// ==UserScript==
// @name         Text Replacer12 (Material You, Import/Export v2, Infinite Storage, Blacklist & Advanced Logic)
// @namespace    http://tampermonkey.net/
// @version      3.3.0-modInf
// @description  Dynamically replaces text using a Material You GUI with text file import/export and case toggling. Now supports site blacklisting (hides transparent icon), advanced rule logic (ignore special chars, CJK/no word boundary, span start→stop), and JSONL v2 import/export. Uses IndexedDB for unlimited rules, debounced replacements, and skips non-content elements.
// @match        *://*/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  /** ================== IN-MEMORY ================== **/
  // replacements keyed by oldText (for term rules) or by a generated id (for span rules)
  // Rule types:
  // - { type:"term", oldText, newText, caseSensitive, ignoreSpecial, noWordBoundary }
  // - { type:"span", startText, endText, newText, caseSensitive, ignoreSpecial, noWordBoundary, greedy }
  // + site: hostname this rule applies to
  let replacements = {};
  let guiBox, fab, toggleBtn;
  let isGuiOpen = false;

  const originalTextMap = new WeakMap();
  let observerTimeout = null;

  /** ================== INDEXEDDB ================== **/
  let db;
  const DB_NAME = "TextReplacerDB";
  const STORE_RULES = "rules";
  const STORE_SETTINGS = "settings";
  // bump version for new store + flexible rule schema
  const DB_VERSION = 2;

  async function initDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_RULES)) {
          db.createObjectStore(STORE_RULES, { keyPath: "id" }); // v2: generic id
        } else {
          // v1 -> v2 migration: clone old store (keyPath oldText) into new schema
          try {
            const tx = e.target.transaction;
            const old = tx.objectStore("rules");
            // if old existed with keyPath oldText, we’ll read and re-put with ids
            const allReq = old.getAll();
            allReq.onsuccess = () => {
              const newStore = db.createObjectStore(STORE_RULES, { keyPath: "id" });
              const sTx = e.target.transaction;
              const putStore = sTx.objectStore(STORE_RULES);
              allReq.result.forEach((r) => {
                // migrate to term rule with id based on oldText + site
                const id = `term:${r.oldText}:${r.site || "*"}`;
                putStore.put({
                  id,
                  type: "term",
                  oldText: r.oldText,
                  newText: r.newText,
                  caseSensitive: !!r.caseSensitive,
                  ignoreSpecial: false,
                  noWordBoundary: hasCJK(r.oldText), // auto if CJK
                  site: r.site || "*",
                });
              });
              db.deleteObjectStore("rules"); // drop old
            };
          } catch {}
        }
        if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
          const s = db.createObjectStore(STORE_SETTINGS, { keyPath: "key" });
          // defaults
          s.put({ key: "blacklist", value: [] });
        }
      };
      req.onsuccess = (e) => {
        db = e.target.result;
        resolve();
      };
      req.onerror = (e) => reject(e);
    });
  }

  function tx(store, mode) {
    return db.transaction([store], mode).objectStore(store);
  }

  async function loadAllRules() {
    const store = tx(STORE_RULES, "readonly");
    const req = store.getAll();
    return new Promise((res, rej) => {
      req.onsuccess = () => {
        replacements = {};
        req.result.forEach((r) => (replacements[r.id] = r));
        res();
      };
      req.onerror = rej;
    });
  }

  async function saveRule(rule) {
    const store = tx(STORE_RULES, "readwrite");
    const req = store.put(rule);
    return new Promise((res, rej) => {
      req.onsuccess = () => res();
      req.onerror = rej;
    });
  }

  async function deleteRule(id) {
    const store = tx(STORE_RULES, "readwrite");
    const req = store.delete(id);
    return new Promise((res, rej) => {
      req.onsuccess = () => res();
      req.onerror = rej;
    });
  }

  async function getSetting(key, defVal) {
    const store = tx(STORE_SETTINGS, "readonly");
    const req = store.get(key);
    return new Promise((res) => {
      req.onsuccess = () => res(req.result ? req.result.value : defVal);
      req.onerror = () => res(defVal);
    });
  }

  async function setSetting(key, value) {
    const store = tx(STORE_SETTINGS, "readwrite");
    const req = store.put({ key, value });
    return new Promise((res, rej) => {
      req.onsuccess = () => res();
      req.onerror = rej;
    });
  }

  /** ================== HELPERS ================== **/
  function siteHost() {
    return location.hostname;
  }

  function hasCJK(str) {
    // Basic CJK ranges; used to disable word boundaries automatically
    return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(str);
  }

  function shouldSkip(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const p = node.parentElement;
      if (!p) return true;
      if (p.closest('.mui-box, .mui-toggle, .mui-fab')) return true;
      const tag = p.tagName;
      if (['HEAD', 'SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE'].includes(tag)) return true;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.closest('.mui-box, .mui-toggle, .mui-fab')) return true;
      if (['HEAD', 'SCRIPT', 'STYLE'].includes(node.tagName)) return true;
    }
    return false;
  }

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Build a forgiving pattern for "term" rules
  function buildTermPattern(text, { caseSensitive, ignoreSpecial, noWordBoundary }) {
    let body;
    if (ignoreSpecial) {
      // Allow any number of non-letter/number chars between characters
      // Split into unicode-aware chars
      const parts = Array.from(text);
      body = parts.map(ch => {
        const esc = escapeRegExp(ch);
        return esc + "[^\\p{L}\\p{N}]*";
      }).join('');
      // remove trailing tolerance
      body = body.replace(/\[\^\\p\{L\}\\p\{N\}\]\*$/u, '');
    } else {
      body = escapeRegExp(text);
    }
    const flags = caseSensitive ? 'gu' : 'giu';
    if (noWordBoundary || hasCJK(text)) {
      return new RegExp(body, flags);
    } else {
      return new RegExp(`\\b${body}\\b`, flags);
    }
  }

  // Build a "span" pattern: replace from startText to endText
  function buildSpanPattern(startText, endText, { caseSensitive, ignoreSpecial, noWordBoundary, greedy }) {
    const start = buildTermPattern(startText, { caseSensitive, ignoreSpecial, noWordBoundary }).source;
    const end = buildTermPattern(endText, { caseSensitive, ignoreSpecial, noWordBoundary }).source;
    // non-greedy (default) vs greedy
    const mid = greedy ? "[\\s\\S]*" : "[\\s\\S]*?";
    const flags = caseSensitive ? 'gu' : 'giu';
    return new RegExp(`${start}${mid}${end}`, flags);
  }

  /** ================== REPLACEMENT ENGINE ================== **/
  function applyReplacementsToText(baseText, rulesForSite) {
    let updated = baseText;
    // TERM rules first, then SPAN (or vice versa). We'll do SPAN first to collapse big ranges, then TERM.
    const spanRules = rulesForSite.filter(r => r.type === 'span');
    const termRules = rulesForSite.filter(r => r.type === 'term');

    for (const r of spanRules) {
      try {
        const pat = buildSpanPattern(r.startText, r.endText, r);
        updated = updated.replace(pat, r.newText);
      } catch { /* ignore bad regex */ }
    }
    for (const r of termRules) {
      try {
        const pat = buildTermPattern(r.oldText, r);
        updated = updated.replace(pat, r.newText);
      } catch { /* ignore bad regex */ }
    }
    return updated;
  }

  function replaceNode(node) {
    if (shouldSkip(node)) return;
    if (node.nodeType === Node.TEXT_NODE) {
      if (!originalTextMap.has(node)) {
        originalTextMap.set(node, node.nodeValue);
      }
      const baseText = originalTextMap.get(node);
      const site = siteHost();
      const rulesForSite = Object.values(replacements).filter(r => (r.site === site || r.site === "*"));
      if (rulesForSite.length === 0) return;
      const newText = applyReplacementsToText(baseText, rulesForSite);
      if (newText !== node.nodeValue) node.nodeValue = newText;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      node.childNodes.forEach(replaceNode);
    }
  }

  function runReplacements() {
    replaceNode(document.body);
  }

  const observer = new MutationObserver(() => {
    if (observerTimeout) clearTimeout(observerTimeout);
    observerTimeout = setTimeout(runReplacements, 500);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  function onUrlChange() { runReplacements(); }
  const _ps = history.pushState;
  history.pushState = function (...a) { _ps.apply(history, a); onUrlChange(); };
  const _rs = history.replaceState;
  history.replaceState = function (...a) { _rs.apply(history, a); onUrlChange(); };
  addEventListener('popstate', onUrlChange);

  /** ================== GUI ================== **/
  function displayRules() {
    if (!guiBox) return;
    guiBox.innerHTML = '';

    const title = el('h2', 'Text Replacer Rules');
    guiBox.appendChild(title);

    // Controls row
    const row = el('div');
    row.appendChild(btn('➕ Add', addRule));
    row.appendChild(btn('📤 Export (v2)', exportRules));
    row.appendChild(btn('📥 Import', importRules));
    row.appendChild(btn('⛔ Blacklist', manageBlacklist));
    guiBox.appendChild(row);

    const site = siteHost();
    const list = Object.values(replacements).filter(r => r.site === site || r.site === "*");

    if (list.length === 0) {
      guiBox.appendChild(el('div', '(No rules for this site)'));
      return;
    }

    for (const r of list) {
      const card = el('div'); card.className = 'mui-card';
      const meta = (r.type === 'term')
        ? `term • "${r.oldText}" → "${r.newText}"`
        : `span • "${r.startText}" … "${r.endText}" → "${r.newText}"`;
      const opts = `(${r.caseSensitive ? 'Case' : 'i'}; ${r.ignoreSpecial ? 'IgnoreSpecial' : 'Exact'}; ${r.noWordBoundary ? 'NoWB' : 'WB'}${r.type === 'span' ? `; ${r.greedy ? 'Greedy' : 'Lazy'}` : ''}; site=${r.site})`;
      const left = el('div', `<strong>${meta}</strong><br><small>${opts}</small>`);
      const actions = el('div');
      actions.appendChild(btn('✏️ Edit', () => editRule(r.id)));
      actions.appendChild(btn('🗑️ Delete', () => deleteRuleUI(r.id)));
      card.appendChild(left);
      card.appendChild(actions);
      guiBox.appendChild(card);
    }
  }

  function el(tag, html) {
    const x = document.createElement(tag);
    if (html !== undefined) x.innerHTML = html;
    return x;
  }
  function btn(text, handler) {
    const b = document.createElement('button');
    b.textContent = text;
    b.className = 'mui-button';
    b.addEventListener('click', handler);
    return b;
  }

  async function addRule() {
    const type = prompt('Rule type? Enter "term" or "span"', 'term');
    if (!type) return;

    const site = prompt('Site scope (leave empty for current, or "*" for all):', siteHost()) || siteHost();

    const caseSensitive = confirm('Case-sensitive match? OK = Yes, Cancel = No');
    const ignoreSpecial = confirm('Ignore special characters between letters? (e.g., "Open-AI" matches "OpenAI")');
    const noWordBoundary = confirm('Disable word boundaries? (OK if CJK or needs partial matches)');

    if (type.toLowerCase() === 'span') {
      const startText = prompt('Enter START text:', '');
      if (!startText) return;
      const endText = prompt('Enter END text:', '');
      if (!endText) return;
      const newText = prompt('Replacement text for the whole span:', '');
      if (newText === null) return;
      const greedy = confirm('Greedy match (spans the farthest end)? OK = Greedy, Cancel = Lazy');

      const id = `span:${startText}:${endText}:${site}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      const rule = { id, type: 'span', startText: startText.trim(), endText: endText.trim(), newText: newText.trim(), caseSensitive, ignoreSpecial, noWordBoundary, greedy, site };
      replacements[id] = rule;
      await saveRule(rule);
    } else {
      const oldText = prompt('Enter the text to replace:', '');
      if (!oldText) return;
      const newText = prompt('Enter the replacement text:', '');
      if (newText === null) return;
      const id = `term:${oldText}:${site}`;
      const rule = { id, type: 'term', oldText: oldText.trim(), newText: newText.trim(), caseSensitive, ignoreSpecial, noWordBoundary, site };
      replacements[id] = rule;
      await saveRule(rule);
    }
    alert('Rule added.');
    displayRules();
    runReplacements();
  }

  async function editRule(id) {
    const r = replacements[id];
    if (!r) return alert('Rule not found.');
    const site = prompt('Edit site scope ("*" or hostname):', r.site) || r.site;
    const caseSensitive = confirm('Case-sensitive? OK = Yes, Cancel = No');
    const ignoreSpecial = confirm('Ignore special characters?');
    const noWordBoundary = confirm('Disable word boundaries?');

    if (r.type === 'span') {
      const startText = prompt('Edit START text:', r.startText);
      if (startText === null) return;
      const endText = prompt('Edit END text:', r.endText);
      if (endText === null) return;
      const newText = prompt('Edit replacement text:', r.newText);
      if (newText === null) return;
      const greedy = confirm('Greedy match? OK = Yes, Cancel = No');

      const newId = `span:${startText}:${endText}:${site}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      await deleteRule(id);
      const updated = { id: newId, type: 'span', startText: startText.trim(), endText: endText.trim(), newText: newText.trim(), caseSensitive, ignoreSpecial, noWordBoundary, greedy, site };
      replacements[newId] = updated;
      await saveRule(updated);
      delete replacements[id];
    } else {
      const oldText = prompt('Edit original text:', r.oldText);
      if (oldText === null) return;
      const newText = prompt('Edit replacement text:', r.newText);
      if (newText === null) return;

      const newId = `term:${oldText}:${site}`;
      await deleteRule(id);
      const updated = { id: newId, type: 'term', oldText: oldText.trim(), newText: newText.trim(), caseSensitive, ignoreSpecial, noWordBoundary, site };
      replacements[newId] = updated;
      await saveRule(updated);
      delete replacements[id];
    }
    alert('Rule updated.');
    displayRules();
    runReplacements();
  }

  async function deleteRuleUI(id) {
    if (!confirm('Delete this rule?')) return;
    await deleteRule(id);
    delete replacements[id];
    alert('Rule deleted.');
    displayRules();
    runReplacements();
  }

  /** ================== IMPORT / EXPORT ================== **/
  // v2 format: JSONL lines prefixed with "v2|"
  // Legacy v1: oldText:newText:caseInt
  function exportRules() {
    const lines = [];
    for (const r of Object.values(replacements)) {
      lines.push(`v2|${JSON.stringify(r)}`);
    }
    const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'text_replacements_v2.txt';
    a.click();
  }

  function importRules() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.txt';
    input.addEventListener('change', async (ev) => {
      const file = ev.target.files[0];
      if (!file) return;
      const text = await file.text();
      const lines = text.split(/\r?\n/);
      let count = 0;
      for (const line of lines) {
        if (!line.trim()) continue;
        if (line.startsWith('v2|')) {
          try {
            const r = JSON.parse(line.slice(3));
            // ensure site default
            r.site = r.site || siteHost();
            // ensure id
            if (!r.id) {
              r.id = r.type === 'span'
                ? `span:${r.startText}:${r.endText}:${r.site}:${Date.now()}:${Math.random().toString(36).slice(2)}`
                : `term:${r.oldText}:${r.site}`;
            }
            replacements[r.id] = r;
            await saveRule(r);
            count++;
          } catch { /* ignore bad lines */ }
        } else {
          // legacy
          const parts = line.split(':');
          if (parts.length >= 3) {
            const oldText = parts[0].trim();
            const newText = parts[1].trim();
            const caseSensitive = parts[2].trim() === '1';
            if (oldText) {
              const id = `term:${oldText}:${siteHost()}`;
              const r = { id, type: 'term', oldText, newText, caseSensitive, ignoreSpecial: false, noWordBoundary: hasCJK(oldText), site: siteHost() };
              replacements[id] = r;
              await saveRule(r);
              count++;
            }
          }
        }
      }
      alert(`Imported ${count} rule(s).`);
      displayRules();
      runReplacements();
    });
    input.click();
  }

  /** ================== BLACKLIST (HIDE TRANSPARENT ICON) ================== **/
  async function manageBlacklist() {
    const current = await getSetting('blacklist', []);
    const action = prompt(
      `Blacklist manager\nCurrent: ${current.join(', ') || '(empty)'}\n` +
      `Enter:\n - "add example.com"\n - "remove example.com"\n - "clear"\n - "show"`,
      'show'
    );
    if (!action) return;
    const [cmd, val] = action.split(/\s+/);
    let next = current.slice();
    if (cmd === 'add' && val) {
      if (!next.includes(val)) next.push(val);
      await setSetting('blacklist', next);
      alert(`Added ${val}`);
    } else if (cmd === 'remove' && val) {
      next = next.filter(x => x !== val);
      await setSetting('blacklist', next);
      alert(`Removed ${val}`);
    } else if (cmd === 'clear') {
      await setSetting('blacklist', []);
      alert('Cleared.');
    } else {
      alert(`Current blacklist:\n${current.join('\n') || '(empty)'}`);
    }
    updateIconVisibility();
  }

  async function updateIconVisibility() {
    const bl = await getSetting('blacklist', []);
    const host = siteHost();
    const hidden = bl.includes(host);
    if (toggleBtn) toggleBtn.classList.toggle('mui-hidden', hidden);
    if (fab) fab.classList.toggle('mui-hidden', hidden || !isGuiOpen); // keep consistent
    if (guiBox) guiBox.classList.toggle('mui-hidden', hidden || !isGuiOpen);
  }

  /** ================== TOGGLE / GUI BOOT ================== **/
  function toggleGUI() {
    isGuiOpen = !isGuiOpen;
    if (guiBox) guiBox.classList.toggle('mui-hidden', !isGuiOpen);
    if (fab) fab.classList.toggle('mui-hidden', !isGuiOpen);
  }

  function createGUI() {
    guiBox = document.createElement('div');
    guiBox.className = 'mui-box mui-hidden';
    document.body.appendChild(guiBox);
    displayRules();

    fab = document.createElement('button');
    fab.textContent = '+';
    fab.className = 'mui-fab mui-hidden';
    fab.addEventListener('click', addRule);
    document.body.appendChild(fab);

    toggleBtn = document.createElement('div');
    toggleBtn.className = 'mui-toggle';
    toggleBtn.textContent = '☰';
    toggleBtn.addEventListener('click', toggleGUI);
    document.body.appendChild(toggleBtn);
  }

  /** ================== STYLES ================== **/
  function applyMaterialYouStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .mui-box {
        position: fixed; top: 50%; left: 60px; transform: translateY(-50%);
        width: 320px; background: white; color: #000;