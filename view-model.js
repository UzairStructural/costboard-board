// The Cost Board dashboard: pure view-model functions. No DOM, no network, no timers.
//
// Everything the page renders is derived here from (projection, deltas, rows, flags, now) so that it
// can be unit-tested with `node --test dashboard/view-model.test.mjs`. app.js only maps this model
// onto element ids.

import { Constants, Gaps, GOALS, fmtDate, fmtMoney, lastLogAt as engineLastLogAt, zoned } from './engine.js';

export const VOICE_EVENT_STALE_MS = 90 * 60 * 1000; // a voice_events row this old no longer blocks a new line
export const VOICE_MIN_INTERVAL_MS = 5 * 60 * 1000; // never more than one voice-line request per 5 min per page
export const POLL_INTERVAL_MS = 60 * 1000;
export const WEEKLY_ROTATE_MS = 12 * 1000; // the weekly summary shows one sentence at a time, this long each
export const MOCK_PORT = '8787';

// ---------------------------------------------------------------------------------------------
// Query flags
// ---------------------------------------------------------------------------------------------
/**
 * Parse the page's query string into flags.
 *   ?kiosk=1        numbers and labels only (hides captions, weekly summary, footer status/updated)
 *   ?tv=tv1|tv2     identity of this TV for voice dedupe (default "tv")
 *   ?voice=0        mute this TV
 *   ?zone=<IANA>    override settings.zone
 *   ?mock=1         API base = same origin (mock server); also implied when the port is 8787
 */
export function parseFlags(search = '', port = '') {
  const q = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const truthy = (v) => v != null && v !== '' && v !== '0' && v.toLowerCase() !== 'false' && v.toLowerCase() !== 'no';
  const tvRaw = (q.get('tv') || '').trim();
  const tv = /^[a-z0-9_-]{1,32}$/i.test(tvRaw) ? tvRaw : 'tv';
  const zoneRaw = (q.get('zone') || '').trim();
  return {
    kiosk: truthy(q.get('kiosk')),
    tv,
    voice: q.has('voice') ? truthy(q.get('voice')) : true,
    zone: isValidZone(zoneRaw) ? zoneRaw : null,
    mock: truthy(q.get('mock')) || String(port) === MOCK_PORT,
  };
}

export function isValidZone(zone) {
  if (!zone || typeof zone !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Configuration / API base
// ---------------------------------------------------------------------------------------------
/**
 * Decide where the REST + function calls go.
 *   mock flag  -> the page's own origin, key "mock"
 *   otherwise  -> window.COSTBOARD from config.js (must have a non-blank URL and key)
 * Returns { ok, base, key, reason }.
 */
export function resolveApi(config, flags, origin = '') {
  if (flags && flags.mock) {
    return { ok: true, base: stripSlash(origin), key: (config && config.SUPABASE_ANON_KEY) || 'mock', reason: null };
  }
  if (!config || typeof config !== 'object') {
    return { ok: false, base: null, key: null, reason: 'config.js is missing. Copy config.example.js to config.js and fill in SUPABASE_URL and SUPABASE_ANON_KEY.' };
  }
  const base = String(config.SUPABASE_URL || '').trim();
  const key = String(config.SUPABASE_ANON_KEY || '').trim();
  if (!base || !key) {
    return { ok: false, base: null, key: null, reason: 'config.js is blank. Fill in SUPABASE_URL and SUPABASE_ANON_KEY.' };
  }
  if (!/^https?:\/\//i.test(base)) {
    return { ok: false, base: null, key: null, reason: 'SUPABASE_URL in config.js must start with http:// or https://.' };
  }
  return { ok: true, base: stripSlash(base), key, reason: null };
}

function stripSlash(s) {
  return String(s || '').replace(/\/+$/, '');
}

export function restHeaders(key) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };
}

/** The five GET calls of one poll, relative to `<base>/rest/v1/`. */
export const POLL_QUERIES = Object.freeze({
  entries: 'log_entries?select=*&order=logged_at.desc',
  snapshots: 'snapshots?select=*&order=taken_at.desc&limit=120',
  settings: 'settings?select=*',
  weekly: 'weekly_summaries?select=*&order=week_start.desc&limit=1',
  voiceEvents: 'voice_events?select=*&order=fired_at.desc&limit=1',
});

// ---------------------------------------------------------------------------------------------
// Settings rows -> object
// ---------------------------------------------------------------------------------------------
/** `[{key, value}]` (value is jsonb, already parsed by PostgREST) -> `{ zone, tracking_start, voice_enabled, ... }`. */
export function settingsMap(rows) {
  const out = {};
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    if (!r || typeof r.key !== 'string') continue;
    let v = r.value;
    if (typeof v === 'string') {
      const t = v.trim();
      if ((t.startsWith('"') && t.endsWith('"')) || t === 'true' || t === 'false' || t === 'null') {
        try { v = JSON.parse(t); } catch { /* keep the raw string */ }
      }
    }
    out[r.key] = v;
  }
  return out;
}

