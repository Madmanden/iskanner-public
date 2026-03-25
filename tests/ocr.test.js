// Unit tests for OCR normalization and error correction
import { describe, it, expect } from 'bun:test';

// Mock parts database for testing
const mockPartsDatabase = {
    'BM067R': 'Cabinet A, Drawer 1',
    'BM068R': 'Cabinet A, Drawer 2',
    'BM100': 'Cabinet B, Drawer 1',
    '12345': 'Cabinet C, Drawer 1',
    '100.300': 'Cabinet D, Drawer 1',
    'A1B2C3': 'Cabinet E, Drawer 1',
    'TEST01': 'Test Location 1',
};

// Mock lookupLocation function
globalThis.lookupLocation = (key) => mockPartsDatabase[key] || null;

describe('OCR Part Number Normalization', () => {
    function normalizeOcrPartNumber(value) {
        const raw = (value || '');
        const trimmed = String(raw).trim().toUpperCase();
        if (!trimmed) return null;
        const compact = trimmed.replace(/\s+/g, '');
        const cleaned = compact.replace(/[^A-Z0-9.\-]/g, '');
        return cleaned || null;
    }

    it('should normalize uppercase part numbers', () => {
        expect(normalizeOcrPartNumber('BM067R')).toBe('BM067R');
    });

    it('should normalize lowercase part numbers', () => {
        expect(normalizeOcrPartNumber('bm067r')).toBe('BM067R');
    });

    it('should remove whitespace', () => {
        expect(normalizeOcrPartNumber('BM 067 R')).toBe('BM067R');
        expect(normalizeOcrPartNumber('BM067R ')).toBe('BM067R');
        expect(normalizeOcrPartNumber(' BM067R')).toBe('BM067R');
    });

    it('should remove special characters except . and -', () => {
        expect(normalizeOcrPartNumber('BM@067#R')).toBe('BM067R');
        expect(normalizeOcrPartNumber('100/300')).toBe('100300');
        expect(normalizeOcrPartNumber('A!B@C#')).toBe('ABC');
    });

    it('should preserve dots and hyphens', () => {
        expect(normalizeOcrPartNumber('100.300')).toBe('100.300');
        expect(normalizeOcrPartNumber('00-1206-090-60')).toBe('00-1206-090-60');
    });

    it('should handle empty input', () => {
        expect(normalizeOcrPartNumber('')).toBeNull();
        expect(normalizeOcrPartNumber(null)).toBeNull();
        expect(normalizeOcrPartNumber(undefined)).toBeNull();
    });

    it('should handle whitespace-only input', () => {
        expect(normalizeOcrPartNumber('   ')).toBeNull();
        expect(normalizeOcrPartNumber('\t\n')).toBeNull();
    });
});

describe('OCR Error Correction', () => {
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

    const alphaToDigit = { O: '0', I: '1', S: '5', B: '8', Z: '2' };
    const digitToAlpha = { '0': 'O', '1': 'I', '5': 'S', '8': 'B', '2': 'Z' };

    it('should apply char map replacements', () => {
        // alphaToDigit maps: O->0, I->1, S->5, B->8, Z->2
        expect(applyCharMap('BMO67R', alphaToDigit)).toBe('8M067R'); // B->8, O->0
        expect(applyCharMap('ZONE', alphaToDigit)).toBe('20NE'); // Z->2
    });

    it('should correct 0 to O when in alpha map', () => {
        // digitToAlpha maps: 0->O, 1->I, 5->S, 8->B, 2->Z
        expect(applyCharMap('B0OK', digitToAlpha)).toBe('BOOK'); // 0->O
        // Note: applyCharMap uppercases input, so 'A1pha' becomes 'A1PHA'
        // digitToAlpha has '1'->'I', so 'A1PHA' becomes 'AIPHA'
        expect(applyCharMap('A1PHA', digitToAlpha)).toBe('AIPHA'); // 1->I
    });

    it('should preserve characters not in map', () => {
        const result = applyCharMap('HELLO123', alphaToDigit);
        // H, E are not in alphaToDigit
        // L, L are not in alphaToDigit
        // 1, 2, 3 are not in alphaToDigit
        expect(result).toBe('HELL0123'); // O->0
    });

    it('should handle empty input', () => {
        expect(applyCharMap('', alphaToDigit)).toBe('');
        expect(applyCharMap(null, alphaToDigit)).toBe('');
    });
});

describe('Part Number Validation', () => {
    function isLikelyPartNumber(value) {
        const v = String(value || '').trim().toUpperCase();
        if (!v) return false;
        if (v.length < 4) return false;
        if (v.length > 32) return false;
        if (!/[0-9]/.test(v)) return false;
        if (!/^[A-Z0-9.\-]+$/.test(v)) return false;
        return true;
    }

    it('should accept valid part numbers', () => {
        expect(isLikelyPartNumber('BM067R')).toBe(true);
        expect(isLikelyPartNumber('100.300')).toBe(true);
        expect(isLikelyPartNumber('A1B2C3')).toBe(true);
        expect(isLikelyPartNumber('TEST01')).toBe(true);
    });

    it('should reject too short strings', () => {
        expect(isLikelyPartNumber('ABC')).toBe(false);
        expect(isLikelyPartNumber('123')).toBe(false);
        expect(isLikelyPartNumber('AB')).toBe(false);
    });

    it('should reject strings without digits', () => {
        expect(isLikelyPartNumber('ABCD')).toBe(false);
        expect(isLikelyPartNumber('HELLO')).toBe(false);
    });

    it('should reject strings with invalid characters', () => {
        expect(isLikelyPartNumber('BM@067')).toBe(false);
        expect(isLikelyPartNumber('ABC 123')).toBe(false);
    });

    it('should accept dots and hyphens', () => {
        expect(isLikelyPartNumber('100.300')).toBe(true);
        expect(isLikelyPartNumber('00-1206')).toBe(true);
    });

    it('should handle empty input', () => {
        expect(isLikelyPartNumber('')).toBe(false);
        expect(isLikelyPartNumber(null)).toBe(false);
        expect(isLikelyPartNumber(undefined)).toBe(false);
    });
});

describe('OCR Score Calculation', () => {
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
        if (matchesPartNumberFormat(v)) score += 10;
        if (/[0-9]/.test(v)) score += 2;
        if (v.length >= 3 && v.length <= 32) score += 1;

        const ambiguous = (v.match(/[O0I1S5B8Z2]/g) || []).length;
        score -= ambiguous * 2;

        const location = globalThis.lookupLocation ? globalThis.lookupLocation(v) : null;
        if (location) score += 100;

        return score;
    }

    it('should score database matches highest', () => {
        const score = scorePartNumberCandidate('BM067R');
        expect(score).toBeGreaterThan(100);
    });

    it('should penalize ambiguous characters', () => {
        const score = scorePartNumberCandidate('BM0O7R');
        expect(score).toBeLessThan(15);
    });

    it('should score non-matches lower', () => {
        const score = scorePartNumberCandidate('XYZ999');
        expect(score).toBeLessThan(15);
    });

    it('should handle invalid inputs', () => {
        expect(scorePartNumberCandidate('')).toBe(-Infinity);
        expect(scorePartNumberCandidate('ABC')).toBeLessThan(10);
    });
});
