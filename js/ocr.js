// OCR API module
import { API_URL, JPEG_QUALITY, OVERLAY_FEEDBACK_MS, OCR_CROP_Y_BIAS_RATIO, OCR_ATTEMPTS, OCR_PREPROCESSING_PROFILES, OCR_PREPROCESSING_PROFILE } from './config.js';
import { updateStatus, displayResult, showError, setOverlaySuccess, setOverlayError, saveToHistory, clearOverlayFeedback } from './ui.js';
import { findClosestPartNumber, lookupLocation } from './utils.js';
import { getStream, getVideoTrack } from './camera.js';
import { getToken } from './auth.js';
import { isAndroid, OCR, sleep, clamp } from './utils.js';

// Image preprocessing constants
const PREPROCESS_TARGET_WIDTH = 640; // Optimal width for OCR
const DEFAULT_PREPROCESSING = { contrastFactor: 1.4, brightnessOffset: 10 };
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;

// ============================================================================
// OCR Result Caching with Perceptual Hashing
// ============================================================================

const ocrCache = new Map();
const OCR_CACHE_MAX_SIZE = 50;
const OCR_CACHE_TTL_MS = 30000; // 30 seconds

/**
 * Simple perceptual hash for image caching
 * Uses average hash algorithm for speed
 */
function computePerceptualHash(canvas) {
    if (!canvas) return null;
    
    const size = 8;
    const tmp = document.createElement('canvas');
    tmp.width = size;
    tmp.height = size;
    const tctx = tmp.getContext('2d', { willReadFrequently: true });
    if (!tctx) return null;
    
    tctx.drawImage(canvas, 0, 0, size, size);
    const imageData = tctx.getImageData(0, 0, size, size);
    const data = imageData.data;
    
    // Convert to grayscale and compute average
    let sum = 0;
    const pixels = [];
    for (let i = 0; i < data.length; i += 4) {
        const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        pixels.push(gray);
        sum += gray;
    }
    const avg = sum / pixels.length;
    
    // Compute hash: 1 if pixel > average, 0 otherwise
    let hash = '';
    for (const pixel of pixels) {
        hash += pixel > avg ? '1' : '0';
    }
    
    return hash;
}

/**
 * Get cached OCR result for an image
 */
function getCachedOcrResult(hash) {
    if (!hash) return null;
    const entry = ocrCache.get(hash);
    if (!entry) return null;
    
    // Check if expired
    if (Date.now() - entry.timestamp > OCR_CACHE_TTL_MS) {
        ocrCache.delete(hash);
        return null;
    }
    
    return entry.result;
}

/**
 * Cache an OCR result
 */
function cacheOcrResult(hash, result) {
    if (!hash || !result) return;
    
    // Evict oldest if at capacity
    if (ocrCache.size >= OCR_CACHE_MAX_SIZE) {
        let oldestKey = null;
        let oldestTime = Infinity;
        for (const [key, entry] of ocrCache.entries()) {
            if (entry.timestamp < oldestTime) {
                oldestTime = entry.timestamp;
                oldestKey = key;
            }
        }
        if (oldestKey) ocrCache.delete(oldestKey);
    }
    
    ocrCache.set(hash, {
        result,
        timestamp: Date.now()
    });
}

function isOcrDebugEnabled() {
    try {
        if (typeof window === 'undefined') return false;
        const params = new URLSearchParams(window.location.search || '');
        if (params.get('ocrDebug') === '1') return true;
        if (window.localStorage && window.localStorage.getItem('ocrDebug') === '1') return true;
        return false;
    } catch (e) {
        return false;
    }
}

const OCR_DEBUG_ENABLED = isOcrDebugEnabled();

function captureOcrDebugFrame(base64Image, meta) {
    if (!OCR_DEBUG_ENABLED || typeof window === 'undefined') return;
    try {
        const dataUrl = `data:image/jpeg;base64,${base64Image}`;
        const approxBytes = Math.floor((String(base64Image || '').length * 3) / 4);
        const entry = {
            at: new Date().toISOString(),
            approxBytes,
            dataUrl,
            ...(meta || {})
        };

        const shots = Array.isArray(window.__ocrDebugShots) ? window.__ocrDebugShots : [];
        shots.push(entry);
        while (shots.length > 6) shots.shift();

        window.__ocrDebugShots = shots;
        window.__lastOcrDebugImage = dataUrl;

        console.log('[OCR DEBUG] captured crop', {
            mode: entry.attemptMode || 'unknown',
            attemptIndex: entry.attemptIndex,
            approxBytes: entry.approxBytes,
            framesStored: shots.length,
            hint: 'window.open(window.__lastOcrDebugImage)'
        });
    } catch (e) {
        console.log('[OCR DEBUG] capture failed:', e && e.message ? e.message : e);
    }
}

