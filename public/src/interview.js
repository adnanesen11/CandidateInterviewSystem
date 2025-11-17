import { AudioPlayer } from './lib/play/AudioPlayer.js';
import { ChatHistoryManager } from "./lib/util/ChatHistoryManager.js";

// Extract session ID from URL
const pathParts = window.location.pathname.split('/');
const interviewSessionId = pathParts[pathParts.length - 1];

let socket;
let SYSTEM_PROMPT = '';

// DOM elements
const startButton = document.getElementById('start');
const stopButton = document.getElementById('stop');
const testRetryButton = document.getElementById('test-retry');
const statusElement = document.getElementById('status');
const chatContainer = document.getElementById('chat-container');
const cameraFeed = document.getElementById('camera-feed');
const cameraStatus = document.getElementById('camera-status');

// Camera variables
let cameraStream = null;
let isCameraActive = false;

// Initialize the interview session
async function initializeInterviewSession() {
    if (!interviewSessionId || interviewSessionId === 'interview') {
        statusElement.textContent = "Invalid interview link";
        statusElement.className = "error";
        return;
    }

    try {
        // Fetch session details
        const response = await fetch(`/api/session/${interviewSessionId}`);
        if (!response.ok) {
            throw new Error('Interview session not found');
        }

        const session = await response.json();
        SYSTEM_PROMPT = session.systemPrompt;

        // Connect to socket with interview session ID
        socket = io({
            query: { interviewSessionId }
        });

        // Set up all socket listeners
        setupSocketListeners();

        // Initialize audio
        await initAudio();

    } catch (error) {
        console.error('Error loading interview session:', error);
        statusElement.textContent = "Error: " + error.message;
        statusElement.className = "error";
    }
}

// Chat history management
let chat = { history: [] };
const chatRef = { current: chat };
const chatHistoryManager = ChatHistoryManager.getInstance(
    chatRef,
    (newChat) => {
        chat = { ...newChat };
        chatRef.current = chat;
        updateChatUI();
    }
);

// Audio processing variables
let audioContext;
let audioStream;
let isStreaming = false;
let processor;
let sourceNode;
let waitingForAssistantResponse = false;
let waitingForUserTranscription = false;
let userThinkingIndicator = null;
let assistantThinkingIndicator = null;
let transcriptionReceived = false;
let displayAssistantText = false;
let role;
const audioPlayer = new AudioPlayer();
let initialAudioSent = false;
let initialAudioData = null;
let initialAudioChunkSize = 512; // Size of chunks to send initial audio in
let initialMessageShown = false;
let sessionInitialized = false;
let manualDisconnect = false;

let samplingRatio = 1;
const TARGET_SAMPLE_RATE = 16000;
const isFirefox = navigator.userAgent.toLowerCase().includes('firefox');

