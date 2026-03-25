// Main application module
import { initCameraElements, initCamera, stopCamera, resetCameraInactivityTimer, getStream } from './camera.js';
import { initUIElements, updateStatus, showError, setOverlayFeedbackEnabled, setOverlayScanning, removeOverlayScanning, displayResult, displaySearchResults, setOverlaySuccess, setOverlayError, saveToHistory } from './ui.js';
import { initVoiceElements, initSpeechRecognition, isVoiceListening, stopVoiceRecognition, startVoiceRecognition } from './voice.js';
import { initOCRElements, scanPartNumber, getLastOcrTimings, getLastOcrModelInfo } from './ocr.js';
import { setButtonContents, lookupLocation, smartSearch } from './utils.js';
import { isAuthenticated, login, getDaysUntilExpiry } from './auth.js';

// State
let isScanning = false;

function mapProviderLabel(providerUsed) {
    const key = String(providerUsed || '').toLowerCase();
    if (key === 'hyperbolic') return 'Hyperbolic';
    if (key === 'openrouter') return 'OpenRouter';
    return providerUsed || null;
}

function mapModelLabel(modelUsed) {
    if (!modelUsed) return null;
    if (modelUsed === 'mistralai/Pixtral-12B-2409') return 'Pixtral';
    if (modelUsed === 'nvidia/NVIDIA-Nemotron-Nano-12B-v2-VL-BF16') return 'Nemotron';
    if (modelUsed === 'google/gemini-2.5-flash-lite') return 'Gemini 2.5 Flash Lite';
    return modelUsed;
}

function formatOcrModelStatus(modelInfo) {
    const modelLabel = mapModelLabel(modelInfo && modelInfo.modelUsed);
    const providerLabel = mapProviderLabel(modelInfo && modelInfo.providerUsed);
    if (!modelLabel) return 'Klar til scanning';

    const via = providerLabel ? ` (${providerLabel})` : '';
    const fellBack = !!(modelInfo && (modelInfo.fallbackUsed || modelInfo.providerFallbackUsed));
    return fellBack
        ? `Klar til scanning · OCR: ${modelLabel}${via} · fallback`
        : `Klar til scanning · OCR: ${modelLabel}${via}`;
}

