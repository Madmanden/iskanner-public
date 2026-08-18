// Shared utility functions for Instrument Scanner
// This module centralizes common utility functions used across the app
import partsDatabase from '../parts-database.js';

import {
    JPEG_QUALITY,
    OCR_CROP_Y_BIAS_RATIO,
    OCR_PREPROCESSING_PROFILES,
    OCR_PREPROCESSING_PROFILE,
    VOICE_CONFIDENCE_THRESHOLD,
    VOICE_TIMEOUT_MS,
    VOICE_RESULT_DISPLAY_MS
} from './config.js';

// ---------------------------------------------------------------------------
// Parts database loading — prefer the generated parts-database.json (fetched
// with no-store so part updates reach devices immediately), fall back to
// window.partsDatabase (tests / external overrides), then to the bundled
// parts-database.js import (offline first paint).
// ---------------------------------------------------------------------------
const PARTS_DATABASE_JSON_PATH = '/parts-database.json';
let jsonPartsDatabase = null;
let jsonPartsDatabasePromise = null;

/**
 * Load the parts database from the generated JSON file. Cached; safe to call
 * multiple times. Resolves to the object or null if unavailable.
 * @returns {Promise<object|null>}
 */
export function loadPartsDatabaseJson() {
    if (jsonPartsDatabasePromise) return jsonPartsDatabasePromise;

    if (typeof fetch !== 'function' || typeof window === 'undefined') {
        jsonPartsDatabasePromise = Promise.resolve(null);
        return jsonPartsDatabasePromise;
    }

    jsonPartsDatabasePromise = (async () => {
        try {
            const res = await fetch(PARTS_DATABASE_JSON_PATH, { cache: 'no-store' });
            if (!res.ok) return null;
            const data = await res.json();
            if (data && typeof data === 'object' && Object.keys(data).length > 0) {
                jsonPartsDatabase = data;
                return data;
            }
            return null;
        } catch (e) {
            return null;
        }
    })();

    return jsonPartsDatabasePromise;
}

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
 * Escape HTML to prevent XSS.
 * Escapes quotes as well so the result is safe in attribute values
 * (e.g. data-part="..."), not just in element content.
 */
export function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
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

/**
 * Check whether verbose debug logging is enabled in the browser.
 * Activated via URL params or localStorage so production stays quiet by default.
 */
export function isDebugLoggingEnabled() {
    try {
        if (typeof window === 'undefined') return false;

        const search = String(window.location?.search || '');
        if (typeof URLSearchParams === 'function') {
            const params = new URLSearchParams(search);
            if (params.get('debug') === '1') return true;
            if (params.get('debugLogs') === '1') return true;
            if (params.get('ocrDebug') === '1') return true;
        }

        const storage = window.localStorage;
        if (!storage) return false;
        return storage.getItem('debugLogs') === '1' || storage.getItem('ocrDebug') === '1';
    } catch (e) {
        return false;
    }
}

/**
 * Write a log line only when debug logging is enabled.
 */
export function debugLog(...args) {
    if (!isDebugLoggingEnabled()) return;
    console.log(...args);
}

// ============================================================================
// OCR-related constants and thresholds
// Documented magic numbers for maintainability
// Values that are tunable per-deployment live in config.js and are re-exposed
// here so there is a single source of truth.
// ============================================================================

const activePreprocessing =
    (OCR_PREPROCESSING_PROFILES && OCR_PREPROCESSING_PROFILES[OCR_PREPROCESSING_PROFILE]) ||
    (OCR_PREPROCESSING_PROFILES && OCR_PREPROCESSING_PROFILES.default) ||
    { contrastFactor: 1.4, brightnessOffset: 10 };

