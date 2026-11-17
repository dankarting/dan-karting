import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Callout, Closing, CopyButton, FileCard, Group, Header, useLocalState } from '@instinct/files';
import * as L from './logic';
import * as Cloud from './cloud';
import * as R from './rentix';
import { useShared, type SyncStatus } from './shared';

/** Data saved by the older per-device version, used once as the starting point. */
function legacy<T>(k: string): T | null { try { const r = localStorage.getItem(k); return r ? JSON.parse(r) as T : null; } catch { return null; } }
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
function PriceLine({ core, tickets, minutes = 10 }: { core: L.Core; tickets: string[]; minutes?: number }) {
    const { total, missing } = L.priceOf(core, tickets, minutes);
    if (tickets.length === 0) return null;
    return <div className="price-line" aria-live="polite">
        <span>סה״כ לתשלום</span><b>{total > 0 ? ils(total) : '–'}</b>
        {missing.length > 0 && <small>אין עדיין מחיר{minutes >= 20 ? ' ל-20 דקות' : ''} ל: {missing.join(', ')} (מגדירים בהגדרות)</small>}
    </div>;
}

/** Ticket chips for one participant. Buttons only (no native select: it crashed the hosted app). */
function TicketChips({ core, value, onChange, label, minutes = 10 }: { core: L.Core; value: string; onChange: (t: string) => void; label: string; minutes?: number }) {
    const p = (minutes >= 20 ? core.settings.prices20 : core.settings.prices) ?? {};
    return <div className="chips tchips" role="radiogroup" aria-label={label}>
        {core.settings.tickets.map(t => <button key={t} type="button" role="radio" aria-checked={value === t} className={`chip sm${value === t ? ' sel' : ''}${L.isFastTicket(core, t) ? ' fastc' : ''}`} onClick={() => onChange(t)}>{t}{L.isFastTicket(core, t) ? ' ⚡' : ''}{p[t] ? ` ${ils(p[t])}` : ''}{isPair(core, t) ? ' לשניים' : ''}</button>)}
    </div>;
}

const isPair = (core: L.Core, t: string) => (core.settings.pairTickets ?? []).includes(t);

/** 10 or 20 minutes for one registration (20 has its own price list). */
function MinuteChips({ value, onChange }: { value: number; onChange: (m: number) => void }) {
    return <div className="chips" role="radiogroup" aria-label="אורך המקצה">
        {L.HEAT_MINUTE_OPTIONS.map(m => <button key={m} type="button" role="radio" aria-checked={value === m} className={`chip${value === m ? ' sel' : ''}`} onClick={() => onChange(m)}>{m} דקות</button>)}
    </div>;
}

/** Form row: a participant, or the second seat of the two-seat kart above it (זוגי). */
type FormRow = { name: string; ticket: string; partner?: boolean };

/** Participant rows: name + ticket chips per name; picking a pair ticket (זוגי) adds the second seat's name row. */
function NameRows({ core, rows, setRows, minutes, onEdit }: { core: L.Core; rows: FormRow[]; setRows: (r: FormRow[]) => void; minutes: number; onEdit?: () => void }) {
    const def = core.settings.tickets[0] ?? '';
    const setTicketAt = (i: number, t: string) => {
        const r = rows.slice();
        const hadPartner = r[i + 1]?.partner;
        r[i] = { ...r[i], ticket: t };
        if (isPair(core, t)) { if (hadPartner) r[i + 1] = { ...r[i + 1], ticket: t }; else r.splice(i + 1, 0, { name: '', ticket: t, partner: true }); }
        else if (hadPartner) r.splice(i + 1, 1);
        setRows(r);
    };
    const removeAt = (i: number) => setRows(rows.filter((_, j) => j !== i && !(j === i + 1 && rows[j].partner)));
    const setAt = (i: number, v: string) => { onEdit?.(); setRows(rows.map((x, j) => (j === i ? { ...x, name: v } : x))); };
    let num = 0;
    return <>
        <ol className="plain dlist names">
            {rows.map((r, i) => { num++; return <li key={i} className={`drow trow${r.partner ? ' partner' : ''}`}>
                <span className="meta nidx">{num}</span>
                <input className="inp dname" value={r.name} onChange={e => setAt(i, e.target.value)} placeholder={r.partner ? 'שם השני ברכב הזוגי' : 'שם'} aria-label={`משתתף ${num}`} maxLength={24} />
                {!r.partner && <button type="button" className="kb ghost sm" aria-label={`הסר משתתף ${num}`} disabled={rows.filter(x => !x.partner).length <= 1} onClick={() => removeAt(i)}>✕</button>}
                {r.partner ? <span className="meta pair-note">↑ באותו רכב זוגי</span>
                    : <TicketChips core={core} value={r.ticket} onChange={t => setTicketAt(i, t)} label={`כרטיס למשתתף ${num}`} minutes={minutes} />}
            </li>; })}
        </ol>
        <div className="actions"><Btn small disabled={rows.length >= L.MAX_FORM_NAMES} onClick={() => setRows([...rows, { name: '', ticket: def }])}>+ משתתף</Btn></div>
    </>;
}

function CustomerForm({ core, update }: { core: L.Core; update: Update }) {
    const [group, setGroup] = useState('');
    const def = core.settings.tickets[0] ?? '';
    const blank = (): FormRow[] => [{ name: '', ticket: def }, { name: '', ticket: def }];
    const [rows, setRows] = useState<FormRow[]>(blank);
    const [minutes, setMinutes] = useState(10);
    const [error, setError] = useState('');
    const [sent, setSent] = useState<{ id: string; group: string; n: number; tickets: string[]; minutes: number } | null>(null);
    const names = rows.map(r => r.name);
    const tix = rows.map(r => r.ticket);
    const chosen = rows.filter(r => r.name.trim()).map(r => r.ticket);
    const filled = chosen.length;
    const submit = () => {
        let res: { id?: string; error?: string } = {};
        update(c => { const r = L.submitForm(c, group, names, Date.now(), tix, minutes); res = r; return r.core; });
        if (res.error || !res.id) { setError(res.error ?? 'שגיאה'); return; }
        setSent({ id: res.id, group: group.trim(), n: filled, tickets: chosen, minutes }); setGroup(''); setRows(blank()); setMinutes(10); setError('');
    };
    const sample = () => {
        const k = Math.floor(Math.random() * 20);
        setGroup(`קבוצה לדוגמה ${k + 1}`);
        const n = 3 + (k % 4);
        setRows(Array.from({ length: n }, (_, i) => ({ name: L.DEMO_NAMES[(k + i * 7) % L.DEMO_NAMES.length], ticket: def })));
    };
    if (sent) return <Group label="נשלח לקופה" heading>
        <div className="sent">
            <div className="sent-num">#{sent.id.replace(/\D/g, '')}</div>
            <p><b>{sent.group}</b> · {sent.n} משתתפים · {sent.minutes} דקות</p>
            <PriceLine core={core} tickets={sent.tickets} minutes={sent.minutes} />
            <p>ההרשמה מחכה בקופה. גשו לקופה לתשלום. אחרי אישור התשלום תיכנסו לתור ותוזמנו במסך המסלול.</p>
        </div>
        <Btn kind="primary" onClick={() => setSent(null)}>הרשמה חדשה</Btn>
    </Group>;
    return <Group label="הרשמה לקארטינג" heading>
        <Callout title="דמו" tone="warning">זה טופס לדוגמה. אל תזינו שמות אמיתיים. ליד כל שם בוחרים כרטיס. ליגה ומאסטר ⚡ הן מכוניות מהירות. בזוגי יושבים שניים ברכב אחד, אז נפתחת שורה לשם השני. אין תשלום בטופס: משלמים בקופה.</Callout>
        <div className="form">
            <label className="field"><span className="flabel">שם הקבוצה</span>
                <input className="inp" value={group} onChange={e => { setError(''); setGroup(e.target.value); }} placeholder="למשל: החבר׳ה מהעבודה" maxLength={40} />
            </label>
            <div className="field"><span className="flabel">אורך המקצה</span><MinuteChips value={minutes} onChange={setMinutes} /></div>
            <div className="field"><span className="flabel">שמות המשתתפים ({filled})</span>
                <NameRows core={core} rows={rows} setRows={setRows} minutes={minutes} onEdit={() => setError('')} />
                <div className="actions"><Btn small onClick={sample}>מלא דוגמה</Btn></div>
            </div>
            <PriceLine core={core} tickets={chosen.length ? chosen : rows.map(r => r.ticket)} minutes={minutes} />
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
        {(g.minutes ?? 10) >= 20 && <span className="gtag">{g.minutes} דק׳</span>}
    </span>;
}

