// ==UserScript==
// @name         Text Replacer7 (Material You, Text File Import/Export, Case Sensitivity)
// @namespace    http://tampermonkey.net/
// @version      3.2.1-mod
// @description  Dynamically replaces text with a Material You GUI, text file–based import/export, and case-sensitive toggle per rule. Rule adding now uses separate prompts for "old text" and "new text". Also supports dynamic reloading of replacements for additions and deletions.
// @match        *://*/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    let replacements = {};
    let guiBox;
    let fab;
    let isGuiOpen = false;

    // A WeakMap to store original text for each text node.
    const originalTextMap = new WeakMap();

    /* ------------------- STORAGE ------------------- */
    // Remove any corrupted entries from the stored replacements.
    function sanitizeReplacements() {
        for (const key in replacements) {
            const rule = replacements[key];
            if (!rule || typeof rule.newText !== 'string') {
                console.warn("Corrupted rule found for key:", key, "removing.");
                delete replacements[key];
            } else {
                // Ensure caseSensitive is a boolean.
                if (typeof rule.caseSensitive !== 'boolean') {
                    rule.caseSensitive = false;
                }
            }
        }
    }
    
    function loadReplacements() {
        const stored = localStorage.getItem('textReplacements');
        if (stored) {
            try {
                replacements = JSON.parse(stored);
                sanitizeReplacements();
            } catch (e) {
                console.error("Error parsing stored replacements:", e);
                replacements = {};
            }
        }
    }
    function saveReplacements() {
        localStorage.setItem('textReplacements', JSON.stringify(replacements));
    }

    /* ------------------- TEXT REPLACEMENT ------------------- */
    function escapeRegExp(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    function replaceText(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            // Save the original text if not already stored.
            if (!originalTextMap.has(node)) {
                originalTextMap.set(node, node.nodeValue);
            }
            // Always start from the original text so that removals or edits of rules recalc correctly.
            let baseText = originalTextMap.get(node);
            let updatedText = baseText;
            for (const [oldTxt, rule] of Object.entries(replacements)) {
                if (!rule || typeof rule.newText !== 'string') continue;
                const { newText: replacement, caseSensitive } = rule;
                // Wrap with word boundaries to ensure whole-word matching.
                const pattern = new RegExp('\\b' + escapeRegExp(oldTxt) + '\\b', caseSensitive ? 'g' : 'gi');
                updatedText = updatedText.replace(pattern, replacement);
            }
            node.nodeValue = updatedText;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            node.childNodes.forEach(child => replaceText(child));
        }
    }
    function runReplacements() {
        replaceText(document.body);
    }
    // Enhanced observer: now listening for child additions and any characterData modifications.
    const observer = new MutationObserver(mutations => {
        mutations.forEach(mutation => {
            // If text content changes, update that node.
            if (mutation.type === 'characterData' && mutation.target.nodeType === Node.TEXT_NODE) {
                // If the text node changed externally, update its original value.
                originalTextMap.set(mutation.target, mutation.target.nodeValue);
                replaceText(mutation.target);
            }
            // For newly added nodes, process their text.
            mutation.addedNodes.forEach(node => {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    replaceText(node);
                } else if (node.nodeType === Node.TEXT_NODE) {
                    // Store original text for new text nodes.
                    if (!originalTextMap.has(node)) {
                        originalTextMap.set(node, node.nodeValue);
                    }
                    replaceText(node);
                }
            });
        });
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    /* ------------------- GUI FUNCTIONS ------------------- */
    function displayRules() {
        if (!guiBox) return;
        guiBox.innerHTML = '';

        const title = document.createElement('h2');
        title.textContent = 'Text Replacer Rules';
        guiBox.appendChild(title);

        for (const oldText in replacements) {
            const { newText, caseSensitive } = replacements[oldText];
            const ruleDiv = document.createElement('div');
            ruleDiv.classList.add('mui-card');

            const ruleText = document.createElement('span');
            ruleText.innerHTML = `<strong>"${oldText}" → "${newText}"</strong> (${caseSensitive ? "Case-Sensitive" : "Case-Insensitive"})`;
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

    /* ------------------- UPDATED RULE ADDING ------------------- */
    // Separate prompts for original and replacement text.
    function addRule() {
        const oldText = prompt("Enter the text to replace:", "");
        if (oldText === null || oldText.trim() === "") {
            alert("You must provide the text to replace.");
            return;
        }
        const newText = prompt("Enter the replacement text:", "");
        if (newText === null) return;
        const caseSensitive = confirm("Should this replacement be case-sensitive?");
        replacements[oldText.trim()] = { newText: newText.trim(), caseSensitive };
        saveReplacements();
        alert("Replacement rule added.");
        displayRules();
        runReplacements();
    }

    function editRule(oldText) {
        const rule = replacements[oldText];
        if (!rule) {
            alert("Rule not found.");
            return;
        }
        const { newText, caseSensitive } = rule;
        const updatedOld = prompt("Edit original text:", oldText);
        if (updatedOld === null) return;
        const updatedNew = prompt("Edit replacement text:", newText);
        if (updatedNew === null) return;
        const updatedCaseSensitive = confirm("Should this rule be case-sensitive?");
        if (updatedOld.trim() && updatedNew.trim()) {
            delete replacements[oldText];
            replacements[updatedOld.trim()] = { newText: updatedNew.trim(), caseSensitive: updatedCaseSensitive };
            saveReplacements();
            alert("Rule updated.");
            displayRules();
            runReplacements();
        } else {
            alert("Both values must be non-empty.");
        }
    }

    function deleteRule(oldText) {
        if (confirm(`Delete rule "${oldText}"?`)) {
            delete replacements[oldText];
            saveReplacements();
            alert("Rule deleted.");
            displayRules();
            runReplacements();
        }
    }

    /* ------------------- TEXT FILE IMPORT/EXPORT ------------------- */
    function exportRules() {
        let exportText = "";
        for (const [oldText, rule] of Object.entries(replacements)) {
            exportText += `${oldText}:${rule.newText}:${rule.caseSensitive ? "1" : "0"}\n`;
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
                reader.onload = function(e) {
                    const lines = e.target.result.split("\n");
                    for (let line of lines) {
                        const parts = line.split(":");
                        if (parts.length === 3) {
                            const oldText = parts[0].trim();
                            const newText = parts[1].trim();
                            const caseSensitive = parts[2].trim() === "1";
                            if (oldText && newText !== undefined) {
                                replacements[oldText] = { newText, caseSensitive };
                            }
                        }
                    }
                    sanitizeReplacements();
                    saveReplacements();
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
        // Create the main GUI panel.
        guiBox = document.createElement('div');
        guiBox.classList.add('mui-box', 'mui-hidden');
        document.body.appendChild(guiBox);
        displayRules();

        // Create the Floating Action Button (FAB) for adding a new rule.
        fab = document.createElement('button');
        fab.textContent = '+';
        fab.classList.add('mui-fab', 'mui-hidden');
        fab.addEventListener('click', addRule);
        document.body.appendChild(fab);

        // Create the transparent toggle button (hamburger icon) on the left middle side.
        const toggleButton = document.createElement('div');
        toggleButton.classList.add('mui-toggle');
        toggleButton.textContent = '☰';
        toggleButton.addEventListener('click', toggleGUI);
        document.body.appendChild(toggleButton);
    }

    /* ------------------- MATERIAL YOU STYLES ------------------- */
    function applyMaterialYouStyles() {
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

    /* ------------------- INITIALIZE ------------------- */
    loadReplacements();
    applyMaterialYouStyles();
    createGUI();
    runReplacements();
})();