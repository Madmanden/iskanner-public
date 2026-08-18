import partsDatabase from '../parts-database.js';
import { lookupLocation } from './utils.js';

function normalizeSearchText(value) {
    return String(value || '').trim().toUpperCase();
}

function compactSearchText(value) {
    return normalizeSearchText(value).replace(/[^A-Z0-9]/g, '');
}

function getSearchDatabase() {
    try {
        if (typeof window !== 'undefined') {
            const runtimeDb = window.partsDatabase;
            if (runtimeDb && typeof runtimeDb === 'object' && Object.keys(runtimeDb).length > 0) {
                return runtimeDb;
            }
        }
    } catch (e) {}

    return partsDatabase && typeof partsDatabase === 'object' ? partsDatabase : {};
}

function commonPrefixLength(a, b) {
    const limit = Math.min(a.length, b.length);
    let count = 0;
    while (count < limit && a[count] === b[count]) count += 1;
    return count;
}

function commonSuffixLength(a, b) {
    const limit = Math.min(a.length, b.length);
    let count = 0;
    while (count < limit && a[a.length - 1 - count] === b[b.length - 1 - count]) count += 1;
    return count;
}

export function damerauLevenshteinDistanceMax(a, b, maxDistance = Infinity) {
    const left = String(a || '');
    const right = String(b || '');

    if (left === right) return 0;
    if (Math.abs(left.length - right.length) > maxDistance) return null;
    if (left.length === 0) return right.length <= maxDistance ? right.length : null;
    if (right.length === 0) return left.length <= maxDistance ? left.length : null;

    const rows = left.length + 1;
    const cols = right.length + 1;
    const matrix = Array.from({ length: rows }, () => new Array(cols).fill(0));

    for (let i = 0; i < rows; i++) matrix[i][0] = i;
    for (let j = 0; j < cols; j++) matrix[0][j] = j;

    for (let i = 1; i < rows; i++) {
        let rowMin = Infinity;

        for (let j = 1; j < cols; j++) {
            const cost = left[i - 1] === right[j - 1] ? 0 : 1;
            let value = Math.min(
                matrix[i - 1][j] + 1,
                matrix[i][j - 1] + 1,
                matrix[i - 1][j - 1] + cost
            );

            if (
                i > 1 &&
                j > 1 &&
                left[i - 1] === right[j - 2] &&
                left[i - 2] === right[j - 1]
            ) {
                value = Math.min(value, matrix[i - 2][j - 2] + 1);
            }

            matrix[i][j] = value;
            if (value < rowMin) rowMin = value;
        }

        if (rowMin > maxDistance) return null;
    }

    const distance = matrix[left.length][right.length];
    return distance <= maxDistance ? distance : null;
}

function allowedDistanceForLength(length) {
    if (length <= 1) return 0;
    if (length <= 4) return 1;
    if (length <= 7) return 2;
    return 3;
}

function scoreCandidate(cleaned, compactNeedle, partNumber, location) {
    const upperPart = normalizeSearchText(partNumber);
    const compactPart = compactSearchText(partNumber);

    if (!upperPart || !compactPart) return null;

    let score = 0;
    let matchType = null;
    let distance = null;

    if (compactNeedle && compactPart === compactNeedle) {
        score += 220;
        matchType = 'normalized';
        distance = 0;
    }

    if (upperPart.startsWith(cleaned)) {
        score += 95;
        matchType ||= 'prefix';
    } else if (upperPart.includes(cleaned)) {
        score += 65;
        matchType ||= 'substring';
    }

    if (compactNeedle) {
        if (compactPart.startsWith(compactNeedle)) {
            score += 85;
            matchType ||= 'prefix';
        } else if (compactPart.includes(compactNeedle)) {
            score += 55;
            matchType ||= 'substring';
        }
    }

    if (compactNeedle.length >= 2) {
        const maxDistance = allowedDistanceForLength(compactNeedle.length);
        const fuzzyDistance = damerauLevenshteinDistanceMax(compactNeedle, compactPart, maxDistance);

        if (fuzzyDistance !== null) {
            distance = fuzzyDistance;
            score += 130 - fuzzyDistance * 32;
            score -= Math.abs(compactPart.length - compactNeedle.length) * 4;
            score += Math.min(commonPrefixLength(compactNeedle, compactPart), 3) * 7;
            score += Math.min(commonSuffixLength(compactNeedle, compactPart), 3) * 7;
            if (compactNeedle[0] === compactPart[0]) score += 8;
            if (compactNeedle.at(-1) === compactPart.at(-1)) score += 8;
            matchType = fuzzyDistance === 0 ? (matchType || 'normalized') : 'fuzzy';
        }
    }

    if (score <= 0 || !matchType) return null;

    return {
        partNumber,
        location,
        score,
        distance,
        matchType
    };
}

export function smartSearchV2(input, maxResults = 10) {
    const cleaned = normalizeSearchText(input);
    if (!cleaned) {
        return { exactMatch: null, results: [], strategy: 'empty' };
    }

    const exactLocation = lookupLocation(cleaned);
    if (exactLocation) {
        return {
            exactMatch: { partNumber: cleaned, location: exactLocation },
            results: [],
            strategy: 'exact'
        };
    }

    const compactNeedle = compactSearchText(cleaned);
    if (!compactNeedle) {
        return { exactMatch: null, results: [], strategy: 'none' };
    }

    const db = getSearchDatabase();
    const matches = [];

    for (const partNumber of Object.keys(db)) {
        const location = lookupLocation(partNumber) || db[partNumber];
        const candidate = scoreCandidate(cleaned, compactNeedle, partNumber, location);
        if (candidate) matches.push(candidate);
    }

    matches.sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score;

        const aDistance = a.distance === null ? Infinity : a.distance;
        const bDistance = b.distance === null ? Infinity : b.distance;
        if (aDistance !== bDistance) return aDistance - bDistance;

        const aLengthDelta = Math.abs(compactSearchText(a.partNumber).length - compactNeedle.length);
        const bLengthDelta = Math.abs(compactSearchText(b.partNumber).length - compactNeedle.length);
        if (aLengthDelta !== bLengthDelta) return aLengthDelta - bLengthDelta;

        return a.partNumber.localeCompare(b.partNumber, 'da', { numeric: true, sensitivity: 'base' });
    });

    const safeMaxResults = Math.max(1, Number(maxResults) || 1);
    const results = matches.slice(0, safeMaxResults);
    const strategy = results.some(result => result.matchType === 'fuzzy')
        ? 'fuzzy'
        : (results[0]?.matchType || 'none');

    return { exactMatch: null, results, strategy };
}

export function findClosestPartNumberV2(input) {
    const result = smartSearchV2(input, 1);
    if (result.exactMatch) return result.exactMatch.partNumber;
    return result.results[0]?.partNumber || null;
}
