import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Callout, Closing, CopyButton, FileCard, Group, Header, useLocalState } from '@instinct/files';
import * as L from './logic';
import * as Cloud from './cloud';
import type { Session } from '@supabase/supabase-js';

type Tab = 'form' | 'cashier' | 'heats' | 'live' | 'history' | 'settings';
const TABS: { id: Tab; label: string }[] = [
    { id: 'form', label: 'הרשמה' },
    { id: 'cashier', label: 'קופה' },
    { id: 'heats', label: 'מקצים' },
    { id: 'live', label: 'חי' },
    { id: 'history', label: 'היסטוריה' },
    { id: 'settings', label: 'הגדרות' },
];

/**
 * Demo autopilot pacing. ILLUSTRATIVE ONLY: the real call-up trigger at the venue is not decided.
 * Nothing here is an operational rule.
 */
const DEMO = { callAfterMs: 2500, startAfterMs: 6000, resultsHoldMs: 7000, speed: 20 };
const SPEEDS = [1, 5, 20];

/**
 * Dan Karting logo: a local copy in public/ (supplied by the owner), served with the app.
 * Not hot-linked: the demo makes no external calls. If the file is missing, a text wordmark is shown.
 */
const LOGO_SRC = 'dan-karting-logo.jpg';

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
    if (core.live?.heatId === h.id) return { text: 'על המסלול', cls: 'track' };
    if (L.overCapacity(h, core.settings.capacity) && h.status !== 'done') return { text: 'חורג מהקיבולת', cls: 'bad' };
    if (h.status === 'draft') return { text: 'טיוטה', cls: 'draft' };
    if (h.status === 'done') return { text: 'הסתיים', cls: 'done' };
    return h.called ? { text: 'נקרא למסלול', cls: 'called' } : { text: 'מאושר · בתור', cls: 'approved' };
}

// ------------------------------------------------------------ customer form
// What a customer fills on their own phone or a kiosk: one group name + participant names. Nothing else.
const ils = (n: number) => `₪${n.toLocaleString('he-IL')}`;

/** Price line: total, or which ticket types still have no price (owner sets prices in Settings). */
function PriceLine({ core, tickets }: { core: L.Core; tickets: string[] }) {
    const { total, missing } = L.priceOf(core, tickets);
    if (tickets.length === 0) return null;
    return <div className="price-line" aria-live="polite">
        <span>סה״כ לתשלום</span><b>{total > 0 ? ils(total) : '–'}</b>
        {missing.length > 0 && <small>אין עדיין מחיר ל: {missing.join(', ')} (מגדירים בהגדרות)</small>}
    </div>;
}

/** Ticket chips for one participant. Buttons only (no native select: it crashed the hosted app). */
function TicketChips({ core, value, onChange, label }: { core: L.Core; value: string; onChange: (t: string) => void; label: string }) {
    const p = core.settings.prices ?? {};
    return <div className="chips tchips" role="radiogroup" aria-label={label}>
        {core.settings.tickets.map(t => <button key={t} type="button" role="radio" aria-checked={value === t} className={`chip sm${value === t ? ' sel' : ''}${L.isFastTicket(core, t) ? ' fastc' : ''}`} onClick={() => onChange(t)}>{t}{L.isFastTicket(core, t) ? ' ⚡' : ''}{p[t] ? ` ${ils(p[t])}` : ''}{(core.settings.pairTickets ?? []).includes(t) ? ' לשניים' : ''}</button>)}
    </div>;
}

function CustomerForm({ core, update }: { core: L.Core; update: Update }) {
    const [group, setGroup] = useState('');
    const [names, setNames] = useState<string[]>(['', '']);
    const def = core.settings.tickets[0] ?? '';
    const [tix, setTix] = useState<string[]>([def, def]);
    const [error, setError] = useState('');
    const [sent, setSent] = useState<{ id: string; group: string; n: number; tickets: string[] } | null>(null);
    const setTixAt = (i: number, t: string) => setTix(tix.map((x, j) => (j === i ? t : x)));
    const chosen = names.map((n, i) => (n.trim() ? tix[i] ?? def : null)).filter((x): x is string => x != null);
    const setAt = (i: number, v: string) => { setError(''); setNames(names.map((x, j) => (j === i ? v : x))); };
    const filled = names.filter(x => x.trim()).length;
    const submit = () => {
        let res: { id?: string; error?: string } = {};
        update(c => { const r = L.submitForm(c, group, names, Date.now(), tix); res = r; return r.core; });
        if (res.error || !res.id) { setError(res.error ?? 'שגיאה'); return; }
        setSent({ id: res.id, group: group.trim(), n: filled, tickets: chosen }); setGroup(''); setNames(['', '']); setTix([def, def]); setError('');
    };
    const sample = () => {
        const k = Math.floor(Math.random() * 20);
        setGroup(`קבוצה לדוגמה ${k + 1}`);
        const n = 3 + (k % 4);
        setNames(Array.from({ length: n }, (_, i) => L.DEMO_NAMES[(k + i * 7) % L.DEMO_NAMES.length]));
        setTix(Array.from({ length: n }, () => def));
    };
    if (sent) return <Group label="נשלח לקופה" heading>
        <div className="sent">
            <div className="sent-num">#{sent.id.replace(/\D/g, '')}</div>
            <p><b>{sent.group}</b> · {sent.n} משתתפים</p>
            <PriceLine core={core} tickets={sent.tickets} />
            <p>ההרשמה מחכה בקופה. גשו לקופה לתשלום. אחרי אישור התשלום תיכנסו לתור ותוזמנו במסך המסלול.</p>
        </div>
        <Btn kind="primary" onClick={() => setSent(null)}>הרשמה חדשה</Btn>
    </Group>;
    return <Group label="הרשמה לקארטינג" heading>
        <Callout title="דמו" tone="warning">זה טופס לדוגמה. אל תזינו שמות אמיתיים. ליד כל שם בוחרים כרטיס. ליגה ומאסטר ⚡ הן מכוניות מהירות. אין תשלום בטופס: משלמים בקופה.</Callout>
        <div className="form">
            <label className="field"><span className="flabel">שם הקבוצה</span>
                <input className="inp" value={group} onChange={e => { setError(''); setGroup(e.target.value); }} placeholder="למשל: החבר׳ה מהעבודה" maxLength={40} />
            </label>
            <div className="field"><span className="flabel">שמות המשתתפים ({filled})</span>
                <ol className="plain dlist names">
                    {names.map((v, i) => <li key={i} className="drow trow">
                        <span className="meta nidx">{i + 1}</span>
                        <input className="inp dname" value={v} onChange={e => setAt(i, e.target.value)} placeholder="שם" aria-label={`משתתף ${i + 1}`} maxLength={24} />
                        <button type="button" className="kb ghost sm" aria-label={`הסר משתתף ${i + 1}`} disabled={names.length <= 1} onClick={() => { setNames(names.filter((_, j) => j !== i)); setTix(tix.filter((_, j) => j !== i)); }}>✕</button>
                        <TicketChips core={core} value={tix[i] ?? def} onChange={t => setTixAt(i, t)} label={`כרטיס למשתתף ${i + 1}`} />
                    </li>)}
                </ol>
                <div className="actions"><Btn small disabled={names.length >= L.MAX_FORM_NAMES} onClick={() => { setNames([...names, '']); setTix([...tix, def]); }}>+ משתתף</Btn><Btn small onClick={sample}>מלא דוגמה</Btn></div>
            </div>
            <PriceLine core={core} tickets={chosen} />
            {error && <div className="warn" role="alert">{error}</div>}
            <Btn kind="primary" onClick={submit}>שליחה לקופה</Btn>
        </div>
    </Group>;
}

