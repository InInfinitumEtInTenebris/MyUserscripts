// ==UserScript==
// @name         Text Replacer — Stable UI + Smart Priority + Quick Edit Highlight
// @namespace    http://tampermonkey.net/
// @version      9.2.6
// @description  Stable GUI, persistent scroll, blocklist import/export, MASTER/ACTIVE/IDB pipeline. Smart Priority. Blue highlighted text with click-to-quick-edit pop-up.
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
    const MASTER_POLL_MS = 5000;
    const ACTIVE_POLL_MS = 3000;
    const MASTER_WRITE_DEBOUNCE = 600;
    const GUI_UPDATE_DEBOUNCE = 150;
    const REPLACE_DEBOUNCE = 120;
    const SCROLL_SAVE_DEBOUNCE = 250;

    // ---------- STATE ----------
    let dbInstance = null;
    let localRules = [];
    let activeRules = {}; // oldText -> rule
    let blockedDomains = [];
    let guiBox = null, listContainer = null, fab = null, quickEditBox = null;
    let isGuiOpen = false;
    // originalTextMap is less useful now that we replace nodes, but kept for edge cases if needed later.
    let originalTextMap = new WeakMap();
    let writingMaster = false;
    let applyingRemoteMaster = false;
    let applyingRemoteActive = false;
    let lastMasterPayloadTs = 0;
    let lastActivePayloadTs = 0;
    const HOST = window.location.hostname;
    let prevActiveHash = '';
    let prevLocalHash = '';
    let guiUpdateTimer = null;
    let replaceTimer = null;
    let userInteracting = false;
    let userInteractTimeout = null;
    let masterWriteTimer = null;
    let scrollSaveTimer = null;
    let quickEditActiveId = null;

    // ---------- helpers ----------
    function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
    function isLatinToken(s) { return /^[a-zA-Z0-9_]+$/.test(s); }
    function now() { return Date.now(); }
    function uuid() { return now().toString(36) + Math.random().toString(36).slice(2); }
    function signatureOf(r) { return `${r.oldText}:::${r.newText}:::${!!r.caseSensitive}:::${!!r.forceGlobal}:::${!!r.smartPriority}`; }

    // ---------- IndexedDB ----------
    function openDB() {
        return new Promise((resolve, reject) => {
            if (dbInstance) return resolve(dbInstance);
            const req = indexedDB.open(DB_NAME, 1);
            req.onerror = () => reject(req.error || 'IDB error');
            req.onsuccess = (e) => {
                dbInstance = e.target.result;
                resolve(dbInstance);
            };
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'id' });
            };
        });
    }
    async function dbGetAll() {
        const db = await openDB();
        return new Promise((res) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const req = tx.objectStore(STORE_NAME).getAll();
            req.onsuccess = () => res(req.result || []);
            req.onerror = () => res([]);
        });
    }
    async function dbPut(rule) {
        const db = await openDB();
        return new Promise((res, rej) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const req = tx.objectStore(STORE_NAME).put(rule);
            req.onsuccess = () => res();
            req.onerror = (e) => rej(e);
        });
    }
    async function dbDelete(id) {
        const db = await openDB();
        return new Promise((res, rej) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const req = tx.objectStore(STORE_NAME).delete(id);
            req.onsuccess = () => res();
            req.onerror = (e) => rej(e);
        });
    }

    // ---------- GM helpers ----------
    function readGM(key, fallback = null) {
        try {
            const raw = GM_getValue(key, null);
            if (raw === null) return fallback;
            return (typeof raw === 'string') ? JSON.parse(raw) : raw;
        } catch (e) {
            console.warn('readGM parse failed', e);
            return fallback;
        }
    }
    function writeGM(key, value) {
        try {
            GM_setValue(key, JSON.stringify(value));
        } catch (e) {
            console.warn('writeGM failed', e);
        }
    }

    // ---------- Blocklist (Global Master) ----------
    // Always load fresh from GM when needed to ensure global sync
    function loadBlocked() { blockedDomains = readGM(BLOCK_KEY, []) || []; }
    function saveBlocked() { writeGM(BLOCK_KEY, blockedDomains || []); }

    // ---------- MASTER mirror ----------
    async function scheduleWriteMasterMirror() {
        if (masterWriteTimer) clearTimeout(masterWriteTimer);
        masterWriteTimer = setTimeout(async () => {
            try {
                writingMaster = true;
                const rules = await dbGetAll();
                writeGM(MASTER_KEY, { ts: now(), rules: rules.map(r => ({ ...r })) });
                lastMasterPayloadTs = now();
            } finally { setTimeout(() => writingMaster = false, 200); }
        }, MASTER_WRITE_DEBOUNCE);
    }

    // ---------- intelligent merge ----------
    async function mergeMasterPayload(payload) {
        if (!payload || !Array.isArray(payload.rules)) return;
        if (applyingRemoteMaster) return;
        applyingRemoteMaster = true;
        try {
            const incoming = payload.rules;
            const current = await dbGetAll();
            const byId = new Map(current.map(r => [r.id, r]));
            const bySig = new Map(current.map(r => [signatureOf(r), r]));

            for (const r of incoming) {
                if (!r || !r.oldText) continue;
                const cand = {
                    id: r.id || uuid(), oldText: r.oldText, newText: r.newText || '',
                    caseSensitive: !!r.caseSensitive, forceGlobal: !!r.forceGlobal,
                    smartPriority: !!r.smartPriority,
                    enabled: r.enabled !== false, createdAt: r.createdAt || now(),
                    updatedAt: r.updatedAt || now(), site: r.site || null
                };
                if (byId.has(cand.id)) {
                    const local = byId.get(cand.id);
                    if ((cand.updatedAt || 0) > (local.updatedAt || 0)) await dbPut({ ...local, ...cand, id: local.id });
                } else {
                    const sig = signatureOf(cand);
                    if (bySig.has(sig)) {
                        const local = bySig.get(sig);
                        if ((cand.updatedAt || 0) > (local.updatedAt || 0)) await dbPut({ ...local, ...cand, id: local.id });
                    } else {
                        await dbPut(cand);
                    }
                }
            }
            localRules = await dbGetAll();
            scheduleGuiUpdate();
            scheduleReplace();
        } catch (e) {
            console.warn('mergeMasterPayload err', e);
        } finally {
            applyingRemoteMaster = false;
        }
    }

    // ---------- ACTIVE host logic ----------
    function updateActiveHostInGM(detectedArray) {
        const payload = readGM(ACTIVE_KEY, { ts: 0, hostMap: {} });
        payload.hostMap = payload.hostMap || {};
        if (!detectedArray || detectedArray.length === 0) {
            if (payload.hostMap[HOST]) delete payload.hostMap[HOST];
        } else {
            payload.hostMap[HOST] = detectedArray.map(r => ({
                id: r.id, oldText: r.oldText, newText: r.newText,
                caseSensitive: !!r.caseSensitive, forceGlobal: !!r.forceGlobal,
                smartPriority: !!r.smartPriority
            }));
        }
        payload.ts = now();
        writeGM(ACTIVE_KEY, payload);
        lastActivePayloadTs = payload.ts;
    }
    async function handleActiveGMChange(raw) {
        let payload = raw || readGM(ACTIVE_KEY, { ts: 0, hostMap: {} });
        try { if (typeof payload === 'string') payload = JSON.parse(payload); } catch (e) { payload = readGM(ACTIVE_KEY, { ts:0, hostMap:{} }); }
        if (!payload || !payload.hostMap) return;
        const hostRules = payload.hostMap[HOST] || [];
        if (applyingRemoteActive) return;
        applyingRemoteActive = true;
        try {
            const newActive = {};
            for (const r of hostRules) if (r && r.oldText) newActive[r.oldText] = r;
            const newHash = JSON.stringify(Object.keys(newActive).sort());
            if (newHash === prevActiveHash) { applyingRemoteActive = false; return; }
            activeRules = newActive;
            prevActiveHash = newHash;
            scheduleReplace();
            scheduleGuiUpdate();
        } finally { setTimeout(() => applyingRemoteActive = false, 200); }
    }

    // ---------- detection & replacement ----------
    function testRuleAgainstText(rule, text) {
        if (!rule || !rule.oldText) return false;
        if (rule.forceGlobal) return true;
        const old = rule.oldText;
        const patt = isLatinToken(old) ? `\\b${escapeRegExp(old)}\\b` : escapeRegExp(old);
        try {
            const re = new RegExp(patt, rule.caseSensitive ? '' : 'i');
            return re.test(text);
        } catch (e) {
            return text.indexOf(old) !== -1;
        }
    }

    async function runDetectionAndApplyInternal() {
        loadBlocked(); // Ensure blocklist is up to date
        if (blockedDomains.includes(HOST)) return;
        localRules = await dbGetAll();
        const bodyText = document.body ? (document.body.innerText || document.body.textContent || '') : '';
        const detected = [];
        const newActive = {};
        for (const r of localRules) {
            if (!r.enabled) continue;
            if (testRuleAgainstText(r, bodyText)) {
                detected.push(r);
                newActive[r.oldText] = r;
            }
        }
        updateActiveHostInGM(detected);

        const newHash = JSON.stringify(Object.keys(newActive).sort());
        if (newHash !== prevActiveHash) {
            activeRules = newActive;
            prevActiveHash = newHash;
            scheduleReplace();
            scheduleGuiUpdate();
        }
    }

    function scheduleReplace() {
        if (replaceTimer) clearTimeout(replaceTimer);
        replaceTimer = setTimeout(() => {
            performReplacementPass();
            replaceTimer = null;
        }, REPLACE_DEBOUNCE);
    }

    // REWRITTEN: Now uses DocumentFragments and spans for highlighting
    function performReplacementPass() {
        try {
            let rulesList = Object.values(activeRules);
            // Sorting: Priority then Length Descending
            rulesList.sort((a, b) => {
                if (!!a.smartPriority !== !!b.smartPriority) return a.smartPriority ? -1 : 1;
                return (b.oldText || '').length - (a.oldText || '').length;
            });

            if (rulesList.length === 0) return;

            // Build a single master regex for all rules
            const regexParts = [];
            const ruleMap = new Map(); // Map escaped oldText back to the rule object

            for (const rule of rulesList) {
                 if (!rule.oldText) continue;
                 const escaped = escapeRegExp(rule.oldText);
                 const isLatin = isLatinToken(rule.oldText);
                 const pattern = isLatin ? `\\b${escaped}\\b` : escaped;
                 regexParts.push(pattern);
                 // We need to map the pattern back to the rule to know which replacement to use
                 ruleMap.set(pattern, rule);
            }

            if (regexParts.length === 0) return;

            // Create the master regex. Use capturing groups so split() includes separators.
            const masterPattern = `(${regexParts.join('|')})`;
            // Note: We can't easily support mixed case-sensitivity in a single regex pass easily.
            // For simplicity in this complex DOM insertion scenario, we'll default to case-insensitive globally for the master match,
            // and handle exact case matching during the replacement phase if needed, though this implementation simplifies to 'gi'.
            const masterRegex = new RegExp(masterPattern, 'gi');

            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
            const nodesToReplace = [];

            // 1. Collect nodes first to avoid messing up the walker while modifying the DOM
            let node;
            while ((node = walker.nextNode())) {
                if (!node.parentElement) continue;
                 // Skip our own GUI elements
                if (node.parentElement.closest && node.parentElement.closest('#text-replacer-gui, .mui-fab, .mui-toggle, #tr-quick-edit, .tr-replaced')) continue;
                const tag = node.parentElement.tagName;
                if (['HEAD', 'SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'CODE', 'PRE', 'svg', 'path'].includes(tag)) continue;
                if (node.parentElement.isContentEditable) continue;
                if (!node.nodeValue.trim()) continue;

                if (masterRegex.test(node.nodeValue)) {
                    nodesToReplace.push(node);
                }
                masterRegex.lastIndex = 0; // Reset for next test
            }

            // 2. Process and replace nodes
            for (const textNode of nodesToReplace) {
                const text = textNode.nodeValue;
                // Split text by the regex. Result looks like: ["preceding", "match1", "middle", "match2", "end"]
                const parts = text.split(masterRegex);
                const fragment = document.createDocumentFragment();

                let matchFound = false;
                for (let i = 0; i < parts.length; i++) {
                    const part = parts[i];
                    if (i % 2 === 0) {
                        // Even indices are regular text parts
                        if (part) fragment.appendChild(document.createTextNode(part));
                    } else {
                        // Odd indices are matches. Find the corresponding rule.
                        // We iterate rulesList because we sorted it by priority/length.
                        // The first rule that matches this specific part text win.
                        let appliedRule = null;
                        for(const rule of rulesList) {
                             const isLatin = isLatinToken(rule.oldText);
                             const pattStr = isLatin ? `^\\b${escapeRegExp(rule.oldText)}\\b$` : `^${escapeRegExp(rule.oldText)}$`;
                             const flags = rule.caseSensitive ? '' : 'i';
                             if(new RegExp(pattStr, flags).test(part)) {
                                 appliedRule = rule;
                                 break;
                             }
                        }

                        if (appliedRule) {
                            const span = document.createElement('span');
                            span.className = 'tr-replaced';
                            span.textContent = appliedRule.newText;
                            // Store original text for the Quick Edit GUI
                            span.dataset.orig = appliedRule.oldText;
                            span.dataset.ruleId = appliedRule.id; // Store ID for reliable updates
                            fragment.appendChild(span);
                            matchFound = true;
                        } else {
                             // Should rarely happen if regex construction is correct, but fallback to plain text
                             fragment.appendChild(document.createTextNode(part));
                        }
                    }
                }

                if (matchFound && textNode.parentNode) {
                    textNode.parentNode.replaceChild(fragment, textNode);
                }
            }

        } catch (e) {
            console.warn('performReplacementPass error', e);
        }
    }


    // ---------- GUI update dedupe & scroll persistence ----------
    function computeLocalHash() { return JSON.stringify((localRules || []).map(r => r.id).sort()); }
    function computeActiveHash() { return JSON.stringify(Object.keys(activeRules).sort()); }
    function scheduleGuiUpdate() {
        if (userInteracting) return;
        if (guiUpdateTimer) clearTimeout(guiUpdateTimer);
        guiUpdateTimer = setTimeout(() => {
            guiUpdateTimer = null;
            renderOrPatchGUI();
        }, GUI_UPDATE_DEBOUNCE);
    }
    function renderOrPatchGUI() {
        if (!guiBox) return;
        const localHash = computeLocalHash();
        const activeHash = computeActiveHash();
        if (localHash === prevLocalHash && activeHash === prevActiveHash) return;
        prevLocalHash = localHash;
        prevActiveHash = activeHash;
        if (!listContainer) { buildFullGUI(); return; }
        const scrollTop = listContainer.scrollTop;
        const itemsMap = new Map();
        Array.from(listContainer.children || []).forEach(el => {
            const key = el.getAttribute('data-old') || '';
            if (key) itemsMap.set(key, el);
        });
        const newChildren = [];
        for (const r of (localRules || []).sort((a, b) => (a.oldText || '').localeCompare(b.oldText || ''))) {
            const key = r.oldText || '';
            let el = itemsMap.get(key);
            const isActive = !!activeRules[key];
            if (!el) {
                el = makeRuleCardElement(r);
            } else {
                updateRuleCardMeta(el, r, isActive);
                el.style.borderLeft = isActive ? '4px solid #4CAF50' : '4px solid #ccc';
                el.style.opacity = isActive ? '1' : '0.8';
            }
            newChildren.push(el);
        }
        listContainer.innerHTML = '';
        newChildren.forEach(c => listContainer.appendChild(c));
        listContainer.scrollTop = Math.max(0, scrollTop);
        saveUIScrollDebounced();
    }
    function buildFullGUI() {
        if (!guiBox) return;
        guiBox.innerHTML = '';
        const header = document.createElement('div'); header.className = 'mui-header';
        const title = document.createElement('h2'); title.textContent = 'Library';
        const optsBtn = document.createElement('button'); optsBtn.textContent = '⚙️'; optsBtn.className = 'mui-button-small'; optsBtn.onclick = showSettings;
        header.append(title, optsBtn);
        guiBox.appendChild(header);
        guiBox.appendChild(document.createElement('hr'));
        listContainer = document.createElement('div'); listContainer.className = 'mui-list-container';
        const saved = loadUIScrollForHost(HOST);
        if (typeof saved === 'number') { setTimeout(() => { if (listContainer) listContainer.scrollTop = saved; }, 0); }
        listContainer.addEventListener('pointerdown', () => { userInteracting = true; if (userInteractTimeout) clearTimeout(userInteractTimeout); });
        document.addEventListener('pointerup', () => {
            if (userInteracting) {
                if (userInteractTimeout) clearTimeout(userInteractTimeout);
                userInteractTimeout = setTimeout(() => { userInteracting = false; scheduleGuiUpdate(); }, 800);
            }
        });
        listContainer.addEventListener('wheel', () => {
            userInteracting = true; if (userInteractTimeout) clearTimeout(userInteractTimeout);
            userInteractTimeout = setTimeout(() => { userInteracting = false; scheduleGuiUpdate(); }, 800);
        });
        listContainer.addEventListener('scroll', () => { saveUIScrollDebounced(); });
        guiBox.appendChild(listContainer);
        for (const r of (localRules || []).sort((a, b) => (a.oldText || '').localeCompare(b.oldText || ''))) {
            const card = makeRuleCardElement(r);
            listContainer.appendChild(card);
        }
        const bottom = document.createElement('div'); bottom.style.marginTop = '8px'; bottom.style.display = 'flex'; bottom.style.flexDirection = 'column'; bottom.style.gap = '8px';
        const addBtn = document.createElement('button'); addBtn.textContent = '＋ Add Rule'; addBtn.className = 'mui-button full-width'; addBtn.onclick = addRuleInteractive;
        const exImpRow = document.createElement('div'); exImpRow.style.display = 'flex'; exImpRow.style.gap = '8px';
        const exportBtn = document.createElement('button'); exportBtn.textContent = 'Export'; exportBtn.className = 'mui-button'; exportBtn.onclick = exportRulesFile;
        const importBtn = document.createElement('button'); importBtn.textContent = 'Import'; importBtn.className = 'mui-button'; importBtn.onclick = () => { const merge = confirm('Press OK to MERGE imported rules with your library. Cancel to REPLACE.'); promptFileImport(merge); };
        exImpRow.append(exportBtn, importBtn);
        bottom.append(addBtn, exImpRow);
        guiBox.appendChild(bottom);
    }
    function updateRuleCardMeta(el, r, isActive) {
        const metaNode = el.querySelector('.mui-rule-meta');
        if (metaNode) {
             const status = isActive ? '✅ Active' : '💤 Idle (Stored)';
             const globalTxt = r.forceGlobal ? '🌍 Global' : '🤖 Auto';
             const prioTxt = r.smartPriority ? '⚡ Priority' : '';
             metaNode.textContent = [status, globalTxt, prioTxt].filter(x=>x).join(' | ');
        }
    }
    function makeRuleCardElement(r) {
        const isActive = !!activeRules[r.oldText];
        const item = document.createElement('div'); item.className = 'mui-card'; item.setAttribute('data-old', r.oldText || '');
        item.style.borderLeft = isActive ? '4px solid #4CAF50' : '4px solid #ccc'; item.style.opacity = isActive ? '1' : '0.8';
        const info = document.createElement('div');
        const status = isActive ? '✅ Active' : '💤 Idle (Stored)';
        const globalTxt = r.forceGlobal ? '🌍 Global' : '🤖 Auto';
        const prioTxt = r.smartPriority ? '⚡ Priority' : '';
        info.innerHTML = `<div class="mui-rule-text">"${escapeHtml(r.oldText)}" ➡ "${escapeHtml(r.newText)}"</div>
                          <div class="mui-rule-meta">${[status, globalTxt, prioTxt].filter(x=>x).join(' | ')}</div>`;
        const actions = document.createElement('div'); actions.className = 'mui-card-actions';
        const editBtn = document.createElement('button'); editBtn.textContent = '✏️'; editBtn.className = 'mui-icon-btn'; editBtn.onclick = () => editRuleInteractive(r.id);
        const delBtn = document.createElement('button'); delBtn.textContent = '🗑️'; delBtn.className = 'mui-icon-btn danger'; delBtn.onclick = () => deleteRuleInteractive(r.id);
        actions.append(editBtn, delBtn); item.append(info, actions); return item;
    }

    // ---------- Save / Load UI scroll ----------
    function saveUIScrollForHost(host, offset) { try { const map = readGM(UI_SCROLL_KEY, {}) || {}; map[host] = offset; writeGM(UI_SCROLL_KEY, map); } catch (e) { console.warn('saveUIScrollForHost failed', e); } }
    function loadUIScrollForHost(host) { try { const map = readGM(UI_SCROLL_KEY, {}) || {}; const v = map[host]; return (typeof v === 'number') ? v : 0; } catch (e) { return 0; } }
    function saveUIScrollDebounced() {
        if (!listContainer) return;
        if (scrollSaveTimer) clearTimeout(scrollSaveTimer);
        const offset = listContainer.scrollTop;
        scrollSaveTimer = setTimeout(() => { saveUIScrollForHost(HOST, offset); scrollSaveTimer = null; }, SCROLL_SAVE_DEBOUNCE);
    }

    // ---------- CRUD & File import/export & Blocklist import/export ----------
    async function addRuleInteractive() {
        const oldText = prompt('Text to replace:', ''); if (!oldText?.trim()) return;
        const newText = prompt('Replacement text:', ''); if (newText === null) return;
        const caseSensitive = confirm('Case-sensitive? (OK = yes)');
        const forceGlobal = confirm('Force Global? (OK = always active)');
        const smartPriority = confirm('Enable Smart Prioritization? (Prioritize larger terms/phrases over single words)');
        const t = now();
        const r = { id: uuid(), oldText: oldText.trim(), newText: newText.trim(), caseSensitive, forceGlobal, smartPriority, enabled: true, createdAt: t, updatedAt: t, site: HOST };
        await dbPut(r); localRules = await dbGetAll(); scheduleWriteMasterMirror(); scheduleGuiUpdate(); await runDetectionAndApplyInternal();
    }
    async function editRuleInteractive(id) {
        const cur = await dbGetAll(); const rule = cur.find(x => x.id === id); if (!rule) return;
        const updatedOld = prompt('Original text:', rule.oldText); if (updatedOld === null) return;
        const updatedNew = prompt('Replacement text:', rule.newText); if (updatedNew === null) return;
        const updatedCase = confirm(`Case-sensitive? (Current: ${rule.caseSensitive})`);
        const updatedGlobal = confirm(`Force Global? (Current: ${rule.forceGlobal})`);
        const updatedPriority = confirm(`Smart Prioritization? (Current: ${!!rule.smartPriority})\nOK = Enable (Prioritize larger terms), Cancel = Disable`);
        rule.oldText = updatedOld.trim(); rule.newText = updatedNew.trim();
        rule.caseSensitive = updatedCase; rule.forceGlobal = updatedGlobal;
        rule.smartPriority = updatedPriority;
        rule.updatedAt = now();
        await dbPut(rule); localRules = await dbGetAll(); scheduleWriteMasterMirror(); scheduleGuiUpdate(); await runDetectionAndApplyInternal();
    }
    async function deleteRuleInteractive(id) {
        if (!confirm('Delete this rule permanently?')) return;
        await dbDelete(id); localRules = await dbGetAll(); scheduleWriteMasterMirror(); scheduleGuiUpdate(); await runDetectionAndApplyInternal();
    }
    async function exportRulesFile() {
        const all = await dbGetAll(); const blob = new Blob([JSON.stringify({ ts: now(), rules: all }, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `text-replacer-rules-${now()}.json`;
        document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url); alert('Exported rules to your downloads.');
    }
    function promptFileImport(merge = true) {
        const input = document.createElement('input'); input.type = 'file'; input.accept = '.json,application/json'; input.style.display = 'none';
        input.onchange = async (e) => {
            const f = e.target.files && e.target.files[0]; if (!f) { input.remove(); return; }
            try { const text = await f.text(); await importRulesFromJSONString(text, merge); } catch (err) { alert('Failed to import file: ' + err); } finally { input.remove(); }
        };
        document.body.appendChild(input); input.click();
    }
    async function importRulesFromJSONString(jsonStr, merge = true) {
        let payload; try { payload = JSON.parse(jsonStr); } catch (e) { alert('Invalid JSON'); return; }
        const rulesArr = Array.isArray(payload) ? payload : (Array.isArray(payload.rules) ? payload.rules : null);
        if (!rulesArr) { alert('JSON must be an array or {rules:[...]}'); return; }
        const current = await dbGetAll();
        const byId = new Map(current.map(r => [r.id, r]));
        const bySig = new Map(current.map(r => [signatureOf(r), r]));
        for (const r of rulesArr) {
            if (!r || !r.oldText) continue;
            const cand = { id: r.id || uuid(), oldText: r.oldText, newText: r.newText || '', caseSensitive: !!r.caseSensitive, forceGlobal: !!r.forceGlobal, smartPriority: !!r.smartPriority, enabled: r.enabled !== false, createdAt: r.createdAt || now(), updatedAt: r.updatedAt || now(), site: r.site || null };
            if (byId.has(cand.id)) {
                const local = byId.get(cand.id);
                if ((cand.updatedAt || 0) > (local.updatedAt || 0)) await dbPut({ ...local, ...cand, id: local.id });
            } else {
                const sig = signatureOf(cand);
                if (bySig.has(sig)) {
                    const local = bySig.get(sig);
                    if ((cand.updatedAt || 0) > (local.updatedAt || 0)) await dbPut({ ...local, ...cand, id: local.id });
                } else { await dbPut(cand); }
            }
        }
        localRules = await dbGetAll(); scheduleWriteMasterMirror(); scheduleGuiUpdate(); await runDetectionAndApplyInternal(); alert('Import complete.');
    }
    // Blocklist import/export
    function promptBlocklistImport() {
        const input = document.createElement('input'); input.type = 'file'; input.accept = '.json,application/json'; input.style.display = 'none';
        input.onchange = async (e) => {
            const f = e.target.files && e.target.files[0]; if (!f) { input.remove(); return; }
            try { const text = await f.text(); await importBlocklistFromJSONString(text); } catch (err) { alert('Failed to import blocklist file: ' + err); } finally { input.remove(); }
        };
        document.body.appendChild(input); input.click();
    }
    async function importBlocklistFromJSONString(jsonStr) {
        let payload; try { payload = JSON.parse(jsonStr); } catch (e) { alert('Invalid JSON for blocklist'); return; }
        let arr = null; if (Array.isArray(payload)) arr = payload; else if (Array.isArray(payload.blocklist)) arr = payload.blocklist; else if (Array.isArray(payload.blocked)) arr = payload.blocked; else if (Array.isArray(payload.domains)) arr = payload.domains;
        if (!arr) { alert('Blocklist JSON must be an array of host strings or an object with blocklist/blocked/domains array.'); return; }
        const allStrings = arr.every(x => typeof x === 'string'); if (!allStrings) { alert('Blocklist entries must be strings (hostnames).'); return; }
        if (!confirm(`Importing will replace your current blocklist with ${arr.length} entries. Proceed?`)) return;
        blockedDomains = arr; saveBlocked(); showSettings(); alert('Blocklist imported successfully.');
    }

    // ---------- GUI & settings ----------
    function applyStyles() {
        if (document.getElementById('tr-styles')) return;
        const style = document.createElement('style'); style.id = 'tr-styles';
        style.textContent = `
            .mui-box { position: fixed; top:50%; left:50%; transform:translate(-50%,-50%); width:90vw; max-width:450px; background:#fff; color:#333; padding:15px; border-radius:12px; box-shadow:0 8px 30px rgba(0,0,0,.45); z-index:2147483647; max-height:85vh; display:flex; flex-direction:column; font-family:Segoe UI, Roboto, sans-serif; font-size:14px;}
            .mui-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;}
            .mui-list-container{overflow-y:auto;flex-grow:1;padding-right:4px;}
            .mui-card{background:#f6f6f6;border-radius:8px;padding:12px;margin:8px 0;display:flex;justify-content:space-between;align-items:center;border:1px solid #eee;}
            .mui-card-actions{display:flex;gap:8px;}
            .mui-button,.mui-button-small{background:#6200EE;color:#fff;border:none;border-radius:8px;padding:10px;cursor:pointer;font-weight:500;}
            .mui-fab{position:fixed;bottom:20px;right:20px;width:56px;height:56px;background:#6200EE;color:white;border-radius:50%;border:none;font-size:28px;z-index:2147483647;display:flex;align-items:center;justify-content:center;}
            .mui-toggle{position:fixed;top:15vh;left:0;width:40px;height:40px;background:rgba(0,0,0,0.6);border-top-right-radius:8px;border-bottom-right-radius:8px;color:white;text-align:center;line-height:40px;cursor:pointer;z-index:2147483647;font-size:22px;}
            .mui-hidden{display:none!important;}
            /* New styles for highlighted text and quick edit */
            .tr-replaced { background-color: rgba(33, 150, 243, 0.2); border-bottom: 2px solid rgba(33, 150, 243, 0.5); cursor: pointer; transition: background-color 0.2s; }
            .tr-replaced:hover { background-color: rgba(33, 150, 243, 0.4); }
            #tr-quick-edit { position: absolute; z-index: 2147483647; background: #222; color: #eee; padding: 10px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.5); font-family: sans-serif; font-size: 13px; display: flex; flex-direction: column; gap: 8px; min-width: 200px; }
            #tr-quick-edit .qe-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
            #tr-quick-edit label { color: #aaa; font-size: 12px; }
            #tr-quick-edit input { background: #444; border: 1px solid #555; color: #fff; padding: 4px 8px; border-radius: 4px; flex-grow: 1; }
            #tr-quick-edit .qe-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
            #tr-quick-edit button { padding: 4px 12px; border-radius: 4px; border: none; cursor: pointer; font-size: 12px; }
            #tr-quick-edit .qe-save { background: #6200EE; color: white; }
            #tr-quick-edit .qe-cancel { background: #555; color: white; }
        `;
        document.documentElement.appendChild(style);
    }
    function escapeHtml(s) { if (!s) return ''; return s.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]); }
    function createGUI() {
        if (document.getElementById('text-replacer-gui')) return;
        guiBox = document.createElement('div'); guiBox.id = 'text-replacer-gui'; guiBox.className = 'mui-box mui-hidden';
        fab = document.createElement('button'); fab.textContent = '+'; fab.className = 'mui-fab mui-hidden'; fab.onclick = addRuleInteractive;
        const toggle = document.createElement('div'); toggle.className = 'mui-toggle'; toggle.textContent = '☰';
        toggle.onclick = () => { isGuiOpen = !isGuiOpen; guiBox.classList.toggle('mui-hidden', !isGuiOpen); fab.classList.toggle('mui-hidden', !isGuiOpen); if (isGuiOpen) renderOrPatchGUI(); };
        document.documentElement.append(guiBox, fab, toggle);
        createQuickEditGUI();
    }

    function createQuickEditGUI() {
        if (document.getElementById('tr-quick-edit')) return;
        quickEditBox = document.createElement('div');
        quickEditBox.id = 'tr-quick-edit';
        quickEditBox.className = 'mui-hidden';
        quickEditBox.innerHTML = `
            <div class="qe-row"><label>From:</label><input type="text" id="qe-from" readonly></div>
            <div class="qe-row"><label>To:</label><input type="text" id="qe-to"></div>
            <div class="qe-actions">
                <button class="qe-cancel">Cancel</button>
                <button class="qe-save">Save</button>
            </div>
        `;
        document.body.appendChild(quickEditBox);

        quickEditBox.querySelector('.qe-cancel').onclick = hideQuickEdit;
        quickEditBox.querySelector('.qe-save').onclick = saveQuickEdit;

        // Global click handler for replaced text
        document.addEventListener('click', (e) => {
            if (e.target.classList.contains('tr-replaced')) {
                showQuickEdit(e.target);
            } else if (quickEditBox && !quickEditBox.contains(e.target) && !e.target.classList.contains('tr-replaced')) {
                 hideQuickEdit();
            }
        });
    }

    function showQuickEdit(targetElement) {
        if (!quickEditBox) return;
        const origText = targetElement.dataset.orig;
        const ruleId = targetElement.dataset.ruleId;
        const currentReplacement = targetElement.textContent;

        document.getElementById('qe-from').value = origText;
        const toInput = document.getElementById('qe-to');
        toInput.value = currentReplacement;
        quickEditActiveId = ruleId;

        const rect = targetElement.getBoundingClientRect();
        const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
        const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;

        quickEditBox.style.top = `${rect.bottom + scrollTop + 5}px`;
        quickEditBox.style.left = `${rect.left + scrollLeft}px`;
        quickEditBox.classList.remove('mui-hidden');
        toInput.focus();
        toInput.select();
    }

    function hideQuickEdit() {
        if (quickEditBox) quickEditBox.classList.add('mui-hidden');
        quickEditActiveId = null;
    }

    async function saveQuickEdit() {
        const newToText = document.getElementById('qe-to').value;
        if (quickEditActiveId && newToText !== null) {
            const cur = await dbGetAll();
            const rule = cur.find(x => x.id === quickEditActiveId);
            if (rule) {
                rule.newText = newToText.trim();
                rule.updatedAt = now();
                await dbPut(rule);
                localRules = await dbGetAll();
                scheduleWriteMasterMirror();
                scheduleGuiUpdate();
                await runDetectionAndApplyInternal();
            }
        }
        hideQuickEdit();
    }

    function displayRules() { if (!guiBox) return; if (!listContainer) buildFullGUI(); else renderOrPatchGUI(); }
    function showSettings() {
        if (!guiBox) return;
        loadBlocked(); // Ensure we have the latest global blocklist from GM
        guiBox.innerHTML = ''; const title = document.createElement('h2'); title.textContent = 'Settings'; guiBox.appendChild(title); guiBox.appendChild(document.createElement('hr'));
        const container = document.createElement('div'); container.className = 'mui-list-container';
        const blTitle = document.createElement('div'); blTitle.textContent = 'Blocklist (Global)'; blTitle.style.fontWeight = '600'; container.appendChild(blTitle);
        (blockedDomains || []).forEach(d => {
            const row = document.createElement('div'); row.style.display = 'flex'; row.style.justifyContent = 'space-between'; row.style.padding = '6px 0';
            row.innerHTML = `<span>${escapeHtml(d)}</span>`;
            const x = document.createElement('button'); x.textContent = '✖'; x.onclick = () => { blockedDomains = blockedDomains.filter(x => x !== d); saveBlocked(); showSettings(); };
            row.appendChild(x); container.appendChild(row);
        });
        const blockBtn = document.createElement('button'); blockBtn.textContent = '🚫 Block Current Site'; blockBtn.className = 'mui-button full-width'; blockBtn.style.marginTop = '10px';
        blockBtn.onclick = () => { if (!blockedDomains.includes(HOST)) { blockedDomains.push(HOST); saveBlocked(); showSettings(); } };
        container.appendChild(blockBtn);
        // Export Blocklist
        const exportBlockBtn = document.createElement('button'); exportBlockBtn.textContent = 'Export Blocklist'; exportBlockBtn.className = 'mui-button full-width'; exportBlockBtn.style.marginTop = '8px';
        exportBlockBtn.onclick = async () => { try { const json = JSON.stringify(blockedDomains || [], null, 2); try { await navigator.clipboard.writeText(json); const blob = new Blob([json], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `text-replacer-blocklist-${now()}.json`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url); alert('Blocklist copied to clipboard and saved to downloads.'); } catch (clipErr) { const blob = new Blob([json], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `text-replacer-blocklist-${now()}.json`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url); alert('Blocklist exported to downloads.'); } } catch (e) { alert('Failed to export blocklist: ' + e); } }; container.appendChild(exportBlockBtn);
        // Import Blocklist
        const importBlockBtn = document.createElement('button'); importBlockBtn.textContent = 'Import Blocklist'; importBlockBtn.className = 'mui-button full-width'; importBlockBtn.style.marginTop = '8px'; importBlockBtn.onclick = () => { promptBlocklistImport(); }; container.appendChild(importBlockBtn);
        // Manual sync for this site
        const syncTitle = document.createElement('div'); syncTitle.textContent = 'Sync'; syncTitle.style.fontWeight = '600'; syncTitle.style.marginTop = '12px'; container.appendChild(syncTitle);
        const syncRow = document.createElement('div'); syncRow.style.display = 'flex'; syncRow.style.gap = '8px';
        const syncBtn = document.createElement('button'); syncBtn.textContent = 'Sync to this site now'; syncBtn.className = 'mui-button full-width';
        syncBtn.onclick = async () => { try { await forceSyncToThisSite(); alert('Sync to this site completed.'); } catch (e) { alert('Sync failed: ' + e); } };
        syncRow.append(syncBtn); container.append(syncRow); guiBox.appendChild(container);
        const backBtn = document.createElement('button'); backBtn.textContent = '⬅ Back'; backBtn.className = 'mui-button full-width'; backBtn.style.marginTop = '12px';
        backBtn.onclick = () => { isGuiOpen = true; guiBox.classList.remove('mui-hidden'); listContainer = null; displayRules(); };
        guiBox.appendChild(backBtn);
    }

    // ---------- reliable force sync implementation ----------
    async function forceSyncToThisSite() {
        try { const currentMaster = readGM(MASTER_KEY, null); if (currentMaster && currentMaster.ts) await mergeMasterPayload(currentMaster); } catch(e) { console.warn("Force sync merge failed", e); }
        localRules = await dbGetAll();
        writeGM(MASTER_KEY, { ts: now(), rules: localRules.map(r => ({ ...r })) });
        lastMasterPayloadTs = now();
        await new Promise(res => setTimeout(res, 120));
        const bodyText = document.body ? (document.body.innerText || document.body.textContent || '') : '';
        const detected = [];
        for (const r of localRules) { if (!r.enabled) continue; if (testRuleAgainstText(r, bodyText)) detected.push(r); }
        updateActiveHostInGM(detected);
        try { writeGM(SYNC_KEY, { ts: now(), host: HOST }); } catch (e) { }
        await new Promise(res => setTimeout(res, 80));
        await runDetectionAndApplyInternal();
        scheduleGuiUpdate();
    }

    // ---------- GM listeners + SYNC support ----------
    try {
        if (typeof GM_addValueChangeListener === 'function') {
            GM_addValueChangeListener(MASTER_KEY, (name, oldVal, newVal) => {
                try {
                    const payload = newVal ? (typeof newVal === 'string' ? JSON.parse(newVal) : newVal) : readGM(MASTER_KEY, null);
                    if (payload && payload.ts && payload.ts !== lastMasterPayloadTs) { lastMasterPayloadTs = payload.ts; mergeMasterPayload(payload); }
                } catch (e) { console.warn('MASTER listener parse', e); }
            });
            GM_addValueChangeListener(ACTIVE_KEY, (name, oldVal, newVal) => {
                try {
                    const payload = newVal ? (typeof newVal === 'string' ? JSON.parse(newVal) : newVal) : readGM(ACTIVE_KEY, null);
                    if (payload && payload.ts && payload.ts !== lastActivePayloadTs) { lastActivePayloadTs = payload.ts; handleActiveGMChange(payload); }
                } catch (e) { console.warn('ACTIVE listener parse', e); }
            });
            GM_addValueChangeListener(SYNC_KEY, (name, oldVal, newVal) => {
                try {
                    const payload = newVal ? (typeof newVal === 'string' ? JSON.parse(newVal) : newVal) : readGM(SYNC_KEY, null);
                    if (!payload) return;
                    const master = readGM(MASTER_KEY, null); if (master && master.ts) mergeMasterPayload(master);
                    const active = readGM(ACTIVE_KEY, null); if (active && active.ts) handleActiveGMChange(active);
                } catch (e) { console.warn('SYNC listener error', e); }
            });
        }
    } catch (e) { console.warn('GM_addValueChangeListener not available', e); }
    setInterval(() => {
        try {
            const master = readGM(MASTER_KEY, null);
            if (master && master.ts && master.ts !== lastMasterPayloadTs) { lastMasterPayloadTs = master.ts; mergeMasterPayload(master); }
        } catch (e) {}
    }, MASTER_POLL_MS);
    setInterval(() => {
        try {
            const active = readGM(ACTIVE_KEY, null);
            if (active && active.ts && active.ts !== lastActivePayloadTs) { lastActivePayloadTs = active.ts; handleActiveGMChange(active); }
        } catch (e) {}
    }, ACTIVE_POLL_MS);

    // ---------- DOM observe & periodic detection ----------
    let mutationTimer = null;
    function observeDOM() {
        const mo = new MutationObserver(() => {
            if (mutationTimer) clearTimeout(mutationTimer);
            mutationTimer = setTimeout(() => {
                runDetectionAndApplyInternal();
                if (!document.getElementById('text-replacer-gui')) createGUI();
            }, 450);
        });
        if (document.body) mo.observe(document.body, { childList: true, subtree: true });
    }
    setInterval(() => { runDetectionAndApplyInternal(); }, 8000);

    // ---------- bootstrap ----------
    async function bootstrap() {
        applyStyles(); loadBlocked(); createGUI();
        localRules = await dbGetAll();
        if ((!localRules || localRules.length === 0)) {
            const master = readGM(MASTER_KEY, null);
            if (master && Array.isArray(master.rules) && master.rules.length > 0) await mergeMasterPayload(master);
        } else {
            scheduleWriteMasterMirror();
        }
        await runDetectionAndApplyInternal();
        observeDOM();
        try { window.__TextReplacer = { dbGetAll, runDetectionAndApplyInternal, exportRulesFile: exportRulesFile, syncThisSite: forceSyncToThisSite }; } catch (e) {}
    }
    applyStyles(); bootstrap();
})();
