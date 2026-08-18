export function normalizeOcrCandidate(value) {
    const normalized = String(value || '').trim().toUpperCase();
    return normalized || null;
}

export function getMoSiblingPartNumber(partNumber) {
    const normalized = normalizeOcrCandidate(partNumber);
    if (!normalized) return null;

    const match = normalized.match(/^E([MO])(.+)$/);
    if (!match) return null;

    const siblingPrefix = match[1] === 'M' ? 'EO' : 'EM';
    return `${siblingPrefix}${match[2]}`;
}

export function isMoSiblingAmbiguous(partNumber, lookupLocation) {
    const normalized = normalizeOcrCandidate(partNumber);
    const sibling = getMoSiblingPartNumber(normalized);
    if (!normalized || !sibling || typeof lookupLocation !== 'function') return false;

    return !!lookupLocation(normalized) && !!lookupLocation(sibling);
}

export function chooseOcrConsensusPartNumber(partNumbers, lookupLocation) {
    const normalized = (Array.isArray(partNumbers) ? partNumbers : [])
        .map(normalizeOcrCandidate)
        .filter(Boolean);

    if (!normalized.length) return null;

    const counts = new Map();
    for (const partNumber of normalized) {
        counts.set(partNumber, (counts.get(partNumber) || 0) + 1);
    }

    for (const partNumber of normalized) {
        if (!isMoSiblingAmbiguous(partNumber, lookupLocation)) continue;

        const sibling = getMoSiblingPartNumber(partNumber);
        const emPart = partNumber.startsWith('EM') ? partNumber : sibling;
        const eoPart = partNumber.startsWith('EO') ? partNumber : sibling;
        const emCount = counts.get(emPart) || 0;
        const eoCount = counts.get(eoPart) || 0;

        if (emCount > 0 && eoCount > 0) {
            return eoCount >= emCount ? eoPart : emPart;
        }
    }

    let best = normalized[0];
    let bestCount = counts.get(best) || 0;
    for (const partNumber of normalized) {
        const count = counts.get(partNumber) || 0;
        if (count > bestCount) {
            best = partNumber;
            bestCount = count;
        }
    }

    return best;
}
