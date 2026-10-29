// Stores OCR ground truth: a scan that did not give an exact database hit,
// followed by the part number the user actually confirmed. Each sample keeps
// the crop that was sent to the OCR model, so the samples can be replayed as
// a benchmark against other prompts and models.

import crypto from 'crypto';
import * as blobs from '@netlify/blobs';

import {
    getHeader,
    getAllowedOrigins,
    buildCorsHeaders,
    jsonResponse,
    getTokenSecret,
    verifyToken
} from './lib/shared.js';

export const OCR_FEEDBACK_STORE_NAME = 'ocr-feedback';
// OCR crops are 768 px wide and usually 50–150 KB.
const MAX_IMAGE_BASE64_LENGTH = 600_000; // ~450 KB JPEG
// Caps stored samples per UTC day, so a leaked session token cannot fill the
// Blob store. Real use stays far below it (at most one sample per scan).
export const MAX_SAMPLES_PER_DAY = 200;
const DAILY_COUNT_RETRY_ATTEMPTS = 4;
const LOOKUP_KINDS = ['suggestion', 'not_found', 'no_result'];
const CONFIRM_SOURCES = ['ocr_suggestion', 'manual', 'manual_search', 'voice', 'lookup'];
const SERVER_TIMING_NAMES = ['ratelimit', 'upstream', 'usage', 'total', 'cold'];

function cappedString(value, maxLength) {
    return typeof value === 'string' ? value.slice(0, maxLength) : '';
}

function finiteOrNull(value) {
    const number = Number(value);
    return value !== null && value !== '' && Number.isFinite(number) ? number : null;
}

function sanitizeServerTimings(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 5).map((timing) => {
        const out = {};
        if (!timing || typeof timing !== 'object') return out;
        for (const name of SERVER_TIMING_NAMES) {
            const metric = timing[name];
            if (!metric || typeof metric !== 'object') continue;
            out[name] = {
                dur: finiteOrNull(metric.dur),
                desc: cappedString(metric.desc, 40)
            };
        }
        return out;
    });
}

function isCompleteJpeg(bytes) {
    const n = bytes.length;
    return n >= 4 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[n - 2] === 0xFF && bytes[n - 1] === 0xD9;
}

/**
 * Validate a feedback payload from the client. Returns { record, image }
 * (image: decoded JPEG bytes or null) or { error } for a 400 response.
 */
export function buildOcrFeedbackRecord(payload, { now = new Date(), userAgent = '' } = {}) {
    if (!payload || typeof payload !== 'object') return { error: 'Invalid payload' };

    const correct = String(payload.correct || '').trim().toUpperCase();
    if (!/^[A-Z0-9.\-]{2,40}$/.test(correct)) return { error: 'Invalid part number' };

    let image = null;
    if (payload.image !== undefined && payload.image !== null && payload.image !== '') {
        const base64 = String(payload.image).trim();
        if (base64.length > MAX_IMAGE_BASE64_LENGTH || !/^[A-Za-z0-9+/=]+$/.test(base64)) {
            return { error: 'Invalid image' };
        }
        image = Buffer.from(base64, 'base64');
        if (!isCompleteJpeg(image)) return { error: 'Invalid image' };
    }

    const kind = LOOKUP_KINDS.includes(payload.kind) ? payload.kind : 'unknown';
    const source = CONFIRM_SOURCES.includes(payload.source) ? payload.source : 'unknown';

    return {
        image,
        record: {
            createdAt: now.toISOString(),
            correct,
            read: cappedString(payload.read, 64).toUpperCase(),
            raw: cappedString(payload.raw, 300),
            kind,
            source,
            model: cappedString(payload.model, 100),
            attemptModes: Array.isArray(payload.attemptModes)
                ? payload.attemptModes.slice(0, 5).map(mode => cappedString(mode, 20))
                : [],
            sharpness: finiteOrNull(payload.sharpness),
            clippedRatio: finiteOrNull(payload.clippedRatio),
            networkMs: finiteOrNull(payload.networkMs),
            msSinceScan: finiteOrNull(payload.msSinceScan),
            serverTimings: sanitizeServerTimings(payload.serverTimings),
            userAgent: cappedString(userAgent, 200)
        }
    };
}

