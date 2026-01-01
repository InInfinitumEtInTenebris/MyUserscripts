// ==UserScript==
// @name         Text Replacer11ZInd (Responsive UX)
// @namespace    http://tampermonkey.net/
// @version      7.1.0-Responsive
// @description  Mobile-friendly UI. Syncs rules across all sites via GM_Storage.
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // --- Configuration ---
    const IO_SEPARATOR = " |:| ";
    
    // --- State ---
    let replacements = {};
    let allRules = [];
    let blockedDomains = [];
    let guiBox, fab;
    let isGuiOpen = false;
    const originalTextMap = new WeakMap();
    let observerTimeout = null;

    // --- Storage Engine (GM_Storage) ---
    
    function loadData() {
        const rawData = GM_getValue("TextReplacerData", JSON.stringify({ rules: [], blocked: [] }));
        let data;
        try {
            data = JSON.parse(rawData);
        } catch(e) {
            data = { rules: [], blocked: [] };
        }
        
        allRules = data.rules || [];
        blockedDomains = data.blocked || [];
        
        // Build Active Replacements Map
        replacements = {};
        const currentHost = window.location.hostname;

        // 1. Load Globals
        allRules.forEach(rule => {
            if (rule.isGlobal) replacements[rule.oldText] = rule;
        });

        // 2. Load Locals (Overrides)
        allRules.forEach(rule => {
            if (!rule.isGlobal && rule.site === currentHost) {
                replacements[rule.oldText] = rule;
            }
        });
    }

    function saveData() {
        const data = {
            rules: allRules,
            blocked: blockedDomains
        };
        GM_setValue("TextReplacerData", JSON.stringify(data));
    }

    // --- Core Logic ---

    function isSiteBlocked() {
        return blockedDomains.includes(window.location.hostname);
    }

    function shouldSkip(node) {
        if (!node.parentElement) return true;
        if (node.parentElement.closest && node.parentElement.closest('#text-replacer-gui, .mui-fab, .mui-toggle')) return true;
        
        if (node.nodeType === Node.TEXT_NODE) {
            const tag = node.parentElement.tagName;
            if (['HEAD', 'SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE', 'INPUT'].includes(tag)) return true;
            if (node.parentElement.isContentEditable) return true; 
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
                if (!rule || typeof rule.newText !== 'string') continue;
                const pattern = new RegExp('\\b' + escapeRegExp(oldTxt) + '\\b', rule.caseSensitive ? 'g' : 'gi');
                updatedText = updatedText.replace(pattern, rule.newText);
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
        if (document.body) replaceText(document.body);
    }

    // --- Rule Management ---

    function upsertRule(newRule) {
        const newId = `${newRule.isGlobal ? 'GLOBAL' : newRule.site}::${newRule.oldText}`;
        allRules = allRules.filter(r => {
            const rId = `${r.isGlobal ? 'GLOBAL' : r.site}::${r.oldText}`;
            return rId !== newId;
        });
        allRules.push(newRule);
        saveData();
        loadData(); 
    }

    function removeRule(oldText) {
        const activeRule = replacements[oldText];
        if(!activeRule) return;

        const targetId = `${activeRule.isGlobal ? 'GLOBAL' : activeRule.site}::${activeRule.oldText}`;
        allRules = allRules.filter(r => {
            const rId = `${r.isGlobal ? 'GLOBAL' : r.site}::${r.oldText}`;
            return rId !== targetId;
        });
        
        saveData();
        loadData();
    }

    // --- GUI ---

    function displayRules() {
        if (!guiBox) return;
        guiBox.innerHTML = '';

        // Header
        const header = document.createElement('div');
        header.className = 'mui-header';
        
        const title = document.createElement('h2');
        title.textContent = 'Active Rules';
        
        const settingsBtn = document.createElement('button');
        settingsBtn.textContent = '⚙️ Opts';
        settingsBtn.classList.add('mui-button-small');
        settingsBtn.onclick = showSettings;

        header.appendChild(title);
        header.appendChild(settingsBtn);
        guiBox.appendChild(header);
        guiBox.appendChild(document.createElement('hr'));

        // List
        const listContainer = document.createElement('div');
        listContainer.className = 'mui-list-container';

        const activeKeys = Object.keys(replacements);
        if(activeKeys.length === 0) {
            const empty = document.createElement('div');
            empty.textContent = "No rules active on this page.";
            empty.className = 'mui-empty-state';
            listContainer.appendChild(empty);
        }

        for (const oldText of activeKeys) {
            const rule = replacements[oldText];
            const ruleDiv = document.createElement('div');
            ruleDiv.classList.add('mui-card');
            
            if (!rule.isGlobal) {
                ruleDiv.style.borderLeft = "4px solid #6200EE";
            }

            const infoDiv = document.createElement('div');
            infoDiv.innerHTML = `
                <div class="mui-rule-text">"${oldText}" ➡ "${rule.newText}"</div>
                <div class="mui-rule-meta">
                    ${rule.isGlobal ? "🌍 Global" : "🏠 Local Override"} | 
                    ${rule.caseSensitive ? "Aa" : "aa"}
                </div>
            `;
            
            const btnDiv = document.createElement('div');
            btnDiv.className = 'mui-card-actions';

            const editButton = document.createElement('button');
            editButton.textContent = '✏️';
            editButton.classList.add('mui-icon-btn');
            editButton.onclick = () => editRule(oldText);

            const deleteButton = document.createElement('button');
            deleteButton.textContent = '🗑️';
            deleteButton.classList.add('mui-icon-btn', 'danger');
            deleteButton.onclick = () => {
                if(confirm(`Delete rule "${oldText}"?`)) {
                    removeRule(oldText);
                    displayRules();
                    runReplacements();
                }
            };

            btnDiv.appendChild(editButton);
            btnDiv.appendChild(deleteButton);

            ruleDiv.appendChild(infoDiv);
            ruleDiv.appendChild(btnDiv);
            listContainer.appendChild(ruleDiv);
        }
        guiBox.appendChild(listContainer);

        // Footer
        const footer = document.createElement('div');
        footer.className = 'mui-footer';
        
        const exportBtn = document.createElement('button');
        exportBtn.textContent = '📤 Export All';
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
        scrollContainer.className = 'mui-list-container';

        const blTitle = document.createElement('h3');
        blTitle.textContent = "Blocklist";
        scrollContainer.appendChild(blTitle);

        const listDiv = document.createElement('div');
        listDiv.className = 'mui-blocklist';

        blockedDomains.forEach(domain => {
            const item = document.createElement('div');
            item.className = 'mui-blocklist-item';
            item.innerHTML = `<span>${domain}</span>`;
            const delBtn = document.createElement('button');
            delBtn.textContent = '✖';
            delBtn.className = 'mui-delete-x';
            delBtn.onclick = () => {
                blockedDomains = blockedDomains.filter(d => d !== domain);
                saveData();
                showSettings();
            };
            item.appendChild(delBtn);
            listDiv.appendChild(item);
        });
        scrollContainer.appendChild(listDiv);

        const addBlockBtn = document.createElement('button');
        addBlockBtn.textContent = '🚫 Block Current Site';
        addBlockBtn.classList.add('mui-button', 'full-width');
        addBlockBtn.onclick = () => {
            if (!blockedDomains.includes(window.location.hostname)) {
                blockedDomains.push(window.location.hostname);
                saveData();
                showSettings();
            }
        };
        scrollContainer.appendChild(addBlockBtn);
        
        const helpTxt = document.createElement('p');
        helpTxt.className = 'mui-help-text';
        helpTxt.textContent = "Note: Database is synced across ALL sites. Global rules appear everywhere automatically.";
        scrollContainer.appendChild(helpTxt);

        guiBox.appendChild(scrollContainer);

        const backBtn = document.createElement('button');
        backBtn.textContent = '⬅ Back';
        backBtn.classList.add('mui-button', 'full-width');
        backBtn.style.marginTop = '20px';
        backBtn.onclick = displayRules;
        guiBox.appendChild(backBtn);
    }

    // --- Actions ---

    function addRule() {
        const oldText = prompt("Text to replace:", "");
        if (!oldText?.trim()) return;
        const newText = prompt("Replacement text:", "");
        if (newText === null) return;
        const caseSensitive = confirm("Case-sensitive?");
        const isGlobal = confirm("Apply Globally?\nOK = Global (Every Site)\nCancel = Local (This Site Only)");

        const rule = { 
            oldText: oldText.trim(),
            newText: newText.trim(), 
            caseSensitive, 
            isGlobal, 
            site: window.location.hostname 
        };
        upsertRule(rule);
        displayRules();
        runReplacements();
    }

    function editRule(oldText) {
        const rule = replacements[oldText];
        if (!rule) return;
        
        const updatedOld = prompt("Original text:", oldText);
        if (updatedOld === null) return;
        const updatedNew = prompt("Replacement text:", rule.newText);
        if (updatedNew === null) return;
        const updatedCase = confirm(`Case-sensitive?\n(Currently: ${rule.caseSensitive})`);
        const updatedGlobal = confirm(`Apply Globally?\n(Currently: ${rule.isGlobal ? "Global" : "Local"})\n\nOK = Global\nCancel = Local`);

        if (updatedOld.trim() !== oldText || updatedGlobal !== rule.isGlobal) {
            removeRule(oldText); 
        }
        
        const newRule = { 
            oldText: updatedOld.trim(),
            newText: updatedNew.trim(), 
            caseSensitive: updatedCase, 
            isGlobal: updatedGlobal, 
            site: window.location.hostname 
        };
        upsertRule(newRule);
        displayRules();
        runReplacements();
    }

    function exportRules() {
        if (allRules.length === 0) return alert("Database is empty.");
        let exportText = "";
        for (const rule of allRules) {
            const siteStr = rule.site || "unknown";
            const caseStr = rule.caseSensitive ? "1" : "0";
            const globStr = rule.isGlobal ? "1" : "0";
            exportText += `${siteStr}${IO_SEPARATOR}${rule.oldText}${IO_SEPARATOR}${rule.newText}${IO_SEPARATOR}${caseStr}${IO_SEPARATOR}${globStr}\n`;
        }
        const blob = new Blob([exportText], { type: 'text/plain' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `replacer_db_synced_${Date.now()}.txt`;
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
                    let count = 0;
                    for (let line of lines) {
                        if (!line.trim()) continue;
                        if (line.includes(IO_SEPARATOR.trim())) {
                            const parts = line.split(IO_SEPARATOR);
                            if (parts.length >= 5) {
                                const site = parts[0];
                                const isGlobal = parts[4].trim() === "1";
                                const rule = { 
                                    site: site, 
                                    oldText: parts[1], 
                                    newText: parts[2], 
                                    caseSensitive: parts[3] === "1", 
                                    isGlobal: isGlobal 
                                };
                                const newId = `${rule.isGlobal?'GLOBAL':rule.site}::${rule.oldText}`;
                                if (!allRules.some(r => (`${r.isGlobal?'GLOBAL':r.site}::${r.oldText}`) === newId)) {
                                    allRules.push(rule);
                                    count++;
                                }
                            }
                        }
                    }
                    saveData();
                    loadData();
                    alert(`Imported ${count} new rules.`);
                    displayRules();
                    runReplacements();
                };
                reader.readAsText(file);
            }
        });
        input.click();
    }

    // --- GUI Init ---

    function toggleGUI() {
        isGuiOpen = !isGuiOpen;
        if(guiBox) guiBox.classList.toggle('mui-hidden', !isGuiOpen);
        if(fab) fab.classList.toggle('mui-hidden', !isGuiOpen);
    }

    function createGUI() {
        if (document.getElementById('text-replacer-gui')) return;
        const root = document.documentElement;

        guiBox = document.createElement('div');
        guiBox.id = 'text-replacer-gui';
        guiBox.classList.add('mui-box', 'mui-hidden');
        root.appendChild(guiBox);
        
        fab = document.createElement('button');
        fab.textContent = '+';
        fab.classList.add('mui-fab', 'mui-hidden');
        fab.onclick = addRule;
        root.appendChild(fab);

        const toggleButton = document.createElement('div');
        toggleButton.classList.add('mui-toggle');
        toggleButton.textContent = '☰';
        toggleButton.onclick = toggleGUI;
        root.appendChild(toggleButton);
        
        displayRules();
    }

    function applyStyles() {
        const style = document.createElement('style');
        style.textContent = `
            /* Base Mobile-First Styles */
            .mui-box {
                position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
                width: 90vw; max-width: 450px;
                background: white; color: #333; padding: 15px;
                border-radius: 12px; box-shadow: 0 4px 30px rgba(0,0,0,0.5);
                z-index: 2147483647; max-height: 85vh; display: flex; flex-direction: column;
                font-family: 'Segoe UI', Roboto, sans-serif; font-size: 14px;
            }
            .mui-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px; }
            .mui-list-container { overflow-y: auto; flex-grow: 1; padding-right: 2px; }
            .mui-footer { margin-top: 15px; display: flex; justify-content: space-between; gap: 10px; }
            
            .mui-card {
                background: #f9f9f9; border-radius: 8px;
                padding: 12px; margin: 8px 0; display: flex;
                justify-content: space-between; align-items: center;
                border: 1px solid #eee;
            }
            .mui-card-actions { display: flex; gap: 8px; }
            
            .mui-button, .mui-button-small {
                background: #6200EE; color: #fff; border: none;
                border-radius: 8px; padding: 12px; cursor: pointer;
                transition: opacity 0.2s; font-weight: 500; font-size: 14px;
            }
            .mui-button-small { padding: 6px 12px; font-size: 12px; border-radius: 20px; }
            .full-width { width: 100%; display: block; }
            .half-width { flex: 1; }
            .mui-button:hover { opacity: 0.9; }
            
            .mui-icon-btn {
                background: #e0e0e0; border: none; border-radius: 50%;
                width: 36px; height: 36px; cursor: pointer; display: flex;
                align-items: center; justify-content: center; font-size: 16px;
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
                position: fixed; top: 15vh; left: 0; 
                width: 40px; height: 40px; background: rgba(0,0,0,0.6);
                border-top-right-radius: 8px; border-bottom-right-radius: 8px;
                color: white; text-align: center; line-height: 40px; 
                cursor: pointer; z-index: 2147483647; font-size: 22px;
            }
            
            .mui-blocklist { background: rgba(0,0,0,0.05); border-radius: 8px; padding: 10px; margin-bottom: 10px; }
            .mui-blocklist-item { display: flex; justify-content: space-between; border-bottom: 1px solid rgba(0,0,0,0.1); padding: 8px 0; }
            .mui-delete-x { color: red; border: none; background: none; cursor: pointer; padding: 0 10px; font-size: 16px; }
            .mui-help-text { font-size: 0.9em; color: #666; margin-top: 15px; }
            .mui-empty-state { text-align: center; color: #888; padding: 20px; }
            .mui-hidden { display: none !important; }
            hr { border: 0; border-top: 1px solid #eee; margin: 10px 0; }
            h2, h3 { color: #6200EE; margin: 0; }

            /* Desktop / Large Screen Overrides */
            @media (min-width: 768px) {
                .mui-box {
                    left: 60px; top: 50%; transform: translateY(-50%);
                    width: 360px; max-width: none;
                    padding: 20px; font-size: 15px;
                }
                .mui-toggle { top: 50%; width: 30px; height: 30px; font-size: 18px; line-height: 30px; }
                .mui-fab { width: 50px; height: 50px; font-size: 24px; bottom: 30px; right: 30px; }
                .mui-card-actions { flex-direction: column; gap: 5px; }
                .mui-icon-btn { width: 30px; height: 30px; font-size: 14px; }
            }
        `;
        document.documentElement.appendChild(style);
    }

    async function main() {
        try {
            applyStyles();
            loadData();
            createGUI();
            
            const observer = new MutationObserver(() => {
                if (observerTimeout) clearTimeout(observerTimeout);
                observerTimeout = setTimeout(() => {
                    runReplacements();
                    if (!document.getElementById('text-replacer-gui')) createGUI();
                }, 500);
            });
            
            observer.observe(document.documentElement, { childList: true, subtree: true });
            runReplacements();

        } catch (e) {
            console.error("TextReplacer Startup Error:", e);
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", main);
    } else {
        main();
    }
})();