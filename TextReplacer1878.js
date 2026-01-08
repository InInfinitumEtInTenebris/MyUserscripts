// ==UserScript==
// @name         Text Replacer — Fixed Replacement & Sync (MASTER + ACTIVE + IDB)
// @namespace    http://tampermonkey.net/
// @version      9.1.0
// @description  IndexedDB master + GM MASTER mirror + per-host ACTIVE cache. Reliable detection, intelligent merge, stable replacement baseline, GM listener + polling fallback.
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  /* ---------------- CONFIG ---------------- */
  const DB_NAME = 'TextReplacerDB_v2';
  const STORE_NAME = 'rules';
  const MASTER_KEY = 'TextReplacer_MASTER_v2'; // full library mirror (for bootstrap & merges)
  const ACTIVE_KEY = 'TextReplacer_ACTIVE_v2'; // per-host detected rules: { ts, hostMap: { host: [summary,...] } }
  const BLOCK_KEY = 'TextReplacer_BLOCK_v2';

  const MASTER_POLL_MS = 5000;
  const ACTIVE_POLL_MS = 3000;
  const MASTER_WRITE_DEBOUNCE = 600;

  /* ---------------- STATE ---------------- */
  let dbInstance = null;
  let localRules = [];
  let activeRules = {}; // map oldText -> ruleSummary used for replacements
  let blockedDomains = [];
  let guiBox = null;
  let fab = null;
  let isGuiOpen = false;
  let originalTextMap = new WeakMap(); // node -> original text baseline
  let masterWriteTimer = null;
  let writingMaster = false;
  let applyingRemoteMaster = false;
  let applyingRemoteActive = false;
  let lastMasterPayloadTs = 0;
  let lastActivePayloadTs = 0;
  const HOST = window.location.hostname;

  /* ---------------- Helpers ---------------- */
  function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function isLatinToken(s) { return /^[a-zA-Z0-9_]+$/.test(s); }
  function now() { return Date.now(); }
  function uuid() { return now().toString(36) + Math.random().toString(36).slice(2); }

  /* ---------------- IndexedDB ---------------- */
  function openDB() {
    return new Promise((resolve, reject) => {
      if (dbInstance) return resolve(dbInstance);
      const req = indexedDB.open(DB_NAME, 1);
      req.onerror = () => reject(req.error || 'IDB error');
      req.onsuccess = (e) => { dbInstance = e.target.result; resolve(dbInstance); };
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

  /* ---------------- GM storage helpers ---------------- */
  function readGM(key, fallback = null) {
    try {
      const raw = GM_getValue(key, null);
      if (raw === null) return fallback;
      return (typeof raw === 'string') ? JSON.parse(raw) : raw;
    } catch (e) { console.warn('readGM parse failed', e); return fallback; }
  }
  function writeGM(key, value) {
    try {
      GM_setValue(key, JSON.stringify(value));
    } catch (e) { console.warn('writeGM failed', e); }
  }

  /* ---------------- Blocklist ---------------- */
  function loadBlocked() {
    blockedDomains = readGM(BLOCK_KEY, []) || [];
  }
  function saveBlocked() {
    writeGM(BLOCK_KEY, blockedDomains || []);
  }

  /* ---------------- MASTER mirror & merges ---------------- */
  async function scheduleWriteMasterMirror() {
    if (masterWriteTimer) clearTimeout(masterWriteTimer);
    masterWriteTimer = setTimeout(async () => {
      try {
        writingMaster = true;
        const rules = await dbGetAll();
        writeGM(MASTER_KEY, { ts: now(), rules: rules.map(r => ({ ...r })) });
        lastMasterPayloadTs = now();
      } catch (e) { console.warn('scheduleWriteMasterMirror error', e); }
      finally { setTimeout(() => writingMaster = false, 200); }
    }, MASTER_WRITE_DEBOUNCE);
  }

  // Intelligent merge: upsert by id or by signature
  function signatureOf(r) {
    return `${r.oldText}:::${r.newText}:::${!!r.caseSensitive}:::${!!r.forceGlobal}`;
  }

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
          id: r.id || uuid(),
          oldText: r.oldText,
          newText: r.newText || '',
          caseSensitive: !!r.caseSensitive,
          forceGlobal: !!r.forceGlobal,
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
          } else {
            await dbPut(cand);
          }
        }
      }

      localRules = await dbGetAll();
      // do not delete local rules on merge
      await runDetectionAndApplyInternal();
    } catch (e) {
      console.warn('mergeMasterPayload err', e);
    } finally {
      applyingRemoteMaster = false;
    }
  }

  /* ---------------- ACTIVE per-host logic ---------------- */
  function updateActiveHostInGM(detectedArray) {
    const payload = readGM(ACTIVE_KEY, { ts: 0, hostMap: {} });
    payload.hostMap = payload.hostMap || {};
    if (!detectedArray || detectedArray.length === 0) {
      if (payload.hostMap[HOST]) delete payload.hostMap[HOST];
    } else {
      payload.hostMap[HOST] = detectedArray.map(r => ({
        id: r.id, oldText: r.oldText, newText: r.newText, caseSensitive: !!r.caseSensitive, forceGlobal: !!r.forceGlobal
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
      activeRules = {};
      for (const r of hostRules) if (r && r.oldText) activeRules[r.oldText] = r;
      await runReplacementPass();
      if (isGuiOpen) displayRules();
    } finally { setTimeout(() => applyingRemoteActive = false, 200); }
  }

  /* ---------------- Detection & Replacement ---------------- */
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
    if (blockedDomains.includes(HOST)) return;
    try {
      localRules = await dbGetAll();
      const bodyText = document.body ? (document.body.innerText || document.body.textContent || '') : '';
      const detected = [];
      activeRules = {};
      for (const r of localRules) {
        if (!r.enabled) continue;
        if (testRuleAgainstText(r, bodyText)) {
          detected.push(r);
          activeRules[r.oldText] = r;
        }
      }
      // update host ACTIVE in GM; other tabs will observe this
      updateActiveHostInGM(detected);
      await runReplacementPass();
      if (isGuiOpen) displayRules();
    } catch (e) { console.warn('runDetectionAndApplyInternal err', e); }
  }

  async function runReplacementPass() {
    // Replace based on ORIGINAL baseline: ensures toggling rules doesn't corrupt previously replaced text.
    try {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
      let node;
      while ((node = walker.nextNode())) {
        if (!node.parentElement) continue;
        // skip UI
        if (node.parentElement.closest && node.parentElement.closest('#text-replacer-gui, .mui-fab, .mui-toggle')) continue;
        const tag = node.parentElement.tagName;
        if (['HEAD','SCRIPT','STYLE','TEXTAREA','INPUT','CODE','PRE'].includes(tag)) continue;
        if (node.parentElement.isContentEditable) continue;

        if (!originalTextMap.has(node)) originalTextMap.set(node, node.nodeValue);
        const base = originalTextMap.get(node) || node.nodeValue;
        let updated = base;
        let changed = false;
        for (const [oldTxt, rule] of Object.entries(activeRules)) {
          if (!oldTxt) continue;
          const isLatin = isLatinToken(oldTxt);
          const pattStr = isLatin ? `\\b${escapeRegExp(oldTxt)}\\b` : escapeRegExp(oldTxt);
          const flags = rule.caseSensitive ? 'g' : 'gi';
          const re = new RegExp(pattStr, flags);
          if (re.test(updated)) {
            updated = updated.replace(re, rule.newText);
            changed = true;
          }
        }
        if (changed && node.nodeValue !== updated) node.nodeValue = updated;
        // If no change and node currently differs from base, leave as-is (we only apply replacements; restoring to base when rules removed would require full revert — but since we always compute from base this is okay)
      }
    } catch (e) { console.warn('runReplacementPass error', e); }
  }

  /* ---------------- CRUD & UI integration ---------------- */
  async function addRuleInteractive() {
    const oldText = prompt('Text to replace:', '');
    if (!oldText?.trim()) return;
    const newText = prompt('Replacement text:', '');
    if (newText === null) return;
    const caseSensitive = confirm('Case-sensitive? (OK = yes)');
    const forceGlobal = confirm('Force Global? (OK = always active)');
    const nowTs = now();
    const rule = {
      id: uuid(),
      oldText: oldText.trim(),
      newText: newText.trim(),
      caseSensitive,
      forceGlobal,
      enabled: true,
      createdAt: nowTs,
      updatedAt: nowTs,
      site: HOST
    };
    await dbPut(rule);
    localRules = await dbGetAll();
    scheduleWriteMasterMirror();
    await runDetectionAndApplyInternal();
    displayRules();
  }

  async function editRuleInteractive(id) {
    const current = await dbGetAll();
    const rule = current.find(r => r.id === id);
    if (!rule) return;
    const updatedOld = prompt('Original text:', rule.oldText);
    if (updatedOld === null) return;
    const updatedNew = prompt('Replacement text:', rule.newText);
    if (updatedNew === null) return;
    const updatedCase = confirm(`Case-sensitive? (Current: ${rule.caseSensitive})`);
    const updatedGlobal = confirm(`Force Global? (Current: ${rule.forceGlobal})`);
    rule.oldText = updatedOld.trim();
    rule.newText = updatedNew.trim();
    rule.caseSensitive = updatedCase;
    rule.forceGlobal = updatedGlobal;
    rule.updatedAt = now();
    await dbPut(rule);
    localRules = await dbGetAll();
    scheduleWriteMasterMirror();
    await runDetectionAndApplyInternal();
    displayRules();
  }

  async function deleteRuleInteractive(id) {
    if (!confirm('Delete this rule permanently?')) return;
    await dbDelete(id);
    localRules = await dbGetAll();
    scheduleWriteMasterMirror();
    await runDetectionAndApplyInternal();
    displayRules();
  }

  /* ---------------- Import / Export (file-based) ---------------- */
  async function exportRulesFile() {
    const all = await dbGetAll();
    const blob = new Blob([JSON.stringify({ ts: now(), rules: all }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `text-replacer-rules-${now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    alert('Exported rules to your downloads.');
  }

  function promptFileImport(merge = true) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.style.display = 'none';
    input.onchange = async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) { input.remove(); return; }
      try {
        const text = await f.text();
        await importRulesFromJSONString(text, merge);
      } catch (err) {
        alert('Failed to import file: ' + err);
      } finally { input.remove(); }
    };
    document.body.appendChild(input);
    input.click();
  }

  async function importRulesFromJSONString(jsonStr, merge = true) {
    let payload;
    try { payload = JSON.parse(jsonStr); } catch (e) { alert('Invalid JSON'); return; }
    const rulesArr = Array.isArray(payload) ? payload : (Array.isArray(payload.rules) ? payload.rules : null);
    if (!rulesArr) { alert('JSON must be an array or {rules:[...]}'); return; }
    const current = await dbGetAll();
    const byId = new Map(current.map(r => [r.id, r]));
    const bySig = new Map(current.map(r => [signatureOf(r), r]));
    for (const r of rulesArr) {
      if (!r || !r.oldText) continue;
      const cand = {
        id: r.id || uuid(),
        oldText: r.oldText,
        newText: r.newText || '',
        caseSensitive: !!r.caseSensitive,
        forceGlobal: !!r.forceGlobal,
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
        } else {
          await dbPut(cand);
        }
      }
    }
    localRules = await dbGetAll();
    scheduleWriteMasterMirror();
    await runDetectionAndApplyInternal();
    displayRules();
    alert('Import complete.');
  }

  /* ---------------- GUI (keeps style & behavior) ---------------- */
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
    `;
    document.documentElement.appendChild(style);
  }

  function escapeHtml(s) { if (!s) return ''; return s.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]); }

  function displayRules() {
    if (!guiBox) return;
    guiBox.innerHTML = '';
    const header = document.createElement('div'); header.className = 'mui-header';
    const title = document.createElement('h2'); title.textContent = 'Library';
    const optsBtn = document.createElement('button'); optsBtn.textContent = '⚙️'; optsBtn.className = 'mui-button-small'; optsBtn.onclick = showSettings;
    header.append(title, optsBtn);
    guiBox.appendChild(header);
    guiBox.appendChild(document.createElement('hr'));
    const listContainer = document.createElement('div'); listContainer.className = 'mui-list-container';
    if (!localRules || localRules.length === 0) listContainer.innerHTML = '<div class="mui-empty-state">Library is empty.</div>';
    const sorted = [...(localRules || [])].sort((a, b) => {
      const aActive = !!activeRules[a.oldText], bActive = !!activeRules[b.oldText];
      if (aActive === bActive) return (a.oldText || '').localeCompare(b.oldText || '');
      return bActive - aActive;
    });
    for (const r of sorted) {
      const isActive = !!activeRules[r.oldText];
      const item = document.createElement('div'); item.className = 'mui-card';
      item.style.borderLeft = isActive ? '4px solid #4CAF50' : '4px solid #ccc';
      item.style.opacity = isActive ? '1' : '0.8';
      const info = document.createElement('div');
      info.innerHTML = `<div class="mui-rule-text">"${escapeHtml(r.oldText)}" ➡ "${escapeHtml(r.newText)}"</div>
                        <div class="mui-rule-meta">${isActive ? '✅ Active' : '💤 Idle (Stored)'} | ${r.forceGlobal ? '🌍 Global' : '🤖 Auto-Detect'}</div>`;
      const actions = document.createElement('div'); actions.className = 'mui-card-actions';
      const editBtn = document.createElement('button'); editBtn.textContent = '✏️'; editBtn.className = 'mui-icon-btn'; editBtn.onclick = () => editRuleInteractive(r.id);
      const delBtn = document.createElement('button'); delBtn.textContent = '🗑️'; delBtn.className = 'mui-icon-btn danger'; delBtn.onclick = () => deleteRuleInteractive(r.id);
      actions.append(editBtn, delBtn);
      item.append(info, actions);
      listContainer.appendChild(item);
    }
    guiBox.appendChild(listContainer);
    const bottom = document.createElement('div'); bottom.style.marginTop = '8px'; bottom.style.display = 'flex'; bottom.style.flexDirection = 'column'; bottom.style.gap = '8px';
    const addBtn = document.createElement('button'); addBtn.textContent = '＋ Add Rule'; addBtn.className = 'mui-button full-width'; addBtn.onclick = addRuleInteractive;
    const exImpRow = document.createElement('div'); exImpRow.style.display = 'flex'; exImpRow.style.gap = '8px';
    const exportBtn = document.createElement('button'); exportBtn.textContent = 'Export'; exportBtn.className = 'mui-button'; exportBtn.onclick = exportRulesFile;
    const importBtn = document.createElement('button'); importBtn.textContent = 'Import'; importBtn.className = 'mui-button';
    importBtn.onclick = () => {
      const merge = confirm('Press OK to MERGE imported rules with your library. Cancel to REPLACE.');
      promptFileImport(merge);
    };
    exImpRow.append(exportBtn, importBtn);
    bottom.append(addBtn, exImpRow);
    guiBox.appendChild(bottom);
  }

  function showSettings() {
    if (!guiBox) return;
    guiBox.innerHTML = '';
    const title = document.createElement('h2'); title.textContent = 'Blocklist'; guiBox.appendChild(title);
    const list = document.createElement('div'); list.className = 'mui-list-container';
    blockedDomains.forEach(d => {
      const row = document.createElement('div'); row.className = 'mui-blocklist-item'; row.innerHTML = `<span>${escapeHtml(d)}</span>`;
      const x = document.createElement('button'); x.textContent = '✖'; x.className = 'mui-delete-x'; x.onclick = () => { blockedDomains = blockedDomains.filter(x => x !== d); saveBlocked(); showSettings(); };
      row.appendChild(x); list.appendChild(row);
    });
    const addBtn = document.createElement('button'); addBtn.textContent = '🚫 Block Current Site'; addBtn.className = 'mui-button full-width'; addBtn.style.marginTop = '10px'; addBtn.onclick = () => { if (!blockedDomains.includes(HOST)) { blockedDomains.push(HOST); saveBlocked(); showSettings(); } };
    const exportBlockBtn = document.createElement('button'); exportBlockBtn.textContent = 'Export Blocklist'; exportBlockBtn.className = 'mui-button full-width'; exportBlockBtn.style.marginTop = '6px'; exportBlockBtn.onclick = async () => {
      try { await navigator.clipboard.writeText(JSON.stringify(blockedDomains, null, 2)); alert('Blocklist copied to clipboard.'); } catch (e) {
        const blob = new Blob([JSON.stringify(blockedDomains, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `text-replacer-blocklist-${now()}.json`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      }
    };
    const backBtn = document.createElement('button'); backBtn.textContent = '⬅ Back'; backBtn.className = 'mui-button full-width'; backBtn.style.marginTop = '10px'; backBtn.onclick = displayRules;
    list.appendChild(addBtn); list.appendChild(exportBlockBtn); guiBox.appendChild(list); guiBox.appendChild(backBtn);
  }

  function createGUI() {
    if (document.getElementById('text-replacer-gui')) return;
    guiBox = document.createElement('div'); guiBox.id = 'text-replacer-gui'; guiBox.className = 'mui-box mui-hidden';
    fab = document.createElement('button'); fab.textContent = '+'; fab.className = 'mui-fab mui-hidden'; fab.onclick = addRuleInteractive;
    const toggle = document.createElement('div'); toggle.className = 'mui-toggle'; toggle.textContent = '☰'; toggle.onclick = () => { isGuiOpen = !isGuiOpen; guiBox.classList.toggle('mui-hidden', !isGuiOpen); fab.classList.toggle('mui-hidden', !isGuiOpen); if (isGuiOpen) displayRules(); };
    document.documentElement.append(guiBox, fab, toggle);
  }

  /* ---------------- GM listeners + polling fallback ---------------- */
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
    }
  } catch (e) { console.warn('GM_addValueChangeListener not available', e); }

  // Polling fallback to ensure we don't miss updates
  setInterval(() => {
    try {
      const master = readGM(MASTER_KEY, null);
      if (master && master.ts && master.ts !== lastMasterPayloadTs) { lastMasterPayloadTs = master.ts; mergeMasterPayload(master); }
    } catch (e) { /* ignore */ }
  }, MASTER_POLL_MS);

  setInterval(() => {
    try {
      const active = readGM(ACTIVE_KEY, null);
      if (active && active.ts && active.ts !== lastActivePayloadTs) { lastActivePayloadTs = active.ts; handleActiveGMChange(active); }
    } catch (e) { /* ignore */ }
  }, ACTIVE_POLL_MS);

  /* ---------------- Mutation observer & periodic detection ---------------- */
  let mutationTimer = null;
  function observeDOM() {
    const mo = new MutationObserver(() => {
      if (mutationTimer) clearTimeout(mutationTimer);
      mutationTimer = setTimeout(() => { runDetectionAndApplyInternal(); if (!document.getElementById('text-replacer-gui')) createGUI(); }, 450);
    });
    if (document.body) mo.observe(document.body, { childList: true, subtree: true });
  }

  setInterval(() => { runDetectionAndApplyInternal(); }, 8000); // periodic detection

  /* ---------------- Init ---------------- */
  async function bootstrap() {
    applyStyles();
    loadBlocked();
    createGUI();
    localRules = await dbGetAll();

    // if local empty, attempt to bootstrap from MASTER immediately
    const master = readGM(MASTER_KEY, null);
    if ((!localRules || localRules.length === 0) && master && Array.isArray(master.rules) && master.rules.length > 0) {
      await mergeMasterPayload(master);
    } else {
      // ensure master mirror reflects our DB on first run
      scheduleWriteMasterMirror();
    }

    await runDetectionAndApplyInternal();
    observeDOM();

    // expose debug helpers
    try { window.__TextReplacer = { dbGetAll, runDetectionAndApplyInternal, exportRulesFile, mergeMasterPayload, readGM }; } catch (e) { /* ignore */ }
  }

  applyStyles();
  bootstrap();

  /* ---------------- Expose UI functions used by script (not overwritten) ---------------- */
  // If your UI calls displayRules(), etc., they are present above.
})();