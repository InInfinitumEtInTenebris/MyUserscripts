// ==UserScript==
// @name         Text Replacer
// @namespace    http://tampermonkey.net/
// @version      10.5.0
// @description  Virtualized M3 UI, dynamic theming, full Blocklist/Rule I/O, Multi-Term (|), Gap (---), Filter (#{...}#) operators, Cross-Element Replacement (Range API), Protected Areas, dark/light theme, operator cheat sheet, unified backup, performance optimisations, larger scrollable settings lists with click-to-edit entries, IndexedDB-backed blocklist/settings persistence, word-count-based overwrite priority for overlapping terms, robust bidirectional IndexedDB↔GM_storage term sync with live cross-site updates.
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    const LOG_PREFIX = '[TextReplacer]';
    function log(...args) { console.log(LOG_PREFIX, ...args); }
    function error(...args) { console.error(LOG_PREFIX, ...args); }

    window.addEventListener('error', (e) => {
        if (e.filename && e.filename.includes('text-replacer')) {
            error('Uncaught error:', e.message, 'at', e.lineno, e.filename);
        }
    });

    function isExcludedContext() {
        try {
            const h = window.location.hostname;
            if (h.includes('google.com/recaptcha') || h.includes('hcaptcha.com') || h.includes('cloudflare.com')) return true;
            if (document.title.includes('Just a moment...') || document.title.includes('Attention Required!')) return true;
            if (document.querySelector('.cf-browser-verification, #cf-spinner-allow-5-secs, #challenge-running')) return true;
        } catch (e) {}
        return false;
    }
    if (isExcludedContext()) return;

    // ---------- CONFIG ----------
    const DB_NAME = 'TextReplacerDB_v2';
    const STORE_NAME = 'rules';
    const SETTINGS_STORE = 'settings';
    const DB_VERSION = 2; // v2 adds the SETTINGS_STORE (blocklist/protected selectors/highlight) so they survive userscript reinstalls, same as rules already do
    const MASTER_KEY = 'TextReplacer_MASTER_v2';
    const ACTIVE_KEY = 'TextReplacer_ACTIVE_v2';
    const BLOCK_KEY = 'TextReplacer_BLOCK_GLOBAL';
    const UI_SCROLL_KEY = 'TextReplacer_UI_SCROLL_v2';
    const HIGHLIGHT_KEY = 'TextReplacer_HIGHLIGHT_v2';
    const STATS_KEY = 'TextReplacer_Stats_v2';
    const PROTECTED_KEY = 'TextReplacer_PROTECTED_SELECTORS';
    const MASTER_POLL_MS = 5000;
    const MASTER_WRITE_DEBOUNCE = 600;
    const REPLACE_DEBOUNCE = 120;
    const SCROLL_SAVE_DEBOUNCE = 250;
    const STATS_SAVE_DEBOUNCE = 30000;
    const CARD_HEIGHT = 88;

    // ---------- STATE ----------
    let dbInstance = null, localRules = [], activeRules = {}, blockedDomains = [];
    let enableHighlight = true, siteThemeColor = '#6750A4';
    let guiBox = null, mainPage = null, settingsPage = null, dialogWrapper = null;
    let listContainer = null, virtualScroller = null, quickEditBox = null, selectionFab = null;
    let isGuiOpen = false, writingMaster = false, applyingRemoteMaster = false;
    let lastMasterPayloadTs = 0;
    const HOST = window.location.hostname;
    let prevActiveHash = '', prevLocalHash = '';
    let replaceTimer = null, masterWriteTimer = null, scrollSaveTimer = null;
    let quickEditActiveId = null, mo = null;
    let searchQuery = '';
    let externalIhwAPI = null;
    let isNavigating = false;
    
    let repDataMap = new Map();
    let trIdCounter = 0;
    const regexCache = new Map();
    const wordCountCache = new Map();
    let isRenderingScroll = false;

    // ---------- PROTECTED AREAS ----------
    let protectedSelectors = [];
    const DEFAULT_PROTECTED_SELECTORS = [
        'textarea',
        'input[type="text"]',
        'input[type="search"]',
        'input[type="email"]',
        'input[type="url"]',
        'input[type="number"]',
        '[contenteditable="true"]',
        '[role="textbox"]',
        '.comment-textarea',
        '.comment-box',
        '.review-text',
        '.editor',
        '#comment',
        '#review',
        '.input-message',
        '.message-input'
    ];
    let protectedSelectorString = '';

    function updateProtectedSelectorString() {
        protectedSelectorString = protectedSelectors.join(',');
    }

    // ---------- SMART PRIORITY / RECENCY ----------
    let ruleStats = new Map();
    try {
        const raw = GM_getValue(STATS_KEY, '{}');
        if (raw) {
            const obj = JSON.parse(raw);
            for (const [k, v] of Object.entries(obj)) {
                ruleStats.set(k, { lastUsed: v.lastUsed || 0, matchCount: v.matchCount || 0 });
            }
        }
    } catch (e) { error('Failed to load stats', e); }
    let statsSaveTimer = null, statsDirty = false;

    function scheduleStatsSave() {
        statsDirty = true;
        if (!statsSaveTimer) {
            statsSaveTimer = setTimeout(() => { flushStats(); }, STATS_SAVE_DEBOUNCE);
        }
    }

    function flushStats() {
        if (!statsDirty) return;
        const obj = {};
        ruleStats.forEach((v, k) => { obj[k] = v; });
        try { GM_setValue(STATS_KEY, JSON.stringify(obj)); } catch (e) { error('Failed to save stats', e); }
        statsDirty = false;
        if (statsSaveTimer) { clearTimeout(statsSaveTimer); statsSaveTimer = null; }
    }

    window.addEventListener('beforeunload', () => { flushStats(); });

    // ---------- [IHW INTEGRATION HANDLER] ----------
    window.addEventListener('IHW_Register', (e) => {
        externalIhwAPI = e.detail;
        externalIhwAPI.hideNativeButton();
        if (isGuiOpen && document.getElementById('tr-set-cont')) { showSettings(); }
    });

    // ---------- HELPERS & GM ----------
    function escapeRegExp(s) {
        if (s === "'") return "['’]";
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    function now() { return Date.now(); }
    function uuid() { return now().toString(36) + Math.random().toString(36).slice(2); }
    function signatureOf(r) { return `${r.oldText}:::${r.newText}:::${!!r.caseSensitive}:::${!!r.forceGlobal}:::${!!r.smartPriority}`; }
    function escapeHtml(s) { return (s||'').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]); }

    function extractThemeColor() {
        try {
            const meta = document.querySelector('meta[name="theme-color"]');
            if (meta && meta.content) siteThemeColor = meta.content;
        } catch (e) {}
    }

    function readGM(k, fb = null) { try { const r = GM_getValue(k, null); return r === null ? fb : (typeof r === 'string' ? JSON.parse(r) : r); } catch (e) { error('readGM failed for', k, e); return fb; } }
    function writeGM(k, v) { try { GM_setValue(k, JSON.stringify(v)); } catch (e) { error('writeGM failed for', k, e); } }

    // ---------- ENGINE LOGIC ----------
    function compileRuleRegex(rule, forHtml = false) {
        const cacheKey = `${rule.id}_${forHtml ? 'H' : 'T'}_${rule.updatedAt}`;
        if (regexCache.has(cacheKey)) return regexCache.get(cacheKey);

        const parts = rule.oldText.split(/\s*\|\s*/);
        const branchRegexes = parts.map(part => {
            const subParts = part.split(/\s*---\s*/);
            const parsedPart = subParts.map(sp => {
                return sp.split(/\s+/).map(w => w.split('').map(escapeRegExp).join('[\\u200B-\\u200D\\uFEFF]*')).join(forHtml ? '(?:<[^>]+>|\\s|&nbsp;)+' : '\\s+');
            }).join(forHtml ? '(?:<[^>]+>|\\s|&nbsp;)+(.*?)(?:<[^>]+>|\\s|&nbsp;)+' : '\\s+(.*?)\\s+');
            const pre = /^[\w'’]/.test(part) ? '\\b' : '';
            const post = /[\w'’]$/.test(part) ? '\\b' : '';
            return `${pre}${parsedPart}${post}`;
        });
        const rx = new RegExp(`(${branchRegexes.join('|')})`, rule.caseSensitive ? 'g' : 'gi');
        regexCache.set(cacheKey, rx);
        return rx;
    }

    function getRuleBranchSource(rule) {
        const parts = rule.oldText.split(/\s*\|\s*/);
        const branchRegexes = parts.map(part => {
            const subParts = part.split(/\s*---\s*/);
            const parsedPart = subParts.map(sp => {
                return sp.split(/\s+/).map(w => w.split('').map(escapeRegExp).join('[\\u200B-\\u200D\\uFEFF]*')).join('\\s+');
            }).join('\\s+(.*?)\\s+');
            const pre = /^[\w'’]/.test(part) ? '\\b' : '';
            const post = /[\w'’]$/.test(part) ? '\\b' : '';
            return `${pre}${parsedPart}${post}`;
        });
        return branchRegexes.join('|');
    }

    // ---------- WORD-COUNT PRIORITY ----------
    // Determines how "specific" a rule is (by its longest word-count branch) so that,
    // when two rules' matches overlap (e.g. "student" vs "this student"), the rule
    // covering more words wins and the shorter one is suppressed for that span.
    function countRuleWords(rule) {
        const cacheKey = `${rule.id}_${rule.updatedAt}`;
        if (wordCountCache.has(cacheKey)) return wordCountCache.get(cacheKey);
        const branches = (rule.oldText || '').split(/\s*\|\s*/);
        let maxWords = 0;
        for (const branch of branches) {
            const words = branch.split(/\s*---\s*/).join(' ').trim().split(/\s+/).filter(Boolean);
            if (words.length > maxWords) maxWords = words.length;
        }
        wordCountCache.set(cacheKey, maxWords);
        return maxWords;
    }

    function processReplacement(rule, matchText, capturedGap) {
        let out = rule.newText;
        const filterMatch = out.match(/#\{(.*?)\}#/);
        let gapText = capturedGap || '';
        if (filterMatch) {
            const wordsToExclude = filterMatch[1].split(',').map(s => s.trim().toLowerCase());
            wordsToExclude.forEach(w => {
                const wReg = new RegExp(`\\b${escapeRegExp(w)}\\b`, 'gi');
                gapText = gapText.replace(wReg, '').replace(/\s{2,}/g, ' ').trim();
            });
            out = out.replace(filterMatch[0], '');
        }
        if (out.includes('---')) { out = out.replace('---', gapText); }
        else if (capturedGap) { out += ' ' + gapText; }
        return out.trim();
    }

    // ---------- PROTECTED AREA CHECK ----------
    function isInProtectedArea(node) {
        if (!protectedSelectorString) return false;
        const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
        if (!el || !el.closest) return false;
        // closest() already checks the element itself before walking ancestors,
        // so a separate matches() call first was redundant on this very hot path.
        return !!el.closest(protectedSelectorString);
    }

    // ---------- SAFE CROSS-ELEMENT REPLACEMENT (Range API) ----------
    function collectContiguousTextNodes(container) {
        const walker = document.createTreeWalker(
            container,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode: function(node) {
                    const p = node.parentElement;
                    if (!p) return NodeFilter.FILTER_REJECT;
                    if (['SCRIPT','STYLE','NOSCRIPT','TEXTAREA','INPUT','IFRAME'].includes(p.tagName)) return NodeFilter.FILTER_REJECT;
                    if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
                    if (p.closest && p.closest('#text-replacer-gui, .tr-replaced, [data-tr-processed="true"]')) return NodeFilter.FILTER_REJECT;
                    if (isInProtectedArea(p)) return NodeFilter.FILTER_REJECT;
                    return NodeFilter.FILTER_ACCEPT;
                }
            },
            false
        );
        const nodes = [];
        let node;
        while ((node = walker.nextNode())) {
            nodes.push(node);
        }
        return nodes;
    }

    function buildTextMap(nodes) {
        let text = '';
        const map = [];
        for (const node of nodes) {
            const val = node.nodeValue;
            const start = text.length;
            text += val;
            map.push({ node, start, end: text.length, length: val.length });
        }
        return { text, map };
    }

    function findCrossElementMatchesSafe(rule, container) {
        const nodes = collectContiguousTextNodes(container);
        if (nodes.length < 2) return [];
        const { text, map } = buildTextMap(nodes);
        const rx = compileRuleRegex(rule, false);
        const matches = [];
        let match;
        rx.lastIndex = 0;
        while ((match = rx.exec(text)) !== null) {
            const mStart = match.index;
            const mEnd = match.index + match[0].length;
            let firstIdx = -1, lastIdx = -1;
            for (let i = 0; i < map.length; i++) {
                if (map[i].start < mEnd && map[i].end > mStart) {
                    if (firstIdx === -1) firstIdx = i;
                    lastIdx = i;
                }
            }
            if (firstIdx !== -1 && lastIdx !== -1 && lastIdx > firstIdx) {
                matches.push({
                    rule,
                    startOffset: mStart,
                    endOffset: mEnd,
                    fullMatch: match[0],
                    capturedGap: match[2] || match[3] || '',
                    firstNodeIdx: firstIdx,
                    lastNodeIdx: lastIdx,
                    map: map.slice()
                });
            }
        }
        return matches;
    }

    function applyCrossMatches(matches) {
        matches.sort((a, b) => b.startOffset - a.startOffset);
        const nowTs = now();
        for (const m of matches) {
            try {
                const { rule, fullMatch, capturedGap, firstNodeIdx, lastNodeIdx, map } = m;
                const replacement = processReplacement(rule, fullMatch, capturedGap);
                const nodes = map.map(item => item.node);
                const startNode = nodes[firstNodeIdx];
                const endNode = nodes[lastNodeIdx];
                if (!startNode || !endNode || !startNode.parentNode) continue;

                const startOffset = m.startOffset - map[firstNodeIdx].start;
                const endOffset = m.endOffset - map[lastNodeIdx].start;

                const range = document.createRange();
                range.setStart(startNode, startOffset);
                range.setEnd(endNode, endOffset);
                range.deleteContents();

                const wrapper = document.createElement('span');
                const trId = 'tr' + (++trIdCounter);
                repDataMap.set(trId, { orig: fullMatch, ruleId: rule.id });
                wrapper.className = enableHighlight ? 'tr-replaced' : 'tr-replaced-hidden';
                wrapper.dataset.trId = trId;
                wrapper.textContent = replacement;
                range.insertNode(wrapper);

                const s = ruleStats.get(rule.id) || { lastUsed: 0, matchCount: 0 };
                s.lastUsed = nowTs; s.matchCount++;
                ruleStats.set(rule.id, s);
                scheduleStatsSave();
            } catch (e) {
                error('Cross-element apply failed for rule', m.rule.id, e);
            }
        }
    }

    function processCrossElementReplacements(rulesList) {
        const containers = document.querySelectorAll('p, div, span, li, td, th, h1, h2, h3, h4, h5, h6');
        const processed = new Set();
        for (const container of containers) {
            if (processed.has(container)) continue;
            if (container.closest('#text-replacer-gui, .tr-replaced, [data-tr-processed="true"]')) continue;
            if (isInProtectedArea(container)) continue;
            let ancestor = container.parentElement;
            let skip = false;
            while (ancestor) {
                if (processed.has(ancestor) || isInProtectedArea(ancestor)) { skip = true; break; }
                ancestor = ancestor.parentElement;
            }
            if (skip) continue;
            processed.add(container);

            for (const rule of rulesList) {
                try {
                    const matches = findCrossElementMatchesSafe(rule, container);
                    if (matches.length > 0) {
                        applyCrossMatches(matches);
                    }
                } catch (e) {
                    error('Cross-element error for rule', rule.id, e);
                }
            }
        }
    }

    // ---------- EARLY PATTERN PRIMING ----------
    try {
        let earlyBlocked = [];
        try {
            const raw = GM_getValue(BLOCK_KEY, null);
            earlyBlocked = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
        } catch (e) { error('Failed to read blocklist for early priming', e); }

        if (!earlyBlocked.includes(HOST) && !isExcludedContext()) {
            const primedHostData = readGM(ACTIVE_KEY, { hostMap: {} });
            const earlyRules = primedHostData.hostMap ? (primedHostData.hostMap[HOST] || []) : [];
            let earlyMo = null;
            if (earlyRules.length > 0) {
                const earlyRxMap = earlyRules.map(r => ({ r, rx: compileRuleRegex(r, false) }));
                earlyMo = new MutationObserver(mutations => {
                    for (const m of mutations) {
                        m.addedNodes.forEach(node => {
                            if (node.nodeType === Node.TEXT_NODE && node.nodeValue && node.nodeValue.trim()) {
                                if (!isInProtectedArea(node.parentElement)) {
                                    processEarlyTextNode(node, earlyRxMap);
                                }
                            } else if (node.nodeType === Node.ELEMENT_NODE) {
                                if (['SCRIPT','STYLE','NOSCRIPT','TEXTAREA','INPUT'].includes(node.tagName)) return;
                                if (isInProtectedArea(node)) return;
                                const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null, false);
                                let tNode;
                                while ((tNode = walker.nextNode())) {
                                    if (tNode.parentElement && ['SCRIPT','STYLE','NOSCRIPT','TEXTAREA','INPUT'].includes(tNode.parentElement.tagName)) continue;
                                    if (!isInProtectedArea(tNode.parentElement)) {
                                        processEarlyTextNode(tNode, earlyRxMap);
                                    }
                                }
                            }
                        });
                    }
                });
                if (document.documentElement) {
                    earlyMo.observe(document.documentElement, { childList: true, subtree: true });
                } else {
                    earlyMo.observe(document, { childList: true, subtree: true });
                }
            }

            function processEarlyTextNode(tNode, rxMap) {
                let val = tNode.nodeValue;
                let changed = false;
                const nowTs = now();
                for (const {r, rx} of rxMap) {
                    const before = val;
                    // rx is a cached, shared RegExp reused across every text node this observer
                    // sees. With the 'g' flag, .test() advances lastIndex on a match and leaves
                    // it non-zero, so the NEXT node's .test() would silently start scanning from
                    // that stale offset and can miss a real match earlier in the new string.
                    rx.lastIndex = 0;
                    if (rx.test(val)) {
                        rx.lastIndex = 0;
                        val = val.replace(rx, (...args) => {
                            changed = true;
                            const matchedStr = args[0];
                            const gapMatch = args.slice(2, -2).find(x => x !== undefined && x !== matchedStr);
                            return processReplacement(r, matchedStr, gapMatch);
                        });
                        if (val !== before) {
                            const s = ruleStats.get(r.id) || { lastUsed: 0, matchCount: 0 };
                            s.lastUsed = nowTs; s.matchCount++; ruleStats.set(r.id, s);
                            scheduleStatsSave();
                        }
                    }
                }
                if (changed) tNode.nodeValue = val;
            }

            window.__trEarlyMoCleanup = () => { if (earlyMo) { earlyMo.disconnect(); earlyMo = null; window.__trEarlyMoCleanup = null; } };
        }
    } catch (e) { error('Early priming setup failed', e); }

    // ---------- IndexedDB ----------
    function openDB() {
        return new Promise((resolve, reject) => {
            if (dbInstance) return resolve(dbInstance);
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onerror = (e) => reject(e.target.error || 'IDB error');
            req.onblocked = () => { error('IndexedDB upgrade blocked by another open tab on this site; close other tabs and reload.'); };
            req.onsuccess = (e) => {
                dbInstance = e.target.result;
                // If another tab later needs a version upgrade, release our connection so it isn't stuck blocked.
                dbInstance.onversionchange = () => { try { dbInstance.close(); } catch (err) {} dbInstance = null; };
                resolve(dbInstance);
            };
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'id' });
                if (!db.objectStoreNames.contains(SETTINGS_STORE)) db.createObjectStore(SETTINGS_STORE, { keyPath: 'key' });
            };
        });
    }
    async function dbGetAll() {
        try {
            const db = await openDB();
            return new Promise(res => {
                const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
                req.onsuccess = () => res(req.result || []); req.onerror = () => res([]);
            });
        } catch (e) { error('dbGetAll failed', e); return []; }
    }
    async function dbPut(r) {
        try {
            const db = await openDB();
            return new Promise((res, rej) => {
                const req = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(r);
                req.onsuccess = () => { regexCache.clear(); wordCountCache.clear(); res(); }; req.onerror = e => rej(e);
            });
        } catch (e) { error('dbPut failed', e); }
    }
    async function dbDelete(id) {
        try {
            const db = await openDB();
            return new Promise((res, rej) => {
                const req = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(id);
                req.onsuccess = () => { regexCache.clear(); wordCountCache.clear(); res(); }; req.onerror = e => rej(e);
            });
        } catch (e) { error('dbDelete failed', e); }
    }

    // Settings (blocklist / protected selectors / highlight) live in IndexedDB, keyed by origin,
    // so — like the rules store — they survive the userscript being reinstalled/updated in the
    // manager. GM_setValue storage is tied to the script's own identity in the manager and can be
    // wiped out on a reinstall, which is why the blocklist used to go empty after an update.
    async function dbGetSetting(key, fallback) {
        try {
            const db = await openDB();
            return new Promise((resolve) => {
                const req = db.transaction(SETTINGS_STORE, 'readonly').objectStore(SETTINGS_STORE).get(key);
                req.onsuccess = () => resolve(req.result ? req.result.value : fallback);
                req.onerror = () => resolve(fallback);
            });
        } catch (e) { error('dbGetSetting failed for', key, e); return fallback; }
    }
    async function dbSetSetting(key, value) {
        try {
            const db = await openDB();
            return new Promise((resolve, reject) => {
                const req = db.transaction(SETTINGS_STORE, 'readwrite').objectStore(SETTINGS_STORE).put({ key, value });
                req.onsuccess = () => resolve(); req.onerror = (e) => reject(e);
            });
        } catch (e) { error('dbSetSetting failed for', key, e); }
    }

    async function loadSettings() {
        try {
            // Legacy GM key migration (kept from earlier versions).
            const legacyBlock = readGM('TextReplacer_BLOCK_v2', null);
            let gmBlocked = readGM(BLOCK_KEY, null);
            if (legacyBlock) {
                gmBlocked = gmBlocked || legacyBlock;
                writeGM(BLOCK_KEY, gmBlocked);
                try { GM_deleteValue('TextReplacer_BLOCK_v2'); } catch(e){}
            }

            // IndexedDB is canonical. On first run under this version, migrate in whatever GM
            // storage already had so nobody's existing blocklist/selectors get lost in the switch.
            let idbBlocked = await dbGetSetting('blockedDomains', null);
            if (idbBlocked === null) {
                idbBlocked = gmBlocked || [];
                if (idbBlocked.length) await dbSetSetting('blockedDomains', idbBlocked);
            }
            blockedDomains = Array.isArray(idbBlocked) ? idbBlocked : [];
            writeGM(BLOCK_KEY, blockedDomains); // keep GM mirror fresh for the document-start early-priming fast path

            let idbProtected = await dbGetSetting('protectedSelectors', null);
            if (idbProtected === null) {
                idbProtected = readGM(PROTECTED_KEY, null) || DEFAULT_PROTECTED_SELECTORS;
                await dbSetSetting('protectedSelectors', idbProtected);
            }
            protectedSelectors = Array.isArray(idbProtected) ? idbProtected : DEFAULT_PROTECTED_SELECTORS;
            updateProtectedSelectorString();

            let idbHighlight = await dbGetSetting('enableHighlight', null);
            if (idbHighlight === null) {
                idbHighlight = readGM(HIGHLIGHT_KEY, true);
                await dbSetSetting('enableHighlight', idbHighlight);
            }
            enableHighlight = idbHighlight !== false;

            extractThemeColor();
        } catch (e) { error('loadSettings failed', e); }
    }
    async function saveBlocked() {
        blockedDomains = blockedDomains || [];
        writeGM(BLOCK_KEY, blockedDomains);
        await dbSetSetting('blockedDomains', blockedDomains);
    }
    async function saveProtectedSelectors() {
        writeGM(PROTECTED_KEY, protectedSelectors);
        updateProtectedSelectorString();
        await dbSetSetting('protectedSelectors', protectedSelectors);
    }
    function saveHighlightSetting() {
        writeGM(HIGHLIGHT_KEY, enableHighlight);
        dbSetSetting('enableHighlight', enableHighlight);
    }

    // ---------- MASTER mirror ----------
    // IndexedDB is scoped per-origin (each site has its own separate database), so GM storage is
    // the one thing actually shared across every site this script runs on. This section keeps the
    // two in sync in both directions: local rule changes get published to the master mirror, and
    // anything published by another site/tab gets folded back into this site's IndexedDB.
    async function scheduleWriteMasterMirror() {
        if (masterWriteTimer) clearTimeout(masterWriteTimer);
        masterWriteTimer = setTimeout(async () => {
            try {
                writingMaster = true;
                // Pull-then-push: fold in whatever another site/tab already published to the master
                // mirror before we publish our own set. Without this, pushing local rules as a flat
                // overwrite could silently erase rules another site added that this site's IndexedDB
                // never had (e.g. site A publishes {1,2,3}, site B — whose local DB only has {1,2,4} —
                // pushes and wipes out rule 3 for everyone, even though it still exists on site A).
                const currentMaster = readGM(MASTER_KEY, null);
                if (currentMaster && Array.isArray(currentMaster.rules)) {
                    await mergeMasterPayload(currentMaster);
                }
                const rules = await dbGetAll();
                const ts = now();
                writeGM(MASTER_KEY, { ts, rules: rules.map(r => ({ ...r })) });
                lastMasterPayloadTs = ts;
            } finally { setTimeout(() => writingMaster = false, 200); }
        }, MASTER_WRITE_DEBOUNCE);
    }

    async function mergeMasterPayload(payload) {
        if (!payload || !Array.isArray(payload.rules) || applyingRemoteMaster) return;
        applyingRemoteMaster = true;
        try {
            const incoming = payload.rules; const current = await dbGetAll();
            const byId = new Map(current.map(r => [r.id, r])); const bySig = new Map(current.map(r => [signatureOf(r), r]));
            for (const r of incoming) {
                if (!r || !r.oldText) continue;
                const cand = { id: r.id || uuid(), oldText: r.oldText, newText: r.newText || '', caseSensitive: !!r.caseSensitive, forceGlobal: !!r.forceGlobal, smartPriority: !!r.smartPriority, enabled: r.enabled !== false, createdAt: r.createdAt || now(), updatedAt: r.updatedAt || now(), site: r.site || null };
                if (byId.has(cand.id)) { const local = byId.get(cand.id); if ((cand.updatedAt || 0) > (local.updatedAt || 0)) await dbPut({ ...local, ...cand, id: local.id }); }
                else { const sig = signatureOf(cand); if (bySig.has(sig)) { const local = bySig.get(sig); if ((cand.updatedAt || 0) > (local.updatedAt || 0)) await dbPut({ ...local, ...cand, id: local.id }); } else await dbPut(cand); }
            }
            if (payload.ts) lastMasterPayloadTs = Math.max(lastMasterPayloadTs, payload.ts);
            localRules = await dbGetAll(); updateGuiIfNeeded(); scheduleReplace();
        } finally { applyingRemoteMaster = false; }
    }

    // Live cross-site/cross-tab sync: fires whenever another open tab/site (remote === true) writes
    // to the master mirror, so a rule added on siteA shows up on siteB right away instead of only
    // the next time siteB happens to reload. Debounced briefly to coalesce rapid successive writes.
    let remoteMergeTimer = null;
    function scheduleRemoteMasterMerge(payload) {
        if (remoteMergeTimer) clearTimeout(remoteMergeTimer);
        remoteMergeTimer = setTimeout(() => { remoteMergeTimer = null; mergeMasterPayload(payload); }, 300);
    }
    try {
        if (typeof GM_addValueChangeListener === 'function') {
            GM_addValueChangeListener(MASTER_KEY, (name, oldValue, newValue, remote) => {
                if (!remote) return; // this tab's own writes also fire this listener; ignore those
                try {
                    const payload = typeof newValue === 'string' ? JSON.parse(newValue) : newValue;
                    if (!payload || !Array.isArray(payload.rules)) return;
                    if (payload.ts && payload.ts <= lastMasterPayloadTs) return; // already have this version
                    scheduleRemoteMasterMerge(payload);
                } catch (e) { error('Failed to parse remote master payload', e); }
            });
        }
    } catch (e) { error('GM_addValueChangeListener registration failed', e); }

    function updateActiveHostInGM(detectedArray) {
        const payload = readGM(ACTIVE_KEY, { ts: 0, hostMap: {} }); payload.hostMap = payload.hostMap || {};
        if (!detectedArray || detectedArray.length === 0) { if (payload.hostMap[HOST]) delete payload.hostMap[HOST]; }
        else { payload.hostMap[HOST] = detectedArray.map(r => ({ id: r.id, oldText: r.oldText, newText: r.newText, caseSensitive: !!r.caseSensitive, forceGlobal: !!r.forceGlobal, smartPriority: !!r.smartPriority })); }
        payload.ts = now(); writeGM(ACTIVE_KEY, payload);
    }

    function revertAllReplacements() {
        try {
            document.querySelectorAll('.tr-replaced, .tr-replaced-hidden').forEach(el => {
                const data = repDataMap.get(el.dataset.trId);
                if (data) {
                    el.outerHTML = data.orig;
                }
            });
            repDataMap.clear();
            document.querySelectorAll('[data-tr-processed]').forEach(el => {
                delete el.dataset.trProcessed;
            });
        } catch (e) { error('revertAllReplacements failed', e); }
    }

    async function runDetectionAndApplyInternal() {
        if (blockedDomains.includes(HOST)) return;
        localRules = await dbGetAll();
        // textContent avoids the forced synchronous layout/reflow that innerText triggers,
        // which matters here since this runs on every debounced mutation pass.
        const bodyText = document.body ? (document.body.textContent || '') : '';
        const detected = []; const newActive = {};
        for (const r of localRules) {
            if (!r.enabled) continue;
            try {
                const rx = compileRuleRegex(r, false);
                // rx is cached/shared across calls; a global regex's .test() leaves lastIndex
                // sitting after the previous match it found, so without this reset a later call
                // can silently start mid-string and miss a real match near the beginning.
                rx.lastIndex = 0;
                if (r.forceGlobal || rx.test(bodyText)) { detected.push(r); newActive[r.id] = r; }
            } catch(e) {}
        }
        updateActiveHostInGM(detected);
        const newHash = JSON.stringify(Object.keys(newActive).sort());
        activeRules = newActive;
        if (newHash !== prevActiveHash) { prevActiveHash = newHash; updateGuiIfNeeded(); }
        scheduleReplace();
    }

    function scheduleReplace() {
        if (replaceTimer) clearTimeout(replaceTimer);
        replaceTimer = setTimeout(() => {
            if ('requestIdleCallback' in window) {
                requestIdleCallback(() => performReplacementPass(), { timeout: 2000 });
            } else {
                performReplacementPass();
            }
            replaceTimer = null;
        }, REPLACE_DEBOUNCE);
    }

    // ---------- COMBINED REGEX OPTIMISATION ----------
    let combinedRegex = null;
    let combinedRuleMap = [];

    function buildCombinedRegex(rulesList) {
        if (!rulesList.length) {
            combinedRegex = null;
            combinedRuleMap = [];
            return;
        }
        const caseSensitiveRules = rulesList.filter(r => r.caseSensitive);
        const caseInsensitiveRules = rulesList.filter(r => !r.caseSensitive);
        if (caseSensitiveRules.length > 0 && caseInsensitiveRules.length === 0) {
            const branches = [];
            combinedRuleMap = [];
            for (const rule of caseSensitiveRules) {
                const branch = getRuleBranchSource(rule);
                branches.push(`(${branch})`);
                combinedRuleMap.push(rule);
            }
            combinedRegex = new RegExp(branches.join('|'), 'g');
        } else if (caseInsensitiveRules.length > 0 && caseSensitiveRules.length === 0) {
            const branches = [];
            combinedRuleMap = [];
            for (const rule of caseInsensitiveRules) {
                const branch = getRuleBranchSource(rule);
                branches.push(`(${branch})`);
                combinedRuleMap.push(rule);
            }
            combinedRegex = new RegExp(branches.join('|'), 'gi');
        } else {
            // mixed case sensitivity, fallback to per-rule
            combinedRegex = null;
            combinedRuleMap = [];
        }
    }

    function performReplacementPass() {
        if (blockedDomains.includes(HOST)) return;

        let rulesList = Object.values(activeRules).sort((a, b) => {
            // More words = more specific = higher priority, so e.g. "this student" (2 words)
            // wins over an overlapping "student" (1 word) instead of both trying to apply.
            const wordDiff = countRuleWords(b) - countRuleWords(a);
            if (wordDiff !== 0) return wordDiff;
            const lenDiff = (b.oldText || '').length - (a.oldText || '').length;
            if (lenDiff !== 0) return lenDiff;
            const aSmart = !!a.smartPriority;
            const bSmart = !!b.smartPriority;
            if (aSmart !== bSmart) return aSmart ? -1 : 1;
            if (aSmart) {
                const aStats = ruleStats.get(a.id) || { lastUsed: 0, matchCount: 0 };
                const bStats = ruleStats.get(b.id) || { lastUsed: 0, matchCount: 0 };
                if (aStats.lastUsed !== bStats.lastUsed) return bStats.lastUsed - aStats.lastUsed;
                if (aStats.matchCount !== bStats.matchCount) return bStats.matchCount - aStats.matchCount;
            }
            return 0;
        });

        if (!rulesList.length) return;
        buildCombinedRegex(rulesList);
        const nowTs = now();

        // Pass 0: Cross-element replacement (Range API). A single-word match can't meaningfully
        // straddle two elements, so only pay for this full-DOM container scan + ancestor walk
        // when at least one active rule actually spans more than one word.
        const needsCrossElementPass = rulesList.some(r => countRuleWords(r) > 1);
        if (needsCrossElementPass) {
            processCrossElementReplacements(rulesList);
        }

        // Pass 1: Block-level HTML replacement
        try {
            const safeBlocks = document.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote, dd, dt');
            safeBlocks.forEach(block => {
                if (block.dataset.trProcessed) return;
                if (isInProtectedArea(block)) return;
                if (block.querySelector('a, button, input, textarea, select, iframe, script, style, [onclick]')) return;
                let html = block.innerHTML; let modified = false;
                for (const rule of rulesList) {
                    try {
                        const rx = compileRuleRegex(rule, true);
                        // Same cached-regex/lastIndex hazard as elsewhere: this rx is reused across
                        // every block in safeBlocks, so it must be reset before each .test() or a
                        // match in an earlier block can cause a later block's real match to be missed.
                        rx.lastIndex = 0;
                        const beforeHtml = html;
                        if (rx.test(html)) {
                            html = html.replace(rx, (...args) => {
                                const matchedStr = args[0];
                                const offset = args[args.length - 2];
                                const fullStr = args[args.length - 1];
                                const before = fullStr.substring(0, offset);
                                if ((before.match(/</g) || []).length > (before.match(/>/g) || []).length) {
                                    return matchedStr;
                                }
                                modified = true;
                                const gapMatch = args.slice(2, -2).find(x => x !== undefined && x !== matchedStr);
                                const rep = processReplacement(rule, matchedStr, gapMatch);
                                const trId = 'tr' + (++trIdCounter);
                                repDataMap.set(trId, { orig: matchedStr, ruleId: rule.id });
                                return `<span class="${enableHighlight ? 'tr-replaced' : 'tr-replaced-hidden'}" data-tr-id="${trId}">${rep}</span>`;
                            });
                            if (html !== beforeHtml) {
                                const s = ruleStats.get(rule.id) || { lastUsed: 0, matchCount: 0 };
                                s.lastUsed = nowTs; s.matchCount++; ruleStats.set(rule.id, s);
                                scheduleStatsSave();
                            }
                        }
                    } catch(e) { error('Block replacement error', e); }
                }
                if (modified) { block.innerHTML = html; block.dataset.trProcessed = "true"; }
            });
        } catch (e) { error('Pass 1 error', e); }

        // Pass 2: Text node replacement (optimised)
        try {
            const nodeFilter = {
                acceptNode: function(node) {
                    const p = node.parentElement;
                    if (!p) return NodeFilter.FILTER_REJECT;
                    const tag = p.tagName;
                    if (tag === 'HEAD' || tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'CODE' || tag === 'PRE' || tag === 'SVG' || tag === 'PATH' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
                    if (p.isContentEditable || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
                    if (p.closest && p.closest('#text-replacer-gui, .mui-fab, .mui-toggle, #tr-quick-edit, .tr-replaced, #tr-selection-fab, [data-tr-processed="true"]')) return NodeFilter.FILTER_REJECT;
                    if (isInProtectedArea(p)) return NodeFilter.FILTER_REJECT;
                    return NodeFilter.FILTER_ACCEPT;
                }
            };
            const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, nodeFilter, false);
            const nodesToReplace = [];
            let node;
            while ((node = walker.nextNode())) { nodesToReplace.push(node); }

            if (combinedRegex) {
                for (const textNode of nodesToReplace) {
                    let text = textNode.nodeValue;
                    let modified = false;
                    const replacements = [];
                    let match;
                    combinedRegex.lastIndex = 0;
                    while ((match = combinedRegex.exec(text)) !== null) {
                        let matchedRule = null;
                        let matchedString = match[0];
                        for (let i = 1; i <= combinedRuleMap.length; i++) {
                            if (match[i] !== undefined) {
                                matchedRule = combinedRuleMap[i-1];
                                break;
                            }
                        }
                        if (!matchedRule) continue;
                        let capturedGap = '';
                        if (matchedRule.oldText.includes('---')) {
                            const rx = compileRuleRegex(matchedRule, false);
                            rx.lastIndex = 0;
                            const ruleMatch = rx.exec(matchedString);
                            if (ruleMatch) {
                                capturedGap = ruleMatch[2] || ruleMatch[3] || '';
                            }
                        }
                        const rep = processReplacement(matchedRule, matchedString, capturedGap);
                        replacements.push({ start: match.index, end: combinedRegex.lastIndex, str: matchedString, rep, rule: matchedRule });
                        modified = true;
                    }
                    if (modified) {
                        const fragment = document.createDocumentFragment();
                        let lastIdx = 0;
                        replacements.sort((a,b) => a.start - b.start);
                        for (const repl of replacements) {
                            if (repl.start > lastIdx) {
                                fragment.appendChild(document.createTextNode(text.substring(lastIdx, repl.start)));
                            }
                            const trId = 'tr' + (++trIdCounter);
                            repDataMap.set(trId, { orig: repl.str, ruleId: repl.rule.id });
                            const span = document.createElement('span');
                            span.className = enableHighlight ? 'tr-replaced' : 'tr-replaced-hidden';
                            span.textContent = repl.rep;
                            span.dataset.trId = trId;
                            fragment.appendChild(span);
                            lastIdx = repl.end;
                            const s = ruleStats.get(repl.rule.id) || { lastUsed: 0, matchCount: 0 };
                            s.lastUsed = nowTs; s.matchCount++;
                            ruleStats.set(repl.rule.id, s);
                            scheduleStatsSave();
                        }
                        if (lastIdx < text.length) {
                            fragment.appendChild(document.createTextNode(text.substring(lastIdx)));
                        }
                        textNode.parentNode.replaceChild(fragment, textNode);
                    }
                }
            } else {
                // Fallback to per-rule loop
                for (const textNode of nodesToReplace) {
                    let text = textNode.nodeValue; let modified = false; let ruleMap = [];
                    for (const rule of rulesList) {
                        try {
                            const rx = compileRuleRegex(rule, false);
                            // rx is cached/shared across every text node in this loop; without
                            // resetting lastIndex first, a match found in an earlier node can leave
                            // it pointed mid-string, causing .test() here to miss a real match and
                            // silently skip this rule for this node (letting a shorter overlapping
                            // rule apply instead — this was the source of the overwrite-priority bug).
                            rx.lastIndex = 0;
                            const beforeText = text;
                            if (!rx.test(text)) continue;
                            rx.lastIndex = 0;
                            text = text.replace(rx, (...args) => {
                                modified = true;
                                const matchedStr = args[0];
                                const gapMatch = args.slice(2, -2).find(x => x !== undefined && x !== matchedStr);
                                const rep = processReplacement(rule, matchedStr, gapMatch);
                                const marker = `[[TR_REP_${rule.id}_${uuid()}]]`;
                                ruleMap.push({ marker, rep, orig: matchedStr, ruleId: rule.id });
                                return marker;
                            });
                            if (text !== beforeText) {
                                const s = ruleStats.get(rule.id) || { lastUsed: 0, matchCount: 0 };
                                s.lastUsed = nowTs; s.matchCount++; ruleStats.set(rule.id, s);
                                scheduleStatsSave();
                            }
                        } catch(e) { error('Text replacement error', e); }
                    }
                    if (modified && textNode.parentNode) {
                        const fragment = document.createDocumentFragment();
                        const splitRegex = /(\[\[TR_REP_[^\]]+\]\])/g;
                        const parts = text.split(splitRegex);
                        parts.forEach(part => {
                            const mapped = ruleMap.find(rm => rm.marker === part);
                            if (mapped) {
                                const trId = 'tr' + (++trIdCounter);
                                repDataMap.set(trId, { orig: mapped.orig, ruleId: mapped.ruleId });
                                const span = document.createElement('span');
                                span.className = enableHighlight ? 'tr-replaced' : 'tr-replaced-hidden';
                                span.textContent = mapped.rep;
                                span.dataset.trId = trId;
                                fragment.appendChild(span);
                            } else if (part) { fragment.appendChild(document.createTextNode(part)); }
                        });
                        textNode.parentNode.replaceChild(fragment, textNode);
                    }
                }
            }
        } catch (e) { error('Pass 2 error', e); }
    }

    // ---------- VIRTUALIZED GUI ----------
    function updateGuiIfNeeded() { try { if (isGuiOpen && listContainer) renderVirtualList(); } catch(e) { error('updateGuiIfNeeded failed', e); } }

    function saveUIScrollForHost(host, offset) { try { const map = readGM(UI_SCROLL_KEY, {}) || {}; map[host] = offset; writeGM(UI_SCROLL_KEY, map); } catch (e) {} }
    function loadUIScrollForHost(host) { try { const map = readGM(UI_SCROLL_KEY, {}) || {}; const v = map[host]; return (typeof v === 'number') ? v : 0; } catch (e) { return 0; } }
    function saveUIScrollDebounced() {
        if (!listContainer) return;
        if (scrollSaveTimer) clearTimeout(scrollSaveTimer);
        const offset = listContainer.scrollTop;
        scrollSaveTimer = setTimeout(() => { saveUIScrollForHost(HOST, offset); scrollSaveTimer = null; }, SCROLL_SAVE_DEBOUNCE);
    }

    function renderVirtualList() {
        try {
            if (!listContainer || !virtualScroller) return;
            if (!localRules || localRules.length === 0) {
                virtualScroller.style.height = '100px';
                virtualScroller.innerHTML = `<div style="text-align: center; padding: 40px; color: #777;">No Terms Found. Use [＋ Add Term] or [Import] to begin.</div>`;
                return;
            }
            let filteredRules = localRules || [];
            if (searchQuery.trim() !== '') {
                const lowerQ = searchQuery.toLowerCase();
                filteredRules = filteredRules.filter(r => r.oldText.toLowerCase().includes(lowerQ) || r.newText.toLowerCase().includes(lowerQ));
            }
            if (filteredRules.length === 0) {
                virtualScroller.style.height = '100px';
                virtualScroller.innerHTML = `<div style="text-align: center; padding: 40px; color: #777;">No results for "${escapeHtml(searchQuery)}".</div>`;
                return;
            }
            const sorted = filteredRules.sort((a, b) => a.oldText.localeCompare(b.oldText));
            const scrollTop = listContainer.scrollTop;
            const viewportHeight = listContainer.clientHeight || 400;
            virtualScroller.style.height = `${sorted.length * CARD_HEIGHT}px`;
            const startIndex = Math.max(0, Math.floor(scrollTop / CARD_HEIGHT) - 2);
            const endIndex = Math.min(sorted.length, Math.ceil((scrollTop + viewportHeight) / CARD_HEIGHT) + 2);
            const nowTs = now();
            let htmlStr = '';
            for (let i = startIndex; i < endIndex; i++) {
                const r = sorted[i]; const isActive = !!activeRules[r.id];
                const stats = ruleStats.get(r.id);
                const isRecent = stats && (nowTs - stats.lastUsed) < 3600000;
                const meta = `${isActive ? '✅ Active' : '💤 Idle'} • ${r.forceGlobal ? '🌍 Global' : '🤖 Auto'} ${r.smartPriority ? '• ⚡ Priority' : ''}${isRecent ? ' • ⏱️ Recent' : ''}`;
                htmlStr += `
                    <div class="mui-card ${isActive ? 'active' : ''}" style="top:${i * CARD_HEIGHT}px" data-id="${r.id}">
                        <div style="flex-grow:1; overflow:hidden;">
                            <div class="mui-rule-text">"${escapeHtml(r.oldText)}" ➡ "${escapeHtml(r.newText)}"</div>
                            <div class="mui-rule-meta">${meta}</div>
                        </div>
                        <div class="mui-card-actions">
                            <button class="mui-icon-btn mui-tonal edit-btn">✏️</button>
                            <button class="mui-icon-btn mui-error del-btn">🗑️</button>
                        </div>
                    </div>
                `;
            }
            virtualScroller.innerHTML = htmlStr;
        } catch (e) { error('renderVirtualList failed', e); }
    }

    function buildFullGUI() {
        try {
            searchQuery = '';
            mainPage.innerHTML = `
                <div class="mui-header"><h2>Library</h2><button class="mui-icon-btn" id="tr-settings-btn">⚙️</button></div>
                <div class="mui-search-bar">
                    <span style="opacity:0.6; margin-right:8px;">🔍</span>
                    <input type="text" id="tr-search-input" placeholder="Search terms...">
                </div>
                <div class="mui-list-container" id="tr-list-container">
                    <div id="tr-virtual-scroller" style="position: relative; width: 100%;"></div>
                </div>
                <div class="mui-bottom-actions">
                    <button class="mui-button mui-pill-primary" id="tr-add-btn">＋ Add Term</button>
                    <div style="display:flex; gap:8px;">
                        <button class="mui-button mui-pill-secondary" id="tr-backup-btn">Backup All</button>
                        <button class="mui-button mui-pill-secondary" id="tr-import-btn">Import</button>
                    </div>
                </div>
            `;
            listContainer = mainPage.querySelector('#tr-list-container');
            virtualScroller = mainPage.querySelector('#tr-virtual-scroller');
            const searchInput = mainPage.querySelector('#tr-search-input');
            searchInput.addEventListener('input', (e) => {
                searchQuery = e.target.value;
                listContainer.scrollTop = 0;
                renderVirtualList();
            });
            listContainer.addEventListener('scroll', () => {
                if (!isRenderingScroll) {
                    isRenderingScroll = true;
                    requestAnimationFrame(() => {
                        if (isGuiOpen) renderVirtualList();
                        isRenderingScroll = false;
                    });
                }
                saveUIScrollDebounced();
            });
            virtualScroller.addEventListener('click', (e) => {
                const editBtn = e.target.closest('.edit-btn');
                if (editBtn) return editRuleInteractive(editBtn.closest('.mui-card').dataset.id);
                const delBtn = e.target.closest('.del-btn');
                if (delBtn) return deleteRuleInteractive(delBtn.closest('.mui-card').dataset.id);
            });
            const savedScroll = loadUIScrollForHost(HOST);
            if (typeof savedScroll === 'number') setTimeout(() => { if (listContainer) listContainer.scrollTop = savedScroll; }, 0);
            mainPage.querySelector('#tr-settings-btn').onclick = () => {
                if (!isNavigating) showPage('settings');
            };
            mainPage.querySelector('#tr-add-btn').onclick = () => addRuleInteractive();
            mainPage.querySelector('#tr-backup-btn').onclick = backupAllData;
            mainPage.querySelector('#tr-import-btn').onclick = () => { promptFileImport(); };
            renderVirtualList();
        } catch (e) { error('buildFullGUI failed', e); }
    }

    // ---------- UNIFIED BACKUP / IMPORT ----------
    async function backupAllData() {
        const rules = await dbGetAll();
        const backup = {
            version: 2,
            timestamp: now(),
            rules: rules.map(r => ({ ...r })),
            blockedDomains: [...blockedDomains],
            protectedSelectors: [...protectedSelectors]
        };
        const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `text-replacer-backup-${now()}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    function promptFileImport() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.style.display = 'none';
        input.onchange = async (e) => {
            const f = e.target.files && e.target.files[0];
            if (!f) return;
            try {
                const text = await f.text();
                await applyImportedData(text);
            } catch(err) {
                alert('Failed to import file.');
                error(err);
            } finally {
                input.remove();
            }
        };
        document.body.appendChild(input);
        input.click();
    }

    async function applyImportedData(jsonStr) {
        let payload;
        try { payload = JSON.parse(jsonStr); } catch (e) { alert('Invalid JSON.'); return; }

        let importedRules = null;
        let importedBlocked = null;
        let importedProtected = null;

        if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
            if (Array.isArray(payload.rules)) importedRules = payload.rules;
            if (Array.isArray(payload.blockedDomains)) importedBlocked = payload.blockedDomains;
            if (Array.isArray(payload.protectedSelectors)) importedProtected = payload.protectedSelectors;
            if (!importedBlocked && Array.isArray(payload.domains)) importedBlocked = payload.domains;
        } else if (Array.isArray(payload)) {
            importedRules = payload;
        } else if (payload && typeof payload === 'object' && !payload.rules && Array.isArray(payload.domains)) {
            importedBlocked = payload.domains;
        }

        if (importedRules) {
            const current = await dbGetAll();
            const byId = new Map(current.map(r => [r.id, r]));
            const bySig = new Map(current.map(r => [signatureOf(r), r]));
            for (const r of importedRules) {
                if (!r || !r.oldText) continue;
                const cand = {
                    id: r.id || uuid(),
                    oldText: r.oldText,
                    newText: r.newText || '',
                    caseSensitive: !!r.caseSensitive,
                    forceGlobal: !!r.forceGlobal,
                    smartPriority: !!r.smartPriority,
                    enabled: r.enabled !== false,
                    createdAt: r.createdAt || now(),
                    updatedAt: r.updatedAt || now(),
                    site: r.site || null
                };
                if (byId.has(cand.id)) {
                    const local = byId.get(cand.id);
                    if ((cand.updatedAt || 0) > (local.updatedAt || 0)) await dbPut({ ...local, ...cand, id: local.id });
                } else {
                    const sig = signatureOf(cand);
                    if (bySig.has(sig)) {
                        const local = bySig.get(sig);
                        if ((cand.updatedAt || 0) > (local.updatedAt || 0)) await dbPut({ ...local, ...cand, id: local.id });
                    } else await dbPut(cand);
                }
            }
        }

        if (importedBlocked) {
            blockedDomains = importedBlocked;
            await saveBlocked();
        }

        if (importedProtected) {
            protectedSelectors = importedProtected;
            await saveProtectedSelectors();
        }

        localRules = await dbGetAll();
        scheduleWriteMasterMirror();
        revertAllReplacements();
        await runDetectionAndApplyInternal();
        updateGuiIfNeeded();
        alert('Import completed successfully.');
    }

    // ---------- DIALOG WITH OPERATOR CHEAT SHEET ----------
    function showTermDialog(isEdit = false, ruleData = {}) {
        const title = isEdit ? 'Edit Term' : 'Add New Term';
        const oldText = ruleData.oldText || '';
        const newText = ruleData.newText || '';
        const isCase = ruleData.caseSensitive || false;
        const isGlobal = ruleData.forceGlobal || false;
        const isSmart = ruleData.smartPriority || false;
        let contentHtml = `
            <div class="mui-expressive-dialog mui-term-dialog">
                <h3>${title}</h3>
                <div class="mui-operator-info">
                    <strong>Operators:</strong>
                    <ul style="margin:4px 0; padding-left:18px; font-size:13px; line-height:1.5;">
                        <li><b>|</b> – Multi‑term: "word1 | word2"</li>
                        <li><b>---</b> – Gap: "first --- second" matches a gap of any words</li>
                        <li><b>#{word1,word2}#</b> – Filter: exclude words from the gap</li>
                        <li>Cross‑element matching is automatic (no special syntax)</li>
                    </ul>
                </div>
                <div class="mui-form-group">
                    <label for="mui-old-text">Original:</label>
                    <input type="text" id="mui-old-text" class="mui-pill-field" placeholder="Text to replace..." value="${escapeHtml(oldText)}">
                </div>
                <div class="mui-form-group">
                    <label for="mui-new-text">Replacement:</label>
                    <input type="text" id="mui-new-text" class="mui-pill-field" placeholder="New text..." value="${escapeHtml(newText)}">
                </div>
                <div class="mui-expressive-checkboxes">
                    <label class="mui-check-group"><input type="checkbox" id="mui-case-check" ${isCase ? 'checked' : ''}><span>Case Sensitive</span></label>
                    <label class="mui-check-group"><input type="checkbox" id="mui-global-check" ${isGlobal ? 'checked' : ''}><span>Force Global</span></label>
                    <label class="mui-check-group"><input type="checkbox" id="mui-smart-check" ${isSmart ? 'checked' : ''}><span>Smart Priority</span></label>
                </div>
                <div class="mui-dialog-actions mui-centered-pills">
                    <button class="mui-button mui-pill-secondary" id="mui-dialog-cancel">Cancel</button>
                    <button class="mui-button mui-pill-primary" id="mui-dialog-save">${isEdit ? 'Save Changes' : 'Add Term'}</button>
                </div>
            </div>
        `;
        showCustomDialog(contentHtml, () => {
            const saveBtn = dialogWrapper.querySelector('#mui-dialog-save');
            const cancelBtn = dialogWrapper.querySelector('#mui-dialog-cancel');
            saveBtn.onclick = async () => {
                const oldInput = dialogWrapper.querySelector('#mui-old-text').value.trim();
                const newInput = dialogWrapper.querySelector('#mui-new-text').value.trim();
                const isCaseInput = dialogWrapper.querySelector('#mui-case-check').checked;
                const isGlobalInput = dialogWrapper.querySelector('#mui-global-check').checked;
                const isSmartInput = dialogWrapper.querySelector('#mui-smart-check').checked;
                if (!oldInput || newInput === undefined) { alert('Original and replacement fields cannot be empty.'); return; }
                if (isEdit) {
                    ruleData.oldText = oldInput;
                    ruleData.newText = newInput;
                    ruleData.caseSensitive = isCaseInput;
                    ruleData.forceGlobal = isGlobalInput;
                    ruleData.smartPriority = isSmartInput;
                    ruleData.updatedAt = now();
                    await dbPut(ruleData);
                } else {
                    const t = now();
                    const newRule = {
                        id: uuid(),
                        oldText: oldInput,
                        newText: newInput,
                        caseSensitive: isCaseInput,
                        forceGlobal: isGlobalInput,
                        smartPriority: isSmartInput,
                        enabled: true,
                        createdAt: t,
                        updatedAt: t,
                        site: HOST
                    };
                    await dbPut(newRule);
                }
                closeCustomDialog();
                localRules = await dbGetAll();
                scheduleWriteMasterMirror();
                revertAllReplacements();
                await runDetectionAndApplyInternal();
                updateGuiIfNeeded();
            };
            cancelBtn.onclick = closeCustomDialog;
        });
    }

    function addRuleInteractive(prefill = '') { showTermDialog(false, { oldText: prefill }); }
    async function editRuleInteractive(id) {
        const r = localRules.find(x => x.id === id);
        if (!r) return;
        showTermDialog(true, r);
    }
    async function deleteRuleInteractive(id) {
        if (confirm('Delete this rule permanently?')) {
            await dbDelete(id);
            localRules = await dbGetAll();
            scheduleWriteMasterMirror();
            revertAllReplacements();
            await runDetectionAndApplyInternal();
            updateGuiIfNeeded();
        }
    }

    // ---------- SETTINGS WITH SCROLL FIX ----------
    function createEditableListRow(value, { onSave, onDelete }) {
        const row = document.createElement('div');
        row.className = 'mui-settings-row';

        const textSpan = document.createElement('span');
        textSpan.className = 'mui-row-text';
        textSpan.textContent = value;
        textSpan.title = 'Click to edit';

        const actions = document.createElement('div');
        actions.className = 'mui-row-actions';

        const editBtn = document.createElement('button');
        editBtn.textContent = '✏️';
        editBtn.className = 'mui-icon-btn mui-tonal';
        editBtn.title = 'Edit';

        const delBtn = document.createElement('button');
        delBtn.textContent = '✖';
        delBtn.className = 'mui-icon-btn mui-error';
        delBtn.title = 'Remove';

        let input = null;
        function restoreView() {
            if (input && row.contains(input)) row.replaceChild(textSpan, input);
            actions.classList.remove('mui-hidden');
        }

        function enterEditMode() {
            if (input) return; // already editing
            input = document.createElement('input');
            input.type = 'text';
            input.value = value;
            input.className = 'mui-row-edit-input';
            row.replaceChild(input, textSpan);
            actions.classList.add('mui-hidden');
            input.focus();
            input.select();

            let finished = false;
            function commit() {
                if (finished) return; finished = true;
                const newVal = input.value.trim();
                if (newVal && newVal !== value) { onSave(newVal); return; }
                restoreView();
            }
            function cancel() {
                if (finished) return; finished = true;
                restoreView();
            }
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); commit(); }
                else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
            });
            input.addEventListener('blur', commit);
        }

        textSpan.addEventListener('click', enterEditMode);
        editBtn.onclick = enterEditMode;
        delBtn.onclick = onDelete;

        actions.appendChild(editBtn);
        actions.appendChild(delBtn);
        row.appendChild(textSpan);
        row.appendChild(actions);
        return row;
    }

    function showSettings() {
        if (!isGuiOpen) return;
        try {
            settingsPage.innerHTML = `
                <div class="mui-header mui-settings-header">
                    <button class="mui-button mui-back-pill mui-pill-settings" id="tr-back-btn">⬅ Back</button>
                    <h2>Settings</h2>
                </div>
                <div class="mui-settings-container" id="tr-set-cont"></div>
            `;
            const cont = settingsPage.querySelector('#tr-set-cont');

            // --- Protected Areas ---
            const protTitle = document.createElement('div'); protTitle.className = 'mui-settings-title'; protTitle.textContent = 'Protected Areas (no replacement)'; cont.appendChild(protTitle);
            const protDesc = document.createElement('div'); protDesc.textContent = 'CSS selectors for elements where replacement should be blocked (e.g., text inputs, comment fields).'; protDesc.style.fontSize = '12px'; protDesc.style.marginBottom = '8px'; cont.appendChild(protDesc);

            const protListContainer = document.createElement('div');
            protListContainer.className = 'mui-scroll-list';

            protectedSelectors.forEach(sel => {
                const row = createEditableListRow(sel, {
                    onSave: (newVal) => {
                        if (protectedSelectors.includes(newVal)) { alert('That selector already exists.'); return; }
                        protectedSelectors = protectedSelectors.map(s => s === sel ? newVal : s);
                        saveProtectedSelectors();
                        showSettings();
                    },
                    onDelete: () => {
                        protectedSelectors = protectedSelectors.filter(s => s !== sel);
                        saveProtectedSelectors();
                        showSettings();
                    }
                });
                protListContainer.appendChild(row);
            });
            cont.appendChild(protListContainer);

            const addProtRow = document.createElement('div'); addProtRow.style.display = 'flex'; addProtRow.style.gap = '8px'; addProtRow.style.marginBottom = '16px';
            const protInput = document.createElement('input'); protInput.type = 'text'; protInput.placeholder = 'e.g., .comment-box, #editor'; protInput.style.flex = '1'; protInput.style.padding = '8px'; protInput.style.borderRadius = '8px'; protInput.style.border = '1px solid #ccc';
            const addBtn = document.createElement('button'); addBtn.textContent = 'Add'; addBtn.className = 'mui-button mui-pill-settings';
            addBtn.onclick = () => {
                const val = protInput.value.trim();
                if (val && !protectedSelectors.includes(val)) {
                    protectedSelectors.push(val);
                    saveProtectedSelectors();
                    showSettings();
                }
            };
            addProtRow.appendChild(protInput); addProtRow.appendChild(addBtn);
            cont.appendChild(addProtRow);

            // --- Blocklist ---
            const blTitle = document.createElement('div'); blTitle.className = 'mui-settings-title'; blTitle.textContent = 'Blocklist (Global)'; cont.appendChild(blTitle);

            const blocklistContainer = document.createElement('div');
            blocklistContainer.className = 'mui-scroll-list';

            (blockedDomains || []).forEach(d => {
                const row = createEditableListRow(d, {
                    onSave: (newVal) => {
                        if (blockedDomains.includes(newVal)) { alert('That domain already exists.'); return; }
                        blockedDomains = blockedDomains.map(x => x === d ? newVal : x);
                        saveBlocked();
                        showSettings();
                    },
                    onDelete: () => {
                        blockedDomains = blockedDomains.filter(x => x !== d);
                        saveBlocked();
                        showSettings();
                    }
                });
                blocklistContainer.appendChild(row);
            });

            const blockBtn = document.createElement('button'); blockBtn.textContent = '🚫 Block Current Site';
            blockBtn.className = 'mui-button mui-pill-settings';
            blockBtn.style.marginBottom = '12px';
            blockBtn.onclick = () => { if (!blockedDomains.includes(HOST)) { blockedDomains.push(HOST); saveBlocked(); showSettings(); } };

            cont.appendChild(blockBtn);
            cont.appendChild(blocklistContainer);

            const note = document.createElement('div'); note.textContent = 'Use "Backup All" in the Library to export everything.'; note.style.fontSize = '12px'; note.style.marginBottom = '12px'; cont.appendChild(note);

            // Highlight toggle
            const hlTitle = document.createElement('div'); hlTitle.className = 'mui-settings-title'; hlTitle.textContent = 'Appearance'; cont.appendChild(hlTitle);
            const hlBtn = document.createElement('button'); hlBtn.textContent = enableHighlight ? '🔵 Blue Highlight: ON' : '⚪ Blue Highlight: OFF';
            hlBtn.className = 'mui-button mui-pill-settings';
            hlBtn.onclick = () => { enableHighlight = !enableHighlight; saveHighlightSetting(); revertAllReplacements(); runDetectionAndApplyInternal(); showSettings(); };
            cont.appendChild(hlBtn);

            if (externalIhwAPI) {
                const othersTitle = document.createElement('div'); othersTitle.className = 'mui-settings-title'; othersTitle.textContent = 'Other Userscripts'; cont.appendChild(othersTitle);
                const ihwRow = document.createElement('div'); ihwRow.className = 'mui-settings-row';
                ihwRow.innerHTML = `<span style="font-weight: 500;">I Hate Waiting</span>`;
                const ihwBtn = document.createElement('button'); ihwBtn.className = 'mui-button mui-pill-settings';
                ihwBtn.textContent = externalIhwAPI.isOff ? 'OFF' : 'ON';
                if (!externalIhwAPI.isOff) {
                    ihwBtn.style.background = 'var(--md-sys-color-primary)';
                    ihwBtn.style.color = 'var(--md-sys-color-surface)';
                }
                ihwBtn.onclick = () => { externalIhwAPI.toggle(); showSettings(); };
                ihwRow.appendChild(ihwBtn);
                cont.appendChild(ihwRow);
            }

            const backBtn = settingsPage.querySelector('#tr-back-btn');
            backBtn.onclick = () => { if (!isNavigating) showPage('main'); };
        } catch (e) { error('showSettings failed', e); }
    }

    // ---------- QUICK EDIT & SELECTION ----------
    function createQuickEditGUI() {
        if (document.getElementById('tr-quick-edit')) return;
        quickEditBox = document.createElement('div'); quickEditBox.id = 'tr-quick-edit'; quickEditBox.className = 'mui-hidden';
        quickEditBox.innerHTML = `<div><label>Original:</label> <span class="qe-orig-text" id="qe-from"></span></div><div style="margin-top: 4px;"><button class="mui-icon-btn mui-tonal" id="qe-edit-btn">✏️</button></div>`;
        document.body.appendChild(quickEditBox);
        document.getElementById('qe-edit-btn').onclick = () => { if (quickEditActiveId) { editRuleInteractive(quickEditActiveId); hideQuickEdit(); } };
        document.addEventListener('click', (e) => {
            if (e.target.classList.contains('tr-replaced')) showQuickEdit(e.target);
            else if (quickEditBox && !quickEditBox.contains(e.target) && !e.target.classList.contains('tr-replaced')) hideQuickEdit();
        });
    }

    function showQuickEdit(targetElement) {
        if (!quickEditBox) return;
        const data = repDataMap.get(targetElement.dataset.trId);
        if (!data) return;
        document.getElementById('qe-from').textContent = data.orig;
        quickEditActiveId = data.ruleId;
        const rect = targetElement.getBoundingClientRect();
        quickEditBox.style.top = `${rect.bottom + window.pageYOffset + 8}px`;
        quickEditBox.style.left = `${rect.left + window.pageXOffset}px`;
        quickEditBox.classList.remove('mui-hidden');
    }
    function hideQuickEdit() { if (quickEditBox) quickEditBox.classList.add('mui-hidden'); quickEditActiveId = null; }

    function createSelectionFab() {
        if (document.getElementById('tr-selection-fab')) return;
        selectionFab = document.createElement('button'); selectionFab.id = 'tr-selection-fab'; selectionFab.className = 'mui-hidden'; selectionFab.textContent = '✏️';
        document.body.appendChild(selectionFab);
        selectionFab.onclick = () => { const txt = window.getSelection().toString().trim(); if (txt) { window.getSelection().removeAllRanges(); selectionFab.classList.add('mui-hidden'); addRuleInteractive(txt); } };
        document.addEventListener('selectionchange', () => {
            const selection = window.getSelection(); const txt = selection.toString().trim();
            if (txt && selection.rangeCount > 0) {
                const anc = selection.getRangeAt(0).commonAncestorContainer;
                if (anc && anc.closest && anc.closest('#text-replacer-gui, #tr-quick-edit, #tr-term-dialog')) { selectionFab.classList.add('mui-hidden'); return; }
                selectionFab.classList.remove('mui-hidden');
            } else { selectionFab.classList.add('mui-hidden'); }
        });
    }

    // ---------- STYLES ----------
    function applyStyles() {
        if (document.getElementById('tr-styles')) return;
        const style = document.createElement('style'); style.id = 'tr-styles';
        style.textContent = `
            :root { --md-sys-color-primary: ${siteThemeColor}; --md-sys-color-surface: #FEF7FF; --md-sys-color-surface-container: #F3EDF7; --md-sys-color-on-surface: #1D1B20; --md-pill-radius: 9999px; --md-ease-standard: cubic-bezier(0.2, 0, 0, 1.0); --md-ease-emphasized: cubic-bezier(0.05, 0.7, 0.1, 1.0); --md-ease-expressive: cubic-bezier(0.25, 1.25, 0.25, 1.0); }
            .mui-box { position:fixed; top:50%; left:50%; transform:translate(-50%,-50%) scale(0.95); opacity:0; visibility:hidden; width:90vw; max-width:450px; height:82vh; min-height:520px; background:var(--md-sys-color-surface); color:var(--md-sys-color-on-surface); padding:24px; border-radius:28px; box-shadow:0 8px 30px rgba(0,0,0,.15); z-index:2147483647; max-height:800px; display:flex; flex-direction:column; transition:transform 0.4s var(--md-ease-standard), opacity 0.4s var(--md-ease-standard), visibility 0s linear 0.4s; pointer-events:none; overflow: hidden; }
            .mui-box.open { transform:translate(-50%,-50%) scale(1); opacity:1; visibility:visible; pointer-events:auto; transition:transform 0.4s var(--md-ease-standard), opacity 0.4s var(--md-ease-standard), visibility 0s; }
            .mui-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; flex-shrink: 0; }
            .mui-header h2 { margin:0; font-size:22px; font-weight:500; text-align: center; flex: 1; }
            .mui-search-bar { display:flex; align-items:center; background:#E6E0E9; border-radius: 28px; padding: 0 16px; margin-bottom: 12px; height: 50px; transition: background 0.2s; flex-shrink: 0; }
            .mui-search-bar:focus-within { background: #E8DEF8; }
            .mui-search-bar input { border:none; background:transparent; outline:none; font-size:16px; flex-grow:1; color:var(--md-sys-color-on-surface); font-family:inherit; }
            .mui-list-container { overflow-y:auto; flex-grow:1; position:relative; display:flex; flex-direction:column; gap:12px; }
            .mui-card { position:absolute; left:0; right:8px; height:76px; background:var(--md-sys-color-surface-container); border-radius:16px; padding:12px 16px; display:flex; justify-content:space-between; align-items:center; border-left:6px solid #CAC4D0; opacity:0.8; transition:transform 0.2s, box-shadow 0.2s; box-sizing:border-box;}
            .mui-card:hover { transform:translateY(-2px); box-shadow:0 4px 8px rgba(0,0,0,0.1); }
            .mui-card.active { border-left-color:#386A20; opacity:1; }
            .mui-rule-text { font-size:16px; font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
            .mui-rule-meta { font-size:12px; opacity:0.7; }
            .mui-card-actions { display:flex; gap:8px; }
            .mui-bottom-actions { margin-top:16px; display:flex; flex-direction:column; gap:12px; flex-shrink: 0; align-items: center;}
            .mui-toggle { position:fixed; top:15vh; left:0; width:48px; height:48px; background:var(--md-sys-color-primary); color:#fff; border-radius:0 16px 16px 0; text-align:center; line-height:48px; cursor:pointer; z-index:2147483647; font-size:22px; box-shadow:2px 2px 8px rgba(0,0,0,0.2); transition:transform 0.2s; }
            .mui-toggle:hover { transform:scale(1.05); }
            .mui-hidden { display:none!important; }
            .tr-replaced { background:rgba(103,80,164,0.15); border-bottom:2px solid var(--md-sys-color-primary); border-radius:4px; padding:0 2px; cursor:pointer; }
            .tr-replaced-hidden { display:inline; cursor:text; }
            #tr-quick-edit { position:absolute; z-index:2147483647; background:#ECE6F0; color:#1D1B20; padding:12px 16px; border-radius:16px; box-shadow:0 4px 12px rgba(0,0,0,0.2); font-family:system-ui,sans-serif; font-size:14px; display:flex; flex-direction:column; gap:8px; min-width:150px; }
            #tr-quick-edit label { color:#49454F; font-size:12px; font-weight:500;} .qe-orig-text { font-weight:600; overflow-wrap:break-word; max-width:200px; }
            #tr-selection-fab { position:fixed; bottom:24px; left:24px; width:56px; height:56px; background:#E8DEF8; color:#1D192B; border-radius:16px; border:none; font-size:24px; z-index:2147483646; display:flex; align-items:center; justify-content:center; cursor:pointer; box-shadow:0 4px 12px rgba(0,0,0,0.2); }
            
            .mui-page { position: absolute; top: 24px; left: 24px; right: 24px; bottom: 24px; opacity: 0; pointer-events: none; visibility: hidden; display: flex; flex-direction: column; transition: transform 0.6s var(--md-ease-expressive), opacity 0.5s var(--md-ease-standard), visibility 0s linear 0.6s; overflow: hidden;}
            
            .mui-page.active { opacity: 1; pointer-events: inherit; visibility: inherit; transform: translate(0,0) scale(1); transition: transform 0.6s var(--md-ease-expressive), opacity 0.5s var(--md-ease-standard), visibility 0s; }
            
            .mui-page.mui-page-enter { transform: translate(30%,0) scale(1.05); opacity: 0; visibility: inherit; transition: visibility 0s; }
            .mui-page.mui-page-leave { transform: translate(-30%,0) scale(0.9); opacity: 0; visibility: inherit; }
            .mui-page.mui-page-leave.active { visibility: hidden; transition: transform 0.6s var(--md-ease-expressive), opacity 0.5s var(--md-ease-standard), visibility 0s linear 0.6s; }
            
            .mui-button { border:none; border-radius:var(--md-pill-radius); font-weight:500; cursor:pointer; font-size:16px; transition: opacity 0.2s, transform 0.1s; display:flex; align-items:center; justify-content:center; flex:1; width: 100%; box-sizing: border-box;}
            .mui-button:active { transform: scale(0.98); }
            .mui-icon-btn { border:none; background:transparent; border-radius:50%; width:40px; height:40px; cursor:pointer; font-size:16px; display:flex; align-items:center; justify-content:center; flex-shrink: 0; }
            .mui-icon-btn:hover { background:rgba(0,0,0,0.05); }
            .mui-tonal { background:#E8DEF8; } .mui-error { background:#F9DEDC; color:#410E0B; }
            
            .mui-pill-primary { background: #00E676; color: #fff; padding: 14px 28px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;}
            .mui-pill-secondary { background: #302E3E; color: #fff; padding: 12px 26px; }
            .mui-back-pill { background: #E8DEF8; color: #1D192B; padding: 10px 20px; font-size: 14px; margin: 0; width: auto; flex: 0;}

            #tr-settings-page { overflow-y: auto; }
            .mui-settings-header { justify-content: flex-start; gap: 8px; margin-bottom: 24px;}
            .mui-back-pill { font-size: 13px; padding: 6px 14px; width: max-content;}
            .mui-settings-container { display: flex; flex-direction: column; gap: 16px; padding-left: 8px; overflow-y: auto; flex: 1; }
            .mui-settings-title { font-size: 14px; font-weight: 600; color: #444; text-transform: uppercase; letter-spacing: 1px; margin-top: 8px;}
            .mui-settings-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 10px 4px; border-bottom: 1px solid #EEE; }
            .mui-settings-action-row { display: flex; gap: 8px; }

            .mui-scroll-list { height: 38vh; min-height: 220px; max-height: 420px; overflow-y: auto; border: 1px solid var(--md-sys-color-surface-container); border-radius: 12px; padding: 4px 10px; margin-bottom: 12px; scrollbar-width: thin; scrollbar-color: var(--md-sys-color-primary) transparent; }
            .mui-scroll-list::-webkit-scrollbar { width: 8px; }
            .mui-scroll-list::-webkit-scrollbar-track { background: transparent; }
            .mui-scroll-list::-webkit-scrollbar-thumb { background-color: rgba(103,80,164,0.4); border-radius: 4px; }
            .mui-scroll-list::-webkit-scrollbar-thumb:hover { background-color: rgba(103,80,164,0.7); }
            .mui-row-text { flex: 1; font-weight: 500; word-break: break-all; cursor: text; padding: 6px 8px; border-radius: 6px; transition: background 0.15s; }
            .mui-row-text:hover { background: rgba(103,80,164,0.08); }
            .mui-row-actions { display: flex; gap: 4px; flex-shrink: 0; }
            .mui-row-edit-input { flex: 1; font: inherit; font-size: 14px; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--md-sys-color-primary); outline: none; background: #fff; color: inherit; min-width: 0; }

            .mui-pill-settings { background: #ECE6F0; color: #1D1B20; font-size: 13px; font-weight: 500; padding: 6px 14px; width: max-content; flex: none;}
            .mui-pill-settings:hover { background: #E8DEF8; }
            
            .mui-dialog-overlay { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.5); z-index: 2147483648; opacity: 0; pointer-events: none; visibility: hidden; transition: opacity 0.4s var(--md-ease-standard); }
            .mui-dialog-overlay.open { opacity: 1; pointer-events: auto; visibility: visible; }
            .mui-expressive-dialog { position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%) scale(0.9); background: var(--md-sys-color-surface); color: var(--md-sys-color-on-surface); padding: 32px; border-radius: 28px; box-shadow: 0 12px 40px rgba(0,0,0,0.3); max-width: 400px; width: 80vw; display: flex; flex-direction: column; gap: 16px; opacity: 0; transition: transform 0.6s var(--md-ease-expressive), opacity 0.4s var(--md-ease-standard); font-family: inherit;}
            .mui-dialog-overlay.open .mui-expressive-dialog { opacity: 1; transform: translate(-50%,-50%) scale(1); }
            .mui-expressive-dialog h3 { margin: 0; font-size: 20px; font-weight: 600; text-align: center; }
            .mui-operator-info { background: #E8DEF8; border-radius: 12px; padding: 8px 12px; font-size: 13px; line-height: 1.5; }
            .mui-form-group { display: flex; flex-direction: column; gap: 6px; }
            .mui-form-group label { font-size: 14px; font-weight: 500; opacity: 0.8;}
            .mui-pill-field { border: 1px solid rgba(0,0,0,0.1); border-radius: var(--md-pill-radius); padding: 12px 18px; font-size: 16px; outline: none; background: #fff; font-family: inherit;}
            .mui-expressive-checkboxes { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px;}
            .mui-check-group { display: flex; align-items: center; gap: 8px; font-size: 14px;}
            .mui-dialog-actions.mui-centered-pills { display: flex; justify-content: center; gap: 12px; margin-top: 16px;}

            @media (prefers-color-scheme: dark) {
                :root { --md-sys-color-surface: #1E1E1E; --md-sys-color-surface-container: #2C2C2C; --md-sys-color-on-surface: #E0E0E0; }
                .mui-search-bar { background: #333; }
                .mui-search-bar input { color: #ddd; }
                .mui-card { background: #2C2C2C; border-left-color: #555; }
                .mui-card.active { border-left-color:#81C784; }
                .mui-pill-primary { background: #00C853; }
                .mui-pill-secondary { background: #424242; }
                .mui-back-pill, .mui-pill-settings { background: #3A3A3A; color: #ddd; }
                .mui-pill-settings:hover { background: #4A4A4A; }
                .mui-operator-info { background: #2C2C2C; color: #ccc; }
                .mui-pill-field { background: #333; color: #eee; border-color: #555; }
                .mui-form-group label { color: #ccc; }
                .mui-settings-row { border-bottom-color: #444; }
                .mui-scroll-list { scrollbar-color: #81C784 transparent; }
                .mui-scroll-list::-webkit-scrollbar-thumb { background-color: rgba(129,199,132,0.4); }
                .mui-scroll-list::-webkit-scrollbar-thumb:hover { background-color: rgba(129,199,132,0.7); }
                .mui-row-text:hover { background: rgba(255,255,255,0.08); }
                .mui-row-edit-input { background: #333; color: #eee; border-color: #81C784; }
                .mui-tonal { background: #3A3A3A; }
                .mui-error { background: #5C2B2B; color: #F5C6C6; }
                #tr-quick-edit { background: #2C2C2C; color: #ddd; }
                #tr-quick-edit label { color: #aaa; }
                #tr-selection-fab { background: #3A3A3A; color: #ddd; }
            }
        `;
        document.documentElement.appendChild(style);
    }

    function createGUI() {
        if (document.getElementById('text-replacer-gui')) return;
        try {
            guiBox = document.createElement('div'); guiBox.id = 'text-replacer-gui'; guiBox.className = 'mui-box';
            const toggle = document.createElement('div'); toggle.className = 'mui-toggle'; toggle.textContent = '☰';
            toggle.onclick = () => {
                if (isNavigating) return;
                isGuiOpen = !isGuiOpen;
                if (isGuiOpen) {
                    guiBox.classList.add('open');
                    showPage('main');
                } else {
                    guiBox.classList.remove('open');
                }
            };
            document.documentElement.append(guiBox, toggle);

            mainPage = document.createElement('div'); mainPage.id = 'tr-main-page'; mainPage.className = 'mui-page';
            settingsPage = document.createElement('div'); settingsPage.id = 'tr-settings-page'; settingsPage.className = 'mui-page';
            guiBox.append(mainPage, settingsPage);

            dialogWrapper = document.createElement('div'); dialogWrapper.id = 'tr-dialog-wrapper'; dialogWrapper.className = 'mui-dialog-overlay';
            document.documentElement.appendChild(dialogWrapper);

            createQuickEditGUI(); createSelectionFab();
            log('GUI elements created.');
        } catch (e) { error('createGUI failed', e); }
    }

    function showCustomDialog(contentHtml, afterRenderCallback) {
        dialogWrapper.innerHTML = contentHtml;
        dialogWrapper.classList.add('open');
        guiBox.style.pointerEvents = 'none';
        afterRenderCallback();
    }
    function closeCustomDialog() {
        dialogWrapper.classList.remove('open');
        guiBox.style.pointerEvents = 'auto';
        setTimeout(() => { dialogWrapper.innerHTML = ''; }, 400);
    }

    function showPage(pageId) {
        if (isNavigating || !isGuiOpen) return;
        isNavigating = true;

        const pages = [mainPage, settingsPage];
        const nextIdx = pageId === 'main' ? 0 : 1;
        const currentIdx = 1 - nextIdx;
        const currentPage = pages[currentIdx];
        const nextPage = pages[nextIdx];

        currentPage.classList.add('mui-page-leave');
        nextPage.classList.add('mui-page-enter');
        nextPage.classList.add('mui-page-active');
        
        if (pageId === 'main') { buildFullGUI(); } else { showSettings(); }
        
        void nextPage.offsetWidth;
        currentPage.classList.remove('active');
        nextPage.classList.add('active');
        nextPage.classList.remove('mui-page-enter');

        setTimeout(() => {
            if (!currentPage.classList.contains('active')) {
                currentPage.classList.remove('mui-page-leave');
                currentPage.classList.remove('mui-page-active');
            }
            isNavigating = false;
        }, 600);
    }

    mo = new MutationObserver((mutations) => {
        let shouldRun = false;
        for (const m of mutations) {
            if (m.target.closest && m.target.closest('#text-replacer-gui, #tr-quick-edit, #tr-dialog-wrapper, .mui-fab, .mui-toggle, #tr-selection-fab, .tr-replaced, .tr-replaced-hidden')) continue;
            shouldRun = true;
            break;
        }
        if (shouldRun) {
            clearTimeout(replaceTimer);
            replaceTimer = setTimeout(runDetectionAndApplyInternal, 600);
        }
    });

    // ---------- FALLBACK INIT ----------
    function attemptInit() {
        try {
            if (document.body) {
                log('Body found, starting full init.');
                bootstrap();
            } else {
                log('Body not yet available. Retrying in 100ms...');
                setTimeout(attemptInit, 100);
            }
        } catch (e) {
            error('Init failed, will retry', e);
            setTimeout(attemptInit, 500);
        }
    }

    async function bootstrap() {
        try {
            await loadSettings();
            applyStyles(); createGUI();
            if (blockedDomains.includes(HOST)) return;
            if (document.body) {
                mo.observe(document.body, { childList: true, subtree: true, characterData: true });
            }
            localRules = await dbGetAll();
            const master = readGM(MASTER_KEY, null);
            if (master && Array.isArray(master.rules) && master.rules.length > 0) {
                // Pull in anything published from other sites/tabs, whether or not this site
                // already has local rules of its own.
                await mergeMasterPayload(master);
                localRules = await dbGetAll();
            }
            // Publish this site's rules too (debounced push itself pull-merges first), so any
            // local-only rules become visible to other sites/tabs as well.
            scheduleWriteMasterMirror();
            await runDetectionAndApplyInternal();
            if (window.__trEarlyMoCleanup) {
                window.__trEarlyMoCleanup();
                delete window.__trEarlyMoCleanup;
            }
            log('Text Replacer initialized successfully.');
        } catch (e) {
            error('Bootstrap error', e);
            createGUI();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { setTimeout(attemptInit, 0); });
    } else {
        setTimeout(attemptInit, 0);
    }

})();