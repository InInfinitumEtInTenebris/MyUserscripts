// ==UserScript==
// @name         Text Replacer11ZInd (Material You, Text File Import/Export, Infinite Storage)
// @namespace    http://tampermonkey.net/
// @version      3.2.2-modInf-zindex-fix
// @description  Dynamically replaces text using a Material You GUI with text file import/export and case-sensitive toggling. Now uses IndexedDB for storage so that the total rules list can grow arbitrarily large. Uses debounced replacement on added/removed nodes (no characterData observation) and skips non‑content elements. Ensures GUI elements stay on top.
// @match        *://*/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // Inject custom CSS to override potential page styles
    function addGlobalStyles() {
        const style = document.createElement('style');
        style.textContent = `
            /* Use custom class names to avoid conflicts */
            .text-replacer-box, .text-replacer-fab {
                position: fixed !important;
                z-index: 2147483647 !important;
                display: block !important;
                pointer-events: auto !important;
            }
        `;
        document.head.appendChild(style);
    }
    addGlobalStyles();

    // Global object to store rules in memory.
    // Each rule is stored as: { oldText, newText, caseSensitive, site }
    let replacements = {};
    let guiBox;
    let fab;
    let isGuiOpen = false;

    // A WeakMap to store each text node’s original content.
    const originalTextMap = new WeakMap();
    let observerTimeout = null;

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

    // Only load valid rules: rule.newText must be a string and rule.oldText non-empty.
    function loadReplacementsFromDB() {
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], "readonly");
            const store = transaction.objectStore(STORE_NAME);
            const request = store.getAll();
            request.onsuccess = function(e) {
                const result = e.target.result;
                replacements = {};
                result.forEach(rule => {
                    if (
                        rule &&
                        typeof rule.newText === "string" &&
                        rule.oldText &&
                        rule.oldText.trim() !== ""
                    ) {
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
    // Skips nodes inside our GUI as well as common non‑content tags.
    function shouldSkip(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            if (!node.parentElement) return true;
            // Check if the node or its parent is part of our GUI using custom classes
            if (node.parentElement.closest('.text-replacer-box, .text-replacer-fab')) return true;
            const tag = node.parentElement.tagName;
            if (['HEAD', 'SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE'].includes(tag)) return true;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.closest('.text-replacer-box, .text-replacer-fab')) return true;
            if (['HEAD', 'SCRIPT', 'STYLE'].includes(node.tagName)) return true;
        }
        return false;
    }

    /* ------------------- TEXT REPLACEMENT ------------------- */
    function escapeRegExp(string) {
        // Escape characters with special meaning in regex
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function replaceText(node) {
        if (shouldSkip(node)) return; // Skip GUI elements and non-content tags

        if (node.nodeType === Node.TEXT_NODE) {
            // Store original content if not already stored
            if (!originalTextMap.has(node)) {
                originalTextMap.set(node, node.nodeValue);
            }

            const baseText = originalTextMap.get(node);
            let updatedText = baseText;

            for (const [oldTxt, rule] of Object.entries(replacements)) {
                // Only apply rule if it is for the current site.
                if (rule.site !== window.location.hostname) continue;

                // Ensure rule and newText are valid
                if (!rule || typeof rule.newText !== 'string') continue;

                const { newText, caseSensitive } = rule;
                // Use word boundaries to replace whole words only
                const pattern = new RegExp('\\b' + escapeRegExp(oldTxt) + '\\b', caseSensitive ? 'g' : 'gi');
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

    // Observer for debounced text replacement on added nodes
    const observer = new MutationObserver((mutationsList) => {
        if (observerTimeout) clearTimeout(observerTimeout);
        observerTimeout = setTimeout(() => {
            let needsReplacement = false;
            for (const mutation of mutationsList) {
                if (mutation.type === 'childList') {
                    for (const node of mutation.addedNodes) {
                        if (!shouldSkip(node)) {
                            needsReplacement = true;
                            break;
                        }
                    }
                }
                if (needsReplacement) break;
            }
            if (needsReplacement) {
                runReplacements();
            }
        }, 500);
    });

    if (document.body) {
         observer.observe(document.body, { childList: true, subtree: true });
    } else {
         window.addEventListener('DOMContentLoaded', () => {
             observer.observe(document.body, { childList: true, subtree: true });
         });
    }

    /* ------------------- HANDLE PAGINATED CONTENT / SPA NAVIGATION ------------------- */
    let lastUrl = location.href;
    new MutationObserver(() => {
      const url = location.href;
      if (url !== lastUrl) {
        lastUrl = url;
        setTimeout(runReplacements, 500);
      }
    }).observe(document, { subtree: true, childList: true });

    window.addEventListener('popstate', () => setTimeout(runReplacements, 500));
    const originalPushState = history.pushState;
    history.pushState = function(...args) {
        originalPushState.apply(history, args);
        setTimeout(runReplacements, 500);
    };
    const originalReplaceState = history.replaceState;
    history.replaceState = function(...args) {
        originalReplaceState.apply(history, args);
        setTimeout(runReplacements, 500);
    };

    /* ------------------- GUI FUNCTIONS ------------------- */
    function createGUI() {
        // Create the GUI container using a custom class name
        guiBox = document.createElement('div');
        guiBox.className = 'text-replacer-box';
        Object.assign(guiBox.style, {
            top: '50px',
            right: '20px',
            width: '300px',
            maxHeight: '80vh',
            overflowY: 'auto',
            backgroundColor: 'white',
            border: '1px solid #ccc',
            padding: '10px',
            boxShadow: '0 0 10px rgba(0,0,0,0.5)',
            display: 'none'
        });
        document.body.appendChild(guiBox);

        // Create the floating action button (FAB)
        fab = document.createElement('div');
        fab.className = 'text-replacer-fab';
        Object.assign(fab.style, {
            bottom: '20px',
            right: '20px',
            width: '50px',
            height: '50px',
            borderRadius: '50%',
            backgroundColor: '#6200ea',
            color: 'white',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '24px',
            cursor: 'pointer'
        });
        fab.textContent = '📝';
        fab.title = 'Toggle Text Replacer GUI';
        fab.addEventListener('click', () => {
            isGuiOpen = !isGuiOpen;
            guiBox.style.display = isGuiOpen ? 'block' : 'none';
        });
        document.body.appendChild(fab);
    }

    function displayRules() {
        if (!guiBox) return;
        guiBox.innerHTML = '';

        const title = document.createElement('h2');
        title.textContent = `Replacements for ${window.location.hostname}`;
        title.style.marginTop = '0';
        title.style.fontSize = '18px';
        guiBox.appendChild(title);

        const currentSiteRules = Object.entries(replacements)
            .filter(([_, rule]) => rule.site === window.location.hostname)
            .sort(([oldA], [oldB]) => oldA.localeCompare(oldB));

        if (currentSiteRules.length === 0) {
             const noRulesMsg = document.createElement('p');
             noRulesMsg.textContent = 'No rules defined for this site yet.';
             noRulesMsg.style.fontStyle = 'italic';
             guiBox.appendChild(noRulesMsg);
        } else {
            currentSiteRules.forEach(([oldText, rule]) => {
                const { newText, caseSensitive } = rule;
                const ruleDiv = document.createElement('div');
                ruleDiv.classList.add('mui-card');

                const ruleText = document.createElement('span');
                ruleText.innerHTML = `"${oldText}" → "${newText}" <small>(${caseSensitive ? "Case-Sensitive" : "Case-Insensitive"})</small>`;
                ruleText.style.flexGrow = '1';
                ruleText.style.marginRight = '10px';
                ruleText.style.wordBreak = 'break-all';

                const buttonContainer = document.createElement('div');
                buttonContainer.style.display = 'flex';
                buttonContainer.style.gap = '5px';
                buttonContainer.style.flexShrink = '0';

                const editButton = document.createElement('button');
                editButton.textContent = '✏️';
                editButton.title = 'Edit Rule';
                editButton.classList.add('mui-button', 'mui-button-icon');
                editButton.addEventListener('click', (e) => {
                     e.stopPropagation();
                     editRule(oldText);
                });

                const deleteButton = document.createElement('button');
                deleteButton.textContent = '🗑️';
                deleteButton.title = 'Delete Rule';
                deleteButton.classList.add('mui-button', 'mui-button-icon', 'mui-button-danger');
                deleteButton.addEventListener('click', (e) => {
                     e.stopPropagation();
                     deleteRule(oldText);
                });

                buttonContainer.appendChild(editButton);
                buttonContainer.appendChild(deleteButton);
                ruleDiv.appendChild(ruleText);
                ruleDiv.appendChild(buttonContainer);

                guiBox.appendChild(ruleDiv);
            });
       }

        const actionsDiv = document.createElement('div');
        actionsDiv.style.marginTop = '20px';
        actionsDiv.style.display = 'flex';
        actionsDiv.style.gap = '10px';
        actionsDiv.style.flexWrap = 'wrap';

        const exportButton = document.createElement('button');
        exportButton.textContent = '📤 Export All Rules';
        exportButton.title = 'Export all rules to a text file';
        exportButton.classList.add('mui-button');
        exportButton.addEventListener('click', exportRules);
        actionsDiv.appendChild(exportButton);

        const importButton = document.createElement('button');
        importButton.textContent = '📥 Import Rules';
        importButton.title = 'Import rules from a text file (adds to current site)';
        importButton.classList.add('mui-button');
        importButton.addEventListener('click', importRules);
        actionsDiv.appendChild(importButton);

        guiBox.appendChild(actionsDiv);
    }

    /* ------------------- RULE ADD/EDIT/DELETE ------------------- */
    async function addRule() {
        const oldText = prompt("Enter the exact text to replace:", "");
        if (oldText === null || oldText.trim() === "") {
            return;
        }
        const newText = prompt(`Enter the text to replace "${oldText}" with:`, "");
        if (newText === null) return;

        const caseSensitive = confirm("Should this replacement be case-sensitive?\n(OK = Yes, Cancel = No)");

        const trimmedOldText = oldText.trim();
        const rule = {
            newText: newText,
            caseSensitive,
            site: window.location.hostname
        };

        replacements[trimmedOldText] = rule;
        try {
            await saveRuleToDB(trimmedOldText, rule);
            displayRules();
            runReplacements();
        } catch (e) {
            console.error("Error saving rule:", e);
            alert("Error saving rule. Check console for details.");
        }
    }

    async function editRule(oldText) {
        const rule = replacements[oldText];
        if (!rule) {
            alert("Rule not found for editing.");
            return;
        }

        const { newText, caseSensitive } = rule;
        const updatedOld = prompt("Edit the text to replace:", oldText);
        if (updatedOld === null) return;
        const trimmedUpdatedOld = updatedOld.trim();
        if (!trimmedUpdatedOld) {
            alert("The text to replace cannot be empty.");
            return;
        }

        const updatedNew = prompt(`Edit the replacement text for "${trimmedUpdatedOld}":`, newText);
        if (updatedNew === null) return;
        const updatedCaseSensitive = confirm("Should this updated rule be case-sensitive?\n(OK = Yes, Cancel = No)");

        const updatedRule = {
            newText: updatedNew,
            caseSensitive: updatedCaseSensitive,
            site: window.location.hostname
        };

        try {
            if (trimmedUpdatedOld !== oldText) {
                await deleteRuleFromDB(oldText);
                delete replacements[oldText];
            }
            replacements[trimmedUpdatedOld] = updatedRule;
            await saveRuleToDB(trimmedUpdatedOld, updatedRule);
            displayRules();
            runReplacements();
        } catch (e) {
            console.error("Error updating rule:", e);
            alert("Error updating rule. Check console for details.");
        }
    }

    async function deleteRule(oldText) {
        if (confirm(`Are you sure you want to delete the rule that replaces "${oldText}"?`)) {
            try {
                await deleteRuleFromDB(oldText);
                delete replacements[oldText];
                displayRules();
                runReplacements();
            } catch (e) {
                console.error("Error deleting rule:", e);
                alert("Error deleting rule. Check console for details.");
            }
        }
    }

    /* ------------------- TEXT FILE IMPORT/EXPORT ------------------- */
    function exportRules() {
        let exportData = [];
        for (const [oldText, rule] of Object.entries(replacements)) {
             exportData.push({
                old: oldText,
                new: rule.newText,
                cs: rule.caseSensitive,
                site: rule.site
             });
         }

        if (exportData.length === 0) {
            alert("No rules to export.");
            return;
        }

        const exportJson = JSON.stringify(exportData, null, 2);
        const blob = new Blob([exportJson], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        const dateStr = new Date().toISOString().slice(0, 10);
        a.download = `text_replacer_rules_${dateStr}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);
    }

    function importRules() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json, .txt';
        input.addEventListener('change', function(event) {
            const file = event.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = async function(e) {
                const content = e.target.result;
                let importedCount = 0;
                let errorCount = 0;

                try {
                    let rulesToImport = [];
                    if (file.name.endsWith('.json')) {
                        const importedData = JSON.parse(content);
                        if (!Array.isArray(importedData)) {
                             throw new Error("JSON file is not a valid array of rules.");
                        }
                        importedData.forEach(item => {
                            // Validate that old (the text to replace) is non-empty.
                            if (
                                typeof item.old === 'string' &&
                                item.old.trim() !== "" &&
                                typeof item.new === 'string' &&
                                typeof item.cs === 'boolean'
                            ) {
                                 rulesToImport.push({
                                    oldText: item.old.trim(),
                                    newText: item.new,
                                    caseSensitive: item.cs,
                                    site: window.location.hostname
                                 });