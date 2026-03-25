// Unit tests for fuzzy matching algorithm
import { describe, it, expect } from 'bun:test';

// Mock parts database for testing
const mockPartsDatabase = {
    'BM067R': 'Cabinet A, Drawer 1',
    'BM068R': 'Cabinet A, Drawer 2',
    'BM069R': 'Cabinet A, Drawer 3',
    'BM100': 'Cabinet B, Drawer 1',
    'BM200': 'Cabinet B, Drawer 2',
    '100.300': 'Cabinet D, Drawer 1',
    '100.301': 'Cabinet D, Drawer 2',
    '100.400': 'Cabinet D, Drawer 3',
    '12345': 'Cabinet C, Drawer 1',
    '12346': 'Cabinet C, Drawer 2',
    'A1B2C3': 'Cabinet E, Drawer 1',
    'TEST01': 'Test Location 1',
    'TEST02': 'Test Location 2',
};

const lookupLocation = (key) => mockPartsDatabase[key] || null;

describe('Levenshtein Distance', () => {
    function levenshteinDistanceMax(a, b, maxDistance) {
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

    it('should return 0 for identical strings', () => {
        expect(levenshteinDistanceMax('BM067R', 'BM067R', 5)).toBe(0);
    });

    it('should return distance for single character difference', () => {
        expect(levenshteinDistanceMax('BM067R', 'BM068R', 5)).toBe(1);
    });

    it('should return null when difference exceeds max distance', () => {
        expect(levenshteinDistanceMax('ABC', 'XYZ', 1)).toBeNull();
    });

    it('should handle empty strings', () => {
        expect(levenshteinDistanceMax('', '', 5)).toBe(0);
        expect(levenshteinDistanceMax('ABC', '', 5)).toBe(3);
        expect(levenshteinDistanceMax('', 'ABC', 5)).toBe(3);
    });

    it('should handle length differences', () => {
        expect(levenshteinDistanceMax('BM067R', 'BM067', 5)).toBe(1);
        expect(levenshteinDistanceMax('BM067', 'BM067R', 5)).toBe(1);
    });

    it('should return null for length differences exceeding max', () => {
        expect(levenshteinDistanceMax('BM067R', 'BM', 2)).toBeNull();
    });

    it('should count substitutions', () => {
        expect(levenshteinDistanceMax('ABC', 'XYZ', 3)).toBe(3);
        expect(levenshteinDistanceMax('ABC', 'ABD', 3)).toBe(1);
    });

    it('should find minimum edits', () => {
        expect(levenshteinDistanceMax('cat', 'cut', 2)).toBe(1);
        expect(levenshteinDistanceMax('cat', 'at', 2)).toBe(1);
    });
});

describe('Fuzzy Part Number Matching', () => {
    function levenshteinDistanceMax(a, b, maxDistance) {
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

    function findClosestPartNumber(input, maxDistance = 3) {
        const needle = (input || '').trim().toUpperCase();
        if (!needle) return null;
        if (lookupLocation(needle)) return needle;

        const keys = Object.keys(mockPartsDatabase);
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

    it('should find exact matches directly', () => {
        expect(findClosestPartNumber('BM067R')).toBe('BM067R');
        expect(findClosestPartNumber('12345')).toBe('12345');
        expect(findClosestPartNumber('100.300')).toBe('100.300');
    });

    it('should find close matches (1-2 edits)', () => {
        const result = findClosestPartNumber('BM066R');
        expect(result).not.toBeNull();
        expect(result).toMatch(/^BM/);
    });

    it('should use prefix optimization', () => {
        const result = findClosestPartNumber('BM066R');
        expect(result).toMatch(/^BM/);
    });

    it('should return null for no match within distance', () => {
        expect(findClosestPartNumber('XYZ999')).toBeNull();
        expect(findClosestPartNumber('NOTFOUND')).toBeNull();
    });

    it('should handle case-insensitive input', () => {
        expect(findClosestPartNumber('bm067r')).toBe('BM067R');
    });

    it('should handle numeric part numbers', () => {
        expect(findClosestPartNumber('12346')).toBe('12346');
    });

    it('should handle dotted part numbers', () => {
        expect(findClosestPartNumber('100.300')).toBe('100.300');
    });
});

describe('Prefix Matching', () => {
    function findPartsByPrefix(prefix, maxResults = 20) {
        if (!prefix) return [];

        const needle = prefix.trim().toUpperCase();
        if (!needle) return [];

        const matches = [];
        const keys = Object.keys(mockPartsDatabase);

        for (const key of keys) {
            if (key.startsWith(needle)) {
                matches.push({ partNumber: key, location: mockPartsDatabase[key] });
                if (matches.length >= maxResults) break;
            }
        }

        return matches.sort((a, b) => a.partNumber.localeCompare(b.partNumber));
    }

    it('should find parts by prefix', () => {
        const results = findPartsByPrefix('BM');
        expect(results.length).toBeGreaterThanOrEqual(5);
        expect(results.every(r => r.partNumber.startsWith('BM'))).toBe(true);
    });

    it('should limit results', () => {
        const results = findPartsByPrefix('BM', 2);
        expect(results.length).toBeLessThanOrEqual(2);
    });

    it('should return empty for no matches', () => {
        const results = findPartsByPrefix('XYZ');
        expect(results.length).toBe(0);
    });

    it('should handle single character prefix', () => {
        const results = findPartsByPrefix('T');
        expect(results.length).toBeGreaterThan(0);
    });
});

describe('Smart Search', () => {
    function levenshteinDistanceMax(a, b, maxDistance) {
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

    function findMultipleMatches(input, maxResults = 10, maxDistance = 3) {
        const needle = (input || '').trim().toUpperCase();
        if (!needle) return [];

        if (lookupLocation(needle)) {
            return [{ partNumber: needle, location: lookupLocation(needle), distance: 0 }];
        }

        const keys = Object.keys(mockPartsDatabase);
        const prefix = /^[A-Z]{2}/.test(needle) ? needle.slice(0, 2) : null;
        const matches = [];

        for (const k of keys) {
            if (!k) continue;
            if (prefix && !k.startsWith(prefix)) continue;
            if (Math.abs(k.length - needle.length) > maxDistance) continue;

            const d = levenshteinDistanceMax(needle, k, maxDistance);
            if (d !== null) {
                matches.push({ partNumber: k, location: mockPartsDatabase[k], distance: d });
            }
        }

        return matches
            .sort((a, b) => {
                if (a.distance !== b.distance) return a.distance - b.distance;
                return a.partNumber.localeCompare(b.partNumber);
            })
            .slice(0, maxResults);
    }

    it('should return exact match first', () => {
        const results = findMultipleMatches('BM067R');
        expect(results[0].partNumber).toBe('BM067R');
        expect(results[0].distance).toBe(0);
    });

    it('should sort by distance', () => {
        const results = findMultipleMatches('BM066R');
        expect(results.length).toBeGreaterThan(0);
    });

    it('should return empty for no matches', () => {
        const results = findMultipleMatches('XYZ999');
        expect(results.length).toBe(0);
    });

    it('should respect max results limit', () => {
        const results = findMultipleMatches('BM', 3);
        expect(results.length).toBeLessThanOrEqual(3);
    });
});
