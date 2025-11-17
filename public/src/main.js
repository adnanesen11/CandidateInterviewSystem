import { AudioPlayer } from './lib/play/AudioPlayer.js';
import { ChatHistoryManager } from "./lib/util/ChatHistoryManager.js";

// Connect to the server
const socket = io();

// DOM elements
const startButton = document.getElementById('start');
const stopButton = document.getElementById('stop');
const statusElement = document.getElementById('status');
const chatContainer = document.getElementById('chat-container');
const cameraFeed = document.getElementById('camera-feed');

// Helper function to update status
function updateStatus(text, type = 'ready') {
    if (statusElement) {
        const indicator = statusElement.querySelector('.status-indicator');
        const textEl = statusElement.querySelector('.status-text');
        if (textEl) textEl.textContent = text;
    }
}

// Camera variables
let cameraStream = null;
let isCameraActive = false;

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

// Custom system prompt - you can modify this
let SYSTEM_PROMPT = `You are an AI interviewer conducting a voice interview for a UI Developer position.

Job Description and Requirements:
We are looking for a UI Developer with strong React Proficiency. The individual will be responsible for designing databases and ensuring their stability, reliability and performance. Required skills include:
- Proficiency in React.js, Redux and TypeScript
- Strong experience with micro-frontend architecture and frameworks
- Proficient in Node.js and related frameworks (e.g., Express)
- Solid understanding of HTML, CSS, and JavaScript
- Experience with state management libraries such as Redux or MobX
- Familiarity with RESTful APIs and/or GraphQL
- Knowledge of Webpack, Babel, and other front-end build tools
- Experience: 3-6 years

Your role:
- Conduct a professional, conversational interview
- Ask relevant questions based on the job description
- Listen carefully to the candidate's responses
- Ask follow-up questions to understand their experience and skills
- Keep your questions concise and clear (2-3 sentences maximum)
- Be encouraging and professional
- Focus on evaluating: technical skills, problem-solving ability, communication, and cultural fit

Start by greeting the candidate and asking them to introduce themselves.

Begin the interview now.`;

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
            //firefox doesn't allow audio context have differnt sample rate than what the user media device offers
            audioContext = new AudioContext();
        } else {
            audioContext = new AudioContext({
                sampleRate: TARGET_SAMPLE_RATE
            });
        }

        //samplingRatio - is only relevant for firefox, for Chromium based browsers, it's always 1
        samplingRatio = audioContext.sampleRate / TARGET_SAMPLE_RATE;
        console.log(`Debug AudioContext- sampleRate: ${audioContext.sampleRate} samplingRatio: ${samplingRatio}`)
        

        await audioPlayer.start();

        // Don't change status after initialization - keep "Welcome to CT test"
        // statusElement.textContent = "Microphone ready. Click Start to begin.";
        // statusElement.className = "ready";
        startButton.disabled = false;
    } catch (error) {
        console.error("Error accessing microphone:", error);
        // statusElement.textContent = "Error: " + error.message;
        // statusElement.className = "error";
    }
}

// Initialize the session with Bedrock
async function initializeSession() {
    if (sessionInitialized) return;

    // statusElement.textContent = "Initializing session...";

    try {
        // Wait for server acknowledgment before proceeding
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Connection timeout')), 5000);

            socket.emit('initializeConnection', (ack) => {
                clearTimeout(timeout);
                if (ack?.success) resolve();
                else reject(new Error(ack?.error || 'Connection failed'));
            });
        });

        // Wait for audio to be ready before proceeding
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Audio setup timeout')), 10000);

            // Set up one-time listener for audioReady event
            socket.once('audioReady', () => {
                clearTimeout(timeout);
                resolve();
            });

            // Send events in sequence
            socket.emit('promptStart');
            socket.emit('systemPrompt', SYSTEM_PROMPT);
            socket.emit('audioStart');
        });

        // Mark session as initialized
        sessionInitialized = true;
        // statusElement.textContent = "Session initialized successfully";
    } catch (error) {
        console.error("Failed to initialize session:", error);
        // statusElement.textContent = "Error initializing session";
        // statusElement.className = "error";
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

        // Reconnect if disconnected
        if (!socket.connected) {
            socket.connect();
            // Wait for connection
            await new Promise((resolve) => {
                if (socket.connected) {
                    resolve();
                } else {
                    socket.once('connect', resolve);
                }
            });
        }

        // Restart audioPlayer if needed
        if (!audioPlayer.initialized) {
            await audioPlayer.start();
        }

        // First, make sure the session is initialized
        if (!sessionInitialized) {
            await initializeSession();
        }

        // Send initial audio first (as if it's coming from the user)
        if (initialAudioData && !initialAudioSent) {
            await sendInitialAudio();
        }

        // Create audio processor
        sourceNode = audioContext.createMediaStreamSource(audioStream);

        // Use ScriptProcessorNode for audio processing
        if (audioContext.createScriptProcessor) {
            processor = audioContext.createScriptProcessor(512, 1, 1);

            processor.onaudioprocess = (e) => {
                if (!isStreaming) return;

                const inputData = e.inputBuffer.getChannelData(0);
                const numSamples = Math.round(inputData.length / samplingRatio)
                const pcmData = isFirefox ? (new Int16Array(numSamples)) : (new Int16Array(inputData.length));
                
                // Convert to 16-bit PCM
                if (isFirefox) {                    
                    for (let i = 0; i < inputData.length; i++) {
                        //NOTE: for firefox the samplingRatio is not 1, 
                        // so it will downsample by skipping some input samples
                        // A better approach is to compute the mean of the samplingRatio samples.
                        // or pass through a low-pass filter first 
                        // But skipping is a preferable low-latency operation
                        pcmData[i] = Math.max(-1, Math.min(1, inputData[i * samplingRatio])) * 0x7FFF;
                    }
                } else {
                    for (let i = 0; i < inputData.length; i++) {
                        pcmData[i] = Math.max(-1, Math.min(1, inputData[i])) * 0x7FFF;
                    }
                }
                

                // Convert to base64 (browser-safe way)
                const base64Data = arrayBufferToBase64(pcmData.buffer);

                // Send to server
                socket.emit('audioInput', base64Data);
            };

            sourceNode.connect(processor);
            processor.connect(audioContext.destination);
        }

        isStreaming = true;
        startButton.disabled = true;
        stopButton.disabled = false;
        // statusElement.textContent = "Streaming... Speak now";
        // statusElement.className = "recording";

        // Don't show user thinking indicator initially - let agent speak first
        transcriptionReceived = false;
        // showUserThinkingIndicator();

    } catch (error) {
        console.error("Error starting recording:", error);
        // statusElement.textContent = "Error: " + error.message;
        // statusElement.className = "error";
    }
}