export const OCR = {
    SHARPNESS_MIN_THRESHOLD: 10,
    SHARPNESS_EARLY_EXIT: 200,
    CONTRAST_FACTOR: activePreprocessing.contrastFactor,
    BRIGHTNESS_OFFSET: activePreprocessing.brightnessOffset,
    GAMMA_CORRECTION: 0.85,
    SHARPEN_AMOUNT_ANDROID: 0.15,
    SHARPEN_AMOUNT_DEFAULT: 0.30,
    CROP_Y_BIAS: OCR_CROP_Y_BIAS_RATIO,
    CROP_INNER_PADDING: 0.08,
    SCORE_MATCHES_FORMAT: 10,
    SCORE_HAS_DIGIT: 2,
    SCORE_LENGTH_VALID: 1,
    SCORE_AMBIGUOUS_CHAR_PENALTY: 2,
    SCORE_DATABASE_BONUS: 100,
    MIN_DISPLAY_SCORE: 50,
    FUZZY_MAX_DISTANCE: 3,
    FUZZY_PREFIX_LENGTH: 2,
    JPEG_QUALITY_DEFAULT: JPEG_QUALITY,
    JPEG_MIN_QUALITY: 0.35,
    JPEG_QUALITY_STEP: 0.07,
    JPEG_MAX_ATTEMPTS: 10,
    OCR_TIMEOUT_MS: 5000,
    SCAN_TIMEOUT_MS: 30000,
    CAMERA_SETTLE_MAX_WAIT_MS: 450,
    CAMERA_SETTLE_POLL_MS: 80,
    CAMERA_SETTLE_STABLE_SAMPLES: 2,
};

export const VOICE = {
    CONFIDENCE_THRESHOLD: VOICE_CONFIDENCE_THRESHOLD,
    TIMEOUT_MS: VOICE_TIMEOUT_MS,
    RESULT_DISPLAY_MS: VOICE_RESULT_DISPLAY_MS,
};

export const AUTH = {
    TOKEN_VALIDITY_MS: 30 * 24 * 60 * 60 * 1000,
    SESSION_WARN_DAYS: 3,
};

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
            curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
            if (curr[j] < rowMin) rowMin = curr[j];
        }
        if (rowMin > maxDistance) return null;
        for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
    }

    return prev[b.length] <= maxDistance ? prev[b.length] : null;
}

function getPartsDb() {
    if (jsonPartsDatabase && typeof jsonPartsDatabase === 'object') return jsonPartsDatabase;
    try {
        if (typeof window !== 'undefined') {
            const runtimeDb = window.partsDatabase;
            if (runtimeDb && typeof runtimeDb === 'object' && Object.keys(runtimeDb).length > 0) return runtimeDb;
        }
    } catch (e) {}
    return partsDatabase && typeof partsDatabase === 'object' ? partsDatabase : null;
}

