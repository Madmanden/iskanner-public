// Netlify serverless function to proxy OCR model API calls
// This keeps the API key secure on the server side

import crypto from 'crypto';
import fs from 'fs/promises';
import * as blobs from '@netlify/blobs';

import {
    getHeader,
    getAllowedOrigins,
    buildCorsHeaders,
    jsonResponse,
    getTokenSecret,
    verifyToken
} from './lib/shared.js';

// Blob-backed rate limiting keeps the limit shared across warm instances.
// We keep an in-memory fallback for local/dev environments without Blobs.
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS_AUTHENTICATED = 50; // max requests per window for authenticated users
const RATE_LIMIT_MAX_ENTRIES = 5000; // Maximum entries before pruning
const RATE_LIMIT_BLOB_STORE_NAME = 'ocr-rate-limit';
const RATE_LIMIT_RETRY_ATTEMPTS = 4;

// Count this warm instance last saw for each client in the current window.
// A client well below the limit does not wait for the Blob round trip before
// the model call: its check runs alongside the call, and the answer is
// discarded if the check says the limit was reached. Without a recent count
// (cold instance) or close to the limit, the check blocks as before, so the
// extra model calls past the limit stay bounded by the number of instances.
const rateLimitSeenCounts = new Map();
const RATE_LIMIT_PARALLEL_HEADROOM = 10;

export function rememberRateLimitCount(ip, record) {
    if (rateLimitSeenCounts.size > RATE_LIMIT_MAX_ENTRIES) rateLimitSeenCounts.clear();
    rateLimitSeenCounts.set(getRateLimitRecordKey(ip), {
        windowStart: Number(record && record.windowStart) || 0,
        count: Number(record && record.count) || 0
    });
}

export function hasRateLimitHeadroom(ip, now = Date.now()) {
    const seen = rateLimitSeenCounts.get(getRateLimitRecordKey(ip));
    if (!seen) return false;
    const currentWindowStart = getRateLimitWindowKey(now) * RATE_LIMIT_WINDOW_MS;
    const count = seen.windowStart === currentWindowStart ? seen.count : 0;
    return count + RATE_LIMIT_PARALLEL_HEADROOM < RATE_LIMIT_MAX_REQUESTS_AUTHENTICATED;
}

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
export const OCR_REQUEST_TIMEOUT_MS = 8000;
const DEFAULT_PRIMARY_PROVIDER = 'openrouter';
const DEFAULT_FALLBACK_PROVIDER = '';
const DEFAULT_HYPERBOLIC_OCR_MODELS = [
    'Qwen/Qwen2.5-VL-72B-Instruct',
    'Qwen/Qwen2.5-VL-7B-Instruct'
];
const DEFAULT_OPENROUTER_OCR_MODELS = [
    'google/gemini-2.5-flash-lite'
];
// Format hints come from the most common key shapes in parts-database. They are
// described in words, not as example codes: a model that echoes an example
// could otherwise return a real part number that is not on the label.
// The model lists its candidates (and the alternative reading of an ambiguous
// character) instead of choosing one; the client picks the line that is a real
// database key.
export const OCR_PROMPT = [
    'Read the label in the image and list the real part numbers (article/catalogue numbers) printed on it, one per line, the most likely first. Usually there is only one. Return only the codes.',
    'It is usually printed after REF or Art. Do not return the REF/Art. prefix itself, and ignore LOT/batch numbers, serial numbers (SN), dates, quantities, CE marks and barcode digits such as (01)/(17)/(10).',
    'Part numbers use letters, digits, dots and hyphens; keep dots and hyphens exactly as printed. Common forms: two letters, three digits and one letter; or groups of digits joined by hyphens or dots.',
    'If a character in a code could be read two ways (for example the letter O, the digit 0 or the letter M), add the other reading of that code on the next line.',
    'Do not invent or guess values. If unreadable, respond exactly NO_PART_NUMBER.'
].join(' ');
const OCR_MAX_TOKENS = 64;
let usageStore = null;
let usageStoreInitAttempted = false;
let usageStoreDisabledReason = null;