/** Effective zone: ?zone= override, else settings.zone, else the browser's zone, else UTC. */
export function effectiveZone(flags, settings, browserZone) {
  if (flags && isValidZone(flags.zone)) return flags.zone;
  if (settings && isValidZone(settings.zone)) return settings.zone;
  if (isValidZone(browserZone)) return browserZone;
  return 'UTC';
}

/** Effective tracking start: settings.tracking_start when it is a YYYY-MM-DD string, else null (engine falls back to the first log). */
export function effectiveTrackingStart(settings) {
  const v = settings && settings.tracking_start;
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

// ---------------------------------------------------------------------------------------------
// Deltas -> colour language
// ---------------------------------------------------------------------------------------------
/**
 * One goal/date delta (from engine.compare) -> what the page shows next to the date.
 *   tone: 'red' (slipped / NEVER), 'green' (closer / back from NEVER), 'muted' (no change / no baseline)
 *   arrow: '▲' later, '▼' earlier, '' otherwise
 */
export function deltaView(delta) {
  if (!delta) return { text: '', arrow: '', tone: 'muted', label: 'no baseline' };
  if (delta.toNever) return { text: 'NEVER', arrow: '', tone: 'red', label: 'now never' };
  if (delta.fromNever) return { text: 'back from NEVER', arrow: '▼', tone: 'green', label: 'back from never' };
  if (delta.days == null) return { text: '', arrow: '', tone: 'muted', label: 'no baseline' };
  if (delta.days === 0) return { text: 'no change', arrow: '', tone: 'muted', label: 'no change' };
  const n = Math.abs(delta.days);
  const unit = n === 1 ? 'day' : 'days';
  if (delta.days > 0) return { text: `${n} ${unit}`, arrow: '▲', tone: 'red', label: `${n} ${unit} later than Monday` };
  return { text: `${n} ${unit}`, arrow: '▼', tone: 'green', label: `${n} ${unit} closer than Monday` };
}

/** Tone for a projected date on its own: NEVER is red, anything else neutral. */
export function dateTone(iso) {
  return iso == null ? 'red' : 'neutral';
}

/** Tone for the cumulative loss: red while any target hour is unpaid (landing has slipped), neutral at $0. */
export function lossTone(skippedHours) {
  return (Number(skippedHours) || 0) > 0 ? 'red' : 'neutral';
}

/** The sentence to show at rotation step `index` (wraps; empty string when there is none). */
export function weeklySentence(sentences, index) {
  if (!Array.isArray(sentences) || !sentences.length) return '';
  const n = sentences.length;
  const i = ((Math.trunc(Number(index) || 0) % n) + n) % n;
  return sentences[i];
}

// ---------------------------------------------------------------------------------------------
// Render model
// ---------------------------------------------------------------------------------------------
export function fmtHours(h) {
  const n = Number(h) || 0;
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, '');
}

export function fmtRate(r) {
  return `${(Number(r) || 0).toFixed(1)} h/day`;
}

export function fmtClock(ms, zone) {
  const z = zoned(ms, zone);
  return `${String(z.h).padStart(2, '0')}:${String(z.mi).padStart(2, '0')}`;
}

export function fmtSkipped(h) {
  const n = Number(h) || 0;
  const s = fmtHours(n);
  return `${s} French hour${n === 1 ? '' : 's'} skipped`;
}

