// ==UserScript==
// @name         Text Replacer11ZInd (Material You, Text File Import/Export, Infinite Storage)
// @namespace    http://tampermonkey.net/
// @version      3.2.2-modInf-zindex
// @description  Dynamically replaces text using a Material You GUI with text file import/export and case-sensitive toggling. Now uses IndexedDB for storage so that the total rules list can grow arbitrarily large. Uses debounced replacement on added/removed nodes (no characterData observation) and skips non‑content elements. Ensures GUI elements stay on top.
// @match        *://*/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

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
    // Skips nodes inside our GUI as well as common non‑content tags.
    function shouldSkip(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            if (!node.parentElement) return true;
            // Check if the node or its parent is part of the script's GUI
            if (node.parentElement.closest('.mui-box, .mui-toggle, .mui-fab')) return true;
            const tag = node.parentElement.tagName;
            if (['HEAD', 'SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE'].includes(tag)) return true;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            // Check if the element itself is part of the script's GUI
            if (node.closest('.mui-box, .mui-toggle, .mui-fab')) return true;
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
            // If we haven't yet stored its original content, do so.
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
                // Escape the old text for use in RegExp
                const pattern = new RegExp('\\b' + escapeRegExp(oldTxt) + '\\b', caseSensitive ? 'g' : 'gi');
                updatedText = updatedText.replace(pattern, newText);
            }

            // Update the node value only if it has actually changed.
            if (node.nodeValue !== updatedText) {
                node.nodeValue = updatedText;
            }
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            // Recursively process child nodes
            node.childNodes.forEach(child => replaceText(child));
        }
    }


    function runReplacements() {
        replaceText(document.body);
    }

    // Observer now only watches for childList mutations (node additions/removals) with a 500ms debounce.
    const observer = new MutationObserver((mutationsList) => {
        // Debounce the replacement logic
        if (observerTimeout) clearTimeout(observerTimeout);
        observerTimeout = setTimeout(() => {
            // Check if any added nodes are outside the GUI before running full replacements
            let needsReplacement = false;
            for (const mutation of mutationsList) {
                if (mutation.type === 'childList') {
                    for (const node of mutation.addedNodes) {
                         if (!shouldSkip(node)) { // Only trigger if added node is not part of GUI
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
        }, 500); // 500ms debounce interval
    });


    // Observe the body for additions/removals of nodes in the subtree
    if (document.body) {
         observer.observe(document.body, { childList: true, subtree: true });
    } else {
         // Fallback if body isn't ready immediately (though @run-at document-end should prevent this)
         window.addEventListener('DOMContentLoaded', () => {
             observer.observe(document.body, { childList: true, subtree: true });
         });
    }


    /* ------------------- HANDLE PAGINATED CONTENT / SPA NAVIGATION ------------------- */
    // Function to re-run replacements when URL changes (e.g., in Single Page Applications).
    let lastUrl = location.href;
    new MutationObserver(() => {
      const url = location.href;
      if (url !== lastUrl) {
        lastUrl = url;
        // Needs a slight delay to allow SPA frameworks to update the DOM
        setTimeout(runReplacements, 500);
      }
    }).observe(document, { subtree: true, childList: true });

    // Also listen for explicit history changes
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
    function displayRules() {
        if (!guiBox) return;
        guiBox.innerHTML = ''; // Clear previous content

        const title = document.createElement('h2');
        title.textContent = `Replacements for ${window.location.hostname}`;
        title.style.marginTop = '0'; // Adjust title spacing
        title.style.fontSize = '18px';
        guiBox.appendChild(title);

        // Filter and sort rules for the current site alphabetically by oldText
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
                ruleText.style.flexGrow = '1'; // Allow text to take available space
                ruleText.style.marginRight = '10px'; // Space before buttons
                 ruleText.style.wordBreak = 'break-all'; // Prevent long text overflow

                const buttonContainer = document.createElement('div');
                buttonContainer.style.display = 'flex'; // Align buttons horizontally
                buttonContainer.style.gap = '5px'; // Space between buttons
                buttonContainer.style.flexShrink = '0'; // Prevent buttons from shrinking

                const editButton = document.createElement('button');
                editButton.textContent = '✏️'; // Using emoji for compactness
                editButton.title = 'Edit Rule'; // Tooltip
                editButton.classList.add('mui-button', 'mui-button-icon');
                editButton.addEventListener('click', (e) => {
                     e.stopPropagation(); // Prevent triggering card click if any
                     editRule(oldText);
                });

                const deleteButton = document.createElement('button');
                deleteButton.textContent = '🗑️'; // Using emoji
                deleteButton.title = 'Delete Rule'; // Tooltip
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


        // Add Import/Export buttons at the bottom
        const actionsDiv = document.createElement('div');
        actionsDiv.style.marginTop = '20px';
        actionsDiv.style.display = 'flex';
        actionsDiv.style.gap = '10px'; // Space between buttons
        actionsDiv.style.flexWrap = 'wrap'; // Wrap if needed

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
            // alert("Replacement text cannot be empty."); // Avoid alert annoyance
            return;
        }
        const newText = prompt(`Enter the text to replace "${oldText}" with:`, "");
        if (newText === null) return; // User cancelled new text prompt

        const caseSensitive = confirm("Should this replacement be case-sensitive?\n(OK = Yes, Cancel = No)");

        const trimmedOldText = oldText.trim();
        const rule = {
            newText: newText, // Allow empty string as replacement, don't trim
            caseSensitive,
            site: window.location.hostname
        };

        replacements[trimmedOldText] = rule; // Update in-memory store
        try {
            await saveRuleToDB(trimmedOldText, rule); // Save to IndexedDB
            // No need for alert, UI update is sufficient feedback
            displayRules(); // Refresh the GUI list
            runReplacements(); // Re-run replacements on the page
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
        if (updatedOld === null) return; // User cancelled
        const trimmedUpdatedOld = updatedOld.trim();
        if (!trimmedUpdatedOld) {
            alert("The text to replace cannot be empty.");
            return;
        }


        const updatedNew = prompt(`Edit the replacement text for "${trimmedUpdatedOld}":`, newText);
        if (updatedNew === null) return; // User cancelled

        const updatedCaseSensitive = confirm("Should this updated rule be case-sensitive?\n(OK = Yes, Cancel = No)");

        // Prepare the updated rule object
        const updatedRule = {
            newText: updatedNew, // Don't trim replacement text
            caseSensitive: updatedCaseSensitive,
            site: window.location.hostname // Ensure site is correct
        };

        try {
            // If the 'oldText' key changed, we need to delete the old record and add a new one
            if (trimmedUpdatedOld !== oldText) {
                await deleteRuleFromDB(oldText); // Delete the old entry
                 delete replacements[oldText]; // Remove old entry from memory
            }
            // Add/update the rule in memory and DB
            replacements[trimmedUpdatedOld] = updatedRule;
            await saveRuleToDB(trimmedUpdatedOld, updatedRule);
            // No alert needed
            displayRules(); // Refresh UI
            runReplacements(); // Apply changes
        } catch (e) {
            console.error("Error updating rule:", e);
            alert("Error updating rule. Check console for details.");
        }

    }

    async function deleteRule(oldText) {
        if (confirm(`Are you sure you want to delete the rule that replaces "${oldText}"?`)) {
            try {
                await deleteRuleFromDB(oldText); // Remove from DB
                delete replacements[oldText]; // Remove from memory
                // No alert needed
                displayRules(); // Refresh UI
                runReplacements(); // Revert text on page
            } catch (e) {
                console.error("Error deleting rule:", e);
                alert("Error deleting rule. Check console for details.");
            }
        }
    }

    /* ------------------- TEXT FILE IMPORT/EXPORT ------------------- */
    function exportRules() {
        // Export *all* rules from memory, regardless of site
        let exportData = [];
         for (const [oldText, rule] of Object.entries(replacements)) {
             exportData.push({
                old: oldText,
                new: rule.newText,
                cs: rule.caseSensitive,
                site: rule.site // Include site in export
             });
         }

        if (exportData.length === 0) {
            alert("No rules to export.");
            return;
        }

        // Use JSON for more robust import/export
        const exportJson = JSON.stringify(exportData, null, 2); // Pretty print JSON
        const blob = new Blob([exportJson], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        // Include date in filename
        const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
        a.download = `text_replacer_rules_${dateStr}.json`;
        document.body.appendChild(a); // Required for Firefox
        a.click();
        document.body.removeChild(a); // Clean up
        URL.revokeObjectURL(a.href); // Free memory
    }

    function importRules() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json, .txt'; // Accept JSON and legacy TXT
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
                         // Handle JSON import
                        const importedData = JSON.parse(content);
                        if (!Array.isArray(importedData)) {
                             throw new Error("JSON file is not a valid array of rules.");
                        }
                        importedData.forEach(item => {
                            // Basic validation
                            if (typeof item.old === 'string' && typeof item.new === 'string' && typeof item.cs === 'boolean') {
                                 rulesToImport.push({
                                    oldText: item.old.trim(),
                                   