// ==UserScript==
// @name        Adguard Mobile Image Remover/Compressor1 (Global)
// @namespace   YourNamespace
// @version     1.6
// @description Removes or compresses images globally to save data, including video posters.
// @author      You
// @match       *://*/*
// @grant       GM_setValue
// @grant       GM_getValue
// @run-at      document-idle
// @mobile      true
//
// The following @require lines assume you have these libraries available via CDN.
// You can host these libraries yourself if needed.
// @require     https://unpkg.com/brotli-wasm@latest/dist/brotli.js
// @require     https://unpkg.com/zstd-codec@latest/dist/zstd-codec.js
// ==/UserScript==

(async function() {
    'use strict';

    // -------------------- Initialize Zstd Library --------------------
    let ZstdInstance = null;
    if (typeof ZstdCodec !== 'undefined') {
        await new Promise((resolve, reject) => {
            ZstdCodec.run(zstd => {
                ZstdInstance = zstd;
                console.log("Zstd initialized.");
                resolve();
            });
        });
    } else {
        console.error("ZstdCodec library not loaded.");
    }

    // -------------------- Configuration and State --------------------
    const globalRemoveKey      = 'globalImageRemovalEnabled';
    const globalCompressionKey = 'globalCompressionEnabled';
    const compressionMethodKey = 'compressionMethod';

    const isGlobalRemoveEnabled      = getValue(globalRemoveKey, true);
    const isGlobalCompressionEnabled = getValue(globalCompressionKey, false);
    // "lowres", "brotli", or "zstd"
    const currentCompressionMethod   = getValue(compressionMethodKey, "lowres");

    let originalImages       = [];
    let originalVideoPosters = [];
    let currentImageState    = 'original';

    // 1x1 transparent PNG used as a low-res placeholder.
    const lowResPlaceholder = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    const MIN_IMAGE_SIZE    = 30; // in pixels
    const videoHostsPattern = /youtube\.com|ytimg\.com|vimeo\.com|dailymotion\.com/i;

    // -------------------- Utility Functions --------------------
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
        return Array.from(images).filter(shouldProcessImage);
    }

    // -------------------- Removal and Restoration --------------------
    function removeAllImages() {
        const images = filterImages(document.querySelectorAll('img'));
        originalImages = [];
        images.forEach(img => {
            originalImages.push({ element: img, src: img.src });
            img.removeAttribute('src');
            img.style.visibility = 'hidden'; // preserve layout
        });
        originalVideoPosters = [];
        const videos = document.querySelectorAll('video[poster]');
        videos.forEach(video => {
            originalVideoPosters.push({ element: video, poster: video.poster });
            video.removeAttribute('poster');
        });
        currentImageState = 'removed';
        console.log('Images and video posters removed.');
    }
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
            saveValue(globalRemoveKey, true);
            saveValue(globalCompressionKey, false);
        } else {
            console.log('No images to restore.');
        }
    }

    // -------------------- Compression Functions --------------------
    // Fetch image data as an ArrayBuffer.
    async function fetchImageData(url) {
        try {
            const response = await fetch(url);
            const blob = await response.blob();
            return await blob.arrayBuffer();
        } catch (e) {
            console.error("Error fetching image data:", e);
            return null;
        }
    }

    // --- Brotli Compression (using brotli-wasm library) ---
    async function brotliCompress(arrayBuffer) {
        try {
            const input = new Uint8Array(arrayBuffer);
            // Brotli.compress returns a Uint8Array.
            const compressed = Brotli.compress(input);
            return compressed.buffer;
        } catch (e) {
            console.error("Brotli compression error:", e);
            return arrayBuffer;
        }
    }
    async function brotliDecompress(arrayBuffer) {
        try {
            const input = new Uint8Array(arrayBuffer);
            const decompressed = Brotli.decompress(input);
            return decompressed.buffer;
        } catch (e) {
            console.error("Brotli decompression error:", e);
            return arrayBuffer;
        }
    }

    // --- Zstd Compression (using zstd-codec library) ---
    async function zstdCompress(arrayBuffer) {
        if (!ZstdInstance) {
            console.error("Zstd instance not available.");
            return arrayBuffer;
        }
        try {
            const input = new Uint8Array(arrayBuffer);
            const compressed = ZstdInstance.compress(input);
            return compressed.buffer;
        } catch (e) {
            console.error("Zstd compression error:", e);
            return arrayBuffer;
        }
    }
    async function zstdDecompress(arrayBuffer) {
        if (!ZstdInstance) {
            console.error("Zstd instance not available.");
            return arrayBuffer;
        }
        try {
            const input = new Uint8Array(arrayBuffer);
            const decompressed = ZstdInstance.decompress(input);
            return decompressed.buffer;
        } catch (e) {
            console.error("Zstd decompression error:", e);
            return arrayBuffer;
        }
    }

    // For each image, fetch its data, compress & decompress it, and update its source.
    async function compressAndReplaceImage(img, algorithm) {
        try {
            const imageData = await fetchImageData(img.src);
            if (!imageData) return;
            let compressed, decompressed;
            if (algorithm === "brotli") {
                compressed  = await brotliCompress(imageData);
                decompressed = await brotliDecompress(compressed);
            } else if (algorithm === "zstd") {
                compressed  = await zstdCompress(imageData);
                decompressed = await zstdDecompress(compressed);
            } else {
                // fallback to low-res placeholder
                img.src = lowResPlaceholder;
                return;
            }
            // Create a blob from the decompressed data and update the image.
            const blob = new Blob([decompressed], { type: "image/jpeg" }); // adjust MIME type if needed
            const objectURL = URL.createObjectURL(blob);
            img.src = objectURL;
        } catch (e) {
            console.error("Error during compression process:", e);
            img.src = lowResPlaceholder;
        }
    }
    async function applyCompression() {
        const method = getValue(compressionMethodKey, "lowres");
        const images = filterImages(document.querySelectorAll('img'));
        originalImages = [];
        for (const img of images) {
            originalImages.push({ element: img, src: img.src });
            if (method === "lowres") {
                img.src = lowResPlaceholder;
            } else {
                await compressAndReplaceImage(img, method);
            }
        }
        // Process video posters using low-res placeholder for simplicity.
        const videos = document.querySelectorAll('video[poster]');
        originalVideoPosters = [];
        videos.forEach(video => {
            originalVideoPosters.push({ element: video, poster: video.poster });
            video.poster = lowResPlaceholder;
        });
        currentImageState = 'compressed';
        console.log("Images compressed using method:", method);
    }

    // -------------------- UI: Settings Menu and Controls --------------------
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

    // Button: Toggle image removal.
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

    // Button: Restore images.
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

    // Button: Toggle compression.
    const compressionToggleButton = document.createElement('button');
    compressionToggleButton.textContent = isGlobalCompressionEnabled ? 'Disable Compression' : 'Enable Compression';
    compressionToggleButton.style.backgroundColor = '#444';
    compressionToggleButton.style.color = 'white';
    compressionToggleButton.style.border = 'none';
    compressionToggleButton.style.padding = '8px 12px';
    compressionToggleButton.style.borderRadius = '3px';
    compressionToggleButton.style.cursor = 'pointer';
    compressionToggleButton.addEventListener('click', async () => {
        let enabled = getValue(globalCompressionKey, false);
        enabled = !enabled;
        saveValue(globalCompressionKey, enabled);
        compressionToggleButton.textContent = enabled ? 'Disable Compression' : 'Enable Compression';
        if (enabled) {
            await applyCompression();
        } else {
            restoreAllImages();
        }
    });
    settingsMenu.appendChild(compressionToggleButton);

    // Buttons to choose compression method.
    const methodLowResButton = document.createElement('button');
    methodLowResButton.textContent = 'Use Low-Res';
    methodLowResButton.style.backgroundColor = '#444';
    methodLowResButton.style.color = 'white';
    methodLowResButton.style.border = 'none';
    methodLowResButton.style.padding = '8px 12px';
    methodLowResButton.style.borderRadius = '3px';
    methodLowResButton.style.cursor = 'pointer';
    methodLowResButton.addEventListener('click', () => {
        saveValue(compressionMethodKey, "lowres");
        alert("Compression method set to Low-Res placeholder. Toggle compression to apply changes.");
    });
    settingsMenu.appendChild(methodLowResButton);

    const methodBrotliButton = document.createElement('button');
    methodBrotliButton.textContent = 'Use Brotli';
    methodBrotliButton.style.backgroundColor = '#444';
    methodBrotliButton.style.color = 'white';
    methodBrotliButton.style.border = 'none';
    methodBrotliButton.style.padding = '8px 12px';
    methodBrotliButton.style.borderRadius = '3px';
    methodBrotliButton.style.cursor = 'pointer';
    methodBrotliButton.addEventListener('click', () => {
        saveValue(compressionMethodKey, "brotli");
        alert("Compression method set to Brotli. Toggle compression to apply changes.");
    });
    settingsMenu.appendChild(methodBrotliButton);

    const methodZstdButton = document.createElement('button');
    methodZstdButton.textContent = 'Use Zstd';
    methodZstdButton.style.backgroundColor = '#444';
    methodZstdButton.style.color = 'white';
    methodZstdButton.style.border = 'none';
    methodZstdButton.style.padding = '8px 12px';
    methodZstdButton.style.borderRadius = '3px';
    methodZstdButton.style.cursor = 'pointer';
    methodZstdButton.addEventListener('click', () => {
        saveValue(compressionMethodKey, "zstd");
        alert("Compression method set to Zstd. Toggle compression to apply changes.");
    });
    settingsMenu.appendChild(methodZstdButton);

    document.body.appendChild(settingsMenu);

    // -------------------- Toggle Button for Settings --------------------
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
        settingsMenu.style.display = settingsMenu.style.display === 'none' ? 'flex' : 'none';
    });
    const iconIndicator = document.createElement('div');
    iconIndicator.style.width = '60%';
    iconIndicator.style.height = '60%';
    iconIndicator.style.backgroundColor = 'white';
    iconIndicator.style.borderRadius = '50%';
    iconIndicator.style.margin = 'auto';
    toggleButton.appendChild(iconIndicator);
    function appendToggleButton() {
        if (document.body) {
            document.body.appendChild(toggleButton);
            console.log('Toggle button added.');
        } else {
            setTimeout(appendToggleButton, 100);
        }
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', appendToggleButton);
    } else {
        appendToggleButton();
    }

    // -------------------- Auto-apply on Page Load --------------------
    if (isGlobalRemoveEnabled) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', removeAllImages);
        } else {
            removeAllImages();
        }
    }
    if (isGlobalCompressionEnabled) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', applyCompression);
        } else {
            await applyCompression();
        }
    }
})();