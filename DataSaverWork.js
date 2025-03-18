// ==UserScript==
// @name        Adguard Mobile Image Remover/Compressor (Global)
// @namespace   YourNamespace
// @version     1.4
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

    // Initialize arrays for images and video posters
    let originalImages = [];
    let originalVideoPosters = [];
    let currentImageState = 'original'; // 'original', 'removed', 'compressed'
    const lowResPlaceholder = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="; // 1x1 transparent pixel
    const globalRemoveKey = 'globalImageRemovalEnabled';
    let settingsVisible = false;
    
    // Default is now ON
    const isGlobalRemoveEnabled = getValue(globalRemoveKey, true);

    // Minimum image size (in pixels) to consider for removal/compression.
    // If an image is smaller than this and not a known video image, it is skipped.
    const MIN_IMAGE_SIZE = 30; // Adjust this value if needed

    // Regex pattern to force removal/compression of video-related images even if small.
    const videoHostsPattern = /youtube\.com|ytimg\.com|vimeo\.com|dailymotion\.com/i;

    // Function to save a value using GM_setValue (or localStorage fallback)
    function saveValue(key, value) {
        if (typeof GM_setValue !== 'undefined') {
            GM_setValue(key, value);
        } else {
            localStorage.setItem(key, JSON.stringify(value));
        }
    }

    // Function to get a value using GM_getValue (or localStorage fallback)
    function getValue(key, defaultValue) {
        if (typeof GM_getValue !== 'undefined') {
            return GM_getValue(key, defaultValue);
        } else {
            const storedValue = localStorage.getItem(key);
            return storedValue ? JSON.parse(storedValue) : defaultValue;
        }
    }

    // Determine whether an image should be processed.
    function shouldProcessImage(img) {
        // Always process images from known video hosts.
        if (videoHostsPattern.test(img.src)) {
            return true;
        }
        const rect = img.getBoundingClientRect();
        return rect.width >= MIN_IMAGE_SIZE && rect.height >= MIN_IMAGE_SIZE;
    }

    // Filter images based on the above criteria.
    function filterImages(images) {
        return Array.from(images).filter(shouldProcessImage);
    }

    // Function to remove all images and video posters (excluding those that don't meet criteria)
    function removeAllImages() {
        // Process <img> elements
        const images = filterImages(document.querySelectorAll('img'));
        originalImages = [];
        images.forEach(img => {
            originalImages.push({ element: img, src: img.src });
            img.removeAttribute('src');
            img.style.visibility = 'hidden'; // Hide to preserve layout
        });
        // Process video poster attributes
        originalVideoPosters = [];
        const videos = document.querySelectorAll('video[poster]');
        videos.forEach(video => {
            originalVideoPosters.push({ element: video, poster: video.poster });
            video.removeAttribute('poster');
        });
        currentImageState = 'removed';
        console.log('Images and video posters removed globally.');
    }

    // Function to restore original images and video posters
    function restoreAllImages() {
        if (currentImageState === 'removed' || currentImageState === 'compressed') {
            originalImages.forEach(item => {
                if (item.element) {
                    item.element.src = item.src;
                    item.element.style.visibility = '';
                }
            });
            originalImages = [];
            originalVideoPosters.forEach(item => {
                if (item.element) {
                    item.element.poster = item.poster;
                }
            });
            originalVideoPosters = [];
            currentImageState = 'original';
            console.log('Original images and video posters restored.');
            saveValue(globalRemoveKey, true); // Set to enabled by default after restoration
        } else {
            console.log('No images to restore.');
        }
    }

    // Function to "compress" images (replace with low-res placeholder) and video posters
    function compressImages() {
        const images = filterImages(document.querySelectorAll('img'));
        originalImages = [];
        images.forEach(img => {
            originalImages.push({ element: img, src: img.src });
            img.src = lowResPlaceholder;
        });
        // Process video posters
        originalVideoPosters = [];
        const videos = document.querySelectorAll('video[poster]');
        videos.forEach(video => {
            originalVideoPosters.push({ element: video, poster: video.poster });
            video.poster = lowResPlaceholder;
        });
        currentImageState = 'compressed';
        console.log('Images and video posters "compressed" with low-res placeholders.');
    }

    // Function to handle specific compression levels (using placeholder for now)
    function compressWithQuality(quality) {
        alert(`Image compression to ${quality}% using a low-resolution placeholder.`);
        compressImages();
    }

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

    // Create the toggle button (transparent icon)
    const toggleButton = document.createElement('div');
    toggleButton.id = 'imageRemoverToggleButton';
    toggleButton.style.position = 'fixed';
    toggleButton.style.bottom = '10px';
    toggleButton.style.right = '10px';
    toggleButton.style.width = '40px';
    toggleButton.style.height = '40px';
    toggleButton.style.backgroundColor = 'rgba(0, 0, 0, 0.5)'; // semi-transparent
    // Added border and box-shadow for better visibility on varying backgrounds
    toggleButton.style.border = '2px solid rgba(255,255,255,0.8)';
    toggleButton.style.boxShadow = '0 0 4px rgba(0,0,0,0.5)';
    toggleButton.style.borderRadius = '50%';
    toggleButton.style.zIndex = '2001';
    toggleButton.style.cursor = 'pointer';
    toggleButton.addEventListener('click', () => {
        settingsVisible = !settingsVisible;
        settingsMenu.style.display = settingsVisible ? 'flex' : 'none';
    });

    // Add a visual cue to the toggle icon (optional)
    const iconIndicator = document.createElement('div');
    iconIndicator.style.width = '60%';
    iconIndicator.style.height = '60%';
    iconIndicator.style.backgroundColor = 'white';
    iconIndicator.style.borderRadius = '50%';
    iconIndicator.style.margin = 'auto';
    toggleButton.appendChild(iconIndicator);

    // Append the toggle button to the body after the DOM is loaded
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

    // Apply global image (and video poster) removal on page load if enabled
    if (isGlobalRemoveEnabled) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', removeAllImages);
        } else {
            removeAllImages();
        }
    }

})();