function getPreprocessingSettings() {
    const profiles = OCR_PREPROCESSING_PROFILES || {};
    const key = OCR_PREPROCESSING_PROFILE || 'default';
    const selected = profiles[key];
    const fallback = profiles.default || DEFAULT_PREPROCESSING;
    return {
        contrastFactor: typeof (selected?.contrastFactor) === 'number' ? selected.contrastFactor : fallback.contrastFactor,
        brightnessOffset: typeof (selected?.brightnessOffset) === 'number' ? selected.brightnessOffset : fallback.brightnessOffset
    };
}

let overlayFeedbackTimeoutId = null;

let activeOcrController = null;
let activeScanToken = 0;

let lastOcrNetworkMs = 0;
let lastOcrNetworkCalls = 0;
let lastOcrPayloadBytes = 0;
let lastOcrModelUsed = null;
let lastOcrModelFallbackUsed = false;
let lastOcrProviderUsed = null;
let lastOcrProviderFallbackUsed = false;

// DOM elements
let videoEl = null;
let canvasEl = null;
let ctxEl = null;
let overlayEl = null;

function normalizeOcrPartNumber(value) {
    const raw = (value || '');
    const trimmed = String(raw).trim().toUpperCase();
    if (!trimmed) return null;

    // Remove whitespace and keep only characters we support in part numbers
    const compact = trimmed.replace(/\s+/g, '');
    const cleaned = compact.replace(/[^A-Z0-9.\-]/g, '');
    return cleaned || null;
}

function isExpired(startedAt, timeoutMs) {
    const now = (typeof performance !== 'undefined' && typeof performance.now === 'function')
        ? performance.now()
        : Date.now();
    return (now - startedAt) > timeoutMs;
}

function isLikelyPartNumber(value) {
    const v = String(value || '').trim().toUpperCase();
    if (!v) return false;
    if (v.length < 4) return false;
    if (v.length > 32) return false;
    if (!/[0-9]/.test(v)) return false;
    if (!/^[A-Z0-9.\-]+$/.test(v)) return false;
    return true;
}

function pickKnownSettings(settings) {
    if (!settings || typeof settings !== 'object') return {};
    const picked = {};

    const keys = [
        'focusDistance',
        'exposureTime',
        'exposureCompensation',
        'iso',
        'colorTemperature',
        'brightness',
        'contrast',
        'saturation',
        'sharpness',
        'whiteBalanceMode',
        'exposureMode',
        'focusMode'
    ];

    for (const key of keys) {
        const v = settings[key];
        if (v === undefined || v === null) continue;
        picked[key] = typeof v === 'number' ? Math.round(v * 1000) / 1000 : v;
    }

    return picked;
}

async function ensureContinuousFocusExposure(track) {
    if (!track) return;
    if (typeof track.getCapabilities !== 'function') return;
    if (typeof track.applyConstraints !== 'function') return;

    let caps = null;
    try {
        caps = track.getCapabilities();
    } catch (e) {
        caps = null;
    }

    const supportsFocusContinuous = caps && Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous');
    const supportsExposureContinuous = caps && Array.isArray(caps.exposureMode) && caps.exposureMode.includes('continuous');
    const supportsWbContinuous = caps && Array.isArray(caps.whiteBalanceMode) && caps.whiteBalanceMode.includes('continuous');

    if (!supportsFocusContinuous && !supportsExposureContinuous && !supportsWbContinuous) return;

    const advanced = [{}];
    if (supportsFocusContinuous) advanced[0].focusMode = 'continuous';
    if (supportsExposureContinuous) advanced[0].exposureMode = 'continuous';
    if (supportsWbContinuous) advanced[0].whiteBalanceMode = 'continuous';

    try {
        await track.applyConstraints({ advanced });
    } catch (e) {
        try {
            await track.applyConstraints(advanced[0]);
        } catch (e2) {
        }
    }
}

