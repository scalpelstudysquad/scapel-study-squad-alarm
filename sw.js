// ═══════════════════════════════════════════════════════════
//  SSS ALARM — Service Worker v3.0
//  • Stores alarms in Cache API (survives SW restart)
//  • Checks alarms every 30s while SW is alive
//  • Shows high-priority screen-wake notification (requireInteraction)
//  • Fires alarm in open app tabs via postMessage
//  • Periodic Background Sync for extra Android reliability
//  • Re-notifies every 20s if user swipes notification away
// ═══════════════════════════════════════════════════════════

const SW_VERSION    = '3.0';
const STATIC_CACHE  = `sss-static-v${SW_VERSION}`;
const DYNAMIC_CACHE = `sss-dynamic-v${SW_VERSION}`;
const DATA_CACHE    = `sss-data-v${SW_VERSION}`;

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

// ── In-memory state ───────────────────────────────────────
const firedThisSession = new Set(); // dedup fired alarms
let   cachedAlarms     = [];
let   activeAlarmIds   = new Set(); // alarms currently ringing

// ═══════════════════════════════════════════════════════════
//  ALARM STORAGE  (Cache API → persists across SW restarts)
// ═══════════════════════════════════════════════════════════

async function loadAlarmsFromCache() {
  try {
    const cache = await caches.open(DATA_CACHE);
    const res   = await cache.match('alarm-list');
    if (!res) return [];
    const data  = await res.json();
    return Array.isArray(data) ? data : [];
  } catch(e) { return []; }
}

async function saveAlarmsToCache(alarms) {
  try {
    const cache = await caches.open(DATA_CACHE);
    await cache.put('alarm-list', new Response(JSON.stringify(alarms), {
      headers: { 'Content-Type': 'application/json' }
    }));
    cachedAlarms = alarms;
  } catch(e) {}
}

// Load alarms immediately when SW starts
loadAlarmsFromCache().then(a => {
  cachedAlarms = a;
  console.log(`[SSS SW v${SW_VERSION}] Loaded ${a.length} alarm(s).`);
});

// ═══════════════════════════════════════════════════════════
//  CORE ALARM CHECK  — called every 30 seconds
// ═══════════════════════════════════════════════════════════

async function checkAlarms() {
  const alarms = cachedAlarms.length ? cachedAlarms : await loadAlarmsFromCache();
  if (!alarms.length) return;

  const now = new Date();
  const ct  = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  const cd  = now.getDay();

  for (const alarm of alarms) {
    if (!alarm.enabled) continue;
    if (alarm.time !== ct) continue;
    if (alarm.days && alarm.days.length > 0 && !alarm.days.includes(cd)) continue;

    const dedupeKey = `${alarm.id}_${now.toDateString()}_${ct}`;
    if (firedThisSession.has(dedupeKey)) continue;
    firedThisSession.add(dedupeKey);

    console.log(`[SSS SW] ⏰ Firing alarm: "${alarm.label}" at ${ct}`);
    activeAlarmIds.add(alarm.id);

    // Show persistent notification (works with screen off)
    await showAlarmNotification(alarm);

    // Tell open app tabs to start audio immediately
    const openClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    openClients.forEach(client =>
      client.postMessage({ type: 'FIRE_ALARM_AUDIO', alarm })
    );
  }
}

// Run every 30 seconds
setInterval(checkAlarms, 30000);
checkAlarms();

// ═══════════════════════════════════════════════════════════
//  ALARM NOTIFICATION  — high priority, stays on screen
// ═══════════════════════════════════════════════════════════