export function buildOcrFeedbackKey(now = new Date()) {
    const month = now.toISOString().slice(0, 7);
    const stamp = now.toISOString().replace(/[-:.]/g, '');
    return `samples/${month}/${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * Count one sample against today's cap. Returns false when the cap is reached
 * or the counter stays contended.
 */
export async function reserveDailySample(store, now = new Date()) {
    const key = `count/${now.toISOString().slice(0, 10)}`;
    for (let attempt = 0; attempt < DAILY_COUNT_RETRY_ATTEMPTS; attempt++) {
        const entry = await store.getWithMetadata(key, { type: 'json' });
        const count = Number(entry && entry.data && entry.data.count) || 0;
        if (count >= MAX_SAMPLES_PER_DAY) return false;
        const options = entry && entry.etag ? { onlyIfMatch: entry.etag } : { onlyIfNew: true };
        const result = await store.setJSON(key, { count: count + 1 }, options);
        if (result && result.modified) return true;
    }
    return false;
}

function getFeedbackStore() {
    if (!blobs || typeof blobs.getStore !== 'function') return null;

    try {
        return blobs.getStore({ name: OCR_FEEDBACK_STORE_NAME });
    } catch (e) {
        const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID || '';
        const token =
            process.env.NETLIFY_BLOBS_TOKEN ||
            process.env.NETLIFY_AUTH_TOKEN ||
            process.env.NETLIFY_ACCESS_TOKEN ||
            '';

        if (!siteID || !token) return null;
        try {
            return blobs.getStore({ name: OCR_FEEDBACK_STORE_NAME, siteID, token });
        } catch (err) {
            return null;
        }
    }
}

export const handler = async (event) => {
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

    if (event.httpMethod !== 'POST') {
        return jsonResponse({
            statusCode: 405,
            corsHeaders,
            body: { error: 'Method not allowed' }
        });
    }

    const authHeader = getHeader(event.headers, 'authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ') || !verifyToken(authHeader.substring(7), tokenSecret)) {
        return jsonResponse({
            statusCode: 401,
            corsHeaders,
            body: { error: 'Authentication required' }
        });
    }

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

    const now = new Date();
    const { record, image, error } = buildOcrFeedbackRecord(payload, {
        now,
        userAgent: getHeader(event.headers, 'user-agent') || ''
    });
    if (error) {
        return jsonResponse({
            statusCode: 400,
            corsHeaders,
            body: { error }
        });
    }

    const store = getFeedbackStore();
    if (!store) {
        return jsonResponse({
            statusCode: 503,
            corsHeaders,
            body: { error: 'Feedback storage is not available' }
        });
    }

    try {
        if (!(await reserveDailySample(store, now))) {
            return jsonResponse({
                statusCode: 429,
                corsHeaders,
                body: { error: 'Daily feedback limit reached' }
            });
        }

        const key = buildOcrFeedbackKey(now);
        // The image is written first, so a stored record always has its image.
        if (image) {
            await store.set(`${key}.jpg`, image.buffer.slice(image.byteOffset, image.byteOffset + image.byteLength));
        }
        await store.setJSON(`${key}.json`, { ...record, image: image ? `${key}.jpg` : null });

        return jsonResponse({
            statusCode: 200,
            corsHeaders,
            body: { ok: true }
        });
    } catch (e) {
        console.error('[ocr-feedback] store failed:', e && e.message ? e.message : e);
        return jsonResponse({
            statusCode: 500,
            corsHeaders,
            body: { error: 'Could not store feedback' }
        });
    }
};
