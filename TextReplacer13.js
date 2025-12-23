// ==UserScript==
// @name         Text Replacer11ZInd (Global Toggle + Site Exclusion)
// @namespace    http://tampermonkey.net/
// @version      4.0.0-Optimized
// @description  Text replacement with options for Global/Site-Specific rules and a Global Domain Blocklist. Uses IndexedDB for storage.
// @match        *://*/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    let replacements = {};
    let blockedDomains = []; // List of domains to exclude entirely
    let guiBox, fab;
    let isGuiOpen = false;
    const originalTextMap = new WeakMap();
    let observerTimeout = null;

    let db;
    const DB_NAME = "TextReplacerDB";
    const DB_VERSION = 2; // Incremented version for schema changes if needed
    const STORE_RULES = "rules";
    const STORE_SETTINGS = "settings";

    // --- Database Operations ---

    function initDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = function(e) {
                db = e.target.result;
                if (!db.objectStoreNames.contains(STORE_RULES)) {
                    db.createObjectStore(STORE_RULES, { keyPath: "oldText" });
                }
                if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
                    db.createObjectStore(STORE_SETTINGS, { keyPath: "id" });
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

    function loadDataFromDB() {
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_RULES, STORE_SETTINGS], "readonly");
            
            // Load Rules
            const ruleStore = transaction.objectStore(STORE_RULES);
            ruleStore.getAll().onsuccess = function(e) {
                const result = e.target.result;
                replacements = {};
                result.forEach(rule => {
                    if (rule && typeof rule.newText === "string") {
                        replacements[rule.oldText] = rule;
                    }
                });
            };

            // Load Blocked Domains
            const settingsStore = transaction.objectStore(STORE_SETTINGS);
            settingsStore.get("blockedDomains").onsuccess = function(e) {
                if (e.target.result) {
                    blockedDomains = e.target.result.list || [];
                }
            };

            transaction.oncomplete = () => resolve();
            transaction.onerror = (e) => reject(e);
        });
    }

    function saveRuleToDB(oldText, rule) {
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_RULES], "readwrite");
            const store = transaction.objectStore(STORE_RULES);
            const request = store.put({ ...rule, oldText });
            request.onsuccess = () => resolve();
            request.onerror = (e) => reject(e);
        });
    }

    function deleteRuleFromDB(oldText) {
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_RULES], "readwrite");
            const store = transaction.objectStore(STORE_RULES);
            const request = store.delete(oldText);
            request.onsuccess = () => resolve();
            request.onerror = (e) => reject(e);
        });
    }

    function saveBlockedDomainsToDB() {
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_SETTINGS], "readwrite");
            const store = transaction.objectStore(STORE_SETTINGS);
            const request = store.put({ id: "blockedDomains", list: blockedDomains });
            request.onsuccess = () => resolve();
            request.onerror = (e) => reject(e);
        });
    }

    // --- Core Logic ---

    function isSiteBlocked() {
        return blockedDomains.includes(window.location.hostname);
    }

    function shouldSkip(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            if (!node.parentElement) return true;
            if (node.parentElement.closest('.mui-box, .mui-toggle, .mui-fab')) return true;
            const tag = node.parentElement.tagName;
            if (['HEAD', 'SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE', 'INPUT'].includes(tag)) return true;
            if (node.parentElement.isContentEditable) return true; 
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.closest('.mui-box, .mui-toggle, .mui-fab')) return true;
            if (['HEAD', 'SCRIPT', 'STYLE'].includes(node.tagName)) return true;
        }
        return false;
    }

    function escapeRegExp(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function replaceText(node) {
        // 1. Check if the entire site is blocked
        if (isSiteBlocked()) return;
        
        if (shouldSkip(node)) return;

        if (node.nodeType === Node.TEXT_NODE) {
            if (!originalTextMap.has(node)) {
                originalTextMap.set(node, node.nodeValue);
            }
            const baseText = originalTextMap.get(node);
            let updatedText = baseText;

            for (const [oldTxt, rule] of Object.entries(replacements)) {
                // 2. Logic Update: Run if Global OR matches current site
                if (!rule.isGlobal && rule.site !== window.location.hostname) continue;
                
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
        if (isSiteBlocked()) return; 
        replaceText(document.body);
    }

    const observer = new MutationObserver(() => {
        if (observerTimeout) clearTimeout(observerTimeout);
        observerTimeout = setTimeout(() => {
            runReplacements();
        }, 500);
    });
    // Only observe if site is not blocked
    if (!blockedDomains.includes(window.location.hostname)){
       observer.observe(document.body, { childList: true, subtree: true });
    }


    // --- GUI & Interactions ---

    function displayRules() {
        if (!guiBox) return;
        guiBox.innerHTML = '';

        // Header
        const header = document.createElement('div');
        header.style.display = 'flex';
        header.style.justifyContent = 'space-between';
        header.style.alignItems = 'center';
        
        const title = document.createElement('h2');
        title.textContent = 'Rules';
        title.style.margin = '0';
        
        const settingsBtn = document.createElement('button');
        settingsBtn.textContent = '⚙️ Blocklist';
        settingsBtn.classList.add('mui-button-small');
        settingsBtn.onclick = showSettings;

        header.appendChild(title);
        header.appendChild(settingsBtn);
        guiBox.appendChild(header);
        
        guiBox.appendChild(document.createElement('hr'));

        // List Rules
        for (const oldText in replacements) {
            const rule = replacements[oldText];
            // Show rule if it is Global OR for this site
            const isRelevant = rule.isGlobal || rule.site === window.location.hostname;
            if (!isRelevant) continue;

            const { newText, caseSensitive, isGlobal } = rule;
            const ruleDiv = document.createElement('div');
            ruleDiv.classList.add('mui-card');

            const infoDiv = document.createElement('div');
            infoDiv.innerHTML = `
                <div style="font-weight:bold; font-size:1.1em;">"${oldText}" ➡ "${newText}"</div>
                <div style="font-size:0.85em; opacity:0.8; margin-top:4px;">
                    ${isGlobal ? "🌍 Global" : "🏠 This Site Only"} | 
                    ${caseSensitive ? "Aa Case-Sensitive" : "aa Case-Insensitive"}
                </div>
            `;
            
            const btnDiv = document.createElement('div');
            btnDiv.style.display = 'flex';
            btnDiv.style.flexDirection = 'column';
            btnDiv.style.gap = '5px';

            const editButton = document.createElement('button');
            editButton.textContent = '✏️';
            editButton.classList.add('mui-icon-btn');
            editButton.onclick = () => editRule(oldText);

            const deleteButton = document.createElement('button');
            deleteButton.textContent = '🗑️';
            deleteButton.classList.add('mui-icon-btn', 'danger');
            deleteButton.onclick = () => deleteRule(oldText);

            btnDiv.appendChild(editButton);
            btnDiv.appendChild(deleteButton);

            ruleDiv.appendChild(infoDiv);
            ruleDiv.appendChild(btnDiv);
            guiBox.appendChild(ruleDiv);
        }

        // Footer Actions
        const footer = document.createElement('div');
        footer.style.marginTop = '20px';
        footer.style.display = 'flex';
        footer.style.gap = '10px';
        
        const exportBtn = document.createElement('button');
        exportBtn.textContent = '📤 Export';
        exportBtn.classList.add('mui-button');
        exportBtn.onclick = exportRules;
        
        const importBtn = document.createElement('button');
        importBtn.textContent = '📥 Import';
        importBtn.classList.add('mui-button');
        importBtn.onclick = importRules;

        footer.appendChild(exportBtn);
        footer.appendChild(importBtn);
        guiBox.appendChild(footer);
    }

    function showSettings() {
        if (!guiBox) return;
        guiBox.innerHTML = '';
        
        const title = document.createElement('h2');
        title.textContent = 'Blocked Domains';
        guiBox.appendChild(title);

        const desc = document.createElement('p');
        desc.textContent = "The script will not run on these sites.";
        desc.style.fontSize = "0.9em";
        guiBox.appendChild(desc);

        const listDiv = document.createElement('div');
        listDiv.style.maxHeight = '200px';
        listDiv.style.overflowY = 'auto';
        listDiv.style.background = 'rgba(0,0,0,0.05)';
        listDiv.style.borderRadius = '8px';
        listDiv.style.padding = '10px';
        listDiv.style.marginBottom = '10px';

        blockedDomains.forEach(domain => {
            const item = document.createElement('div');
            item.style.display = 'flex';
            item.style.justifyContent = 'space-between';
            item.style.borderBottom = '1px solid rgba(0,0,0,0.1)';
            item.style.padding = '4px 0';
            
            const domName = document.createElement('span');
            domName.textContent = domain;
            
            const delBtn = document.createElement('button');
            delBtn.textContent = '✖';
            delBtn.style.background = 'none';
            delBtn.style.border = 'none';
            delBtn.style.color = 'red';
            delBtn.style.cursor = 'pointer';
            delBtn.onclick = async () => {
                blockedDomains = blockedDomains.filter(d => d !== domain);
                await saveBlockedDomainsToDB();
                showSettings();
            };
            
            item.appendChild(domName);
            item.appendChild(delBtn);
            listDiv.appendChild(item);
        });
        guiBox.appendChild(listDiv);

        const addBtn = document.createElement('button');
        addBtn.textContent = '+ Block Current Site';
        addBtn.classList.add('mui-button');
        addBtn.onclick = async () => {
            if (!blockedDomains.includes(window.location.hostname)) {
                blockedDomains.push(window.location.hostname);
                await saveBlockedDomainsToDB();
                showSettings();
                alert(`Blocked ${window.location.hostname}. Please refresh page.`);
            }
        };
        guiBox.appendChild(addBtn);

        const backBtn = document.createElement('button');
        backBtn.textContent = '⬅ Back';
        backBtn.classList.add('mui-button');
        backBtn.style.marginTop = '10px';
        backBtn.onclick = displayRules;
        guiBox.appendChild(backBtn);
    }

    async function addRule() {
        const oldText = prompt("Text to replace:", "");
        if (!oldText?.trim()) return;
        
        const newText = prompt("Replacement text:", "");
        if (newText === null) return;
        
        const caseSensitive = confirm("Case-sensitive?");
        const isGlobal = confirm("Apply GLOBALLY to all websites?\n(Cancel = Only this site)");

        const rule = { 
            newText: newText.trim(), 
            caseSensitive, 
            isGlobal, 
            site: window.location.hostname 
        };
        
        replacements[oldText.trim()] = rule;
        await saveRuleToDB(oldText.trim(), rule);
        displayRules();
        runReplacements();
    }

    async function editRule(oldText) {
        const rule = replacements[oldText];
        if (!rule) return;
        
        const updatedOld = prompt("Original text:", oldText);
        if (updatedOld === null) return;
        
        const updatedNew = prompt("Replacement text:", rule.newText);
        if (updatedNew === null) return;
        
        const updatedCase = confirm(`Case-sensitive?\n(Currently: ${rule.caseSensitive})`);
        const updatedGlobal = confirm(`Apply GLOBALLY?\n(Currently: ${rule.isGlobal ? "Global" : "This Site Only"})\nOK = Global, Cancel = Local`);

        if (updatedOld.trim() !== oldText) {
            await deleteRuleFromDB(oldText);
            delete replacements[oldText];
        }
        
        const newRule = { 
            newText: updatedNew.trim(), 
            caseSensitive: updatedCase, 
            isGlobal: updatedGlobal, 
            site: window.location.hostname 
        };
        
        replacements[updatedOld.trim()] = newRule;
        await saveRuleToDB(updatedOld.trim(), newRule);
        displayRules();
        runReplacements();
    }

    async function deleteRule(oldText) {
        if (confirm(`Delete rule "${oldText}"?`)) {
            await deleteRuleFromDB(oldText);
            delete replacements[oldText];
            displayRules();
            runReplacements();
        }
    }

    function exportRules() {
        let exportText = "";
        for (const [oldText, rule] of Object.entries(replacements)) {
            // Format: old:new:case:global
            exportText += `${oldText}:${rule.newText}:${rule.caseSensitive?1:0}:${rule.isGlobal?1:0}\n`;
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
                        // Backwards compatibility handling
                        if (parts.length >= 3) {
                            const oldText = parts[0].trim();
                            const newText = parts[1].trim();
                            const caseSensitive = parts[2].trim() === "1";
                            // Default to global if not specified in old imports, or parse 4th part
                            const isGlobal = parts.length > 3 ? parts[3].trim() === "1" : false;

                            if (oldText && newText !== undefined) {
                                const rule = { newText, caseSensitive, isGlobal, site: window.location.hostname };
                                replacements[oldText] = rule;
                                await saveRuleToDB(oldText, rule);
                            }
                        }
                    }
                    alert("Import successful.");
                    displayRules();
                    runReplacements();
                };
                reader.readAsText(file);
            }
        });
        input.click();
    }

    // --- GUI Construction ---

    function toggleGUI() {
        isGuiOpen = !isGuiOpen;
        guiBox.classList.toggle('mui-hidden', !isGuiOpen);
        fab.classList.toggle('mui-hidden', !isGuiOpen);
    }

    function createGUI() {
        guiBox = document.createElement('div');
        guiBox.classList.add('mui-box', 'mui-hidden');
        document.body.appendChild(guiBox);
        
        fab = document.createElement('button');
        fab.textContent = '+';
        fab.classList.add('mui-fab', 'mui-hidden');
        fab.onclick = addRule;
        document.body.appendChild(fab);

        const toggleButton = document.createElement('div');
        toggleButton.classList.add('mui-toggle');
        toggleButton.textContent = '☰';
        toggleButton.onclick = toggleGUI;
        document.body.appendChild(toggleButton);
        
        displayRules();
    }

    function applyStyles() {
        const style = document.createElement('style');
        style.textContent = `
            .mui-box {
                position: fixed; top: 50%; left: 60px; transform: translateY(-50%);
                width: 300px; background: white; color: #333; padding: 20px;
                border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.4);
                z-index: 2147483647; max-height: 80vh; overflow-y: auto;
                font-family: sans-serif;
            }
            .mui-card {
                background: #f5f5f5; color: #333; border-radius: 12px;
                padding: 12px; margin: 8px 0; display: flex;
                justify-content: space-between; align-items: center;
                border: 1px solid #ddd;
            }
            .mui-button, .mui-button-small {
                background: #6200EE; color: #fff; border: none;
                border-radius: 20px; padding: 8px 16px; cursor: pointer;
                transition: opacity 0.2s;
            }
            .mui-button-small { padding: 4px 10px; font-size: 0.8em; }
            .mui-button:hover { opacity: 0.9; }
            .mui-icon-btn {
                background: #e0e0e0; border: none; border-radius: 50%;
                width: 32px; height: 32px; cursor: pointer;
            }
            .danger { color: red; background: #fee; }
            .mui-fab {
                position: fixed; bottom: 20px; right: 20px;
                width: 56px; height: 56px; background: #6200EE;
                color: white; border-radius: 50%; border: none;
                font-size: 28px; cursor: pointer; box-shadow: 0 4px 10px rgba(0,0,0,0.3);
                z-index: 2147483647;
            }
            .mui-toggle {
                position: fixed; top: 50%; left: 10px; transform: translateY(-50%);
                width: 40px; height: 40px; background: rgba(0,0,0,0.5);
                border-radius: 50%; color:
white; text-align: center;
                line-height: 40px; cursor: pointer; z-index: 2147483647;
            }
            .mui-hidden { display: none !important; }
        `;
        document.head.appendChild(style);
    }

    async function main() {
        try {
            await initDB();
            await loadDataFromDB();
        } catch (e) {
            console.error("Storage Error:", e);
        }
        applyStyles();
        createGUI();
        runReplacements();
    }

    main();
})();