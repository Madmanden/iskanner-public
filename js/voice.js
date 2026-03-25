// Voice/Speech recognition module
import { VOICE_CONFIDENCE_THRESHOLD, VOICE_TIMEOUT_MS, VOICE_RESULT_DISPLAY_MS } from './config.js';
import { isLikelyPartNumberFormat, setButtonContents, lookupLocation } from './utils.js';
import { 
    updateStatus, 
    displayVoiceLookup, 
    showListeningFeedback, 
    showInterimTranscript, 
    showVoiceError,
    setOverlayScanning,
    removeOverlayScanning,
    clearOverlayFeedback
} from './ui.js';

// State
let recognition = null;
let isListening = false;
let lastHeardTranscript = '';
let didProcessVoiceResult = false;
let manualStopRequested = false;
let shouldResetStatusOnEnd = false;
let voiceTimeoutId = null;
let overlayFeedbackTimeoutId = null;

// DOM elements
let voiceBtn = null;
let overlayEl = null;

export function initVoiceElements(voiceBtnEl, overlay) {
    voiceBtn = voiceBtnEl;
    overlayEl = overlay;
}

export function isVoiceListening() {
    return isListening;
}

export function stopVoiceRecognition() {
    if (voiceBtn) {
        const previousTransition = voiceBtn.style.transition;
        const previousFilter = voiceBtn.style.filter;
        voiceBtn.style.transition = 'filter 0.12s ease';
        voiceBtn.style.filter = 'brightness(1.6) saturate(1.4)';
        setTimeout(() => {
            if (!voiceBtn) return;
            voiceBtn.style.filter = previousFilter;
            voiceBtn.style.transition = previousTransition;
        }, 180);
    }

    // Stop immediately from the app perspective (UI + state), then try to stop the engine.
    manualStopRequested = true;
    shouldResetStatusOnEnd = true;

    updateStatus('Stopper...', 'scanning');

    if (voiceTimeoutId) {
        clearTimeout(voiceTimeoutId);
        voiceTimeoutId = null;
    }

    if (isListening) {
        isListening = false;
        if (voiceBtn) {
            voiceBtn.classList.remove('active');
            setButtonContents(voiceBtn, '🎤', 'Tal');
        }
        removeOverlayScanning();
    }

    setTimeout(() => {
        if (!isListening) {
            updateStatus('Klar til scanning', 'ready');
        }
    }, 1600);

    if (!recognition) return;

    // Detach callbacks to prevent late events from updating UI after stop
    try {
        recognition.onresult = null;
        recognition.onerror = null;
        recognition.onstart = null;
        recognition.onend = null;
    } catch (e) {
    }

    // iOS Safari often requires abort() to truly end the capture session.
    try {
        recognition.abort();
        recognition = null;
        return;
    } catch (e) {
        // fall through
    }

    try {
        recognition.stop();
        recognition = null;
    } catch (e) {
    }
}

export function startVoiceRecognition() {
    if (recognition) {
        recognition.start();
    }
}

