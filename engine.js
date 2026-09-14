// The Cost Board projection engine, JavaScript port.
//
// This is a line-for-line port of costboard/engine (Kotlin), which is the reference implementation.
// It runs in the dashboard page (browser) and in the Supabase edge functions (Deno). Parity with the
// Kotlin engine is enforced by dashboard/engine.test.mjs against shared/golden.json, which the Kotlin
// test suite generates. If you change a number here, change it in Constants.kt too, then regenerate.
//
// Dates: LocalDate values are ISO strings "YYYY-MM-DD". Instants are epoch milliseconds (or anything
// Date.parse accepts, e.g. the "+00:00" timestamps PostgREST returns). Zones are IANA names.

export const Constants = Object.freeze({
  TOTAL_FRENCH_HOURS_NEEDED: 1000.0,
  DAILY_FRENCH_TARGET: 3.0,
  POST_EXAM_LAG_DAYS: 120,
  TRAILING_WINDOW_DAYS: 7,

  JOB_SAVINGS_INITIAL: 3000.0,
  JOB_SAVINGS_RAISED: 4000.0,
  JOB_SAVINGS_RAISE_MONTH: 6,
  DOORDASH_RATE_US: 18.0,

  DOORDASH_RATE_CA: 12.41, // CAD 20/hr gross, -15% vehicle, x 0.73 FX (user estimate, unverified)
  BUSINESS_TAKE_HOME: 0.55,
  LIVING_COSTS_CA: 2200.0,
  DOORDASH_STOP_RUN_RATE: 100000.0,

  RUN_RATE_M0: 30000.0,
  RUN_RATE_M12: 85000.0,
  RUN_RATE_M24: 175000.0,
  RUN_RATE_M36: 300000.0,
  RUN_RATE_M48: 500000.0,
  DAYS_PER_MONTH: 30.4375,

  PARTNER_TUITION_DEBIT: 10000.0,
  PARTNER_TUITION_TOTAL: 50000.0,
  PARTNER_TUITION_INTERVAL_MONTHS: 6,
  INDIA_HOUSE_EMI: 567.0,
  INDIA_HOUSE_EMI_MONTHS: 240,
  SIMULATION_HORIZON_MONTHS: 600,

  // Skipping a French hour at 3 hr/day pushes the landing date later, shifting a 30-year business
  // curve right. NPV of that profit stream at 8 % is ~$14.6M; annual carrying cost / 365 / 3 ~= $1,600/hr.
  COST_PER_SKIPPED_FRENCH_HOUR: 1601.0, // primary, displayed
  YEAR_30_NET_WORTH_PER_HOUR: 42721.0, // north star, small text only

  WAKING_START_HOUR: 7,
  WAKING_END_HOUR: 22,
  PROMPT_INTERVAL_MINUTES: 90,
  ESCALATION_GAP_MINUTES: 180,
});

export const GOALS = Object.freeze([
  { key: 'brother', label: "Brother's tuition", amount: 35000.0 },
  { key: 'india_house', label: 'House in India', amount: 50000.0 },
  { key: 'marriage', label: 'Marriage', amount: 65000.0 },
  { key: 'us_house', label: 'House in US', amount: 80000.0 },
]);

export const KEY_PARTNER = 'partner_tuition';
export const KEY_NCLC7 = 'nclc7';
export const KEY_LANDING = 'landing';

const MAX_PROJECTION_DAYS = 3650000;
const DAY_MS = 86400000;

