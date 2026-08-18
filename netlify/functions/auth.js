// Authentication function for shared password login
// Provides JWT-like tokens for 30-day sessions

import {
    TOKEN_VALIDITY_MS,
    getHeader,
    getAllowedOrigins,
    buildCorsHeaders,
    jsonResponse,
    getTokenSecret,
    createToken,
    timingSafeEqualString
} from './lib/shared.js';

function getSharedPassword() {
    return String(process.env.AUTH_PASSWORD || '').trim();
}

export const handler = async (event) => {
    const allowedOrigins = getAllowedOrigins();
    const origin = getHeader(event.headers, 'origin');
    const host = getHeader(event.headers, 'host');
    const corsHeaders = buildCorsHeaders(origin, allowedOrigins, host);

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: corsHeaders, body: '' };
    }

    const tokenSecret = getTokenSecret();
    const sharedPassword = getSharedPassword();
    if (!sharedPassword || !tokenSecret) {
        return jsonResponse({
            statusCode: 500,
            corsHeaders,
            body: {
                error: 'Authentication is not configured',
                details: !sharedPassword
                    ? 'Set AUTH_PASSWORD in your environment.'
                    : 'Set AUTH_TOKEN_SECRET in your environment.'
            }
        });
    }

    if (event.httpMethod !== 'POST') {
        return jsonResponse({ statusCode: 405, corsHeaders, body: { error: 'Method not allowed' } });
    }

    try {
        const contentType = String(getHeader(event.headers, 'content-type') || '').toLowerCase();
        if (!contentType.includes('application/json')) {
            return jsonResponse({ statusCode: 415, corsHeaders, body: { error: 'Unsupported Media Type. Use application/json.' } });
        }

        let payload;
        try {
            payload = JSON.parse(event.body || '');
        } catch {
            return jsonResponse({ statusCode: 400, corsHeaders, body: { error: 'Invalid JSON body' } });
        }

        const { password } = payload;
        if (!password || typeof password !== 'string') {
            return jsonResponse({ statusCode: 400, corsHeaders, body: { error: 'Password is required' } });
        }

        if (!timingSafeEqualString(password, sharedPassword)) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            return jsonResponse({ statusCode: 401, corsHeaders, body: { error: 'Invalid password' } });
        }

        const token = createToken({ secret: tokenSecret });
        return jsonResponse({
            statusCode: 200,
            corsHeaders,
            body: { token, expiresIn: TOKEN_VALIDITY_MS, message: 'Authentication successful' }
        });
    } catch (error) {
        console.error('Auth function error:', error);
        return jsonResponse({ statusCode: 500, corsHeaders, body: { error: 'Internal server error' } });
    }
};
