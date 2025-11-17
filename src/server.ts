import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import { Server } from 'socket.io';
import { fromIni, fromEnv } from "@aws-sdk/credential-providers";
import { NovaSonicBidirectionalStreamClient, StreamSession } from './client';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'crypto';

// Configure AWS credentials - try multiple sources
const AWS_PROFILE_NAME = process.env.AWS_PROFILE || 'bedrock-test';

// Create Express app and HTTP server
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Try to use credentials from environment first, fall back to profile
let credentials;
if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    console.log('Using AWS credentials from environment variables');
    credentials = fromEnv();
} else {
    console.log(`Using AWS credentials from profile: ${AWS_PROFILE_NAME}`);
    credentials = fromIni({ profile: AWS_PROFILE_NAME });
}

// Create the AWS Bedrock client
const bedrockClient = new NovaSonicBidirectionalStreamClient({
    requestHandlerConfig: {
        maxConcurrentStreams: 10,
    },
    clientConfig: {
        region: process.env.AWS_REGION || "us-east-1",
        credentials: credentials
    }
});

// Track active sessions per socket
const socketSessions = new Map<string, StreamSession>();

// Session states
enum SessionState {
    INITIALIZING = 'initializing',
    READY = 'ready',
    ACTIVE = 'active',
    CLOSED = 'closed'
}

const sessionStates = new Map<string, SessionState>();
const cleanupInProgress = new Map<string, boolean>();
const retryInProgress = new Set<string>();  // Track sockets currently in retry

// Map socket IDs to interview session IDs
const socketToInterviewSession = new Map<string, string>();

// Interview session storage
interface InterviewSession {
    sessionId: string;
    jobTitle: string;
    candidateName?: string;
    jobDescription: string;
    systemPrompt: string;
    createdAt: Date;
    status: 'active' | 'completed';
    transcript?: string[];
}

const interviewSessions = new Map<string, InterviewSession>();

// Periodically check for and close inactive sessions (every minute)
// Sessions with no activity for over 5 minutes will be force closed
setInterval(() => {
    console.log("Session cleanup check");
    const now = Date.now();

    // Check all active sessions
    bedrockClient.getActiveSessions().forEach(sessionId => {
        const lastActivity = bedrockClient.getLastActivityTime(sessionId);

        // If no activity for 5 minutes, force close
        if (now - lastActivity > 5 * 60 * 1000) {
            console.log(`Closing inactive session ${sessionId} after 5 minutes of inactivity`);
            try {
                bedrockClient.forceCloseSession(sessionId);
            } catch (error) {
                console.error(`Error force closing inactive session ${sessionId}:`, error);
            }
        }
    });
}, 60000);

// Middleware
app.use(express.json());

