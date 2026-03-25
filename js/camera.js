// Camera handling module
import { CAMERA_INACTIVITY_TIMEOUT_MS } from './config.js';
import { updateStatus, showError } from './ui.js';
import { isAndroid } from './utils.js';

// State
let stream = null;
let videoTrack = null;
let cameraInactivityTimeoutId = null;
let tapToFocusHandler = null;
let initPromise = null;

// DOM elements (set during init)
let video = null;
let zoomControls = null;
let zoomSlider = null;

async function applyTapToFocus(track) {
    if (!track) return;
    if (typeof track.getCapabilities !== 'function') return;

    const caps = track.getCapabilities();
    const supported = caps && Array.isArray(caps.focusMode) ? caps.focusMode : null;
    if (!supported || supported.length === 0) return;

    // Many Android devices support triggering an autofocus cycle via 'single-shot'.
    // We fall back to re-applying 'continuous' which sometimes also forces a refocus.
    const canSingleShot = supported.includes('single-shot');
    const canContinuous = supported.includes('continuous');

    try {
        if (canSingleShot) {
            try {
                await track.applyConstraints({ advanced: [{ focusMode: 'single-shot' }] });
            } catch (e) {
                await track.applyConstraints({ focusMode: 'single-shot' });
            }
        }
    } catch (e) {
    }

    if (!canContinuous) return;

    // Restore continuous focus after a short delay.
    setTimeout(async () => {
        try {
            try {
                await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
            } catch (e) {
                await track.applyConstraints({ focusMode: 'continuous' });
            }
        } catch (e2) {
        }
    }, 150);
}

function setupTapToFocus(track) {
    if (!video) return;
    if (!track) return;

    if (tapToFocusHandler) {
        try {
            video.removeEventListener('click', tapToFocusHandler);
        } catch (e) {
        }
    }

    tapToFocusHandler = () => {
        applyTapToFocus(track);
    };

    video.addEventListener('click', tapToFocusHandler);
}

async function applyAndroidCameraTuning(track) {
    if (!track) return;
    if (!isAndroid()) return;

    let caps = null;
    try {
        if (typeof track.getCapabilities === 'function') {
            caps = track.getCapabilities();
        }
    } catch (e) {
        caps = null;
    }

    const supportsExposureComp = !!(caps && caps.exposureCompensation);
    let exposureCompensation = null;
    if (supportsExposureComp) {
        const min = caps.exposureCompensation.min;
        const max = caps.exposureCompensation.max;
        const step = caps.exposureCompensation.step || 0.1;

        const preferred = -0.5;
        const clamped = Math.max(min, Math.min(max, preferred));
        exposureCompensation = Math.round(clamped / step) * step;
    }

    const constraints = {
        advanced: [
            {
                focusMode: 'continuous',
                exposureMode: 'continuous',
                whiteBalanceMode: 'continuous',
                ...(exposureCompensation === null ? {} : { exposureCompensation })
            }
        ]
    };

    try {
        await track.applyConstraints(constraints);
    } catch (e) {
        try {
            await track.applyConstraints({
                focusMode: 'continuous',
                exposureMode: 'continuous',
                whiteBalanceMode: 'continuous'
            });
        } catch (e2) {
        }
    }
}

export function initCameraElements(videoEl, zoomControlsEl, zoomSliderEl) {
    video = videoEl;
    zoomControls = zoomControlsEl;
    zoomSlider = zoomSliderEl;
}

export function getStream() {
    return stream;
}

export function getVideoTrack() {
    return videoTrack;
}

async function applyZoom(track, zoomValue) {
    try {
        await track.applyConstraints({ advanced: [{ zoom: zoomValue }] });
        return;
    } catch (e) {
        // fall through
    }
    await track.applyConstraints({ zoom: zoomValue });
}

function setupZoomControlsUnsupported() {
    if (!zoomControls || !zoomSlider) return;
    zoomControls.classList.remove('hidden');
    zoomSlider.min = '1';
    zoomSlider.max = '1';
    zoomSlider.step = '0.1';
    zoomSlider.value = '1';
    zoomSlider.disabled = true;
    zoomSlider.oninput = null;
}