// Convert ArrayBuffer to base64 string
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

    // Clean up audio processing
    if (processor) {
        processor.disconnect();
        sourceNode.disconnect();
    }

    startButton.disabled = false;
    stopButton.disabled = true;
    // statusElement.textContent = "Processing...";
    // statusElement.className = "processing";

    audioPlayer.bargeIn();
    // Tell server to finalize processing
    socket.emit('stopAudio');

    // End the current turn in chat history
    chatHistoryManager.endTurn();

    // Reset session for new connection
    sessionInitialized = false;
    
    // Mark as manual disconnect
    manualDisconnect = true;
    
    // Disconnect from server to end current session
    socket.disconnect();
    
    // statusElement.textContent = "Stopped. Click Start to begin new session.";
    // statusElement.className = "ready";
}

// Base64 to Float32Array conversion
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

// Process message data and add to chat history
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

// Update the UI based on the current chat history
function updateChatUI() {
    if (!chatContainer) {
        console.error("Chat container not found");
        return;
    }

    // Clear existing chat messages
    chatContainer.innerHTML = '';

    // Add all messages from history
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

    // Re-add thinking indicators if we're still waiting
    if (waitingForUserTranscription) {
        showUserThinkingIndicator();
    }

    if (waitingForAssistantResponse) {
        showAssistantThinkingIndicator();
    }

    // Scroll to bottom
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

// Show the "Listening" indicator for user
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

// Show the "Thinking" indicator for assistant
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

// Hide the user thinking indicator
function hideUserThinkingIndicator() {
    waitingForUserTranscription = false;
    if (userThinkingIndicator && userThinkingIndicator.parentNode) {
        userThinkingIndicator.parentNode.removeChild(userThinkingIndicator);
    }
    userThinkingIndicator = null;
}

// Hide the assistant thinking indicator
function hideAssistantThinkingIndicator() {
    waitingForAssistantResponse = false;
    if (assistantThinkingIndicator && assistantThinkingIndicator.parentNode) {
        assistantThinkingIndicator.parentNode.removeChild(assistantThinkingIndicator);
    }
    assistantThinkingIndicator = null;
}

// EVENT HANDLERS
// --------------

// Handle content start from the server
socket.on('contentStart', (data) => {
    console.log('Content start received:', data);

    // Set role from contentStart regardless of type (TEXT or AUDIO)
    // This ensures role is always set when content starts
    if (data.role) {
        role = data.role;
    }

    if (data.type === 'TEXT') {
        if (data.role === 'USER') {
            // When user's text content starts, hide user thinking indicator
            hideUserThinkingIndicator();
        }
        else if (data.role === 'ASSISTANT') {
            // When assistant's text content starts, hide assistant thinking indicator
            hideAssistantThinkingIndicator();

            // Always display assistant text immediately (whether speculative or final)
            // This ensures text appears as soon as the AI starts speaking
            displayAssistantText = true;

            // Log if it's speculative for debugging
            try {
                if (data.additionalModelFields) {
                    const additionalFields = JSON.parse(data.additionalModelFields);
                    if (additionalFields.generationStage === "SPECULATIVE") {
                        console.log("Received speculative content");
                    }
                }
            } catch (e) {
                console.error("Error parsing additionalModelFields:", e);
            }
        }
    }
    else if (data.type === 'AUDIO') {
        // When assistant audio content starts, enable text display
        if (data.role === 'ASSISTANT') {
            hideAssistantThinkingIndicator();
            displayAssistantText = true;
        }
        // When audio content starts for user, show user thinking indicator
        if (isStreaming && data.role === 'USER') {
            showUserThinkingIndicator();
        }
    }
});

// Handle text output from the server
socket.on('textOutput', (data) => {
    console.log('Received text output:', data);

    if (role === 'USER') {
        // When user text is received, show thinking indicator for assistant response
        transcriptionReceived = true;
        //hideUserThinkingIndicator();

        // Add user message to chat
        handleTextOutput({
            role: data.role,
            content: data.content
        });

        // Show assistant thinking indicator after user text appears
        showAssistantThinkingIndicator();
    }
    else if (role === 'ASSISTANT') {
        //hideAssistantThinkingIndicator();
        if (displayAssistantText) {
            handleTextOutput({
                role: data.role,
                content: data.content
            });
        }
    }
});

// Handle audio output
socket.on('audioOutput', (data) => {
    if (data.content) {
        try {
            const audioData = base64ToFloat32Array(data.content);
            audioPlayer.playAudio(audioData);
        } catch (error) {
            console.error('Error processing audio data:', error);
        }
    }
});

// Handle content end events
socket.on('contentEnd', (data) => {
    console.log('Content end received:', data);

    if (data.type === 'TEXT') {
        if (role === 'USER') {
            // When user's text content ends, make sure assistant thinking is shown
            hideUserThinkingIndicator();
            showAssistantThinkingIndicator();
        }
        else if (role === 'ASSISTANT') {
            // When assistant's text content ends, prepare for user input in next turn
            hideAssistantThinkingIndicator();
        }

        // Handle stop reasons
        if (data.stopReason && data.stopReason.toUpperCase() === 'END_TURN') {
            chatHistoryManager.endTurn();
        } else if (data.stopReason && data.stopReason.toUpperCase() === 'INTERRUPTED') {
            console.log("Interrupted by user");
            audioPlayer.bargeIn();
        }
    }
    else if (data.type === 'AUDIO') {
        // When audio content ends, we may need to show user thinking indicator
        if (isStreaming) {
            showUserThinkingIndicator();
        }
    }
});

// Stream completion event
socket.on('streamComplete', () => {
    if (isStreaming) {
        stopStreaming();
    }
    // statusElement.textContent = "Microphone ready. Click Start to begin.";
    // statusElement.className = "ready";
});

// Handle connection status updates
socket.on('connect', () => {
    // statusElement.textContent = "Connected to server";
    // statusElement.className = "connected";
    sessionInitialized = false;
    initialAudioSent = false;
    initialMessageShown = false;
});

socket.on('disconnect', () => {
    if (manualDisconnect) {
        // Manual disconnect - keep buttons enabled for restart
        manualDisconnect = false;
        // statusElement.textContent = "Stopped. Click Start to begin new session.";
        // statusElement.className = "ready";
        startButton.disabled = false;
        stopButton.disabled = true;
    } else {
        // Unexpected disconnect - disable buttons
        // statusElement.textContent = "Disconnected from server";
        // statusElement.className = "disconnected";
        startButton.disabled = true;
        stopButton.disabled = true;
    }
    sessionInitialized = false;
    hideUserThinkingIndicator();
    hideAssistantThinkingIndicator();
});

// Handle errors
socket.on('error', (error) => {
    console.error("Server error:", error);
    // statusElement.textContent = "Error: " + (error.message || JSON.stringify(error).substring(0, 100));
    // statusElement.className = "error";
    hideUserThinkingIndicator();
    hideAssistantThinkingIndicator();
});

// Camera control functions
async function startCamera() {
    try {
        const cameraStatus = document.getElementById('camera-status');
        const videoOverlay = document.getElementById('video-overlay');
        if (cameraStatus) {
            cameraStatus.innerHTML = '<span class="camera-icon">📹</span><span>Requesting access...</span>';
        }
        
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
        
        if (cameraStatus) {
            cameraStatus.innerHTML = '<span class="camera-icon">📹</span><span>Active</span>';
        }
        if (videoOverlay) {
            videoOverlay.classList.add('hidden');
        }
        
    } catch (error) {
        console.error('Error accessing camera:', error);
        const cameraStatus = document.getElementById('camera-status');
        if (cameraStatus) {
            cameraStatus.innerHTML = '<span class="camera-icon">⚠️</span><span>Camera Error</span>';
        }
    }
}

// Button event listeners
startButton.addEventListener('click', startStreaming);
stopButton.addEventListener('click', stopStreaming);

// Initialize the app when the page loads
document.addEventListener('DOMContentLoaded', () => {
    initAudio();
    startCamera(); // Auto-start camera
});