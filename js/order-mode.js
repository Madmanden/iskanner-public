import {
    displayResult,
    setOverlayError,
    setOverlayFeedbackEnabled,
    setOverlaySuccess,
    updateStatus
} from './ui.js';
import { getToken } from './auth.js';
import { escapeHtml, lookupLocation } from './utils.js';
import { smartSearchV2 } from './search-v2.js';

const ORDER_LIST_KEY = 'orderList';
const HISTORY_KEY = 'recentLookups';
const HISTORY_SORT_KEY = 'historySortMode';

let orderModeActive = false;
let historyPanelVisible = false;
let activeHistoryTab = 'history';

function readList(key) {
    try {
        const parsed = JSON.parse(localStorage.getItem(key) || '[]');
        return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
    } catch (e) {
        return [];
    }
}

function writeList(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {}
}

function addToOrderList(partNumber, location) {
    const normalized = String(partNumber || '').trim().toUpperCase();
    if (!normalized || !location) return false;

    const current = readList(ORDER_LIST_KEY);
    if (current.some(item => item && item.partNumber === normalized)) {
        return false;
    }

    current.unshift({
        partNumber: normalized,
        location,
        timestamp: Date.now()
    });
    writeList(ORDER_LIST_KEY, current);

    if (historyPanelVisible && activeHistoryTab === 'orders') {
        renderHistoryPanel();
    }
    return true;
}

function removeFromList(key, partNumber) {
    const normalized = String(partNumber || '').trim().toUpperCase();
    const next = readList(key).filter(item => item && item.partNumber !== normalized);
    writeList(key, next);
}

function clearList(key) {
    try {
        localStorage.removeItem(key);
    } catch (e) {}
}

function ensureInjectedStyles() {
    if (document.getElementById('orderModeStyles')) return;

    const style = document.createElement('style');
    style.id = 'orderModeStyles';
    style.textContent = `
        .history-tabs {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 4px;
            padding: 6px;
            border-bottom: 1px solid var(--border);
            background: var(--bg);
        }

        .history-tab {
            padding: 8px 10px;
            border-radius: 7px;
            background: transparent;
            color: var(--text-secondary);
            font-size: 12px;
            box-shadow: none;
        }

        .history-tab.active {
            background: var(--surface);
            color: var(--primary);
            box-shadow: var(--shadow-sm);
        }

        .order-mode-banner {
            margin-top: 14px;
            padding: 9px 10px;
            border: 1px solid rgba(59, 130, 246, 0.25);
            background: var(--primary-light);
            color: var(--primary-dark);
            border-radius: 8px;
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 12px;
            font-weight: 700;
        }

        .order-mode-banner.hidden {
            display: none;
        }

        .order-mode-banner button {
            margin-left: auto;
            padding: 5px 8px;
            border: 1px solid rgba(59, 130, 246, 0.25);
            background: var(--surface);
            color: var(--primary);
            border-radius: 6px;
            font-size: 11px;
        }

        .order-controls {
            padding: 10px 12px;
            border-bottom: 1px solid var(--border);
        }

        .order-mode-toggle {
            width: 100%;
            padding: 9px 10px;
            border-radius: 8px;
            background: var(--primary);
            color: white;
            font-size: 12px;
        }

        .order-mode-toggle.active {
            background: var(--text);
        }

        .order-actions {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 6px;
            padding: 10px 12px;
            border-top: 1px solid var(--border);
        }

        .order-action {
            padding: 9px 10px;
            border-radius: 8px;
            font-size: 12px;
        }

        .order-action-clear {
            background: transparent;
            border: 1px solid rgba(239, 68, 68, 0.25);
            color: var(--error);
        }

        .order-action-send {
            background: var(--primary);
            color: white;
        }

        .order-action:disabled {
            opacity: 0.5;
            cursor: default;
        }

        .order-count {
            margin-left: 4px;
            opacity: 0.7;
        }

        .order-mode-result-note {
            margin-top: 7px;
            color: var(--text-secondary);
            font-size: 12px;
            text-align: center;
        }
    `;
    document.head.appendChild(style);
}

