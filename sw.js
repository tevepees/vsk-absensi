/**
 * ================================================================
 *  VSK Absensi — Service Worker
 *  Strategi: Cache-first untuk app shell (offline support)
 *             Network-first untuk panggilan API
 * ================================================================
 */

const CACHE_VERSION = 'vsk-absensi-v1';

// File yang di-cache untuk offline / fast load
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  // Google Fonts sudah di-cache oleh browser sendiri; tidak perlu di sini
];

// ---- Install: pre-cache app shell ----
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => {
      return cache.addAll(APP_SHELL);
    })
  );
  // Langsung aktif tanpa menunggu tab lama ditutup
  self.skipWaiting();
});

// ---- Activate: hapus cache lama ----
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_VERSION)
          .map(key => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// ---- Fetch: strategi berdasarkan tipe request ----
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Lewati request non-GET dan cross-origin (Apps Script, Google Fonts, dll.)
  if (request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  // Strategi: Cache-first → Network fallback → Offline fallback
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) {
        // Serve dari cache, update di background (stale-while-revalidate)
        const networkFetch = fetch(request)
          .then(networkRes => {
            if (networkRes && networkRes.ok) {
              caches.open(CACHE_VERSION).then(c => c.put(request, networkRes.clone()));
            }
            return networkRes;
          })
          .catch(() => null);
        // Kembalikan cached segera
        return cached;
      }

      // Tidak ada di cache → fetch network
      return fetch(request)
        .then(networkRes => {
          // Cache HTML dan aset statik
          if (networkRes && networkRes.ok && (
            url.pathname === '/' ||
            url.pathname.endsWith('.html') ||
            url.pathname.endsWith('.js') ||
            url.pathname.endsWith('.css') ||
            url.pathname.endsWith('.png') ||
            url.pathname.endsWith('.svg') ||
            url.pathname.endsWith('.ico') ||
            url.pathname.endsWith('.json')
          )) {
            caches.open(CACHE_VERSION).then(c => c.put(request, networkRes.clone()));
          }
          return networkRes;
        })
        .catch(() => {
          // Offline: kembalikan halaman utama untuk navigasi
          if (request.destination === 'document') {
            return caches.match('/index.html');
          }
          // Untuk request lain yang tidak di-cache: biarkan gagal dengan grace
          return new Response(
            JSON.stringify({ offline: true, message: 'Tidak ada koneksi internet.' }),
            { status: 503, headers: { 'Content-Type': 'application/json' } }
          );
        });
    })
  );
});

// ---- Background Sync (opsional, untuk kirim ulang absensi yang gagal) ----
// Catatan: hanya didukung di Chrome Android; iOS Safari tidak support.
// Implementasi lanjutan jika dibutuhkan.
