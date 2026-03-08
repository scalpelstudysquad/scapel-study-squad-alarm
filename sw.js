// ═══════════════════════════════════════════════════════════
//  SSS ALARM — Service Worker v2.1
//  Scalpel Study Squad
//  Handles: caching, offline support, background sync,
//           push notifications, alarm persistence
// ═══════════════════════════════════════════════════════════

const CACHE_NAME    = 'sss-alarm-v2.1';
const STATIC_CACHE  = 'sss-static-v2.1';
const DYNAMIC_CACHE = 'sss-dynamic-v2.1';

// ── FILES TO CACHE ON INSTALL ──────────────────────────────
// List every file that must work offline
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './questions.json',
  './icons/icon-72.png',
  './icons/icon-96.png',
  './icons/icon-128.png',
  './icons/icon-144.png',
  './icons/icon-152.png',
  './icons/icon-192.png',
  './icons/icon-384.png',
  './icons/icon-512.png'
];

// ── EXTERNAL URLS TO CACHE (CDN assets) ───────────────────
const CDN_ASSETS = [
  'https://cdn.jsdelivr.net/npm/chart.js',
  'https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&family=Roboto:wght@400;500;700&display=swap'
];

// ── INSTALL ────────────────────────────────────────────────
self.addEventListener('install', event => {
  console.log('[SSS SW] Installing v2.1...');
  event.waitUntil(
    Promise.all([
      // Cache static local assets
      caches.open(STATIC_CACHE).then(cache => {
        return Promise.allSettled(
          STATIC_ASSETS.map(url =>
            cache.add(url).catch(err => {
              console.warn('[SSS SW] Failed to cache:', url, err.message);
            })
          )
        );
      }),
      // Cache CDN assets separately (may fail on first load — that's OK)
      caches.open(DYNAMIC_CACHE).then(cache => {
        return Promise.allSettled(
          CDN_ASSETS.map(url =>
            fetch(url, { mode: 'cors' })
              .then(res => { if (res.ok) cache.put(url, res); })
              .catch(() => {})
          )
        );
      })
    ]).then(() => {
      console.log('[SSS SW] Install complete.');
      // Activate immediately without waiting for old SW to be released
      return self.skipWaiting();
    })
  );
});

// ── ACTIVATE ───────────────────────────────────────────────
self.addEventListener('activate', event => {
  console.log('[SSS SW] Activating...');
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys
          .filter(key => key !== STATIC_CACHE && key !== DYNAMIC_CACHE)
          .map(key => {
            console.log('[SSS SW] Deleting old cache:', key);
            return caches.delete(key);
          })
      );
    }).then(() => {
      console.log('[SSS SW] Activated. Claiming clients...');
      return self.clients.claim();
    })
  );
});

// ── FETCH STRATEGY ─────────────────────────────────────────
// Strategy:
//   - HTML pages          → Network first, fallback to cache
//   - Static assets       → Cache first, fallback to network
//   - API / questions.json→ Network first, fallback to cache
//   - CDN fonts/scripts   → Cache first, fallback to network
//   - External images     → Network only (no cache for GitHub raw)
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  // Skip chrome-extension and non-http requests
  if (!event.request.url.startsWith('http')) return;

  // ── GitHub raw content (icons) — network with cache fallback
  if (url.hostname === 'raw.githubusercontent.com') {
    event.respondWith(
      fetch(event.request)
        .then(res => {
          if (res && res.ok) {
            const resClone = res.clone();
            caches.open(DYNAMIC_CACHE).then(cache => cache.put(event.request, resClone));
          }
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // ── Google Fonts & CDN — cache first
  if (url.hostname.includes('fonts.googleapis.com') ||
      url.hostname.includes('fonts.gstatic.com') ||
      url.hostname.includes('cdn.jsdelivr.net')) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(res => {
          if (res && res.ok) {
            const resClone = res.clone();
            caches.open(DYNAMIC_CACHE).then(cache => cache.put(event.request, resClone));
          }
          return res;
        }).catch(() => cached);
      })
    );
    return;
  }

  // ── questions.json — network first (fresh questions), fallback cache
  if (url.pathname.endsWith('questions.json')) {
    event.respondWith(
      fetch(event.request)
        .then(res => {
          if (res && res.ok) {
            const resClone = res.clone();
            caches.open(STATIC_CACHE).then(cache => cache.put(event.request, resClone));
          }
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // ── HTML (index.html / root) — network first for freshness
  if (event.request.mode === 'navigate' ||
      url.pathname.endsWith('.html') ||
      url.pathname === '/') {
    event.respondWith(
      fetch(event.request)
        .then(res => {
          if (res && res.ok) {
            const resClone = res.clone();
            caches.open(STATIC_CACHE).then(cache => cache.put(event.request, resClone));
          }
          return res;
        })
        .catch(() =>
          caches.match(event.request).then(cached =>
            cached || caches.match('./index.html')
          )
        )
    );
    return;
  }

  // ── Everything else — cache first, fallback network
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(res => {
        if (res && res.ok && res.type !== 'opaque') {
          const resClone = res.clone();
          caches.open(DYNAMIC_CACHE).then(cache => cache.put(event.request, resClone));
        }
        return res;
      }).catch(() => {
        // Return a basic offline fallback for images
        if (event.request.destination === 'image') {
          return new Response(
            '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#132B45"/><text x="50" y="55" text-anchor="middle" fill="#42A5F5" font-size="14" font-family="sans-serif">SSS</text></svg>',
            { headers: { 'Content-Type': 'image/svg+xml' } }
          );
        }
        return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
      });
    })
  );
});

