'use client';
import { logoUrl } from './components';

const W = 1080;
const crs = (l) => (l == null ? '—' : l >= 100 ? `₹${+(l / 100).toFixed(2)} Cr` : `₹${l} L`);
const GRADE_COL = { 'A+': '#22c55e', A: '#4ade80', 'B+': '#fbbf24', B: '#f59e0b', C: '#fb923c', D: '#ef4444' };
const ROLE_LABEL = { Batter: 'BATTERS', Wicketkeeper: 'WICKETKEEPERS', 'All-rounder': 'ALL-ROUNDERS', Bowler: 'BOWLERS' };

function load(url) {
  return new Promise((res) => {
    if (!url) return res(null);
    const i = new Image(); i.crossOrigin = 'anonymous';
    i.onload = () => res(i); i.onerror = () => res(null); setTimeout(() => res(null), 4000); i.src = url;
  });
}
function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
function text(ctx, t, x, y, size, color = '#fff', weight = 'bold', align = 'left') { ctx.font = `${weight} ${size}px sans-serif`; ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'alphabetic'; ctx.fillText(t, x, y); }
function fit(ctx, t, maxW, size, weight = 'bold') { ctx.font = `${weight} ${size}px sans-serif`; let s = t; while (ctx.measureText(s).width > maxW && s.length > 3) s = s.slice(0, -2); return s === t ? t : s + '…'; }
async function badge(ctx, team, color, x, y, size) {
  const img = await load(await logoUrl(team));
  ctx.save(); ctx.beginPath(); ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2); ctx.closePath(); ctx.fillStyle = img ? '#fff' : color; ctx.fill();
  if (img) { ctx.clip(); const s = size * 0.88, ar = img.width / img.height; let w = s, h = s; if (ar > 1) h = s / ar; else w = s * ar; ctx.drawImage(img, x + (size - w) / 2, y + (size - h) / 2, w, h); }
  else { ctx.fillStyle = '#fff'; ctx.font = `bold ${size / 3}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(team.split(' ').map((w) => w[0]).join('').slice(0, 3), x + size / 2, y + size / 2); }
  ctx.restore();
}
function bg(ctx, h, color) {
  const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#0f1d44'); g.addColorStop(1, '#070b16');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, h); ctx.fillStyle = color; ctx.fillRect(0, 0, W, 14);
}
const toBlob = (c) => new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Image export blocked by the browser'))), 'image/png'));

export async function squadImage(d) {
  const groups = [['Batter', 'Wicketkeeper'], ['All-rounder', 'Bowler']];
  const by = (role) => d.players.filter((p) => p.role === role).sort((a, b) => b.price - a.price);
  const colH = (g) => g.reduce((s, r) => s + (by(r).length ? 56 + by(r).length * 42 + 10 : 0), 0);
  const H = 520 + Math.max(colH(groups[0]), colH(groups[1]), 120) + 110;
  const c = document.createElement('canvas'); c.width = W; c.height = H; const ctx = c.getContext('2d');
  bg(ctx, H, d.color);
  await badge(ctx, d.team, d.color, 60, 60, 150);
  text(ctx, fit(ctx, d.team, 560, 50), 240, 118, 50);
  text(ctx, `${d.isBot ? 'AI Bot' : d.owner} · ${d.roomName}`, 240, 164, 28, '#9fb0d0', 'normal');
  text(ctx, `Rank #${d.rank} of ${d.teamCount}`, 240, 206, 30, '#fbbf24');
  rr(ctx, W - 270, 56, 210, 170, 24); ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fill();
  text(ctx, d.grade, W - 165, 160, 100, GRADE_COL[d.grade] || '#fff', 'bold', 'center');
  text(ctx, `Overall ${Math.round(d.st.overall)}`, W - 165, 205, 26, '#cbd5e1', 'normal', 'center');
  const tiles = [['SPENT', crs(d.spent)], ['PURSE LEFT', crs(d.purse)], ['PLAYERS', `${d.count} (min ${d.minSquad})`], ['OVERSEAS', String(d.os)]];
  tiles.forEach(([k, v], i) => { const x = 60 + i * 243; rr(ctx, x, 270, 228, 100, 18); ctx.fillStyle = 'rgba(255,255,255,0.07)'; ctx.fill(); text(ctx, k, x + 18, 306, 20, '#94a3b8', 'bold'); text(ctx, v, x + 18, 348, 34); });
  text(ctx, `BAT ${Math.round(d.st.bat)}   BOWL ${Math.round(d.st.bowl)}   ALL-ROUND ${Math.round(d.st.ar)}   KEEPER ${Math.round(d.st.keep)}   BALANCE ${Math.round(d.st.bal)}`, W / 2, 425, 27, '#e2e8f0', 'bold', 'center');
  text(ctx, 'Strength ratings are game estimates, not official IPL ratings', W / 2, 462, 20, '#64748b', 'normal', 'center');
  groups.forEach((g, gi) => {
    let y = 520; const x0 = 60 + gi * 500;
    g.forEach((role) => {
      const list = by(role); if (!list.length) return;
      text(ctx, `${ROLE_LABEL[role]} (${list.length})`, x0, y + 20, 22, '#fbbf24'); ctx.fillStyle = 'rgba(251,191,36,0.4)'; ctx.fillRect(x0, y + 30, 460, 2); y += 56;
      list.forEach((p) => { text(ctx, fit(ctx, (p.overseas ? '✈ ' : '') + p.name, 310, 26), x0, y + 12, 26, '#fff', 'normal'); text(ctx, crs(p.price), x0 + 460, y + 12, 26, '#fbbf24', 'bold', 'right'); y += 42; });
      y += 10;
    });
  });
  text(ctx, `IPL 2026 Friends Auction · Room ${d.code}`, W / 2, H - 50, 24, '#64748b', 'normal', 'center');
  return toBlob(c);
}

