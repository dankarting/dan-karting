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
    /** 'track' = created by track staff with the cashier add-on off (no payment concept). Absent = cashier path. */
    origin?: 'track';
    /**
     * PAYMENT GATE ("cleared to race"). With the cashier add-on: true only after explicit cashier confirmation
     * (markPaid / confirmGroupPaid). Without it: set by addTrackHeat, which is closed while the add-on is on.
     * Queue, heat composition and call-up all check it. Simulated staff flag: no payment is processed.
     */
    paid?: boolean;
    paidAt?: number;
};

/**
 * A customer's form submission: one group name + participant names. Nothing else is asked.
 * It waits at the cashier until staff confirm payment (simulated: no payment is processed here).
 */
export type Submission = {
    id: string; groupName: string; names: string[]; createdAt: number; status: 'pending' | 'paid' | 'cancelled'; groupId?: string;
    /** Where it came from: the customer form, the cashier's manual add (headcount, maybe no names), or the synthetic demo. */
    source?: 'form' | 'cashier' | 'demo';
    /** Headcount when no names were given (cashier manual add). */
    size?: number;
    ticket?: string; keepTogether?: boolean; note?: string;
};

export type Entry = { groupId: string; count: number };
export type HeatStatus = 'draft' | 'approved' | 'done';
export type DriverEdit = { name?: string; kart?: number };
export type Heat = { id: string; num: number; status: HeatStatus; entries: Entry[]; drivers?: Record<string, DriverEdit>; called?: boolean };
/** How karts get matched to drivers. Not decided by the venue yet, so 'unset' keeps an editable auto suggestion. */
export type KartMode = 'unset' | 'cashier' | 'staff';

export type Settings = {
    capacity: number; // configurable: the real limit is not confirmed (10 or 14 were both mentioned)
    laps: number;
    tickets: string[];
    kartMode?: KartMode;
    /**
     * Optional CASHIER ADD-ON (registration form + payment confirmation). The timing system is the core and
     * runs fully without it. Off by default. While it is ON, heats can only be filled through the cashier
     * (pending -> paid), so the payment gate cannot be bypassed from the timing screens.
     */
    cashierEnabled?: boolean;
    /** Optional kart number -> transponder id. Unset = synthetic ids. Real mapping not known yet. */
    transponders?: Record<string, string>;
    /**
     * What the public (customer) website shows. Both show live timing while a heat runs (also a quick start
     * without a queue). 'lineup' (default): between heats the queue / call-up waiting screen.
     * 'heat': between heats the latest results.
     */
    publicView?: PublicView;
};
export type PublicView = 'heat' | 'lineup';
export const publicViewOf = (core: Core): PublicView => core.settings.publicView ?? 'lineup';

/** The heat currently on track (simulated). Stored in Core so it survives tab changes and reloads. */
/** pausedAt: set while a marshal has stopped the heat ("עצור"); the clock and simulated laps freeze. */
export type LiveRun = { heatId: string; t0: number; seed: number; speed: number; pausedAt?: number };

export type Core = {
    settings: Settings;
    groups: Group[];
    heats: Heat[];
    nextHeatNum: number;
    seq: number;
    live?: LiveRun | null;
    submissions?: Submission[];
};

export const MIN_CAP = 1;
export const MAX_CAP = 30;