/** One pending registration: tickets per participant (from the form, editable), family, price, then "paid". */
function PendingItem({ core, update, sb }: { core: L.Core; update: Update; sb: L.Submission }) {
    const def = core.settings.tickets[0] ?? '';
    const [tix, setTix] = useState<string[]>(() => sb.names.map((_, i) => sb.tickets?.[i] ?? def));
    const [family, setFamily] = useState(false);
    const [minutes, setMinutes] = useState(sb.minutes ?? 10);
    const fast = tix.filter(t => L.isFastTicket(core, t)).length;
    const mixed = fast > 0 && fast < tix.length;
    return <li className="item pending">
        <div className="itop"><strong>{sb.groupName}</strong><span className="big">{sb.names.length}</span></div>
        <div className="meta">#{sb.id.replace(/\D/g, '')} · {timeOf(sb.createdAt)}</div>
        <ul className="plain dlist">
            {sb.names.map((n, i) => <li key={i} className="trow"><span className="tname">{n}</span>
                <TicketChips core={core} value={tix[i]} onChange={t => setTix(tix.map((x, j) => (j === i ? t : x)))} label={`כרטיס ל${n}`} minutes={minutes} /></li>)}
        </ul>
        <div className="chips"><button type="button" aria-pressed={family} className={`chip${family ? ' sel' : ''}`} onClick={() => setFamily(!family)}>משפחה (מותר לערבב מהירות ורגילות)</button></div>
        {mixed && <div className={family ? 'meta' : 'warn'}>{family ? 'משפחה: ייכנסו יחד לאותו מקצה.' : `יש כאן ${fast} עם מכוניות מהירות ו-${tix.length - fast} עם רגילות. אם זו לא משפחה, הם יתפצלו לשתי קבוצות ולמקצים נפרדים.`}</div>}
        <MinuteChips value={minutes} onChange={setMinutes} />
        <PriceLine core={core} tickets={tix} minutes={minutes} />
        <div className="actions">
            <Btn kind="primary" small onClick={() => update(c => L.markPaidAndPlan(c, sb.id, Date.now(), { tickets: tix, family, minutes }))}>שולם · הכנס לתור</Btn>
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
    const def = core.settings.tickets[0] ?? '';
    const [rows, setRows] = useState<FormRow[]>([{ name: '', ticket: def }, { name: '', ticket: def }]);
    const [mins, setMins] = useState(10);
    const [mErr, setMErr] = useState('');
    const named = rows.filter(r => r.name.trim());
    // With names: same path as a customer form that is paid at once (tickets per name, minutes, family, pair seats).
    const addNamed = () => {
        const nm = name.trim() || `קבוצה ${core.groups.length + 1}`;
        let err = '';
        update(c => { const r = L.submitForm(c, nm, rows.map(x => x.name), Date.now(), rows.map(x => x.ticket), mins); if (r.error || !r.id) { err = r.error ?? 'שגיאה'; return c; } return L.markPaidAndPlan(r.core, r.id, Date.now(), { family: fam, keepTogether: keep, minutes: mins }); });
        if (err) { setMErr(err); return; }
        setName(''); setNote(''); setRows([{ name: '', ticket: def }, { name: '', ticket: def }]); setMins(10); setMErr('');
    };
    const add = () => {
        if (named.length > 0) { addNamed(); return; }
        const nm = name.trim() || `קבוצה ${core.groups.length + 1}`;
        update(c => { const x = L.addGroup(c, { name: nm, size, ticket, keepTogether: keep, note: note.trim() }, Date.now()); const id = x.groups[x.groups.length - 1].id; return { ...x, groups: x.groups.map(g => (g.id === id ? { ...g, family: fam, ...(mins >= 20 ? { minutes: 20 } : {}) } : g)) }; });
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
                <div className="field"><span className="flabel">אורך המקצה</span><MinuteChips value={mins} onChange={setMins} /></div>
                <div className="field"><span className="flabel">שמות המשתתפים ({named.length})</span>
                    <NameRows core={core} rows={rows} setRows={setRows} minutes={mins} onEdit={() => setMErr('')} />
                </div>
                {named.length > 0 ? <PriceLine core={core} tickets={named.map(r => r.ticket)} minutes={mins} /> : <>
                    <p className="meta">אפשר גם בלי שמות: משאירים את השורות ריקות ובוחרים רק כמה משתתפים וסוג כרטיס.</p>
                    <Stepper label="כמה משתתפים (בלי שמות)" value={size} min={1} max={30} onChange={setSize} />
                    <div className="field"><span className="flabel">מה נקנה</span>
                        <div className="chips" role="radiogroup" aria-label="סוג כרטיס">
                            {core.settings.tickets.map(t => <button key={t} type="button" role="radio" aria-checked={ticket === t} className={`chip${ticket === t ? ' sel' : ''}`} onClick={() => setTicket(t)}>{t}{L.isFastTicket(core, t) ? ' ⚡' : ''}</button>)}
                        </div>
                    </div>
                </>}
                <div className="chips"><button type="button" aria-pressed={fam} className={`chip${fam ? ' sel' : ''}`} onClick={() => setFam(!fam)}>משפחה (מותר לערבב מהירות ורגילות)</button></div>
                {mErr && <div className="warn" role="alert">{mErr}</div>}
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
                    {L.mixNeedsOk(core, h) && <div className="warn mixwarn">מכוניות מהירות (ליגה/מאסטר) ורגילות באותו מקצה. מותר רק באישור אחמ״ש (או למשפחה).
                        {canEdit && <Btn small onClick={() => act(c => L.approveMix(c, h.id))}>אחמ״ש מאשר ערבוב</Btn>}</div>}
                    {L.mixApproved(core, h) && <div className="meta mixok">✓ ערבוב מהירות ורגילות אושר ע״י אחמ״ש.
                        {canEdit && <button type="button" className="kb ghost sm" onClick={() => act(c => L.approveMix(c, h.id, false))}>בטל אישור</button>}</div>}
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
type BoardRow = {
    key: string; pos: number; kart: number; label: string; laps: number; best: number | null; last: number | null;
    gap: string; finished: boolean; isBest: boolean; gained: number | null;
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

function WallDisplay(p: { title: string; sub: string; totalLaps: number; clock?: string; countdown?: string; state: 'live' | 'done' | 'wait'; rows: BoardRow[]; footer?: React.ReactNode; onClose: () => void; real?: boolean; srcName?: string }) {
    useEscape(p.onClose);
    const dense = p.rows.length > 10;
    const listRef = useRef<HTMLOListElement>(null);
    useRankAnimation(listRef, p.rows.map(r => r.key).join('|'));
    const nosec = !!p.real; // real track timing: no gap column (as on the RentiX screen)
    // podium at the end of a heat: shown for a few seconds over the results, tap to close
    const [podium, setPodium] = useState(false);
    const podKey = p.state === 'done' && p.rows.length > 0 ? p.title : '';
    useEffect(() => {
        if (!podKey) { setPodium(false); return; }
        setPodium(true);
        const t = setTimeout(() => setPodium(false), 14_000);
        return () => clearTimeout(t);
    }, [podKey]);
    return <div className={`wall tboard${nosec ? ' nosec' : ''}`} role="dialog" aria-label="לוח זמנים">
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
        {p.real ? <div className="wall-sim real">זמנים מהמסלול · {p.srcName ?? 'RentiX'}</div> : <div className="wall-sim">סימולציה · נתוני דמה · לא שעון אמיתי</div>}
        <ol ref={listRef} className={`tb-rows${dense ? ' dense' : ''}`}>
            <li className="tb-row tb-cols" aria-hidden="true"><span>מק׳</span><span>קארט</span><span>נהג</span><span>אחרונה</span><span>הקפה מהירה</span><span>פער</span><span>הקפות</span></li>
            {p.rows.map(r => <li key={r.key} data-k={r.key} className={`tb-row p${r.pos}${r.pos === 1 ? ' lead' : ''}`}>
                <span className="tb-pos">{r.pos}{r.gained ? <em className={r.gained > 0 ? 'up' : 'down'}>{r.gained > 0 ? `▲${r.gained}` : `▼${-r.gained}`}</em> : null}</span>
                <span className="tb-kart">{r.kart}</span>
                <span className="tb-name">{r.label}</span>
                <span className="tb-last"><bdi>{L.fmt(r.last)}</bdi></span>
                <span className={`tb-best${r.isBest ? ' ob' : ''}`}><bdi>{L.fmt(r.best)}</bdi></span>
                <span className="tb-gap"><bdi>{r.gap}</bdi></span>
                <span className="tb-laps">{p.totalLaps ? `${r.laps}/${p.totalLaps}` : r.laps}{r.finished ? ' ✓' : ''}</span>
            </li>)}
        </ol>
        <div className="tb-legend"><span className="ob">סגול</span> הכי מהיר במקצה{nosec ? '' : ' · ▲▼ מקומות לעומת הזינוק'}</div>
        {p.footer && <div className="call-next">{p.footer}</div>}
        {podium && <Podium title={p.title} rows={p.rows} onClose={() => setPodium(false)} />}
    </div>;
}

/** Rows that change place slide to their new spot; a row that climbs flashes green, one that drops flashes red. */
function useRankAnimation(list: React.RefObject<HTMLOListElement>, order: string) {
    const prev = useRef(new Map<string, { top: number; idx: number }>());
    useLayoutEffect(() => {
        const ol = list.current;
        if (!ol) return;
        const rows = [...ol.querySelectorAll<HTMLElement>('li[data-k]')];
        const next = new Map<string, { top: number; idx: number }>();
        rows.forEach((el, idx) => next.set(el.dataset.k!, { top: el.getBoundingClientRect().top, idx }));
        const calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (!calm && typeof rows[0]?.animate === 'function') rows.forEach(el => {
            const was = prev.current.get(el.dataset.k!), now = next.get(el.dataset.k!)!;
            if (!was || was.idx === now.idx) return;
            const dy = was.top - now.top;
            const up = now.idx < was.idx;
            el.animate([{ transform: `translateY(${dy}px)`, zIndex: up ? 2 : 1 }, { transform: 'translateY(0)', zIndex: up ? 2 : 1 }], { duration: 700, easing: 'cubic-bezier(.2,.8,.2,1)' });
            const glow = up ? 'rgba(46,224,106,.55)' : 'rgba(255,80,86,.45)';
            el.animate([{ outline: `2px solid ${glow}`, filter: 'brightness(1.35)' }, { outline: '2px solid transparent', filter: 'brightness(1)' }], { duration: 1600, easing: 'ease-out' });
        });
        prev.current = next;
    }, [order, list]);
}

/** End-of-heat podium: 2nd, 1st, 3rd rise up with name, kart and best lap; confetti falls. Tap to see the full results. */
function Podium({ title, rows, onClose }: { title: string; rows: BoardRow[]; onClose: () => void }) {
    const top = [rows[1], rows[0], rows[2]];
    const conf = React.useMemo(() => Array.from({ length: 36 }, (_, i) => ({ l: (i * 37) % 100, d: (i % 9) * 0.35, c: ['#e3262b', '#ffd400', '#ffffff', '#c77dff'][i % 4], r: (i * 53) % 360 })), []);
    return <div className="podium" role="dialog" aria-label={`פודיום · ${title}`} onClick={onClose}>
        <div className="pd-conf" aria-hidden="true">{conf.map((c, i) => <i key={i} style={{ left: `${c.l}%`, animationDelay: `${c.d}s`, background: c.c, rotate: `${c.r}deg` } as React.CSSProperties} />)}</div>
        <div className="pd-title"><span>פודיום</span><b>{title}</b></div>
        <div className="pd-stage">
            {top.map((r, i) => r ? <div key={r.key} className={`pd-col p${r.pos}`} style={{ '--d': `${[0.9, 1.6, 0.3][i]}s` } as React.CSSProperties}>
                <div className="pd-who">
                    <Avatar kart={r.kart} label={r.label} />
                    <div className="pd-name">{r.label}</div>
                    <div className="pd-meta"><span className="pd-kart">{r.kart}</span><bdi>{L.fmt(r.best)}</bdi></div>
                </div>
                <div className="pd-block"><span>{r.pos}</span></div>
            </div> : <div key={i} className="pd-col empty" />)}
        </div>
        <div className="pd-hint">לחיצה לתוצאות המלאות</div>
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
            <div className="lu-banner" key={`${p.state}-${p.heat?.id ?? ''}`}><span>{p.state === 'call' ? 'נקראים למסלול' : p.state === 'next' ? 'הבא בתור' : 'אין מקצים בתור'}</span>{p.heat && <b>מקצה {p.heat.num}</b>}</div>
            <button type="button" className="wall-close" onClick={p.onClose} aria-label="סגור תצוגת מסך">✕</button>
        </header>
        <div className="lu-sub">{p.heat ? `${ds.length} נהגים${p.state === 'call' ? ' · לגשת לאזור ההמתנה, לפי מספר הקארט' : ' · עוד לא נקרא, להתכונן'}` : waiting ? `${waiting} קבוצות ממתינות לשיבוץ בקופה` : 'ממתינים לקבוצות'}</div>
        <div className="wall-sim">סימולציה · שמות ותמונות זמניים לדוגמה · לא חיבור למסלול</div>
        {p.state === 'call' && <div className="lu-flag" aria-hidden="true" />}
        {p.heat && <ul key={`${p.state}-${p.heat.id}`} className={`lu-grid${ds.length > 10 ? ' many' : ''}`}>
            {ds.map((d, i) => {
                const hide = staff && !d.kartSet;
                return <li key={d.key} className="lu-card" style={{ '--i': i } as React.CSSProperties}>
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

/** Time behind the leader, compared at the same number of laps (the lap count has its own column). */
function gapTo(total: number, laps: number, leaderLaps: number[]): string {
    if (laps === 0 || leaderLaps.length < laps) return '';
    const at = leaderLaps.slice(0, laps).reduce((a, b) => a + b, 0);
    return `+${L.fmt(Math.max(0, total - at))}`;
}

function liveRowsOf(core: L.Core, timing: L.DriverTiming[]): BoardRow[] {
    const h = L.runningHeat(core);
    if (!h || !core.live) return [];
    const drivers = L.driversOf(core, h);
    const ranked = L.rank(timing);
    const leader = ranked[0];
    const bestAll = Math.min(...timing.map(t => t.best ?? Infinity));
    return ranked.map((t, i) => {
        const d = drivers.find(x => x.key === t.key)!;
        const gap = i === 0 || !leader ? '' : gapTo(t.total, t.laps.length, leader.laps);
        const grid = drivers.findIndex(x => x.key === t.key) + 1;
        return { key: t.key, pos: i + 1, kart: d.kart, label: d.label, laps: t.laps.length, best: t.best, last: t.last, gap, finished: t.finished, isBest: t.best != null && t.best === bestAll, gained: t.laps.length ? grid - (i + 1) : null };
    });
}

function resultRowsOf(r: L.Result): BoardRow[] {
    const bAll = Math.min(...r.rows.map(x => x.best ?? Infinity));
    return r.rows.map((x, i) => ({ key: `${x.pos}`, pos: x.pos, kart: x.kart, label: x.label, laps: x.laps.length, best: x.best, last: x.laps.length ? x.laps[x.laps.length - 1] : null, gap: i === 0 ? '' : gapTo(x.total, x.laps.length, r.rows[0].laps), finished: r.simulated ? x.laps.length >= r.laps : true, isBest: x.best != null && x.best === bAll, gained: null }));
}

const mmss = (ms: number) => { const s = Math.ceil(ms / 1000); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

/** The venue screen: switches by itself between lineup (call / next / empty) and live timing. */
/** Live board from RentiX (real track timing, read-only). */
function ExtWall({ ext, onClose }: { ext: R.ExtBoard; onClose: () => void }) {
    const lead = ext.rows[0];
    const bAll = Math.min(...ext.rows.map(r => r.best ?? Infinity));
    const done = /finish|checker/i.test(ext.flag);
    const seen = new Set<string>(); // stable key per driver so a place change animates
    const keyOf = (r: { kart: number; name: string }, i: number) => { let k = `${r.kart}-${r.name}`; if (seen.has(k)) k += `-${i}`; seen.add(k); return k; };
    const rows: BoardRow[] = ext.rows.map((r, i) => ({ key: keyOf(r, i), pos: r.pos, kart: r.kart, label: r.name, laps: r.laps, best: r.best, last: r.last,
        gap: i === 0 || r.total == null || lead.total == null ? '' : r.laps === lead.laps ? `+${L.fmt(Math.max(0, r.total - lead.total))}`
            // fewer laps: the leader's race time when it had done as many laps
            : lead.lapTimes && lead.lapTimes.length === lead.laps && r.laps > 0 ? `+${L.fmt(Math.max(0, r.total - (lead.total - lead.lapTimes.slice(r.laps).reduce((a, b) => a + b, 0))))}` : '',
        finished: done, isBest: r.best != null && r.best === bAll, gained: null }));
    return <WallDisplay title={ext.run || 'מקצה'} sub={done ? 'הסתיים · תוצאות' : `על המסלול · זמנים מהמסלול${ext.flag ? ` · ${ext.flag}` : ''}`} totalLaps={0} state={done ? 'done' : 'live'}
        clock={ext.raceTime != null ? L.fmt(ext.raceTime) : undefined} countdown={ext.timeToGo ? mmss(ext.timeToGo) : undefined} rows={rows} onClose={onClose} real srcName={R.sourceName(ext.src)} />;
}

/** Polls the timing bridge on this computer (dk-bridge, or the older rentix-bridge.ps1). Not running = no live data.
 *  source: RentiX's feed, or the AMB decoder read directly. */
type RxState = { up: boolean; connected: boolean; error: string; ext: R.ExtBoard | null; source?: R.ExtSource };
function useRentix(): RxState {
    const [st, setSt] = useState<RxState>({ up: false, connected: false, error: '', ext: null });
    useEffect(() => {
        let stop = false; let timer: ReturnType<typeof setTimeout>;
        const tick = async () => {
            const b = await R.readBridge();
            if (stop) return;
            setSt(b ? { up: true, connected: b.connected, error: b.error, source: b.source, ext: R.parseRMonitor(b.lines, Date.now(), b.source) } : { up: false, connected: false, error: '', ext: null });
            timer = setTimeout(tick, b ? 1000 : 5000);
        };
        void tick();
        return () => { stop = true; clearTimeout(timer); };
    }, []);
    return st;
}

export function TrackScreen({ core, now, onClose, ext }: { core: L.Core; now: number; onClose: () => void; ext?: R.ExtBoard | null }) {
    // real timing from RentiX wins over the simulation while it has a heat
    if (R.extActive(ext)) return <ExtWall ext={ext} onClose={onClose} />;
    const sc = L.screenState(core);
    if (sc.state === 'race' && sc.heat) {
        const timing = L.liveTiming(core, now);
        const done = L.allFinished(timing);
        const called = L.calledHeat(core);
        const el = L.elapsedOf(core.live, now);
        const left = L.timeLeft(core.live, now);
        const timed = left != null;
        const sub = done ? 'הסתיים · תוצאות' : L.isPaused(core) ? 'המקצה עצור · דגל אדום' : timed && left === 0 ? 'הזמן נגמר · הקפה אחרונה' : 'על המסלול · בלייב';
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
    save: () => void; start: (id: string) => void; cancel: () => void; goHeats: () => void; rx: RxState;
};

/** Race control: one bar with start, pause/resume, save, reset and cancel for the heat on track. */
function RaceControl(p: { core: L.Core; update: Update; now: number; done: boolean; canSave: boolean; startable: L.Heat | undefined; start: (id: string) => void; save: () => void; cancel: () => void }) {
    const heat = L.runningHeat(p.core);
    const paused = L.isPaused(p.core);
    const [ask, setAsk] = useState<'' | 'reset' | 'cancel'>('');
    useEffect(() => { setAsk(''); }, [heat?.id]);
    const left = L.timeLeft(p.core.live, p.now);
    const state = !heat ? 'idle' : p.done ? 'done' : paused ? 'paused' : 'live';
    const label = { idle: p.startable ? `מוכן · מקצה ${p.startable.num}` : 'אין מקצה מוכן', live: `במירוץ · מקצה ${heat?.num}`, paused: `עצור · מקצה ${heat?.num}`, done: `הסתיים · מקצה ${heat?.num}` }[state];
    const clock = heat ? (left != null ? mmss(left) : L.fmt(L.elapsedOf(p.core.live, p.now))) : p.startable ? `${L.heatMinutesOf(p.core)}:00` : '--:--';
    return <div className={`rc rc-${state}`} role="toolbar" aria-label="שליטה במקצה">
        <div className="rc-status">
            <span className="rc-dot" aria-hidden="true" />
            <span className="rc-label">{label}</span>
            <bdi className="rc-clock" aria-label="שעון המקצה">{clock}</bdi>
        </div>
        {ask ? <div className="rc-ask" role="alertdialog" aria-label="אישור">
            <span>{ask === 'reset' ? 'לאפס את המקצה? השעון וההקפות יתחילו מאפס, אותם נהגים.' : 'לבטל את המקצה בלי לשמור? הוא יחזור לתור.'}</span>
            <button type="button" className="rc-btn rc-danger" onClick={() => { if (ask === 'reset') p.update(c => L.restartRun(c, Date.now())); else p.cancel(); setAsk(''); }}>{ask === 'reset' ? 'כן, אפס' : 'כן, בטל'}</button>
            <button type="button" className="rc-btn" onClick={() => setAsk('')}>חזרה</button>
        </div> : <div className="rc-btns">
            <button type="button" className="rc-btn rc-go" disabled={!!heat || !p.startable} onClick={() => p.startable && p.start(p.startable.id)}><i aria-hidden="true">▶</i><span>התחלה</span></button>
            {paused
                ? <button type="button" className="rc-btn rc-go" onClick={() => p.update(c => L.resumeRun(c, Date.now()))}><i aria-hidden="true">▶</i><span>המשך</span></button>
                : <button type="button" className="rc-btn rc-stop" disabled={!heat || p.done} onClick={() => p.update(c => L.pauseRun(c, Date.now()))}><i aria-hidden="true">❚❚</i><span>עצירה</span></button>}
            <button type="button" className="rc-btn rc-save" disabled={!heat || !p.canSave} onClick={p.save}><i aria-hidden="true">✓</i><span>{p.done ? 'שמירה' : 'סיום ושמירה'}</span></button>
            <button type="button" className="rc-btn rc-reset" disabled={!heat} onClick={() => setAsk('reset')}><i aria-hidden="true">↺</i><span>איפוס</span></button>
            <button type="button" className="rc-btn rc-cancel" disabled={!heat} onClick={() => setAsk('cancel')}><i aria-hidden="true">✕</i><span>ביטול</span></button>
        </div>}
    </div>;
}

function Live({ core, update, now, hist, auto, setAuto, openScreen, save, start, cancel, goHeats, rx }: LiveProps) {
    const ext = R.extActive(rx.ext) ? rx.ext : null;
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
        {ext && <div className="rx-card" aria-label={`זמנים מהמסלול (${R.sourceName(ext.src)})`}>
            <div className="itop"><strong>{ext.run || 'מקצה'} · זמנים מהמסלול</strong><span className="badge rx">{R.sourceName(ext.src)} · אמיתי</span></div>
            <p className="meta">{ext.raceTime != null ? `זמן ${L.fmt(ext.raceTime)}` : ''}{ext.timeToGo ? ` · נותר ${mmss(ext.timeToGo)}` : ''}{ext.flag ? ` · ${ext.flag}` : ''}. {ext.src === 'decoder' ? 'נקרא ישירות מהדקודר: מקצה חדש מתחיל במעבר הראשון אחרי דקה בלי מעברים בקו.' : 'המקצה מנוהל ב-RentiX; כאן רק מוצג ונשלח למסך הלקוחות.'}</p>
            {R.unmappedTx(ext, core.settings.transponders).length > 0 && <p className="warn">טרנספונדרים בלי קארט: {R.unmappedTx(ext, core.settings.transponders).join(', ')}. שייך בהגדרות ← שעון הקפות.</p>}
            <ol className="board">{ext.rows.map(r => <li key={`${r.kart}-${r.pos}`} className="brow"><span className="pos">{r.pos}</span><span className="kart">{r.kart}</span><span className="who">{r.name}<small>{r.laps} הקפות</small></span><span className="times"><b><bdi>{L.fmt(r.best)}</bdi></b><small>אחרונה <bdi>{L.fmt(r.last)}</bdi></small></span></li>)}</ol>
        </div>}
        <Callout title="סימולציה, לא שעון אמיתי" tone="warning">הזמנים מומצאים על ידי האפליקציה כדי להדגים את המסך. אין חיבור לשעון ההקפות או למסכים של המסלול. התזמונים של הדמו האוטומטי להמחשה בלבד.</Callout>

        <div className="row-actions">
            <Btn kind={auto ? 'on' : 'ghost'} onClick={() => { const on = !auto; setAuto(on); if (on) openScreen('track'); }}>{auto ? '■ עצור דמו אוטומטי' : '▶ הפעל דמו אוטומטי'}</Btn>
            <Btn onClick={() => openScreen('track')}>מסך מסלול</Btn>
            {!heat && <Btn onClick={() => { update(c => L.demoSetup(c, Date.now())); setAuto(true); openScreen('track'); }}>⚡ הדגמה מלאה בלחיצה</Btn>}
            <Btn small onClick={() => update(L.fillDemoNames)}>מלא שמות דמו</Btn>
        </div>
        <p className="meta">{auto ? autoNext : 'תור פשוט, בלי שעות: המקצים המאושרים לפי הסדר. "מסך מסלול" הוא המסך הגדול באתר: הוא עובר לבד בין קריאה, הבא בתור ומירוץ. בדמו האוטומטי המסך קורא, מציג תוצאות וממשיך לבד, אבל מקצה מתחיל רק בלחיצה על "התחל מקצה". הקופאית יכולה לשנות הרכב בכל שלב בלשונית מקצים.'}</p>

        <RaceControl core={core} update={update} now={now} done={done} canSave={done || rows.some(r => r.laps > 0)} startable={!heat ? [calledH, ...qList].find(h => h && L.startBlockers(core, h).length === 0) : undefined} start={start} save={save} cancel={cancel} />
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
                <Btn onClick={() => openScreen('track')}>תצוגת מסך</Btn>
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

        {lastRes && !heat && <div className="row-actions"><span className="meta">תוצאה אחרונה: {L.resultTitle(lastRes)} · {timeOf(lastRes.at)}</span><Btn small onClick={() => openScreen('last')}>הצג על מסך</Btn></div>}
    </Group>;
}

// ------------------------------------------------------------------ history
function History({ hist, pub }: { hist: L.Result[]; pub?: boolean }) {
    const [q, setQ] = useState('');
    const [open, setOpen] = useState<string | null>(null);
    const [openRow, setOpenRow] = useState<string | null>(null);
    const shown = hist.filter(r => !q.trim() || r.rows.some(x => x.label.includes(q.trim())));
    return <Group label="היסטוריית מקצים" heading>
        <label className="field"><span className="flabel">חיפוש לפי שם</span>
            <input className="inp" value={q} onChange={e => setQ(e.target.value)} placeholder="שם קבוצה או נהג" />
        </label>
        {hist.length === 0 && <p className="empty">{pub ? 'עוד אין מקצים שהסתיימו היום.' : 'עוד אין מקצים שהסתיימו. הרץ מקצה בלשונית חי (או את הדמו האוטומטי).'}</p>}
        <ul className="list">
            {shown.map(r => {
                const id = `${r.heatId}-${r.at}`;
                const isOpen = open === id;
                const q2 = q.trim();
                return <li key={id} className="item">
                    <button type="button" className="hhead" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : id)}>
                        <strong>{L.resultTitle(r)}</strong>
                        <span className="meta">{dayOf(r.at)} {timeOf(r.at)} · {r.rows.length} נהגים{r.minutes ? ` · ${r.minutes} דק׳` : ''}{pub ? '' : ` · ${r.simulated ? 'סימולציה' : 'אמיתי'}`}</span>
                        <span aria-hidden="true">{isOpen ? '▴' : '▾'}</span>
                    </button>
                    {isOpen && <ol className="board">
                        {r.rows.map(x => {
                            const rk = `${id}-${x.pos}`;
                            const lapsOpen = openRow === rk;
                            return <li key={x.pos} className={`brow-wrap${q2 && x.label.includes(q2) ? ' hit' : ''}`}>
                                <button type="button" className="brow brow-btn" aria-expanded={lapsOpen} onClick={() => setOpenRow(lapsOpen ? null : rk)} disabled={x.laps.length === 0}>
                                    <span className="pos">{x.pos}</span><span className="kart">{x.kart}</span>
                                    <span className="who">{x.label}<small>{r.minutes ? `${x.laps.length} הקפות` : `${x.laps.length}/${r.laps} הקפות`}{x.laps.length ? (lapsOpen ? ' · ▴' : ' · זמני הקפות ▾') : ''}</small></span>
                                    <span className="times"><b><bdi>{L.fmt(x.best)}</bdi></b><small>סה״כ <bdi>{L.fmt(x.total)}</bdi></small></span>
                                </button>
                                {lapsOpen && <ol className="laplist" aria-label={`זמני הקפות · ${x.label}`}>
                                    {x.laps.map((ms, n) => <li key={n} className={ms === x.best ? 'best' : ''}>
                                        <span>הקפה {n + 1}</span><bdi>{L.fmt(ms)}</bdi>
                                    </li>)}
                                </ol>}
                            </li>;
                        })}
                    </ol>}
                </li>;
            })}
        </ul>
    </Group>;
}

/** Kart info (as in RentiX): each kart's fastest lap in these heats, who drove it, and how much it ran. */
function KartInfo({ hist }: { hist: L.Result[] }) {
    const ks = L.kartStats(hist);
    return <Group label="מידע קארטים" heading>
        {ks.length === 0 ? <p className="empty">עוד אין הקפות בתקופה הזו.</p> : <ol className="board kinfo">
            <li className="brow kcols" aria-hidden="true"><span className="kart">קארט</span><span className="who">שיא הקארט · נהג</span><span className="times">מקצים · הקפות</span></li>
            {ks.map((k, i) => <li key={k.kart} className={`brow${i === 0 && k.best != null ? ' hit' : ''}`}>
                <span className="kart">{k.kart}</span>
                <span className="who"><b><bdi>{L.fmt(k.best)}</bdi></b><small>{k.bestBy || '–'}{k.bestAt ? ` · ${timeOf(k.bestAt)}` : ''}</small></span>
                <span className="times"><b>{k.heats}</b><small>{k.laps} הקפות</small></span>
            </li>)}
        </ol>}
    </Group>;
}

/** Preparation (as in RentiX): the heat being called and the next ones, with drivers and karts. */
function NextHeats({ core }: { core: L.Core }) {
    const called = L.calledHeat(core);
    const running = L.runningHeat(core);
    const list = [called, ...L.queueOf(core).filter(h => h.id !== called?.id)].filter((h): h is L.Heat => !!h).slice(0, 6);
    const staff = L.kartMode(core) === 'staff';
    return <Group label="הבא בתור" heading>
        {running && <p className="meta">עכשיו על המסלול: מקצה {running.num}</p>}
        {list.length === 0 ? <p className="empty">אין מקצים בתור כרגע.</p> : <ul className="list">
            {list.map(h => <li key={h.id} className="item">
                <div className="hhead static"><strong>מקצה {h.num}</strong><span className="meta">{h.id === called?.id ? 'נקראים למסלול' : 'ממתין'} · {L.heatCount(h)} נהגים</span></div>
                <ol className="board">{L.driversOf(core, h).map((d, i) => <li key={d.key} className="brow">
                    <span className="pos">{i + 1}</span><span className="kart">{staff && !d.kartSet ? '?' : d.kart}</span><span className="who">{d.label}</span>
                </li>)}</ol>
            </li>)}
        </ul>}
    </Group>;
}

/** Staff history: the current period (resets at midnight or end of week) and the full archive from the cloud. */
function HistoryTab({ core, update, hist, now }: { core: L.Core; update: Update; hist: L.Result[]; now: number }) {
    const mode = L.histResetOf(core);
    const [view, setView] = useState<'now' | 'all'>('now');
    const [arch, setArch] = useState<L.Result[] | null>(null);
    const [err, setErr] = useState('');
    useEffect(() => { if (view === 'all') { setErr(''); void Cloud.fetchArchive().then(r => { if (r) setArch(r); else setErr('אין חיבור לארכיון בענן. מוצג מה שנשמר במכשיר הזה.'); }); } }, [view]);
    const cur = L.currentPeriod(hist, now, mode);
    const all = L.mergeResults(arch ?? [], hist);
    const since = new Date(L.periodStart(now, mode)).toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'numeric' });
    return <>
        <div className="row-actions">
            <div className="chips" role="radiogroup" aria-label="תצוגת היסטוריה">
                <button type="button" role="radio" aria-checked={view === 'now'} className={`chip${view === 'now' ? ' sel' : ''}`} onClick={() => setView('now')}>{mode === 'day' ? 'היום' : 'השבוע'} ({cur.length})</button>
                <button type="button" role="radio" aria-checked={view === 'all'} className={`chip${view === 'all' ? ' sel' : ''}`} onClick={() => setView('all')}>ארכיון מלא</button>
            </div>
        </div>
        <p className="meta">{view === 'now' ? `מקצים מאז ${since} 00:00. התצוגה הזו (וגם באתר הציבורי) מתחילה מחדש ${mode === 'day' ? 'כל לילה ב-12' : 'כל מוצאי שבת ב-12 בלילה'}. שום דבר לא נמחק: הכול נשמר בארכיון.` : `כל המקצים שנשמרו בענן${arch ? ` (${all.length})` : '…'}.`}</p>
        {err && <p className="err">{err}</p>}
        <div className="field"><span className="flabel">איפוס התצוגה</span>
            <div className="chips" role="radiogroup" aria-label="איפוס התצוגה">
                {([['day', 'כל לילה ב-12'], ['week', 'כל סוף שבוע']] as [L.HistReset, string][]).map(([k, t]) => <button key={k} type="button" role="radio" aria-checked={mode === k} className={`chip sm${mode === k ? ' sel' : ''}`} onClick={() => update(c => ({ ...c, settings: { ...c.settings, histReset: k } }))}>{t}</button>)}
            </div>
        </div>
        <History hist={view === 'now' ? cur : all} />
        <KartInfo hist={view === 'now' ? cur : all} />
        {view === 'all' && all.length > 0 && <div className="row-actions"><CopyButton text={JSON.stringify(all, null, 1)} label="העתק את כל הארכיון (JSON)" /></div>}
    </>;
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

/** Live timing from the track: bridge state + kart -> transponder map (needed when the bridge reads the decoder directly). */
function TimingSettings({ core, update, rx }: { core: L.Core; update: Update; rx?: RxState }) {
    const map = core.settings.transponders ?? {};
    const maxKart = Math.max(core.settings.capacity, ...Object.keys(map).map(Number).filter(n => n > 0), 0);
    const [extra, setExtra] = useState(0);
    const [assign, setAssign] = useState<Record<string, string>>({});
    const karts = Array.from({ length: Math.min(99, maxKart + extra) }, (_, i) => i + 1);
    const unmapped = R.unmappedTx(rx?.ext, map);
    return <Group label="שעון הקפות" heading>
        <p className={rx?.up && rx.connected ? 'tx-ok' : 'tx-bad'}>
            {!rx?.up ? '✗ תוכנת הגשר (dk-bridge) לא רצה במחשב הזה. הפעל אותה פעם אחת עם install.cmd (הוראות: docs/BRIDGE-HE.md).'
                : rx.connected ? `✓ מחובר ל${R.sourceName(rx.source)}. הזמנים מוצגים בלשונית חי, במסך המסלול ובאתר.`
                    : `✗ הגשר רץ אבל אין חיבור ל-RentiX או לדקודר${rx.error ? `: ${rx.error}` : ''}.`}
        </p>
        <p className="meta">הגשר קורא קודם את RentiX (בלי לשנות בו כלום). רק אם RentiX לא רץ, הוא קורא את הדקודר ישירות. בקריאה ישירה מהדקודר צריך לשייך כל טרנספונדר לקארט (למטה).</p>
        {unmapped.length > 0 && <div className="field"><span className="flabel">טרנספונדרים על המסלול בלי קארט</span>
            <ul className="tx-recent">{unmapped.map(tx => <li key={tx}><bdi dir="ltr">{tx}</bdi><span className="tx-bad">לא משויך</span>
                <span className="inline"><input className="inp" type="number" inputMode="numeric" min={1} max={99} placeholder="קארט" aria-label={`קארט לטרנספונדר ${tx}`} value={assign[tx] ?? ''} onChange={e => setAssign(a => ({ ...a, [tx]: e.target.value }))} />
                    <Btn small onClick={() => { const n = Number(assign[tx]); if (n >= 1) update(c => L.setTransponder(c, n, tx)); }}>שייך</Btn></span></li>)}</ul>
        </div>}
        <div className="field"><span className="flabel">קארט ← מספר טרנספונדר</span>
            <div className="tx-table">
                {karts.map(k => <label key={k} className="tx-cell"><span className="kart">{k}</span>
                    <input key={`${k}-${map[String(k)] ?? ''}`} className="inp" inputMode="numeric" placeholder="—" aria-label={`טרנספונדר של קארט ${k}`} defaultValue={map[String(k)] ?? ''} maxLength={12}
                        onBlur={e => { const v = e.target.value.trim(); if (v !== (map[String(k)] ?? '')) update(c => L.setTransponder(c, k, v)); }}
                        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} /></label>)}
            </div>
            <Btn small onClick={() => setExtra(x => x + 5)}>עוד קארטים</Btn>
            <p className="meta">המספר שמודפס על הטרנספונדר שמחובר לקארט. עם RentiX לא צריך: מספרי הקארטים מגיעים ממנו.</p>
        </div>
    </Group>;
}

function Settings({ core, update, hist, onReset, site, rx }: { core: L.Core; update: Update; hist: L.Result[]; onReset: () => void; site: React.ReactNode; rx?: RxState }) {
    const s = core.settings;
    const [t, setT] = useState('');
    const [confirm, setConfirm] = useState(false);
    const upd = (p: Partial<L.Settings>) => update(c => ({ ...c, settings: { ...c.settings, ...p } }));
    const overDraft = core.heats.filter(h => h.status === 'draft' && L.heatCount(h) > s.capacity).length;
    const overQueued = core.heats.filter(h => h.status === 'approved' && L.heatCount(h) > s.capacity).length;
    return <>
        {site}
        <TimingSettings core={core} update={update} rx={rx} />
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
                <span className="flabel">מחיר לכרטיס (₪): 10 דקות · 20 דקות</span>
                <p className="meta">לפי המחירון: רגיל וליגה 87 ל-10 דקות ו-100 ל-20 דקות. זוגי 100 (רכב דו-מושבי, מחיר אחד לשניים), מאסטר 100. ל-20 דקות של זוגי ומאסטר עוד אין מחיר.</p>
                <ul className="plain dlist">{s.tickets.map(x => <li key={x} className="trow"><span className="tname">{x}</span>
                    {(['prices', 'prices20'] as const).map(k => <input key={`${k}-${x}-${s[k]?.[x] ?? ''}`} className="inp price-inp" type="number" inputMode="numeric" min={0} step={1} dir="ltr" placeholder="לא הוגדר" defaultValue={s[k]?.[x] ?? ''} aria-label={`מחיר ${x}${k === 'prices20' ? ' 20 דקות' : ''}`}
                        onBlur={e => { const v = Math.max(0, Math.round(Number(e.target.value) || 0)); const next = { ...(s[k] ?? {}) }; if (v > 0) next[x] = v; else delete next[x]; upd({ [k]: next }); }} />)}</li>)}</ul>
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

const SYNC_SHORT: Record<SyncStatus, string> = { synced: '⇅ מסונכרן', saving: '⇅ שומר…', connecting: '⇅ מתחבר…', offline: '⚠ לא מחובר', local: 'מכשיר זה בלבד', 'no-table': '⚠ לא מחובר' };
const SYNC_TEXT: Record<SyncStatus, string> = {
    synced: 'מסונכרן: כל מחשבי הצוות רואים את אותם טפסים, קופה, תור, מקצים ומסלול.',
    saving: 'שומר את השינוי לכל מחשבי הצוות…',
    connecting: 'מתחבר למחשבי הצוות…',
    offline: 'אין חיבור לענן: אפשר להמשיך לעבוד, והשינויים יישלחו לשאר המחשבים כשהחיבור יחזור.',
    'no-table': 'אין חיבור לענן: אפשר להמשיך לעבוד, והשינויים יישלחו לשאר המחשבים כשהחיבור יחזור.',
    local: 'השינויים נשמרים במכשיר הזה בלבד (לא מחובר כצוות).',
};
const SYNC_ORDER: SyncStatus[] = ['offline', 'no-table', 'local', 'connecting', 'saving', 'synced'];
const worst = (a: SyncStatus, b: SyncStatus) => (SYNC_ORDER.indexOf(a) <= SYNC_ORDER.indexOf(b) ? a : b);

// ---------------------------------------------------------------------- app
export function App() {
    // Staff session first: while signed in, core and history are shared by every staff computer (see shared.ts).
    const [session, setSession] = useState<Session | null>(null);
    useEffect(() => Cloud.onSession(setSession), []);
    const online = !!session;
    const shCore = useShared<L.Core>('core', legacy<L.Core>('dankart.core.v1') ?? L.initialCore(), online, L.migrateTickets);
    const shHist = useShared<L.Result[]>('hist', legacy<L.Result[]>('dankart.hist.v1') ?? [], online);
    const core = shCore.value; const hist = shHist.value;
    const [tab, setTab] = useState<Tab>('cashier');
    const [screen, setScreen] = useState<'track' | 'last' | null>(null);
    const [auto, setAutoRaw] = useState(false);
    const [now, setNow] = useState(() => Date.now());
    const ready = true;

    // Public website: "broadcast" switch (per device). Publishes the board on every change.
    const [broadcast, setBroadcast] = useLocalState<boolean>('dankart.broadcast.v1', true);
    const [pubStatus, setPubStatus] = useState('');
    const rxRaw = useRentix();
    // direct decoder: kart numbers from the transponder map (Settings), before anything is shown or published
    const rx: RxState = rxRaw.ext ? { ...rxRaw, ext: R.withKarts(rxRaw.ext, core.settings.transponders) } : rxRaw;
    const extNow = R.extActive(rx.ext) ? rx.ext : null;
    const sending = ready && !!session && broadcast;
    const periodKey = L.periodStart(now, L.histResetOf(core));
    useEffect(() => {
        if (!sending) { setPubStatus(''); return; }
        const t = setTimeout(() => {
            void Cloud.publishBoard(Cloud.boardOf(core, Date.now(), L.currentPeriod(hist, Date.now(), L.histResetOf(core)), extNow)).then(e => setPubStatus(e ? `השידור נכשל: ${e}` : `✓ עודכן באתר ב-${new Date().toLocaleTimeString('he-IL')}`));
        }, 300);
        return () => clearTimeout(t);
    }, [sending, core, hist, periodKey, extNow && JSON.stringify(extNow.rows) + extNow.flag + extNow.run + Math.floor((extNow.timeToGo ?? 0) / 5000)]);
    // Every heat this device finished goes to the cloud archive as soon as staff is signed in (catches up after offline use).
    useEffect(() => { if (ready && session) void Cloud.archiveHeats(histRef.current); }, [ready, session]); // eslint-disable-line react-hooks/exhaustive-deps

    // Latest state for timers and chained edits: every change goes through update(fn) on the newest core.
    const coreRef = useRef(core); coreRef.current = core;
    const histRef = useRef(hist); histRef.current = hist;
    const readyRef = useRef(ready); readyRef.current = ready;
    const update: Update = fn => { coreRef.current = shCore.apply(fn); };
    // History edits are functions too, so two computers finishing heats never drop each other's results.
    const updHist = (fn: (h: L.Result[]) => L.Result[]) => { histRef.current = shHist.apply(fn); };

    // A run finished on the track timing (RentiX / decoder) goes to history once, like our own heats:
    // after the checkered flag, when the board has been unchanged for 45 s or the next run starts.
    const extRef = useRef(extNow); extRef.current = extNow;
    const pend = useRef<{ id: string; ext: R.ExtBoard; since: number } | null>(null);
    const latch = useRef(false);
    useEffect(() => {
        const commit = (p: { id: string; ext: R.ExtBoard }) => {
            pend.current = null; latch.current = true;
            if (histRef.current.some(r => r.heatId === p.id)) return;
            const res = R.extResult(p.ext, Date.now());
            updHist(h => L.trimHistory(L.mergeResults([res], h), L.SHARED_HISTORY_BYTES));
            void Cloud.archiveHeats([res]);
        };
        const i = setInterval(() => {
            const e = extRef.current;
            const p = pend.current;
            if (e && R.extDone(e)) {
                if (latch.current) return;
                const id = R.extRunId(e);
                if (!p || p.id !== id) pend.current = { id, ext: e, since: Date.now() };
                else if (Date.now() - p.since > 45_000) commit(p);
            } else {
                if (p) commit(p);
                latch.current = false;
            }
        }, 3000);
        return () => clearInterval(i);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const autoRef = useRef(auto); autoRef.current = auto;
    const start = (id: string) => update(c => L.startHeat(c, id, Date.now(), Date.now() % 100000, autoRef.current ? DEMO.speed : 5));
    const save = () => {
        const t = Date.now();
        const { result } = L.finishRun(coreRef.current, t);
        if (result) { updHist(h => L.trimHistory(L.mergeResults([result], h), L.SHARED_HISTORY_BYTES)); void Cloud.archiveHeats([result]); }
        update(c => (c.live && c.live.heatId === result?.heatId) || !result ? L.finishRun(c, t).core : c);
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

    const msg = '';
    const volatile = ready && /not saved|only while|memory/i.test(msg);
    const persistNote = !ready ? 'טוען…' : volatile
        ? 'בתצוגה הזו השינויים לא נשמרים: הם נשארים רק כל עוד הקובץ פתוח.'
        : /fail|error|unavailable|blocked|full/i.test(msg) ? `השמירה במכשיר לא הצליחה (${msg}).` : SYNC_TEXT[worst(shCore.status, shHist.status)];
    const syncSt = worst(shCore.status, shHist.status);
    const pending = core.groups.filter(g => L.unassignedOf(core, g) > 0).length;
    const counts: Partial<Record<Tab, number>> = { cashier: pending + L.pendingOf(core).length, heats: core.heats.filter(h => h.status === 'draft' && h.entries.length > 0).length, live: L.queueOf(core).length };
    const lastRes = hist[0];
    const goHeats = () => setTab('heats');

    return <FileCard lang="he">
        <div className="dk">
            <div className="brandbar"><Logo /><span className="brand-tag">דמו · נתוני דמה</span><span className={`brand-tag sync-tag ${syncSt}`} title={SYNC_TEXT[syncSt]}>{SYNC_SHORT[syncSt]}</span>{sending && <span className="brand-tag onair-tag">● משדר לאתר</span>}{rx.up && <span className={`brand-tag rx-tag${rx.connected ? '' : ' bad'}`} title={rx.error}>{rx.connected ? (extNow ? `● ${R.sourceName(rx.source)} · ${extNow.run || 'מקצה'}` : `● ${R.sourceName(rx.source)} מחובר`) : '⚠ אין חיבור ל-RentiX או לדקודר'}</span>}{core.live && <button type="button" className="onair" onClick={() => setTab('live')}>● מקצה {L.runningHeat(core)?.num} על המסלול</button>}</div>
            <Header title="מקצים ותור" fact="גרסת דמו · נתוני דמה" intro="קופה, שיבוץ מקצים, תור פשוט, קריאה למסלול וזמנים מדומים. אפשר לשדר את לוח הזמנים לאתר ציבורי (הגדרות). אין חיבור לשעון של העסק." />
            <nav className="tabs" aria-label="מסכים">
                {TABS.map(t => <button key={t.id} type="button" className={tab === t.id ? 'on' : ''} aria-current={tab === t.id ? 'page' : undefined} onClick={() => setTab(t.id)}>{t.label}{t.id === 'live' && core.live ? <i className="live-dot" aria-label="מקצה על המסלול">●</i> : counts[t.id] ? <i>{counts[t.id]}</i> : null}</button>)}
            </nav>
            {!ready && <p className="empty">טוען נתונים שמורים…</p>}
            {ready && tab === 'form' && <CustomerForm core={core} update={update} />}
            {ready && tab === 'cashier' && <Cashier core={core} update={update} goHeats={goHeats} />}
            {ready && tab === 'heats' && <Heats core={core} update={update} />}
            {ready && tab === 'live' && <Live rx={rx} core={core} update={update} now={now} hist={hist} auto={auto} setAuto={setAuto} openScreen={setScreen} save={save} start={start} cancel={cancel} goHeats={goHeats} />}
            {ready && tab === 'history' && <HistoryTab core={core} update={update} hist={hist} now={now} />}
            {ready && tab === 'settings' && <Settings rx={rx} site={<PublicSite session={session} on={broadcast} setOn={setBroadcast} status={pubStatus} />} core={core} update={update} hist={hist} onReset={() => { setAuto(false); setScreen(null); update(() => L.initialCore()); updHist(() => []); }} />}
            <Closing>{persistNote} לא נשלח ולא שולם דבר.</Closing>
            {ready && screen === 'track' && <TrackScreen core={core} now={now} onClose={() => setScreen(null)} ext={extNow} />}
            {ready && screen === 'last' && lastRes && <WallDisplay title={`תוצאות · ${L.resultTitle(lastRes)}`} sub={`${dayOf(lastRes.at)} ${timeOf(lastRes.at)}`} totalLaps={lastRes.laps} state="done" rows={resultRowsOf(lastRes)} onClose={() => setScreen(null)} />}
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
    const [tab, setTab] = useState<PubTab>('live');
    useEffect(() => {
        const take = (p: Cloud.BoardPayload) => setBoard(p);
        void Cloud.fetchBoard().then(p => { if (p) take(p); setLoaded(true); });
        return Cloud.subscribeBoard(take, setConn);
    }, []);
    useEffect(() => { const i = setInterval(() => setNow(Date.now()), 200); return () => clearInterval(i); }, []);
    // The board carries the race start time, so each viewer runs the race clock locally (phone clocks are network-synced).
    const clock = now;
    if (!loaded) return <div className="dk pub-wait"><Logo big /><p>טוען…</p></div>;
    if (!board) return <div className="dk pub-wait"><Logo big /><p>הלוח עוד לא פעיל. כשהקופה תתחיל לשדר, המקצים והזמנים יופיעו כאן.</p><StaffShield /></div>;
    const hist = board.hist ?? [];
    const nav = <nav className="pub-tabs" aria-label="לשוניות">
        {PUB_TABS.map(([id, label]) => <button key={id} type="button" className={tab === id ? 'on' : ''} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>{label}{id === 'results' && hist.length ? <i>{hist.length}</i> : null}</button>)}
    </nav>;
    if (tab !== 'live') return <div className="dk pub-hist">
        <div className="pub-hist-top"><Logo /><span className={`pub-conn static ${conn === 'SUBSCRIBED' ? 'ok' : ''}`}>{conn === 'SUBSCRIBED' ? '● שידור חי' : 'מתחבר…'}</span></div>
        {tab === 'next' && <NextHeats core={board.core} />}
        {tab === 'results' && <History hist={hist} pub />}
        {tab === 'karts' && <KartInfo hist={hist} />}
        {nav}
        <StaffShield />
    </div>;
    return <div className="dk pub">
        <TrackScreen core={board.core} now={clock} onClose={() => {}} ext={board.ext && now - board.sentAt < 60_000 ? board.ext : null} />
        <StaffShield />
        {nav}
        <div className={`pub-conn ${conn === 'SUBSCRIBED' ? 'ok' : ''}`}>{conn === 'SUBSCRIBED' ? '● שידור חי' : 'מתחבר…'}</div>
    </div>;
}

/** Public site tabs, the same sections as on the RentiX screen: live results, preparation, race results, kart info. */
type PubTab = 'live' | 'next' | 'results' | 'karts';
const PUB_TABS: [PubTab, string][] = [['live', 'לוח חי'], ['next', 'הבא בתור'], ['results', 'תוצאות'], ['karts', 'קארטים']];

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
/** The staff area (?staff) opens only after a staff sign-in. Accounts are created by the owner in Supabase. */
/** User name + password form for staff. onDone runs after a successful sign-in. */
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