function ensureModeBanner() {
    let banner = document.getElementById('orderModeBanner');
    if (banner) return banner;

    const manualEntry = document.querySelector('.manual-entry');
    if (!manualEntry || !manualEntry.parentElement) return null;

    banner = document.createElement('div');
    banner.id = 'orderModeBanner';
    banner.className = 'order-mode-banner hidden';
    banner.innerHTML = `
        <span>Bestillingsmode aktiv</span>
        <button type="button" id="exitOrderModeBtn">Afslut</button>
    `;
    manualEntry.parentElement.insertBefore(banner, manualEntry);

    const exitBtn = banner.querySelector('#exitOrderModeBtn');
    if (exitBtn) {
        exitBtn.addEventListener('click', () => setOrderMode(false));
    }

    return banner;
}

function setOrderMode(enabled) {
    orderModeActive = Boolean(enabled);

    const banner = ensureModeBanner();
    if (banner) banner.classList.toggle('hidden', !orderModeActive);

    const manualInput = document.getElementById('manualPartInput');
    if (manualInput) {
        manualInput.placeholder = orderModeActive
            ? 'Skriv varenummer til bestilling…'
            : 'Skriv varenummer…';
    }

    const manualSearchBtn = document.getElementById('manualSearchBtn');
    if (manualSearchBtn) {
        const icon = manualSearchBtn.querySelector('.btn-icon');
        const label = manualSearchBtn.querySelector('.btn-label');
        if (icon) icon.textContent = orderModeActive ? '＋' : '🔍';
        if (label) label.textContent = orderModeActive ? 'Tilføj' : 'Søg';
    }

    updateStatus(orderModeActive ? 'Bestillingsmode aktiv' : 'Klar til scanning', 'ready');

    if (historyPanelVisible && activeHistoryTab === 'orders') {
        renderHistoryPanel();
    }

    if (orderModeActive && manualInput) {
        manualInput.focus();
    }
}

function formatOrderListForForm(items) {
    return items
        .map(item => `${item.partNumber} — ${item.location}`)
        .join('\n');
}

async function submitOrderList() {
    const items = readList(ORDER_LIST_KEY);
    if (items.length === 0) {
        updateStatus('Bestillingslisten er tom', 'ready');
        return;
    }

    const formData = new FormData();
    formData.append('form-name', 'order-list');
    formData.append('timestamp', new Date().toISOString());
    formData.append('itemCount', String(items.length));
    formData.append('items', formatOrderListForForm(items));
    formData.append('userAgent', typeof navigator !== 'undefined' ? navigator.userAgent : '');

    const headers = {};
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetch('/', {
        method: 'POST',
        headers,
        body: formData
    });

    if (!response.ok) throw new Error('Order list submission failed');
}

function getHistorySortMode() {
    try {
        const mode = localStorage.getItem(HISTORY_SORT_KEY) || 'recent';
        return mode === 'location' || mode === 'alpha' ? mode : 'recent';
    } catch (e) {
        return 'recent';
    }
}

function sortHistory(items, mode) {
    const collator = new Intl.Collator('da', { numeric: true, sensitivity: 'base' });
    const sorted = items.slice();

    if (mode === 'alpha') {
        sorted.sort((a, b) => {
            const partCmp = collator.compare(String(a?.partNumber || ''), String(b?.partNumber || ''));
            if (partCmp !== 0) return partCmp;
            return collator.compare(String(a?.location || ''), String(b?.location || ''));
        });
    } else if (mode === 'location') {
        sorted.sort((a, b) => {
            const aLoc = String(a?.location || '');
            const bLoc = String(b?.location || '');
            const aIsBvr = aLoc === 'BestilViaRep';
            const bIsBvr = bLoc === 'BestilViaRep';
            if (aIsBvr !== bIsBvr) return aIsBvr ? 1 : -1;

            const locCmp = collator.compare(aLoc, bLoc);
            if (locCmp !== 0) return locCmp;
            return collator.compare(String(a?.partNumber || ''), String(b?.partNumber || ''));
        });
    }

    return sorted;
}

