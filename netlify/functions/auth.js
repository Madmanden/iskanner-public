// Authentication function for shared password login
// Provides JWT-like tokens for 30-day sessions

const crypto = require('crypto');

// Password for accessing the app, provided via environment configuration.
// Generate a strong value with:
// node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
const SHARED_PASSWORD = String(process.env.AUTH_PASSWORD || '').trim();
const TOKEN_VALIDITY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const CORS_HEADERS_BASE = {
    'Access-Control-Allow-Headers': 'Content-Type',
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

    if (Array.isArray(allowedOrigins) && allowedOrigins.includes(origin)) {
        return true;
    }

    // Allow any Netlify subdomain for this project
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

// Generate a token secret from environment or use a default (should be set in production)
function getTokenSecret() {
    return process.env.AUTH_TOKEN_SECRET || 'default-secret-change-in-production';
}

// Create a signed token
function createToken() {
    const expiresAt = Date.now() + TOKEN_VALIDITY_MS;
    const payload = JSON.stringify({ exp: expiresAt });
    const secret = getTokenSecret();

    // Create HMAC signature
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(payload);
    const signature = hmac.digest('base64url');

    // Token format: base64(payload).signature
    const payloadBase64 = Buffer.from(payload).toString('base64url');
    return `${payloadBase64}.${signature}`;
}

// Verify a token (used by other functions)
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
    const allowedOrigins = getAllowedOrigins();
    const origin = getHeader(event.headers, 'origin');
    const host = getHeader(event.headers, 'host');
    const corsHeaders = buildCorsHeaders(origin, allowedOrigins, host);

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

        const { password } = payload;

        if (!password || typeof password !== 'string') {
            return jsonResponse({
                statusCode: 400,
                corsHeaders,
                body: { error: 'Password is required' }
            });
        }

        if (!SHARED_PASSWORD) {
            console.error('[Auth] ERROR: AUTH_PASSWORD environment variable is not set!');
            return jsonResponse({
                statusCode: 500,
                corsHeaders,
                body: { error: 'Authentication is not configured on this deployment' }
            });
        }

        // Validate password
        if (password !== SHARED_PASSWORD) {
            // Add a small delay to prevent brute force
            await new Promise(resolve => setTimeout(resolve, 1000));
            return jsonResponse({
                statusCode: 401,
                corsHeaders,
                body: { error: 'Invalid password' }
            });
        }

        // Generate token
        const token = createToken();

        return jsonResponse({
            statusCode: 200,
            corsHeaders,
            body: {
                token,
                expiresIn: TOKEN_VALIDITY_MS,
                message: 'Authentication successful'
            }
        });

    } catch (error) {
        console.error('Auth function error:', error);
        return jsonResponse({
            statusCode: 500,
            corsHeaders,
            body: { error: 'Internal server error' }
        });
    }
};

// Export verifyToken for use by other functions
exports.verifyToken = verifyToken;
