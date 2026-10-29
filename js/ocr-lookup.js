import { findClosestPartNumber, findMultipleMatches, lookupLocation } from './utils.js';

function normalizeOcrPartNumber(value) {
    return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

function replaceAt(value, index, replacement) {
    return `${value.slice(0, index)}${replacement}${value.slice(index + 1)}`;
}

// Letter/digit pairs that look alike in label fonts. Swapping one changes the
// shape of the code (a letter where the database has a digit, or the reverse),
// so a swap that lands on a real key is a likely misread rather than another
// part. Letter/letter and digit/digit look-alikes (M/N, 3/8) are left out:
// they keep the shape and could turn one real part into another.
const SHAPE_CONFUSIONS = {
    O: ['0'], D: ['0'], Q: ['0'], '0': ['O', 'D', 'Q'],
    I: ['1'], L: ['1'], '1': ['I', 'L'],
    S: ['5'], '5': ['S'],
    B: ['8'], '8': ['B'],
    Z: ['2'], '2': ['Z'],
    G: ['6'], '6': ['G'],
    A: ['4'], '4': ['A'],
    T: ['7'], '7': ['T'],
    // EO… read as EM… is a known label-font misread.
    M: ['O']
};
const MAX_OCR_SUBSTITUTIONS = 2;

// Look-alike pairs used only to rank fuzzy suggestions, never to auto-correct.
const VISUAL_CONFUSION_PAIRS = [
    ...Object.entries(SHAPE_CONFUSIONS).flatMap(([from, tos]) => tos.map(to => from + to)),
    'MN', 'MW', 'NH', 'CG', 'CO', 'EF', 'UV', 'PR', 'KX', '38', '68', '56', '17'
];
const VISUAL_CONFUSIONS = new Set(VISUAL_CONFUSION_PAIRS.flatMap(pair => [pair, pair[1] + pair[0]]));
const VISUAL_SUBSTITUTION_COST = 0.4;

/**
 * All variants of `normalized` with up to MAX_OCR_SUBSTITUTIONS look-alike
 * swaps, mapped to the number of swaps. The read itself maps to 0.
 */
function collectOcrCorrections(normalized) {
    const corrections = new Map([[normalized, 0]]);
    let frontier = [{ text: normalized, nextIndex: 0 }];

    // Each round swaps one more position, always to the right of the previous
    // swap, so every combination is generated once.
    for (let substitutions = 1; substitutions <= MAX_OCR_SUBSTITUTIONS; substitutions += 1) {
        const nextFrontier = [];
        for (const { text, nextIndex } of frontier) {
            for (let index = nextIndex; index < text.length; index += 1) {
                for (const replacement of SHAPE_CONFUSIONS[text[index]] || []) {
                    const variant = replaceAt(text, index, replacement);
                    if (corrections.has(variant)) continue;
                    corrections.set(variant, substitutions);
                    nextFrontier.push({ text: variant, nextIndex: index + 1 });
                }
            }
        }
        frontier = nextFrontier;
    }

    // The common label errors relevant to the E-prefix part numbers are:
    // E0... → EO... and O0... → EO.... The latter also repairs a leading E
    // that the OCR model omitted or read as O.
    const eoPrefixMatch = normalized.match(/^(?:E0|O0)(\d{3}[A-Z])$/);
    if (eoPrefixMatch) {
        const eoKey = `EO${eoPrefixMatch[1]}`;
        corrections.set(eoKey, Math.min(corrections.get(eoKey) ?? 1, 1));
    }

    return corrections;
}

/**
 * Generate only conservative OCR corrections. A generated value is accepted
 * only if it is an actual database key, so OCR text is never turned into an
 * invented part number.
 */
export function getOcrCorrectionCandidates(value) {
    const normalized = normalizeOcrPartNumber(value);
    if (!normalized) return [];
    return [...collectOcrCorrections(normalized).keys()];
}

/**
 * Edit distance where swapping two look-alike characters costs less than an
 * unrelated substitution, so "XN902R" ranks XM902R above XN902A.
 */
export function ocrConfusionDistance(a, b) {
    const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i += 1) {
        const curr = [i];
        for (let j = 1; j <= b.length; j += 1) {
            let substitution = 0;
            if (a[i - 1] !== b[j - 1]) {
                substitution = VISUAL_CONFUSIONS.has(a[i - 1] + b[j - 1]) ? VISUAL_SUBSTITUTION_COST : 1;
            }
            curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + substitution);
        }
        for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j];
    }
    return prev[b.length];
}

function addUniqueCandidate(candidates, partNumber, location, distance, correctedFrom = null) {
    if (!location || candidates.some(candidate => candidate.partNumber === partNumber)) return;
    candidates.push({ partNumber, location, distance, correctedFrom });
}

/**
 * Database keys reachable from the read through look-alike swaps, closest
 * (fewest swaps) first. Includes the read itself when it is a key.
 */
export function findOcrCorrectionHits(partNumber, lookup = lookupLocation) {
    const normalized = normalizeOcrPartNumber(partNumber);
    if (!normalized) return [];

    const candidates = [];
    const corrections = [...collectOcrCorrections(normalized)].sort((a, b) => a[1] - b[1]);
    for (const [candidate, substitutions] of corrections) {
        addUniqueCandidate(candidates, candidate, lookup(candidate), substitutions, substitutions ? normalized : null);
    }
    return candidates;
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
    const corrections = findOcrCorrectionHits(normalized, lookup);
    if (corrections.length > 0) {
        // Only the fewest-swap tier: one swap that hits a key beats two.
        return corrections.filter(candidate => candidate.distance === corrections[0].distance);
    }

    const findMatches = options.findMatches || (
        lookup === lookupLocation ? (value) => findMultipleMatches(value, 20, 2) : null
    );
    if (!findMatches) return [];
    const fuzzyMatches = findMatches(normalized) || [];
    if (!fuzzyMatches.length) return [];

    // Keep the closest edit-distance tier, ordered so look-alike swaps come first.
    const bestDistance = Math.min(...fuzzyMatches.map(match => Number(match.distance)));
    return fuzzyMatches
        .filter(match => Number(match.distance) === bestDistance)
        .map(match => ({
            partNumber: match.partNumber,
            location: match.location || lookup(match.partNumber),
            distance: match.distance,
            correctedFrom: null,
            weight: ocrConfusionDistance(normalized, match.partNumber)
        }))
        .filter(match => match.location)
        .sort((a, b) => a.weight - b.weight || a.partNumber.localeCompare(b.partNumber))
        .slice(0, 5)
        .map(({ weight, ...match }) => match);
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
    // Only a unique single-swap correction is applied automatically; a
    // correction that needs two swaps is offered as a suggestion.
    if (candidates.length === 1 && candidates[0].correctedFrom && candidates[0].distance <= 1) {
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

    if (candidates.length > 1 || (candidates.length === 1 && candidates[0].correctedFrom)) {
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
