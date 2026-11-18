// Public timing board: the cashier device (signed-in staff) publishes the board state to Supabase,
// and the public page (index.html, no login) reads it and follows changes in real time.
// The publishable key is public by design: Row Level Security lets anyone READ public.live_board,
// and only signed-in staff UPDATE it. New sign-ups are disabled in the Supabase project, so only
// staff accounts created by the owner in the Supabase dashboard can sign in.
import { createClient, type Session } from '@supabase/supabase-js';
import type * as L from './logic';
import type { ExtBoard } from './rentix';

export const SUPABASE_URL = 'https://fqytpdapnvbpfonatopt.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_RANVYVqyzWASfwYdThRXtQ_SHfUjJa9';
const TABLE = 'live_board';
const ROW = 'main';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, storageKey: 'dankart.staff.session' },
});

/** What the public page receives: only what the venue screen shows. Unpaid form submissions stay on the cashier device. */
/** hist: finished heats (newest first) for the public history view. */
export type BoardPayload = { core: L.Core; sentAt: number; hist?: L.Result[]; ext?: ExtBoard | null };

export const PUBLIC_HISTORY = 150;
export function boardOf(core: L.Core, now: number, hist: L.Result[] = [], ext: ExtBoard | null = null): BoardPayload {
    const { submissions: _unpaid, ...rest } = core;
    // Phone check-ins keep only their number, status and groups (no names), so the customer's personal area can follow them.
    const subs = (core.submissions ?? []).filter(x => x.checkinId != null)
        .map(x => ({ id: x.id, groupName: '', names: [], createdAt: 0, status: x.status, checkinId: x.checkinId, ...(x.groupIds ? { groupIds: x.groupIds } : {}), ...(x.groupId ? { groupId: x.groupId } : {}) }));
    return { core: { ...rest, submissions: subs }, sentAt: now, hist: hist.slice(0, PUBLIC_HISTORY), ext };
}

export async function publishBoard(payload: BoardPayload): Promise<string | null> {
    const { data, error } = await supabase.from(TABLE).update({ data: payload, updated_at: new Date(payload.sentAt).toISOString() }).eq('id', ROW).select('id');
    if (error) return error.message;
    if (!data || data.length === 0) return 'אין הרשאת כתיבה (צריך להתחבר כצוות)';
    return null;
}

export async function fetchBoard(): Promise<BoardPayload | null> {
    const { data, error } = await supabase.from(TABLE).select('data').eq('id', ROW).maybeSingle();
    if (error || !data) return null;
    return isPayload(data.data) ? data.data : null;
}

/** Calls back on every board change. Returns an unsubscribe function. */
export function subscribeBoard(cb: (p: BoardPayload) => void, onStatus?: (s: string) => void): () => void {
    const ch = supabase.channel('live_board_main')
        .on('postgres_changes', { event: '*', schema: 'public', table: TABLE, filter: `id=eq.${ROW}` }, msg => {
            const row = msg.new as { data?: unknown } | undefined;
            if (row && isPayload(row.data)) cb(row.data);
        })
        .subscribe(status => onStatus?.(status));
    return () => { void supabase.removeChannel(ch); };
}

function isPayload(x: unknown): x is BoardPayload {
    const p = x as BoardPayload | null;
    return !!p && typeof p === 'object' && !!p.core && Array.isArray(p.core.heats) && typeof p.sentAt === 'number';
}

// Permanent archive: one row per finished heat in public.heat_history (anyone reads, signed-in staff insert).
const ARCHIVE = 'heat_history';
/** Saves finished heats to the archive. Already-saved heats are skipped. Returns an error message or null. */
export async function archiveHeats(rs: L.Result[]): Promise<string | null> {
    if (rs.length === 0) return null;
    const rows = rs.map(r => ({ id: `${r.heatId}-${r.at}`, at: new Date(r.at).toISOString(), data: r }));
    const { error } = await supabase.from(ARCHIVE).upsert(rows, { onConflict: 'id', ignoreDuplicates: true });
    return error ? error.message : null;
}
/** Newest archived heats first. */
export async function fetchArchive(limit = 2000): Promise<L.Result[] | null> {
    const { data, error } = await supabase.from(ARCHIVE).select('data').order('at', { ascending: false }).limit(limit);
    if (error || !data) return null;
    return data.map(d => d.data as L.Result).filter(r => r && Array.isArray(r.rows));
}

