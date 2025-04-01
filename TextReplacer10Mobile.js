// ==UserScript==
// @name         Text Replacer10 (Mobile-Optimized – Forced Toggle Visibility)
// @namespace    http://tampermonkey.net/
// @version      3.2.1-mod9
// @description  Replaces text using a Material You GUI with text file import/export and case-sensitive toggling. This version forces the toggle icon to be visible on mobile by using !important rules.
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // Storage for replacement rules.
    let replacements = {};
    let guiBox, fab, toggleButton;
    let isGuiOpen = false;
    const originalTextMap = new WeakMap();
    let observerTimeout = null;

    // STORAGE FUNCTIONS
    function sanitizeReplacements() {
        for (const key in replacements) {
            const rule = replacements[key];
            if (!rule || typeof rule.newText !== 'string') {
                delete replacements[key];
            } else if (typeof rule.caseSensitive !== 'boolean') {
                rule.caseSensitive = false;
            }
        }
    }
    function loadReplacements() {
        replacements = GM_getValue('textReplacements', {});
        sanitizeReplacements();
    }
    function saveReplacements() {
        GM_setValue('textReplacements', replacements);
    }

    // HELPER: Skip non-content nodes and our own GUI.
    function shouldSkip(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            if (!node.parentElement) return true;
            if (node.parentElement.closest('.tr10-box, .tr10-toggle, .tr10-fab')) return true;
            const tag = node.parentElement.tagName;
            if (['HEAD', 'SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE'].includes(tag)) return true;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.closest('.tr10-box, .tr10-toggle, .tr10-fab')) return true;
            if (['HEAD', 'SCRIPT', 'STYLE'].includes(node.tagName)) return true;
        }
        return false;
    }

    // TEXT REPLACEMENT FUNCTIONS
    function escapeRegExp(string) {
        return string.replace(/[.*+?^${}()|[\/g, '\\$&');
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
                const { newText, caseSensitive } = rule;
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
    // Debounced MutationObserver to re-run replacements.
    const observer = new MutationObserver(() => {
        if (observerTimeout) clearTimeout(observerTimeout);
        observerTimeout = setTimeout(runReplacements, 500);
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // HANDLE PAGINATED CONTENT: re-run on URL changes.
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

    // GUI FUNCTIONS
    function displayRules() {
        if (!guiBox) return;
        guiBox.innerHTML = '';
        const title = document.createElement('h2');
        title.textContent = 'Text Replacer Rules';
        guiBox.appendChild(title);
        for (const oldText in replacements) {
            const rule = replacements[oldText];
            if (rule.site !== window.location.hostname) continue;
            const { newText, caseSensitive } = rule;
            const ruleDiv = document.createElement('div');
            ruleDiv.classList.add('tr10-card');
            const ruleText = document.createElement('span');
            ruleText.innerHTML = `<strong>"${oldText}" → "${newText}"</strong> (${caseSensitive ? "Case-Sensitive" : "Case-Insensitive"})`;
            ruleDiv.appendChild(ruleText);
            const buttonContainer = document.createElement('div');
            const editButton = document.createElement('button');
            editButton.textContent = '✏️ Edit';
            editButton.classList.add('tr10-button');
            editButton.addEventListener('click', () => editRule(oldText));
            const deleteButton = document.createElement('button');
            deleteButton.textContent = '🗑️ Delete';
            deleteButton.classList.add('tr10-button');
            deleteButton.addEventListener('click', () => deleteRule(oldText));
            buttonContainer.appendChild(editButton);
            buttonContainer.appendChild(deleteButton);
            ruleDiv.appendChild(buttonContainer);
            guiBox.appendChild(ruleDiv);
        }
        const exportButton = document.createElement('button');
        exportButton.textContent = '📤 Export Rules (File)';
        exportButton.classList.add('tr10-button');
        exportButton.addEventListener('click', exportRules);
        guiBox.appendChild(exportButton);
        const importButton = document.createElement('button');
        importButton.textContent = '📥 Import Rules (File)';
        importButton.classList.add('tr10-button');
        importButton.addEventListener('click', importRules);
        guiBox.appendChild(importButton);
    }
    function addRule() {
        const oldText = prompt("Enter the text to replace:", "");
        if (!oldText || !oldText.trim()) {
            alert("You must provide the text to replace.");
            return;
        }
        const newText = prompt("Enter the replacement text:", "");
        if (newText === null) return;
        const caseSensitive = confirm("Should this replacement be case-sensitive?");
        replacements[oldText.trim()] = { 
            newText: newText.trim(), 
            caseSensitive, 
            site: window.location.hostname 
        };
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
            replacements[updatedOld.trim()] = { 
                newText: updatedNew.trim(), 
                caseSensitive: updatedCaseSensitive,
                site: window.location.hostname 
            };
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
    // IMPORT/EXPORT FUNCTIONS
    function exportRules() {
        let exportText = "";
        for (const [oldText, rule] of Object.entries(replacements)) {
            exportText += `${oldText} : ${rule.newText} (${rule.caseSensitive ? "Case-Sensitive" : "Case-Insensitive"}) - ${rule.site}\n`;
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
                        // Expected format: term : replacement (Case-Sensitive/Case-Insensitive) - website
                        const [termPart, websitePart] = line.split(" - ");
                        if (!termPart || !websitePart) continue;
                        const termSplit = termPart.split(" : ");
                        if (termSplit.length !== 2) continue;
                        const oldText = termSplit[0].trim();
                        const replacementPart = termSplit[1].trim();
                        const match = replacementPart.match(/^(.*)(Case-Sensitive|Case-Insensitive)$/);
                        if (!match) continue;
                        const newText = match[1].trim();
                        const caseSensitive = match[2] === "Case-Sensitive";
                        replacements[oldText] = { 
                            newText, 
                            caseSensitive, 
                            site: window.location.hostname 
                        };
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
    // GUI TOGGLE FUNCTION
    function toggleGUI() {
        isGuiOpen = !isGuiOpen;
        guiBox.classList.toggle('tr10-hidden', !isGuiOpen);
        fab.classList.toggle('tr10-hidden', !isGuiOpen);
    }
    // CREATE THE GUI ELEMENTS
    function createGUI() {
        guiBox = document.createElement('div');
        guiBox.className = 'tr10-box tr10-hidden';
        document.body.appendChild(guiBox);
        displayRules();
        fab = document.createElement('button');
        fab.textContent = '+';
        fab.className = 'tr10-fab tr10-hidden';
        fab.addEventListener('click', addRule);
        document.body.appendChild(fab);
        toggleButton = document.createElement('div');
        toggleButton.className = 'tr10-toggle';
        toggleButton.textContent = '☰';
        toggleButton.addEventListener('click', toggleGUI);
        document.body.appendChild(toggleButton);
    }
    // APPLY MATERIAL YOU STYLES WITH !important RULES
    function applyMaterialYouStyles() {
        const style = document.createElement('style');
        style.textContent = `
            .tr10-box {
                position: fixed !important;
                top: 50% !important;
                left: 60px !important;
                transform: translateY(-50%) !important;
                width: 280px !important;
                background: white !important;
                color: #000 !important;
                padding: 20px !important;
                border-radius: 16px !important;
                box-shadow: 0px 4px 12px rgba(0,0,0,0.3) !important;
                z-index: 100000 !important;
                max-height: 80vh !important;
                overflow-y: auto !important;
            }
            .tr10-card {
                background: #222 !important;
                color: #fff !important;
                border-radius: 16px !important;
                box-shadow: 0px 2px 8px rgba(0,0,0,0.2) !important;
                padding: 16px !important;
                margin: 8px 0 !important;
                display: flex !important;
                justify-content: space-between !important;
                align-items: center !important;
                transition: transform 0.2s ease-in-out !important;
            }
            .tr10-card:hover {
                transform: scale(1.02) !important;
            }
            .tr10-button {
                background: #6200EE !important;
                color: #fff !important;
                border: none !important;
                border-radius: 24px !important;
                padding: 10px 16px !important;
                font-size: 14px !important;
                cursor: pointer !important;
                transition: background 0.3s ease !important;
                margin-top: 8px !important;
            }
            .tr10-button:hover {
                background: #3700B3 !important;
            }
            .tr10-fab {
                position: fixed !important;
                bottom: 20px !important;
                right: 20px !important;
                width: 56px !important;
                height: 56px !important;
                background: #6200EE !important;
                color: #fff !important;
                border-radius: 50% !important;
                box-shadow: 0px 4px 10px rgba(0,0,0,0.3) !important;
                display: flex !important;
                justify-content: center !important;
                align-items: center !important;
                font-size: 24px !important;
                cursor: pointer !important;
                transition: background 0.3s ease, transform 0.2s !important;
                z-index: 100001 !important;
            }
            .tr10-fab:hover {
                background: #3700B3 !important;
                transform: scale(1.1) !important;
            }
            .tr10-toggle {
                position: fixed !important;
                top: 50% !important;
                left: 20px !important;
                transform: translateY(-50%) !important;
                width: 40px !important;
                height: 40px !important;
                background: rgba(0,0,0,0.8) !important;
                border-radius: 50% !important;
                cursor: pointer !important;
                transition: background 0.2s !important;
                border: 1px solid rgba(0,0,0,0.6) !important;
                z-index: 2147483647 !important;
                text-align: center !important;
                line-height: 40px !important;
                font-size: 24px !important;
                color: #fff !important;
            }
            .tr10-toggle:hover {
                background: rgba(0,0,0,1) !important;
            }
            .tr10-hidden {
                display: none !important;
            }
        `;
        document.head.appendChild(style);
    }
    // Initialize once DOM is ready.
    document.addEventListener('DOMContentLoaded', function() {
        loadReplacements();
        applyMaterialYouStyles();
        createGUI();
        runReplacements();
    });
})();