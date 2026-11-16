// Shared staff state: the same core/history on every signed-in staff computer.
// Local edits are functions (core => core). They apply at once on this screen, then are written to the cloud on top of
// the newest cloud copy. If another computer wrote first, the functions are replayed on its version (no lost edits).
// Without internet the screen keeps working from the local copy and catches up when the connection is back.
import { useCallback, useEffect, useRef, useState } from 'react';
import * as Cloud from './cloud';

export type SyncStatus = 'local' | 'connecting' | 'synced' | 'saving' | 'offline' | 'no-table';
type Fn<T> = (v: T) => T;

export function useShared<T>(key: string, initial: T, enabled: boolean, prepare: (v: T) => T = v => v): { value: T; apply: (fn: Fn<T>) => T; status: SyncStatus; ready: boolean } {
    const cacheKey = `dankart.shared.${key}.v1`;
    const [value, setValue] = useState<T>(() => { try { const raw = localStorage.getItem(cacheKey); return raw ? prepare(JSON.parse(raw) as T) : initial; } catch { return initial; } });
    const [status, setStatus] = useState<SyncStatus>('local');
    const server = useRef<{ v: T; rev: number } | null>(null);
    const pending = useRef<Fn<T>[]>([]);
    const shown = useRef<T>(value);
    const busy = useRef(false);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const show = (v: T) => { shown.current = v; setValue(v); try { localStorage.setItem(cacheKey, JSON.stringify(v)); } catch { /* memory only */ } };
    const recompute = () => { if (server.current) show(pending.current.reduce((acc, f) => f(acc), server.current.v)); };

    const flush = useCallback(async () => {
        if (busy.current || !enabled) return;
        busy.current = true;
        try {
            for (let tries = 0; tries < 6; tries++) {
                if (!server.current) {
                    const row = await Cloud.loadState<T>(key);
                    if (!row) { setStatus('offline'); schedule(4000); return; }
                    if (row.data == null) {
                        // Empty cloud row: this computer's copy becomes the shared one.
                        const seed = shown.current;
                        const r = await Cloud.saveState(key, seed, row.rev);
                        if (r !== 'ok') { if (r === 'error') { setStatus('offline'); schedule(4000); return; } continue; }
                        server.current = { v: seed, rev: row.rev + 1 }; pending.current = [];
                    } else {
                        server.current = { v: prepare(row.data), rev: row.rev };
                    }
                    recompute();
                }
                const n = pending.current.length;
                if (n === 0) { setStatus('synced'); return; }
                setStatus('saving');
                const base = server.current!;
                const next = pending.current.slice(0, n).reduce((acc, f) => f(acc), base.v);
                const r = await Cloud.saveState(key, next, base.rev);
                if (r === 'ok') {
                    if (server.current === base || (server.current && server.current.rev <= base.rev)) server.current = { v: next, rev: base.rev + 1 };
                    pending.current = pending.current.slice(n);
                    recompute();
                    continue;
                }
                if (r === 'error') { setStatus('offline'); schedule(4000); return; }
                server.current = null; // conflict: reload the newest copy and replay our edits on it
            }
            schedule(500);
        } finally { busy.current = false; }
    }, [enabled, key]); // eslint-disable-line react-hooks/exhaustive-deps
    const schedule = (ms: number) => { if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => { void flush(); }, ms); };

    useEffect(() => {
        if (!enabled) { setStatus('local'); return; }
        setStatus('connecting'); server.current = null; void flush();
        const off = Cloud.subscribeState((k, row) => {
            if (k !== key || row.data == null) return;
            if (server.current && row.rev <= server.current.rev) return; // our own write echoing back, or older
            server.current = { v: prepare(row.data as T), rev: row.rev };
            recompute();
            if (pending.current.length) schedule(50);
        });
        // Safety net if the live channel drops: check for a newer copy every few seconds.
        const poll = setInterval(async () => {
            if (busy.current || pending.current.length || !server.current) return;
            const row = await Cloud.loadState<T>(key);
            if (row && row.data != null && server.current && row.rev > server.current.rev && !pending.current.length) { server.current = { v: prepare(row.data), rev: row.rev }; recompute(); setStatus('synced'); }
        }, 5000);
        const onOnline = () => schedule(100);
        window.addEventListener('online', onOnline);
        return () => { off(); clearInterval(poll); window.removeEventListener('online', onOnline); if (timer.current) clearTimeout(timer.current); };
    }, [enabled, key]); // eslint-disable-line react-hooks/exhaustive-deps

    const apply = useCallback((fn: Fn<T>): T => {
        const next = fn(shown.current);
        if (next === shown.current) return next;
        pending.current.push(fn);
        show(next);
        if (enabled) schedule(120);
        else pending.current = []; // no cloud: the local copy is the truth
        return next;
    }, [enabled]); // eslint-disable-line react-hooks/exhaustive-deps

    return { value, apply, status, ready: true };
}
