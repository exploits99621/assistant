// ============================================
// Zoya · OpenRouter + Web Speech API
// Speech-to-Text → OpenRouter → Text-to-Speech
// ============================================

(function () {
    'use strict';

    const $ = (id) => document.getElementById(id);
    const permissionScreen = $('permissionScreen');
    const app = $('app');
    const startBtn = $('startBtn');
    const orbCore = $('orbCore');
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
    const rateSelect = $('rateSelect');
    const micIcon = $('micIcon');

    const State = { IDLE: 'idle', LISTENING: 'listening', THINKING: 'thinking', SPEAKING: 'speaking', ERROR: 'error' };
    let currentState = State.IDLE;
    let recognition = null;
    let synth = window.speechSynthesis;
    let selectedVoice = null;
    let isMuted = false;
    let isSessionActive = false;
    let isSpeaking = false;
    let isProcessing = false;
    let currentUtterance = null;
    let captionTimeout = null;

    // ============================================
    // CANVAS VISUALIZER (Mic + Speech)
    // ============================================
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

        const cx = w / 2;
        const cy = h / 2;
        const baseRadius = Math.min(w, h) * 0.26;
        const bars = 72;
        const time = Date.now() / 1000;

        for (let i = 0; i < bars; i++) {
            const angle = (i / bars) * Math.PI * 2 - Math.PI / 2;

            let amplitude = 0;
            if (analyser && analyserData) {
                analyser.getByteFrequencyData(analyserData);
                amplitude = analyserData[i % analyserData.length] / 255;
            } else {
                // Idle breathe animation
                amplitude = 0.1 + Math.sin(time * 2 + i * 0.3) * 0.1;
            }

            const len = 3 + amplitude * 50;

            const x1 = cx + Math.cos(angle) * baseRadius;
            const y1 = cy + Math.sin(angle) * baseRadius;
            const x2 = cx + Math.cos(angle) * (baseRadius + len);
            const y2 = cy + Math.sin(angle) * (baseRadius + len);

            let color1, color2;
            if (currentState === State.SPEAKING) {
                color1 = 'rgba(168, 85, 247, 0.95)';
                color2 = 'rgba(255, 45, 149, 0.4)';
            } else if (currentState === State.LISTENING) {
                color1 = 'rgba(34, 211, 238, 0.95)';
                color2 = 'rgba(34, 211, 238, 0.3)';
            } else if (currentState === State.THINKING) {
                color1 = 'rgba(245, 158, 11, 0.9)';
                color2 = 'rgba(245, 158, 11, 0.3)';
            } else {
                color1 = 'rgba(255, 45, 149, 0.7)';
                color2 = 'rgba(168, 85, 247, 0.3)';
            }

            const grad = canvasCtx.createLinearGradient(x1, y1, x2, y2);
            grad.addColorStop(0, color1);
            grad.addColorStop(1, color2);

            canvasCtx.strokeStyle = grad;
            canvasCtx.lineWidth = 2.5;
            canvasCtx.lineCap = 'round';
            canvasCtx.beginPath();
            canvasCtx.moveTo(x1, y1);
            canvasCtx.lineTo(x2, y2);
            canvasCtx.stroke();
        }

        animationId = requestAnimationFrame(drawWaveform);
    }

    // ============================================
    // STATE
    // ============================================
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
            captionTimeout = setTimeout(() => { caption.textContent = ''; }, duration);
        }
    }

    // ============================================
    // MIC VISUALIZER (for waveform)
    // ============================================
    async function initMicAnalyser() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const src = ctx.createMediaStreamSource(stream);
            analyser = ctx.createAnalyser();
            analyser.fftSize = 128;
            analyser.smoothingTimeConstant = 0.75;
            analyserData = new Uint8Array(analyser.frequencyBinCount);
            src.connect(analyser);
        } catch (e) {
            console.warn('Mic analyser error:', e);
        }
    }

    // ============================================
    // SPEECH RECOGNITION (Speech-to-Text)
    // ============================================
    function initRecognition() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            setCaption('❌ Browser support nahi karta. Chrome use karo.', 6000);
            return null;
        }

        const rec = new SpeechRecognition();
        rec.lang = 'en-IN';
        rec.continuous = true;
        rec.interimResults = false;
        rec.maxAlternatives = 1;

        rec.onstart = () => {
            console.log('[Zoya] 🎤 Listening...');
            setState(State.LISTENING);
        };

        rec.onresult = (event) => {
            const last = event.results.length - 1;
            const transcript = event.results[last][0].transcript.trim();
            if (transcript && !isProcessing && !isSpeaking) {
                console.log('[Zoya] User said:', transcript);
                handleUserInput(transcript);
            }
        };

        rec.onerror = (event) => {
            console.warn('[Zoya] Recognition error:', event.error);
            if (event.error === 'no-speech') {
                // Silent — keep listening
                return;
            }
            if (event.error === 'not-allowed') {
                setCaption('🎤 Mic permission deny. Allow karo.', 5000);
                setState(State.ERROR);
                isSessionActive = false;
            }
        };

        rec.onend = () => {
            // Auto-restart for continuous listening
            if (isSessionActive && !isMuted && !isSpeaking && recognition) {
                try { recognition.start(); } catch (e) {}
            }
        };

        return rec;
    }

    // ============================================
    // OPENROUTER API CALL (FAST)
    // ============================================
    async function getAIResponse(userText) {
        const apiKey = window.ZOYA_CONFIG.apiKey;
        if (!apiKey || !apiKey.startsWith('sk-or-')) {
            return "Arre, API key galat hai. Settings mein sahi key daalo.";
        }

        const payload = {
            model: window.ZOYA_CONFIG.models[0],
            messages: [
                { role: 'system', content: window.ZOYA_CONFIG.systemPrompt },
                { role: 'user', content: userText }
            ],
            max_tokens: window.ZOYA_CONFIG.maxTokens,
            temperature: window.ZOYA_CONFIG.temperature
        };

        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 8000);

            const res = await fetch(window.ZOYA_CONFIG.apiUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': window.location.origin,
                    'X-Title': 'Zoya Voice AI'
                },
                body: JSON.stringify(payload),
                signal: controller.signal
            });

            clearTimeout(timeout);

            if (!res.ok) {
                const errText = await res.text();
                console.error('[Zoya] API error:', res.status, errText);

                if (res.status === 401) return "Key expire ho gayi lagti hai. Naya key daalo.";
                if (res.status === 429) return "Ruko yaar, thoda saans lene do. Ek second.";
                return "Hmm, kuch gadbad ho gayi. Phir bolo?";
            }

            const data = await res.json();
            const reply = data?.choices?.[0]?.message?.content?.trim();

            if (!reply) return "Kuch samajh nahi aaya. Phir se bolo na.";

            return reply;
        } catch (err) {
            if (err.name === 'AbortError') return "Slow ho gaya internet. Phir bolo?";
            console.error('[Zoya] Fetch error:', err);
            return "Network issue hai. Check karo.";
        }
    }

    // ============================================
    // TEXT-TO-SPEECH (Speaking)
    // ============================================
    function loadVoices() {
        const voices = synth.getVoices();
        if (!voices.length) return;

        const lang = window.ZOYA_CONFIG.voice.lang;
        selectedVoice = voices.find(v => v.lang === lang && v.name.toLowerCase().includes('female'))
            || voices.find(v => v.lang === lang)
            || voices.find(v => v.lang.startsWith('en'))
            || voices[0];

        console.log('[Zoya] Voice:', selectedVoice?.name, selectedVoice?.lang);
    }

    synth.onvoiceschanged = loadVoices;
    loadVoices();

    function speak(text) {
        if (isMuted) {
            // Still continue conversation
            setTimeout(() => { if (isSessionActive) restartListening(); }, 500);
            return;
        }

        // Cancel previous
        synth.cancel();

        const utter = new SpeechSynthesisUtterance(text);
        if (selectedVoice) utter.voice = selectedVoice;
        utter.lang = window.ZOYA_CONFIG.voice.lang;
        utter.rate = parseFloat(rateSelect.value) || window.ZOYA_CONFIG.voice.rate;
        utter.pitch = window.ZOYA_CONFIG.voice.pitch;
        utter.volume = window.ZOYA_CONFIG.voice.volume;

        utter.onstart = () => {
            isSpeaking = true;
            setState(State.SPEAKING);
            // Stop recognition while speaking (avoid feedback)
            if (recognition) { try { recognition.stop(); } catch (e) {} }
        };

        utter.onend = () => {
            isSpeaking = false;
            currentUtterance = null;
            if (isSessionActive) {
                setState(State.LISTENING);
                restartListening();
            } else {
                setState(State.IDLE);
            }
        };

        utter.onerror = (e) => {
            console.warn('[Zoya] TTS error:', e);
            isSpeaking = false;
            if (isSessionActive) restartListening();
        };

        currentUtterance = utter;
        synth.speak(utter);
    }

    function restartListening() {
        if (!recognition || !isSessionActive || isMuted || isSpeaking) return;
        setTimeout(() => {
            try { recognition.start(); } catch (e) {}
        }, 200);
    }

    function stopSpeaking() {
        if (synth.speaking) synth.cancel();
        isSpeaking = false;
    }

    // ============================================
    // HANDLE USER INPUT
    // ============================================
    async function handleUserInput(text) {
        if (isProcessing || isSpeaking) return;
        isProcessing = true;

        // Interrupt current speech if any
        stopSpeaking();

        // Show what user said
        setCaption(`You: "${text}"`, 3000);
        setState(State.THINKING);

        // Get AI reply
        const reply = await getAIResponse(text);

        console.log('[Zoya] Reply:', reply);
        setCaption(reply, 8000);

        // Speak
        speak(reply);

        isProcessing = false;
    }

    // ============================================
    // SESSION CONTROL
    // ============================================
    async function startSession() {
        if (isSessionActive) return;

        const apiKey = window.ZOYA_CONFIG.apiKey;
        if (!apiKey || !apiKey.startsWith('sk-or-')) {
            openSettings();
            setCaption('Pehle API key daalo (sk-or-...)', 5000);
            return;
        }

        isSessionActive = true;
        setCaption('Zoya is waking up... 💋', 2500);

        // Init recognition
        recognition = initRecognition();
        if (!recognition) { isSessionActive = false; return; }

        // Init mic analyser for waveform
        await initMicAnalyser();

        // Start listening
        try { recognition.start(); } catch (e) {}
        setState(State.LISTENING);

        // Greet
        setTimeout(() => {
            const greetings = [
                "Hey hotshot. I'm listening. 💋",
                "Oh look, you're back. What do you want?",
                "Finally. I was getting bored. Speak.",
                "I'm all ears, gorgeous. Go on.",
                "Well well, look who showed up. Talk to me."
            ];
            const greet = greetings[Math.floor(Math.random() * greetings.length)];
            setCaption(greet, 5000);
            speak(greet);
        }, 800);
    }

    function endSession() {
        isSessionActive = false;
        isProcessing = false;
        isSpeaking = false;

        if (recognition) {
            try { recognition.stop(); } catch (e) {}
            recognition = null;
        }
        stopSpeaking();
        synth.cancel();

        setState(State.IDLE);
        setCaption('Session ended. Tap orb to wake me again. 💋', 4000);
    }

    // ============================================
    // UI EVENTS
    // ============================================
    startBtn.addEventListener('click', async () => {
        const savedKey = localStorage.getItem('zoya_api_key');
        const configKey = window.ZOYA_CONFIG.apiKey;
        const key = (configKey && configKey.startsWith('sk-or-')) ? configKey : savedKey;

        if (!key || !key.startsWith('sk-or-')) {
            permissionScreen.classList.add('hidden');
            app.classList.remove('hidden');
            openSettings();
            setCaption('OpenRouter key chahiye (sk-or-v1-...)', 8000);
            return;
        }

        window.ZOYA_CONFIG.apiKey = key;

        // Request mic
        try {
            await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (e) {
            setCaption('Mic permission chahiye.', 5000);
            return;
        }

        permissionScreen.classList.add('hidden');
        app.classList.remove('hidden');

        setTimeout(() => startSession(), 300);
    });

    orbCore.addEventListener('click', () => {
        if (!isSessionActive) startSession();
        else if (isSpeaking) {
            // Interrupt
            stopSpeaking();
            setState(State.LISTENING);
            restartListening();
        }
    });

    endBtn.addEventListener('click', endSession);

    muteBtn.addEventListener('click', () => {
        isMuted = !isMuted;
        muteBtn.classList.toggle('active', isMuted);
        if (isMuted) {
            stopSpeaking();
            setCaption('Muted. Still here though.', 2500);
        } else {
            setCaption('Back online. Miss me? 💋', 2500);
            restartListening();
        }
    });

    settingsBtn.addEventListener('click', openSettings);
    closeSettings.addEventListener('click', () => settingsModal.classList.add('hidden'));

    saveSettings.addEventListener('click', () => {
        const key = apiKeyInput.value.trim();
        const voice = voiceSelect.value;
        const rate = rateSelect.value;

        if (!key.startsWith('sk-or-')) {
            alert('❌ Galat key. "sk-or-v1-..." wali key daalo.\n\nLo yahan se: https://openrouter.ai/keys');
            return;
        }

        localStorage.setItem('zoya_api_key', key);
        localStorage.setItem('zoya_voice', voice);
        localStorage.setItem('zoya_rate', rate);

        window.ZOYA_CONFIG.apiKey = key;
        window.ZOYA_CONFIG.voice.lang = voice;

        settingsModal.classList.add('hidden');
        setCaption('Saved. Ab bol. 💋', 2500);
    });

    function openSettings() {
        apiKeyInput.value = localStorage.getItem('zoya_api_key') || '';
        voiceSelect.value = localStorage.getItem('zoya_voice') || 'en-IN';
        rateSelect.value = localStorage.getItem('zoya_rate') || '1.0';
        settingsModal.classList.remove('hidden');
    }

    // ============================================
    // INIT
    // ============================================
    (function init() {
        const savedKey = localStorage.getItem('zoya_api_key');
        if (savedKey && savedKey.startsWith('sk-or-')) {
            window.ZOYA_CONFIG.apiKey = savedKey;
        }
        const savedVoice = localStorage.getItem('zoya_voice');
        if (savedVoice) window.ZOYA_CONFIG.voice.lang = savedVoice;

        resizeCanvas();
        drawWaveform();

        // Unlock speech synthesis on first interaction
        document.addEventListener('click', () => {
            if (synth.paused) synth.resume();
        }, { once: true });

        console.log('💋 Zoya loaded. OpenRouter ready.');
    })();

})();