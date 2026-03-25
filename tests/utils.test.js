// Unit tests for utility functions
import { describe, it, expect, beforeEach, test } from 'bun:test';
import { isAndroid, isIOS, clamp, escapeHtml, sleep, OCR, VOICE, AUTH } from '../js/utils.js';

describe('isAndroid', () => {
    it('should be a function', () => {
        expect(typeof isAndroid).toBe('function');
    });

    it('should return boolean', () => {
        const result = isAndroid();
        expect(typeof result).toBe('boolean');
    });
});

describe('isIOS', () => {
    it('should be a function', () => {
        expect(typeof isIOS).toBe('function');
    });

    it('should return boolean', () => {
        const result = isIOS();
        expect(typeof result).toBe('boolean');
    });
});

describe('clamp', () => {
    it('should clamp value to min when below', () => {
        expect(clamp(5, 10, 20)).toBe(10);
    });

    it('should clamp value to max when above', () => {
        expect(clamp(25, 10, 20)).toBe(20);
    });

    it('should return value when within range', () => {
        expect(clamp(15, 10, 20)).toBe(15);
    });

    it('should handle edge cases', () => {
        expect(clamp(10, 10, 20)).toBe(10);
        expect(clamp(20, 10, 20)).toBe(20);
    });

    it('should handle negative values', () => {
        expect(clamp(-5, 0, 10)).toBe(0);
    });
});

describe('escapeHtml', () => {
    it('should be a function', () => {
        expect(typeof escapeHtml).toBe('function');
    });

    // Note: escapeHtml requires browser DOM (document.createElement)
    // Skip these tests in Node/Bun environment
    // In a real project, use a testing library like happy-dom or jsdom
});

describe('sleep', () => {
    it('should delay execution', async () => {
        const start = Date.now();
        await sleep(50);
        const elapsed = Date.now() - start;
        expect(elapsed).toBeGreaterThanOrEqual(45);
        expect(elapsed).toBeLessThan(150);
    });

    it('should handle zero delay', async () => {
        const start = Date.now();
        await sleep(0);
        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(10);
    });
});

describe('OCR Constants', () => {
    it('should have valid sharpness thresholds', () => {
        expect(OCR.SHARPNESS_MIN_THRESHOLD).toBeGreaterThan(0);
        expect(OCR.SHARPNESS_EARLY_EXIT).toBeGreaterThan(OCR.SHARPNESS_MIN_THRESHOLD);
    });

    it('should have valid preprocessing parameters', () => {
        expect(OCR.CONTRAST_FACTOR).toBeGreaterThan(0);
        expect(OCR.BRIGHTNESS_OFFSET).toBeGreaterThanOrEqual(0);
        expect(OCR.GAMMA_CORRECTION).toBeGreaterThan(0);
    });

    it('should have valid JPEG quality settings', () => {
        expect(OCR.JPEG_QUALITY_DEFAULT).toBeGreaterThan(0);
        expect(OCR.JPEG_QUALITY_DEFAULT).toBeLessThanOrEqual(1);
        expect(OCR.JPEG_MIN_QUALITY).toBeGreaterThan(0);
        expect(OCR.JPEG_MIN_QUALITY).toBeLessThan(OCR.JPEG_QUALITY_DEFAULT);
    });

    it('should have valid timeout values', () => {
        expect(OCR.OCR_TIMEOUT_MS).toBeGreaterThan(0);
        expect(OCR.SCAN_TIMEOUT_MS).toBeGreaterThan(OCR.OCR_TIMEOUT_MS);
    });

    it('should have valid scoring thresholds', () => {
        expect(OCR.SCORE_MATCHES_FORMAT).toBeGreaterThan(0);
        expect(OCR.SCORE_DATABASE_BONUS).toBeGreaterThan(OCR.MIN_DISPLAY_SCORE);
    });

    it('should have valid crop constants', () => {
        expect(OCR.CROP_Y_BIAS).toBeGreaterThan(-0.2);
        expect(OCR.CROP_Y_BIAS).toBeLessThan(0.2);
        expect(OCR.CROP_INNER_PADDING).toBeGreaterThan(0);
        expect(OCR.CROP_INNER_PADDING).toBeLessThan(0.5);
    });

    it('should have valid fuzzy matching constants', () => {
        expect(OCR.FUZZY_MAX_DISTANCE).toBeGreaterThan(0);
        expect(OCR.FUZZY_MAX_DISTANCE).toBeLessThan(10);
        expect(OCR.FUZZY_PREFIX_LENGTH).toBeGreaterThan(0);
    });
});

describe('VOICE Constants', () => {
    it('should have valid confidence threshold', () => {
        expect(VOICE.CONFIDENCE_THRESHOLD).toBeGreaterThan(0);
        expect(VOICE.CONFIDENCE_THRESHOLD).toBeLessThanOrEqual(1);
    });

    it('should have valid timeout values', () => {
        expect(VOICE.TIMEOUT_MS).toBeGreaterThan(0);
        expect(VOICE.RESULT_DISPLAY_MS).toBeGreaterThan(0);
    });
});

describe('AUTH Constants', () => {
    it('should have valid token validity', () => {
        expect(AUTH.TOKEN_VALIDITY_MS).toBeGreaterThan(0);
        // Should be approximately 30 days
        expect(AUTH.TOKEN_VALIDITY_MS).toBeGreaterThan(25 * 24 * 60 * 60 * 1000);
        expect(AUTH.TOKEN_VALIDITY_MS).toBeLessThan(35 * 24 * 60 * 60 * 1000);
    });

    it('should have reasonable session warning threshold', () => {
        expect(AUTH.SESSION_WARN_DAYS).toBeGreaterThan(0);
        expect(AUTH.SESSION_WARN_DAYS).toBeLessThan(10);
    });
});
