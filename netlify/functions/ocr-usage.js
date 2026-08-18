import * as blobs from '@netlify/blobs';

import {
    getHeader,
    getAllowedOrigins,
    buildCorsHeaders,
    jsonResponse,
    getTokenSecret,
    verifyToken
} from './lib/shared.js';

function getCurrentMonthKey() {
    return new Date().toISOString().slice(0, 7);
}

function sanitizeMonth(value) {
    const v = String(value || '').trim();
    if (!v) return '';
    return /^\d{4}-\d{2}$/.test(v) ? v : '';
}

function makeEmptyUsage(month) {
    return {
        month,
        total: 0,
        byModel: {},
        pixtralCount: 0,
        openrouterGeminiCount: 0,
        updatedAt: null
    };
}

function enrichUsageSnapshot(snapshot) {
    const month = String(snapshot.month || getCurrentMonthKey());
    const byModel = (snapshot.byModel && typeof snapshot.byModel === 'object') ? snapshot.byModel : {};
    const pixtralCount = Number(byModel['hyperbolic:mistralai/Pixtral-12B-2409'] || 0);
    const openrouterGeminiCount = Number(byModel['openrouter:google/gemini-2.5-flash-lite'] || 0);

    return {
        month,
        total: Number(snapshot.total || 0),
        byModel,
        pixtralCount,
        openrouterGeminiCount,
        updatedAt: snapshot.updatedAt || null
    };
}

function getUsageStore() {
    if (!blobs || typeof blobs.getStore !== 'function') {
        throw new Error('netlify_blobs_unavailable');
    }

    try {
        return blobs.getStore({ name: 'ocr-usage' });
    } catch (e) {
        const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID || '';
        const token =
            process.env.NETLIFY_BLOBS_TOKEN ||
            process.env.NETLIFY_AUTH_TOKEN ||
            process.env.NETLIFY_ACCESS_TOKEN ||
            '';

        if (!siteID || !token) {
            throw new Error('blobs_not_configured');
        }
        return blobs.getStore({ name: 'ocr-usage', siteID, token });
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

    if (event.httpMethod !== 'GET') {
        return jsonResponse({
            statusCode: 405,
            corsHeaders,
            body: { error: 'Method not allowed' }
        });
    }

    const authHeader = getHeader(event.headers, 'authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return jsonResponse({
            statusCode: 401,
            corsHeaders,
            body: { error: 'Authentication required' }
        });
    }

    const token = authHeader.substring(7);
    if (!verifyToken(token, tokenSecret)) {
        return jsonResponse({
            statusCode: 401,
            corsHeaders,
            body: { error: 'Invalid token' }
        });
    }

    const month = sanitizeMonth(event.queryStringParameters && event.queryStringParameters.month) || getCurrentMonthKey();
    const key = `month:${month}`;

    try {
        const store = getUsageStore();
        let snapshot = null;

        try {
            const val = await store.get(key, { type: 'json' });
            if (val && typeof val === 'object') snapshot = val;
            if (!snapshot && typeof val === 'string') snapshot = JSON.parse(val);
        } catch (e) {
            snapshot = null;
        }

        const enriched = snapshot ? enrichUsageSnapshot(snapshot) : makeEmptyUsage(month);
        return jsonResponse({
            statusCode: 200,
            corsHeaders,
            body: {
                ok: true,
                ...enriched
            }
        });
    } catch (error) {
        return jsonResponse({
            statusCode: 500,
            corsHeaders,
            body: {
                error: 'Could not read OCR usage counters',
                details: error && error.message ? error.message : 'unknown_error'
            }
        });
    }
};
