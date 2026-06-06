import { describe, expect, it } from 'bun:test';
import {
    chooseOcrConsensusPartNumber,
    getMoSiblingPartNumber,
    isMoSiblingAmbiguous
} from '../js/ocr-selection.js';

const mockPartsDatabase = {
    EM125R: 'BestilViaRep',
    EO125R: 'Skab78VenstreRække1',
    BM067R: 'Cabinet A, Drawer 1',
};

const lookupLocation = (key) => mockPartsDatabase[key] || null;

describe('OCR M/O ambiguity selection', () => {
    it('finds EM/EO sibling part numbers', () => {
        expect(getMoSiblingPartNumber('EM125R')).toBe('EO125R');
        expect(getMoSiblingPartNumber('EO125R')).toBe('EM125R');
        expect(getMoSiblingPartNumber('BM067R')).toBeNull();
    });

    it('flags only valid EM/EO sibling pairs as ambiguous', () => {
        expect(isMoSiblingAmbiguous('EM125R', lookupLocation)).toBe(true);
        expect(isMoSiblingAmbiguous('EO125R', lookupLocation)).toBe(true);
        expect(isMoSiblingAmbiguous('BM067R', lookupLocation)).toBe(false);
    });

    it('prefers EO when ambiguous attempts disagree and counts tie', () => {
        const selected = chooseOcrConsensusPartNumber(['EM125R', 'EO125R'], lookupLocation);
        expect(selected).toBe('EO125R');
    });

    it('keeps EM when every ambiguous attempt reads EM', () => {
        const selected = chooseOcrConsensusPartNumber(['EM125R', 'EM125R'], lookupLocation);
        expect(selected).toBe('EM125R');
    });

    it('keeps normal non-ambiguous successful reads', () => {
        const selected = chooseOcrConsensusPartNumber(['BM067R'], lookupLocation);
        expect(selected).toBe('BM067R');
    });
});
