// The Cost Board projection engine, JavaScript port.
//
// A line-for-line port of costboard/engine (Kotlin), the reference implementation. It runs in the TV page (browser)
// and in the Supabase edge functions (Deno). Parity is enforced by dashboard/engine.test.mjs against
// shared/golden.json, which the Kotlin test suite generates. Change a number here only together with Constants.kt,
// then regenerate. The projection returns numbers and dates; presentation helpers at the bottom are separate.
//
// Dates: LocalDate values are ISO strings "YYYY-MM-DD". Instants are epoch milliseconds (or anything Date.parse
// accepts, e.g. the "+00:00" timestamps PostgREST returns). Zones are IANA names.

export const Constants = Object.freeze({
  MODEL_VERSION: '2026-09-14',

  TOTAL_FRENCH_HOURS_NEEDED: 1000.0,
  DAILY_FRENCH_TARGET: 3.0,
  POST_EXAM_LAG_DAYS: 120,
  TRAILING_WINDOW_DAYS: 7,
  DOORDASH_PACE_WINDOW_DAYS: 28,
  DOORDASH_SEED_HOURS_PER_WEEK_PHASE1: 45.0,
  DOORDASH_SEED_HOURS_PER_WEEK_PHASE2: 80.0,

  JOB_SAVINGS_INITIAL: 3000.0,
  JOB_SAVINGS_RAISED: 4000.0,
  JOB_SAVINGS_RAISE_MONTH: 6,
  DOORDASH_RATE_US: 18.0,

  DOORDASH_RATE_CA: 12.41, // CAD 20/hr gross, -15% vehicle, x 0.73 FX (owner's estimate, unverified)
  BUSINESS_TAKE_HOME: 0.55,
  LIVING_COSTS_CA: 2200.0,
  DOORDASH_STOP_RUN_RATE: 100000.0, // a TARGET rule; not applied to the projected pace (see Constants.kt)
  DOORDASH_STOP_IN_PROJECTION: false,

  RUN_RATE_M0: 30000.0,
  RUN_RATE_M12: 85000.0,
  RUN_RATE_M24: 175000.0,
  RUN_RATE_M36: 300000.0,
  RUN_RATE_M48: 500000.0,

  PARTNER_TUITION_DEBIT: 10000.0,
  PARTNER_TUITION_TOTAL: 50000.0,
  PARTNER_TUITION_INTERVAL_MONTHS: 6,
  INDIA_HOUSE_EMI: 567.0,
  INDIA_HOUSE_EMI_MONTHS: 240,
  INDIA_HOUSE_EMI_IN_PROJECTION: true,
  SIMULATION_HORIZON_MONTHS: 600,
  PLAN_KEY_PARTNER: 'partner',

  // Skipping a French hour at 3 hr/day pushes the landing date later, shifting a 30-year business
  // curve right. NPV of that profit stream at 8 % is ~$14.6M; annual carrying cost / 365 / 3 ~= $1,600/hr.
  // Accrual: at 23:59 local each day, max(0, 3.0 - hoursLoggedThatDay) x 1601 is added; never repaid.
  COST_PER_SKIPPED_FRENCH_HOUR: 1601.0, // primary, displayed
  YEAR_30_NET_WORTH_PER_HOUR: 42721.0, // north star, small text only
  ACCRUAL_RULE_TEXT: 'accrues $1,601 per hour under target · closes at 23:59',

  WAKING_START_HOUR: 7,
  WAKING_END_HOUR: 22,
  PROMPT_INTERVAL_MINUTES: 90,
  PROMPT_ACTION_HOURS: 1.0,
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
export const KEY_MODEL = 'model';

/** The owner's immovable plan, verbatim. "partner" is the partner's tuition final payment. */
export const PLAN_DATES = Object.freeze({
  brother: '2027-03-14',
  india_house: '2027-12-14',
  marriage: '2029-08-14',
  us_house: '2030-07-14',
  partner: '2029-03-14',
});

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
  /** ChronoUnit.MONTHS.between(a, b): whole months, truncated toward zero, like java.time. */
  monthsBetween(a, b) {
    const A = LDate.parse(a);
    const B = LDate.parse(b);
    let total = (B.y * 12 + B.m) - (A.y * 12 + A.m);
    const days = B.d - A.d;
    if (total > 0 && days < 0) total--;
    else if (total < 0 && days > 0) total++;
    return total;
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
// Rates and paces
// ---------------------------------------------------------------------------------------------
function normEntry(e) {
  return { loggedAt: toMs(e.loggedAt ?? e.logged_at), activity: e.activity, hours: Number(e.hours), note: e.note ?? null, id: e.id ?? null };
}

export function hoursInWindow(entries, activity, nowMs, windowDays) {
  const from = nowMs - windowDays * DAY_MS;
  let hours = 0;
  for (const e of entries) if (e.activity === activity && e.loggedAt > from) hours += e.hours;
  return hours;
}

export function trailingDailyRate(entries, activity, nowMs, windowDays = Constants.TRAILING_WINDOW_DAYS) {
  return hoursInWindow(entries, activity, nowMs, windowDays) / windowDays;
}

/** Complete days of data since the tracking start (today excluded), capped at the window. */
export function dataDays(trackingStartIso, todayIso, windowDays) {
  if (trackingStartIso == null) return 0;
  return Math.min(windowDays, Math.max(0, LDate.daysBetween(trackingStartIso, todayIso)));
}

/** Actual hours in the window plus the seed for every day of the window that has no data yet. */
export function pace(entries, activity, nowMs, trackingStartIso, todayIso, windowDays, seedHoursPerDay) {
  const d = dataDays(trackingStartIso, todayIso, windowDays);
  const actual = hoursInWindow(entries, activity, nowMs, windowDays);
  const hoursPerDay = (actual + (windowDays - d) * seedHoursPerDay) / windowDays;
  return {
    hoursPerDay,
    actualHoursInWindow: actual,
    dataDays: d,
    windowDays,
    seedHoursPerDay,
    isPureSeed: d === 0,
    isPureActual: d >= windowDays,
    actualHoursPerDay: d === 0 ? 0 : actual / d,
  };
}

export function frenchPace(entries, nowMs, trackingStartIso, todayIso) {
  return pace(entries, 'FRENCH', nowMs, trackingStartIso, todayIso, Constants.TRAILING_WINDOW_DAYS, Constants.DAILY_FRENCH_TARGET);
}

export function doordashPace(entries, nowMs, trackingStartIso, todayIso, seedHoursPerWeek) {
  return pace(entries, 'DOORDASH', nowMs, trackingStartIso, todayIso, Constants.DOORDASH_PACE_WINDOW_DAYS, seedHoursPerWeek / 7.0);
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

export function hoursByLocalDate(entries, activity, zone) {
  const out = new Map();
  for (const e of entries) {
    if (e.activity !== activity) continue;
    const d = localDate(e.loggedAt, zone);
    out.set(d, (out.get(d) || 0) + e.hours);
  }
  return out;
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

/** "at 3.0 h/day" on a pure seed, "at your pace (2.1 h/day)" once real data is blended in. */
export function frenchBasisLabel(p) {
  return p.isPureSeed ? `at ${Constants.DAILY_FRENCH_TARGET.toFixed(1)} h/day` : `at your pace (${p.hoursPerDay.toFixed(1)} h/day)`;
}

// ---------------------------------------------------------------------------------------------
// Cash flow: install-anchored, month by month, income credited at month end
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

/**
 * See CashFlow.simulate in the Kotlin engine. Options object:
 * { doordashPhase2HoursPerDay, today, actualDoordashHoursByDate (Map iso -> hours), startingPool, horizonMonths,
 *   emiEnabled, doordashStopsAtRunRate }.
 */
export function simulate(startIso, landingIso, doordashPhase1HoursPerDay, opts = {}) {
  const C = Constants;
  const p2 = opts.doordashPhase2HoursPerDay ?? doordashPhase1HoursPerDay;
  const todayIso = opts.today ?? startIso;
  const actual = opts.actualDoordashHoursByDate ?? new Map();
  const horizonMonths = opts.horizonMonths ?? C.SIMULATION_HORIZON_MONTHS;
  const emiEnabled = opts.emiEnabled ?? C.INDIA_HOUSE_EMI_IN_PROJECTION;
  const stops = opts.doordashStopsAtRunRate ?? C.DOORDASH_STOP_IN_PROJECTION;

  const fundedOn = GOALS.map(() => null);
  let nextGoal = 0;
  let pool = opts.startingPool ?? 0;
  let partnerPaid = 0;
  const debits = [];
  let emiFrom = null;
  let emiPaid = 0;
  const ledger = [];

  for (let i = 1; i <= horizonMonths; i++) {
    const mStart = LDate.plusMonths(startIso, i - 1);
    const mEnd = LDate.plusMonths(startIso, i);
    const days = LDate.daysBetween(mStart, mEnd);

    let partner = 0;
    if (i > 1 && (i - 1) % C.PARTNER_TUITION_INTERVAL_MONTHS === 0 && partnerPaid < C.PARTNER_TUITION_TOTAL) {
      partner = Math.min(C.PARTNER_TUITION_DEBIT, C.PARTNER_TUITION_TOTAL - partnerPaid);
      partnerPaid += partner;
      pool -= partner;
      debits.push(mStart);
    }
    const poolStart = pool;

    const pastDays = Math.min(days, Math.max(0, LDate.daysBetween(mStart, todayIso)));
    let actualHours = 0;
    if (pastDays > 0 && actual.size) {
      for (let k = 0; k < pastDays; k++) actualHours += actual.get(LDate.plusDays(mStart, k)) || 0;
    }
    const futureDays = days - pastDays;

    const landedBy = landingIso != null && !LDate.isAfter(landingIso, mStart) ? landingIso : null;
    let job = 0;
    let doordash;
    let business = 0;
    let living = 0;
    let runRate = 0;
    if (landedBy == null) {
      job = jobSavings(i);
      doordash = (actualHours + futureDays * doordashPhase1HoursPerDay) * C.DOORDASH_RATE_US;
    } else {
      runRate = businessRunRate(LDate.monthsBetween(landedBy, mStart));
      business = (runRate / 12.0) * C.BUSINESS_TAKE_HOME;
      living = -C.LIVING_COSTS_CA;
      doordash = stops && runRate >= C.DOORDASH_STOP_RUN_RATE ? 0 : (actualHours + futureDays * p2) * C.DOORDASH_RATE_CA;
    }
    let emi = 0;
    if (emiEnabled && emiFrom != null && !LDate.isBefore(mStart, emiFrom) && emiPaid < C.INDIA_HOUSE_EMI_MONTHS) {
      emi = -C.INDIA_HOUSE_EMI;
      emiPaid++;
    }
    const net = job + doordash + business + living + emi;

    pool = poolStart + net;
    const fundedNow = [];
    while (nextGoal < GOALS.length && pool + 1e-9 >= GOALS[nextGoal].amount) {
      const g = GOALS[nextGoal];
      pool -= g.amount;
      fundedOn[nextGoal] = mEnd;
      fundedNow.push(g.key);
      if (g.key === 'india_house') emiFrom = mEnd;
      nextGoal++;
    }

    ledger.push({
      index: i, start: mStart, end: mEnd, phase1Fraction: landedBy == null ? 1.0 : 0.0, businessRunRate: runRate,
      jobSavings: job, doordash, business, living, emi, partnerTuition: -partner,
      net, poolStart, poolEnd: pool, funded: fundedNow,
    });
    if (nextGoal === GOALS.length && partnerPaid >= C.PARTNER_TUITION_TOTAL) break;
  }
  const partnerTuitionPaidOff =
    debits.length && debits.length * C.PARTNER_TUITION_DEBIT >= C.PARTNER_TUITION_TOTAL ? debits[debits.length - 1] : null;
  return {
    goals: GOALS.map((g, idx) => ({
      key: g.key, label: g.label, amount: g.amount, fundedOn: fundedOn[idx],
      planDate: PLAN_DATES[g.key],
      planDeltaDays: fundedOn[idx] == null ? null : LDate.daysBetween(PLAN_DATES[g.key], fundedOn[idx]),
    })),
    partnerTuitionDebits: debits,
    partnerTuitionPaidOff,
    ledger,
  };
}

// ---------------------------------------------------------------------------------------------
// Loss: per-day accrual at 23:59, never repaid
// ---------------------------------------------------------------------------------------------
export function skippedFrenchHours(entries, trackingStartIso, todayIso, zone) {
  if (trackingStartIso == null) return 0;
  if (LDate.daysBetween(trackingStartIso, todayIso) <= 0) return 0;
  const byDay = hoursByLocalDate(entries, 'FRENCH', zone);
  let skipped = 0;
  let d = trackingStartIso;
  while (LDate.isBefore(d, todayIso)) {
    skipped += Math.max(0, Constants.DAILY_FRENCH_TARGET - (byDay.get(d) || 0));
    d = LDate.plusDays(d, 1);
  }
  return skipped;
}

// ---------------------------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------------------------
export function project(rawEntries, now, zone, trackingStartIso = null) {
  const C = Constants;
  const nowMs = toMs(now);
  const entries = rawEntries.map(normEntry);
  const today = localDate(nowMs, zone);
  const start = trackingStartIso ?? firstLogDate(entries, zone) ?? today;
  const banked = totalHours(entries, 'FRENCH');
  const fp = frenchPace(entries, nowMs, start, today);
  const remaining = remainingHours(banked);
  const nclc7 = projectedNclc7(today, remaining, fp.hoursPerDay);
  const landing = projectedLanding(nclc7);
  const dashP1 = doordashPace(entries, nowMs, start, today, C.DOORDASH_SEED_HOURS_PER_WEEK_PHASE1);
  const landed = landing != null && !LDate.isAfter(landing, today);
  const seed2 = C.DOORDASH_SEED_HOURS_PER_WEEK_PHASE2 / 7.0;
  const dashP2 = landed
    ? doordashPace(entries, nowMs, start, today, C.DOORDASH_SEED_HOURS_PER_WEEK_PHASE2)
    : { hoursPerDay: seed2, actualHoursInWindow: 0, dataDays: 0, windowDays: C.DOORDASH_PACE_WINDOW_DAYS, seedHoursPerDay: seed2, isPureSeed: true, isPureActual: false, actualHoursPerDay: 0 };
  const sim = simulate(start, landing, dashP1.hoursPerDay, {
    doordashPhase2HoursPerDay: dashP2.hoursPerDay,
    today,
    actualDoordashHoursByDate: hoursByLocalDate(entries, 'DOORDASH', zone),
  });
  const skipped = skippedFrenchHours(entries, start, today, zone);
  const todayFrench = hoursOn(entries, 'FRENCH', today, zone);
  const pending = Math.max(0, C.DAILY_FRENCH_TARGET - todayFrench);
  const remainingToday = Math.max(0, C.DAILY_FRENCH_TARGET - todayFrench);
  const wakingRemaining = Gaps.wakingHoursRemaining(nowMs, zone);
  const partnerPlanDate = PLAN_DATES[C.PLAN_KEY_PARTNER];
  return {
    today,
    computedAt: nowMs,
    zone,
    trackingStart: start,
    frenchHoursBanked: banked,
    frenchHoursRemaining: remaining,
    frenchPace: fp,
    doordashPace: dashP1,
    doordashPhase2Pace: dashP2,
    frenchTrailingDailyRate: fp.hoursPerDay,
    doordashTrailingDailyRate: dashP1.hoursPerDay,
    frenchBasisLabel: frenchBasisLabel(fp),
    todayFrenchHours: todayFrench,
    todayDoordashHours: hoursOn(entries, 'DOORDASH', today, zone),
    projectedNclc7: nclc7,
    projectedLanding: landing,
    goals: sim.goals,
    partnerTuitionDebits: sim.partnerTuitionDebits,
    partnerTuitionPaidOff: sim.partnerTuitionPaidOff,
    partnerTuitionPlanDate: partnerPlanDate,
    partnerTuitionPlanDeltaDays: sim.partnerTuitionPaidOff == null ? null : LDate.daysBetween(partnerPlanDate, sim.partnerTuitionPaidOff),
    skippedFrenchHours: skipped,
    cumulativeLoss: skipped * C.COST_PER_SKIPPED_FRENCH_HOUR,
    closingCumulativeLoss: (skipped + pending) * C.COST_PER_SKIPPED_FRENCH_HOUR,
    year30Loss: skipped * C.YEAR_30_NET_WORTH_PER_HOUR,
    todayPendingSkippedHours: pending,
    frenchTargetToday: C.DAILY_FRENCH_TARGET,
    frenchHoursRemainingToday: remainingToday,
    wakingHoursRemaining: wakingRemaining,
    dayIsUnrecoverable: remainingToday > wakingRemaining,
    lastLogAt: lastLogAt(entries),
    ledger: sim.ledger,
  };
}

/** `goal_dates` JSON exactly as the Kotlin engine writes it into `snapshots` (includes the model tag). */
export function snapshotGoalDates(p) {
  const out = {};
  for (const g of p.goals) out[g.key] = g.fundedOn;
  out[KEY_PARTNER] = p.partnerTuitionPaidOff;
  out[KEY_NCLC7] = p.projectedNclc7;
  out[KEY_LANDING] = p.projectedLanding;
  out[KEY_MODEL] = Constants.MODEL_VERSION;
  return out;
}

/** A full `snapshots` row (snake_case, as PostgREST expects). `closing` records the 23:59 close. */
export function toSnapshotRow(p, takenAtMs = p.computedAt, closing = false) {
  return {
    taken_at: new Date(takenAtMs).toISOString(),
    french_hours_banked: p.frenchHoursBanked,
    projected_landing: p.projectedLanding,
    goal_dates: snapshotGoalDates(p),
    cumulative_loss: closing ? p.closingCumulativeLoss : p.cumulativeLoss,
  };
}

// ---------------------------------------------------------------------------------------------
// Deltas and baselines (signed integers; presentation is the UI's job)
// ---------------------------------------------------------------------------------------------
function dateDelta(key, label, current, baseline) {
  const days = current != null && baseline != null ? LDate.daysBetween(baseline, current) : null;
  const toNever = current == null && baseline != null;
  const fromNever = current != null && baseline == null;
  return { key, label, current, baseline, days, toNever, fromNever, slipped: toNever || (days ?? 0) > 0, improved: fromNever || (days ?? 0) < 0 };
}

/** `baseline` is a `snapshots` row (snake_case). `kind` is 'INSTALL' or 'MONDAY'. */
export function compare(p, baseline, kind) {
  const gd = baseline.goal_dates ?? {};
  const goals = p.goals.map((g) => dateDelta(g.key, g.label, g.fundedOn, gd[g.key] ?? null));
  const partner = dateDelta(KEY_PARTNER, "Partner's tuition", p.partnerTuitionPaidOff, gd[KEY_PARTNER] ?? null);
  const nclc7 = dateDelta(KEY_NCLC7, 'NCLC 7', p.projectedNclc7, gd[KEY_NCLC7] ?? null);
  const landing = dateDelta(KEY_LANDING, 'Canada landing', p.projectedLanding, baseline.projected_landing ?? null);
  const ds = goals.map((g) => g.days).filter((d) => d != null);
  let aggregateDays = 0;
  if (ds.length) {
    const worst = Math.max(...ds);
    aggregateDays = worst > 0 ? worst : Math.min(...ds);
  }
  return {
    kind,
    baselineTakenAt: new Date(toMs(baseline.taken_at)).toISOString().replace('.000Z', 'Z'),
    goals,
    partner,
    nclc7,
    landing,
    headlineNever: goals.some((g) => g.toNever),
    aggregateDays,
  };
}

export function installInstantMs(installIso, zone) {
  return zonedToMs(installIso, 12, 0, zone);
}

/** The install baseline, recomputed from the current model (nothing logged, install day noon). Never missing. */
export function installSnapshotRow(installIso, zone) {
  const at = installInstantMs(installIso, zone);
  return toSnapshotRow(project([], at, zone, installIso), at);
}

/** The newest snapshot taken on a Monday (local), on/before today, not before `notBefore`, from the current model. */
export function lastMonday(snapshots, todayIso, zone, notBefore = null, model = Constants.MODEL_VERSION) {
  let best = null;
  for (const s of snapshots) {
    const d = localDate(toMs(s.taken_at), zone);
    if (LDate.dayOfWeek(d) !== 1 || LDate.isAfter(d, todayIso)) continue;
    if (notBefore != null && LDate.isBefore(d, notBefore)) continue;
    if (model != null && (s.goal_dates?.[KEY_MODEL] ?? null) !== model) continue;
    if (!best || toMs(s.taken_at) > toMs(best.taken_at)) best = s;
  }
  return best;
}

export function sinceInstall(p, zone) {
  return compare(p, installSnapshotRow(p.trackingStart, zone), 'INSTALL');
}

export function sinceMonday(p, snapshots, zone) {
  const monday = lastMonday(snapshots, p.today, zone, p.trackingStart);
  return monday ? compare(p, monday, 'MONDAY') : sinceInstall(p, zone);
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
  /** Hours between now and 22:00 local today, floored at 0 (whole minutes). */
  wakingHoursRemaining(ms, zone) {
    const end = zonedToMs(localDate(ms, zone), Constants.WAKING_END_HOUR, 0, zone);
    const minutes = Math.trunc((end - ms) / 60000);
    return Math.max(0, minutes) / 60;
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
// Presentation helpers (not used by the projection). Shared by the TV page and the voice line.
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

/** Signed days as "+4 d", "−2 d", "—"; "NEVER" / "back" when a date fell off or returned. */
export function formatDeltaDays(days, toNever = false, fromNever = false) {
  if (toNever) return 'NEVER';
  if (fromNever) return 'back';
  if (days == null || days === 0) return '—';
  return days > 0 ? `+${days} d` : `−${-days} d`;
}

export function fmtDelta(delta) {
  return formatDeltaDays(delta.days, delta.toNever, delta.fromNever);
}
