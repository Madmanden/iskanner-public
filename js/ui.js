// UI and display functions
import { OVERLAY_FEEDBACK_MS, MAX_RECENT_LOOKUPS } from './config.js';
import { escapeHtml, findClosestPartNumber, lookupLocation } from './utils.js';
// State
let overlayFeedbackTimeoutId = null;

// DOM elements (set during init)
let resultEl = null;
let statusEl = null;
let overlayEl = null;
let historyListEl = null;
let historyBtnEl = null;
let historyVisible = false;

let overlayFeedbackEnabled = true;

const HISTORY_SORT_KEY = 'historySortMode';

export function initUIElements(result, status, overlay, historyList, historyBtn) {
    resultEl = result;
    statusEl = status;
    overlayEl = overlay;
    historyListEl = historyList;
    historyBtnEl = historyBtn;
    
    if (historyBtnEl) {
        historyBtnEl.onclick = toggleHistory;
    }
}

export function setOverlayFeedbackEnabled(enabled) {
    overlayFeedbackEnabled = Boolean(enabled);
    if (!overlayFeedbackEnabled) {
        clearOverlayFeedback();
    }
}

export function updateStatus(text, type) {
    if (statusEl) {
        statusEl.textContent = text;
        statusEl.className = `status-indicator status-${type}`;
    }
}


function setSearchResultsLayout(enabled) {
    if (!resultEl) return;
    const isEnabled = Boolean(enabled);
    resultEl.classList.toggle('search-results-mode', isEnabled);

    const resultSectionEl = resultEl.closest('.result-section');
    if (resultSectionEl) {
        resultSectionEl.classList.toggle('search-results-mode', isEnabled);
    }
}

export function showError(message) {
    if (resultEl) {
        setSearchResultsLayout(false);
        resultEl.innerHTML = `<div class="error">${escapeHtml(message)}</div>`;
    }
}

async function submitWrongLocationReport(payload) {
    const formData = new FormData();
    formData.append('form-name', 'wrong-location-reports');

    formData.append('timestamp', payload.createdAtIso || new Date().toISOString());
    formData.append('partNumber', payload.partNumber || '');
    formData.append('shownLocation', payload.shownLocation || '');
    formData.append('locationOrNote', payload.locationOrNote || '');
    formData.append('source', payload.source || '');
    formData.append('userAgent', payload.userAgent || '');

    const res = await fetch('/', {
        method: 'POST',
        body: formData
    });

    if (!res.ok) {
        throw new Error('Report failed');
    }
}

function wireWrongLocationReportButton(options) {
    const btn = document.getElementById('wrongLocationBtn');
    if (!btn) return;

    btn.onclick = async () => {
        const input = window.prompt('Ny placering eller note:', '');
        if (input === null) return;

        const locationOrNote = (input || '').trim();
        if (!locationOrNote) return;

        const payload = {
            partNumber: options.partNumber,
            shownLocation: options.location,
            locationOrNote,
            source: options.source,
            createdAtIso: new Date().toISOString(),
            userAgent: (typeof navigator !== 'undefined' ? navigator.userAgent : '')
        };

        try {
            await submitWrongLocationReport(payload);
            updateStatus('Tak! Rapport sendt.', 'ready');
        } catch (e) {
            updateStatus('Kunne ikke sende rapport (kontakt admin).', 'ready');
        }
    };
}

export function displayResult(partNumber, location, ocrRaw = null) {
    if (!resultEl) return;

    setSearchResultsLayout(false);
    
    if (location) {
        resultEl.innerHTML = `
            <div>
                <div class="result-text"><span class="instrument-number">${escapeHtml(partNumber)}</span></div>
                <div class="result-location">📍 ${escapeHtml(location)}</div>
                <button class="report-btn" id="wrongLocationBtn">Forkert placering?</button>
            </div>
        `;

        wireWrongLocationReportButton({ partNumber, location, source: 'ocr_or_manual' });
    } else {
        const cleaned = (partNumber || '').trim().toUpperCase();
        const ocrRawCleaned = (ocrRaw || '').trim();
        const suggestion = cleaned ? findClosestPartNumber(cleaned) : null;
        resultEl.innerHTML = `
            <div class="error">
                Varenummer ikke fundet i databasen
            </div>
            ${ocrRawCleaned ? `<div class="result-text" style="margin-top: 8px;"><span style="color: #64748B; font-weight: 600;">OCR:</span> <span class="instrument-number">${escapeHtml(ocrRawCleaned)}</span></div>` : ''}
            ${suggestion ? `<button class="suggestion-btn" id="ocrSuggestionBtn" data-suggest="${escapeHtml(suggestion)}">Mente du: ${escapeHtml(suggestion)}?</button>` : ''}
        `;

        const btn = document.getElementById('ocrSuggestionBtn');
        if (btn) {
            btn.onclick = () => {
                const suggested = btn.dataset.suggest;
                if (!suggested) return;
                const suggestedLocation = lookupLocation(suggested);
                if (suggestedLocation) {
                    displayResult(suggested, suggestedLocation);
                    setOverlaySuccess();
                    saveToHistory(suggested, suggestedLocation);
                }
            };
        }
    }
}

