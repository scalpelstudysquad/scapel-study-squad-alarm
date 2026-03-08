// ═══════════════════════════════════════════════════════════
//  SSS ALARM — Service Worker v3.1
//
//  FIX v3.1:
//  • REMOVED unreliable setInterval (SW is killed after ~30s idle)
//  • Alarms checked on every KEEPALIVE ping from page (every 25s)
//  • FIXED registerPeriodicSync (navigator not available in SW)
//  • event.waitUntil() on every message keeps SW alive long enough
// ═══════════════════════════════════════════════════════════

const SW_VERSION    = '3.1';
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
const firedThisSession = new Set();
let   cachedAlarms     = [];
let   activeAlarmIds   = new Set();

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

// Load alarms immediately when SW first starts
loadAlarmsFromCache().then(a => {
  cachedAlarms = a;
  console.log(`[SSS SW v${SW_VERSION}] Loaded ${a.length} alarm(s) from cache.`);
});

// ═══════════════════════════════════════════════════════════
//  CORE ALARM CHECK
//  Called on: KEEPALIVE ping, periodicsync, notificationclick
// ═══════════════════════════════════════════════════════════

async function checkAlarms() {
  if (!cachedAlarms.length) {
    cachedAlarms = await loadAlarmsFromCache();
  }
  if (!cachedAlarms.length) return;

  const now = new Date();
  const ct  = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  const cd  = now.getDay();

  for (const alarm of cachedAlarms) {
    if (!alarm.enabled) continue;
    if (alarm.time !== ct) continue;
    if (alarm.days && alarm.days.length > 0 && !alarm.days.includes(cd)) continue;

    const dedupeKey = `${alarm.id}_${now.toDateString()}_${ct}`;
    if (firedThisSession.has(dedupeKey)) continue;
    firedThisSession.add(dedupeKey);

    console.log(`[SSS SW] ⏰ FIRING: "${alarm.label}" at ${ct}`);
    activeAlarmIds.add(alarm.id);

    await showAlarmNotification(alarm);

    const openClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    openClients.forEach(client =>
      client.postMessage({ type: 'FIRE_ALARM_AUDIO', alarm })
    );
  }
}

// ═══════════════════════════════════════════════════════════
//  ALARM NOTIFICATION
// ═══════════════════════════════════════════════════════════

async function showAlarmNotification(alarm) {
  const qCount = alarm.qCount || 15;
  const vibratePattern = [
    900,200, 900,200, 900,400,
    300,200, 300,200, 300,500,
    900,200, 900,200, 900
  ];

  const base = {
    body:               `Alarm ringing! Tap → Answer ${qCount} MCQs → Alarm stops 🔔`,
    icon:               './icons/icon-192.png',
    badge:              './icons/icon-96.png',
    vibrate:            vibratePattern,
    tag:                `sss-alarm-${alarm.id}`,
    renotify:           true,
    requireInteraction: true,
    silent:             false,
    timestamp:          Date.now(),
    data:               { alarm, firedAt: Date.now() }
  };

  try {
    await self.registration.showNotification(`⏰ ${alarm.label}`, {
      ...base,
      actions: [
        { action: 'open-quiz', title: '📝 Answer MCQs' },
        { action: 'open-app',  title: '⏰ Open App'    }
      ]
    });
  } catch(e) {
    try {
      await self.registration.showNotification(`⏰ ${alarm.label}`, base);
    } catch(e2) {
      console.error('[SSS SW] Notification error:', e2);
    }
  }

  startReminderLoop(alarm);
}

