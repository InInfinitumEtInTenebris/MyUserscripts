// ==UserScript==
// @name        Adguard Mobile Image Remover/Compressor (Global)
// @namespace   YourNamespace
// @version     1.5
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

    const observer = new MutationObserver(mutations => {
        mutations.forEach(mutation => {
            mutation.addedNodes.forEach(node => {
                if (node.tagName === 'IMG' || node.querySelectorAll) {
                    removeAllImages();
                }
            });
        });
    });

    observer.observe(document.body, { childList: true, subtree: true });

    if (isGlobalRemoveEnabled) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', removeAllImages);
        } else {
            removeAllImages();
        }
    }

})();