export const initialCore = (): Core => ({
    settings: { capacity: 10, laps: 8, tickets: ['קארטינג', 'כרטיס משולב'] },
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

/** Payment gate: a group counts only after explicit cashier confirmation. Legacy groups without the flag are unpaid. */
export const isPaid = (g: Group | undefined): boolean => g?.paid === true;
/** Every group in this heat has been confirmed as paid. */
export const heatPaid = (core: Core, h: Heat): boolean => h.entries.every(e => isPaid(core.groups.find(g => g.id === e.groupId)));
/** Paid groups with people not yet placed in a heat: the waiting list the cashier composes heats from. */
export const waitingGroups = (core: Core): Group[] => core.groups.filter(g => isPaid(g) && unassignedOf(core, g) > 0);

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
        if (!isPaid(g)) continue; // payment gate: unpaid groups are never planned into heats
        let left = g.size - assignedOf(fixed, g.id);
        if (left <= 0) continue;
        // keep-together group bigger than a heat: never split automatically.
        // It stays unassigned until the cashier allows splitting or raises capacity.
        if (left > cap && g.keepTogether) continue;
        if (left <= cap || !g.keepTogether) {
            // whole group fits somewhere?
            const whole = drafts.find(h => cap - heatCount(h) >= left);
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
            if (free > 0 && !g.keepTogether) {
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
    core.groups.filter(g => isPaid(g) && g.keepTogether && g.size - assignedOf(core.heats.filter(h => h.status !== 'draft'), g.id) > core.settings.capacity);

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
            const ok = h.entries.length > 0 && !overCapacity(h, core.settings.capacity) && canApprove(core, h) && heatPaid(core, h);
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
            h.id === heatId && h.status === 'draft' && h.entries.length > 0 && !overCapacity(h, core.settings.capacity) && canApprove(core, h) && heatPaid(core, h)
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

/**
 * Approved heats waiting for the track, in heat-number order. The heat on track is not in the queue.
 * Payment gate: a heat holding any unpaid group is never in the queue, so it can never be called or started.
 */
export const queueOf = (core: Core): Heat[] =>
    core.heats.filter(h => h.status === 'approved' && h.id !== core.live?.heatId && heatPaid(core, h)).sort((a, b) => a.num - b.num);
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
    if (!heatPaid(core, h)) out.push('קבוצה שלא אושר לה תשלום');
    if (overCapacity(h, core.settings.capacity)) out.push(`מעל הקיבולת (${core.settings.capacity})`);
    if (kartConflicts(core, h).length) out.push('קארט כפול');
    return out;
}

/** Put a queued heat on track. Clears its "called" flag: it is now racing. */
export function startHeat(core: Core, heatId: string, now: number, seed: number, speed = 1): Core {
    const h = queueOf(core).find(x => x.id === heatId);
    if (!h || core.live || startBlockers(core, h).length) return core;
    return {
        ...core,
        live: { heatId, t0: now, seed, speed },
        heats: core.heats.map(x => (x.id === heatId ? { ...x, called: false } : x)),
    };
}

/** Simulated ms on track. Speed multiplies wall time (demo only). */
export const elapsedOf = (live: LiveRun | null | undefined, now: number) =>
    (live ? Math.max(0, ((live.pausedAt ?? now) - live.t0) * live.speed) : 0);

/** Change simulation speed without jumping the clock (also while stopped). */
export function setSpeed(core: Core, speed: number, now: number): Core {
    if (!core.live || speed <= 0) return core;
    const ref = core.live.pausedAt ?? now;
    const el = elapsedOf(core.live, now);
    return { ...core, live: { ...core.live, speed, t0: ref - el / speed } };
}

// ------------------------------------------------------- marshal controls (simulated)
// התחלה / עצור / שמור. Stop = pause: the heat stays on track, clock frozen. Start resumes it.
// Save ends the heat into history (finishRun). Nothing here talks to real timing hardware.

export const isPaused = (core: Core) => !!core.live && core.live.pausedAt != null;

/** "עצור": freeze the heat on track. */
export const pauseRun = (core: Core, now: number): Core =>
    core.live && core.live.pausedAt == null ? { ...core, live: { ...core.live, pausedAt: now } } : core;

/** "התחלה" on a stopped heat: continue from where it froze. */
export function resumeRun(core: Core, now: number): Core {
    if (!core.live || core.live.pausedAt == null) return core;
    const { pausedAt, ...rest } = core.live;
    return { ...core, live: { ...rest, t0: core.live.t0 + (now - pausedAt) } };
}

export type MarshalState = 'idle' | 'running' | 'paused' | 'finished';
/** What the marshal console shows and which buttons are live. */
export function marshalState(core: Core, now: number): { state: MarshalState; heat?: Heat; target?: Heat } {
    const h = runningHeat(core);
    if (h) {
        if (allFinished(liveTiming(core, now))) return { state: 'finished', heat: h };
        return { state: isPaused(core) ? 'paused' : 'running', heat: h };
    }
    return { state: 'idle', target: calledHeat(core) ?? queueOf(core)[0] };
}

/**
 * Nameless quick start: a heat of `count` drivers created and put on track at once (timing core, cashier
 * add-on OFF). Drivers show as "נהג 1..n" until names are typed in, also during the race.
 */
export function quickStartHeat(core: Core, count: number, now: number, seed: number, speed = 1): { core: Core; heatId?: string; error?: string } {
    if (core.live) return { core, error: 'יש מקצה על המסלול' };
    const r = addTrackHeat(core, count, now);
    if (r.error || !r.heatId) return r;
    const started = startHeat(r.core, r.heatId, now, seed, speed);
    return started === r.core ? { core, error: 'לא ניתן להתחיל' } : { core: started, heatId: r.heatId };
}

/** Timing for the heat on track. The feed defaults to the simulation; a real read-only feed would be passed here. */
export function liveTiming(core: Core, now: number, feed?: TimingFeed): DriverTiming[] {
    const h = runningHeat(core);
    if (!h || !core.live) return [];
    return (feed ?? makeSimulatedFeed(core.live.seed, transponderOf(core))).snapshot(driversOf(core, h), elapsedOf(core.live, now), core.settings.laps);
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

/**
 * Low-level group constructor. The new group is ALWAYS unpaid: it cannot be planned, queued or called
 * until a cashier confirms payment. UI entry points do not call this directly; they create a pending
 * submission (submitForm / submitCashier) and markPaid turns it into a paid group.
 */
export function addGroup(core: Core, g: Omit<Group, 'id' | 'createdAt' | 'paid' | 'paidAt'>, now: number): Core {
    const size = Math.max(1, Math.min(99, Math.floor(g.size)));
    return {
        ...core,
        seq: core.seq + 1,
        groups: [...core.groups, { ...g, size, id: `g${core.seq}`, createdAt: now, paid: false }],
    };
}

/** Explicit cashier confirmation for an existing unpaid group (e.g. data saved before the payment gate). */
export const confirmGroupPaid = (core: Core, groupId: string, now: number): Core => ({
    ...core,
    groups: core.groups.map(g => (g.id === groupId && !isPaid(g) ? { ...g, paid: true, paidAt: now } : g)),
});

/**
 * Upgrade data saved by earlier versions. A group without the paid flag is paid only if a paid
 * submission produced it; anything else (e.g. an old manual add) becomes unpaid and needs confirmation.
 */
export function migrateCore(core: Core): Core {
    if (core.groups.every(g => typeof g.paid === 'boolean')) return core;
    const paidIds = new Set((core.submissions ?? []).filter(s => s.status === 'paid' && s.groupId).map(s => s.groupId));
    return { ...core, groups: core.groups.map(g => (typeof g.paid === 'boolean' ? g : { ...g, paid: paidIds.has(g.id) })) };
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
    if (!g || !isPaid(g) || !editable(core, h)) return core;
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
        laps: core.settings.laps,
        rows: ranked.map((t, i) => {
            const d = drivers.find(x => x.key === t.key)!;
            return { pos: i + 1, kart: d.kart, label: d.label, laps: t.laps, best: t.best, total: t.total };
        }),
    };
}

/** Keep history under the per-key storage budget (16 KiB), dropping the oldest. */
export function trimHistory(h: Result[], maxBytes = 14000): Result[] {
    let out = h;
    while (out.length > 1 && JSON.stringify(out).length > maxBytes) out = out.slice(0, -1);
    return out;
}

export const demoGroups: { name: string; size: number; ticket: number; keepTogether: boolean; note: string }[] = [
    { name: 'משפחת כהן (דמו)', size: 4, ticket: 0, keepTogether: true, note: '' },
    { name: 'יום הולדת (דמו)', size: 7, ticket: 1, keepTogether: true, note: '' },
    { name: 'דני ושני (דמו)', size: 2, ticket: 0, keepTogether: true, note: '' },
    { name: 'משפחת לוי (דמו)', size: 5, ticket: 1, keepTogether: true, note: '' },
    { name: 'חברים (דמו)', size: 3, ticket: 0, keepTogether: false, note: '' },
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
    // SYNTHETIC AUTO-DEMO, kept separate from real entries: it creates its own demo submissions
    // (source 'demo') and confirms payment ONLY for those. Pre-existing pending submissions are
    // never touched and stay out of the queue until a cashier confirms them.
    if (!c.groups.some(isPaid)) {
        const r = loadDemoRegistrations(c, now);
        c = r.core;
        const meta = new Map(r.ids.map((id, i) => [id, demoGroups[i]]));
        for (const id of r.ids) { const g = meta.get(id)!; c = markPaid(c, id, now, { keepTogether: g.keepTogether, ticket: c.settings.tickets[g.ticket] }); }
    }
    for (const g of oversizedGroups(c)) c = allowSplit(c, g.id);
    if (waitingGroups(c).length > 0) c = planHeats(c);
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
export function submitForm(core: Core, groupName: string, names: string[], now: number, source: 'form' | 'demo' = 'form'): { core: Core; id?: string; error?: string } {
    const gn = groupName.trim().slice(0, 40);
    const ns = names.map(x => x.trim().slice(0, 24)).filter(Boolean);
    if (!gn) return { core, error: 'חסר שם קבוצה' };
    if (ns.length === 0) return { core, error: 'צריך לפחות משתתף אחד' };
    if (ns.length > MAX_FORM_NAMES) return { core, error: `עד ${MAX_FORM_NAMES} משתתפים בטופס אחד` };
    const id = `s${core.seq}`;
    return { core: { ...core, seq: core.seq + 1, submissions: [...(core.submissions ?? []), { id, groupName: gn, names: ns, createdAt: now, status: 'pending', source }] }, id };
}

/**
 * Cashier's manual add (walk-in, no form). Creates a PENDING submission by headcount, like a form,
 * so it goes through the same explicit payment confirmation before it can reach the queue.
 */
export function submitCashier(core: Core, g: { name: string; size: number; ticket: string; keepTogether: boolean; note: string }, now: number): { core: Core; id?: string; error?: string } {
    const gn = g.name.trim().slice(0, 40);
    const size = Math.floor(g.size);
    if (!gn) return { core, error: 'חסר שם קבוצה' };
    if (!(size >= 1) || size > MAX_FORM_NAMES) return { core, error: `בין 1 ל־${MAX_FORM_NAMES} משתתפים` };
    const id = `s${core.seq}`;
    const sub: Submission = { id, groupName: gn, names: [], size, ticket: g.ticket, keepTogether: g.keepTogether, note: g.note.trim().slice(0, 80), createdAt: now, status: 'pending', source: 'cashier' };
    return { core: { ...core, seq: core.seq + 1, submissions: [...(core.submissions ?? []), sub] }, id };
}

/** Synthetic demo registrations (invented names). They arrive PENDING like real ones; nothing is paid here. */
export function loadDemoRegistrations(core: Core, now: number): { core: Core; ids: string[] } {
    let c = core; let n = 0; const ids: string[] = [];
    for (const g of demoGroups) {
        const names = Array.from({ length: g.size }, () => DEMO_NAMES[n++ % DEMO_NAMES.length]);
        const r = submitForm(c, g.name, names, now, 'demo');
        if (r.id) { c = r.core; ids.push(r.id); }
    }
    return { core: c, ids };
}

/** Size of the group a submission becomes: its names, or the cashier's headcount. */
export const submissionSize = (s: Submission) => s.names.length || s.size || 0;

/** Staff confirm payment (simulated). The group enters the waiting list for heats with its names. */
export function markPaid(core: Core, subId: string, now: number, opts: { keepTogether?: boolean; ticket?: string } = {}): Core {
    const s = (core.submissions ?? []).find(x => x.id === subId);
    if (!s || s.status !== 'pending') return core;
    const size = submissionSize(s);
    if (size < 1) return core;
    const withGroup = addGroup(core, { name: s.groupName, size, ticket: opts.ticket ?? s.ticket ?? core.settings.tickets[0] ?? '', keepTogether: opts.keepTogether ?? s.keepTogether ?? true, note: s.note ?? '' }, now);
    const g = withGroup.groups[withGroup.groups.length - 1];
    return {
        ...withGroup,
        // the explicit cashier confirmation is what sets the durable paid flag
        groups: withGroup.groups.map(x => (x.id === g.id ? { ...x, ...(s.names.length ? { names: [...s.names] } : {}), paid: true, paidAt: now } : x)),
        submissions: (core.submissions ?? []).map(x => (x.id === subId ? { ...x, status: 'paid' as const, groupId: g.id } : x)),
    };
}

/** Drop a pending submission (customer left, duplicate...). Paid ones are handled as groups. */
export const cancelSubmission = (core: Core, subId: string): Core => ({
    ...core,
    submissions: (core.submissions ?? []).map(x => (x.id === subId && x.status === 'pending' ? { ...x, status: 'cancelled' as const } : x)),
});

// ------------------------------------------------ timing core: heats without the cashier add-on
// The core system is timing: heats, call-up/live/results board with its controls, history.
// With the cashier add-on OFF, track staff create a heat directly by driver count; names and karts
// are edited afterwards. No payment concept exists in that mode. With the add-on ON this entry is
// closed, so every group must pass the cashier's payment confirmation first.

export const cashierOn = (core: Core) => core.settings.cashierEnabled === true;

/**
 * Track staff create a heat of `count` drivers straight into the queue (approved). Optional names fill
 * the drivers in order. Refused while the cashier add-on is on, or when count is outside 1..capacity.
 */
export function addTrackHeat(core: Core, count: number, now: number, names: string[] = []): { core: Core; heatId?: string; error?: string } {
    if (cashierOn(core)) return { core, error: 'תוסף הקופה פעיל: מקצים נכנסים רק דרך הקופה' };
    const n = Math.floor(count);
    if (!(n >= 1) || n > core.settings.capacity) return { core, error: `בין 1 ל־${core.settings.capacity} נהגים` };
    let c = addGroup(core, { name: 'נהג', size: n, ticket: '', keepTogether: true, note: '' }, now);
    const gid = c.groups[c.groups.length - 1].id;
    const clean = names.map(x => x.trim().slice(0, 24)).filter(Boolean).slice(0, n);
    // cleared for the track by the track staff themselves: there is no cashier in this mode
    c = { ...c, groups: c.groups.map(g => (g.id === gid ? { ...g, paid: true, paidAt: now, origin: 'track' as const, ...(clean.length ? { names: clean } : {}) } : g)) };
    c = createHeat(c);
    const heatId = c.heats[c.heats.length - 1].id;
    c = addToHeat(c, gid, heatId);
    c = approveHeat(c, heatId);
    return { core: c, heatId };
}

/** Synthetic demo for the timing core alone: a few heats of invented names, no registrations, no cashier. */
export function demoTrackSetup(core: Core, now: number, sizes: number[] = [8, 6, 10, 5]): Core {
    let c = core; let k = 0;
    for (const size of sizes) {
        const n = Math.min(size, c.settings.capacity);
        const names = Array.from({ length: n }, () => DEMO_NAMES[k++ % DEMO_NAMES.length]);
        const r = addTrackHeat(c, n, now, names);
        if (r.error) break;
        c = r.core;
    }
    return c;
}
