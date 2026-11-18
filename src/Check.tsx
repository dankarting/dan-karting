// Security self-check (?check): acts as a stranger on the internet (no sign-in) and tries everything a stranger must NOT
// be able to do, plus the few things the public site needs. Every line should end green. Nothing here changes real data:
// writes that are refused change nothing, and the one write that is allowed is not attempted.
import React, { useEffect, useState } from 'react';
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_KEY, SUPABASE_URL } from './cloud';

type Row = { name: string; ok: boolean | null; detail: string };
type Probe = { name: string; run: () => Promise<{ ok: boolean; detail: string }> };

export function CheckPage() {
    const [rows, setRows] = useState<Row[]>([]);
    const [done, setDone] = useState(false);
    useEffect(() => {
        const anon = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false, storageKey: 'dankart.check' } });
        // A table a stranger must not read: refused, or zero rows back.
        const noRead = (t: string): Probe => ({ name: `זר לא קורא את ${t}`, run: async () => {
            const { data, error } = await anon.from(t).select('*').limit(1);
            if (error) return { ok: true, detail: 'נחסם' };
            return { ok: !data || data.length === 0, detail: data && data.length ? `ראה ${data.length} שורות!` : 'אין גישה (0 שורות)' };
        } });
        // A function a stranger must not run.
        const noCall = (fn: string, args: Record<string, unknown> = {}): Probe => ({ name: `זר לא מפעיל את ${fn}`, run: async () => {
            const { error } = await anon.rpc(fn, args);
            return error ? { ok: true, detail: 'נחסם' } : { ok: false, detail: 'הצליח!' };
        } });
        const probes: Probe[] = [
            { name: 'הלוח הציבורי נקרא (צריך לעבוד)', run: async () => {
                const { data, error } = await anon.from('live_board').select('id').limit(1);
                return { ok: !error && !!data, detail: error ? error.message : 'עובד' };
            } },
            { name: 'זר לא משנה את הלוח הציבורי', run: async () => {
                const { data, error } = await anon.from('live_board').update({ updated_at: new Date().toISOString() }).eq('id', 'main').select('id');
                return { ok: !!error || !data || data.length === 0, detail: error ? 'נחסם' : data && data.length ? 'שינה!' : 'לא שינה (0 שורות)' };
            } },
            { name: 'זר לא מוסיף תוצאה מזויפת', run: async () => {
                const { error } = await anon.from('heat_history').insert({ id: `check-${Date.now()}`, at: new Date().toISOString(), data: {} });
                return error ? { ok: true, detail: 'נחסם' } : { ok: false, detail: 'נוסף!' };
            } },
            { name: 'זר לא משנה את נתוני הקופה', run: async () => {
                const { data, error } = await anon.from('staff_state').update({ rev: 0 }).eq('id', 'none').select('id');
                return { ok: !!error || !data || data.length === 0, detail: error ? 'נחסם' : 'לא שינה (0 שורות)' };
            } },
            noRead('staff_state'), noRead('checkins'), noRead('id_customers'), noRead('staff_users'),
            noRead('checkin_secret'), noRead('checkin_rate'), noRead('checkin_sms'), noRead('checkin_codes'), noRead('drivers'), noRead('rides'),
            noCall('checkin_claim'), noCall('tz_hash', { t: '123456782' }), noCall('checkin_throttle', { p_kind: 'x', p_max: 1, p_window: '1 minute' }),
            noCall('checkin_lookup', { p_phone: '0500000000' }), noCall('checkin_submit', { p_phone: '0500000000', p_pick: [], p_new: ['x'], p_minutes: 10 }),
            noCall('checkin_send_code', { p_phone: '0500000000' }),
            { name: 'ת"ז לא תקינה נדחית', run: async () => {
                const { error } = await anon.rpc('checkin_lookup_id', { p_tz: '123456789' });
                return error ? { ok: true, detail: 'נדחה' } : { ok: false, detail: 'התקבל!' };
            } },
            { name: 'זר לא מוסיף נסיעה מזויפת', run: async () => {
                const { error } = await anon.from('rides').insert({ id: `check-${Date.now()}`, id_hash: 'x', at: new Date().toISOString() });
                return error ? { ok: true, detail: 'נחסם' } : { ok: false, detail: 'נוסף!' };
            } },
            { name: 'היסטוריה עם ת"ז לא תקינה נדחית', run: async () => {
                const { error } = await anon.rpc('my_rides', { p_tz: '123456789' });
                return error ? { ok: true, detail: error.message.includes('my_rides') ? 'my_rides חסר: צריך להריץ את rides.sql' : 'נדחה' } : { ok: false, detail: 'התקבל!' };
            } },
            { name: 'זר אינו צוות', run: async () => {
                const { data, error } = await anon.rpc('is_staff');
                if (error) return { ok: false, detail: 'is_staff חסר: צריך להריץ את security.sql' };
                return { ok: data === false, detail: data === false ? 'לא צוות' : 'צוות?!' };
            } },
        ];
        setRows(probes.map(p => ({ name: p.name, ok: null, detail: '…' })));
        void (async () => {
            for (let i = 0; i < probes.length; i++) {
                let r: { ok: boolean; detail: string };
                try { r = await probes[i].run(); } catch (e) { r = { ok: false, detail: `שגיאה: ${(e as Error).message}` }; }
                setRows(prev => prev.map((x, j) => (j === i ? { name: x.name, ...r } : x)));
            }
            setDone(true);
        })();
    }, []);
    const bad = rows.filter(r => r.ok === false).length;
    return <div className="dk join" dir="rtl">
        <div className="join-card check-card">
            <h1>בדיקת אבטחה</h1>
            <p className="join-sub">הדף מתנהג כמו אדם זר מהאינטרנט (בלי כניסה) ומנסה לגשת למה שאסור לו.</p>
            <ul className="check-list">
                {rows.map((r, i) => <li key={i} className={r.ok === null ? 'run' : r.ok ? 'ok' : 'bad'}>
                    <span className="check-mark" aria-hidden="true">{r.ok === null ? '…' : r.ok ? '✓' : '✕'}</span>
                    <span className="check-name">{r.name}</span><span className="check-detail">{r.detail}</span>
                </li>)}
            </ul>
            {done && <div className={`my-status ${bad ? 'bad' : 'ok'}`}><div className="my-icon" aria-hidden="true">{bad ? '⚠️' : '🛡️'}</div>
                <div><div className="my-title">{bad ? `${bad} בעיות` : 'הכול חסום כמו שצריך'}</div><div className="my-sub">{bad ? 'שלחו צילום מסך של הדף הזה.' : `${rows.length} בדיקות עברו.`}</div></div></div>}
        </div>
    </div>;
}
