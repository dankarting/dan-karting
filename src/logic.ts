// Pure logic for the karting heat app. No React, no storage, no network.
// Everything here is testable with `npx tsx tests/logic.test.ts`.

export type Group = {
    id: string;
    name: string;
    size: number;
    ticket: string; // free label, configured in settings. No prices anywhere.
    keepTogether: boolean; // a proposed goal, not a venue rule
    note: string;
    createdAt: number;
    /** Participant names from the customer form, in the order entered. Absent for groups the cashier added by count. */
    names?: string[];
    /** Family: may share a heat with either kart class (fast and regular). Owner rule. */
    family?: boolean;
    /** Ticket per participant (same order as names), when chosen per person in the form. */
    tickets?: string[];
    /** Heat length this group paid for (10 / 20). Unset = the default in Settings. Groups of different lengths never share a heat. */
    minutes?: number;
};

/**
 * A customer's form submission: one group name + participant names. Nothing else is asked.
 * It waits at the cashier until staff confirm payment (simulated: no payment is processed here).
 */
export type Submission = { id: string; groupName: string; names: string[]; createdAt: number; status: 'pending' | 'paid' | 'cancelled'; groupId?: string; groupIds?: string[];
    /** Ticket per participant, same order as names (chosen by the customer in the form). */
    tickets?: string[];
    /** Heat length the customer chose (10 or 20). */
    minutes?: number };

export type Entry = { groupId: string; count: number };
export type HeatStatus = 'draft' | 'approved' | 'done';
export type DriverEdit = { name?: string; kart?: number };
export type Heat = { id: string; num: number; status: HeatStatus; entries: Entry[]; drivers?: Record<string, DriverEdit>; called?: boolean;
    /** Shift manager (אחמ"ש) approved mixing fast and regular karts for exactly these groups (sorted ids). Any change to the groups voids it. */
    mixOk?: string };
/** How karts get matched to drivers. Not decided by the venue yet, so 'unset' keeps an editable auto suggestion. */
export type KartMode = 'unset' | 'cashier' | 'staff';

export type Settings = {
    capacity: number; // configurable: the real limit is not confirmed (10 or 14 were both mentioned)
    laps: number; // legacy lap-limited runs only; heats are now timed (heatMinutes)
    /** Heat duration in minutes. 10 is the minimum (owner); 20 is the other common option. Default 10. */
    heatMinutes?: number;
    /** When the "current" heat history starts over: every night at 00:00 (day) or Saturday night -> Sunday 00:00 (week). The archive keeps everything. */
    histReset?: HistReset;
    tickets: string[];
    /** Ticket types that ride the FAST karts (owner: ליגה, מאסטר). They never share a heat with regular karts, unless family. */
    fastTickets?: string[];
    /** Price per ticket type in shekels. Set by the owner in Settings; unset = no price shown. Display only, nothing is charged. */
    prices?: Record<string, number>;
    /** Price per ticket type for a 20-minute heat. */
    prices20?: Record<string, number>;
    /** Ticket types where two participants share one kart and pay one price (זוגי). */
    pairTickets?: string[];
    kartMode?: KartMode;
    /** Optional kart number -> transponder id. Unset = synthetic ids. Real mapping not known yet. */
    transponders?: Record<string, string>;
};

/** The heat currently on track (simulated). Stored in Core so it survives tab changes and reloads. */
/** durationMs set = timed heat (fixed when the heat starts). Unset = legacy lap-limited run. */
export type LiveRun = { heatId: string; t0: number; seed: number; speed: number; durationMs?: number };

export const MIN_HEAT_MINUTES = 10;
export const MAX_HEAT_MINUTES = 30;
export const HEAT_MINUTE_OPTIONS = [10, 20];
export const heatMinutesOf = (core: Core) => Math.min(MAX_HEAT_MINUTES, Math.max(MIN_HEAT_MINUTES, Math.round(core.settings.heatMinutes ?? MIN_HEAT_MINUTES)));

export type Core = {
    settings: Settings;
    groups: Group[];
    heats: Heat[];
    nextHeatNum: number;
    seq: number;
    live?: LiveRun | null;
    submissions?: Submission[];
};

/** The venue's four ticket types (owner, 2026-11-15). ליגה and מאסטר ride the fast karts. */
export const DEFAULT_TICKETS = ['רגיל', 'זוגי', 'ליגה', 'מאסטר'];
export const DEFAULT_FAST_TICKETS = ['ליגה', 'מאסטר'];
/** From the venue price board (photo, 2026-11-15), per 10-minute heat: karting 87, two-seat kart with adult 100 (per kart),
 *  Master 100. League has no price on the board yet. */
export const DEFAULT_PRICES: Record<string, number> = { 'רגיל': 87, 'זוגי': 100, 'ליגה': 87, 'מאסטר': 100 };
/** 20-minute heat (owner, 2026-11-15): 100. League is priced like regular. Others not given yet. */
export const DEFAULT_PRICES20: Record<string, number> = { 'רגיל': 100, 'ליגה': 100 };
/** Two-seat kart: two participants share one kart and one price ("רכב זוגי בליווי מבוגר"). */
export const DEFAULT_PAIR_TICKETS = ['זוגי'];
const OLD_DEFAULT_TICKETS = ['קארטינג', 'כרטיס משולב'];

/** Saved data from before the four ticket types: swap the old placeholder tickets for the real ones. */
export function migrateTickets(core: Core): Core {
    let st = core.settings;
    const t = st.tickets;
    const old = t.length === OLD_DEFAULT_TICKETS.length && t.every((x, i) => x === OLD_DEFAULT_TICKETS[i]);
    if (old) st = { ...st, tickets: [...DEFAULT_TICKETS], fastTickets: [...DEFAULT_FAST_TICKETS] };
    if (!st.fastTickets) st = { ...st, fastTickets: st.tickets.filter(x => DEFAULT_FAST_TICKETS.includes(x)) };
    // "יחיד" on the price board means "per person"; the ticket is called "רגיל".
    if (st.tickets.includes('יחיד') && !st.tickets.includes('רגיל')) st = { ...st, tickets: st.tickets.map(x => (x === 'יחיד' ? 'רגיל' : x)) };
    if (!st.prices) st = { ...st, prices: Object.fromEntries(Object.entries(DEFAULT_PRICES).filter(([k]) => st.tickets.includes(k))) };
    if (!st.pairTickets) st = { ...st, pairTickets: [...DEFAULT_PAIR_TICKETS] };
    if (st.prices && st.prices['ליגה'] == null && st.tickets.includes('ליגה')) st = { ...st, prices: { ...st.prices, 'ליגה': DEFAULT_PRICES['ליגה'] } };
    if (!st.prices20) st = { ...st, prices20: Object.fromEntries(Object.entries(DEFAULT_PRICES20).filter(([k]) => st.tickets.includes(k))) };
    if (st === core.settings) return core;
    const ren = (x: string) => (x === 'יחיד' ? 'רגיל' : x);
    return { ...core, settings: st, groups: core.groups.map(g => ({ ...g, ticket: ren(g.ticket), tickets: g.tickets?.map(ren) })),
        submissions: core.submissions?.map(x => ({ ...x, tickets: x.tickets?.map(ren) })) };
}

