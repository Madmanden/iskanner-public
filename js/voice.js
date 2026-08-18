// Voice/Speech recognition module
import { VOICE_CONFIDENCE_THRESHOLD, VOICE_TIMEOUT_MS, VOICE_RESULT_DISPLAY_MS } from './config.js';
import { isLikelyPartNumberFormat, setButtonContents, lookupLocation } from './utils.js';
import { recordVoiceSelection, resolveVoicePartNumber } from './voice-lookup.js';
import {
    updateStatus,
    displayResult,
    displayVoiceLookup,
    showListeningFeedback,
    showInterimTranscript,
    showVoiceError,
    setOverlayScanning,
    removeOverlayScanning,
    setOverlayError,
    clearOverlayFeedback
} from './ui.js';

// State
let recognition = null;
let isListening = false;
let lastHeardTranscript = '';
let didProcessVoiceResult = false;
let voiceErrorShown = false;
let manualStopRequested = false;
let shouldResetStatusOnEnd = false;
let isStarting = false;
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

function scheduleOverlayCleanup() {
    if (overlayFeedbackTimeoutId) clearTimeout(overlayFeedbackTimeoutId);
    overlayFeedbackTimeoutId = setTimeout(() => {
        clearOverlayFeedback();
    }, VOICE_RESULT_DISPLAY_MS);
}

function wireVoiceCandidateButtons(sourcePartNumber, transcript) {
    if (typeof document === 'undefined') return;

    const wire = (btn) => {
        if (!btn) return;
        btn.onclick = () => {
            const suggested = (btn.dataset.suggest || '').trim().toUpperCase();
            if (!suggested) return;
            const location = lookupLocation(suggested);
            if (!location) return;

            recordVoiceSelection(sourcePartNumber, suggested);
            displayVoiceLookup(suggested, transcript);
        };
    };

    document.querySelectorAll('.ocr-suggestion-btn').forEach(wire);
    wire(document.getElementById('ocrSuggestionBtn'));
}

function presentVoiceResolution(resolution, transcript, sourcePartNumber) {
    if (!resolution) {
        displayVoiceLookup(null, null);
        return false;
    }

    if (resolution.kind === 'exact' || resolution.kind === 'corrected') {
        displayVoiceLookup(resolution.partNumber, transcript);
        return true;
    }

    if (resolution.kind === 'suggestion') {
        displayResult(resolution.partNumber, null, null, { suggestions: resolution.candidates });
        wireVoiceCandidateButtons(sourcePartNumber, transcript);
        setOverlayError();
        updateStatus('Vælg det rigtige varenr.', 'ready');
        return false;
    }

    displayResult(resolution.partNumber, null, null, { suggestions: [] });
    setOverlayError();
    updateStatus('Klar til scanning', 'ready');
    return false;
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

    // Detach callbacks to prevent late events from updating UI after stop / a completed final result.
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

export function startVoiceRecognition() {
    if (!recognition || isListening || isStarting) return;
    manualStopRequested = false;
    isStarting = true;
    try {
        recognition.start();
    } catch (e) {
        isStarting = false;
        showVoiceError('Talegenkendelse fejlede');
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
        isStarting = false;
        isListening = true;
        didProcessVoiceResult = false;
        voiceErrorShown = false;
        manualStopRequested = false;
        shouldResetStatusOnEnd = true;
        lastHeardTranscript = '';
        if (overlayFeedbackTimeoutId) {
            clearTimeout(overlayFeedbackTimeoutId);
            overlayFeedbackTimeoutId = null;
        }
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
        // Ignore late or duplicate results after stop / a completed final result.
        if (!isListening || manualStopRequested || didProcessVoiceResult) return;

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
            // Reset the timeout — give the user a full silence window, not a hard cap.
            if (voiceTimeoutId) clearTimeout(voiceTimeoutId);
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
        let bestSourcePartNumber = null;
        let bestResolution = null;
        let bestScore = -Infinity;

        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            const transcript = (r && r.transcript ? r.transcript : '').trim();
            if (!transcript) continue;

            const confidence = typeof r.confidence === 'number' ? r.confidence : 0;

            // Reject noise-like transcripts before spending time on normalization.
            if (transcript.length <= 1) continue;
            if (transcript.length > 30) continue;
            if (/(.)\1{4,}/.test(transcript)) continue;
            if (transcript.split(/\s+/).filter(Boolean).length > 8) continue;

            const partNumber = normalizeVoicePartNumber(transcript);
            if (!partNumber) continue;

            const resolution = resolveVoicePartNumber(partNumber, confidence);
            const patternHit = isLikelyPartNumberFormat(partNumber) ? 1 : 0;
            const sanitized = transcript.toUpperCase().replace(/[^A-Z0-9.\-]/g, '');
            const ratio = sanitized.length > 0 ? partNumber.length / sanitized.length : 1;

            let score = confidence;
            if (resolution.kind === 'exact') score += 3.0;
            if (resolution.kind === 'corrected') score += 2.5;
            if (resolution.kind === 'suggestion') score += 2.0;
            if (resolution.learned) score += 0.4;
            if (patternHit) score += 0.5;
            if (partNumber.length < 3) score -= 1.0;
            if (ratio < 0.6) score -= 0.25;

            // Preserve the previous DB-backed confidence ranking: exact,
            // corrected and ambiguous database candidates all count as DB evidence.
            const hasDatabaseEvidence = resolution.kind === 'exact'
                || resolution.kind === 'corrected'
                || resolution.kind === 'suggestion';
            if (hasDatabaseEvidence && confidence < 0.4) {
                score -= 99;
            } else if (hasDatabaseEvidence && confidence < VOICE_CONFIDENCE_THRESHOLD) {
                score -= 0.15;
            } else if (!hasDatabaseEvidence && confidence < VOICE_CONFIDENCE_THRESHOLD) {
                score -= 0.5;
            }

            if (score > bestScore) {
                bestScore = score;
                bestTranscript = transcript;
                bestSourcePartNumber = partNumber;
                bestResolution = resolution;
            }
        }

        if (bestResolution) {
            const resolvedSafely = presentVoiceResolution(bestResolution, bestTranscript, bestSourcePartNumber);
            if (resolvedSafely && recognition && isListening) {
                // We already have a trusted database result. End capture now rather
                // than waiting for the browser's natural end/timeout.
                try {
                    recognition.stop();
                } catch (e) {}
            }
        } else {
            displayVoiceLookup(null, null);
        }

        scheduleOverlayCleanup();
    }

    recognition.onerror = (event) => {
        isStarting = false;
        voiceErrorShown = true;
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
        scheduleOverlayCleanup();
    };

    const boundRecognition = recognition;
    recognition.onend = () => {
        // Ignore stale onend from a previous recognition instance,
        // but allow it when recognition was cleared to null by stopVoiceRecognition.
        if (recognition && boundRecognition !== recognition) return;

        isStarting = false;
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

        if (!didProcessVoiceResult && !voiceErrorShown) {
            const partNumber = normalizeVoicePartNumber(lastHeardTranscript);
            if (partNumber) {
                shouldResetStatusOnEnd = false;
                // No reliable confidence exists for an interim/manual-stop fallback,
                // so only exact hits can auto-resolve; corrections remain choices.
                const resolution = resolveVoicePartNumber(partNumber, 0);
                presentVoiceResolution(resolution, lastHeardTranscript, partNumber);
                scheduleOverlayCleanup();
            } else if (lastHeardTranscript) {
                shouldResetStatusOnEnd = false;
                displayVoiceLookup(null, null);
            } else {
                showVoiceError('Ingen tale detekteret');
                scheduleOverlayCleanup();
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
