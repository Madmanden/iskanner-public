// Shared utility functions for Instrument Scanner
// This module centralizes common utility functions used across the app

/**
 * Check if the current browser is on an Android device
 * Used for device-specific optimizations (camera, image processing)
 */
export function isAndroid() {
    try {
        return /android/i.test(navigator.userAgent || '');
    } catch (e) {
        return false;
    }
}

/**
 * Check if the current browser is on iOS
 */
export function isIOS() {
    try {
        return /iPad|iPhone|iPod/.test(navigator.userAgent || '');
    } catch (e) {
        return false;
    }
}

/**
 * Check if the browser supports the Camera API
 */
export function supportsCamera() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

/**
 * Check if the browser supports Speech Recognition
 */
export function supportsSpeechRecognition() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

/**
 * Escape HTML to prevent XSS
 */
export function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Sleep for a specified number of milliseconds
 */
export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Clamp a number between min and max
 */
export function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

// ============================================================================
// OCR-related constants and thresholds
// Documented magic numbers for maintainability
// ============================================================================

export const OCR = {
    // Sharpness detection (Laplacian variance threshold)
    // Images with variance < 10 are considered too blurry for reliable OCR
    SHARPNESS_MIN_THRESHOLD: 10,
    
    // Early exit sharpness threshold (skip preprocessing if image is very sharp)
    SHARPNESS_EARLY_EXIT: 200,
    
    // Preprocessing parameters
    CONTRAST_FACTOR: 1.4,
    BRIGHTNESS_OFFSET: 10,
    GAMMA_CORRECTION: 0.85,
    
    // Sharpening amount (fraction of edge to add back)
    SHARPEN_AMOUNT_ANDROID: 0.15,
    SHARPEN_AMOUNT_DEFAULT: 0.30,
    
    // Crop adjustment (0 keeps crop centered on the visible overlay)
    CROP_Y_BIAS: 0,
    
    // Inner padding around crop area (8% on each side)
    CROP_INNER_PADDING: 0.08,
    
    // Part number scoring thresholds
    SCORE_MATCHES_FORMAT: 10,
    SCORE_HAS_DIGIT: 2,
    SCORE_LENGTH_VALID: 1,
    SCORE_AMBIGUOUS_CHAR_PENALTY: 2,
    SCORE_DATABASE_BONUS: 100,
    
    // Minimum score to display a result (without database match)
    // Calculated: format(10) + digit(2) + length(1) - 0 ambiguous = 13
    // But we require DB match or score >= 50 for confidence
    MIN_DISPLAY_SCORE: 50,
    
    // Fuzzy matching
    FUZZY_MAX_DISTANCE: 3,
    FUZZY_PREFIX_LENGTH: 2,
    
    // JPEG encoding
    JPEG_QUALITY_DEFAULT: 0.85,
    JPEG_QUALITY_LOW_BANDWIDTH: 0.75,
    JPEG_MIN_QUALITY: 0.35,
    JPEG_QUALITY_STEP: 0.07,
    JPEG_MAX_ATTEMPTS: 10,
    
    // Timeout values (ms)
    OCR_TIMEOUT_MS: 5000,
    SCAN_TIMEOUT_MS: 30000,
    
    // Camera settling
    CAMERA_SETTLE_MAX_WAIT_MS: 450,
    CAMERA_SETTLE_POLL_MS: 80,
    CAMERA_SETTLE_STABLE_SAMPLES: 2,
};

// Voice recognition constants
export const VOICE = {
    // Minimum confidence threshold (0-1)
    CONFIDENCE_THRESHOLD: 0.7,
    
    // Timeout for voice recognition (ms)
    TIMEOUT_MS: 10000,
    
    // Result display duration (ms)
    RESULT_DISPLAY_MS: 3000,
};

// Auth constants
export const AUTH = {
    // Token validity (30 days)
    TOKEN_VALIDITY_MS: 30 * 24 * 60 * 60 * 1000,
    
    // Warn when session expires in N days or less
    SESSION_WARN_DAYS: 3,
};

// ============================================================================
// Search / database helpers (required by app.js, ui.js, voice.js)
// ============================================================================

export function isLikelyPartNumberFormat(value) {
    const v = (value || '').trim().toUpperCase();
    if (!v) return false;
    if (/^[A-Z]{2}\d{3}[A-Z]$/.test(v)) return true;
    if (/^\d{2}\.\d{2}\.\d{2}$/.test(v)) return true;
    if (/^\d{3}\.\d{3}$/.test(v)) return true;
    if (/^[A-Z0-9.\-]+$/.test(v) && /\d/.test(v)) return true;
    return false;
}