export type KartClass = 'fast' | 'regular';
export const isFastTicket = (core: Core, ticket: string) => (core.settings.fastTickets ?? DEFAULT_FAST_TICKETS).includes(ticket);
export const classOf = (core: Core, g: Group): KartClass => (isFastTicket(core, g.ticket) ? 'fast' : 'regular');

/** Kart classes of the NON-family groups in a heat. Family groups fit with either class. */
export function heatClasses(core: Core, h: Heat): Set<KartClass> {
    const out = new Set<KartClass>();
    for (const e of h.entries) { const g = core.groups.find(x => x.id === e.groupId); if (g && !g.family) out.add(classOf(core, g)); }
    return out;
}
/** Fast and regular karts in the same heat, with a non-family group on each side. */
export const mixesClasses = (core: Core, h: Heat) => heatClasses(core, h).size > 1;
const mixKey = (h: Heat) => h.entries.map(e => e.groupId).sort().join(',');
/** Mixed classes that still need the shift manager's OK (approval is tied to the exact groups in the heat). */
export const mixNeedsOk = (core: Core, h: Heat) => mixesClasses(core, h) && h.mixOk !== mixKey(h);
export const mixApproved = (core: Core, h: Heat) => mixesClasses(core, h) && h.mixOk === mixKey(h);
/** Shift manager approves (or withdraws approval for) mixing fast and regular karts in this heat. */
export function approveMix(core: Core, heatId: string, ok = true): Core {
    return { ...core, heats: core.heats.map(h => (h.id === heatId ? { ...h, mixOk: ok ? mixKey(h) : undefined } : h)) };
}
/** Heat length of a group: what it paid for, else the default. */
export const groupMinutes = (core: Core, g: Group) => g.minutes ?? heatMinutesOf(core);
/** Heat lengths present in a heat (one value when consistent). */
export function heatMinutesSet(core: Core, h: Heat): Set<number> {
    const out = new Set<number>();
    for (const e of h.entries) { const g = core.groups.find(x => x.id === e.groupId); if (g) out.add(groupMinutes(core, g)); }
    return out;
}
/** Minutes this heat runs: its groups' length, else the default. */
export const minutesOfHeat = (core: Core, h: Heat) => [...heatMinutesSet(core, h)][0] ?? heatMinutesOf(core);
export const mixesMinutes = (core: Core, h: Heat) => heatMinutesSet(core, h).size > 1;

/** Can group g join heat h without mixing fast and regular karts, or 10- and 20-minute groups? */
export function fitsClass(core: Core, h: Heat, g: Group): boolean {
    const mins = heatMinutesSet(core, h);
    if (mins.size > 0 && !mins.has(groupMinutes(core, g))) return false;
    if (g.family) return true;
    const cls = heatClasses(core, h);
    return cls.size === 0 || (cls.size === 1 && cls.has(classOf(core, g)));
}

/** Price total for a list of tickets. `missing` lists ticket types that have no price yet. Display only. */
export function priceOf(core: Core, tickets: string[], minutes = 10): { total: number; missing: string[] } {
    const p = (minutes >= 20 ? core.settings.prices20 : core.settings.prices) ?? {};
    const pair = new Set(core.settings.pairTickets ?? DEFAULT_PAIR_TICKETS);
    const count = new Map<string, number>(); tickets.forEach(t => count.set(t, (count.get(t) ?? 0) + 1));
    let total = 0; const missing: string[] = [];
    for (const [t, n] of count) {
        const v = p[t];
        if (typeof v !== 'number' || v <= 0) { missing.push(t); continue; }
        total += v * (pair.has(t) ? Math.ceil(n / 2) : n); // two participants share one two-seat kart
    }
    return { total, missing };
}

export const MIN_CAP = 1;
export const MAX_CAP = 30;

export const initialCore = (): Core => ({
    settings: { capacity: 10, laps: 8, tickets: [...DEFAULT_TICKETS], fastTickets: [...DEFAULT_FAST_TICKETS], prices: { ...DEFAULT_PRICES }, prices20: { ...DEFAULT_PRICES20 }, pairTickets: [...DEFAULT_PAIR_TICKETS] },
    groups: [],
    heats: [],
    nextHeatNum: 1,
    seq: 1,
    live: null,
});

/** Capacity values that were mentioned for the venue. Not decided: both are offered, default 10. */
export const CAPACITY_OPTIONS = [10, 14];

export const heatCount = (h: Heat) => h.entries.reduce((s, e) => s + e.count, 0);

/** People of a group already placed in any heat. */
export const assignedOf = (heats: Heat[], groupId: string) =>
    heats.reduce((s, h) => s + h.entries.filter(e => e.groupId === groupId).reduce((a, e) => a + e.count, 0), 0);

export const unassignedOf = (core: Core, g: Group) => g.size - assignedOf(core.heats, g.id);

/**
 * Rebuild draft heats from whatever is not yet in an approved/done heat.
 * Rules (proposals, not venue policy):
 *  - first come, first served, first heat with room
 *  - a group stays whole when it fits in a heat
 *  - a group larger than capacity, or one the cashier marked "may split", is split
 *  - approved/done heats are never touched
 * Capacity left in approved heats is not reused (approved means the cashier is done with it).
 */
