// The Cost Board: wall-display dashboard page.
//
// Static, no framework, no build. Polls Supabase (or the mock server) every 60 s, recomputes the
// projection in the browser with engine.js, derives a render model with view-model.js and paints it.
//
// Kiosk deployment (Chrome on the TV box). Autoplay: Chrome only lets a page start audio after a user
// gesture unless it is launched with
//
//     chrome --kiosk --autoplay-policy=no-user-gesture-required "http://<host>/dashboard/?tv=tv1"
//
// Without that flag the first voice line is held back and the page shows a 48 px "Tap once to enable
// voice" overlay; a single click or key press dismisses it, unlocks audio, and the held line plays.
//
// ABSOLUTE RULE: audio never plays between 22:00 and 07:00 local (Gaps.isQuietHours). The rule is
// enforced in decideVoice() before any request, again in playVoice() immediately before play(), and
// the silent unlock in unlockAudio() skips its (muted) play() in quiet hours too.

import * as E from './engine.js';
import {
  POLL_INTERVAL_MS,
  POLL_QUERIES,
  WEEKLY_ROTATE_MS,
  audioAllowed,
  buildModel,
  decideVoice,
  effectiveTrackingStart,
  effectiveZone,
  parseFlags,
  resolveApi,
  restHeaders,
  settingsMap,
  weeklySentence,
} from './view-model.js';

// ---------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------
const flags = parseFlags(location.search, location.port);
const api = resolveApi(typeof window.COSTBOARD === 'object' ? window.COSTBOARD : null, flags, location.origin);
const browserZone = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; }
})();

const $ = (id) => document.getElementById(id);
const els = {
  board: $('board'),
  lossFigure: $('loss-figure'),
  lossSince: $('loss-since'),
  lossSkipped: $('loss-skipped'),
  frenchBanked: $('french-banked'),
  frenchRate: $('french-rate'),
  frenchNclc7: $('french-nclc7'),
  frenchLanding: $('french-landing'),
  weekly: $('weekly'),
  weeklyText: $('weekly-text'),
  footerYear30: $('footer-year30'),
  footerUpdated: $('footer-updated'),
  statusDot: $('status-dot'),
  statusError: $('status-error'),
  configMissing: $('config-missing'),
  configMissingText: $('config-missing-text'),
  voiceOverlay: $('voice-overlay'),
  audio: $('voice-audio'),
};

const state = {
  // last good data
  entries: [],
  snapshots: [],
  settings: {},
  weekly: null,
  latestVoiceEvent: null,
  // render bookkeeping
  status: { ok: true, error: null, updatedAt: null },
  model: null,
  zone: browserZone,
  weeklyIndex: 0, // which sentence of the weekly summary is on screen
  weeklyKey: null, // week_start of the summary the index belongs to
  // voice bookkeeping
  voiceInFlight: false,
  voiceLastRequestAt: null,
  audioUnlocked: false,
  pendingClip: null, // { blob, fetchedAt } held back by the autoplay policy
  pollTimer: null,
  polling: false,
};

els.board.dataset.kiosk = flags.kiosk ? '1' : '0';

if (!api.ok) {
  els.configMissingText.textContent = api.reason;
  els.configMissing.hidden = false;
  els.statusDot.classList.remove('status-dot--ok');
  els.statusDot.classList.add('status-dot--error');
  els.footerUpdated.textContent = 'not configured';
} else {
  start();
}

function start() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') poll();
  });
  for (const ev of ['click', 'keydown', 'touchstart', 'pointerdown']) {
    document.addEventListener(ev, onUserGesture, { passive: true });
  }
  setInterval(tickClock, 1000);
  setInterval(rotateWeekly, WEEKLY_ROTATE_MS);
  poll();
  state.pollTimer = setInterval(poll, POLL_INTERVAL_MS);
}

// ---------------------------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------------------------
async function poll() {
  if (state.polling) return;
  if (document.visibilityState === 'hidden') return;
  state.polling = true;
  const now = Date.now();
  try {
    const [entries, snapshots, settingsRows, weeklyRows, voiceRows] = await Promise.all([
      getRows(POLL_QUERIES.entries),
      getRows(POLL_QUERIES.snapshots),
      getRows(POLL_QUERIES.settings),
      getRows(POLL_QUERIES.weekly),
      getRows(POLL_QUERIES.voiceEvents),
    ]);
    state.entries = entries;
    state.snapshots = snapshots;
    state.settings = settingsMap(settingsRows);
    state.weekly = weeklyRows[0] || null;
    state.latestVoiceEvent = voiceRows[0] || null;
    state.status = { ok: true, error: null, updatedAt: now };
    recompute(now);
    render();
    await maybeSpeak(now);
  } catch (err) {
    state.status = { ok: false, error: describeError(err), updatedAt: state.status.updatedAt };
    if (state.model) {
      // Keep the last good numbers on screen; only the footer changes.
      state.model = buildModel({
        projection: state.projection,
        deltas: state.deltas,
        weekly: state.weekly,
        status: state.status,
        flags,
        now,
      });
      render();
    } else {
      renderFooterOnly();
    }
    console.warn('[costboard] poll failed:', err);
  } finally {
    state.polling = false;
  }
}

