import {
  BedrockRuntimeClient,
  BedrockRuntimeClientConfig,
  InvokeModelWithBidirectionalStreamCommand,
  InvokeModelWithBidirectionalStreamInput,
} from "@aws-sdk/client-bedrock-runtime";
import {
  NodeHttp2Handler,
  NodeHttp2HandlerOptions,
} from "@smithy/node-http-handler";
import { Provider } from "@smithy/types";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { InferenceConfig } from "./types";
import { Subject } from 'rxjs';
import { take } from 'rxjs/operators';
import { firstValueFrom } from 'rxjs';
import {
  DefaultAudioInputConfiguration,
  DefaultAudioOutputConfiguration,
  DefaultSystemPrompt,
  DefaultTextConfiguration,
  DefaultToolSchema,
  WeatherToolSchema
} from "./consts";

export interface NovaSonicBidirectionalStreamClientConfig {
  requestHandlerConfig?:
  | NodeHttp2HandlerOptions
  | Provider<NodeHttp2HandlerOptions | void>;
  clientConfig: Partial<BedrockRuntimeClientConfig>;
  inferenceConfig?: InferenceConfig;
}

export class StreamSession {
  private audioBufferQueue: Buffer[] = [];
  private maxQueueSize = 200; // Maximum number of audio chunks to queue
  private isProcessingAudio = false;
  private isActive = true;

  constructor(
    private sessionId: string,
    private client: NovaSonicBidirectionalStreamClient
  ) { }

  // Register event handlers for this specific session
  public onEvent(eventType: string, handler: (data: any) => void): StreamSession {
    this.client.registerEventHandler(this.sessionId, eventType, handler);
    return this; // For chaining
  }

  public async setupSessionAndPromptStart(): Promise<void> {
    this.client.setupSessionStartEvent(this.sessionId);
    this.client.setupPromptStartEvent(this.sessionId);
  }

  public async setupSystemPrompt(
    textConfig: typeof DefaultTextConfiguration = DefaultTextConfiguration,
    systemPromptContent: string = DefaultSystemPrompt): Promise<void> {
    this.client.setupSystemPromptEvent(this.sessionId, textConfig, systemPromptContent);
  }

  public async setupStartAudio(
    audioConfig: typeof DefaultAudioInputConfiguration = DefaultAudioInputConfiguration
  ): Promise<void> {
    this.client.setupStartAudioEvent(this.sessionId, audioConfig);
  }


  // Stream audio for this session
  public async streamAudio(audioData: Buffer): Promise<void> {
    // Check queue size to avoid memory issues
    if (this.audioBufferQueue.length >= this.maxQueueSize) {
      // Queue is full, drop oldest chunk
      this.audioBufferQueue.shift();
      console.log("Audio queue full, dropping oldest chunk");
    }

    // Queue the audio chunk for streaming
    this.audioBufferQueue.push(audioData);
    this.processAudioQueue();
  }

  // Process audio queue for continuous streaming
  private async processAudioQueue() {
    if (this.isProcessingAudio || this.audioBufferQueue.length === 0 || !this.isActive) return;

    this.isProcessingAudio = true;
    try {
      // Process all chunks in the queue, up to a reasonable limit
      let processedChunks = 0;
      const maxChunksPerBatch = 5; // Process max 5 chunks at a time to avoid overload

      while (this.audioBufferQueue.length > 0 && processedChunks < maxChunksPerBatch && this.isActive) {
        const audioChunk = this.audioBufferQueue.shift();
        if (audioChunk) {
          await this.client.streamAudioChunk(this.sessionId, audioChunk);
          processedChunks++;
        }
      }
    } finally {
      this.isProcessingAudio = false;

      // If there are still items in the queue, schedule the next processing using setTimeout
      if (this.audioBufferQueue.length > 0 && this.isActive) {
        setTimeout(() => this.processAudioQueue(), 0);
      }
    }
  }
  // Get session ID
  public getSessionId(): string {
    return this.sessionId;
  }

  public async endAudioContent(): Promise<void> {
    if (!this.isActive) return;
    await this.client.sendContentEnd(this.sessionId);
  }

  public async endPrompt(): Promise<void> {
    if (!this.isActive) return;
    await this.client.sendPromptEnd(this.sessionId);
  }

  public async close(): Promise<void> {
    if (!this.isActive) return;

    this.isActive = false;
    this.audioBufferQueue = []; // Clear any pending audio

    await this.client.sendSessionEnd(this.sessionId);
    console.log(`Session ${this.sessionId} close completed`);
  }
}

// Chat history message interface
interface ChatHistoryMessage {
  role: 'USER' | 'ASSISTANT';
  content: string;
  timestamp?: number;
}

// Session data type
interface SessionData {
  queue: Array<any>;
  queueSignal: Subject<void>;
  closeSignal: Subject<void>;
  responseSubject: Subject<any>;
  toolUseContent: any;
  toolUseId: string;
  toolName: string;
  responseHandlers: Map<string, (data: any) => void>;
  promptName: string;
  inferenceConfig: InferenceConfig;
  isActive: boolean;
  isPromptStartSent: boolean;
  isAudioContentStartSent: boolean;
  audioContentId: string;
  chatHistory: ChatHistoryMessage[];
  retryCount: number;
  sessionCreatedAt: number;  // Fixed timestamp when interview actually started
  currentMessageContent: string;  // Accumulate text chunks for current message
  currentMessageRole: 'USER' | 'ASSISTANT' | null;  // Track current message role
  currentContentId: string | null;  // Track current content ID to know when message is complete
}