export function planHeats(core: Core): Core {
    const cap = core.settings.capacity;
    const fixed = core.heats.filter(h => h.status !== 'draft');
    let num = core.nextHeatNum;
    // drafts keep numbering from where fixed heats end
    const drafts: Heat[] = [];
    const mk = (): Heat => {
        const h: Heat = { id: `h${num}`, num, status: 'draft', entries: [] };
        num += 1;
        drafts.push(h);
        return h;
    };
    // reuse the numbers of old drafts so the numbers do not run away on re-plan
    const maxFixed = fixed.reduce((m, h) => Math.max(m, h.num), 0);
    num = maxFixed + 1;
    for (const g of core.groups) {
        let left = g.size - assignedOf(fixed, g.id);
        if (left <= 0) continue;
        // keep-together group bigger than a heat: never split automatically.
        // It stays unassigned until the cashier allows splitting or raises capacity.
        if (left > cap && g.keepTogether) continue;
        if (left <= cap || !g.keepTogether) {
            // whole group fits somewhere?
            const whole = drafts.find(h => cap - heatCount(h) >= left && fitsClass(core, h, g));
            if (left <= cap && whole) {
                whole.entries.push({ groupId: g.id, count: left });
                continue;
            }
            if (left <= cap && g.keepTogether) {
                mk().entries.push({ groupId: g.id, count: left });
                continue;
            }
        }
        // split: fill free seats first, then new heats
        for (const h of drafts) {
            if (left <= 0) break;
            const free = cap - heatCount(h);
            if (free > 0 && !g.keepTogether && fitsClass(core, h, g)) {
                const take = Math.min(free, left);
                h.entries.push({ groupId: g.id, count: take });
                left -= take;
            }
        }
        while (left > 0) {
            const take = Math.min(cap, left);
            mk().entries.push({ groupId: g.id, count: take });
            left -= take;
        }
    }
    return { ...core, heats: [...fixed, ...drafts], nextHeatNum: num };
}

/** Groups that ended up split over several heats. */
export function splitGroupIds(heats: Heat[]): Set<string> {
    const seen = new Map<string, number>();
    for (const h of heats) for (const e of h.entries) seen.set(e.groupId, (seen.get(e.groupId) ?? 0) + 1);
    return new Set([...seen].filter(([, n]) => n > 1).map(([id]) => id));
}

/** Groups marked keep-together that cannot fit in one heat at the current capacity. */
export const oversizedGroups = (core: Core) =>
    core.groups.filter(g => g.keepTogether && g.size - assignedOf(core.heats.filter(h => h.status !== 'draft'), g.id) > core.settings.capacity);

/** Explicit cashier choice: allow this group to be split over heats. */
export const allowSplit = (core: Core, groupId: string): Core => ({
    ...core,
    groups: core.groups.map(g => (g.id === groupId ? { ...g, keepTogether: false } : g)),
});

// ------------------------------------------- cashier override of heat composition
// The cashier can change who is in a heat at any point until it goes on track:
// drafts freely, approved (queued or called) heats too. An approved heat that stops
// being valid after an edit (empty, over capacity, kart clash, missing karts in
// cashier mode) drops back to draft, so nothing invalid stays in the queue.

/** Heats whose composition may still change: drafts and approved heats that are not on track. */
export const editable = (core: Core, h: Heat | undefined): h is Heat =>
    !!h && (h.status === 'draft' || (h.status === 'approved' && core.live?.heatId !== h.id));

function revalidate(core: Core, heatIds: string[]): Core {
    return {
        ...core,
        heats: core.heats.map(h => {
            if (!heatIds.includes(h.id) || h.status !== 'approved') return h;
            const ok = h.entries.length > 0 && !overCapacity(h, core.settings.capacity) && canApprove(core, h);
            return ok ? h : { ...h, status: 'draft' as const, called: false };
        }),
    };
}

/** Driver edits of a group's entry, re-keyed from index `from` onwards. */
function editsOf(h: Heat, groupId: string, count: number, offset: number): Record<string, DriverEdit> {
    const out: Record<string, DriverEdit> = {};
    for (let i = 0; i < count; i++) {
        const x = h.drivers?.[`${groupId}-${i}`];
        if (x) out[`${groupId}-${i + offset}`] = { ...x };
    }
    return out;
}
const withoutGroup = (d: Record<string, DriverEdit> | undefined, groupId: string) =>
    Object.fromEntries(Object.entries(d ?? {}).filter(([k]) => !k.startsWith(`${groupId}-`)));

/**
 * Move a group's entry to another heat. Names and karts entered for those drivers move with them.
 * Into an approved heat only when it fits the capacity.
 */
export function moveEntry(core: Core, groupId: string, fromHeatId: string, toHeatId: string): Core {
    if (fromHeatId === toHeatId) return core;
    const from = core.heats.find(h => h.id === fromHeatId);
    const to = core.heats.find(h => h.id === toHeatId);
    if (!editable(core, from) || !editable(core, to)) return core;
    const e = from.entries.find(x => x.groupId === groupId);
    if (!e) return core;
    if (to.status === 'approved' && heatCount(to) + e.count > core.settings.capacity) return core;
    const ex = to.entries.find(x => x.groupId === groupId);
    const moved = editsOf(from, groupId, e.count, ex?.count ?? 0);
    const heats = core.heats.map(h => {
        if (h.id === from.id) return { ...h, entries: h.entries.filter(x => x.groupId !== groupId), drivers: withoutGroup(h.drivers, groupId) };
        if (h.id === to.id) {
            return {
                ...h,
                entries: ex
                    ? h.entries.map(x => (x.groupId === groupId ? { ...x, count: x.count + e.count } : x))
                    : [...h.entries, { ...e }],
                drivers: { ...(h.drivers ?? {}), ...moved },
            };
        }
        return h;
    });
    return revalidate({ ...core, heats }, [from.id, to.id]);
}

export const overCapacity = (h: Heat, cap: number) => heatCount(h) > cap;

export function approveHeat(core: Core, heatId: string): Core {
    return {
        ...core,
        heats: core.heats.map(h =>
            h.id === heatId && h.status === 'draft' && h.entries.length > 0 && !overCapacity(h, core.settings.capacity) && canApprove(core, h)
                ? { ...h, status: 'approved' as const }
                : h,
        ),
    };
}

