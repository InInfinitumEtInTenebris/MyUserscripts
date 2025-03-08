// ==UserScript==
// @name         Text Replacer6 (Material You GUI, Visible Spaces, Import/Export)
// @namespace    http://tampermonkey.net/
// @version      2.6
// @description  Dynamically replaces text (even phrases with spaces), with a Material You GUI, import/export, and a hidden toggle icon. Whitespace is shown as "␣" to avoid confusion.
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

    /* ------------------- 1) LOAD & SAVE REPLACEMENTS ------------------- */
    function loadReplacements() {
        const stored = localStorage.getItem('textReplacements');
        if (stored) {
            try {
                replacements = JSON.parse(stored);
            } catch (e) {
                console.error("Error parsing stored replacements:", e);
            }
        }
    }

    function saveReplacements() {
        localStorage.setItem('textReplacements', JSON.stringify(replacements));
    }

    /* ------------------- 2) TEXT REPLACEMENT LOGIC ------------------- */
    // Escape special regex chars in the 'old text' so phrases with spaces or punctuation work properly
    function escapeRegExp(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function replaceText(node) {
        // Skip script/style/textarea
        if (node.nodeType === Node.ELEMENT_NODE) {
            const tag = node.tagName;
            if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA') {
                return;
            }
        }
        if (node.nodeType === Node.TEXT_NODE) {
            let text = node.nodeValue;
            for (const [oldTxt, newTxt] of Object.entries(replacements)) {
                const pattern = new RegExp(escapeRegExp(oldTxt), 'g');
                text = text.replace(pattern, newTxt);
            }
            node.nodeValue = text;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            node.childNodes.forEach(child => replaceText(child));
        }
    }

    function runReplacements() {
        replaceText(document.body);
    }

    // Observe DOM changes to replace new text dynamically
    const observer = new MutationObserver(mutations => {
        mutations.forEach(mutation => {
            mutation.addedNodes.forEach(node => {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    replaceText(node);
                }
            });
        });
    });
    observer.observe(document.body, { childList: true, subtree: true });

    /* ------------------- 3) GUI: DISPLAY, ADD, EDIT, DELETE ------------------- */
    // For debugging: show the actual replacements object in the console each time we refresh the GUI
    function displayRules() {
        if (!guiBox) return;
        guiBox.innerHTML = '';

        console.log('Replacements object:', replacements);

        const title = document.createElement('h2');
        title.textContent = 'Text Replacer Rules';
        title.style.marginBottom = '16px';
        guiBox.appendChild(title);

        // Build rule cards
        for (const oldText in replacements) {
            const newText = replacements[oldText];
            const ruleDiv = document.createElement('div');
            ruleDiv.classList.add('mui-card');

            // Replace whitespace with '␣' so invisible differences become visible
            const visibleOld = oldText.replace(/\s/g, '␣');
            const visibleNew = newText.replace(/\s/g, '␣');

            const ruleText = document.createElement('span');
            ruleText.textContent = `"${visibleOld}" → "${visibleNew}"`;
            ruleDiv.appendChild(ruleText);

            const buttonContainer = document.createElement('div');

            const editButton = document.createElement('button');
            editButton.textContent = '✏️';
            editButton.classList.add('mui-button');
            editButton.style.marginRight = '8px';
            editButton.addEventListener('click', () => editRule(oldText, newText));

            const deleteButton = document.createElement('button');
            deleteButton.textContent = '🗑️';
            deleteButton.classList.add('mui-button');
            deleteButton.addEventListener('click', () => deleteRule(oldText));

            buttonContainer.appendChild(editButton);
            buttonContainer.appendChild(deleteButton);
            ruleDiv.appendChild(buttonContainer);

            guiBox.appendChild(ruleDiv);
        }

        // Import/Export
        const importButton = document.createElement('button');
        importButton.textContent = 'Import Rules';
        importButton.classList.add('mui-button');
        importButton.style.marginRight = '8px';
        importButton.addEventListener('click', importRules);
        guiBox.appendChild(importButton);

        const exportButton = document.createElement('button');
        exportButton.textContent = 'Export Rules';
        exportButton.classList.add('mui-button');
        exportButton.addEventListener('click', exportRules);
        guiBox.appendChild(exportButton);
    }

    function addRule() {
        const input = prompt("Enter a replacement rule in 'old:new' format:", "");
        if (!input) return;
        const parts = input.split(":");
        if (parts.length === 2) {
            const oldText = parts[0].trim();
            const newText = parts[1].trim();
            if (oldText && newText) {
                replacements[oldText] = newText;
                saveReplacements();
                alert("Replacement rule added.");
                displayRules();
                runReplacements();
            } else {
                alert("Both original and replacement values must be non-empty.");
            }
        } else {
            alert("Invalid format. Please use 'old:new'.");
        }
    }

    function editRule(oldText, currentNewText) {
        const updatedOld = prompt("Edit original text:", oldText);
        if (updatedOld === null) return;
        const updatedNew = prompt("Edit replacement text:", currentNewText);
        if (updatedNew === null) return;

        if (updatedOld.trim() && updatedNew.trim()) {
            delete replacements[oldText]; // remove the old key
            replacements[updatedOld.trim()] = updatedNew.trim(); // add the updated key
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

    /* ------------------- 4) IMPORT & EXPORT ------------------- */
    function exportRules() {
        const rulesJSON = JSON.stringify(replacements, null, 2);
        prompt("Copy the following JSON:", rulesJSON);
    }

    function importRules() {
        const inputJSON = prompt("Paste the JSON to import:", "");
        if (inputJSON) {
            try {
                replacements = JSON.parse(inputJSON);
                saveReplacements();
                alert("Rules imported and saved.");
                displayRules();
                runReplacements();
            } catch (e) {
                alert("Invalid JSON.");
            }
        }
    }

    /* ------------------- 5) SHOW/HIDE GUI + FAB ------------------- */
    function toggleGUI() {
        isGuiOpen = !isGuiOpen;
        guiBox.classList.toggle('mui-hidden', !isGuiOpen);
        fab.classList.toggle('mui-hidden', !isGuiOpen);

        // If we just opened, run replacements again
        if (isGuiOpen) {
            runReplacements();
        }
    }

    function createGUI() {
        // The main GUI panel
        guiBox = document.createElement('div');
        guiBox.style.position = 'fixed';
        guiBox.style.top = '50%';
        guiBox.style.left = '60px';
        guiBox.style.transform = 'translateY(-50%)';
        guiBox.style.background = 'white';
        guiBox.style.padding = '20px';
        guiBox.style.borderRadius = '16px';
        guiBox.style.boxShadow = '0px 4px 12px rgba(0, 0, 0, 0.3)';
        guiBox.style.zIndex = '10000';
        guiBox.style.width = '280px';
        guiBox.style.maxHeight = '80vh';
        guiBox.style.overflowY = 'auto';
        guiBox.classList.add('mui-hidden');
        document.body.appendChild(guiBox);

        // Floating Action Button (add rule)
        fab = document.createElement('div');
        fab.classList.add('mui-fab', 'mui-hidden');
        fab.textContent = '+';
        fab.addEventListener('click', addRule);
        document.body.appendChild(fab);

        // The toggle (hamburger) button on the left middle side
        const toggleButton = document.createElement('div');
        toggleButton.classList.add('mui-toggle');
        toggleButton.textContent = '☰';
        toggleButton.addEventListener('click', toggleGUI);
        document.body.appendChild(toggleButton);

        // Fill in the rules
        displayRules();
    }

    /* ------------------- 6) STYLES (MATERIAL YOU) ------------------- */
    function applyMaterialYouStyles() {
        const style = document.createElement('style');
        style.textContent = `
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
                box-shadow: 0px 4px 10px rgba(0, 0, 0, 0.3);
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

            /* The GUI container itself */
            [style*="guiBox"] {
                background: var(--md-sys-color-surface, #111) !important;
                color: var(--md-sys-color-on-surface, #fff) !important;
            }
        `;
        document.head.appendChild(style);
    }

    /* ------------------- 7) INITIALIZE EVERYTHING ------------------- */
    loadReplacements();
    applyMaterialYouStyles();
    createGUI();
    runReplacements();

})();