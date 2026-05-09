// Local OCR using Tesseract.js (browser-side WASM, no cloud cost)
// ~4MB JS + ~4MB eng language data — loads fast, cached by browser after first load.

const TESSERACT_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@v5.1.1/dist/tesseract.esm.min.js';
const WORKER_PATH  = 'https://cdn.jsdelivr.net/npm/tesseract.js@v5.1.1/dist/worker.min.js';
const CORE_PATH    = 'https://cdn.jsdelivr.net/npm/tesseract.js-core@v5.1.1';
const LANG_PATH    = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int';

// PSM 11 = SPARSE_TEXT: find all text anywhere in the image without assuming layout.
// Better than PSM 6 (single block) for instrument labels where the part number sits
// among logos, barcodes, and other text at varying sizes and positions.
const PSM_SPARSE_TEXT = '11';

export const LOCAL_OCR_MODEL_ID    = 'tesseract-eng';
export const LOCAL_OCR_MODEL_LABEL = 'Tesseract';

let _worker         = null;
let _loadingPromise = null;
let _ready          = false;
let _failed         = false;
let _running        = false; // prevents concurrent recognitions on the shared worker

export function isLocalOCRReady()  { return _ready; }
export function isLocalOCRFailed() { return _failed; }

/**
 * Initialise the Tesseract worker. Safe to call multiple times.
 * @param {function} [onProgress] - receives Tesseract logger events {status, progress}
 * @returns {Promise<boolean>}
 */
export async function initLocalOCR(onProgress) {
    if (_ready)          return true;
    if (_failed)         return false;
    if (_loadingPromise) return _loadingPromise;

    _loadingPromise = (async () => {
        try {
            const Tesseract = await import(TESSERACT_CDN);
            const createWorker = Tesseract.createWorker ?? Tesseract.default?.createWorker;

            _worker = await createWorker('eng', 1, {
                workerPath: WORKER_PATH,
                corePath:   CORE_PATH,
                langPath:   LANG_PATH,
                logger: typeof onProgress === 'function' ? onProgress : undefined,
            });

            // Whitelist keeps only part-number characters, reducing noise
            await _worker.setParameters({
                tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-',
                tessedit_pageseg_mode:   PSM_SPARSE_TEXT,
            });

            _ready = true;
            console.log('[LocalOCR] Tesseract ready');
            return true;
        } catch (e) {
            _failed = true;
            _loadingPromise = null;
            console.warn('[LocalOCR] Failed to init Tesseract:', e && e.message ? e.message : String(e));
            return false;
        }
    })();

    return _loadingPromise;
}

/**
 * Run OCR on a base64 JPEG image.
 * @param {string} base64Image - base64-encoded JPEG without data: prefix
 * @returns {Promise<string|null>} raw recognised text or null
 */
export async function runLocalOCR(base64Image) {
    if (!_ready || !_worker) return null;

    // scanPartNumber() runs the top-2 attempts in parallel — skip the second call
    // rather than queue a concurrent recognition on the same worker.
    if (_running) {
        console.log('[LocalOCR] Skipping concurrent call — recognition in progress');
        return null;
    }

    _running = true;
    try {
        const dataUrl = `data:image/jpeg;base64,${base64Image}`;
        const { data: { text } } = await _worker.recognize(dataUrl);
        const cleaned = (text || '').trim();
        if (!cleaned) {
            console.log('[LocalOCR] Empty result — no text detected');
            return null;
        }

        // Truncate to avoid leaking label contents into console
        console.log('[LocalOCR] Raw result:', cleaned.length > 60 ? cleaned.slice(0, 60) + '…' : cleaned);
        return cleaned;
    } catch (e) {
        console.warn('[LocalOCR] Recognition failed:', e && e.message ? e.message : String(e));
        return null;
    } finally {
        _running = false;
    }
}