/** Back to draft for editing. Not while the heat is on track. */
export const unapproveHeat = (core: Core, heatId: string): Core => core.live?.heatId === heatId ? core : ({
    ...core,
    heats: core.heats.map(h => (h.id === heatId && h.status === 'approved' ? { ...h, status: 'draft' as const, called: false } : h)),
});

// ------------------------------------------- simple queue and screen call-up (demo)
// The queue is just the approved heats in order. There are no time slots.
// "Called" is a visual state for the on-site screen. It is a demo flag, not an operational rule.

/** Approved heats waiting for the track, in heat-number order. The heat on track is not in the queue. */
export const queueOf = (core: Core): Heat[] =>
    core.heats.filter(h => h.status === 'approved' && h.id !== core.live?.heatId).sort((a, b) => a.num - b.num);
export const calledHeat = (core: Core): Heat | undefined => queueOf(core).find(h => h.called);

/** Mark a queued heat as called to the track. Only one heat is called at a time. Any queued heat may be called, not only the first. */
export function callHeat(core: Core, heatId: string): Core {
    const h = queueOf(core).find(x => x.id === heatId);
    if (!h || calledHeat(core)) return core;
    return { ...core, heats: core.heats.map(x => (x.id === heatId ? { ...x, called: true } : x)) };
}
export const uncallHeat = (core: Core, heatId: string): Core => ({ ...core, heats: core.heats.map(x => (x.id === heatId ? { ...x, called: false } : x)) });

export type ScreenState = 'race' | 'call' | 'next' | 'empty';
/**
 * What the on-site screen shows. The heat on track wins; otherwise the called heat; otherwise the next in queue.
 * `runningHeatId` defaults to the live run stored in core.
 */
export function screenState(core: Core, runningHeatId: string | null = core.live?.heatId ?? null): { state: ScreenState; heat?: Heat } {
    if (runningHeatId) { const h = core.heats.find(x => x.id === runningHeatId); if (h) return { state: 'race', heat: h }; }
    const c = calledHeat(core); if (c) return { state: 'call', heat: c };
    const n = queueOf(core)[0]; if (n) return { state: 'next', heat: n };
    return { state: 'empty' };
}

// ------------------------------------------------------- live run (simulated)

export const runningHeat = (core: Core): Heat | undefined =>
    core.live ? core.heats.find(h => h.id === core.live!.heatId && h.status === 'approved') : undefined;

/** Reasons a queued heat cannot go on track now (Hebrew, shown to the cashier). Empty = can start. */
export function startBlockers(core: Core, h: Heat): string[] {
    const out: string[] = [];
    if (h.status !== 'approved') out.push('המקצה לא מאושר');
    if (core.live && core.live.heatId !== h.id) out.push('מקצה אחר על המסלול');
    if (h.entries.length === 0) out.push('אין נהגים');
    if (overCapacity(h, core.settings.capacity)) out.push(`מעל הקיבולת (${core.settings.capacity})`);
    if (kartConflicts(core, h).length) out.push('קארט כפול');
    if (mixNeedsOk(core, h)) out.push('מכוניות מהירות ורגילות באותו מקצה בלי אישור אחמ״ש');
    if (mixesMinutes(core, h)) out.push('קבוצות של 10 ו-20 דקות באותו מקצה');
    return out;
}

/** Put a queued heat on track. Clears its "called" flag: it is now racing. */
export function startHeat(core: Core, heatId: string, now: number, seed: number, speed = 1): Core {
    const h = queueOf(core).find(x => x.id === heatId);
    if (!h || core.live || startBlockers(core, h).length) return core;
    return {
        ...core,
        live: { heatId, t0: now, seed, speed, durationMs: minutesOfHeat(core, h) * 60_000 },
        heats: core.heats.map(x => (x.id === heatId ? { ...x, called: false } : x)),
    };
}

/** Simulated ms on track. Speed multiplies wall time (demo only). */
export const elapsedOf = (live: LiveRun | null | undefined, now: number) => (live ? Math.max(0, (now - live.t0) * live.speed) : 0);

/** Change simulation speed without jumping the clock. */
export function setSpeed(core: Core, speed: number, now: number): Core {
    if (!core.live || speed <= 0) return core;
    const el = elapsedOf(core.live, now);
    return { ...core, live: { ...core.live, speed, t0: now - el / speed } };
}

/** Timing for the heat on track. The feed defaults to the simulation; a real read-only feed would be passed here. */
export function liveTiming(core: Core, now: number, feed?: TimingFeed): DriverTiming[] {
    const h = runningHeat(core);
    if (!h || !core.live) return [];
    const drivers = driversOf(core, h), el = elapsedOf(core.live, now);
    if (core.live.durationMs) return timedTiming((feed ?? makeSimulatedFeed(core.live.seed, transponderOf(core))).snapshot(drivers, el, TIMED_LAP_CAP), core.live.durationMs);
    return (feed ?? makeSimulatedFeed(core.live.seed, transponderOf(core))).snapshot(drivers, el, core.settings.laps);
}

const TIMED_LAP_CAP = 200;

/**
 * Timed heat: when the clock reaches the duration, each driver finishes the lap they are on and is then done
 * (the usual way to end a timed heat). Laps completed after that are dropped.
 */
export function timedTiming(rows: DriverTiming[], durationMs: number): DriverTiming[] {
    return rows.map(r => {
        let t = 0; const laps: number[] = [];
        for (const lap of r.laps) { laps.push(lap); t += lap; if (t >= durationMs) break; }
        const done = t >= durationMs;
        return { ...r, laps, total: laps.length ? t : 0, best: laps.length ? Math.min(...laps) : null, last: laps.length ? laps[laps.length - 1] : null, finished: done };
    });
}

/** Time left on a timed heat (0 when over). Null for a legacy lap-limited run. */
export function timeLeft(live: LiveRun | null | undefined, now: number): number | null {
    if (!live?.durationMs) return null;
    return Math.max(0, live.durationMs - elapsedOf(live, now));
}

/** End the run, mark the heat done and return its result for history. */
export function finishRun(core: Core, now: number, feed?: TimingFeed): { core: Core; result: Result | null } {
    const h = runningHeat(core);
    if (!h) return { core: { ...core, live: null }, result: null };
    const result = resultOf(core, h, liveTiming(core, now, feed), now, !feed);
    return {
        core: { ...core, live: null, heats: core.heats.map(x => (x.id === h.id ? { ...x, status: 'done' as const, called: false } : x)) },
        result,
    };
}