// API Routes for interview session management
app.post('/api/create-session', (req: express.Request, res: express.Response): void => {
    try {
        const { jobTitle, candidateName, jobDescription } = req.body;

        if (!jobTitle || !jobDescription) {
            res.status(400).json({ error: 'Job title and description are required' });
            return;
        }

        // Generate unique session ID
        const sessionId = randomUUID();

        // Create system prompt for the interview
        const systemPrompt = `You are an AI interviewer conducting a voice screening interview for a ${jobTitle} position. This will be a natural spoken conversation between you and the candidate.

TIME MANAGEMENT IS CRITICAL - READ THIS CAREFULLY.

After every candidate response, you MUST call getInterviewElapsedTimeTool. This tool returns an ACTION_REQUIRED field that tells you EXACTLY what to do next. You must follow this instruction precisely.

The tool will return one of three actions:

1. "CONTINUE_INTERVIEW_ASK_NEXT_QUESTION" - This means you have plenty of time left. Ask your next interview question normally.

2. "ASK_ONE_FINAL_QUESTION" - This means you are between 12-14 minutes. Say something like "I have one final question before we wrap up" and ask one more question. After they answer, the tool will tell you to begin closing.

3. "BEGIN_CLOSING_PROTOCOL_NOW" - This means 14+ minutes have passed. DO NOT ask any more interview questions. Begin the five-step closing protocol immediately.

The tool also returns a "message" field with specific instructions. Read this message carefully and follow it exactly. If it says "Continue with your next interview question" then continue. If it says "Do NOT ask any more interview questions" then you must begin closing immediately.

Do NOT make your own assumptions about time based on how many questions you've asked. ONLY use the ACTION_REQUIRED field from the tool to decide what to do next.

Now let me explain the closing protocol. When shouldWrapUp becomes true, you must follow these five steps in order. Do not skip any step.

Step one is the summary. Thank the candidate by name and quickly summarize what you discussed. Mention two or three specific topics from your conversation and note one specific insight they shared that you appreciated. Keep this to about twenty seconds.

Step two is explaining next steps. Tell the candidate that your hiring team will review their responses and they'll hear back within two business days via email. Explain that if they're selected to move forward, the next step will be a technical interview with your senior developer. This should take about twenty seconds.

Step three is asking if they have questions. Say "Before we close, do you have any quick questions for me?" Wait for their response. If they ask a question, give a brief answer but keep the total time under thirty seconds. If they say no, move directly to step four.

Step four is the thank you and goodbye. Say "Thank you so much for your time today" and use their name. Tell them you enjoyed speaking with them and wish them best of luck with their job search. This should take about ten seconds.

Step five is critical and mandatory. Immediately after saying goodbye, you must call the endInterviewTool. This is not optional. The interview will not end without this tool call. This must be the very last thing you do. Do not say anything after calling this tool. Just call it and stop.

Let me emphasize this again because it's crucial. After you say your final goodbye, immediately call endInterviewTool. Do not skip this. Do not forget this. This is how the interview session actually closes.

For your conversation style, keep all of your responses to two or three sentences maximum. Be warm, professional, and encouraging throughout the interview. Listen carefully to what the candidate says. If a candidate starts rambling and goes past two minutes on a single question, politely interrupt them by saying something like "That's helpful. Given our time, let me ask about something else."

QUESTION VARIETY - AVOID REPETITION:

You must track what questions you've already asked and NEVER repeat the exact same question. Each question in the interview should be unique and distinct. Here's how to maintain variety:

- If you ask "Tell me about a time when you solved a complex security problem" you CANNOT ask this again
- Instead, ask different behavioral questions: "Describe a challenging incident you investigated" or "Walk me through how you handled a false positive situation"
- Vary the specific angle: projects vs processes, technical vs soft skills, past experiences vs hypothetical scenarios
- Pay attention to what the candidate has already discussed and don't ask for information they've already provided

Before asking any question, mentally check: "Have I asked this exact question already?" If yes, ask something different.

CRITICAL RULES - NEVER BREAK THESE:

1. NEVER ask the exact same question twice - vary your wording and angle for each question
2. NEVER begin the closing protocol unless ACTION_REQUIRED says "BEGIN_CLOSING_PROTOCOL_NOW"
3. NEVER make assumptions about time - ONLY trust the tool result
4. NEVER wrap up early just because you've asked several questions
5. NEVER skip calling getInterviewElapsedTimeTool after each candidate response
6. NEVER ask new questions after the tool says to begin closing
7. NEVER skip calling endInterviewTool after saying goodbye
8. NEVER say anything after calling endInterviewTool

The job description and requirements for this position are:
${jobDescription}

INTERVIEW STRATEGY - HOW TO USE THE FULL 15 MINUTES:

This is a 15-minute interview. You need to fill the entire time with meaningful conversation. Do NOT simply check boxes on the job description and wrap up early. Here's how to conduct a thorough interview:

1. GO DEEP, NOT JUST BROAD - For each skill or requirement in the job description, ask 2-3 follow-up questions:
   - Initial question: "Tell me about your experience with [skill]"
   - Follow-up 1: "Can you walk me through a specific project where you used [skill]?"
   - Follow-up 2: "What challenges did you face and how did you overcome them?"
   - Follow-up 3: "What were the measurable results or outcomes?"

2. ASK BEHAVIORAL QUESTIONS using the STAR method (Situation, Task, Action, Result):
   - "Tell me about a time when you had to [scenario]"
   - "Describe a situation where you faced [challenge]"
   - "Give me an example of when you [behavior]"

3. ASK SCENARIO-BASED QUESTIONS:
   - "How would you approach [hypothetical situation]?"
   - "If you had to choose between [option A] and [option B], how would you decide?"
   - "Walk me through your process for [task]"

4. EXPLORE BEYOND THE JOB DESCRIPTION - Ask about:
   - Career motivations and goals
   - Learning experiences and professional development
   - Team dynamics and collaboration style
   - Specific tools, methodologies, or frameworks they've used
   - Challenges they're looking for in their next role
   - How they stay current with industry trends
   - Their approach to learning new technologies
   - Examples of mistakes they've made and what they learned

5. PROBE FOR SPECIFICS when answers are vague:
   - "Can you give me a concrete example?"
   - "What specific metrics or KPIs did you track?"
   - "How did you measure success?"
   - "What was your exact role versus your team's role?"

6. VARY YOUR QUESTION TYPES:
   - Technical questions about tools and skills
   - Process questions about how they work
   - Soft skill questions about communication and collaboration
   - Problem-solving questions with hypothetical scenarios
   - Culture fit questions about work style and values

Remember: You have 15 minutes. Most candidates can speak for 30-60 seconds per answer. That means you need approximately 15-20 distinct questions or topics. The job description is your starting point, but you should explore each area deeply with multiple follow-ups.

NEVER say "I'm running out of questions" or wrap up early just because you've covered the basic requirements. Keep exploring, keep probing, and keep the conversation going until the time tool tells you to wrap up.

${candidateName ? `The candidate's name is ${candidateName}. ` : ''}You should begin the interview now by greeting the candidate warmly and asking your first question.`;

        // Store the interview session
        const interview: InterviewSession = {
            sessionId,
            jobTitle,
            candidateName,
            jobDescription,
            systemPrompt,
            createdAt: new Date(),
            status: 'active',
            transcript: []
        };

        interviewSessions.set(sessionId, interview);

        console.log(`Created interview session: ${sessionId} for ${jobTitle}`);

        res.json({
            sessionId,
            interviewUrl: `/interview/${sessionId}`
        });
    } catch (error) {
        console.error('Error creating session:', error);
        res.status(500).json({ error: 'Failed to create session' });
    }
});

