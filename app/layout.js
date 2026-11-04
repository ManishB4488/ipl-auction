import './globals.css';
export const metadata = { title: 'IPL 2026 Friends Auction', description: 'Real-time multiplayer IPL auction' };
export default function RootLayout({ children }) {
  return (<html lang="en"><body><meta name="viewport" content="width=device-width, initial-scale=1" />
    <header className="border-b border-white/10 px-4 py-3"><a href="/" className="text-xl font-extrabold text-amber-400">🏏 IPL 2026 Friends Auction</a></header>
    <main className="mx-auto max-w-6xl p-4">{children}</main></body></html>);
}
