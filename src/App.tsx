import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Callout, Closing, CopyButton, FileCard, Group, useLocalState } from '@instinct/files';
import * as L from './logic';
import * as Cloud from './cloud';
declare const __BUILD__: string;
import type { Session } from '@supabase/supabase-js';

type Tab = 'form' | 'cashier' | 'heats' | 'live' | 'history' | 'settings';
/** CORE: the timing system. Always present. */
const CORE_TABS: { id: Tab; label: string }[] = [
    { id: 'live', label: 'מסלול' },
    { id: 'heats', label: 'מקצים' },
    { id: 'history', label: 'היסטוריה' },
    { id: 'settings', label: 'הגדרות' },
];
/** OPTIONAL ADD-ON: only shown when the cashier add-on is enabled in Settings. */
const ADDON_TABS: { id: Tab; label: string }[] = [
    { id: 'cashier', label: 'קופה' },
    { id: 'form', label: 'הרשמה' },
];

/**
 * Demo autopilot pacing. ILLUSTRATIVE ONLY: the real call-up trigger at the venue is not decided.
 * Nothing here is an operational rule.
 */
const DEMO = { callAfterMs: 2500, startAfterMs: 6000, resultsHoldMs: 7000, speed: 20 };
const SPEEDS = [1, 5, 20];

/**
 * Official Dan Karting wide logo (owner-verified source: dankart.co.il, dan-karting-wide-logo-1.png).
 * Downloaded once and bundled in public/, so the app itself makes no external calls.
 * Transparent with a black tagline, so it sits on a light plate over the dark theme (asset not recoloured).
 * If the file is missing, a text wordmark is shown.
 */
const LOGO_SRC = 'dan-karting-wide-logo.png';

const timeOf = (t: number) => new Date(t).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
const dayOf = (t: number) => new Date(t).toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' });

type Update = (fn: (c: L.Core) => L.Core) => void;

function Logo({ big }: { big?: boolean }) {
    const [ok, setOk] = useState(true);
    if (LOGO_SRC && ok) return <img className={`logo-img${big ? ' big' : ''}`} src={LOGO_SRC} alt="Dan Karting" onError={() => setOk(false)} />;
    return <span className={`wordmark${big ? ' big' : ''}`} dir="ltr" aria-label="Dan Karting"><b>DAN</b> KARTING</span>;
}

function Btn(p: { children: React.ReactNode; onClick?: () => void; kind?: 'primary' | 'ghost' | 'danger' | 'on'; disabled?: boolean; small?: boolean; label?: string }) {
    return <button type="button" className={`kb ${p.kind ?? 'ghost'}${p.small ? ' sm' : ''}`} onClick={p.onClick} disabled={p.disabled} aria-label={p.label} aria-pressed={p.kind === 'on' ? true : undefined}>{p.children}</button>;
}

function Stepper(p: { label: string; value: number; min: number; max: number; onChange: (n: number) => void }) {
    return <div className="field">
        <span className="flabel">{p.label}</span>
        <div className="stepper">
            <button type="button" className="kb ghost" aria-label="פחות" onClick={() => p.onChange(Math.max(p.min, p.value - 1))} disabled={p.value <= p.min}>−</button>
            <output aria-live="polite">{p.value}</output>
            <button type="button" className="kb ghost" aria-label="יותר" onClick={() => p.onChange(Math.min(p.max, p.value + 1))} disabled={p.value >= p.max}>+</button>
        </div>
    </div>;
}

function heatBadge(core: L.Core, h: L.Heat): { text: string; cls: string } {
    if (h.status !== 'done' && !L.heatPaid(core, h)) return { text: 'לא שולם', cls: 'bad' };
    if (core.live?.heatId === h.id) return { text: 'על המסלול', cls: 'track' };
    if (L.overCapacity(h, core.settings.capacity) && h.status !== 'done') return { text: 'חורג מהקיבולת', cls: 'bad' };
    if (h.status === 'draft') return { text: 'טיוטה', cls: 'draft' };
    if (h.status === 'done') return { text: 'הסתיים', cls: 'done' };
    return h.called ? { text: 'נקרא למסלול', cls: 'called' } : { text: 'מאושר · בתור', cls: 'approved' };
}

// ------------------------------------------------------------ customer form
// What a customer fills on their own phone or a kiosk: one group name + participant names. Nothing else.
function CustomerForm({ core, update }: { core: L.Core; update: Update }) {
    const [group, setGroup] = useState('');
    const [names, setNames] = useState<string[]>(['', '']);
    const [error, setError] = useState('');
    const [sent, setSent] = useState<{ id: string; group: string; n: number } | null>(null);
    const setAt = (i: number, v: string) => { setError(''); setNames(names.map((x, j) => (j === i ? v : x))); };
    const filled = names.filter(x => x.trim()).length;
    const submit = () => {
        let res: { id?: string; error?: string } = {};
        update(c => { const r = L.submitForm(c, group, names, Date.now()); res = r; return r.core; });
        if (res.error || !res.id) { setError(res.error ?? 'שגיאה'); return; }
        setSent({ id: res.id, group: group.trim(), n: filled }); setGroup(''); setNames(['', '']); setError('');
    };
    const sample = () => {
        const k = Math.floor(Math.random() * 20);
        setGroup(`קבוצה לדוגמה ${k + 1}`);
        setNames(Array.from({ length: 3 + (k % 4) }, (_, i) => L.DEMO_NAMES[(k + i * 7) % L.DEMO_NAMES.length]));
    };
    if (sent) return <Group label="נשלח לקופה" heading>
        <div className="sent">
            <div className="sent-num">#{sent.id.replace(/\D/g, '')}</div>
            <p><b>{sent.group}</b> · {sent.n} משתתפים</p>
            <p>ההרשמה מחכה בקופה. גשו לקופה לתשלום. אחרי אישור התשלום תיכנסו לתור ותוזמנו במסך המסלול.</p>
        </div>
        <Btn kind="primary" onClick={() => setSent(null)}>הרשמה חדשה</Btn>
    </Group>;
    return <Group label="הרשמה לקארטינג" heading>
        <Callout title="דמו" tone="warning">זה טופס לדוגמה. אל תזינו שמות אמיתיים. אין תשלום בטופס: התשלום בקופה.</Callout>
        <div className="form">
            <label className="field"><span className="flabel">שם הקבוצה</span>
                <input className="inp" value={group} onChange={e => { setError(''); setGroup(e.target.value); }} placeholder="למשל: החבר׳ה מהעבודה" maxLength={40} />
            </label>
            <div className="field"><span className="flabel">שמות המשתתפים ({filled})</span>
                <ol className="plain dlist names">
                    {names.map((v, i) => <li key={i} className="drow">
                        <span className="meta nidx">{i + 1}</span>
                        <input className="inp dname" value={v} onChange={e => setAt(i, e.target.value)} placeholder="שם" aria-label={`משתתף ${i + 1}`} maxLength={24} />
                        <button type="button" className="kb ghost sm" aria-label={`הסר משתתף ${i + 1}`} disabled={names.length <= 1} onClick={() => setNames(names.filter((_, j) => j !== i))}>✕</button>
                    </li>)}
                </ol>
                <div className="actions"><Btn small disabled={names.length >= L.MAX_FORM_NAMES} onClick={() => setNames([...names, ''])}>+ משתתף</Btn><Btn small onClick={sample}>מלא דוגמה</Btn></div>
            </div>
            {error && <div className="warn" role="alert">{error}</div>}
            <Btn kind="primary" onClick={submit}>שליחה לקופה</Btn>
        </div>
    </Group>;
}

