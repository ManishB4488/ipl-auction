import './globals.css';
import { Barlow_Condensed } from 'next/font/google';
import { PwaRegister } from './install';
const display = Barlow_Condensed({ subsets: ['latin'], weight: ['600', '700', '800'], variable: '--font-display', display: 'swap' });
export const metadata = {
  title: 'IPL 2026 Friends Auction', description: 'Real-time multiplayer IPL auction',
  appleWebApp: { capable: true, title: 'IPL Auction', statusBarStyle: 'black' },
};
export const viewport = { width: 'device-width', initialScale: 1, themeColor: '#070d24' };
export default function RootLayout({ children }) {
  return (<html lang="en" className={display.variable}><body>
    <PwaRegister />
    <header className="sticky top-0 z-40 border-b-4 border-amber-400 bg-ipl-navy/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2">
        <a href="/" className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-b from-amber-300 to-amber-500 text-2xl shadow-lg shadow-amber-500/30">🏏</span>
          <span className="leading-none"><span className="block font-display text-2xl font-extrabold uppercase tracking-wide text-white">IPL <span className="text-amber-400">Auction</span></span>
            <span className="block text-[10px] font-semibold uppercase tracking-[.25em] text-slate-400">2026 · Friends Edition</span></span></a>
        <nav className="ml-auto flex items-center gap-4 font-display text-lg uppercase tracking-wider text-slate-300">
          <a href="/" className="hover:text-amber-400">Home</a><a href="/rejoin" className="hover:text-amber-400">Rejoin</a></nav>
      </div></header>
    <main className="mx-auto max-w-6xl p-4">{children}</main></body></html>);
}