async function showAlarmNotification(alarm) {
  const qCount = alarm.qCount || 15;

  // Aggressive vibration: 3 long pulses then 3 short, repeat feel
  const vibratePattern = [
    900,200, 900,200, 900,400,
    300,200, 300,200, 300,500,
    900,200, 900,200, 900
  ];

  try {
    await self.registration.showNotification(`⏰ ${alarm.label}`, {
      body:             `Alarm ringing! Tap → Answer ${qCount} MCQs → Alarm stops 🔔`,
      icon:             './icons/icon-192.png',
      badge:            './icons/icon-96.png',
      vibrate:          vibratePattern,
      tag:              `sss-alarm-${alarm.id}`,   // unique per alarm
      renotify:         true,
      requireInteraction: true,   // ← CRITICAL: stays on lock screen
      silent:           false,    // use system notification sound
      timestamp:        Date.now(),
      actions: [
        { action: 'open-quiz', title: '📝 Answer MCQs' },
        { action: 'open-app',  title: '⏰ Open App'    }
      ],
      data: { alarm, firedAt: Date.now() }
    });
  } catch(e) {
    // Fallback without actions (iOS Safari doesn't support actions)
    try {
      await self.registration.showNotification(`⏰ ${alarm.label}`, {
        body:             `Alarm ringing! Tap to answer ${qCount} MCQs 🔔`,
        icon:             './icons/icon-192.png',
        vibrate:          vibratePattern,
        tag:              `sss-alarm-${alarm.id}`,
        renotify:         true,
        requireInteraction: true,
        silent:           false,
        data:             { alarm }
      });
    } catch(e2) {
      console.error('[SSS SW] Notification error:', e2);
    }
  }

  // Re-vibrate every 20s until user opens app (max 3 min)
  startReminderLoop(alarm);
}

// Re-notify if user ignores / swipes away notification
function startReminderLoop(alarm) {
  let attempts = 0;
  const id = setInterval(async () => {
    attempts++;
    if (attempts > 9) { clearInterval(id); return; } // stop after 3 min

    // If app opened and handled alarm, stop reminding
    if (!activeAlarmIds.has(alarm.id)) { clearInterval(id); return; }

    const openClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (openClients.length > 0) {
      // App is open – it's handling things, but re-post message just in case
      openClients.forEach(c => c.postMessage({ type: 'FIRE_ALARM_AUDIO', alarm }));
    } else {
      // App closed – keep vibrating notification
      try {
        await self.registration.showNotification(`⏰ ALARM STILL RINGING — ${alarm.label}`, {
          body:             `You haven't answered the MCQs yet! Open app to stop alarm.`,
          icon:             './icons/icon-192.png',
          badge:            './icons/icon-96.png',
          vibrate:          [500,200,500,200,1000],
          tag:              `sss-alarm-${alarm.id}`,
          renotify:         true,
          requireInteraction: true,
          silent:           true,  // vibrate only, no repeated sound
          data:             { alarm }
        });
      } catch(e) {}
    }
  }, 20000);
}

// ═══════════════════════════════════════════════════════════
//  NOTIFICATION CLICK  → open app and start alarm audio
// ═══════════════════════════════════════════════════════════

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const alarm  = event.notification.data?.alarm;
  const action = event.action || 'open-app';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clientList => {
        // Focus existing window
        for (const client of clientList) {
          if (client.url.includes('index.html') || /\/$/.test(client.url)) {
            client.postMessage({ type: 'FIRE_ALARM_AUDIO', alarm, action });
            return client.focus();
          }
        }
        // No window open — open app, then send message after it loads
        return clients.openWindow('./index.html').then(newClient => {
          if (newClient) {
            // Give the page 2s to initialize
            setTimeout(() => {
              newClient.postMessage({ type: 'FIRE_ALARM_AUDIO', alarm, action });
            }, 2000);
          }
        });
      })
  );
});

// ═══════════════════════════════════════════════════════════
//  MESSAGE HANDLER  — from main app page
// ═══════════════════════════════════════════════════════════

self.addEventListener('message', event => {
  const msg = event.data || {};

  switch (msg.type) {

    // Main page sends all alarms on startup and on every change
    case 'UPDATE_ALARMS':
      saveAlarmsToCache(msg.alarms || []);
      console.log(`[SSS SW] Alarms updated: ${(msg.alarms||[]).length}`);
      break;

    // User answered all MCQs — alarm is done
    case 'ALARM_DISMISSED':
      activeAlarmIds.delete(msg.alarmId);
      // Close all notifications for this alarm
      self.registration.getNotifications({ tag: `sss-alarm-${msg.alarmId}` })
        .then(notifs => notifs.forEach(n => n.close()))
        .catch(() => {});
      // Also close catch-all tag
      self.registration.getNotifications({ tag: 'sss-alarm-active' })
        .then(notifs => notifs.forEach(n => n.close()))
        .catch(() => {});
      console.log(`[SSS SW] Alarm dismissed: ${msg.alarmId}`);
      break;

    // Register periodic background sync
    case 'REGISTER_PERIODIC_SYNC':
      registerPeriodicSync();
      break;

    case 'SKIP_WAITING':
      self.skipWaiting();
      break;

    default:
      break;
  }
});

