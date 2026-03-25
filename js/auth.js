// Authentication module for managing login sessions

const AUTH_TOKEN_KEY = 'instrumentskanner_auth_token';
const AUTH_EXPIRY_KEY = 'instrumentskanner_auth_expiry';

/**
 * Check if user is currently authenticated
 * @returns {boolean}
 */
export function isAuthenticated() {
    const token = localStorage.getItem(AUTH_TOKEN_KEY);
    const expiry = localStorage.getItem(AUTH_EXPIRY_KEY);

    if (!token || !expiry) {
        return false;
    }

    // Check if token has expired
    if (Date.now() > parseInt(expiry, 10)) {
        clearAuth();
        return false;
    }

    return true;
}

/**
 * Get the current authentication token
 * @returns {string|null}
 */
export function getToken() {
    if (!isAuthenticated()) {
        return null;
    }
    return localStorage.getItem(AUTH_TOKEN_KEY);
}

/**
 * Attempt to log in with the provided password
 * @param {string} password
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function login(password) {
    try {
        console.log('[Auth] Attempting login...');
        const response = await fetch('/.netlify/functions/auth', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ password })
        });

        console.log('[Auth] Response status:', response.status);

        const data = await response.json();
        console.log('[Auth] Response data:', data);

        if (response.ok && data.token) {
            const expiryTime = Date.now() + data.expiresIn;
            localStorage.setItem(AUTH_TOKEN_KEY, data.token);
            localStorage.setItem(AUTH_EXPIRY_KEY, expiryTime.toString());

            console.log('[Auth] Login successful, token saved');
            return {
                success: true,
                message: data.message || 'Login successful'
            };
        } else {
            console.warn('[Auth] Login failed:', data.error || 'Unknown error');
            return {
                success: false,
                message: data.error || 'Login mislykkedes'
            };
        }
    } catch (error) {
        console.error('[Auth] Login network error:', error);
        return {
            success: false,
            message: 'Netværksfejl. Kører du "netlify dev"?'
        };
    }
}

/**
 * Log out and clear stored authentication data
 */
export function logout() {
    clearAuth();
}

/**
 * Clear authentication data from localStorage
 */
function clearAuth() {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_EXPIRY_KEY);
}

/**
 * Get remaining time until token expires (in milliseconds)
 * @returns {number}
 */
export function getTimeUntilExpiry() {
    const expiry = localStorage.getItem(AUTH_EXPIRY_KEY);
    if (!expiry) return 0;
    return Math.max(0, parseInt(expiry, 10) - Date.now());
}

/**
 * Get remaining days until token expires
 * @returns {number}
 */
export function getDaysUntilExpiry() {
    const ms = getTimeUntilExpiry();
    return Math.floor(ms / (1000 * 60 * 60 * 24));
}