async function waitForCameraSettingsToSettle(track, options = {}) {
    if (!track) return;
    if (typeof track.getSettings !== 'function') return;

    const maxWaitMs = Number.isFinite(options.maxWaitMs) ? options.maxWaitMs : OCR.CAMERA_SETTLE_MAX_WAIT_MS;
    const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : OCR.CAMERA_SETTLE_POLL_MS;
    const stableSamplesRequired = Number.isFinite(options.stableSamplesRequired) ? options.stableSamplesRequired : OCR.CAMERA_SETTLE_STABLE_SAMPLES;

    const startedAt = Date.now();
    let last = null;
    let stableCount = 0;

    while (Date.now() - startedAt < maxWaitMs) {
        let s = null;
        try {
            s = track.getSettings();
        } catch (e) {
            return;
        }

        const picked = pickKnownSettings(s);
        const signature = JSON.stringify(picked);

        if (last !== null && signature === last) {
            stableCount += 1;
            if (stableCount >= stableSamplesRequired) return;
        } else {
            stableCount = 0;
            last = signature;
        }

        await sleep(pollMs);
    }
}

function varianceOfLaplacianFromImageData(imageData, width, height) {
    const data = imageData.data;
    if (!data || width < 3 || height < 3) return 0;

    const step = Math.max(1, Math.round(Math.min(width, height) / 200));
    let n = 0;
    let sum = 0;
    let sumSq = 0;

    const idx = (x, y) => (y * width + x) * 4;

    for (let y = 1; y < height - 1; y += step) {
        for (let x = 1; x < width - 1; x += step) {
            const c = data[idx(x, y)];
            const l = data[idx(x - 1, y)];
            const r = data[idx(x + 1, y)];
            const t = data[idx(x, y - 1)];
            const b = data[idx(x, y + 1)];

            const lap = 4 * c - l - r - t - b;
            n += 1;
            sum += lap;
            sumSq += lap * lap;
        }
    }

    if (n === 0) return 0;
    const mean = sum / n;
    return (sumSq / n) - mean * mean;
}

function computeSharpnessScore(canvas) {
    if (!canvas) return 0;
    const srcW = canvas.width;
    const srcH = canvas.height;
    if (!srcW || !srcH) return 0;

    const maxDim = 320;
    const scale = Math.min(1, maxDim / Math.max(srcW, srcH));

    const w = Math.max(3, Math.round(srcW * scale));
    const h = Math.max(3, Math.round(srcH * scale));

    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    const tctx = tmp.getContext('2d', { willReadFrequently: true });
    if (!tctx) return 0;
    tctx.drawImage(canvas, 0, 0, w, h);

    const imageData = tctx.getImageData(0, 0, w, h);
    return varianceOfLaplacianFromImageData(imageData, w, h);
}

function matchesPartNumberFormat(value) {
    const v = String(value || '').trim().toUpperCase();
    if (!v) return false;
    if (v.length < 3 || v.length > 32) return false;
    if (!/^[A-Z0-9.\-]+$/.test(v)) return false;
    if (!/[0-9]/.test(v)) return false;
    return true;
}

function scorePartNumberCandidate(value) {
    const v = String(value || '').trim().toUpperCase();
    if (!v) return -Infinity;

    let score = 0;
    if (matchesPartNumberFormat(v)) score += OCR.SCORE_MATCHES_FORMAT;
    if (/[0-9]/.test(v)) score += OCR.SCORE_HAS_DIGIT;
    if (v.length >= 3 && v.length <= 32) score += OCR.SCORE_LENGTH_VALID;

    const ambiguous = (v.match(/[O0I1S5B8Z2]/g) || []).length;
    score -= ambiguous * OCR.SCORE_AMBIGUOUS_CHAR_PENALTY;

    try {
        const location = lookupLocation(v);
        if (location) score += OCR.SCORE_DATABASE_BONUS;
    } catch (e) {
    }

    return score;
}

function applyCharMap(value, map) {
    const v = String(value || '').trim().toUpperCase();
    if (!v) return '';
    let out = '';
    for (let i = 0; i < v.length; i++) {
        const ch = v[i];
        out += Object.prototype.hasOwnProperty.call(map, ch) ? map[ch] : ch;
    }
    return out;
}