class OcrTimeoutError extends Error {
    constructor() {
        super('OCR request timed out');
        this.name = 'OcrTimeoutError';
        this.errorType = 'timeout';
    }
}

function isOcrTimeoutError(error) {
    return !!(error && (error.errorType === 'timeout' || error.name === 'OcrTimeoutError'));
}

function getRemainingRequestTime(deadlineAt) {
    return Math.max(0, deadlineAt - Date.now());
}

async function readResponseBodyWithinDeadline(response, controller, deadlineAt) {
    const remainingMs = getRemainingRequestTime(deadlineAt);
    if (remainingMs <= 0) throw new OcrTimeoutError();

    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            try { controller.abort(); } catch (e) {}
            reject(new OcrTimeoutError());
        }, remainingMs);
    });

    try {
        return await Promise.race([response.text(), timeoutPromise]);
    } finally {
        clearTimeout(timeoutId);
    }
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
        'sharpness',
        'clippedRatio'
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

export function extractPartNumberFromRawText(rawText) {
    // The model answers with one candidate per line. Drop the "nothing found"
    // marker and the common hallucinated placeholder from VLM fallback behavior.
    const lines = String(rawText || '')
        .toUpperCase()
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line && line !== 'NO_PART_NUMBER' && line !== '12345-6789');
    if (!lines.length) return '';

    // Require at least one token that looks like a part number before treating
    // this attempt as successful. Prevents verbose, instructional, or truncated
    // model output from short-circuiting the provider fallback chain.
    // Charset and length match the client-side isLikelyPartNumber() check.
    const tokens = lines.join('\n').match(/[A-Z0-9.\-]+/g) || [];
    const hasCandidate = tokens.some(t => t.length >= 4 && t.length <= 32 && /[0-9]/.test(t));
    if (!hasCandidate) return '';

    // Return all lines so the frontend's DB-aware extraction picks the best candidate.
    return lines.join('\n');
}

function getCurrentMonthKey() {
    return new Date().toISOString().slice(0, 7);
}

function getUsageStore() {
    if (usageStore) return usageStore;
    if (usageStoreInitAttempted) return null;
    usageStoreInitAttempted = true;

    try {
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

        for (let attempt = 0; attempt < RATE_LIMIT_RETRY_ATTEMPTS; attempt++) {
            const snapshotRecord = await readJsonRecord(store, key);
            const snapshot = (snapshotRecord.data && typeof snapshotRecord.data === 'object') ? snapshotRecord.data : {};
            const byModel = (snapshot.byModel && typeof snapshot.byModel === 'object') ? { ...snapshot.byModel } : {};

            const prevModelCount = Number(byModel[model] || 0);
            byModel[model] = prevModelCount + 1;

            const next = {
                month,
                total: Number(snapshot.total || 0) + 1,
                byModel,
                updatedAt: new Date().toISOString()
            };

            const modified = await writeJsonRecord(store, key, next, snapshotRecord.etag);
            if (modified) {
                return {
                    month,
                    total: next.total,
                    model,
                    modelCount: next.byModel[model]
                };
            }
        }

        return null;
    } catch (e) {
        usageStore = null;
        usageStoreInitAttempted = true;
        usageStoreDisabledReason = e && e.message ? e.message : 'usage_counter_error';
        return null;
    }
}

function getRateLimitStore() {
    try {
        if (!blobs || typeof blobs.getStore !== 'function') {
            return null;
        }

        try {
            return blobs.getStore({ name: RATE_LIMIT_BLOB_STORE_NAME });
        } catch (e) {
            const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID || '';
            const token =
                process.env.NETLIFY_BLOBS_TOKEN ||
                process.env.NETLIFY_AUTH_TOKEN ||
                process.env.NETLIFY_ACCESS_TOKEN ||
                '';

            if (siteID && token) {
                return blobs.getStore({ name: RATE_LIMIT_BLOB_STORE_NAME, siteID, token });
            }

            return null;
        }
    } catch (e) {
        return null;
    }
}