export function displayVoiceLookup(partNumber, originalTranscript = null) {
    if (!resultEl) return;

    setSearchResultsLayout(false);
    
    const cleaned = (partNumber || '').trim().toUpperCase();
    if (!cleaned) {
        resultEl.innerHTML = `
            <div class="error">
                Sig kun bogstaver og tal (og evt. punktum/bindestreg), fx BM067R eller 100.300.
            </div>
        `;
        setOverlayError();
        updateStatus('Klar til scanning', 'ready');
        return;
    }

    const location = lookupLocation(cleaned);
    if (location) {
        resultEl.innerHTML = `
            <div>
                <div class="result-text"><span class="instrument-number">${escapeHtml(cleaned)}</span></div>
                <div class="result-location">📍 ${escapeHtml(location)}</div>
                <button class="report-btn" id="wrongLocationBtn">Forkert placering?</button>
            </div>
        `;

        wireWrongLocationReportButton({ partNumber: cleaned, location, source: 'voice' });
        setOverlaySuccess();
        updateStatus('Fundet: ' + cleaned, 'ready');
        saveToHistory(cleaned, location);
    } else {
        const suggestion = findClosestPartNumber(cleaned);
        resultEl.innerHTML = `
            <div class="error">
                Varenr. ikke fundet: ${escapeHtml(cleaned)}
            </div>
            ${suggestion ? `<button class="suggestion-btn" id="voiceSuggestionBtn" data-suggest="${escapeHtml(suggestion)}">Mente du: ${escapeHtml(suggestion)}?</button>` : ''}
        `;
        setOverlayError();
        updateStatus('Klar til scanning', 'ready');

        const btn = document.getElementById('voiceSuggestionBtn');
        if (btn) {
            btn.onclick = () => {
                const suggested = btn.dataset.suggest;
                if (!suggested) return;
                const suggestedLocation = lookupLocation(suggested);
                if (suggestedLocation) {
                    resultEl.innerHTML = `
                        <div>
                            <div class="result-text"><span class="instrument-number">${escapeHtml(suggested)}</span></div>
                            <div class="result-location">📍 ${escapeHtml(suggestedLocation)}</div>
                        </div>
                    `;
                    setOverlaySuccess();
                    updateStatus('Fundet: ' + suggested, 'ready');
                    saveToHistory(suggested, suggestedLocation);
                }
            };
        }
    }
}

export function showListeningFeedback() {
    if (!resultEl) return;

    setSearchResultsLayout(false);
    resultEl.innerHTML = `
        <div style="color: #666; text-align: center;">
            <div class="loading">
                <div class="spinner"></div>
                <span>Lytter...</span>
            </div>
            <div style="font-size: 12px; margin-top: 10px;">
                Sig varenummeret højt og tydeligt
            </div>
        </div>
    `;
}

export function showInterimTranscript(transcript) {
    if (!resultEl) return;

    setSearchResultsLayout(false);
    resultEl.innerHTML = `
        <div style="color: #666; text-align: center;">
            <div class="loading">
                <div class="spinner"></div>
                <span>Lytter...</span>
            </div>
            <div style="font-size: 14px; margin-top: 10px; color: #0066FF;">
                Hører: "${escapeHtml(transcript.trim())}"
            </div>
        </div>
    `;
}

export function showVoiceError(errorMessage) {
    if (!resultEl) return;

    setSearchResultsLayout(false);
    resultEl.innerHTML = `
        <div class="error">
            ${escapeHtml(errorMessage)}
        </div>
    `;
    setOverlayError();
    updateStatus('Fejl: ' + errorMessage, 'ready');
}

export function setOverlayScanning() {
    if (!overlayEl) return;
    if (!overlayFeedbackEnabled) return;
    overlayEl.classList.add('scanning');
}

export function removeOverlayScanning() {
    if (overlayEl) overlayEl.classList.remove('scanning');
}