// ═══════════════════════════════════════════════════════════
//  PERIODIC BACKGROUND SYNC  — Chrome Android only
//  Wakes SW ~every minute even when phone is idle
// ═══════════════════════════════════════════════════════════

self.addEventListener('periodicsync', event => {
  if (event.tag === 'sss-alarm-check') {
    console.log('[SSS SW] Periodic background sync triggered.');
    event.waitUntil(checkAlarms());
  }
});

async function registerPeriodicSync() {
  try {
    if (!self.registration.periodicSync) return;
    const status = await navigator.permissions?.query({ name: 'periodic-background-sync' });
    if (status?.state === 'granted') {
      await self.registration.periodicSync.register('sss-alarm-check', {
        minInterval: 60 * 1000 // 1 minute
      });
      console.log('[SSS SW] Periodic background sync registered ✓');
    }
  } catch(e) {
    console.warn('[SSS SW] Periodic sync unavailable:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════
//  INSTALL
// ═══════════════════════════════════════════════════════════

self.addEventListener('install', event => {
  console.log(`[SSS SW v${SW_VERSION}] Installing...`);
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => Promise.allSettled(
        STATIC_ASSETS.map(url => cache.add(url).catch(() => {}))
      ))
      .then(() => self.skipWaiting())
  );
});

// ═══════════════════════════════════════════════════════════
//  ACTIVATE
// ═══════════════════════════════════════════════════════════

self.addEventListener('activate', event => {
  console.log(`[SSS SW v${SW_VERSION}] Activating...`);
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => k !== STATIC_CACHE && k !== DYNAMIC_CACHE && k !== DATA_CACHE)
          .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ═══════════════════════════════════════════════════════════
//  FETCH  — offline-first caching
// ═══════════════════════════════════════════════════════════

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith('http')) return;

  const url = new URL(event.request.url);

  // GitHub raw (icons) — network + cache
  if (url.hostname === 'raw.githubusercontent.com') {
    event.respondWith(
      fetch(event.request).then(res => {
        if (res?.ok) caches.open(DYNAMIC_CACHE).then(c => c.put(event.request, res.clone()));
        return res;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  // CDN / Fonts — cache first
  if (url.hostname.includes('fonts.') || url.hostname.includes('cdn.jsdelivr')) {
    event.respondWith(
      caches.match(event.request).then(cached => cached ||
        fetch(event.request).then(res => {
          if (res?.ok) caches.open(DYNAMIC_CACHE).then(c => c.put(event.request, res.clone()));
          return res;
        })
      )
    );
    return;
  }

  // questions.json — network first (freshest data)
  if (url.pathname.endsWith('questions.json')) {
    event.respondWith(
      fetch(event.request).then(res => {
        if (res?.ok) caches.open(STATIC_CACHE).then(c => c.put(event.request, res.clone()));
        return res;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  // HTML navigation — network first
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).then(res => {
        if (res?.ok) caches.open(STATIC_CACHE).then(c => c.put(event.request, res.clone()));
        return res;
      }).catch(() =>
        caches.match(event.request).then(c => c || caches.match('./index.html'))
      )
    );
    return;
  }

  // Everything else — cache first
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(res => {
        if (res?.ok && res.type !== 'opaque') {
          caches.open(DYNAMIC_CACHE).then(c => c.put(event.request, res.clone()));
        }
        return res;
      }).catch(() =>
        event.request.destination === 'image'
          ? new Response(
              '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">' +
              '<rect width="96" height="96" rx="20" fill="#132B45"/>' +
              '<text x="48" y="56" text-anchor="middle" fill="#42A5F5" ' +
              'font-size="18" font-weight="bold" font-family="sans-serif">SSS</text></svg>',
              { headers: { 'Content-Type': 'image/svg+xml' } }
            )
          : new Response('Offline', { status: 503 })
      );
    })
  );
});

console.log(`[SSS SW] Loaded v${SW_VERSION}`);

