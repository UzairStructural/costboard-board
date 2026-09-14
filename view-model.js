// The Cost Board dashboard: pure view-model functions. No DOM, no network, no timers.
//
// buildModel(...) returns a flat object { <binding name>: { text, tone? } }. index.html carries one element per
// name (data-bind="<name>"); app.js copies `text` into textContent, `tone` into data-tone, and sets the hidden
// attribute when `text` is null. BINDINGS is the list of every name; BINDINGS.md documents each one.
//
// Tones: 'slipped' | 'closer' | 'unchanged' | 'never'. The style block in index.html maps them to colour tokens.
// Visible words are limited to data values (dates, money, signed days, NEVER), the engine's basis string,
// ACCRUAL_RULE_TEXT, the owner's labels (LABELS), the weekly_summaries row and errorDisplay() values.

import {
  Constants,
  GOALS,
  Gaps,
  fmtDate,
  fmtDelta,
  fmtMoney,
  formatDeltaDays,
  lastLogAt as engineLastLogAt,
  project,
  sinceInstall as engineSinceInstall,
  sinceMonday as engineSinceMonday,
} from './engine.js';

export const VOICE_EVENT_STALE_MS = 90 * 60 * 1000; // a voice_events row this old no longer blocks a new line
export const VOICE_MIN_INTERVAL_MS = 5 * 60 * 1000; // at most one voice-line request per 5 min per page
export const POLL_INTERVAL_MS = 60 * 1000;
export const WEEKLY_ROTATE_MS = 12 * 1000; // the weekly summary is shown one sentence at a time, this long each
export const MOCK_PORT = '8787';

// ---------------------------------------------------------------------------------------------
// Query flags
// ---------------------------------------------------------------------------------------------
/**
 * Parse the page's query string into flags.
 *   ?kiosk=1        numbers and their labels only (hides the accrual rule, the weekly summary and status.error)
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
 *   otherwise  -> window.COSTBOARD from config.js (must have a non-blank http(s) URL and a key)
 * Returns { ok, base, key, reason }. `reason` is for the console only; it is our own wording, so it never reaches
 * the screen (status.error shows only errorDisplay() values).
 */
