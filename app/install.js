'use client';
import { useEffect, useState } from 'react';

export function PwaRegister() {
  useEffect(() => { if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {}); }, []);
  return null;
}

export function InstallCard() {
  const [ev, setEv] = useState(null), [ios, setIos] = useState(false), [installed, setInstalled] = useState(false);
  useEffect(() => {
    setIos(/iphone|ipad|ipod/i.test(navigator.userAgent));
    setInstalled(window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true);
    const h = (e) => { e.preventDefault(); setEv(e); };
    window.addEventListener('beforeinstallprompt', h);
    return () => window.removeEventListener('beforeinstallprompt', h);
  }, []);
  if (installed) return null;
  return (<div className="card mx-auto max-w-xl text-center text-sm">
    <div className="font-semibold">📲 Install this as an app on your phone</div>
    {ev ? <button onClick={() => ev.prompt()} className="btn mt-2 bg-amber-400 text-black">Install app</button>
      : ios ? <p className="mt-1 text-slate-300">iPhone: open this page in <b>Safari</b>, tap the <b>Share</b> button, then <b>Add to Home Screen</b>.</p>
      : <p className="mt-1 text-slate-300">Android (Chrome): tap the <b>⋮ menu</b> → <b>Install app</b> or <b>Add to Home screen</b>.</p>}
  </div>);
}