// Get all sessions
app.get('/api/sessions', (_req: express.Request, res: express.Response) => {
    const sessions = Array.from(interviewSessions.values()).map(s => ({
        sessionId: s.sessionId,
        jobTitle: s.jobTitle,
        candidateName: s.candidateName,
        createdAt: s.createdAt,
        status: s.status
    }));
    res.json(sessions);
});

// Get specific session details
app.get('/api/session/:sessionId', (req: express.Request, res: express.Response): void => {
    const session = interviewSessions.get(req.params.sessionId);
    if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
    }
    res.json(session);
});

// Serve interview page
app.get('/interview/:sessionId', (req: express.Request, res: express.Response) => {
    res.sendFile(path.join(__dirname, '../public/interview.html'));
});

// Serve admin page as landing page at root
app.get('/', (req: express.Request, res: express.Response) => {
    res.sendFile(path.join(__dirname, '../public/admin.html'));
});

// Also serve admin page at /admin for backwards compatibility
app.get('/admin', (req: express.Request, res: express.Response) => {
    res.sendFile(path.join(__dirname, '../public/admin.html'));
});

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, '../public')));

// Helper function to create and initialize a new session
async function createNewSession(socket: any): Promise<StreamSession> {
    const sessionId = socket.id;

    try {
        console.log(`Creating new session for client: ${sessionId}`);
        sessionStates.set(sessionId, SessionState.INITIALIZING);

        // Create session with the correct API
        const session = bedrockClient.createStreamSession(sessionId);

        // Set up event handlers
        setupSessionEventHandlers(session, socket);

        // Store the session (don't initiate AWS Bedrock connection yet)
        socketSessions.set(sessionId, session);
        sessionStates.set(sessionId, SessionState.READY);

        console.log(`Session ${sessionId} created and ready, stored in maps`);
        console.log(`Session map size: ${socketSessions.size}, States map size: ${sessionStates.size}`);
        console.log(`Stored session for ${sessionId}:`, !!socketSessions.get(sessionId));

        return session;
    } catch (error) {
        console.error(`Error creating session for ${sessionId}:`, error);
        sessionStates.set(sessionId, SessionState.CLOSED);
        throw error;
    }
}

