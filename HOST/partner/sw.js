// sw.js
const CACHE_NAME = 'my-app-cache-v1';
const urlsToCache = [
    '/',
    '/index.html',
    '/apikey.html',
    '/category.html',
    '/dashboard.html',
    '/footer.html',
    '/login.html',
    '/signup.html',
    '/css/page.css',
    '/images/icon-192.png',
    '/images/icon-512.png'
];

// Enhanced logging function to send detailed logs to the client
const sendLog = (eventType, data = {}) => {
    const logEntry = {
        timestamp: new Date().toISOString(),
        event: eventType,
        swContext: {
            scope: self.registration.scope,
            userAgent: self.navigator.userAgent || 'Not available',
            online: navigator.onLine,
            connection: navigator.connection ? {
                effectiveType: navigator.connection.effectiveType,
                rtt: navigator.connection.rtt,
                downlink: navigator.connection.downlink
            } : 'Not available'
        },
        ...data
    };
    self.clients.matchAll({ includeUncontrolled: true }).then(clients => {
        if (clients.length === 0) {
            console.warn('No clients found to send log:', logEntry);
        }
        clients.forEach(client => client.postMessage({ type: 'LOG', log: JSON.stringify(logEntry) }));
    }).catch(err => {
        console.error('Error sending log to clients:', err);
    });
};

// Install event: Cache resources with detailed logging
self.addEventListener('install', event => {
    sendLog('install_start', { message: 'Service worker installation initiated' });
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            sendLog('install_caching', { message: 'Caching resources', urls: urlsToCache });
            return cache.addAll(urlsToCache).then(() => {
                sendLog('install_success', { message: 'Resources cached successfully' });
            }).catch(err => {
                sendLog('install_error', {
                    errorType: err.constructor.name,
                    errorMessage: err.message,
                    errorStack: err.stack || 'No stack available'
                });
                throw err;
            });
        }).catch(err => {
            sendLog('install_cache_open_failed', {
                errorType: err.constructor.name,
                errorMessage: err.message
            });
            throw err;
        })
    );
});

// Activate event: Clean up old caches with logging
self.addEventListener('activate', event => {
    sendLog('activate_start', { message: 'Service worker activation initiated' });
    const cacheWhitelist = [CACHE_NAME];
    event.waitUntil(
        caches.keys().then(cacheNames => {
            sendLog('activate_cache_list', { cacheNames });
            return Promise.all(
                cacheNames.map(cacheName => {
                    if (!cacheWhitelist.includes(cacheName)) {
                        sendLog('activate_deleting_cache', { cacheName });
                        return caches.delete(cacheName).then(() => {
                            sendLog('activate_cache_deleted', { cacheName });
                        });
                    }
                }).filter(Boolean)
            );
        }).then(() => {
            sendLog('activate_complete', { message: 'Activation completed' });
        }).catch(err => {
            sendLog('activate_error', {
                errorType: err.constructor.name,
                errorMessage: err.message
            });
        })
    );
});

// Fetch event: Handle requests with comprehensive debugging
self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    const requestClone = event.request.clone();
    const isIOS = /iPhone|iPad|iPod/.test(self.navigator.userAgent || '');

    sendLog('fetch_triggered', {
        url: url.href,
        method: event.request.method,
        headers: Object.fromEntries(event.request.headers.entries()),
        mode: event.request.mode,
        credentials: event.request.credentials,
        cache: event.request.cache,
        redirect: event.request.redirect,
        referrer: event.request.referrer,
        isIOS
    });

    // Always bypass API requests to AWS API Gateway
    if (url.origin === 'https://ytepcnwske.execute-api.eu-west-2.amazonaws.com') {
        sendLog('api_bypassing', { message: 'Bypassing service worker for API request', url: url.href });
        event.respondWith(fetch(event.request));
        return;
    }

    // Handle cached resources (unchanged)
    sendLog('fetch_cache_check', { url: url.href });
    event.respondWith(
        caches.match(event.request).then(cachedResponse => {
            if (cachedResponse) {
                sendLog('cache_hit', { url: url.href });
                return cachedResponse;
            }
            sendLog('fetch_network', { url: url.href });
            return fetch(event.request).then(networkResponse => {
                const duration = Date.now() - (event.request.startTimestamp || Date.now());
                sendLog('fetch_success', {
                    url: url.href,
                    status: networkResponse.status,
                    headers: Object.fromEntries(networkResponse.headers.entries()),
                    durationMs: duration
                });
                return networkResponse;
            }).catch(err => {
                sendLog('fetch_failed', {
                    url: url.href,
                    errorType: err.constructor.name,
                    errorMessage: err.message,
                    errorStack: err.stack || 'No stack available'
                });
                if (event.request.mode === 'navigate') {
                    sendLog('fetch_fallback', { url: '/index.html' });
                    return caches.match('/index.html');
                }
                return new Response(JSON.stringify({ error: 'Fetch failed', details: err.message }), {
                    status: 503,
                    headers: { 'Content-Type': 'application/json' }
                });
            });
        })
    );
});

// Message event: Handle client messages
self.addEventListener('message', event => {
    sendLog('message_received', { data: event.data });
    if (event.data.type === 'CLEAR_LOGS') {
        sendLog('message_clear_logs', { message: 'Logs cleared by user request' });
    }
});