export function initSpeechRecognition() {
    if (recognition) {
        return true;
    }

    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
        if (voiceBtn) voiceBtn.style.display = 'none';
        return false;
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new SpeechRecognition();
    
    recognition.lang = 'da-DK';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 3;
    
    recognition.onstart = () => {
        isListening = true;
        didProcessVoiceResult = false;
        manualStopRequested = false;
        shouldResetStatusOnEnd = true;
        lastHeardTranscript = '';
        if (voiceBtn) {
            voiceBtn.classList.add('active');
            setButtonContents(voiceBtn, '🛑', 'Stop');
        }
        updateStatus('Lytter efter varenr...', 'scanning');
        setOverlayScanning();
        
        if (voiceTimeoutId) clearTimeout(voiceTimeoutId);
        voiceTimeoutId = setTimeout(() => {
            if (isListening) {
                manualStopRequested = true;
                recognition.stop();
            }
        }, VOICE_TIMEOUT_MS);
        
        showListeningFeedback();
    };
    
    recognition.onresult = (event) => {
        // Ignore any late results after the user pressed stop
        if (!isListening || manualStopRequested) return;

        let interimTranscript = '';
        let finalTranscript = '';
        
        for (let i = event.resultIndex; i < event.results.length; i++) {
            const result = event.results[i];
            const transcript = result[0].transcript;
            
            if (result.isFinal) {
                finalTranscript += transcript;
            } else {
                interimTranscript += transcript;
            }
        }
        
        if (interimTranscript) {
            lastHeardTranscript = interimTranscript;
            showInterimTranscript(interimTranscript);
        }
        
        if (finalTranscript) {
            lastHeardTranscript = finalTranscript;
            processFinalResults(event);
        }
    };

    function processFinalResults(event) {
        didProcessVoiceResult = true;
        shouldResetStatusOnEnd = false;
        const results = event.results[event.results.length - 1];
        let bestTranscript = null;
        let bestPartNumber = null;
        let bestScore = -Infinity;

        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            const transcript = (r && r.transcript ? r.transcript : '').trim();
            if (!transcript) continue;

            const confidence = typeof r.confidence === 'number' ? r.confidence : 0;
            const partNumber = normalizeVoicePartNumber(transcript);
            if (!partNumber) continue;

            const dbHit = lookupLocation(partNumber) ? 1 : 0;
            const patternHit = isLikelyPartNumberFormat(partNumber) ? 1 : 0;
            const sanitized = transcript.toUpperCase().replace(/[^A-Z0-9.\-]/g, '');
            const ratio = sanitized.length > 0 ? partNumber.length / sanitized.length : 1;

            let score = confidence;
            if (confidence < VOICE_CONFIDENCE_THRESHOLD) score -= 0.25;
            if (dbHit) score += 2.0;
            if (patternHit) score += 0.5;
            if (partNumber.length < 3) score -= 1.0;
            if (ratio < 0.6) score -= 0.25;

            if (score > bestScore) {
                bestScore = score;
                bestTranscript = transcript;
                bestPartNumber = partNumber;
            }
        }

        if (bestPartNumber) {
            displayVoiceLookup(bestPartNumber, bestTranscript);
        } else {
            displayVoiceLookup(null, null);
        }
        
        if (overlayFeedbackTimeoutId) clearTimeout(overlayFeedbackTimeoutId);
        overlayFeedbackTimeoutId = setTimeout(() => {
            clearOverlayFeedback();
        }, VOICE_RESULT_DISPLAY_MS);
    }

    recognition.onerror = (event) => {
        let errorMessage = 'Talegenkendelse fejlede';
        
        switch (event.error) {
            case 'no-speech':
                errorMessage = 'Ingen tale detekteret';
                break;
            case 'audio-capture':
                errorMessage = 'Mikrofon adgang nægtet';
                break;
            case 'not-allowed':
                errorMessage = 'Mikrofon adgang nægtet';
                break;
            case 'network':
                errorMessage = 'Netværksfejl';
                break;
            case 'service-not-allowed':
                errorMessage = 'Talegenkendelse ikke tilladt';
                break;
        }
        
        showVoiceError(errorMessage);
        
        if (overlayFeedbackTimeoutId) clearTimeout(overlayFeedbackTimeoutId);
        overlayFeedbackTimeoutId = setTimeout(() => {
            clearOverlayFeedback();
        }, VOICE_RESULT_DISPLAY_MS);
    };
    
    recognition.onend = () => {
        isListening = false;
        if (voiceTimeoutId) {
            clearTimeout(voiceTimeoutId);
            voiceTimeoutId = null;
        }
        if (voiceBtn) {
            voiceBtn.classList.remove('active');
            setButtonContents(voiceBtn, '🎤', 'Tal');
        }
        removeOverlayScanning();

        if (manualStopRequested && !didProcessVoiceResult) {
            shouldResetStatusOnEnd = false;
            const partNumber = normalizeVoicePartNumber(lastHeardTranscript);
            displayVoiceLookup(partNumber);
        }

        if (shouldResetStatusOnEnd) {
            updateStatus('Klar til scanning', 'ready');
        }
    };
    
    return true;
}

