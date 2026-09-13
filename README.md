# Zoya · AI Voice Companion 🌐

A sassy, real-time voice AI assistant built with **Gemini Live API** + **Web Audio API**.

## 🚀 Setup

1. **Get a Gemini API key** → https://aistudio.google.com/apikey
2. Open `index.html` in Chrome (or deploy to Vercel/Netlify)
3. Enter API key in settings
4. Allow microphone
5. Start talking to Zoya

## 🎙️ Features

- Real-time bi-directional voice
- Zero-touch interface (pure voice)
- Interruption handling (talk over her, she stops)
- Live audio waveform visualizer
- Personality: flirty, witty, sassy
- Voice options: Aoede, Kore, Puck, etc.

## 📁 Files

- `index.html` — UI
- `style.css` — Dark futuristic theme
- `app.js` — Gemini Live + Audio pipeline
- `config.js` — API key + Zoya's personality

## ⚠️ Notes

- Must use **HTTPS** or `localhost` for mic access
- Best on **Chrome Desktop** / **Android Chrome**
- API key stored in `localStorage` (client-side only)

## 🌐 Deploy

```bash
# Vercel
vercel --prod

# Or just drag-drop to Netlify