/**
 * ============================================================================
 * SERVICE WORKER AZI CELL (sw.js) - AUTO UPDATE ENGINE
 * ============================================================================
 * CARA PAKAI SAAT REVISI / UPDATE:
 * Cukup ubah nilai CACHE_VERSION di bawah ini (misal dari v1.0.2 ke v1.0.3)
 * lalu push ke GitHub. Saat pengguna membuka aplikasi, layar akan otomatis
 * menampilkan animasi LOADING MUTER dan menarik versi terbaru tanpa nyangkut!
 * ============================================================================
 */
const CACHE_VERSION = 'azicell-pwa-v1.0.4';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './config.js',
  './app.js',
  './manifest.json',
  './logo1.png',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  // Paksa Service Worker baru langsung aktif tanpa menunggu tab ditutup
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE).catch(() => {});
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Hapus seluruh cache versi lama
      const keys = await caches.keys();
      await Promise.all(
        keys.map((key) => {
          if (key !== CACHE_VERSION) {
            return caches.delete(key);
          }
        })
      );
      await self.clients.claim();
      // Kirim sinyal ke semua tab terbuka bahwa update selesai & siap reload
      const allClients = await self.clients.matchAll({ includeUncontrolled: true });
      for (const client of allClients) {
        client.postMessage({
          type: 'SW_UPDATED_READY',
          version: CACHE_VERSION
        });
      }
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Strategi Network-First untuk file inti agar perubahan di GitHub langsung terdeteksi
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request, { cache: 'no-store' })
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_VERSION).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return networkResponse;
      })
      .catch(() => {
        return caches.match(event.request).then((cached) => cached || caches.match('./index.html'));
      })
  );
});
