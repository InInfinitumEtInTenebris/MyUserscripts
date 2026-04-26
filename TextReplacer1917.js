// ==UserScript==
// @name         Text Replacer
// @namespace    http://tampermonkey.net/
// @version      9.9.1
// @description  Virtualized M3 UI, dynamic theming, full Blocklist/Rule I/O, Multi-Term (|), Gap (---), Filter (#{...}#) operators, Expressive motion, custom CRUD GUI. Added apostrophe handling and early pattern priming. Smart Priority now uses recency/frequency; recent term detection badge. Improved lifecycle (early priming respects blocklist, disconnects after init, stats flushed on unload).
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // ---------- EXCLUSIONS ----------
    function isExcludedContext() {
        const h = window.location.hostname;
        if (h.includes('google.com/recaptcha') || h.includes('hcaptcha.com') || h.includes('cloudflare.com')) return true;
        if (document.title.includes('Just a moment...') || document.title.includes('Attention Required!')) return true;
        if (document.querySelector('.cf-browser-verification, #cf-spinner-allow-5-secs, #challenge-running')) return true;
        return false;
    }
    if (isExcludedContext()) return;

    // ---------- CONFIG ----------
    const DB_NAME = 'TextReplacerDB_v2';
    const STORE_NAME = 'rules';
    const MASTER_KEY = 'TextReplacer_MASTER_v2';
    const ACTIVE_KEY = 'TextReplacer_ACTIVE_v2';
    const BLOCK_KEY = 'TextReplacer_BLOCK_GLOBAL';
    const UI_SCROLL_KEY = 'TextReplacer_UI_SCROLL_v2';
    const SYNC_KEY = 'TextReplacer_SYNC_v2';
    const HIGHLIGHT_KEY = 'TextReplacer_HIGHLIGHT_v2';
    const STATS_KEY = 'TextReplacer_Stats_v2';
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
    let listContainer = null, virtualScroller = null, fab = null, quickEditBox = null, selectionFab = null;
    let isGuiOpen = false, writingMaster = false, applyingRemoteMaster = false;
    let lastMasterPayloadTs = 0;
    const HOST = window.location.hostname;
    let prevActiveHash = '', prevLocalHash = '';
    let replaceTimer = null, masterWriteTimer = null, scrollSaveTimer = null, userInteractTimeout = null;
    let userInteracting = false, quickEditActiveId = null, mo = null;
    let searchQuery = '';
    let externalIhwAPI = null;
    
    let repDataMap = new Map();
    let trIdCounter = 0;
    const regexCache = new Map();
    let isRenderingScroll = false;

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
    } catch (e) {}
    let statsSaveTimer = null, statsDirty = false;

    function scheduleStatsSave() {
        statsDirty = true;
        if (!statsSaveTimer) {
            statsSaveTimer = setTimeout(() => {
                flushStats();
            }, STATS_SAVE_DEBOUNCE);
        }
    }

    function flushStats() {
        if (!statsDirty) return;
        const obj = {};
        ruleStats.forEach((v, k) => { obj[k] = v; });
        try { GM_setValue(STATS_KEY, JSON.stringify(obj)); } catch (e) {}
        statsDirty = false;
        if (statsSaveTimer) {
            clearTimeout(statsSaveTimer);
            statsSaveTimer = null;
        }
    }

    // Ensure stats are saved even on tab close
    window.addEventListener('beforeunload', () => {
        flushStats();
    });

    // ---------- [IHW INTEGRATION HANDLER] ----------
    window.addEventListener('IHW_Register', (e) => {
        externalIhwAPI = e.detail;
        externalIhwAPI.hideNativeButton();
        if (isGuiOpen && document.getElementById('tr-set-cont')) {
            showSettings();
        }
    });

    // ---------- HELPERS & GM ----------
    function escapeRegExp(s) {
        if (s === "'") return "['’]"; // Enhanced apostrophe support
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    function now() { return Date.now(); }
    function uuid() { return now().toString(36) + Math.random().toString(36).slice(2); }
    function signatureOf(r) { return `${r.oldText}:::${r.newText}:::${!!r.caseSensitive}:::${!!r.forceGlobal}:::${!!r.smartPriority}`; }
    function escapeHtml(s) { return (s||'').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]); }

    function extractThemeColor() {
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta && meta.content) siteThemeColor = meta.content;
    }

    function readGM(k, fb = null) { try { const r = GM_getValue(k, null); return r === null ? fb : (typeof r === 'string' ? JSON.parse(r) : r); } catch (e) { return fb; } }
    function writeGM(k, v) { try { GM_setValue(k, JSON.stringify(v)); } catch (e) {} }

    // ---------- ENGINE LOGIC: Operators & DOM ----------
    function compileRuleRegex(rule, forHtml = false) {
        const cacheKey = `${rule.id}_${forHtml ? 'H' : 'T'}_${rule.updatedAt}`;
        if (regexCache.has(cacheKey)) return regexCache.get(cacheKey);

        const parts = rule.oldText.split(/\s*\|\s*/);
        const branchRegexes = parts.map(part => {
            const subParts = part.split(/\s*---\s*/);
            const parsedPart = subParts.map(sp => {
                return sp.split(/\s+/).map(w => w.split('').map(escapeRegExp).join('[\\u200B-\\u200D\\uFEFF]*')).join(forHtml ? '(?:<[^>]+>|\\s|&nbsp;)+' : '\\s+');
            }).join(forHtml ? '(?:<[^>]+>|\\s|&nbsp;)+(.*?)(?:<[^>]+>|\\s|&nbsp;)+' : '\\s+(.*?)\\s+');
            // Expanded word boundary check to include apostrophes
            const pre = /^[\w'’]/.test(part) ? '\\b' : '';
            const post = /[\w'’]$/.test(part) ? '\\b' : '';
            return `${pre}${parsedPart}${post}`;
        });
        const rx = new RegExp(`(${branchRegexes.join('|')})`, rule.caseSensitive ? 'g' : 'gi');
        regexCache.set(cacheKey, rx);
        return rx;
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

    // ---------- EARLY PATTERN PRIMING (Pre-load Replacement) ----------
    // Load blocklist early to avoid priming on blocked sites
    let earlyBlocked = [];
    try {
        const raw = GM_getValue(BLOCK_KEY, null);
        earlyBlocked = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
    } catch (e) {}

    if (earlyBlocked.includes(HOST) || isExcludedContext()) {
        // Do not prime on blocked or excluded sites – bail out.
    } else {
        const primedHostData = readGM(ACTIVE_KEY, { hostMap: {} });
        const earlyRules = primedHostData.hostMap ? (primedHostData.hostMap[HOST] || []) : [];
        
        let earlyMo = null;
        if (earlyRules.length > 0) {
            const earlyRxMap = earlyRules.map(r => ({ r, rx: compileRuleRegex(r, false) }));
            earlyMo = new MutationObserver(mutations => {
                for (const m of mutations) {
                    m.addedNodes.forEach(node => {
                        if (node.nodeType === Node.TEXT_NODE && node.nodeValue && node.nodeValue.trim()) {
                            processEarlyTextNode(node, earlyRxMap);
                        } else if (node.nodeType === Node.ELEMENT_NODE) {
                            if (['SCRIPT','STYLE','NOSCRIPT','TEXTAREA','INPUT'].includes(node.tagName)) return;
                            const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null, false);
                            let tNode;
                            while ((tNode = walker.nextNode())) {
                                if (tNode.parentElement && ['SCRIPT','STYLE','NOSCRIPT','TEXTAREA','INPUT'].includes(tNode.parentElement.tagName)) continue;
                                processEarlyTextNode(tNode, earlyRxMap);
                            }
                        }
                    });
                }
            });

            // Attach immediately to start priming text nodes as they stream in
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

        // Export a cleanup function so the main init can disconnect when ready
        window.__trEarlyMoCleanup = () => { if (earlyMo) { earlyMo.disconnect(); earlyMo = null; window.__trEarlyMoCleanup = null; } };
    }

    // ---------- IndexedDB ----------
    function openDB() {
        return new Promise((resolve, reject) => {
            if (dbInstance) return resolve(dbInstance);
            const req = indexedDB.open(DB_NAME, 1);
            req.onerror = () => reject(req.error || 'IDB error');
            req.onsuccess = (e) => { dbInstance = e.target.result; resolve(dbInstance); };
            req.onupgradeneeded = (e) => {
                if (!e.target.result.objectStoreNames.contains(STORE_NAME)) e.target.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
            };
        });
    }
    async function dbGetAll() {
        const db = await openDB();
        return new Promise(res => {
            const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
            req.onsuccess = () => res(req.result || []); req.onerror = () => res([]);
        });
    }
    async function dbPut(r) {
        const db = await openDB();
        return new Promise((res, rej) => {
            const req = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(r);
            req.onsuccess = () => { regexCache.clear(); res(); }; req.onerror = e => rej(e);
        });
    }
    async function dbDelete(id) {
        const db = await openDB();
        return new Promise((res, rej) => {
            const req = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(id);
            req.onsuccess = () => { regexCache.clear(); res(); }; req.onerror = e => rej(e);
        });
    }

    function loadSettings() {
        const legacyBlock = readGM('TextReplacer_BLOCK_v2', null);
        blockedDomains = readGM(BLOCK_KEY, legacyBlock || []) || [];
        if (legacyBlock) { writeGM(BLOCK_KEY, blockedDomains); try { GM_deleteValue('TextReplacer_BLOCK_v2'); } catch(e){} }
        enableHighlight = readGM(HIGHLIGHT_KEY, true);
        extractThemeColor();
    }
    function saveBlocked() { writeGM(BLOCK_KEY, blockedDomains || []); }

    // ---------- MASTER mirror ----------
    async function scheduleWriteMasterMirror() {
        if (masterWriteTimer) clearTimeout(masterWriteTimer);
        masterWriteTimer = setTimeout(async () => {
            try {
                writingMaster = true; const rules = await dbGetAll();
                writeGM(MASTER_KEY, { ts: now(), rules: rules.map(r => ({ ...r })) }); lastMasterPayloadTs = now();
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
            localRules = await dbGetAll(); updateGuiIfNeeded(); scheduleReplace();
        } finally { applyingRemoteMaster = false; }
    }

    function updateActiveHostInGM(detectedArray) {
        const payload = readGM(ACTIVE_KEY, { ts: 0, hostMap: {} }); payload.hostMap = payload.hostMap || {};
        if (!detectedArray || detectedArray.length === 0) { if (payload.hostMap[HOST]) delete payload.hostMap[HOST]; }
        else { payload.hostMap[HOST] = detectedArray.map(r => ({ id: r.id, oldText: r.oldText, newText: r.newText, caseSensitive: !!r.caseSensitive, forceGlobal: !!r.forceGlobal, smartPriority: !!r.smartPriority })); }
        payload.ts = now(); writeGM(ACTIVE_KEY, payload);
    }

    function revertAllReplacements() {
        document.querySelectorAll('.tr-replaced, .tr-replaced-hidden').forEach(el => {
            const data = repDataMap.get(el.dataset.trId);
            el.outerHTML = data ? data.orig : el.textContent;
        });
        repDataMap.clear();
        document.querySelectorAll('[data-tr-processed]').forEach(el => {
            delete el.dataset.trProcessed;
        });
    }

    async function runDetectionAndApplyInternal() {
        loadSettings();
        if (blockedDomains.includes(HOST)) return;
        localRules = await dbGetAll();
        const bodyText = document.body ? (document.body.innerText || document.body.textContent || '') : '';
        const detected = []; const newActive = {};
        
        for (const r of localRules) {
            if (!r.enabled) continue;
            try {
                const rx = compileRuleRegex(r, false);
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

    function performReplacementPass() {
        if (blockedDomains.includes(HOST)) return;
        let rulesList = Object.values(activeRules).sort((a, b) => {
            const aSmart = !!a.smartPriority;
            const bSmart = !!b.smartPriority;
            if (aSmart !== bSmart) return aSmart ? -1 : 1;
            if (aSmart) {
                const aStats = ruleStats.get(a.id) || { lastUsed: 0, matchCount: 0 };
                const bStats = ruleStats.get(b.id) || { lastUsed: 0, matchCount: 0 };
                if (aStats.lastUsed !== bStats.lastUsed) return bStats.lastUsed - aStats.lastUsed;
                if (aStats.matchCount !== bStats.matchCount) return bStats.matchCount - aStats.matchCount;
            }
            return (b.oldText || '').length - (a.oldText || '').length;
        });
        if (!rulesList.length) return;

        const nowTs = now();

        // Pass 1: Handle disconnected/bolded words via safe block innerHTML
        const safeBlocks = document.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote, dd, dt');
        safeBlocks.forEach(block => {
            if (block.dataset.trProcessed) return;
            if (block.querySelector('a, button, input, textarea, select, iframe, script, style, [onclick]')) return;
            
            let html = block.innerHTML; let modified = false;
            for (const rule of rulesList) {
                try {
                    const rx = compileRuleRegex(rule, true);
                    const beforeHtml = html;
                    if (rx.test(html)) {
                        html = html.replace(rx, (...args) => {
                            const matchedStr = args[0];
                            const offset = args[args.length - 2];
                            const fullStr = args[args.length - 1];
                            const before = fullStr.substring(0, offset);
                            
                            // Guard clause to prevent replacing text that is inside an HTML tag attribute
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
                } catch(e) {}
            }
            if (modified) { block.innerHTML = html; block.dataset.trProcessed = "true"; }
        });

        // Pass 2: Handle standard text nodes using optimized TreeWalker
        const nodeFilter = {
            acceptNode: function(node) {
                const p = node.parentElement;
                if (!p) return NodeFilter.FILTER_REJECT;
                const tag = p.tagName;
                if (tag === 'HEAD' || tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'CODE' || tag === 'PRE' || tag === 'SVG' || tag === 'PATH' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
                if (p.isContentEditable || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
                if (p.closest && p.closest('#text-replacer-gui, .mui-fab, .mui-toggle, #tr-quick-edit, .tr-replaced, #tr-selection-fab, [data-tr-processed="true"]')) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            }
        };

        const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, nodeFilter, false);
        const nodesToReplace = [];
        let node;
        while ((node = walker.nextNode())) { nodesToReplace.push(node); }

        for (const textNode of nodesToReplace) {
            let text = textNode.nodeValue; let modified = false; let ruleMap = [];
            
            for (const rule of rulesList) {
                try {
                    const rx = compileRuleRegex(rule, false);
                    const beforeText = text;
                    if (!rx.test(text)) continue;
                    rx.lastIndex = 0; // reset due to test
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
                } catch(e) {}
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

    // ---------- VIRTUALIZED GUI ----------
    function updateGuiIfNeeded() { if (isGuiOpen && listContainer) renderVirtualList(); }

    function saveUIScrollForHost(host, offset) { try { const map = readGM(UI_SCROLL_KEY, {}) || {}; map[host] = offset; writeGM(UI_SCROLL_KEY, map); } catch (e) {} }
    function loadUIScrollForHost(host) { try { const map = readGM(UI_SCROLL_KEY, {}) || {}; const v = map[host]; return (typeof v === 'number') ? v : 0; } catch (e) { return 0; } }
    function saveUIScrollDebounced() {
        if (!listContainer) return;
        if (scrollSaveTimer) clearTimeout(scrollSaveTimer);
        const offset = listContainer.scrollTop;
        scrollSaveTimer = setTimeout(() => { saveUIScrollForHost(HOST, offset); scrollSaveTimer = null; }, SCROLL_SAVE_DEBOUNCE);
    }

    function renderVirtualList() {
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
    }

    function buildFullGUI() {
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
                    <button class="mui-button mui-pill-secondary" id="tr-export-btn">Export</button>
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

        mainPage.querySelector('#tr-settings-btn').onclick = () => showPage('settings');
        mainPage.querySelector('#tr-add-btn').onclick = () => addRuleInteractive();
        mainPage.querySelector('#tr-export-btn').onclick = exportRulesFile;
        mainPage.querySelector('#tr-import-btn').onclick = () => { promptFileImport(true); };
        
        renderVirtualList();
    }

    // ---------- CUSTOM MATERIAL EXPRESSIVE GUI ----------
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

                if (!oldInput || newInput === undefined) {
                    alert('Original and replacement fields cannot be empty.');
                    return;
                }

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

    function addRuleInteractive(prefill = '') {
        showTermDialog(false, { oldText: prefill });
    }
    
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

    async function exportRulesFile() {
        const all = await dbGetAll(); const blob = new Blob([JSON.stringify({ ts: now(), rules: all }, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `text-replacer-rules-${now()}.json`;
        document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url); alert('Exported rules to your downloads.');
    }

    function promptFileImport(merge = true) {
        const input = document.createElement('input'); input.type = 'file'; input.accept = '.json,application/json'; input.style.display = 'none';
        input.onchange = async (e) => { const f = e.target.files && e.target.files[0]; if (!f) return; try { const text = await f.text(); await importRulesFromJSONString(text, merge); } catch(err){} finally{input.remove();} };
        document.body.appendChild(input); input.click();
    }

    async function importRulesFromJSONString(jsonStr, merge = true) {
        let payload; try { payload = JSON.parse(jsonStr); } catch (e) { return; }
        const rulesArr = Array.isArray(payload) ? payload : (Array.isArray(payload.rules) ? payload.rules : null); if (!rulesArr) return;
        const current = await dbGetAll(); const byId = new Map(current.map(r => [r.id, r])); const bySig = new Map(current.map(r => [signatureOf(r), r]));
        for (const r of rulesArr) {
            if (!r || !r.oldText) continue;
            const cand = { id: r.id || uuid(), oldText: r.oldText, newText: r.newText || '', caseSensitive: !!r.caseSensitive, forceGlobal: !!r.forceGlobal, smartPriority: !!r.smartPriority, enabled: r.enabled !== false, createdAt: r.createdAt || now(), updatedAt: r.updatedAt || now(), site: r.site || null };
            if (byId.has(cand.id)) { const local = byId.get(cand.id); if ((cand.updatedAt || 0) > (local.updatedAt || 0)) await dbPut({ ...local, ...cand, id: local.id }); }
            else { const sig = signatureOf(cand); if (bySig.has(sig)) { const local = bySig.get(sig); if ((cand.updatedAt || 0) > (local.updatedAt || 0)) await dbPut({ ...local, ...cand, id: local.id }); } else await dbPut(cand); }
        }
        localRules = await dbGetAll(); scheduleWriteMasterMirror(); revertAllReplacements(); await runDetectionAndApplyInternal(); updateGuiIfNeeded(); alert('Import complete.');
    }

    // ---------- SETTINGS & BLOCKLIST ----------
    function showSettings() {
        loadSettings();
        settingsPage.innerHTML = `
            <div class="mui-header mui-settings-header">
                <button class="mui-button mui-back-pill mui-pill-settings" id="tr-back-btn">⬅ Back</button>
                <h2>Settings</h2>
            </div>
            <div class="mui-settings-container" id="tr-set-cont"></div>
        `;
        const cont = settingsPage.querySelector('#tr-set-cont');
        
        const blTitle = document.createElement('div'); blTitle.className = 'mui-settings-title'; blTitle.textContent = 'Blocklist (Global)'; cont.appendChild(blTitle);
        (blockedDomains || []).forEach(d => {
            const row = document.createElement('div'); row.className = 'mui-settings-row';
            row.innerHTML = `<span style="font-weight: 500;">${escapeHtml(d)}</span>`;
            const x = document.createElement('button'); x.textContent = '✖'; x.className = 'mui-icon-btn mui-error'; x.onclick = () => { blockedDomains = blockedDomains.filter(x => x !== d); saveBlocked(); showSettings(); };
            row.appendChild(x); cont.appendChild(row);
        });
        
        const blockBtn = document.createElement('button'); blockBtn.textContent = '🚫 Block Current Site'; blockBtn.className = 'mui-button mui-pill-settings';
        blockBtn.onclick = () => { if (!blockedDomains.includes(HOST)) { blockedDomains.push(HOST); saveBlocked(); showSettings(); } }; cont.appendChild(blockBtn);
        
        const blExImpRow = document.createElement('div'); blExImpRow.className = 'mui-settings-action-row';
        const blExportBtn = document.createElement('button'); blExportBtn.textContent = 'Export'; blExportBtn.className = 'mui-button mui-pill-settings'; blExportBtn.onclick = () => {
            const blob = new Blob([JSON.stringify({ domains: blockedDomains }, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `text-replacer-blocklist-${now()}.json`;
            document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
        };
        const blImportBtn = document.createElement('button'); blImportBtn.textContent = 'Import'; blImportBtn.className = 'mui-button mui-pill-settings'; blImportBtn.onclick = () => {
            promptFileImport(false);
        };
        blExImpRow.append(blExportBtn, blImportBtn); cont.appendChild(blExImpRow);

        const hlTitle = document.createElement('div'); hlTitle.className = 'mui-settings-title'; hlTitle.textContent = 'Appearance'; cont.appendChild(hlTitle);
        const hlBtn = document.createElement('button'); hlBtn.textContent = enableHighlight ? '🔵 Blue Highlight: ON' : '⚪ Blue Highlight: OFF'; hlBtn.className = 'mui-button mui-pill-settings';
        hlBtn.onclick = () => { enableHighlight = !enableHighlight; writeGM(HIGHLIGHT_KEY, enableHighlight); revertAllReplacements(); runDetectionAndApplyInternal(); showSettings(); }; cont.appendChild(hlBtn);

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
            ihwBtn.onclick = () => {
                externalIhwAPI.toggle();
                showSettings();
            };
            ihwRow.appendChild(ihwBtn);
            cont.appendChild(ihwRow);
        }

        settingsPage.querySelector('#tr-back-btn').onclick = () => showPage('main');
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

    // ---------- STYLES & GUI SETUP ----------
    function applyStyles() {
        if (document.getElementById('tr-styles')) return;
        const style = document.createElement('style'); style.id = 'tr-styles';
        style.textContent = `
            :root { --md-sys-color-primary: ${siteThemeColor}; --md-sys-color-surface: #FEF7FF; --md-sys-color-surface-container: #F3EDF7; --md-sys-color-on-surface: #1D1B20; --md-pill-radius: 9999px; --md-ease-standard: cubic-bezier(0.2, 0, 0, 1.0); --md-ease-emphasized: cubic-bezier(0.05, 0.7, 0.1, 1.0); --md-ease-expressive: cubic-bezier(0.25, 1.25, 0.25, 1.0); }
            .mui-box { position:fixed; top:50%; left:50%; transform:translate(-50%,-50%) scale(0.95); opacity:0; visibility:hidden; width:90vw; max-width:450px; height:75vh; min-height:450px; background:var(--md-sys-color-surface); color:var(--md-sys-color-on-surface); padding:24px; border-radius:28px; box-shadow:0 8px 30px rgba(0,0,0,.15); z-index:2147483647; max-height:85vh; display:flex; flex-direction:column; font-family:system-ui,sans-serif; transition:transform 0.4s var(--md-ease-standard), opacity 0.4s var(--md-ease-standard), visibility 0s linear 0.4s; pointer-events:none; overflow: hidden; }
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

            #tr-settings-page { padding: 16px; }
            .mui-settings-header { justify-content: flex-start; gap: 8px; margin-bottom: 24px;}
            .mui-back-pill { font-size: 13px; padding: 6px 14px; width: max-content;}
            .mui-settings-container { display: flex; flex-direction: column; gap: 16px; padding-left: 8px;}
            .mui-settings-title { font-size: 14px; font-weight: 600; color: #444; text-transform: uppercase; letter-spacing: 1px; margin-top: 8px;}
            .mui-settings-row { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid #EEE; }
            .mui-settings-action-row { display: flex; gap: 8px; }

            .mui-pill-settings { background: #ECE6F0; color: #1D1B20; font-size: 13px; font-weight: 500; padding: 6px 14px; width: max-content; flex: none;}
            .mui-pill-settings:hover { background: #E8DEF8; }
            
            .mui-dialog-overlay { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.5); z-index: 2147483648; opacity: 0; pointer-events: none; visibility: hidden; transition: opacity 0.4s var(--md-ease-standard); }
            .mui-dialog-overlay.open { opacity: 1; pointer-events: auto; visibility: visible; }
            .mui-expressive-dialog { position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%) scale(0.9); background: var(--md-sys-color-surface); color: var(--md-sys-color-on-surface); padding: 32px; border-radius: 28px; box-shadow: 0 12px 40px rgba(0,0,0,0.3); max-width: 400px; width: 80vw; display: flex; flex-direction: column; gap: 16px; opacity: 0; transition: transform 0.6s var(--md-ease-expressive), opacity 0.4s var(--md-ease-standard); font-family: inherit;}
            .mui-dialog-overlay.open .mui-expressive-dialog { opacity: 1; transform: translate(-50%,-50%) scale(1); }
            .mui-expressive-dialog h3 { margin: 0; font-size: 20px; font-weight: 600; text-align: center; }
            .mui-form-group { display: flex; flex-direction: column; gap: 6px; }
            .mui-form-group label { font-size: 14px; font-weight: 500; opacity: 0.8;}
            .mui-pill-field { border: 1px solid rgba(0,0,0,0.1); border-radius: var(--md-pill-radius); padding: 12px 18px; font-size: 16px; outline: none; background: #fff; font-family: inherit;}
            .mui-expressive-checkboxes { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px;}
            .mui-check-group { display: flex; align-items: center; gap: 8px; font-size: 14px;}
            .mui-dialog-actions.mui-centered-pills { display: flex; justify-content: center; gap: 12px; margin-top: 16px;}
        `;
        document.documentElement.appendChild(style);
    }

    function createGUI() {
        if (document.getElementById('text-replacer-gui')) return;
        guiBox = document.createElement('div'); guiBox.id = 'text-replacer-gui'; guiBox.className = 'mui-box';
        const toggle = document.createElement('div'); toggle.className = 'mui-toggle'; toggle.textContent = '☰';
        toggle.onclick = () => { isGuiOpen = !isGuiOpen; isGuiOpen ? guiBox.classList.add('open') : guiBox.classList.remove('open'); if (isGuiOpen) showPage('main'); };
        document.documentElement.append(guiBox, toggle);

        mainPage = document.createElement('div'); mainPage.id = 'tr-main-page'; mainPage.className = 'mui-page';
        settingsPage = document.createElement('div'); settingsPage.id = 'tr-settings-page'; settingsPage.className = 'mui-page';
        guiBox.append(mainPage, settingsPage);

        dialogWrapper = document.createElement('div'); dialogWrapper.id = 'tr-dialog-wrapper'; dialogWrapper.className = 'mui-dialog-overlay';
        document.documentElement.appendChild(dialogWrapper);

        createQuickEditGUI(); createSelectionFab();
    }

    // ---------- Custom Modal Dialog Functions ----------
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

    // ---------- Navigation & Expressive Transitions ----------
    function showPage(pageId) {
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
    
    // ---------- INIT ----------
    async function bootstrap() {
        const loadDoc = () => {
            loadSettings(); applyStyles(); createGUI();
            if (blockedDomains.includes(HOST)) return;
            
            if (document.body) mo.observe(document.body, { childList: true, subtree: true, characterData: true });
        };
        
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', loadDoc);
        } else {
            loadDoc();
        }
        
        localRules = await dbGetAll();
        if ((!localRules || localRules.length === 0)) {
            const master = readGM(MASTER_KEY, null);
            if (master && Array.isArray(master.rules) && master.rules.length > 0) await mergeMasterPayload(master);
        } else scheduleWriteMasterMirror();
        await runDetectionAndApplyInternal();

        // Disconnect the early priming observer now that the full engine is running
        if (window.__trEarlyMoCleanup) {
            window.__trEarlyMoCleanup();
            delete window.__trEarlyMoCleanup;
        }
    }
    bootstrap();
})();