// Customer check-in from their own phone (QR at the counter -> ?join).
// Step 1 phone, step 2 who is coming (saved names for a returning customer, or new names), step 3 "go to the cashier".
// The page reads nothing but the short saved names for the phone typed (see docs/checkin.sql).
import React, { useEffect, useRef, useState } from 'react';
import qrcode from 'qrcode-generator';
import * as Cloud from './cloud';

const LOGO_SRC = 'dan-karting-logo.jpg';
function JoinLogo() {
    const [ok, setOk] = useState(true);
    return ok ? <img className="join-logo" src={LOGO_SRC} alt="Dan Karting" onError={() => setOk(false)} /> : <div className="join-word">DAN KARTING</div>;
}

type Step = 'phone' | 'who' | 'done';

export function JoinPage() {
    const [step, setStep] = useState<Step>('phone');
    const [phone, setPhone] = useState('');
    const [saved, setSaved] = useState<string[]>([]);
    const [pick, setPick] = useState<boolean[]>([]);
    const [fresh, setFresh] = useState<string[]>(['']);
    const [minutes, setMinutes] = useState(10);
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState('');
    const [sent, setSent] = useState<string[]>([]);
    const phoneRef = useRef<HTMLInputElement>(null);
    useEffect(() => { phoneRef.current?.focus(); }, []);

    const reset = () => { setStep('phone'); setPhone(''); setSaved([]); setPick([]); setFresh(['']); setMinutes(10); setErr(''); setSent([]); };
    // After "done", go back to the start by itself so the next customer at a shared tablet starts clean.
    useEffect(() => { if (step !== 'done') return; const t = setTimeout(reset, 45_000); return () => clearTimeout(t); }, [step]);

    const next = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!Cloud.validPhone(phone)) { setErr('מספר הטלפון לא תקין. למשל 0521234567'); return; }
        setBusy(true); setErr('');
        const names = await Cloud.checkinLookup(phone);
        setBusy(false);
        if (names === null) { setErr('אין חיבור כרגע. נסו שוב או פנו לקופה.'); return; }
        setSaved(names); setPick(names.map((_, i) => i === 0)); setFresh(names.length ? [] : ['']); setStep('who');
    };
    const typed = fresh.map(f => f.trim()).filter(Boolean);
    const coming = [...saved.filter((_, i) => pick[i]), ...typed];
    const submit = async () => {
        if (coming.length === 0) { setErr(saved.length ? 'סמנו מי מגיע או הוסיפו שם' : 'כתבו את השם שלכם'); return; }
        setBusy(true); setErr('');
        const m = await Cloud.checkinSubmit(phone, pick.map((p, i) => (p ? i + 1 : 0)).filter(Boolean), typed, minutes);
        setBusy(false);
        if (m) { setErr(m); return; }
        setSent(coming); setStep('done');
    };

    return <div className="dk join" dir="rtl">
        <JoinLogo />
        {step === 'phone' && <form className="join-card" onSubmit={next}>
            <h1>הרשמה למקצה</h1>
            <p className="join-sub">הקלידו מספר טלפון. לקוחות חוזרים מזוהים לבד.</p>
            <label className="field"><span className="flabel">טלפון נייד</span>
                <input ref={phoneRef} className="inp join-phone" type="tel" inputMode="numeric" autoComplete="tel" dir="ltr" placeholder="05X-XXXXXXX" maxLength={14}
                    value={phone} onChange={e => { setErr(''); setPhone(e.target.value.replace(/[^\d-]/g, '')); }} />
            </label>
            {err && <p className="err" role="alert">{err}</p>}
            <button type="submit" className="kb primary join-go" disabled={busy}>{busy ? 'בודק…' : 'המשך'}</button>
        </form>}

        {step === 'who' && <div className="join-card">
            <h1>{saved.length ? `שלום ${saved[0].split(' ')[0]}! 👋` : 'ברוכים הבאים!'}</h1>
            <p className="join-sub">{saved.length ? 'סמנו מי מגיע היום. אפשר להוסיף חברים.' : 'כתבו את השם שלכם. בפעם הבאה נזהה אתכם לפי הטלפון.'}</p>
            {saved.length > 0 && <ul className="join-list">
                {saved.map((n, i) => <li key={i}>
                    <button type="button" className={`join-pick${pick[i] ? ' on' : ''}`} aria-pressed={!!pick[i]} onClick={() => { setErr(''); setPick(pick.map((p, j) => (j === i ? !p : p))); }}>
                        <span className="join-box" aria-hidden="true">{pick[i] ? '✓' : ''}</span>{n}
                    </button>
                </li>)}
            </ul>}
            {fresh.map((f, i) => <div key={i} className="join-row">
                <input className="inp" value={f} maxLength={24} placeholder={i === 0 && !saved.length ? 'שם מלא' : 'שם של חבר/ה'} aria-label={`שם ${i + 1}`}
                    autoFocus={i === fresh.length - 1 && (i > 0 || !saved.length)}
                    onChange={e => { setErr(''); setFresh(fresh.map((x, j) => (j === i ? e.target.value : x))); }} />
                {(i > 0 || saved.length > 0) && <button type="button" className="kb ghost sm" aria-label="הסר" onClick={() => setFresh(fresh.filter((_, j) => j !== i))}>✕</button>}
            </div>)}
            {fresh.length + saved.length < 20 && <button type="button" className="kb join-add" onClick={() => setFresh([...fresh, ''])}>+ הוסף חבר/ה</button>}
            <div className="field"><span className="flabel">אורך המקצה</span>
                <div className="chips" role="radiogroup" aria-label="אורך המקצה">
                    {[10, 20].map(m => <button key={m} type="button" role="radio" aria-checked={minutes === m} className={`chip${minutes === m ? ' sel' : ''}`} onClick={() => setMinutes(m)}>{m} דקות</button>)}
                </div>
            </div>
            {err && <p className="err" role="alert">{err}</p>}
            <button type="button" className="kb primary join-go" disabled={busy} onClick={() => void submit()}>{busy ? 'שולח…' : coming.length > 1 ? `שליחה (${coming.length} משתתפים)` : 'שליחה'}</button>
            <button type="button" className="kb ghost sm" onClick={reset}>חזרה</button>
        </div>}

        {step === 'done' && <div className="join-card join-done">
            <div className="join-check" aria-hidden="true">✓</div>
            <h1>נרשמתם!</h1>
            <p className="join-names">{sent.join(' · ')}</p>
            <p className="join-sub">גשו לקופה לתשלום. אחרי התשלום תיכנסו לתור, והשם שלכם יופיע במסך כשתקראו למסלול.</p>
            <button type="button" className="kb join-go" onClick={reset}>הרשמה נוספת</button>
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