/** Stop without saving: the heat goes back to the queue (not called). */
export const cancelRun = (core: Core): Core => ({ ...core, live: null });

export function addGroup(core: Core, g: Omit<Group, 'id' | 'createdAt'>, now: number): Core {
    const size = Math.max(1, Math.min(99, Math.floor(g.size)));
    return {
        ...core,
        seq: core.seq + 1,
        groups: [...core.groups, { ...g, size, id: `g${core.seq}`, createdAt: now }],
    };
}

/** Removes a group unless it is in an approved/done heat. Drafts are cleaned. */
export function removeGroup(core: Core, groupId: string): Core {
    const locked = core.heats.some(h => h.status !== 'draft' && h.entries.some(e => e.groupId === groupId));
    if (locked) return core;
    return {
        ...core,
        groups: core.groups.filter(g => g.id !== groupId),
        heats: core.heats
            .map(h => (h.status === 'draft' ? { ...h, entries: h.entries.filter(e => e.groupId !== groupId), drivers: withoutGroup(h.drivers, groupId) } : h))
            .filter(h => h.status !== 'draft' || h.entries.length > 0),
    };
}

// ---------------------------------------------------------------- drivers

export type Driver = { key: string; kart: number; label: string; groupId: string; kartSet: boolean; nameSet: boolean };

export function driversOf(core: Core, heat: Heat): Driver[] {
    const ed = heat.drivers ?? {};
    const base: Driver[] = [];
    for (const e of heat.entries) {
        const g = core.groups.find(x => x.id === e.groupId);
        // a group split over heats continues its form names from where the earlier heat left off
        const offset = g?.names ? namesOffset(core, heat, e.groupId) : 0;
        for (let i = 0; i < e.count; i++) {
            const key = `${e.groupId}-${i}`;
            const x = ed[key] ?? {};
            const formName = g?.names?.[offset + i];
            base.push({
                key,
                kart: x.kart ?? 0,
                kartSet: x.kart != null,
                nameSet: !!(x.name || formName),
                label: x.name || formName || (g ? `${g.name}${g.size > 1 ? ` ${offset + i + 1}` : ''}` : 'נהג'),
                groupId: e.groupId,
            });
        }
    }
    // drivers without a chosen kart get the lowest free number: a suggestion only
    const used = new Set(base.filter(d => d.kartSet).map(d => d.kart));
    let n = 1;
    for (const d of base) if (!d.kartSet) { while (used.has(n)) n++; d.kart = n++; }
    return base;
}

/** How many of this group's people sit in heats ordered before `heat` (by heat number). */
function namesOffset(core: Core, heat: Heat, groupId: string): number {
    let n = 0;
    for (const h of core.heats) {
        if (h.id === heat.id || h.num > heat.num || (h.num === heat.num && h.id > heat.id)) continue;
        for (const e of h.entries) if (e.groupId === groupId) n += e.count;
    }
    return n;
}

/** Kart numbers used by more than one driver of the same heat. */
export function kartConflicts(core: Core, heat: Heat): number[] {
    const seen = new Map<number, number>();
    for (const d of driversOf(core, heat)) seen.set(d.kart, (seen.get(d.kart) ?? 0) + 1);
    return [...seen].filter(([, c]) => c > 1).map(([k]) => k);
}

export const kartMode = (core: Core): KartMode => core.settings.kartMode ?? 'unset';

/** A heat may be approved when karts do not clash and, in cashier mode, every kart was chosen on purpose. */
export function canApprove(core: Core, heat: Heat): boolean {
    if (kartConflicts(core, heat).length) return false;
    if (mixNeedsOk(core, heat) || mixesMinutes(core, heat)) return false;
    if (kartMode(core) === 'cashier' && driversOf(core, heat).some(d => !d.kartSet)) return false;
    return true;
}

export function setDriver(core: Core, heatId: string, key: string, patch: DriverEdit): Core {
    return {
        ...core,
        heats: core.heats.map(h => {
            if (h.id !== heatId || h.status === 'done') return h;
            const cur = { ...(h.drivers ?? {}) };
            const next: DriverEdit = { ...(cur[key] ?? {}), ...patch };
            if (!next.name) delete next.name;
            if (next.kart == null || !(next.kart >= 1)) delete next.kart; else next.kart = Math.min(99, Math.floor(next.kart));
            if (Object.keys(next).length) cur[key] = next; else delete cur[key];
            return { ...h, drivers: cur };
        }),
    };
}

// ---------------------------------------- manual heat building (cashier decides)

export function createHeat(core: Core): Core {
    const num = core.heats.reduce((m, h) => Math.max(m, h.num), core.nextHeatNum - 1) + 1;
    return { ...core, nextHeatNum: num + 1, heats: [...core.heats, { id: `h${num}`, num, status: 'draft', entries: [] }] };
}

/** Put the waiting people of a group into a heat (draft, or approved and not on track). Never splits a keep-together group on its own. */
export function addToHeat(core: Core, groupId: string, heatId: string): Core {
    const h = core.heats.find(x => x.id === heatId);
    const g = core.groups.find(x => x.id === groupId);
    if (!g || !editable(core, h)) return core;
    const left = unassignedOf(core, g);
    const free = core.settings.capacity - heatCount(h);
    if (left <= 0 || free <= 0) return core;
    if (g.keepTogether && left > free) return core;
    const take = Math.min(left, free);
    const ex = h.entries.find(e => e.groupId === groupId);
    return revalidate({
        ...core,
        heats: core.heats.map(x => x.id !== heatId ? x : { ...x, entries: ex ? x.entries.map(e => e.groupId === groupId ? { ...e, count: e.count + take } : e) : [...x.entries, { groupId, count: take }] }),
    }, [heatId]);
}

/** Send a group's drivers in this heat back to the waiting list. Works on drafts and on approved heats not on track. */
export function removeFromHeat(core: Core, groupId: string, heatId: string): Core {
    if (!editable(core, core.heats.find(h => h.id === heatId))) return core;
    return revalidate({
        ...core,
        heats: core.heats.map(h => h.id === heatId ? { ...h, entries: h.entries.filter(e => e.groupId !== groupId), drivers: withoutGroup(h.drivers, groupId) } : h),
    }, [heatId]);
}

