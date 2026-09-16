self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const href = event.notification.data?.href || '/';
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
    const open = windows[0];
    if (open) return open.focus().then(() => open.navigate(href));
    return clients.openWindow(href);
  }));
});
