import crypto from 'crypto';

export const TOKEN_VALIDITY_MS = 30 * 24 * 60 * 60 * 1000;

export const CORS_HEADERS_BASE = {
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Cache-Control': 'no-store',
    'Vary': 'Origin'
};

export function getHeader(headers, headerName) {
    if (!headers || !headerName) return undefined;
    const target = String(headerName).toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
        if (String(key).toLowerCase() === target) return value;
    }
    return undefined;
}

export function getAllowedOrigins() {
    const origins = new Set();
    const raw = process.env.ALLOWED_ORIGINS;
    if (raw) {
        for (const origin of raw.split(',')) {
            const trimmed = origin.trim();
            if (trimmed) origins.add(trimmed);
        }
    }

    const netlifyOrigins = [process.env.URL, process.env.DEPLOY_PRIME_URL, process.env.DEPLOY_URL];
    for (const origin of netlifyOrigins) {
        if (origin && String(origin).trim()) origins.add(String(origin).trim());
    }

    return Array.from(origins);
}

export function isAllowedOrigin(origin, allowedOrigins, host) {
    if (!origin) return false;

    const normalizedHost = host ? String(host).trim().toLowerCase() : '';
    if (normalizedHost) {
        const originLower = String(origin).trim().toLowerCase();
        if (originLower === `https://${normalizedHost}` || originLower === `http://${normalizedHost}`) {
            return true;
        }
    }

    if (Array.isArray(allowedOrigins) && allowedOrigins.includes(origin)) return true;

    return /^https:\/\/[a-z0-9-]+--iskanner\.netlify\.app$/.test(origin) ||
        /^https:\/\/iskanner\.netlify\.app$/.test(origin);
}

export function buildCorsHeaders(origin, allowedOrigins, host) {
    if (origin && isAllowedOrigin(origin, allowedOrigins, host)) {
        return { ...CORS_HEADERS_BASE, 'Access-Control-Allow-Origin': origin };
    }

    if (!origin && Array.isArray(allowedOrigins) && allowedOrigins.length === 0) {
        return { ...CORS_HEADERS_BASE, 'Access-Control-Allow-Origin': '*' };
    }

    return { ...CORS_HEADERS_BASE };
}

export function jsonResponse({ statusCode, corsHeaders, body }) {
    return {
        statusCode,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    };
}

export function getTokenSecret() {
    const secret = String(process.env.AUTH_TOKEN_SECRET || '').trim();
    return secret || null;
}

export function requireTokenSecret() {
    const secret = getTokenSecret();
    if (!secret) throw new Error('AUTH_TOKEN_SECRET is not set');
    return secret;
}

export function timingSafeEqualString(left, right) {
    const leftBuffer = Buffer.from(String(left || ''), 'utf8');
    const rightBuffer = Buffer.from(String(right || ''), 'utf8');
    if (leftBuffer.length !== rightBuffer.length) return false;
    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function createToken({ expiresAt, secret } = {}) {
    const tokenSecret = secret || requireTokenSecret();
    const expiry = Number.isFinite(expiresAt) ? expiresAt : Date.now() + TOKEN_VALIDITY_MS;
    const payload = JSON.stringify({ exp: expiry });
    const hmac = crypto.createHmac('sha256', tokenSecret);
    hmac.update(payload);
    const signature = hmac.digest('base64url');
    const payloadBase64 = Buffer.from(payload).toString('base64url');
    return `${payloadBase64}.${signature}`;
}

export function verifyToken(token, secret = getTokenSecret()) {
    if (!secret || !token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [payloadBase64, signature] = parts;
    if (!payloadBase64 || !signature) return null;

    let payload;
    try { payload = Buffer.from(payloadBase64, 'base64url').toString('utf8'); }
    catch { return null; }

    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(payload);
    const expectedSignature = hmac.digest('base64url');
    if (!timingSafeEqualString(signature, expectedSignature)) return null;

    try {
        const data = JSON.parse(payload);
        if (!data.exp || Date.now() > data.exp) return null;
        return data;
    } catch {
        return null;
    }
}
