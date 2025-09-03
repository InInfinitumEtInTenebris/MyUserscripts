// ==UserScript==
// @name         Text Replacer11 (Material You, Text File Import/Export, Infinite Storage)
// @namespace    http://tampermonkey.net/
// @version      3.2.2-modInf-v2
// @description  Dynamically replaces text using a Material You GUI with text file import/export and case-sensitive toggling. Now uses IndexedDB for storage so that the total rules list can grow arbitrarily large. Uses debounced replacement on added/removed nodes (no characterData observation) and skips non‑content elements.
// @match        :///*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // Global object to store rules in memory.
    // Each rule is stored as: { oldText, newText, caseSensitive, site, logicType }
    let replacements = {};
    let guiBox;
    let fab;
    let isGuiOpen = false;

    // A WeakMap to store each text node’s original content.
    const originalTextMap = new WeakMap();
    let observerTimeout = null;

    // Blacklisted sites where the script should not run or show its icon.
    // Add domains to this array to blacklist them.
    const BLACKLISTED_SITES = [
        'docs.google.com',
        'sheets.google.com',
        'mail.google.com'
    ];

    /* ------------------- INDEXEDDB STORAGE SETUP ------------------- */
    let db;
    const DB_NAME = "TextReplacerDB";
    const DB_VERSION = 1;
    const STORE_NAME = "rules";

    function initDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = function(e) {
                db = e.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: "oldText" });
                }
            };
            request.onsuccess = function(e) {
                db = e.target.result;
                resolve();
            };
            request.onerror = function(e) {
                console.error("IndexedDB error:", e);
                reject(e);
            };
        });
    }

    function loadReplacementsFromDB() {
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], "readonly");
            const store = transaction.objectStore(STORE_NAME);
            const request = store.getAll();
            request.onsuccess = function(e) {
                const result = e.target.result;
                replacements = {};
                result.forEach(rule => {
                    // Only load rules that are valid (each rule must have a newText string)
                    if (rule && typeof rule.newText === "string") {
                        replacements[rule.oldText] = rule;
                    }
                });
                resolve();
            };
            request.onerror = function(e) {
                reject(e);
            };
        });
    }

    function saveRuleToDB(oldText, rule) {
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], "readwrite");
            const store = transaction.objectStore(STORE_NAME);
            const request = store.put({ ...rule, oldText });
            request.onsuccess = function() {
                resolve();
            };
            request.onerror = function(e) {
                console.error("Error saving rule:", e);
                reject(e);
            };
        });
    }

    function deleteRuleFromDB(oldText) {
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], "readwrite");
            const store = transaction.objectStore(STORE_NAME);
            const request = store.delete(oldText);
            request.onsuccess = function() {
                resolve();
            };
            request.onerror = function(e) {
                console.error("Error deleting rule:", e);
                reject(e);
            };
        });
    }

    /* ------------------- HELPER FUNCTIONS ------------------- */
    // Returns true if this node (or one of its parents) should be skipped.
    // Also checks if the current site is on the blacklist.
    function shouldSkip(node) {
        // Blacklist check
        if (BLACKLISTED_SITES.includes(window.location.hostname)) {
            return true;
        }

        if (node.nodeType === Node.TEXT_NODE) {
            if (!node.parentElement) return true;
            if (node.parentElement.closest('.mui-box, .mui-toggle, .mui-fab')) return true;
            const tag = node.parentElement.tagName;
            if (['HEAD', 'SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE'].includes(tag)) return true;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.closest('.mui-box, .mui-toggle, .mui-fab')) return true;
            if (['HEAD', 'SCRIPT', 'STYLE'].includes(node.tagName)) return true;
        }
        return false;
    }

    /* ------------------- TEXT REPLACEMENT ------------------- */
    function escapeRegExp(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function replaceText(node) {
        if (shouldSkip(node)) return;
        if (node.nodeType === Node.TEXT_NODE) {
            if (!originalTextMap.has(node)) {
                originalTextMap.set(node, node.nodeValue);
            }
            const baseText = originalTextMap.get(node);
            let updatedText = baseText;
            for (const [oldTxt, rule] of Object.entries(replacements)) {
                if (rule.site !== window.location.hostname) continue;
                if (!rule || typeof rule.newText !== 'string') continue;

                const { newText, caseSensitive, logicType } = rule;
                let pattern;

                switch (logicType) {
                    case 'ignoreSpecialCharacters':
                        // Create a regex to ignore special characters by only matching word characters.
                        const cleanOldTxt = oldTxt.replace(/[^\p{L}\p{N}]/gu, '');
                        pattern = new RegExp(cleanOldTxt, caseSensitive ? 'g' : 'gi');
                        break;
                    case 'ignoreCase':
                        // The original case-insensitive logic.
                        pattern = new RegExp(escapeRegExp(oldTxt), 'gi');
                        break;
                    case 'wholeWord':
                    default:
                        // The original whole-word logic.
                        pattern = new RegExp('\\b' + escapeRegExp(oldTxt) + '\\b', caseSensitive ? 'g' : 'gi');
                        break;
                }

                updatedText = updatedText.replace(pattern, newText);
            }
            if (node.nodeValue !== updatedText) {
                node.nodeValue = updatedText;
            }
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            node.childNodes.forEach(child => replaceText(child));
        }
    }

    function runReplacements() {
        replaceText(document.body);
    }

    const observer = new MutationObserver(() => {
        if (observerTimeout) clearTimeout(observerTimeout);
        observerTimeout = setTimeout(() => {
            runReplacements();
        }, 500);
    });

    // Only observe if the current site is not blacklisted.
    if (!BLACKLISTED_SITES.includes(window.location.hostname)) {
        observer.observe(document.body, { childList: true, subtree: true });
    }

    /* ------------------- HANDLE PAGINATED CONTENT ------------------- */
    function onUrlChange() {
        runReplacements();
    }
    const originalPushState = history.pushState;
    history.pushState = function(...args) {
        originalPushState.apply(history, args);
        onUrlChange();
    };
    const originalReplaceState = history.replaceState;
    history.replaceState = function(...args) {
        originalReplaceState.apply(history, args);
        onUrlChange();
    };
    window.addEventListener('popstate', onUrlChange);

    /* ------------------- GUI FUNCTIONS ------------------- */
    function displayRules() {
        if (!guiBox) return;
        guiBox.innerHTML = '';

        const title = document.createElement('h2');
        title.textContent = 'Text Replacer Rules';
        guiBox.appendChild(title);

        for (const oldText in replacements) {
            const rule = replacements[oldText];
            if (rule.site !== window.location.hostname) continue;

            const { newText, caseSensitive, logicType } = rule;
            const ruleDiv = document.createElement('div');
            ruleDiv.classList.add('mui-card');

            const logicText = logicType === 'ignoreSpecialCharacters' ? 'Ignore Special Chars' : logicType === 'ignoreCase' ? 'Case-Insensitive' : 'Whole Word';
            const ruleText = document.createElement('span');
            ruleText.innerHTML = `<strong>"${oldText}" → "${newText}"</strong> (${logicText}, Case-Sensitive: ${caseSensitive ? 'Yes' : 'No'})`;
            ruleDiv.appendChild(ruleText);

            const buttonContainer = document.createElement('div');

            const editButton = document.createElement('button');
            editButton.textContent = '✏️ Edit';
            editButton.classList.add('mui-button');
            editButton.addEventListener('click', () => editRule(oldText));

            const deleteButton = document.createElement('button');
            deleteButton.textContent = '🗑️ Delete';
            deleteButton.classList.add('mui-button');
            deleteButton.addEventListener('click', () => deleteRule(oldText));

            buttonContainer.appendChild(editButton);
            buttonContainer.appendChild(deleteButton);
            ruleDiv.appendChild(buttonContainer);

            guiBox.appendChild(ruleDiv);
        }

        const exportButton = document.createElement('button');
        exportButton.textContent = '📤 Export Rules (File)';
        exportButton.classList.add('mui-button');
        exportButton.addEventListener('click', exportRules);
        guiBox.appendChild(exportButton);

        const importButton = document.createElement('button');
        importButton.textContent = '📥 Import Rules (File)';
        importButton.classList.add('mui-button');
        importButton.addEventListener('click', importRules);
        guiBox.appendChild(importButton);
    }

    /* ------------------- RULE ADD/EDIT/DELETE ------------------- */
    async function addRule() {
        const oldText = prompt("Enter the text to replace:", "");
        if (oldText === null || oldText.trim() === "") {
            alert("You must provide the text to replace.");
            return;
        }
        const newText = prompt("Enter the replacement text:", "");
        if (newText === null) return;
        const caseSensitive = confirm("Should this replacement be case-sensitive?");
        const logicType = prompt("Enter replacement logic type (wholeWord, ignoreCase, ignoreSpecialCharacters):", "wholeWord") || "wholeWord";

        const rule = {
            newText: newText.trim(),
            caseSensitive,
            logicType,
            site: window.location.hostname
        };
        replacements[oldText.trim()] = rule;
        try {
            await saveRuleToDB(oldText.trim(), rule);
            alert("Replacement rule added.");
            displayRules();
            runReplacements();
        } catch (e) {
            alert("Error saving rule.");
        }
    }

    async function editRule(oldText) {
        const rule = replacements[oldText];
        if (!rule) {
            alert("Rule not found.");
            return;
        }
        const { newText, caseSensitive, logicType } = rule;
        const updatedOld = prompt("Edit original text:", oldText);
        if (updatedOld === null) return;
        const updatedNew = prompt("Edit replacement text:", newText);
        if (updatedNew === null) return;
        const updatedCaseSensitive = confirm("Should this rule be case-sensitive?");
        const updatedLogicType = prompt("Edit logic type (wholeWord, ignoreCase, ignoreSpecialCharacters):", logicType) || "wholeWord";

        if (updatedOld.trim() && updatedNew.trim()) {
            if (updatedOld.trim() !== oldText) {
                try {
                    await deleteRuleFromDB(oldText);
                } catch (e) {
                    alert("Error updating rule.");
                    return;
                }
                delete replacements[oldText];
            }
            const updatedRule = {
                newText: updatedNew.trim(),
                caseSensitive: updatedCaseSensitive,
                logicType: updatedLogicType,
                site: window.location.hostname
            };
            replacements[updatedOld.trim()] = updatedRule;
            try {
                await saveRuleToDB(updatedOld.trim(), updatedRule);
                alert("Rule updated.");
                displayRules();
                runReplacements();
            } catch (e) {
                alert("Error updating rule.");
            }
        } else {
            alert("Both values must be non-empty.");
        }
    }

    async function deleteRule(oldText) {
        if (confirm(`Delete rule "${oldText}"?`)) {
            try {
                await deleteRuleFromDB(oldText);
                delete replacements[oldText];
                alert("Rule deleted.");
                displayRules();
                runReplacements();
            } catch (e) {
                alert("Error deleting rule.");
            }
        }
    }

    /* ------------------- TEXT FILE IMPORT/EXPORT ------------------- */
    function exportRules() {
        let exportText = "";
        // Export all rules (site tags are not included so that imported rules will default to the current site)
        for (const [oldText, rule] of Object.entries(replacements)) {
            exportText += `${oldText}:${rule.newText}:${rule.caseSensitive ? "1" : "0"}:${rule.logicType}\n`;
        }
        const blob = new Blob([exportText], { type: 'text/plain' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'text_replacements.txt';
        a.click();
    }
    function importRules() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.txt';
        input.addEventListener('change', function(event) {
            const file = event.target.files[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = async function(e) {
                    const lines = e.target.result.split("\n");
                    for (let line of lines) {
                        const parts = line.split(":");
                        if (parts.length >= 3) {
                            const oldText = parts[0].trim();
                            const newText = parts[1].trim();
                            const caseSensitive = parts[2].trim() === "1";
                            const logicType = parts[3] ? parts[3].trim() : "wholeWord";
                            if (oldText && newText !== undefined) {
                                const rule = {
                                    newText,
                                    caseSensitive,
                                    logicType,
                                    site: window.location.hostname
                                };
                                replacements[oldText] = rule;
                                try {
                                    await saveRuleToDB(oldText, rule);
                                } catch (e) {
                                    console.error("Error importing rule", oldText, e);
                                }
                            }
                        }
                    }
                    alert("Rules imported successfully.");
                    displayRules();
                    runReplacements();
                };
                reader.readAsText(file);
            }
        });
        input.click();
    }

    /* ------------------- GUI TOGGLE ------------------- */
    function toggleGUI() {
        isGuiOpen = !isGuiOpen;
        guiBox.classList.toggle('mui-hidden', !isGuiOpen);
        fab.classList.toggle('mui-hidden', !isGuiOpen);
    }

    /* ------------------- CREATE GUI ------------------- */
    function createGUI() {
        if (shouldSkip(document.body)) {
            return;
        }

        guiBox = document.createElement('div');
        guiBox.classList.add('mui-box', 'mui-hidden');
        document.body.appendChild(guiBox);
        displayRules();

        fab = document.createElement('button');
        fab.textContent = '+';
        fab.classList.add('mui-fab', 'mui-hidden');
        fab.addEventListener('click', addRule);
        document.body.appendChild(fab);

        const toggleButton = document.createElement('div');
        toggleButton.classList.add('mui-toggle');
        toggleButton.textContent = '☰';
        toggleButton.addEventListener('click', toggleGUI);
        document.body.appendChild(toggleButton);
    }

    /* ------------------- MATERIAL YOU STYLES ------------------- */
    function applyMaterialYouStyles() {
        if (shouldSkip(document.body)) {
            return;
        }
        const style = document.createElement('style');
        style.textContent = `
            .mui-box {
                position: fixed;
                top: 50%;
                left: 60px;
                transform: translateY(-50%);
                width: 280px;
                background: white;
                color: #000;
                padding: 20px;
                border-radius: 16px;
                box-shadow: 0px 4px 12px rgba(0, 0, 0, 0.3);
                z-index: 10000;
                max-height: 80vh;
                overflow-y: auto;
            }
            .mui-card {
                background: var(--md-sys-color-surface, #222);
                color: var(--md-sys-color-on-surface, #fff);
                border-radius: 16px;
                box-shadow: 0px 2px 8px rgba(0, 0, 0, 0.2);
                padding: 16px;
                margin: 8px 0;
                display: flex;
                justify-content: space-between;
                align-items: center;
                transition: transform 0.2s ease-in-out;
            }
            .mui-card:hover {
                transform: scale(1.02);
            }
            .mui-button {
                background: var(--md-sys-color-primary, #6200EE);
                color: #fff;
                border: none;
                border-radius: 24px;
                padding: 10px 16px;
                font-size: 14px;
                cursor: pointer;
                transition: background 0.3s ease;
                margin-top: 8px;
            }
            .mui-button:hover {
                background: var(--md-sys-color-primary-dark, #3700B3);
            }
            .mui-fab {
                position: fixed;
                bottom: 20px;
                right: 20px;
                width: 56px;
                height: 56px;
                background: var(--md-sys-color-primary, #6200EE);
                color: #fff;
                border-radius: 50%;
                box-shadow: 0px 4px 10px rgba(0,0,0,0.3);
                display: flex;
                justify-content: center;
                align-items: center;
                font-size: 24px;
                cursor: pointer;
                transition: background 0.3s ease, transform 0.2s;
                z-index: 10002;
            }
            .mui-fab:hover {
                background: var(--md-sys-color-primary-dark, #3700B3);
                transform: scale(1.1);
            }
            .mui-hidden {
                display: none !important;
            }
            .mui-toggle {
                position: fixed;
                top: 50%;
                left: 20px;
                transform: translateY(-50%);
                width: 40px;
                height: 40px;
                background: rgba(0, 0, 0, 0.1);
                border-radius: 50%;
                cursor: pointer;
                transition: background 0.2s;
                border: 1px solid rgba(0, 0, 0, 0.3);
                z-index: 10001;
                text-align: center;
                line-height: 40px;
                font-size: 24px;
                color: rgba(255,255,255,0.9);
            }
            .mui-toggle:hover {
                background: rgba(0, 0, 0, 0.2);
            }
        `;
        document.head.appendChild(style);
    }

    /* ------------------- INITIALIZATION ------------------- */
    async function main() {
        if (BLACKLISTED_SITES.includes(window.location.hostname)) {
            console.log("Text Replacer: Site is blacklisted. Script is inactive.");
            return;
        }

        try {
            await initDB();
            await loadReplacementsFromDB();
        } catch (e) {
            console.error("Error initializing storage:", e);
        }
        applyMaterialYouStyles();
        createGUI();
        runReplacements();
    }
    main();

})();