// Helper function to set up event handlers for a session
function setupSessionEventHandlers(session: StreamSession, socket: any) {


    session.onEvent('usageEvent', (data) => {
        console.log('usageEvent:', data);
        socket.emit('usageEvent', data);
    });

    session.onEvent('completionStart', (data) => {
        console.log('completionStart:', data);
        socket.emit('completionStart', data);
    });

    session.onEvent('contentStart', (data) => {
        console.log('contentStart:', data);
        socket.emit('contentStart', data);
    });

    session.onEvent('textOutput', (data) => {
        console.log('Text output:', data);
        socket.emit('textOutput', data);
    });

    session.onEvent('audioOutput', (data) => {
        console.log('Audio output received, sending to client');
        socket.emit('audioOutput', data);
    });

    session.onEvent('error', (data) => {
        console.error('Error in session:', data);
        socket.emit('error', data);
    });

    session.onEvent('toolUse', (data) => {
        console.log('Tool use detected:', data.toolName);
        socket.emit('toolUse', data);
    });

    session.onEvent('toolResult', (data) => {
        console.log('Tool result received');
        socket.emit('toolResult', data);
    });

    session.onEvent('contentEnd', (data) => {
        console.log('Content end received: ', data);
        socket.emit('contentEnd', data);
    });

    session.onEvent('streamComplete', () => {
        console.log('Stream completed for client:', socket.id);
        socket.emit('streamComplete');
        sessionStates.set(socket.id, SessionState.CLOSED);
    });

    // Handle retry required event (timeout/error recovery)
    session.onEvent('retryRequired', async (data) => {
        // Prevent duplicate retry handling (event might fire from old and new sessions)
        if (retryInProgress.has(socket.id)) {
            console.log(`Retry already in progress for ${socket.id}, skipping duplicate event`);
            return;
        }

        retryInProgress.add(socket.id);
        console.log('🔄 Retry required for session:', socket.id, 'Retry count:', data.retryCount);

        // Mark session as reinitializing to drop audio packets during retry
        sessionStates.set(socket.id, SessionState.INITIALIZING);

        // Emit retry event to client with chat history
        socket.emit('retryRequired', {
            retryCount: data.retryCount,
            chatHistoryLength: data.chatHistory?.length || 0,
            reason: data.reason
        });

        // Automatically create new session and inject history
        try {
            console.log('Creating new session with chat history for retry...');

            // NOTE: cleanupForRetry() already sent contentEnd → promptEnd → sessionEnd
            // So we just need to remove the old session from our map
            socketSessions.delete(socket.id);

            // Create brand new session
            const newSession = await createNewSession(socket);
            socketSessions.set(socket.id, newSession);

            // Initialize session and prompt start
            await newSession.setupSessionAndPromptStart();

            // Get interview session to retrieve system prompt
            const interviewSessionId = socketToInterviewSession.get(socket.id);
            let systemPrompt = "You are a helpful assistant.";
            if (interviewSessionId) {
                const interviewSession = interviewSessions.get(interviewSessionId);
                if (interviewSession) {
                    systemPrompt = interviewSession.systemPrompt;
                }
            }

            // Setup system prompt
            await newSession.setupSystemPrompt(undefined, systemPrompt);

            // **CRITICAL**: Inject chat history AFTER system prompt, BEFORE audio start
            if (data.chatHistory && data.chatHistory.length > 0) {
                console.log(`Injecting ${data.chatHistory.length} messages from chat history...`);
                const client = (newSession as any).client; // Access underlying client
                await client.injectChatHistory(newSession.getSessionId(), data.chatHistory);
            }

            // **CRITICAL**: Restore original interview start time to preserve elapsed time
            if (data.originalStartTime) {
                console.log(`Restoring original interview start time: ${new Date(data.originalStartTime).toISOString()}`);
                const client = (newSession as any).client;
                client.restoreSessionStartTime(newSession.getSessionId(), data.originalStartTime);
            }

            // Setup audio start
            await newSession.setupStartAudio();

            // **CRITICAL**: Start the AWS Bedrock connection to send queued events
            console.log(`Starting AWS Bedrock connection for retry session ${socket.id}`);
            bedrockClient.initiateBidirectionalStreaming(socket.id);

            // Mark session as active - ready to accept audio again
            sessionStates.set(socket.id, SessionState.ACTIVE);

            console.log('Session successfully resumed with chat history');
            socket.emit('sessionResumed', {
                success: true,
                messagesRestored: data.chatHistory?.length || 0
            });

        } catch (error) {
            console.error('Error during retry/resume:', error);
            sessionStates.set(socket.id, SessionState.CLOSED);
            socket.emit('retryFailed', {
                error: error instanceof Error ? error.message : String(error)
            });
        } finally {
            // Remove from retry in progress
            retryInProgress.delete(socket.id);
        }
    });

    // Handle max retries exceeded
    session.onEvent('maxRetriesExceeded', (data) => {
        console.error('❌ Max retries exceeded for session:', socket.id);
        socket.emit('maxRetriesExceeded', {
            chatHistoryLength: data.chatHistory?.length || 0,
            message: 'Maximum retry attempts reached. Please start a new interview.'
        });
    });

    // Handle interview completion signal from agent
    session.onEvent('interviewComplete', (data) => {
        console.log('🎬 Interview completion signal received from agent:', data);

        // Wait 5 seconds for final audio to play, then close gracefully
        setTimeout(() => {
            console.log('Closing interview session after agent completion');

            // Emit completion event to client
            socket.emit('streamComplete');

            // Update state
            sessionStates.set(socket.id, SessionState.CLOSED);
            cleanupInProgress.set(socket.id, true);

            // Close the session gracefully
            session.close().catch((error) => {
                console.error('Error closing session:', error);
            });

            // Clean up maps
            socketSessions.delete(socket.id);
            cleanupInProgress.delete(socket.id);

            console.log(`Session ${socket.id} closed after agent-initiated completion`);
        }, 5000); // 5 second delay for audio playback
    });
}

