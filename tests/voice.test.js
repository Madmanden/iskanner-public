import { describe, expect, it } from 'bun:test';
import { normalizeVoicePartNumber } from '../js/voice.js';

describe('Voice Part Number Normalization', () => {
    it('should normalize Danish spoken letter words', () => {
        expect(normalizeVoicePartNumber('be em nul seks syv er')).toBe('BM067R');
        expect(normalizeVoicePartNumber('pe te ve es')).toBe('PTVS');
        expect(normalizeVoicePartNumber('el em en')).toBe('LM1');
        expect(normalizeVoicePartNumber('set')).toBe('Z');
    });

    it('should normalize alternate zero words', () => {
        expect(normalizeVoicePartNumber('en null null')).toBe('100');
        expect(normalizeVoicePartNumber('en nul nul')).toBe('100');
    });

    it('should treat EN as N after raw numeric tokens', () => {
        expect(normalizeVoicePartNumber('BM 067 EN')).toBe('BM067N');
        expect(normalizeVoicePartNumber('BM 067 en')).toBe('BM067N');
    });
});
