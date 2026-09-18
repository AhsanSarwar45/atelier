// The part of the app that is still there when the app is not.
//
// A phone freezes a web app within seconds of it being backgrounded, so the
// page cannot be what notices a chat started waiting — by then it is not
// running. This worker is: the server pushes to it, and it draws the
// notification whether or not a window exists (bw-ndlu.3).

// A worker registered today should handle the next push, not wait for every
// tab of the old one to close first.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  // A push with no body is still worth drawing: it means the server had
  // something to say and the payload was lost, which is better said than
  // swallowed.
  let sent = {};
  if (event.data) {
    try {
      sent = event.data.json();
    } catch {
      sent = { body: event.data.text() };
    }
  }
  const title = sent.title || 'Atelier';
  const href = sent.href || '/';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: sent.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      // One notification per chat: a chat that changes twice replaces its own
      // notification rather than stacking a second one under it.
      tag: sent.tag || href,
      renotify: true,
      data: { href },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const href = event.notification.data?.href || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows[0];
      if (open) return open.focus().then(() => open.navigate(href));
      return clients.openWindow(href);
    }),
  );
});
