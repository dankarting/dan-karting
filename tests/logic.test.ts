import assert from 'node:assert/strict';
import * as L from '../src/logic';

// Tiny counted harness: each test() is one named case; the run fails (exit 1) on any failure.
let passed = 0; const failed: string[] = [];
function test(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ok   ${name}`); }
    catch (e) { failed.push(name); console.log(`  FAIL ${name}\n       ${(e as Error).message.split('\n')[0]}`); }
}

/**
 * Test setup for a group that already passed the payment gate: the low-level constructor
 * (always unpaid) followed by the explicit cashier confirmation.
 */
function addPaid(c: L.Core, g: Parameters<typeof L.addGroup>[1], now: number): L.Core {
    const n = L.addGroup(c, g, now);
    return L.confirmGroupPaid(n, n.groups[n.groups.length - 1].id, now);
}

test('planning, capacity, approve, move, simulated feed (original suite)', () => {
    let c = L.initialCore();
    L.demoGroups.forEach((g, i) => { c = addPaid(c, { ...g, ticket: c.settings.tickets[g.ticket] }, i); });
    c = L.planHeats(c);
    const cap = c.settings.capacity;
    // no heat over capacity, every person placed exactly once
    for (const h of c.heats) assert.ok(L.heatCount(h) <= cap, 'cap');
    for (const g of c.groups) if (g.id !== c.groups[5].id) assert.equal(L.assignedOf(c.heats, g.id), g.size);
    // groups that fit and want to stay together are not split
    const split = L.splitGroupIds(c.heats);
    for (const g of c.groups) if (g.size <= cap && g.keepTogether) assert.ok(!split.has(g.id), g.name);
    const big = c.groups[5]; // 12 > 10, keep together
    assert.equal(L.assignedOf(c.heats, big.id), 0, 'oversized keep-together must not be auto-split');
    assert.ok(!split.has(big.id));
    assert.deepEqual(L.oversizedGroups(c).map(g => g.id), [big.id]);
    // raising capacity fixes it
    const c12 = L.planHeats({ ...c, settings: { ...c.settings, capacity: 12 } });
    assert.equal(L.assignedOf(c12.heats, big.id), 12); assert.equal(L.oversizedGroups(c12).length, 0);
    // explicit allow-split places it in pieces
    const cs = L.planHeats(L.allowSplit(c, big.id));
    assert.equal(L.assignedOf(cs.heats, big.id), 12); assert.ok(L.splitGroupIds(cs.heats).has(big.id));
    for (const h of cs.heats) assert.ok(L.heatCount(h) <= 10);
    // capacity 14 repacks
    let c14 = L.planHeats({ ...c, settings: { ...c.settings, capacity: 14 } });
    for (const h of c14.heats) assert.ok(L.heatCount(h) <= 14);
    // approve then replan keeps approved heat
    const first = c.heats[0].id;
    c = L.approveHeat(c, first);
    const c2 = L.planHeats(c);
    assert.equal(c2.heats[0].status, 'approved');
    for (const g of c2.groups) if (g.id !== c2.groups[5].id) assert.equal(L.assignedOf(c2.heats, g.id), g.size);
    // locked group cannot be removed
    const lockedG = c2.heats[0].entries[0].groupId;
    assert.equal(L.removeGroup(c2, lockedG).groups.length, c2.groups.length);
    // move
    const d = c2.heats.filter(h => h.status === 'draft');
    if (d.length > 1) { const e = d[0].entries[0]; const m = L.moveEntry(c2, e.groupId, d[0].id, d[1].id); for (const g of m.groups) if (g.id !== m.groups[5].id) assert.equal(L.assignedOf(m.heats, g.id), g.size); }
    // simulated feed deterministic + monotonic
    const dr = L.driversOf(c2, c2.heats[0]);
    const f = L.makeSimulatedFeed(5);
    const a = f.snapshot(dr, 100000, 8), b = f.snapshot(dr, 100000, 8);
    assert.deepEqual(a, b);
    const later = f.snapshot(dr, 200000, 8);
    a.forEach((x, i) => assert.deepEqual(later[i].laps.slice(0, x.laps.length), x.laps));
    assert.ok(L.allFinished(f.snapshot(dr, 10 ** 7, 8)));
    const res = L.resultOf(c2, c2.heats[0], f.snapshot(dr, 10 ** 7, 8), 1);
    assert.equal(res.rows[0].pos, 1);
    assert.equal(L.fmt(61234), '1:01.23'); assert.equal(L.fmt(41234), '41.23'); assert.equal(L.fmt(null), '–');
    assert.ok(JSON.stringify([res, res, res, res, res]).length < 14000, 'five results fit the storage budget');
});

test('manual heats + driver names/karts (original suite)', () => {
    let m = L.initialCore();
    m = addPaid(m, { name: 'א', size: 4, ticket: '', keepTogether: true, note: '' }, 1);
    m = addPaid(m, { name: 'ב', size: 7, ticket: '', keepTogether: true, note: '' }, 2);
    m = L.createHeat(m); m = L.createHeat(m);
    assert.equal(m.heats.length, 2); assert.notEqual(m.heats[0].num, m.heats[1].num);
    const [h1, h2] = m.heats;
    m = L.addToHeat(m, 'g1', h1.id);
    assert.equal(L.heatCount(m.heats[0]), 4);
    m = L.addToHeat(m, 'g2', h1.id); // 7 > 6 free, keep-together: refused, no silent split
    assert.equal(L.heatCount(m.heats[0]), 4); assert.equal(L.assignedOf(m.heats, 'g2'), 0);
    m = L.addToHeat(m, 'g2', h2.id);
    assert.equal(L.heatCount(m.heats[1]), 7);
    // names and karts
    let hh = m.heats[0];
    assert.deepEqual(L.driversOf(m, hh).map(d => d.kart), [1, 2, 3, 4]);
    m = L.setDriver(m, h1.id, 'g1-0', { name: 'נועה', kart: 7 });
    hh = m.heats[0];
    const ds = L.driversOf(m, hh);
    assert.equal(ds[0].label, 'נועה'); assert.equal(ds[0].kart, 7); assert.ok(ds[0].kartSet);
    assert.deepEqual(ds.slice(1).map(d => d.kart), [1, 2, 3]); // suggestions skip the chosen number
    // duplicate kart blocks approval
    m = L.setDriver(m, h1.id, 'g1-1', { kart: 7 });
    assert.deepEqual(L.kartConflicts(m, m.heats[0]), [7]);
    assert.equal(L.approveHeat(m, h1.id).heats[0].status, 'draft');
    m = L.setDriver(m, h1.id, 'g1-1', { kart: 8 });
    assert.equal(L.approveHeat(m, h1.id).heats[0].status, 'approved');
    // cashier mode needs every kart chosen
    const cm = { ...m, settings: { ...m.settings, kartMode: 'cashier' as const } };
    assert.equal(L.approveHeat(cm, h1.id).heats[0].status, 'draft');
    // clearing a kart removes the override
    m = L.setDriver(m, h1.id, 'g1-1', { kart: 0 });
    assert.ok(!L.driversOf(m, m.heats[0])[1].kartSet);
    // old saved data without new fields still works
    const old = L.planHeats({ ...L.initialCore(), groups: [{ id: 'g1', name: 'x', size: 2, ticket: '', keepTogether: true, note: '', createdAt: 1, paid: true }] });
    assert.equal(L.driversOf(old, old.heats[0]).length, 2);
    // remove back to queue
    m = L.removeFromHeat(m, 'g1', h1.id);
    assert.equal(L.assignedOf(m.heats, 'g1'), 0);
});

test('queue + call-up (original suite)', () => {
    let q = L.initialCore();
    q = addPaid(q, { name: 'א', size: 3, ticket: '', keepTogether: true, note: '' }, 1);
    q = addPaid(q, { name: 'ב', size: 2, ticket: '', keepTogether: true, note: '' }, 2);
    q = L.createHeat(q); q = L.createHeat(q);
    q = L.addToHeat(q, 'g1', q.heats[0].id); q = L.addToHeat(q, 'g2', q.heats[1].id);
    assert.equal(L.screenState(q, null).state, 'empty'); // drafts are not in the queue
    q = L.approveHeat(q, q.heats[1].id); q = L.approveHeat(q, q.heats[0].id);
    assert.deepEqual(L.queueOf(q).map(h => h.num), [q.heats[0].num, q.heats[1].num]);
    assert.equal(L.screenState(q, null).state, 'next'); assert.equal(L.screenState(q, null).heat!.id, q.heats[0].id);
    q = L.callHeat(q, q.heats[1].id);
    assert.equal(L.screenState(q, null).state, 'call'); assert.equal(L.screenState(q, null).heat!.id, q.heats[1].id);
    assert.equal(L.callHeat(q, q.heats[0].id), q); // only one called at a time
    assert.equal(L.screenState(q, q.heats[0].id).state, 'race');
    q = L.unapproveHeat(q, q.heats[1].id); assert.ok(!L.calledHeat(q));
});

// ---------------------------------------------------------------- new: end-to-end demo flow
/** Two small groups, each in its own approved heat. */
function twoQueued() {
    let q = L.initialCore();
    q = addPaid(q, { name: 'א', size: 3, ticket: '', keepTogether: true, note: '' }, 1);
    q = addPaid(q, { name: 'ב', size: 2, ticket: '', keepTogether: true, note: '' }, 2);
    q = addPaid(q, { name: 'ג', size: 4, ticket: '', keepTogether: true, note: '' }, 3);
    q = L.createHeat(q); q = L.createHeat(q);
    q = L.addToHeat(q, 'g1', q.heats[0].id); q = L.addToHeat(q, 'g2', q.heats[1].id);
    q = L.approveHeat(q, q.heats[0].id); q = L.approveHeat(q, q.heats[1].id);
    return q;
}

test('queue -> call -> start -> live -> finish -> next heat on screen', () => {
    let q = twoQueued();
    const [h1, h2] = q.heats;
    q = L.callHeat(q, h1.id);
    assert.equal(L.screenState(q).state, 'call');
    q = L.startHeat(q, h1.id, 1_000, 42, 20);
    assert.equal(q.live?.heatId, h1.id);
    assert.equal(L.screenState(q).state, 'race');
    assert.ok(!q.heats[0].called, 'start clears the call flag');
    assert.deepEqual(L.queueOf(q).map(h => h.id), [h2.id], 'heat on track leaves the queue');
    // next heat may be called while the first is racing; screen still shows the race
    q = L.callHeat(q, h2.id);
    assert.equal(L.calledHeat(q)?.id, h2.id);
    assert.equal(L.screenState(q).state, 'race');
    // timing advances with speed and ends
    const mid = L.liveTiming(q, 1_000 + 5_000);
    assert.equal(mid.length, 3);
    assert.ok(!L.allFinished(mid));
    const end = 1_000 + 10 ** 6;
    assert.ok(L.allFinished(L.liveTiming(q, end)));
    const { core: after, result } = L.finishRun(q, end);
    assert.ok(result && result.rows.length === 3 && result.simulated && result.heatNum === h1.num);
    assert.equal(after.live, null);
    assert.equal(after.heats.find(h => h.id === h1.id)!.status, 'done');
    const sc = L.screenState(after);
    assert.equal(sc.state, 'call'); assert.equal(sc.heat!.id, h2.id);
});

test('only one heat on track; blockers stop a start', () => {
    let q = twoQueued();
    const [h1, h2] = q.heats;
    q = L.startHeat(q, h1.id, 0, 1);
    assert.equal(L.startHeat(q, h2.id, 0, 1), q, 'second start refused');
    assert.ok(L.startBlockers(q, h2).includes('מקצה אחר על המסלול'));
    assert.equal(L.callHeat(q, h1.id), q, 'heat on track cannot be called');
    assert.equal(L.unapproveHeat(q, h1.id), q, 'heat on track cannot be unapproved');
    q = L.cancelRun(q);
    assert.equal(q.live, null);
    assert.deepEqual(L.queueOf(q).map(h => h.id), [h1.id, h2.id], 'cancelled heat back in queue');
    // kart clash on an approved heat blocks start (kart edits do not un-approve)
    q = L.setDriver(q, h2.id, 'g2-0', { kart: 5 }); q = L.setDriver(q, h2.id, 'g2-1', { kart: 5 });
    assert.equal(q.heats[1].status, 'approved');
    assert.deepEqual(L.startBlockers(q, q.heats[1]), ['קארט כפול']);
    assert.equal(L.startHeat(q, h2.id, 0, 1), q);
    assert.equal(L.startHeat(q, 'nope', 0, 1), q);
});

test('speed change keeps the simulated clock continuous', () => {
    let q = L.startHeat(twoQueued(), 'h1', 0, 7, 5);
    const before = L.elapsedOf(q.live, 10_000);
    q = L.setSpeed(q, 20, 10_000);
    assert.equal(L.elapsedOf(q.live, 10_000), before);
    assert.equal(L.elapsedOf(q.live, 11_000), before + 20_000);
    assert.equal(L.setSpeed(L.cancelRun(q), 5, 0).live, null);
});

test('cashier override: edit an approved/called heat in the queue', () => {
    let q = twoQueued();
    const [h1, h2] = q.heats;
    q = L.callHeat(q, h1.id);
    // add a waiting group into the called heat: stays approved and called
    q = L.addToHeat(q, 'g3', h1.id);
    assert.equal(L.heatCount(q.heats[0]), 7);
    assert.equal(q.heats[0].status, 'approved'); assert.ok(q.heats[0].called);
    assert.equal(L.screenState(q).heat!.id, h1.id);
    assert.equal(L.driversOf(q, q.heats[0]).length, 7, 'call screen sees the new drivers');
    // move a group between approved heats when it fits
    q = L.moveEntry(q, 'g3', h1.id, h2.id);
    assert.equal(L.heatCount(q.heats[0]), 3); assert.equal(L.heatCount(q.heats[1]), 6);
    // move refused when the approved target would go over capacity
    const tight = { ...q, settings: { ...q.settings, capacity: 8 } };
    assert.equal(L.moveEntry(tight, 'g1', h1.id, h2.id), tight);
    // removing the last group empties the heat: it drops back to draft and out of the queue
    q = L.removeFromHeat(q, 'g1', h1.id);
    assert.equal(q.heats[0].status, 'draft'); assert.ok(!q.heats[0].called);
    assert.deepEqual(L.queueOf(q).map(h => h.id), [h2.id]);
    // the heat on track is locked
    q = L.startHeat(q, h2.id, 0, 1);
    assert.equal(L.removeFromHeat(q, 'g2', h2.id), q);
    assert.equal(L.addToHeat(q, 'g1', h2.id), q);
});

test('cashier kart mode: adding drivers without karts to an approved heat un-approves it', () => {
    let q = twoQueued();
    q = { ...q, settings: { ...q.settings, kartMode: 'cashier' } };
    q = L.addToHeat(q, 'g3', q.heats[0].id);
    assert.equal(q.heats[0].status, 'draft');
});

test('moving a group carries its driver names and karts', () => {
    let m = L.initialCore();
    m = addPaid(m, { name: 'א', size: 2, ticket: '', keepTogether: true, note: '' }, 1);
    m = addPaid(m, { name: 'ב', size: 2, ticket: '', keepTogether: false, note: '' }, 2);
    m = L.createHeat(m); m = L.createHeat(m);
    const [a, b] = m.heats;
    m = L.addToHeat(m, 'g1', a.id); m = L.addToHeat(m, 'g2', b.id);
    m = L.setDriver(m, a.id, 'g1-1', { name: 'רון', kart: 9 });
    m = L.moveEntry(m, 'g1', a.id, b.id);
    const ds = L.driversOf(m, m.heats[1]);
    const ron = ds.find(d => d.label === 'רון');
    assert.ok(ron && ron.kart === 9 && ron.kartSet);
    assert.deepEqual(m.heats[0].drivers, {}, 'source keeps no orphan edits');
    // merging into a heat that already holds part of the same group re-keys after the existing drivers
    let s2 = L.initialCore();
    s2 = addPaid(s2, { name: 'ג', size: 4, ticket: '', keepTogether: false, note: '' }, 1);
    s2 = { ...s2, settings: { ...s2.settings, capacity: 2 } };
    s2 = L.planHeats(s2);
    assert.equal(s2.heats.length, 2);
    s2 = L.setDriver(s2, s2.heats[1].id, 'g1-0', { name: 'דנה' });
    s2 = { ...s2, settings: { ...s2.settings, capacity: 10 } };
    s2 = L.moveEntry(s2, 'g1', s2.heats[1].id, s2.heats[0].id);
    assert.equal(L.driversOf(s2, s2.heats[0])[2].label, 'דנה');
});

test('capacity 10 vs 14 stays a setting; lowering it flags approved heats', () => {
    assert.deepEqual(L.CAPACITY_OPTIONS, [10, 14]);
    assert.equal(L.initialCore().settings.capacity, 10);
    let q = L.initialCore();
    q = { ...q, settings: { ...q.settings, capacity: 14 } };
    q = addPaid(q, { name: 'גדולה', size: 13, ticket: '', keepTogether: true, note: '' }, 1);
    q = L.planHeats(q);
    assert.equal(q.heats.length, 1);
    q = L.approveHeat(q, q.heats[0].id);
    assert.equal(q.heats[0].status, 'approved');
    const back = { ...q, settings: { ...q.settings, capacity: 10 } };
    assert.ok(L.startBlockers(back, back.heats[0]).some(x => x.startsWith('מעל הקיבולת')));
});

test('old saved data: migrated, an unpaid legacy group stays out until the cashier confirms', () => {
    // saved before the payment gate: no paid flag, no live/called fields, no submissions
    const saved = { settings: { capacity: 10, laps: 8, tickets: ['x'] }, groups: [{ id: 'g1', name: 'x', size: 2, ticket: '', keepTogether: true, note: '', createdAt: 1 }], heats: [{ id: 'h1', num: 1, status: 'approved' as const, entries: [{ groupId: 'g1', count: 2 }] }], nextHeatNum: 2, seq: 2 };
    let old = L.migrateCore(saved);
    assert.equal(old.groups[0].paid, false);
    assert.equal(L.screenState(old).state, 'empty', 'unpaid legacy heat is not shown on the call-up screen');
    assert.equal(L.startHeat(old, 'h1', 0, 3), old);
    assert.equal(L.runningHeat(old), undefined);
    old = L.confirmGroupPaid(old, 'g1', 5);
    assert.equal(L.screenState(old).state, 'next');
    const s = L.startHeat(old, 'h1', 0, 3);
    assert.equal(L.screenState(s).state, 'race');
    // a legacy group produced by a paid submission is migrated as paid
    const viaForm = L.migrateCore({ ...saved, submissions: [{ id: 's9', groupName: 'x', names: ['a', 'b'], createdAt: 1, status: 'paid' as const, groupId: 'g1' }] });
    assert.equal(viaForm.groups[0].paid, true);
    assert.equal(L.migrateCore(viaForm), viaForm, 'already migrated: unchanged');
});

test('race clock freezes at the last finisher', () => {
    let q = L.startHeat(twoQueued(), 'h1', 0, 9, 1);
    const late = L.liveTiming(q, 10 ** 7);
    const last = Math.max(...late.map(r => r.total));
    assert.equal(L.raceClock(late, 10 ** 7), last);
    const early = L.liveTiming(q, 1000);
    assert.equal(L.raceClock(early, 1000), 1000);
});

test('timing seam: passings -> laps (debounce, unsorted, unknown transponders, rolling start)', () => {
    const ds = [{ key: 'a', kart: 1, label: 'A', groupId: 'g', kartSet: true, nameSet: false }, { key: 'b', kart: 2, label: 'B', groupId: 'g', kartSet: true, nameSet: false }];
    const ps: L.Passing[] = [
        { transponder: 'SIM-1', t: 1000 + 80000 }, { transponder: 'SIM-1', t: 1000 + 40000 }, { transponder: 'SIM-1', t: 1000 + 40500 }, // double read
        { transponder: 'SIM-2', t: 1000 + 42000 }, { transponder: 'X-99', t: 5000 }, { transponder: 'SIM-1', t: 10 }, // before start
    ];
    const r = L.lapsFromPassings(ds, ps, 1000, 2);
    assert.deepEqual(r[0].laps, [40000, 40000]); assert.ok(r[0].finished); assert.equal(r[0].total, 80000);
    assert.deepEqual(r[1].laps, [42000]);
    assert.deepEqual(L.unknownTransponders(ds, ps), ['X-99']);
    const rolling = L.lapsFromPassings(ds, ps, 1000, 5, L.simTransponder, { minLapMs: 15000, firstCrossing: 'start' });
    assert.deepEqual(rolling[0].laps, [40000]);
    // custom kart -> transponder mapping
    const mapped = L.lapsFromPassings(ds, [{ transponder: 'T7', t: 41000 }], 1000, 2, k => (k === 1 ? 'T7' : 'none'));
    assert.deepEqual(mapped[0].laps, [40000]);
    // a decoder-shaped feed gives the same result as the pure function
    assert.deepEqual(L.makePassingFeed(() => ps, 1000).snapshot(ds, 0, 2), r);
});

test('vision demo: one-click setup, synthetic names, sectors, countdown', () => {
    let c = L.demoSetup(L.initialCore(), 1);
    const q = L.queueOf(c);
    assert.ok(q.length >= 4, 'all heats approved into the queue');
    assert.equal(c.groups.filter(g => L.unassignedOf(c, g) > 0).length, 0, 'everyone placed');
    for (const h of q) for (const d of L.driversOf(c, h)) assert.ok(d.nameSet && L.DEMO_NAMES.includes(d.label));
    assert.equal(L.demoSetup(c, 2).groups.length, c.groups.length, 'idempotent: no duplicate groups');
    const [s1, s2, s3] = L.sectorsOf(41234, 9, 2, 3);
    assert.equal(s1 + s2 + s3, 41234); assert.ok(s1 > 0 && s2 > 0 && s3 > 0);
    assert.deepEqual(L.sectorsOf(41234, 9, 2, 3), [s1, s2, s3]);
    c = L.startHeat(c, q[0].id, 0, 4, 1);
    const early = L.liveTiming(c, 60_000);
    assert.ok(L.estRemaining(early, 60_000, c.settings.laps) > 0);
    assert.equal(L.estRemaining(L.liveTiming(c, 10 ** 7), 10 ** 7, c.settings.laps), 0);
});

test('customer form -> waits for payment -> paid enters the queue with its names', () => {
    let c = L.initialCore();
    assert.equal(L.submitForm(c, '  ', ['א'], 1).error, 'חסר שם קבוצה');
    assert.equal(L.submitForm(c, 'קבוצה', [' ', ''], 1).error, 'צריך לפחות משתתף אחד');
    let r = L.submitForm(c, ' החבר׳ה ', ['דנה', ' ', 'רון', 'מאיה'], 5);
    assert.ok(r.id && !r.error); c = r.core;
    assert.deepEqual(L.pendingOf(c).map(s => s.names), [['דנה', 'רון', 'מאיה']], 'blank rows dropped');
    // pending is NOT in the queue: no group, nothing to plan
    assert.equal(c.groups.length, 0);
    assert.equal(L.planHeats(c).heats.length, 0);
    r = L.submitForm(c, 'ביטול', ['x'], 6); c = L.cancelSubmission(r.core, r.id!);
    assert.equal(L.pendingOf(c).length, 1);
    // staff confirm payment (simulated)
    const subId = L.pendingOf(c)[0].id;
    c = L.markPaid(c, subId, 7);
    assert.equal(L.markPaid(c, subId, 8), c, 'paying twice does nothing');
    assert.equal(L.pendingOf(c).length, 0);
    assert.equal(c.groups.length, 1);
    const g = c.groups[0];
    assert.equal(g.name, 'החבר׳ה'); assert.equal(g.size, 3); assert.equal(L.unassignedOf(c, g), 3);
    // cashier composes heats; driver labels come from the form
    c = L.planHeats(c);
    assert.deepEqual(L.driversOf(c, c.heats[0]).map(d => d.label), ['דנה', 'רון', 'מאיה']);
    assert.ok(L.driversOf(c, c.heats[0]).every(d => d.nameSet));
    // fillDemoNames never overwrites form names; cashier edit still wins
    assert.deepEqual(L.driversOf(L.fillDemoNames(c), c.heats[0]).map(d => d.label), ['דנה', 'רון', 'מאיה']);
    c = L.setDriver(c, c.heats[0].id, `${g.id}-1`, { name: 'רוני' });
    assert.equal(L.driversOf(c, c.heats[0])[1].label, 'רוני');
});

test('form names continue across heats when a paid group is split', () => {
    let c = L.initialCore();
    c = { ...c, settings: { ...c.settings, capacity: 2 } };
    const r = L.submitForm(c, 'גדולה', ['א1', 'א2', 'א3', 'א4', 'א5'], 1);
    c = L.markPaid(r.core, r.id!, 1, { keepTogether: false });
    c = L.planHeats(c);
    assert.deepEqual(c.heats.map(h => L.driversOf(c, h).map(d => d.label)), [['א1', 'א2'], ['א3', 'א4'], ['א5']]);
});

test('payment gate: cashier manual add is pending; unpaid never reaches heat composition or call-up', () => {
    let c = L.initialCore();
    assert.equal(L.submitCashier(c, { name: ' ', size: 3, ticket: '', keepTogether: true, note: '' }, 1).error, 'חסר שם קבוצה');
    const r = L.submitCashier(c, { name: 'הליכה מהרחוב', size: 3, ticket: 'קארטינג', keepTogether: true, note: 'בלי טופס' }, 1);
    c = r.core;
    assert.equal(L.pendingOf(c).length, 1); assert.equal(L.pendingOf(c)[0].source, 'cashier');
    assert.equal(c.groups.length, 0, 'manual add does not create a queued group');
    assert.equal(L.planHeats(c).heats.length, 0);
    // the low-level constructor is unpaid and excluded everywhere downstream
    c = L.addGroup(c, { name: 'לא שולם', size: 4, ticket: '', keepTogether: true, note: '' }, 2);
    const unpaid = c.groups[0];
    assert.equal(unpaid.paid, false);
    assert.deepEqual(L.waitingGroups(c), []);
    assert.equal(L.planHeats(c).heats.length, 0, 'planHeats skips unpaid');
    c = L.createHeat(c);
    const hid = c.heats[0].id;
    assert.equal(L.addToHeat(c, unpaid.id, hid), c, 'manual heat composition refuses unpaid');
    // even if an unpaid entry got into a heat (corrupted/legacy data), it cannot be approved, queued, called or started
    const forced: L.Core = { ...c, heats: [{ ...c.heats[0], entries: [{ groupId: unpaid.id, count: 4 }] }] };
    assert.equal(L.approveHeat(forced, hid).heats[0].status, 'draft');
    const asApproved: L.Core = { ...forced, heats: [{ ...forced.heats[0], status: 'approved' }] };
    assert.deepEqual(L.queueOf(asApproved), []);
    assert.equal(L.callHeat(asApproved, hid), asApproved);
    assert.equal(L.screenState(asApproved).state, 'empty');
    assert.equal(L.startHeat(asApproved, hid, 0, 1), asApproved);
    assert.ok(L.startBlockers(asApproved, asApproved.heats[0]).includes('קבוצה שלא אושר לה תשלום'));
    // explicit confirmation opens the gate
    const paidNow = L.confirmGroupPaid(asApproved, unpaid.id, 9);
    assert.equal(L.queueOf(paidNow).length, 1);
    assert.equal(L.screenState(L.callHeat(paidNow, hid)).state, 'call');
    // paying the manual submission gives a paid group by headcount with its cashier choices
    c = L.markPaid(c, r.id!, 10);
    const g = c.groups.find(x => x.name === 'הליכה מהרחוב')!;
    assert.ok(g.paid && g.size === 3 && g.ticket === 'קארטינג' && g.note === 'בלי טופס' && !g.names);
    c = L.planHeats(c);
    assert.equal(c.heats.filter(h => h.entries.some(e => e.groupId === unpaid.id)).length, 0, 'unpaid still excluded after planning');
    assert.ok(c.heats.some(h => h.entries.some(e => e.groupId === g.id)));
});

test('payment gate: an unpaid form submission is excluded end to end (queue, heats, call-up)', () => {
    let c = L.initialCore();
    c = L.submitForm(c, 'ממתינים', ['רון', 'דנה'], 1).core;
    c = L.planHeats(c);
    c = L.createHeat(c);
    for (const h of c.heats) c = L.approveHeat(c, h.id);
    assert.deepEqual(L.queueOf(c), []);
    assert.equal(L.screenState(c).state, 'empty');
    const names = c.heats.flatMap(h => L.driversOf(c, h).map(d => d.label));
    assert.ok(!names.includes('רון'));
});

test('auto-demo is separate: it never pays or queues pre-existing pending submissions', () => {
    let c = L.initialCore();
    c = L.submitForm(c, 'לקוחות אמיתיים', ['זיו', 'עדן'], 1).core;
    const before = L.pendingOf(c)[0];
    c = L.demoSetup(c, 2);
    const after = (c.submissions ?? []).find(s => s.id === before.id)!;
    assert.equal(after.status, 'pending', 'pre-existing pending submission untouched');
    assert.ok(!c.groups.some(g => g.name === 'לקוחות אמיתיים'));
    const labels = c.heats.flatMap(h => L.driversOf(c, h).map(d => d.label));
    assert.ok(!labels.includes('זיו') && !labels.includes('עדן'));
    assert.ok((c.submissions ?? []).filter(s => s.source === 'demo').every(s => s.status === 'paid'), 'only demo submissions were confirmed');
    assert.ok(L.queueOf(c).length >= 4);
    // the cashier's "load demo" path only creates PENDING demo registrations
    const loaded = L.loadDemoRegistrations(L.initialCore(), 3);
    assert.equal(loaded.core.groups.length, 0);
    assert.ok(L.pendingOf(loaded.core).length === L.demoGroups.length && L.pendingOf(loaded.core).every(s => s.source === 'demo'));
});

test('timing core runs without the cashier: track heat -> call -> start -> results -> next', () => {
    let c = L.initialCore();
    assert.equal(L.cashierOn(c), false, 'cashier add-on is off by default');
    let r = L.addTrackHeat(c, 3, 1, ['רון', '', 'דנה']);
    assert.ok(r.heatId && !r.error); c = r.core;
    r = L.addTrackHeat(c, 2, 2); c = r.core;
    assert.deepEqual(c.submissions ?? [], [], 'no registrations involved');
    const [h1, h2] = L.queueOf(c);
    assert.ok(h1 && h2, 'both heats are queued');
    assert.deepEqual(L.driversOf(c, h1).map(d => d.label), ['רון', 'דנה', 'נהג 3']);
    c = L.callHeat(c, h1.id);
    assert.equal(L.screenState(c).state, 'call');
    c = L.startHeat(c, h1.id, 0, 7, 20);
    assert.equal(L.screenState(c).state, 'race');
    const { core: after, result } = L.finishRun(c, 10 ** 7);
    assert.ok(result && result.rows.length === 3);
    assert.equal(L.screenState(after).state, 'next');
    assert.equal(L.screenState(after).heat!.id, h2.id);
    assert.equal(L.addTrackHeat(after, 0, 3).error, `בין 1 ל־10 נהגים`);
    assert.ok(L.addTrackHeat(after, 11, 3).error);
});

test('cashier add-on ON closes the track entry, so the payment gate cannot be bypassed', () => {
    let c: L.Core = { ...L.initialCore(), settings: { ...L.initialCore().settings, cashierEnabled: true } };
    const r = L.addTrackHeat(c, 4, 1);
    assert.ok(r.error); assert.equal(r.core, c);
    assert.equal(L.demoTrackSetup(c, 1), c, 'core demo adds nothing while the cashier is on');
    // the cashier path still gates: pending registration never reaches the queue until paid
    c = L.submitCashier(c, { name: 'קבוצה', size: 4, ticket: '', keepTogether: true, note: '' }, 2).core;
    c = L.planHeats(c);
    assert.deepEqual(L.queueOf(c), []);
    c = L.markPaid(c, L.pendingOf(c)[0].id, 3);
    c = L.planHeats(c);
    for (const h of c.heats) c = L.approveHeat(c, h.id);
    assert.equal(L.queueOf(c).length, 1);
});

test('core demo: synthetic heats without registrations', () => {
    const c = L.demoTrackSetup(L.initialCore(), 1);
    assert.equal(L.queueOf(c).length, 4);
    assert.deepEqual(c.submissions ?? [], []);
    for (const h of L.queueOf(c)) for (const d of L.driversOf(c, h)) assert.ok(L.DEMO_NAMES.includes(d.label));
});

test('marshal controls: start, stop (pause) freezes the clock, start resumes, save goes to history', () => {
    let c = L.addTrackHeat(L.initialCore(), 4, 1).core;
    assert.equal(L.marshalState(c, 0).state, 'idle');
    const h = L.marshalState(c, 0).target!;
    c = L.startHeat(c, h.id, 0, 3, 1);
    assert.equal(L.marshalState(c, 1000).state, 'running');
    c = L.pauseRun(c, 50_000);
    assert.equal(L.marshalState(c, 60_000).state, 'paused');
    assert.equal(L.elapsedOf(c.live, 90_000), 50_000, 'clock frozen while stopped');
    const frozen = L.liveTiming(c, 50_000);
    assert.deepEqual(L.liveTiming(c, 500_000), frozen, 'no laps are added while stopped');
    assert.equal(L.pauseRun(c, 70_000), c, 'stopping twice does nothing');
    c = L.setSpeed(c, 5, 80_000);
    assert.equal(L.elapsedOf(c.live, 80_000), 50_000, 'speed change while stopped keeps the clock');
    c = L.resumeRun(c, 100_000);
    assert.equal(L.marshalState(c, 100_000).state, 'running');
    assert.equal(L.elapsedOf(c.live, 101_000), 55_000, 'resumes from 50 s at the new speed');
    const paused = L.pauseRun(c, 101_000);
    const { core: saved, result } = L.finishRun(paused, 999_999);
    assert.ok(result && result.rows.length === 4, 'saving while stopped records the frozen state');
    assert.equal(result!.rows.reduce((m, r) => Math.max(m, r.laps.length), 0), L.liveTiming(paused, 0).reduce((m, t) => Math.max(m, t.laps.length), 0));
    assert.equal(saved.live, null);
    assert.equal(L.marshalState(L.startHeat(L.addTrackHeat(L.initialCore(), 2, 1).core, 'h1', 0, 1, 1), 10 ** 8).state, 'finished');
});

test('nameless quick start: heat created and on track at once; names can be added during the race', () => {
    let r = L.quickStartHeat(L.initialCore(), 5, 1, 9, 1);
    assert.ok(r.heatId && !r.error);
    let c = r.core;
    assert.equal(L.marshalState(c, 2).state, 'running');
    const h = L.runningHeat(c)!;
    assert.deepEqual(L.driversOf(c, h).map(d => d.label), ['נהג 1', 'נהג 2', 'נהג 3', 'נהג 4', 'נהג 5']);
    c = L.setDriver(c, h.id, L.driversOf(c, h)[2].key, { name: 'שירן' });
    assert.equal(L.driversOf(c, L.runningHeat(c)!)[2].label, 'שירן', 'rename during the race');
    assert.ok(L.quickStartHeat(c, 3, 3, 1).error, 'not while another heat is on track');
    const on: L.Core = { ...L.initialCore(), settings: { ...L.initialCore().settings, cashierEnabled: true } };
    assert.ok(L.quickStartHeat(on, 3, 1, 1).error, 'closed while the cashier add-on is on (payment gate)');
});

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