export function setOverlaySuccess() {
    if (!overlayEl) return;

    if (!overlayFeedbackEnabled) return;

    triggerSuccessHaptic();

    overlayEl.classList.remove('scanning');
    overlayEl.classList.remove('overlay-error');
    overlayEl.classList.add('success');
    if (overlayFeedbackTimeoutId) clearTimeout(overlayFeedbackTimeoutId);
    overlayFeedbackTimeoutId = setTimeout(() => {
        overlayEl.classList.remove('success');
    }, OVERLAY_FEEDBACK_MS);
}

function triggerSuccessHaptic() {
    try {
        if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
        // Slightly more noticeable than a single short pulse.
        navigator.vibrate([20, 30, 20]);
    } catch (e) {}
}

export function setOverlayError() {
    if (!overlayEl) return;

    if (!overlayFeedbackEnabled) return;
    overlayEl.classList.remove('scanning');
    overlayEl.classList.remove('success');
    overlayEl.classList.add('overlay-error');
    if (overlayFeedbackTimeoutId) clearTimeout(overlayFeedbackTimeoutId);
    overlayFeedbackTimeoutId = setTimeout(() => {
        overlayEl.classList.remove('overlay-error');
    }, OVERLAY_FEEDBACK_MS);
}

export function clearOverlayFeedback() {
    if (overlayEl) {
        overlayEl.classList.remove('success');
        overlayEl.classList.remove('overlay-error');
        overlayEl.classList.remove('scanning');
    }
}

// History functions
export function saveToHistory(partNumber, location) {
    try {
        let history = JSON.parse(localStorage.getItem('recentLookups') || '[]');
        history = history.filter(h => h.partNumber !== partNumber);
        history.unshift({ partNumber, location, timestamp: Date.now() });
        history = history.slice(0, MAX_RECENT_LOOKUPS);
        localStorage.setItem('recentLookups', JSON.stringify(history));
        if (historyVisible && historyListEl && !historyListEl.classList.contains('hidden')) {
            renderHistoryList();
        }
    } catch (e) {}
}

function getRecentLookups() {
    try {
        return JSON.parse(localStorage.getItem('recentLookups') || '[]');
    } catch (e) {
        return [];
    }
}

function clearHistory() {
    try {
        localStorage.removeItem('recentLookups');
    } catch (e) {}
}

function deleteHistoryEntry(partNumber) {
    const part = (partNumber || '').trim();
    if (!part) return;

    try {
        let history = JSON.parse(localStorage.getItem('recentLookups') || '[]');
        history = history.filter(h => h && h.partNumber !== part);
        localStorage.setItem('recentLookups', JSON.stringify(history));
    } catch (e) {}
}