export function resolveApi(config, flags, origin = '') {
  if (flags && flags.mock) {
    return { ok: true, base: stripSlash(origin), key: (config && config.SUPABASE_ANON_KEY) || 'mock', reason: null };
  }
  if (!config || typeof config !== 'object') {
    return { ok: false, base: null, key: null, reason: 'config.js: window.COSTBOARD is not defined' };
  }
  const base = String(config.SUPABASE_URL || '').trim();
  const key = String(config.SUPABASE_ANON_KEY || '').trim();
  if (!base || !key) {
    return { ok: false, base: null, key: null, reason: 'config.js: SUPABASE_URL or SUPABASE_ANON_KEY is blank' };
  }
  if (!/^https?:\/\//i.test(base)) {
    return { ok: false, base: null, key: null, reason: 'config.js: SUPABASE_URL is not an http(s) URL' };
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

/**
 * What status.error may show for a failed poll. Only values that are data, never our own wording:
 *   err.display, set by app.js to the HTTP status code of a failed response ("503") or to the platform's own
 *   exception text from fetch() / res.json() ("TypeError: Failed to fetch").
 * Anything else (configuration errors, unexpected shapes, engine exceptions) returns null: console only.
 */
export function errorDisplay(err) {
  return err && typeof err.display === 'string' && err.display !== '' ? err.display : null;
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

/** settings.tracking_start when it is a YYYY-MM-DD string, else null (project() then chooses its own anchor). */
export function effectiveTrackingStart(settings) {
  const v = settings && settings.tracking_start;
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

// ---------------------------------------------------------------------------------------------
// Engine state for one poll
// ---------------------------------------------------------------------------------------------
/**
 * Everything the page derives from one poll, using the engine API exactly:
 *   projection   = project(entries, now, zone, settings.tracking_start)
 *   sinceInstall = sinceInstall(projection, zone)
 *   sinceMonday  = sinceMonday(projection, snapshots, zone)
 */
export function deriveState({ entries, snapshots, settings, flags, now, browserZone }) {
  const zone = effectiveZone(flags, settings, browserZone);
  const projection = project(Array.isArray(entries) ? entries : [], now, zone, effectiveTrackingStart(settings));
  return {
    zone,
    projection,
    sinceInstall: engineSinceInstall(projection, zone),
    sinceMonday: engineSinceMonday(projection, Array.isArray(snapshots) ? snapshots : [], zone),
  };
}

// ---------------------------------------------------------------------------------------------
// Tones
// ---------------------------------------------------------------------------------------------
export const TONES = Object.freeze(['slipped', 'closer', 'unchanged', 'never']);

/** Tone of a signed day count: > 0 slipped, < 0 closer, 0 / null unchanged; `never` wins. */
export function daysTone(days, never = false, back = false) {
  if (never) return 'never';
  if (back) return 'closer';
  if (days == null || days === 0) return 'unchanged';
  return days > 0 ? 'slipped' : 'closer';
}

/** Tone of an engine DateDelta ({ days, toNever, fromNever }). */
export function driftTone(delta) {
  if (!delta) return 'unchanged';
  return daysTone(delta.days, !!delta.toNever, !!delta.fromNever);
}

// ---------------------------------------------------------------------------------------------
// Labels and binding names
// ---------------------------------------------------------------------------------------------
/** The owner's words, and nothing else. */
export const LABELS = Object.freeze({
  brother: "Brother's tuition",
  india_house: 'House in India',
  marriage: 'Marriage',
  us_house: 'House in US',
  partner: "Partner's tuition",
  nclc7: 'NCLC 7',
  landing: 'Canada landing',
  frenchTotal: 'of 1,000 h',
  year30: 'Year-30 north star',
});

/** The four goals in engine order, then the partner's tuition. */
export const GOAL_KEYS = Object.freeze([...GOALS.map((g) => g.key), Constants.PLAN_KEY_PARTNER]);

/** Every binding name, in page order. */
export const BINDINGS = Object.freeze([
  'cost.cumulative',
  'cost.accrualRule',
  ...GOAL_KEYS.flatMap((k) => [
    `label.${k}`,
    `goal.${k}.projected`,
    `goal.${k}.plan`,
    `goal.${k}.driftPlan`,
    `goal.${k}.driftMonday`,
  ]),
  'drift.sinceInstall',
  'french.banked',
  'label.frenchTotal',
  'label.nclc7',
  'french.nclc7',
  'label.landing',
  'french.landing',
  'french.basis',
  'weekly.summary',
  'label.year30',
  'footer.year30',
  'status.error',
]);

// ---------------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------------
/** 33 -> "33", 1.5 -> "1.5", 13.98 -> "14". */
export function fmtHours(h) {
  const n = Number(h) || 0;
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, '');
}

/** Split the weekly summary into its sentences (defensive: the row is free text). */
export function splitSentences(text) {
  if (typeof text !== 'string') return [];
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The sentence at rotation step `index` (wraps); null when there is none. */
export function weeklySentence(sentences, index) {
  if (!Array.isArray(sentences) || !sentences.length) return null;
  const n = sentences.length;
  const i = ((Math.trunc(Number(index) || 0) % n) + n) % n;
  return sentences[i];
}

// ---------------------------------------------------------------------------------------------
// Render model
// ---------------------------------------------------------------------------------------------
const value = (text, tone) => (tone === undefined ? { text } : { text, tone });
const hidden = () => ({ text: null });

/**
 * Build the flat render model.
 *   projection   : engine project(...) result, or null before the first successful poll
 *   sinceInstall : engine sinceInstall(projection, zone)
 *   sinceMonday  : engine sinceMonday(projection, snapshots, zone)
 *   weekly       : latest weekly_summaries row or null
 *   weeklyIndex  : which sentence of the weekly summary is on screen
 *   status       : { ok, error }
 *   flags        : parseFlags(...)
 * Returns { name: { text, tone? } } with exactly the keys in BINDINGS. `text: null` means hidden.
 */
export function buildModel({ projection = null, sinceInstall = null, sinceMonday = null, weekly = null, weeklyIndex = 0, status = null, flags = null } = {}) {
  const kiosk = !!(flags && flags.kiosk);
  const out = {};
  for (const name of BINDINGS) out[name] = hidden();

  const error = status && !status.ok && status.error ? String(status.error) : null;
  out['status.error'] = value(kiosk ? null : error);

  if (!projection) return out;
  const p = projection;

  out['cost.cumulative'] = value(fmtMoney(p.cumulativeLoss));
  out['cost.accrualRule'] = value(kiosk ? null : Constants.ACCRUAL_RULE_TEXT);

  const mondayByKey = new Map((sinceMonday ? sinceMonday.goals : []).map((d) => [d.key, d]));
  for (const key of GOAL_KEYS) {
    const isPartner = key === Constants.PLAN_KEY_PARTNER;
    const g = isPartner ? null : p.goals.find((x) => x.key === key);
    const projected = isPartner ? p.partnerTuitionPaidOff : g ? g.fundedOn : null;
    const planDate = isPartner ? p.partnerTuitionPlanDate : g ? g.planDate : null;
    const planDeltaDays = isPartner ? p.partnerTuitionPlanDeltaDays : g ? g.planDeltaDays : null;
    const monday = isPartner ? (sinceMonday ? sinceMonday.partner : null) : mondayByKey.get(key) || null;
    const never = projected == null;

    out[`label.${key}`] = value(LABELS[key]);
    out[`goal.${key}.projected`] = never ? value(fmtDate(null), 'never') : value(fmtDate(projected));
    out[`goal.${key}.plan`] = value(planDate == null ? null : fmtDate(planDate));
    out[`goal.${key}.driftPlan`] = value(formatDeltaDays(never ? null : planDeltaDays, never, false), daysTone(never ? null : planDeltaDays, never));
    out[`goal.${key}.driftMonday`] = value(mondayDriftText(monday), driftTone(monday));
  }

  if (sinceInstall) {
    const never = !!sinceInstall.headlineNever;
    out['drift.sinceInstall'] = value(formatDeltaDays(never ? null : sinceInstall.aggregateDays, never, false), daysTone(sinceInstall.aggregateDays, never));
  }

  out['french.banked'] = value(fmtHours(p.frenchHoursBanked));
  out['label.frenchTotal'] = value(LABELS.frenchTotal);
  out['label.nclc7'] = value(LABELS.nclc7);
  out['french.nclc7'] = value(fmtDate(p.projectedNclc7), dateTone(p.projectedNclc7, sinceMonday ? sinceMonday.nclc7 : null));
  out['label.landing'] = value(LABELS.landing);
  out['french.landing'] = value(fmtDate(p.projectedLanding), dateTone(p.projectedLanding, sinceMonday ? sinceMonday.landing : null));
  out['french.basis'] = value(p.frenchBasisLabel || null);

  const sentences = weekly ? splitSentences(weekly.summary) : [];
  out['weekly.summary'] = value(kiosk ? null : weeklySentence(sentences, weeklyIndex));

  out['label.year30'] = value(LABELS.year30);
  out['footer.year30'] = value(fmtMoney(p.year30Loss));
  return out;
}

/**
 * Drift-since-Monday text. The engine's formatDeltaDays says "back" when a date returns from NEVER; that word is not
 * in the owner's copy, so such a delta (and a missing one) is hidden instead.
 */
export function mondayDriftText(delta) {
  if (!delta || delta.fromNever) return null;
  return fmtDelta(delta);
}

/** NCLC 7 and landing dates: NEVER is 'never'; otherwise the tone of their drift since Monday. */
function dateTone(iso, mondayDelta) {
  if (iso == null) return 'never';
  return driftTone(mondayDelta);
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

/** The single named guard for audio: false in quiet hours [22:00, 07:00) local. */
export function audioAllowed(now, zone) {
  return !Gaps.isQuietHours(now, zone);
}