function normalizeAndCorrectOcrPartNumber(value) {
    const normalized = normalizeOcrPartNumber(value);
    if (!normalized) return null;

    const alphaToDigit = { O: '0', I: '1', S: '5', B: '8', Z: '2' };
    const digitToAlpha = { '0': 'O', '1': 'I', '5': 'S', '8': 'B', '2': 'Z' };
    const digitSwap = { '0': '1', '1': '0' };

    const candidates = [
        normalized,
        applyCharMap(normalized, alphaToDigit),
        applyCharMap(normalized, digitToAlpha),
        applyCharMap(normalized, digitSwap)
    ];

    let best = normalized;
    let bestScore = scorePartNumberCandidate(best);

    for (const c of candidates) {
        const s = scorePartNumberCandidate(c);
        if (s > bestScore) {
            best = c;
            bestScore = s;
        }
    }

    return best;
}

function extractPotentialPartNumbers(text) {
    const candidates = [];
    const matches = String(text || '').match(/[A-Z0-9.\-]+/gi) || [];
    for (const match of matches) {
        const cleaned = match.replace(/[^A-Z0-9.\-]/g, '');
        if (cleaned.length >= 2) candidates.push(cleaned);
    }
    return candidates;
}

function extractAndSelectBestPartNumber(rawOutput) {
    const candidates = extractPotentialPartNumbers(rawOutput);
    if (candidates.length === 0) return null;

    const ranked = [];

    for (const cand of candidates) {
        const corrected = normalizeAndCorrectOcrPartNumber(cand) || normalizeOcrPartNumber(cand) || '';
        if (!corrected) continue;
        let inDb = false;
        try {
            inDb = !!lookupLocation(corrected);
        } catch (e) {}
        const score = scorePartNumberCandidate(corrected);
        ranked.push({ value: corrected, score, inDb });
    }

    if (!ranked.length) return null;

    const dbMatches = ranked.filter(r => r.inDb);
    const pool = dbMatches.length ? dbMatches : ranked;

    let best = null;
    let bestScore = -Infinity;
    for (const item of pool) {
        if (item.score > bestScore) {
            best = item.value;
            bestScore = item.score;
        }
    }

    if (bestScore < OCR.MIN_DISPLAY_SCORE && dbMatches.length === 0) return null;

    return best;
}

export function initOCRElements(video, canvas, overlay) {
    videoEl = video;
    canvasEl = canvas;
    ctxEl = canvas.getContext('2d', { willReadFrequently: true });
    overlayEl = overlay;
}

// Preprocess image for better OCR accuracy
function preprocessImage(canvas, ctx) {
    const width = canvas.width;
    const height = canvas.height;

    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;

    const { contrastFactor, brightnessOffset } = getPreprocessingSettings();

    for (let i = 0; i < data.length; i += 4) {
        const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        let adjusted = ((gray - 128) * contrastFactor) + 128 + brightnessOffset;
        adjusted = clamp(adjusted, 0, 255);
        data[i] = adjusted;
        data[i + 1] = adjusted;
        data[i + 2] = adjusted;
    }

    ctx.putImageData(imageData, 0, 0);

    if (isAndroid()) {
        applyGammaCorrection(canvas, ctx, OCR.GAMMA_CORRECTION);
    }

    applySharpening(canvas, ctx);
}

function applyGammaCorrection(canvas, ctx, gamma) {
    if (!Number.isFinite(gamma) || gamma <= 0) return;

    const width = canvas.width;
    const height = canvas.height;

    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;

    const invGamma = 1 / gamma;
    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) {
        lut[i] = Math.max(0, Math.min(255, Math.round(Math.pow(i / 255, invGamma) * 255)));
    }

    for (let i = 0; i < data.length; i += 4) {
        const v = data[i];
        const g = lut[v];
        data[i] = g;
        data[i + 1] = g;
        data[i + 2] = g;
    }

    ctx.putImageData(imageData, 0, 0);
}

function applyOtsuThreshold(canvas, ctx) {
    const width = canvas.width;
    const height = canvas.height;
    if (!width || !height) return;

    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;

    const hist = new Uint32Array(256);
    for (let i = 0; i < data.length; i += 4) {
        hist[data[i]]++;
    }

    const total = width * height;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];

    let sumB = 0;
    let wB = 0;
    let maxVar = -1;
    let threshold = 128;

    for (let t = 0; t < 256; t++) {
        wB += hist[t];
        if (wB === 0) continue;
        const wF = total - wB;
        if (wF === 0) break;

        sumB += t * hist[t];
        const mB = sumB / wB;
        const mF = (sum - sumB) / wF;
        const between = wB * wF * (mB - mF) * (mB - mF);

        if (between > maxVar) {
            maxVar = between;
            threshold = t;
        }
    }

    for (let i = 0; i < data.length; i += 4) {
        const v = data[i] >= threshold ? 255 : 0;
        data[i] = v;
        data[i + 1] = v;
        data[i + 2] = v;
    }

    ctx.putImageData(imageData, 0, 0);
}