// Initialize the application
function init() {
    // Get DOM elements
    const video = document.getElementById('video');
    const canvas = document.getElementById('canvas');
    const scanBtn = document.getElementById('scanBtn');
    const voiceBtn = document.getElementById('voiceBtn');
    const zoomControls = document.getElementById('zoomControls');
    const zoomSlider = document.getElementById('zoomSlider');
    const result = document.getElementById('result');
    const status = document.getElementById('status');
    const offlineBadge = document.getElementById('offlineBadge');
    const overlay = document.querySelector('.camera-overlay');
    const historyBtn = document.getElementById('historyBtn');
    const historyList = document.getElementById('historyList');
    const manualInput = document.getElementById('manualPartInput');
    const manualSearchBtn = document.getElementById('manualSearchBtn');
    const loginModal = document.getElementById('loginModal');
    const loginForm = document.getElementById('loginForm');
    const passwordInput = document.getElementById('passwordInput');
    const loginError = document.getElementById('loginError');

    // Check authentication and show login modal if needed
    function checkAuth() {
        if (!isAuthenticated()) {
            showLoginModal();
        } else {
            hideLoginModal();
            const daysLeft = getDaysUntilExpiry();
            if (daysLeft <= 3 && daysLeft > 0) {
                console.log(`[Auth] Session expires in ${daysLeft} days`);
            }
        }
    }

    function showLoginModal() {
        if (loginModal) {
            loginModal.classList.remove('hidden');
            if (passwordInput) passwordInput.focus();
        }
    }

    function hideLoginModal() {
        if (loginModal) {
            loginModal.classList.add('hidden');
            if (loginError) loginError.classList.add('hidden');
            if (passwordInput) passwordInput.value = '';
        }
    }

    // Login form handler
    if (loginForm) {
        loginForm.onsubmit = async function(e) {
            e.preventDefault();

            const password = passwordInput?.value || '';
            if (!password) return;

            // Show loading state
            const submitBtn = loginForm.querySelector('button[type="submit"]');
            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.querySelector('.btn-label').textContent = 'Logger ind...';
            }

            // Hide previous errors
            if (loginError) loginError.classList.add('hidden');

            // Attempt login
            const loginResult = await login(password);

            console.log('[App] Login result:', loginResult);

            if (loginResult.success) {
                console.log('[App] Login successful, hiding modal');
                hideLoginModal();
                updateStatus('Login vellykket', 'ready');
            } else {
                console.log('[App] Login failed:', loginResult.message);
                if (loginError) {
                    loginError.textContent = loginResult.message;
                    loginError.classList.remove('hidden');
                }
            }

            // Reset button state
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.querySelector('.btn-label').textContent = 'Log ind';
            }
        };
    }

    // Check authentication on startup
    checkAuth();

    // Initialize modules with DOM elements
    initCameraElements(video, zoomControls, zoomSlider);
    initUIElements(result, status, overlay, historyList, historyBtn);
    initVoiceElements(voiceBtn, overlay);
    initOCRElements(video, canvas, overlay);
    
    // Fallback database if external file doesn't load
    if (typeof partsDatabase === 'undefined') {
        window.partsDatabase = {
            '12345': 'Skab 78, højre række 4',
            '67890': 'Skab 45, venstre række 2',
            '11111': 'Skab 23, midten række 1',
        };
    }
    
    // Scan button handler
    scanBtn.onclick = async function() {
        // Lazy init: start camera on first scan if not running
        if (!getStream()) {
            try {
                await initCamera();
                // Camera is now ready, inform user to scan again
                resetCameraInactivityTimer();
                updateStatus('Kamera klar - tryk igen for at skanne', 'ready');
                return;
            } catch (e) {
                // Camera init failed, error is already shown by initCamera
                return;
            }
        }

        resetCameraInactivityTimer();

        setOverlayFeedbackEnabled(true);
        
        if (isScanning) return;
        
        isScanning = true;
        scanBtn.disabled = true;
        setButtonContents(scanBtn, '⏳', 'Scanner...');
        setOverlayScanning();

        const scanStartedAt = (typeof performance !== 'undefined' && typeof performance.now === 'function')
            ? performance.now()
            : Date.now();

        try {
            await scanPartNumber();
        } catch (error) {
            // Check if error is due to authentication (401 status)
            if (error && error.status === 401) {
                showLoginModal();
                showError('Log venligst ind igen');
            }
        }

        const scanFinishedAt = (typeof performance !== 'undefined' && typeof performance.now === 'function')
            ? performance.now()
            : Date.now();
        const elapsedMs = Math.max(0, Math.round(scanFinishedAt - scanStartedAt));

        const { ocrNetworkMs, ocrPayloadBytes } = getLastOcrTimings();
        const ocrMs = Math.max(0, Math.round(ocrNetworkMs || 0));
        const capturePrepMs = Math.max(0, elapsedMs - ocrMs);
        const payloadKb = ocrPayloadBytes ? Math.max(0, Math.round(ocrPayloadBytes / 1024)) : 0;
        const modelInfo = getLastOcrModelInfo();

        isScanning = false;
        scanBtn.disabled = false;
        setButtonContents(scanBtn, '📷', 'Skan');
        removeOverlayScanning();
        updateStatus(formatOcrModelStatus(modelInfo), 'ready');
    };
    
    // Voice button handler
    voiceBtn.onclick = function() {
        if (isVoiceListening()) {
            stopVoiceRecognition();
            return;
        }

        if (!initSpeechRecognition()) {
            showError('Talegenkendelse understøttes ikke i denne browser');
            return;
        }

        setOverlayFeedbackEnabled(true);
        startVoiceRecognition();
    };
    
    // Manual input handler
    function performManualLookup() {
        if (!manualInput) return;
        const partNumber = manualInput.value.trim().toUpperCase();
        if (!partNumber) return;

        setOverlayFeedbackEnabled(false);

        // Use smart search to find exact matches, prefixes, or fuzzy matches (top 3 results)
        const searchResult = smartSearch(partNumber, 3);

        if (searchResult.exactMatch) {
            // Exact match found
            const { partNumber: foundPart, location } = searchResult.exactMatch;
            displayResult(foundPart, location);
            saveToHistory(foundPart, location);
            setOverlaySuccess();
            updateStatus('Fundet: ' + foundPart, 'ready');
        } else if (searchResult.results && searchResult.results.length > 0) {
            // Multiple matches found (prefix, fuzzy, or substring)
            displaySearchResults(searchResult);
            setOverlaySuccess();
            const count = searchResult.results.length;
            const strategyText = {
                'prefix': 'starter med',
                'fuzzy': 'lignende',
                'substring': 'indeholder'
            }[searchResult.strategy] || 'matcher';
            updateStatus(`${count} ${strategyText} "${partNumber}"`, 'ready');
        } else {
            // No matches found
            displayResult(partNumber, null);
            setOverlayError();
            updateStatus('Ikke fundet: ' + partNumber, 'ready');
        }

        manualInput.value = '';
        manualInput.blur();
    }
    
    if (manualInput) {
        manualInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                performManualLookup();
            }
        });
    }
    
    if (manualSearchBtn) {
        manualSearchBtn.addEventListener('click', performManualLookup);
        manualSearchBtn.addEventListener('touchend', (e) => {
            e.preventDefault();
            performManualLookup();
        });
    }
    
    // Pause camera when tab is hidden (battery optimization)
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            stopCamera();
        }
    });
    
    // Cleanup on unload
    window.addEventListener('beforeunload', () => {
        stopCamera();
    });
    
    // Initialize speech recognition
    initSpeechRecognition();

    function updateOfflineBadge() {
        if (!offlineBadge) return;
        if (navigator.onLine) {
            offlineBadge.classList.add('hidden');
        } else {
            offlineBadge.classList.remove('hidden');
        }
    }

    updateOfflineBadge();
    window.addEventListener('online', updateOfflineBadge);
    window.addEventListener('offline', updateOfflineBadge);
}

// Start app when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        const isStandalone =
            (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
            (typeof navigator !== 'undefined' && navigator.standalone === true);

        if (!isStandalone) {
            return;
        }

        navigator.serviceWorker.register('/sw.js').catch(() => {
            // no-op
        });
    });
}
