// Customer check-in from their own phone (QR at the counter -> ?join).
// Step 1 ID number (ת"ז), step 2 who is coming (saved names for a returning customer, or new names), step 3 "go to the cashier".
// The ID number itself is never stored: the database keeps only a salted fingerprint of it (see docs/checkin-id.sql).
import React, { useEffect, useRef, useState } from 'react';
import qrcode from 'qrcode-generator';
import * as Cloud from './cloud';
import * as L from './logic';

// The customer's own check-in on this phone, kept for the day: reopening ?join shows the personal area.
const ME_KEY = 'dankart.join.me.v1';
type Me = { cid: number; name: string; until: number };
function readMe(): Me | null { try { const m = JSON.parse(localStorage.getItem(ME_KEY) || 'null') as Me | null; return m && m.until > Date.now() ? m : null; } catch { return null; } }
function saveMe(m: Me | null) { try { if (m) localStorage.setItem(ME_KEY, JSON.stringify(m)); else localStorage.removeItem(ME_KEY); } catch { /* memory only */ } }

const LOGO_SRC = 'dan-karting-logo.jpg';
function JoinLogo() {
    const [ok, setOk] = useState(true);
    return ok ? <img className="join-logo" src={LOGO_SRC} alt="Dan Karting" onError={() => setOk(false)} /> : <div className="join-word">DAN KARTING</div>;
}

type Step = 'id' | 'who' | 'me';

export function JoinPage() {
    const [me, setMe] = useState<Me | null>(() => readMe());
    const [step, setStep] = useState<Step>(() => (readMe() ? 'me' : 'id'));
    const [tz, setTz] = useState('');
    const [saved, setSaved] = useState<string[]>([]);
    const [pick, setPick] = useState<boolean[]>([]);
    const [fresh, setFresh] = useState<string[]>(['']);
    const [minutes, setMinutes] = useState(10);
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState('');
    const [sent, setSent] = useState<string[]>([]);
    const idRef = useRef<HTMLInputElement>(null);
    useEffect(() => { idRef.current?.focus(); }, []);

    const reset = () => { setStep('id'); setTz(''); setSaved([]); setPick([]); setFresh(['']); setMinutes(10); setErr(''); setSent([]); };

    const next = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!Cloud.validTz(tz)) { setErr('מספר תעודת הזהות לא תקין. בדקו את כל 9 הספרות.'); return; }
        setBusy(true); setErr('');
        const names = await Cloud.checkinLookupId(tz);
        setBusy(false);
        if (names === null) { setErr('אין חיבור כרגע. נסו שוב או פנו לקופה.'); return; }
        setSaved(names.slice(0, 1)); setPick(names.length ? [true] : []); setFresh(names.length ? [] : ['']); setStep('who');
    };
    const typed = fresh.map(f => f.trim()).filter(Boolean);
    const coming = [...saved.filter((_, i) => pick[i]), ...typed];
    const submit = async () => {
        if (coming.length === 0) { setErr(saved.length ? 'סמנו מי מגיע או הוסיפו שם' : 'כתבו את השם שלכם'); return; }
        setBusy(true); setErr('');
        const m = await Cloud.checkinSubmitId(tz, pick.map((p, i) => (p ? i + 1 : 0)).filter(Boolean), typed, minutes);
        setBusy(false);
        if (typeof m === 'string') { setErr(m); return; }
        const mine = { cid: m.id, name: coming[0], until: Date.now() + 12 * 3600_000 };
        saveMe(mine); setMe(mine); setSent(coming); setStep('me');
    };

    return <div className="dk join" dir="rtl">
        <JoinLogo />
        {step === 'id' && <form className="join-card" onSubmit={next}>
            <h1>הרשמה למקצה</h1>
            <p className="join-sub">הקלידו מספר תעודת זהות. לקוחות חוזרים מזוהים לבד.</p>
            <label className="field"><span className="flabel">תעודת זהות</span>
                <input ref={idRef} className="inp join-phone" type="text" inputMode="numeric" autoComplete="off" dir="ltr" placeholder="ת״ז" maxLength={9}
                    value={tz} onChange={e => { setErr(''); setTz(e.target.value.replace(/\D/g, '').slice(0, 9)); }} />
            </label>
            {err && <p className="err" role="alert">{err}</p>}
            <button type="submit" className="kb primary join-go" disabled={busy}>{busy ? 'בודק…' : 'המשך'}</button>
            <p className="join-small">מספר הזהות לא נשמר אצלנו, רק משמש לזהות אתכם בפעם הבאה.</p>
        </form>}

        {step === 'who' && <div className="join-card">
            <h1>{saved.length ? `שלום ${saved[0].split(' ')[0]}! 👋` : 'ברוכים הבאים!'}</h1>
            {saved.length > 0
                ? <p className="join-names">{saved[0]}</p>
                : <>
                    <p className="join-sub">כתבו את השם שלכם. בפעם הבאה נזהה אתכם לפי תעודת הזהות.</p>
                    <input className="inp join-name" value={fresh[0] ?? ''} maxLength={24} placeholder="שם מלא" aria-label="שם מלא" autoFocus
                        onChange={e => { setErr(''); setFresh([e.target.value]); }} />
                </>}
            {err && <p className="err" role="alert">{err}</p>}
            <button type="button" className="kb primary join-go" disabled={busy} onClick={() => void submit()}>{busy ? 'שולח…' : 'שליחה'}</button>
            <button type="button" className="kb ghost sm" onClick={reset}>{saved.length ? 'זה לא אני' : 'חזרה'}</button>
        </div>}

        {step === 'me' && me && <MyArea me={me} fresh={sent.length > 0} onLeave={() => { saveMe(null); setMe(null); reset(); }} />}
    </div>;
}

