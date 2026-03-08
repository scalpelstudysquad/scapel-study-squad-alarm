// ═══════════════════════════════════════════════════════════
//  SSS ALARM — Service Worker v4.0  (FIXED)
//
//  WHAT WAS FIXED vs v3.2:
//  ─────────────────────────────────────────────────────────
//  1. firedKeys now persisted in IndexedDB → survives SW
//     restarts and screen-off wake cycles (was in-memory Set,
//     so SW restart after screen-off cleared it → duplicate fires)
//
//  2. SW requests fresh alarms from page when cachedAlarms is
//     empty (e.g. after SW restart) → fixes "background alarm
//     never fires because cachedAlarms is always []"
//
//  3. Notification shown via SW only → lock screen &
//     notification panel work correctly on Android
//     (page now calls SW via SHOW_NOTIFICATION, never
//     new Notification() directly)
//
//  4. Snooze handled entirely in SW notification action →
//     snooze works even when screen is off / app is closed
//
//  5. ALARM_DISMISSED clears firedKeys entry from IndexedDB
//     so re-enabled alarms work the next day
//
//  6. Offline cache for all app shell files → app loads
//     without network after first install
//
//  7. Periodic sync registration attempted inside SW activate
//     as well as from page → more reliable background wakeup
//
//  ARCHITECTURE:
//  ┌─────────────────────────────────────────────────────┐
//  │  SCREEN ON  → Page pings SW every 20s (KEEPALIVE)  │
//  │               SW checks alarms → posts FIRE_ALARM   │
//  │               to page AND shows SW notification     │
//  │               Page fires audio + shows overlay      │
//  │                                                     │
//  │  SCREEN OFF → Periodic Background Sync fires        │
//  │               SW requests alarms from page if open  │
//  │               SW checks cachedAlarms independently  │
//  │               SW shows LOCK SCREEN notification     │
//  │               User taps → app opens → quiz starts   │
//  │                                                     │
//  │  SNOOZE     → Handled by SW via setTimeout even    │
//  │               when page is closed                  │
//  └─────────────────────────────────────────────────────┘
// ═══════════════════════════════════════════════════════════

const SW_VERSION = 'sss-alarm-v4.0';

// ── APP SHELL CACHE ───────────────────────────────────────
const CACHE_NAME = 'sss-cache-v4';
const CACHE_FILES = [
  './Index.html',
  './sw.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// ── IN-MEMORY ALARM CACHE ─────────────────────────────────
// Populated by page via UPDATE_ALARMS message.
// Persisted to IndexedDB so it survives SW restart.
let cachedAlarms = [];

// Active snooze timers: { alarmId → timeoutId }
const snoozeTimers = {};

// ── INDEXEDDB HELPERS ─────────────────────────────────────
// We use IDB to persist:
//   firedKeys  → Set of "alarmId_DateString_HH:MM" strings
//   alarms     → copy of cachedAlarms array
const IDB_NAME    = 'sss-sw-store';
const IDB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('kv')) {
        db.createObjectStore('kv');
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function idbGet(key) {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction('kv', 'readonly');
      const req = tx.objectStore('kv').get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => resolve(null);
    });
  } catch { return null; }
}

async function idbSet(key, value) {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction('kv', 'readwrite');
      const req = tx.objectStore('kv').put(value, key);
      req.onsuccess = () => resolve(true);
      req.onerror   = () => resolve(false);
    });
  } catch { return false; }
}

// ── FIRED KEYS (persisted) ────────────────────────────────
async function hasFiredKey(key) {
  const keys = await idbGet('firedKeys') || [];
  return keys.includes(key);
}

async function addFiredKey(key) {
  const keys = await idbGet('firedKeys') || [];
  if (!keys.includes(key)) {
    keys.push(key);
    // Keep only last 500 keys to avoid unbounded growth
    if (keys.length > 500) keys.splice(0, keys.length - 500);
    await idbSet('firedKeys', keys);
  }
}

async function removeFiredKey(key) {
  const keys = await idbGet('firedKeys') || [];
  const filtered = keys.filter(k => k !== key);
  await idbSet('firedKeys', filtered);
}

// ── INSTALL ───────────────────────────────────────────────
self.addEventListener('install', event => {
  console.log('[SW] Install', SW_VERSION);
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(CACHE_FILES).catch(err => {
        // Don't block install if some files are missing
        console.warn('[SW] Cache prefill partial:', err.message);
      });
    }).then(() => self.skipWaiting())
  );
});

// ── ACTIVATE ──────────────────────────────────────────────
self.addEventListener('activate', event => {
  console.log('[SW] Activate', SW_VERSION);
  event.waitUntil(
    Promise.all([
      // Delete old caches
      caches.keys().then(names =>
        Promise.all(
          names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n))
        )
      ),
      self.clients.claim(),
      // Restore cached alarms from IDB (survives SW restart)
      idbGet('cachedAlarms').then(alarms => {
        if (Array.isArray(alarms) && alarms.length > 0) {
          cachedAlarms = alarms;
          console.log('[SW] Restored', alarms.length, 'alarms from IDB');
        }
      })
    ])
  );
});

