// Public timing board: the cashier device (signed-in staff) publishes the board state to Supabase,
// and the public page (index.html, no login) reads it and follows changes in real time.
// The publishable key is public by design: Row Level Security lets anyone READ public.live_board,
// and only signed-in staff UPDATE it. New sign-ups are disabled in the Supabase project, so only
// staff accounts created by the owner in the Supabase dashboard can sign in.
import { createClient, type Session } from '@supabase/supabase-js';
import type * as L from './logic';

export const SUPABASE_URL = 'https://fqytpdapnvbpfonatopt.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_RANVYVqyzWASfwYdThRXtQ_SHfUjJa9';
const TABLE = 'live_board';
const ROW = 'main';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, storageKey: 'dankart.staff.session' },
});

/** What the public page receives: only what the venue screen shows. Unpaid form submissions stay on the cashier device. */
/** hist: finished heats (newest first) for the public history view. */
export type BoardPayload = { core: L.Core; sentAt: number; hist?: L.Result[] };

export const PUBLIC_HISTORY = 150;
export function boardOf(core: L.Core, now: number, hist: L.Result[] = []): BoardPayload {
    const { submissions: _unpaid, ...rest } = core;
    return { core: { ...rest, submissions: [] }, sentAt: now, hist: hist.slice(0, PUBLIC_HISTORY) };
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

// ------------------------------------------------------------ decoder (AMB) through the bridge program
// The bridge on the track laptop inserts one row per crossing into public.passings and keeps a heartbeat
// in public.decoder_status (docs/decoder-setup.sql). Staff only: the public site gets laps via the board.
type PassingRow = { uid: string; transponder: string; t: number };
const toPassing = (r: PassingRow): L.Passing => ({ id: r.uid, transponder: String(r.transponder), t: Number(r.t) });

/** Crossings at or after `sinceMs` (oldest first). */
export async function fetchPassings(sinceMs: number, limit = 3000): Promise<L.Passing[] | null> {
    const { data, error } = await supabase.from('passings').select('uid,transponder,t').gte('t', sinceMs).order('t', { ascending: true }).limit(limit);
    if (error || !data) return null;
    return (data as PassingRow[]).map(toPassing);
}

/** Latest crossings, newest first (Settings: "who just crossed the line"). */
export async function fetchRecentPassings(limit = 30): Promise<L.Passing[] | null> {
    const { data, error } = await supabase.from('passings').select('uid,transponder,t').order('t', { ascending: false }).limit(limit);
    if (error || !data) return null;
    return (data as PassingRow[]).map(toPassing);
}

/** Every new crossing, as it arrives. Returns an unsubscribe function. */
export function subscribePassings(cb: (p: L.Passing) => void, onStatus?: (s: string) => void): () => void {
    const ch = supabase.channel('passings_live')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'passings' }, msg => {
            const r = msg.new as PassingRow | undefined;
            if (r && r.transponder != null && r.t != null) cb(toPassing(r));
        })
        .subscribe(status => onStatus?.(status));
    return () => { void supabase.removeChannel(ch); };
}

export type DecoderStatus = { connected?: boolean; source?: string; format?: string; passings?: number; lastTransponder?: string; lastAt?: number; error?: string; pending?: number; version?: string; sentAt?: number };
export async function fetchDecoderStatus(): Promise<{ data: DecoderStatus; updatedAt: number } | null> {
    const { data, error } = await supabase.from('decoder_status').select('data,updated_at').eq('id', 'main').maybeSingle();
    if (error || !data) return null;
    return { data: (data.data ?? {}) as DecoderStatus, updatedAt: Date.parse(data.updated_at as string) };
}
