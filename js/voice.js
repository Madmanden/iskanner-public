// Voice/Speech recognition module
import { VOICE_CONFIDENCE_THRESHOLD, VOICE_TIMEOUT_MS, VOICE_RESULT_DISPLAY_MS } from './config.js';
import { isLikelyPartNumberFormat, setButtonContents, lookupLocation, findClosestPartNumber } from './utils.js';
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
let audioStream = null;

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

    // Release audio processing stream if held
    if (audioStream) {
        audioStream.getTracks().forEach(track => track.stop());
        audioStream = null;
    }

    if (!recognition) return;

    // Detach callbacks to prevent late events from updating UI after stop.
    // Keep onend attached so it can fire after abort()/stop() and clear
    // the listening UI (spinner, result div).
    try {
        recognition.onresult = null;
        recognition.onerror = null;
        recognition.onstart = null;
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

export async function startVoiceRecognition() {
    manualStopRequested = false;
    await activateAudioProcessing();
    if (manualStopRequested) {
        releaseAudioProcessing();
        return;
    }
    if (recognition) {
        recognition.start();
    }
}

async function activateAudioProcessing() {
    // Release any stale stream first
    if (audioStream) {
        audioStream.getTracks().forEach(track => track.stop());
        audioStream = null;
    }

    try {
        audioStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
            }
        });
        // Holding this stream keeps the browser's hardware DSP active
        // (noise suppression, echo cancellation, auto gain).
        // SpeechRecognition picks up the processed audio implicitly.
    } catch (e) {
        // Non-fatal: recognition still works, just without DSP assist
        audioStream = null;
    }
}

function releaseAudioProcessing() {
    if (audioStream) {
        audioStream.getTracks().forEach(track => track.stop());
        audioStream = null;
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
    recognition.maxAlternatives = 5;
    
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
            // Reset the timeout — give the user a full silence window, not a hard cap
            if (voiceTimeoutId) {
                clearTimeout(voiceTimeoutId);
            }
            voiceTimeoutId = setTimeout(() => {
                if (isListening) {
                    manualStopRequested = true;
                    recognition.stop();
                }
            }, VOICE_TIMEOUT_MS);
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
        let bestOriginalPartNumber = null;
        let bestConfidence = 0;
        let bestScore = -Infinity;

        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            const transcript = (r && r.transcript ? r.transcript : '').trim();
            if (!transcript) continue;

            const confidence = typeof r.confidence === 'number' ? r.confidence : 0;

            // Reject noise-like transcripts before spending time on normalization
            if (transcript.length <= 1) continue;
            if (transcript.length > 30) continue;
            if (/(.)\1{4,}/.test(transcript)) continue;
            if (transcript.split(/\s+/).filter(Boolean).length > 8) continue;

            const partNumber = normalizeVoicePartNumber(transcript);
            if (!partNumber) continue;

            // Try exact DB lookup first, then fuzzy (1-char tolerance)
            let matchedDbKey = null;
            let dbHit = 0;
            const exactLocation = lookupLocation(partNumber);
            if (exactLocation) {
                dbHit = 1;
                matchedDbKey = partNumber;
            } else {
                const fuzzyKey = findClosestPartNumber(partNumber, 1);
                if (fuzzyKey) {
                    dbHit = 1;
                    matchedDbKey = fuzzyKey;
                }
            }

            const patternHit = isLikelyPartNumberFormat(partNumber) ? 1 : 0;
            const sanitized = transcript.toUpperCase().replace(/[^A-Z0-9.\-]/g, '');
            const ratio = sanitized.length > 0 ? partNumber.length / sanitized.length : 1;

            let score = confidence;
            if (dbHit) {
                score += 2.0;
                // Be lenient with DB matches at moderate confidence,
                // but reject outright if confidence is too low
                if (confidence < 0.4) {
                    score -= 99;
                } else if (confidence < VOICE_CONFIDENCE_THRESHOLD) {
                    score -= 0.15;
                }
            } else {
                // No DB match: penalize harder for low confidence
                if (confidence < VOICE_CONFIDENCE_THRESHOLD) score -= 0.50;
            }
            if (patternHit) score += 0.5;
            if (partNumber.length < 3) score -= 1.0;
            if (ratio < 0.6) score -= 0.25;

            if (score > bestScore) {
                bestScore = score;
                bestTranscript = transcript;
                bestPartNumber = matchedDbKey || partNumber;
                bestOriginalPartNumber = partNumber;
                bestConfidence = confidence;
            }
        }

        if (bestPartNumber) {
            // For low-confidence fuzzy matches, pass the original (uncorrected)
            // part number so displayVoiceLookup shows a "Mente du?" suggestion
            // instead of treating it as a definitive find.
            const isFuzzyCorrection = bestOriginalPartNumber && bestPartNumber !== bestOriginalPartNumber;
            const displayKey = (isFuzzyCorrection && bestConfidence < VOICE_CONFIDENCE_THRESHOLD)
                ? bestOriginalPartNumber
                : bestPartNumber;
            displayVoiceLookup(displayKey, bestTranscript);
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
        releaseAudioProcessing();
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
            if (partNumber) {
                // Apply same fuzzy logic as scoring pipeline
                const exactLocation = lookupLocation(partNumber);
                const fuzzyKey = !exactLocation ? findClosestPartNumber(partNumber, 1) : null;
                const displayKey = fuzzyKey || partNumber;
                displayVoiceLookup(displayKey, lastHeardTranscript);
            } else {
                displayVoiceLookup(null, null);
            }
        }

        if (shouldResetStatusOnEnd) {
            updateStatus('Klar til scanning', 'ready');
        }
    };
    
    return true;
}

