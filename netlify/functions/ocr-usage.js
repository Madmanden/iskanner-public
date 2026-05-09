const crypto = require('crypto');

const CORS_HEADERS_BASE = {
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
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

    if (Array.isArray(allowedOrigins) && allowedOrigins.includes(origin)) {
        return true;
    }

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

function getTokenSecret() {
    return process.env.AUTH_TOKEN_SECRET || 'default-secret-change-in-production';
}

function verifyToken(token) {
    if (!token || typeof token !== 'string') return null;

    const parts = token.split('.');
    if (parts.length !== 2) return null;

    const [payloadBase64, signature] = parts;
    const secret = getTokenSecret();

    const hmac = crypto.createHmac('sha256', secret);
    const payload = Buffer.from(payloadBase64, 'base64url').toString('utf8');
    hmac.update(payload);
    const expectedSignature = hmac.digest('base64url');

    if (signature !== expectedSignature) return null;

    try {
        const data = JSON.parse(payload);
        if (!data.exp || Date.now() > data.exp) return null;
        return data;
    } catch {
        return null;
    }
}

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
    const blobs = require('@netlify/blobs');
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

exports.handler = async (event) => {
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
    if (!verifyToken(token)) {
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
