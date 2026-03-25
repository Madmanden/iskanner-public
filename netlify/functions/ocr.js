// Netlify serverless function to proxy OCR model API calls
// This keeps the API key secure on the server side

const crypto = require('crypto');
const fs = require('fs/promises');

// Simple in-memory rate limiting (resets on cold start)
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS_AUTHENTICATED = 50; // max requests per window for authenticated users
const RATE_LIMIT_MAX_ENTRIES = 5000; // Maximum entries before pruning

function pruneRateLimitMap(now) {
    // Always prune expired entries regardless of map size
    for (const [ip, record] of rateLimitMap.entries()) {
        if (!record || now - record.windowStart > RATE_LIMIT_WINDOW_MS) {
            rateLimitMap.delete(ip);
        }
    }
    
    // If still over limit, prune oldest entries
    if (rateLimitMap.size > RATE_LIMIT_MAX_ENTRIES) {
        const entries = Array.from(rateLimitMap.entries());
        entries.sort((a, b) => a[1].windowStart - b[1].windowStart);
        
        const toDelete = entries.slice(0, entries.length - RATE_LIMIT_MAX_ENTRIES);
        for (const [ip] of toDelete) {
            rateLimitMap.delete(ip);
        }
    }
}
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB max
const DEFAULT_PRIMARY_PROVIDER = 'hyperbolic';
const DEFAULT_FALLBACK_PROVIDER = 'openrouter';
const DEFAULT_HYPERBOLIC_OCR_MODELS = [
    'mistralai/Pixtral-12B-2409'
];
const DEFAULT_OPENROUTER_OCR_MODELS = [
    'google/gemini-2.5-flash-lite'
];
let usageStore = null;
let usageStoreInitAttempted = false;
let usageStoreDisabledReason = null;
let usageStoreStatusLogged = false;

const CORS_HEADERS_BASE = {
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Cache-Control': 'no-store',
    'Vary': 'Origin'
};

function getHeader(headers, headerName) {
    if (!headers || !headerName) return undefined;
    const target = String(headerName).toLowerCase();
    for (const [k, v] of Object.entries(headers)) {
        if (String(k).toLowerCase() === target) return v;
    }
    return undefined;
}

function getAllowedOrigins() {
    const origins = new Set();
    const raw = process.env.ALLOWED_ORIGINS;
    if (raw) {
        for (const o of raw.split(',')) {
            const trimmed = o.trim();
            if (trimmed) origins.add(trimmed);
        }
    }

    const netlifyOrigins = [process.env.URL, process.env.DEPLOY_PRIME_URL, process.env.DEPLOY_URL];
    for (const o of netlifyOrigins) {
        if (o && String(o).trim()) origins.add(String(o).trim());
    }

    return Array.from(origins);
}

function isAllowedOrigin(origin, allowedOrigins, host) {
    if (!origin) return false;

    const normalizedHost = host ? String(host).trim().toLowerCase() : '';
    if (normalizedHost) {
        const originLower = String(origin).trim().toLowerCase();
        if (originLower === `https://${normalizedHost}` || originLower === `http://${normalizedHost}`) {
            return true;
        }
    }
    
    // Check explicit allowed origins
    if (Array.isArray(allowedOrigins) && allowedOrigins.includes(origin)) {
        return true;
    }
    
    // Allow any Netlify subdomain for this project (covers branch deploys)
    if (/^https:\/\/[a-z0-9-]+--cc-parts-scanner\.netlify\.app$/.test(origin) ||
        /^https:\/\/cc-parts-scanner\.netlify\.app$/.test(origin)) {
        return true;
    }
    
    return false;
}

function buildCorsHeaders(origin, allowedOrigins, host) {
    if (origin && isAllowedOrigin(origin, allowedOrigins, host)) {
        return { ...CORS_HEADERS_BASE, 'Access-Control-Allow-Origin': origin };
    }

    if (!origin && Array.isArray(allowedOrigins) && allowedOrigins.length === 0) {
        return { ...CORS_HEADERS_BASE, 'Access-Control-Allow-Origin': '*' };
    }

    return { ...CORS_HEADERS_BASE };
}

function jsonResponse({ statusCode, corsHeaders, body }) {
    return {
        statusCode,
        headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    };
}