export function levenshteinDistanceMax(a, b, maxDistance) {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > maxDistance) return null;
    if (a.length === 0) return b.length <= maxDistance ? b.length : null;
    if (b.length === 0) return a.length <= maxDistance ? a.length : null;

    const prev = new Array(b.length + 1);
    const curr = new Array(b.length + 1);

    for (let j = 0; j <= b.length; j++) prev[j] = j;

    for (let i = 1; i <= a.length; i++) {
        curr[0] = i;
        let rowMin = curr[0];

        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            const del = prev[j] + 1;
            const ins = curr[j - 1] + 1;
            const sub = prev[j - 1] + cost;
            curr[j] = Math.min(del, ins, sub);
            if (curr[j] < rowMin) rowMin = curr[j];
        }

        if (rowMin > maxDistance) return null;
        for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
    }

    return prev[b.length] <= maxDistance ? prev[b.length] : null;
}

function getPartsDb() {
    if (typeof partsDatabase === 'object' && partsDatabase !== null) return partsDatabase;
    if (typeof window !== 'undefined' && typeof window.partsDatabase === 'object' && window.partsDatabase !== null) return window.partsDatabase;
    return null;
}

export function findClosestPartNumber(input, maxDistance = 3) {
    const db = getPartsDb();
    const needle = (input || '').trim().toUpperCase();
    if (!needle || !db) return null;
    if (db[needle]) return needle;

    const keys = Object.keys(db);
    const prefix = /^[A-Z]{2}/.test(needle) ? needle.slice(0, 2) : null;

    let bestKey = null;
    let bestDistance = null;

    for (const k of keys) {
        if (!k) continue;
        if (prefix && !k.startsWith(prefix)) continue;
        if (Math.abs(k.length - needle.length) > maxDistance) continue;

        const d = levenshteinDistanceMax(needle, k, maxDistance);
        if (d === null) continue;
        if (bestDistance === null || d < bestDistance) {
            bestDistance = d;
            bestKey = k;
            if (bestDistance === 0) break;
        }
    }

    return bestKey;
}

export function setButtonContents(button, icon, label) {
    const iconEl = button?.querySelector?.('.btn-icon');
    const labelEl = button?.querySelector?.('.btn-label');
    if (iconEl) iconEl.textContent = icon;
    if (labelEl) labelEl.textContent = label;
}

export function lookupLocation(partNumber) {
    const db = getPartsDb();
    return db ? db[partNumber] || null : null;
}

export function findPartsByPrefix(prefix, maxResults = 20) {
    const db = getPartsDb();
    if (!db || !prefix) return [];

    const needle = prefix.trim().toUpperCase();
    if (!needle) return [];

    const matches = [];
    const keys = Object.keys(db);

    for (const key of keys) {
        if (key.startsWith(needle)) {
            matches.push({ partNumber: key, location: db[key] });
            if (matches.length >= maxResults) break;
        }
    }

    matches.sort((a, b) => a.partNumber.localeCompare(b.partNumber));
    return matches;
}

export function findPartsContaining(searchTerm, maxResults = 20) {
    const db = getPartsDb();
    if (!db || !searchTerm) return [];

    const needle = searchTerm.trim().toUpperCase();
    if (!needle) return [];

    const matches = [];
    const keys = Object.keys(db);

    for (const key of keys) {
        if (key.includes(needle)) {
            matches.push({ partNumber: key, location: db[key] });
            if (matches.length >= maxResults) break;
        }
    }

    matches.sort((a, b) => a.partNumber.localeCompare(b.partNumber));
    return matches;
}

export function findMultipleMatches(input, maxResults = 10, maxDistance = 3) {
    const db = getPartsDb();
    const needle = (input || '').trim().toUpperCase();
    if (!needle || !db) return [];

    if (db[needle]) {
        return [{ partNumber: needle, location: db[needle], distance: 0 }];
    }

    const keys = Object.keys(db);
    const prefix = /^[A-Z]{2}/.test(needle) ? needle.slice(0, 2) : null;
    const matches = [];

    for (const k of keys) {
        if (!k) continue;
        if (prefix && !k.startsWith(prefix)) continue;
        if (Math.abs(k.length - needle.length) > maxDistance) continue;

        const d = levenshteinDistanceMax(needle, k, maxDistance);
        if (d !== null) {
            matches.push({ partNumber: k, location: db[k], distance: d });
        }
    }

    matches.sort((a, b) => {
        if (a.distance !== b.distance) return a.distance - b.distance;
        return a.partNumber.localeCompare(b.partNumber);
    });

    return matches.slice(0, maxResults);
}

function normalizeSearchText(value) {
    return (value || '').trim().toUpperCase();
}

function compactSearchText(value) {
    return normalizeSearchText(value).replace(/[^A-Z0-9]/g, '');
}

function tokenizeSearchText(value) {
    return normalizeSearchText(value)
        .split(/[^A-Z0-9]+/)
        .map(t => t.trim())
        .filter(Boolean);
}