export class NovaSonicBidirectionalStreamClient {
  private bedrockRuntimeClient: BedrockRuntimeClient;
  private inferenceConfig: InferenceConfig;
  private activeSessions: Map<string, SessionData> = new Map();
  private sessionLastActivity: Map<string, number> = new Map();
  private sessionCleanupInProgress = new Set<string>();


  constructor(config: NovaSonicBidirectionalStreamClientConfig) {
    const nodeHttp2Handler = new NodeHttp2Handler({
      requestTimeout: 300000,
      sessionTimeout: 300000,
      disableConcurrentStreams: false,
      maxConcurrentStreams: 20,
      ...config.requestHandlerConfig,
    });

    if (!config.clientConfig.credentials) {
      throw new Error("No credentials provided");
    }

    this.bedrockRuntimeClient = new BedrockRuntimeClient({
      ...config.clientConfig,
      credentials: config.clientConfig.credentials,
      region: config.clientConfig.region || "us-east-1",
      requestHandler: nodeHttp2Handler
    });

    this.inferenceConfig = config.inferenceConfig ?? {
      maxTokens: 4096,
      topP: 0.9,
      temperature: 0,  // AWS recommends temperature 0 for tool use (greedy decoding)
    };
  }

  public isSessionActive(sessionId: string): boolean {
    const session = this.activeSessions.get(sessionId);
    return !!session && session.isActive;
  }

  public getActiveSessions(): string[] {
    return Array.from(this.activeSessions.keys());
  }

  public getLastActivityTime(sessionId: string): number {
    return this.sessionLastActivity.get(sessionId) || 0;
  }

  private updateSessionActivity(sessionId: string): void {
    this.sessionLastActivity.set(sessionId, Date.now());
  }

  public isCleanupInProgress(sessionId: string): boolean {
    return this.sessionCleanupInProgress.has(sessionId);
  }


  // Create a new streaming session
  public createStreamSession(sessionId: string = randomUUID(), config?: NovaSonicBidirectionalStreamClientConfig): StreamSession {
    if (this.activeSessions.has(sessionId)) {
      throw new Error(`Stream session with ID ${sessionId} already exists`);
    }

    const session: SessionData = {
      queue: [],
      queueSignal: new Subject<void>(),
      closeSignal: new Subject<void>(),
      responseSubject: new Subject<any>(),
      toolUseContent: null,
      toolUseId: "",
      toolName: "",
      responseHandlers: new Map(),
      promptName: randomUUID(),
      inferenceConfig: config?.inferenceConfig ?? this.inferenceConfig,
      isActive: true,
      isPromptStartSent: false,
      isAudioContentStartSent: false,
      audioContentId: randomUUID(),
      chatHistory: [],
      retryCount: 0,
      sessionCreatedAt: Date.now(),  // Fixed timestamp - set once, never updated
      currentMessageContent: "",  // Initialize message accumulator
      currentMessageRole: null,  // No message in progress
      currentContentId: null  // No content being processed
    };

    this.activeSessions.set(sessionId, session);

    return new StreamSession(sessionId, this);
  }

  private async processToolUse(toolName: string, toolUseContent: object, sessionId?: string): Promise<Object> {
    const tool = toolName.toLowerCase();

    switch (tool) {
      case "getdateandtimetool":
        const date = new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" });
        const pstDate = new Date(date);
        return {
          date: pstDate.toISOString().split('T')[0],
          year: pstDate.getFullYear(),
          month: pstDate.getMonth() + 1,
          day: pstDate.getDate(),
          dayOfWeek: pstDate.toLocaleString('en-US', { weekday: 'long' }).toUpperCase(),
          timezone: "PST",
          formattedTime: pstDate.toLocaleTimeString('en-US', {
            hour12: true,
            hour: '2-digit',
            minute: '2-digit'
          })
        };
      case "getweathertool":
        console.log(`weather tool`)
        const parsedContent = await this.parseToolUseContentForWeather(toolUseContent);
        console.log("parsed content")
        if (!parsedContent) {
          throw new Error('parsedContent is undefined');
        }
        return this.fetchWeatherData(parsedContent?.latitude, parsedContent?.longitude);
      case "getinterviewelapsedtimetool":
        // Get session start time from session data (fixed timestamp)
        if (!sessionId) {
          return { error: "Session ID not provided" };
        }
        const sessionData = this.activeSessions.get(sessionId);

        if (!sessionData || !sessionData.sessionCreatedAt) {
          console.error(`Session or start time not found for session ${sessionId}`);
          return { error: "Session start time not found" };
        }

        const now = Date.now();
        const elapsedMs = now - sessionData.sessionCreatedAt;
        const elapsedMinutes = Math.floor(elapsedMs / 60000);
        const elapsedSeconds = Math.floor((elapsedMs % 60000) / 1000);

        const result = {
          elapsedMinutes,
          elapsedSeconds,
          totalElapsedMs: elapsedMs,
          targetDuration: 15,
          remainingMinutes: Math.max(0, 15 - elapsedMinutes),
          remainingSeconds: Math.max(0, (15 * 60) - Math.floor(elapsedMs / 1000)),
          isNearingEnd: elapsedMinutes >= 12,
          shouldWrapUp: elapsedMinutes >= 14,
          ACTION_REQUIRED: elapsedMinutes >= 14
            ? "BEGIN_CLOSING_PROTOCOL_NOW"
            : elapsedMinutes >= 12
            ? "ASK_ONE_FINAL_QUESTION"
            : "CONTINUE_INTERVIEW_ASK_NEXT_QUESTION",
          message: elapsedMinutes >= 14
            ? `STOP! You have reached 14+ minutes. Do NOT ask any more interview questions. You MUST begin the closing protocol immediately.`
            : elapsedMinutes >= 12
            ? `You are at ${elapsedMinutes} minutes. You have time for ONE more question before closing.`
            : `You are at ${elapsedMinutes} minutes out of 15. You have plenty of time remaining. Continue with your next interview question.`
        };

        console.log(`⏱️ Time check for session ${sessionId}:`, result);
        return result;
      case "endinterviewtool":
        if (!sessionId) {
          return { error: "Session ID not provided" };
        }
        console.log(`🎬 Agent signaled interview completion for session ${sessionId}`);

        // Dispatch special event that server will listen for
        this.dispatchEvent(sessionId, 'interviewComplete', {
          sessionId: sessionId,
          completedAt: new Date().toISOString(),
          reason: 'agent_completed_closing'
        });

        return {
          success: true,
          message: "Interview end signal received. Session will close in 5 seconds.",
          action: "closing"
        };
      default:
        console.log(`Tool ${tool} not supported`)
        throw new Error(`Tool ${tool} not supported`);
    }
  }

