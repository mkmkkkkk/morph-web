// Morph PWA Service Worker — offline shell + push notifications

const CACHE_NAME = 'morph-shell-v3';

// App shell — enough to render the UI when tunnel is down
const SHELL_URLS = [
  '/',
  '/manifest.json',
];

// ─── Install: cache app shell ───
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS))
  );
  self.skipWaiting();
});

// ─── Activate: clean old caches, claim clients ───
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ─── Fetch: network-first for HTML, cache-first for hashed assets ───
self.addEventListener('fetch', (event) => {
  const { request } = event;
  // Only handle GET
  if (request.method !== 'GET') return;
  // Skip WebSocket, API calls, chrome-extension
  const url = new URL(request.url);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
  if (url.pathname.startsWith('/v2/') || url.pathname.startsWith('/socket.io/')) return;

  // HTML navigation: network-first, fall back to cached shell
  if (request.mode === 'navigate' || request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(request).then((res) => {
        // Cache fresh copy
        const clone = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(request, clone));
        return res;
      }).catch(() => caches.match('/') || new Response('Offline', { status: 503 }))
    );
    return;
  }

  // Hashed assets (JS/CSS bundles in /assets/): cache-first
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(request, clone));
          return res;
        });
      })
    );
    return;
  }

  // Other static files (fonts, images, videos): stale-while-revalidate
  event.respondWith(
    caches.match(request).then((cached) => {
      const fetchPromise = fetch(request).then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(request, clone));
        }
        return res;
      }).catch(() => cached);
      return cached || fetchPromise;
    })
  );
});

// ─── Push notification handler ───
self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'Morph', body: event.data.text() };
  }

  const title = payload.title || 'Morph';
  const options = {
    body: payload.body || '',
    icon: '/icon-192-v4.png',
    badge: '/icon-192-v4.png',
    tag: payload.tag || 'morph-default',
    data: payload.data || {},
    renotify: true,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// ─── Notification click handler ───
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const sessionId = event.notification.data?.sessionId;
  const urlPath = sessionId ? `/sessions/${sessionId}` : '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin)) {
          if (sessionId) client.navigate(urlPath);
          return client.focus();
        }
      }
      return self.clients.openWindow(urlPath);
    })
  );
});