/** Small label: ticket type, fast-kart class, family. */
function GroupTags({ core, g }: { core: L.Core; g: L.Group }) {
    return <span className="gtags">
        {(g.tickets && new Set(g.tickets).size > 1
            ? [...new Set(g.tickets)].map(t => <span key={t} className={`gtag${L.isFastTicket(core, t) ? ' fast' : ''}`}>{t} ×{g.tickets!.filter(x => x === t).length}</span>)
            : <span className={`gtag${L.classOf(core, g) === 'fast' ? ' fast' : ''}`}>{g.ticket || 'ללא סוג'}{L.classOf(core, g) === 'fast' ? ' · מהירות' : ''}</span>)}
        {g.family && <span className="gtag fam">משפחה</span>}
    </span>;
}

/** One pending registration: tickets per participant (from the form, editable), family, price, then "paid". */
function PendingItem({ core, update, sb }: { core: L.Core; update: Update; sb: L.Submission }) {
    const def = core.settings.tickets[0] ?? '';
    const [tix, setTix] = useState<string[]>(() => sb.names.map((_, i) => sb.tickets?.[i] ?? def));
    const [family, setFamily] = useState(false);
    const fast = tix.filter(t => L.isFastTicket(core, t)).length;
    const mixed = fast > 0 && fast < tix.length;
    return <li className="item pending">
        <div className="itop"><strong>{sb.groupName}</strong><span className="big">{sb.names.length}</span></div>
        <div className="meta">#{sb.id.replace(/\D/g, '')} · {timeOf(sb.createdAt)}</div>
        <ul className="plain dlist">
            {sb.names.map((n, i) => <li key={i} className="trow"><span className="tname">{n}</span>
                <TicketChips core={core} value={tix[i]} onChange={t => setTix(tix.map((x, j) => (j === i ? t : x)))} label={`כרטיס ל${n}`} /></li>)}
        </ul>
        <div className="chips"><button type="button" aria-pressed={family} className={`chip${family ? ' sel' : ''}`} onClick={() => setFamily(!family)}>משפחה (מותר לערבב מהירות ורגילות)</button></div>
        {mixed && <div className={family ? 'meta' : 'warn'}>{family ? 'משפחה: ייכנסו יחד לאותו מקצה.' : `יש כאן ${fast} עם מכוניות מהירות ו-${tix.length - fast} עם רגילות. אם זו לא משפחה, הם יתפצלו לשתי קבוצות ולמקצים נפרדים.`}</div>}
        <PriceLine core={core} tickets={tix} />
        <div className="actions">
            <Btn kind="primary" small onClick={() => update(c => L.markPaidAndPlan(c, sb.id, Date.now(), { tickets: tix, family }))}>שולם · הכנס לתור</Btn>
            <Btn kind="danger" small onClick={() => update(c => L.cancelSubmission(c, sb.id))}>בטל הרשמה</Btn>
        </div>
    </li>;
}