function historyItemHtml(item, key) {
    return `
        <div class="history-item" data-part="${escapeHtml(item.partNumber)}" data-list-key="${key}">
            <span class="history-item-part">${escapeHtml(item.partNumber)}</span>
            <span class="history-item-location">${escapeHtml(item.location)}</span>
            <button class="history-item-delete" type="button" data-action="delete" aria-label="Slet">×</button>
        </div>
    `;
}

function renderHistoryTabContent() {
    const mode = getHistorySortMode();
    const items = sortHistory(readList(HISTORY_KEY), mode);

    let html = `
        <div class="history-controls">
            <label class="history-sort-label" for="historySortSelect">Sorter</label>
            <select id="historySortSelect" class="history-sort-select">
                <option value="recent" ${mode === 'recent' ? 'selected' : ''}>Seneste</option>
                <option value="alpha" ${mode === 'alpha' ? 'selected' : ''}>A-Å</option>
                <option value="location" ${mode === 'location' ? 'selected' : ''}>Placering</option>
            </select>
        </div>
    `;

    if (items.length === 0) {
        html += '<div class="history-empty">Ingen historik endnu</div>';
    } else {
        html += items.map(item => historyItemHtml(item, HISTORY_KEY)).join('');
        html += '<button class="history-clear" id="clearHistoryBtn">Ryd historik</button>';
    }

    return html;
}

function renderOrderTabContent() {
    const items = readList(ORDER_LIST_KEY);

    let html = `
        <div class="order-controls">
            <button type="button" id="orderModeToggleBtn" class="order-mode-toggle ${orderModeActive ? 'active' : ''}">
                ${orderModeActive ? 'Afslut bestillingsmode' : 'Start bestillingsmode'}
            </button>
        </div>
    `;

    if (items.length === 0) {
        html += '<div class="history-empty">Bestillingslisten er tom</div>';
    } else {
        html += items.map(item => historyItemHtml(item, ORDER_LIST_KEY)).join('');
        html += `
            <div class="order-actions">
                <button type="button" id="clearOrderListBtn" class="order-action order-action-clear">Ryd liste</button>
                <button type="button" id="sendOrderListBtn" class="order-action order-action-send">Send</button>
            </div>
        `;
    }

    return html;
}

function renderHistoryPanel() {
    const historyList = document.getElementById('historyList');
    if (!historyList) return;

    const orderCount = readList(ORDER_LIST_KEY).length;

    historyList.innerHTML = `
        <div class="history-tabs">
            <button type="button" class="history-tab ${activeHistoryTab === 'history' ? 'active' : ''}" data-history-tab="history">
                Historik
            </button>
            <button type="button" class="history-tab ${activeHistoryTab === 'orders' ? 'active' : ''}" data-history-tab="orders">
                Bestilling <span class="order-count">(${orderCount})</span>
            </button>
        </div>
        ${activeHistoryTab === 'history' ? renderHistoryTabContent() : renderOrderTabContent()}
    `;

    historyList.querySelectorAll('[data-history-tab]').forEach(button => {
        button.addEventListener('click', () => {
            activeHistoryTab = button.dataset.historyTab === 'orders' ? 'orders' : 'history';
            renderHistoryPanel();
        });
    });

    const sortSelect = historyList.querySelector('#historySortSelect');
    if (sortSelect) {
        sortSelect.addEventListener('change', () => {
            const mode = sortSelect.value === 'location' || sortSelect.value === 'alpha'
                ? sortSelect.value
                : 'recent';
            try {
                localStorage.setItem(HISTORY_SORT_KEY, mode);
            } catch (e) {}
            renderHistoryPanel();
        });
    }

    historyList.querySelectorAll('.history-item').forEach(item => {
        item.addEventListener('click', event => {
            const partNumber = item.dataset.part;
            const listKey = item.dataset.listKey;
            const deleteBtn = event.target.closest('.history-item-delete');

            if (deleteBtn) {
                event.preventDefault();
                event.stopPropagation();
                removeFromList(listKey, partNumber);
                renderHistoryPanel();
                return;
            }

            const location = lookupLocation(partNumber);
            if (location) {
                displayResult(partNumber, location);
                setOverlaySuccess();
            }
        });
    });

    const clearHistoryBtn = historyList.querySelector('#clearHistoryBtn');
    if (clearHistoryBtn) {
        clearHistoryBtn.addEventListener('click', () => {
            if (confirm('Er du sikker på, at du vil slette hele historikken?')) {
                clearList(HISTORY_KEY);
                renderHistoryPanel();
            }
        });
    }

    const orderModeToggleBtn = historyList.querySelector('#orderModeToggleBtn');
    if (orderModeToggleBtn) {
        orderModeToggleBtn.addEventListener('click', () => {
            setOrderMode(!orderModeActive);
            if (orderModeActive) {
                historyPanelVisible = false;
                historyList.classList.add('hidden');
            }
        });
    }

    const clearOrderListBtn = historyList.querySelector('#clearOrderListBtn');
    if (clearOrderListBtn) {
        clearOrderListBtn.addEventListener('click', () => {
            if (confirm('Er du sikker på, at du vil rydde bestillingslisten?')) {
                clearList(ORDER_LIST_KEY);
                renderHistoryPanel();
            }
        });
    }

    const sendOrderListBtn = historyList.querySelector('#sendOrderListBtn');
    if (sendOrderListBtn) {
        sendOrderListBtn.addEventListener('click', async () => {
            sendOrderListBtn.disabled = true;
            sendOrderListBtn.textContent = 'Sender…';
            try {
                await submitOrderList();
                updateStatus('Bestillingsliste sendt', 'ready');
                sendOrderListBtn.textContent = 'Sendt';
            } catch (e) {
                updateStatus('Kunne ikke sende bestillingslisten', 'ready');
                sendOrderListBtn.disabled = false;
                sendOrderListBtn.textContent = 'Send';
            }
        });
    }
}

