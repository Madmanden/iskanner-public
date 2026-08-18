// Configuration constants
export const API_URL = '/.netlify/functions/ocr';
export const JPEG_QUALITY = 0.78;
export const OVERLAY_FEEDBACK_MS = 1200;
export const VOICE_RESULT_DISPLAY_MS = 3000;
export const MAX_RECENT_LOOKUPS = 50;
export const CAMERA_INACTIVITY_TIMEOUT_MS = 60000; // 60 seconds
export const VOICE_CONFIDENCE_THRESHOLD = 0.7;
export const VOICE_TIMEOUT_MS = 10000;

// OCR crop adjustment: negative values shift the crop upward relative to the overlay.
// Keep at 0 so the OCR crop aligns with the visible aiming box.
export const OCR_CROP_Y_BIAS_RATIO = 0;

// OCR attempt profiles. Order matters: raw → pre in priority order.
// Later attempts fire only if the previous returned no valid part number.
// Note: pre variants may also be skipped before any OCR call if sharpness
// gating determines the raw frame is already sufficiently sharp.
export const OCR_ATTEMPTS = [
    // Raw — cleanest signal, lowest hallucination risk. Best for sharp photos.
    { preprocess: false, thresholded: false, biasOffset: 0 },
    // Preprocessed — contrast/brightness/sharpen boost for faded or low-contrast labels.
    { preprocess: true,  thresholded: false, biasOffset: 0 },
];

// OCR preprocessing profiles. Switch the key to try different contrast/brightness tunings.
export const OCR_PREPROCESSING_PROFILES = {
    default: { contrastFactor: 1.4, brightnessOffset: 10 },
    lowContrast: { contrastFactor: 1.0, brightnessOffset: 5 }
};

// Active preprocessing profile key. Set to 'lowContrast' to try the 1.0x/ +5 variant.
export const OCR_PREPROCESSING_PROFILE = 'default';