export async function leaderboardImage(d) {
  const H = 300 + d.rows.length * 112 + 190;
  const c = document.createElement('canvas'); c.width = W; c.height = H; const ctx = c.getContext('2d');
  bg(ctx, H, '#fbbf24');
  text(ctx, 'FINAL LEADERBOARD', W / 2, 120, 62, '#fff', 'bold', 'center');
  text(ctx, d.roomName, W / 2, 170, 30, '#9fb0d0', 'normal', 'center');
  text(ctx, 'Team grades are game estimates, not official ratings', W / 2, 212, 20, '#64748b', 'normal', 'center');
  for (let i = 0; i < d.rows.length; i++) {
    const r = d.rows[i], y = 250 + i * 112;
    rr(ctx, 50, y, 980, 98, 20); ctx.fillStyle = i === 0 ? 'rgba(251,191,36,0.18)' : 'rgba(255,255,255,0.06)'; ctx.fill();
    text(ctx, i === 0 ? '👑' : `#${i + 1}`, 100, y + 64, 40, '#fbbf24', 'bold', 'center');
    await badge(ctx, r.team, r.color, 150, y + 14, 70);
    text(ctx, fit(ctx, r.team, 400, 32), 245, y + 48, 32);
    text(ctx, `${r.isBot ? 'AI Bot' : r.owner} · ${r.count} players · spent ${crs(r.spent)}`, 245, y + 80, 20, '#9fb0d0', 'normal');
    text(ctx, r.grade, 880, y + 66, 54, GRADE_COL[r.grade] || '#fff', 'bold', 'center');
    text(ctx, String(Math.round(r.overall)), 975, y + 62, 38, '#e2e8f0', 'bold', 'center');
  }
  let y = 250 + d.rows.length * 112 + 30;
  (d.extra || []).forEach((l) => { text(ctx, fit(ctx, l, 960, 26, 'normal'), W / 2, y, 26, '#e2e8f0', 'normal', 'center'); y += 38; });
  text(ctx, `IPL 2026 Friends Auction · Room ${d.code}`, W / 2, H - 40, 24, '#64748b', 'normal', 'center');
  return toBlob(c);
}

export async function shareBlob(blob, name, title) {
  const file = new File([blob], name, { type: 'image/png' });
  try { if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title }); return; } }
  catch (e) { if (e && e.name === 'AbortError') return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 8000);
}