export function hasPartsDatabase() {
    const db = getPartsDb();
    return !!(db && Object.keys(db).length > 0);
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

    if (prefix) {
        for (const k of keys) {
            if (!k || !k.startsWith(prefix)) continue;
            if (Math.abs(k.length - needle.length) > maxDistance) continue;
            const d = levenshteinDistanceMax(needle, k, maxDistance);
            if (d === null) continue;
            if (bestDistance === null || d < bestDistance) {
                bestDistance = d;
                bestKey = k;
                if (bestDistance === 0) break;
            }
        }
        if (bestDistance !== null && bestDistance <= 1) return bestKey;
    }

    for (const k of keys) {
        if (!k) continue;
        if (prefix && k.startsWith(prefix)) continue;
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
    for (const key of Object.keys(db)) {
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
    for (const key of Object.keys(db)) {
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
    if (db[needle]) return [{ partNumber: needle, location: db[needle], distance: 0 }];
    const matches = [];
    for (const k of Object.keys(db)) {
        if (!k || Math.abs(k.length - needle.length) > maxDistance) continue;
        const d = levenshteinDistanceMax(needle, k, maxDistance);
        if (d !== null) matches.push({ partNumber: k, location: db[k], distance: d });
    }
    matches.sort((a, b) => a.distance !== b.distance ? a.distance - b.distance : a.partNumber.localeCompare(b.partNumber));
    return matches.slice(0, maxResults);
}

function normalizeSearchText(value) { return (value || '').trim().toUpperCase(); }
function compactSearchText(value) { return normalizeSearchText(value).replace(/[^A-Z0-9]/g, ''); }
function tokenizeSearchText(value) {
    return normalizeSearchText(value).split(/[^A-Z0-9]+/).map(t => t.trim()).filter(Boolean);
}
function isFuzzyTokenMatch(queryToken, partToken) {
    if (!queryToken || !partToken) return false;
    if (partToken.includes(queryToken) || queryToken.includes(partToken)) return true;
    if (queryToken.length >= 4 && partToken.length >= 4 && Math.abs(queryToken.length - partToken.length) <= 1) {
        return levenshteinDistanceMax(queryToken, partToken, 1) !== null;
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
        if (upperPart.includes(cleaned)) { score += 30; hasAnySignal = true; }
        if (upperPart.startsWith(cleaned)) { score += 18; hasAnySignal = true; }
        if (compactNeedle && compactPart.includes(compactNeedle)) { score += 25; hasAnySignal = true; }
        let matchedTokens = 0;
        let strictTokenMiss = false;
        for (const token of queryTokens) {
            const tokenMatched = partTokens.some(pt => isFuzzyTokenMatch(token, pt));
            if (tokenMatched) matchedTokens += 1;
            else strictTokenMiss = true;
        }
        if (queryTokens.length > 0 && matchedTokens > 0) { score += matchedTokens * 15; hasAnySignal = true; }
        if (queryTokens.length > 1 && strictTokenMiss && matchedTokens === 0) continue;
        if (queryTokens.length > 1 && strictTokenMiss && matchedTokens > 0) score -= (queryTokens.length - matchedTokens) * 4;
        if (compactNeedle && compactNeedle.length >= 4) {
            const allowedDistance = compactNeedle.length >= 5 ? 2 : 1;
            const distance = levenshteinDistanceMax(compactNeedle, compactPart, allowedDistance);
            if (distance !== null) { score += 16 - (distance * 5); hasAnySignal = true; }
        }
        if (!hasAnySignal || score <= 0) continue;
        matches.push({ partNumber, location, score });
    }
    matches.sort((a, b) => a.score !== b.score ? b.score - a.score : a.partNumber.localeCompare(b.partNumber));
    return matches.slice(0, maxResults);
}

export function smartSearch(input, maxResults = 10) {
    const cleaned = normalizeSearchText(input);
    if (!cleaned) return { exactMatch: null, results: [], strategy: 'empty' };
    const safeMaxResults = Math.max(1, maxResults);
    const queryTokens = tokenizeSearchText(cleaned);
    const exactLocation = lookupLocation(cleaned);
    if (exactLocation) return { exactMatch: { partNumber: cleaned, location: exactLocation }, results: [], strategy: 'exact' };

    const isShortQuery = cleaned.length >= 2 && cleaned.length <= 4;
    const tryPrefixSearch = () => {
        const prefixMatches = findPartsByPrefix(cleaned, safeMaxResults);
        if (prefixMatches.length === 0) return null;
        return { exactMatch: null, results: prefixMatches.map(m => ({ ...m, matchType: 'prefix' })), strategy: 'prefix' };
    };

    if (isShortQuery && queryTokens.length <= 1) {
        const prefixResult = tryPrefixSearch();
        if (prefixResult) return prefixResult;
    }
    const flexibleMatches = findFlexibleMatches(cleaned, safeMaxResults);
    if (flexibleMatches.length > 0) return { exactMatch: null, results: flexibleMatches.map(m => ({ ...m, matchType: 'fuzzy' })), strategy: 'fuzzy' };
    if (isShortQuery && queryTokens.length > 1) {
        const prefixResult = tryPrefixSearch();
        if (prefixResult) return prefixResult;
    }
    const substringMatches = findPartsContaining(cleaned, safeMaxResults);
    if (substringMatches.length > 0) return { exactMatch: null, results: substringMatches.map(m => ({ ...m, matchType: 'substring' })), strategy: 'substring' };
    return { exactMatch: null, results: [], strategy: 'none' };
}
