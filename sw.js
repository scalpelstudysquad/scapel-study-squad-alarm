// ═══════════════════════════════════════════════════════════
//  SSS ALARM — Service Worker v3.2
//
//  ARCHITECTURE:
//  ┌─────────────────────────────────────────────────────┐
//  │  SCREEN ON  → Page pings SW every 25s (KEEPALIVE)  │
//  │               SW checks alarms → posts to page     │
//  │               Page fires audio + shows overlay     │
//  │                                                     │
//  │  SCREEN OFF → Periodic Background Sync fires       │
//  │               SW checks alarms independently       │
//  │               SW shows LOCK SCREEN notification    │
//  │               User taps → app opens → quiz starts  │
//  └─────────────────────────────────────────────────────┘
//
//  KEY POINTS:
//  - Notification is shown from SW (not page) — only SW
//    notifications appear on lock screen reliably.
//  - Audio cannot play from SW — page must handle audio.
//  - notificationclick opens/focuses the page and posts
//    LAUNCH_QUIZ so alarm + audio start immediately.
//  - firedKeys Set prevents duplicate fires within same minute.
// ═══════════════════════════════════════════════════════════

const SW_VERSION = 'sss-alarm-v3.2';

// In-memory alarm cache (populated by page via UPDATE_ALARMS)
let cachedAlarms = [];

// Tracks alarms that have already fired this session
// Format: "alarmId_DateString_HH:MM"
const firedKeys = new Set();

// ── INSTALL ───────────────────────────────────────────────
self.addEventListener('install', event => {
  console.log('[SW] Install', SW_VERSION);
  self.skipWaiting();
});

// ── ACTIVATE ──────────────────────────────────────────────
self.addEventListener('activate', event => {
  console.log('[SW] Activate', SW_VERSION);
  event.waitUntil(self.clients.claim());
});

// ── MESSAGE FROM PAGE ─────────────────────────────────────
self.addEventListener('message', event => {
  const msg = event.data || {};
  const src = event.source;

  switch (msg.type) {

    // Page sends its full alarm list on load + every update
    case 'UPDATE_ALARMS':
      cachedAlarms = msg.alarms || [];
      console.log('[SW] Alarms updated:', cachedAlarms.length);
      break;

    // Page keepalive ping every 25s — SW wakes, checks alarms
    case 'KEEPALIVE':
      checkAlarmsAndFire();
      // Ack so page knows SW is alive
      if (src) src.postMessage({ type: 'KEEPALIVE_ACK' });
      break;

    // Page-side alarm fired — show SW notification so it appears
    // on lock screen / notification panel (page notifications don't)
    case 'SHOW_NOTIFICATION':
      if (msg.alarm) showNotificationOnly(msg.alarm);
      break;

    // Page confirms alarm was dismissed — prevents re-fire
    case 'ALARM_DISMISSED':
      if (msg.alarmId) {
        // Add all possible keys for this alarm to prevent re-trigger
        const now = new Date();
        const ct = formatTime(now);
        firedKeys.add(`${msg.alarmId}_${now.toDateString()}_${ct}`);
      }
      // Close any open notifications for this alarm
      self.registration.getNotifications({ tag: 'sss-alarm-active' })
        .then(notifs => notifs.forEach(n => n.close()))
        .catch(() => {});
      break;
  }
});

// ── PERIODIC BACKGROUND SYNC ──────────────────────────────
// Fires even when screen is off (Chrome Android, registered from page)
// Chrome decides exact timing — typically respects minInterval of 60s
self.addEventListener('periodicsync', event => {
  if (event.tag === 'sss-alarm-check') {
    console.log('[SW] Periodic sync fired');
    event.waitUntil(checkAlarmsAndFire());
  }
});

// ── NOTIFICATION CLICK ────────────────────────────────────
// User taps lock-screen notification → open or focus the app
// Then send LAUNCH_QUIZ so audio + quiz start immediately
self.addEventListener('notificationclick', event => {
  event.notification.close();

  const data    = event.notification.data || {};
  const alarm   = data.alarm;
  const action  = event.action;

  console.log('[SW] Notification clicked, action:', action, 'alarm:', alarm?.label);

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then(clientList => {

        // ── Try to find an already-open app window ─────────
        for (const client of clientList) {
          const url = new URL(client.url);
          // Match any page of this PWA
          if (url.origin === self.location.origin) {
            client.focus();
            // Post message to fire alarm immediately
            client.postMessage({ type: 'LAUNCH_QUIZ', alarm });
            return;
          }
        }

        // ── No open window — open new one ──────────────────
        // URL params are the fallback for checkURLParams() in page
        const targetUrl = `${self.location.origin}/?alarm=true&id=${alarm?.id || ''}`;
        return self.clients.openWindow(targetUrl);
      })
  );
});

