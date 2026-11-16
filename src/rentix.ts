// RentiX live timing (read-only). RentiX on the main computer sends its scoreboard feed (RMonitor format,
// TCP 50000). A small bridge on the staff laptop (public/rentix-bridge.ps1) reads it and serves the lines
// on http://localhost:8787 only. This file turns those lines into the board shown on our screens.
// Nothing here writes to RentiX.
//
// RMonitor records used:
//   $A,"reg","number",transponder,"first","last","nat",class   competitor
//   $COMP,"reg","number",class,"first","last","nat","extra"    competitor
//   $B,id,"description"                                        run (heat) name
//   $F,lapsToGo,"timeToGo","timeOfDay","raceTime","flag"       heartbeat
//   $G,pos,"reg",laps,"totalTime"                              race position
//   $H,pos,"reg",bestLapNo,"bestLapTime"                       best lap
//   $J,"reg","lapTime","totalTime"                             passing (one per lap)
//   $I,...                                                     reset (new session)

export type ExtRow = { pos: number; kart: number; name: string; laps: number; best: number | null; last: number | null; total: number | null };
/** What a board needs from RentiX. Published with the board so the public site shows the same. */
export type ExtBoard = { src: 'rentix'; at: number; run: string; flag: string; timeToGo: number | null; raceTime: number | null; lapsToGo: number | null; rows: ExtRow[] };

/** Split one CSV record; quotes are removed. */
export function splitRecord(line: string): string[] {
    const out: string[] = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
        else if (ch === ',' && !q) { out.push(cur); cur = ''; }
        else cur += ch;
    }
    out.push(cur);
    return out.map(s => s.trim());
}

/** "HH:MM:SS.mmm", "MM:SS.mmm" or "SS.mmm" -> ms. Empty or invalid -> null. */
export function timeMs(s: string | undefined): number | null {
    if (!s) return null;
    const parts = s.trim().split(':');
    if (parts.some(p => p === '' || isNaN(Number(p)))) return null;
    let ms = 0;
    for (const p of parts) ms = ms * 60 + Number(p);
    return Math.round(ms * 1000);
}

/** Lines from the bridge -> board. Only data after the last $I reset counts. */
export function parseRMonitor(lines: string[], at: number): ExtBoard {
    let start = 0;
    lines.forEach((l, i) => { if (l.startsWith('$I,') || l === '$I') start = i + 1; });
    const comp = new Map<string, { kart: number; name: string }>();
    const g = new Map<string, { pos: number; laps: number; total: number | null }>();
    const h = new Map<string, number | null>();
    const j = new Map<string, { laps: number[]; total: number | null }>();
    let run = '', flag = '', timeToGo: number | null = null, raceTime: number | null = null, lapsToGo: number | null = null;
    for (const line of lines.slice(start)) {
        const f = splitRecord(line);
        const t = f[0];
        if (t === '$A' || t === '$COMP') {
            const [reg, num] = [f[1], f[2]];
            const first = t === '$A' ? f[4] : f[4];
            const last = t === '$A' ? f[5] : f[5];
            comp.set(reg, { kart: parseInt(num, 10) || parseInt(reg, 10) || 0, name: `${first ?? ''} ${last ?? ''}`.trim() });
        } else if (t === '$B') run = f[2] ?? '';
        else if (t === '$F') { lapsToGo = f[1] !== '' && !isNaN(Number(f[1])) ? Number(f[1]) : null; timeToGo = timeMs(f[2]); raceTime = timeMs(f[4]); flag = f[5] ?? ''; }
        else if (t === '$G') g.set(f[2], { pos: Number(f[1]) || 0, laps: Number(f[3]) || 0, total: timeMs(f[4]) });
        else if (t === '$H') h.set(f[2], timeMs(f[4]));
        else if (t === '$J') {
            const e = j.get(f[1]) ?? { laps: [], total: null };
            const lap = timeMs(f[2]);
            if (lap != null && lap > 0) e.laps.push(lap);
            e.total = timeMs(f[3]) ?? e.total;
            j.set(f[1], e);
        }
    }
    const regs = new Set<string>([...comp.keys(), ...g.keys(), ...j.keys()]);
    const rows = [...regs].map(reg => {
        const c = comp.get(reg), gg = g.get(reg), jj = j.get(reg), hb = h.get(reg);
        const kart = c?.kart || parseInt(reg, 10) || 0;
        const best = hb ?? (jj && jj.laps.length ? Math.min(...jj.laps) : null);
        return {
            pos: gg?.pos ?? 0, kart, name: c?.name || `קארט ${kart}`,
            laps: gg?.laps ?? jj?.laps.length ?? 0, best, last: jj && jj.laps.length ? jj.laps[jj.laps.length - 1] : null,
            total: gg?.total ?? jj?.total ?? null,
        };
    });
    // RentiX positions when it sends them; otherwise more laps first, then earlier total time
    rows.sort((a, b) => (a.pos && b.pos ? a.pos - b.pos : 0) || b.laps - a.laps || (a.total ?? Infinity) - (b.total ?? Infinity) || a.kart - b.kart);
    rows.forEach((r, i) => { r.pos = i + 1; });
    return { src: 'rentix', at, run, flag, timeToGo, raceTime, lapsToGo, rows };
}

export const BRIDGE_URL = 'http://localhost:8787/';
export type BridgeState = { connected: boolean; error: string; at: number; lines: string[] };

/** One read from the local bridge. Null when the bridge is not running on this computer. */
export async function readBridge(timeoutMs = 1500): Promise<BridgeState | null> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const r = await fetch(BRIDGE_URL, { signal: ac.signal, cache: 'no-store' });
        if (!r.ok) return null;
        const d = await r.json() as Partial<BridgeState>;
        return { connected: !!d.connected, error: String(d.error ?? ''), at: Number(d.at) || 0, lines: Array.isArray(d.lines) ? d.lines.map(String) : [] };
    } catch { return null; } finally { clearTimeout(t); }
}

/** A RentiX board is shown only while it has drivers (after a reset it falls back to our own screens). */
export const extActive = (e: ExtBoard | null | undefined): e is ExtBoard => !!e && e.rows.length > 0;
