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

export const PUBLIC_HISTORY = 30;
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