/**
 * Adaptive JPEG encoding with quality adjustment
 * Uses lower quality for better compression when network is slow
 */
function encodeJpegAdaptive(canvas, startingQuality, maxBytes) {
    const clampQuality = (q) => clamp(q, 0, 1);
    const max = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : MAX_IMAGE_SIZE_BYTES;
    let quality = clampQuality(startingQuality);

    let best = null;
    for (let attempt = 1; attempt <= OCR.JPEG_MAX_ATTEMPTS; attempt++) {
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        const base64 = (dataUrl.split(',')[1] || '').trim();
        const approxBytes = Math.floor((base64.length * 3) / 4);

        best = { base64, quality, approxBytes, attempts: attempt };

        if (approxBytes <= max) return best;
        if (quality <= OCR.JPEG_MIN_QUALITY) return best;
        quality = clampQuality(quality - OCR.JPEG_QUALITY_STEP);
    }

    return best;
}

// Apply simple sharpening using unsharp mask principle
function applySharpening(canvas, ctx) {
    const width = canvas.width;
    const height = canvas.height;
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;
    const original = new Uint8ClampedArray(data);
    const sharpenAmount = isAndroid() ? OCR.SHARPEN_AMOUNT_ANDROID : OCR.SHARPEN_AMOUNT_DEFAULT;
    
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const idx = (y * width + x) * 4;
            const top = original[((y - 1) * width + x) * 4];
            const bottom = original[((y + 1) * width + x) * 4];
            const left = original[(y * width + (x - 1)) * 4];
            const right = original[(y * width + (x + 1)) * 4];
            const center = original[idx];
            
            const edge = 4 * center - top - bottom - left - right;
            let sharpened = center + edge * sharpenAmount;
            sharpened = clamp(sharpened, 0, 255);
            
            data[idx] = sharpened;
            data[idx + 1] = sharpened;
            data[idx + 2] = sharpened;
        }
    }
    
    ctx.putImageData(imageData, 0, 0);
}

/**
 * Capture and preprocess a single OCR attempt variant
 */
async function prepareOcrAttempt(attempt, params) {
    const { left, top, width, height, srcW, srcH, displayW, displayH, scale, offsetX, offsetY } = params;
    const { preprocess, thresholded, biasOffset } = attempt;
    
    const baseBias = (typeof OCR_CROP_Y_BIAS_RATIO === 'number' && Number.isFinite(OCR_CROP_Y_BIAS_RATIO))
        ? OCR_CROP_Y_BIAS_RATIO
        : 0;
    
    let sx = (left + offsetX) / scale;
    let sy = (top + offsetY) / scale;
    let sw = width / scale;
    let sh = height / scale;

    const padX = sw * OCR.CROP_INNER_PADDING;
    const padY = sh * OCR.CROP_INNER_PADDING;
    sx += padX;
    sy += padY;
    sw -= 2 * padX;
    sh -= 2 * padY;

    const effectiveBias = baseBias + (biasOffset || 0);
    sy += effectiveBias * sh;

    sx = clamp(sx, 0, srcW - 1);
    sy = clamp(sy, 0, srcH - 1);
    sw = clamp(sw, 1, srcW - sx);
    sh = clamp(sh, 1, srcH - sy);

    const shouldUpscale = isAndroid();
    const targetWidth = shouldUpscale ? 1200 : PREPROCESS_TARGET_WIDTH;

    const sourceW = Math.round(sw);
    const sourceH = Math.round(sh);

    const scaleFactor = (targetWidth > 0 && sourceW > 0)
        ? Math.max(1, targetWidth / sourceW)
        : 1;

    canvasEl.width = Math.round(sourceW * scaleFactor);
    canvasEl.height = Math.round(sourceH * scaleFactor);

    ctxEl.imageSmoothingEnabled = true;
    ctxEl.imageSmoothingQuality = 'high';

    ctxEl.drawImage(
        videoEl,
        Math.round(sx), Math.round(sy), sourceW, sourceH,
        0, 0, canvasEl.width, canvasEl.height
    );

    if (preprocess !== false) {
        preprocessImage(canvasEl, ctxEl);
    }

    if (thresholded) {
        applyOtsuThreshold(canvasEl, ctxEl);
    }

    const sharpnessScore = computeSharpnessScore(canvasEl);
    if (sharpnessScore < OCR.SHARPNESS_MIN_THRESHOLD) {
        return { success: false, error: 'Too blurry', sharpness: sharpnessScore };
    }

    const encoded = encodeJpegAdaptive(canvasEl, JPEG_QUALITY, MAX_IMAGE_SIZE_BYTES);
    if (!encoded || !encoded.base64) {
        return { success: false, error: 'JPEG encoding failed' };
    }

    const attemptMode = `${preprocess === false ? 'raw' : 'pre'}${thresholded ? '+otsu' : ''}`;

    captureOcrDebugFrame(encoded.base64, {
        attemptMode,
        preprocess: preprocess !== false,
        thresholded: !!thresholded,
        sourceW,
        sourceH,
        targetW: canvasEl.width,
        targetH: canvasEl.height,
        sharpness: Math.round(sharpnessScore)
    });

    return {
        success: true,
        base64: encoded.base64,
        attemptMode,
        sourceW,
        sourceH,
        targetW: canvasEl.width,
        targetH: canvasEl.height,
        sharpness: sharpnessScore,
        approxBytes: encoded.approxBytes
    };
}

