/* ══════════════════════════════════════════════════════════════════════════
   GOLEX SERVICE WORKER — Cache-First Shell + Network-Only Realtime Data
   ──────────────────────────────────────────────────────────────────────
   HOW IT WORKS:
     • First visit  : Downloads everything normally, caches the HTML shell
                      and all static CDN assets (Firebase SDK, Lucide, Fonts)
     • Second visit : HTML + static assets served instantly from cache (0 network)
                      Only Firebase RTDB real-time data goes to the network

   HOW TO UPDATE:
     When you deploy a new version of the HTML, bump CACHE_VERSION by 1.
     The old cache is automatically cleaned up on the next visit.
   ══════════════════════════════════════════════════════════════════════════ */

const CACHE_VERSION = 1; // ← BUMP THIS when you deploy a new HTML version
const CACHE_NAME = `golex-shell-v${CACHE_VERSION}`;

/* ── Static assets to pre-cache on install ──────────────────────────────── */
const PRECACHE_URLS = [
  '/golex',
  'https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js',
  'https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js',
  'https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js',
  'https://www.gstatic.com/firebasejs/10.8.1/firebase-app-check.js',
  'https://cdn.jsdelivr.net/npm/lucide@0.383.0/dist/umd/lucide.min.js',
];

/* ── Network-only patterns — never cache these ──────────────────────────── */
const NETWORK_ONLY = [
  /firebaseio\.com/,             // Firebase Realtime Database (live data)
  /identitytoolkit\.googleapis\.com/, // Firebase Auth API
  /securetoken\.googleapis\.com/,     // Firebase Auth token refresh
  /firebaseapp\.com\/__\/auth/,       // Firebase Auth popup handler
  /checkout\.razorpay\.com/,          // Razorpay payment (must be fresh)
  /recaptcha\.net/,                   // reCAPTCHA
  /google\.com\/recaptcha/,           // reCAPTCHA (Google domain)
  /googleapis\.com\/v1\//,            // Firebase REST API calls
];

/* ═══════════════ INSTALL — pre-cache the static shell ═════════════════ */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Cache all assets in parallel; don't fail install if one CDN hiccups
      const results = await Promise.allSettled(
        PRECACHE_URLS.map(url =>
          cache.add(new Request(url, { mode: 'cors', credentials: 'omit' }))
            .catch(err => console.warn('[Golex SW] Pre-cache miss:', url, err.message))
        )
      );
      const ok = results.filter(r => r.status === 'fulfilled').length;
      console.log(`[Golex SW] Installed — cached ${ok}/${PRECACHE_URLS.length} shell assets`);
    })
    .then(() => self.skipWaiting()) // Activate immediately on first install
  );
});

/* ═══════════════ ACTIVATE — clean old caches ══════════════════════════ */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter(name => name.startsWith('golex-shell-') && name !== CACHE_NAME)
          .map(name => {
            console.log('[Golex SW] Removing old cache:', name);
            return caches.delete(name);
          })
      )
    ).then(() => {
      console.log('[Golex SW] Activated — now controlling all clients');
      return self.clients.claim();
    })
  );
});

/* ═══════════════ FETCH — smart cache routing ══════════════════════════ */
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET requests
  if (request.method !== 'GET') return;

  // Skip non-http(s) requests (chrome-extension://, etc.)
  if (!request.url.startsWith('http')) return;

  // ── Network-only zone (real-time data, payments, auth) ─────────────────
  if (NETWORK_ONLY.some(pattern => pattern.test(request.url))) {
    return; // Let browser handle naturally
  }

  const url = new URL(request.url);

  // ── Navigation request (the HTML document itself) ───────────────────────
  // Strategy: Cache-first with background update (stale-while-revalidate)
  // Result: Second visit loads the 1.5MB file from cache in ~0ms
  if (request.mode === 'navigate' || (request.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // ── Firebase JS SDK + Lucide + Razorpay JS ──────────────────────────────
  // These are versioned CDN assets — cache forever (cache-first)
  if (
    url.hostname === 'www.gstatic.com' ||
    url.hostname === 'cdn.jsdelivr.net' ||
    (url.hostname === 'checkout.razorpay.com' && url.pathname.includes('.js'))
  ) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // ── Google Fonts CSS ────────────────────────────────────────────────────
  // Strategy: Stale-while-revalidate (CSS varies slightly, but font files are stable)
  if (url.hostname === 'fonts.googleapis.com') {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // ── Google Fonts files (.woff2, etc.) ───────────────────────────────────
  // Long-lived immutable files — cache forever
  if (url.hostname === 'fonts.gstatic.com') {
    event.respondWith(cacheFirst(request));
    return;
  }

  // ── Everything else — try cache, fall back to network ───────────────────
  event.respondWith(networkWithCacheFallback(request));
});

/* ═══════════════ CACHE STRATEGIES ═════════════════════════════════════ */

/**
 * Cache-first: Return cached response immediately.
 * Falls back to network and caches the result.
 * Best for: versioned CDN assets (Firebase SDK, Lucide, Font files)
 */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response && response.status === 200) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    console.warn('[Golex SW] Cache-first network fail:', request.url);
    return new Response('Offline', { status: 503 });
  }
}

/**
 * Stale-while-revalidate: Serve from cache immediately,
 * update the cache in the background.
 * Best for: HTML shell, Google Fonts CSS
 */
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  // Kick off network fetch in background regardless
  const networkFetch = fetch(request)
    .then(async (response) => {
      if (response && response.status === 200) {
        await cache.put(request, response.clone());
        // Notify clients that a fresh version is cached (for update prompt)
        const clients = await self.clients.matchAll({ type: 'window' });
        clients.forEach(client =>
          client.postMessage({ type: 'GOLEX_CACHE_UPDATED', url: request.url })
        );
      }
      return response;
    })
    .catch(() => null);

  // Return cached immediately if available, else await network
  return cached || networkFetch;
}

/**
 * Network-first with cache fallback: Try network, serve cache if offline.
 * Best for: everything else
 */
async function networkWithCacheFallback(request) {
  try {
    const response = await fetch(request);
    if (response && response.status === 200) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await caches.match(request);
    return cached || new Response('Offline', { status: 503 });
  }
}

/* ═══════════════ MESSAGE HANDLER ═══════════════════════════════════════ */
self.addEventListener('message', (event) => {
  if (!event.data) return;

  switch (event.data.type) {
    case 'SKIP_WAITING':
      // Called by the page when user clicks "Update now"
      self.skipWaiting();
      break;

    case 'CLEAR_CACHE':
      // Emergency cache wipe (accessible from dev console)
      caches.delete(CACHE_NAME).then(() =>
        console.log('[Golex SW] Cache cleared:', CACHE_NAME)
      );
      break;

    case 'GET_CACHE_VERSION':
      event.source?.postMessage({ type: 'CACHE_VERSION', version: CACHE_VERSION });
      break;
  }
});
