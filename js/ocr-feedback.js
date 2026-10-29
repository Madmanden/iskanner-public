// OCR ground truth from real use. After a scan without an exact database hit,
// the next part number the user confirms (an OCR suggestion, or a manual or
// voice lookup) is sent to the ocr-feedback function together with what the
// scan saw, including the crop sent to the model.

import { getToken } from './auth.js';
import { debugLog } from './utils.js';

const OCR_FEEDBACK_URL = '/.netlify/functions/ocr-feedback';
// A confirmation later than this is more likely a different instrument.
export const OCR_FEEDBACK_WINDOW_MS = 2 * 60 * 1000;

let pending = null;

export function setPendingOcrFeedback(context, now = Date.now()) {
    pending = context ? { ...context, scannedAt: now } : null;
}

export function clearPendingOcrFeedback() {
    pending = null;
}

function getAuthHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    try {
        const token = getToken();
        if (token) headers['Authorization'] = `Bearer ${token}`;
    } catch (e) {}
    return headers;
}

/**
 * Send the pending scan with the part number the user confirmed. Each scan is
 * sent at most once. Returns the send promise (resolving to whether it was
 * stored), or null when there was nothing to send.
 */
export function reportOcrConfirmation(partNumber, source, options = {}) {
    const context = pending;
    pending = null;
    if (!context) return null;

    const now = options.now ?? Date.now();
    const correct = String(partNumber || '').trim().toUpperCase();
    if (!correct || now - context.scannedAt > OCR_FEEDBACK_WINDOW_MS) return null;

    const { scannedAt, ...sample } = context;
    const fetchImpl = options.fetch || fetch;

    return fetchImpl(OCR_FEEDBACK_URL, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ ...sample, correct, source, msSinceScan: now - scannedAt })
    }).then((response) => {
        if (!response.ok) debugLog('[OCR feedback] not stored:', response.status);
        return response.ok;
    }).catch((e) => {
        debugLog('[OCR feedback] send failed:', e && e.message ? e.message : e);
        return false;
    });
}
