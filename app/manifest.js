export default function manifest() {
  return {
    name: 'IPL 2026 Friends Auction', short_name: 'IPL Auction', description: 'Real-time multiplayer IPL auction with friends',
    start_url: '/', scope: '/', display: 'standalone', orientation: 'portrait', background_color: '#070b16', theme_color: '#0b1430',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