export async function scanPartNumber() {
    const stream = getStream();
    if (!stream) return;

    const scanToken = ++activeScanToken;

    const scanTimeoutMs = OCR.SCAN_TIMEOUT_MS;
    const scanStartedAt = (typeof performance !== 'undefined' && typeof performance.now === 'function')
        ? performance.now()
        : Date.now();

    lastOcrNetworkMs = 0;
    lastOcrNetworkCalls = 0;
    lastOcrPayloadBytes = 0;
    lastOcrProviderUsed = null;
    lastOcrProviderFallbackUsed = false;
    lastOcrModelUsed = null;
    lastOcrModelFallbackUsed = false;

    await sleep(150);
    if (scanToken !== activeScanToken) return;
    if (isExpired(scanStartedAt, scanTimeoutMs)) throw new Error('Scan timeout');

    const track = getVideoTrack();
    await ensureContinuousFocusExposure(track);
    await waitForCameraSettingsToSettle(track, { maxWaitMs: 250, pollMs: 60, stableSamplesRequired: 1 });
    if (scanToken !== activeScanToken) return;
    if (isExpired(scanStartedAt, scanTimeoutMs)) throw new Error('Scan timeout');

    if (activeOcrController) {
        try {
            activeOcrController.abort();
        } catch (e) {}
    }
    activeOcrController = new AbortController();
    
    try {
        const videoRect = videoEl.getBoundingClientRect();
        const overlayRect = overlayEl.getBoundingClientRect();

        const left = overlayRect.left - videoRect.left;
        const top = overlayRect.top - videoRect.top;
        const width = overlayRect.width;
        const height = overlayRect.height;

        const srcW = videoEl.videoWidth;
        const srcH = videoEl.videoHeight;
        const displayW = videoEl.clientWidth;
        const displayH = videoEl.clientHeight;

        const scale = Math.max(displayW / srcW, displayH / srcH);
        const renderW = srcW * scale;
        const renderH = srcH * scale;
        const offsetX = (renderW - displayW) / 2;
        const offsetY = (renderH - displayH) / 2;

        const attempts = OCR_ATTEMPTS || [];

        console.log('[OCR] Starting parallel scan with', attempts.length, 'attempts');

        // Step 1: Prepare all attempts in parallel (preprocessing is CPU-bound)
        const preparedAttempts = await Promise.all(
            attempts.map(attempt => prepareOcrAttempt(attempt, {
                left, top, width, height,
                srcW, srcH, displayW, displayH,
                scale, offsetX, offsetY
            }))
        );

        // Step 2: Find sharpest images that were successfully preprocessed
        const validAttempts = preparedAttempts
            .map((result, index) => ({ ...result, index }))
            .filter(r => r.success)
            .sort((a, b) => b.sharpness - a.sharpness);

        if (validAttempts.length === 0) {
            const blurErrors = preparedAttempts.filter(r => !r.success);
            console.log('[OCR] All attempts failed:', blurErrors.map(e => e.error));
            showError('Billedet er for uskarpt. Hold kameraet mere stabilt.');
            setOverlayError();
            return;
        }

        // Step 3: Send top 2 attempts to OCR in parallel (network-bound)
        const topAttempts = validAttempts.slice(0, Math.min(2, validAttempts.length));
        
        console.log('[OCR] Sending', topAttempts.length, 'attempts to OCR (parallel)');

        let partNumber = '';
        let ocrRaw = '';
        let attemptResults = [];
        let ocrSuccess = false;

        const ocrPromises = topAttempts.map(async (attemptData) => {
            if (scanToken !== activeScanToken) return null;
            
            const ocrStartTime = performance.now();
            try {
                const ocrResponse = await performOCR(
                    attemptData.base64,
                    activeOcrController,
                    OCR_DEBUG_ENABLED ? attemptData : null
                );
                const ocrNetworkMs = Math.round(performance.now() - ocrStartTime);
                
                return {
                    ...attemptData,
                    ocrResponse,
                    ocrNetworkMs
                };
            } catch (e) {
                return {
                    ...attemptData,
                    ocrResponse: null,
                    error: e.message,
                    ocrNetworkMs: Math.round(performance.now() - ocrStartTime)
                };
            }
        });

        const ocrResults = await Promise.all(ocrPromises);

        // Step 4: Process results in order
        for (const result of ocrResults) {
            if (scanToken !== activeScanToken) return;
            if (!result.ocrResponse || !result.ocrResponse.partNumber) continue;
            
            const rawPartNumber = result.ocrResponse.partNumber;
            const normalized = normalizeOcrPartNumber(rawPartNumber);
            const corrected = normalizeAndCorrectOcrPartNumber(normalized);
            const extracted = extractAndSelectBestPartNumber(rawPartNumber);

            const finalPartNumber = extracted || corrected ||
                (isLikelyPartNumber(normalized) ? normalized : null);

            if (finalPartNumber && isLikelyPartNumber(finalPartNumber)) {
                partNumber = finalPartNumber;
                ocrRaw = rawPartNumber || '';
                lastOcrNetworkMs += result.ocrNetworkMs;
                lastOcrPayloadBytes += result.approxBytes || 0;
                lastOcrNetworkCalls++;
                ocrSuccess = true;

                // Update model info from successful response
                if (result.ocrResponse.providerUsed) lastOcrProviderUsed = result.ocrResponse.providerUsed;
                if (result.ocrResponse.modelUsed) lastOcrModelUsed = result.ocrResponse.modelUsed;
                lastOcrProviderFallbackUsed = !!result.ocrResponse.providerFallbackUsed;
                lastOcrModelFallbackUsed = !!result.ocrResponse.fallbackUsed;

                console.log(`  ✓ Attempt ${result.index} (${result.attemptMode}): ${partNumber} (raw: ${ocrRaw})`);
                break;
            } else {
                console.log(`  ✗ Attempt ${result.index} (${result.attemptMode}): No valid part number (raw: ${rawPartNumber})`);
            }
        }

        // Aggregate metrics
        lastOcrNetworkMs = ocrResults.reduce((sum, r) => sum + (r.ocrNetworkMs || 0), 0);
        lastOcrPayloadBytes = ocrResults.reduce((sum, r) => sum + (r.approxBytes || 0), 0);
        lastOcrNetworkCalls = ocrResults.filter(r => r.ocrResponse).length;

        console.log('[OCR] Completed parallel scan | success:', ocrSuccess);

        if (scanToken !== activeScanToken) return;

        // Step 5: Process and display result
        const normalized =
            extractAndSelectBestPartNumber(partNumber) ||
            normalizeAndCorrectOcrPartNumber(partNumber) ||
            (isLikelyPartNumber(partNumber) ? partNumber : normalizeOcrPartNumber(partNumber));

        console.log('[OCR] Normalized:', normalized, '| From partNumber:', partNumber);

        if (normalized) {
            let resolvedPartNumber = normalized;
            let location = lookupLocation(resolvedPartNumber);

            console.log('[OCR] Exact lookup for', resolvedPartNumber, '→', location || 'NOT FOUND');

            if (!location) {
                const suggestion = findClosestPartNumber(resolvedPartNumber);
                console.log('[OCR] Fuzzy suggestion:', suggestion || 'none');
                if (suggestion) {
                    resolvedPartNumber = suggestion;
                    location = lookupLocation(resolvedPartNumber);
                    console.log('[OCR] Fuzzy lookup for', resolvedPartNumber, '→', location || 'NOT FOUND');
                }
            }

            displayResult(resolvedPartNumber, location, location ? null : ocrRaw);

            if (location) {
                saveToHistory(resolvedPartNumber, location);
                setOverlaySuccess();
            } else {
                setOverlayError();
            }
        } else {
            const ocrRawCleaned = (ocrRaw || '').trim();
            console.log('[OCR] No normalized result. Raw OCR:', ocrRawCleaned || '(empty)');
            showError(ocrRawCleaned ? ('Varenummer ikke fundet (OCR: ' + ocrRawCleaned + ')') : 'Varenummer ikke fundet');
            setOverlayError();
        }

        if (overlayFeedbackTimeoutId) clearTimeout(overlayFeedbackTimeoutId);
        overlayFeedbackTimeoutId = setTimeout(() => {
            clearOverlayFeedback();
        }, OVERLAY_FEEDBACK_MS);
        
    } catch (error) {
        if (error && (error.name === 'AbortError' || String(error.message || '').toLowerCase().includes('aborted'))) {
            return;
        }
        if (scanToken !== activeScanToken) return;
        if (error && String(error.message || '') === 'Scan timeout') {
            try {
                if (activeOcrController) activeOcrController.abort();
            } catch (e) {}
            showError('Skanning tog for lang tid');
        } else {
            showError('Scanning mislykkedes: ' + error.message);
        }
        setOverlayError();
        if (overlayFeedbackTimeoutId) clearTimeout(overlayFeedbackTimeoutId);
        overlayFeedbackTimeoutId = setTimeout(() => {
            clearOverlayFeedback();
        }, OVERLAY_FEEDBACK_MS);
    }
}