// Load initial audio file
async function loadInitialAudio() {
    try {
        const response = await fetch('/input-audio-example/hi.raw');
        if (!response.ok) {
            throw new Error(`Failed to load initial audio: ${response.status} ${response.statusText}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        initialAudioData = new Int16Array(arrayBuffer);
        console.log('Initial audio loaded successfully', initialAudioData.length);
        return true;
    } catch (error) {
        console.error('Error loading initial audio:', error);
        return false;
    }
}

// Send initial audio file to model
async function sendInitialAudio() {
    if (!initialAudioData || initialAudioSent) return false;

    try {
        // Send initial audio data in chunks to simulate streaming
        for (let i = 0; i < initialAudioData.length; i += initialAudioChunkSize) {
            const end = Math.min(i + initialAudioChunkSize, initialAudioData.length);
            const chunk = initialAudioData.slice(i, end);

            // Convert chunk to base64
            const base64Data = arrayBufferToBase64(chunk.buffer);

            // Send chunk to server
            socket.emit('audioInput', base64Data);
        }

        initialAudioSent = true;
        console.log('Initial audio sent successfully');
        return true;
    } catch (error) {
        console.error('Error sending initial audio:', error);
        return false;
    }
}

// Initialize WebSocket audio
async function initAudio() {
    try {
        // Don't change status message during microphone access
        // statusElement.textContent = "Requesting microphone access...";
        // statusElement.className = "connecting";

        // Load initial audio file
        await loadInitialAudio();

        // Request microphone access
        audioStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });

        if (isFirefox) {
            audioContext = new AudioContext();
        } else {
            audioContext = new AudioContext({
                sampleRate: TARGET_SAMPLE_RATE
            });
        }

        samplingRatio = audioContext.sampleRate / TARGET_SAMPLE_RATE;
        console.log(`Debug AudioContext- sampleRate: ${audioContext.sampleRate} samplingRatio: ${samplingRatio}`)

        await audioPlayer.start();

        // Don't change status after initialization - keep "Welcome to CT test"
        // statusElement.textContent = "Microphone ready. Click Start to begin.";
        // statusElement.className = "ready";
        startButton.disabled = false;
    } catch (error) {
        console.error("Error accessing microphone:", error);
        statusElement.textContent = "Error: " + error.message;
        statusElement.className = "error";
    }
}

// Initialize the session with Bedrock
async function initializeSession() {
    if (sessionInitialized) return;

    statusElement.textContent = "Initializing session...";

    try {
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Connection timeout')), 5000);

            socket.emit('initializeConnection', (ack) => {
                clearTimeout(timeout);
                if (ack?.success) resolve();
                else reject(new Error(ack?.error || 'Connection failed'));
            });
        });

        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Audio setup timeout')), 10000);

            socket.once('audioReady', () => {
                clearTimeout(timeout);
                resolve();
            });

            socket.emit('promptStart');
            socket.emit('systemPrompt', SYSTEM_PROMPT);
            socket.emit('audioStart');
        });

        sessionInitialized = true;
        statusElement.textContent = "Session initialized successfully";
    } catch (error) {
        console.error("Failed to initialize session:", error);
        statusElement.textContent = "Error initializing session";
        statusElement.className = "error";
        throw error;
    }
}

async function startStreaming() {
    if (isStreaming) return;

    try {
        // Clear chat history when starting new stream
        chat.history = [];
        chatRef.current = chat;
        updateChatUI();

        // Reset all client-side state
        initialAudioSent = false;
        initialMessageShown = false;

        if (!socket.connected) {
            socket.connect();
            await new Promise((resolve) => {
                if (socket.connected) {
                    resolve();
                } else {
                    socket.once('connect', resolve);
                }
            });
        }

        if (!audioPlayer.initialized) {
            await audioPlayer.start();
        }

        if (!sessionInitialized) {
            await initializeSession();
        }

        // Send initial audio first (as if it's coming from the user)
        if (initialAudioData && !initialAudioSent) {
            await sendInitialAudio();
        }

        sourceNode = audioContext.createMediaStreamSource(audioStream);

        if (audioContext.createScriptProcessor) {
            processor = audioContext.createScriptProcessor(512, 1, 1);

            processor.onaudioprocess = (e) => {
                if (!isStreaming) return;

                const inputData = e.inputBuffer.getChannelData(0);
                const numSamples = Math.round(inputData.length / samplingRatio)
                const pcmData = isFirefox ? (new Int16Array(numSamples)) : (new Int16Array(inputData.length));

                if (isFirefox) {
                    for (let i = 0; i < inputData.length; i++) {
                        pcmData[i] = Math.max(-1, Math.min(1, inputData[i * samplingRatio])) * 0x7FFF;
                    }
                } else {
                    for (let i = 0; i < inputData.length; i++) {
                        pcmData[i] = Math.max(-1, Math.min(1, inputData[i])) * 0x7FFF;
                    }
                }

                const base64Data = arrayBufferToBase64(pcmData.buffer);
                socket.emit('audioInput', base64Data);
            };

            sourceNode.connect(processor);
            processor.connect(audioContext.destination);
        }

        isStreaming = true;
        startButton.disabled = true;
        stopButton.disabled = false;
        testRetryButton.style.display = 'inline-flex'; // Show test button
        statusElement.textContent = "Streaming... Speak now";
        statusElement.className = "recording";

        transcriptionReceived = false;
        // Don't show user thinking indicator initially - let agent speak first
        // showUserThinkingIndicator();

    } catch (error) {
        console.error("Error starting recording:", error);
        statusElement.textContent = "Error: " + error.message;
        statusElement.className = "error";
    }
}

function arrayBufferToBase64(buffer) {
    const binary = [];
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
        binary.push(String.fromCharCode(bytes[i]));
    }
    return btoa(binary.join(''));
}

function stopStreaming() {
    if (!isStreaming) return;

    isStreaming = false;

    if (processor) {
        processor.disconnect();
        sourceNode.disconnect();
    }

    startButton.disabled = false;
    stopButton.disabled = true;
    statusElement.textContent = "Processing...";
    statusElement.className = "processing";

    audioPlayer.bargeIn();
    socket.emit('stopAudio');

    chatHistoryManager.endTurn();
    sessionInitialized = false;
    manualDisconnect = true;
    socket.disconnect();

    statusElement.textContent = "Stopped. Click Start to begin new session.";
    statusElement.className = "ready";
}

function base64ToFloat32Array(base64String) {
    try {
        const binaryString = window.atob(base64String);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }

        const int16Array = new Int16Array(bytes.buffer);
        const float32Array = new Float32Array(int16Array.length);
        for (let i = 0; i < int16Array.length; i++) {
            float32Array[i] = int16Array[i] / 32768.0;
        }

        return float32Array;
    } catch (error) {
        console.error('Error in base64ToFloat32Array:', error);
        throw error;
    }
}

function handleTextOutput(data) {
    console.log("Processing text output:", data);
    // Skip adding the initial "hi" message to chat history if it's from USER
    if (data.role === 'USER' && !initialMessageShown) {
        initialMessageShown = true;
        console.log("Initial user message skipped in UI:", data.content);
        return;
    }

    if (data.content) {
        const messageData = {
            role: data.role,
            message: data.content
        };
        chatHistoryManager.addTextMessage(messageData);
    }
}

function updateChatUI() {
    if (!chatContainer) {
        console.error("Chat container not found");
        return;
    }

    chatContainer.innerHTML = '';

    chat.history.forEach(item => {
        if (item.endOfConversation) {
            const endDiv = document.createElement('div');
            endDiv.className = 'message system';
            endDiv.textContent = "Conversation ended";
            chatContainer.appendChild(endDiv);
            return;
        }

        if (item.role) {
            const messageDiv = document.createElement('div');
            const roleLowerCase = item.role.toLowerCase();
            messageDiv.className = `message ${roleLowerCase}`;

            const roleLabel = document.createElement('div');
            roleLabel.className = 'role-label';
            roleLabel.textContent = item.role;
            messageDiv.appendChild(roleLabel);

            const content = document.createElement('div');
            content.textContent = item.message || "No content";
            messageDiv.appendChild(content);

            chatContainer.appendChild(messageDiv);
        }
    });

    if (waitingForUserTranscription) {
        showUserThinkingIndicator();
    }

    if (waitingForAssistantResponse) {
        showAssistantThinkingIndicator();
    }

    chatContainer.scrollTop = chatContainer.scrollHeight;
}

function showUserThinkingIndicator() {
    hideUserThinkingIndicator();

    waitingForUserTranscription = true;
    userThinkingIndicator = document.createElement('div');
    userThinkingIndicator.className = 'message user thinking';

    const roleLabel = document.createElement('div');
    roleLabel.className = 'role-label';
    roleLabel.textContent = 'USER';
    userThinkingIndicator.appendChild(roleLabel);

    const listeningText = document.createElement('div');
    listeningText.className = 'thinking-text';
    listeningText.textContent = 'Listening';
    userThinkingIndicator.appendChild(listeningText);

    const dotContainer = document.createElement('div');
    dotContainer.className = 'thinking-dots';

    for (let i = 0; i < 3; i++) {
        const dot = document.createElement('span');
        dot.className = 'dot';
        dotContainer.appendChild(dot);
    }

    userThinkingIndicator.appendChild(dotContainer);
    chatContainer.appendChild(userThinkingIndicator);
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

function showAssistantThinkingIndicator() {
    hideAssistantThinkingIndicator();

    waitingForAssistantResponse = true;
    assistantThinkingIndicator = document.createElement('div');
    assistantThinkingIndicator.className = 'message assistant thinking';

    const roleLabel = document.createElement('div');
    roleLabel.className = 'role-label';
    roleLabel.textContent = 'ASSISTANT';
    assistantThinkingIndicator.appendChild(roleLabel);

    const thinkingText = document.createElement('div');
    thinkingText.className = 'thinking-text';
    thinkingText.textContent = 'Thinking';
    assistantThinkingIndicator.appendChild(thinkingText);

    const dotContainer = document.createElement('div');
    dotContainer.className = 'thinking-dots';

    for (let i = 0; i < 3; i++) {
        const dot = document.createElement('span');
        dot.className = 'dot';
        dotContainer.appendChild(dot);
    }

    assistantThinkingIndicator.appendChild(dotContainer);
    chatContainer.appendChild(assistantThinkingIndicator);
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

function hideUserThinkingIndicator() {
    waitingForUserTranscription = false;
    if (userThinkingIndicator && userThinkingIndicator.parentNode) {
        userThinkingIndicator.parentNode.removeChild(userThinkingIndicator);
    }
    userThinkingIndicator = null;
}

function hideAssistantThinkingIndicator() {
    waitingForAssistantResponse = false;
    if (assistantThinkingIndicator && assistantThinkingIndicator.parentNode) {
        assistantThinkingIndicator.parentNode.removeChild(assistantThinkingIndicator);
    }
    assistantThinkingIndicator = null;
}

// Set up socket event listeners
function setupSocketListeners() {
    socket.on('contentStart', (data) => {
        console.log('Content start received:', data);

        if (data.type === 'TEXT') {
            role = data.role;
            if (data.role === 'USER') {
                hideUserThinkingIndicator();
            }
            else if (data.role === 'ASSISTANT') {
                hideAssistantThinkingIndicator();

                // Only display FINAL text, not SPECULATIVE (preview)
                let shouldDisplay = false;  // Default to NOT displaying

                try {
                    if (data.additionalModelFields) {
                        const additionalFields = JSON.parse(data.additionalModelFields);
                        const generationStage = additionalFields.generationStage;

                        if (generationStage === "FINAL") {
                            console.log("ASSISTANT FINAL text - will display");
                            shouldDisplay = true;
                        } else if (generationStage === "SPECULATIVE") {
                            console.log("ASSISTANT SPECULATIVE text - will NOT display");
                            shouldDisplay = false;
                        }
                    } else {
                        // If no additionalModelFields, assume it's final to be safe
                        console.log("No additionalModelFields - assuming FINAL");
                        shouldDisplay = true;
                    }
                } catch (e) {
                    console.error("Error parsing additionalModelFields:", e);
                    shouldDisplay = true;  // On error, display to be safe
                }

                displayAssistantText = shouldDisplay;
            }
        }
        else if (data.type === 'AUDIO') {
            console.log(`Audio contentStart - role: ${data.role}`);

            if (isStreaming) {
                showUserThinkingIndicator();
            }
        }
    });

    socket.on('textOutput', (data) => {
        console.log('Received text output:', data);
        console.log('Current role:', role, 'displayAssistantText:', displayAssistantText);

        if (role === 'USER') {
            transcriptionReceived = true;

            handleTextOutput({
                role: data.role,
                content: data.content
            });

            showAssistantThinkingIndicator();
        }
        else if (role === 'ASSISTANT') {
            console.log('Processing ASSISTANT text. displayAssistantText =', displayAssistantText);
            if (displayAssistantText) {
                console.log('✓ Displaying ASSISTANT text:', data.content);
                handleTextOutput({
                    role: data.role,
                    content: data.content
                });
            } else {
                console.log('✗ Skipping ASSISTANT text (speculative):', data.content);
            }
        }
    });

    socket.on('audioOutput', (data) => {
        // Play audio immediately - don't buffer
        // Nova Sonic generates faster than real-time, so we play as chunks arrive
        if (data.content) {
            try {
                const audioData = base64ToFloat32Array(data.content);
                audioPlayer.playAudio(audioData);
            } catch (error) {
                console.error('Error processing audio data:', error);
            }
        }
    });

    socket.on('contentEnd', (data) => {
        console.log('Content end received:', data);

        if (data.type === 'TEXT') {
            if (role === 'USER') {
                hideUserThinkingIndicator();
                showAssistantThinkingIndicator();
            }
            else if (role === 'ASSISTANT') {
                hideAssistantThinkingIndicator();
            }

            if (data.stopReason && data.stopReason.toUpperCase() === 'END_TURN') {
                chatHistoryManager.endTurn();
            } else if (data.stopReason && data.stopReason.toUpperCase() === 'INTERRUPTED') {
                console.log("Interrupted by user");
                audioPlayer.bargeIn();
            }
        }
        else if (data.type === 'AUDIO') {
            console.log(`Audio contentEnd - stopReason: ${data.stopReason}`);

            // If interrupted, clear the audio playback queue
            if (data.stopReason === 'INTERRUPTED') {
                console.log("Audio interrupted by user - clearing playback");
                audioPlayer.bargeIn();
            }

            if (isStreaming) {
                showUserThinkingIndicator();
            }
        }
    });

    socket.on('streamComplete', () => {
        if (isStreaming) {
            stopStreaming();
        }
        statusElement.textContent = "Microphone ready. Click Start to begin.";
        statusElement.className = "ready";
    });

    socket.on('connect', () => {
        statusElement.textContent = "Connected to server";
        statusElement.className = "connected";
        sessionInitialized = false;
        initialAudioSent = false;
        initialMessageShown = false;
    });

    socket.on('disconnect', () => {
        if (manualDisconnect) {
            manualDisconnect = false;
            statusElement.textContent = "Stopped. Click Start to begin new session.";
            statusElement.className = "ready";
            startButton.disabled = false;
            stopButton.disabled = true;
            testRetryButton.style.display = 'none'; // Hide test button
        } else {
            statusElement.textContent = "Disconnected from server";
            statusElement.className = "disconnected";
            startButton.disabled = true;
            stopButton.disabled = true;
        }
        sessionInitialized = false;
        hideUserThinkingIndicator();
        hideAssistantThinkingIndicator();
    });

    // Extract error handling into a function so we can call it from test button
    window.handleServerError = function(error) {
        console.error("Server error:", error);

        // Check if it's a timeout error that will trigger retry
        if (error.isTimeout && error.shouldRetry) {
            statusElement.textContent = "Connection timeout - reconnecting...";
            statusElement.className = "connecting";

            // Manually trigger the cleanup and retry on the server
            socket.emit('triggerRetry', { reason: 'manual_test' });
        } else {
            statusElement.textContent = "Error: " + (error.message || JSON.stringify(error).substring(0, 100));
            statusElement.className = "error";
            hideUserThinkingIndicator();
            hideAssistantThinkingIndicator();
        }
    };

    socket.on('error', (error) => {
        window.handleServerError(error);
    });

    // Handle retry required event
    socket.on('retryRequired', (data) => {
        console.log('🔄 Retry required:', data);
        statusElement.textContent = `Reconnecting (attempt ${data.retryCount}/3)...`;
        statusElement.className = "connecting";

        // Show a message to the user
        const retryMessage = {
            role: 'SYSTEM',
            message: `Connection interrupted. Reconnecting and restoring ${data.chatHistoryLength} messages...`
        };
        chatHistoryManager.addTextMessage(retryMessage);
    });

    // Handle session resumed event
    socket.on('sessionResumed', (data) => {
        console.log('✅ Session resumed:', data);
        statusElement.textContent = "Connection restored";
        statusElement.className = "connected";

        // Show success message
        const resumeMessage = {
            role: 'SYSTEM',
            message: `✓ Connection restored. Conversation resumed with ${data.messagesRestored} messages.`
        };
        chatHistoryManager.addTextMessage(resumeMessage);

        // Clear the message after 3 seconds
        setTimeout(() => {
            statusElement.textContent = "Streaming... Speak now";
            statusElement.className = "recording";
        }, 3000);
    });

    // Handle max retries exceeded
    socket.on('maxRetriesExceeded', (data) => {
        console.error('❌ Max retries exceeded:', data);
        statusElement.textContent = "Connection failed - please restart interview";
        statusElement.className = "error";

        const errorMessage = {
            role: 'SYSTEM',
            message: `❌ ${data.message}`
        };
        chatHistoryManager.addTextMessage(errorMessage);

        // Auto-stop streaming
        stopStreaming();
    });

    // Handle retry failed
    socket.on('retryFailed', (data) => {
        console.error('❌ Retry failed:', data);
        statusElement.textContent = "Failed to restore connection";
        statusElement.className = "error";

        const errorMessage = {
            role: 'SYSTEM',
            message: `Failed to restore connection: ${data.error}`
        };
        chatHistoryManager.addTextMessage(errorMessage);
    });
}

// Camera control functions
async function startCamera() {
    try {
        cameraStatus.textContent = 'Requesting camera access...';

        cameraStream = await navigator.mediaDevices.getUserMedia({
            video: {
                width: { ideal: 1280 },
                height: { ideal: 720 },
                facingMode: 'user'
            }
        });

        cameraFeed.srcObject = cameraStream;
        cameraFeed.classList.add('active');
        isCameraActive = true;

        // Hide the video overlay
        const videoOverlay = document.getElementById('video-overlay');
        if (videoOverlay) {
            videoOverlay.classList.add('hidden');
        }

        cameraStatus.textContent = 'Camera Active';

    } catch (error) {
        console.error('Error accessing camera:', error);
        cameraStatus.textContent = 'Camera Error: ' + error.message;
    }
}

// Auto-start camera function
async function initializeCamera() {
    await startCamera();
}

// Button event listeners
startButton.addEventListener('click', startStreaming);
stopButton.addEventListener('click', stopStreaming);

// Test retry button - simulates a timeout error
testRetryButton.addEventListener('click', () => {
    console.log('🧪 Manually triggering timeout error for testing...');

    // Simulate a timeout error from the server
    const timeoutError = {
        type: 'modelStreamErrorException',
        details: {
            message: 'Model has timed out in processing the request. Try your request again.'
        },
        isTimeout: true,
        shouldRetry: true
    };

    // Call the error handler directly (not emit to server)
    if (window.handleServerError) {
        window.handleServerError(timeoutError);
    }

    console.log('🧪 Timeout error triggered! Watch the retry flow...');
});

// Initialize when page loads
document.addEventListener('DOMContentLoaded', () => {
    initializeInterviewSession();
    initializeCamera(); // Auto-start camera
});