const fmtLap = (ms: number | null) => (ms == null ? '—' : L.fmt(ms));

/** Personal area: where I stand now (follows the public board live), then a way to the customers' area. */
function MyArea({ me, fresh, onLeave }: { me: Me; fresh: boolean; onLeave: () => void }) {
    const [board, setBoard] = useState<Cloud.BoardPayload | null>(null);
    useEffect(() => { void Cloud.fetchBoard().then(p => { if (p) setBoard(p); }); return Cloud.subscribeBoard(setBoard); }, []);
    const st = board ? L.myStatus(board.core, board.hist ?? [], me.cid) : null;
    const first = me.name.split(' ')[0];
    const view: Record<L.MyStatus['kind'], { icon: string; title: string; sub: string; tone: string }> = {
        pending: { icon: '💳', title: 'ממתינים לתשלום', sub: 'גשו לקופה. אחרי התשלום תיכנסו לתור למקצה.', tone: 'wait' },
        cancelled: { icon: '✕', title: 'ההרשמה בוטלה', sub: 'אם זו טעות, פנו לקופה.', tone: 'bad' },
        waiting: { icon: '✓', title: 'שולם!', sub: 'אנחנו משבצים אתכם למקצה. מספר המקצה יופיע כאן.', tone: 'ok' },
        queued: { icon: '⏳', title: st?.heatNum ? `מקצה ${st.heatNum}` : 'בתור', sub: st?.ahead ? `לפניכם ${st.ahead === 1 ? 'מקצה אחד' : `${st.ahead} מקצים`}. תישארו קרוב.` : 'אתם הבאים בתור! תתכוננו.', tone: 'ok' },
        called: { icon: '📣', title: `מקצה ${st?.heatNum ?? ''}: גשו למסלול!`, sub: 'קוראים לכם עכשיו. גשו לנקודת העלייה.', tone: 'call' },
        racing: { icon: '🏁', title: 'אתם על המסלול!', sub: 'הזמנים מופיעים בלוח החי.', tone: 'call' },
        done: { icon: '🏆', title: 'סיימתם!', sub: 'התוצאות שלכם:', tone: 'ok' },
    };
    const v = st ? view[st.kind] : null;
    return <>
        {fresh && <div className="join-toast">✓ נרשמתם! גשו לקופה לתשלום.</div>}
        <div className="join-card">
            <h1>האזור שלי</h1>
            <p className="join-names">{me.name}</p>
            {!v ? <p className="join-sub">טוען…</p> : <div className={`my-status ${v.tone}`}>
                <div className="my-icon" aria-hidden="true">{v.icon}</div>
                <div><div className="my-title">{v.title}</div><div className="my-sub">{v.sub}</div></div>
            </div>}
            {st && st.kart != null && st.kind !== 'pending' && st.kind !== 'waiting' && <div className="my-facts">
                {st.heatNum != null && <div><span>מקצה</span><b>{st.heatNum}</b></div>}
                {st.kind !== 'queued' && <div><span>קארט</span><b>{st.kart}</b></div>}
                {st.result && <><div><span>מקום</span><b>{st.result.pos}/{st.result.of}</b></div><div><span>הקפה מהירה</span><b dir="ltr">{fmtLap(st.result.best)}</b></div></>}
            </div>}
            <a className="kb primary join-go join-a" href="./">לאזור הלקוחות: לוח חי ותוצאות</a>
            <button type="button" className="join-link" onClick={onLeave}>{first ? `לא ${first}? ` : ''}הרשמה חדשה</button>
        </div>
    </>;
}

/** The check-in address (same site, ?join). */
export const joinUrl = () => `${location.origin}${location.pathname}?join`;

/** QR code as an SVG for the counter sign. */
export function JoinQr({ size = 220 }: { size?: number }) {
    const q = qrcode(0, 'M'); q.addData(joinUrl()); q.make();
    const n = q.getModuleCount(); const cell = 1; const pad = 2; const dim = n + pad * 2;
    const path: string[] = [];
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) path.push(`M${c + pad} ${r + pad}h${cell}v${cell}h-${cell}z`);
    return <svg className="join-qr" width={size} height={size} viewBox={`0 0 ${dim} ${dim}`} role="img" aria-label="QR להרשמה" shapeRendering="crispEdges">
        <rect width={dim} height={dim} fill="#fff" /><path d={path.join('')} fill="#000" />
    </svg>;
}

/** Printable counter sign: open in a new window and print. */
export function printJoinSign() {
    const w = window.open('', '_blank'); if (!w) return;
    const q = qrcode(0, 'M'); q.addData(joinUrl()); q.make();
    w.document.write(`<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8"><title>הרשמה למקצה</title>
<style>body{font-family:system-ui,Arial,sans-serif;text-align:center;margin:40px;color:#111}h1{font-size:54px;margin:0 0 8px}p{font-size:26px;margin:8px 0}.qr img{width:420px;height:420px;image-rendering:pixelated}.u{font-size:16px;color:#555;direction:ltr}</style></head>
<body><h1>נרשמים כאן 🏁</h1><p>סרקו עם המצלמה, הקלידו טלפון, וגשו לקופה</p><div class="qr">${q.createImgTag(10, 20)}</div><p class="u">${joinUrl()}</p>
<script>setTimeout(function(){window.print()},400)</script></body></html>`);
    w.document.close();
}