// Socket.IO connection handler
io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);

    // Get interview session ID from handshake query if present
    const interviewSessionId = socket.handshake.query.interviewSessionId as string;
    if (interviewSessionId) {
        const interviewSession = interviewSessions.get(interviewSessionId);
        if (interviewSession) {
            socketToInterviewSession.set(socket.id, interviewSessionId);
            console.log(`Socket ${socket.id} linked to interview session: ${interviewSessionId}`);
        } else {
            console.warn(`Interview session ${interviewSessionId} not found`);
        }
    }

    // Don't create session immediately - wait for client to request it
    sessionStates.set(socket.id, SessionState.CLOSED);

    // Connection count logging (only set up once per connection)
    const connectionInterval = setInterval(() => {
        const connectionCount = Object.keys(io.sockets.sockets).length;
        console.log(`Active socket connections: ${connectionCount}`);
    }, 60000);

    // Handle session initialization request
    socket.on('initializeConnection', async (callback) => {
        try {
            const currentState = sessionStates.get(socket.id);
            console.log(`Initializing session for ${socket.id}, current state: ${currentState}`);
            if (currentState === SessionState.INITIALIZING || currentState === SessionState.READY || currentState === SessionState.ACTIVE) {
                console.log(`Session already exists for ${socket.id}, state: ${currentState}`);
                if (callback) callback({ success: true });
                return;
            }

            await createNewSession(socket);

            // Start the AWS Bedrock connection
            console.log(`Starting AWS Bedrock connection for ${socket.id}`);
            bedrockClient.initiateBidirectionalStreaming(socket.id);

            // Update state to active
            sessionStates.set(socket.id, SessionState.ACTIVE);

            if (callback) callback({ success: true });

        } catch (error) {
            console.error('Error initializing session:', error);
            sessionStates.set(socket.id, SessionState.CLOSED);
            if (callback) callback({ success: false, error: error instanceof Error ? error.message : String(error) });
            socket.emit('error', {
                message: 'Failed to initialize session',
                details: error instanceof Error ? error.message : String(error)
            });
        }
    });

    // Handle starting a new chat (after stopping previous one)
    socket.on('startNewChat', async () => {
        try {
            const currentState = sessionStates.get(socket.id);
            console.log(`Starting new chat for ${socket.id}, current state: ${currentState}`);

            // Clean up existing session if any
            const existingSession = socketSessions.get(socket.id);
            if (existingSession && bedrockClient.isSessionActive(socket.id)) {
                console.log(`Cleaning up existing session for ${socket.id}`);
                try {
                    await existingSession.endAudioContent();
                    await existingSession.endPrompt();
                    await existingSession.close();
                } catch (cleanupError) {
                    console.error(`Error during cleanup for ${socket.id}:`, cleanupError);
                    bedrockClient.forceCloseSession(socket.id);
                }
                socketSessions.delete(socket.id);
            }

            // Create new session
            await createNewSession(socket);
        } catch (error) {
            console.error('Error starting new chat:', error);
            socket.emit('error', {
                message: 'Failed to start new chat',
                details: error instanceof Error ? error.message : String(error)
            });
        }
    });

    // Audio input handler with session validation
    socket.on('audioInput', async (audioData) => {
        try {
            const session = socketSessions.get(socket.id);
            const currentState = sessionStates.get(socket.id);

            // console.log(`Audio input received for ${socket.id}, session exists: ${!!session}, state: ${currentState}`);

            if (!session || currentState !== SessionState.ACTIVE) {
                // Silently drop audio packets if session isn't ready yet
                // This is normal during initialization - client may send a few packets before session is fully active
                return;
            }

            // Convert base64 string to Buffer
            const audioBuffer = typeof audioData === 'string'
                ? Buffer.from(audioData, 'base64')
                : Buffer.from(audioData);

            // Stream the audio
            await session.streamAudio(audioBuffer);

        } catch (error) {
            console.error('Error processing audio:', error);
            socket.emit('error', {
                message: 'Error processing audio',
                details: error instanceof Error ? error.message : String(error)
            });
        }
    });

    socket.on('promptStart', async () => {
        try {
            const session = socketSessions.get(socket.id);
            const currentState = sessionStates.get(socket.id);
            console.log(`Prompt start received for ${socket.id}, session exists: ${!!session}, state: ${currentState}`);

            if (!session) {
                console.error(`No session found for promptStart: ${socket.id}`);
                socket.emit('error', { message: 'No active session for prompt start' });
                return;
            }

            await session.setupSessionAndPromptStart();
            console.log(`Prompt start completed for ${socket.id}`);
        } catch (error) {
            console.error('Error processing prompt start:', error);
            socket.emit('error', {
                message: 'Error processing prompt start',
                details: error instanceof Error ? error.message : String(error)
            });
        }
    });

    socket.on('systemPrompt', async (data) => {
        try {
            const session = socketSessions.get(socket.id);
            const currentState = sessionStates.get(socket.id);
            console.log(`System prompt received for ${socket.id}, session exists: ${!!session}, state: ${currentState}`);

            if (!session) {
                console.error(`No session found for systemPrompt: ${socket.id}`);
                socket.emit('error', { message: 'No active session for system prompt' });
                return;
            }

            // Check if this socket is linked to an interview session
            const interviewSessionId = socketToInterviewSession.get(socket.id);
            let systemPrompt = data;

            if (interviewSessionId) {
                const interviewSession = interviewSessions.get(interviewSessionId);
                if (interviewSession) {
                    systemPrompt = interviewSession.systemPrompt;
                    console.log(`Using custom system prompt for interview session: ${interviewSessionId}`);
                }
            }

            await session.setupSystemPrompt(undefined, systemPrompt);
            console.log(`System prompt completed for ${socket.id}`);
        } catch (error) {
            console.error('Error processing system prompt:', error);
            socket.emit('error', {
                message: 'Error processing system prompt',
                details: error instanceof Error ? error.message : String(error)
            });
        }
    });

    // 🧪 Manual test trigger for retry logic
    socket.on('triggerRetry', async (data) => {
        console.log('🧪 Manual retry test triggered for', socket.id);
        const session = socketSessions.get(socket.id);
        if (!session) {
            console.error('No session found for manual retry test');
            return;
        }

        // Get the underlying client to access chat history
        const client = (session as any).client;
        if (client) {
            // Manually trigger cleanup with a simulated timeout
            await client.cleanupForRetry(session.getSessionId());
        } else {
            console.error('Could not access client for manual retry test');
        }
    });

    socket.on('audioStart', async (data) => {
        try {
            const session = socketSessions.get(socket.id);
            const currentState = sessionStates.get(socket.id);
            console.log(`Audio start received for ${socket.id}, session exists: ${!!session}, state: ${currentState}`);

            if (!session) {
                console.error(`No session found for audioStart: ${socket.id}`);
                socket.emit('error', { message: 'No active session for audio start' });
                return;
            }

            // Set up audio configuration
            await session.setupStartAudio();
            console.log(`Audio start setup completed for ${socket.id}`);

            // Emit confirmation that session is fully ready for audio
            socket.emit('audioReady');
        } catch (error) {
            console.error('Error processing audio start:', error);
            sessionStates.set(socket.id, SessionState.CLOSED);
            socket.emit('error', {
                message: 'Error processing audio start',
                details: error instanceof Error ? error.message : String(error)
            });
        }
    });

    socket.on('stopAudio', async () => {
        try {
            const session = socketSessions.get(socket.id);
            if (!session || cleanupInProgress.get(socket.id)) {
                console.log('No active session to stop or cleanup already in progress');
                return;
            }

            console.log('Stop audio requested, beginning proper shutdown sequence');
            cleanupInProgress.set(socket.id, true);
            sessionStates.set(socket.id, SessionState.CLOSED);

            // Chain the closing sequence with timeout protection
            const cleanupPromise = Promise.race([
                (async () => {
                    await session.endAudioContent();
                    await session.endPrompt();
                    await session.close();
                    console.log('Session cleanup complete');
                })(),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Session cleanup timeout')), 5000)
                )
            ]);

            await cleanupPromise;

            // Remove from tracking
            socketSessions.delete(socket.id);
            cleanupInProgress.delete(socket.id);

            // Notify client that session is closed and ready for new chat
            socket.emit('sessionClosed');

        } catch (error) {
            console.error('Error processing streaming end events:', error);

            // Force cleanup on error
            try {
                bedrockClient.forceCloseSession(socket.id);
                socketSessions.delete(socket.id);
                cleanupInProgress.delete(socket.id);
                sessionStates.set(socket.id, SessionState.CLOSED);
            } catch (forceError) {
                console.error('Error during force cleanup:', forceError);
            }

            socket.emit('error', {
                message: 'Error processing streaming end events',
                details: error instanceof Error ? error.message : String(error)
            });
        }
    });

    // Handle disconnection
    socket.on('disconnect', async () => {
        console.log('Client disconnected abruptly:', socket.id);

        // Clear the connection interval
        clearInterval(connectionInterval);

        const session = socketSessions.get(socket.id);
        const sessionId = socket.id;

        if (session && bedrockClient.isSessionActive(sessionId) && !cleanupInProgress.get(socket.id)) {
            try {
                console.log(`Beginning cleanup for abruptly disconnected session: ${socket.id}`);
                cleanupInProgress.set(socket.id, true);

                // Add explicit timeouts to avoid hanging promises
                const cleanupPromise = Promise.race([
                    (async () => {
                        await session.endAudioContent();
                        await session.endPrompt();
                        await session.close();
                    })(),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Session cleanup timeout')), 3000)
                    )
                ]);

                await cleanupPromise;
                console.log(`Successfully cleaned up session after abrupt disconnect: ${socket.id}`);
            } catch (error) {
                console.error(`Error cleaning up session after disconnect: ${socket.id}`, error);
                try {
                    bedrockClient.forceCloseSession(sessionId);
                    console.log(`Force closed session: ${sessionId}`);
                } catch (e) {
                    console.error(`Failed even force close for session: ${sessionId}`, e);
                }
            }
        }

        // Clean up tracking maps
        socketSessions.delete(socket.id);
        sessionStates.delete(socket.id);
        cleanupInProgress.delete(socket.id);
        socketToInterviewSession.delete(socket.id);

        console.log(`Cleanup complete for disconnected client: ${socket.id}`);
    });
});