// ------------------------------------------------------------------ cashier
function Cashier({ core, update, goHeats }: { core: L.Core; update: Update; goHeats: () => void }) {
    const [name, setName] = useState('');
    const [size, setSize] = useState(2);
    const [ticket, setTicket] = useState(core.settings.tickets[0] ?? '');
    const [keep, setKeep] = useState(true);
    const [note, setNote] = useState('');
    const split = useMemo(() => L.splitGroupIds(core.heats), [core.heats]);
    // Manual add creates a PENDING registration by headcount. It needs the same explicit "paid" confirmation as a form.
    const add = () => {
        const nm = name.trim() || `קבוצה ${core.groups.length + L.pendingOf(core).length + 1}`;
        update(c => L.submitCashier(c, { name: nm, size, ticket, keepTogether: keep, note }, Date.now()).core);
        setName(''); setNote(''); setSize(2); setKeep(true); setManual(false);
    };
    // Synthetic demo registrations arrive pending too; the cashier confirms each one.
    const loadDemo = () => update(c => L.loadDemoRegistrations(c, Date.now()).core);
    const waiting = L.waitingGroups(core);
    const unpaidGroups = core.groups.filter(g => !L.isPaid(g));
    const over = new Set(L.oversizedGroups(core).map(g => g.id));
    const pending = L.pendingOf(core);
    const [manual, setManual] = useState(false);
    return <>
        <Group label={`ממתינים לתשלום (${pending.length})`} heading>
            <p className="meta">כל קבוצה, מהטופס או מהוספה ידנית בקופה, מחכה כאן. היא נכנסת לתור ולמקצים רק אחרי "שולם". אישור התשלום כאן מדומה: אין חיוב ואין סליקה.</p>
            {pending.length === 0 && <div className="empty"><p>אין הרשמות שממתינות. לקוחות נרשמים בלשונית "הרשמה".</p><Btn small onClick={loadDemo}>טען הרשמות דמו (ממתינות)</Btn></div>}
            <ul className="list">
                {pending.map(sb => <li key={sb.id} className="item pending">
                    <div className="itop"><strong>{sb.groupName}</strong><span className="big">{L.submissionSize(sb)}</span></div>
                    <div className="meta">#{sb.id.replace(/\D/g, '')} · {timeOf(sb.createdAt)} · {sb.source === 'cashier' ? 'הוספה ידנית בקופה' : sb.source === 'demo' ? 'דמו' : 'טופס לקוח'}{sb.note ? ` · ${sb.note}` : ''}</div>
                    <div className="names-list">{sb.names.length ? sb.names.join(' · ') : `${L.submissionSize(sb)} משתתפים, בלי שמות`}</div>
                    <div className="actions">
                        <Btn kind="primary" small onClick={() => update(c => L.markPaid(c, sb.id, Date.now()))}>שולם · הכנס לתור</Btn>
                        <Btn kind="danger" small onClick={() => update(c => L.cancelSubmission(c, sb.id))}>בטל הרשמה</Btn>
                    </div>
                </li>)}
            </ul>
        </Group>
        <div className="row-actions"><Btn small onClick={() => setManual(!manual)}>{manual ? 'סגור הוספה ידנית' : 'הוספה ידנית בקופה (בלי טופס)'}</Btn></div>
        {manual && <Group label="קבוצה חדשה (ידני)" heading>
            <div className="form">
                <label className="field"><span className="flabel">שם הקבוצה</span>
                    <input className="inp" value={name} onChange={e => setName(e.target.value)} placeholder="למשל: קבוצה 1" maxLength={40} />
                </label>
                <Stepper label="כמה משתתפים" value={size} min={1} max={30} onChange={setSize} />
                <div className="field"><span className="flabel">מה נקנה</span>
                    <div className="chips" role="radiogroup" aria-label="סוג כרטיס">
                        {core.settings.tickets.map(t => <button key={t} type="button" role="radio" aria-checked={ticket === t} className={`chip${ticket === t ? ' sel' : ''}`} onClick={() => setTicket(t)}>{t}</button>)}
                    </div>
                </div>
                <div className="field"><span className="flabel">שיבוץ</span>
                    <div className="chips">
                        <button type="button" aria-pressed={keep} className={`chip${keep ? ' sel' : ''}`} onClick={() => setKeep(true)}>לשמור יחד</button>
                        <button type="button" aria-pressed={!keep} className={`chip${!keep ? ' sel' : ''}`} onClick={() => setKeep(false)}>אפשר לפצל</button>
                    </div>
                </div>
                <label className="field"><span className="flabel">הערה לצוות (לא חובה)</span>
                    <input className="inp" value={note} onChange={e => setNote(e.target.value)} maxLength={80} />
                </label>
                <Btn kind="primary" onClick={add}>צור הרשמה (ממתינה לתשלום)</Btn>
            </div>
        </Group>}
        {unpaidGroups.length > 0 && <Callout title="קבוצות בלי אישור תשלום" tone="warning">
            <p>נתונים שנשמרו לפני שער התשלום. הקבוצות האלה לא ייכנסו לתור, למקצים או למסך עד שמאשרים תשלום.</p>
            <ul className="plain">{unpaidGroups.map(g => <li key={g.id}>{g.name} ({g.size}) <Btn small kind="primary" onClick={() => update(c => L.confirmGroupPaid(c, g.id, Date.now()))}>שולם</Btn></li>)}</ul>
        </Callout>}
        <Group label={`קבוצות ששילמו (${core.groups.filter(L.isPaid).length})`} heading>
            {!core.groups.some(L.isPaid) && <div className="empty">
                <p>אין עדיין קבוצות ששילמו. סמן הרשמה כ"שולם" למעלה.</p>
            </div>}
            <ul className="list">
                {core.groups.filter(L.isPaid).map(g => {
                    const left = L.unassignedOf(core, g);
                    const heats = core.heats.filter(h => h.entries.some(e => e.groupId === g.id)).map(h => h.num);
                    const locked = core.heats.some(h => h.status !== 'draft' && h.entries.some(e => e.groupId === g.id));
                    return <li key={g.id} className="item">
                        <div className="itop"><strong>{g.name}</strong><span className="big">{g.size}</span></div>
                        <div className="meta">{g.ticket || 'ללא סוג'} · {g.keepTogether ? 'לשמור יחד' : 'אפשר לפצל'} · {timeOf(g.createdAt)}</div>
                        {g.note && <div className="meta">הערה: {g.note}</div>}
                        {g.names && <div className="names-list">{g.names.join(' · ')}</div>}
                        <div className="meta">{over.has(g.id) ? 'לא משובצת: גדולה מהקיבולת' : left === g.size ? 'ממתינה לשיבוץ' : left > 0 ? `חלק לא משובץ (${left})` : `משובצת במקצה ${heats.join(', ')}`}{split.has(g.id) ? ' · פוצלה, לבדוק' : ''}</div>
                        <div className="actions"><Btn small kind="danger" disabled={locked} onClick={() => update(c => L.removeGroup(c, g.id))}>{locked ? 'במקצה מאושר' : 'הסר'}</Btn></div>
                    </li>;
                })}
            </ul>
            {waiting.length > 0 && <div className="row-actions">
                <Btn kind="primary" onClick={() => { update(L.planHeats); goHeats(); }}>הצע שיבוץ למקצים</Btn>
                <Btn onClick={goHeats}>לבנות ידנית</Btn>
            </div>}
        </Group>
    </>;
}

// ------------------------------------------------------- driver names + karts
function DriverEditor({ core, heat, update }: { core: L.Core; heat: L.Heat; update: Update }) {
    const ds = L.driversOf(core, heat);
    const clash = new Set(L.kartConflicts(core, heat));
    const mode = L.kartMode(core);
    const locked = heat.status === 'done';
    return <div className="drivers">
        <div className="meta">{mode === 'cashier' ? 'מצב "הקופאית בוחרת": בוחרים קארט לכל נהג לפני אישור המקצה.' : mode === 'staff' ? 'מצב "הצוות מקצה": הצוות מעדכן קארט כשהנהג עולה. עד אז המסך מציג "הצוות יקצה".' : 'מספר קארט מוצע אוטומטית ואפשר לשנות. עדיין לא הוחלט מי קובע אותו (הגדרות).'}</div>
        <ul className="plain dlist">
            {ds.map(d => <li key={d.key} className="drow">
                <input key={`n-${d.key}-${d.label}`} className="inp dname" aria-label="שם הנהג" placeholder={d.label} defaultValue={d.nameSet ? d.label : ''} disabled={locked} maxLength={24}
                    onBlur={e => { const v = e.target.value.trim(); if (v !== (d.nameSet ? d.label : '')) update(c => L.setDriver(c, heat.id, d.key, { name: v })); }} />
                <input key={`k-${d.key}-${d.kartSet ? d.kart : 'x'}`} className={`inp dkart${clash.has(d.kart) ? ' clash' : ''}`} type="number" inputMode="numeric" min={1} max={99} aria-label="מספר קארט" disabled={locked}
                    placeholder={String(d.kart)} defaultValue={d.kartSet ? d.kart : ''}
                    onBlur={e => { const v = Number(e.target.value); const cur = d.kartSet ? d.kart : 0; if ((v || 0) !== cur) update(c => L.setDriver(c, heat.id, d.key, { kart: v })); }} />
                <span className="meta dstat">{d.kartSet ? 'נבחר' : 'הצעה'}</span>
            </li>)}
        </ul>
        {clash.size > 0 && <div className="warn">אותו מספר קארט לשני נהגים: {[...clash].join(', ')}</div>}
    </div>;
}

// -------------------------------------------------------------------- heats
function Heats({ core, update }: { core: L.Core; update: Update }) {
    const cap = core.settings.capacity;
    const split = L.splitGroupIds(core.heats);
    const waiting = L.waitingGroups(core);
    const oversized = L.oversizedGroups(core);
    const [openDrv, setOpenDrv] = useState<string | null>(null);
    const [notice, setNotice] = useState('');
    const [showDone, setShowDone] = useState(false);
    // Apply an edit and tell the cashier when an approved heat had to go back to draft.
    const act = (fn: (c: L.Core) => L.Core) => update(c => {
        const next = fn(c);
        const back = next.heats.filter(h => h.status === 'draft' && c.heats.find(x => x.id === h.id)?.status === 'approved');
        setNotice(back.length ? `מקצה ${back.map(h => h.num).join(', ')} חזר לטיוטה אחרי השינוי (ריק, חורג, או חסר קארט). צריך לאשר שוב.` : '');
        return next;
    });
    const shown = [...core.heats].sort((a, b) => a.num - b.num).filter(h => showDone || h.status !== 'done');
    const doneCount = core.heats.filter(h => h.status === 'done').length;
    return <Group label="מקצים" heading>
        <Callout title="הצוות מחליט" tone="note">ההצעה האוטומטית היא רק קיצור. אפשר לבנות מקצה ידנית ("מקצה חדש" ואז להוסיף קבוצות), ואפשר לשנות הרכב גם אחרי אישור, גם למקצה שכבר נקרא למסלול, עד שהוא עולה למסלול. מקצה מאושר שהשינוי הופך ללא תקין חוזר לטיוטה. "שבץ מחדש" מחליף רק טיוטות. הכללים (קבוצה נשארת שלמה כשיש מקום, פיצול רק כשחייבים) הם הצעה לבדיקה מול הצוות. אין כאן בדיקות גיל או גובה.</Callout>
        <div className="row-actions">
            <Btn kind="primary" onClick={() => act(L.planHeats)}>{core.heats.some(h => h.status === 'draft') ? 'שבץ מחדש את הטיוטות' : 'הצע שיבוץ'}</Btn>
            <Btn onClick={() => act(L.createHeat)}>מקצה חדש</Btn>
            <span className="meta">קיבולת: {cap}{waiting.length ? ` · ${waiting.length} קבוצות ממתינות` : ''}</span>
        </div>
        {notice && <div className="notice" role="status">{notice} <button type="button" className="linkish" onClick={() => setNotice('')}>הבנתי</button></div>}
        {oversized.length > 0 && <Callout title="קבוצות שלא שובצו" tone="warning">
            <p>קבוצה שסומנה "לשמור יחד" גדולה מהקיבולת ({cap}), ולכן לא שובצה ולא פוצלה אוטומטית. בחר: לאפשר פיצול לקבוצה, או לשנות קיבולת בהגדרות.</p>
            <ul className="plain">{oversized.map(g => <li key={g.id}>{g.name}: {g.size} משתתפים <Btn small onClick={() => act(c => L.planHeats(L.allowSplit(c, g.id)))}>אפשר לפצל ושבץ</Btn></li>)}</ul>
        </Callout>}
        {core.heats.length === 0 && <p className="empty">{L.cashierOn(core) ? 'אין מקצים. אשר תשלום לקבוצות בלשונית קופה ואז הצע שיבוץ או בנה מקצה ידנית.' : 'אין מקצים. הוסף מקצה בלשונית מסלול.'}</p>}
        <ul className="list">
            {shown.map(h => {
                const n = L.heatCount(h); const over = n > cap;
                const canEdit = L.editable(core, h);
                const targets = core.heats.filter(d => d.id !== h.id && L.editable(core, d)).sort((a, b) => a.num - b.num);
                const b = heatBadge(core, h);
                return <li key={h.id} className={`item heat ${h.status}${h.called ? ' called' : ''}${core.live?.heatId === h.id ? ' ontrack' : ''}`}>
                    <div className="itop">
                        <strong className="hnum">מקצה {h.num}</strong>
                        <span className={`badge ${b.cls}`}>{b.text}</span>
                    </div>
                    <div className="bar" aria-hidden="true"><i style={{ width: `${Math.min(100, (n / cap) * 100)}%` }} className={over ? 'over' : ''} /></div>
                    <div className="meta">{n} מתוך {cap}{core.live?.heatId === h.id ? ' · נעול בזמן שהוא על המסלול' : ''}</div>
                    <ul className="entries">
                        {h.entries.map(e => {
                            const g = core.groups.find(x => x.id === e.groupId);
                            return <li key={e.groupId}>
                                <span>{g?.name ?? '?'} <b>{e.count}</b>{split.has(e.groupId) ? ` מתוך ${g?.size}` : ''}{split.has(e.groupId) && <em className="warn"> פוצלה</em>}</span>
                                {canEdit && <span className="moves" role="group" aria-label={`פעולות על ${g?.name}`}>
                                    <button type="button" className="kb ghost sm" onClick={() => act(c => L.removeFromHeat(c, e.groupId, h.id))}>החזר להמתנה</button>
                                    {targets.map(d => {
                                        const fits = d.status === 'draft' || L.heatCount(d) + e.count <= cap;
                                        return <button key={d.id} type="button" className="kb ghost sm" disabled={!fits} onClick={() => act(c => L.moveEntry(c, e.groupId, h.id, d.id))}>{`למקצה ${d.num}`}</button>;
                                    })}
                                </span>}
                            </li>;
                        })}
                    </ul>
                    {canEdit && waiting.length > 0 && <div className="moves" role="group" aria-label="הוסף קבוצה למקצה">{waiting.map(g => { const left = L.unassignedOf(core, g); const free = cap - n; const blocked = free <= 0 || (g.keepTogether && left > free); return <button key={g.id} type="button" className="kb ghost sm add" disabled={blocked} onClick={() => act(c => L.addToHeat(c, g.id, h.id))}>{`+ ${g.name} (${left})`}</button>; })}</div>}
                    {h.entries.length > 0 && h.status !== 'done' && <div className="actions"><Btn small onClick={() => setOpenDrv(openDrv === h.id ? null : h.id)}>{openDrv === h.id ? 'סגור שמות וקארטים' : 'שמות וקארטים'}</Btn></div>}
                    {openDrv === h.id && h.status !== 'done' && <DriverEditor core={core} heat={h} update={update} />}
                    {h.status === 'draft' && h.entries.length > 0 && !over && !L.canApprove(core, h) && <div className="meta warn">{L.kartConflicts(core, h).length ? 'אי אפשר לאשר: קארט כפול.' : 'אי אפשר לאשר: במצב "הקופאית בוחרת" צריך לבחור קארט לכל נהג.'}</div>}
                    {h.status === 'approved' && L.kartConflicts(core, h).length > 0 && <div className="meta warn">קארט כפול: המקצה לא יוכל לעלות למסלול עד שיתוקן.</div>}
                    {h.status === 'draft' && <div className="actions"><Btn kind="primary" small disabled={over || h.entries.length === 0 || !L.canApprove(core, h)} onClick={() => act(c => L.approveHeat(c, h.id))}>אשר והכנס לתור</Btn></div>}
                    {h.status === 'approved' && canEdit && <div className="actions"><Btn small onClick={() => update(c => L.unapproveHeat(c, h.id))}>הוצא מהתור (טיוטה)</Btn></div>}
                </li>;
            })}
        </ul>
        {doneCount > 0 && <div className="row-actions"><Btn small onClick={() => setShowDone(!showDone)}>{showDone ? 'הסתר מקצים שהסתיימו' : `הצג מקצים שהסתיימו (${doneCount})`}</Btn></div>}
    </Group>;
}

