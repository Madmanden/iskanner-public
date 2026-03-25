# Instrument Scanner PWA

A mobile-optimized Progressive Web App (PWA) for scanning instrument part numbers and looking up their storage locations.

Built to replace a manual lookup workflow in a sterile services department. Staff previously had to look up instrument storage locations on a PC and write them on post-its — for every single instrument. This app lets you point your phone camera at a part number and get the answer immediately.

It uses the camera, voice input, and manual entry to find part numbers quickly, with secure server-side OCR via Netlify Functions.


## Screenshots

<img src="screenshots/screenshot.jpg" alt="Instrument Scanner screenshot" />

## Features

- 📷 **Camera OCR** — scan part numbers with your phone camera
- 🎤 **Voice Input** — say the part number aloud
- ⌨️ **Manual Entry** — type part numbers directly
- 📜 **History** — quick access to recent lookups, sortable by latest, location, or alphabetically
- 🔍 **Fuzzy Matching** — suggests similar part numbers if there's no exact match
- 📱 **PWA** — install on your home screen
- 🔒 **Secure** — API keys stay server-side via Netlify Functions
- 🌐 **Offline Support** — service worker caching for offline use
- 🔑 **Authentication** — password protection and rate limiting

## Requirements

- Node.js 18+
- [Netlify CLI](https://docs.netlify.com/cli/get-started/) (`npm install -g netlify-cli`)
- A Hyperbolic API key for OCR
- Optional OpenRouter API key as fallback OCR provider
- A Netlify account if you want to deploy

## Quick Start

### 1. Clone and install

```bash
git clone <your-repo-url>
cd iskanner-public
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env`:

```bash
HYPERBOLIC_API_KEY=your_hyperbolic_api_key_here
AUTH_TOKEN_SECRET=your_secret_token_here
AUTH_PASSWORD=change-me-in-production
# Optional fallback OCR provider
# OPENROUTER_API_KEY=your_openrouter_api_key_here
# Optional CORS settings
# ALLOWED_ORIGINS=https://yourdomain.com,https://www.yourdomain.com
```

### 3. Run locally

```bash
npm run dev
```

Open http://localhost:8888 in your browser.

> **Note:** Authentication and OCR only work when running through Netlify Dev. Opening `index.html` directly will not work for login or OCR.

## Deployment

If you want a live deployment, Netlify can deploy this repo from GitHub commits. If you do nothing else, this repo stays source-only and unhosted.

### Netlify setup

1. Push this repo to GitHub
2. Connect the repo to Netlify
3. Add the environment variables in Netlify:
   - `HYPERBOLIC_API_KEY`
   - `AUTH_TOKEN_SECRET`
   - `AUTH_PASSWORD`
   - `OPENROUTER_API_KEY` if you want fallback OCR
   - `ALLOWED_ORIGINS` if you want to restrict CORS
   - `NETLIFY_SITE_ID` and `NETLIFY_BLOBS_TOKEN` if you want usage stats
4. Deploy

### Automatic deploys

Once connected, Netlify will deploy on every push to the configured branch.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `HYPERBOLIC_API_KEY` | Yes | OCR provider API key |
| `AUTH_PASSWORD` | Yes | Password for accessing the app |
| `AUTH_TOKEN_SECRET` | Yes | Secret for signing auth tokens |
| `OPENROUTER_API_KEY` | No | Fallback OCR provider |
| `ALLOWED_ORIGINS` | No | Comma-separated list of allowed origins |
| `NETLIFY_SITE_ID` | No | Enables usage stats with Netlify Blobs |
| `NETLIFY_BLOBS_TOKEN` | No | Token for Netlify Blobs usage stats |

## Customization

### Parts database

Edit `parts-database.js` to add your own part numbers and locations.

### OCR settings

Edit `js/config.js` to tune:

- camera inactivity timeout
- voice recognition timeout
- recent lookup history size
- JPEG quality
- OCR preprocessing attempts

### OCR providers

By default the app uses Hyperbolic first, with OpenRouter as optional fallback.

You can control the provider chain with environment variables:

```bash
OCR_PRIMARY_PROVIDER=hyperbolic
OCR_FALLBACK_PROVIDER=openrouter
HYPERBOLIC_OCR_MODELS=mistralai/Pixtral-12B-2409
OPENROUTER_OCR_MODELS=google/gemini-2.5-flash-lite
```

## Usage

1. Open the app on your phone
2. Enter the password
3. Tap **Scan** to open the camera
4. Tap **Scan** again to capture
5. Or tap **Tal** to use voice input
6. Or type a part number manually
7. Open **Historik** to sort recent lookups by latest, location, or alphabetically

## Project structure

```text
├── index.html
├── css/
├── icons/
├── js/
│   ├── app.js
│   ├── auth.js
│   ├── camera.js
│   ├── config.js
│   ├── ocr.js
│   ├── ui.js
│   ├── utils.js
│   └── voice.js
├── netlify/
│   └── functions/
│       ├── auth.js
│       └── ocr.js
├── parts-database.js
├── screenshots/
│   └── screenshot.svg
├── manifest.json
├── sw.js
└── netlify.toml
```

## Security

- API keys stay server-side
- Auth tokens are signed and expire after 30 days
- OCR requests are rate limited
- CORS origin checks are enabled
- Service worker caches only the app assets

## Troubleshooting

**Buttons do nothing**
- Make sure the app JavaScript loads without errors
- Run through Netlify Dev locally
- Clear cache / service worker if you previously loaded an older broken build

**Login fails locally**
- Use `npm run dev` instead of opening the HTML file directly

**OCR doesn't work**
- Check that `HYPERBOLIC_API_KEY` is set
- Add `OPENROUTER_API_KEY` if you want fallback OCR

## License

MIT
