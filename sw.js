// ═══════════════════════════════════════════════════════════
//  SSS ALARM — Service Worker v3.2
//
//  v3.2 CHANGES:
//  • Rich lock-screen notification: large logo image shown prominently
//  • Rhythmic re-notify every 10s with pulsing vibration (like real alarm)
//  • Tap notification → LAUNCHES QUIZ DIRECTLY (no intermediate screen)
//  • Action button "📝 Start Quiz" goes straight to questions
//  • KEEPALIVE architecture from v3.1 retained
// ═══════════════════════════════════════════════════════════

const SW_VERSION    = '3.2';
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
//  ALARM NOTIFICATION  — rich lock-screen card
//
//  • icon  = small badge (top-left on Android)
//  • image = large logo shown prominently in expanded notification
//  • Vibrates in a rhythmic pulse every 10s like a real alarm app
//  • Tap or "📝 Start Quiz" → LAUNCHES QUIZ DIRECTLY in app
// ═══════════════════════════════════════════════════════════

const LOGO_URL = 'https://raw.githubusercontent.com/scalpelstudysquad/scapel-study-squad-alarm/8d2a88640a7eee2cc66beaaa226566f9fdb3e5f5/icon-512.png';

// Rhythmic pulse — 3 short beats then a rest, like a cardiac monitor
const PULSE_VIBRATE = [
  300,120, 300,120, 300,600,   // ♪ ♪ ♪  ...pause
  300,120, 300,120, 300,600,   // ♪ ♪ ♪  ...pause
  600,200, 600,800             // ♫ ♫    ...long rest
];

async function showAlarmNotification(alarm) {
  const qCount = alarm.qCount || 15;
  const label  = alarm.label  || 'SSS Alarm';

  const base = {
    // ── Content ──────────────────────────────────────────
    body:    `Tap to answer ${qCount} MCQs and stop the alarm 🔔`,

    // ── Icons ────────────────────────────────────────────
    // icon  → small circle icon (notification row, status bar)
    // badge → monochrome icon shown in status bar on Android
    // image → large image shown in expanded notification body ← KEY for "logo appears"
    icon:    LOGO_URL,
    badge:   LOGO_URL,
    image:   LOGO_URL,

    // ── Behaviour ────────────────────────────────────────
    vibrate:            PULSE_VIBRATE,
    tag:                `sss-alarm-${alarm.id}`,  // unique per alarm
    renotify:           true,    // allows re-showing same tag (for rhythmic re-ring)
    requireInteraction: true,    // stays on lock screen until tapped
    silent:             false,   // play system notification sound
    timestamp:          Date.now(),
    data:               { alarm, firedAt: Date.now(), directQuiz: true }
  };

  const withActions = {
    ...base,
    actions: [
      { action: 'start-quiz', title: '📝 Start Quiz Now' },
      { action: 'open-app',   title: '⏰ Open App'        }
    ]
  };

  try {
    await self.registration.showNotification(`⏰ ${label} — RINGING`, withActions);
  } catch(e) {
    try {
      // Fallback without actions (iOS Safari)
      await self.registration.showNotification(`⏰ ${label} — RINGING`, base);
    } catch(e2) {
      console.error('[SSS SW] Notification error:', e2);
    }
  }

  // Start rhythmic re-notification loop
  startRhythmicLoop(alarm);
}

// ── Rhythmic loop: re-notifies every 10s so it keeps pulsing ──
// Each re-notify replaces the existing notification (same tag)
// but triggers vibrate again and updates the body text with elapsed time
function startRhythmicLoop(alarm) {
  let pulse   = 0;
  const qCount = alarm.qCount || 15;
  const label  = alarm.label  || 'SSS Alarm';

  const id = setInterval(async () => {
    pulse++;

    // Stop after 18 min (108 pulses × 10s) or when dismissed
    if (pulse > 108 || !activeAlarmIds.has(alarm.id)) {
      clearInterval(id);
      return;
    }

    const elapsed = pulse * 10; // seconds
    const elStr   = elapsed < 60
      ? `${elapsed}s`
      : `${Math.floor(elapsed/60)}m ${elapsed%60}s`;

    const openClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });

    if (openClients.length > 0) {
      // App is open — ping it so audio keeps playing / quiz launches
      openClients.forEach(c => c.postMessage({ type: 'FIRE_ALARM_AUDIO', alarm }));
    }

    // Always re-show notification so lock screen keeps pulsing
    try {
      await self.registration.showNotification(`⏰ ${label} — ${elStr} RINGING`, {
        body:               `Tap to answer ${qCount} MCQs and stop the alarm 🔔`,
        icon:               LOGO_URL,
        badge:              LOGO_URL,
        image:              LOGO_URL,
        vibrate:            PULSE_VIBRATE,
        tag:                `sss-alarm-${alarm.id}`,
        renotify:           true,
        requireInteraction: true,
        silent:             true,   // vibrate only on re-rings (no repeated sound)
        data:               { alarm, firedAt: Date.now(), directQuiz: true },
        actions: [
          { action: 'start-quiz', title: '📝 Start Quiz Now' },
          { action: 'open-app',   title: '⏰ Open App'        }
        ]
      });
    } catch(e) {}

  }, 10000); // every 10 seconds
}

// ═══════════════════════════════════════════════════════════
//  NOTIFICATION CLICK  → open app and LAUNCH QUIZ DIRECTLY
//
//  Tapping the notification (or "Start Quiz" button) skips
//  the alarm overlay entirely and goes straight to MCQs.
//  Audio starts simultaneously on the page side.
// ═══════════════════════════════════════════════════════════

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const alarm  = event.notification.data?.alarm;
  const action = event.action; // 'start-quiz' | 'open-app' | '' (body tap)

  // Body tap OR "Start Quiz" → go directly to quiz
  // "Open App" → show alarm overlay (normal flow)
  const goDirectToQuiz = (action === 'start-quiz' || action === '');

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clientList => {
        // Find an existing open window
        for (const client of clientList) {
          if (client.url.includes('index.html') || /\/$/.test(client.url)) {
            client.postMessage({
              type:  goDirectToQuiz ? 'LAUNCH_QUIZ' : 'FIRE_ALARM_AUDIO',
              alarm
            });
            return client.focus();
          }
        }

        // No window open — open app fresh, then send message after 2.5s init
        return clients.openWindow('./index.html').then(newClient => {
          if (newClient) {
            setTimeout(() => {
              newClient.postMessage({
                type:  goDirectToQuiz ? 'LAUNCH_QUIZ' : 'FIRE_ALARM_AUDIO',
                alarm
              });
            }, 2500);
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