/** Staff sign in with a short user name (e.g. "admin"); Supabase needs an e-mail, so a name maps to <name>@dankarting.app.
 *  A full e-mail address is used as typed. The matching user is created by the owner in Supabase (Authentication -> Users). */
export const STAFF_DOMAIN = 'dankarting.app';
export const staffEmail = (user: string) => (user.includes('@') ? user : `${user}@${STAFF_DOMAIN}`).trim().toLowerCase();

export async function signIn(user: string, password: string): Promise<string | null> {
    const { error } = await supabase.auth.signInWithPassword({ email: staffEmail(user), password });
    return error ? error.message : null;
}

export async function signOut() { await supabase.auth.signOut(); }

export function onSession(cb: (s: Session | null) => void): () => void {
    void supabase.auth.getSession().then(({ data }) => cb(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => cb(s));
    return () => data.subscription.unsubscribe();
}

// ---------------------------------------------------------------- shared staff state
// One row per key in public.staff_state (signed-in staff only: read + write). Every staff computer reads it, follows
// changes in real time and writes with a revision check, so two computers never silently overwrite each other.
const STATE = 'staff_state';
export type StateRow<T> = { data: T | null; rev: number };
/** null = could not reach the cloud (offline, not signed in, or the table does not exist yet). */
export async function loadState<T>(key: string): Promise<StateRow<T> | null> {
    const { data, error } = await supabase.from(STATE).select('data, rev').eq('id', key).maybeSingle();
    if (error || !data) return null;
    return { data: (data.data ?? null) as T | null, rev: Number(data.rev) || 0 };
}
/** Writes only if nobody else wrote since `rev`. 'conflict' = someone did; reload and re-apply. */
export async function saveState<T>(key: string, value: T, rev: number): Promise<'ok' | 'conflict' | 'error'> {
    const { data, error } = await supabase.from(STATE).update({ data: value, rev: rev + 1, updated_at: new Date().toISOString() }).eq('id', key).eq('rev', rev).select('rev');
    if (error) return 'error';
    return data && data.length ? 'ok' : 'conflict';
}
export function subscribeState(cb: (key: string, row: StateRow<unknown>) => void, onStatus?: (s: string) => void): () => void {
    const ch = supabase.channel('staff_state_all')
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: STATE }, msg => {
            const r = msg.new as { id?: string; data?: unknown; rev?: number } | undefined;
            if (r?.id) cb(r.id, { data: r.data ?? null, rev: Number(r.rev) || 0 });
        })
        .subscribe(s => onStatus?.(s));
    return () => { void supabase.removeChannel(ch); };
}

// ---------------------------------------------------------------- phone check-in (?join, docs/checkin.sql)
// The public page never reads customer data directly: it calls two database functions that return only short names.
export const phoneDigits = (p: string) => p.replace(/\D/g, '');
export const validPhone = (p: string) => /^0\d{8,9}$/.test(phoneDigits(p));
export type CheckinRow = { id: number; at: string; phone?: string; tz_tail?: string | null; names: string[]; minutes: number };