// Health check endpoint
app.get('/health', (_req: express.Request, res: express.Response) => {
    const activeSessions = bedrockClient.getActiveSessions().length;
    const socketConnections = Object.keys(io.sockets.sockets).length;

    res.status(200).json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        activeSessions,
        socketConnections
    });
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`Open http://localhost:${PORT} in your browser to access the application`);
});

process.on('SIGINT', async () => {
    console.log('Shutting down server...');

    const forceExitTimer = setTimeout(() => {
        console.error('Forcing server shutdown after timeout');
        process.exit(1);
    }, 5000);

    try {
        // First close Socket.IO server which manages WebSocket connections
        await new Promise(resolve => io.close(resolve));
        console.log('Socket.IO server closed');

        // Then close all active sessions
        const activeSessions = bedrockClient.getActiveSessions();
        console.log(`Closing ${activeSessions.length} active sessions...`);

        await Promise.all(activeSessions.map(async (sessionId) => {
            try {
                await bedrockClient.closeSession(sessionId);
                console.log(`Closed session ${sessionId} during shutdown`);
            } catch (error) {
                console.error(`Error closing session ${sessionId} during shutdown:`, error);
                bedrockClient.forceCloseSession(sessionId);
            }
        }));

        // Now close the HTTP server with a promise
        await new Promise(resolve => server.close(resolve));
        clearTimeout(forceExitTimer);
        console.log('Server shut down');
        process.exit(0);
    } catch (error) {
        console.error('Error during server shutdown:', error);
        process.exit(1);
    }
});