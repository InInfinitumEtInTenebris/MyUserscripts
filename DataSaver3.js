// ==UserScript==
// @name        Adguard Mobile Image Remover/Compressor (Global)
// @namespace   YourNamespace
// @version     1.6
// @description Removes or "compresses" images globally to save data, including video posters (e.g., YouTube thumbnails).
// @author      You
// @match       *://*/*
// @grant       GM_setValue
// @grant       GM_getValue
// @run-at      document-idle
// @mobile      true
// ==/UserScript==

(function() {
    'use strict';

    let originalImages = [];
    let originalVideoPosters = [];
    let currentImageState = 'original'; // 'original', 'removed', 'compressed'
    const lowResPlaceholder = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    const globalRemoveKey = 'globalImageRemovalEnabled';
    let settingsVisible = false;

    const isGlobalRemoveEnabled = getValue(globalRemoveKey, true);
    const MIN_IMAGE_SIZE = 30; 
    const videoHostsPattern = /youtube\.com|ytimg\.com|vimeo\.com|dailymotion\.com/i;

    function saveValue(key, value) {
        if (typeof GM_setValue !== 'undefined') {
            GM_setValue(key, value);
        } else {
            localStorage.setItem(key, JSON.stringify(value));
        }
    }

    function getValue(key, defaultValue) {
        if (typeof GM_getValue !== 'undefined') {
            return GM_getValue(key, defaultValue);
        } else {
            const storedValue = localStorage.getItem(key);
            return storedValue ? JSON.parse(storedValue) : defaultValue;
        }
    }

    function shouldProcessImage(img) {
        if (videoHostsPattern.test(img.src)) return true;
        const rect = img.getBoundingClientRect();
        return rect.width >= MIN_IMAGE_SIZE && rect.height >= MIN_IMAGE_SIZE;
    }

    function filterImages(images) {
        return Array.from(images).filter(img => shouldProcessImage(img) && !img.hasAttribute('data-processed'));
    }

    function removeAllImages() {
        const images = filterImages(document.querySelectorAll('img:not([data-processed])'));
        images.forEach(img => {
            originalImages.push({ element: img, src: img.src });
            img.removeAttribute('src');
            img.style.visibility = 'hidden';
            img.setAttribute('data-processed', 'true');
        });

        const videos = document.querySelectorAll('video[poster]:not([data-processed])');
        videos.forEach(video => {
            originalVideoPosters.push({ element: video, poster: video.poster });
            video.removeAttribute('poster');
            video.setAttribute('data-processed', 'true');
        });

        currentImageState = 'removed';
        console.log('Images and video posters removed globally.');
    }

    function restoreAllImages() {
        if (currentImageState === 'removed' || currentImageState === 'compressed') {
            originalImages.forEach(item => {
                if (item.element) {
                    item.element.src = item.src;
                    item.element.style.visibility = '';
                    item.element.removeAttribute('data-processed');
                }
            });
            originalImages = [];

            originalVideoPosters.forEach(item => {
                if (item.element) {
                    item.element.poster = item.poster;
                    item.element.removeAttribute('data-processed');
                }
            });
            originalVideoPosters = [];

            currentImageState = 'original';
            console.log('Original images and video posters restored.');
            saveValue(globalRemoveKey, true);
        } else {
            console.log('No images to restore.');
        }
    }

    function compressImages() {
        const images = filterImages(document.querySelectorAll('img:not([data-processed])'));
        images.forEach(img => {
            originalImages.push({ element: img, src: img.src });
            img.src = lowResPlaceholder;
            img.setAttribute('data-processed', 'true');
        });

        const videos = document.querySelectorAll('video[poster]:not([data-processed])');
        videos.forEach(video => {
            originalVideoPosters.push({ element: video, poster: video.poster });
            video.poster = lowResPlaceholder;
            video.setAttribute('data-processed', 'true');
        });

        currentImageState = 'compressed';
        console.log('Images and video posters "compressed" with low-res placeholders.');
    }

    function compressWithQuality(quality) {
        alert(`Image compression to ${quality}% using a low-resolution placeholder.`);
        compressImages();
    }

    // MutationObserver to handle dynamically loaded images and videos
    const observer = new MutationObserver(mutations => {
        mutations.forEach(mutation => {
            mutation.addedNodes.forEach(node => {
                if (node.tagName === 'IMG' || (node.querySelectorAll && node.querySelectorAll('img').length > 0)) {
                    removeAllImages();
                }
            });
        });
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Create the settings menu
    const settingsMenu = document.createElement('div');
    settingsMenu.id = 'imageRemoverSettingsMenu';
    settingsMenu.style.position = 'fixed';
    settingsMenu.style.bottom = '60px';
    settingsMenu.style.right = '10px';
    settingsMenu.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
    settingsMenu.style.color = 'white';
    settingsMenu.style.borderRadius = '5px';
    settingsMenu.style.padding = '10px';
    settingsMenu.style.zIndex = '2000';
    settingsMenu.style.display = 'none';
    settingsMenu.style.flexDirection = 'column';
    settingsMenu.style.gap = '5px';

    const removeButton = document.createElement('button');
    removeButton.textContent = isGlobalRemoveEnabled ? 'Disable Image Removal' : 'Enable Image Removal';
    removeButton.style.backgroundColor = '#444';
    removeButton.style.color = 'white';
    removeButton.style.border = 'none';
    removeButton.style.padding = '8px 12px';
    removeButton.style.borderRadius = '3px';
    removeButton.style.cursor = 'pointer';
    removeButton.addEventListener('click', () => {
        const enabled = getValue(globalRemoveKey, true);
        saveValue(globalRemoveKey, !enabled);
        removeButton.textContent = !enabled ? 'Disable Image Removal' : 'Enable Image Removal';
        if (!enabled) {
            removeAllImages();
        } else {
            restoreAllImages();
        }
    });
    settingsMenu.appendChild(removeButton);

    const restoreButton = document.createElement('button');
    restoreButton.textContent = 'Restore Images';
    restoreButton.style.backgroundColor = '#444';
    restoreButton.style.color = 'white';
    restoreButton.style.border = 'none';
    restoreButton.style.padding = '8px 12px';
    restoreButton.style.borderRadius = '3px';
    restoreButton.style.cursor = 'pointer';
    restoreButton.addEventListener('click', restoreAllImages);
    settingsMenu.appendChild(restoreButton);

    const compress80Button = document.createElement('button');
    compress80Button.textContent = 'Compress 80%';
    compress80Button.style.backgroundColor = '#444';
    compress80Button.style.color = 'white';
    compress80Button.style.border = 'none';
    compress80Button.style.padding = '8px 12px';
    compress80Button.style.borderRadius = '3px';
    compress80Button.style.cursor = 'pointer';
    compress80Button.addEventListener('click', () => compressWithQuality(80));
    settingsMenu.appendChild(compress80Button);

    const compress60Button = document.createElement('button');
    compress60Button.textContent = 'Compress 60%';
    compress60Button.style.backgroundColor = '#444';
    compress60Button.style.color = 'white';
    compress60Button.style.border = 'none';
    compress60Button.style.padding = '8px 12px';
    compress60Button.style.borderRadius = '3px';
    compress60Button.style.cursor = 'pointer';
    compress60Button.addEventListener('click', () => compressWithQuality(60));
    settingsMenu.appendChild(compress60Button);

    const compress40Button = document.createElement('button');
    compress40Button.textContent = 'Compress 40%';
    compress40Button.style.backgroundColor = '#444';
    compress40Button.style.color = 'white';
    compress40Button.style.border = 'none';
    compress40Button.style.padding = '8px 12px';
    compress40Button.style.borderRadius = '3px';
    compress40Button.style.cursor = 'pointer';
    compress40Button.addEventListener('click', () => compressWithQuality(40));
    settingsMenu.appendChild(compress40Button);

    const compress20Button = document.createElement('button');
    compress20Button.textContent = 'Compress 20%';
    compress20Button.style.backgroundColor = '#444';
    compress20Button.style.color = 'white';
    compress20Button.style.border = 'none';
    compress20Button.style.padding = '8px 12px';
    compress20Button.style.borderRadius = '3px';
    compress20Button.style.cursor = 'pointer';
    compress20Button.addEventListener('click', () => compressWithQuality(20));
    settingsMenu.appendChild(compress20Button);

    document.body.appendChild(settingsMenu);

    // Create the toggle button with an image icon
    const toggleButton = document.createElement('div');
    toggleButton.id = 'imageRemoverToggleButton';
    toggleButton.style.position = 'fixed';
    toggleButton.style.bottom = '10px';
    toggleButton.style.right = '10px';
    toggleButton.style.width = '40px';
    toggleButton.style.height = '40px';
    toggleButton.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
    toggleButton.style.border = '2px solid rgba(255,255,255,0.8)';
    toggleButton.style.boxShadow = '0 0 4px rgba(0,0,0,0.5)';
    toggleButton.style.borderRadius = '50%';
    toggleButton.style.zIndex = '2001';
    toggleButton.style.cursor = 'pointer';
    toggleButton.addEventListener('click', () => {
        settingsVisible = !settingsVisible;
        settingsMenu.style.display = settingsVisible ? 'flex' : 'none';
    });

    // Create an image element for the toggle icon
    const toggleIcon = document.createElement('img');
    // This Base64-encoded PNG icon represents an image/photo icon.
    toggleIcon.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAAAY1BMVEUAAAD///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////8q2g5fAAAAKXRSTlMAAQIEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4fICEiIyQlJicoKSorLC0uLzAxMjM0AAAC8ElEQVQ4y+3SzYqEUBiG4c9zco6np9nHc8qQWmWHEAmET1Hw/k/69FCIAtqFdd53KfFMYIP3xPsf9rmsxu1mzmBxmV9POFT6TULUT8lZ3FJRvp3Xk/Tb67bUSFCUWBdWCVRZo0JW0I8uQtU3W+UVsrV0/Ik47X2mD/0qVbjS6h0+0oFqD1OKC+9RNoN/1C4/1aYBwWa8k8l0L1hYDE8+SxO9/1L69QB/er6/KnWiF1hV9FDrK+NAYXqH1k3RUoi8mE4ar8yWDpN3+8h4nGp0wjUglIhD0Fe9Zy2N1Qcv4d+e3zTzbYJzNvC0eweMljNJTVI15VQJir6oGtBWpL83yVpP1o0lHL71k0lHL71k0lHL71k0lHL71k0lHL71k0lHL71k0lHL71k0lHL71k0lHL71k0lHL71k0lHL71k0lHL71k0lHL7/WT/wDTx+9BX+90MIAAAAASUVORK5CYII=';
    toggleIcon.style.width = '100%';
    toggleIcon.style.height = '100%';
    toggleIcon.style.borderRadius = '50%';
    toggleButton.appendChild(toggleIcon);

    // Append the toggle button to the DOM once available
    function appendToggleButton() {
        if (document.body) {
            document.body.appendChild(toggleButton);
            console.log('Toggle button added to the DOM.');
        } else {
            console.log('Document body not yet available, retrying...');
            setTimeout(appendToggleButton, 100);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', appendToggleButton);
    } else {
        appendToggleButton();
    }

    if (isGlobalRemoveEnabled) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', removeAllImages);
        } else {
            removeAllImages();
        }
    }
})();