// ── PUSH NOTIFICATIONS ─────────────────────────────────────
// Fired when a push message arrives from the server (optional future feature)
self.addEventListener('push', event => {
  let data = { title: '⏰ SSS ALARM', body: 'Time to study!', icon: './icons/icon-192.png' };
  if (event.data) {
    try { data = { ...data, ...event.data.json() }; } catch(e) {}
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body:    data.body,
      icon:    data.icon || './icons/icon-192.png',
      badge:   './icons/icon-96.png',
      vibrate: [200, 100, 200, 100, 400],
      tag:     'sss-alarm',
      renotify: true,
      requireInteraction: true,
      actions: [
        { action: 'start-quiz', title: '📝 Answer MCQs' },
        { action: 'snooze',     title: '💤 Snooze 5 min' }
      ],
      data: data
    })
  );
});

// ── NOTIFICATION CLICK ─────────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();

  const action = event.action;
  const targetUrl = action === 'snooze'
    ? './index.html?action=snooze'
    : action === 'start-quiz'
    ? './index.html?action=quiz'
    : './index.html';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      // If app window is already open, focus it
      for (const client of clientList) {
        if (client.url.includes('index.html') && 'focus' in client) {
          client.postMessage({ type: 'NOTIFICATION_ACTION', action });
          return client.focus();
        }
      }
      // Otherwise open a new window
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});

// ── NOTIFICATION DISMISS ───────────────────────────────────
self.addEventListener('notificationclose', event => {
  // User dismissed the notification — log it (optional analytics)
  console.log('[SSS SW] Notification dismissed:', event.notification.tag);
});

// ── BACKGROUND SYNC ────────────────────────────────────────
// Fires when connectivity is restored (for future server sync)
self.addEventListener('sync', event => {
  if (event.tag === 'sync-study-logs') {
    event.waitUntil(syncStudyLogs());
  }
});

async function syncStudyLogs() {
  // Placeholder — implement server sync here if needed
  console.log('[SSS SW] Background sync: study logs');
}

// ── PERIODIC BACKGROUND SYNC ───────────────────────────────
// Wakes the SW periodically (Chrome Android, when granted)
self.addEventListener('periodicsync', event => {
  if (event.tag === 'alarm-check') {
    event.waitUntil(checkScheduledAlarms());
  }
});

async function checkScheduledAlarms() {
  // Post a message to all open clients to check alarms
  const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  allClients.forEach(client => {
    client.postMessage({ type: 'PERIODIC_ALARM_CHECK' });
  });
}

// ── MESSAGE HANDLER ────────────────────────────────────────
// Receives messages from the main page
self.addEventListener('message', event => {
  const { type, payload } = event.data || {};

  if (type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  if (type === 'CACHE_QUESTION_BANK') {
    // Pre-cache a custom questions.json blob sent from the page
    caches.open(STATIC_CACHE).then(cache => {
      const response = new Response(JSON.stringify(payload), {
        headers: { 'Content-Type': 'application/json' }
      });
      cache.put('./questions.json', response);
      console.log('[SSS SW] Questions cached from message.');
    });
    return;
  }

  if (type === 'SHOW_ALARM_NOTIFICATION') {
    // Page asks SW to show an alarm notification (useful when tab is hidden)
    const alarm = payload || {};
    self.registration.showNotification('⏰ ' + (alarm.label || 'Study Alarm'), {
      body:    `Answer ${alarm.qCount || 15} MCQs → Unlock alarm tone 🔔`,
      icon:    './icons/icon-192.png',
      badge:   './icons/icon-96.png',
      vibrate: [300, 100, 300, 100, 600],
      tag:     'sss-alarm-' + (alarm.id || 'main'),
      renotify: true,
      requireInteraction: true,
      actions: [
        { action: 'start-quiz', title: '📝 Answer MCQs' },
        { action: 'snooze',     title: '💤 Snooze' }
      ],
      data: alarm
    });
    return;
  }

  // Unknown message — ignore
  console.log('[SSS SW] Unknown message type:', type);
});

// ── VERSION LOG ────────────────────────────────────────────
console.log('[SSS SW] Scalpel Study Squad Alarm — Service Worker v2.1 loaded.');

