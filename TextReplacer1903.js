// ==UserScript==
// @name         Text Replacer — Ultimate M3 Engine & Virtual UI
// @namespace    http://tampermonkey.net/
// @version      9.6.1
// @description  Virtualized M3 UI, dynamic theming, full Blocklist/Rule I/O, Multi-Term (|), Gap (---), and Filter (#{...}#) operators.
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    // ---------- CONFIG ----------
    const DB_NAME = 'TextReplacerDB_v2';
    const STORE_NAME = 'rules';
    const MASTER_KEY = 'TextReplacer_MASTER_v2';
    const ACTIVE_KEY = 'TextReplacer_ACTIVE_v2';
    const BLOCK_KEY = 'TextReplacer_BLOCK_v2';
    const UI_SCROLL_KEY = 'TextReplacer_UI_SCROLL_v2';
    const SYNC_KEY = 'TextReplacer_SYNC_v2';
    const HIGHLIGHT_KEY = 'TextReplacer_HIGHLIGHT_v2';
    const MASTER_POLL_MS = 5000;
    const MASTER_WRITE_DEBOUNCE = 600;
    const REPLACE_DEBOUNCE = 120;
    const SCROLL_SAVE_DEBOUNCE = 250;
    const CARD_HEIGHT = 88;

    // ---------- STATE ----------
    let dbInstance = null, localRules = [], activeRules = {}, blockedDomains = [];
    let enableHighlight = true, siteThemeColor = '#6750A4';
    let guiBox = null, listContainer = null, virtualScroller = null, fab = null, quickEditBox = null, selectionFab = null;
    let isGuiOpen = false, writingMaster = false, applyingRemoteMaster = false;
    let lastMasterPayloadTs = 0;
    const HOST = window.location.hostname;
    let prevActiveHash = '', prevLocalHash = '';
    let replaceTimer = null, masterWriteTimer = null, scrollSaveTimer = null, userInteractTimeout = null;
    let userInteracting = false, quickEditActiveId = null, mo = null;

    // ---------- helpers ----------
    function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
    function isLatinToken(s) { return /^[a-zA-Z0-9_]+$/.test(s); }
    function now() { return Date.now(); }
    function uuid() { return now().toString(36) + Math.random().toString(36).slice(2); }
    function signatureOf(r) { return `${r.oldText}:::${r.newText}:::${!!r.caseSensitive}:::${!!r.forceGlobal}:::${!!r.smartPriority}`; }
    function escapeHtml(s) { return (s||'').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]); }

    function extractThemeColor() {
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta && meta.content) siteThemeColor = meta.content;
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
            req.onsuccess = () => res(); req.onerror = e => rej(e);
        });
    }
    async function dbDelete(id) {
        const db = await openDB();
        return new Promise((res, rej) => {
            const req = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(id);
            req.onsuccess = () => res(); req.onerror = e => rej(e);
        });
    }

    // ---------- GM helpers ----------
    function readGM(k, fb = null) { try { const r = GM_getValue(k, null); return r === null ? fb : (typeof r === 'string' ? JSON.parse(r) : r); } catch (e) { return fb; } }
    function writeGM(k, v) { try { GM_setValue(k, JSON.stringify(v)); } catch (e) {} }

    function loadSettings() {
        blockedDomains = readGM(BLOCK_KEY, []) || [];
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

    // ---------- ENGINE LOGIC: Operators ----------
    function compileRuleRegex(rule) {
        const parts = rule.oldText.split(/\s*\|\s*/);
        const branchRegexes = parts.map(part => {
            if (part.includes('---')) {
                const subParts = part.split(/\s*---\s*/);
                return subParts.map(sp => escapeRegExp(sp)).join('\\s+(.*?)\\s+');
            }
            return escapeRegExp(part);
        });
        const combined = branchRegexes.join('|');
        const isWord = isLatinToken(rule.oldText.replace(/[^a-zA-Z0-9]/g, ''));
        const pattern = isWord ? `\\b(${combined})\\b` : `(${combined})`;
        return new RegExp(pattern, rule.caseSensitive ? 'g' : 'gi');
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

    async function runDetectionAndApplyInternal() {
        loadSettings();
        if (blockedDomains.includes(HOST)) return;
        localRules = await dbGetAll();
        const bodyText = document.body ? (document.body.innerText || document.body.textContent || '') : '';
        const detected = []; const newActive = {};
        
        for (const r of localRules) {
            if (!r.enabled) continue;
            try {
                const rx = compileRuleRegex(r);
                if (r.forceGlobal || rx.test(bodyText)) { detected.push(r); newActive[r.id] = r; }
            } catch(e) {}
        }
        
        updateActiveHostInGM(detected);
        const newHash = JSON.stringify(Object.keys(newActive).sort());
        if (newHash !== prevActiveHash) { activeRules = newActive; prevActiveHash = newHash; scheduleReplace(); updateGuiIfNeeded(); }
    }

    function scheduleReplace() {
        if (replaceTimer) clearTimeout(replaceTimer);
        replaceTimer = setTimeout(() => { performReplacementPass(); replaceTimer = null; }, REPLACE_DEBOUNCE);
    }

    function performReplacementPass() {
        if (blockedDomains.includes(HOST)) return;
        let rulesList = Object.values(activeRules).sort((a, b) => {
            if (!!a.smartPriority !== !!b.smartPriority) return a.smartPriority ? -1 : 1;
            return (b.oldText || '').length - (a.oldText || '').length;
        });
        if (!rulesList.length) return;

        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        const nodesToReplace = [];
        let node;
        while ((node = walker.nextNode())) {
            const p = node.parentElement;
            if (!p || p.closest('#text-replacer-gui, .mui-fab, .mui-toggle, #tr-quick-edit, .tr-replaced, #tr-selection-fab')) continue;
            if (['HEAD', 'SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'CODE', 'PRE', 'svg', 'path'].includes(p.tagName)) continue;
            if (p.isContentEditable || !node.nodeValue.trim()) continue;
            nodesToReplace.push(node);
        }

        for (const textNode of nodesToReplace) {
            let text = textNode.nodeValue; let modified = false; let ruleMap = [];
            
            for (const rule of rulesList) {
                try {
                    const rx = compileRuleRegex(rule);
                    text = text.replace(rx, (...args) => {
                        modified = true;
                        const matchedStr = args[0];
                        const gapMatch = args.slice(1, -2).find(x => x && x !== matchedStr); 
                        const rep = processReplacement(rule, matchedStr, gapMatch);
                        const marker = `[[TR_REP_${rule.id}_${uuid()}]]`;
                        ruleMap.push({ marker, rep, orig: matchedStr, ruleId: rule.id });
                        return marker;
                    });
                } catch(e) {}
            }

            if (modified && textNode.parentNode) {
                const fragment = document.createDocumentFragment();
                const splitRegex = /(\[\[TR_REP_[^\]]+\]\])/g;
                const parts = text.split(splitRegex);
                
                parts.forEach(part => {
                    const mapped = ruleMap.find(rm => rm.marker === part);
                    if (mapped) {
                        const span = document.createElement('span');
                        span.className = enableHighlight ? 'tr-replaced' : 'tr-replaced-hidden';
                        span.textContent = mapped.rep; span.dataset.orig = mapped.orig; span.dataset.ruleId = mapped.ruleId;
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
        const sorted = (localRules || []).sort((a, b) => a.oldText.localeCompare(b.oldText));
        const scrollTop = listContainer.scrollTop;
        const viewportHeight = listContainer.clientHeight || 400;
        
        virtualScroller.style.height = `${sorted.length * CARD_HEIGHT}px`;
        virtualScroller.innerHTML = '';
        
        const startIndex = Math.max(0, Math.floor(scrollTop / CARD_HEIGHT) - 2);
        const endIndex = Math.min(sorted.length, Math.ceil((scrollTop + viewportHeight) / CARD_HEIGHT) + 2);

        for (let i = startIndex; i < endIndex; i++) {
            const r = sorted[i]; const isActive = !!activeRules[r.id];
            const item = document.createElement('div'); 
            item.className = `mui-card ${isActive ? 'active' : ''}`;
            item.style.top = `${i * CARD_HEIGHT}px`;
            
            item.innerHTML = `
                <div style="flex-grow:1; overflow:hidden;">
                    <div class="mui-rule-text">"${escapeHtml(r.oldText)}" ➡ "${escapeHtml(r.newText)}"</div>
                    <div class="mui-rule-meta">${isActive ? '✅ Active' : '💤 Idle'} • ${r.forceGlobal ? '🌍 Global' : '🤖 Auto'} ${r.smartPriority ? '• ⚡ Priority' : ''}</div>
                </div>
                <div class="mui-card-actions">
                    <button class="mui-icon-btn mui-tonal edit-btn">✏️</button>
                    <button class="mui-icon-btn mui-error del-btn">🗑️</button>
                </div>
            `;
            item.querySelector('.edit-btn').onclick = () => editRuleInteractive(r.id);
            item.querySelector('.del-btn').onclick = () => deleteRuleInteractive(r.id);
            virtualScroller.appendChild(item);
        }
    }

    function buildFullGUI() {
        if (!guiBox) return;
        guiBox.innerHTML = `
            <div class="mui-header"><h2>Library</h2><button class="mui-icon-btn" id="tr-settings-btn">⚙️</button></div>
            <div class="mui-list-container" id="tr-list-container">
                <div id="tr-virtual-scroller" style="position: relative; width: 100%;"></div>
            </div>
            <div class="mui-bottom-actions">
                <button class="mui-button mui-primary" id="tr-add-btn">＋ Add Term</button>
                <div style="display:flex; gap:8px;">
                    <button class="mui-button mui-secondary" id="tr-export-btn">Export</button>
                    <button class="mui-button mui-secondary" id="tr-import-btn">Import</button>
                </div>
            </div>
        `;
        listContainer = guiBox.querySelector('#tr-list-container');
        virtualScroller = guiBox.querySelector('#tr-virtual-scroller');
        
        listContainer.addEventListener('scroll', () => { requestAnimationFrame(renderVirtualList); saveUIScrollDebounced(); });
        const savedScroll = loadUIScrollForHost(HOST);
        if (typeof savedScroll === 'number') setTimeout(() => { if (listContainer) listContainer.scrollTop = savedScroll; }, 0);

        guiBox.querySelector('#tr-settings-btn').onclick = showSettings;
        guiBox.querySelector('#tr-add-btn').onclick = () => addRuleInteractive();
        guiBox.querySelector('#tr-export-btn').onclick = exportRulesFile;
        guiBox.querySelector('#tr-import-btn').onclick = () => { promptFileImport(confirm('Press OK to MERGE imported rules with your library. Cancel to REPLACE.')); };
        
        renderVirtualList();
    }

    // ---------- CRUD & I/O ----------
    async function addRuleInteractive(prefill = '') {
        const oldText = prompt('Text to replace (Use | for OR, --- for Gap):', prefill); if (!oldText) return;
        const newText = prompt('Replacement (Use --- to insert gap, #{...}# to filter):', ''); if (newText === null) return;
        const caseSensitive = confirm('Case-sensitive? (OK = yes)');
        const forceGlobal = confirm('Force Global? (OK = always active)');
        const smartPriority = confirm('Enable Smart Prioritization?');
        const t = now();
        const r = { id: uuid(), oldText: oldText.trim(), newText: newText.trim(), caseSensitive, forceGlobal, smartPriority, enabled: true, createdAt: t, updatedAt: t, site: HOST };
        await dbPut(r); localRules = await dbGetAll(); scheduleWriteMasterMirror(); await runDetectionAndApplyInternal();
    }
    async function editRuleInteractive(id) {
        const r = localRules.find(x => x.id === id); if (!r) return;
        const oldText = prompt('Original:', r.oldText); if (!oldText) return;
        const newText = prompt('Replacement:', r.newText); if (newText === null) return;
        r.oldText = oldText.trim(); r.newText = newText.trim(); 
        r.caseSensitive = confirm(`Case-sensitive? (Current: ${r.caseSensitive})`);
        r.forceGlobal = confirm(`Force Global? (Current: ${r.forceGlobal})`); 
        r.smartPriority = confirm(`Smart Prioritization? (Current: ${!!r.smartPriority})`);
        r.updatedAt = now();
        await dbPut(r); localRules = await dbGetAll(); scheduleWriteMasterMirror(); await runDetectionAndApplyInternal();
    }
    async function deleteRuleInteractive(id) {
        if (confirm('Delete this rule permanently?')) { await dbDelete(id); localRules = await dbGetAll(); scheduleWriteMasterMirror(); await runDetectionAndApplyInternal(); }
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
        localRules = await dbGetAll(); scheduleWriteMasterMirror(); await runDetectionAndApplyInternal(); alert('Import complete.');
    }

    // ---------- SETTINGS & BLOCKLIST ----------
    function showSettings() {
        if (!guiBox) return; loadSettings();
        guiBox.innerHTML = `<div class="mui-header"><h2>Settings</h2></div><div class="mui-list-container" id="tr-set-cont"></div><button class="mui-button mui-primary" id="tr-back-btn" style="margin-top:16px;">⬅ Back</button>`;
        const cont = guiBox.querySelector('#tr-set-cont');
        
        const blTitle = document.createElement('div'); blTitle.textContent = 'Blocklist (Global)'; blTitle.style.fontWeight = '600'; cont.appendChild(blTitle);
        (blockedDomains || []).forEach(d => {
            const row = document.createElement('div'); row.style.display = 'flex'; row.style.justifyContent = 'space-between'; row.style.alignItems = 'center'; row.style.padding = '8px 0';
            row.innerHTML = `<span style="font-weight: 500;">${escapeHtml(d)}</span>`;
            const x = document.createElement('button'); x.textContent = '✖'; x.className = 'mui-icon-btn mui-error'; x.onclick = () => { blockedDomains = blockedDomains.filter(x => x !== d); saveBlocked(); showSettings(); };
            row.appendChild(x); cont.appendChild(row);
        });
        
        const blockBtn = document.createElement('button'); blockBtn.textContent = '🚫 Block Current Site'; blockBtn.className = 'mui-button mui-secondary';
        blockBtn.onclick = () => { if (!blockedDomains.includes(HOST)) { blockedDomains.push(HOST); saveBlocked(); showSettings(); } }; cont.appendChild(blockBtn);
        
        const blExImpRow = document.createElement('div'); blExImpRow.style.display = 'flex'; blExImpRow.style.gap = '8px'; blExImpRow.style.marginTop = '8px';
        const blExportBtn = document.createElement('button'); blExportBtn.textContent = 'Export'; blExportBtn.className = 'mui-button mui-secondary'; blExportBtn.onclick = () => {
            const blob = new Blob([JSON.stringify({ domains: blockedDomains }, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `text-replacer-blocklist-${now()}.json`;
            document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
        };
        const blImportBtn = document.createElement('button'); blImportBtn.textContent = 'Import'; blImportBtn.className = 'mui-button mui-secondary'; blImportBtn.onclick = () => {
            const input = document.createElement('input'); input.type = 'file'; input.accept = '.json,application/json'; input.style.display = 'none';
            input.onchange = async (e) => { const f = e.target.files && e.target.files[0]; if (!f) return; try {
                let p = JSON.parse(await f.text()); let arr = Array.isArray(p) ? p : (p.blocklist || p.blocked || p.domains);
                if (arr && arr.every(x => typeof x === 'string')) { if(confirm('Replace blocklist?')) { blockedDomains = arr; saveBlocked(); showSettings(); } }
            } catch(err){} finally{input.remove();} }; document.body.appendChild(input); input.click();
        };
        blExImpRow.append(blExportBtn, blImportBtn); cont.appendChild(blExImpRow);

        const hlTitle = document.createElement('div'); hlTitle.textContent = 'Appearance'; hlTitle.style.fontWeight = '600'; hlTitle.style.marginTop = '16px'; cont.appendChild(hlTitle);
        const hlBtn = document.createElement('button'); hlBtn.textContent = enableHighlight ? '🔵 Blue Highlight: ON' : '⚪ Blue Highlight: OFF'; hlBtn.className = 'mui-button mui-secondary';
        hlBtn.onclick = () => { enableHighlight = !enableHighlight; writeGM(HIGHLIGHT_KEY, enableHighlight); showSettings(); }; cont.appendChild(hlBtn);

        guiBox.querySelector('#tr-back-btn').onclick = buildFullGUI;
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
        document.getElementById('qe-from').textContent = targetElement.dataset.orig; quickEditActiveId = targetElement.dataset.ruleId;
        const rect = targetElement.getBoundingClientRect();
        quickEditBox.style.top = `${rect.bottom + window.pageYOffset + 8}px`; quickEditBox.style.left = `${rect.left + window.pageXOffset}px`;
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
                if (anc && anc.closest && anc.closest('#text-replacer-gui, #tr-quick-edit')) { selectionFab.classList.add('mui-hidden'); return; }
                selectionFab.classList.remove('mui-hidden');
            } else { selectionFab.classList.add('mui-hidden'); }
        });
    }

    // ---------- STYLES & GUI SETUP ----------
    function applyStyles() {
        if (document.getElementById('tr-styles')) return;
        const style = document.createElement('style'); style.id = 'tr-styles';
        style.textContent = `
            :root { --md-sys-color-primary: ${siteThemeColor}; --md-sys-color-surface: #FEF7FF; --md-sys-color-surface-container: #F3EDF7; --md-sys-color-on-surface: #1D1B20; }
            .mui-box { position:fixed; top:50%; left:50%; transform:translate(-50%,-50%) scale(0.95); opacity:0; width:90vw; max-width:450px; background:var(--md-sys-color-surface); color:var(--md-sys-color-on-surface); padding:24px; border-radius:28px; box-shadow:0 8px 30px rgba(0,0,0,.15); z-index:2147483647; max-height:85vh; display:flex; flex-direction:column; font-family:system-ui,sans-serif; transition:all 0.25s cubic-bezier(0,0,0.2,1); pointer-events:none; }
            .mui-box.open { transform:translate(-50%,-50%) scale(1); opacity:1; pointer-events:auto; }
            .mui-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; }
            .mui-header h2 { margin:0; font-size:22px; font-weight:500; }
            .mui-list-container { overflow-y:auto; flex-grow:1; position:relative; display:flex; flex-direction:column; gap:12px; }
            .mui-card { position:absolute; left:0; right:8px; height:76px; background:var(--md-sys-color-surface-container); border-radius:16px; padding:12px 16px; display:flex; justify-content:space-between; align-items:center; border-left:6px solid #CAC4D0; opacity:0.8; transition:transform 0.2s, box-shadow 0.2s; box-sizing:border-box;}
            .mui-card:hover { transform:translateY(-2px); box-shadow:0 4px 8px rgba(0,0,0,0.1); }
            .mui-card.active { border-left-color:#386A20; opacity:1; }
            .mui-rule-text { font-size:16px; font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
            .mui-rule-meta { font-size:12px; opacity:0.7; }
            .mui-card-actions { display:flex; gap:8px; }
            .mui-button { border:none; border-radius:100px; padding:10px 24px; font-weight:500; cursor:pointer; font-size:14px; transition:opacity 0.2s; display:flex; align-items:center; justify-content:center; flex:1;}
            .mui-primary { background:var(--md-sys-color-primary); color:#fff; } .mui-primary:hover { opacity:0.9; }
            .mui-secondary { background:#E8DEF8; color:#1D192B; }
            .mui-icon-btn { border:none; background:transparent; border-radius:50%; width:40px; height:40px; cursor:pointer; font-size:16px; display:flex; align-items:center; justify-content:center; }
            .mui-icon-btn:hover { background:rgba(0,0,0,0.05); }
            .mui-tonal { background:#E8DEF8; } .mui-error { background:#F9DEDC; color:#410E0B; }
            .mui-bottom-actions { margin-top:16px; display:flex; flex-direction:column; gap:12px; }
            .mui-toggle { position:fixed; top:15vh; left:0; width:48px; height:48px; background:var(--md-sys-color-primary); color:#fff; border-radius:0 16px 16px 0; text-align:center; line-height:48px; cursor:pointer; z-index:2147483647; font-size:22px; box-shadow:2px 2px 8px rgba(0,0,0,0.2); transition:transform 0.2s; }
            .mui-toggle:hover { transform:scale(1.05); }
            .mui-hidden { display:none!important; }
            .tr-replaced { background:rgba(103,80,164,0.15); border-bottom:2px solid var(--md-sys-color-primary); border-radius:4px; padding:0 2px; cursor:pointer; }
            .tr-replaced-hidden { display:inline; cursor:text; }
            #tr-quick-edit { position:absolute; z-index:2147483647; background:#ECE6F0; color:#1D1B20; padding:12px 16px; border-radius:16px; box-shadow:0 4px 12px rgba(0,0,0,0.2); font-family:system-ui,sans-serif; font-size:14px; display:flex; flex-direction:column; gap:8px; min-width:150px; }
            #tr-quick-edit label { color:#49454F; font-size:12px; font-weight:500;} .qe-orig-text { font-weight:600; overflow-wrap:break-word; max-width:200px; }
            #tr-selection-fab { position:fixed; bottom:24px; left:24px; width:56px; height:56px; background:#E8DEF8; color:#1D192B; border-radius:16px; border:none; font-size:24px; z-index:2147483646; display:flex; align-items:center; justify-content:center; cursor:pointer; box-shadow:0 4px 12px rgba(0,0,0,0.2); }
        `;
        document.documentElement.appendChild(style);
    }

    function createGUI() {
        if (document.getElementById('text-replacer-gui')) return;
        guiBox = document.createElement('div'); guiBox.id = 'text-replacer-gui'; guiBox.className = 'mui-box';
        const toggle = document.createElement('div'); toggle.className = 'mui-toggle'; toggle.textContent = '☰';
        toggle.onclick = () => { isGuiOpen = !isGuiOpen; isGuiOpen ? guiBox.classList.add('open') : guiBox.classList.remove('open'); if (isGuiOpen) buildFullGUI(); };
        document.documentElement.append(guiBox, toggle);
        createQuickEditGUI(); createSelectionFab();
    }

    // ---------- INIT ----------
    async function bootstrap() {
        loadSettings(); applyStyles(); createGUI();
        if (blockedDomains.includes(HOST)) return;
        mo = new MutationObserver(() => { clearTimeout(replaceTimer); replaceTimer = setTimeout(runDetectionAndApplyInternal, 450); });
        if (document.body) mo.observe(document.body, { childList: true, subtree: true });
        
        localRules = await dbGetAll();
        if ((!localRules || localRules.length === 0)) {
            const master = readGM(MASTER_KEY, null);
            if (master && Array.isArray(master.rules) && master.rules.length > 0) await mergeMasterPayload(master);
        } else scheduleWriteMasterMirror();
        await runDetectionAndApplyInternal();
    }
    bootstrap();
})();
