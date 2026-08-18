import { findMultipleMatches, lookupLocation } from './utils.js';

export const VOICE_LEARNING_STORAGE_KEY = 'voicePartNumberLearningV1';
const MAX_LEARNING_KEYS = 100;
const MIN_LEARNED_CONFIRMATIONS = 2;

function normalizePartNumber(value) {
    return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

function getDefaultStorage() {
    try {
        return typeof localStorage !== 'undefined' ? localStorage : null;
    } catch (e) {
        return null;
    }
}

function readLearning(storage = getDefaultStorage()) {
    if (!storage) return {};
    try {
        const parsed = JSON.parse(storage.getItem(VOICE_LEARNING_STORAGE_KEY) || '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (e) {
        return {};
    }
}

function writeLearning(learning, storage = getDefaultStorage()) {
    if (!storage) return;
    try {
        storage.setItem(VOICE_LEARNING_STORAGE_KEY, JSON.stringify(learning));
    } catch (e) {}
}

function learningCount(learning, source, target) {
    const entry = learning[source];
    const count = entry && entry.targets ? Number(entry.targets[target]) : 0;
    return Number.isFinite(count) && count > 0 ? count : 0;
}

function trimLearning(learning) {
    const keys = Object.keys(learning);
    if (keys.length <= MAX_LEARNING_KEYS) return learning;

    keys.sort((a, b) => Number(learning[b]?.updatedAt || 0) - Number(learning[a]?.updatedAt || 0));
    const keep = new Set(keys.slice(0, MAX_LEARNING_KEYS));
    for (const key of keys) {
        if (!keep.has(key)) delete learning[key];
    }
    return learning;
}

export function recordVoiceSelection(sourcePartNumber, selectedPartNumber, options = {}) {
    const source = normalizePartNumber(sourcePartNumber);
    const target = normalizePartNumber(selectedPartNumber);
    if (!source || !target || source === target) return;

    const lookup = options.lookup || lookupLocation;
    if (!lookup(target)) return;

    const storage = options.storage === undefined ? getDefaultStorage() : options.storage;
    if (!storage) return;

    const learning = readLearning(storage);
    const entry = learning[source] && typeof learning[source] === 'object'
        ? learning[source]
        : { targets: {}, updatedAt: 0 };
    if (!entry.targets || typeof entry.targets !== 'object') entry.targets = {};

    const previousCount = Number(entry.targets[target]) || 0;
    entry.targets[target] = previousCount + 1;
    entry.updatedAt = Date.now();
    learning[source] = entry;
    writeLearning(trimLearning(learning), storage);
}

function rankCandidates(candidates) {
    return candidates.slice().sort((a, b) => {
        if (a.distance !== b.distance) return a.distance - b.distance;
        return a.partNumber.localeCompare(b.partNumber);
    });
}

function getVoiceMaxDistance(value) {
    const length = String(value || '').length;
    if (length >= 8) return 3;
    if (length >= 5) return 2;
    return 1;
}

function getRepeatedLearnedTarget(candidates, source, learning) {
    const ranked = candidates
        .map(candidate => ({ candidate, count: learningCount(learning, source, candidate.partNumber) }))
        .sort((a, b) => b.count - a.count);

    if (!ranked.length || ranked[0].count < MIN_LEARNED_CONFIRMATIONS) return null;
    if (ranked.length > 1 && ranked[0].count === ranked[1].count) return null;
    return ranked[0].candidate;
}

/**
 * Resolve a normalized spoken part number against real database entries.
 * Auto-correction is deliberately narrow: exact matches, repeated learned
 * choices, or a unique edit-distance-1 candidate with sufficient speech
 * confidence. Everything else remains an explicit user choice.
 */
export function resolveVoicePartNumber(partNumber, confidence = 0, options = {}) {
    const normalized = normalizePartNumber(partNumber);
    const lookup = options.lookup || lookupLocation;
    const findMatches = options.findMatches || findMultipleMatches;
    const storage = options.storage === undefined ? getDefaultStorage() : options.storage;

    if (!normalized) {
        return { kind: 'not_found', partNumber: normalized, location: null, candidates: [] };
    }

    const exactLocation = lookup(normalized);
    if (exactLocation) {
        return {
            kind: 'exact',
            partNumber: normalized,
            location: exactLocation,
            candidates: [],
            correctedFrom: null,
            learned: false
        };
    }

    const maxDistance = getVoiceMaxDistance(normalized);
    const rawMatches = (findMatches(normalized, 8, maxDistance) || [])
        .map(match => ({
            partNumber: normalizePartNumber(match.partNumber),
            location: match.location || lookup(normalizePartNumber(match.partNumber)),
            distance: Number(match.distance)
        }))
        .filter(match => match.partNumber && match.location && Number.isFinite(match.distance))
        .filter((match, index, all) => all.findIndex(other => other.partNumber === match.partNumber) === index);

    if (!rawMatches.length) {
        return { kind: 'not_found', partNumber: normalized, location: null, candidates: [] };
    }

    const learning = readLearning(storage);
    const ranked = rankCandidates(rawMatches);
    const bestDistance = Math.min(...ranked.map(candidate => candidate.distance));
    const bestDistanceCandidates = ranked.filter(candidate => candidate.distance === bestDistance);
    const learnedTarget = getRepeatedLearnedTarget(ranked, normalized, learning);
    const safeConfidence = Number.isFinite(Number(confidence)) ? Number(confidence) : 0;

    if (learnedTarget && learnedTarget.distance === bestDistance && safeConfidence >= 0.4) {
        return {
            kind: 'corrected',
            partNumber: learnedTarget.partNumber,
            location: learnedTarget.location,
            candidates: [],
            correctedFrom: normalized,
            learned: true
        };
    }

    if (bestDistance === 1 && bestDistanceCandidates.length === 1 && safeConfidence >= 0.55) {
        const candidate = bestDistanceCandidates[0];
        return {
            kind: 'corrected',
            partNumber: candidate.partNumber,
            location: candidate.location,
            candidates: [],
            correctedFrom: normalized,
            learned: false
        };
    }

    return {
        kind: 'suggestion',
        partNumber: normalized,
        location: null,
        candidates: ranked.slice(0, 3),
        correctedFrom: null,
        learned: false
    };
}