/** Split the weekly summary into its sentences (defensive: the row is free text from Claude). */
export function splitSentences(text) {
  if (typeof text !== 'string') return [];
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Build the whole render model.
 *   projection : engine.project(...)
 *   deltas     : engine.compare(projection, baseline)
 *   weekly     : latest weekly_summaries row or null
 *   status     : { ok: boolean, error: string|null, updatedAt: ms|null }
 *   flags      : parseFlags(...)
 *   now        : ms
 */
export function buildModel({ projection, deltas, weekly, status, flags, now }) {
  const zone = projection.zone;
  // engine.compare(p, null) marks every date "fromNever"; without a Monday baseline there is nothing
  // to compare against, so every delta renders muted instead.
  const hasBaseline = !!(deltas && deltas.hasBaseline);
  const goalsByKey = new Map((hasBaseline ? deltas.goals : []).map((g) => [g.key, g]));
  const goals = GOALS.map((g) => {
    const p = projection.goals.find((x) => x.key === g.key) || { fundedOn: null };
    const d = goalsByKey.get(g.key) || null;
    return {
      key: g.key,
      label: g.label,
      date: fmtDate(p.fundedOn),
      dateTone: dateTone(p.fundedOn),
      delta: deltaView(d),
    };
  });
  const partner = {
    key: 'partner_tuition',
    label: "Partner's tuition",
    date: fmtDate(projection.partnerTuitionPaidOff),
    dateTone: 'muted',
  };
  const nclc7 = {
    label: 'NCLC 7',
    date: fmtDate(projection.projectedNclc7),
    dateTone: dateTone(projection.projectedNclc7),
    delta: deltaView(hasBaseline ? deltas.nclc7 : null),
  };
  const landing = {
    label: 'Canada landing',
    date: fmtDate(projection.projectedLanding),
    dateTone: dateTone(projection.projectedLanding),
    delta: deltaView(hasBaseline ? deltas.landing : null),
  };
  const sentences = weekly ? splitSentences(weekly.summary) : [];
  const kiosk = !!(flags && flags.kiosk);
  return {
    kiosk,
    loss: {
      figure: fmtMoney(projection.cumulativeLoss),
      tone: lossTone(projection.skippedFrenchHours),
      since: projection.trackingStart ? `since ${fmtDate(projection.trackingStart)}` : 'no tracking start yet',
      skipped: fmtSkipped(projection.skippedFrenchHours),
      showCaptions: !kiosk,
    },
    goals,
    partner,
    french: {
      banked: `${fmtHours(projection.frenchHoursBanked)} of ${Constants.TOTAL_FRENCH_HOURS_NEEDED.toLocaleString('en-US')} h`,
      rate: `${fmtRate(projection.frenchTrailingDailyRate)} (7-day)`,
      nclc7,
      landing,
    },
    weekly: {
      show: !kiosk && sentences.length > 0,
      sentences,
    },
    footer: {
      year30: `Year-30 north star: ${fmtMoney(projection.year30Loss)}`,
      showUpdated: !kiosk,
      updated: status && status.updatedAt != null ? `updated ${fmtClock(status.updatedAt, zone)}` : 'waiting for first update',
      ok: !!(status && status.ok),
      error: status && !status.ok && status.error ? String(status.error) : '',
      showError: !kiosk && !!(status && !status.ok && status.error),
    },
    headline: {
      never: hasBaseline && !!deltas.headlineNever,
      days: hasBaseline ? deltas.headlineDays : null,
    },
    now,
    zone,
  };
}

// ---------------------------------------------------------------------------------------------
// Voice decision
// ---------------------------------------------------------------------------------------------
/**
 * Should this poll ask the voice-line function for a line? Every clause is required.
 * Returns { fire: boolean, reason: string } so the decision is inspectable in tests and the console.
 *
 *   flags.voice                 this TV is not muted (?voice=0)
 *   settings.voice_enabled      master switch (missing = enabled)
 *   !isQuietHours(now, zone)    ABSOLUTE: nothing between 22:00 and 07:00 local
 *   shouldEscalate(lastLog)     >= 180 waking minutes since the last log
 *   latest voice_event          none, or older than the last log, or >= 90 min old
 *   client guard                no request in flight and >= 5 min since the last request from this page
 */
export function decideVoice({ flags, settings, now, zone, entries, latestVoiceEvent, lastRequestAt, inFlight }) {
  if (!flags || !flags.voice) return { fire: false, reason: 'muted by ?voice=0' };
  if (settings && settings.voice_enabled === false) return { fire: false, reason: 'settings.voice_enabled is false' };
  if (Gaps.isQuietHours(now, zone)) return { fire: false, reason: 'quiet hours' };
  const lastLog = lastLogMs(entries);
  if (lastLog == null) return { fire: false, reason: 'no logs yet' };
  if (!Gaps.shouldEscalate(lastLog, now, zone)) return { fire: false, reason: 'gap below escalation threshold' };
  if (latestVoiceEvent && latestVoiceEvent.fired_at) {
    const firedAt = Date.parse(latestVoiceEvent.fired_at);
    if (!Number.isNaN(firedAt)) {
      const newerThanLog = firedAt >= lastLog;
      const stale = now - firedAt >= VOICE_EVENT_STALE_MS;
      if (newerThanLog && !stale) return { fire: false, reason: 'a voice line already covers this gap' };
    }
  }
  if (inFlight) return { fire: false, reason: 'request in flight' };
  if (lastRequestAt != null && now - lastRequestAt < VOICE_MIN_INTERVAL_MS) return { fire: false, reason: 'rate limited (5 min)' };
  return { fire: true, reason: 'escalate' };
}

/** Latest logged_at in ms from raw PostgREST rows (or engine-normalised entries). */
export function lastLogMs(entries) {
  if (!Array.isArray(entries) || !entries.length) return null;
  const norm = entries
    .map((e) => ({ loggedAt: Date.parse(e.logged_at ?? e.loggedAt) }))
    .filter((e) => !Number.isNaN(e.loggedAt));
  return norm.length ? engineLastLogAt(norm) : null;
}

/** The single place that says whether audio may play right now. Mirrors Gaps.isQuietHours; kept separate so the page has one named guard. */
export function audioAllowed(now, zone) {
  return !Gaps.isQuietHours(now, zone);
}
