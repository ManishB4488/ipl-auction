// Minimal service worker: lets the site install as an app. It never caches app files, so updates always arrive instantly.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.method !== 'GET' || r.mode !== 'navigate') return;   // only page loads; everything else goes straight to the network
  e.respondWith(fetch(r).catch(() => new Response(
    '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="background:#070b16;color:#fff;font-family:sans-serif;text-align:center;padding:3rem"><h2>You are offline</h2><p>Reconnect to the internet to continue the auction.</p><button onclick="location.reload()" style="padding:.7rem 1.2rem;border-radius:.6rem;border:0;background:#fbbf24;font-weight:700">Try again</button>',
    { headers: { 'Content-Type': 'text/html' } })));
});
