import assert from 'node:assert/strict';
import * as L from '../src/logic';
import * as R from '../src/rentix';

// Tiny counted harness: each test() is one named case; the run fails (exit 1) on any failure.
let passed = 0; const failed: string[] = [];
function test(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ok   ${name}`); }
    catch (e) { failed.push(name); console.log(`  FAIL ${name}\n       ${(e as Error).message.split('\n')[0]}`); }
}

test('planning, capacity, approve, move, simulated feed (original suite)', () => {
    let c = L.initialCore();
    L.demoGroups.forEach((g, i) => { c = L.addGroup(c, { ...g, ticket: c.settings.tickets[g.ticket] }, i); });
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
    m = L.addGroup(m, { name: 'א', size: 4, ticket: '', keepTogether: true, note: '' }, 1);
    m = L.addGroup(m, { name: 'ב', size: 7, ticket: '', keepTogether: true, note: '' }, 2);
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
    const old = L.planHeats({ ...L.initialCore(), groups: [{ id: 'g1', name: 'x', size: 2, ticket: '', keepTogether: true, note: '', createdAt: 1 }] });
    assert.equal(L.driversOf(old, old.heats[0]).length, 2);
    // remove back to queue
    m = L.removeFromHeat(m, 'g1', h1.id);
    assert.equal(L.assignedOf(m.heats, 'g1'), 0);
});

test('queue + call-up (original suite)', () => {
    let q = L.initialCore();
    q = L.addGroup(q, { name: 'א', size: 3, ticket: '', keepTogether: true, note: '' }, 1);
    q = L.addGroup(q, { name: 'ב', size: 2, ticket: '', keepTogether: true, note: '' }, 2);
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
    q = L.addGroup(q, { name: 'א', size: 3, ticket: '', keepTogether: true, note: '' }, 1);
    q = L.addGroup(q, { name: 'ב', size: 2, ticket: '', keepTogether: true, note: '' }, 2);
    q = L.addGroup(q, { name: 'ג', size: 4, ticket: '', keepTogether: true, note: '' }, 3);
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
    assert.ok(!L.allFinished(L.liveTiming(q, end)), 'a timed heat never ends by itself: staff stop it');
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
    m = L.addGroup(m, { name: 'א', size: 2, ticket: '', keepTogether: true, note: '' }, 1);
    m = L.addGroup(m, { name: 'ב', size: 2, ticket: '', keepTogether: false, note: '' }, 2);
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
    s2 = L.addGroup(s2, { name: 'ג', size: 4, ticket: '', keepTogether: false, note: '' }, 1);
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
    q = L.addGroup(q, { name: 'גדולה', size: 13, ticket: '', keepTogether: true, note: '' }, 1);
    q = L.planHeats(q);
    assert.equal(q.heats.length, 1);
    q = L.approveHeat(q, q.heats[0].id);
    assert.equal(q.heats[0].status, 'approved');
    const back = { ...q, settings: { ...q.settings, capacity: 10 } };
    assert.ok(L.startBlockers(back, back.heats[0]).some(x => x.startsWith('מעל הקיבולת')));
});

test('old saved data without live/called fields still works', () => {
    const old = { settings: { capacity: 10, laps: 8, tickets: ['x'] }, groups: [{ id: 'g1', name: 'x', size: 2, ticket: '', keepTogether: true, note: '', createdAt: 1 }], heats: [{ id: 'h1', num: 1, status: 'approved' as const, entries: [{ groupId: 'g1', count: 2 }] }], nextHeatNum: 2, seq: 2 };
    assert.equal(L.screenState(old).state, 'next');
    assert.equal(L.runningHeat(old), undefined);
    const s = L.startHeat(old, 'h1', 0, 3);
    assert.equal(L.screenState(s).state, 'race');
});

test('race clock keeps running until staff stop a timed heat', () => {
    let q = L.startHeat(twoQueued(), 'h1', 0, 9, 1);
    const late = L.liveTiming(q, 10 ** 7);
    assert.equal(L.raceClock(late, 10 ** 7), 10 ** 7);
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

test('timed heat: default 10 min, 20 possible, min 10; ends after the lap in progress when time is up', () => {
    let q = twoQueued();
    const h1 = q.heats[0];
    assert.equal(L.heatMinutesOf(q), 10, 'default 10 minutes');
    assert.equal(L.heatMinutesOf({ ...q, settings: { ...q.settings, heatMinutes: 5 } }), 10, '10 is the minimum');
    q = { ...q, settings: { ...q.settings, heatMinutes: 20 } };
    q = L.startHeat(q, h1.id, 0, 7, 1);
    assert.equal(q.live?.durationMs, 20 * 60_000, 'duration fixed at start');
    assert.equal(L.timeLeft(q.live, 60_000), 19 * 60_000);
    // changing the setting during the heat does not change the running heat
    const q2 = { ...q, settings: { ...q.settings, heatMinutes: 10 } };
    assert.equal(L.timeLeft(q2.live, 60_000), 19 * 60_000);
    const atEnd = L.liveTiming(q, 20 * 60_000 - 1);
    assert.ok(!L.allFinished(atEnd), 'not finished before the clock runs out');
    assert.equal(L.timeLeft(q.live, 21 * 60_000), 0);
    assert.ok(!L.isLastLap(q.live, 19 * 60_000 + 29_000), 'no last-lap call before 30 s to go');
    assert.ok(L.isLastLap(q.live, 19 * 60_000 + 30_000), 'last-lap call at 19:30 of 20 minutes');
    const after = L.liveTiming(q, 22 * 60_000);
    assert.ok(!L.allFinished(after), 'time up does not stop the heat: staff stop it');
    assert.ok(after.some(r => r.total > 20 * 60_000 + 60_000), 'karts keep lapping after the clock ran out');
    assert.ok(after[0].laps.length > 8, 'a 20 minute heat is not capped at the old lap count');
    const { result } = L.finishRun(q, 22 * 60_000);
    assert.equal(result?.minutes, 20);
});

test('four ticket types: ליגה/מאסטר (fast) never share a heat with regular karts, unless family; heats build on payment', () => {
    let c = L.initialCore();
    c = { ...c, groups: [], submissions: [] };
    assert.deepEqual(c.settings.tickets, ['רגיל', 'זוגי', 'ליגה', 'מאסטר']);
    const pay = (name: string, n: number, ticket: string, family = false) => {
        const r = L.submitForm(c, name, Array.from({ length: n }, (_, i) => `${name}${i}`), 1);
        c = L.markPaidAndPlan(r.core, r.id!, 2, { ticket, family });
    };
    pay('רגיל', 3, 'רגיל');
    assert.equal(c.heats.length, 1, 'a heat is suggested as soon as a group pays');
    pay('ליגה', 3, 'ליגה');
    assert.equal(c.heats.length, 2, 'fast group goes to its own heat although there is room');
    pay('זוג', 2, 'זוגי');
    pay('מאסטר', 2, 'מאסטר');
    for (const h of c.heats) assert.ok(!L.mixesClasses(c, h), `heat ${h.num} mixes classes`);
    assert.equal(c.heats.length, 2);
    // a family may join either class
    pay('משפחה', 2, 'ליגה', true);
    assert.equal(c.heats.length, 2, 'family fits into an existing heat');
    // manual mixing is blocked from approval and start
    const fastG = c.groups.find(g => g.name === 'ליגה')!;
    const regHeat = c.heats.find(h => h.entries.some(e => c.groups.find(g => g.id === e.groupId)?.name === 'רגיל'))!;
    const mixed = { ...c, heats: c.heats.map(h => (h.id === regHeat.id ? { ...h, entries: [...h.entries, { groupId: fastG.id, count: 1 }] } : h)) };
    const mh = mixed.heats.find(h => h.id === regHeat.id)!;
    assert.ok(L.mixesClasses(mixed, mh));
    assert.equal(L.approveHeat(mixed, mh.id).heats.find(h => h.id === mh.id)!.status, 'draft');
    // old saved tickets migrate to the four types
    const old = { ...c, settings: { ...c.settings, tickets: ['קארטינג', 'כרטיס משולב'], fastTickets: undefined } };
    assert.deepEqual(L.migrateTickets(old).settings.tickets, ['רגיל', 'זוגי', 'ליגה', 'מאסטר']);
});

test('ticket per participant in the form; price total; mixed non-family registration splits by kart class', () => {
    let c = L.initialCore();
    c = { ...c, groups: [], submissions: [], settings: { ...c.settings, prices: { 'רגיל': 100, 'ליגה': 150 } } };
    const r = L.submitForm(c, 'חברים', ['א', ' ', 'ב', 'ג'], 1, ['רגיל', 'מאסטר', 'ליגה', 'רגיל']);
    const sub = r.core.submissions![0];
    assert.deepEqual(sub.names, ['א', 'ב', 'ג']);
    assert.deepEqual(sub.tickets, ['רגיל', 'ליגה', 'רגיל'], 'tickets follow the names when a blank row is dropped');
    assert.deepEqual(L.priceOf(r.core, sub.tickets!), { total: 350, missing: [] });
    assert.deepEqual(L.priceOf(r.core, ['זוגי']).missing, ['זוגי']);
    // not family -> two groups, never in the same heat
    let p = L.markPaidAndPlan(r.core, r.id!, 2);
    assert.equal(p.groups.length, 2);
    assert.deepEqual(p.groups.map(g => g.names), [['א', 'ג'], ['ב']]);
    assert.ok(p.heats.every(h => !L.mixesClasses(p, h)));
    assert.equal(p.heats.length, 2);
    // family -> one group, one heat
    const f = L.markPaidAndPlan(r.core, r.id!, 2, { family: true });
    assert.equal(f.groups.length, 1); assert.equal(f.heats.length, 1);
    assert.deepEqual(f.groups[0].tickets, ['רגיל', 'ליגה', 'רגיל']);
});

test('price board defaults: רגיל 87, זוגי 100 per two-seat kart, מאסטר 100, ליגה 87; 20 min = 100', () => {
    const c = L.initialCore();
    assert.deepEqual(L.priceOf(c, ['רגיל', 'רגיל', 'מאסטר']), { total: 274, missing: [] });
    assert.equal(L.priceOf(c, ['זוגי', 'זוגי']).total, 100, 'two people share one double kart');
    assert.equal(L.priceOf(c, ['זוגי', 'זוגי', 'זוגי']).total, 200);
    assert.deepEqual(L.priceOf(c, ['ליגה']), { total: 87, missing: [] });
    assert.deepEqual(L.priceOf(c, ['רגיל', 'ליגה'], 20), { total: 200, missing: [] });
    const old = { ...c, settings: { ...c.settings, tickets: ['יחיד', 'זוגי', 'ליגה', 'מאסטר'], prices: undefined } };
    const m = L.migrateTickets(old);
    assert.deepEqual(m.settings.tickets, ['רגיל', 'זוגי', 'ליגה', 'מאסטר']);
    assert.equal(m.settings.prices?.['רגיל'], 87);
});

test('heat controls: pause freezes the clock, resume continues, restart goes back to zero', () => {
    const base = { live: { heatId: 'h', t0: 1_000, seed: 1, speed: 1, durationMs: 600_000 } } as unknown as L.Core;
    let c = L.pauseRun(base, 61_000);
    assert.ok(L.isPaused(c));
    assert.equal(L.elapsedOf(c.live, 500_000), 60_000, 'frozen while paused');
    assert.equal(L.timeLeft(c.live, 500_000), 540_000);
    assert.equal(L.pauseRun(c, 70_000), c, 'double pause ignored');
    c = L.resumeRun(c, 500_000);
    assert.ok(!L.isPaused(c));
    assert.equal(L.elapsedOf(c.live, 510_000), 70_000, 'continues after resume');
    assert.equal(L.elapsedOf(L.setSpeed(L.pauseRun(c, 510_000), 5, 520_000).live, 530_000), 70_000, 'speed change while paused keeps the clock');
    const r = L.restartRun(L.pauseRun(c, 520_000), 600_000);
    assert.equal(L.elapsedOf(r.live, 600_000), 0); assert.ok(!L.isPaused(r));
    assert.equal(L.elapsedOf(r.live, 605_000), 5_000);
});

test('checkered flag: staff end the heat, clock stops, everyone finished; reset clears it', () => {
    let q = L.startHeat(twoQueued(), 'h1', 0, 9, 1);
    assert.ok(!L.allFinished(L.liveTiming(q, 700_000)), 'time up alone does not end it');
    q = L.endRun(q, 700_000);
    assert.ok(L.isEnded(q) && !L.isPaused(q));
    assert.equal(L.elapsedOf(q.live, 900_000), 700_000, 'clock stopped at the flag');
    assert.ok(L.allFinished(L.liveTiming(q, 900_000)));
    assert.equal(L.pauseRun(q, 800_000), q, 'no pause after the flag');
    const p = L.endRun(L.pauseRun(L.restartRun(q, 1_000_000), 1_060_000), 1_200_000);
    assert.equal(L.elapsedOf(p.live, 1_300_000), 60_000, 'flag while paused ends at the pause');
    assert.ok(!L.isEnded(L.restartRun(p, 2_000_000)));
});

test('quick start: open heat with no registration, karts appear as they cross, cancel drops it', () => {
    let q = twoQueued();
    q = L.startOpenHeat(q, 0, 5, 1);
    const h = L.runningHeat(q)!;
    assert.ok(h.open && h.entries.length === 0);
    assert.ok(h.num > Math.max(...q.heats.filter(x => !x.open).map(x => x.num)), 'gets a fresh number');
    assert.equal(q.live?.durationMs, 10 * 60_000);
    assert.equal(L.detectedOnly(q, L.liveTiming(q, 5_000)).length, 0, 'nobody before the first crossing');
    const later = L.detectedOnly(q, L.liveTiming(q, 120_000));
    assert.ok(later.length > 0 && later.every(r => r.laps.length > 0), 'karts join after crossing the line');
    assert.equal(L.startOpenHeat(q, 1, 1), q, 'only one heat on track');
    const { core: done, result } = L.finishRun(L.endRun(q, 200_000), 200_000);
    assert.ok(result && result.rows.length > 0 && result.rows.every(r => r.laps.length > 0) && result.rows[0].label.startsWith('קארט'));
    assert.equal(done.live, null);
    const c = L.cancelRun(L.startOpenHeat(twoQueued(), 0, 5, 1));
    assert.ok(!c.live && !c.heats.some(x => x.open), 'cancel removes the empty quick-start heat');
    assert.deepEqual(L.queueOf(c).map(x => x.id), L.queueOf(twoQueued()).map(x => x.id), 'the queue is untouched');
});

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);

test('10- and 20-minute groups never share a heat', () => {
    let c = L.initialCore();
    let r = L.submitForm(c, 'קצר', ['א', 'ב'], 1, ['רגיל', 'רגיל'], 10); c = L.markPaidAndPlan(r.core, r.id!, 2);
    r = L.submitForm(c, 'ארוך', ['ג', 'ד'], 3, ['רגיל', 'רגיל'], 20); c = L.markPaidAndPlan(r.core, r.id!, 4);
    assert.equal(c.groups.find(g => g.name === 'ארוך')?.minutes, 20);
    const heatOf = (n: string) => c.heats.find(h => h.entries.some(e => e.groupId === c.groups.find(g => g.name === n)!.id))!;
    assert.notEqual(heatOf('קצר').id, heatOf('ארוך').id);
    assert.equal(L.minutesOfHeat(c, heatOf('ארוך')), 20);
});

test('fast + regular in one heat is allowed with shift manager (אחמ״ש) approval, voided when groups change', () => {
    let c = L.initialCore();
    c = L.addGroup(c, { name: 'מהירים', size: 2, ticket: 'ליגה', keepTogether: true, note: '' }, 1);
    c = L.addGroup(c, { name: 'רגילים', size: 2, ticket: 'רגיל', keepTogether: true, note: '' }, 2);
    c = L.addGroup(c, { name: 'עוד', size: 1, ticket: 'רגיל', keepTogether: true, note: '' }, 3);
    const [a, b, d] = c.groups;
    c = { ...c, heats: [{ id: 'h1', num: 1, status: 'draft', entries: [{ groupId: a.id, count: 2 }, { groupId: b.id, count: 2 }] }] };
    const h = () => c.heats[0];
    assert.equal(L.canApprove(c, h()), false);
    c = L.approveMix(c, 'h1');
    assert.equal(L.canApprove(c, h()), true);
    assert.equal(L.mixApproved(c, h()), true);
    c = { ...c, heats: [{ ...h(), entries: [...h().entries, { groupId: d.id, count: 1 }] }] };
    assert.equal(L.canApprove(c, h()), false, 'approval covers only the groups that were there');
});

test('history period: resets at local midnight (day) or Saturday night (week); archive merge keeps one copy', () => {
    const wed = new Date(2026, 10, 18, 15, 30).getTime(); // Wednesday
    assert.equal(L.periodStart(wed, 'day'), new Date(2026, 10, 18).getTime());
    assert.equal(L.periodStart(wed, 'week'), new Date(2026, 10, 15).getTime(), 'Sunday 00:00');
    const r = (at: number, id = 'h'): L.Result => ({ heatId: id, heatNum: 1, at, simulated: true, laps: 0, rows: [] });
    const hist = [r(wed), r(new Date(2026, 10, 17, 22).getTime()), r(new Date(2026, 10, 14, 23).getTime())];
    assert.equal(L.currentPeriod(hist, wed, 'day').length, 1);
    assert.equal(L.currentPeriod(hist, wed, 'week').length, 2);
    assert.equal(L.mergeResults(hist, [r(wed)], [r(wed + 1, 'x')]).length, 4);
});

test('RentiX feed (RMonitor) -> board: names, karts, laps, best, last, order; reset clears', () => {
    const lines = [
        '$I,"16:00:00.000","16 Nov 26"',
        '$B,12,"מקצה 12"',
        '$A,"5","5",1005,"שירה","כהן","",1',
        '$COMP,"7","7",1,"Avi","","",""',
        '$J,"5","00:00:41.200","00:00:41.200"',
        '$J,"7","00:00:43.000","00:00:43.000"',
        '$J,"5","00:00:39.900","00:01:21.100"',
        '$G,1,"5",2,"00:01:21.100"',
        '$G,2,"7",1,"00:00:43.000"',
        '$H,1,"5",2,"00:00:39.900"',
        '$F,9999,"00:08:30","16:01:30","00:01:30","Green "',
    ];
    const b = R.parseRMonitor(lines, 1);
    assert.equal(b.run, 'מקצה 12'); assert.equal(b.flag, 'Green');
    assert.equal(b.timeToGo, 510_000); assert.equal(b.raceTime, 90_000);
    assert.deepEqual(b.rows.map(r => [r.pos, r.kart, r.name, r.laps]), [[1, 5, 'שירה כהן', 2], [2, 7, 'Avi', 1]]);
    assert.equal(b.rows[0].best, 39_900); assert.equal(b.rows[0].last, 39_900); assert.equal(b.rows[0].total, 81_100);
    assert.ok(R.extActive(b));
    assert.equal(R.parseRMonitor([...lines, '$I,"16:10:00","16 Nov 26"'], 2).rows.length, 0, 'a reset starts a new session');
    assert.deepEqual(R.splitRecord('$A,"a,b","x""y",3'), ['$A', 'a,b', 'x"y', '3']);
    assert.equal(R.timeMs('01:02:03.5'), 3_723_500); assert.equal(R.timeMs(''), null);
});

test('direct decoder board (dk-bridge): transponders mapped to karts in Settings, unmapped listed', () => {
    // lines exactly as dk-bridge renders a decoder heat
    const lines = ['$I,"20:49:37.614","decoder"', '$B,1,"מקצה 1 · דקודר"', '$F,"","00:00:00","20:49:47","00:01:21.000","Green"',
        '$A,"1118533","",1118533,"","","",""', '$A,"237062","",237062,"","","",""',
        '$G,1,"1118533",2,"00:01:20.000"', '$H,1,"1118533",0,"00:00:39.000"', '$G,2,"237062",1,"00:00:43.000"',
        '$J,"1118533","00:00:41.000","00:00:41.000"', '$J,"1118533","00:00:39.000","00:01:20.000"', '$J,"237062","00:00:43.000","00:00:43.000"'];
    const ext = R.parseRMonitor(lines, 1, 'decoder');
    assert.equal(ext.src, 'decoder'); assert.equal(ext.rows[0].tx, '1118533'); assert.equal(ext.rows[0].best, 39_000);
    let c = L.initialCore();
    c = L.setTransponder(c, 7, '1118533');
    c = L.setTransponder(c, 3, '1118533'); // moved: one transponder, one kart
    assert.deepEqual(c.settings.transponders, { '3': '1118533' });
    const m = R.withKarts(ext, c.settings.transponders);
    assert.equal(m.rows[0].kart, 3); assert.equal(m.rows[0].name, 'קארט 3');
    assert.deepEqual(R.unmappedTx(m, c.settings.transponders), ['237062']);
    assert.equal(m.rows[1].kart, 0); assert.equal(m.rows[1].name, 'טרנספונדר 237062', 'an unmapped transponder is not shown as a kart number');
    // RentiX boards keep RentiX's own kart numbers
    const rx = R.parseRMonitor(['$A,"5","5",1118533,"Dana","K","",1', '$G,1,"5",1,"00:00:40.000"'], 1);
    assert.equal(R.withKarts(rx, c.settings.transponders).rows[0].kart, 5);
    assert.equal(R.sourceName('decoder'), 'דקודר AMB'); assert.equal(R.sourceName('rentix'), 'RentiX');
});

test('RentiX-style sections: finished track run -> real history result; kart info per kart', () => {
    const lines = ['$I,"21:00:00.000","x"', '$B,12,"Heat 12"', '$F,0,"00:00:00","21:10:00","00:10:00.000","Finish"',
        '$A,"5","5",111,"Kart","5","",1', '$A,"7","7",222,"Kart","7","",1',
        '$G,1,"5",2,"00:00:56.000"', '$G,2,"7",2,"00:00:57.000"', '$H,1,"5",2,"00:00:27.420"', '$H,2,"7",1,"00:00:27.960"',
        '$J,"5","00:00:28.580","00:00:28.580"', '$J,"5","00:00:27.420","00:00:56.000"', '$J,"7","00:00:27.960","00:00:27.960"', '$J,"7","00:00:29.040","00:00:57.000"'];
    const ext = R.parseRMonitor(lines, 1);
    assert.ok(R.extDone(ext));
    assert.deepEqual(ext.rows[0].lapTimes, [28_580, 27_420]);
    const id = R.extRunId(ext);
    assert.equal(R.extRunId(R.parseRMonitor(lines, 999)), id, 'same run, same id (saved once)');
    const res = R.extResult(ext, 5000);
    assert.equal(res.simulated, false); assert.equal(res.heatNum, 12); assert.equal(L.resultTitle(res), 'Heat 12');
    assert.equal(res.rows[0].kart, 5); assert.equal(res.rows[0].best, 27_420); assert.equal(res.rows[0].total, 56_000);
    // kart info across two heats: kart 5's best is from the second heat
    const res2: L.Result = { ...res, heatId: 'b', at: 9000, title: 'Heat 13', rows: [{ pos: 1, kart: 5, label: 'Dana', laps: [27_000, 27_500], best: 27_000, total: 54_500 }] };
    const ks = L.kartStats([res2, res]);
    assert.equal(ks[0].kart, 5); assert.equal(ks[0].best, 27_000); assert.equal(ks[0].bestBy, 'Dana'); assert.equal(ks[0].heats, 2); assert.equal(ks[0].laps, 4);
    assert.equal(ks[1].kart, 7); assert.equal(ks[1].best, 27_960);
    assert.equal(L.resultTitle({ ...res, title: undefined }), 'מקצה 12');
});