async function getRows(query) {
  const res = await fetch(`${api.base}/rest/v1/${query}`, { headers: restHeaders(api.key), cache: 'no-store' });
  if (!res.ok) throw new Error(`${query.split('?')[0]}: HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body)) throw new Error(`${query.split('?')[0]}: unexpected response shape`);
  return body;
}

function describeError(err) {
  if (!err) return 'unknown error';
  if (err instanceof TypeError) return `network error: ${err.message}`;
  return err.message || String(err);
}

function recompute(now) {
  state.zone = effectiveZone(flags, state.settings, browserZone);
  const trackingStart = effectiveTrackingStart(state.settings);
  state.projection = E.project(state.entries, now, state.zone, trackingStart);
  const baseline = E.lastMonday(state.snapshots, state.projection.today, state.zone);
  state.deltas = E.compare(state.projection, baseline);
  state.model = buildModel({
    projection: state.projection,
    deltas: state.deltas,
    weekly: state.weekly,
    status: state.status,
    flags,
    now,
  });
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------
const TONES = ['tone-red', 'tone-green', 'tone-muted', 'tone-neutral'];
function setTone(el, tone) {
  for (const t of TONES) el.classList.remove(t);
  el.classList.add(`tone-${tone}`);
}

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function renderDelta(container, arrowEl, textEl, delta) {
  setText(arrowEl, delta.arrow);
  setText(textEl, delta.text);
  setTone(container, delta.tone);
  container.setAttribute('aria-label', delta.label);
}

function render() {
  const m = state.model;
  if (!m) return;

  // 1. Cumulative loss
  setText(els.lossFigure, m.loss.figure);
  setTone(els.lossFigure, m.loss.tone);
  setText(els.lossSince, m.loss.since);
  setText(els.lossSkipped, m.loss.skipped);

  // 2. Goal dates
  for (const g of m.goals) {
    const li = $(`goal-${g.key}`);
    if (!li) continue;
    const date = li.querySelector('.goal__date');
    setText(date, g.date);
    setTone(date, g.dateTone);
    renderDelta(
      li.querySelector('.goal__delta'),
      li.querySelector('.goal__arrow'),
      li.querySelector('.goal__delta-text'),
      g.delta,
    );
  }
  const partner = $('goal-partner_tuition');
  setText(partner.querySelector('.goal__date'), m.partner.date);

  // 3. French progress
  setText(els.frenchBanked, m.french.banked);
  setText(els.frenchRate, m.french.rate);
  for (const [el, item] of [[els.frenchNclc7, m.french.nclc7], [els.frenchLanding, m.french.landing]]) {
    const date = el.querySelector('.french__date');
    setText(date, item.date);
    setTone(date, item.dateTone);
    renderDelta(
      el.querySelector('.french__delta'),
      el.querySelector('.french__arrow'),
      el.querySelector('.french__delta-text'),
      item.delta,
    );
  }

  // 4. Weekly summary: one sentence at a time (a whole four-sentence summary does not fit at 48 px).
  const weeklyKey = state.weekly ? state.weekly.week_start || state.weekly.id || null : null;
  if (weeklyKey !== state.weeklyKey) {
    state.weeklyKey = weeklyKey;
    state.weeklyIndex = 0;
  }
  renderWeekly();

  // 5. Footer
  setText(els.footerYear30, m.footer.year30);
  renderFooterOnly();
}

function renderWeekly() {
  const m = state.model;
  if (!m) return;
  els.weekly.hidden = !m.weekly.show;
  setText(els.weeklyText, weeklySentence(m.weekly.sentences, state.weeklyIndex));
}

function rotateWeekly() {
  const m = state.model;
  if (!m || !m.weekly.show || m.weekly.sentences.length < 2) return;
  state.weeklyIndex = (state.weeklyIndex + 1) % m.weekly.sentences.length;
  renderWeekly();
}

function renderFooterOnly() {
  const m = state.model;
  const ok = state.status.ok;
  // Grey only: red and green are reserved for dates that slipped or moved closer.
  els.statusDot.classList.toggle('status-dot--error', !ok);
  els.statusDot.setAttribute('aria-label', ok ? 'connection ok' : 'last poll failed');
  if (m) {
    setText(els.footerUpdated, m.footer.updated);
    els.statusError.hidden = !m.footer.showError;
    setText(els.statusError, m.footer.error);
  } else {
    setText(els.footerUpdated, state.status.updatedAt == null ? 'waiting for first update' : '');
    els.statusError.hidden = flags.kiosk || ok || !state.status.error;
    setText(els.statusError, state.status.error || '');
  }
}

function tickClock() {
  if (!state.model) return;
  // The "updated hh:mm" text is derived from the last successful poll; re-deriving it every second
  // keeps it correct across zone changes and makes the footer a live element.
  state.model.footer.updated = buildModel({
    projection: state.projection,
    deltas: state.deltas,
    weekly: state.weekly,
    status: state.status,
    flags,
    now: Date.now(),
  }).footer.updated;
  renderFooterOnly();
}

// ---------------------------------------------------------------------------------------------
// Voice (the escalation)
// ---------------------------------------------------------------------------------------------
async function maybeSpeak(now) {
  const decision = decideVoice({
    flags,
    settings: state.settings,
    now,
    zone: state.zone,
    entries: state.entries,
    latestVoiceEvent: state.latestVoiceEvent,
    lastRequestAt: state.voiceLastRequestAt,
    inFlight: state.voiceInFlight,
  });
  if (!decision.fire) return;

  state.voiceInFlight = true;
  state.voiceLastRequestAt = now;
  try {
    const res = await fetch(`${api.base}/functions/v1/voice-line`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${api.key}`, apikey: api.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tv: flags.tv, force: false }),
    });
    if (res.status === 204) return;
    if (!res.ok) throw new Error(`voice-line: HTTP ${res.status}`);
    const body = await res.json();
    if (!body || typeof body.audio_base64 !== 'string' || !body.audio_base64) return;
    const blob = base64ToBlob(body.audio_base64, body.mime || 'audio/mpeg');
    // The function inserted a voice_events row; mirror it locally so the next poll cannot double-fire
    // before the row is visible.
    state.latestVoiceEvent = { fired_at: body.fired_at || new Date(now).toISOString(), line: body.line || '', played_by: flags.tv };
    await playVoice(blob);
  } catch (err) {
    console.warn('[costboard] voice-line failed:', err);
  } finally {
    state.voiceInFlight = false;
  }
}

