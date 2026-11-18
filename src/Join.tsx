// Customer check-in from their own phone (QR at the counter -> ?join).
// Sign in with Google, tick who is coming (saved names come back next time), send -> "go to the cashier".
// The page reads nothing but the signed-in customer's own saved names (see docs/checkin.sql).
import React, { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import qrcode from 'qrcode-generator';
import * as Cloud from './cloud';

const LOGO_SRC = 'dan-karting-logo.jpg';
function JoinLogo() {
    const [ok, setOk] = useState(true);
    return ok ? <img className="join-logo" src={LOGO_SRC} alt="Dan Karting" onError={() => setOk(false)} /> : <div className="join-word">DAN KARTING</div>;
}
function GoogleG() {
    return <svg viewBox="0 0 48 48" width="24" height="24" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" /><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" /><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2c-2 1.5-4.5 2.4-7.2 2.4-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" /><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" /></svg>;
}

type Step = 'who' | 'done';

export function JoinPage() {
    const [session, setSession] = useState<Session | null | undefined>(undefined);
    const [step, setStep] = useState<Step>('who');
    const [saved, setSaved] = useState<string[] | null>(null);
    const [pick, setPick] = useState<boolean[]>([]);
    const [fresh, setFresh] = useState<string[]>([]);
    const [minutes, setMinutes] = useState(10);
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState('');
    const [sent, setSent] = useState<string[]>([]);
    const me = Cloud.customerOf(session ?? null);

    useEffect(() => Cloud.onCustomer(s => {
        setSession(s);
        // back from Google: tidy the address so a reload or a shared link is clean
        if (s && /[?&](code|error)=/.test(location.search + location.hash)) history.replaceState(null, '', `${location.pathname}?join`);
    }), []);
    const uid = session?.user.id;
    const load = async () => {
        setErr(''); setSaved(null);
        const names = await Cloud.checkinMe();
        if (names === null) { setErr('אין חיבור כרגע. נסו שוב או פנו לקופה.'); setSaved([]); setFresh([me?.name ?? '']); return; }
        setSaved(names); setPick(names.map((_, i) => i === 0)); setFresh(names.length ? [] : [me?.name ?? '']);
    };
    useEffect(() => { if (uid) void load(); }, [uid]); // eslint-disable-line react-hooks/exhaustive-deps

    const google = async () => { setBusy(true); setErr(''); const m = await Cloud.customerGoogle(joinUrl()); if (m) { setBusy(false); setErr('הכניסה עם גוגל לא הצליחה. נסו שוב או פנו לקופה.'); } };
    const signOut = async () => { await Cloud.customerSignOut(); setStep('who'); setSaved(null); setSent([]); };
    const list = saved ?? [];
    const typed = fresh.map(f => f.trim()).filter(Boolean);
    const coming = [...list.filter((_, i) => pick[i]), ...typed];
    const submit = async () => {
        if (coming.length === 0) { setErr(list.length ? 'סמנו מי מגיע או הוסיפו שם' : 'כתבו את השם שלכם'); return; }
        setBusy(true); setErr('');
        const m = await Cloud.checkinSubmit(pick.map((p, i) => (p ? i + 1 : 0)).filter(Boolean), typed, minutes);
        setBusy(false);
        if (m) { setErr(m); return; }
        setSent(coming); setStep('done');
    };
    const again = () => { setStep('who'); setSent([]); setMinutes(10); void load(); };
    const first = (me?.name || list[0] || '').split(' ')[0];

    if (session === undefined) return <div className="dk join"><JoinLogo /><p className="join-sub">טוען…</p></div>;
    return <div className="dk join" dir="rtl">
        <JoinLogo />
        {!session && <div className="join-card">
            <h1>הרשמה למקצה</h1>
            <p className="join-sub">מתחברים עם גוגל, מסמנים מי מגיע וניגשים לקופה. בפעם הבאה השמות כבר יחכו לכם.</p>
            <button type="button" className="kb join-go join-google" disabled={busy} onClick={() => void google()}><GoogleG />{busy ? 'פותח את גוגל…' : 'המשך עם Google'}</button>
            {err && <p className="err" role="alert">{err}</p>}
            <p className="join-small">אין חשבון גוגל? גשו לקופה ונרשום אתכם שם.</p>
        </div>}

        {session && step === 'who' && <div className="join-card">
            <div className="join-me">{me?.avatar ? <img src={me.avatar} alt="" referrerPolicy="no-referrer" /> : null}<span dir="ltr">{me?.email}</span><button type="button" className="join-link" onClick={() => void signOut()}>לא אתם?</button></div>
            <h1>{list.length ? `שלום ${first}! 👋` : first ? `ברוכים הבאים, ${first}!` : 'ברוכים הבאים!'}</h1>
            {saved === null ? <p className="join-sub">טוען…</p> : <>
                <p className="join-sub">{list.length ? 'סמנו מי מגיע היום. אפשר להוסיף חברים.' : 'בדקו שהשם נכון והוסיפו את מי שבא איתכם.'}</p>
                {list.length > 0 && <ul className="join-list">
                    {list.map((n, i) => <li key={i}>
                        <button type="button" className={`join-pick${pick[i] ? ' on' : ''}`} aria-pressed={!!pick[i]} onClick={() => { setErr(''); setPick(pick.map((p, j) => (j === i ? !p : p))); }}>
                            <span className="join-box" aria-hidden="true">{pick[i] ? '✓' : ''}</span>{n}
                        </button>
                    </li>)}
                </ul>}
                {fresh.map((f, i) => <div key={i} className="join-row">
                    <input className="inp" value={f} maxLength={24} placeholder={i === 0 && !list.length ? 'שם מלא' : 'שם של חבר/ה'} aria-label={`שם ${i + 1}`}
                        autoFocus={i === fresh.length - 1 && i > 0}
                        onChange={e => { setErr(''); setFresh(fresh.map((x, j) => (j === i ? e.target.value : x))); }} />
                    {(i > 0 || list.length > 0) && <button type="button" className="kb ghost sm" aria-label="הסר" onClick={() => setFresh(fresh.filter((_, j) => j !== i))}>✕</button>}
                </div>)}
                {fresh.length + list.length < 20 && <button type="button" className="kb join-add" onClick={() => setFresh([...fresh, ''])}>+ הוסף חבר/ה</button>}
                <div className="field"><span className="flabel">אורך המקצה</span>
                    <div className="chips" role="radiogroup" aria-label="אורך המקצה">
                        {[10, 20].map(m => <button key={m} type="button" role="radio" aria-checked={minutes === m} className={`chip${minutes === m ? ' sel' : ''}`} onClick={() => setMinutes(m)}>{m} דקות</button>)}
                    </div>
                </div>
                {err && <p className="err" role="alert">{err}</p>}
                <button type="button" className="kb primary join-go" disabled={busy} onClick={() => void submit()}>{busy ? 'שולח…' : coming.length > 1 ? `שליחה (${coming.length} משתתפים)` : 'שליחה'}</button>
            </>}
        </div>}

        {session && step === 'done' && <div className="join-card join-done">
            <div className="join-check" aria-hidden="true">✓</div>
            <h1>נרשמתם!</h1>
            <p className="join-names">{sent.join(' · ')}</p>
            <p className="join-sub">גשו לקופה לתשלום. אחרי התשלום תיכנסו לתור, והשם שלכם יופיע במסך כשתקראו למסלול.</p>
            <button type="button" className="kb join-go" onClick={again}>הרשמה נוספת</button>
            <button type="button" className="join-link" onClick={() => void signOut()}>התנתקות</button>
        </div>}
    </div>;
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
