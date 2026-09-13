// ============================================
// Zoya · Web AI Voice Assistant
// Gemini Live API + Web Audio API
// ============================================

(function () {
    'use strict';

    // ---------- DOM ----------
    const $ = (id) => document.getElementById(id);
    const permissionScreen = $('permissionScreen');
    const app = $('app');
    const startBtn = $('startBtn');
    const orbCore = $('orbCore');
    const orbHalo = $('orbHalo');
    const orbCanvas = $('orbCanvas');
    const caption = $('caption');
    const statusDot = $('statusDot');
    const statusText = $('statusText');
    const muteBtn = $('muteBtn');
    const endBtn = $('endBtn');
    const settingsBtn = $('settingsBtn');
    const settingsModal = $('settingsModal');
    const closeSettings = $('closeSettings');
    const saveSettings = $('saveSettings');
    const apiKeyInput = $('apiKeyInput');
    const voiceSelect = $('voiceSelect');
    const micIcon = $('micIcon');

    // ---------- STATE ----------
    const State = {
        IDLE: 'idle',
        LISTENING: 'listening',
        THINKING: 'thinking',
        SPEAKING: 'speaking',
        ERROR: 'error'
    };
    let currentState = State.IDLE;
    let ws = null;
    let audioContext = null;
    let mediaStream = null;
    let audioWorkletNode = null;
    let sourceNode = null;
    let playbackNode = null;
    let isMuted = false;
    let isSessionActive = false;
    let setupComplete = false;
    let captionTimeout = null;

    // ---------- CANVAS VISUALIZER ----------
    const canvasCtx = orbCanvas.getContext('2d');
    let analyser = null;
    let analyserData = null;
    let animationId = null;

    function resizeCanvas() {
        const dpr = window.devicePixelRatio || 1;
        orbCanvas.width = orbCanvas.clientWidth * dpr;
        orbCanvas.height = orbCanvas.clientHeight * dpr;
        canvasCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    window.addEventListener('resize', resizeCanvas);

    function drawWaveform() {
        const w = orbCanvas.clientWidth;
        const h = orbCanvas.clientHeight;
        canvasCtx.clearRect(0, 0, w, h);

        if (!analyser) return;
        analyser.getByteFrequencyData(analyserData);

        const cx = w / 2;
        const cy = h / 2;
        const baseRadius = Math.min(w, h) * 0.28;
        const bars = 64;

        for (let i = 0; i < bars; i++) {
            const angle = (i / bars) * Math.PI * 2 - Math.PI / 2;
            const value = analyserData[i % analyserData.length] / 255;
            const len = 4 + value * 40;

            const x1 = cx + Math.cos(angle) * baseRadius;
            const y1 = cy + Math.sin(angle) * baseRadius;
            const x2 = cx + Math.cos(angle) * (baseRadius + len);
            const y2 = cy + Math.sin(angle) * (baseRadius + len);

            const grad = canvasCtx.createLinearGradient(x1, y1, x2, y2);
            grad.addColorStop(0, 'rgba(255, 45, 149, 0.9)');
            grad.addColorStop(1, 'rgba(34, 211, 238, 0.4)');

            canvasCtx.strokeStyle = grad;
            canvasCtx.lineWidth = 2;
            canvasCtx.lineCap = 'round';
            canvasCtx.beginPath();
            canvasCtx.moveTo(x1, y1);
            canvasCtx.lineTo(x2, y2);
            canvasCtx.stroke();
        }

        animationId = requestAnimationFrame(drawWaveform);
    }

    // ---------- STATE HELPERS ----------
    function setState(state) {
        currentState = state;
        orbCore.classList.remove('listening', 'speaking', 'thinking');
        statusDot.className = 'status-dot';

        switch (state) {
            case State.LISTENING:
                orbCore.classList.add('listening');
                statusDot.classList.add('listening');
                statusText.textContent = 'Listening';
                micIcon.style.color = '#22d3ee';
                break;
            case State.THINKING:
                orbCore.classList.add('thinking');
                statusDot.classList.add('active');
                statusText.textContent = 'Thinking';
                micIcon.style.color = '#f59e0b';
                break;
            case State.SPEAKING:
                orbCore.classList.add('speaking');
                statusDot.classList.add('speaking');
                statusText.textContent = 'Speaking';
                micIcon.style.color = '#a855f7';
                break;
            case State.ERROR:
                statusDot.classList.add('error');
                statusText.textContent = 'Error';
                break;
            default:
                statusText.textContent = 'Idle';
                micIcon.style.color = '';
        }
    }

    function setCaption(text, duration = 4000) {
        caption.textContent = text;
        if (captionTimeout) clearTimeout(captionTimeout);
        if (duration > 0) {
            captionTimeout = setTimeout(() => {
                caption.textContent = '';
            }, duration);
        }
    }

    // ---------- AUDIO CAPTURE (PCM16 @ 16kHz) ----------
    async function startAudioCapture() {
        mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                channelCount: 1,
                sampleRate: 16000
            }
        });

        audioContext = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: 16000
        });

        sourceNode = audioContext.createMediaStreamSource(mediaStream);

        // Analyser for visualizer
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 128;
        analyser.smoothingTimeConstant = 0.75;
        analyserData = new Uint8Array(analyser.frequencyBinCount);
        sourceNode.connect(analyser);

        // Worklet for PCM capture
        await audioContext.audioWorklet.addModule(URL.createObjectURL(
            new Blob([createPCMWorklet()], { type: 'application/javascript' })
        ));

        audioWorkletNode = new AudioWorkletNode(audioContext, 'pcm-capture', {
            processorOptions: { targetSampleRate: 16000 }
        });

        audioWorkletNode.port.onmessage = (event) => {
            if (!isSessionActive || isMuted || !ws || ws.readyState !== WebSocket.OPEN) return;
            const pcm16 = event.data;
            const base64 = arrayBufferToBase64(pcm16);
            sendAudioChunk(base64);
        };

        sourceNode.connect(audioWorkletNode);
    }

    function createPCMWorklet() {
        return `
        class PCMCapture extends AudioWorkletProcessor {
            constructor(options) {
                super();
                this.targetRate = options.processorOptions.targetSampleRate || 16000;
                this.buffer = [];
                this.bufferSize = 1024;
            }
            process(inputs) {
                const input = inputs[0];
                if (!input || !input[0]) return true;
                const channel = input[0];
                const sourceRate = sampleRate;
                const ratio = sourceRate / this.targetRate;

                for (let i = 0; i < channel.length; i++) {
                    this.buffer.push(channel[i]);
                }

                const outLen = Math.floor(this.buffer.length / ratio);
                if (outLen < this.bufferSize) return true;

                const pcm = new Int16Array(outLen);
                for (let i = 0; i < outLen; i++) {
                    const srcIdx = i * ratio;
                    const s = this.buffer[Math.floor(srcIdx)];
                    pcm[i] = Math.max(-1, Math.min(1, s)) * 0x7FFF;
                }
                this.buffer = this.buffer.slice(Math.floor(outLen * ratio));

                this.port.postMessage(pcm.buffer, [pcm.buffer]);
                return true;
            }
        }
        registerProcessor('pcm-capture', PCMCapture);
        `;
    }

    function arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return btoa(binary);
    }

    function base64ToArrayBuffer(base64) {
        const binary = atob(base64);
        const len = binary.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
        return bytes.buffer;
    }

    // ---------- AUDIO PLAYBACK (PCM16 @ 24kHz) ----------
    let playbackContext = null;
    let playbackTime = 0;

    function initPlayback() {
        playbackContext = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: 24000
        });
        playbackTime = playbackContext.currentTime;
    }

    function playPCMAudio(base64Data) {
        if (!playbackContext) initPlayback();
        const buffer = base64ToArrayBuffer(base64Data);
        const int16 = new Int16Array(buffer);
        const float32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) {
            float32[i] = int16[i] / 0x8000;
        }

        const audioBuffer = playbackContext.createBuffer(1, float32.length, 24000);
        audioBuffer.copyToChannel(float32, 0);

        const source = playbackContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(playbackContext.destination);

        const now = playbackContext.currentTime;
        if (playbackTime < now) playbackTime = now;
        source.start(playbackTime);
        playbackTime += audioBuffer.duration;
    }

    function stopPlayback() {
        if (playbackContext) {
            playbackContext.close();
            playbackContext = null;
        }
    }

    // ---------- GEMINI LIVE WEBSOCKET ----------
    function connectGeminiLive() {
        const apiKey = window.ZOYA_CONFIG.apiKey;
        if (!apiKey) {
            setState(State.ERROR);
            setCaption('API key missing. Open settings.', 5000);
            return;
        }

        const model = window.ZOYA_CONFIG.model;
        const voice = window.ZOYA_CONFIG.defaultVoice;
        const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;

        ws = new WebSocket(url);

        ws.onopen = () => {
            console.log('[Zoya] WebSocket connected');
            sendSetup(model, voice);
        };

        ws.onmessage = async (event) => {
            let text;
            if (event.data instanceof Blob) {
                text = await event.data.text();
            } else {
                text = event.data;
            }
            try {
                const msg = JSON.parse(text);
                handleServerMessage(msg);
            } catch (e) {
                console.warn('Parse error:', e);
            }
        };

        ws.onerror = (e) => {
            console.error('[Zoya] WS error', e);
            setState(State.ERROR);
            setCaption('Connection hiccup. Even I get tired of bad WiFi.', 4000);
        };

        ws.onclose = (e) => {
            console.log('[Zoya] WS closed', e.code, e.reason);
            if (isSessionActive) {
                setState(State.ERROR);
                setCaption('Session ended. Tap the orb to wake me again.', 4000);
            }
            isSessionActive = false;
            setupComplete = false;
        };
    }

    function sendSetup(model, voice) {
        const setup = {
            setup: {
                model: `models/${model}`,
                generationConfig: {
                    responseModalities: ['AUDIO'],
                    speechConfig: {
                        voiceConfig: {
                            prebuiltVoiceConfig: { voiceName: voice }
                        }
                    }
                },
                systemInstruction: {
                    parts: [{ text: window.ZOYA_CONFIG.systemPrompt }]
                }
            }
        };
        ws.send(JSON.stringify(setup));
        console.log('[Zoya] Setup sent');
    }

    function sendAudioChunk(base64) {
        const msg = {
            realtimeInput: {
                mediaChunks: [{
                    mimeType: 'audio/pcm;rate=16000',
                    data: base64
                }]
            }
        };
        ws.send(JSON.stringify(msg));
    }

    function sendTextMessage(text) {
        const msg = {
            clientContent: {
                turns: [{ role: 'user', parts: [{ text }] }],
                turnComplete: true
            }
        };
        ws.send(JSON.stringify(msg));
    }

    function handleServerMessage(msg) {
        // Setup complete
        if (msg.setupComplete) {
            setupComplete = true;
            setState(State.LISTENING);
            setCaption('I\'m all ears, hotshot. Say something.', 3000);
            console.log('[Zoya] Setup complete');
            return;
        }

        // Server content
        if (msg.serverContent) {
            const sc = msg.serverContent;

            // Interruption
            if (sc.interrupted) {
                stopPlayback();
                setState(State.LISTENING);
                console.log('[Zoya] Interrupted');
            }

            // Model turn
            if (sc.modelTurn && sc.modelTurn.parts) {
                setState(State.SPEAKING);
                for (const part of sc.modelTurn.parts) {
                    if (part.inlineData && part.inlineData.data) {
                        playPCMAudio(part.inlineData.data);
                    }
                }
            }

            // Turn complete
            if (sc.turnComplete) {
                setState(State.LISTENING);
            }
        }
    }

    // ---------- SESSION CONTROL ----------
    async function startSession() {
        try {
            if (isSessionActive) return;
            isSessionActive = true;
            setCaption('Waking up... give me a sec.', 3000);
            setState(State.THINKING);

            await startAudioCapture();
            initPlayback();

            if (audioContext.state === 'suspended') await audioContext.resume();
            if (playbackContext.state === 'suspended') await playbackContext.resume();

            connectGeminiLive();

            // Start visualizer
            resizeCanvas();
            if (!animationId) drawWaveform();

        } catch (err) {
            console.error('Start error:', err);
            setState(State.ERROR);
            setCaption('Mic permission issue. Check browser settings.', 5000);
            isSessionActive = false;
        }
    }

    function endSession() {
        isSessionActive = false;
        setupComplete = false;

        if (ws) {
            try { ws.close(); } catch (e) {}
            ws = null;
        }

        if (audioWorkletNode) {
            try { audioWorkletNode.disconnect(); } catch (e) {}
            audioWorkletNode = null;
        }
        if (sourceNode) {
            try { sourceNode.disconnect(); } catch (e) {}
            sourceNode = null;
        }
        if (mediaStream) {
            mediaStream.getTracks().forEach(t => t.stop());
            mediaStream = null;
        }
        if (audioContext) {
            try { audioContext.close(); } catch (e) {}
            audioContext = null;
        }
        stopPlayback();

        if (animationId) {
            cancelAnimationFrame(animationId);
            animationId = null;
        }
        analyser = null;

        setState(State.IDLE);
        setCaption('Session ended. Tap the orb to wake me up again.', 4000);
    }

    // ---------- UI EVENTS ----------
    startBtn.addEventListener('click', async () => {
        const apiKey = localStorage.getItem('zoya_api_key') || window.ZOYA_CONFIG.apiKey;
        if (!apiKey) {
            openSettings();
            return;
        }
        window.ZOYA_CONFIG.apiKey = apiKey;

        permissionScreen.classList.add('hidden');
        app.classList.remove('hidden');

        // Warm up mic permission
        try {
            await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (e) {
            setCaption('Microphone permission needed. Reload and allow.', 6000);
        }

        // Auto-start
        setTimeout(() => startSession(), 500);
    });

    orbCore.addEventListener('click', () => {
        if (!isSessionActive) {
            startSession();
        }
    });

    endBtn.addEventListener('click', () => {
        endSession();
    });

    muteBtn.addEventListener('click', () => {
        isMuted = !isMuted;
        muteBtn.classList.toggle('active', isMuted);
        setCaption(isMuted ? 'Muted. Take your time.' : 'Back online. Miss me?', 2500);
    });

    settingsBtn.addEventListener('click', openSettings);
    closeSettings.addEventListener('click', () => settingsModal.classList.add('hidden'));
    saveSettings.addEventListener('click', () => {
        const key = apiKeyInput.value.trim();
        const voice = voiceSelect.value;
        if (key) {
            localStorage.setItem('zoya_api_key', key);
            window.ZOYA_CONFIG.apiKey = key;
        }
        localStorage.setItem('zoya_voice', voice);
        window.ZOYA_CONFIG.defaultVoice = voice;
        settingsModal.classList.add('hidden');
        setCaption('Saved. Now go break the internet.', 2500);
    });

    function openSettings() {
        apiKeyInput.value = localStorage.getItem('zoya_api_key') || '';
        voiceSelect.value = localStorage.getItem('zoya_voice') || 'Aoede';
        settingsModal.classList.remove('hidden');
    }

    // Load saved config
    (function init() {
        const savedKey = localStorage.getItem('zoya_api_key');
        if (savedKey) window.ZOYA_CONFIG.apiKey = savedKey;
        const savedVoice = localStorage.getItem('zoya_voice');
        if (savedVoice) window.ZOYA_CONFIG.defaultVoice = savedVoice;
        resizeCanvas();
    })();

})();