// ---------------------------------------------------------------------------------------------
// LocalDate helpers with java.time semantics.
// ---------------------------------------------------------------------------------------------
export const LDate = {
  parse(iso) {
    const m = /^(-?\d{4,9})-(\d{2})-(\d{2})$/.exec(iso);
    if (!m) throw new Error(`bad LocalDate: ${iso}`);
    return { y: +m[1], m: +m[2], d: +m[3] };
  },
  toISO({ y, m, d }) {
    const yy = y < 0 ? '-' + String(-y).padStart(4, '0') : String(y).padStart(4, '0');
    return `${yy}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  },
  toEpochDay(iso) {
    const { y, m, d } = LDate.parse(iso);
    const dt = new Date(0);
    dt.setUTCFullYear(y, m - 1, d);
    dt.setUTCHours(0, 0, 0, 0);
    return Math.round(dt.getTime() / DAY_MS);
  },
  fromEpochDay(n) {
    const dt = new Date(n * DAY_MS);
    return LDate.toISO({ y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() });
  },
  plusDays(iso, n) {
    return LDate.fromEpochDay(LDate.toEpochDay(iso) + n);
  },
  daysInMonth(y, m) {
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
  },
  /** java.time: the day-of-month is clamped to the last valid day of the resulting month. */
  plusMonths(iso, n) {
    const { y, m, d } = LDate.parse(iso);
    const total = y * 12 + (m - 1) + n;
    const ny = Math.floor(total / 12);
    const nm = total - ny * 12 + 1;
    return LDate.toISO({ y: ny, m: nm, d: Math.min(d, LDate.daysInMonth(ny, nm)) });
  },
  /** ChronoUnit.DAYS.between(a, b): b - a in whole days. */
  daysBetween(a, b) {
    return LDate.toEpochDay(b) - LDate.toEpochDay(a);
  },
  isBefore(a, b) {
    return LDate.toEpochDay(a) < LDate.toEpochDay(b);
  },
  isAfter(a, b) {
    return LDate.toEpochDay(a) > LDate.toEpochDay(b);
  },
  dayOfWeek(iso) {
    // 1 = Monday ... 7 = Sunday, like java.time.
    const js = new Date(LDate.toEpochDay(iso) * DAY_MS).getUTCDay();
    return js === 0 ? 7 : js;
  },
};

// ---------------------------------------------------------------------------------------------
// Zone helpers: instant <-> local wall time in an IANA zone.
// ---------------------------------------------------------------------------------------------
const dtfCache = new Map();
function dtf(zone) {
  let f = dtfCache.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    dtfCache.set(zone, f);
  }
  return f;
}

export function toMs(instant) {
  if (typeof instant === 'number') return instant;
  if (instant instanceof Date) return instant.getTime();
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) throw new Error(`bad instant: ${instant}`);
  return ms;
}

/** Local wall-clock fields of an instant in a zone. */
export function zoned(ms, zone) {
  const parts = dtf(zone).formatToParts(new Date(ms));
  const get = (t) => +parts.find((p) => p.type === t).value;
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour') % 24, mi: get('minute'), s: get('second') };
}

export function localDate(ms, zone) {
  const z = zoned(ms, zone);
  return LDate.toISO({ y: z.y, m: z.m, d: z.d });
}

function offsetMs(ms, zone) {
  const z = zoned(ms, zone);
  const asUtc = Date.UTC(z.y, z.m - 1, z.d, z.h, z.mi, z.s);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Instant (ms) for a local wall time in a zone. Handles DST by re-checking the offset. */
export function zonedToMs(iso, h, mi, zone) {
  const { y, m, d } = LDate.parse(iso);
  const wall = Date.UTC(y, m - 1, d, h, mi, 0);
  let guess = wall - offsetMs(wall, zone);
  const off2 = offsetMs(guess, zone);
  if (wall - off2 !== guess) guess = wall - off2;
  return guess;
}

// ---------------------------------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------------------------------
function normEntry(e) {
  return { loggedAt: toMs(e.loggedAt ?? e.logged_at), activity: e.activity, hours: Number(e.hours), note: e.note ?? null, id: e.id ?? null };
}

export function trailingDailyRate(entries, activity, nowMs, windowDays = Constants.TRAILING_WINDOW_DAYS) {
  const from = nowMs - windowDays * DAY_MS;
  let hours = 0;
  for (const e of entries) {
    if (e.activity === activity && e.loggedAt > from) hours += e.hours;
  }
  return hours / windowDays;
}

export function totalHours(entries, activity) {
  let t = 0;
  for (const e of entries) if (e.activity === activity) t += e.hours;
  return t;
}

export function hoursOn(entries, activity, iso, zone) {
  let t = 0;
  for (const e of entries) if (e.activity === activity && localDate(e.loggedAt, zone) === iso) t += e.hours;
  return t;
}

export function firstLogDate(entries, zone) {
  if (!entries.length) return null;
  let min = Infinity;
  for (const e of entries) if (e.loggedAt < min) min = e.loggedAt;
  return localDate(min, zone);
}

export function lastLogAt(entries) {
  if (!entries.length) return null;
  let max = -Infinity;
  for (const e of entries) if (e.loggedAt > max) max = e.loggedAt;
  return max;
}

// ---------------------------------------------------------------------------------------------
// French
// ---------------------------------------------------------------------------------------------
export function remainingHours(banked) {
  return Math.max(0, Constants.TOTAL_FRENCH_HOURS_NEEDED - banked);
}

export function projectedNclc7(todayIso, remaining, dailyRate) {
  if (remaining <= 0) return todayIso;
  if (dailyRate <= 0) return null; // NEVER
  return LDate.plusDays(todayIso, Math.min(MAX_PROJECTION_DAYS, Math.ceil(remaining / dailyRate)));
}

export function projectedLanding(nclc7Iso) {
  return nclc7Iso == null ? null : LDate.plusDays(nclc7Iso, Constants.POST_EXAM_LAG_DAYS);
}

// ---------------------------------------------------------------------------------------------
// Cash flow
// ---------------------------------------------------------------------------------------------
const lerp = (a, b, t) => a + (b - a) * t;

export function businessRunRate(t) {
  const C = Constants;
  if (t < 0) return 0;
  if (t < 12) return lerp(C.RUN_RATE_M0, C.RUN_RATE_M12, t / 12);
  if (t < 24) return lerp(C.RUN_RATE_M12, C.RUN_RATE_M24, (t - 12) / 12);
  if (t < 36) return lerp(C.RUN_RATE_M24, C.RUN_RATE_M36, (t - 24) / 12);
  if (t < 48) return lerp(C.RUN_RATE_M36, C.RUN_RATE_M48, (t - 36) / 12);
  return C.RUN_RATE_M48;
}

export function jobSavings(monthIndex) {
  return monthIndex < Constants.JOB_SAVINGS_RAISE_MONTH ? Constants.JOB_SAVINGS_INITIAL : Constants.JOB_SAVINGS_RAISED;
}

/** See CashFlow.simulate in the Kotlin engine for the full description of the month step. */
export function simulate(todayIso, landingIso, doordashHoursPerDay, startingPool = 0, horizonMonths = Constants.SIMULATION_HORIZON_MONTHS) {
  const C = Constants;
  const fundedOn = GOALS.map(() => null);
  let nextGoal = 0;
  let pool = startingPool;
  let partnerPaid = 0;
  const debits = [];
  let emiFrom = null;
  let emiPaid = 0;
  const ledger = [];

  for (let i = 1; i <= horizonMonths; i++) {
    const start = LDate.plusMonths(todayIso, i - 1);
    const end = LDate.plusMonths(todayIso, i);
    const days = LDate.daysBetween(start, end);

    let partner = 0;
    if (i > 1 && (i - 1) % C.PARTNER_TUITION_INTERVAL_MONTHS === 0 && partnerPaid < C.PARTNER_TUITION_TOTAL) {
      partner = Math.min(C.PARTNER_TUITION_DEBIT, C.PARTNER_TUITION_TOTAL - partnerPaid);
      partnerPaid += partner;
      pool -= partner;
      debits.push(start);
    }
    const poolStart = pool;

    let f1;
    if (landingIso == null || !LDate.isBefore(landingIso, end)) f1 = 1.0;
    else if (!LDate.isAfter(landingIso, start)) f1 = 0.0;
    else f1 = LDate.daysBetween(start, landingIso) / days;
    const f2 = 1.0 - f1;

    const job = jobSavings(i) * f1;
    const ddHours = doordashHoursPerDay * days;
    let doordash = ddHours * f1 * C.DOORDASH_RATE_US;
    let business = 0;
    let living = 0;
    let runRate = 0;
    if (f2 > 0 && landingIso != null) {
      const daysSinceLandingAtStart = LDate.daysBetween(landingIso, start);
      const p2StartOffset = days * f1;
      const p2MidOffset = p2StartOffset + (days - p2StartOffset) / 2.0;
      runRate = businessRunRate((daysSinceLandingAtStart + p2MidOffset) / C.DAYS_PER_MONTH);
      const runRateAtP2Start = businessRunRate((daysSinceLandingAtStart + p2StartOffset) / C.DAYS_PER_MONTH);
      business = (runRate / 12.0) * C.BUSINESS_TAKE_HOME * f2;
      living = -C.LIVING_COSTS_CA * f2;
      if (runRateAtP2Start < C.DOORDASH_STOP_RUN_RATE) doordash += ddHours * f2 * C.DOORDASH_RATE_CA;
    }
    let emi = 0;
    if (emiFrom != null && !LDate.isBefore(start, emiFrom) && emiPaid < C.INDIA_HOUSE_EMI_MONTHS) {
      emi = -C.INDIA_HOUSE_EMI;
      emiPaid++;
    }
    const net = job + doordash + business + living + emi;

    const fundedNow = [];
    let threshold = 0;
    while (nextGoal < GOALS.length) {
      const g = GOALS[nextGoal];
      threshold += g.amount;
      if (poolStart + net + 1e-9 < threshold) break;
      const f = net > 0 ? Math.min(1, Math.max(0, (threshold - poolStart) / net)) : 0;
      fundedOn[nextGoal] = LDate.plusDays(start, Math.round(f * days));
      fundedNow.push(g.key);
      if (g.key === 'india_house') emiFrom = end;
      nextGoal++;
    }
    let fundedAmount = 0;
    for (const k of fundedNow) fundedAmount += GOALS.find((g) => g.key === k).amount;
    pool = poolStart + net - fundedAmount;

    ledger.push({
      index: i, start, end, phase1Fraction: f1, businessRunRate: runRate,
      jobSavings: job, doordash, business, living, emi, partnerTuition: -partner,
      net, poolStart, poolEnd: pool, funded: fundedNow,
    });
    if (nextGoal === GOALS.length && partnerPaid >= C.PARTNER_TUITION_TOTAL) break;
  }
  const partnerTuitionPaidOff =
    debits.length && debits.length * C.PARTNER_TUITION_DEBIT >= C.PARTNER_TUITION_TOTAL ? debits[debits.length - 1] : null;
  return {
    goals: GOALS.map((g, idx) => ({ key: g.key, label: g.label, amount: g.amount, fundedOn: fundedOn[idx] })),
    partnerTuitionDebits: debits,
    partnerTuitionPaidOff,
    ledger,
  };
}

// ---------------------------------------------------------------------------------------------
// Loss
// ---------------------------------------------------------------------------------------------
export function skippedFrenchHours(trackingStartIso, todayIso, banked) {
  if (trackingStartIso == null) return 0;
  const completeDays = Math.max(0, LDate.daysBetween(trackingStartIso, todayIso));
  return Math.max(0, completeDays * Constants.DAILY_FRENCH_TARGET - banked);
}

// ---------------------------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------------------------
export function project(rawEntries, now, zone, trackingStartIso = null) {
  const nowMs = toMs(now);
  const entries = rawEntries.map(normEntry);
  const today = localDate(nowMs, zone);
  const banked = totalHours(entries, 'FRENCH');
  const frenchRate = trailingDailyRate(entries, 'FRENCH', nowMs);
  const doordashRate = trailingDailyRate(entries, 'DOORDASH', nowMs);
  const remaining = remainingHours(banked);
  const nclc7 = projectedNclc7(today, remaining, frenchRate);
  const landing = projectedLanding(nclc7);
  const sim = simulate(today, landing, doordashRate);
  const start = trackingStartIso ?? firstLogDate(entries, zone);
  const skipped = skippedFrenchHours(start, today, banked);
  return {
    today,
    computedAt: nowMs,
    zone,
    trackingStart: start,
    frenchHoursBanked: banked,
    frenchHoursRemaining: remaining,
    frenchTrailingDailyRate: frenchRate,
    doordashTrailingDailyRate: doordashRate,
    todayFrenchHours: hoursOn(entries, 'FRENCH', today, zone),
    todayDoordashHours: hoursOn(entries, 'DOORDASH', today, zone),
    projectedNclc7: nclc7,
    projectedLanding: landing,
    goals: sim.goals,
    partnerTuitionDebits: sim.partnerTuitionDebits,
    partnerTuitionPaidOff: sim.partnerTuitionPaidOff,
    skippedFrenchHours: skipped,
    cumulativeLoss: skipped * Constants.COST_PER_SKIPPED_FRENCH_HOUR,
    year30Loss: skipped * Constants.YEAR_30_NET_WORTH_PER_HOUR,
    lastLogAt: lastLogAt(entries),
    ledger: sim.ledger,
  };
}

/** `goal_dates` JSON exactly as the Kotlin engine writes it into `snapshots`. */
export function snapshotGoalDates(p) {
  const out = {};
  for (const g of p.goals) out[g.key] = g.fundedOn;
  out[KEY_PARTNER] = p.partnerTuitionPaidOff;
  out[KEY_NCLC7] = p.projectedNclc7;
  out[KEY_LANDING] = p.projectedLanding;
  return out;
}

/** A full `snapshots` row (snake_case, as PostgREST expects) for the projection. */
export function toSnapshotRow(p, takenAtMs = p.computedAt) {
  return {
    taken_at: new Date(takenAtMs).toISOString(),
    french_hours_banked: p.frenchHoursBanked,
    projected_landing: p.projectedLanding,
    goal_dates: snapshotGoalDates(p),
    cumulative_loss: p.cumulativeLoss,
  };
}

// ---------------------------------------------------------------------------------------------
// Deltas
// ---------------------------------------------------------------------------------------------
function dateDelta(key, label, current, baseline) {
  const days = current != null && baseline != null ? LDate.daysBetween(baseline, current) : null;
  const toNever = current == null && baseline != null;
  const fromNever = current != null && baseline == null;
  return {
    key, label, current, baseline, days, toNever, fromNever,
    slipped: toNever || (days ?? 0) > 0,
    improved: fromNever || (days ?? 0) < 0,
  };
}

/** `baseline` is a `snapshots` row (snake_case) or null. */
export function compare(p, baseline) {
  const gd = baseline?.goal_dates ?? {};
  const goals = p.goals.map((g) => dateDelta(g.key, g.label, g.fundedOn, gd[g.key] ?? null));
  const nclc7 = dateDelta(KEY_NCLC7, 'NCLC 7', p.projectedNclc7, gd[KEY_NCLC7] ?? null);
  const landing = dateDelta(KEY_LANDING, 'Canada landing', p.projectedLanding, baseline?.projected_landing ?? null);
  const hasBaseline = baseline != null;
  const headlineNever = goals.some((g) => g.toNever);
  let headlineDays = null;
  if (hasBaseline) {
    const ds = goals.map((g) => g.days).filter((d) => d != null);
    if (ds.length) {
      const worst = Math.max(...ds);
      headlineDays = worst > 0 ? worst : Math.min(...ds);
    }
  }
  return { baselineTakenAt: baseline?.taken_at ?? null, hasBaseline, goals, nclc7, landing, headlineNever, headlineDays };
}

export function lastMonday(snapshots, todayIso, zone) {
  let best = null;
  for (const s of snapshots) {
    const d = localDate(toMs(s.taken_at), zone);
    if (LDate.dayOfWeek(d) === 1 && !LDate.isAfter(d, todayIso)) {
      if (!best || toMs(s.taken_at) > toMs(best.taken_at)) best = s;
    }
  }
  return best;
}

export function lastWeek(snapshots, todayIso, zone) {
  const cutoff = LDate.plusDays(todayIso, -7);
  let best = null;
  let oldest = null;
  for (const s of snapshots) {
    const d = localDate(toMs(s.taken_at), zone);
    if (!LDate.isAfter(d, cutoff) && (!best || toMs(s.taken_at) > toMs(best.taken_at))) best = s;
    if (!oldest || toMs(s.taken_at) < toMs(oldest.taken_at)) oldest = s;
  }
  return best ?? oldest;
}

// ---------------------------------------------------------------------------------------------
// Gaps (waking-hours arithmetic; the audio guard lives here too)
// ---------------------------------------------------------------------------------------------
export const Gaps = {
  isWaking(ms, zone) {
    const h = zoned(ms, zone).h;
    return h >= Constants.WAKING_START_HOUR && h < Constants.WAKING_END_HOUR;
  },
  isQuietHours(ms, zone) {
    return !Gaps.isWaking(ms, zone);
  },
  nextWakingInstant(ms, zone) {
    if (Gaps.isWaking(ms, zone)) return ms;
    const d = localDate(ms, zone);
    const todayStart = zonedToMs(d, Constants.WAKING_START_HOUR, 0, zone);
    return ms < todayStart ? todayStart : zonedToMs(LDate.plusDays(d, 1), Constants.WAKING_START_HOUR, 0, zone);
  },
  wakingMinutesBetween(lastMs, nowMs, zone) {
    if (nowMs <= lastMs) return 0;
    let total = 0;
    let cursor = lastMs;
    while (cursor < nowMs) {
      const date = localDate(cursor, zone);
      const wakeStart = zonedToMs(date, Constants.WAKING_START_HOUR, 0, zone);
      const wakeEnd = zonedToMs(date, Constants.WAKING_END_HOUR, 0, zone);
      const segStart = Math.max(cursor, wakeStart);
      const segEnd = Math.min(nowMs, wakeEnd);
      if (segEnd > segStart) total += Math.floor((segEnd - segStart) / 60000);
      cursor = zonedToMs(LDate.plusDays(date, 1), 0, 0, zone);
    }
    return total;
  },
  shouldEscalate(lastMs, nowMs, zone) {
    if (!Gaps.isWaking(nowMs, zone)) return false;
    if (lastMs == null) return false;
    return Gaps.wakingMinutesBetween(lastMs, nowMs, zone) >= Constants.ESCALATION_GAP_MINUTES;
  },
};

// ---------------------------------------------------------------------------------------------
// Formatting helpers shared by the dashboard and the voice line.
// ---------------------------------------------------------------------------------------------
export function fmtMoney(x) {
  return '$' + Math.round(x).toLocaleString('en-US');
}

export function fmtDate(iso) {
  if (iso == null) return 'NEVER';
  const { y, m, d } = LDate.parse(iso);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d} ${months[m - 1]} ${y}`;
}

export function fmtDelta(delta) {
  if (delta.toNever) return 'NEVER';
  if (delta.fromNever) return 'back from NEVER';
  if (delta.days == null) return '';
  if (delta.days === 0) return 'no change';
  const n = Math.abs(delta.days);
  return `${delta.days > 0 ? '+' : '-'}${n} day${n === 1 ? '' : 's'}`;
}