// ------------------------------------------------------------ venue screens
// Original design for the on-site screens: a lineup board (driver photos + names) and a red/dark
// live timing board. Not a copy of any vendor's screens or assets. All data is synthetic.
type Sec = { ms: number; cls: '' | 'pb' | 'ob' };
/** Gap to the leader: whole laps behind, or time behind on the same lap. Kept structured so RTL rendering stays correct. */
type Gap = null | { laps: number } | { ms: number };
type BoardRow = {
    key: string; pos: number; kart: number; label: string; laps: number; best: number | null; last: number | null;
    gap: Gap; finished: boolean; isBest: boolean; sectors: Sec[] | null; gained: number | null;
};

const gapOf = (laps: number, total: number, leadLaps: number, leadTotal: number, isLeader: boolean): Gap =>
    isLeader || (laps === 0 && leadLaps === 0) ? null : laps < leadLaps ? { laps: leadLaps - laps } : { ms: total - leadTotal };

/**
 * The signed number is an isolated LTR run, so "+1" never flips to "1+" or collides with the Hebrew word
 * next to it inside the RTL page.
 */
function GapView({ g }: { g: Gap }) {
    if (!g) return null;
    if ('laps' in g) return <span className="gapv laps"><bdi dir="ltr">+{g.laps}</bdi><small>{g.laps === 1 ? 'הקפה' : 'הקפות'}</small></span>;
    return <span className="gapv"><bdi dir="ltr">+{L.fmt(g.ms)}</bdi></span>;
}