function normalizeVoicePartNumber(transcript) {
    const input = (transcript || '').trim().toUpperCase();
    if (!input) return null;

    const tokenized = input.replace(/[^A-Z0-9.\-\s]/g, ' ').trim();
    const tokens = tokenized ? tokenized.split(/\s+/).filter(Boolean) : [];

    const numberWords = {
        'NUL': '0',
        'NULL': '0',
        'BUL': '0',
        'BULL': '0',
        'ET': '1',
        'TO': '2',
        'TRE': '3',
        'FIRE': '4',
        'FEM': '5',
        'SEKS': '6',
        'SYV': '7',
        'OTTE': '8',
        'NI': '9',
        'ZERO': '0',
        'ONE': '1',
        'TWO': '2',
        'THREE': '3',
        'FOUR': '4',
        'FIVE': '5',
        'SIX': '6',
        'SEVEN': '7',
        'EIGHT': '8',
        'NINE': '9'
    };

    const letterWords = {
        'A': 'A',
        'BE': 'B',
        'CE': 'C',
        'DE': 'D',
        'E': 'E',
        'EF': 'F',
        'GE': 'G',
        'HÅ': 'H',
        'HA': 'H',
        'HO': 'H',
        'I': 'I',
        'J': 'J',
        'JOD': 'J',
        'KÅ': 'K',
        'KA': 'K',
        'KO': 'K',
        'EL': 'L',
        'EM': 'M',
        'EN': 'N',
        'O': 'O',
        'PE': 'P',
        'KU': 'Q',
        'ER': 'R',
        'HER': 'R',
        'ES': 'S',
        'TE': 'T',
        'U': 'U',
        'VE': 'V',
        'DOBBELT': 'W',
        'DOBBELTVE': 'W',
        'EKS': 'X',
        'X': 'X',
        'Y': 'Y',
        'SET': 'Z',
        'ZET': 'Z',
        'Æ': 'Æ',
        'Ø': 'Ø',
        'Å': 'Å',
        'ARR': 'R',
        'AIR': 'R',
        'ÆR': 'R',
        'ASS': 'S',
        'ARS': 'S',
        'EFF': 'F',
        'ELL': 'L',
        'EMM': 'M',
        'ENN': 'N',
        'BEE': 'B',
        'SEE': 'C',
        'DEE': 'D',
        'GEE': 'G',
        'PEE': 'P',
        'TEE': 'T',
        'VEE': 'V',
        'ZEE': 'Z'
    };

    const punctuationWords = {
        'PUNKT': '.',
        'PRIK': '.',
        'PUNKTUM': '.',
        'DOT': '.',
        'STREG': '-',
        'BINDESTREG': '-',
        'BINDSTREG': '-',
        'DASH': '-',
        'MINUS': '-'
    };

    function mapToken(token, hasDigit) {
        if (token === 'EN') return hasDigit ? 'N' : '1';
        if (numberWords[token]) return numberWords[token];
        if (letterWords[token]) return letterWords[token];
        if (punctuationWords[token]) return punctuationWords[token];
        if (/^[A-Z0-9.\-]+$/.test(token)) return token;
        return null;
    }

    if (tokens.length > 1) {
        let out = '';
        let hasDigit = false;
        for (const t of tokens) {
            const mapped = mapToken(t, hasDigit);
            if (!mapped) return null;
            out += mapped;
            if (/\d/.test(mapped)) hasDigit = true;
        }
        return out || null;
    }

    let raw = input;
    const embeddedRules = [
        ['BINDESTREG', '-'],
        ['BINDSTREG', '-'],
        ['PUNKTUM', '.'],
        ['PUNKT', '.'],
        ['PRIK', '.'],
        ['DOT', '.'],
        ['MINUS', '-'],
        ['DASH', '-'],
        ['STREG', '-'],
        ['NULL', '0'],
        ['NUL', '0'],
        ['BULL', '0'],
        ['BUL', '0'],
        ['ZERO', '0'],
        ['ONE', '1'],
        ['TWO', '2'],
        ['THREE', '3'],
        ['FOUR', '4'],
        ['FIVE', '5'],
        ['SIX', '6'],
        ['SEVEN', '7'],
        ['EIGHT', '8'],
        ['NINE', '9'],
        ['FIRE', '4'],
        ['FEM', '5'],
        ['SEKS', '6'],
        ['SYV', '7'],
        ['OTTE', '8'],
        ['NI', '9'],
        ['TRE', '3'],
        ['TO', '2'],
        ['ET', '1'],
        ['DOBBELTVE', 'W'],
        ['DOBBELT', 'W'],
        ['HER', 'R'],
        ['JOD', 'J'],
        ['SET', 'Z'],
        ['ZET', 'Z'],
        ['EKS', 'X'],
        ['HÅ', 'H'],
        ['HA', 'H'],
        ['HO', 'H'],
        ['KÅ', 'K'],
        ['KA', 'K'],
        ['KO', 'K'],
        ['KU', 'Q'],
        ['BE', 'B'],
        ['CE', 'C'],
        ['DE', 'D'],
        ['GE', 'G'],
        ['PE', 'P'],
        ['TE', 'T'],
        ['VE', 'V'],
        ['ER', 'R'],
        ['ES', 'S'],
        ['EF', 'F'],
        ['EL', 'L'],
        ['EM', 'M'],
        ['EN', '1'],
        ['ARR', 'R'],
        ['AIR', 'R'],
        ['ÆR', 'R'],
        ['ASS', 'S'],
        ['ARS', 'S'],
        ['EFF', 'F'],
        ['ELL', 'L'],
        ['EMM', 'M'],
        ['ENN', 'N'],
        ['BEE', 'B'],
        ['SEE', 'C'],
        ['DEE', 'D'],
        ['GEE', 'G'],
        ['PEE', 'P'],
        ['TEE', 'T'],
        ['VEE', 'V'],
        ['ZEE', 'Z']
    ];

    for (const [from, to] of embeddedRules) {
        raw = raw.replace(new RegExp(from, 'g'), to);
    }

    const result = raw.replace(/[^A-Z0-9.\-]/g, '');
    return result || null;
}