function renderRankedResults(searchResult, query) {
    const resultEl = document.getElementById('result');
    if (!resultEl) return;

    const resultSection = resultEl.closest('.result-section');
    resultEl.classList.add('search-results-mode');
    if (resultSection) resultSection.classList.add('search-results-mode');

    const results = searchResult.results || [];
    resultEl.innerHTML = `
        <div class="search-results-header">Mulige match (${results.length})</div>
        <div class="search-results-list">
            ${results.map(result => `
                <button class="search-result-item" data-part="${escapeHtml(result.partNumber)}">
                    <span class="search-result-part">${escapeHtml(result.partNumber)}</span>
                    <span class="search-result-location">📍 ${escapeHtml(result.location)}</span>
                </button>
            `).join('')}
        </div>
    `;

    resultEl.querySelectorAll('.search-result-item').forEach(button => {
        button.addEventListener('click', () => {
            const partNumber = button.dataset.part;
            const selected = results.find(result => result.partNumber === partNumber);
            if (!selected) return;

            displayResult(selected.partNumber, selected.location);

            if (orderModeActive) {
                const added = addToOrderList(selected.partNumber, selected.location);
                updateStatus(
                    added
                        ? `Tilføjet til bestilling: ${selected.partNumber}`
                        : `Allerede på bestillingslisten: ${selected.partNumber}`,
                    'ready'
                );
                const input = document.getElementById('manualPartInput');
                if (input) input.focus();
            } else {
                saveNormalHistory(selected.partNumber, selected.location);
                updateStatus('Fundet: ' + selected.partNumber, 'ready');
            }

            setOverlaySuccess();
        });
    });

    updateStatus(`${results.length} mulige match for "${query}"`, 'ready');
}

function saveNormalHistory(partNumber, location) {
    const history = readList(HISTORY_KEY)
        .filter(item => item && item.partNumber !== partNumber);
    history.unshift({ partNumber, location, timestamp: Date.now() });
    writeList(HISTORY_KEY, history.slice(0, 50));

    if (historyPanelVisible && activeHistoryTab === 'history') {
        renderHistoryPanel();
    }
}

function showNoManualMatches(query) {
    const resultEl = document.getElementById('result');
    if (!resultEl) return;

    const resultSection = resultEl.closest('.result-section');
    resultEl.classList.remove('search-results-mode');
    if (resultSection) resultSection.classList.remove('search-results-mode');

    resultEl.innerHTML = `
        <div class="error">Ingen varenumre fundet for ${escapeHtml(query)}</div>
    `;
    setOverlayError();
    updateStatus('Ikke fundet: ' + query, 'ready');
}