/** Saved short names for this phone ([] = new customer); 'code' = an SMS code is needed first; null = cloud not reachable. */
export async function checkinLookup(phone: string, token?: string): Promise<string[] | 'code' | null> {
    const { data, error } = await supabase.rpc('checkin_lookup', { p_phone: phoneDigits(phone), ...(token ? { p_token: token } : {}) });
    if (error) return (error.message || '').includes('need code') ? 'code' : null;
    return Array.isArray(data) ? (data as string[]) : [];
}
/** Sends an SMS code. 'sent', 'off' (SMS not set up: no code needed) or an error (Hebrew). */
export async function checkinSendCode(phone: string): Promise<'sent' | 'off' | { error: string }> {
    const { data, error } = await supabase.rpc('checkin_send_code', { p_phone: phoneDigits(phone) });
    if (!error) return data === 'off' ? 'off' : 'sent';
    const m = error.message || '';
    if (m.includes('wait')) return { error: 'כבר שלחנו קוד. אפשר לבקש שוב בעוד דקה.' };
    if (m.includes('bad phone')) return { error: 'צריך מספר נייד (05X)' };
    if (m.includes('busy')) return { error: 'יש עומס כרגע. פנו לקופה.' };
    return { error: 'לא הצלחנו לשלוח קוד. נסו שוב או פנו לקופה.' };
}
/** Checks the code. Returns a pass for this phone (kept for the day), or an error (Hebrew). */
export async function checkinVerify(phone: string, code: string): Promise<{ token: string } | { error: string }> {
    const { data, error } = await supabase.rpc('checkin_verify', { p_phone: phoneDigits(phone), p_code: code.replace(/\D/g, '') });
    if (!error && typeof data === 'string') return { token: data };
    const m = error?.message || '';
    if (m.includes('wrong')) return { error: 'הקוד לא נכון. נסו שוב.' };
    if (m.includes('expired')) return { error: 'הקוד פג תוקף. בקשו קוד חדש.' };
    return { error: 'לא הצלחנו לבדוק את הקוד. נסו שוב.' };
}
/** pick = 1-based positions of saved names that are coming; fresh = names typed now. Returns an error (Hebrew) or null. */
export async function checkinSubmit(phone: string, pick: number[], fresh: string[], minutes: number, token?: string): Promise<string | null> {
    const { error } = await supabase.rpc('checkin_submit', { p_phone: phoneDigits(phone), p_pick: pick, p_new: fresh, p_minutes: minutes, ...(token ? { p_token: token } : {}) });
    if (!error) return null;
    const m = error.message || '';
    if (m.includes('too soon')) return 'כבר נרשמתם עכשיו. גשו לקופה.';
    if (m.includes('bad phone')) return 'מספר הטלפון לא תקין';
    if (m.includes('no names')) return 'צריך לפחות שם אחד';
    if (m.includes('too many')) return 'יותר מדי שמות בהרשמה אחת. פנו לקופה.';
    if (m.includes('need code')) return 'צריך לאמת את הטלפון עם קוד. חזרו להתחלה.';
    return 'ההרשמה לא נשלחה. נסו שוב או פנו לקופה.';
}
// ---- ID number (ת"ז) check-in: the number goes to the database functions only; they keep a salted fingerprint, never the number.
/** Israeli ID check digit (9 digits, shorter numbers padded with zeros). */
export function validTz(raw: string): boolean {
    const d = raw.replace(/\D/g, '');
    if (d.length < 5 || d.length > 9) return false;
    const z = d.padStart(9, '0');
    if (/^0+$/.test(z)) return false;
    let sum = 0;
    for (let i = 0; i < 9; i++) { let n = Number(z[i]) * ((i % 2) + 1); if (n > 9) n -= 9; sum += n; }
    return sum % 10 === 0;
}
const tzOf = (raw: string) => raw.replace(/\D/g, '').padStart(9, '0');
/** Saved short names for this ID ([] = new customer), or null if the cloud could not be reached. */
export async function checkinLookupId(tz: string): Promise<string[] | null> {
    const { data, error } = await supabase.rpc('checkin_lookup_id', { p_tz: tzOf(tz) });
    if (error) return null;
    return Array.isArray(data) ? (data as string[]) : [];
}
export async function checkinSubmitId(tz: string, pick: number[], fresh: string[], minutes: number): Promise<{ id: number } | string> {
    const { data, error } = await supabase.rpc('checkin_submit_id', { p_tz: tzOf(tz), p_pick: pick, p_new: fresh, p_minutes: minutes });
    if (!error) return { id: Number(data) };
    const m = error.message || '';
    if (m.includes('too soon')) return 'כבר נרשמתם עכשיו. גשו לקופה.';
    if (m.includes('bad id')) return 'מספר תעודת הזהות לא תקין';
    if (m.includes('no names')) return 'צריך לפחות שם אחד';
    if (m.includes('too many')) return 'יותר מדי שמות בהרשמה אחת. פנו לקופה.';
    return 'ההרשמה לא נשלחה. נסו שוב או פנו לקופה.';
}
/** Staff: takes all open check-ins once (null = table not set up yet or offline). */
export async function checkinClaim(): Promise<CheckinRow[] | null> {
    const { data, error } = await supabase.rpc('checkin_claim');
    if (error) return null;
    return (data ?? []) as CheckinRow[];
}
/** Calls back when a new check-in arrives (staff only). */
export function subscribeCheckins(cb: () => void): () => void {
    const ch = supabase.channel('checkins_new')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'checkins' }, () => cb())
        .subscribe();
    return () => { void supabase.removeChannel(ch); };
}