// ------------------------------------------------- timing: passings -> laps
// Target architecture: this app REPLACES the venue's current timing software and will
// eventually read the venue's own lap-timing hardware (decoder + transponders) directly.
// The decoder model, its protocol and its connection are NOT known yet, so nothing here
// assumes one. The seam is deliberately small:
//
//   decoder adapter (future, outside this file)  ->  Passing[]  ->  lapsFromPassings()  ->  DriverTiming[]
//
// A passing is the only thing an adapter must produce: "transponder X crossed the line at
// time t". Everything after that (lap building, noise filtering, ranking, results) is pure
// and tested here. Today the passings are SYNTHETIC (makeSimulatedFeed). See
// docs/TIMING-INTEGRATION.md for what a real decoder integration still needs.

export type DriverTiming = {
    key: string;
    laps: number[]; // completed lap times in ms
    total: number; // elapsed at last completed lap
    best: number | null;
    last: number | null;
    finished: boolean;
};

/** Read-only source of timing for the heat on track. Simulated today; a decoder-backed feed later. */
export interface TimingFeed {
    snapshot(drivers: Driver[], elapsedMs: number, totalLaps: number): DriverTiming[];
}

/** One crossing of the timing line, as a decoder would report it. `t` is ms on the timing clock. */
export type Passing = { transponder: string; t: number };

export type LapRules = {
    /** Crossings closer than this to the previous counted one are ignored (double reads, pit-lane noise). Demo value, not a venue setting yet. */
    minLapMs: number;
    /**
     * 'lap': the race starts at startT and the first crossing completes lap 1 (karts start behind the line).
     * 'start': the first crossing only starts the clock for that kart (rolling start).
     * Which one the venue uses is not decided.
     */
    firstCrossing: 'lap' | 'start';
};
export const DEFAULT_LAP_RULES: LapRules = { minLapMs: 15000, firstCrossing: 'lap' };

/** Kart -> transponder id. The real mapping (fixed per kart? swapped?) is unknown; the default is a synthetic id. */
export const simTransponder = (kart: number) => `SIM-${kart}`;
export const transponderOf = (core: Core) => (kart: number) => core.settings.transponders?.[String(kart)] || simTransponder(kart);

/** Pure: build each driver's laps from raw passings. Passings may arrive unsorted and with duplicates. */
export function lapsFromPassings(
    drivers: Driver[], passings: Passing[], startT: number, totalLaps: number,
    tx: (kart: number) => string = simTransponder, rules: LapRules = DEFAULT_LAP_RULES,
): DriverTiming[] {
    const byTx = new Map<string, number[]>();
    for (const p of passings) {
        if (p.t < startT) continue;
        const a = byTx.get(p.transponder) ?? [];
        a.push(p.t); byTx.set(p.transponder, a);
    }
    return drivers.map(d => {
        const ts = (byTx.get(tx(d.kart)) ?? []).sort((a, b) => a - b);
        const laps: number[] = [];
        let prev: number | null = rules.firstCrossing === 'lap' ? startT : null;
        let origin = startT;
        for (const t of ts) {
            if (laps.length >= totalLaps) break;
            if (prev == null) { prev = t; origin = t; continue; }
            if (t - prev < rules.minLapMs) continue;
            laps.push(t - prev);
            prev = t;
        }
        const total = laps.length ? (prev as number) - origin : 0;
        return { key: d.key, laps, total, best: laps.length ? Math.min(...laps) : null, last: laps.length ? laps[laps.length - 1] : null, finished: laps.length >= totalLaps };
    });
}

/** Transponders seen on the line that belong to no driver of this heat (for the operator to resolve). */
export function unknownTransponders(drivers: Driver[], passings: Passing[], tx: (kart: number) => string = simTransponder): string[] {
    const known = new Set(drivers.map(d => tx(d.kart)));
    return [...new Set(passings.map(p => p.transponder).filter(x => !known.has(x)))];
}

function rng(seed: number) {
    let s = seed >>> 0 || 1;
    return () => {
        s ^= s << 13; s >>>= 0;
        s ^= s >> 17;
        s ^= s << 5; s >>>= 0;
        return s / 4294967296;
    };
}

/**
 * SIMULATION. Synthetic passings: a pure function of (seed, drivers, elapsed ms). No hardware, no network.
 * Pace is 36-45 s per lap, demo only.
 */
export function simulatedPassings(seed: number, drivers: Driver[], elapsedMs: number, totalLaps: number, tx: (kart: number) => string = simTransponder): Passing[] {
    const out: Passing[] = [];
    drivers.forEach((d, idx) => {
        const r = rng(seed * 7919 + idx * 104729 + 13);
        const pace = 36000 + Math.floor(r() * 9000);
        let t = 0;
        for (let i = 0; i < totalLaps; i++) {
            const lap = Math.round(pace + (r() - 0.5) * 3500 + (i === 0 ? 4000 : 0));
            if (t + lap > elapsedMs) break;
            t += lap;
            out.push({ transponder: tx(d.kart), t });
        }
    });
    return out;
}

/** The demo feed: synthetic passings run through the same lapsFromPassings path a decoder feed will use. */
export function makeSimulatedFeed(seed: number, tx: (kart: number) => string = simTransponder): TimingFeed {
    return {
        snapshot(drivers, elapsedMs, totalLaps) {
            return lapsFromPassings(drivers, simulatedPassings(seed, drivers, elapsedMs, totalLaps, tx), 0, totalLaps, tx);
        },
    };
}

/**
 * Adapter shape for a FUTURE decoder-backed feed. `read()` returns the passings received so far
 * (from whatever local bridge ends up talking to the hardware); `startT` is the green-flag time on
 * the same clock. Not used by the demo; kept here so the seam is explicit and testable.
 */
export function makePassingFeed(read: () => Passing[], startT: number, tx: (kart: number) => string = simTransponder, rules: LapRules = DEFAULT_LAP_RULES): TimingFeed {
    return { snapshot: (drivers, _elapsedMs, totalLaps) => lapsFromPassings(drivers, read(), startT, totalLaps, tx, rules) };
}

/** Order: more laps first, then earlier time at last completed lap. */
export function rank(rows: DriverTiming[]): DriverTiming[] {
    return [...rows].sort((a, b) => b.laps.length - a.laps.length || a.total - b.total);
}