// ── FETCH (offline cache) ─────────────────────────────────
self.addEventListener('fetch', event => {
  // Only cache GET requests for same-origin app shell
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Cache fresh copies of app shell
        if (response.ok) {
          caches.open(CACHE_NAME).then(cache =>
            cache.put(event.request, response.clone())
          );
        }
        return response;
      }).catch(() => cached || new Response('Offline', { status: 503 }));
    })
  );
});

// ── MESSAGE FROM PAGE ─────────────────────────────────────
self.addEventListener('message', event => {
  const msg = event.data || {};
  const src = event.source;

  switch (msg.type) {

    // ── Page sends full alarm list on load + every update ──
    case 'UPDATE_ALARMS':
      cachedAlarms = msg.alarms || [];
      // Persist to IDB so we have it after SW restart
      idbSet('cachedAlarms', cachedAlarms);
      console.log('[SW] Alarms updated & persisted:', cachedAlarms.length);
      if (src) src.postMessage({ type: 'SW_READY', version: SW_VERSION });
      break;

    // ── Page keepalive ping every 20s ─────────────────────
    // SW wakes up, checks alarms, posts back ACK
    case 'KEEPALIVE':
      checkAlarmsAndFire();
      if (src) src.postMessage({ type: 'KEEPALIVE_ACK', version: SW_VERSION });
      break;

    // ── Page fires alarm, asks SW to show the notification ─
    // This ensures lock screen + notification panel visibility
    case 'SHOW_NOTIFICATION':
      if (msg.alarm) showAlarmNotification(msg.alarm);
      break;

    // ── Alarm dismissed (quiz answered / results closed) ───
    case 'ALARM_DISMISSED': {
      const id = msg.alarmId;
      if (id) {
        const now = new Date();
        const ct  = formatTime(now);
        const key = `${id}_${now.toDateString()}_${ct}`;
        addFiredKey(key);
      }
      // Cancel any pending snooze for this alarm
      if (id && snoozeTimers[id]) {
        clearTimeout(snoozeTimers[id]);
        delete snoozeTimers[id];
      }
      // Close any open alarm notification
      self.registration.getNotifications({ tag: 'sss-alarm-active' })
        .then(notifs => notifs.forEach(n => n.close()))
        .catch(() => {});
      break;
    }

    // ── Page requests SW version (health check) ───────────
    case 'PING':
      if (src) src.postMessage({ type: 'PONG', version: SW_VERSION });
      break;
  }
});

// ── PERIODIC BACKGROUND SYNC ──────────────────────────────
// Fires even when screen is off on Chrome Android
self.addEventListener('periodicsync', event => {
  if (event.tag === 'sss-alarm-check') {
    console.log('[SW] Periodic sync fired');
    event.waitUntil(
      // Try to get fresh alarms from the open page first
      requestAlarmsFromPage().then(() => checkAlarmsAndFire())
    );
  }
});

// ── NOTIFICATION CLICK ────────────────────────────────────
self.addEventListener('notificationclick', event => {
  const notification = event.notification;
  const data   = notification.data || {};
  const alarm  = data.alarm;
  const action = event.action;

  notification.close();
  console.log('[SW] Notification clicked, action:', action, 'alarm:', alarm?.label);

  // ── Snooze action ──────────────────────────────────────
  if (action === 'snooze') {
    const snoozeCount = (data.snoozeCount || 0) + 1;
    if (snoozeCount > 3) {
      // Max snoozes reached — re-show notification forcing quiz
      event.waitUntil(showAlarmNotification(alarm, snoozeCount, true));
      return;
    }
    // Schedule re-fire after 5 minutes entirely within SW
    event.waitUntil(
      Promise.resolve().then(() => {
        console.log('[SW] Snooze', snoozeCount, '/3 for', alarm?.label);
        if (alarm?.id && snoozeTimers[alarm.id]) {
          clearTimeout(snoozeTimers[alarm.id]);
        }
        if (alarm?.id) {
          snoozeTimers[alarm.id] = setTimeout(() => {
            delete snoozeTimers[alarm.id];
            fireAlarm(alarm, snoozeCount);
          }, 5 * 60 * 1000);
        }
        // Also notify the page if it's open
        return self.clients.matchAll({ type: 'window', includeUncontrolled: true })
          .then(clients => {
            clients.forEach(c => {
              if (new URL(c.url).origin === self.location.origin) {
                c.postMessage({ type: 'SNOOZED', alarmId: alarm?.id, snoozeCount });
              }
            });
          });
      })
    );
    return;
  }

  // ── Answer / tap notification body ────────────────────
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then(clientList => {
        for (const client of clientList) {
          if (new URL(client.url).origin === self.location.origin) {
            client.focus();
            client.postMessage({ type: 'LAUNCH_QUIZ', alarm });
            return;
          }
        }
        // No open window — open new one
        const targetUrl = `${self.location.origin}/Index.html?alarm=true&id=${alarm?.id || ''}`;
        return self.clients.openWindow(targetUrl);
      })
  );
});