async function performOCR(base64Image, controller, debugMeta) {
    const startedAt = (typeof performance !== 'undefined' && typeof performance.now === 'function')
        ? performance.now()
        : Date.now();

    const timeoutMs = OCR.OCR_TIMEOUT_MS;
    let timedOut = false;
    const timeoutId = setTimeout(() => {
        timedOut = true;
        try {
            if (controller && typeof controller.abort === 'function') controller.abort();
        } catch (e) {}
    }, timeoutMs);

    let response;
    try {
        const token = getToken();
        const headers = {
            'Content-Type': 'application/json'
        };

        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        response = await fetch(API_URL, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                image: base64Image,
                debug: OCR_DEBUG_ENABLED,
                debugMeta: debugMeta || undefined
            }),
            signal: controller ? controller.signal : undefined
        });
    } catch (e) {
        if (timedOut) {
            throw new Error('OCR timeout');
        }
        throw e;
    } finally {
        clearTimeout(timeoutId);
    }

    if (!response.ok) {
        let errorMsg = `API error: ${response.status}`;
        try {
            const error = await response.json();
            errorMsg = error.error || errorMsg;
            if (error.details) errorMsg += ' - ' + error.details;
        } catch (e) {}
        const err = new Error(errorMsg);
        err.status = response.status;
        throw err;
    }

    const data = await response.json();
    if (OCR_DEBUG_ENABLED && data && data.debug) {
        console.log('[OCR DEBUG] server', data.debug);
    }
    lastOcrProviderUsed = data && typeof data.providerUsed === 'string' ? data.providerUsed : null;
    lastOcrProviderFallbackUsed = !!(data && data.providerFallbackUsed);
    lastOcrModelUsed = data && typeof data.modelUsed === 'string' ? data.modelUsed : null;
    lastOcrModelFallbackUsed = !!(data && data.modelFallbackUsed);
    return {
        partNumber: data && typeof data.partNumber === 'string' ? data.partNumber : '',
        providerUsed: lastOcrProviderUsed,
        providerFallbackUsed: lastOcrProviderFallbackUsed,
        modelUsed: lastOcrModelUsed,
        fallbackUsed: lastOcrModelFallbackUsed
    };
}

export function getLastOcrTimings() {
    return {
        ocrNetworkMs: lastOcrNetworkMs,
        ocrNetworkCalls: lastOcrNetworkCalls,
        ocrPayloadBytes: lastOcrPayloadBytes
    };
}

export function getLastOcrModelInfo() {
    return {
        providerUsed: lastOcrProviderUsed,
        providerFallbackUsed: lastOcrProviderFallbackUsed,
        modelUsed: lastOcrModelUsed,
        fallbackUsed: lastOcrModelFallbackUsed
    };
}