  private async parseToolUseContentForWeather(toolUseContent: any): Promise<{ latitude: number; longitude: number; } | null> {
    try {
      // Check if the content field exists and is a string
      if (toolUseContent && typeof toolUseContent.content === 'string') {
        // Parse the JSON string into an object
        const parsedContent = JSON.parse(toolUseContent.content);
        console.log(`parsedContent ${parsedContent}`)
        // Return the parsed content
        return {
          latitude: parsedContent.latitude,
          longitude: parsedContent.longitude
        };
      }
      return null;
    } catch (error) {
      console.error("Failed to parse tool use content:", error);
      return null;
    }
  }


  private async fetchWeatherData(
    latitude: number,
    longitude: number
  ): Promise<Record<string, any>> {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true`;

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'MyApp/1.0',
          'Accept': 'application/json'
        }
      });
      const weatherData = await response.json();
      console.log("weatherData:", weatherData);

      return {
        weather_data: weatherData
      };
    } catch (error) {
      console.error(`Error fetching weather data: ${error instanceof Error ? error.message : String(error)} `, error);
      throw error;
    }
  }

  // Stream audio for a specific session
  public async initiateBidirectionalStreaming(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new Error(`Stream session ${sessionId} not found`);
    }

    try {

      // Create the bidirectional stream with session-specific async iterator
      const asyncIterable = this.createSessionAsyncIterable(sessionId);

      console.log(`Starting bidirectional stream for session ${sessionId}...`);

      const response = await this.bedrockRuntimeClient.send(
        new InvokeModelWithBidirectionalStreamCommand({
          modelId: "amazon.nova-sonic-v1:0",
          body: asyncIterable,
        })
      );

      console.log(`Stream established for session ${sessionId}, processing responses...`);

      // Process responses for this session
      await this.processResponseStream(sessionId, response);

    } catch (error) {
      console.error(`Error in session ${sessionId}: `, error);
      this.dispatchEventForSession(sessionId, 'error', {
        source: 'bidirectionalStream',
        error
      });

      // Make sure to clean up if there's an error
      if (session.isActive) {
        this.closeSession(sessionId);
      }
    }
  }

  // Dispatch events to handlers for a specific session
  private dispatchEventForSession(sessionId: string, eventType: string, data: any): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    const handler = session.responseHandlers.get(eventType);
    if (handler) {
      try {
        handler(data);
      } catch (e) {
        console.error(`Error in ${eventType} handler for session ${sessionId}: `, e);
      }
    }

    // Also dispatch to "any" handlers
    const anyHandler = session.responseHandlers.get('any');
    if (anyHandler) {
      try {
        anyHandler({ type: eventType, data });
      } catch (e) {
        console.error(`Error in 'any' handler for session ${sessionId}: `, e);
      }
    }
  }

  private createSessionAsyncIterable(sessionId: string): AsyncIterable<InvokeModelWithBidirectionalStreamInput> {

    if (!this.isSessionActive(sessionId)) {
      console.log(`Cannot create async iterable: Session ${sessionId} not active`);
      return {
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ value: undefined, done: true })
        })
      };
    }

    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new Error(`Cannot create async iterable: Session ${sessionId} not found`);
    }

    let eventCount = 0;

    return {
      [Symbol.asyncIterator]: () => {
        console.log(`AsyncIterable iterator requested for session ${sessionId}`);

        return {
          next: async (): Promise<IteratorResult<InvokeModelWithBidirectionalStreamInput>> => {
            try {
              // Check if session is still active
              if (!session.isActive || !this.activeSessions.has(sessionId)) {
                console.log(`Iterator closing for session ${sessionId}, done = true`);
                return { value: undefined, done: true };
              }
              // Wait for items in the queue or close signal
              if (session.queue.length === 0) {
                try {
                  await Promise.race([
                    firstValueFrom(session.queueSignal.pipe(take(1))),
                    firstValueFrom(session.closeSignal.pipe(take(1))).then(() => {
                      throw new Error("Stream closed");
                    })
                  ]);
                } catch (error) {
                  if (error instanceof Error) {
                    if (error.message === "Stream closed" || !session.isActive) {
                      // This is an expected condition when closing the session
                      if (this.activeSessions.has(sessionId)) {
                        console.log(`Session ${ sessionId } closed during wait`);
                      }
                      return { value: undefined, done: true };
                    }
                  }
                  else {
                    console.error(`Error on event close`, error)
                  }
                }
              }

              // If queue is still empty or session is inactive, we're done
              if (session.queue.length === 0 || !session.isActive) {
                console.log(`Queue empty or session inactive: ${sessionId} `);
                return { value: undefined, done: true };
              }

              // Get next item from the session's queue
              const nextEvent = session.queue.shift();
              eventCount++;

              //console.log(`Sending event #${ eventCount } for session ${ sessionId }: ${ JSON.stringify(nextEvent).substring(0, 100) }...`);

              return {
                value: {
                  chunk: {
                    bytes: new TextEncoder().encode(JSON.stringify(nextEvent))
                  }
                },
                done: false
              };
            } catch (error) {
              console.error(`Error in session ${sessionId} iterator: `, error);
              session.isActive = false;
              return { value: undefined, done: true };
            }
          },

          return: async (): Promise<IteratorResult<InvokeModelWithBidirectionalStreamInput>> => {
            console.log(`Iterator return () called for session ${sessionId}`);
            session.isActive = false;
            return { value: undefined, done: true };
          },

          throw: async (error: any): Promise<IteratorResult<InvokeModelWithBidirectionalStreamInput>> => {
            console.log(`Iterator throw () called for session ${sessionId} with error: `, error);
            session.isActive = false;
            throw error;
          }
        };
      }
    };
  }

  // Process the response stream from AWS Bedrock
  private async processResponseStream(sessionId: string, response: any): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    try {
      for await (const event of response.body) {
        if (!session.isActive) {
          console.log(`Session ${sessionId} is no longer active, stopping response processing`);
          break;
        }
        if (event.chunk?.bytes) {
          try {
            this.updateSessionActivity(sessionId);
            const textResponse = new TextDecoder().decode(event.chunk.bytes);

            try {
              const jsonResponse = JSON.parse(textResponse);
              if (jsonResponse.event?.contentStart) {
                const contentStart = jsonResponse.event.contentStart;
                this.dispatchEvent(sessionId, 'contentStart', contentStart);

                // If this is a TEXT content from USER or ASSISTANT, start accumulating
                if (contentStart.type === 'TEXT' && (contentStart.role === 'USER' || contentStart.role === 'ASSISTANT')) {
                  session.currentMessageContent = "";
                  session.currentMessageRole = contentStart.role;
                  session.currentContentId = contentStart.contentId; // FIX: Use contentId not contentName
                  console.log(`Started accumulating ${contentStart.role} message (contentId: ${contentStart.contentId})`);
                }
              } else if (jsonResponse.event?.textOutput) {
                this.dispatchEvent(sessionId, 'textOutput', jsonResponse.event.textOutput);

                // Accumulate text chunks for the current message
                const textOutput = jsonResponse.event.textOutput;
                const role = textOutput.role;
                const content = textOutput.content;

                // Filter out Nova Sonic's interruption signal - this should NOT be displayed or saved
                const isInterruptedSignal = content && content.includes('{ "interrupted" : true }');

                if (isInterruptedSignal) {
                  console.log(`🚫 Filtered out interruption signal from chat history`);
                }

                if ((role === 'USER' || role === 'ASSISTANT') && content && !isInterruptedSignal) {
                  // Add this chunk to the current message accumulator
                  session.currentMessageContent += content;
                  // console.log(`Accumulated chunk for ${role}: "${content}" (total length: ${session.currentMessageContent.length})`);
                }
              } else if (jsonResponse.event?.audioOutput) {
                this.dispatchEvent(sessionId, 'audioOutput', jsonResponse.event.audioOutput);
              } else if (jsonResponse.event?.toolUse) {
                this.dispatchEvent(sessionId, 'toolUse', jsonResponse.event.toolUse);

                // Store tool use information for later
                session.toolUseContent = jsonResponse.event.toolUse;
                session.toolUseId = jsonResponse.event.toolUse.toolUseId;
                session.toolName = jsonResponse.event.toolUse.toolName;
              } else if (jsonResponse.event?.contentEnd &&
                jsonResponse.event?.contentEnd?.type === 'TOOL') {

                // Process tool use
                console.log(`Processing tool use for session ${sessionId}`);
                this.dispatchEvent(sessionId, 'toolEnd', {
                  toolUseContent: session.toolUseContent,
                  toolUseId: session.toolUseId,
                  toolName: session.toolName
                });

                console.log("calling tooluse");
                console.log("tool use content : ", session.toolUseContent)
                // function calling
                const toolResult = await this.processToolUse(session.toolName, session.toolUseContent, sessionId);

                // Send tool result
                this.sendToolResult(sessionId, session.toolUseId, toolResult);

                // Also dispatch event about tool result
                this.dispatchEvent(sessionId, 'toolResult', {
                  toolUseId: session.toolUseId,
                  result: toolResult
                });
              } else if (jsonResponse.event?.contentEnd) {
                const contentEnd = jsonResponse.event.contentEnd;
                this.dispatchEvent(sessionId, 'contentEnd', contentEnd);

                // If this is the end of a TEXT content we were accumulating, save to chat history
                // ONLY save if stopReason is 'END_TURN' (not PARTIAL_TURN or other intermediate states)
                const isEndTurn = !contentEnd.stopReason || contentEnd.stopReason === 'END_TURN';

                if (contentEnd.type === 'TEXT' &&
                    session.currentMessageRole &&
                    session.currentMessageContent.length > 0 &&
                    session.currentContentId === contentEnd.contentId && // FIX: Use contentId not contentName
                    isEndTurn) { // FIX: Only save complete messages, not partial ones

                  session.chatHistory.push({
                    role: session.currentMessageRole,
                    content: session.currentMessageContent,
                    timestamp: Date.now()
                  });

                  console.log(`💾 Chat history saved (${contentEnd.stopReason}): ${session.currentMessageRole}: ${session.currentMessageContent.substring(0, 60)}...`);

                  // Reset accumulator for next message
                  session.currentMessageContent = "";
                  session.currentMessageRole = null;
                  session.currentContentId = null;
                } else if (contentEnd.type === 'TEXT' && contentEnd.stopReason === 'PARTIAL_TURN') {
                  console.log(`⏭️ Skipping partial turn save: ${session.currentMessageRole}: ${session.currentMessageContent.substring(0, 60)}...`);
                  // Still reset accumulator so we can start fresh for the next (final) version
                  session.currentMessageContent = "";
                  session.currentMessageRole = null;
                  session.currentContentId = null;
                }
              }
              else {
                // Handle other events
                const eventKeys = Object.keys(jsonResponse.event || {});
                console.log(`Event keys for session ${sessionId}: `, eventKeys)
                console.log(`Handling other events`)
                if (eventKeys.length > 0) {
                  this.dispatchEvent(sessionId, eventKeys[0], jsonResponse.event);
                } else if (Object.keys(jsonResponse).length > 0) {
                  this.dispatchEvent(sessionId, 'unknown', jsonResponse);
                }
              }
            } catch (e) {
              console.log(`Raw text response for session ${sessionId}(parse error): `, textResponse);
            }
          } catch (e) {
            console.error(`Error processing response chunk for session ${sessionId}: `, e);
          }
        } else if (event.modelStreamErrorException) {
          console.error(`Model stream error for session ${sessionId}: `, event.modelStreamErrorException);

          // Check if this is a model timeout (8-minute connection timeout)
          const errorMessage = event.modelStreamErrorException?.message || '';
          const isModelTimeout = errorMessage.includes('Model has timed out') &&
                                errorMessage.includes('processing the request');

          this.dispatchEvent(sessionId, 'error', {
            type: 'modelStreamErrorException',
            details: event.modelStreamErrorException,
            isTimeout: isModelTimeout,
            shouldRetry: isModelTimeout
          });

          // If model timeout, initiate cleanup for retry
          if (isModelTimeout) {
            console.log(`Model timeout detected for session ${sessionId}, preparing for retry...`);
            await this.cleanupForRetry(sessionId);
          }
        } else if (event.internalServerException) {
          console.error(`Internal server error for session ${sessionId}: `, event.internalServerException);
          this.dispatchEvent(sessionId, 'error', {
            type: 'internalServerException',
            details: event.internalServerException
          });
        }
      }

      console.log(`Response stream processing complete for session ${sessionId}`);

      // Only dispatch streamComplete if session still exists
      // During retry, session gets deleted so we DON'T want to trigger client disconnect
      if (this.activeSessions.has(sessionId)) {
        this.dispatchEvent(sessionId, 'streamComplete', {
          timestamp: new Date().toISOString()
        });
      } else {
        console.log(`Session ${sessionId} no longer active (likely in retry), skipping streamComplete event`);
      }

    } catch (error) {
      console.error(`Error processing response stream for session ${sessionId}: `, error);

      // Check if this is a MODEL timeout exception (8-minute connection timeout)
      // NOT validation timeouts or other timeout errors
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorName = (error as any)?.name || '';
      const isModelTimeout = errorName === 'ModelTimeoutException' ||
                            (errorMessage.includes('Model has timed out') &&
                             errorMessage.includes('processing the request'));

      this.dispatchEvent(sessionId, 'error', {
        source: 'responseStream',
        message: 'Error processing response stream',
        details: errorMessage,
        isTimeout: isModelTimeout,
        shouldRetry: isModelTimeout
      });

      // If MODEL timeout (not other timeouts), initiate cleanup for retry
      if (isModelTimeout) {
        console.log(`⏱️ Model timeout exception caught for session ${sessionId}, initiating retry...`);
        await this.cleanupForRetry(sessionId);
      }
    }
  }

  // Add an event to a session's queue
  private addEventToSessionQueue(sessionId: string, event: any): void {
    const session = this.activeSessions.get(sessionId);
    if (!session || !session.isActive) return;

    this.updateSessionActivity(sessionId);
    session.queue.push(event);
    session.queueSignal.next();
  }


  // Set up initial events for a session
  public setupSessionStartEvent(sessionId: string): void {
    console.log(`Setting up initial events for session ${sessionId}...`);
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    // Session start event
    this.addEventToSessionQueue(sessionId, {
      event: {
        sessionStart: {
          inferenceConfiguration: session.inferenceConfig
        }
      }
    });
  }

  public setupPromptStartEvent(sessionId: string): void {
    console.log(`Setting up prompt start event for session ${sessionId}...`);
    const session = this.activeSessions.get(sessionId);
    if (!session) return;
    // Prompt start event
    this.addEventToSessionQueue(sessionId, {
      event: {
        promptStart: {
          promptName: session.promptName,
          textOutputConfiguration: {
            mediaType: "text/plain",
          },
          audioOutputConfiguration: DefaultAudioOutputConfiguration,
          toolUseOutputConfiguration: {
            mediaType: "application/json",
          },
          toolConfiguration: {
            tools: [{
              toolSpec: {
                name: "getDateAndTimeTool",
                description: "Get information about the current date and time.",
                inputSchema: {
                  json: DefaultToolSchema
                }
              }
            },
            {
              toolSpec: {
                name: "getWeatherTool",
                description: "Get the current weather for a given location, based on its WGS84 coordinates.",
                inputSchema: {
                  json: WeatherToolSchema
                }
              }
            },
            {
              toolSpec: {
                name: "getInterviewElapsedTimeTool",
                description: "REQUIRED: Must be called immediately before responding to the candidate to check how much time has elapsed in this 15-minute interview. Returns critical time flags (isNearingEnd, shouldWrapUp) that determine your next action. You MUST call this before every response to the candidate.",
                inputSchema: {
                  json: DefaultToolSchema
                }
              }
            },
            {
              toolSpec: {
                name: "endInterviewTool",
                description: "Signal that the interview is complete and should be closed. Only call this after completing the full closing protocol and saying final goodbye. This is the last action you take.",
                inputSchema: {
                  json: DefaultToolSchema
                }
              }
            }
            ]
          },
        },
      }
    });
    session.isPromptStartSent = true;
  }

  public setupSystemPromptEvent(sessionId: string,
    textConfig: typeof DefaultTextConfiguration = DefaultTextConfiguration,
    systemPromptContent: string = DefaultSystemPrompt
  ): void {
    console.log(`Setting up systemPrompt events for session ${sessionId}...`);
    const session = this.activeSessions.get(sessionId);
    if (!session) return;
    // Text content start
    const textPromptID = randomUUID();
    this.addEventToSessionQueue(sessionId, {
      event: {
        contentStart: {
          promptName: session.promptName,
          contentName: textPromptID,
          type: "TEXT",
          interactive: false,
          role: "SYSTEM",
          textInputConfiguration: textConfig,
        },
      }
    });

    // Text input content
    this.addEventToSessionQueue(sessionId, {
      event: {
        textInput: {
          promptName: session.promptName,
          contentName: textPromptID,
          content: systemPromptContent,
        },
      }
    });

    // Text content end
    this.addEventToSessionQueue(sessionId, {
      event: {
        contentEnd: {
          promptName: session.promptName,
          contentName: textPromptID,
        },
      }
    });
  }

  public setupStartAudioEvent(
    sessionId: string,
    audioConfig: typeof DefaultAudioInputConfiguration = DefaultAudioInputConfiguration
  ): void {
    console.log(`Setting up startAudioContent event for session ${sessionId}...`);
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    console.log(`Using audio content ID: ${session.audioContentId}`);
    // Audio content start
    this.addEventToSessionQueue(sessionId, {
      event: {
        contentStart: {
          promptName: session.promptName,
          contentName: session.audioContentId,
          type: "AUDIO",
          interactive: true,
          role: "USER",
          audioInputConfiguration: audioConfig,
        },
      }
    });
    session.isAudioContentStartSent = true;
    console.log(`Initial events setup complete for session ${sessionId}`);
  }

  // Stream an audio chunk for a session
  public async streamAudioChunk(sessionId: string, audioData: Buffer): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session || !session.isActive || !session.audioContentId) {
      // Session is closed or not ready - silently drop the audio chunk
      // This is expected during cleanup/retry when queue is still draining
      return;
    }
    // Convert audio to base64
    const base64Data = audioData.toString('base64');

    this.addEventToSessionQueue(sessionId, {
      event: {
        audioInput: {
          promptName: session.promptName,
          contentName: session.audioContentId,
          content: base64Data,
        },
      }
    });
  }


  // Send tool result back to the model
  private async sendToolResult(sessionId: string, toolUseId: string, result: any): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    console.log("inside tool result")
    if (!session || !session.isActive) return;

    console.log(`Sending tool result for session ${sessionId}, tool use ID: ${toolUseId}`);
    const contentId = randomUUID();

    // Tool content start
    this.addEventToSessionQueue(sessionId, {
      event: {
        contentStart: {
          promptName: session.promptName,
          contentName: contentId,
          interactive: false,
          type: "TOOL",
          role: "TOOL",
          toolResultInputConfiguration: {
            toolUseId: toolUseId,
            type: "TEXT",
            textInputConfiguration: {
              mediaType: "text/plain"
            }
          }
        }
      }
    });

    // Tool content input
    const resultContent = typeof result === 'string' ? result : JSON.stringify(result);
    this.addEventToSessionQueue(sessionId, {
      event: {
        toolResult: {
          promptName: session.promptName,
          contentName: contentId,
          content: resultContent
        }
      }
    });

    // Tool content end
    this.addEventToSessionQueue(sessionId, {
      event: {
        contentEnd: {
          promptName: session.promptName,
          contentName: contentId
        }
      }
    });

    console.log(`Tool result sent for session ${sessionId}`);
  }

  public async sendContentEnd(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session || !session.isAudioContentStartSent) return;

    await this.addEventToSessionQueue(sessionId, {
      event: {
        contentEnd: {
          promptName: session.promptName,
          contentName: session.audioContentId,
        }
      }
    });

    // Wait to ensure it's processed
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  public async sendPromptEnd(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session || !session.isPromptStartSent) return;

    await this.addEventToSessionQueue(sessionId, {
      event: {
        promptEnd: {
          promptName: session.promptName
        }
      }
    });

    // Wait to ensure it's processed
    await new Promise(resolve => setTimeout(resolve, 300));
  }

  public async sendSessionEnd(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    await this.addEventToSessionQueue(sessionId, {
      event: {
        sessionEnd: {}
      }
    });

    // Wait to ensure it's processed
    await new Promise(resolve => setTimeout(resolve, 300));

    // Now it's safe to clean up
    session.isActive = false;
    session.closeSignal.next();
    session.closeSignal.complete();
    this.activeSessions.delete(sessionId);
    this.sessionLastActivity.delete(sessionId);
    console.log(`Session ${sessionId} closed and removed from active sessions`);
  }

  public async injectChatHistory(sessionId: string, chatHistory: ChatHistoryMessage[]): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session || chatHistory.length === 0) {
      console.log(`No chat history to inject for session ${sessionId}`);
      return;
    }

    // AWS REQUIREMENT: First message MUST be from USER
    // Filter to ensure we start with a USER message
    const validHistory = chatHistory.filter((msg, index) => {
      if (index === 0 && msg.role === 'ASSISTANT') {
        console.log(`⚠️ Skipping initial ASSISTANT message (AWS requires USER first): ${msg.content.substring(0, 60)}...`);
        return false;
      }
      return true;
    });

    if (validHistory.length === 0) {
      console.log(`No valid chat history to inject (all messages filtered out)`);
      return;
    }

    // Ensure first message is USER
    if (validHistory[0].role !== 'USER') {
      console.error(`❌ Chat history validation failed: First message must be USER, got ${validHistory[0].role}`);
      return;
    }

    console.log(`Injecting ${validHistory.length} messages into session ${sessionId} (filtered from ${chatHistory.length})`);

    // Inject each message as a text content block (following AWS pattern exactly)
    for (const message of validHistory) {
      const contentName = randomUUID(); // AWS uses contentName for input events

      // Content start WITHOUT role (AWS pattern)
      this.addEventToSessionQueue(sessionId, {
        event: {
          contentStart: {
            promptName: session.promptName,
            contentName: contentName,
            type: "TEXT",
            interactive: false,
            textInputConfiguration: {
              mediaType: "text/plain"
            }
          }
        }
      });

      // Text input WITH role (AWS pattern - this is the key difference!)
      this.addEventToSessionQueue(sessionId, {
        event: {
          textInput: {
            promptName: session.promptName,
            contentName: contentName,
            content: message.content,
            role: message.role
          }
        }
      });

      // Content end
      this.addEventToSessionQueue(sessionId, {
        event: {
          contentEnd: {
            promptName: session.promptName,
            contentName: contentName
          }
        }
      });
    }

    console.log(`Chat history injected successfully for session ${sessionId}`);
  }

  public async cleanupForRetry(sessionId: string): Promise<void> {
    // Prevent double-calling cleanup (timeout might be detected in multiple places)
    if (this.sessionCleanupInProgress.has(sessionId)) {
      console.log(`Cleanup already in progress for session ${sessionId}, skipping duplicate call`);
      return;
    }

    const session = this.activeSessions.get(sessionId);
    if (!session) {
      console.error(`Cannot cleanup - session ${sessionId} not found`);
      return;
    }

    // Mark cleanup as in progress
    this.sessionCleanupInProgress.add(sessionId);
    console.log(`Cleaning up session ${sessionId} for retry...`);

    try {
      // Step 0: Save session data AND event handlers BEFORE cleanup (since sendSessionEnd will delete it)
      const chatHistory = [...session.chatHistory];
      const retryCount = session.retryCount + 1;
      const originalStartTime = session.sessionCreatedAt;  // CRITICAL: Preserve original interview start time

      // CRITICAL: Save event handler references BEFORE session is deleted
      const retryHandler = session.responseHandlers.get('retryRequired');
      const maxRetriesHandler = session.responseHandlers.get('maxRetriesExceeded');

      // Mark session as inactive immediately to stop accepting NEW audio
      session.isActive = false;

      // Wait briefly for any in-flight audio queue processing to complete
      // This prevents race conditions where audio is still being streamed
      await new Promise(resolve => setTimeout(resolve, 100));

      // Step 1: Send contentEnd if audio streaming started
      if (session.isAudioContentStartSent) {
        await this.sendContentEnd(sessionId).catch(err => {
          console.log(`ContentEnd error (expected during cleanup): ${err.message}`);
        });
      }

      // Step 2: Send promptEnd
      await this.sendPromptEnd(sessionId).catch(err => {
        console.log(`PromptEnd error (expected during cleanup): ${err.message}`);
      });

      // Step 3: Send sessionEnd (this will delete from activeSessions)
      await this.sendSessionEnd(sessionId).catch(err => {
        console.log(`SessionEnd error (expected during cleanup): ${err.message}`);
      });

      console.log(`Session ${sessionId} cleaned up. Retry count: ${retryCount}`);

      // Step 4: Call event handlers directly (session is now deleted, can't use dispatchEvent)
      if (retryCount < 3) {
        // Max 3 retries
        const retryData = {
          sessionId,
          chatHistory: chatHistory,
          retryCount: retryCount,
          reason: 'timeout',
          originalStartTime: originalStartTime  // Pass original interview start time
        };

        console.log(`🔄 Dispatching retry event (attempt ${retryCount}/3)`);
        if (retryHandler) {
          try {
            retryHandler(retryData);
          } catch (e) {
            console.error(`Error in retryRequired handler:`, e);
          }
        } else {
          console.warn(`No retry handler registered for session ${sessionId}`);
        }
      } else {
        console.error(`Session ${sessionId} exceeded max retry attempts (3)`);
        const maxRetriesData = {
          sessionId,
          chatHistory: chatHistory
        };

        if (maxRetriesHandler) {
          try {
            maxRetriesHandler(maxRetriesData);
          } catch (e) {
            console.error(`Error in maxRetriesExceeded handler:`, e);
          }
        }
      }
    } catch (error) {
      console.error(`Error during cleanup for retry: ${error}`);
    } finally {
      // Remove from cleanup in progress
      this.sessionCleanupInProgress.delete(sessionId);
    }
  }

  // Register an event handler for a session
  public registerEventHandler(sessionId: string, eventType: string, handler: (data: any) => void): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    session.responseHandlers.set(eventType, handler);
  }

  // Restore original start time (used during retry to preserve elapsed time)
  public restoreSessionStartTime(sessionId: string, originalStartTime: number): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      console.error(`Cannot restore start time - session ${sessionId} not found`);
      return;
    }
    session.sessionCreatedAt = originalStartTime;
    console.log(`✅ Restored original start time for session ${sessionId}: ${new Date(originalStartTime).toISOString()}`);
  }

  // Dispatch an event to registered handlers
  private dispatchEvent(sessionId: string, eventType: string, data: any): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    const handler = session.responseHandlers.get(eventType);
    if (handler) {
      try {
        handler(data);
      } catch (e) {
        console.error(`Error in ${eventType} handler for session ${sessionId}:`, e);
      }
    }

    // Also dispatch to "any" handlers
    const anyHandler = session.responseHandlers.get('any');
    if (anyHandler) {
      try {
        anyHandler({ type: eventType, data });
      } catch (e) {
        console.error(`Error in 'any' handler for session ${sessionId}:`, e);
      }
    }
  }

  public async closeSession(sessionId: string): Promise<void> {
    if (this.sessionCleanupInProgress.has(sessionId)) {
      console.log(`Cleanup already in progress for session ${sessionId}, skipping`);
      return;
    }
    this.sessionCleanupInProgress.add(sessionId);
    try {
      console.log(`Starting close process for session ${sessionId}`);
      await this.sendContentEnd(sessionId);
      await this.sendPromptEnd(sessionId);
      await this.sendSessionEnd(sessionId);
      console.log(`Session ${sessionId} cleanup complete`);
    } catch (error) {
      console.error(`Error during closing sequence for session ${sessionId}:`, error);

      // Ensure cleanup happens even if there's an error
      const session = this.activeSessions.get(sessionId);
      if (session) {
        session.isActive = false;
        this.activeSessions.delete(sessionId);
        this.sessionLastActivity.delete(sessionId);
      }
    } finally {
      // Always clean up the tracking set
      this.sessionCleanupInProgress.delete(sessionId);
    }
  }

  // Same for forceCloseSession:
  public forceCloseSession(sessionId: string): void {
    if (this.sessionCleanupInProgress.has(sessionId) || !this.activeSessions.has(sessionId)) {
      console.log(`Session ${sessionId} already being cleaned up or not active`);
      return;
    }

    this.sessionCleanupInProgress.add(sessionId);
    try {
      const session = this.activeSessions.get(sessionId);
      if (!session) return;

      console.log(`Force closing session ${sessionId}`);

      // Immediately mark as inactive and clean up resources
      session.isActive = false;
      session.closeSignal.next();
      session.closeSignal.complete();
      this.activeSessions.delete(sessionId);
      this.sessionLastActivity.delete(sessionId);

      console.log(`Session ${sessionId} force closed`);
    } finally {
      this.sessionCleanupInProgress.delete(sessionId);
    }
  }

}