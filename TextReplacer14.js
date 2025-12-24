// ==UserScript==
// @name         Text Replacer11ZInd (Settings Menu + Mass Edit + Enhanced I/O)
// @namespace    http://tampermonkey.net/
// @version      4.1.0-SettingsUpdate
// @description  Text replacement with Global/Site-Specific toggles, Mass Editing tools, and Site-aware Import/Export.
// @match        *://*/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    let replacements = {};
    let blockedDomains = [];
    let guiBox, fab;
    let isGuiOpen = false;
    const originalTextMap = new WeakMap();
    let observerTimeout = null;

    let db;
    const DB_NAME = "TextReplacerDB";
    const DB_VERSION = 2;
    const STORE_RULES = "rules";
    const STORE_SETTINGS = "settings";

    // Separator for Import/Export (Unique enough to avoid text conflicts)
    const IO_SEPARATOR = " |:| ";

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

    function saveAllRulesToDB(allRules) {
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_RULES], "readwrite");
            const store = transaction.objectStore(STORE_RULES);
            
            // Clear existing and rewrite (safer for mass updates)
            // Or loop put. Loop put is better to keep unmodified ones safe, 
            // but for mass update we just iterate.
            
            // Using a loop of puts
            let itemsProcessed = 0;
            if (Object.keys(allRules).length === 0) resolve();

            Object.entries(allRules).forEach(([key, val]) => {
                store.put({ ...val, oldText: key });
                itemsProcessed++;
            });
            
            transaction.oncomplete = () => resolve();
            transaction.onerror = (e) => reject(e);
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
        if (isSiteBlocked()) return;
        if (shouldSkip(node)) return;

        if (node.nodeType === Node.TEXT_NODE) {
            if (!originalTextMap.has(node)) {
                originalTextMap.set(node, node.nodeValue);
            }
            const baseText = originalTextMap.get(node);
            let updatedText = baseText;

            for (const [oldTxt, rule] of Object.entries(replacements)) {
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
        title.textContent = 'Replacer Rules';
        title.style.margin = '0';
        title.style.fontSize = '1.2em';
        
        const settingsBtn = document.createElement('button');
        settingsBtn.textContent = '⚙️ Settings';
        settingsBtn.classList.add('mui-button-small');
        settingsBtn.onclick = showSettings;

        header.appendChild(title);
        header.appendChild(settingsBtn);
        guiBox.appendChild(header);
        
        guiBox.appendChild(document.createElement('hr'));

        // List Rules
        const listContainer = document.createElement('div');
        listContainer.style.maxHeight = '60vh';
        listContainer.style.overflowY = 'auto';

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
                <div style="font-weight:bold; font-size:1.05em;">"${oldText}" ➡ "${newText}"</div>
                <div style="font-size:0.8em; opacity:0.8; margin-top:4px;">
                    ${isGlobal ? "🌍 Global" : "🏠 This Site Only"} | 
                    ${caseSensitive ? "Aa Match Case" : "aa Ignore Case"}
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
            listContainer.appendChild(ruleDiv);
        }
        guiBox.appendChild(listContainer);

        // Footer Actions
        const footer = document.createElement('div');
        footer.style.marginTop = '15px';
        footer.style.display = 'flex';
        footer.style.justifyContent = 'space-between';
        
        const exportBtn = document.createElement('button');
        exportBtn.textContent = '📤 Export';
        exportBtn.classList.add('mui-button', 'half-width');
        exportBtn.onclick = exportRules;
        
        const importBtn = document.createElement('button');
        importBtn.textContent = '📥 Import';
        importBtn.classList.add('mui-button', 'half-width');
        importBtn.onclick = importRules;

        footer.appendChild(exportBtn);
        footer.appendChild(importBtn);
        guiBox.appendChild(footer);
    }

    function showSettings() {
        if (!guiBox) return;
        guiBox.innerHTML = '';
        
        const title = document.createElement('h2');
        title.textContent = 'Settings';
        guiBox.appendChild(title);

        const scrollContainer = document.createElement('div');
        scrollContainer.style.maxHeight = '70vh';
        scrollContainer.style.overflowY = 'auto';

        // --- Blocklist Section ---
        const blTitle = document.createElement('h3');
        blTitle.textContent = "Blocklist (Exclude Sites)";
        blTitle.style.marginTop = "15px";
        scrollContainer.appendChild(blTitle);

        const listDiv = document.createElement('div');
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
            delBtn.style.color = 'red';
            delBtn.style.border = 'none';
            delBtn.style.background = 'none';
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
        scrollContainer.appendChild(listDiv);

        const addBlockBtn = document.createElement('button');
        addBlockBtn.textContent = '🚫 Block Current Site';
        addBlockBtn.classList.add('mui-button', 'full-width');
        addBlockBtn.onclick = async () => {
            if (!blockedDomains.includes(window.location.hostname)) {
                blockedDomains.push(window.location.hostname);
                await saveBlockedDomainsToDB();
                showSettings();
                alert(`Blocked ${window.location.hostname}.`);
            }
        };
        scrollContainer.appendChild(addBlockBtn);

        // --- Bulk Actions Section ---
        const bulkTitle = document.createElement('h3');
        bulkTitle.textContent = "Bulk Actions";
        bulkTitle.style.marginTop = "25px";
        scrollContainer.appendChild(bulkTitle);

        const bulkDesc = document.createElement('p');
        bulkDesc.textContent = "Apply to ALL rules in your library:";
        bulkDesc.style.fontSize = "0.85em";
        scrollContainer.appendChild(bulkDesc);

        const makeGlobalBtn = document.createElement('button');
        makeGlobalBtn.textContent = '🌍 Set ALL to Global';
        makeGlobalBtn.classList.add('mui-button', 'full-width');
        makeGlobalBtn.style.marginBottom = "8px";
        makeGlobalBtn.onclick = async () => {
            if(confirm("Are you sure? This will make EVERY rule in your database active on ALL websites.")) {
                for (let key in replacements) {
                    replacements[key].isGlobal = true;
                }
                await saveAllRulesToDB(replacements);
                alert("All rules are now Global.");
                showSettings(); // Refresh
            }
        };
        scrollContainer.appendChild(makeGlobalBtn);

        const makeLocalBtn = document.createElement('button');
        makeLocalBtn.textContent = `🏠 Set ALL to "${window.location.hostname}"`;
        makeLocalBtn.classList.add('mui-button', 'full-width');
        makeLocalBtn.onclick = async () => {
            if(confirm(`Are you sure? This will make EVERY rule in your database apply ONLY to "${window.location.hostname}". Rules from other sites will be moved here.`)) {
                for (let key in replacements) {
                    replacements[key].isGlobal = false;
                    replacements[key].site = window.location.hostname;
                }
                await saveAllRulesToDB(replacements);
                alert(`All rules are now local to ${window.location.hostname}.`);
                showSettings(); // Refresh
            }
        };
        scrollContainer.appendChild(makeLocalBtn);

        guiBox.appendChild(scrollContainer);

        // Back Button
        const backBtn = document.createElement('button');
        backBtn.textContent = '⬅ Back to Rules';
        backBtn.classList.add('mui-button', 'full-width');
        backBtn.style.marginTop = '20px';
        backBtn.onclick = displayRules;
        guiBox.appendChild(backBtn);
    }

    // --- Actions ---

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
            // New Robust Format: Site |:| Old |:| New |:| Case(1/0) |:| Global(1/0)
            const siteStr = rule.site || "unknown";
            const caseStr = rule.caseSensitive ? "1" : "0";
            const globStr = rule.isGlobal ? "1" : "0";
            
            exportText += `${siteStr}${IO_SEPARATOR}${oldText}${IO_SEPARATOR}${rule.newText}${IO_SEPARATOR}${caseStr}${IO_SEPARATOR}${globStr}\n`;
        }
        const blob = new Blob([exportText], { type: 'text/plain' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `replacer_rules_${Date.now()}.txt`;
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
                    let count = 0;
                    for (let line of lines) {
                        if (!line.trim()) continue;

                        // Try New Format first
                        if (line.includes(IO_SEPARATOR.trim())) {
                            const parts = line.split(IO_SEPARATOR);
                            // Expect 5 parts: Site, Old, New, Case, Global
if (parts.length >= 5) {
                                const site = parts[0];
                                const oldText = parts[1];
                                const newText = parts[2];
                                const caseSensitive = parts[3] === "1";
                                const isGlobal = parts[4].trim() === "1";
                                
                                const rule = { newText, caseSensitive, isGlobal, site };
                                replacements[oldText] = rule;
                                await saveRuleToDB(oldText, rule);
                                count++;
                            }
                        } 
                        // Fallback to Legacy Format (Old:New:Case:Global)
                        else {
                            const parts = line.split(":");
                            if (parts.length >= 3) {
                                const oldText = parts[0].trim();
                                const newText = parts[1].trim();
                                const caseSensitive = parts[2].trim() === "1";
                                const isGlobal = parts.length > 3 ? parts[3].trim() === "1" : false;
                                
                                const rule = { newText, caseSensitive, isGlobal, site: window.location.hostname };
                                replacements[oldText] = rule;
                                await saveRuleToDB(oldText, rule);
                                count++;
                            }
                        }
                    }
                    alert(`Imported ${count} rules successfully.`);
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
                width: 320px; background: white; color: #333; padding: 20px;
                border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.4);
                z-index: 2147483647; max-height: 85vh; overflow-y: visible;
                font-family: 'Segoe UI', Roboto, sans-serif;
            }
            .mui-card {
                background: #f9f9f9; color: #333; border-radius: 10px;
                padding: 10px; margin: 8px 0; display: flex;
                justify-content: space-between; align-items: center;
                border: 1px solid #eee;
            }
            .mui-button, .mui-button-small {
                background: #6200EE; color: #fff; border: none;
                border-radius: 8px; padding: 10px 16px; cursor: pointer;
                transition: opacity 0.2s; font-weight: 500;
            }
            .mui-button-small { padding: 5px 12px; font-size: 0.85em; border-radius: 16px; }
            .full-width { width: 100%; display: block; }
            .half-width { width: 48%; }
            .mui-button:hover { opacity: 0.9; }
            .mui-icon-btn {
                background: #e0e0e0; border: none; border-radius: 50%;
                width: 30px; height: 30px; cursor: pointer; display: flex;
                align-items: center; justify-content: center; font-size: 14px;
            }
            .danger { color: #D32F2F; background: #FFEBEE; }
            .mui-fab {
                position: fixed; bottom: 20px; right: 20px;
                width: 56px; height: 56px; background: #6200EE;
                color: white; border-radius: 50%; border: none;
                font-size: 28px; cursor: pointer; box-shadow: 0 4px 10px rgba(0,0,0,0.3);
                z-index: 2147483647; display: flex; align-items: center; justify-content: center;
            }
            .mui-toggle {
                position: fixed; top: 50%; left: 10px; transform: translateY(-50%);
                width: 40px; height: 40px; background: rgba(0,0,0,0.6);
                border-radius: 50%; color: white; text-align: center;
                line-height: 40px; cursor: pointer; z-index: 2147483647;
                font-size: 20px;
            }
            .mui-hidden { display: none !important; }
            hr { border: 0; border-top: 1px solid #eee; margin: 10px 0; }
            h2, h3 { color: #6200EE; }
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