// ------------------------------------------------------------------ cashier
function Cashier({ core, update, goHeats }: { core: L.Core; update: Update; goHeats: () => void }) {
    const [name, setName] = useState('');
    const [size, setSize] = useState(2);
    const [ticket, setTicket] = useState(core.settings.tickets[0] ?? '');
    const [keep, setKeep] = useState(true);
    const [fam, setFam] = useState(false);
    const [note, setNote] = useState('');
    const split = useMemo(() => L.splitGroupIds(core.heats), [core.heats]);
    const add = () => {
        const nm = name.trim() || `קבוצה ${core.groups.length + 1}`;
        update(c => { const x = L.addGroup(c, { name: nm, size, ticket, keepTogether: keep, note: note.trim() }, Date.now()); const id = x.groups[x.groups.length - 1].id; return { ...x, groups: x.groups.map(g => (g.id === id ? { ...g, family: fam } : g)) }; });
        setName(''); setNote(''); setSize(2); setKeep(true);
    };
    const loadDemo = () => update(c => {
        let x = c;
        L.demoGroups.forEach(g => { x = L.addGroup(x, { ...g, ticket: c.settings.tickets[g.ticket] ?? c.settings.tickets[0] ?? '' }, Date.now()); });
        return x;
    });
    const waiting = core.groups.filter(g => L.unassignedOf(core, g) > 0);
    const over = new Set(L.oversizedGroups(core).map(g => g.id));
    const pending = L.pendingOf(core);
    const [manual, setManual] = useState(false);
    return <>
        <Group label={`ממתינים לתשלום (${pending.length})`} heading>
            <p className="meta">הרשמות שהלקוחות שלחו מהטופס. בוחרים סוג כרטיס ומסמנים "שולם": הקבוצה נכנסת לתור והמקצים מסתדרים לבד (טיוטה, הקופאית מאשרת). אישור התשלום כאן מדומה: אין חיוב ואין סליקה.</p>
            {pending.length === 0 && <p className="empty">אין הרשמות שממתינות. לקוחות נרשמים בלשונית "הרשמה".</p>}
            <ul className="list">
                {pending.map(sb => <PendingItem key={sb.id} core={core} update={update} sb={sb} />)}
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
                        {core.settings.tickets.map(t => <button key={t} type="button" role="radio" aria-checked={ticket === t} className={`chip${ticket === t ? ' sel' : ''}`} onClick={() => setTicket(t)}>{t}{L.isFastTicket(core, t) ? ' ⚡' : ''}</button>)}
                        <button type="button" aria-pressed={fam} className={`chip${fam ? ' sel' : ''}`} onClick={() => setFam(!fam)}>משפחה</button>
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
                <Btn kind="primary" onClick={add}>הוסף לרשימת ההמתנה</Btn>
            </div>
        </Group>}
        <Group label={`קבוצות ששילמו (${core.groups.length})`} heading>
            {core.groups.length === 0 && <div className="empty">
                <p>אין עדיין קבוצות בתור. סמן הרשמה כ"שולם" למעלה, או טען דוגמה כדי לנסות את האפליקציה.</p>
                <Btn onClick={loadDemo}>טען קבוצות דמו</Btn>
            </div>}
            <ul className="list">
                {core.groups.map(g => {
                    const left = L.unassignedOf(core, g);
                    const heats = core.heats.filter(h => h.entries.some(e => e.groupId === g.id)).map(h => h.num);
                    const locked = core.heats.some(h => h.status !== 'draft' && h.entries.some(e => e.groupId === g.id));
                    return <li key={g.id} className="item">
                        <div className="itop"><strong>{g.name}</strong><span className="big">{g.size}</span></div>
                        <div className="meta"><GroupTags core={core} g={g} /> {g.keepTogether ? 'לשמור יחד' : 'אפשר לפצל'} · {timeOf(g.createdAt)}</div>
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
    const waiting = core.groups.filter(g => L.unassignedOf(core, g) > 0);
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
        <Callout title="הקופאית מחליטה" tone="note">ההצעה האוטומטית היא רק קיצור. אפשר לבנות מקצה ידנית ("מקצה חדש" ואז להוסיף קבוצות), ואפשר לשנות הרכב גם אחרי אישור, גם למקצה שכבר נקרא למסלול, עד שהוא עולה למסלול. מקצה מאושר שהשינוי הופך ללא תקין חוזר לטיוטה. "שבץ מחדש" מחליף רק טיוטות. הכללים (קבוצה נשארת שלמה כשיש מקום, פיצול רק כשחייבים) הם הצעה לבדיקה מול הצוות. אין כאן בדיקות גיל או גובה.</Callout>
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
        {core.heats.length === 0 && <p className="empty">אין מקצים. הוסף קבוצות בלשונית קופה ואז הצע שיבוץ או בנה מקצה ידנית.</p>}
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
                    <div className="meta">{n} מתוך {cap}{L.heatClasses(core, h).has('fast') ? ' · ⚡ מכוניות מהירות' : ''}{core.live?.heatId === h.id ? ' · נעול בזמן שהוא על המסלול' : ''}</div>
                    {L.mixesClasses(core, h) && <div className="warn">מכוניות מהירות (ליגה/מאסטר) ורגילות באותו מקצה. מותר רק למשפחה. אי אפשר לאשר עד שמפרידים.</div>}
                    <ul className="entries">
                        {h.entries.map(e => {
                            const g = core.groups.find(x => x.id === e.groupId);
                            return <li key={e.groupId}>
                                <span>{g?.name ?? '?'} <b>{e.count}</b> {g && <GroupTags core={core} g={g} />}{split.has(e.groupId) ? ` מתוך ${g?.size}` : ''}{split.has(e.groupId) && <em className="warn"> פוצלה</em>}</span>
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
                    {canEdit && waiting.length > 0 && <div className="moves" role="group" aria-label="הוסף קבוצה למקצה">{waiting.map(g => { const left = L.unassignedOf(core, g); const free = cap - n; const blocked = free <= 0 || (g.keepTogether && left > free) || !L.fitsClass(core, h, g); return <button key={g.id} type="button" className="kb ghost sm add" disabled={blocked} onClick={() => act(c => L.addToHeat(c, g.id, h.id))}>{`+ ${g.name} (${left})`}</button>; })}</div>}
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
type BoardRow = {
    key: string; pos: number; kart: number; label: string; laps: number; best: number | null; last: number | null;
    gap: string; finished: boolean; isBest: boolean; sectors: Sec[] | null; gained: number | null;
};

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

function WallDisplay(p: { title: string; sub: string; totalLaps: number; clock?: string; countdown?: string; state: 'live' | 'done' | 'wait'; rows: BoardRow[]; footer?: React.ReactNode; onClose: () => void }) {
    useEscape(p.onClose);
    const dense = p.rows.length > 10;
    return <div className="wall tboard" role="dialog" aria-label="לוח זמנים">
        <header className="tb-head">
            <Logo big />
            <Lights state={p.state} />
            <div className="tb-title"><div className="tb-heat">{p.title}</div><div className="tb-sub">{p.sub}</div></div>
            <div className="tb-clocks">
                {p.countdown != null && <div className="tb-count" aria-label="זמן שנותר"><small>נותר</small><bdi>{p.countdown}</bdi></div>}
                {p.clock && <div className="tb-elapsed"><small>זמן</small><bdi>{p.clock}</bdi></div>}
            </div>
            <button type="button" className="wall-close" onClick={p.onClose} aria-label="סגור תצוגת מסך">✕</button>
        </header>
        <div className="wall-sim">סימולציה · נתוני דמה · לא שעון אמיתי</div>
        <ol className={`tb-rows${dense ? ' dense' : ''}`}>
            <li className="tb-row tb-cols" aria-hidden="true"><span>מק׳</span><span>קארט</span><span>נהג</span><span>S1</span><span>S2</span><span>S3</span><span>אחרונה</span><span>הקפה מהירה</span><span>פער</span><span>הקפות</span></li>
            {p.rows.map(r => <li key={r.key} className={`tb-row${r.pos === 1 ? ' lead' : ''}`}>
                <span className="tb-pos">{r.pos}{r.gained ? <em className={r.gained > 0 ? 'up' : 'down'}>{r.gained > 0 ? `▲${r.gained}` : `▼${-r.gained}`}</em> : null}</span>
                <span className="tb-kart">{r.kart}</span>
                <span className="tb-name">{r.label}</span>
                {[0, 1, 2].map(i => <span key={i} className={`tb-sec ${r.sectors?.[i]?.cls ?? ''}`}><bdi>{r.sectors ? (r.sectors[i].ms / 1000).toFixed(3) : '–'}</bdi></span>)}
                <span className="tb-last"><bdi>{L.fmt(r.last)}</bdi></span>
                <span className={`tb-best${r.isBest ? ' ob' : ''}`}><bdi>{L.fmt(r.best)}</bdi></span>
                <span className="tb-gap"><bdi>{r.gap}</bdi></span>
                <span className="tb-laps">{p.totalLaps ? `${r.laps}/${p.totalLaps}` : r.laps}{r.finished ? ' ✓' : ''}</span>
            </li>)}
        </ol>
        <div className="tb-legend"><span className="ob">סגול</span> הכי מהיר במקצה · <span className="pb">ירוק</span> שיא אישי · ▲▼ מקומות לעומת הזינוק</div>
        {p.footer && <div className="call-next">{p.footer}</div>}
    </div>;
}

/** Lineup board: the heat being called (or next), as driver photo cards with names and kart numbers. */
function CallDisplay(p: { core: L.Core; state: 'call' | 'next' | 'empty'; heat?: L.Heat; onClose: () => void }) {
    useEscape(p.onClose);
    const ds = p.heat ? L.driversOf(p.core, p.heat) : [];
    const staff = L.kartMode(p.core) === 'staff';
    const rest = L.queueOf(p.core).filter(h => h.id !== p.heat?.id).slice(0, 3);
    const waiting = p.core.groups.filter(g => L.unassignedOf(p.core, g) > 0).length;
    return <div className={`wall callwall ${p.state}`} role="dialog" aria-label="מסך קריאה למסלול">
        <header className="lu-head">
            <Logo big />
            <div className="lu-banner"><span>{p.state === 'call' ? 'נקראים למסלול' : p.state === 'next' ? 'הבא בתור' : 'אין מקצים בתור'}</span>{p.heat && <b>מקצה {p.heat.num}</b>}</div>
            <button type="button" className="wall-close" onClick={p.onClose} aria-label="סגור תצוגת מסך">✕</button>
        </header>
        <div className="lu-sub">{p.heat ? `${ds.length} נהגים${p.state === 'call' ? ' · לגשת לאזור ההמתנה, לפי מספר הקארט' : ' · עוד לא נקרא, להתכונן'}` : waiting ? `${waiting} קבוצות ממתינות לשיבוץ בקופה` : 'ממתינים לקבוצות'}</div>
        <div className="wall-sim">סימולציה · שמות ותמונות זמניים לדוגמה · לא חיבור למסלול</div>
        {p.heat && <ul className={`lu-grid${ds.length > 10 ? ' many' : ''}`}>
            {ds.map(d => {
                const hide = staff && !d.kartSet;
                return <li key={d.key} className="lu-card">
                    <div className="lu-photo"><Avatar kart={d.kart} label={d.label} /><span className={`lu-kart${hide ? ' tbd' : ''}`}>{hide ? '?' : d.kart}</span></div>
                    <div className="lu-name">{d.label}</div>
                    {hide ? <div className="lu-note">הצוות יקצה קארט</div> : !d.kartSet && <div className="lu-note">קארט מוצע</div>}
                </li>;
            })}
        </ul>}
        {p.state === 'empty' && <div className="call-hint">כשהקופה תאשר מקצה, הוא יופיע כאן.</div>}
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
        const gap = i === 0 || !leader || t.laps.length === 0 && leader.laps.length === 0 ? '' : t.laps.length < leader.laps.length ? `-${leader.laps.length - t.laps.length} הקפות` : `+${L.fmt(t.total - leader.total)}`;
        const mine = secs.get(t.key) ?? [];
        const lastS = mine[mine.length - 1];
        const sectors: Sec[] | null = lastS ? lastS.map((ms, k) => ({ ms, cls: ms === overall[k] ? 'ob' : ms === Math.min(...mine.map(x => x[k])) ? 'pb' : '' })) : null;
        const grid = drivers.findIndex(x => x.key === t.key) + 1;
        return { key: t.key, pos: i + 1, kart: d.kart, label: d.label, laps: t.laps.length, best: t.best, last: t.last, gap, finished: t.finished, isBest: t.best != null && t.best === bestAll, sectors, gained: t.laps.length ? grid - (i + 1) : null };
    });
}

function resultRowsOf(r: L.Result): BoardRow[] {
    const bAll = Math.min(...r.rows.map(x => x.best ?? Infinity));
    return r.rows.map((x, i) => ({ key: `${x.pos}`, pos: x.pos, kart: x.kart, label: x.label, laps: x.laps.length, best: x.best, last: x.laps.length ? x.laps[x.laps.length - 1] : null, gap: i === 0 ? '' : x.laps.length < r.rows[0].laps.length ? `-${r.rows[0].laps.length - x.laps.length} הקפות` : `+${L.fmt(x.total - r.rows[0].total)}`, finished: x.laps.length >= r.laps, isBest: x.best != null && x.best === bAll, sectors: null, gained: null }));
}

const mmss = (ms: number) => { const s = Math.ceil(ms / 1000); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

/** The venue screen: switches by itself between lineup (call / next / empty) and live timing. */
export function TrackScreen({ core, now, onClose }: { core: L.Core; now: number; onClose: () => void }) {
    const sc = L.screenState(core);
    if (sc.state === 'race' && sc.heat) {
        const timing = L.liveTiming(core, now);
        const done = L.allFinished(timing);
        const called = L.calledHeat(core);
        const el = L.elapsedOf(core.live, now);
        const left = L.timeLeft(core.live, now);
        const timed = left != null;
        const sub = done ? 'הסתיים · תוצאות' : timed && left === 0 ? 'הזמן נגמר · הקפה אחרונה' : 'על המסלול · בלייב';
        return <WallDisplay title={`מקצה ${sc.heat.num}`} sub={timed ? `${sub} · ${Math.round(core.live!.durationMs! / 60_000)} דק׳` : sub} totalLaps={timed ? 0 : core.settings.laps} state={done ? 'done' : 'live'}
            clock={L.fmt(Math.min(L.raceClock(timing, el), 3_600_000))} countdown={mmss(timed ? left : L.estRemaining(timing, el, core.settings.laps))} rows={liveRowsOf(core, timing)} onClose={onClose}
            footer={called ? <><b>נקראים למסלול:</b> מקצה {called.num} ({L.heatCount(called)} נהגים)</> : undefined} />;
    }
    return <CallDisplay core={core} state={sc.state === 'race' ? 'empty' : sc.state} heat={sc.heat} onClose={onClose} />;
}

/** Heat length picker: 10 minutes is the minimum, 20 the other common option, or any value up to 30. */
function HeatMinutes({ core, update }: { core: L.Core; update: Update }) {
    const m = L.heatMinutesOf(core);
    const set = (n: number) => update(c => ({ ...c, settings: { ...c.settings, heatMinutes: n } }));
    return <div className="field"><span className="flabel">זמן מקצה (דקות)</span>
        <div className="chips" role="radiogroup" aria-label="זמן מקצה">
            {L.HEAT_MINUTE_OPTIONS.map(n => <button key={n} type="button" role="radio" aria-checked={m === n} className={`chip${m === n ? ' sel' : ''}`} onClick={() => set(n)}>{n} דק׳</button>)}
        </div>
        <Stepper label="או ערך אחר" value={m} min={L.MIN_HEAT_MINUTES} max={L.MAX_HEAT_MINUTES} onChange={set} />
        <p className="meta">המינימום 10 דקות. הזמן נקבע ברגע הלחיצה על "התחל מקצה". כשהזמן נגמר, כל נהג מסיים את ההקפה שהוא נמצא בה ואז מוצגות התוצאות.</p>
    </div>;
}

// --------------------------------------------------------------------- live
type LiveProps = {
    core: L.Core; update: Update; now: number; hist: L.Result[];
    auto: boolean; setAuto: (b: boolean) => void; openScreen: (s: 'track' | 'last') => void;
    save: () => void; start: (id: string) => void; cancel: () => void; goHeats: () => void;
};

function Live({ core, update, now, hist, auto, setAuto, openScreen, save, start, cancel, goHeats }: LiveProps) {
    const [editId, setEditId] = useState<string | null>(null);
    const heat = L.runningHeat(core);
    const timing = L.liveTiming(core, now);
    const rows = liveRowsOf(core, timing);
    const done = !!heat && L.allFinished(timing);
    const elapsed = L.elapsedOf(core.live, now);
    const qList = L.queueOf(core);
    const calledH = L.calledHeat(core);
    const lastRes = hist[0];
    const nextUp = calledH ?? qList[0];
    const autoNext = !auto ? '' : heat ? (done ? 'הדמו: מציג תוצאות, קורא למקצה הבא ושומר לבד.' : 'הדמו: המקצה על המסלול. כשהזמן ייגמר והנהגים יסיימו את ההקפה, התוצאות יוצגו וישמרו לבד.')
        : calledH ? (L.startBlockers(core, calledH).length ? `הדמו ממתין: מקצה ${calledH.num} לא יכול לעלות (${L.startBlockers(core, calledH).join(', ')}).` : `הדמו: מקצה ${calledH.num} נקרא. לחץ "התחל מקצה" כשהנהגים מוכנים.`)
            : qList[0] ? `הדמו: יקרא למקצה ${qList[0].num} עוד רגע.` : 'הדמו ממתין: אין מקצה מאושר בתור. אשר מקצה בלשונית מקצים.';

    return <Group label="מסלול ותור" heading>
        <Callout title="סימולציה, לא שעון אמיתי" tone="warning">הזמנים מומצאים על ידי האפליקציה כדי להדגים את המסך. אין חיבור לשעון ההקפות או למסכים של המסלול. התזמונים של הדמו האוטומטי להמחשה בלבד.</Callout>

        <div className="row-actions">
            <Btn kind={auto ? 'on' : 'ghost'} onClick={() => { const on = !auto; setAuto(on); if (on) openScreen('track'); }}>{auto ? '■ עצור דמו אוטומטי' : '▶ הפעל דמו אוטומטי'}</Btn>
            <Btn onClick={() => openScreen('track')}>מסך מסלול</Btn>
            {!heat && <Btn onClick={() => { update(c => L.demoSetup(c, Date.now())); setAuto(true); openScreen('track'); }}>⚡ הדגמה מלאה בלחיצה</Btn>}
            <Btn small onClick={() => update(L.fillDemoNames)}>מלא שמות דמו</Btn>
        </div>
        <p className="meta">{auto ? autoNext : 'תור פשוט, בלי שעות: המקצים המאושרים לפי הסדר. "מסך מסלול" הוא המסך הגדול באתר: הוא עובר לבד בין קריאה, הבא בתור ומירוץ. בדמו האוטומטי המסך קורא, מציג תוצאות וממשיך לבד, אבל מקצה מתחיל רק בלחיצה על "התחל מקצה". הקופאית יכולה לשנות הרכב בכל שלב בלשונית מקצים.'}</p>

        {heat && <section className="panel ontrack" aria-label="על המסלול">
            <div className="row-actions">
                <strong className="hnum">על המסלול · מקצה {heat.num}</strong>
                {L.timeLeft(core.live, now) != null
                    ? <span className="clock" aria-label="זמן שנותר">נותר {mmss(L.timeLeft(core.live, now)!)}</span>
                    : <span className="clock" aria-label="זמן שעבר">{L.fmt(Math.min(L.raceClock(timing, elapsed), 3_600_000))}</span>}
            </div>
            <div className="chips" role="radiogroup" aria-label="מהירות סימולציה">
                {SPEEDS.map(s => <button key={s} type="button" role="radio" aria-checked={core.live?.speed === s} className={`chip${core.live?.speed === s ? ' sel' : ''}`} onClick={() => update(c => L.setSpeed(c, s, Date.now()))}>x{s}</button>)}
            </div>
            <ol className="board">
                {rows.map(r => <li key={r.key} className="brow">
                    <span className="pos">{r.pos}</span>
                    <span className="kart">{r.kart}</span>
                    <span className="who">{r.label}<small>{core.live?.durationMs ? `${r.laps} הקפות` : `${r.laps}/${core.settings.laps} הקפות`}{r.finished ? ' · סיים' : ''}</small></span>
                    <span className="times"><b className={r.isBest ? 'best' : ''}><bdi>{L.fmt(r.best)}</bdi></b><small>אחרונה <bdi>{L.fmt(r.last)}</bdi></small>{r.gap && <small><bdi>{r.gap}</bdi></small>}</span>
                </li>)}
            </ol>
            <div className="row-actions">
                <Btn kind="primary" onClick={save} disabled={!done && rows.every(r => r.laps === 0)}>{done ? 'שמור תוצאות והמשך' : 'סיים עכשיו ושמור'}</Btn>
                <Btn onClick={() => openScreen('track')}>תצוגת מסך</Btn>
                <Btn kind="danger" onClick={cancel}>בטל בלי לשמור</Btn>
            </div>
        </section>}

        <h3 className="subhead">התור ({qList.length})</h3>
        {!heat && <HeatMinutes core={core} update={update} />}
        {!heat && !calledH && nextUp && <div className="row-actions"><Btn kind="primary" onClick={() => update(c => L.callHeat(c, nextUp.id))}>{`קרא למסלול: מקצה ${nextUp.num}`}</Btn></div>}
        {qList.length === 0 ? <div className="empty"><p>אין מקצה מאושר בתור.</p><Btn onClick={goHeats}>למקצים</Btn></div> : <ol className="list queue">
            {qList.map((h, i) => {
                const blockers = L.startBlockers(core, h);
                return <li key={h.id} className={`item${h.called ? ' called' : ''}`}>
                    <div className="itop"><strong>{i + 1}. מקצה {h.num}</strong><span className={`badge ${h.called ? 'called' : 'approved'}`}>{h.called ? 'נקרא למסלול' : i === 0 ? 'הבא' : 'בתור'}</span></div>
                    <div className="meta">{L.heatCount(h)} נהגים · {L.driversOf(core, h).map(d => `${d.label} (${d.kart})`).join(', ')}</div>
                    <div className="actions">
                        {h.called ? <Btn small onClick={() => update(c => L.uncallHeat(c, h.id))}>בטל קריאה</Btn> : <Btn small disabled={!!calledH} onClick={() => update(c => L.callHeat(c, h.id))}>קרא למסלול</Btn>}
                        <Btn kind="primary" small disabled={blockers.length > 0} onClick={() => start(h.id)}>{h.called ? `▶ התחל מקצה (${L.heatMinutesOf(core)} דק׳)` : 'התחל בלי קריאה'}</Btn>
                        <Btn small onClick={() => setEditId(editId === h.id ? null : h.id)}>{editId === h.id ? 'סגור' : 'שמות וקארטים'}</Btn>
                        <Btn small onClick={goHeats}>שנה הרכב</Btn>
                    </div>
                    {blockers.length > 0 && !(blockers.length === 1 && blockers[0] === 'מקצה אחר על המסלול') && <div className="warn">לא יכול לעלות: {blockers.filter(b => b !== 'מקצה אחר על המסלול').join(', ')}.</div>}
                    {editId === h.id && <DriverEditor core={core} heat={h} update={update} />}
                </li>;
            })}
        </ol>}

        {lastRes && !heat && <div className="row-actions"><span className="meta">תוצאה אחרונה: מקצה {lastRes.heatNum} · {timeOf(lastRes.at)}</span><Btn small onClick={() => openScreen('last')}>הצג על מסך</Btn></div>}
    </Group>;
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
        {hist.length === 0 && <p className="empty">עוד אין מקצים שהסתיימו. הרץ מקצה בלשונית חי (או את הדמו האוטומטי).</p>}
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
                    {isOpen && <ol className="board">
                        {r.rows.map(x => <li key={x.pos} className={`brow${q2 && x.label.includes(q2) ? ' hit' : ''}`}>
                            <span className="pos">{x.pos}</span><span className="kart">{x.kart}</span>
                            <span className="who">{x.label}<small>{x.laps.length}/{r.laps} הקפות</small></span>
                            <span className="times"><b><bdi>{L.fmt(x.best)}</bdi></b><small>סה״כ <bdi>{L.fmt(x.total)}</bdi></small></span>
                        </li>)}
                    </ol>}
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

function Settings({ core, update, hist, onReset, site }: { core: L.Core; update: Update; hist: L.Result[]; onReset: () => void; site: React.ReactNode }) {
    const s = core.settings;
    const [t, setT] = useState('');
    const [confirm, setConfirm] = useState(false);
    const upd = (p: Partial<L.Settings>) => update(c => ({ ...c, settings: { ...c.settings, ...p } }));
    const overDraft = core.heats.filter(h => h.status === 'draft' && L.heatCount(h) > s.capacity).length;
    const overQueued = core.heats.filter(h => h.status === 'approved' && L.heatCount(h) > s.capacity).length;
    return <>
        {site}
        <Group label="הגדרות" heading>
            <div className="field"><span className="flabel">קיבולת מקצה (קארטים)</span>
                <div className="chips" role="radiogroup" aria-label="קיבולת">
                    {L.CAPACITY_OPTIONS.map(n => <button key={n} type="button" role="radio" aria-checked={s.capacity === n} className={`chip${s.capacity === n ? ' sel' : ''}`} onClick={() => upd({ capacity: n })}>{n}</button>)}
                </div>
            </div>
            <Stepper label="או ערך אחר" value={s.capacity} min={L.MIN_CAP} max={L.MAX_CAP} onChange={n => upd({ capacity: n })} />
            <p className="meta">פתוח: הוזכרו 10 וגם 14, הערך הנכון לא אושר. ברירת המחדל 10. אחרי שינוי לחץ "שבץ מחדש" בלשונית מקצים.{overDraft > 0 ? ` ${overDraft} טיוטות חורגות עכשיו.` : ''}{overQueued > 0 ? ` ${overQueued} מקצים בתור חורגים ולא יעלו למסלול עד שיתוקנו.` : ''}</p>
            <HeatMinutes core={core} update={update} />
            <div className="field"><span className="flabel">מי קובע קארט לנהג</span>
                <div className="chips" role="radiogroup" aria-label="שיוך קארט">
                    {([['unset', 'עוד לא הוחלט (הצעה, אפשר לערוך)'], ['cashier', 'הקופאית בוחרת עם השמות'], ['staff', 'הצוות מקצה בעלייה']] as [L.KartMode, string][]).map(([k, label]) => <button key={k} type="button" role="radio" aria-checked={L.kartMode(core) === k} className={`chip${L.kartMode(core) === k ? ' sel' : ''}`} onClick={() => upd({ kartMode: k })}>{label}</button>)}
                </div>
                <p className="meta">פתוח: עוד לא הוחלט. "הקופאית בוחרת" דורש קארט לכל נהג לפני אישור. "הצוות מקצה" מציג במסך "הצוות יקצה" עד שנבחר קארט. אין זיהוי אוטומטי של קארטים שחונים במסלול.</p>
            </div>
            <div className="field"><span className="flabel">סוגי כרטיס</span>
                <div className="chips">{s.tickets.map(x => <button key={x} type="button" className="chip" onClick={() => s.tickets.length > 1 && upd({ tickets: s.tickets.filter(y => y !== x), fastTickets: (s.fastTickets ?? []).filter(y => y !== x) })} aria-label={`הסר ${x}`}>{x} ✕</button>)}</div>
                <span className="flabel">מחיר לכרטיס (₪, למקצה של 10 דקות)</span>
                <p className="meta">לפי המחירון במקום: רגיל 87, זוגי 100 (רכב דו-מושבי בליווי מבוגר, מחיר אחד לשניים), מאסטר 100. לליגה עוד אין מחיר.</p>
                <ul className="plain dlist">{s.tickets.map(x => <li key={x} className="trow"><span className="tname">{x}</span>
                    <input key={`p-${x}-${s.prices?.[x] ?? ''}`} className="inp price-inp" type="number" inputMode="numeric" min={0} step={1} dir="ltr" placeholder="לא הוגדר" defaultValue={s.prices?.[x] ?? ''} aria-label={`מחיר ${x}`}
                        onBlur={e => { const v = Math.max(0, Math.round(Number(e.target.value) || 0)); const next = { ...(s.prices ?? {}) }; if (v > 0) next[x] = v; else delete next[x]; upd({ prices: next }); }} /></li>)}</ul>
                <span className="flabel">מכוניות מהירות (לא משובצים עם רגילות, חוץ ממשפחה)</span>
                <div className="chips">{s.tickets.map(x => { const on = L.isFastTicket(core, x); return <button key={x} type="button" aria-pressed={on} className={`chip${on ? ' sel' : ''}`} onClick={() => upd({ fastTickets: on ? (s.fastTickets ?? L.DEFAULT_FAST_TICKETS).filter(y => y !== x) : [...(s.fastTickets ?? L.DEFAULT_FAST_TICKETS), x] })}>⚡ {x}</button>; })}</div>
                <div className="inline"><input className="inp" value={t} onChange={e => setT(e.target.value)} placeholder="סוג חדש" maxLength={24} /><Btn onClick={() => { const v = t.trim(); if (v && !s.tickets.includes(v)) { upd({ tickets: [...s.tickets, v] }); setT(''); } }}>הוסף</Btn></div>
                <p className="meta">המחירים מוצגים בטופס ובקופה כחישוב בלבד. האפליקציה לא גובה תשלום.</p>
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
    const [tab, setTab] = useState<Tab>('cashier');
    const [screen, setScreen] = useState<'track' | 'last' | null>(null);
    const [auto, setAutoRaw] = useState(false);
    const [now, setNow] = useState(() => Date.now());
    const ready = savedCore.ready && savedHist.ready;
    // Saved data from before the four ticket types gets the real ticket list once.
    useEffect(() => { if (ready) { const m = L.migrateTickets(core); if (m !== core) setCoreRaw(m); } }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps

    // Public website: staff session + "broadcast" switch (per device). Publishes the board on every change.
    const [session, setSession] = useState<Session | null>(null);
    useEffect(() => Cloud.onSession(setSession), []);
    const [broadcast, setBroadcast] = useLocalState<boolean>('dankart.broadcast.v1', true);
    const [pubStatus, setPubStatus] = useState('');
    const sending = ready && !!session && broadcast;
    useEffect(() => {
        if (!sending) { setPubStatus(''); return; }
        const t = setTimeout(() => {
            void Cloud.publishBoard(Cloud.boardOf(core, Date.now())).then(e => setPubStatus(e ? `השידור נכשל: ${e}` : `✓ עודכן באתר ב-${new Date().toLocaleTimeString('he-IL')}`));
        }, 300);
        return () => clearTimeout(t);
    }, [sending, core]);

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

    const autoRef = useRef(auto); autoRef.current = auto;
    const start = (id: string) => update(c => L.startHeat(c, id, Date.now(), Date.now() % 100000, autoRef.current ? DEMO.speed : 5));
    const save = () => {
        const { core: next, result } = L.finishRun(coreRef.current, Date.now());
        if (result) setHist(L.trimHistory([result, ...histRef.current]));
        update(() => next);
    };
    const setAuto = (b: boolean) => { autoRef.current = b; phase.current = { key: '', since: 0 }; setAutoRaw(b); };
    const cancel = () => { setAuto(false); update(L.cancelRun); };

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
            // A heat never starts by itself: staff press "התחל מקצה" after the drivers are seated.
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
    const pending = core.groups.filter(g => L.unassignedOf(core, g) > 0).length;
    const counts: Partial<Record<Tab, number>> = { cashier: pending + L.pendingOf(core).length, heats: core.heats.filter(h => h.status === 'draft' && h.entries.length > 0).length, live: L.queueOf(core).length };
    const lastRes = hist[0];
    const goHeats = () => setTab('heats');

    return <FileCard lang="he">
        <div className="dk">
            <div className="brandbar"><Logo /><span className="brand-tag">דמו · נתוני דמה</span>{sending && <span className="brand-tag onair-tag">● משדר לאתר</span>}{core.live && <button type="button" className="onair" onClick={() => setTab('live')}>● מקצה {L.runningHeat(core)?.num} על המסלול</button>}</div>
            <Header title="מקצים ותור" fact="גרסת דמו · נתוני דמה" intro="קופה, שיבוץ מקצים, תור פשוט, קריאה למסלול וזמנים מדומים. אפשר לשדר את לוח הזמנים לאתר ציבורי (הגדרות). אין חיבור לשעון של העסק." />
            <nav className="tabs" aria-label="מסכים">
                {TABS.map(t => <button key={t.id} type="button" className={tab === t.id ? 'on' : ''} aria-current={tab === t.id ? 'page' : undefined} onClick={() => setTab(t.id)}>{t.label}{t.id === 'live' && core.live ? <i className="live-dot" aria-label="מקצה על המסלול">●</i> : counts[t.id] ? <i>{counts[t.id]}</i> : null}</button>)}
            </nav>
            {!ready && <p className="empty">טוען נתונים שמורים…</p>}
            {ready && tab === 'form' && <CustomerForm core={core} update={update} />}
            {ready && tab === 'cashier' && <Cashier core={core} update={update} goHeats={goHeats} />}
            {ready && tab === 'heats' && <Heats core={core} update={update} />}
            {ready && tab === 'live' && <Live core={core} update={update} now={now} hist={hist} auto={auto} setAuto={setAuto} openScreen={setScreen} save={save} start={start} cancel={cancel} goHeats={goHeats} />}
            {ready && tab === 'history' && <History hist={hist} />}
            {ready && tab === 'settings' && <Settings site={<PublicSite session={session} on={broadcast} setOn={setBroadcast} status={pubStatus} />} core={core} update={update} hist={hist} onReset={() => { setAuto(false); setScreen(null); update(() => L.initialCore()); setHist([]); }} />}
            <Closing>{persistNote} לא נשלח ולא שולם דבר.</Closing>
            {ready && screen === 'track' && <TrackScreen core={core} now={now} onClose={() => setScreen(null)} />}
            {ready && screen === 'last' && lastRes && <WallDisplay title={`תוצאות מקצה ${lastRes.heatNum}`} sub={`${dayOf(lastRes.at)} ${timeOf(lastRes.at)}`} totalLaps={lastRes.laps} state="done" rows={resultRowsOf(lastRes)} onClose={() => setScreen(null)} />}
        </div>
    </FileCard>;
}

// ------------------------------------------------------------- public board
/** The public website: read-only venue screen that follows the cashier device in real time. No login. */
export function PublicBoard() {
    const [board, setBoard] = useState<Cloud.BoardPayload | null>(null);
    const [conn, setConn] = useState('connecting');
    const [loaded, setLoaded] = useState(false);
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const take = (p: Cloud.BoardPayload) => setBoard(p);
        void Cloud.fetchBoard().then(p => { if (p) take(p); setLoaded(true); });
        return Cloud.subscribeBoard(take, setConn);
    }, []);
    useEffect(() => { const i = setInterval(() => setNow(Date.now()), 200); return () => clearInterval(i); }, []);
    // The board carries the race start time, so each viewer runs the race clock locally (phone clocks are network-synced).
    const clock = now;
    if (!loaded) return <div className="dk pub-wait"><Logo big /><p>טוען…</p></div>;
    if (!board) return <div className="dk pub-wait"><Logo big /><p>הלוח עוד לא פעיל. כשהקופה תתחיל לשדר, המקצים והזמנים יופיעו כאן.</p><a className="pub-staff" href="?staff">כניסת צוות (קופה)</a></div>;
    return <div className="dk pub">
        <TrackScreen core={board.core} now={clock} onClose={() => {}} />
        <div className={`pub-conn ${conn === 'SUBSCRIBED' ? 'ok' : ''}`}>{conn === 'SUBSCRIBED' ? '● שידור חי' : 'מתחבר…'}</div>
    </div>;
}

// --------------------------------------------------------------- staff gate
/** The staff area (?staff) opens only after a staff sign-in. Accounts are created by the owner in Supabase. */
export function StaffGate({ children }: { children: React.ReactNode }) {
    const [session, setSession] = useState<Session | null | undefined>(undefined);
    useEffect(() => Cloud.onSession(setSession), []);
    const [email, setEmail] = useState('');
    const [pw, setPw] = useState('');
    const [err, setErr] = useState('');
    const [busy, setBusy] = useState(false);
    if (session === undefined) return <div className="dk pub-wait"><Logo big /><p>טוען…</p></div>;
    if (session) return <>{children}</>;
    const login = async (e: React.FormEvent) => { e.preventDefault(); setBusy(true); setErr(''); const m = await Cloud.signIn(email.trim(), pw); setBusy(false); if (m) setErr('הכניסה נכשלה. בדוק שם משתמש וסיסמה.'); };
    return <div className="dk pub-wait">
        <Logo big />
        <h1 className="gate-title">כניסת צוות</h1>
        <form className="gate" onSubmit={login}>
            <label className="field"><span className="flabel">שם משתמש</span><input className="inp" type="text" autoCapitalize="none" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} dir="ltr" required /></label>
            <label className="field"><span className="flabel">סיסמה</span><input className="inp" type="password" autoComplete="current-password" value={pw} onChange={e => setPw(e.target.value)} dir="ltr" required /></label>
            <button type="submit" className="kb primary" disabled={busy}>{busy ? 'מתחבר…' : 'כניסה'}</button>
            {err && <p className="err" role="alert">{err}</p>}
        </form>
        <a className="pub-staff" href="./">למסך הצופים</a>
    </div>;
}