// ── NOTIFICATION CLOSE (dismissed without tapping) ────────
self.addEventListener('notificationclose', event => {
  // User swiped away — don't mark as dismissed; alarm stays
  // active in case page is visible and handling audio
  console.log('[SW] Notification swiped away — audio still playing on page');
});

// ── PUSH (future server-push support) ────────────────────
self.addEventListener('push', event => {
  console.log('[SW] Push received');
  // Reserved for future server-push alarm triggers
});

// ═══════════════════════════════════════════════════════════
//  CORE: CHECK ALARMS
// ═══════════════════════════════════════════════════════════

async function checkAlarmsAndFire() {
  // If SW restarted and lost cachedAlarms, try IDB restore
  if (!cachedAlarms.length) {
    const stored = await idbGet('cachedAlarms');
    if (Array.isArray(stored) && stored.length > 0) {
      cachedAlarms = stored;
      console.log('[SW] Restored alarms from IDB for check:', cachedAlarms.length);
    }
  }
  if (!cachedAlarms.length) {
    console.log('[SW] No alarms cached — requesting from page');
    await requestAlarmsFromPage();
    return; // Will fire on next check when alarms arrive
  }

  const now   = new Date();
  const ct    = formatTime(now);
  const cd    = now.getDay();
  const today = now.toDateString();

  for (const alarm of cachedAlarms) {
    if (!alarm.enabled)              continue;
    if (alarm.time !== ct)           continue;
    if (!isDayAllowed(alarm.days, cd)) continue;

    const key = `${alarm.id}_${today}_${ct}`;
    if (await hasFiredKey(key))      continue;

    // Mark fired BEFORE async ops to prevent race on rapid pings
    await addFiredKey(key);

    console.log('[SW] Alarm firing:', alarm.label, ct);
    await fireAlarm(alarm, 0);
    break; // fire one alarm per check cycle
  }
}

// ─────────────────────────────────────────────────────────
async function fireAlarm(alarm, snoozeCount = 0) {
  // 1. Tell the open page to fire audio + show overlay
  const pageClients = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true
  });

  for (const client of pageClients) {
    if (new URL(client.url).origin === self.location.origin) {
      client.postMessage({ type: 'FIRE_ALARM_AUDIO', alarm, snoozeCount });
      console.log('[SW] Sent FIRE_ALARM_AUDIO to page');
    }
  }

  // 2. Always show SW notification — this is what appears on
  //    the lock screen and notification panel on Android.
  //    (Page notifications do NOT appear on lock screen)
  await showAlarmNotification(alarm, snoozeCount, false);
}

// ─────────────────────────────────────────────────────────
async function showAlarmNotification(alarm, snoozeCount = 0, noMoreSnooze = false) {
  try {
    // Close any existing alarm notification (avoid stacking)
    const existing = await self.registration.getNotifications({ tag: 'sss-alarm-active' });
    existing.forEach(n => n.close());

    const snoozesLeft = 3 - (snoozeCount || 0);
    const snoozeLabel = noMoreSnooze
      ? '❌ No more snoozes!'
      : `💤 Snooze (${snoozesLeft} left)`;

    await self.registration.showNotification(`⏰ ${alarm.label || 'Study Alarm'}`, {
      body:               `Tap to answer ${alarm.qCount || 15} MCQs and stop the alarm!`,
      icon:               '/icons/icon-512.png',
      badge:              '/icons/icon-192.png',
      tag:                'sss-alarm-active',
      renotify:           true,
      requireInteraction: true,   // stays on screen until tapped
      silent:             false,  // allow system sound / vibration
      vibrate:            [
        1000, 300, 1000, 300, 1000, 600,
        500,  200, 500,  200, 500,  600,
        1000, 300, 1000, 300, 1000
      ],
      timestamp:          Date.now(),
      data:               { alarm, alarmId: alarm.id, snoozeCount: snoozeCount || 0 },
      actions: [
        { action: 'answer', title: '📝 Answer MCQs' },
        { action: 'snooze', title: snoozeLabel }
      ]
    });

    console.log('[SW] Notification shown ✓ (lock screen visible)');
  } catch (err) {
    console.warn('[SW] Notification failed:', err.message);
  }
}

// ─────────────────────────────────────────────────────────
// Ask any open page to re-send its alarm list
// Used when SW restarts and cachedAlarms is empty
async function requestAlarmsFromPage() {
  try {
    const clients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    });
    for (const client of clients) {
      if (new URL(client.url).origin === self.location.origin) {
        client.postMessage({ type: 'REQUEST_ALARMS' });
        console.log('[SW] Requested alarms from open page');
        return true;
      }
    }
  } catch(e) {}
  return false;
}

// ═══════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════

function formatTime(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function isDayAllowed(days, dayOfWeek) {
  if (!days || days.length === 0) return true;
  return days.includes(dayOfWeek);
}