function performManualLookup(event) {
    if (event) {
        event.preventDefault();
        event.stopImmediatePropagation();
    }

    const manualInput = document.getElementById('manualPartInput');
    if (!manualInput) return;

    const query = manualInput.value.trim().toUpperCase();
    if (!query) return;

    setOverlayFeedbackEnabled(false);
    const searchResult = smartSearchV2(query, 3);

    if (searchResult.exactMatch) {
        const { partNumber, location } = searchResult.exactMatch;
        displayResult(partNumber, location);

        if (orderModeActive) {
            const added = addToOrderList(partNumber, location);
            updateStatus(
                added
                    ? `Tilføjet til bestilling: ${partNumber}`
                    : `Allerede på bestillingslisten: ${partNumber}`,
                'ready'
            );
        } else {
            saveNormalHistory(partNumber, location);
            updateStatus('Fundet: ' + partNumber, 'ready');
        }

        setOverlaySuccess();
        manualInput.value = '';

        if (orderModeActive) {
            manualInput.focus();
        } else {
            manualInput.blur();
        }
        return;
    }

    if (searchResult.results.length > 0) {
        renderRankedResults(searchResult, query);
        manualInput.value = '';
        manualInput.blur();
        return;
    }

    showNoManualMatches(query);
    manualInput.value = '';
    if (orderModeActive) manualInput.focus();
    else manualInput.blur();
}

function installHistoryDiversion() {
    const StorageCtor = typeof Storage !== 'undefined' ? Storage : null;
    if (!StorageCtor || StorageCtor.prototype.__orderModeSetItemPatched) return;

    const nativeSetItem = StorageCtor.prototype.setItem;

    Object.defineProperty(StorageCtor.prototype, '__orderModeSetItemPatched', {
        value: true,
        configurable: true
    });

    StorageCtor.prototype.setItem = function(key, value) {
        if (orderModeActive && this === localStorage && key === HISTORY_KEY) {
            try {
                const nextHistory = JSON.parse(String(value || '[]'));
                const newest = Array.isArray(nextHistory) ? nextHistory[0] : null;
                if (newest?.partNumber && newest?.location) {
                    const added = addToOrderList(newest.partNumber, newest.location);
                    if (added) {
                        updateStatus(`Tilføjet til bestilling: ${newest.partNumber}`, 'ready');
                    }
                }
            } catch (e) {}
            return;
        }

        const result = nativeSetItem.call(this, key, value);

        // OCR and voice use ui.saveToHistory(), while the order-mode UI owns the
        // visible history panel. Refresh that panel whenever the shared history
        // storage changes so non-manual lookups appear immediately too.
        if (this === localStorage && key === HISTORY_KEY && historyPanelVisible && activeHistoryTab === 'history') {
            renderHistoryPanel();
        }

        return result;
    };
}

function installManualSearchOverride() {
    const manualInput = document.getElementById('manualPartInput');
    const manualSearchBtn = document.getElementById('manualSearchBtn');
    if (!manualInput || !manualSearchBtn) return;

    manualInput.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        performManualLookup(event);
    }, true);

    manualSearchBtn.addEventListener('click', performManualLookup, true);
    manualSearchBtn.addEventListener('touchend', performManualLookup, true);
}

function installHistoryOverride() {
    const historyBtn = document.getElementById('historyBtn');
    const historyList = document.getElementById('historyList');
    if (!historyBtn || !historyList) return;

    historyBtn.onclick = () => {
        historyPanelVisible = !historyPanelVisible;

        if (historyPanelVisible) {
            renderHistoryPanel();
            historyList.classList.remove('hidden');
        } else {
            historyList.classList.add('hidden');
        }
    };
}

function initOrderMode() {
    ensureInjectedStyles();
    ensureModeBanner();
    installHistoryDiversion();
    installManualSearchOverride();
    installHistoryOverride();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => queueMicrotask(initOrderMode), { once: true });
} else {
    queueMicrotask(initOrderMode);
}
