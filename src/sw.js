// Radical Movies service worker — "always fresh", no persistent cache.
//
// Why this exists: iOS, when the site is added to the Home Screen (display:
// standalone in manifest.json), runs in a separate WebView container that
// aggressively caches assets on disk — even when the server sends
// `Cache-Control: no-store`. That makes users get stale JS/HTML and "movies
// that were working stop working" until they wipe the app.
//
// This worker keeps NO cache of its own. It forces every same-origin GET to
// bypass the HTTP disk cache (network, no-store), and on activation it deletes
// any pre-existing Cache Storage — so simply loading the site once installs the
// worker and permanently heals a device that was stuck on stale assets.
//
// Cross-origin requests (e.g. video from cdn.theradicalparty.com) are left
// untouched so native range-request streaming keeps working.

self.addEventListener('install', () => {
  // Activate immediately rather than waiting for existing tabs to close.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Purge any legacy Cache Storage left by older builds / other workers.
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    // Take control of open clients right away.
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  // NEVER intercept top-level page navigations. If we wrap the navigation in
  // respondWith() and the fetch path misbehaves (as it does on some older TV /
  // smart-device WebViews), the whole page becomes "webpage not available".
  // Pages must always load natively — the server already sends no-store for HTML.
  if (req.mode === 'navigate') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;         // let CDN video etc. go native
  // Sub-resources (JS/CSS) only: bypass the HTTP disk cache to stay fresh, but
  // NEVER reject respondWith — always fall back so a hiccup can't break assets.
  event.respondWith((async () => {
    try { return await fetch(req, { cache: 'no-store' }); }
    catch {
      try { return await fetch(req); }
      catch { return new Response('', { status: 504, statusText: 'offline' }); }
    }
  })());
});
