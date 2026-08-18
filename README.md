# Instrument Scanner PWA

Instrument Scanner is a mobile-first PWA for sterile services (CSSD) teams. It turns instrument part numbers into storage locations using camera OCR, Danish voice input, or manual search.

> **Sanitized public showcase:** this repository is generated from the private production codebase. Production instrument/location data, private documentation, credentials, deployment state and internal operational details are deliberately excluded.

<p align="center">
  <img src="screenshots/instrumentskanner.jpg" alt="Instrument Scanner mobile interface" width="320">
</p>

## What it does

- **Camera OCR** with preprocessing, bounded retries and database-aware correction.
- **Danish voice lookup** with live transcript feedback, conservative fuzzy resolution, explicit ambiguous candidates and local learning from repeated confirmed corrections.
- **Manual lookup** with exact/fuzzy database matching.
- **History** with sorting by recency, part number or location.
- **Order mode** that collects successful lookups into a local order list and can submit it through Netlify Forms.
- **Installable PWA** with offline static assets and cached database fallback.
- **Fresh database delivery**: the JS database is the source of truth; build generates JSON and the app fetches it network-first/no-store when online.
- **Server-side OCR secrets**, shared-password sessions, CORS checks and rate limiting through Netlify Functions.
- **Optional usage statistics** through Netlify Blobs.

## Demo data

The included `parts-database.js` / `.json` contain only fictional example part numbers and locations. Replace them with your own data before deployment.

## Requirements

- Node.js 18+
- Bun (tests)
- Netlify CLI
- OpenRouter API key for the default OCR provider
- Netlify account for deployment

## Quick start

```bash
npm install
cp .env.example .env
npm run dev
```

Set at minimum:

```bash
OPENROUTER_API_KEY=...
AUTH_PASSWORD=...
AUTH_TOKEN_SECRET=...
```

Open `http://localhost:8888`. Authentication and OCR require Netlify Dev/Functions and do not work by opening `index.html` directly.

## Tests and build

```bash
bun test
npm run build
```

The public repository contains a sanitized smoke suite rather than production test fixtures. The build:

1. syncs the user-visible version from `package.json`;
2. generates `parts-database.json` from `parts-database.js`;
3. gives the service-worker cache a unique build version.

## Deployment

Connect the repository to Netlify. `netlify.toml` runs `npm run build` and publishes the repository root with `netlify/functions` as the Functions directory.

Required environment variables:

| Variable | Purpose |
|---|---|
| `OPENROUTER_API_KEY` | Default OCR provider |
| `AUTH_PASSWORD` | Shared app password |
| `AUTH_TOKEN_SECRET` | Session-token signing secret |

Optional variables include `HYPERBOLIC_API_KEY`, provider/model overrides, `ALLOWED_ORIGINS`, `NETLIFY_SITE_ID` and `NETLIFY_BLOBS_TOKEN`.

## Project structure

```text
├── index.html
├── css/styles.css
├── js/
│   ├── app.js
│   ├── auth.js
│   ├── camera.js
│   ├── config.js
│   ├── ocr.js
│   ├── ocr-selection.js
│   ├── ocr-lookup.js
│   ├── order-mode.js
│   ├── search-v2.js
│   ├── ui.js
│   ├── utils.js
│   ├── voice-lookup.js
│   └── voice.js
├── netlify/functions/
│   ├── lib/shared.js
│   ├── auth.js
│   ├── ocr.js
│   └── ocr-usage.js
├── scripts/
├── tests/public-smoke.test.js
├── parts-database.js
├── parts-database.json
├── manifest.json
├── sw.js
└── netlify.toml
```

## Security notes

- API keys stay server-side in Netlify Functions.
- Auth tokens are signed and time-limited.
- OCR endpoints are authenticated and rate-limited.
- CORS is restricted to configured/deployment origins.
- The public repository intentionally contains no production inventory/location dataset.

## License

MIT
