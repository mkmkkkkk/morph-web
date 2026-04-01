// Morph PWA Service Worker — push notifications + offline shell

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
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
    icon: '/morph-192.png',
    badge: '/morph-192.png',
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
      // Try to focus an existing Morph window
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin)) {
          // Navigate existing window to the session if needed
          if (sessionId) {
            client.navigate(urlPath);
          }
          return client.focus();
        }
      }
      // No existing window — open a new one
      return self.clients.openWindow(urlPath);
    })
  );
});