/** Live size of an element (for fitting a whole heat on screen). */
function useBox<T extends HTMLElement>(): [React.RefObject<T>, { w: number; h: number }] {
    const ref = useRef<T>(null);
    const [box, setBox] = useState({ w: 0, h: 0 });
    useEffect(() => {
        const el = ref.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(([e]) => {
            const r = e.contentRect;
            setBox(b => (Math.abs(b.w - r.width) < 1 && Math.abs(b.h - r.height) < 1 ? b : { w: r.width, h: r.height }));
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
    return [ref, box];
}

/** Card height = photo (square) + room for a two-line name. */
const CARD_RATIO = 1.3;
/**
 * Choose columns so every card of the heat fits the available box, as large as possible.
 * Exported shape is small and pure; tested indirectly through the screenshots (10 and 14 karts).
 */
function fitLineup(n: number, w: number, h: number, gap: number, ratio = CARD_RATIO): { cols: number; cell: number } {
    if (n <= 0 || w <= 0 || h <= 0) return { cols: Math.min(Math.max(n, 1), 5), cell: 0 };
    let best = { cols: 1, cell: 0 };
    for (let cols = 1; cols <= n; cols++) {
        const rows = Math.ceil(n / cols);
        const cw = (w - (cols - 1) * gap) / cols;
        const ch = (h - (rows - 1) * gap) / rows;
        const cell = Math.floor(Math.min(cw, ch / ratio));
        if (cell > best.cell) best = { cols, cell };
    }
    return best;
}

function useEscape(onClose: () => void) {
    const ref = useRef(onClose); ref.current = onClose;
    useEffect(() => {
        const k = (e: KeyboardEvent) => { if (e.key === 'Escape') ref.current(); };
        window.addEventListener('keydown', k);
        return () => window.removeEventListener('keydown', k);
    }, []);
}

const HELMETS = ['#e3262b', '#ffd400', '#2f7cf6', '#f5f5f5', '#1fbf6a', '#ff7a1a', '#a24bff', '#00c2d1', '#ff4fa3', '#8c8c8c'];

/** Placeholder driver "photo": an original helmet illustration in a per-kart colour. Not a real photo. */
function Avatar({ kart, label }: { kart: number; label: string }) {
    const id = React.useId().replace(/:/g, '');
    const c = HELMETS[(Math.max(1, kart) - 1) % HELMETS.length];
    return <svg className="avatar" viewBox="0 0 100 100" role="img" aria-label={`תמונה זמנית: ${label}`}>
        <defs>
            <linearGradient id={`bg${id}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#3a1215" /><stop offset="1" stopColor="#0d0b0c" /></linearGradient>
            <linearGradient id={`hl${id}`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#fff" stopOpacity=".55" /><stop offset=".5" stopColor="#fff" stopOpacity="0" /></linearGradient>
        </defs>
        <rect width="100" height="100" fill={`url(#bg${id})`} />
        <path d="M8 100 C12 80 30 73 50 73 C70 73 88 80 92 100 Z" fill="#1b1a1c" />
        <path d="M42 74 L50 100 L58 74 Z" fill={c} opacity=".85" />
        <path d="M22 50 C22 28 36 16 53 16 C71 16 82 30 82 48 C82 61 76 70 65 73 L33 73 C26 70 22 61 22 50 Z" fill={c} />
        <path d="M22 50 C22 28 36 16 53 16 C71 16 82 30 82 48 C82 61 76 70 65 73 L33 73 C26 70 22 61 22 50 Z" fill={`url(#hl${id})`} />
        <path d="M38 38 H80 C82 45 81 54 78 59 H43 C38 55 36 45 38 38 Z" fill="#101012" />
        <path d="M44 41 H74" stroke="#fff" strokeOpacity=".25" strokeWidth="2" strokeLinecap="round" />
        <path d="M30 30 C38 22 50 19 62 21" stroke="#111" strokeOpacity=".35" strokeWidth="5" fill="none" strokeLinecap="round" />
    </svg>;
}

function Lights({ state }: { state: 'live' | 'done' | 'wait' }) {
    if (state === 'done') return <span className="tb-flag" aria-label="דגל משובץ" />;
    return <span className={`tb-lights ${state}`} aria-label={state === 'live' ? 'מקצה פעיל' : 'ממתין'}>{[0, 1, 2, 3].map(i => <i key={i} />)}</span>;
}

function WallDisplay(p: { title: string; sub: string; totalLaps: number; clock?: string; countdown?: string; state: 'live' | 'done' | 'wait'; rows: BoardRow[]; footer?: React.ReactNode; controls?: React.ReactNode; onClose: () => void }) {
    useEscape(p.onClose);
    const [bodyRef, box] = useBox<HTMLDivElement>();
    // Fit every row of the heat (up to 14+) into the space left under the header: row height and font follow it.
    const n = Math.max(p.rows.length, 1);
    const headRow = 22;
    const rowGap = 3; // matches .tb-rows.fit gap: fixed-height rows must leave room for the gaps between them
    const rawRowH = box.h ? (box.h - headRow - rowGap * n) / n : 0;
    const fit = rawRowH >= 26;
    // Rows shrink to fit a full heat but never grow past a sensible height when only a few karts are on track.
    const vw = typeof window !== 'undefined' ? window.innerWidth : box.w;
    const maxRow = vw < 600 ? 52 : vw < 1400 ? 64 : 84;
    const rowH = Math.min(rawRowH, maxRow);
    // Font follows the row height AND the narrowest time column (7.5vw on desktop), so a time like "12.179" stays on one line.
    const colFs = vw >= 900 ? Math.floor((vw * 0.075) / 3.6) : 20;
    const fs = fit ? Math.max(12, Math.min(34, colFs, Math.floor(rowH * 0.4))) : undefined;
    const rowsStyle = fit ? ({ gridTemplateRows: `${headRow}px repeat(${n}, ${Math.floor(rowH)}px)`, alignContent: 'start', '--fs': `${fs}px` } as React.CSSProperties) : undefined;
    return <div className="wall tboard" role="dialog" aria-label="לוח זמנים">
        <header className="tb-head">
            <Logo big />
            <Lights state={p.state} />
            <div className="tb-title"><div className="tb-heat">{p.title}</div><div className="tb-sub">{p.sub}</div></div>
            <div className="tb-clocks">
                {p.countdown != null && <div className="tb-count" aria-label="זמן משוער שנותר"><small>נותר</small><bdi>{p.countdown}</bdi></div>}
                {p.clock && <div className="tb-elapsed"><small>זמן</small><bdi>{p.clock}</bdi></div>}
            </div>
            <button type="button" className="wall-close" onClick={p.onClose} aria-label="סגור תצוגת מסך">✕</button>
        </header>
        {p.controls}
        <div className="wall-sim">סימולציה · נתוני דמה · לא שעון אמיתי</div>
        <div className="tb-body" ref={bodyRef}>
        <ol className={`tb-rows${fit ? ' fit' : ''}`} style={rowsStyle}>
            <li className="tb-row tb-cols" aria-hidden="true"><span>מק׳</span><span>קארט</span><span>נהג</span><span>S1</span><span>S2</span><span>S3</span><span>אחרונה</span><span>הקפה מהירה</span><span>פער</span><span>הקפות</span></li>
            {p.rows.map(r => <li key={r.key} className={`tb-row${r.pos === 1 ? ' lead' : ''}`}>
                <span className="tb-pos">{r.pos}{r.gained ? <em className={r.gained > 0 ? 'up' : 'down'}>{r.gained > 0 ? `▲${r.gained}` : `▼${-r.gained}`}</em> : null}</span>
                <span className="tb-kart">{r.kart}</span>
                <span className={`tb-name${r.label.length > 14 ? ' long' : ''}`}>{r.label}</span>
                {[0, 1, 2].map(i => <span key={i} className={`tb-sec ${r.sectors?.[i]?.cls ?? ''}`}><bdi>{r.sectors ? (r.sectors[i].ms / 1000).toFixed(3) : '–'}</bdi></span>)}
                <span className="tb-last"><bdi>{L.fmt(r.last)}</bdi></span>
                <span className={`tb-best${r.isBest ? ' ob' : ''}`}><bdi>{L.fmt(r.best)}</bdi></span>
                <span className="tb-gap"><GapView g={r.gap} /></span>
                <span className="tb-laps"><bdi dir="ltr">{p.totalLaps ? `${r.laps}/${p.totalLaps}` : r.laps}</bdi>{r.finished ? ' ✓' : ''}</span>
            </li>)}
        </ol>
        </div>
        <div className="tb-legend"><span className="ob">סגול</span> הכי מהיר במקצה · <span className="pb">ירוק</span> שיא אישי · ▲▼ מקומות לעומת הזינוק</div>
        {p.footer && <div className="call-next">{p.footer}</div>}
    </div>;
}

/** Lineup board: the heat being called (or next), as driver photo cards with names and kart numbers. */
function CallDisplay(p: { core: L.Core; state: 'call' | 'next' | 'empty'; heat?: L.Heat; controls?: React.ReactNode; onClose: () => void }) {
    useEscape(p.onClose);
    const ds = p.heat ? L.driversOf(p.core, p.heat) : [];
    const staff = L.kartMode(p.core) === 'staff';
    const rest = L.queueOf(p.core).filter(h => h.id !== p.heat?.id).slice(0, 3);
    const waiting = L.waitingGroups(p.core).length;
    const [bodyRef, box] = useBox<HTMLDivElement>();
    const gap = box.w >= 900 ? 14 : 6;
    // longer names get a taller name strip so they wrap fully (never cut), at the cost of a slightly smaller photo
    const longest = ds.reduce((m, d) => Math.max(m, d.label.length), 0);
    const ratio = longest > 16 ? 1.55 : longest > 10 ? 1.4 : CARD_RATIO;
    const { cols, cell } = fitLineup(ds.length, box.w, box.h, gap, ratio);
    const gridStyle = cell ? ({ gridTemplateColumns: `repeat(${cols}, ${cell}px)`, gridAutoRows: `${Math.floor(cell * ratio)}px`, gap: `${gap}px`, '--cell': `${cell}px` } as React.CSSProperties) : undefined;
    return <div className={`wall callwall ${p.state}`} role="dialog" aria-label="מסך קריאה למסלול">
        <header className="lu-head">
            <Logo big />
            <div className="lu-banner"><span>{p.state === 'call' ? 'נקראים למסלול' : p.state === 'next' ? 'הבא בתור' : 'אין מקצים בתור'}</span>{p.heat && <b>מקצה {p.heat.num}</b>}</div>
            <button type="button" className="wall-close" onClick={p.onClose} aria-label="סגור תצוגת מסך">✕</button>
        </header>
        {p.controls}
        <div className="lu-sub">{p.heat ? `${ds.length} נהגים${p.state === 'call' ? ' · לגשת לאזור ההמתנה, לפי מספר הקארט' : ' · עוד לא נקרא, להתכונן'}` : L.cashierOn(p.core) && waiting ? `${waiting} קבוצות ממתינות לשיבוץ` : 'ממתינים למקצה הבא'}</div>
        <div className="wall-sim">סימולציה · שמות ותמונות זמניים לדוגמה · לא חיבור למסלול</div>
        <div className="lu-body" ref={bodyRef}>
        {p.heat && <ul className={`lu-grid${cell ? ' fit' : ''}`} style={gridStyle}>
            {ds.map(d => {
                const hide = staff && !d.kartSet;
                return <li key={d.key} className="lu-card">
                    <div className="lu-photo"><Avatar kart={d.kart} label={d.label} /><span className={`lu-kart${hide ? ' tbd' : ''}`}>{hide ? '?' : d.kart}</span></div>
                    <div className="lu-name">{d.label}</div>
                    {hide ? <div className="lu-note">הצוות יקצה קארט</div> : !d.kartSet && <div className="lu-note">קארט מוצע</div>}
                </li>;
            })}
        </ul>}
        </div>
        {p.state === 'empty' && <div className="call-hint">כשיתווסף מקצה לתור, הוא יופיע כאן.</div>}
        {rest.length > 0 && <div className="call-next"><b>אחר כך:</b> {rest.map(h => `מקצה ${h.num} (${L.heatCount(h)})`).join(' · ')}</div>}
    </div>;
}

function liveRowsOf(core: L.Core, timing: L.DriverTiming[]): BoardRow[] {
    const h = L.runningHeat(core);
    if (!h || !core.live) return [];
    const seed = core.live.seed;
    const drivers = L.driversOf(core, h);
    const ranked = L.rank(timing);
    const leader = ranked[0];
    const bestAll = Math.min(...timing.map(t => t.best ?? Infinity));
    // simulated sectors of every completed lap: overall best (purple) and personal best (green) per sector
    const secs = new Map<string, [number, number, number][]>();
    timing.forEach(t => { const idx = drivers.findIndex(d => d.key === t.key); secs.set(t.key, t.laps.map((ms, n) => L.sectorsOf(ms, seed, idx, n))); });
    const overall = [0, 1, 2].map(i => Math.min(...[...secs.values()].flat().map(x => x[i]), Infinity));
    return ranked.map((t, i) => {
        const d = drivers.find(x => x.key === t.key)!;
        const gap = gapOf(t.laps.length, t.total, leader?.laps.length ?? 0, leader?.total ?? 0, i === 0 || !leader);
        const mine = secs.get(t.key) ?? [];
        const lastS = mine[mine.length - 1];
        const sectors: Sec[] | null = lastS ? lastS.map((ms, k) => ({ ms, cls: ms === overall[k] ? 'ob' : ms === Math.min(...mine.map(x => x[k])) ? 'pb' : '' })) : null;
        const grid = drivers.findIndex(x => x.key === t.key) + 1;
        return { key: t.key, pos: i + 1, kart: d.kart, label: d.label, laps: t.laps.length, best: t.best, last: t.last, gap, finished: t.finished, isBest: t.best != null && t.best === bestAll, sectors, gained: t.laps.length ? grid - (i + 1) : null };
    });
}

function resultRowsOf(r: L.Result): BoardRow[] {
    const bAll = Math.min(...r.rows.map(x => x.best ?? Infinity));
    return r.rows.map((x, i) => ({ key: `${x.pos}`, pos: x.pos, kart: x.kart, label: x.label, laps: x.laps.length, best: x.best, last: x.laps.length ? x.laps[x.laps.length - 1] : null, gap: gapOf(x.laps.length, x.total, r.rows[0].laps.length, r.rows[0].total, i === 0), finished: r.laps ? x.laps.length >= r.laps : true, isBest: x.best != null && x.best === bAll, sectors: null, gained: null }));
}

const mmss = (ms: number) => { const s = Math.ceil(ms / 1000); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

type BoardActions = { call: (id: string) => void; uncall: (id: string) => void; start: (id: string) => void; finish: () => void; saveAndNext: () => void };

/**
 * Marshal controls on the venue screen itself, at the top: התחלה / עצור / שמור (+ call-up).
 * Same rules as the marshal console. Can be hidden for a public screen (⚙ brings them back).
 */
function BoardControls({ core, now, act, shown, setShown }: { core: L.Core; now: number; act: MarshalActions; shown: boolean; setShown: (b: boolean) => void }) {
    if (!shown) return <button type="button" className="ctl-reveal" onClick={() => setShown(true)} aria-label="הצג כפתורי שליטה">⚙</button>;
    const mb = marshalButtons(core, now);
    const t = mb.ms.target;
    const called = L.calledHeat(core);
    return <div className="ctl-bar" role="toolbar" aria-label="בקרת מרשל">
        <button type="button" className="mc-btn go" disabled={!mb.canStart} title={mb.blockers.join(', ')} onClick={act.startOrResume}><span aria-hidden="true">▶</span>{mb.startLabel}{t && mb.ms.state === 'idle' ? ` · מקצה ${t.num}` : ''}</button>
        <button type="button" className="mc-btn stop" disabled={!mb.canStop} onClick={act.pause}><span aria-hidden="true">■</span>עצור</button>
        <button type="button" className="mc-btn save" disabled={!mb.canSave} onClick={act.saveAndNext}><span aria-hidden="true">✓</span>שמור</button>
        {mb.ms.state === 'idle' && t && !called && <button type="button" className="kb" onClick={() => act.call(t.id)}>{`קרא למסלול · מקצה ${t.num}`}</button>}
        {mb.ms.state === 'idle' && called && <button type="button" className="kb" onClick={() => act.uncall(called.id)}>בטל קריאה</button>}
        <button type="button" className="kb ghost ctl-hide" onClick={() => setShown(false)}>הסתר</button>
    </div>;
}

/** Always-visible broadcast state in the staff app bar, so a silent "not on the website" cannot happen. */
function BroadcastChip({ session, on, status, enable, openSettings }: { session: boolean; on: boolean; status: string; enable: () => void; openSettings: () => void }) {
    if (!session) return <button type="button" className="onair-tag bad" onClick={openSettings}>⚠ לא מחובר · לא משדר לאתר</button>;
    if (!on) return <button type="button" className="onair-tag off" onClick={enable}>○ לא משדר לאתר · הפעל</button>;
    if (status.startsWith('השידור נכשל')) return <button type="button" className="onair-tag bad" title={status} onClick={openSettings}>⚠ השידור לאתר נכשל</button>;
    if (!status) return <span className="onair-tag">● מתחבר לאתר…</span>;
    return <span className="onair-tag" title={status}>● משדר לאתר</span>;
}

/** Heat length: 10 or 20 minutes (10 is the minimum). Applies to the next heat that starts. */
function HeatLength({ core, update }: { core: L.Core; update: Update }) {
    const m = L.heatMinutesOf(core);
    const runMin = core.live?.durationMs ? Math.round(core.live.durationMs / 60_000) : null;
    return <div className="field hl-field"><span className="flabel">זמן מקצה</span>
        <div className="chips" role="radiogroup" aria-label="זמן מקצה">
            {L.HEAT_MINUTES.map(v => <button key={v} type="button" role="radio" aria-checked={m === v} className={`chip${m === v ? ' sel' : ''}`} onClick={() => update(c => ({ ...c, settings: { ...c.settings, heatMinutes: v } }))}>{v} דקות</button>)}
        </div>
        {runMin != null && runMin !== m && <p className="meta">המקצה שעל המסלול נשאר {runMin} דקות. השינוי חל מהמקצה הבא.</p>}
    </div>;
}

/** Staff choice: what the customer website shows between heats. */
function PublicViewChips({ core, update }: { core: L.Core; update: Update }) {
    const v = L.publicViewOf(core);
    const set = (pv: L.PublicView) => update(c => ({ ...c, settings: { ...c.settings, publicView: pv } }));
    return <div className="field pv-field"><span className="flabel">מסך הלקוחות בין מקצים</span>
        <div className="chips" role="radiogroup" aria-label="מסך הלקוחות">
            <button type="button" role="radio" aria-checked={v === 'lineup'} className={`chip${v === 'lineup' ? ' sel' : ''}`} onClick={() => set('lineup')}>תור וקריאה למסלול</button>
            <button type="button" role="radio" aria-checked={v === 'heat'} className={`chip${v === 'heat' ? ' sel' : ''}`} onClick={() => set('heat')}>תוצאות אחרונות</button>
        </div>
        <p className="meta">{v === 'heat' ? 'בזמן מקצה: זמנים חיים. בין מקצים: התוצאות של המקצה האחרון.' : 'בזמן מקצה: זמנים חיים. בין מקצים: התור והנהגים שנקראים למסלול.'}</p>
    </div>;
}

/** The venue screen: switches by itself between lineup (call / next / empty) and live timing, with its own controls. */
function TrackScreen({ core, now, onClose, act, ctlShown = true, setCtlShown = () => {} }: { core: L.Core; now: number; onClose: () => void; act?: MarshalActions; ctlShown?: boolean; setCtlShown?: (b: boolean) => void }) {
    const sc = L.screenState(core);
    // staff screens get the marshal controls; the public website (no act) shows the board only
    const controls = act ? <BoardControls core={core} now={now} act={act} shown={ctlShown} setShown={setCtlShown} /> : undefined;
    if (sc.state === 'race' && sc.heat) {
        const timing = L.liveTiming(core, now);
        const done = L.allFinished(timing);
        const called = L.calledHeat(core);
        const el = L.elapsedOf(core.live, now);
        const paused = L.isPaused(core);
        return <WallDisplay title={`מקצה ${sc.heat.num}`} sub={done ? 'הסתיים · תוצאות' : paused ? 'המקצה עצור' : 'על המסלול · בלייב'} totalLaps={L.lapTargetOf(core)} state={done ? 'done' : paused ? 'wait' : 'live'}
            clock={L.fmt(Math.min(L.raceClock(timing, el), 3_600_000))} countdown={mmss(L.remainingOf(core, timing, now))} rows={liveRowsOf(core, timing)} onClose={onClose}
            footer={called ? <><b>נקראים למסלול:</b> מקצה {called.num} ({L.heatCount(called)} נהגים)</> : undefined} controls={controls} />;
    }
    return <CallDisplay core={core} state={sc.state === 'race' ? 'empty' : sc.state} heat={sc.heat} onClose={onClose} controls={controls} />;
}

// --------------------------------------------------------------------- marshal console (core)
// The main screen of the timing system: marshal controls at the top (התחלה / עצור / שמור), the live
// timing table, name editing, a nameless quick start and the queue. Timing is SIMULATED.
type MarshalActions = BoardActions & { startOrResume: () => void; pause: () => void; quickStart: (n: number) => string | undefined; cancel: () => void };
type LiveProps = {
    core: L.Core; update: Update; now: number; hist: L.Result[];
    auto: boolean; setAuto: (b: boolean) => void; openScreen: (s: 'track' | 'last') => void;
    act: MarshalActions; goHeats: () => void;
};

const STATE_LABEL: Record<L.MarshalState, string> = { idle: 'ממתין', running: 'רץ', paused: 'עצור', finished: 'הסתיים' };

/** Marshal permissions for the three top buttons (shared by the console and the venue screen). */
function marshalButtons(core: L.Core, now: number) {
    const ms = L.marshalState(core, now);
    const blockers = ms.target ? L.startBlockers(core, ms.target) : [];
    const anyLap = ms.heat ? L.liveTiming(core, now).some(t => t.laps.length > 0) : false;
    return {
        ms,
        canStart: ms.state === 'paused' || (ms.state === 'idle' && !!ms.target && blockers.length === 0),
        startLabel: ms.state === 'paused' ? 'המשך' : 'התחלה',
        canStop: ms.state === 'running',
        canSave: ms.state === 'finished' || ms.state === 'paused' || (ms.state === 'running' && anyLap),
        blockers,
    };
}

/** Driver names (and karts before the race) edited inline. Karts are locked during the race. */
function NameEditor({ core, heat, update, karts }: { core: L.Core; heat: L.Heat; update: Update; karts: boolean }) {
    const ds = L.driversOf(core, heat);
    const clash = new Set(L.kartConflicts(core, heat));
    return <ul className="ne-list" aria-label="שמות נהגים">
        {ds.map((d, i) => <li key={d.key} className="ne-row">
            <span className="ne-idx">{i + 1}</span>
            {karts
                ? <input key={`k-${d.key}-${d.kartSet ? d.kart : 'x'}`} className={`inp ne-kart${clash.has(d.kart) ? ' clash' : ''}`} type="number" inputMode="numeric" min={1} max={99} aria-label={`קארט נהג ${i + 1}`} placeholder={String(d.kart)} defaultValue={d.kartSet ? d.kart : ''}
                    onBlur={e => { const v = Number(e.target.value); const cur = d.kartSet ? d.kart : 0; if ((v || 0) !== cur) update(c => L.setDriver(c, heat.id, d.key, { kart: v })); }} />
                : <span className="ne-kartb">{d.kart}</span>}
            <input key={`n-${d.key}-${d.label}`} className="inp ne-name" aria-label={`שם נהג ${i + 1}`} placeholder={d.label} defaultValue={d.nameSet ? d.label : ''} maxLength={24}
                onBlur={e => { const v = e.target.value.trim(); if (v !== (d.nameSet ? d.label : '')) update(c => L.setDriver(c, heat.id, d.key, { name: v })); }}
                onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
        </li>)}
        {clash.size > 0 && <li className="warn">אותו קארט לשני נהגים: {[...clash].join(', ')}</li>}
    </ul>;
}

function MarshalTable({ rows, laps }: { rows: BoardRow[]; laps: number }) {
    return <table className="mt">
        <thead><tr><th>מק׳</th><th>קארט</th><th className="mt-name">נהג</th><th>הקפות</th><th>אחרונה</th><th>מהירה</th><th>פער</th></tr></thead>
        <tbody>
            {rows.map(r => <tr key={r.key} className={r.pos === 1 ? 'lead' : ''}>
                <td className="mt-pos">{r.pos}</td>
                <td><span className="mt-kart">{r.kart}</span></td>
                <td className="mt-name">{r.label}</td>
                <td className="mt-num"><bdi dir="ltr">{laps ? `${r.laps}/${laps}` : r.laps}</bdi>{r.finished ? ' ✓' : ''}</td>
                <td className="mt-num"><bdi>{L.fmt(r.last)}</bdi></td>
                <td className={`mt-num${r.isBest ? ' ob' : ''}`}><bdi>{L.fmt(r.best)}</bdi></td>
                <td className="mt-num"><GapView g={r.gap} /></td>
            </tr>)}
        </tbody>
    </table>;
}

function Live({ core, update, now, hist, auto, setAuto, openScreen, act, goHeats }: LiveProps) {
    const [editNames, setEditNames] = useState(false);
    const [editId, setEditId] = useState<string | null>(null);
    const [qn, setQn] = useState(8);
    const [qMsg, setQMsg] = useState('');
    const [tools, setTools] = useState(false);
    const cashier = L.cashierOn(core);
    const mb = marshalButtons(core, now);
    const { ms } = mb;
    const heat = ms.heat;
    const timing = L.liveTiming(core, now);
    const rows = liveRowsOf(core, timing);
    const clock = heat ? L.fmt(Math.min(L.raceClock(timing, L.elapsedOf(core.live, now)), 3_600_000)) : '0.00';
    const qList = L.queueOf(core);
    const calledH = L.calledHeat(core);
    const lastRes = hist[0];
    const n = Math.min(qn, core.settings.capacity);
    const shownHeat = heat ?? ms.target;
    const addHeat = () => {
        let res: { error?: string } = {};
        update(c => { const r = L.addTrackHeat(c, n, Date.now()); res = r; return r.core; });
        setQMsg(res.error ?? 'נוסף לתור.');
    };

    return <div className="mc">
        <div className="mc-bar" role="toolbar" aria-label="בקרת מרשל">
            <div className="mc-status">
                <span className={`mc-state ${ms.state}`}>{STATE_LABEL[ms.state]}</span>
                <span className="mc-heat">{shownHeat ? `מקצה ${shownHeat.num}` : 'אין מקצה'}<small>{shownHeat ? ` · ${L.heatCount(shownHeat)} נהגים` : ''}</small></span>
                <span className="mc-clock" aria-label="זמן מקצה"><bdi>{clock}</bdi></span>
                {heat && core.live?.durationMs ? <span className="mc-left" aria-label="זמן שנותר"><small>נותר</small><bdi>{mmss(L.remainingOf(core, timing, now))}</bdi></span> : null}
            </div>
            <div className="mc-btns">
                <button type="button" className="mc-btn go" disabled={!mb.canStart} onClick={act.startOrResume}><span aria-hidden="true">▶</span>{mb.startLabel}</button>
                <button type="button" className="mc-btn stop" disabled={!mb.canStop} onClick={act.pause}><span aria-hidden="true">■</span>עצור</button>
                <button type="button" className="mc-btn save" disabled={!mb.canSave} onClick={act.saveAndNext}><span aria-hidden="true">✓</span>שמור</button>
            </div>
        </div>
        {ms.state === 'idle' && ms.target && mb.blockers.length > 0 && <p className="mc-warn">לא ניתן להתחיל את מקצה {ms.target.num}: {mb.blockers.join(', ')}</p>}

        <div className="mc-grid">
            <section className="mc-card mc-main" aria-label={heat ? 'זמנים חיים' : 'המקצה הבא'}>
                <header className="mc-card-h">
                    <h2>{heat ? 'זמנים חיים' : ms.target ? `המקצה הבא · מקצה ${ms.target.num}` : 'אין מקצה בתור'}</h2>
                    {heat && <button type="button" className="kb sm" aria-pressed={editNames} onClick={() => setEditNames(!editNames)}>{editNames ? 'סגור עריכת שמות' : 'ערוך שמות'}</button>}
                    <span className="mc-sim">זמנים מדומים</span>
                </header>
                {heat && !editNames && <MarshalTable rows={rows} laps={L.lapTargetOf(core)} />}
                {heat && editNames && <><p className="meta">שמות בלבד בזמן מקצה. הקארטים נעולים עד הסוף.</p><NameEditor core={core} heat={heat} update={update} karts={false} /></>}
                {!heat && ms.target && <><p className="meta">אפשר להקליד שמות, להשאיר ריק ולהתחיל בלי שמות, או להשלים שמות תוך כדי מקצה.</p><NameEditor core={core} heat={ms.target} update={update} karts /></>}
                {!heat && !ms.target && <div className="empty"><p>{cashier ? 'אין מקצה מאושר בתור. מקצים נבנים מקבוצות ששילמו (לשוניות קופה ומקצים).' : 'אין מקצה בתור. התחל מקצה מהיר בלי שמות, או הוסף מקצה לתור.'}</p>{cashier && <Btn small onClick={goHeats}>למקצים</Btn>}</div>}
            </section>

            <aside className="mc-side">
                {!cashier ? <section className="mc-card" aria-label="מקצה מהיר">
                    <header className="mc-card-h"><h2>מקצה מהיר</h2></header>
                    <HeatLength core={core} update={update} />
                    <Stepper label="כמה נהגים" value={n} min={1} max={core.settings.capacity} onChange={v => { setQn(v); setQMsg(''); }} />
                    <div className="mc-actions">
                        <Btn kind="primary" disabled={!!heat} onClick={() => setQMsg(act.quickStart(n) ?? 'המקצה התחיל בלי שמות. אפשר להוסיף שמות ב"ערוך שמות".')}>התחל עכשיו בלי שמות</Btn>
                        <Btn onClick={addHeat}>הוסף לתור</Btn>
                    </div>
                    {qMsg && <p className="meta" role="status">{qMsg}</p>}
                </section> : <section className="mc-card"><p className="meta">תוסף הקופה פעיל: מקצה מהיר כבוי כדי ששער התשלום לא יעקף.</p></section>}

                <section className="mc-card" aria-label="תור">
                    <header className="mc-card-h"><h2>תור ({qList.length})</h2></header>
                    {qList.length === 0 ? <p className="meta">ריק</p> : <ol className="mq">
                        {qList.map(h => <li key={h.id} className={h.called ? 'called' : ''}>
                            <div className="mq-top"><strong>מקצה {h.num}</strong><span className="meta">{L.heatCount(h)} נהגים</span>{h.called && <span className="badge called">נקרא</span>}</div>
                            <div className="mq-actions">
                                {h.called ? <button type="button" className="kb sm" onClick={() => act.uncall(h.id)}>בטל קריאה</button> : <button type="button" className="kb sm" disabled={!!calledH} onClick={() => act.call(h.id)}>קרא למסלול</button>}
                                <button type="button" className="kb sm" onClick={() => setEditId(editId === h.id ? null : h.id)}>{editId === h.id ? 'סגור' : 'שמות'}</button>
                                <button type="button" className="kb sm" onClick={goHeats}>הרכב</button>
                            </div>
                            {editId === h.id && <NameEditor core={core} heat={h} update={update} karts />}
                        </li>)}
                    </ol>}
                </section>

                <section className="mc-card" aria-label="מסך ותצוגה">
                    <PublicViewChips core={core} update={update} />
                    <div className="mc-actions">
                        <Btn onClick={() => openScreen('track')}>פתח מסך תצוגה</Btn>
                        {lastRes && <Btn onClick={() => openScreen('last')}>{`תוצאה אחרונה · מקצה ${lastRes.heatNum}`}</Btn>}
                    </div>
                    <button type="button" className="linkish mc-tools-t" aria-expanded={tools} onClick={() => setTools(!tools)}>{tools ? '▾' : '▸'} כלי הדגמה</button>
                    {tools && <div className="mc-tools">
                        <div className="mc-actions">
                            <Btn kind={auto ? 'on' : 'ghost'} onClick={() => { const on = !auto; setAuto(on); if (on) openScreen('track'); }}>{auto ? '■ עצור דמו אוטומטי' : '▶ דמו אוטומטי'}</Btn>
                            {!heat && <Btn onClick={() => { update(c => (L.cashierOn(c) ? L.demoSetup(c, Date.now()) : L.demoTrackSetup(c, Date.now()))); setAuto(true); openScreen('track'); }}>⚡ הדגמה מלאה</Btn>}
                            <Btn small onClick={() => update(L.fillDemoNames)}>מלא שמות דמו</Btn>
                            {heat && <Btn small kind="danger" onClick={act.cancel}>בטל מקצה בלי לשמור</Btn>}
                        </div>
                        {heat && <div className="chips" role="radiogroup" aria-label="מהירות סימולציה">
                            {SPEEDS.map(sp => <button key={sp} type="button" role="radio" aria-checked={core.live?.speed === sp} className={`chip${core.live?.speed === sp ? ' sel' : ''}`} onClick={() => update(c => L.setSpeed(c, sp, Date.now()))}>x{sp}</button>)}
                        </div>}
                        <p className="meta">הזמנים מומצאים על ידי האפליקציה. אין חיבור לשעון ההקפות או למסכים של המסלול.</p>
                    </div>}
                </section>
            </aside>
        </div>
    </div>;
}

// ------------------------------------------------------------------ history
function History({ hist }: { hist: L.Result[] }) {
    const [q, setQ] = useState('');
    const [open, setOpen] = useState<string | null>(null);
    const shown = hist.filter(r => !q.trim() || r.rows.some(x => x.label.includes(q.trim())));
    return <Group label="היסטוריית מקצים" heading>
        <label className="field"><span className="flabel">חיפוש לפי שם</span>
            <input className="inp" value={q} onChange={e => setQ(e.target.value)} placeholder="שם קבוצה או נהג" />
        </label>
        {hist.length === 0 && <p className="empty">עוד אין מקצים שהסתיימו. הרץ מקצה בלשונית מסלול (או את הדמו האוטומטי).</p>}
        <ul className="list">
            {shown.map(r => {
                const id = `${r.heatId}-${r.at}`;
                const isOpen = open === id;
                const q2 = q.trim();
                return <li key={id} className="item">
                    <button type="button" className="hhead" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : id)}>
                        <strong>מקצה {r.heatNum}</strong>
                        <span className="meta">{dayOf(r.at)} {timeOf(r.at)} · {r.rows.length} נהגים · {r.simulated ? 'סימולציה' : 'אמיתי'}</span>
                        <span aria-hidden="true">{isOpen ? '▴' : '▾'}</span>
                    </button>
                    {isOpen && (() => {
                        const bAll = Math.min(...r.rows.map(x => x.best ?? Infinity));
                        return <table className="mt mt-hist">
                            <thead><tr><th>מק׳</th><th>קארט</th><th className="mt-name">נהג</th><th>הקפות</th><th>מהירה</th><th>סה״כ</th></tr></thead>
                            <tbody>{r.rows.map(x => <tr key={x.pos} className={`${x.pos === 1 ? 'lead' : ''}${q2 && x.label.includes(q2) ? ' hit' : ''}`}>
                                <td className="mt-pos">{x.pos}</td>
                                <td><span className="mt-kart">{x.kart}</span></td>
                                <td className="mt-name">{x.label}</td>
                                <td className="mt-num"><bdi dir="ltr">{r.laps ? `${x.laps.length}/${r.laps}` : x.laps.length}</bdi></td>
                                <td className={`mt-num${x.best != null && x.best === bAll ? ' ob' : ''}`}><bdi>{L.fmt(x.best)}</bdi></td>
                                <td className="mt-num"><bdi>{L.fmt(x.total)}</bdi></td>
                            </tr>)}</tbody>
                        </table>;
                    })()}
                </li>;
            })}
        </ul>
    </Group>;
}

// ----------------------------------------------------------------- settings
/** Staff sign-in for the public timing website. While signed in and switched on, this device publishes the board. */
function PublicSite({ session, on, setOn, status }: { session: Session | null; on: boolean; setOn: (b: boolean) => void; status: string }) {
    const [email, setEmail] = useState('');
    const [pw, setPw] = useState('');
    const [err, setErr] = useState('');
    const [busy, setBusy] = useState(false);
    const url = `${location.origin}${location.pathname}`;
    const login = async () => { setBusy(true); setErr(''); const e = await Cloud.signIn(email.trim(), pw); setBusy(false); if (e) setErr('הכניסה נכשלה: ' + e); else setPw(''); };
    return <Group label="אתר צפייה ציבורי" heading>
        <p className="meta">כל אחד יכול לפתוח את <a href={url} target="_blank" rel="noreferrer">{url}</a> ולראות בזמן אמת את מסך הקריאה ולוח הזמנים. רק מכשיר של צוות מחובר משדר אליו. רישומים שעוד לא שולמו לא נשלחים לאתר.</p>
        {!session ? <>
            <label className="field"><span className="flabel">שם משתמש</span><input className="inp" type="text" autoCapitalize="none" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} dir="ltr" /></label>
            <label className="field"><span className="flabel">סיסמה</span><input className="inp" type="password" autoComplete="current-password" value={pw} onChange={e => setPw(e.target.value)} dir="ltr" /></label>
            <Btn kind="primary" disabled={busy || !email.trim() || !pw} onClick={login}>{busy ? 'מתחבר…' : 'כניסת צוות'}</Btn>
            {err && <p className="err" role="alert">{err}</p>}
        </> : <>
            <p className="meta">מחובר כ-<bdi>{session.user.email?.replace('@' + Cloud.STAFF_DOMAIN, '')}</bdi>.</p>
            <div className="row-actions">
                <Btn kind={on ? 'on' : 'primary'} onClick={() => setOn(!on)}>{on ? '● משדר לאתר · עצור' : 'התחל לשדר לאתר'}</Btn>
                <Btn kind="ghost" onClick={() => { setOn(false); void Cloud.signOut(); }}>התנתק</Btn>
            </div>
            {status && <p className={status.startsWith('✓') ? 'meta' : 'err'} role="status">{status}</p>}
        </>}
    </Group>;
}

function Settings({ core, update, hist, onReset, site }: { core: L.Core; update: Update; hist: L.Result[]; onReset: () => void; site?: React.ReactNode }) {
    const s = core.settings;
    const [t, setT] = useState('');
    const [confirm, setConfirm] = useState(false);
    const upd = (p: Partial<L.Settings>) => update(c => ({ ...c, settings: { ...c.settings, ...p } }));
    const overDraft = core.heats.filter(h => h.status === 'draft' && L.heatCount(h) > s.capacity).length;
    const overQueued = core.heats.filter(h => h.status === 'approved' && L.heatCount(h) > s.capacity).length;
    return <>
        {site}
        <Group label="תוספים" heading>
            <div className="field"><span className="flabel">תוסף קופה (הרשמה + אישור תשלום)</span>
                <div className="chips" role="radiogroup" aria-label="תוסף קופה">
                    <button type="button" role="radio" aria-checked={!L.cashierOn(core)} className={`chip${!L.cashierOn(core) ? ' sel' : ''}`} onClick={() => upd({ cashierEnabled: false })}>כבוי</button>
                    <button type="button" role="radio" aria-checked={L.cashierOn(core)} className={`chip${L.cashierOn(core) ? ' sel' : ''}`} onClick={() => upd({ cashierEnabled: true })}>פעיל</button>
                </div>
                <p className="meta">מערכת הזמנים עובדת לבד: מקצים, לוח זמנים, מסכים והיסטוריה. כשהתוסף פעיל מופיעות לשוניות "קופה" ו"הרשמה", מקצים נבנים רק מקבוצות שאושר להן תשלום, והוספת מקצה ישירות מהמסלול נסגרת. התשלום מדומה: אין סליקה.</p>
            </div>
        </Group>
        <Group label="הגדרות" heading>
            <div className="field"><span className="flabel">קיבולת מקצה (קארטים)</span>
                <div className="chips" role="radiogroup" aria-label="קיבולת">
                    {L.CAPACITY_OPTIONS.map(n => <button key={n} type="button" role="radio" aria-checked={s.capacity === n} className={`chip${s.capacity === n ? ' sel' : ''}`} onClick={() => upd({ capacity: n })}>{n}</button>)}
                </div>
            </div>
            <Stepper label="או ערך אחר" value={s.capacity} min={L.MIN_CAP} max={L.MAX_CAP} onChange={n => upd({ capacity: n })} />
            <p className="meta">פתוח: הוזכרו 10 וגם 14, הערך הנכון לא אושר. ברירת המחדל 10. אחרי שינוי לחץ "שבץ מחדש" בלשונית מקצים.{overDraft > 0 ? ` ${overDraft} טיוטות חורגות עכשיו.` : ''}{overQueued > 0 ? ` ${overQueued} מקצים בתור חורגים ולא יעלו למסלול עד שיתוקנו.` : ''}</p>
            <HeatLength core={core} update={update} />
            <p className="meta">המקצה רץ לפי זמן: כשהזמן נגמר כל נהג משלים את ההקפה שהוא בה ומסיים. מינימום 10 דקות. ההקפות מדומות.</p>
            <div className="field"><span className="flabel">מי קובע קארט לנהג</span>
                <div className="chips" role="radiogroup" aria-label="שיוך קארט">
                    {([['unset', 'עוד לא הוחלט (הצעה, אפשר לערוך)'], ['cashier', 'נבחר מראש עם השמות'], ['staff', 'הצוות מקצה בעלייה']] as [L.KartMode, string][]).map(([k, label]) => <button key={k} type="button" role="radio" aria-checked={L.kartMode(core) === k} className={`chip${L.kartMode(core) === k ? ' sel' : ''}`} onClick={() => upd({ kartMode: k })}>{label}</button>)}
                </div>
                <p className="meta">פתוח: עוד לא הוחלט. "הקופאית בוחרת" דורש קארט לכל נהג לפני אישור. "הצוות מקצה" מציג במסך "הצוות יקצה" עד שנבחר קארט. אין זיהוי אוטומטי של קארטים שחונים במסלול.</p>
            </div>
            <div className="field"><span className="flabel">סוגי כרטיס</span>
                <div className="chips">{s.tickets.map(x => <button key={x} type="button" className="chip" onClick={() => s.tickets.length > 1 && upd({ tickets: s.tickets.filter(y => y !== x) })} aria-label={`הסר ${x}`}>{x} ✕</button>)}</div>
                <div className="inline"><input className="inp" value={t} onChange={e => setT(e.target.value)} placeholder="סוג חדש" maxLength={24} /><Btn onClick={() => { const v = t.trim(); if (v && !s.tickets.includes(v)) { upd({ tickets: [...s.tickets, v] }); setT(''); } }}>הוסף</Btn></div>
                <p className="meta">שמות בלבד. האפליקציה לא מחזיקה מחירים ולא גובה תשלום.</p>
            </div>
        </Group>
        <Group label="מה אמיתי ומה לא" heading>
            <Callout title="נתוני דמה בלבד" tone="warning">אין חיבור לשרת, לקופה, למסכים או לשעון ההקפות של העסק. אין תשלומים ואין נתוני לקוחות. אל תקליד כאן פרטים אישיים של לקוחות.</Callout>
            <ul className="plain">
                <li><b>שמירה:</b> במכשיר ובדפדפן הזה בלבד. טלפון אחד לא רואה את מה שהוזן במחשב. מערכת משותפת לכמה מכשירים ומסכים דורשת שרת, והיא שלב הבא.</li>
                <li><b>זמנים:</b> מדומים. הקוד מפריד את מקור הזמנים (TimingFeed) מהמסך, כך שבהמשך אפשר להחליף אותו במקור קריאה בלבד, אם יהיה אישור וגישה.</li>
                <li><b>קריאה למסלול:</b> מסך בלבד, בלי הכרזה קולית. מה מפעיל קריאה באתר האמיתי עוד לא הוחלט. התזמונים בדמו האוטומטי להמחשה.</li>
                <li><b>כללי שיבוץ:</b> הצעה בלבד. בטיחות, גיל וגובה לא מוגדרים כאן.</li>
            </ul>
        </Group>
        <Group label="גיבוי ואיפוס" heading>
            <div className="row-actions">
                <CopyButton text={JSON.stringify({ core, history: hist }, null, 1)} label="העתק נתונים (JSON)" />
            </div>
            {!confirm ? <Btn kind="danger" onClick={() => setConfirm(true)}>איפוס כל הנתונים</Btn> : <div className="row-actions"><span>למחוק הכול במכשיר הזה?</span><Btn kind="danger" onClick={() => { onReset(); setConfirm(false); }}>כן, מחק</Btn><Btn onClick={() => setConfirm(false)}>ביטול</Btn></div>}
        </Group>
    </>;
}

// ---------------------------------------------------------------------- app
export function App() {
    const [core, setCoreRaw, savedCore] = useLocalState<L.Core>('dankart.core.v1', L.initialCore());
    const [hist, setHistRaw, savedHist] = useLocalState<L.Result[]>('dankart.hist.v1', []);
    const [tab, setTab] = useState<Tab>('live');
    const [ctlShown, setCtlShown] = useState(true);
    const [screen, setScreen] = useState<'track' | 'last' | null>(null);
    const [auto, setAutoRaw] = useState(false);
    const [now, setNow] = useState(() => Date.now());
    const ready = savedCore.ready && savedHist.ready;

    // Latest state for timers and chained edits: every change goes through update(fn) on the newest core.
    const coreRef = useRef(core); coreRef.current = core;
    const histRef = useRef(hist); histRef.current = hist;
    const readyRef = useRef(ready); readyRef.current = ready;
    const update: Update = fn => {
        if (!readyRef.current) return;
        const next = fn(coreRef.current);
        if (next === coreRef.current) return;
        coreRef.current = next;
        setCoreRaw(next);
    };
    const setHist = (h: L.Result[]) => { if (readyRef.current) { histRef.current = h; setHistRaw(h); } };
    // Data saved before the payment gate: groups without a paid flag become unpaid unless a paid submission made them.
    useEffect(() => { if (ready) update(L.migrateCore); }, [ready]);

    // Public website: staff session + "broadcast" switch (per device). Publishes the board on every change.
    const [session, setSession] = useState<Session | null>(null);
    useEffect(() => Cloud.onSession(setSession), []);
    const [broadcast, setBroadcast] = useLocalState<boolean>('dankart.broadcast.v2', true);
    const [pubStatus, setPubStatus] = useState('');
    const sending = ready && !!session && broadcast;
    useEffect(() => {
        if (!sending) { setPubStatus(''); return; }
        const t = setTimeout(() => {
            void Cloud.publishBoard(Cloud.boardOf(core, Date.now(), hist)).then(e => setPubStatus(e ? `השידור נכשל: ${e}` : `✓ עודכן באתר ב-${new Date().toLocaleTimeString('he-IL')}`));
        }, 300);
        const beat = setInterval(() => void Cloud.publishBoard(Cloud.boardOf(coreRef.current, Date.now(), histRef.current)).then(e => setPubStatus(e ? `השידור נכשל: ${e}` : `✓ עודכן באתר ב-${new Date().toLocaleTimeString('he-IL')}`)), 10_000);
        return () => { clearTimeout(t); clearInterval(beat); };
    }, [sending, core, hist]);
    // Every heat this device finished goes to the cloud archive as soon as staff is signed in (catches up after offline use).
    useEffect(() => { if (ready && session) void Cloud.archiveHeats(histRef.current); }, [ready, session]);

    const autoRef = useRef(auto); autoRef.current = auto;
    const start = (id: string) => update(c => L.startHeat(c, id, Date.now(), Date.now() % 100000, autoRef.current ? DEMO.speed : 5));
    const save = () => {
        const { core: next, result } = L.finishRun(coreRef.current, Date.now());
        if (result) { setHist(L.trimHistory([result, ...histRef.current])); void Cloud.archiveHeats([result]); }
        update(() => next);
    };
    const setAuto = (b: boolean) => { autoRef.current = b; phase.current = { key: '', since: 0 }; setAutoRaw(b); };
    const cancel = () => { setAuto(false); update(L.cancelRun); };
    // board controls: save the finished heat, then call the next one in the queue (if nothing is called yet)
    const saveAndNext = () => {
        save();
        update(c => { const n = L.queueOf(c)[0]; return n && !L.calledHeat(c) ? L.callHeat(c, n.id) : c; });
    };
    const boardActions: MarshalActions = {
        call: id => update(c => L.callHeat(c, id)),
        uncall: id => update(c => L.uncallHeat(c, id)),
        start,
        finish: save,
        saveAndNext,
        // התחלה: resume a stopped heat, otherwise start the called (or next) heat
        startOrResume: () => {
            const c = coreRef.current;
            if (L.isPaused(c)) return update(x => L.resumeRun(x, Date.now()));
            const t = L.marshalState(c, Date.now()).target;
            if (t) start(t.id);
        },
        pause: () => update(c => L.pauseRun(c, Date.now())),
        quickStart: (n: number) => {
            let err: string | undefined;
            update(c => { const r = L.quickStartHeat(c, n, Date.now(), Date.now() % 100000, autoRef.current ? DEMO.speed : 5); err = r.error; return r.core; });
            return err;
        },
        cancel,
    };

    // Demo autopilot: a small state machine driven by the same ticker as the clock.
    // call next -> start -> race -> (results shown, next heat called) -> save -> start the called heat ...
    const phase = useRef({ key: '', since: 0 });
    const step = (t: number) => {
        if (!autoRef.current) return;
        const c = coreRef.current;
        const running = L.runningHeat(c);
        const called = L.calledHeat(c);
        const next = L.queueOf(c)[0];
        const done = !!running && L.allFinished(L.liveTiming(c, t));
        const key = running ? `race:${running.id}:${done}` : called ? `call:${called.id}` : next ? `next:${next.id}` : 'empty';
        if (phase.current.key !== key) phase.current = { key, since: t };
        const age = t - phase.current.since;
        if (running) {
            if (!done) return;
            if (!called && next && age >= DEMO.callAfterMs) update(x => L.callHeat(x, next.id));
            if (age >= DEMO.resultsHoldMs) save();
        } else if (called) {
            if (age >= DEMO.startAfterMs && L.startBlockers(c, called).length === 0) start(called.id);
        } else if (next && age >= DEMO.callAfterMs) {
            update(x => L.callHeat(x, next.id));
        }
    };
    const stepRef = useRef(step); stepRef.current = step;
    const ticking = !!core.live || auto;
    useEffect(() => {
        if (!ticking) return;
        const i = setInterval(() => { const t = Date.now(); setNow(t); stepRef.current(t); }, 200);
        return () => clearInterval(i);
    }, [ticking]);

    const msg = `${savedCore.message || ''} ${savedHist.message || ''}`.trim();
    const volatile = ready && /not saved|only while|memory/i.test(msg);
    const persistNote = !ready ? 'טוען…' : volatile
        ? 'בתצוגה הזו השינויים לא נשמרים: הם נשארים רק כל עוד הקובץ פתוח.'
        : /fail|error|unavailable|blocked|full/i.test(msg) ? `השמירה במכשיר לא הצליחה (${msg}).` : 'השינויים נשמרים במכשיר הזה בלבד.';
    const pending = L.waitingGroups(core).length;
    const counts: Partial<Record<Tab, number>> = { cashier: pending + L.pendingOf(core).length, heats: core.heats.filter(h => h.status === 'draft' && h.entries.length > 0).length, live: L.queueOf(core).length };
    const lastRes = hist[0];
    const goHeats = () => setTab('heats');
    const cashier = L.cashierOn(core);
    const tabs = cashier ? [...CORE_TABS, ...ADDON_TABS] : CORE_TABS;
    const shownTab: Tab = tabs.some(t => t.id === tab) ? tab : 'live';

    return <FileCard lang="he">
        <div className={`dk${shownTab === 'live' ? ' wide' : ''}`}>
            <header className="appbar">
                <Logo />
                <div className="appbar-title"><h1>מערכת זמנים</h1><span>Dan Karting · קארטינג · גרסה {__BUILD__}</span></div>
                <div className="appbar-meta">
                    {core.live && <button type="button" className={`onair${L.isPaused(core) ? ' paused' : ''}`} onClick={() => setTab('live')}>● מקצה {L.runningHeat(core)?.num} {L.isPaused(core) ? 'עצור' : 'על המסלול'}</button>}
                    <span className="sim-badge" title="אין חיבור לשעון ההקפות, לשרת או למסכים של המסלול">סימולציה</span>
                    {cashier && <span className="addon-badge">תוסף קופה</span>}
                    {ready && <BroadcastChip session={!!session} on={broadcast} status={pubStatus} enable={() => setBroadcast(true)} openSettings={() => setTab('settings')} />}
                </div>
            </header>
            <nav className="tabs" aria-label="מסכים" style={{ gridTemplateColumns: `repeat(${tabs.length}, 1fr)` }}>
                {tabs.map(t => <button key={t.id} type="button" className={`${shownTab === t.id ? 'on' : ''}${ADDON_TABS.some(a => a.id === t.id) ? ' addon' : ''}`} aria-current={shownTab === t.id ? 'page' : undefined} onClick={() => setTab(t.id)}>{t.label}{t.id === 'live' && core.live ? <i className="live-dot" aria-label="מקצה על המסלול">●</i> : counts[t.id] ? <i>{counts[t.id]}</i> : null}</button>)}
            </nav>
            {!ready && <p className="empty">טוען נתונים שמורים…</p>}
            {ready && shownTab === 'form' && <CustomerForm core={core} update={update} />}
            {ready && shownTab === 'cashier' && <Cashier core={core} update={update} goHeats={goHeats} />}
            {ready && shownTab === 'heats' && <Heats core={core} update={update} />}
            {ready && shownTab === 'live' && <Live core={core} update={update} now={now} hist={hist} auto={auto} setAuto={setAuto} openScreen={setScreen} act={boardActions} goHeats={goHeats} />}
            {ready && shownTab === 'history' && <History hist={hist} />}
            {ready && shownTab === 'settings' && <Settings site={<PublicSite session={session} on={broadcast} setOn={setBroadcast} status={pubStatus} />} core={core} update={update} hist={hist} onReset={() => { setAuto(false); setScreen(null); update(() => L.initialCore()); setHist([]); }} />}
            <Closing>{persistNote} לא נשלח ולא שולם דבר.</Closing>
            {ready && screen === 'track' && <TrackScreen core={core} now={now} onClose={() => setScreen(null)} act={boardActions} ctlShown={ctlShown} setCtlShown={setCtlShown} />}
            {ready && screen === 'last' && lastRes && <WallDisplay title={`תוצאות מקצה ${lastRes.heatNum}`} sub={`${dayOf(lastRes.at)} ${timeOf(lastRes.at)}`} totalLaps={lastRes.laps} state="done" rows={resultRowsOf(lastRes)} onClose={() => setScreen(null)} />}
        </div>
    </FileCard>;
}

// ------------------------------------------------------------- public board
/**
 * The published board comes from a signed-in staff device, which already applied the payment gate.
 * Boards published by the previous version carry no paid flag at all: show those groups (display only).
 * Groups explicitly marked unpaid (paid: false) stay hidden.
 */
const publicCore = (core: L.Core): L.Core => ({ ...core, groups: core.groups.map(g => (typeof g.paid === 'boolean' ? g : { ...g, paid: true })) });

/** The public website: read-only venue screen that follows the staff device in real time. No login. */
export function PublicBoard() {
    const [board, setBoard] = useState<Cloud.BoardPayload | null>(null);
    const [conn, setConn] = useState('connecting');
    const [loaded, setLoaded] = useState(false);
    const [now, setNow] = useState(() => Date.now());
    const [showHist, setShowHist] = useState(false);
    useEffect(() => {
        const take = (p: Cloud.BoardPayload) => setBoard(p);
        void Cloud.fetchBoard().then(p => { if (p) take(p); setLoaded(true); });
        return Cloud.subscribeBoard(take, setConn);
    }, []);
    useEffect(() => { const i = setInterval(() => setNow(Date.now()), 200); return () => clearInterval(i); }, []);
    if (!loaded) return <div className="dk pub-wait"><Logo big /><p>טוען…</p></div>;
    if (!board) return <div className="dk pub-wait"><Logo big /><p>הלוח עוד לא פעיל. כשהצוות יתחיל לשדר, המקצים והזמנים יופיעו כאן.</p><StaffShield /></div>;
    const hist = board.hist ?? [];
    if (showHist) return <div className="dk pub-hist">
        <div className="pub-hist-top"><Logo /><button type="button" className="kb primary" onClick={() => setShowHist(false)}>← חזרה ללוח החי</button></div>
        <History hist={hist} />
        <StaffShield />
    </div>;
    return <div className="dk pub">
        {(() => {
            const core = publicCore(board.core);
            const last = hist[0];
            // default: the customers see the heat. Between heats that is the latest results, not the queue.
            if (L.publicViewOf(core) === 'heat' && !core.live && last) {
                const called = L.calledHeat(core);
                return <WallDisplay title={`תוצאות מקצה ${last.heatNum}`} sub={`${dayOf(last.at)} ${timeOf(last.at)}`} totalLaps={last.laps} state="done" rows={resultRowsOf(last)} onClose={() => {}}
                    footer={called ? <><b>נקראים למסלול:</b> מקצה {called.num} ({L.heatCount(called)} נהגים)</> : undefined} />;
            }
            return <TrackScreen core={core} now={now} onClose={() => {}} />;
        })()}
        <StaffShield />
        <button type="button" className="pub-hbtn" onClick={() => setShowHist(true)}>היסטוריית מקצים ({hist.length})</button>
        <div className={`pub-conn ${conn === 'SUBSCRIBED' ? 'ok' : ''}`}>{conn === 'SUBSCRIBED' ? '● שידור חי' : 'מתחבר…'}</div>
    </div>;
}

/** Small shield in the corner of the public site: staff sign in here and go to the staff area. */
function StaffShield() {
    const [open, setOpen] = useState(false);
    const go = () => { location.href = '?staff'; };
    const click = async () => { const { data } = await Cloud.supabase.auth.getSession(); if (data.session) go(); else setOpen(true); };
    return <>
        <button type="button" className="pub-shield" aria-label="כניסת צוות" title="כניסת צוות" onClick={() => void click()}>
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 2 4 5v6c0 5 3.4 9.7 8 11 4.6-1.3 8-6 8-11V5l-8-3Zm0 2.2 6 2.2V11c0 4-2.6 7.8-6 8.9-3.4-1.1-6-4.9-6-8.9V6.4l6-2.2Zm0 3.3a2.5 2.5 0 0 0-1 4.8V15h2v-2.7a2.5 2.5 0 0 0-1-4.8Z" /></svg>
        </button>
        {open && <div className="pub-modal" role="dialog" aria-modal="true" aria-label="כניסת צוות" onClick={e => { if (e.target === e.currentTarget) setOpen(false); }}>
            <div className="pub-modal-box">
                <div className="pub-modal-top"><h2 className="gate-title">כניסת צוות</h2><button type="button" className="kb ghost sm" aria-label="סגור" onClick={() => setOpen(false)}>✕</button></div>
                <StaffLoginForm onDone={go} />
            </div>
        </div>}
    </>;
}

// --------------------------------------------------------------- staff gate
/** User name + password form for staff. Accounts are created by the owner in Supabase. */
function StaffLoginForm({ onDone }: { onDone?: () => void }) {
    const [email, setEmail] = useState('');
    const [pw, setPw] = useState('');
    const [err, setErr] = useState('');
    const [busy, setBusy] = useState(false);
    const login = async (e: React.FormEvent) => { e.preventDefault(); setBusy(true); setErr(''); const m = await Cloud.signIn(email.trim(), pw); setBusy(false); if (m) setErr('הכניסה נכשלה. בדוק שם משתמש וסיסמה.'); else onDone?.(); };
    return <form className="gate" onSubmit={login}>
        <label className="field"><span className="flabel">שם משתמש</span><input className="inp" type="text" autoCapitalize="none" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} dir="ltr" required /></label>
        <label className="field"><span className="flabel">סיסמה</span><input className="inp" type="password" autoComplete="current-password" value={pw} onChange={e => setPw(e.target.value)} dir="ltr" required /></label>
        <button type="submit" className="kb primary" disabled={busy}>{busy ? 'מתחבר…' : 'כניסה'}</button>
        {err && <p className="err" role="alert">{err}</p>}
    </form>;
}

/** The staff area (?staff): the marshal console opens only after a staff sign-in. */
export function StaffGate({ children }: { children: React.ReactNode }) {
    const [session, setSession] = useState<Session | null | undefined>(undefined);
    useEffect(() => Cloud.onSession(setSession), []);
    if (session === undefined) return <div className="dk pub-wait"><Logo big /><p>טוען…</p></div>;
    if (session) return <>{children}</>;
    return <div className="dk pub-wait">
        <Logo big />
        <h1 className="gate-title">כניסת צוות</h1>
        <StaffLoginForm />
        <a className="pub-staff" href="./">למסך הצופים</a>
    </div>;
}
