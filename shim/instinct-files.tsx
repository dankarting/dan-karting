// Local stand-in for the '@instinct/files' host package, so the demo runs standalone
// (npm run dev). It mirrors only the parts App.tsx and main.tsx use. When the app is
// delivered back into the hosted Files environment, the real package replaces this
// file through the alias in vite.config.ts / tsconfig.json; App.tsx does not change.
import React, { useCallback, useEffect, useRef, useState } from 'react';

type Kids = { children?: React.ReactNode };

export function FileRouter({ children }: Kids) {
    return <>{children}</>;
}

export function FileCard({ children, lang }: Kids & { lang?: string }) {
    return <main className="fc" lang={lang}>{children}</main>;
}

export function Header(p: { title: string; fact?: string; intro?: string }) {
    return <header className="fc-header">
        <h1 className="fc-title">{p.title}</h1>
        {p.fact && <div className="fc-fact">{p.fact}</div>}
        {p.intro && <p className="fc-intro">{p.intro}</p>}
    </header>;
}

export function Group({ label, heading, children }: Kids & { label: string; heading?: boolean }) {
    return <section className="fc-group" aria-label={label}>
        {heading ? <h2 className="fc-glabel">{label}</h2> : <div className="fc-glabel">{label}</div>}
        {children}
    </section>;
}

export function Callout({ title, tone, children }: Kids & { title: string; tone?: 'note' | 'warning' }) {
    return <div className={`fc-callout ${tone ?? 'note'}`} role="note">
        <strong className="fc-ctitle">{title}</strong>
        <div className="fc-cbody">{children}</div>
    </div>;
}

export function Closing({ children }: Kids) {
    return <footer className="fc-closing">{children}</footer>;
}

export function CopyButton({ text, label }: { text: string; label: string }) {
    const [done, setDone] = useState(false);
    const copy = async () => {
        try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch { setDone(false); }
    };
    return <button type="button" className="kb ghost" onClick={copy}>{done ? 'הועתק' : label}</button>;
}

/** [value, set, { ready, message }] backed by localStorage on this device only. */
export function useLocalState<T>(key: string, initial: T): [T, (v: T) => void, { ready: boolean; message: string }] {
    const [message, setMessage] = useState('');
    const [value, setValue] = useState<T>(() => {
        try {
            const raw = window.localStorage.getItem(key);
            return raw ? (JSON.parse(raw) as T) : initial;
        } catch {
            return initial;
        }
    });
    const first = useRef(true);
    useEffect(() => {
        if (first.current) { first.current = false; return; }
        try { window.localStorage.setItem(key, JSON.stringify(value)); setMessage(''); }
        catch { setMessage('storage unavailable: kept in memory only while open'); }
    }, [key, value]);
    const set = useCallback((v: T) => setValue(v), []);
    return [value, set, { ready: true, message }];
}
