// The Cost Board: wall-display dashboard page.
//
// Static, no framework, no build. Polls Supabase (or the mock server) every 60 s, recomputes the projection in the
// browser with engine.js (project, sinceInstall, sinceMonday), builds the flat binding model with view-model.js and
// writes it into the elements of index.html: textContent from `text`, data-tone from `tone`, hidden when `text` is
// null. app.js never creates text of its own; configuration and network errors go to the console, and status.error
// shows only data (the HTTP status code, or the platform's own fetch/JSON exception text; see errorDisplay).
//
// Kiosk deployment (Chrome on the TV box). Autoplay: Chrome only lets a page start audio after a user gesture
// unless it is launched with
//
//     chrome --kiosk --autoplay-policy=no-user-gesture-required "http://<host>/dashboard/?tv=tv1"
//
// Without that flag a voice line rejected by the autoplay policy is held; the next click or key press silently
// unlocks audio and plays the held line (nothing is shown on screen).
//
// ABSOLUTE RULE: audio never plays in [22:00, 07:00) local (Gaps.isQuietHours). The rule is enforced in
// decideVoice() before any request, again in playVoice() immediately before play(), and the silent unlock in
// unlockAudio() skips its muted play() in quiet hours too.

import {
  BINDINGS,
  POLL_INTERVAL_MS,
  POLL_QUERIES,
  WEEKLY_ROTATE_MS,
  audioAllowed,
  buildModel,
  decideVoice,
  deriveState,
  effectiveZone,
  errorDisplay,
  parseFlags,
  resolveApi,
  restHeaders,
  settingsMap,
  splitSentences,
} from './view-model.js';

// ---------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------
const flags = parseFlags(location.search, location.port);
const api = resolveApi(typeof window.COSTBOARD === 'object' ? window.COSTBOARD : null, flags, location.origin);
const browserZone = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; }
})();

/** name -> element, from every [data-bind] in the markup. */
const bound = new Map();
for (const el of document.querySelectorAll('[data-bind]')) bound.set(el.dataset.bind, el);
for (const name of BINDINGS) {
  if (!bound.has(name)) console.error(`[costboard] index.html has no element for binding "${name}"`);
}
const audio = document.querySelector('audio');
// Belt and braces for the ABSOLUTE RULE: a clip that is still sounding when 22:00 arrives is stopped at once.
for (const ev of ['play', 'playing', 'timeupdate']) {
  audio.addEventListener(ev, () => {
    if (!audio.paused && !audio.muted && !audioAllowed(Date.now(), state.zone)) audio.pause();
  });
}

const state = {
  entries: [],
  snapshots: [],
  settings: {},
  weekly: null,
  latestVoiceEvent: null,
  derived: null, // { zone, projection, sinceInstall, sinceMonday }
  status: { ok: true, error: null },
  zone: browserZone,
  weeklyIndex: 0,
  weeklyKey: null,
  voiceInFlight: false,
  voiceLastRequestAt: null,
  audioUnlocked: false,
  pendingClip: null, // { blob, fetchedAt } held back by the autoplay policy
  polling: false,
};

render();

if (!api.ok) {
  // The reason is our own wording, so it stays in the console; nothing is written to the screen.
  console.error('[costboard] configuration error:', api.reason);
  state.status = { ok: false, error: null };
  render();
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
  setInterval(rotateWeekly, WEEKLY_ROTATE_MS);
  poll();
  setInterval(poll, POLL_INTERVAL_MS);
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
    state.derived = deriveState({ entries, snapshots, settings: state.settings, flags, now, browserZone });
    state.zone = state.derived.zone;
    state.status = { ok: true, error: null };
    const weeklyKey = state.weekly ? state.weekly.week_start || state.weekly.id || null : null;
    if (weeklyKey !== state.weeklyKey) {
      state.weeklyKey = weeklyKey;
      state.weeklyIndex = 0;
    }
    render();
    await maybeSpeak(now);
  } catch (err) {
    // Keep the last good numbers on screen; only status.error changes.
    console.error('[costboard] poll failed:', err);
    state.status = { ok: false, error: errorDisplay(err) };
    state.zone = effectiveZone(flags, state.settings, browserZone);
    render();
  } finally {
    state.polling = false;
  }
}