function base64ToBlob(b64, mime) {
  const clean = b64.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

let currentObjectUrl = null;

async function playVoice(blob) {
  // ABSOLUTE RULE, re-checked at the last possible moment: no audio in quiet hours.
  if (!audioAllowed(Date.now(), state.zone)) {
    state.pendingClip = null;
    return;
  }
  if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
  currentObjectUrl = URL.createObjectURL(blob);
  els.audio.src = currentObjectUrl;
  try {
    await els.audio.play();
    state.audioUnlocked = true;
    state.pendingClip = null;
    els.voiceOverlay.hidden = true;
  } catch (err) {
    // Autoplay policy (NotAllowedError): hold the clip and ask for one gesture.
    console.warn('[costboard] play() rejected, waiting for a user gesture:', err && err.name);
    state.audioUnlocked = false;
    state.pendingClip = { blob, fetchedAt: Date.now() };
    els.voiceOverlay.hidden = false;
  }
}

async function onUserGesture() {
  if (!els.voiceOverlay.hidden) els.voiceOverlay.hidden = true;
  if (state.audioUnlocked) return;
  await unlockAudio();
  const clip = state.pendingClip;
  state.pendingClip = null;
  // A held clip is only worth playing if it is recent and we are still outside quiet hours.
  if (clip && Date.now() - clip.fetchedAt < 10 * 60 * 1000 && audioAllowed(Date.now(), state.zone)) {
    await playVoice(clip.blob);
  }
}

/**
 * Pre-unlock audio inside a user gesture. Chrome grants media playback to a page once it has received
 * a user activation; the silent, muted play() below is what surfaces the grant to the <audio> element.
 * In quiet hours even that muted play() is skipped: the activation itself is remembered by the
 * browser, so the morning's first real line still plays without another tap.
 */
async function unlockAudio() {
  state.audioUnlocked = true;
  if (!audioAllowed(Date.now(), state.zone)) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) {
      const ctx = new Ctx();
      const buffer = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      src.start(0);
      if (ctx.state === 'suspended') await ctx.resume();
      setTimeout(() => ctx.close().catch(() => {}), 500);
    }
    // Also unlock the <audio> element itself with a silent, muted WAV (no audible output).
    els.audio.src = silentWavDataUri();
    els.audio.muted = true;
    await els.audio.play();
    els.audio.pause();
    els.audio.muted = false;
    els.audio.currentTime = 0;
  } catch (err) {
    els.audio.muted = false;
    console.warn('[costboard] audio unlock failed:', err && err.name);
  }
}

/** A 44-byte-header, 8-sample, 8 kHz mono 16-bit PCM WAV of silence. */
function silentWavDataUri() {
  const samples = 8;
  const buf = new ArrayBuffer(44 + samples * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples * 2, true);
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return `data:audio/wav;base64,${btoa(bin)}`;
}