function setupZoomControls() {
    if (!stream || !zoomControls || !zoomSlider) return;
    const tracks = stream.getVideoTracks();
    if (!tracks || tracks.length === 0) return;

    const track = tracks[0];
    if (!track || typeof track.getCapabilities !== 'function') return;

    const caps = track.getCapabilities();
    if (!caps || !caps.zoom) {
        setupZoomControlsUnsupported();
        return;
    }

    videoTrack = track;
    zoomControls.classList.remove('hidden');
    zoomSlider.disabled = false;

    const settings = typeof track.getSettings === 'function' ? track.getSettings() : {};
    const min = caps.zoom.min;
    const max = caps.zoom.max;
    const step = caps.zoom.step || 0.1;

    zoomSlider.min = String(min);
    zoomSlider.max = String(max);
    zoomSlider.step = String(step);
    zoomSlider.value = String(typeof settings.zoom === 'number' ? settings.zoom : min);

    zoomSlider.oninput = async () => {
        if (!videoTrack) return;
        const z = parseFloat(zoomSlider.value);
        if (!Number.isFinite(z)) return;
        try {
            await applyZoom(videoTrack, z);
        } catch (e) {
        }
    };
}

export async function initCamera() {
    // Return existing promise if already initializing
    if (initPromise) return initPromise;
    
    // If already initialized with stream, return resolved promise
    if (stream && video && video.readyState >= 2) {
        return Promise.resolve();
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showError('Kamera understøttes ikke i denne browser');
        return Promise.reject(new Error('Camera not supported'));
    }

    initPromise = _initCameraInternal();
    return initPromise;
}

async function _initCameraInternal() {
    try {
        const isAndroidDevice = isAndroid();

        const constraints = isAndroidDevice
            ? [
                { video: { facingMode: { exact: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } } },
                { video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } } },
                { video: { facingMode: { exact: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } },
                { video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } },
                { video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } },
                { video: true }
            ]
            : [
                { video: { facingMode: { exact: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } },
                { video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } } },
                { video: { width: { ideal: 1280 }, height: { ideal: 720 } } },
                { video: true }
            ];
        
        let lastError = null;
        for (const constraint of constraints) {
            try {
                stream = await navigator.mediaDevices.getUserMedia(constraint);
                video.srcObject = stream;

                try {
                    const tracks = stream.getVideoTracks();
                    if (tracks && tracks[0]) {
                        videoTrack = tracks[0];
                        await applyAndroidCameraTuning(tracks[0]);
                        setupTapToFocus(tracks[0]);
                    }
                } catch (e) {
                }

                setupZoomControls();
                if (zoomControls && zoomControls.classList.contains('hidden')) {
                    setupZoomControlsUnsupported();
                }
                
                // Wait for video to be ready
                await new Promise((resolve, reject) => {
                    if (video.readyState >= 2) {
                        resolve();
                    } else {
                        video.onloadedmetadata = () => resolve();
                        video.onerror = () => reject(new Error('Video load error'));
                        
                        // Timeout after 5 seconds
                        setTimeout(() => reject(new Error('Video load timeout')), 5000);
                    }
                });
                
                await video.play();
                updateStatus('Klar til scanning', 'ready');
                initPromise = null; // Clear after success
                return;
            } catch (error) {
                lastError = error;
            }
        }
        
        throw lastError || new Error('No camera constraints succeeded');
        
    } catch (error) {
        initPromise = null; // Clear on error
        showError('Ingen adgang til kamera. Aktiver kameraadgang i Indstillinger → Safari → Kamera.');
        updateStatus('Kamera-fejl', 'ready');
        throw error;
    }
}

export function stopCamera() {
    if (stream) {
        stream.getTracks().forEach(track => track.stop());
        stream = null;
        videoTrack = null;
    }

    if (tapToFocusHandler && video) {
        try {
            video.removeEventListener('click', tapToFocusHandler);
        } catch (e) {
        }
        tapToFocusHandler = null;
    }

    if (cameraInactivityTimeoutId) {
        clearTimeout(cameraInactivityTimeoutId);
        cameraInactivityTimeoutId = null;
    }
}

export function resetCameraInactivityTimer() {
    if (cameraInactivityTimeoutId) {
        clearTimeout(cameraInactivityTimeoutId);
    }
    if (stream) {
        cameraInactivityTimeoutId = setTimeout(() => {
            stopCamera();
            updateStatus('Kamera stoppet (inaktivitet)', 'ready');
        }, CAMERA_INACTIVITY_TIMEOUT_MS);
    }
}