export function normalizeVoicePartNumber(transcript) {
    const input = (transcript || '').trim().toUpperCase();
    if (!input) return null;

    const raw = input.replace(/[^A-Z0-9.\-\s]/g, ' ').trim();
    const tokens = raw.split(/\s+/).filter(Boolean);

    // Unified recognition rules, ordered by priority (longest first)
    // Format: [spoken, replacement]
    const rules = [
        // Danish multi-char sounds
        ['DOBBELTVE', 'W'], ['DOBBELT', 'W'], ['BINDESTREG', '-'], ['BINDSTREG', '-'],
        ['PUNKTUM', '.'], ['STREG', '-'],
        // Danish letters
        ['JOD', 'J'], ['ZET', 'Z'], ['SET', 'Z'], ['EKS', 'X'], ['HÅ', 'H'], ['KÅ', 'K'], ['ÆR', 'R'],
        ['ARR', 'R'], ['AIR', 'R'], ['ASS', 'S'], ['ARS', 'S'],
        // Double-letter forms (must come before single-letter to avoid partial match)
        ['ENN', 'N'], ['EMM', 'M'], ['ELL', 'L'], ['EFF', 'F'],
        ['BEE', 'B'], ['SEE', 'C'], ['DEE', 'D'], ['GEE', 'G'],
        ['PEE', 'P'], ['TEE', 'T'], ['VEE', 'V'], ['ZEE', 'Z'],
        // Danish letters
        ['HO', 'H'], ['HA', 'H'],
        ['KO', 'K'], ['KA', 'K'], ['KU', 'Q'],
        ['HER', 'R'], ['ER', 'R'],
        ['GE', 'G'],
        ['EL', 'L'], ['EM', 'M'],
        ['PE', 'P'], ['TE', 'T'], ['VE', 'V'], ['ES', 'S'],
        ['Æ', 'Æ'], ['Ø', 'Ø'], ['Å', 'Å'],
        // Punctuation
        ['PRIK', '.'], ['PUNKT', '.'], ['DOT', '.'], ['MINUS', '-'], ['DASH', '-'],
        // Danish numbers
        ['NULL', '0'], ['NUL', '0'], ['BULL', '0'], ['BUL', '0'],
        ['TRE', '3'], ['FIRE', '4'], ['FEM', '5'], ['SEKS', '6'],
        ['SYV', '7'], ['OTTE', '8'], ['NI', '9'], ['TO', '2'], ['ET', '1'],
        // English numbers
        ['ZERO', '0'], ['ONE', '1'], ['TWO', '2'], ['THREE', '3'],
        ['FOUR', '4'], ['FIVE', '5'], ['SIX', '6'],
        ['SEVEN', '7'], ['EIGHT', '8'], ['NINE', '9'],
        // Single-char letter forms (before general letter mappings)
        ['A', 'A'], ['BE', 'B'], ['CE', 'C'], ['DE', 'D'],
        ['E', 'E'], ['EF', 'F'], ['I', 'I'], ['J', 'J'],
        ['L', 'L'], ['M', 'M'], ['N', 'N'], ['O', 'O'],
        ['P', 'P'], ['R', 'R'], ['S', 'S'], ['T', 'T'],
        ['U', 'U'], ['V', 'V'], ['X', 'X'], ['Y', 'Y'],
        // Single-char number forms
        ['0', '0'], ['1', '1'], ['2', '2'], ['3', '3'],
        ['4', '4'], ['5', '5'], ['6', '6'],
        ['7', '7'], ['8', '8'], ['9', '9'],
    ];

    function findRule(token) {
        for (const [from, to] of rules) {
            if (token === from) return to;
        }
        return null;
    }

    function applyRules(str) {
        let result = str;
        for (const [from, to] of rules) {
            result = result.replace(new RegExp(from, 'g'), to);
        }
        return result;
    }

    if (tokens.length > 1) {
        let out = '';
        let hasDigit = false;
        for (const t of tokens) {
            // Context-sensitive: 'EN' after a digit = 'N', otherwise = '1'
            if (t === 'EN') {
                out += hasDigit ? 'N' : '1';
                hasDigit = true;
                continue;
            }
            const mapped = findRule(t);
            if (!mapped) {
                // Allow raw alphanumeric tokens through
                if (/^[A-Z0-9.\-]+$/.test(t)) {
                    out += t;
                    if (/\d/.test(t)) hasDigit = true;
                } else {
                    return null;
                }
            } else {
                out += mapped;
                if (/\d/.test(mapped)) hasDigit = true;
            }
        }
        return out || null;
    }

    // Single token: apply rules then extract valid chars
    let result = applyRules(raw);
    // Context-sensitive EN handling (EN can appear mid-token as 'N')
    if (result.includes('EN')) {
        result = result.replace(/EN/g, 'N');
    }
    result = result.replace(/[^A-Z0-9.\-]/g, '');
    return result || null;
}