async function readJsonRecord(store, key) {
    if (!store || typeof store.getWithMetadata !== 'function') {
        return { data: null, etag: null };
    }

    try {
        const entry = await store.getWithMetadata(key, { type: 'json' });
        if (!entry) return { data: null, etag: null };
        const data = entry.data;
        if (!data || typeof data !== 'object') {
            return { data: null, etag: entry.etag || null };
        }
        return { data, etag: entry.etag || null };
    } catch (e) {
        return { data: null, etag: null };
    }
}

async function writeJsonRecord(store, key, data, etag) {
    if (!store || typeof store.setJSON !== 'function') return false;

    const options = etag ? { onlyIfMatch: etag } : { onlyIfNew: true };
    const result = await store.setJSON(key, data, options);
    return !!(result && result.modified);
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

function getRateLimitWindowKey(now = Date.now()) {
    return Math.floor(now / RATE_LIMIT_WINDOW_MS);
}

function hashRateLimitKey(ip) {
    return crypto.createHash('sha256').update(String(ip || 'unknown')).digest('hex');
}

export function getRateLimitRecordKey(ip) {
    return `ip:${hashRateLimitKey(ip)}`;
}

export function buildRateLimitRecord(snapshot = {}, now = Date.now()) {
    const windowStart = getRateLimitWindowKey(now) * RATE_LIMIT_WINDOW_MS;
    const previousWindowStart = Number(snapshot.windowStart || 0);
    const currentCount = previousWindowStart === windowStart ? Number(snapshot.count || 0) : 0;

    return {
        windowStart,
        count: currentCount + 1,
        updatedAt: new Date(now).toISOString()
    };
}

async function isRateLimited(ip, isAuthenticated) {
    // Block unauthenticated users immediately
    if (!isAuthenticated) {
        return true;
    }

    const now = Date.now();
    const store = getRateLimitStore();

    if (store) {
        const key = getRateLimitRecordKey(ip);

        for (let attempt = 0; attempt < RATE_LIMIT_RETRY_ATTEMPTS; attempt++) {
            const snapshotRecord = await readJsonRecord(store, key);
            const snapshot = (snapshotRecord.data && typeof snapshotRecord.data === 'object') ? snapshotRecord.data : {};
            const currentWindowStart = getRateLimitWindowKey(now) * RATE_LIMIT_WINDOW_MS;
            const storedWindowStart = Number(snapshot.windowStart || 0);
            const currentCount = storedWindowStart === currentWindowStart ? Number(snapshot.count || 0) : 0;

            if (currentCount >= RATE_LIMIT_MAX_REQUESTS_AUTHENTICATED) {
                rememberRateLimitCount(ip, { windowStart: currentWindowStart, count: currentCount });
                return true;
            }

            const next = buildRateLimitRecord(snapshot, now);

            const modified = await writeJsonRecord(store, key, next, snapshotRecord.etag);
            if (modified) {
                rememberRateLimitCount(ip, next);
                return false;
            }
        }

        // Fall back to in-memory state if the shared store is contended or unavailable.
    }

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

function buildRateLimitedResponse(corsHeaders) {
    return jsonResponse({
        statusCode: 429,
        corsHeaders,
        body: { error: 'Too many requests. Please wait a moment.' }
    });
}

// Set on the first invocation of a fresh function instance.
let isColdInstance = true;

function roundMs(value) {
    return Math.round(value * 10) / 10;
}

/**
 * Server-Timing header for the OCR response, so the client (or the browser's
 * network panel) can see where a scan's time went: rate-limit check, model
 * calls, waiting for the usage counter, the whole function, and cold starts.
 */
export function formatServerTiming(timing) {
    const parts = [];
    if (Number.isFinite(timing.rateLimitMs)) {
        parts.push(`ratelimit;dur=${roundMs(timing.rateLimitMs)};desc="${timing.rateLimitMode}"`);
    }
    if (timing.modelCalls > 0) {
        parts.push(`upstream;dur=${roundMs(timing.upstreamMs)};desc="${timing.modelCalls} call${timing.modelCalls === 1 ? '' : 's'}"`);
    }
    if (timing.usageWaitMs > 0) parts.push(`usage;dur=${roundMs(timing.usageWaitMs)}`);
    if (Number.isFinite(timing.totalMs)) parts.push(`total;dur=${roundMs(timing.totalMs)}`);
    if (timing.cold) parts.push('cold');
    return parts.join(', ');
}

export const handler = async (event) => {
    const handlerStartedAt = performance.now();
    const coldStart = isColdInstance;
    isColdInstance = false;
    const requestDeadlineAt = Date.now() + OCR_REQUEST_TIMEOUT_MS;
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

    const tokenSecret = getTokenSecret();
    if (!tokenSecret) {
        return jsonResponse({
            statusCode: 500,
            corsHeaders,
            body: {
                error: 'Authentication is not configured',
                details: 'Set AUTH_TOKEN_SECRET in your environment.'
            }
        });
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
        const tokenData = verifyToken(token, tokenSecret);
        isAuthenticated = tokenData !== null;
    }

    if (!isAuthenticated) {
        return jsonResponse({
            statusCode: 401,
            corsHeaders,
            body: { error: 'Authentication required. Please log in to use OCR.' }
        });
    }

    // Rate limiting (authenticated users: 50/min). With headroom the check runs
    // alongside the model call; see rateLimitSeenCounts.
    const timing = {
        cold: coldStart,
        rateLimitMs: null,
        rateLimitMode: 'blocking',
        upstreamMs: 0,
        modelCalls: 0,
        usageWaitMs: 0,
        totalMs: null
    };
    const clientIp = getClientIp(event.headers);
    const parallelRateLimit = hasRateLimitHeadroom(clientIp);
    if (parallelRateLimit) timing.rateLimitMode = 'parallel';
    const rateLimitStartedAt = performance.now();
    const rateLimitCheck = isRateLimited(clientIp, true).finally(() => {
        timing.rateLimitMs = performance.now() - rateLimitStartedAt;
    });
    // Mark the promise as handled while the model call runs; a failed check
    // still throws where it is awaited below.
    rateLimitCheck.catch(() => {});

    let response;
    if (!parallelRateLimit && await rateLimitCheck) {
        response = buildRateLimitedResponse(corsHeaders);
    } else {
        response = await processOcrRequest(event, corsHeaders, requestDeadlineAt, timing);
        if (await rateLimitCheck) response = buildRateLimitedResponse(corsHeaders);
    }

    timing.totalMs = performance.now() - handlerStartedAt;
    response.headers = { ...response.headers, 'Server-Timing': formatServerTiming(timing) };
    return response;
};

async function processOcrRequest(event, corsHeaders, requestDeadlineAt, timing) {
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

    // Usage is counted per model call and written while the call is in
    // flight, so the Blob round trip is not added to the scan latency.
    const pendingUsage = [];
    // Any wait left at the end is reported as "usage" in Server-Timing.
    const settleUsage = async () => {
        const startedAt = performance.now();
        try {
            return await Promise.all(pendingUsage);
        } finally {
            timing.usageWaitMs += performance.now() - startedAt;
        }
    };

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

        if (debugRequested) {
            try {
                console.debug('[ocr] request', {
                    base64Len: base64Image.length,
                    approxBytes
                });
            } catch (e) {}
        }

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
        let deadlineExceeded = false;
        let lastUpstreamStatus = null;
        const primaryProvider = configuredProviders[0] ? configuredProviders[0].provider : null;
        const primaryModels = configuredProviders[0]
            ? getProviderModelCandidates(configuredProviders[0].provider)
            : [];
        const primaryModel = primaryModels[0] || null;

        for (const providerCfg of configuredProviders) {
            const providerModels = getProviderModelCandidates(providerCfg.provider);
            for (const model of providerModels) {
                const remainingMs = getRemainingRequestTime(requestDeadlineAt);
                if (remainingMs <= 0) {
                    deadlineExceeded = true;
                    break;
                }
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), remainingMs);
                const usagePromise = recordMonthlyModelUsage(`${providerCfg.provider}:${model}`);
                pendingUsage.push(usagePromise);
                let response;
                const upstreamStartedAt = performance.now();
                const addUpstreamTime = () => {
                    timing.upstreamMs += performance.now() - upstreamStartedAt;
                };
                timing.modelCalls += 1;

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
                                            text: OCR_PROMPT
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
                            max_tokens: OCR_MAX_TOKENS,
                            temperature: 0,
                            stream: false
                        }),
                        signal: controller.signal
                    });
                } catch (error) {
                    clearTimeout(timeoutId);
                    if (error && (error.name === 'AbortError' || String(error.name || '').toLowerCase() === 'aborted')) {
                        deadlineExceeded = true;
                        modelAttempts.push({ provider: providerCfg.provider, model, error: 'timeout' });
                        addUpstreamTime();
                        break;
                    }
                    throw error;
                } finally {
                    clearTimeout(timeoutId);
                }

                if (deadlineExceeded) break;

                if (!response.ok) {
                    const errorText = await readResponseBodyWithinDeadline(response, controller, requestDeadlineAt);
                    addUpstreamTime();
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

                const responseText = await readResponseBodyWithinDeadline(response, controller, requestDeadlineAt);
                addUpstreamTime();
                let data;
                try {
                    data = JSON.parse(responseText);
                } catch (error) {
                    throw new Error('Invalid OCR provider response');
                }

                try {
                    if (data && data.usage) {
                        if (debugRequested) {
                            console.debug('[ocr] upstream usage', {
                                provider: providerCfg.provider,
                                model,
                                usage: data.usage
                            });
                        }
                    } else {
                        if (debugRequested) {
                            console.debug('[ocr] upstream usage missing', {
                                provider: providerCfg.provider,
                                model
                            });
                        }
                    }
                } catch (e) {}

                const rawText = (data && data.choices && data.choices[0] && data.choices[0].message)
                    ? extractTextContent(data.choices[0].message.content)
                    : '';
                const partNumber = extractPartNumberFromRawText(rawText);

                if (debugRequested) {
                    console.log('[ocr] model result', {
                        provider: providerCfg.provider,
                        model,
                        rawText: rawText || '',
                        partNumber: partNumber || ''
                    });
                }

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
                    await settleUsage();
                    const usageCounters = await usagePromise;
                    if (usageCounters && debugRequested) {
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
            if (deadlineExceeded) break;
        }

        if (debugInfo) {
            debugInfo.provider = null;
            debugInfo.model = null;
            debugInfo.modelAttempts = modelAttempts;
        }

        const usageResults = await settleUsage();

        if (deadlineExceeded) {
            return jsonResponse({
                statusCode: 504,
                corsHeaders,
                body: { error: 'OCR request timed out', errorType: 'timeout' }
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
        const usageCounters = usageResults.length ? usageResults[usageResults.length - 1] : null;
        if (usageCounters && debugRequested) {
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
        await settleUsage();
        if (isOcrTimeoutError(error) || getRemainingRequestTime(requestDeadlineAt) <= 0) {
            return jsonResponse({
                statusCode: 504,
                corsHeaders,
                body: { error: 'OCR request timed out', errorType: 'timeout' }
            });
        }
        console.error('OCR function error:', error);
        return jsonResponse({
            statusCode: 500,
            corsHeaders,
            body: { error: 'Internal server error' }
        });
    }
}
