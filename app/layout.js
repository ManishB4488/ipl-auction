import './globals.css';
import { PwaRegister } from './install';
export const metadata = {
  title: 'IPL 2026 Friends Auction', description: 'Real-time multiplayer IPL auction',
  appleWebApp: { capable: true, title: 'IPL Auction', statusBarStyle: 'black' },
};
export const viewport = { width: 'device-width', initialScale: 1, themeColor: '#0b1430' };
export default function RootLayout({ children }) {
  return (<html lang="en"><body>
    <PwaRegister />
    <header className="border-b border-white/10 px-4 py-3"><a href="/" className="text-xl font-extrabold text-amber-400">🏏 IPL 2026 Friends Auction</a></header>
    <main className="mx-auto max-w-6xl p-4">{children}</main></body></html>);
}
