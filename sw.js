// Service worker: keeps a copy of the app's own files on your phone, so the
// home-screen app still opens with no signal and can tell you it can't reach
// the database, instead of showing Safari's "you're offline" page.
//
// It always tries the network first, so you get the latest version whenever
// you're online. Database requests are never cached: they go straight to Supabase.

const CACHE = 'glossary-v1';
const APP_FILES = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'db.js',
  'config.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/apple-touch-icon.png',
];
const LIBRARY_HOST = 'cdn.jsdelivr.net'; // where the Supabase library is loaded from
const NETWORK_WAIT_MS = 4000;            // on a weak signal, use the saved copy after this long

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(APP_FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const isAppFile = url.origin === self.location.origin;
  if (isAppFile || url.hostname === LIBRARY_HOST) {
    event.respondWith(networkFirst(request, isAppFile));
  }
});

async function networkFirst(request, isAppFile) {
  const cache = await caches.open(CACHE);
  // 'no-cache' asks the server whether an app file changed, so updates show up
  // right away. The library's address includes its version, so it never changes.
  const network = fetch(request, { cache: isAppFile ? 'no-cache' : 'default' }).then((response) => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  });
  network.catch(() => {}); // a late failure after answering from the saved copy is fine

  try {
    return await Promise.race([network, rejectAfter(NETWORK_WAIT_MS)]);
  } catch {
    const saved =
      (await cache.match(request, { ignoreSearch: true })) ??
      (request.mode === 'navigate' ? await cache.match('./') : undefined);
    return saved ?? network; // nothing saved yet: keep waiting for the network
  }
}

function rejectAfter(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('Network is slow')), ms));
}