export const allFinished = (rows: DriverTiming[]) => rows.length > 0 && rows.every(r => r.finished);

/** Race clock: running time, frozen at the last finisher once everyone is done. */
export const raceClock = (rows: DriverTiming[], elapsedMs: number) =>
    allFinished(rows) ? Math.max(...rows.map(r => r.total)) : elapsedMs;

export function fmt(ms: number | null): string {
    if (ms == null) return '–';
    const s = ms / 1000;
    const m = Math.floor(s / 60);
    const rest = (s - m * 60).toFixed(2).padStart(m ? 5 : 1, '0');
    return m ? `${m}:${rest}` : rest;
}

// ---------------------------------------------------------------- history

export type Result = {
    heatId: string;
    heatNum: number;
    at: number;
    simulated: boolean;
    laps: number;
    /** Timed heat length in minutes (unset for legacy lap-limited runs). */
    minutes?: number;
    rows: { pos: number; kart: number; label: string; laps: number[]; best: number | null; total: number }[];
};

export function resultOf(core: Core, heat: Heat, timing: DriverTiming[], now: number, simulated = true): Result {
    const drivers = driversOf(core, heat);
    const ranked = rank(timing);
    return {
        heatId: heat.id,
        heatNum: heat.num,
        at: now,
        simulated,
        laps: core.live?.durationMs ? Math.max(0, ...ranked.map(t => t.laps.length)) : core.settings.laps,
        minutes: core.live?.durationMs ? Math.round(core.live.durationMs / 60_000) : undefined,
        rows: ranked.map((t, i) => {
            const d = drivers.find(x => x.key === t.key)!;
            return { pos: i + 1, kart: d.kart, label: d.label, laps: t.laps, best: t.best, total: t.total };
        }),
    };
}

/** Keep history under the per-key storage budget (16 KiB), dropping the oldest. */
export type HistReset = 'day' | 'week';
export const histResetOf = (core: Core): HistReset => core.settings.histReset ?? 'day';
/** Start of the current history period, local time: today 00:00, or the last Sunday 00:00 (the Israeli week starts on Sunday). */
export function periodStart(now: number, mode: HistReset): number {
    const d = new Date(now); d.setHours(0, 0, 0, 0);
    if (mode === 'week') d.setDate(d.getDate() - d.getDay());
    return d.getTime();
}
export const currentPeriod = (hist: Result[], now: number, mode: HistReset) => { const t = periodStart(now, mode); return hist.filter(r => r.at >= t); };
/** Same heat result seen twice (local + cloud archive) has the same key. */
export const resultKey = (r: Result) => `${r.heatId}-${r.at}`;
export function mergeResults(...lists: Result[][]): Result[] {
    const m = new Map<string, Result>();
    for (const l of lists) for (const r of l) if (!m.has(resultKey(r))) m.set(resultKey(r), r);
    return [...m.values()].sort((a, b) => b.at - a.at);
}

/** Device copy of the history (the full archive lives in the cloud). ~2 MB keeps months of heats in browser storage. */
/** History shared between staff computers stays small (live sync); everything is also in the heat_history archive. */
export const SHARED_HISTORY_BYTES = 250_000;
export function trimHistory(h: Result[], maxBytes = 2_000_000): Result[] {
    let out = h;
    while (out.length > 1 && JSON.stringify(out).length > maxBytes) out = out.slice(0, -1);
    return out;
}

export const demoGroups: { name: string; size: number; ticket: number; keepTogether: boolean; note: string }[] = [
    { name: 'משפחת כהן (דמו)', size: 4, ticket: 0, keepTogether: true, note: '' },
    { name: 'יום הולדת (דמו)', size: 7, ticket: 0, keepTogether: true, note: '' },
    { name: 'דני ושני (דמו)', size: 2, ticket: 1, keepTogether: true, note: '' },
    { name: 'ליגת חמישי (דמו)', size: 5, ticket: 2, keepTogether: true, note: '' },
    { name: 'חברים (דמו)', size: 3, ticket: 3, keepTogether: false, note: '' },
    { name: 'צוות עבודה (דמו)', size: 12, ticket: 1, keepTogether: true, note: 'גדול מהקיבולת, יפוצל' },
];

// ---------------------------------------------------------- vision demo helpers
// Everything below is SYNTHETIC: names are invented, sectors are derived from simulated laps.
// Real sector times need extra timing loops on the track; whether the venue has them is unknown
// (a single start/finish loop gives laps only).

/** Simulated S1/S2/S3 of one lap: deterministic split of the lap time, sums exactly to the lap. */
export function sectorsOf(lapMs: number, seed: number, driverIdx: number, lapNo: number): [number, number, number] {
    const r = rng(seed * 31 + driverIdx * 997 + lapNo * 7 + 5);
    const a = 0.30 + r() * 0.06, b = 0.34 + r() * 0.06;
    const s1 = Math.round(lapMs * a), s2 = Math.round(lapMs * b);
    return [s1, s2, lapMs - s1 - s2];
}

/** Estimated time left in the heat: leader's remaining laps at the leader's average pace. Demo only. */
export function estRemaining(timing: DriverTiming[], elapsedMs: number, totalLaps: number): number {
    const lead = rank(timing)[0];
    if (!lead) return 0;
    if (lead.finished) return 0;
    const avg = lead.laps.length ? lead.total / lead.laps.length : 42000;
    return Math.max(0, Math.round(totalLaps * avg - elapsedMs));
}

/** Invented first names for the demo lineup. Not real customers. */
export const DEMO_NAMES = ['נועה', 'איתי', 'מאיה', 'עומר', 'שירה', 'יונתן', 'תמר', 'אורי', 'ליה', 'דניאל', 'רוני', 'אלון', 'גיל', 'הדר', 'עידו', 'יעל', 'בן', 'אביב', 'נגה', 'טל', 'רז', 'מיכל', 'אריאל', 'שחר', 'עדי', 'נדב', 'אגם', 'יואב', 'קרן', 'אמיר', 'ליאור', 'דנה'];