/**
 * One REST GET. Errors carry `display` (see errorDisplay): the platform's own exception text for fetch/JSON
 * failures, the numeric HTTP status for a failed response, nothing for a wrong shape. `message` is console only.
 */
async function getRows(query) {
  const table = query.split('?')[0];
  let res;
  let body;
  try {
    res = await fetch(`${api.base}/rest/v1/${query}`, { headers: restHeaders(api.key), cache: 'no-store' });
  } catch (err) {
    throw platformError(err);
  }
  if (!res.ok) {
    const e = new Error(`${table}: HTTP ${res.status}`);
    e.display = String(res.status);
    throw e;
  }
  try {
    body = await res.json();
  } catch (err) {
    throw platformError(err);
  }
  if (!Array.isArray(body)) throw new Error(`${table}: unexpected response shape`);
  return body;
}

function platformError(err) {
  const e = err instanceof Error ? err : new Error(String(err));
  if (e.name && e.message) e.display = `${e.name}: ${e.message}`;
  return e;
}

// ---------------------------------------------------------------------------------------------
// Rendering: the model onto the bindings
// ---------------------------------------------------------------------------------------------
function render() {
  const d = state.derived;
  const model = buildModel({
    projection: d ? d.projection : null,
    sinceInstall: d ? d.sinceInstall : null,
    sinceMonday: d ? d.sinceMonday : null,
    weekly: state.weekly,
    weeklyIndex: state.weeklyIndex,
    status: state.status,
    flags,
  });
  for (const [name, el] of bound) {
    const v = model[name];
    if (!v || v.text == null) {
      if (el.textContent !== '') el.textContent = '';
      el.hidden = true;
      el.removeAttribute('data-tone');
      continue;
    }
    if (el.textContent !== v.text) el.textContent = v.text;
    el.hidden = false;
    if (v.tone) el.setAttribute('data-tone', v.tone);
    else el.removeAttribute('data-tone');
  }
}

function rotateWeekly() {
  if (!state.weekly || flags.kiosk) return;
  const n = splitSentences(state.weekly.summary).length;
  if (n < 2) return;
  state.weeklyIndex = (state.weeklyIndex + 1) % n;
  render();
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
    // The function inserted a voice_events row; mirror it locally so the next poll cannot double-fire before the
    // row is visible.
    state.latestVoiceEvent = { fired_at: body.fired_at || new Date(now).toISOString(), line: body.line || '', played_by: flags.tv };
    await playVoice(blob);
  } catch (err) {
    console.error('[costboard] voice-line failed:', err);
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
  audio.src = currentObjectUrl;
  try {
    await audio.play();
    state.audioUnlocked = true;
    state.pendingClip = null;
  } catch (err) {
    // Autoplay policy (NotAllowedError): hold the clip until the next click or key press. Nothing is shown.
    console.warn('[costboard] play() rejected, holding the clip for a user gesture:', err && err.name);
    state.audioUnlocked = false;
    state.pendingClip = { blob, fetchedAt: Date.now() };
  }
}

async function onUserGesture() {
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
 * Pre-unlock audio inside a user gesture. Chrome grants media playback to a page once it has received a user
 * activation; the silent, muted play() below surfaces the grant to the <audio> element. In quiet hours even that
 * muted play() is skipped: the activation itself is remembered, so the morning's first line still plays.
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
    // Also unlock the <audio> element itself with a silent, muted WAV (no audible output). The guard is re-checked
    // here because the awaits above could straddle 22:00.
    if (!audioAllowed(Date.now(), state.zone)) return;
    audio.src = silentWavDataUri();
    audio.muted = true;
    await audio.play();
    audio.pause();
    audio.muted = false;
    audio.currentTime = 0;
  } catch (err) {
    audio.muted = false;
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