function startReminderLoop(alarm) {
  let attempts = 0;
  const id = setInterval(async () => {
    attempts++;
    if (attempts > 9 || !activeAlarmIds.has(alarm.id)) {
      clearInterval(id);
      return;
    }
    const openClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (openClients.length > 0) {
      openClients.forEach(c => c.postMessage({ type: 'FIRE_ALARM_AUDIO', alarm }));
    } else {
      try {
        await self.registration.showNotification(`⏰ ALARM STILL RINGING — ${alarm.label}`, {
          body:               `You haven't answered the MCQs yet! Open app to stop alarm.`,
          icon:               './icons/icon-192.png',
          badge:              './icons/icon-96.png',
          vibrate:            [500,200,500,200,1000,200,1000],
          tag:                `sss-alarm-${alarm.id}`,
          renotify:           true,
          requireInteraction: true,
          silent:             true,
          data:               { alarm }
        });
      } catch(e) {}
    }
  }, 20000);
}

// ═══════════════════════════════════════════════════════════
//  NOTIFICATION CLICK
// ═══════════════════════════════════════════════════════════

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const alarm = event.notification.data?.alarm;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clientList => {
        for (const client of clientList) {
          if (client.url.includes('index.html') || /\/$/.test(client.url)) {
            client.postMessage({ type: 'FIRE_ALARM_AUDIO', alarm });
            return client.focus();
          }
        }
        return clients.openWindow('./index.html').then(newClient => {
          if (newClient) {
            setTimeout(() => {
              newClient.postMessage({ type: 'FIRE_ALARM_AUDIO', alarm });
            }, 2000);
          }
        });
      })
  );
});

// ═══════════════════════════════════════════════════════════
//  MESSAGE HANDLER
// ═══════════════════════════════════════════════════════════

self.addEventListener('message', event => {
  const msg = event.data || {};

  // ── KEEPALIVE: page pings every 25s → SW wakes, checks alarms ──
  if (msg.type === 'KEEPALIVE') {
    event.waitUntil(
      checkAlarms().then(() => {
        event.source?.postMessage({ type: 'KEEPALIVE_ACK', ts: Date.now() });
      })
    );
    return;
  }

  // ── UPDATE_ALARMS ──────────────────────────────────────
  if (msg.type === 'UPDATE_ALARMS') {
    event.waitUntil(
      saveAlarmsToCache(msg.alarms || []).then(() => {
        console.log(`[SSS SW] Alarms updated: ${(msg.alarms||[]).length}`);
        return checkAlarms();
      })
    );
    return;
  }

  // ── ALARM_DISMISSED ───────────────────────────────────
  if (msg.type === 'ALARM_DISMISSED') {
    activeAlarmIds.delete(msg.alarmId);
    event.waitUntil(
      Promise.all([
        self.registration.getNotifications({ tag: `sss-alarm-${msg.alarmId}` })
          .then(ns => ns.forEach(n => n.close())).catch(() => {}),
        self.registration.getNotifications({ tag: 'sss-alarm-active' })
          .then(ns => ns.forEach(n => n.close())).catch(() => {})
      ])
    );
    console.log(`[SSS SW] Alarm dismissed: ${msg.alarmId}`);
    return;
  }

  if (msg.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
});

// ═══════════════════════════════════════════════════════════
//  PERIODIC BACKGROUND SYNC  — Chrome Android
//  (Registration happens from page — navigator not in SW)
// ═══════════════════════════════════════════════════════════

self.addEventListener('periodicsync', event => {
  if (event.tag === 'sss-alarm-check') {
    console.log('[SSS SW] Periodic background sync triggered.');
    event.waitUntil(checkAlarms());
  }
});

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
//  FETCH
// ═══════════════════════════════════════════════════════════

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith('http')) return;

  const url = new URL(event.request.url);

  if (url.hostname === 'raw.githubusercontent.com') {
    event.respondWith(
      fetch(event.request).then(res => {
        if (res?.ok) caches.open(DYNAMIC_CACHE).then(c => c.put(event.request, res.clone()));
        return res;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

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

  if (url.pathname.endsWith('questions.json')) {
    event.respondWith(
      fetch(event.request).then(res => {
        if (res?.ok) caches.open(STATIC_CACHE).then(c => c.put(event.request, res.clone()));
        return res;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

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