/** Give every unnamed driver in drafts/queued heats a synthetic name. Existing names are kept. */
export function fillDemoNames(core: Core): Core {
    let n = 0;
    let c = core;
    for (const h of core.heats) {
        if (h.status === 'done' || core.live?.heatId === h.id) continue;
        for (const d of driversOf(c, c.heats.find(x => x.id === h.id)!)) {
            if (d.nameSet) continue;
            c = setDriver(c, h.id, d.key, { name: DEMO_NAMES[n++ % DEMO_NAMES.length] });
        }
    }
    return c;
}

/**
 * One-click demo: load demo groups if there are none, let oversized groups split, suggest heats,
 * fill synthetic names and approve every valid draft. The cashier can still change everything after.
 */
export function demoSetup(core: Core, now: number): Core {
    let c = core;
    // demo groups arrive the same way real ones would: customer form -> (simulated) payment -> queue
    if (c.groups.length === 0 && pendingOf(c).length === 0) {
        let n = 0;
        demoGroups.forEach(g => {
            const names = Array.from({ length: g.size }, () => DEMO_NAMES[n++ % DEMO_NAMES.length]);
            const r = submitForm(c, g.name, names, now);
            if (r.id) c = markPaid(r.core, r.id, now, { keepTogether: g.keepTogether, ticket: c.settings.tickets[g.ticket] });
        });
    }
    for (const s of pendingOf(c)) c = markPaid(c, s.id, now);
    for (const g of oversizedGroups(c)) c = allowSplit(c, g.id);
    if (c.groups.some(g => unassignedOf(c, g) > 0)) c = planHeats(c);
    c = fillDemoNames(c);
    for (const h of c.heats) if (h.status === 'draft') c = approveHeat(c, h.id);
    return c;
}

// ------------------------------------------- customer form -> payment -> queue (simulated)
// Customers fill one group name + participant names. The submission waits at the cashier.
// Only when staff mark it paid does it become a group waiting for a heat. No payment is
// processed: "paid" is a staff confirmation flag in this demo. No other fields are collected.

export const MAX_FORM_NAMES = 30;
export const pendingOf = (core: Core): Submission[] => (core.submissions ?? []).filter(s => s.status === 'pending');

/** Validate and store a form. Returns the new id, or an error (Hebrew) and the unchanged core. */
export function submitForm(core: Core, groupName: string, names: string[], now: number, tickets?: string[], minutes?: number): { core: Core; id?: string; error?: string } {
    const gn = groupName.trim().slice(0, 40);
    const keep = names.map((x, i) => ({ n: x.trim().slice(0, 24), t: tickets?.[i] })).filter(x => x.n);
    const ns = keep.map(x => x.n);
    const ts = tickets ? keep.map(x => (x.t && core.settings.tickets.includes(x.t) ? x.t : core.settings.tickets[0] ?? '')) : undefined;
    if (!gn) return { core, error: 'חסר שם קבוצה' };
    if (ns.length === 0) return { core, error: 'צריך לפחות משתתף אחד' };
    if (ns.length > MAX_FORM_NAMES) return { core, error: `עד ${MAX_FORM_NAMES} משתתפים בטופס אחד` };
    const id = `s${core.seq}`;
    return { core: { ...core, seq: core.seq + 1, submissions: [...(core.submissions ?? []), { id, groupName: gn, names: ns, createdAt: now, status: 'pending', ...(ts ? { tickets: ts } : {}), ...(minutes ? { minutes: minutes >= 20 ? 20 : 10 } : {}) }] }, id };
}

/** Staff confirm payment (simulated). The group enters the waiting list for heats with its names. */
export function markPaid(core: Core, subId: string, now: number, opts: { keepTogether?: boolean; ticket?: string; family?: boolean; tickets?: string[]; minutes?: number } = {}): Core {
    const s = (core.submissions ?? []).find(x => x.id === subId);
    if (!s || s.status !== 'pending') return core;
    const fallback = opts.ticket ?? core.settings.tickets[0] ?? '';
    const per = s.names.map((_, i) => opts.tickets?.[i] ?? (opts.ticket ? opts.ticket : s.tickets?.[i]) ?? fallback);
    const family = !!opts.family;
    // Fast and regular karts may not race together unless family: a mixed non-family registration becomes two groups.
    const fastIdx = per.map((t, i) => (isFastTicket(core, t) ? i : -1)).filter(i => i >= 0);
    const parts: { name: string; idx: number[] }[] = family || fastIdx.length === 0 || fastIdx.length === per.length
        ? [{ name: s.groupName, idx: per.map((_, i) => i) }]
        : [{ name: s.groupName, idx: per.map((_, i) => i).filter(i => !fastIdx.includes(i)) }, { name: `${s.groupName} (מהירות)`, idx: fastIdx }];
    let c = core; const ids: string[] = [];
    for (const part of parts) {
        const ts = part.idx.map(i => per[i]);
        const main = mostCommon(ts) ?? fallback;
        c = addGroup(c, { name: part.name, size: part.idx.length, ticket: main, keepTogether: opts.keepTogether ?? true, note: '' }, now);
        const g = c.groups[c.groups.length - 1];
        ids.push(g.id);
        const minutes = opts.minutes ?? s.minutes;
        c = { ...c, groups: c.groups.map(x => (x.id === g.id ? { ...x, names: part.idx.map(i => s.names[i]), family, tickets: ts, ...(minutes ? { minutes } : {}) } : x)) };
    }
    return { ...c, submissions: (core.submissions ?? []).map(x => (x.id === subId ? { ...x, status: 'paid' as const, groupId: ids[0], groupIds: ids, tickets: per } : x)) };
}

function mostCommon(xs: string[]): string | undefined {
    const m = new Map<string, number>(); xs.forEach(x => m.set(x, (m.get(x) ?? 0) + 1));
    return [...m].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/** Paid -> into the queue AND re-suggest the draft heats, so heats build themselves as people pay. Approved heats are untouched. */
export const markPaidAndPlan = (core: Core, subId: string, now: number, opts: { keepTogether?: boolean; ticket?: string; family?: boolean; tickets?: string[]; minutes?: number } = {}): Core => {
    const next = markPaid(core, subId, now, opts);
    return next === core ? core : planHeats(next);
};

/** Drop a pending submission (customer left, duplicate...). Paid ones are handled as groups. */
export const cancelSubmission = (core: Core, subId: string): Core => ({
    ...core,
    submissions: (core.submissions ?? []).map(x => (x.id === subId && x.status === 'pending' ? { ...x, status: 'cancelled' as const } : x)),
});
