import { findClosestPartNumber, findMultipleMatches, lookupLocation } from './utils.js';

function normalizeOcrPartNumber(value) {
    return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

function replaceAt(value, index, replacement) {
    return `${value.slice(0, index)}${replacement}${value.slice(index + 1)}`;
}

/**
 * Generate only conservative OCR corrections. A generated value is accepted
 * only if it is an actual database key, so OCR text is never turned into an
 * invented part number.
 */
export function getOcrCorrectionCandidates(value) {
    const normalized = normalizeOcrPartNumber(value);
    if (!normalized) return [];

    const candidates = new Set([normalized]);

    // The common label errors relevant to the E-prefix part numbers are:
    // E0... → EO... and O0... → EO.... The latter also repairs a leading E
    // that the OCR model omitted or read as O.
    const eoPrefixMatch = normalized.match(/^(?:E0|O0)(\d{3}[A-Z])$/);
    if (eoPrefixMatch) candidates.add(`EO${eoPrefixMatch[1]}`);

    // Treat a zero read as the letter O, and an M read as the letter O. These
    // variants are deliberately checked against the DB before being used.
    for (let index = 0; index < normalized.length; index += 1) {
        const char = normalized[index];
        if (char === '0') candidates.add(replaceAt(normalized, index, 'O'));
        if (char === 'M') candidates.add(replaceAt(normalized, index, 'O'));
    }

    return [...candidates];
}

function addUniqueCandidate(candidates, partNumber, location, distance, correctedFrom = null) {
    if (!location || candidates.some(candidate => candidate.partNumber === partNumber)) return;
    candidates.push({ partNumber, location, distance, correctedFrom });
}

/**
 * Find OCR candidates that are real database entries. Direct OCR corrections
 * take precedence over generic fuzzy matches because ordinary edit distance
 * cannot distinguish 0→O from 0→M.
 */
export function findOcrDatabaseCandidates(partNumber, options = {}) {
    const normalized = normalizeOcrPartNumber(partNumber);
    if (!normalized) return [];

    const lookup = options.lookup || lookupLocation;
    const candidates = [];
    const corrections = getOcrCorrectionCandidates(normalized);

    for (const candidate of corrections) {
        const location = lookup(candidate);
        if (candidate === normalized) {
            addUniqueCandidate(candidates, candidate, location, 0);
        } else {
            addUniqueCandidate(candidates, candidate, location, 1, normalized);
        }
    }

    if (candidates.length > 0) return candidates;

    const findMatches = options.findMatches || (
        lookup === lookupLocation ? (value) => findMultipleMatches(value, 5, 2) : null
    );
    if (!findMatches) return [];
    const fuzzyMatches = findMatches(normalized) || [];
    if (!fuzzyMatches.length) return [];

    const bestDistance = Math.min(...fuzzyMatches.map(match => Number(match.distance)));
    return fuzzyMatches
        .filter(match => Number(match.distance) === bestDistance)
        .map(match => ({
            partNumber: match.partNumber,
            location: match.location || lookup(match.partNumber),
            distance: match.distance,
            correctedFrom: null
        }))
        .filter(match => match.location);
}

/**
 * Resolve an OCR reading without silently replacing it with a fuzzy match.
 * The caller decides whether a suggestion is accepted (and therefore saved).
 */
export function lookupOcrPartNumber(partNumber, options = {}) {
    const normalized = normalizeOcrPartNumber(partNumber);
    const lookup = options.lookup || lookupLocation;
    const suggest = options.suggest || findClosestPartNumber;

    if (!normalized) return { kind: 'not_found', partNumber: normalized, location: null, suggestion: null, candidates: [] };

    const location = lookup(normalized);
    if (location) return { kind: 'exact', partNumber: normalized, location, suggestion: null, candidates: [] };

    const candidates = findOcrDatabaseCandidates(normalized, options);
    if (candidates.length === 1 && candidates[0].correctedFrom) {
        const candidate = candidates[0];
        return {
            kind: 'exact',
            partNumber: candidate.partNumber,
            location: candidate.location,
            suggestion: null,
            candidates: [],
            correctedFrom: candidate.correctedFrom
        };
    }

    if (candidates.length > 1) {
        return {
            kind: 'suggestion',
            partNumber: normalized,
            location: null,
            suggestion: candidates[0].partNumber,
            candidates
        };
    }

    const suggestion = suggest(normalized);
    return {
        kind: suggestion ? 'suggestion' : 'not_found',
        partNumber: normalized,
        location: null,
        suggestion: suggestion || null,
        candidates: []
    };
}
