// ==UserScript==
// @name         Text Replacer
// @namespace    http://tampermonkey.net/
// @version      11.0.0
// @description  Fast, incremental text replacer. Indexed single-pass matcher + time-sliced DOM engine (no more page hangs), cross-element replacement (Range API), Multi-Term (|), Gap (---), Filter (#{...}#) and the new Echo operator (#word# --- #word#, e.g. "Bizzarro also known as Bizarro"). Sharded, self-healing IndexedDB <-> GM_storage sync with convergent tombstones (deletes stay deleted everywhere), LWW-synced blocklist/protected-areas/highlight settings, virtualized M3 UI, protected areas, dark/light theme, unified backup (fully backward compatible with older backups).
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

    function isExcludedContext() {
        try {
            const h = window.location.hostname;
            const full = h + window.location.pathname;
            if (full.includes('google.com/recaptcha') || h.includes('hcaptcha.com') || h.includes('cloudflare.com')) return true;
            if (document.title && (document.title.includes('Just a moment...') || document.title.includes('Attention Required!'))) return true;
            if (document.querySelector && document.querySelector('.cf-browser-verification, #cf-spinner-allow-5-secs, #challenge-running')) return true;
        } catch (e) {}
        return false;
    }
    if (isExcludedContext()) return;

    // =====================================================================
    // CONFIG
    // =====================================================================
    const DB_NAME = 'TextReplacerDB_v2';          // unchanged: existing rules/settings are picked up as-is
    const STORE_NAME = 'rules';
    const SETTINGS_STORE = 'settings';
    const DB_VERSION = 2;

    // Legacy GM keys (read for migration, some still mirrored for compatibility / fast early boot)
    const MASTER_KEY = 'TextReplacer_MASTER_v2';
    const ACTIVE_KEY = 'TextReplacer_ACTIVE_v2';
    const BLOCK_KEY = 'TextReplacer_BLOCK_GLOBAL';
    const UI_SCROLL_KEY = 'TextReplacer_UI_SCROLL_v2';
    const HIGHLIGHT_KEY = 'TextReplacer_HIGHLIGHT_v2';
    const STATS_KEY = 'TextReplacer_Stats_v2';
    const PROTECTED_KEY = 'TextReplacer_PROTECTED_SELECTORS';
    const TOMBSTONE_PURGE_CHECK_KEY = 'TextReplacer_LastTombstonePurge';

    // v3 sync layout: rules are sharded across SHARD_COUNT GM keys; each shard has a tiny "rev" token key
    const SHARD_COUNT = 16;
    const SHARD_PREFIX = 'TR3_S_';
    const REV_PREFIX = 'TR3_R_';
    const SETTINGS_GM_KEY = 'TR3_SETTINGS';
    const TOMB_GM_KEY = 'TR3_TOMBS';
    const ACTIVE_HOST_PREFIX = 'TR3_AH_';

    const SLICE_MS = 8;                         // max main-thread time per work slice
    const MUTATION_DEBOUNCE_MS = 80;
    const RULES_APPLY_DEBOUNCE_MS = 150;
    const PUBLISH_DEBOUNCE_MS = 500;
    const POLL_MS = 20000;
    const STATS_SAVE_DEBOUNCE = 60000;
    const SCROLL_SAVE_DEBOUNCE = 250;
    const CARD_HEIGHT = 88;
    const MAX_SEG_NODES = 1500;
    const EARLY_MAX_RULES = 400;
    const TOMBSTONE_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
    const TOMBSTONE_PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

    const DEFAULT_PROTECTED_SELECTORS = [
        'textarea', 'input[type="text"]', 'input[type="search"]', 'input[type="email"]', 'input[type="url"]',
        'input[type="number"]', '[contenteditable="true"]', '[role="textbox"]', '.comment-textarea', '.comment-box',
        '.review-text', '.editor', '#comment', '#review', '.input-message', '.message-input'
    ];

    // =====================================================================
    // SMALL HELPERS / GM STORAGE
    // =====================================================================
    function now() { return Date.now(); }
    function uuid() { return now().toString(36) + Math.random().toString(36).slice(2); }
    function bump(prev) { return Math.max(now(), (prev || 0) + 1); }
    function escapeHtml(s) { return (s || '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]); }
    function fnv1a(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
    function shardOf(id) { return fnv1a(String(id)) % SHARD_COUNT; }
    function yieldMain() { return new Promise(r => setTimeout(r, 0)); }

    function readGM(k, fb = null) { try { const r = GM_getValue(k, null); return r === null || r === undefined ? fb : (typeof r === 'string' ? JSON.parse(r) : r); } catch (e) { error('readGM failed for', k, e); return fb; } }
    function writeGM(k, v) { try { GM_setValue(k, JSON.stringify(v)); } catch (e) { error('writeGM failed for', k, e); } }

    const HOST = window.location.hostname;
    const IS_TOP = (function () { try { return window.top === window; } catch (e) { return false; } })();

    // =====================================================================
    // RULE STATS (smart priority / recency) - persisted rarely and merged, never blindly overwritten
    // =====================================================================
    const ruleStats = new Map();
    let statsSaveTimer = null, statsDirty = false;
    try {
        const obj = readGM(STATS_KEY, {}) || {};
        for (const [k, v] of Object.entries(obj)) ruleStats.set(k, { lastUsed: v.lastUsed || 0, matchCount: v.matchCount || 0 });
    } catch (e) { error('Failed to load stats', e); }

    function scheduleStatsSave() {
        statsDirty = true;
        if (!statsSaveTimer) statsSaveTimer = setTimeout(flushStats, STATS_SAVE_DEBOUNCE);
    }
    function flushStats() {
        if (statsSaveTimer) { clearTimeout(statsSaveTimer); statsSaveTimer = null; }
        if (!statsDirty) return;
        statsDirty = false;
        try {
            const stored = readGM(STATS_KEY, {}) || {};
            const merged = new Map();
            for (const [k, v] of Object.entries(stored)) merged.set(k, { lastUsed: v.lastUsed || 0, matchCount: v.matchCount || 0 });
            ruleStats.forEach((v, k) => {
                const o = merged.get(k);
                merged.set(k, o ? { lastUsed: Math.max(o.lastUsed, v.lastUsed), matchCount: Math.max(o.matchCount, v.matchCount) } : { lastUsed: v.lastUsed, matchCount: v.matchCount });
            });
            let entries = Array.from(merged.entries());
            if (allRules.size) entries = entries.filter(([k]) => { const r = allRules.get(k); return r && !r.deleted; });
            if (entries.length > 3000) { entries.sort((a, b) => b[1].lastUsed - a[1].lastUsed); entries = entries.slice(0, 3000); }
            const obj = {}; entries.forEach(([k, v]) => { obj[k] = v; });
            writeGM(STATS_KEY, obj);
        } catch (e) { error('Failed to save stats', e); }
    }

    // =====================================================================
    // MATCH ENGINE (pure logic - no DOM)
    // =====================================================================
    // <<ENGINE-BEGIN>>
    const ZW_CLASS = '[\\u200B-\\u200D\\uFEFF]';
    const ZW_TEST = /[\u200B-\u200D\uFEFF]/;
    const ZW_STRIP = /[\u200B-\u200D\uFEFF]/g;
    const APOS_CLASS = "['\u2019\u2018\u02BC]";
    const WORD_SRC = "[\\p{L}\\p{N}\\p{M}_]+(?:['\u2019\\-][\\p{L}\\p{N}\\p{M}_]+)*";
    const WORD_RUN = /\w+(?:[\u200B-\u200D\uFEFF]+\w+)*/g;     // ASCII word runs == positions where \b can hold
    const UNI_WORD = new RegExp(WORD_SRC, 'gu');                // unicode words (used by #word# operator)
    const MAX_GAP_CHARS = 300;     // upper bound for a plain "---" gap
    const LINK_GAP_MAX = 60;       // upper bound for the gap in an echo ("#word# --- #word#") rule
    const LINK_MIN_LEN = 2;        // echo words shorter than this are ignored
    const LINK_STOP = new Set(('a an and or but of to in on at by for with from as is it its be are was were he she we you they ' +
        'i me my his her our their this that these those the not no so if').split(' '));
    const ZERO_STATS = { lastUsed: 0, matchCount: 0 };

    function escapeRegExp(s) {
        if (s === "'" || s === '\u2019' || s === '\u2018' || s === '\u02BC') return APOS_CLASS;
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    function splitBranches(oldText) {
        return String(oldText || '').split(/\s*\|\s*/).map(s => s.trim()).filter(Boolean);
    }
    function literalToSource(chunk, zw) {
        const joiner = zw ? ZW_CLASS + '*' : '';
        return chunk.split(/\s+/).map(w => Array.from(w).map(escapeRegExp).join(joiner)).join('\\s+');
    }
    function textToSource(text, zw, gapMax) {
        return text.split(/\s*---\s*/).map(sp => literalToSource(sp, zw)).join('\\s+(.{0,' + gapMax + '}?)\\s+');
    }
    function firstChars(part, cs) {
        const c = String.fromCodePoint(part.codePointAt(0));
        if (c === "'" || c === '\u2019' || c === '\u2018' || c === '\u02BC') return ["'", '\u2019', '\u2018', '\u02BC'];
        const set = new Set([c]);
        if (!cs) { set.add(c.toLowerCase()); set.add(c.toUpperCase()); }
        return Array.from(set).filter(x => Array.from(x).length === 1);
    }

    // One "branch" = one alternative of a rule (rules can hold several, separated by |).
    function classifyBranch(rule, part) {
        if (/^\s*---/.test(part) || /---\s*$/.test(part)) return null;
        const nWords = (part.match(/#word#/gi) || []).length;
        const literalOnly = part.replace(/#word#/gi, '').replace(/---/g, '').replace(/\s+/g, '');
        if (nWords < 2 && !literalOnly) return null;
        const wc = part.split(/\s*---\s*/).join(' ').trim().split(/\s+/).filter(Boolean).length;
        const b = {
            rule, part, cs: !!rule.caseSensitive, nWords, kind: nWords >= 2 ? 'linked' : 'plain',
            wc, plen: part.length, minChars: Math.max(1, literalOnly.length + nWords),
            pre: /^[\w'\u2019]/.test(part) ? '\\b' : '', post: /[\w'\u2019]$/.test(part) ? '\\b' : '',
            start: 'word', key: '', chars: null,
            rxN: null, rxZ: null, gapIdx: 0, wordIdx: 0,
            rxA: null, midFull: null, rxS: null, maxSpan: 0,
            dead: false, err: ''
        };
        if (/^#word#/i.test(part)) b.start = 'wild';
        else if (/^\w/.test(part)) { b.start = 'word'; b.key = part.match(/^\w+/)[0].toLowerCase(); }
        else { b.start = 'char'; b.chars = firstChars(part, b.cs); }
        return b;
    }

    function buildPlainSource(b, zw) {
        const segs = b.part.split(/#word#/i);
        if (segs.length === 1) {
            b.gapIdx = /---/.test(b.part) ? 1 : 0; b.wordIdx = 0;
            return textToSource(b.part, zw, MAX_GAP_CHARS);
        }
        const k0 = segs[0].split(/\s*---\s*/).length - 1;
        const k1 = segs[1].split(/\s*---\s*/).length - 1;
        b.wordIdx = k0 + 1;
        b.gapIdx = k0 > 0 ? 1 : (k1 > 0 ? k0 + 2 : 0);
        return textToSource(segs[0], zw, MAX_GAP_CHARS) + '(' + WORD_SRC + ')' + textToSource(segs[1], zw, MAX_GAP_CHARS);
    }
    // Regexes are compiled lazily (only when a branch's first word/char actually shows up in text),
    // so building the matcher for thousands of rules is nearly free.
    function getPlainRx(b, zw) {
        if (b.dead) return null;
        let rx = zw ? b.rxZ : b.rxN;
        if (rx) return rx;
        try {
            rx = new RegExp(b.pre + buildPlainSource(b, zw) + b.post, (b.cs ? '' : 'i') + 'uy');
        } catch (e) { b.dead = true; b.err = String((e && e.message) || e); return null; }
        if (zw) b.rxZ = rx; else b.rxN = rx;
        return rx;
    }
    function compileLinked(b) {
        if (b.rxA) return b.rxA;
        if (b.dead) return null;
        try {
            const flags = (b.cs ? '' : 'i') + 'u';
            const segs = b.part.split(/#word#/i);
            const n = segs.length - 1;
            if (/---/.test(segs[0]) || /---/.test(segs[n])) throw new Error('"---" is only allowed between the first and last #word#');
            if (n === 2 && !segs[1].trim()) throw new Error('Put something (text or ---) between the two #word# markers');
            const prefix = textToSource(segs[0], false, LINK_GAP_MAX);
            const mid = segs.slice(1, n).map(s => textToSource(s, false, LINK_GAP_MAX)).join('(?:' + WORD_SRC + ')');
            const suffix = segs[n].trim() ? textToSource(segs[n], false, LINK_GAP_MAX) + b.post : '';
            b.rxA = new RegExp(b.pre + prefix + '(' + WORD_SRC + ')', flags + 'y');
            b.midFull = new RegExp('^' + mid + '$', flags);
            b.rxS = suffix ? new RegExp(suffix, flags + 'y') : null;
            b.maxSpan = segs.slice(1, n).join('').length + LINK_GAP_MAX + 40;
        } catch (e) { b.dead = true; b.err = String((e && e.message) || e); b.rxA = null; return null; }
        return b.rxA;
    }

    function buildMatcher(rules) {
        const wordIndex = new Map(), charIndex = new Map(), wild = [];
        let minLen = Infinity, count = 0;
        for (const rule of rules) {
            if (!rule || rule.deleted || rule.enabled === false || !rule.oldText) continue;
            for (const part of splitBranches(rule.oldText)) {
                const b = classifyBranch(rule, part);
                if (!b) continue;
                count++;
                if (b.minChars < minLen) minLen = b.minChars;
                if (b.start === 'word') { let l = wordIndex.get(b.key); if (!l) wordIndex.set(b.key, l = []); l.push(b); }
                else if (b.start === 'char') { for (const ch of b.chars) { let l = charIndex.get(ch); if (!l) charIndex.set(ch, l = []); l.push(b); } }
                else wild.push(b);
            }
        }
        const byPrio = (x, y) => (y.wc - x.wc) || (y.plen - x.plen);
        wordIndex.forEach(l => { if (l.length > 1) l.sort(byPrio); });
        charIndex.forEach(l => { if (l.length > 1) l.sort(byPrio); });
        wild.sort(byPrio);
        let charScan = null;
        if (charIndex.size) {
            const cls = Array.from(charIndex.keys()).map(ch => '\\u{' + ch.codePointAt(0).toString(16) + '}').join('');
            charScan = new RegExp('[' + cls + ']', 'gu');
        }
        return { wordIndex, charIndex, charScan, wild, minLen: isFinite(minLen) ? minLen : 1, count };
    }

    // ----- echo operator helpers -----
    function foldWord(w) { return w.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/['\u2019\u2018\u02BC\-_]/g, ''); }
    function collapseRepeats(s) { return s.replace(/(.)\1+/g, '$1'); }
    function withinOneEdit(a, b) {
        const la = a.length, lb = b.length;
        if (Math.abs(la - lb) > 1) return false;
        let i = 0, j = 0, edits = 0;
        while (i < la && j < lb) {
            if (a[i] === b[j]) { i++; j++; continue; }
            if (++edits > 1) return false;
            if (la > lb) i++; else if (lb > la) j++; else { i++; j++; }
        }
        return edits + (la - i) + (lb - j) <= 1;
    }
    // "Same word" for the echo operator: identical, or differing only by case / accents / doubled letters
    // ("Bizzarro" ~ "Bizarro") / a single typo in longer words.
    function wordsEquivalent(a, b) {
        if (a === b) return true;
        const fa = foldWord(a), fb = foldWord(b);
        if (!fa || !fb) return false;
        if (fa === fb) return true;
        if (fa[0] !== fb[0]) return false;
        const ca = collapseRepeats(fa), cb = collapseRepeats(fb);
        if (ca === cb) return true;
        return Math.min(ca.length, cb.length) >= 5 && withinOneEdit(ca, cb);
    }
    function lowerBound(arr, x) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; }

    const CTX = { text: '', toks: null };
    function getTokens() {
        if (CTX.toks) return CTX.toks;
        const s = [], e = [], text = CTX.text;
        UNI_WORD.lastIndex = 0;
        let m;
        while ((m = UNI_WORD.exec(text)) !== null) { s.push(m.index); e.push(m.index + m[0].length); }
        return (CTX.toks = { s, e });
    }

    function matchLinked(b, pos, text) {
        const rxA = compileLinked(b);
        if (!rxA) return null;
        rxA.lastIndex = pos;
        const ma = rxA.exec(text);
        if (!ma) return null;
        const w1 = ma[1];
        if (w1.length < LINK_MIN_LEN || LINK_STOP.has(w1.toLowerCase())) return null;
        const e1 = pos + ma[0].length;
        const toks = getTokens();
        const limit = e1 + b.maxSpan;
        for (let j = lowerBound(toks.s, e1); j < toks.s.length && toks.s[j] <= limit; j++) {
            const s2 = toks.s[j], e2 = toks.e[j];
            const w2 = text.slice(s2, e2);
            if (!wordsEquivalent(w1, w2)) continue;
            const mm = b.midFull.exec(text.slice(e1, s2));
            if (!mm) continue;
            let end = e2;
            if (b.rxS) { b.rxS.lastIndex = e2; const ms = b.rxS.exec(text); if (!ms) continue; end = e2 + ms[0].length; }
            return { start: pos, end, b, gap: mm[1] || '', w1, w2 };
        }
        return null;
    }

    function tryBranches(list, pos, text, zw, offset, out) {
        for (let i = 0; i < list.length; i++) {
            const b = list[i];
            if (b.dead) continue;
            if (b.kind === 'plain') {
                const rx = getPlainRx(b, zw);
                if (!rx) continue;
                rx.lastIndex = pos;
                const m = rx.exec(text);
                if (m && m[0].length > 0) {
                    out.push({ start: pos + offset, end: pos + m[0].length + offset, b,
                        gap: b.gapIdx ? (m[b.gapIdx] || '') : '', w1: b.wordIdx ? (m[b.wordIdx] || '') : '', w2: '' });
                }
            } else {
                const c = matchLinked(b, pos, text);
                if (c) { c.start += offset; c.end += offset; out.push(c); }
            }
        }
    }

    // Finds every candidate match of every rule in `text` (positions shifted by `offset`).
    // Cost is O(text) + a handful of anchored regex attempts at word starts that exist in the rule index.
    function collectCands(M, text, offset, out) {
        if (text.length < M.minLen) return;
        CTX.text = text; CTX.toks = null;
        const zw = ZW_TEST.test(text);
        if (M.wordIndex.size) {
            WORD_RUN.lastIndex = 0;
            let m;
            while ((m = WORD_RUN.exec(text)) !== null) {
                const tok = zw ? m[0].replace(ZW_STRIP, '') : m[0];
                const list = M.wordIndex.get(tok.toLowerCase());
                if (list) tryBranches(list, m.index, text, zw, offset, out);
            }
        }
        if (M.charScan) {
            M.charScan.lastIndex = 0;
            let m;
            while ((m = M.charScan.exec(text)) !== null) {
                const list = M.charIndex.get(m[0]);
                if (list) tryBranches(list, m.index, text, zw, offset, out);
            }
        }
        if (M.wild.length) {
            const t = getTokens();
            for (let i = 0; i < t.s.length; i++) tryBranches(M.wild, t.s[i], text, zw, offset, out);
        }
    }

    // Overlapping candidates: the more specific rule (more words, then longer pattern, then smart-priority
    // recency, then leftmost) claims the span; whatever overlaps an already-claimed span is dropped.
    function cmpCand(a, b) {
        const x = a.b, y = b.b;
        if (y.wc !== x.wc) return y.wc - x.wc;
        if (y.plen !== x.plen) return y.plen - x.plen;
        const as = !!x.rule.smartPriority, bs = !!y.rule.smartPriority;
        if (as !== bs) return as ? -1 : 1;
        if (as) {
            const sa = ruleStats.get(x.rule.id) || ZERO_STATS, sb = ruleStats.get(y.rule.id) || ZERO_STATS;
            if (sa.lastUsed !== sb.lastUsed) return sb.lastUsed - sa.lastUsed;
            if (sa.matchCount !== sb.matchCount) return sb.matchCount - sa.matchCount;
        }
        if (a.start !== b.start) return a.start - b.start;
        return x.rule.id < y.rule.id ? -1 : (x.rule.id > y.rule.id ? 1 : 0);
    }
    function resolveCands(cands) {
        if (cands.length <= 1) return cands;
        cands.sort(cmpCand);
        const kept = [];
        for (const c of cands) {
            let lo = 0, hi = kept.length;
            while (lo < hi) { const mid = (lo + hi) >> 1; if (kept[mid].start < c.start) lo = mid + 1; else hi = mid; }
            if (lo > 0 && kept[lo - 1].end > c.start) continue;
            if (lo < kept.length && kept[lo].start < c.end) continue;
            kept.splice(lo, 0, c);
        }
        return kept;
    }

    // Replacement text: "---" = captured gap, #{a,b}# = words removed from the gap,
    // #word# / #word1# = first captured word, #word2# = the echoed word.
    function buildReplacement(c) {
        const rule = c.b.rule;
        let out = rule.newText || '';
        let gapText = c.gap || '';
        const filterMatch = out.match(/#\{(.*?)\}#/);
        if (filterMatch) {
            filterMatch[1].split(',').map(s => s.trim().toLowerCase()).filter(Boolean).forEach(w => {
                gapText = gapText.replace(new RegExp('\\b' + escapeRegExp(w) + '\\b', 'gi'), '').replace(/\s{2,}/g, ' ').trim();
            });
            out = out.replace(filterMatch[0], '');
        }
        const usesWord = /#word[12]?#/i.test(out);
        if (out.includes('---')) out = out.replace('---', () => gapText);
        else if (c.gap && !usesWord && c.b.kind !== 'linked') out += ' ' + gapText;
        if (usesWord) out = out.replace(/#word([12])?#/gi, (_, n) => (n === '2' ? (c.w2 || c.w1) : c.w1));
        return out.trim();
    }

    function validateOldText(text, caseSensitive) {
        const parts = splitBranches(text);
        if (!parts.length) return 'The original text is empty.';
        for (const part of parts) {
            const b = classifyBranch({ id: 'v', oldText: part, caseSensitive: !!caseSensitive }, part);
            if (!b) return 'Invalid pattern "' + part + '": a branch cannot start/end with --- or consist only of #word#.';
            if (b.kind === 'linked') { if (!compileLinked(b)) return 'Invalid pattern "' + part + '": ' + b.err; }
            else if (!getPlainRx(b, false)) return 'Invalid pattern "' + part + '": ' + b.err;
        }
        return null;
    }
    // <<ENGINE-END>>

    // =====================================================================
    // STATE
    // =====================================================================
    let dbPromise = null, dbInstance = null, idbOk = true;
    const allRules = new Map();       // id -> record (alive AND tombstones); the single in-memory source of truth
    const sigIndex = new Map();       // content signature -> Set(ids)
    let rulesVersion = 0, aliveCache = null, aliveCacheVer = -1;
    let applyFlags = { added: false, removed: false };
    const persistDirty = new Set();
    let persistTimer = null;

    let matcher = null;
    let engineActive = false;
    let mo = null;
    let enableHighlight = true, siteThemeColor = '#6750A4';
    let blockedDomains = [], protectedSelectors = DEFAULT_PROTECTED_SELECTORS.slice();
    let settingsDoc = null, lastSettingsRaw = '', hadEarlyList = false;
    const matchedIds = new Set();
    let activeDirty = false;

    let guiBox = null, mainPage = null, settingsPage = null, dialogWrapper = null;
    let listContainer = null, virtualScroller = null, quickEditBox = null, selectionFab = null;
    let isGuiOpen = false, isNavigating = false, isRenderingScroll = false;
    let scrollSaveTimer = null, quickEditActiveId = null, searchQuery = '', externalIhwAPI = null;
    let rulesApplyTimer = null, guiUpdateTimer = null;
    let trIdCounter = 0;
    const repData = new WeakMap();    // replacement <span> -> { orig, ruleId, ver }

    // ---------- protected areas / exclusion ----------
    const ALWAYS_EXCLUDE = ['script', 'style', 'noscript', 'textarea', 'input', 'iframe', 'code', 'pre', 'template', 'canvas',
        'object', 'embed', 'head', 'svg', 'math', '[contenteditable]:not([contenteditable="false"])',
        '#text-replacer-gui', '#tr-quick-edit', '#tr-dialog-wrapper', '#tr-selection-fab', '.mui-toggle', '.tr-replaced', '.tr-replaced-hidden'];
    const OWN_UI_SELECTOR = '#text-replacer-gui,#tr-quick-edit,#tr-dialog-wrapper,#tr-selection-fab,.mui-toggle,.tr-replaced,.tr-replaced-hidden';
    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'IFRAME', 'CODE', 'PRE', 'TEMPLATE', 'CANVAS', 'OBJECT', 'EMBED', 'HEAD']);
    const BLOCK_TAGS = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BODY', 'BUTTON', 'CAPTION', 'CENTER', 'DD', 'DETAILS', 'DIALOG', 'DIV',
        'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HGROUP', 'HR', 'HTML',
        'LEGEND', 'LI', 'MAIN', 'MENU', 'NAV', 'OL', 'OPTGROUP', 'OPTION', 'P', 'SECTION', 'SELECT', 'SUMMARY', 'TABLE', 'TBODY', 'TD', 'TFOOT',
        'TH', 'THEAD', 'TR', 'UL']);
    let excludeSelector = ALWAYS_EXCLUDE.join(',');

    function isValidSelector(sel) {
        try { document.createDocumentFragment().querySelector(sel); return true; } catch (e) { return false; }
    }
    // Invalid user selectors are dropped here instead of making every closest()/querySelectorAll() throw.
    function updateProtectedSelectorString() {
        excludeSelector = ALWAYS_EXCLUDE.concat((protectedSelectors || []).filter(s => typeof s === 'string' && s.trim() && isValidSelector(s))).join(',');
    }
    function isOwnUi(node) {
        const el = node.nodeType === 1 ? node : node.parentElement;
        return !!(el && el.closest && el.closest(OWN_UI_SELECTOR));
    }

    // =====================================================================
    // IN-MEMORY RULE STORE
    // =====================================================================
    function signatureOf(r) { return `${r.oldText}:::${r.newText}:::${!!r.caseSensitive}:::${!!r.forceGlobal}:::${!!r.smartPriority}`; }
    function sigAdd(sig, id) { let s = sigIndex.get(sig); if (!s) sigIndex.set(sig, s = new Set()); s.add(id); }
    function sigRemove(sig, id) { const s = sigIndex.get(sig); if (s) { s.delete(id); if (!s.size) sigIndex.delete(sig); } }
    function peerRecords(sig) { const s = sigIndex.get(sig); return s ? Array.from(s).map(id => allRules.get(id)).filter(Boolean) : []; }

    function normalizeRecord(r, defaultTs) {
        if (!r || typeof r !== 'object' || typeof r.oldText !== 'string' || !r.oldText) return null;
        const ts = defaultTs === undefined ? now() : defaultTs;
        return {
            id: r.id ? String(r.id) : uuid(), oldText: r.oldText, newText: typeof r.newText === 'string' ? r.newText : '',
            caseSensitive: !!r.caseSensitive, forceGlobal: !!r.forceGlobal, smartPriority: !!r.smartPriority,
            enabled: r.enabled !== false, deleted: !!r.deleted,
            createdAt: +r.createdAt || ts, updatedAt: +r.updatedAt || ts, site: r.site || null
        };
    }
    function aliveRules() {
        if (aliveCacheVer !== rulesVersion) {
            aliveCache = [];
            allRules.forEach(r => { if (!r.deleted) aliveCache.push(r); });
            aliveCacheVer = rulesVersion;
        }
        return aliveCache;
    }
    function insertLoaded(r) {
        const prev = allRules.get(r.id);
        if (prev) sigRemove(signatureOf(prev), prev.id);
        allRules.set(r.id, r);
        sigAdd(signatureOf(r), r.id);
    }
    const tombDirty = new Map();
    let tombTimer = null;
    function putRecord(rec) {
        insertLoaded(rec);
        persistDirty.add(rec.id);
        rulesVersion++;
        if (rec.deleted || rec.enabled === false) applyFlags.removed = true; else applyFlags.added = true;
        if (rec.deleted) { tombDirty.set(rec.id, rec.updatedAt); if (!tombTimer) tombTimer = setTimeout(flushTombMirror, 1500); }
        schedulePersist();
    }
    function flushTombMirror() {
        tombTimer = null;
        if (!tombDirty.size) return;
        try {
            const cur = readGM(TOMB_GM_KEY, {}) || {};
            const cutoff = now() - TOMBSTONE_RETENTION_MS;
            tombDirty.forEach((ts, id) => { if (!cur[id] || cur[id] < ts) cur[id] = ts; });
            tombDirty.clear();
            let entries = Object.entries(cur).filter(([, ts]) => ts >= cutoff);
            if (entries.length > 4000) { entries.sort((a, b) => b[1] - a[1]); entries = entries.slice(0, 4000); }
            writeGM(TOMB_GM_KEY, Object.fromEntries(entries));
        } catch (e) { error('flushTombMirror failed', e); }
    }
    function compareVersions(a, b) {
        if (a.updatedAt !== b.updatedAt) return a.updatedAt - b.updatedAt;
        if (a.deleted === b.deleted) return 0;
        return a.deleted ? 1 : -1;     // equal timestamps: a delete beats a live copy (deterministic everywhere)
    }
    function isNewer(a, b) { return compareVersions(a, b) > 0; }

    // The merge that makes deletes global and sync convergent. Pure LWW per rule id, plus content-level
    // rules so that alias copies (same term created independently under different ids) can neither survive
    // nor resurrect a deleted term. Returns which ids changed locally and which local records are *ahead*
    // of the incoming data (those must be re-published so every site converges).
    function mergeIncoming(records) {
        const changed = [], ahead = new Set();
        for (const raw of records) {
            const r = normalizeRecord(raw, 1);
            if (!r) continue;
            const local = allRules.get(r.id);
            if (local) {
                const c = compareVersions(r, local);
                if (c > 0) { putRecord(r); changed.push(r.id); }
                else if (c < 0) ahead.add(r.id);
                continue;
            }
            const peers = peerRecords(signatureOf(r));
            if (r.deleted) {
                putRecord(r); changed.push(r.id);
                for (const p of peers) {   // deleting a term also removes alias copies of it that are not newer
                    if (!p.deleted && p.updatedAt <= r.updatedAt) { putRecord({ ...p, deleted: true, updatedAt: r.updatedAt }); changed.push(p.id); ahead.add(p.id); }
                }
                continue;
            }
            if (peers.some(p => p.deleted && p.updatedAt > r.updatedAt)) {   // this exact term was deleted after this version
                putRecord({ ...r, deleted: true }); changed.push(r.id); ahead.add(r.id);
                continue;
            }
            const alive = peers.filter(p => !p.deleted);
            if (alive.length) {              // duplicate content under another id: keep exactly one, deterministically
                const all = alive.concat(r).sort((a, b) => (b.updatedAt - a.updatedAt) || (a.id < b.id ? -1 : 1));
                const winner = all[0];
                for (const rec of all) {
                    if (rec === winner) { if (rec === r) { putRecord(r); changed.push(r.id); } continue; }
                    putRecord({ ...rec, deleted: true }); changed.push(rec.id); ahead.add(rec.id);
                }
                continue;
            }
            putRecord(r); changed.push(r.id);
        }
        return { changed, ahead: Array.from(ahead) };
    }

    // =====================================================================
    // IndexedDB (write-through cache target; the in-memory Map is what the engine uses)
    // =====================================================================
    function openDB() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB unavailable'));
            let req;
            try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { return reject(e); }
            req.onerror = () => reject(req.error || new Error('IDB error'));
            req.onblocked = () => { error('IndexedDB upgrade blocked by another open tab on this site; close other tabs and reload.'); };
            req.onsuccess = (e) => {
                dbInstance = e.target.result;
                dbInstance.onversionchange = () => { try { dbInstance.close(); } catch (err) {} dbInstance = null; dbPromise = null; };
                resolve(dbInstance);
            };
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'id' });
                if (!db.objectStoreNames.contains(SETTINGS_STORE)) db.createObjectStore(SETTINGS_STORE, { keyPath: 'key' });
            };
        });
        dbPromise.catch(() => { dbPromise = null; });
        return dbPromise;
    }
    async function dbGetAll() {
        const db = await openDB();
        return new Promise((res, rej) => {
            const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
            req.onsuccess = () => res(req.result || []); req.onerror = () => rej(req.error);
        });
    }
    function txOpen(db, store, mode) {
        try { return db.transaction(store, mode, { durability: 'relaxed' }); } catch (e) { return db.transaction(store, mode); }
    }
    async function dbBulkPut(recs) {
        if (!recs.length) return;
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = txOpen(db, STORE_NAME, 'readwrite');
            const st = tx.objectStore(STORE_NAME);
            for (const r of recs) st.put(r);
            tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('IDB tx aborted'));
        });
    }
    async function dbBulkDelete(ids) {
        if (!ids.length) return;
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = txOpen(db, STORE_NAME, 'readwrite');
            const st = tx.objectStore(STORE_NAME);
            for (const id of ids) st.delete(id);
            tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('IDB tx aborted'));
        });
    }
    async function dbGetSetting(key, fallback) {
        try {
            const db = await openDB();
            return await new Promise((resolve) => {
                const req = db.transaction(SETTINGS_STORE, 'readonly').objectStore(SETTINGS_STORE).get(key);
                req.onsuccess = () => resolve(req.result ? req.result.value : fallback);
                req.onerror = () => resolve(fallback);
            });
        } catch (e) { return fallback; }
    }
    async function dbSetSetting(key, value) {
        try {
            const db = await openDB();
            return await new Promise((resolve) => {
                const req = db.transaction(SETTINGS_STORE, 'readwrite').objectStore(SETTINGS_STORE).put({ key, value });
                req.onsuccess = () => resolve(); req.onerror = () => resolve();
            });
        } catch (e) { /* IDB unavailable: GM storage is still the source of truth */ }
    }
    function schedulePersist(ms = 150) { if (!persistTimer) persistTimer = setTimeout(() => { persistTimer = null; flushPersist(); }, ms); }
    async function flushPersist() {
        if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
        if (!persistDirty.size || !idbOk) { persistDirty.clear(); return; }
        const ids = Array.from(persistDirty); persistDirty.clear();
        try { await dbBulkPut(ids.map(id => allRules.get(id)).filter(Boolean)); }
        catch (e) { error('IDB persist failed (will retry)', e); ids.forEach(id => persistDirty.add(id)); schedulePersist(2000); }
    }
    async function loadRulesFromIdb() {
        let rows = [];
        try { rows = await dbGetAll(); } catch (e) { idbOk = false; error('IndexedDB unavailable; running from GM storage only.', e); }
        for (const raw of rows) { const r = normalizeRecord(raw, 1); if (r && raw.id) insertLoaded(r); }
        rulesVersion++;
    }
    async function purgeOldTombstonesIfDue() {
        try {
            const last = readGM(TOMBSTONE_PURGE_CHECK_KEY, 0);
            if (now() - last < TOMBSTONE_PURGE_INTERVAL_MS) return;
            writeGM(TOMBSTONE_PURGE_CHECK_KEY, now());
            const cutoff = now() - TOMBSTONE_RETENTION_MS;
            const stale = [];
            allRules.forEach((r, id) => { if (r.deleted && r.updatedAt < cutoff) stale.push(id); });
            if (!stale.length) return;
            for (const id of stale) { const r = allRules.get(id); sigRemove(signatureOf(r), id); allRules.delete(id); }
            rulesVersion++;
            if (idbOk) await dbBulkDelete(stale);
            log(`Purged ${stale.length} old tombstoned rule(s).`);
        } catch (e) { error('purgeOldTombstonesIfDue failed', e); }
    }

    // =====================================================================
    // SETTINGS (blocklist / protected selectors / highlight) - per-entry last-write-wins, synced globally
    // =====================================================================
    function defaultSettingsDoc() {
        const prot = {}; DEFAULT_PROTECTED_SELECTORS.forEach(s => { prot[s] = { b: 1, t: 1 }; });
        return { blocked: {}, prot, hl: { v: true, t: 0 } };
    }
    function normalizeSettingsDoc(d) {
        const out = { blocked: {}, prot: {}, hl: { v: true, t: 0 } };
        if (!d || typeof d !== 'object') return out;
        for (const key of ['blocked', 'prot']) {
            const src = d[key];
            if (src && typeof src === 'object') for (const [k, e] of Object.entries(src)) { if (e && typeof e === 'object') out[key][k] = { b: e.b ? 1 : 0, t: +e.t || 0 }; }
        }
        if (d.hl && typeof d.hl === 'object') out.hl = { v: d.hl.v !== false, t: +d.hl.t || 0 };
        return out;
    }
    function entryWins(inc, cur) { return !cur || inc.t > cur.t || (inc.t === cur.t && !inc.b && !!cur.b); }
    function mergeSettingsDoc(inc) {
        let changed = false, ahead = false;
        for (const key of ['blocked', 'prot']) {
            const target = settingsDoc[key], src = inc[key];
            for (const [k, e] of Object.entries(src)) {
                const cur = target[k];
                if (entryWins(e, cur)) { if (!cur || cur.b !== e.b || cur.t !== e.t) changed = true; target[k] = e; }
                else if (cur && entryWins(cur, e)) ahead = true;
            }
            for (const k of Object.keys(target)) if (!(k in src)) ahead = true;
        }
        if (inc.hl.t > settingsDoc.hl.t) { settingsDoc.hl = inc.hl; changed = true; } else if (settingsDoc.hl.t > inc.hl.t) ahead = true;
        return { changed, ahead };
    }
    let lastMirrorSig = '';
    function deriveSettings() {
        blockedDomains = Object.keys(settingsDoc.blocked).filter(k => settingsDoc.blocked[k].b);
        protectedSelectors = Object.keys(settingsDoc.prot).filter(k => settingsDoc.prot[k].b);
        enableHighlight = settingsDoc.hl.v !== false;
        updateProtectedSelectorString();
        const sig = JSON.stringify([blockedDomains, protectedSelectors, enableHighlight]);
        if (sig !== lastMirrorSig) {   // flat mirrors: read synchronously at document-start and by older script versions
            lastMirrorSig = sig;
            writeGM(BLOCK_KEY, blockedDomains); writeGM(PROTECTED_KEY, protectedSelectors); writeGM(HIGHLIGHT_KEY, enableHighlight);
        }
    }
    function publishSettings() {
        try {
            const remote = readGM(SETTINGS_GM_KEY, null);
            if (remote) { const r = mergeSettingsDoc(normalizeSettingsDoc(remote)); if (r.changed) { deriveSettings(); onSettingsChanged(); } }
            const s = JSON.stringify(settingsDoc);
            lastSettingsRaw = s;
            GM_setValue(SETTINGS_GM_KEY, s);
        } catch (e) { error('publishSettings failed', e); }
    }
    function commitSettings() {
        deriveSettings();
        onSettingsChanged();
        dbSetSetting('settingsDoc', settingsDoc);
        publishSettings();
    }
    function setBlocked(domain, on) { const cur = settingsDoc.blocked[domain]; settingsDoc.blocked[domain] = { b: on ? 1 : 0, t: bump(cur && cur.t) }; commitSettings(); }
    function setProtected(sel, on) { const cur = settingsDoc.prot[sel]; settingsDoc.prot[sel] = { b: on ? 1 : 0, t: bump(cur && cur.t) }; commitSettings(); }
    function setHighlight(v) { settingsDoc.hl = { v: !!v, t: bump(settingsDoc.hl.t) }; commitSettings(); }

    async function loadSettings() {
        try {
            settingsDoc = defaultSettingsDoc(); settingsDoc.prot = {}; settingsDoc.hl = { v: true, t: 0 };
            const idbDoc = await dbGetSetting('settingsDoc', null);
            const gmDoc = readGM(SETTINGS_GM_KEY, null);
            if (idbDoc) mergeSettingsDoc(normalizeSettingsDoc(idbDoc));
            if (gmDoc) mergeSettingsDoc(normalizeSettingsDoc(gmDoc));
            if (!idbDoc) {
                // First run of this version on this site: fold in the pre-v11 arrays (stamped t=1, so any real
                // add/remove - which is stamped "now" - always wins over them).
                const legacy = { blocked: {}, prot: {}, hl: { v: true, t: 0 } };
                const lb = [].concat(await dbGetSetting('blockedDomains', []) || [], readGM('TextReplacer_BLOCK_v2', []) || [], readGM(BLOCK_KEY, []) || []);
                lb.forEach(d => { if (typeof d === 'string' && d) legacy.blocked[d] = { b: 1, t: 1 }; });
                const lp = await dbGetSetting('protectedSelectors', null);
                const lpg = readGM(PROTECTED_KEY, null);
                const protList = Array.isArray(lp) ? lp : (Array.isArray(lpg) ? lpg : DEFAULT_PROTECTED_SELECTORS);
                protList.forEach(s => { if (typeof s === 'string' && s) legacy.prot[s] = { b: 1, t: 1 }; });
                if (!gmDoc) {
                    const lh = await dbGetSetting('enableHighlight', null);
                    const lhg = readGM(HIGHLIGHT_KEY, true);
                    legacy.hl = { v: (lh === null ? lhg : lh) !== false, t: 1 };
                }
                mergeSettingsDoc(legacy);
            }
            deriveSettings();
            await dbSetSetting('settingsDoc', settingsDoc);
            publishSettings();
            registerSettingsListener();
        } catch (e) { error('loadSettings failed', e); if (!settingsDoc) { settingsDoc = defaultSettingsDoc(); deriveSettings(); } }
        extractThemeColor();
    }
    function onRemoteSettings(raw) {
        try {
            if (!raw || raw === lastSettingsRaw) return;
            const doc = normalizeSettingsDoc(typeof raw === 'string' ? JSON.parse(raw) : raw);
            const r = mergeSettingsDoc(doc);
            if (r.changed) { deriveSettings(); onSettingsChanged(); dbSetSetting('settingsDoc', settingsDoc); if (isGuiOpen && settingsPage && settingsPage.classList.contains('active')) showSettings(); }
            if (r.ahead) publishSettings(); else lastSettingsRaw = typeof raw === 'string' ? raw : JSON.stringify(raw);
        } catch (e) { error('onRemoteSettings failed', e); }
    }
    let settingsListenerOn = false;
    function registerSettingsListener() {
        if (settingsListenerOn || typeof GM_addValueChangeListener !== 'function') return;
        settingsListenerOn = true;
        try { GM_addValueChangeListener(SETTINGS_GM_KEY, (n, o, nv, remote) => { if (remote === false) return; onRemoteSettings(nv); }); }
        catch (e) { error('settings listener failed', e); }
    }
    function onSettingsChanged() {
        applyHighlightClasses();
        applyBlockState();
    }
    function applyHighlightClasses() {
        try {
            const cls = enableHighlight ? 'tr-replaced' : 'tr-replaced-hidden';
            document.querySelectorAll('.tr-replaced, .tr-replaced-hidden').forEach(el => { if (el.className !== cls) el.className = cls; });
        } catch (e) {}
    }
    function applyBlockState() {
        const blocked = blockedDomains.includes(HOST);
        if (blocked) {
            if (engineActive || mo) { engineActive = false; cancelAllJobs(); stopObserver(); jobQueue.push({ kind: 'revert', all: true }); schedulePump(); }
            engineActive = false;
        } else if (!engineActive && bootstrapped) {
            engineActive = true; startObserver(); scheduleRulesApply(0);
        }
    }

    // =====================================================================
    // GLOBAL SYNC: IndexedDB (per-site, big) <-> GM_storage (shared by every site)
    // =====================================================================
    // Layout: rules live in SHARD_COUNT GM keys (TR3_S_k) so a change rewrites ~1/16 of the data instead of
    // the whole database, and each shard has a tiny rev token key (TR3_R_k) that sites watch / poll cheaply.
    // Every publish is "pull-then-push" per shard, every pull re-publishes anything this site holds that is
    // newer or missing (anti-entropy), and a verify step re-checks the shard a moment after writing, so a lost
    // write between racing tabs heals itself instead of leaving sites permanently diverged.
    const sync = { seen: {}, pending: new Set(), pubTimer: null, publishing: false, pullTimers: {}, lastOkAt: 0, lastErr: '',
        attempts: 0, verifyTimer: null, seenTimer: null, pendTimer: null, v3Pending: false, started: false };

    function readShard(k) {
        const raw = readGM(SHARD_PREFIX + k, null);
        const map = new Map();
        if (raw && Array.isArray(raw.rules)) for (const x of raw.rules) { const n = normalizeRecord(x, 1); if (n) map.set(n.id, n); }
        return { rev: raw && raw.rev ? raw.rev : null, map };
    }
    function writeShard(k, map) {
        const rev = now().toString(36) + Math.random().toString(36).slice(2, 8);
        const cutoff = now() - TOMBSTONE_RETENTION_MS;
        const arr = [];
        map.forEach(r => { if (r.deleted && r.updatedAt < cutoff) return; arr.push(r); });
        sync.seen[k] = rev;                                   // set first: our own change event must not trigger a pull
        writeGM(SHARD_PREFIX + k, { rev, ts: now(), rules: arr });
        GM_setValue(REV_PREFIX + k, rev);
        scheduleSeenPersist();
    }
    function scheduleSeenPersist() { if (!sync.seenTimer) sync.seenTimer = setTimeout(() => { sync.seenTimer = null; dbSetSetting('seenRevs', sync.seen); }, 800); }
    function scheduleSavePending() { if (!sync.pendTimer) sync.pendTimer = setTimeout(() => { sync.pendTimer = null; dbSetSetting('pendingPublish', Array.from(sync.pending)); }, 600); }
    function addPending(ids) {
        let n = 0;
        for (const id of ids) if (!sync.pending.has(id)) { sync.pending.add(id); n++; }
        if (n) scheduleSavePending();
    }
    function schedulePublish(delay) {
        if (sync.pubTimer) return;
        sync.pubTimer = setTimeout(() => { sync.pubTimer = null; publishPending(); }, (delay === undefined ? PUBLISH_DEBOUNCE_MS : delay) + Math.floor(Math.random() * 200));
    }
    function afterMerge(res, skipShard) {
        if (res.changed.length) onRulesMutated();
        const other = res.ahead.filter(id => shardOf(id) !== skipShard);
        if (other.length) { addPending(other); schedulePublish(); }
    }
    function publishShard(k) {
        const remote = readShard(k);
        afterMerge(mergeIncoming(Array.from(remote.map.values())), k);   // fold in what others published first
        const out = remote.map;
        let dirty = false;
        const cutoff = now() - TOMBSTONE_RETENTION_MS;
        allRules.forEach((rec, id) => {
            if (shardOf(id) !== k) return;
            if (rec.deleted && rec.updatedAt < cutoff) return;
            const theirs = out.get(id);
            if (!theirs || isNewer(rec, theirs)) { out.set(id, rec); dirty = true; }
        });
        out.forEach((r, id) => { if (r.deleted && r.updatedAt < cutoff) { out.delete(id); dirty = true; } });
        if (dirty || !remote.rev) writeShard(k, out); else sync.seen[k] = remote.rev;
    }
    async function publishPending() {
        if (sync.publishing) { schedulePublish(400); return; }
        sync.publishing = true;
        const touched = new Set();
        let failed = false;
        try {
            for (let round = 0; round < 6 && sync.pending.size; round++) {
                const shards = new Set();
                sync.pending.forEach(id => shards.add(shardOf(id)));
                const ids = Array.from(sync.pending); sync.pending.clear();
                for (const k of shards) {
                    try { publishShard(k); touched.add(k); }
                    catch (e) { failed = true; sync.lastErr = String((e && e.message) || e); error('publish shard failed', k, e); ids.forEach(id => { if (shardOf(id) === k) sync.pending.add(id); }); }
                    await yieldMain();
                }
            }
            await flushPersist();
            if (!failed) {
                sync.lastOkAt = now(); sync.lastErr = '';
                if (sync.v3Pending) { sync.v3Pending = false; dbSetSetting('syncV3Done', true); }
                if (touched.size) { clearTimeout(sync.verifyTimer); sync.verifyTimer = setTimeout(() => verifyShards(Array.from(touched)), 2000); }
            }
            dbSetSetting('pendingPublish', Array.from(sync.pending));
        } catch (e) { sync.lastErr = String((e && e.message) || e); error('publish failed', e); }
        finally { sync.publishing = false; if (sync.pending.size) schedulePublish(failed ? 3000 : 500); }
    }
    function verifyShards(shards) {
        const bad = [];
        const cutoff = now() - TOMBSTONE_RETENTION_MS;
        for (const k of shards) {
            const remote = readShard(k);
            allRules.forEach((rec, id) => {
                if (shardOf(id) !== k || (rec.deleted && rec.updatedAt < cutoff)) return;
                const theirs = remote.map.get(id);
                if (!theirs || isNewer(rec, theirs)) bad.push(id);
            });
        }
        if (bad.length && sync.attempts < 4) { sync.attempts++; addPending(bad); schedulePublish(400); }
        else if (!bad.length) sync.attempts = 0;
    }
    function pullShard(k) {
        const remote = readShard(k);
        const res = mergeIncoming(Array.from(remote.map.values()));
        if (remote.rev) { sync.seen[k] = remote.rev; scheduleSeenPersist(); }
        const cutoff = now() - TOMBSTONE_RETENTION_MS;
        allRules.forEach((rec, id) => {      // local-only records of this shard must be published
            if (shardOf(id) === k && !remote.map.has(id) && !(rec.deleted && rec.updatedAt < cutoff)) res.ahead.push(id);
        });
        afterMerge(res, -1);
    }
    function schedulePull(k) {
        if (sync.pullTimers[k]) return;
        sync.pullTimers[k] = setTimeout(() => {
            delete sync.pullTimers[k];
            try { pullShard(k); } catch (e) { error('pull shard failed', k, e); }
        }, 250 + Math.floor(Math.random() * 250));
    }
    function pollRevs() {
        if (document.hidden) return;
        try {
            for (let k = 0; k < SHARD_COUNT; k++) {
                const cur = GM_getValue(REV_PREFIX + k, null);
                if (cur && cur !== sync.seen[k]) schedulePull(k);
            }
            const s = GM_getValue(SETTINGS_GM_KEY, null);
            if (s && s !== lastSettingsRaw) onRemoteSettings(s);
        } catch (e) {}
    }
    function registerSyncListeners() {
        if (typeof GM_addValueChangeListener === 'function') {
            for (let k = 0; k < SHARD_COUNT; k++) {
                try { GM_addValueChangeListener(REV_PREFIX + k, (n, o, nv, remote) => { if (remote === false) return; if (nv && nv !== sync.seen[k]) schedulePull(k); }); }
                catch (e) { error('rev listener failed', k, e); }
            }
        }
        setInterval(pollRevs, POLL_MS);   // safety net for managers whose change events are unreliable
        document.addEventListener('visibilitychange', () => { if (!document.hidden) pollRevs(); });
    }
    async function startSync() {
        if (sync.started) return; sync.started = true;
        try {
            sync.seen = (await dbGetSetting('seenRevs', {})) || {};
            const pend = await dbGetSetting('pendingPublish', []);
            if (Array.isArray(pend)) pend.forEach(id => { if (allRules.has(id)) sync.pending.add(id); });
            const v3done = await dbGetSetting('syncV3Done', false);
            for (let k = 0; k < SHARD_COUNT; k++) {
                const cur = GM_getValue(REV_PREFIX + k, null);
                if (cur && cur !== sync.seen[k]) { try { pullShard(k); } catch (e) { error('initial pull failed', k, e); } await yieldMain(); }
            }
            if (!v3done) {
                // One-time: fold in the old single-key master mirror, then publish everything this site has.
                const legacy = readGM(MASTER_KEY, null);
                if (legacy && Array.isArray(legacy.rules)) afterMerge(mergeIncoming(legacy.rules), -1);
                allRules.forEach((_, id) => sync.pending.add(id));
                sync.v3Pending = true;
            }
            registerSyncListeners();
            if (sync.pending.size) schedulePublish(300);
            setTimeout(purgeOldTombstonesIfDue, 5000);
        } catch (e) { error('startSync failed', e); }
    }
    function forceResync() {
        allRules.forEach((_, id) => sync.pending.add(id));
        sync.seen = {};
        for (let k = 0; k < SHARD_COUNT; k++) { try { pullShard(k); } catch (e) { error(e); } }
        schedulePublish(100);
    }
    function syncStatusText() {
        const alive = aliveRules().length, tombs = allRules.size - alive;
        const last = sync.lastOkAt ? new Date(sync.lastOkAt).toLocaleTimeString() : 'not yet';
        return `${alive} terms • ${tombs} delete markers • ${sync.pending.size} pending • last publish: ${last}${sync.lastErr ? ' • ⚠ ' + sync.lastErr : ''}${idbOk ? '' : ' • ⚠ IndexedDB unavailable'}`;
    }

    // ---------- local rule mutations ----------
    function onRulesMutated() { scheduleRulesApply(); updateGuiSoon(); }
    async function commitLocalRule(rec) {
        putRecord(rec);
        addPending([rec.id]);
        onRulesMutated();
        schedulePublish(250);
        await flushPersist();
    }
    async function deleteRuleById(id) {
        const cur = allRules.get(id);
        if (!cur || cur.deleted) return;
        await commitLocalRule({ ...cur, deleted: true, updatedAt: bump(cur.updatedAt) });
    }

    // =====================================================================
    // DOM ENGINE: incremental, time-sliced, never feeds back into itself
    // =====================================================================
    let jobQueue = [], currentJob = null, pumpScheduled = false, sliceDeadline = 0;
    const pumpChannel = (typeof MessageChannel !== 'undefined') ? new MessageChannel() : null;
    if (pumpChannel) pumpChannel.port1.onmessage = () => { runPump(); };
    function timeUp() { return performance.now() >= sliceDeadline; }
    function inputPending() { try { return !!(navigator.scheduling && navigator.scheduling.isInputPending && navigator.scheduling.isInputPending()); } catch (e) { return false; } }
    function schedulePump() {
        if (pumpScheduled) return;
        pumpScheduled = true;
        if (pumpChannel) pumpChannel.port2.postMessage(0); else setTimeout(runPump, 0);
    }
    function cancelAllJobs() { jobQueue = []; currentJob = null; dirtyRoots.clear(); dirtyAll = false; }
    function runPump() {
        pumpScheduled = false;
        sliceDeadline = performance.now() + SLICE_MS;
        try {
            for (;;) {
                if (!currentJob) {
                    const j = jobQueue.shift();
                    if (!j) break;
                    if (j.kind !== 'revert' && !engineActive) continue;
                    currentJob = j.kind === 'revert' ? revertJob(j.all) : (j.kind === 'full' ? fullScanJob() : walkRoot(j.root));
                }
                const r = currentJob.next();
                if (r.done) currentJob = null;
                if (timeUp() || inputPending()) break;
            }
        } catch (e) { error('Work slice failed', e); currentJob = null; }
        // Everything queued on the observer right now was produced by this very slice: drop it so our own
        // replacements can never re-enter the pipeline.
        if (mo) mo.takeRecords();
        if (currentJob || jobQueue.length) schedulePump(); else onPumpIdle();
    }
    function onPumpIdle() {
        ensureStyles();
        if (activeDirty) { activeDirty = false; scheduleActivePersist(); updateGuiSoon(); }
    }

    function blockOf(el) {
        let e = el;
        while (e && !BLOCK_TAGS.has(e.tagName)) e = e.parentElement;
        return e || document.documentElement;
    }
    function nodeIndexAt(starts, pos) {
        let lo = 0, hi = starts.length - 1;
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1; }
        return lo;
    }
    const NON_WS = /\S/;

    function recordMatch(rule, ts) {
        let s = ruleStats.get(rule.id);
        if (!s) { s = { lastUsed: 0, matchCount: 0 }; ruleStats.set(rule.id, s); }
        s.lastUsed = ts; s.matchCount++;
        if (!matchedIds.has(rule.id)) { matchedIds.add(rule.id); activeDirty = true; }
        scheduleStatsSave();
    }
    function makeReplacementSpan(rep, orig, rule) {
        const span = document.createElement('span');
        span.className = enableHighlight ? 'tr-replaced' : 'tr-replaced-hidden';
        span.textContent = rep;
        span.dataset.trId = 'tr' + (++trIdCounter);
        repData.set(span, { orig, ruleId: rule.id, ver: rule.updatedAt });
        return span;
    }

    // A "segment" = the contiguous text of one block (text nodes separated only by inline elements).
    // Each segment is scanned per node (exact word boundaries at node edges) AND as one joined string, which
    // finds matches spanning several nodes ("this <b>student</b>") - those are applied with the Range API.
    function processSegment(seg) {
        const M = matcher;
        if (!M || !M.count) return;
        const text = seg.text, nodes = seg.nodes, starts = seg.starts;
        if (text.length < M.minLen) return;
        const cands = [];
        for (let i = 0; i < nodes.length; i++) {
            const t = nodes[i].nodeValue;
            if (t.length >= M.minLen && NON_WS.test(t)) collectCands(M, t, starts[i], cands);
        }
        if (nodes.length > 1) {
            const joined = [];
            collectCands(M, text, 0, joined);
            for (const c of joined) if (nodeIndexAt(starts, c.end - 1) > nodeIndexAt(starts, c.start)) cands.push(c);
        }
        if (!cands.length) return;
        applyAccepted(seg, resolveCands(cands));
    }
    function applyAccepted(seg, accepted) {
        const nodes = seg.nodes, starts = seg.starts, text = seg.text;
        const ts = now();
        for (let k = accepted.length - 1; k >= 0; k--) {     // back to front keeps earlier offsets valid
            const c = accepted[k];
            try {
                const i0 = nodeIndexAt(starts, c.start), i1 = nodeIndexAt(starts, c.end - 1);
                const n0 = nodes[i0], n1 = nodes[i1];
                if (!n0.isConnected || !n1.isConnected) continue;
                const ls = c.start - starts[i0], le = c.end - starts[i1];
                const span = makeReplacementSpan(buildReplacement(c), text.slice(c.start, c.end), c.b.rule);
                if (i0 === i1) {
                    if (le > n0.nodeValue.length) continue;
                    const mid = ls > 0 ? n0.splitText(ls) : n0;
                    if (le - ls < mid.nodeValue.length) mid.splitText(le - ls);
                    mid.parentNode.replaceChild(span, mid);
                } else {
                    if (ls > n0.nodeValue.length || le > n1.nodeValue.length) continue;
                    const startNode = ls > 0 ? n0.splitText(ls) : n0;
                    if (le < n1.nodeValue.length) n1.splitText(le);
                    const range = document.createRange();
                    range.setStartBefore(startNode);
                    range.setEndAfter(n1);
                    range.deleteContents();
                    range.insertNode(span);
                }
                recordMatch(c.b.rule, ts);
            } catch (e) { error('Replacement failed for rule', c.b.rule.id, e); }
        }
    }

    function* walkRoot(root) {
        if (!matcher || !matcher.count || !root) return;
        if (root.nodeType !== 1) root = root.parentElement;
        if (!root || !root.isConnected) return;
        let excluded;
        try {
            if (root.closest(excludeSelector)) return;
            excluded = new Set(root.querySelectorAll(excludeSelector));
        } catch (e) { error('exclusion query failed', e); return; }
        let sawBreak = false;
        const walker = document.createTreeWalker(root, 5, {      // SHOW_ELEMENT | SHOW_TEXT
            acceptNode(n) {
                if (n.nodeType === 3) return 1;                  // ACCEPT
                if (excluded.has(n) || SKIP_TAGS.has(n.tagName)) { sawBreak = true; return 2; }   // REJECT whole subtree
                if (n.tagName === 'BR' || BLOCK_TAGS.has(n.tagName)) return 1;
                return 3;                                        // SKIP (inline element: descend, don't report)
            }
        });
        const blockCache = new Map();
        let seg = null, node;
        const flush = () => { if (seg) { const s = seg; seg = null; processSegment(s); } };
        while ((node = walker.nextNode())) {
            if (sawBreak || node.nodeType === 1) {
                sawBreak = false;
                if (seg) {
                    flush();
                    if (timeUp()) { yield; if (!node.isConnected) { jobQueue.push({ kind: 'root', root }); return; } }
                }
                if (node.nodeType === 1) continue;
            }
            const parent = node.parentElement;
            if (!parent) continue;
            let block = blockCache.get(parent);
            if (!block) { block = blockOf(parent); blockCache.set(parent, block); }
            if (seg && (seg.block !== block || seg.nodes.length >= MAX_SEG_NODES)) {
                flush();
                if (timeUp()) { yield; if (!node.isConnected) { jobQueue.push({ kind: 'root', root }); return; } }
            }
            const val = node.nodeValue;
            if (!seg) { if (!NON_WS.test(val)) continue; seg = { block, nodes: [], starts: [], text: '' }; }
            seg.nodes.push(node); seg.starts.push(seg.text.length); seg.text += val;
        }
        flush();
    }
    function* fullScanJob() {
        const root = document.body || document.documentElement;
        if (root) yield* walkRoot(root);
        onFullScanDone();
    }
    function onFullScanDone() {
        try { document.querySelectorAll('.tr-replaced, .tr-replaced-hidden').forEach(sp => { const d = repData.get(sp); if (d) matchedIds.add(d.ruleId); }); } catch (e) {}
        activeDirty = true;
    }

    function restoreSpan(span, d) {
        const parent = span.parentNode;
        if (!parent) return;
        const prev = span.previousSibling, next = span.nextSibling;
        // Re-join with the neighbouring text nodes (the originals we split) so the page's own nodes are restored.
        if (prev && prev.nodeType === 3) {
            prev.appendData(d.orig);
            if (next && next.nodeType === 3) { prev.appendData(next.nodeValue); next.remove(); }
            span.remove();
        } else {
            const tn = document.createTextNode(d.orig);
            span.replaceWith(tn);
            if (next && next.nodeType === 3) { tn.appendData(next.nodeValue); next.remove(); }
        }
        repData.delete(span);
    }
    function* revertJob(all) {
        let spans;
        try { spans = document.querySelectorAll('.tr-replaced, .tr-replaced-hidden'); } catch (e) { return; }
        let n = 0;
        for (const span of spans) {
            const d = repData.get(span);
            if (!d) continue;
            if (!all) {
                const r = allRules.get(d.ruleId);
                if (r && !r.deleted && r.enabled !== false && r.updatedAt === d.ver) continue;
            }
            try { restoreSpan(span, d); } catch (e) { error('restoreSpan failed', e); }
            if ((++n & 63) === 0 && timeUp()) yield;
        }
    }
    function revertAllReplacementsNow() {   // synchronous (used when the user imports/clears)
        try { document.querySelectorAll('.tr-replaced, .tr-replaced-hidden').forEach(sp => { const d = repData.get(sp); if (d) restoreSpan(sp, d); }); } catch (e) { error('revertAll failed', e); }
    }

    // ---------- mutation tracking ----------
    let dirtyRoots = new Set(), dirtyAll = false, dirtyTimer = null;
    function contextRootFor(node) {
        let el = node.nodeType === 1 ? node : node.parentElement;
        if (!el) return null;
        const start = el;
        while (el && !BLOCK_TAGS.has(el.tagName)) el = el.parentElement;
        if (!el) el = document.body || document.documentElement;
        if (el !== start && el.childElementCount > 300) el = start;   // don't re-walk giant containers for one appended span
        return el;
    }
    function addDirty(node) {
        if (dirtyAll || !node.isConnected) return;
        const root = contextRootFor(node);
        if (root) { dirtyRoots.add(root); if (dirtyRoots.size > 400) dirtyAll = true; }
    }
    function onMutations(records) {
        if (!engineActive || !matcher) return;
        for (let i = 0; i < records.length; i++) {
            if (i > 4000) { dirtyAll = true; break; }
            const m = records[i];
            if (m.type === 'characterData') {
                if (!isOwnUi(m.target)) addDirty(m.target);
            } else if (m.addedNodes.length) {
                if (isOwnUi(m.target)) continue;
                for (let j = 0; j < m.addedNodes.length; j++) {
                    const n = m.addedNodes[j];
                    if (n.nodeType === 3) addDirty(n);
                    else if (n.nodeType === 1 && !(n.matches && n.matches(OWN_UI_SELECTOR))) addDirty(n);
                }
            }
        }
        if (!dirtyTimer) dirtyTimer = setTimeout(flushDirty, document.readyState === 'loading' ? 16 : MUTATION_DEBOUNCE_MS);
    }
    function flushDirty() {
        dirtyTimer = null;
        if (!engineActive || !matcher) { dirtyRoots.clear(); dirtyAll = false; return; }
        if (dirtyAll || dirtyRoots.size > 150) {
            dirtyRoots.clear(); dirtyAll = false;
            if (!jobQueue.some(j => j.kind === 'full')) jobQueue.push({ kind: 'full' });
        } else {
            const roots = Array.from(dirtyRoots); dirtyRoots.clear();
            for (const r of roots) {
                if (!r.isConnected) continue;
                if (roots.some(o => o !== r && o.contains(r))) continue;
                jobQueue.push({ kind: 'root', root: r });
            }
        }
        schedulePump();
    }
    function startObserver() {
        if (mo) return;
        mo = new MutationObserver(onMutations);
        mo.observe(document.documentElement || document, { childList: true, subtree: true, characterData: true });
    }
    function stopObserver() { if (mo) { mo.disconnect(); mo = null; } }

    // ---------- applying rule changes ----------
    function scheduleRulesApply(delay) {
        if (rulesApplyTimer) clearTimeout(rulesApplyTimer);
        rulesApplyTimer = setTimeout(applyRulesNow, delay === undefined ? RULES_APPLY_DEBOUNCE_MS : delay);
    }
    function applyRulesNow() {
        rulesApplyTimer = null;
        matcher = buildMatcher(aliveRules());
        const flags = applyFlags; applyFlags = { added: false, removed: false };
        if (!engineActive) return;
        // New/edited rules can outrank spans already placed (e.g. "this student" vs "student"), so everything
        // is rebuilt; for pure deletions only the spans of removed/changed rules are restored.
        cancelAllJobs();
        jobQueue.push({ kind: 'revert', all: flags.added });
        jobQueue.push({ kind: 'full' });
        schedulePump();
        scheduleActivePersist();
    }

    // ---------- active rules for this host (feeds document-start priming) ----------
    let activePersistTimer = null, lastActiveSig = '';
    function scheduleActivePersist() { if (!activePersistTimer) activePersistTimer = setTimeout(() => { activePersistTimer = null; persistActiveHost(); }, 3000); }
    function persistActiveHost() {
        try {
            if (!allRules.size || !engineActive) return;
            const list = [];
            for (const r of aliveRules()) { if (r.enabled !== false && (r.forceGlobal || matchedIds.has(r.id))) list.push(r); }
            list.sort((a, b) => ((ruleStats.get(b.id) || ZERO_STATS).lastUsed) - ((ruleStats.get(a.id) || ZERO_STATS).lastUsed));
            const capped = list.slice(0, EARLY_MAX_RULES);
            const sig = capped.map(r => r.id + ':' + r.updatedAt).join('|');
            if (sig === lastActiveSig) return;
            lastActiveSig = sig;
            if (!capped.length) { try { GM_deleteValue(ACTIVE_HOST_PREFIX + HOST); } catch (e) {} return; }
            writeGM(ACTIVE_HOST_PREFIX + HOST, capped.map(r => ({ id: r.id, oldText: r.oldText, newText: r.newText, caseSensitive: !!r.caseSensitive,
                forceGlobal: !!r.forceGlobal, smartPriority: !!r.smartPriority, enabled: true, updatedAt: r.updatedAt })));
        } catch (e) { error('persistActiveHost failed', e); }
    }

    // =====================================================================
    // STYLES / THEME
    // =====================================================================
    function extractThemeColor() {
        try {
            const meta = document.querySelector('meta[name="theme-color"]');
            if (meta && meta.content) { siteThemeColor = meta.content; document.documentElement.style.setProperty('--md-sys-color-primary', siteThemeColor); }
        } catch (e) {}
    }
    function ensureStyles() { try { if (!document.getElementById('tr-styles')) applyStyles(); } catch (e) {} }
    function applyStyles() {
        if (document.getElementById('tr-styles') || !document.documentElement) return;
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
            .tr-replaced { background:rgba(103,80,164,0.15) !important; border-bottom:2px solid var(--md-sys-color-primary) !important; border-radius:4px !important; padding:0 2px !important; color:inherit !important; cursor:pointer; }
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
            .mui-sync-status { font-size: 12px; opacity: 0.8; line-height: 1.5; word-break: break-word; }

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
            .mui-expressive-dialog { position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%) scale(0.9); background: var(--md-sys-color-surface); color: var(--md-sys-color-on-surface); padding: 32px; border-radius: 28px; box-shadow: 0 12px 40px rgba(0,0,0,0.3); max-width: 400px; width: 80vw; max-height: 90vh; overflow-y: auto; display: flex; flex-direction: column; gap: 16px; opacity: 0; transition: transform 0.6s var(--md-ease-expressive), opacity 0.4s var(--md-ease-standard); font-family: inherit;}
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
                .mui-settings-title { color: #bbb; }
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

    // =====================================================================
    // IHW integration (unchanged)
    // =====================================================================
    window.addEventListener('IHW_Register', (e) => {
        externalIhwAPI = e.detail;
        externalIhwAPI.hideNativeButton();
        if (isGuiOpen && document.getElementById('tr-set-cont')) { showSettings(); }
    });

    // =====================================================================
    // VIRTUALIZED GUI
    // =====================================================================
    const COLLATOR = (typeof Intl !== 'undefined' && Intl.Collator) ? new Intl.Collator() : null;
    let listCache = { ver: -1, q: null, list: [] };
    function getListRules() {
        const q = searchQuery.trim().toLowerCase();
        if (listCache.ver === rulesVersion && listCache.q === q) return listCache.list;
        let list = aliveRules();
        list = q ? list.filter(r => r.oldText.toLowerCase().includes(q) || r.newText.toLowerCase().includes(q)) : list.slice();
        list.sort((a, b) => COLLATOR ? COLLATOR.compare(a.oldText, b.oldText) : a.oldText.localeCompare(b.oldText));
        listCache = { ver: rulesVersion, q, list };
        return list;
    }
    function updateGuiSoon() {
        if (!isGuiOpen || guiUpdateTimer) return;
        guiUpdateTimer = setTimeout(() => { guiUpdateTimer = null; updateGuiIfNeeded(); }, 200);
    }
    function updateGuiIfNeeded() { try { if (isGuiOpen && listContainer) renderVirtualList(); } catch (e) { error('updateGuiIfNeeded failed', e); } }

    function saveUIScrollForHost(host, offset) { try { const map = readGM(UI_SCROLL_KEY, {}) || {}; map[host] = offset; writeGM(UI_SCROLL_KEY, map); } catch (e) {} }
    function loadUIScrollForHost(host) { try { const map = readGM(UI_SCROLL_KEY, {}) || {}; const v = map[host]; return (typeof v === 'number') ? v : 0; } catch (e) { return 0; } }
    function saveUIScrollDebounced() {
        if (!listContainer) return;
        if (scrollSaveTimer) clearTimeout(scrollSaveTimer);
        const offset = listContainer.scrollTop;
        scrollSaveTimer = setTimeout(() => { saveUIScrollForHost(HOST, offset); scrollSaveTimer = null; }, SCROLL_SAVE_DEBOUNCE);
    }
    function isRuleActive(r) { return !!(engineActive && (matchedIds.has(r.id) || r.forceGlobal)); }

    function renderVirtualList() {
        try {
            if (!listContainer || !virtualScroller) return;
            if (aliveRules().length === 0) {
                virtualScroller.style.height = '100px';
                virtualScroller.innerHTML = `<div style="text-align: center; padding: 40px; color: #777;">No Terms Found. Use [＋ Add Term] or [Import] to begin.</div>`;
                return;
            }
            const sorted = getListRules();
            if (sorted.length === 0) {
                virtualScroller.style.height = '100px';
                virtualScroller.innerHTML = `<div style="text-align: center; padding: 40px; color: #777;">No results for "${escapeHtml(searchQuery)}".</div>`;
                return;
            }
            const scrollTop = listContainer.scrollTop;
            const viewportHeight = listContainer.clientHeight || 400;
            virtualScroller.style.height = `${sorted.length * CARD_HEIGHT}px`;
            const startIndex = Math.max(0, Math.floor(scrollTop / CARD_HEIGHT) - 2);
            const endIndex = Math.min(sorted.length, Math.ceil((scrollTop + viewportHeight) / CARD_HEIGHT) + 2);
            const nowTs = now();
            let htmlStr = '';
            for (let i = startIndex; i < endIndex; i++) {
                const r = sorted[i]; const isActive = isRuleActive(r);
                const stats = ruleStats.get(r.id);
                const isRecent = stats && (nowTs - stats.lastUsed) < 3600000;
                const meta = `${isActive ? '✅ Active' : '💤 Idle'} • ${r.forceGlobal ? '🌍 Global' : '🤖 Auto'} ${r.smartPriority ? '• ⚡ Priority' : ''}${isRecent ? ' • ⏱️ Recent' : ''}`;
                htmlStr += `
                    <div class="mui-card ${isActive ? 'active' : ''}" style="top:${i * CARD_HEIGHT}px" data-id="${escapeHtml(r.id)}">
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
            let searchTimer = null;
            searchInput.addEventListener('input', (e) => {
                searchQuery = e.target.value;
                clearTimeout(searchTimer);
                searchTimer = setTimeout(() => { listContainer.scrollTop = 0; renderVirtualList(); }, 120);
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
            if (typeof savedScroll === 'number') setTimeout(() => { if (listContainer) { listContainer.scrollTop = savedScroll; renderVirtualList(); } }, 0);
            mainPage.querySelector('#tr-settings-btn').onclick = () => { if (!isNavigating) showPage('settings'); };
            mainPage.querySelector('#tr-add-btn').onclick = () => addRuleInteractive();
            mainPage.querySelector('#tr-backup-btn').onclick = backupAllData;
            mainPage.querySelector('#tr-import-btn').onclick = () => { promptFileImport(); };
            renderVirtualList();
        } catch (e) { error('buildFullGUI failed', e); }
    }

    // =====================================================================
    // UNIFIED BACKUP / IMPORT (format stays compatible with every earlier version)
    // =====================================================================
    async function backupAllData() {
        const backup = {
            version: 3,
            timestamp: now(),
            rules: aliveRules().map(r => ({ ...r })),
            blockedDomains: [...blockedDomains],
            protectedSelectors: [...protectedSelectors],
            enableHighlight
        };
        const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `text-replacer-backup-${now()}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    }

    function promptFileImport() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.style.display = 'none';
        input.onchange = async (e) => {
            const f = e.target.files && e.target.files[0];
            if (!f) return;
            try { await applyImportedData(await f.text()); }
            catch (err) { alert('Failed to import file.'); error(err); }
            finally { input.remove(); }
        };
        document.body.appendChild(input);
        input.click();
    }

    async function applyImportedData(jsonStr) {
        let payload;
        try { payload = JSON.parse(jsonStr); } catch (e) { alert('Invalid JSON.'); return; }
        let importedRules = null, importedBlocked = null, importedProtected = null;
        if (Array.isArray(payload)) importedRules = payload;
        else if (payload && typeof payload === 'object') {
            if (Array.isArray(payload.rules)) importedRules = payload.rules;
            if (Array.isArray(payload.blockedDomains)) importedBlocked = payload.blockedDomains;
            else if (Array.isArray(payload.domains)) importedBlocked = payload.domains;
            if (Array.isArray(payload.protectedSelectors)) importedProtected = payload.protectedSelectors;
        }

        let imported = 0;
        if (importedRules) {
            for (let i = 0; i < importedRules.length; i++) {
                const cand = normalizeRecord(importedRules[i], now());
                if (!cand) continue;
                cand.deleted = false;      // an explicit import always means "I want these"
                const local = allRules.get(cand.id);
                const peers = peerRecords(signatureOf(cand));
                if (local) {
                    if (local.deleted) putRecord({ ...cand, updatedAt: bump(local.updatedAt) });       // revive on purpose
                    else if (cand.updatedAt > local.updatedAt) putRecord({ ...local, ...cand, id: local.id });
                    else continue;
                } else if (peers.some(p => !p.deleted)) { continue; }                                    // same term already present
                else {
                    const tombTs = peers.reduce((m, p) => Math.max(m, p.updatedAt), 0);
                    putRecord(tombTs >= cand.updatedAt ? { ...cand, updatedAt: bump(tombTs) } : cand);   // beat any delete marker
                }
                addPending([cand.id]);
                imported++;
                if ((i & 255) === 255) await yieldMain();
            }
        }
        if (importedBlocked) importedBlocked.forEach(d => { if (typeof d === 'string' && d) { const cur = settingsDoc.blocked[d]; if (!cur || !cur.b) settingsDoc.blocked[d] = { b: 1, t: bump(cur && cur.t) }; } });
        if (importedProtected) importedProtected.forEach(s => { if (typeof s === 'string' && s) { const cur = settingsDoc.prot[s]; if (!cur || !cur.b) settingsDoc.prot[s] = { b: 1, t: bump(cur && cur.t) }; } });
        if (importedBlocked || importedProtected) commitSettings();

        await flushPersist();
        schedulePublish(200);
        onRulesMutated();
        alert(`Import completed successfully${importedRules ? ` (${imported} new/updated term${imported === 1 ? '' : 's'})` : ''}.`);
    }

    // =====================================================================
    // DIALOG WITH OPERATOR CHEAT SHEET
    // =====================================================================
    function showTermDialog(isEdit = false, ruleData = {}) {
        const title = isEdit ? 'Edit Term' : 'Add New Term';
        const oldText = ruleData.oldText || '';
        const newText = ruleData.newText || '';
        const isCase = ruleData.caseSensitive || false;
        const isGlobal = ruleData.forceGlobal || false;
        const isSmart = ruleData.smartPriority || false;
        const contentHtml = `
            <div class="mui-expressive-dialog mui-term-dialog">
                <h3>${title}</h3>
                <div class="mui-operator-info">
                    <strong>Operators:</strong>
                    <ul style="margin:4px 0; padding-left:18px; font-size:13px; line-height:1.5;">
                        <li><b>|</b> – Multi‑term: "word1 | word2"</li>
                        <li><b>---</b> – Gap: "first --- second" matches a gap of any words</li>
                        <li><b>#{word1,word2}#</b> – Filter: exclude words from the gap</li>
                        <li><b>#word# --- #word#</b> – Echo: a word, something in between, then the same word again (also tolerates spelling variants like "Bizzarro … Bizarro"). In the replacement, <b>#word#</b> = the first word, <b>#word2#</b> = the second. Anchor it with real text to be safe, e.g. "#word# also known as #word#" → "#word#"</li>
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
                if (!oldInput) { alert('Original and replacement fields cannot be empty.'); return; }
                const problem = validateOldText(oldInput, isCaseInput);
                if (problem) { alert(problem); return; }
                const fields = { oldText: oldInput, newText: newInput, caseSensitive: isCaseInput, forceGlobal: isGlobalInput, smartPriority: isSmartInput };
                if (isEdit) {
                    const cur = allRules.get(ruleData.id);
                    if (!cur || cur.deleted) { closeCustomDialog(); return; }
                    const next = { ...cur, ...fields };
                    const dup = peerRecords(signatureOf(next)).find(p => !p.deleted && p.id !== cur.id);
                    if (dup) { alert('An identical term already exists.'); return; }
                    next.updatedAt = bump(cur.updatedAt);
                    await commitLocalRule(next);
                } else {
                    const rec = { id: uuid(), ...fields, enabled: true, deleted: false, createdAt: now(), updatedAt: now(), site: HOST };
                    const peers = peerRecords(signatureOf(rec));
                    if (peers.some(p => !p.deleted)) { alert('This exact term already exists.'); return; }
                    rec.updatedAt = Math.max(now(), peers.reduce((m, p) => Math.max(m, p.updatedAt + 1), 0));   // always newer than any delete marker of the same term
                    await commitLocalRule(rec);
                }
                closeCustomDialog();
            };
            cancelBtn.onclick = closeCustomDialog;
        });
    }

    function addRuleInteractive(prefill = '') { showTermDialog(false, { oldText: prefill }); }
    function editRuleInteractive(id) {
        const r = allRules.get(id);
        if (!r || r.deleted) return;
        showTermDialog(true, r);
    }
    async function deleteRuleInteractive(id) {
        if (confirm('Delete this rule permanently?')) await deleteRuleById(id);
    }

    // =====================================================================
    // SETTINGS PAGE
    // =====================================================================
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
            if (input) return;
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
            function cancel() { if (finished) return; finished = true; restoreView(); }
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
            const protDesc = document.createElement('div'); protDesc.textContent = 'CSS selectors for elements where replacement should be blocked (e.g., text inputs, comment fields). Invalid selectors are ignored. Synced across all sites.'; protDesc.style.fontSize = '12px'; protDesc.style.marginBottom = '8px'; cont.appendChild(protDesc);

            const protListContainer = document.createElement('div');
            protListContainer.className = 'mui-scroll-list';
            protectedSelectors.forEach(sel => {
                protListContainer.appendChild(createEditableListRow(sel, {
                    onSave: (newVal) => {
                        if (protectedSelectors.includes(newVal)) { alert('That selector already exists.'); return; }
                        if (!isValidSelector(newVal)) { alert('That is not a valid CSS selector.'); return; }
                        setProtected(sel, false); setProtected(newVal, true);
                        showSettings();
                    },
                    onDelete: () => { setProtected(sel, false); showSettings(); }
                }));
            });
            cont.appendChild(protListContainer);

            const addProtRow = document.createElement('div'); addProtRow.style.display = 'flex'; addProtRow.style.gap = '8px'; addProtRow.style.marginBottom = '16px';
            const protInput = document.createElement('input'); protInput.type = 'text'; protInput.placeholder = 'e.g., .comment-box, #editor'; protInput.style.flex = '1'; protInput.style.padding = '8px'; protInput.style.borderRadius = '8px'; protInput.style.border = '1px solid #ccc';
            const addBtn = document.createElement('button'); addBtn.textContent = 'Add'; addBtn.className = 'mui-button mui-pill-settings';
            addBtn.onclick = () => {
                const val = protInput.value.trim();
                if (!val || protectedSelectors.includes(val)) return;
                if (!isValidSelector(val)) { alert('That is not a valid CSS selector.'); return; }
                setProtected(val, true);
                showSettings();
            };
            addProtRow.appendChild(protInput); addProtRow.appendChild(addBtn);
            cont.appendChild(addProtRow);

            // --- Blocklist ---
            const blTitle = document.createElement('div'); blTitle.className = 'mui-settings-title'; blTitle.textContent = 'Blocklist (Global)'; cont.appendChild(blTitle);
            const blocklistContainer = document.createElement('div');
            blocklistContainer.className = 'mui-scroll-list';
            (blockedDomains || []).forEach(d => {
                blocklistContainer.appendChild(createEditableListRow(d, {
                    onSave: (newVal) => {
                        if (blockedDomains.includes(newVal)) { alert('That domain already exists.'); return; }
                        setBlocked(d, false); setBlocked(newVal, true);
                        showSettings();
                    },
                    onDelete: () => { setBlocked(d, false); showSettings(); }
                }));
            });
            const blockBtn = document.createElement('button'); blockBtn.textContent = '🚫 Block Current Site';
            blockBtn.className = 'mui-button mui-pill-settings';
            blockBtn.style.marginBottom = '12px';
            blockBtn.onclick = () => { if (!blockedDomains.includes(HOST)) { setBlocked(HOST, true); showSettings(); } };
            cont.appendChild(blockBtn);
            cont.appendChild(blocklistContainer);

            const note = document.createElement('div'); note.textContent = 'Use "Backup All" in the Library to export everything.'; note.style.fontSize = '12px'; note.style.marginBottom = '12px'; cont.appendChild(note);

            // --- Appearance ---
            const hlTitle = document.createElement('div'); hlTitle.className = 'mui-settings-title'; hlTitle.textContent = 'Appearance'; cont.appendChild(hlTitle);
            const hlBtn = document.createElement('button'); hlBtn.textContent = enableHighlight ? '🔵 Blue Highlight: ON' : '⚪ Blue Highlight: OFF';
            hlBtn.className = 'mui-button mui-pill-settings';
            hlBtn.onclick = () => { setHighlight(!enableHighlight); showSettings(); };
            cont.appendChild(hlBtn);

            // --- Sync ---
            const syncTitle = document.createElement('div'); syncTitle.className = 'mui-settings-title'; syncTitle.textContent = 'Sync'; cont.appendChild(syncTitle);
            const syncInfo = document.createElement('div'); syncInfo.className = 'mui-sync-status'; syncInfo.textContent = syncStatusText(); cont.appendChild(syncInfo);
            const syncBtn = document.createElement('button'); syncBtn.textContent = '🔄 Force full resync';
            syncBtn.className = 'mui-button mui-pill-settings';
            syncBtn.onclick = () => { forceResync(); syncInfo.textContent = 'Resyncing…'; setTimeout(() => { syncInfo.textContent = syncStatusText(); }, 1500); };
            cont.appendChild(syncBtn);

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

            settingsPage.querySelector('#tr-back-btn').onclick = () => { if (!isNavigating) showPage('main'); };
        } catch (e) { error('showSettings failed', e); }
    }

    // =====================================================================
    // QUICK EDIT & SELECTION
    // =====================================================================
    function createQuickEditGUI() {
        if (document.getElementById('tr-quick-edit')) return;
        quickEditBox = document.createElement('div'); quickEditBox.id = 'tr-quick-edit'; quickEditBox.className = 'mui-hidden';
        quickEditBox.innerHTML = `<div><label>Original:</label> <span class="qe-orig-text" id="qe-from"></span></div><div style="margin-top: 4px;"><button class="mui-icon-btn mui-tonal" id="qe-edit-btn">✏️</button></div>`;
        document.body.appendChild(quickEditBox);
        document.getElementById('qe-edit-btn').onclick = () => { if (quickEditActiveId) { editRuleInteractive(quickEditActiveId); hideQuickEdit(); } };
        document.addEventListener('click', (e) => {
            const t = e.target;
            const rep = t && t.classList && t.classList.contains('tr-replaced') ? t : null;
            if (rep) showQuickEdit(rep);
            else if (quickEditBox && !quickEditBox.contains(t)) hideQuickEdit();
        });
    }
    function showQuickEdit(targetElement) {
        if (!quickEditBox) return;
        const data = repData.get(targetElement);
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
        let selTimer = null;
        document.addEventListener('selectionchange', () => {
            clearTimeout(selTimer);
            selTimer = setTimeout(() => {
                const selection = window.getSelection();
                if (!selection || selection.isCollapsed || selection.rangeCount === 0) { selectionFab.classList.add('mui-hidden'); return; }
                const anc = selection.getRangeAt(0).commonAncestorContainer;
                const el = anc && (anc.nodeType === 1 ? anc : anc.parentElement);
                if (el && el.closest && el.closest('#text-replacer-gui, #tr-quick-edit, #tr-dialog-wrapper')) { selectionFab.classList.add('mui-hidden'); return; }
                if (selection.toString().trim()) selectionFab.classList.remove('mui-hidden'); else selectionFab.classList.add('mui-hidden');
            }, 150);
        });
    }

    // =====================================================================
    // GUI SHELL
    // =====================================================================
    function createGUI() {
        if (document.getElementById('text-replacer-gui')) return;
        try {
            guiBox = document.createElement('div'); guiBox.id = 'text-replacer-gui'; guiBox.className = 'mui-box';
            const toggle = document.createElement('div'); toggle.className = 'mui-toggle'; toggle.textContent = '☰';
            toggle.onclick = () => {
                if (isNavigating) return;
                isGuiOpen = !isGuiOpen;
                if (isGuiOpen) { guiBox.classList.add('open'); showPage('main'); }
                else guiBox.classList.remove('open');
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
        const currentPage = pages[1 - nextIdx];
        const nextPage = pages[nextIdx];
        currentPage.classList.add('mui-page-leave');
        nextPage.classList.add('mui-page-enter');
        nextPage.classList.add('mui-page-active');
        if (pageId === 'main') buildFullGUI(); else showSettings();
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

    // =====================================================================
    // BOOT
    // =====================================================================
    let bootstrapped = false;

    // Runs synchronously at document-start: primes the replacement for rules that matched on this host before,
    // so text is already replaced as the page streams in (no flash of original text).
    function earlyBoot() {
        try {
            applyStyles();
            const blocked = readGM(BLOCK_KEY, []);
            if (Array.isArray(blocked) && blocked.includes(HOST)) return;
            enableHighlight = readGM(HIGHLIGHT_KEY, true) !== false;
            const prot = readGM(PROTECTED_KEY, null);
            protectedSelectors = Array.isArray(prot) ? prot : DEFAULT_PROTECTED_SELECTORS.slice();
            updateProtectedSelectorString();
            let list = readGM(ACTIVE_HOST_PREFIX + HOST, null);
            if (!Array.isArray(list)) {
                const legacy = readGM(ACTIVE_KEY, null);
                list = legacy && legacy.hostMap && Array.isArray(legacy.hostMap[HOST]) ? legacy.hostMap[HOST] : [];
            }
            const tombs = readGM(TOMB_GM_KEY, {}) || {};
            const rules = [];
            for (const raw of list) {
                const n = normalizeRecord(raw, 0);
                if (!n || n.deleted || !n.enabled) continue;
                if (tombs[n.id] && tombs[n.id] >= n.updatedAt) continue;   // deleted elsewhere: never prime it
                rules.push(n);
            }
            if (!rules.length) return;
            hadEarlyList = true;
            matcher = buildMatcher(rules);
            if (!matcher.count) { matcher = null; return; }
            engineActive = true;
            startObserver();
            if (document.body) { jobQueue.push({ kind: 'full' }); schedulePump(); }
        } catch (e) { error('Early boot failed', e); }
    }

    async function bootstrap() {
        if (bootstrapped) return;
        bootstrapped = true;
        try {
            extractThemeColor(); applyStyles();
            await loadSettings();                                   // blocklist, protected areas, highlight
            const bigEnough = IS_TOP || (window.innerWidth >= 400 && window.innerHeight >= 300);
            if (bigEnough) createGUI();
            await loadRulesFromIdb();                               // whole DB into memory once; the engine never touches IDB again
            engineActive = !blockedDomains.includes(HOST);
            if (engineActive) startObserver(); else { stopObserver(); jobQueue.push({ kind: 'revert', all: true }); schedulePump(); }
            matcher = buildMatcher(aliveRules());
            if (engineActive) {
                cancelAllJobs();
                applyFlags = { added: false, removed: false };
                jobQueue.push({ kind: 'revert', all: false });      // drop early-primed spans whose rule changed/was deleted
                jobQueue.push({ kind: 'full' });
                schedulePump();
            }
            startSync();                                            // background: pull/push the global database
            log('Text Replacer initialized successfully.');
        } catch (e) {
            error('Bootstrap error', e);
            try { createGUI(); } catch (e2) {}
        }
    }

    function attemptInit() {
        try {
            if (document.body) bootstrap();
            else setTimeout(attemptInit, 100);
        } catch (e) { error('Init failed, will retry', e); setTimeout(attemptInit, 500); }
    }

    function flushEverything() { flushStats(); flushPersist(); flushTombMirror(); }
    window.addEventListener('pagehide', flushEverything);
    document.addEventListener('visibilitychange', () => { if (document.hidden) flushEverything(); });

    earlyBoot();
    const startInit = () => {
        // Sub-frames (ads, widgets) only boot fully if they are big enough to be real content or already had matches.
        if (!IS_TOP && !hadEarlyList && !(window.innerWidth >= 400 && window.innerHeight >= 300)) return;
        setTimeout(attemptInit, 0);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startInit);
    else startInit();

})();
