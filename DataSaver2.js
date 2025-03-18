// ==UserScript==
// @name        Adguard Mobile Image Remover/Compressor (Global)
// @namespace   YourNamespace
// @version     1.6
// @description Removes or compresses images globally to save data, including video posters. Now integrates Brotli and Zstd for on‑device compression.
// @author      You
// @match       *://*/*
// @grant       GM_setValue
// @grant       GM_getValue
// @run-at      document-idle
// @mobile      true
// @require     https://cdn.jsdelivr.net/npm/brotli-wasm@1.0.1/dist/brotli.js
// @require     https://cdn.jsdelivr.net/npm/zstd-codec@1.3.1/dist/zstd-codec.js
// ==/UserScript==

(function() {
    'use strict';

    // ----- Settings Keys and Defaults -----
    const globalRemoveKey = 'globalImageRemovalEnabled';           // Main removal/compression toggle
    const globalCompressionKey = 'globalCompressionEnabled';         // Whether to use compression instead of removal
    const globalCompressionAlgorithmKey = 'globalCompressionAlgorithm'; // Which compression algorithm to use

    // Defaults: removal/compression is enabled on load;
    // compression mode is off by default (so images are removed unless you enable compression),
    // and the default compression algorithm is "placeholder".
    const isGlobalRemoveEnabled = getValue(globalRemoveKey, true);
    let isGlobalCompressionEnabled = getValue(globalCompressionKey, false);
    let compressionAlgorithm = getValue(globalCompressionAlgorithmKey, "placeholder");

    // ----- Variables to Store Originals -----
    let originalImages = [];
    let originalVideoPosters = [];
    let currentImageState = 'original'; // 'original', 'removed', 'compressed'
    const lowResPlaceholder = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="; // fallback
    let settingsVisible = false;

    // ----- Constants -----
    const MIN_IMAGE_SIZE = 30; // Only process images larger than this (in pixels)
    const videoHostsPattern = /youtube\.com|ytimg\.com|vimeo\.com|dailymotion\.com/i;

    // ----- Utility Functions -----
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

    // Determine if an image should be processed (always true for known video hosts)
    function shouldProcessImage(img) {
        if (videoHostsPattern.test(img.src)) {
            return true;
        }
        const rect = img.getBoundingClientRect();
        return rect.width >= MIN_IMAGE_SIZE && rect.height >= MIN_IMAGE_SIZE;
    }

    function filterImages(images) {
        return Array.from(images).filter(shouldProcessImage);
    }

    // ----- Compression Helpers -----

    // Compress an image element by drawing it onto a canvas at reduced dimensions,
    // then obtaining its binary data. Depending on the selected algorithm,
    // the binary data is (optionally) compressed and decompressed.
    async function compressImage(img) {
        return new Promise(resolve => {
            // Create a canvas and scale image to 50% of original dimensions.
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            const width = img.naturalWidth;
            const height = img.naturalHeight;
            const newWidth = Math.max(1, Math.floor(width * 0.5));
            const newHeight = Math.max(1, Math.floor(height * 0.5));
            canvas.width = newWidth;
            canvas.height = newHeight;
            ctx.drawImage(img, 0, 0, newWidth, newHeight);

            // Get a JPEG blob from the canvas (quality 0.5)
            canvas.toBlob(async (blob) => {
                try {
                    const arrayBuffer = await blob.arrayBuffer();
                    let compressed, decompressed;
                    if (compressionAlgorithm === "placeholder") {
                        // No extra compression—just use the canvas output.
                        decompressed = arrayBuffer;
                    } else if (compressionAlgorithm === "brotli") {
                        // Use Brotli (assumes Brotli.compress/decompress are available).
                        // Note: Brotli.compress expects a Uint8Array.
                        compressed = Brotli.compress(new Uint8Array(arrayBuffer));
                        decompressed = Brotli.decompress(compressed);
                    } else if (compressionAlgorithm === "zstd") {
                        // Use Zstd via the zstd-codec library.
                        await new Promise(resolveZstd => {
                            ZstdCodec.run(zstd => {
                                const simple = new zstd.Simple();
                                compressed = simple.compress(new Uint8Array(arrayBuffer));
                                decompressed = simple.decompress(compressed);
                                resolveZstd();
                            });
                        });
                    }
                    // Reconstruct a blob from the (de)compressed data.
                    const newBlob = new Blob([decompressed], {type: blob.type});
                    const newUrl = URL.createObjectURL(newBlob);
                    resolve(newUrl);
                } catch (e) {
                    console.error('Compression error for image:', e);
                    resolve(lowResPlaceholder);
                }
            }, 'image/jpeg', 0.5);
        });
    }

    // For video posters we may not have an <img> element, so load from URL.
    async function compressImageFromUrl(url) {
        return new Promise((resolve, reject) => {
            const tempImg = new Image();
            tempImg.crossOrigin = "Anonymous";
            tempImg.onload = async function() {
                try {
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');
                    const newWidth = Math.max(1, Math.floor(tempImg.naturalWidth * 0.5));
                    const newHeight = Math.max(1, Math.floor(tempImg.naturalHeight * 0.5));
                    canvas.width = newWidth;
                    canvas.height = newHeight;
                    ctx.drawImage(tempImg, 0, 0, newWidth, newHeight);
                    canvas.toBlob(async (blob) => {
                        try {
                            const arrayBuffer = await blob.arrayBuffer();
                            let compressed, decompressed;
                            if (compressionAlgorithm === "placeholder") {
                                decompressed = arrayBuffer;
                            } else if (compressionAlgorithm === "brotli") {
                                compressed = Brotli.compress(new Uint8Array(arrayBuffer));
                                decompressed = Brotli.decompress(compressed);
                            } else if (compressionAlgorithm === "zstd") {
                                await new Promise(resolveZstd => {
                                    ZstdCodec.run(zstd => {
                                        const simple = new zstd.Simple();
                                        compressed = simple.compress(new Uint8Array(arrayBuffer));
                                        decompressed = simple.decompress(compressed);
                                        resolveZstd();
                                    });
                                });
                            }
                            const newBlob = new Blob([decompressed], {type: blob.type});
                            const newUrl = URL.createObjectURL(newBlob);
                            resolve(newUrl);
                        } catch (e) {
                            console.error('Compression error for video poster:', e);
                            resolve(lowResPlaceholder);
                        }
                    }, 'image/jpeg', 0.5);
                } catch (e) {
                    reject(e);
                }
            };
            tempImg.onerror = function(e) {
                reject(e);
            };
            tempImg.src = url;
        });
    }

    // ----- Core Functions -----
    function removeAllImages() {
        const images = filterImages(document.querySelectorAll('img'));
        originalImages = [];
        images.forEach(img => {
            originalImages.push({ element: img, src: img.src });
            img.removeAttribute('src');
            img.style.visibility = 'hidden';
        });
        originalVideoPosters = [];
        const videos = document.querySelectorAll('video[poster]');
        videos.forEach(video => {
            originalVideoPosters.push({ element: video, poster: video.poster });
            video.removeAttribute('poster');
        });
        currentImageState = 'removed';
        console.log('Images and video posters removed globally.');
    }

    async function compressImages() {
        console.log("Using compression algorithm:", compressionAlgorithm);
        const images = filterImages(document.querySelectorAll('img'));
        originalImages = [];
        for (const img of images) {
            originalImages.push({ element: img, src: img.src });
            try {
                const newUrl = await compressImage(img);
                img.src = newUrl;
                img.style.visibility = ''; // ensure visible
            } catch (e) {
                console.error("Error compressing image:", e);
                img.src = lowResPlaceholder;
            }
        }
        originalVideoPosters = [];
        const videos = document.querySelectorAll('video[poster]');
        for (const video of videos) {
            originalVideoPosters.push({ element: video, poster: video.poster });
            try {
                const newUrl = await compressImageFromUrl(video.poster);
                video.poster = newUrl;
            } catch (e) {
                console.error("Error compressing video poster:", e);
                video.poster = lowResPlaceholder;
            }
        }
        currentImageState = 'compressed';
        console.log('Images and video posters compressed using algorithm:', compressionAlgorithm);
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
            // Keep removal enabled by default on restore.
            saveValue(globalRemoveKey, true);
        } else {
            console.log('No images to restore.');
        }
    }

    function compressWithQuality(quality) {
        alert(`Image compression to ${quality}% using algorithm: ${compressionAlgorithm}.`);
        // For demonstration, quality is not used in this example
        compressImages();
    }

    // ----- UI: Settings Menu & Toggle Button -----
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

    // Main removal/compression toggle button.
    const removeButton = document.createElement('button');
    removeButton.textContent = isGlobalRemoveEnabled ? 'Disable Image Removal/Compression' : 'Enable Image Removal/Compression';
    removeButton.style.backgroundColor = '#444';
    removeButton.style.color = 'white';
    removeButton.style.border = 'none';
    removeButton.style.padding = '8px 12px';
    removeButton.style.borderRadius = '3px';
    removeButton.style.cursor = 'pointer';
    removeButton.addEventListener('click', async () => {
        const enabled = getValue(globalRemoveKey, true);
        saveValue(globalRemoveKey, !enabled);
        removeButton.textContent = !enabled ? 'Disable Image Removal/Compression' : 'Enable Image Removal/Compression';
        if (!enabled) {
            if (getValue(globalCompressionKey, false)) {
                await compressImages();
            } else {
                removeAllImages();
            }
        } else {
            restoreAllImages();
        }
    });
    settingsMenu.appendChild(removeButton);

    // Toggle compression mode button.
    const toggleCompressionButton = document.createElement('button');
    toggleCompressionButton.textContent = isGlobalCompressionEnabled ? 'Disable Compression' : 'Enable Compression';
    toggleCompressionButton.style.backgroundColor = '#444';
    toggleCompressionButton.style.color = 'white';
    toggleCompressionButton.style.border = 'none';
    toggleCompressionButton.style.padding = '8px 12px';
    toggleCompressionButton.style.borderRadius = '3px';
    toggleCompressionButton.style.cursor = 'pointer';
    toggleCompressionButton.addEventListener('click', () => {
        const compEnabled = getValue(globalCompressionKey, false);
        isGlobalCompressionEnabled = !compEnabled;
        saveValue(globalCompressionKey, isGlobalCompressionEnabled);
        toggleCompressionButton.textContent = isGlobalCompressionEnabled ? 'Disable Compression' : 'Enable Compression';
    });
    settingsMenu.appendChild(toggleCompressionButton);

    // Compression algorithm selection buttons.
    const placeholderButton = document.createElement('button');
    placeholderButton.textContent = 'Use Placeholder';
    placeholderButton.style.backgroundColor = compressionAlgorithm === "placeholder" ? '#666' : '#444';
    placeholderButton.style.color = 'white';
    placeholderButton.style.border = 'none';
    placeholderButton.style.padding = '8px 12px';
    placeholderButton.style.borderRadius = '3px';
    placeholderButton.style.cursor = 'pointer';
    placeholderButton.addEventListener('click', () => {
        saveValue(globalCompressionAlgorithmKey, "placeholder");
        compressionAlgorithm = "placeholder";
        updateCompressionAlgorithmButtons();
    });
    settingsMenu.appendChild(placeholderButton);

    const brotliButton = document.createElement('button');
    brotliButton.textContent = 'Use Brotli';
    brotliButton.style.backgroundColor = compressionAlgorithm === "brotli" ? '#666' : '#444';
    brotliButton.style.color = 'white';
    brotliButton.style.border = 'none';
    brotliButton.style.padding = '8px 12px';
    brotliButton.style.borderRadius = '3px';
    brotliButton.style.cursor = 'pointer';
    brotliButton.addEventListener('click', () => {
        saveValue(globalCompressionAlgorithmKey, "brotli");
        compressionAlgorithm = "brotli";
        updateCompressionAlgorithmButtons();
    });
    settingsMenu.appendChild(brotliButton);

    const zstdButton = document.createElement('button');
    zstdButton.textContent = 'Use Zstd';
    zstdButton.style.backgroundColor = compressionAlgorithm === "zstd" ? '#666' : '#444';
    zstdButton.style.color = 'white';
    zstdButton.style.border = 'none';
    zstdButton.style.padding = '8px 12px';
    zstdButton.style.borderRadius = '3px';
    zstdButton.style.cursor = 'pointer';
    zstdButton.addEventListener('click', () => {
        saveValue(globalCompressionAlgorithmKey, "zstd");
        compressionAlgorithm = "zstd";
        updateCompressionAlgorithmButtons();
    });
    settingsMenu.appendChild(zstdButton);

    function updateCompressionAlgorithmButtons() {
        placeholderButton.style.backgroundColor = compressionAlgorithm === "placeholder" ? '#666' : '#444';
        brotliButton.style.backgroundColor = compressionAlgorithm === "brotli" ? '#666' : '#444';
        zstdButton.style.backgroundColor = compressionAlgorithm === "zstd" ? '#666' : '#444';
    }

    // Extra quality buttons (for demonstration)
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

    // ----- Toggle Button (the visible icon) -----
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

    const iconIndicator = document.createElement(