function detectImageMime(base64Image) {
    const trimmed = String(base64Image || '').trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('/9j/')) return 'image/jpeg';
    if (trimmed.startsWith('iVBORw0')) return 'image/png';
    return null;
}

function extractTextContent(content) {
    if (typeof content === 'string') return content;
    if (!content) return '';
    if (Array.isArray(content)) {
        return content
            .map((part) => {
                if (!part) return '';
                if (typeof part === 'string') return part;
                if (typeof part.text === 'string') return part.text;
                return '';
            })
            .join('')
            .trim();
    }
    if (typeof content === 'object' && typeof content.text === 'string') return content.text;
    return '';
}

function isTruthy(value) {
    if (value === true) return true;
    const normalized = String(value || '').trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function sanitizeDebugMeta(meta) {
    if (!meta || typeof meta !== 'object') return null;
    const allowedKeys = [
        'attemptMode',
        'attemptIndex',
        'preprocess',
        'thresholded',
        'sourceW',
        'sourceH',
        'targetW',
        'targetH',
        'sharpness'
    ];
    const out = {};
    for (const key of allowedKeys) {
        const value = meta[key];
        if (
            typeof value === 'string' ||
            typeof value === 'number' ||
            typeof value === 'boolean'
        ) {
            out[key] = value;
        }
    }
    return Object.keys(out).length ? out : null;
}

function buildOcrSuccessResponse(corsHeaders, partNumber, debugInfo, modelInfo, usageCounters) {
    const body = { partNumber };
    if (modelInfo) {
        body.providerUsed = modelInfo.providerUsed || null;
        body.providerFallbackUsed = !!modelInfo.providerFallbackUsed;
        body.modelUsed = modelInfo.modelUsed || null;
        body.modelFallbackUsed = !!modelInfo.modelFallbackUsed;
    }
    if (usageCounters) body.usageCounters = usageCounters;
    if (debugInfo) body.debug = debugInfo;
    return {
        statusCode: 200,
        headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    };
}

function normalizeOpenRouterModelSlug(modelName) {
    const value = String(modelName || '').trim();
    if (!value) return '';
    const lower = value.toLowerCase();
    if (lower === 'mistralai/pixtral12b') return 'mistralai/pixtral-12b';
    if (lower === 'mistralai/pixtral-12b-2409') return 'mistralai/pixtral-12b';
    return value;
}

function getProviderConfig(providerName) {
    const provider = String(providerName || '').trim().toLowerCase();
    if (provider === 'openrouter') {
        const apiKey = process.env.OPENROUTER_API_KEY || '';
        return {
            provider: 'openrouter',
            label: 'OpenRouter',
            endpoint: 'https://openrouter.ai/api/v1/chat/completions',
            apiKey,
            getHeaders: () => {
                const headers = {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                };
                if (process.env.OPENROUTER_HTTP_REFERER) {
                    headers['HTTP-Referer'] = process.env.OPENROUTER_HTTP_REFERER;
                } else if (process.env.URL) {
                    headers['HTTP-Referer'] = process.env.URL;
                }
                headers['X-Title'] = process.env.OPENROUTER_APP_NAME || 'instrumentskanner';
                return headers;
            }
        };
    }

    const apiKey = process.env.HYPERBOLIC_API_KEY || '';
    return {
        provider: 'hyperbolic',
        label: 'Hyperbolic',
        endpoint: 'https://api.hyperbolic.xyz/v1/chat/completions',
        apiKey,
        getHeaders: () => ({
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        })
    };
}

function getProviderModelCandidates(providerName) {
    const provider = String(providerName || '').trim().toLowerCase();
    const envKey = provider === 'openrouter' ? 'OPENROUTER_OCR_MODELS' : 'HYPERBOLIC_OCR_MODELS';
    const defaults = provider === 'openrouter' ? DEFAULT_OPENROUTER_OCR_MODELS : DEFAULT_HYPERBOLIC_OCR_MODELS;
    const raw = process.env[envKey];

    if (!raw || !raw.trim()) return defaults.slice();

    const fromEnv = raw
        .split(',')
        .map((m) => {
            const trimmed = String(m || '').trim();
            if (!trimmed) return '';
            return provider === 'openrouter' ? normalizeOpenRouterModelSlug(trimmed) : trimmed;
        })
        .filter(Boolean);

    if (!fromEnv.length) return defaults.slice();
    return fromEnv;
}

function getProviderChain() {
    const primary = String(process.env.OCR_PRIMARY_PROVIDER || DEFAULT_PRIMARY_PROVIDER).trim().toLowerCase();
    const fallback = String(process.env.OCR_FALLBACK_PROVIDER || DEFAULT_FALLBACK_PROVIDER).trim().toLowerCase();
    const chain = [];
    if (primary) chain.push(primary);
    if (fallback && fallback !== primary) chain.push(fallback);
    return chain;
}

function extractPartNumberFromRawText(rawText) {
    const rawUpper = String(rawText || '').toUpperCase().trim();
    if (!rawUpper) return '';
    if (rawUpper === 'NO_PART_NUMBER') return '';

    // Common hallucinated placeholder from VLM fallback behavior.
    if (rawUpper === '12345-6789') return '';

    // Preserve the full OCR response and let the frontend pick from DB-aware candidates.
    return rawUpper;
}

function getCurrentMonthKey() {
    return new Date().toISOString().slice(0, 7);
}

function getUsageStore() {
    if (usageStore) return usageStore;
    if (usageStoreInitAttempted) return null;
    usageStoreInitAttempted = true;

    try {
        const blobs = require('@netlify/blobs');
        if (!blobs || typeof blobs.getStore !== 'function') {
            usageStoreDisabledReason = 'netlify_blobs_unavailable';
            return null;
        }

        // 1) Try Netlify-managed context first.
        try {
            usageStore = blobs.getStore({ name: 'ocr-usage' });
            if (usageStore) return usageStore;
        } catch (e) {}

        // 2) Fallback to explicit credentials when provided.
        const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID || '';
        const token =
            process.env.NETLIFY_BLOBS_TOKEN ||
            process.env.NETLIFY_AUTH_TOKEN ||
            process.env.NETLIFY_ACCESS_TOKEN ||
            '';

        if (siteID && token) {
            usageStore = blobs.getStore({ name: 'ocr-usage', siteID, token });
            if (usageStore) return usageStore;
        }

        usageStoreDisabledReason = 'blobs_not_configured';
        return null;
    } catch (e) {
        usageStoreDisabledReason = e && e.message ? e.message : 'blobs_init_failed';
        return null;
    }
}

async function recordMonthlyModelUsage(modelName) {
    const model = String(modelName || '').trim();
    if (!model) return null;

    try {
        const store = getUsageStore();
        if (!store) return null;

        const month = getCurrentMonthKey();
        const key = `month:${month}`;

        let current = null;
        try {
            if (typeof store.get === 'function') {
                const val = await store.get(key, { type: 'json' });
                if (val && typeof val === 'object') current = val;
                if (!current && typeof val === 'string') current = JSON.parse(val);
            }
        } catch (e) {}

        const snapshot = (current && typeof current === 'object') ? current : {};
        const byModel = (snapshot.byModel && typeof snapshot.byModel === 'object') ? snapshot.byModel : {};

        const prevModelCount = Number(byModel[model] || 0);
        byModel[model] = prevModelCount + 1;

        const next = {
            month,
            total: Number(snapshot.total || 0) + 1,
            byModel,
            updatedAt: new Date().toISOString()
        };

        if (typeof store.setJSON === 'function') {
            await store.setJSON(key, next);
        } else if (typeof store.set === 'function') {
            await store.set(key, JSON.stringify(next), { contentType: 'application/json' });
        } else {
            return null;
        }

        return {
            month,
            total: next.total,
            model,
            modelCount: next.byModel[model]
        };
    } catch (e) {
        console.warn('[ocr] usage counter disabled:', e && e.message ? e.message : e);
        usageStore = null;
        usageStoreInitAttempted = true;
        usageStoreDisabledReason = e && e.message ? e.message : 'usage_counter_error';
        return null;
    }
}

function getClientIp(headers) {
    const forwardedFor = getHeader(headers, 'x-forwarded-for');
    if (forwardedFor && typeof forwardedFor === 'string') {
        const first = forwardedFor.split(',')[0].trim();
        if (first) return first;
    }

    const clientIp = getHeader(headers, 'client-ip');
    if (clientIp && typeof clientIp === 'string' && clientIp.trim()) return clientIp.trim();

    return 'unknown';
}

function isRateLimited(ip, isAuthenticated) {
    // Block unauthenticated users immediately
    if (!isAuthenticated) {
        return true;
    }

    const now = Date.now();
    pruneRateLimitMap(now);
    const record = rateLimitMap.get(ip);

    if (!record || now - record.windowStart > RATE_LIMIT_WINDOW_MS) {
        rateLimitMap.set(ip, { windowStart: now, count: 1 });
        return false;
    }

    if (record.count >= RATE_LIMIT_MAX_REQUESTS_AUTHENTICATED) {
        return true;
    }

    record.count++;
    return false;
}

// Token verification (must match auth.js implementation)
function getTokenSecret() {
    const secret = process.env.AUTH_TOKEN_SECRET;
    if (!secret) {
        throw new Error('AUTH_TOKEN_SECRET is required');
    }
    return secret;
}

function verifyToken(token) {
    if (!token || typeof token !== 'string') return null;

    const parts = token.split('.');
    if (parts.length !== 2) return null;

    const [payloadBase64, signature] = parts;
    const secret = getTokenSecret();

    // Verify signature
    const hmac = crypto.createHmac('sha256', secret);
    const payload = Buffer.from(payloadBase64, 'base64url').toString('utf8');
    hmac.update(payload);
    const expectedSignature = hmac.digest('base64url');

    if (signature !== expectedSignature) return null;

    // Parse and check expiration
    try {
        const data = JSON.parse(payload);
        if (!data.exp || Date.now() > data.exp) return null;
        return data;
    } catch {
        return null;
    }
}

exports.handler = async (event) => {
    if (!usageStoreStatusLogged) {
        const store = getUsageStore();
        if (store) {
            console.info('[ocr] usage counter storage enabled');
        } else {
            console.warn('[ocr] usage counter storage unavailable', {
                reason: usageStoreDisabledReason || 'not_configured',
                hint: 'Set NETLIFY_SITE_ID and NETLIFY_BLOBS_TOKEN (or run in Netlify blobs-enabled runtime).'
            });
        }
        usageStoreStatusLogged = true;
    }

    const allowedOrigins = getAllowedOrigins();
    const origin = getHeader(event.headers, 'origin');
    const host = getHeader(event.headers, 'host');
    const corsHeaders = buildCorsHeaders(origin, allowedOrigins, host);

    if (origin && !corsHeaders['Access-Control-Allow-Origin']) {
        return jsonResponse({
            statusCode: 403,
            corsHeaders,
            body: { error: 'Origin not allowed' }
        });
    }

    // Handle CORS preflight
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 200,
            headers: corsHeaders,
            body: ''
        };
    }
    
    // Only allow POST requests
    if (event.httpMethod !== 'POST') {
        return jsonResponse({
            statusCode: 405,
            corsHeaders,
            body: { error: 'Method not allowed' }
        });
    }

    // Check authentication
    const authHeader = getHeader(event.headers, 'authorization');
    let isAuthenticated = false;

    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        const tokenData = verifyToken(token);
        isAuthenticated = tokenData !== null;
    }

    // Rate limiting (authenticated users: 50/min, unauthenticated: blocked)
    const clientIp = getClientIp(event.headers);
    if (isRateLimited(clientIp, isAuthenticated)) {
        const message = isAuthenticated
            ? 'Too many requests. Please wait a moment.'
            : 'Authentication required. Please log in to use OCR.';
        return jsonResponse({
            statusCode: isAuthenticated ? 429 : 401,
            corsHeaders,
            body: { error: message }
        });
    }

    const providerChain = getProviderChain();
    const providerConfigs = providerChain.map(getProviderConfig).filter(Boolean);
    const configuredProviders = providerConfigs.filter(cfg => !!cfg.apiKey);

    if (!configuredProviders.length) {
        return jsonResponse({
            statusCode: 500,
            corsHeaders,
            body: { error: 'No OCR provider API keys configured (need HYPERBOLIC_API_KEY and/or OPENROUTER_API_KEY)' }
        });
    }

    try {
        const contentType = String(getHeader(event.headers, 'content-type') || '').toLowerCase();
        if (!contentType.includes('application/json')) {
            return jsonResponse({
                statusCode: 415,
                corsHeaders,
                body: { error: 'Unsupported Media Type. Use application/json.' }
            });
        }

        let payload;
        try {
            payload = JSON.parse(event.body || '');
        } catch {
            return jsonResponse({
                statusCode: 400,
                corsHeaders,
                body: { error: 'Invalid JSON body' }
            });
        }

        const imageInput = payload ? payload.image : undefined;
        const debugRequested = !!(payload && isTruthy(payload.debug));
        const debugMeta = sanitizeDebugMeta(payload ? payload.debugMeta : null);

        if (typeof imageInput !== 'string' || !imageInput.trim()) {
            return jsonResponse({
                statusCode: 400,
                corsHeaders,
                body: { error: 'No image provided' }
            });
        }

        const base64Raw = imageInput.includes(',') ? imageInput.split(',').pop() : imageInput;
        const base64Image = String(base64Raw || '').trim().replace(/\s+/g, '');

        if (!base64Image || !/^[A-Za-z0-9+/=]+$/.test(base64Image)) {
            return jsonResponse({
                statusCode: 400,
                corsHeaders,
                body: { error: 'Invalid base64 image data' }
            });
        }

        const imageMime = detectImageMime(base64Image);
        if (!imageMime) {
            return jsonResponse({
                statusCode: 400,
                corsHeaders,
                body: { error: 'Unsupported image format. Use JPEG or PNG.' }
            });
        }
        
        // Validate image size (base64 is ~33% larger than binary)
        const estimatedSize = (base64Image.length * 3) / 4;
        const approxBytes = Math.floor(estimatedSize);
        let debugInfo = null;

        try {
            console.debug('[ocr] request', {
                base64Len: base64Image.length,
                approxBytes
            });
        } catch (e) {}

        if (debugRequested) {
            try {
                const imageBuffer = Buffer.from(base64Image, 'base64');
                const sha256 = crypto.createHash('sha256').update(imageBuffer).digest('hex');
                debugInfo = {
                    mime: imageMime,
                    approxBytes,
                    sha256,
                    meta: debugMeta || undefined
                };

                console.debug('[ocr][debug] image payload', debugInfo);

                if (isTruthy(process.env.OCR_DEBUG_WRITE_IMAGE)) {
                    const extension = imageMime === 'image/png' ? 'png' : 'jpg';
                    const filePath = `/tmp/ocr-${Date.now()}-${sha256.slice(0, 12)}.${extension}`;
                    await fs.writeFile(filePath, imageBuffer);
                    debugInfo.savedPath = filePath;
                    console.debug('[ocr][debug] image saved', { path: filePath });
                }
            } catch (e) {
                console.error('[ocr][debug] image debug failed:', e && e.message ? e.message : e);
            }
        }

        if (estimatedSize > MAX_IMAGE_SIZE_BYTES) {
            return jsonResponse({
                statusCode: 400,
                corsHeaders,
                body: { error: 'Image too large. Maximum size is 5MB.' }
            });
        }

        const modelAttempts = [];
        let sawTimeout = false;
        let lastUpstreamStatus = null;
        const primaryProvider = configuredProviders[0] ? configuredProviders[0].provider : null;
        const primaryModels = configuredProviders[0]
            ? getProviderModelCandidates(configuredProviders[0].provider)
            : [];
        const primaryModel = primaryModels[0] || null;

        for (const providerCfg of configuredProviders) {
            const providerModels = getProviderModelCandidates(providerCfg.provider);
            for (const model of providerModels) {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 12000);
                let response;

                try {
                    response = await fetch(providerCfg.endpoint, {
                        method: 'POST',
                        headers: providerCfg.getHeaders(),
                        body: JSON.stringify({
                            model,
                            messages: [
                                {
                                    role: 'user',
                                    content: [
                                        {
                                            type: 'text',
                                            text: 'Read the label in the image and extract exactly one real part number. Return only that code. Do not invent or guess values. If unreadable, respond exactly NO_PART_NUMBER.'
                                        },
                                        {
                                            type: 'image_url',
                                            image_url: {
                                                url: `data:${imageMime};base64,${base64Image}`
                                            }
                                        }
                                    ]
                                }
                            ],
                            max_tokens: 512,
                            temperature: 0.7,
                            top_p: 0.9,
                            stream: false
                        }),
                        signal: controller.signal
                    });
                } catch (error) {
                    clearTimeout(timeoutId);
                    if (error && (error.name === 'AbortError' || String(error.name || '').toLowerCase() === 'aborted')) {
                        sawTimeout = true;
                        modelAttempts.push({ provider: providerCfg.provider, model, error: 'timeout' });
                        continue;
                    }
                    throw error;
                } finally {
                    clearTimeout(timeoutId);
                }

                if (!response.ok) {
                    const errorText = await response.text();
                    lastUpstreamStatus = response.status;
                    modelAttempts.push({ provider: providerCfg.provider, model, status: response.status });
                    console.error('[ocr] upstream API error:', {
                        provider: providerCfg.provider,
                        status: response.status,
                        model,
                        body: errorText
                    });

                    if (response.status === 401 || response.status === 403) {
                        continue;
                    }

                    continue;
                }

                const data = await response.json();

                try {
                    if (data && data.usage) {
                        console.debug('[ocr] upstream usage', {
                            provider: providerCfg.provider,
                            model,
                            usage: data.usage
                        });
                    } else {
                        console.debug('[ocr] upstream usage missing', {
                            provider: providerCfg.provider,
                            model
                        });
                    }
                } catch (e) {}

                const rawText = (data && data.choices && data.choices[0] && data.choices[0].message)
                    ? extractTextContent(data.choices[0].message.content)
                    : '';
                const partNumber = extractPartNumberFromRawText(rawText);

                console.log('[ocr] model result', {
                    provider: providerCfg.provider,
                    model,
                    rawText: rawText || '',
                    partNumber: partNumber || ''
                });

                modelAttempts.push({
                    provider: providerCfg.provider,
                    model,
                    rawText: String(rawText || '').slice(0, 120),
                    partNumber: partNumber || ''
                });

                if (partNumber) {
                    if (debugInfo) {
                        debugInfo.provider = providerCfg.provider;
                        debugInfo.model = model;
                        debugInfo.modelAttempts = modelAttempts;
                    }
                    const usageCounters = await recordMonthlyModelUsage(`${providerCfg.provider}:${model}`);
                    if (usageCounters) {
                        console.info('[ocr] monthly usage', usageCounters);
                    }
                    const providerFallbackUsed = !!(primaryProvider && providerCfg.provider !== primaryProvider);
                    const modelFallbackUsed = !!(primaryModel && model !== primaryModel);
                    return buildOcrSuccessResponse(
                        corsHeaders,
                        partNumber,
                        debugInfo,
                        {
                            providerUsed: providerCfg.provider,
                            providerFallbackUsed,
                            modelUsed: model,
                            modelFallbackUsed: providerFallbackUsed || modelFallbackUsed
                        },
                        usageCounters
                    );
                }
            }
        }

        if (debugInfo) {
            debugInfo.provider = null;
            debugInfo.model = null;
            debugInfo.modelAttempts = modelAttempts;
        }

        if (sawTimeout && !modelAttempts.some((a) => a.partNumber)) {
            return jsonResponse({
                statusCode: 504,
                corsHeaders,
                body: { error: 'Upstream OCR request timed out' }
            });
        }

        if (lastUpstreamStatus && !modelAttempts.some((a) => a.partNumber) && !modelAttempts.some((a) => !a.status && !a.error)) {
            return jsonResponse({
                statusCode: lastUpstreamStatus,
                corsHeaders,
                body: { error: `API error: ${lastUpstreamStatus}` }
            });
        }

        const lastAttempt = modelAttempts.length ? modelAttempts[modelAttempts.length - 1] : null;
        const lastProviderTried = (lastAttempt && lastAttempt.provider) || primaryProvider;
        const lastModelTried = (lastAttempt && lastAttempt.model) || primaryModel;
        const usageKey = `${lastProviderTried}:${lastModelTried}`;
        const usageCounters = await recordMonthlyModelUsage(usageKey);
        if (usageCounters) {
            console.info('[ocr] monthly usage', usageCounters);
        }

        return buildOcrSuccessResponse(
            corsHeaders,
            '',
            debugInfo,
            {
                providerUsed: lastProviderTried,
                providerFallbackUsed: !!(primaryProvider && lastProviderTried && lastProviderTried !== primaryProvider),
                modelUsed: lastModelTried,
                modelFallbackUsed: !!(primaryModel && lastModelTried && lastModelTried !== primaryModel)
            },
            usageCounters
        );

    } catch (error) {
        console.error('OCR function error:', error);
        return jsonResponse({
            statusCode: 500,
            corsHeaders,
            body: { error: 'Internal server error' }
        });
    }
};