function renderHistoryList() {
    if (!historyListEl) return;
    
    const lookups = getRecentLookups();
    let sortMode = 'recent';
    try {
        sortMode = localStorage.getItem(HISTORY_SORT_KEY) || 'recent';
    } catch (e) {}

    const sortModeSafe = (sortMode === 'location' || sortMode === 'alpha') ? sortMode : 'recent';
    const sorted = lookups.slice();

    const collator = new Intl.Collator('da', { numeric: true, sensitivity: 'base' });

    if (sortModeSafe === 'location') {
        sorted.sort((a, b) => {
            const aLoc = (a && a.location ? String(a.location) : '');
            const bLoc = (b && b.location ? String(b.location) : '');
            const aIsBvr = aLoc === 'BestilViaRep';
            const bIsBvr = bLoc === 'BestilViaRep';
            if (aIsBvr !== bIsBvr) return aIsBvr ? 1 : -1;

            const locCmp = collator.compare(aLoc, bLoc);
            if (locCmp !== 0) return locCmp;

            const aPart = (a && a.partNumber ? String(a.partNumber) : '');
            const bPart = (b && b.partNumber ? String(b.partNumber) : '');
            return collator.compare(aPart, bPart);
        });
    }

    if (sortModeSafe === 'alpha') {
        sorted.sort((a, b) => {
            const aPart = (a && a.partNumber ? String(a.partNumber) : '');
            const bPart = (b && b.partNumber ? String(b.partNumber) : '');
            const partCmp = collator.compare(aPart, bPart);
            if (partCmp !== 0) return partCmp;

            const aLoc = (a && a.location ? String(a.location) : '');
            const bLoc = (b && b.location ? String(b.location) : '');
            return collator.compare(aLoc, bLoc);
        });
    }

    let html = `
        <div class="history-controls">
            <label class="history-sort-label" for="historySortSelect">Sorter</label>
            <select id="historySortSelect" class="history-sort-select">
                <option value="recent" ${sortModeSafe === 'recent' ? 'selected' : ''}>Seneste</option>
                <option value="alpha" ${sortModeSafe === 'alpha' ? 'selected' : ''}>A-Å</option>
                <option value="location" ${sortModeSafe === 'location' ? 'selected' : ''}>Placering</option>
            </select>
        </div>
    `;

    if (sorted.length === 0) {
        html += `<div class="history-empty">Ingen historik endnu</div>`;
        historyListEl.innerHTML = html;
    } else {
        for (const item of sorted) {
            html += `
                <div class="history-item" data-part="${escapeHtml(item.partNumber)}">
                    <span class="history-item-part">${escapeHtml(item.partNumber)}</span>
                    <span class="history-item-location">${escapeHtml(item.location)}</span>
                    <button class="history-item-delete" type="button" data-action="delete" aria-label="Slet">×</button>
                </div>
            `;
        }
        html += `<button class="history-clear" id="clearHistoryBtn">Ryd historik</button>`;
        historyListEl.innerHTML = html;
    }

    const sortSelect = document.getElementById('historySortSelect');
    if (sortSelect) {
        sortSelect.onchange = () => {
            const v = (sortSelect.value === 'location' || sortSelect.value === 'alpha') ? sortSelect.value : 'recent';
            try {
                localStorage.setItem(HISTORY_SORT_KEY, v);
            } catch (e) {}
            renderHistoryList();
        };
    }

    historyListEl.querySelectorAll('.history-item').forEach(item => {
        item.onclick = (e) => {
            const partNumber = item.dataset.part;
            const deleteBtn = e && e.target ? e.target.closest('.history-item-delete') : null;
            if (deleteBtn) {
                try {
                    e.preventDefault();
                    e.stopPropagation();
                } catch (err) {}
                deleteHistoryEntry(partNumber);
                renderHistoryList();
                return;
            }
            const location = lookupLocation(partNumber);
            if (location) {
                displayResult(partNumber, location);
                setOverlaySuccess();
            } else {
                showError('Varenr. ikke længere i databasen: ' + partNumber);
            }
        };
    });
    
    const clearBtn = document.getElementById('clearHistoryBtn');
    if (clearBtn) {
        clearBtn.onclick = () => {
            if (confirm('Er du sikker på, at du vil slette hele historikken?')) {
                clearHistory();
                renderHistoryList();
            }
        };
    }
}

function toggleHistory() {
    historyVisible = !historyVisible;
    if (historyVisible) {
        renderHistoryList();
        historyListEl.classList.remove('hidden');
    } else {
        historyListEl.classList.add('hidden');
    }
}

export function displaySearchResults(searchResult) {
    if (!resultEl) return;

    const { exactMatch, results, strategy } = searchResult;

    if (exactMatch) {
        setSearchResultsLayout(false);
        resultEl.innerHTML = `
            <div>
                <div class="result-text"><span class="instrument-number">${escapeHtml(exactMatch.partNumber)}</span></div>
                <div class="result-location">📍 ${escapeHtml(exactMatch.location)}</div>
            </div>
        `;
        return;
    }

    if (results && results.length > 0) {
        setSearchResultsLayout(true);
        const strategyText = {
            'prefix': 'Starter med',
            'fuzzy': 'Mulige match',
            'substring': 'Indeholder'
        }[strategy] || 'Søgeresultater';

        let html = `
            <div class="search-results-header">${strategyText} (${results.length} ${results.length === 1 ? 'resultat' : 'resultater'})</div>
            <div class="search-results-list">
        `;

        for (const result of results) {
            const distanceInfo = result.distance !== undefined ? ` <span class="distance-badge">${result.distance}</span>` : '';
            html += `
                <button class="search-result-item" data-part="${escapeHtml(result.partNumber)}">
                    <span class="search-result-part">${escapeHtml(result.partNumber)}${distanceInfo}</span>
                    <span class="search-result-location">📍 ${escapeHtml(result.location)}</span>
                </button>
            `;
        }

        html += `</div>`;
        resultEl.innerHTML = html;

        const buttons = resultEl.querySelectorAll('.search-result-item');
        buttons.forEach(btn => {
            btn.onclick = () => {
                const partNumber = btn.dataset.part;
                const result = results.find(r => r.partNumber === partNumber);
                if (result) {
                    displayResult(partNumber, result.location);
                    saveToHistory(partNumber, result.location);
                    setOverlaySuccess();
                }
            };
        });

        return;
    }

    setSearchResultsLayout(false);
    resultEl.innerHTML = `
        <div class="error">
            Ingen varenumre fundet
        </div>
    `;
}