function isFuzzyTokenMatch(queryToken, partToken) {
    if (!queryToken || !partToken) return false;
    if (partToken.includes(queryToken) || queryToken.includes(partToken)) return true;

    if (queryToken.length >= 4 && partToken.length >= 4 && Math.abs(queryToken.length - partToken.length) <= 1) {
        const distance = levenshteinDistanceMax(queryToken, partToken, 1);
        return distance !== null;
    }

    return false;
}

function findFlexibleMatches(input, maxResults = 10) {
    const db = getPartsDb();
    if (!db) return [];

    const cleaned = normalizeSearchText(input);
    const compactNeedle = compactSearchText(cleaned);
    const queryTokens = tokenizeSearchText(cleaned);
    if (!cleaned) return [];

    const matches = [];

    for (const partNumber in db) {
        if (!Object.prototype.hasOwnProperty.call(db, partNumber)) continue;
        const location = db[partNumber];
        const upperPart = normalizeSearchText(partNumber);
        const compactPart = compactSearchText(partNumber);
        const partTokens = tokenizeSearchText(partNumber);

        let score = 0;
        let hasAnySignal = false;

        if (upperPart.includes(cleaned)) {
            score += 30;
            hasAnySignal = true;
        }

        if (upperPart.startsWith(cleaned)) {
            score += 18;
            hasAnySignal = true;
        }

        if (compactNeedle && compactPart.includes(compactNeedle)) {
            score += 25;
            hasAnySignal = true;
        }

        let matchedTokens = 0;
        let strictTokenMiss = false;
        for (const token of queryTokens) {
            const tokenMatched = partTokens.some(pt => isFuzzyTokenMatch(token, pt));
            if (tokenMatched) {
                matchedTokens += 1;
            } else {
                strictTokenMiss = true;
            }
        }

        if (queryTokens.length > 0 && matchedTokens > 0) {
            score += matchedTokens * 15;
            hasAnySignal = true;
        }

        if (queryTokens.length > 1 && strictTokenMiss && matchedTokens === 0) {
            continue;
        }

        if (queryTokens.length > 1 && strictTokenMiss && matchedTokens > 0) {
            score -= (queryTokens.length - matchedTokens) * 4;
        }

        if (compactNeedle && compactNeedle.length >= 4) {
            const allowedDistance = compactNeedle.length >= 6 ? 2 : 1;
            const distance = levenshteinDistanceMax(compactNeedle, compactPart, allowedDistance);
            if (distance !== null) {
                score += 16 - (distance * 5);
                hasAnySignal = true;
            }
        }

        if (!hasAnySignal || score <= 0) continue;

        matches.push({ partNumber, location, score });
    }

    matches.sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score;
        return a.partNumber.localeCompare(b.partNumber);
    });

    return matches.slice(0, maxResults);
}

export function smartSearch(input, maxResults = 10) {
    const cleaned = normalizeSearchText(input);
    if (!cleaned) return { exactMatch: null, results: [], strategy: 'empty' };
    const safeMaxResults = Math.max(1, maxResults);
    const queryTokens = tokenizeSearchText(cleaned);

    const exactLocation = lookupLocation(cleaned);
    if (exactLocation) {
        return {
            exactMatch: { partNumber: cleaned, location: exactLocation },
            results: [],
            strategy: 'exact'
        };
    }

    if (cleaned.length >= 2 && cleaned.length <= 4 && queryTokens.length <= 1) {
        const prefixMatches = findPartsByPrefix(cleaned, safeMaxResults);
        if (prefixMatches.length > 0) {
            return {
                exactMatch: null,
                results: prefixMatches.map(m => ({ ...m, matchType: 'prefix' })),
                strategy: 'prefix'
            };
        }
    }

    const flexibleMatches = findFlexibleMatches(cleaned, safeMaxResults);
    if (flexibleMatches.length > 0) {
        return {
            exactMatch: null,
            results: flexibleMatches.map(m => ({ ...m, matchType: 'fuzzy' })),
            strategy: 'fuzzy'
        };
    }

    if (cleaned.length >= 2 && cleaned.length <= 4) {
        const prefixMatches = findPartsByPrefix(cleaned, safeMaxResults);
        if (prefixMatches.length > 0) {
            return {
                exactMatch: null,
                results: prefixMatches.map(m => ({ ...m, matchType: 'prefix' })),
                strategy: 'prefix'
            };
        }
    }

    const substringMatches = findPartsContaining(cleaned, safeMaxResults);
    if (substringMatches.length > 0) {
        return {
            exactMatch: null,
            results: substringMatches.map(m => ({ ...m, matchType: 'substring' })),
            strategy: 'substring'
        };
    }

    return { exactMatch: null, results: [], strategy: 'none' };
}