// ── NOTIFICATION CLOSE (dismissed without tapping) ────────
self.addEventListener('notificationclose', event => {
  // User swiped away the notification — we DON'T mark as dismissed
  // so the alarm can still fire if the page becomes visible
  console.log('[SW] Notification dismissed without tap');
});

// ── PUSH (future server-push support) ────────────────────
self.addEventListener('push', event => {
  // Reserved for future server-push alarm triggers
  console.log('[SW] Push received');
});

// ═══════════════════════════════════════════════════════════
//  CORE: CHECK ALARMS
// ═══════════════════════════════════════════════════════════

async function checkAlarmsAndFire() {
  if (!cachedAlarms.length) return;

  const now = new Date();
  const ct  = formatTime(now);   // "HH:MM"
  const cd  = now.getDay();      // 0=Sun … 6=Sat
  const today = now.toDateString();

  for (const alarm of cachedAlarms) {
    if (!alarm.enabled)                          continue;
    if (alarm.time !== ct)                       continue;
    if (!isDayAllowed(alarm.days, cd))           continue;

    const key = `${alarm.id}_${today}_${ct}`;
    if (firedKeys.has(key))                      continue;

    // Mark fired BEFORE async ops to prevent race on rapid pings
    firedKeys.add(key);

    console.log('[SW] Alarm firing:', alarm.label, ct);
    await fireAlarm(alarm);
    break; // fire one alarm per check cycle
  }
}

async function fireAlarm(alarm) {
  // ── 1. Try to reach an open page first ────────────────
  // If page is visible (screen on), it handles audio + overlay
  const pageClients = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true
  });

  let pageFired = false;
  for (const client of pageClients) {
    const url = new URL(client.url);
    if (url.origin === self.location.origin) {
      client.postMessage({ type: 'FIRE_ALARM_AUDIO', alarm });
      pageFired = true;
      console.log('[SW] Fired via page message');
    }
  }

  // ── 2. Always show notification ────────────────────────
  // Even if page is open, notification ensures lock-screen visibility
  // and serves as the audio trigger when screen is off + app wakes
  try {
    // Close any existing alarm notification first (avoid stacking)
    const existing = await self.registration.getNotifications({ tag: 'sss-alarm-active' });
    existing.forEach(n => n.close());

    await self.registration.showNotification(`⏰ ${alarm.label}`, {
      body:             `🔊 Alarm ringing! Tap to answer ${alarm.qCount || 15} MCQs and stop it.`,
      icon:             '/icons/icon-512.png',
      badge:            '/icons/icon-192.png',
      tag:              'sss-alarm-active',
      renotify:         true,
      requireInteraction: true,   // stays on screen until tapped
      silent:           false,    // allows system alarm sound if set
      vibrate:          [
        1000, 300, 1000, 300, 1000, 600,   // SOS-like pattern
        500,  200, 500,  200, 500,  600,
        1000, 300, 1000, 300, 1000
      ],
      timestamp:        Date.now(),
      data:             { alarm, alarmId: alarm.id },
      // Notification action button (Android supports these)
      actions: [
        { action: 'answer', title: '📝 Answer MCQs to Stop Alarm' }
      ]
    });

    console.log('[SW] Notification shown ✓');
  } catch (err) {
    console.warn('[SW] Notification failed:', err.message);
  }
}

// ── HELPERS ───────────────────────────────────────────────

function formatTime(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function isDayAllowed(days, dayOfWeek) {
  if (!days || days.length === 0) return true;   // no restriction
  return days.includes(dayOfWeek);
}

// Show notification only — without posting FIRE_ALARM_AUDIO back to page
// Used when page-side checker fires the alarm (page is already handling audio)
async function showNotificationOnly(alarm) {
  try {
    const existing = await self.registration.getNotifications({ tag: 'sss-alarm-active' });
    existing.forEach(n => n.close());
    await self.registration.showNotification(`⏰ ${alarm.label}`, {
      body:               `🔊 Alarm ringing! Tap to answer ${alarm.qCount || 15} MCQs and stop it.`,
      icon:               '/icons/icon-512.png',
      badge:              '/icons/icon-192.png',
      tag:                'sss-alarm-active',
      renotify:           true,
      requireInteraction: true,
      silent:             false,
      vibrate:            [500, 200, 500, 200, 1000, 300, 1000],
      timestamp:          Date.now(),
      data:               { alarm, alarmId: alarm.id },
      actions:            [{ action: 'answer', title: '📝 Answer MCQs to Stop Alarm' }]
    });
  } catch (err) {
    console.warn('[SW] showNotificationOnly failed:', err.message);
  }
}

