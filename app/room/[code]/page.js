'use client';
import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { sb, ensureUser, cr, setLabel } from '../../../lib/supabase';
import { Logo } from '../../components';
import { squadImage, leaderboardImage, shareBlob } from '../../shareimage';

const inc = (c) => (c < 100 ? 5 : c < 200 ? 10 : c < 500 ? 20 : 25);
const wikiCache = {};
function useWiki(name) {
  const [v, setV] = useState(wikiCache[name]);
  useEffect(() => {
    if (wikiCache[name] !== undefined) { setV(wikiCache[name]); return; }
    let dead = false;
    fetch('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(name.replace(/ /g, '_')))
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { const ok = j && /cricket/i.test(j.description || ''); wikiCache[name] = ok ? { src: j.thumbnail && j.thumbnail.source, extract: j.extract } : {}; if (!dead) setV(wikiCache[name]); })
      .catch(() => { wikiCache[name] = {}; });
    return () => { dead = true; };
  }, [name]);
  return v || {};
}
function Photo({ name, size = 96 }) {
  const { src } = useWiki(name);
  const initials = name.split(' ').map((w) => w[0]).slice(0, 2).join('');
  const box = { width: size, height: size };
  return src ? <img src={src} alt={name} referrerPolicy="no-referrer" style={box} className="shrink-0 rounded-2xl bg-white/10 object-cover object-top" />
    : <div style={box} className="grid shrink-0 place-items-center rounded-2xl bg-white/10 font-bold text-amber-300">{initials}</div>;
}
function PlayerInfo({ p, rp, room }) {
  const info = useWiki(p.name);
  const age = (() => { const m = (p.dob || '').split('/'); if (m.length !== 3) return null; return Math.floor((Date.now() - new Date(+m[2], +m[1] - 1, +m[0])) / 31557600000); })();
  const chip = (t, c) => <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${c}`}>{t}</span>;
  return (<div className="space-y-1.5">
    <div className="flex flex-wrap gap-1.5">
      {chip(p.role.toUpperCase(), 'bg-amber-400 text-black')}
      {p.overseas ? chip('✈ OVERSEAS · ' + p.country, 'bg-sky-400 text-black') : chip('🇮🇳 INDIAN', 'bg-green-500 text-black')}
      {p.capped === 'Capped' ? chip('CAPPED', 'bg-purple-500 text-white') : chip('UNCAPPED', 'bg-slate-500 text-white')}
      {p.retained && chip('⭐ RETAINED STAR', 'bg-yellow-300 text-black')}
      {room.accel_done && chip('⚡ ACCELERATED ROUND', 'bg-red-500 text-white')}
    </div>
    <p className="text-xs text-slate-300">{rp.blk_label || setLabel(p.set_code)}</p>
    <p className="text-sm text-slate-300">{age != null && `Age ${age} · `}Bats {p.bat === 'RHB' ? 'right-handed' : p.bat === 'LHB' ? 'left-handed' : '—'}{p.bowl ? ` · Bowls ${p.bowl.toLowerCase()}` : ' · Does not bowl (per list)'}</p>
    <p className="text-xs text-slate-400">{p.retained ? `Retained by ${p.ipl_team_2025} · custom base ${cr(rp.base_lakh)} (not official)` : `IPL 2025 team: ${p.ipl_team_2025 || 'none'}${p.ipl_matches != null ? ` (${p.ipl_matches} matches)` : ''} · Base ${cr(rp.base_lakh)} (official reserve price)`}</p>
    {info.extract && <p className="text-xs text-slate-500">{info.extract.slice(0, 230)}{info.extract.length > 230 ? '…' : ''} <span className="italic">(Wikipedia)</span></p>}
    <a href={`https://www.espncricinfo.com/search?q=${encodeURIComponent(p.name)}`} target="_blank" rel="noreferrer" className="text-xs text-amber-400 underline">Career stats on ESPNcricinfo ↗</a>
  </div>);
}

const TARGETS = { Batter: 5, Wicketkeeper: 2, 'All-rounder': 4, Bowler: 6 };   // suggested balanced minimum (17 of the 18 minimum squad)
function Needs({ room, mine, rps, P, cur }) {
  const sq = rps.filter((r) => r.sold_to === mine.id);
  const have = (role) => sq.filter((r) => P[r.player_id]?.role === role).length;
  const left = room.purse_lakh - mine.spent_lakh;
  const toMin = Math.max(room.min_squad - mine.squad_count, 0);
  const maxBid = Math.max(left - Math.max(room.min_squad - mine.squad_count - 1, 0) * 30, 0);
  const curP = cur ? P[cur.player_id] : null;
  const osLeft = Math.max(room.max_overseas - mine.os_count, 0);
  let hint = null;
  if (curP) hint = (curP.overseas && osLeft === 0) ? ['⚠ You have no overseas slot left for this player', 'bg-red-500/20'] : Math.max(TARGETS[curP.role] - have(curP.role), 0) > 0 ? ['🎯 This player fills a need in your squad', 'bg-green-600/25'] : ['This role is already covered in your squad', 'bg-white/10'];
  return (<div className="card space-y-2"><h3 className="font-semibold">What my team needs</h3>
    <div className="grid grid-cols-2 gap-2 text-center text-xs">{ROLES.map(([role, label]) => { const need = Math.max(TARGETS[role] - have(role), 0); return <div key={role} className={`rounded-lg p-2 ${need ? 'bg-amber-400/15' : 'bg-green-600/20'} ${curP && curP.role === role ? 'ring-1 ring-amber-300' : ''}`}>
      <div className="text-slate-300">{label}</div><div className="text-base font-bold">{have(role)}/{TARGETS[role]}</div><div>{need ? `need ${need} more` : '✅ covered'}</div></div>; })}</div>
    <p className="text-xs text-slate-400">Suggested balance only — you can build any squad you like.</p>
    <p className="text-xs text-slate-300">✈ Overseas slots left: <b>{osLeft}</b> of {room.max_overseas} · Squad <b>{mine.squad_count}</b> (min {room.min_squad}, max {room.max_squad})</p>
    <p className="text-xs text-slate-300">💰 Purse <b>{cr(left)}</b> · {toMin} more player{toMin === 1 ? '' : 's'} needed for the minimum squad<br />Safe average per remaining slot: <b>{toMin ? cr(Math.round(left / toMin)) : '—'}</b><br />Most you can bid on one player now: <b>{cr(maxBid)}</b> <span className="text-slate-500">(keeps ₹30 L per slot for the minimum squad)</span></p>
    {hint && <p className={`rounded p-1 text-center text-xs ${hint[1]}`}>{hint[0]}</p>}</div>);
}

function Watchlist({ watch, rps, P, autos, act }) {
  const items = watch.map((w) => ({ w, p: P[w.player_id], rp: rps.find((r) => r.player_id === w.player_id) })).filter((x) => x.p && x.rp).sort((a, b) => a.rp.seq - b.rp.seq);
  const status = (rp) => rp.status === 'live' ? ['ON NOW', 'text-yellow-300'] : rp.status === 'pending' ? (() => { const n = rps.filter((x) => x.status === 'pending' && x.seq < rp.seq).length; return [n === 0 ? 'NEXT UP' : `${n} players before`, 'text-amber-300']; })() : rp.status === 'sold' ? ['SOLD', 'text-green-400'] : ['UNSOLD', 'text-red-400'];
  const setAuto = (rp) => { const a = autos.find((x) => x.rp_id === rp.id); const v = prompt('Auto-bid up to how many ₹ Crore? (0 or empty = cancel)', a ? a.max_lakh / 100 : ''); if (v === null) return; const l = Math.round(parseFloat(v) * 100); act('set_auto_bid', { p_rp: rp.id, p_max: l > 0 ? l : 0 }); };
  return (<div className="card"><h3 className="mb-1 font-semibold">⭐ My watchlist</h3>
    {items.length === 0 ? <p className="text-xs text-slate-400">Tap ☆ next to a player to add them. They are highlighted when they come up.</p> :
      <ul className="max-h-56 divide-y divide-white/10 overflow-y-auto text-sm">{items.map(({ w, p, rp }) => { const [st, col] = status(rp); const a = autos.find((x) => x.rp_id === rp.id); return <li key={w.player_id} className="flex items-center justify-between gap-2 py-1">
        <span className="min-w-0 flex-1 truncate">{p.name} <span className={`text-xs ${col}`}>{st}</span></span>
        {(rp.status === 'pending' || rp.status === 'live') && <button onClick={() => setAuto(rp)} className="rounded bg-white/10 px-2 py-0.5 text-xs">{a ? `🤖 ≤ ${cr(a.max_lakh)}` : '🤖 Auto'}</button>}
        <button onClick={() => act('toggle_watch', { p_player: w.player_id })} className="text-xs text-slate-400" title="Remove">✕</button></li>; })}</ul>}</div>);
}

function AutoBid({ rp, autos, act }) {
  const a = autos.find((x) => x.rp_id === rp.id);
  const [v, setV] = useState('');
  return (<div className="mt-3 rounded-xl bg-black/20 p-3 text-sm">
    {a ? <div className="flex flex-wrap items-center gap-2"><span>🤖 Auto-bid is on, up to <b>{cr(a.max_lakh)}</b></span><button className="btn bg-white/10 py-1 text-xs" onClick={() => act('set_auto_bid', { p_rp: rp.id, p_max: 0 })}>Cancel</button></div>
      : <div className="flex flex-wrap items-center gap-2"><span>Auto-bid up to ₹</span>
        <input type="number" step="0.05" min="0" className="inp w-24" value={v} onChange={(e) => setV(e.target.value)} placeholder="Cr" /><span>Cr</span>
        <button className="btn bg-amber-400 py-1 text-black" onClick={() => { const l = Math.round(parseFloat(v) * 100); if (l > 0) { act('set_auto_bid', { p_rp: rp.id, p_max: l }); setV(''); } }}>Set</button>
        <span className="text-xs text-slate-400">The app bids for you, one step at a time, up to your limit. Private.</span></div>}
  </div>);
}

function AccelPick({ room, fr, rps, P, mine, isHost, act }) {
  const unsold = rps.filter((r) => r.status === 'unsold');
  const [sel, setSel] = useState([]);
  useEffect(() => {
    if (!mine) return;
    sb.from('accel_picks').select('rp_id').eq('franchise_id', mine.id).then(({ data }) => { if (data && data.length) setSel(data.map((x) => x.rp_id)); });
  }, [mine?.id]);
  const toggle = (id) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length >= 10 ? s : [...s, id]));
  const ready = fr.filter((f) => f.accel_ready).length;
  return (<div className="space-y-4">
    <div className="card"><h2 className="text-xl font-bold">⚡ Accelerated auction — pick your players</h2>
      <p className="mt-1 text-sm text-slate-300">The main round is over. Each franchise picks <b>5–10</b> unsold players it wants. Only picked players are auctioned again, with a <b>{room.accel_secs || 7}-second</b> timer. Your picks are private. Bots have already picked.</p>
      <div className="mt-2 flex flex-wrap gap-2 text-xs">{fr.map((f) => <span key={f.id} className={`rounded-full px-2 py-1 ${f.accel_ready ? 'bg-green-600/40' : 'bg-white/10'}`}>{f.accel_ready ? '✅' : '⏳'} {f.team}{f.is_bot ? ' 🤖' : ''}</span>)}</div>
      {isHost && <button className="btn mt-3 bg-green-500 text-black" onClick={() => act('host_start_accel')}>Start accelerated auction ({ready}/{fr.length} ready)</button>}</div>
    {mine ? <div className="card space-y-3">
      <div className="flex flex-wrap items-center gap-3"><b>{sel.length}/10 selected</b><span className="text-xs text-slate-400">(minimum 5)</span>
        <button className="btn bg-amber-400 text-black" onClick={() => act('submit_picks', { p_rps: sel })}>{mine.accel_ready ? 'Update my picks' : 'Submit my picks'}</button>
        {mine.accel_ready && <span className="text-sm text-green-400">✅ Submitted — you can change them until the host starts.</span>}</div>
      {ROLES.map(([role, label]) => { const g = unsold.filter((r) => P[r.player_id]?.role === role); return g.length ? <div key={role}>
        <div className="border-b border-white/20 pb-1 text-xs font-semibold uppercase tracking-wide text-amber-300">{label} ({g.length})</div>
        <div className="grid gap-x-4 sm:grid-cols-2">{g.map((r) => { const p = P[r.player_id]; return <label key={r.id} className="flex cursor-pointer items-center gap-2 py-1 text-sm">
          <input type="checkbox" checked={sel.includes(r.id)} onChange={() => toggle(r.id)} /><span className="flex-1">{p?.name} <span className="text-slate-400">{p?.overseas ? '✈ ' : ''}{p?.country}</span></span><span>{cr(r.base_lakh)}</span></label>; })}</div></div> : null; })}
    </div> : <p className="card">Waiting for franchises to submit their picks…</p>}
  </div>);
}
const ROLES = [['Batter', 'Batters'], ['Wicketkeeper', 'Wicketkeepers'], ['All-rounder', 'All-rounders'], ['Bowler', 'Bowlers']];
function Upcoming({ rps, P, cur, isHost, act, watchSet, mine }) {
  const [role, setRole] = useState(null);
  const active = role || P[cur?.player_id]?.role || 'Batter';
  const pend = rps.filter((x) => x.status === 'pending' || x.status === 'live');
  const by = (r) => pend.filter((x) => P[x.player_id]?.role === r);
  const total = (r) => rps.filter((x) => P[x.player_id]?.role === r).length;
  const list = by(active).slice(0, 15);
  return (<div className="card"><h3 className="mb-2 font-semibold">Coming up by category <span className="text-xs font-normal text-slate-400">(remaining/total)</span></h3>
    <div className="mb-2 flex flex-wrap gap-1">{ROLES.map(([r, l]) => <button key={r} onClick={() => setRole(r)} className={`rounded-full px-2 py-1 text-xs ${active === r ? 'bg-amber-400 text-black' : 'bg-white/10'}`}>{l} {by(r).length}/{total(r)}</button>)}</div>
    <ul className="max-h-56 divide-y divide-white/10 overflow-y-auto text-sm">{list.map((x) => { const p = P[x.player_id]; return <li key={x.id} className={`flex justify-between py-1 ${watchSet && watchSet.has(x.player_id) ? 'bg-yellow-300/10' : ''}`}><span>{mine && <button title="Watchlist" onClick={() => act('toggle_watch', { p_player: x.player_id })} className="mr-1 text-yellow-300">{watchSet && watchSet.has(x.player_id) ? '★' : '☆'}</button>}{p?.name} <span className="text-slate-400">{p?.country}</span></span><span className="flex items-center gap-2">{cr(x.base_lakh)}{isHost && x.status === 'pending' && <button title="Bots sit out this player" onClick={() => act('host_bots_skip', { p_rp: x.id, p_skip: !x.bots_skip })} className={`rounded px-1 text-xs ${x.bots_skip ? 'bg-red-500/70' : 'bg-white/10'}`}>{x.bots_skip ? '🚫🤖' : '🤖'}</button>}</span></li>; })}
      {by(active).length > 15 && <li className="py-1 text-slate-400">+{by(active).length - 15} more…</li>}</ul></div>);
}
const TABS = ['Live', 'Results Table', 'My Franchise', 'All Teams', 'Final'];

// ---------- sound effects (synthesised in the browser, no audio files) ----------
let _ctx;
function unlockAudio() { try { _ctx = _ctx || new (window.AudioContext || window.webkitAudioContext)(); if (_ctx.state === 'suspended') _ctx.resume(); } catch (e) {} return _ctx; }
function tone(f, d, type = 'sine', v = 0.15, when = 0) {
  const c = unlockAudio(); if (!c) return;
  const o = c.createOscillator(), g = c.createGain(), t0 = c.currentTime + when;
  o.type = type; o.frequency.value = f; g.gain.setValueAtTime(v, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
  o.connect(g); g.connect(c.destination); o.start(t0); o.stop(t0 + d);
}
function thud(when = 0, v = 0.6) {
  const c = unlockAudio(); if (!c) return;
  const t0 = c.currentTime + when, len = Math.floor(c.sampleRate * 0.15), buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const n = c.createBufferSource(), g = c.createGain(); n.buffer = buf;
  g.gain.setValueAtTime(v, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.15);
  n.connect(g); g.connect(c.destination); n.start(t0); tone(120, 0.2, 'sine', v, when);
}
const sfx = {
  beep: () => tone(880, 0.1, 'square', 0.06), beepHi: () => tone(1320, 0.25, 'square', 0.08), bid: () => tone(520, 0.06, 'triangle', 0.07),
  sold: () => { thud(0); thud(0.22); tone(523, 0.18, 'triangle', 0.15, 0.5); tone(659, 0.18, 'triangle', 0.15, 0.65); tone(784, 0.4, 'triangle', 0.15, 0.8); },
  once: () => thud(0, 0.35),
  twice: () => { thud(0, 0.4); thud(0.28, 0.4); },
  final: () => { thud(0, 0.45); thud(0.22, 0.45); thud(0.44, 0.5); tone(1000, 0.3, 'square', 0.06, 0.62); },
  unsold: () => { tone(300, 0.25, 'sawtooth', 0.08); tone(220, 0.45, 'sawtooth', 0.08, 0.22); },
};

function SoldOverlay({ m, P, FR, onClose }) {
  const sold = m.status === 'sold', team = FR[m.sold_to], p = P[m.player_id];
  const bits = useMemo(() => Array.from({ length: 36 }, (_, i) => ({ left: Math.random() * 100, delay: Math.random() * 1.2, dur: 2.2 + Math.random() * 2, color: [team?.color || '#fbbf24', '#fbbf24', '#ffffff'][i % 3] })), [m.id]);
  return (<div onClick={onClose} className="fixed inset-0 z-50 grid place-items-center bg-black/85 p-4 text-center">
    {sold && bits.map((b, i) => <span key={i} className="confetti" style={{ left: `${b.left}%`, animationDelay: `${b.delay}s`, animationDuration: `${b.dur}s`, background: b.color }} />)}
    <div className="pop space-y-3">
      {sold ? (<>
        <div className="hammer text-6xl">🔨</div>
        <div className="text-6xl font-black tracking-widest text-green-400 md:text-8xl">SOLD!</div>
        <div className="flex justify-center"><Logo team={team?.team} size={150} /></div>
        <div className="text-2xl font-bold md:text-4xl">{team?.team}</div>
        <div className="text-5xl font-black text-amber-400 md:text-7xl">{cr(m.sold_lakh)}</div>
        <div className="flex items-center justify-center gap-3 text-lg md:text-2xl"><Photo name={p?.name || '?'} size={64} /><span>{p?.name} <span className="text-slate-300">· {p?.role}</span></span></div>
      </>) : (<>
        <div className="text-6xl font-black tracking-widest text-red-400 md:text-8xl">UNSOLD</div>
        <div className="flex items-center justify-center gap-3 text-xl md:text-3xl"><Photo name={p?.name || '?'} size={72} /><span>{p?.name}</span></div>
        <div className="text-slate-300">No team bought this player</div></>)}
      <div className="text-xs text-slate-500">tap to close</div></div></div>);
}

function PinBadge({ pin }) {
  const [show, setShow] = useState(false);
  return <button onClick={() => setShow(!show)} className="btn bg-white/10 text-sm" title="Your private recovery PIN">🔑 {show ? pin : 'Recovery PIN'}</button>;
}

export default function Room({ params }) {
  const code = params.code.toUpperCase();
  const [me, setMe] = useState(null), [info, setInfo] = useState(null), [room, setRoom] = useState(null);
  const [autos, setAutos] = useState([]), [watch, setWatch] = useState([]);
  const [fr, setFr] = useState([]), [rps, setRps] = useState([]), [bids, setBids] = useState([]), [P, setP] = useState({});
  const [pin, setPin] = useState(null);
  const [tab, setTab] = useState('Live'), [msg, setMsg] = useState(''), [now, setNow] = useState(Date.now()), [err, setErr] = useState('');

  const load = useCallback(async (id) => {
    const [r, f, p, b, au, wa] = await Promise.all([
      sb.from('rooms').select('*').eq('id', id).maybeSingle(),
      sb.from('franchises').select('*').eq('room_id', id).order('created_at'),
      sb.from('room_players').select('*').eq('room_id', id).order('seq').limit(1000),
      sb.from('bids').select('*').eq('room_id', id).order('id', { ascending: false }).limit(300),
      sb.from('auto_bids').select('*').eq('room_id', id), sb.from('watchlist').select('*').eq('room_id', id)]);   // RLS: only your own rows
    setRoom(r.data); setFr(f.data || []); setRps(p.data || []); setBids(b.data || []); setAutos(au.data || []); setWatch(wa.data || []);
  }, []);

  useEffect(() => {
    let ch, iv, dead = false;
    (async () => {
      try {
        setMe(await ensureUser());
        const { data: pl } = await sb.from('players').select('*').limit(1000);
        setP(Object.fromEntries((pl || []).map((x) => [x.id, x])));
        const { data: i } = await sb.rpc('room_by_code', { p_code: code });
        if (!i) return setErr('Room not found');
        if (dead) return;
        setInfo(i); await load(i.id);
        if (dead) return;
        ch = sb.channel('room-' + i.id + '-' + Math.random().toString(36).slice(2));
        ['rooms', 'franchises', 'room_players', 'bids'].forEach((t) => ch.on('postgres_changes',
          { event: '*', schema: 'public', table: t, filter: t === 'rooms' ? `id=eq.${i.id}` : `room_id=eq.${i.id}` }, () => load(i.id)));
        ch.subscribe();
        iv = setInterval(() => load(i.id), 5000); // fallback poll: also restores state after reconnect
      } catch (e) { setErr(e.message); }
    })();
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => { dead = true; clearInterval(t); clearInterval(iv); ch && sb.removeChannel(ch); };
  }, [code, load]);

  useEffect(() => {
    if (!room?.id || !fr.some((f) => f.user_id === me?.id)) { setPin(null); return; }
    sb.rpc('get_my_pin', { p_room: room.id }).then(({ data }) => setPin(data || null));
  }, [room?.id, me?.id, fr.length]);

  const FR = useMemo(() => Object.fromEntries(fr.map((f) => [f.id, f])), [fr]);
  const mine = fr.find((f) => f.user_id === me?.id);
  const isHost = room && me && room.host_id === me.id;
  const cur = room?.cur_rp ? rps.find((x) => x.id === room.cur_rp) : null;
  const left = !room ? 0 : room.status === 'paused' ? room.paused_ms : room.ends_at ? Math.max(0, new Date(room.ends_at) - now) : 0;

  // any client may call tick(); the server only settles when the timer has really expired
  useEffect(() => { if (room?.status === 'live' && room.ends_at && left <= 0) { const t = setTimeout(() => sb.rpc('tick', { p_room: room.id }).then(() => load(room.id)), 400); return () => clearTimeout(t); } }, [left, room, load]);

  // ---- sound + SOLD moment ----
  const [sound, setSound] = useState(true), [moment, setMoment] = useState(null);
  const soundRef = useRef(true), seenSale = useRef(null), momentTimer = useRef(null);
  useEffect(() => {
    try { const off = localStorage.getItem('auction-sound') === 'off'; setSound(!off); soundRef.current = !off; } catch (e) {}
    const unlock = () => unlockAudio();
    window.addEventListener('pointerdown', unlock, { once: true });
    return () => window.removeEventListener('pointerdown', unlock);
  }, []);
  const play = (n) => { if (soundRef.current) sfx[n](); };
  const toggleSound = () => {
    const v = !soundRef.current; soundRef.current = v; setSound(v);
    try { localStorage.setItem('auction-sound', v ? 'on' : 'off'); } catch (e) {}
    if (v) { unlockAudio(); sfx.unsold(); }
  };
  useEffect(() => {   // a sale / unsold just happened (history on first load is ignored)
    if (!room) return;
    const lastRes = [...rps].filter((x) => x.sold_at).sort((a, b) => new Date(b.sold_at) - new Date(a.sold_at))[0];
    const t = lastRes ? new Date(lastRes.sold_at).getTime() : 0;
    if (seenSale.current === null) { seenSale.current = t; return; }
    if (t > seenSale.current) {
      seenSale.current = t; setMoment(lastRes); play(lastRes.status === 'sold' ? 'sold' : 'unsold');
      if (momentTimer.current) clearTimeout(momentTimer.current);
      momentTimer.current = setTimeout(() => setMoment(null), 4500);
    }
  }, [rps, room]);

  useEffect(() => {   // keep the phone screen awake while the auction runs (bots and timers need an open screen)
    const on = room && (room.status === 'live' || room.status === 'paused' || room.status === 'accel_pick');
    if (!on || !('wakeLock' in navigator)) return;
    let lock = null, dead = false;
    const get = () => navigator.wakeLock.request('screen').then((l) => { if (dead) l.release(); else lock = l; }).catch(() => {});
    get();
    const vis = () => { if (document.visibilityState === 'visible') get(); };
    document.addEventListener('visibilitychange', vis);
    return () => { dead = true; document.removeEventListener('visibilitychange', vis); if (lock) lock.release().catch(() => {}); };
  }, [room?.status === 'live' || room?.status === 'paused' || room?.status === 'accel_pick']);

  // Drives the AI bots: the server decides whether a bot acts, so extra calls are harmless.
  useEffect(() => {
    if (!room || room.status !== 'live' || !room.fill_bots) return;
    const iv = setInterval(() => sb.rpc('bot_step', { p_room: room.id }).then(({ error }) => { if (error) setMsg('Bot error: ' + error.message); }), isHost ? 1500 : 4000);
    return () => clearInterval(iv);
  }, [room?.id, room?.status, room?.fill_bots, isHost]);

  const act = async (fn, args = {}) => {
    setMsg(''); const { data, error } = await sb.rpc(fn, { p_room: room.id, ...args });
    if (error) setMsg(error.message); else if (typeof data === 'string' && data !== 'ok') setMsg(data);
    load(room.id);
  };

  if (err) return <p className="text-red-400">{err}</p>;
  if (!info || !me) return <p>Loading…</p>;
  if (!room) return <p className="card">This room is private to participants (spectators disabled) or you are not a member. <a className="underline text-amber-400" href="/">Join from the home page</a> with code <b>{code}</b>, or <a className="underline text-amber-400" href={`/rejoin?code=${code}`}>rejoin with your PIN</a>.</p>;

  const link = typeof window !== 'undefined' ? window.location.href : '';
  if (room.status === 'lobby') return <Lobby {...{ room, fr, isHost, mine, act, link, msg, setMsg, pin }} />;

  return (<div className="space-y-4">
    {moment && <SoldOverlay m={moment} P={P} FR={FR} onClose={() => setMoment(null)} />}
    <div className="flex flex-wrap items-center gap-2">
      <h1 className="text-xl font-bold mr-auto">{room.name} <span className="text-sm text-slate-400">#{room.code} · {room.status.replace('_', ' ').toUpperCase()}</span></h1>
      <button onClick={toggleSound} className="btn bg-white/10 text-sm">{sound ? '🔊 Sound ON' : '🔇 Sound OFF'}</button>
      {room.status !== 'lobby' && <span className="rounded-full bg-white/10 px-2 py-1 text-xs">🤖 Bots {room.fill_bots ? 'ON' : 'OFF'}</span>}
      {mine && pin && <PinBadge pin={pin} />}
      {TABS.map((t) => <button key={t} onClick={() => setTab(t)} className={`btn text-sm ${tab === t ? 'bg-amber-400 text-black' : 'bg-white/10'}`}>{t}</button>)}
    </div>
    {msg && <p className="rounded-lg bg-red-500/20 p-2 text-sm">{msg}</p>}
    {!mine && <p className="rounded-lg bg-white/10 p-2 text-sm">You are watching as a spectator. Are you a player? <a className="text-amber-400 underline" href={`/rejoin?code=${code}`}>Rejoin with your PIN</a></p>}
    {tab === 'Live' && (room.status === 'accel_pick' ? <AccelPick {...{ room, fr, rps, P, mine, isHost, act }} /> : <Live {...{ room, cur, left, P, FR, fr, rps, bids, mine, isHost, act, autos, watch, play }} />)}
    {tab === 'Results Table' && <Table {...{ rps, P, FR, fr, isHost, act, room }} />}
    {tab === 'My Franchise' && (mine ? <Squad f={mine} room={room} rps={rps} P={P} /> : <p className="card">You are watching as a spectator.</p>)}
    {tab === 'All Teams' && <div className="grid gap-4 md:grid-cols-2">{fr.map((f) => <Squad key={f.id} f={f} room={room} rps={rps} P={P} />)}</div>}
    {tab === 'Final' && <Final {...{ rps, P, FR, fr, room }} />}
  </div>);
}

function Lobby({ room, fr, isHost, act, link, msg, mine, pin }) {
  const [r, setR] = useState({ p_purse: room.purse_lakh / 100, p_min: room.min_squad, p_max: room.max_squad, p_os: room.max_overseas, p_timer: room.timer_secs, p_spec: room.spectators, p_bots: room.fill_bots });
  const n = (k) => (e) => setR({ ...r, [k]: +e.target.value });
  return (<div className="grid gap-4 md:grid-cols-2">
    <div className="card space-y-3"><h1 className="text-2xl font-bold">{room.name}</h1>
      <p>Room code: <b className="text-3xl tracking-widest text-amber-400">{room.code}</b></p>
      <input readOnly className="inp text-sm" value={link} onFocus={(e) => e.target.select()} />
      <button className="btn bg-white/10" onClick={() => navigator.clipboard?.writeText(link)}>Copy invite link</button>
      <h3 className="font-semibold pt-2">Franchises ({fr.length}/10)</h3>
      {fr.map((f) => <div key={f.id} className="flex items-center gap-2"><Logo team={f.team} size={28} />{f.team} <span className="text-slate-400 text-sm">— {f.owner}{f.user_id === room.host_id && ' (host)'}{f.is_bot && ' 🤖'}</span></div>)}
      {pin && <div className="rounded-lg border border-amber-400/40 bg-amber-400/10 p-3 text-sm">🔑 Your recovery PIN: <b className="tracking-widest">{pin}</b><br />Save it. If you change phone or lose access, use “Rejoin with PIN” on the home page.</div>}
      {!isHost && <p className="text-sm text-slate-400">Waiting for the host to start…</p>}</div>
    {isHost && <div className="card space-y-2"><h3 className="font-semibold">Custom rules (not official IPL rules)</h3>
      {[['Purse (₹ Cr)', 'p_purse'], ['Min squad', 'p_min'], ['Max squad', 'p_max'], ['Max overseas', 'p_os'], ['Timer (sec)', 'p_timer']].map(([l, k]) =>
        <label key={k} className="flex items-center gap-2 text-sm"><span className="w-32">{l}</span><input type="number" className="inp" value={r[k]} onChange={n(k)} /></label>)}
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={r.p_bots} onChange={(e) => setR({ ...r, p_bots: e.target.checked })} /> Fill empty seats with AI bot teams (up to 10 teams)</label>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={r.p_spec} onChange={(e) => setR({ ...r, p_spec: e.target.checked })} /> Allow spectators</label>
      <button className="btn bg-white/10" onClick={() => act('set_rules', { ...r, p_purse: Math.round(r.p_purse * 100) })}>Save rules</button>
      <button disabled={fr.length < 3} className="btn w-full bg-green-500 text-black" onClick={() => act('start_room')}>Start auction {fr.length < 3 && '(need 3+)'}</button>
      {msg && <p className="text-sm text-red-400">{msg}</p>}</div>}</div>);
}

function Live({ room, cur, left, P, FR, fr, rps, bids, mine, isHost, act, autos, watch, play }) {
  const watchSet = new Set(watch.map((w) => w.player_id));
  const p = cur && P[cur.player_id];
  const recent = [...rps].filter((x) => x.sold_at).sort((a, b) => new Date(b.sold_at) - new Date(a.sold_at)).slice(0, 6);
  const last = recent[0];
  const next = !cur ? 0 : room.cur_bidder ? room.cur_bid + inc(room.cur_bid) : cur.base_lakh;
  const secs = Math.ceil(left / 1000), tot = room.timer_secs || 20;
  let call = null;   // "going once / twice" call as the timer runs down
  if (cur && room.status === 'live' && left > 0) {
    const long = tot >= 15;   // 20 s timer: once <=6s, twice <=4s, final <=2s; 7 s accelerated timer: 4 / 3 / 2
    const stage = secs <= 2 ? 3 : secs <= (long ? 4 : 3) ? 2 : secs <= (long ? 6 : 4) ? 1 : 0;
    if (stage) call = room.cur_bidder ? ['', 'Going once…', 'Going twice…', 'FINAL CALL…'][stage] : 'Any bids?';
  }
  const lastCall = useRef(null);
  useEffect(() => {   // sound for the calls (only when someone has bid)
    if (call === lastCall.current) return;
    lastCall.current = call;
    if (call === 'Going once…') play('once'); else if (call === 'Going twice…') play('twice'); else if (call === 'FINAL CALL…') play('final');
  }, [call]);
  const done = rps.filter((x) => x.status === 'sold' || x.status === 'unsold').length;
  const total = rps.length, sold = rps.filter((x) => x.status === 'sold').length;
  const myBids = bids.filter((b) => cur && b.rp_id === cur.id);
  return (<div className="grid gap-4 lg:grid-cols-3">
    <div className="lg:col-span-2 space-y-4">
      {last && <div key={last.id} className="pop flex items-center justify-center gap-3 rounded-xl p-3 text-center font-bold" style={{ background: last.status === 'sold' ? '#16a34a55' : '#dc262655' }}><Photo name={P[last.player_id]?.name || '?'} size={56} />
        {last.status === 'sold' ? `🔨 SOLD! ${P[last.player_id]?.name} → ${FR[last.sold_to]?.team} for ${cr(last.sold_lakh)}` : `❌ UNSOLD: ${P[last.player_id]?.name}`}</div>}
      {p ? <div className={`card pop ${watchSet.has(p.id) ? 'ring-2 ring-yellow-300' : ''}`} key={cur.id}>
        {watchSet.has(p.id) && <div className="mb-2 rounded-lg bg-yellow-300/20 p-1 text-center text-sm font-bold text-yellow-200">⭐ On your watchlist</div>}
        <div className="flex flex-wrap items-center gap-4">
          <Photo name={p.name} />
          <div className="flex-1"><h2 className="text-3xl font-extrabold">{p.name}{mine && <button title="Add to watchlist" onClick={() => act('toggle_watch', { p_player: p.id })} className="ml-2 text-3xl text-yellow-300">{watchSet.has(p.id) ? '★' : '☆'}</button>}</h2>
            <PlayerInfo p={p} rp={cur} room={room} /></div>
          <div className={`text-5xl font-black tabular-nums ${left < 5000 ? 'text-red-400' : 'text-amber-400'}`}>{Math.ceil(left / 1000)}s</div></div>
        {call && <div key={call} className="pop mt-3 rounded-xl bg-amber-400/15 p-2 text-center text-xl font-extrabold text-amber-300">🔨 {call}</div>}
        <div className="mt-4 grid grid-cols-2 gap-3 text-center">
          <div className="rounded-xl bg-black/30 p-3"><div className="text-xs text-slate-400">CURRENT BID</div><div className="text-3xl font-bold">{room.cur_bidder ? cr(room.cur_bid) : 'No bids'}</div><div className="mt-1 text-xs text-slate-400">{room.cur_bidder ? `Next bid ${cr(next)} (+${cr(inc(room.cur_bid))})` : `Opens at ${cr(next)} (base price)`}</div></div>
          <div className="rounded-xl bg-black/30 p-3" style={{ borderBottom: `4px solid ${FR[room.cur_bidder]?.color || 'transparent'}` }}><div className="text-xs text-slate-400">HIGHEST BIDDER</div><div className="flex items-center justify-center gap-2 text-xl font-bold">{room.cur_bidder && <Logo team={FR[room.cur_bidder]?.team} size={32} />}{FR[room.cur_bidder]?.team || '—'}</div></div></div>
        {mine && room.status === 'live' && <div className="mt-4 flex gap-3">
          <button disabled={room.cur_bidder === mine.id} onClick={() => act('bid', { p_amount: next })} className="btn flex-1 bg-amber-400 py-4 text-xl text-black">BID {cr(next)}</button>
          <button onClick={() => act('pass')} className="btn bg-white/10 py-4">PASS</button></div>}
        {mine && room.status === 'live' && <AutoBid rp={cur} autos={autos} act={act} />}
        <p className="mt-2 text-center text-xs text-slate-500">Bid steps: +5 L below ₹1 Cr · +10 L to ₹2 Cr · +20 L to ₹5 Cr · +25 L above</p>
        {room.status === 'paused' && <p className="mt-3 text-center text-amber-300">⏸ Auction paused by host</p>}
      </div> : <div className="card text-center text-xl">{room.status === 'review' ? 'First round finished — host can re-auction unsold players.' : room.status === 'done' ? 'Auction complete! See the Final tab.' : 'Waiting…'}</div>}
      <div className="card"><h3 className="font-semibold mb-2">Recent results</h3>
        {recent.length === 0 ? <p className="text-sm text-slate-400">Nothing sold yet</p> : recent.map((r) => <div key={r.id} className="flex items-center gap-2 py-1 text-sm">
          <Photo name={P[r.player_id]?.name || '?'} size={32} /><span className="flex-1">{P[r.player_id]?.name}</span>
          {r.status === 'sold' ? <><span style={{ color: FR[r.sold_to]?.color }}>{FR[r.sold_to]?.team}</span><b>{cr(r.sold_lakh)}</b></> : <span className="text-red-400">UNSOLD</span>}</div>)}</div>
      <div className="card"><h3 className="font-semibold mb-2">Bid history (this player)</h3>
        {myBids.length === 0 ? <p className="text-sm text-slate-400">No bids yet</p> : myBids.slice(0, 8).map((b) => <div key={b.id} className="flex justify-between text-sm"><span>{FR[b.franchise_id]?.team}</span><b>{cr(b.amount)}</b></div>)}</div>
      {isHost && <div className="card flex flex-wrap gap-2"><span className="font-semibold mr-2">Host:</span>
        {room.status === 'live' && <button className="btn bg-white/10" onClick={() => act('host_pause')}>Pause</button>}
        {room.status === 'paused' && <button className="btn bg-green-500 text-black" onClick={() => act('host_resume')}>Resume</button>}
        <button className="btn bg-white/10" onClick={() => act('host_skip')}>Skip (to end of queue)</button>
        <button className={`btn ${room.fill_bots ? 'bg-white/10' : 'bg-red-500/70'}`} onClick={() => act('host_bots', { p_on: !room.fill_bots })}>🤖 Bots: {room.fill_bots ? 'ON (tap to stop)' : 'OFF (tap to resume)'}</button>
        {cur && <button className={`btn ${cur.bots_skip ? 'bg-red-500/70' : 'bg-white/10'}`} onClick={() => act('host_bots_skip', { p_rp: cur.id, p_skip: !cur.bots_skip })}>{cur.bots_skip ? '🚫🤖 Bots sitting out this player (tap to undo)' : '🚫🤖 Bots sit out this player'}</button>}
        <button className="btn bg-white/10" onClick={() => act('host_unsold')}>Mark UNSOLD</button>
        <button className="btn bg-white/10" onClick={() => confirm('Undo the last completed sale?') && act('host_undo_sale')}>Undo last sale</button>
        {room.status === 'review' && <button className="btn bg-amber-400 text-black" onClick={() => act('host_reauction')}>Re-auction unsold</button>}
        <button className="btn bg-red-500/70" onClick={() => confirm('End the auction?') && act('host_end')}>End auction</button></div>}
    </div>
    <div className="space-y-4"><div className="card"><h3 className="font-semibold">Progress</h3>
      <p className="text-sm">{done}/{total} auctioned · {sold} sold · {rps.filter((x) => x.status === 'unsold').length} unsold · {rps.filter((x) => x.status === 'pending').length} remaining</p>
      <div className="mt-2 h-2 rounded bg-white/10"><div className="h-2 rounded bg-amber-400" style={{ width: `${(done / Math.max(total, 1)) * 100}%` }} /></div></div>
      {mine && <Needs room={room} mine={mine} rps={rps} P={P} cur={cur} />}
      {mine && <Watchlist watch={watch} rps={rps} P={P} autos={autos} act={act} />}
      <Upcoming rps={rps} P={P} cur={cur} isHost={isHost} act={act} watchSet={watchSet} mine={mine} />
      <div className="card space-y-2"><h3 className="font-semibold">Teams</h3>{fr.map((f) => <div key={f.id} className="flex items-center gap-2 text-sm">
        <Logo team={f.team} size={22} /><span className="flex-1 truncate">{f.team}{f.is_bot && ' 🤖'}</span>
        <span>{cr(room.purse_lakh - f.spent_lakh)}</span><span className="text-slate-400">{f.squad_count}p · {f.os_count}/{room.max_overseas}os</span></div>)}</div></div>
  </div>);
}

function Table({ rps, P, FR, fr, isHost, act, room }) {
  const [q, setQ] = useState(''), [team, setTeam] = useState(''), [role, setRole] = useState(''), [nat, setNat] = useState(''), [st, setSt] = useState(''), [cat, setCat] = useState(''), [sort, setSort] = useState('seq');
  let rows = rps.map((r) => ({ r, p: P[r.player_id] })).filter(({ p }) => p);
  rows = rows.filter(({ r, p }) => (!q || p.name.toLowerCase().includes(q.toLowerCase())) && (!team || r.sold_to === team) && (!role || p.role === role) &&
    (!nat || (nat === 'India' ? !p.overseas : p.overseas)) && (!cat || p.capped === cat) && (!st || r.status === st));
  const key = { seq: (a) => a.r.seq, price: (a) => -(a.r.sold_lakh || 0), team: (a) => FR[a.r.sold_to]?.team || 'zzz', name: (a) => a.p.name, role: (a) => ROLES.findIndex((x) => x[0] === a.p.role) * 100000 + a.r.seq };
  rows.sort((a, b) => (key[sort](a) > key[sort](b) ? 1 : -1));
  const csv = () => {
    const h = ['Player', 'Role', 'Nationality', 'Category', 'Set', 'Base (L)', 'Sold (L)', 'Bought By', 'Status', 'Time'];
    const body = rows.map(({ r, p }) => [p.name, p.role, p.country, p.capped, p.set_code, r.base_lakh, r.sold_lakh ?? '', FR[r.sold_to]?.team ?? '', r.status.toUpperCase(), r.sold_at ?? ''].map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','));
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([[h.join(','), ...body].join('\n')], { type: 'text/csv' })); a.download = `auction-${room.code}.csv`; a.click();
  };
  const S = ({ v, set, opts, ph }) => <select className="inp w-auto" value={v} onChange={(e) => set(e.target.value)}><option value="">{ph}</option>{opts.map((o) => <option key={o[0]} value={o[0]}>{o[1]}</option>)}</select>;
  return (<div className="card space-y-3"><div className="flex flex-wrap gap-2">
    <input className="inp w-44" placeholder="Search player" value={q} onChange={(e) => setQ(e.target.value)} />
    <S v={team} set={setTeam} ph="All franchises" opts={fr.map((f) => [f.id, f.team])} />
    <S v={role} set={setRole} ph="All roles" opts={['Batter', 'Bowler', 'All-rounder', 'Wicketkeeper'].map((x) => [x, x])} />
    <S v={nat} set={setNat} ph="All nationalities" opts={[['India', 'Indian'], ['OS', 'Overseas']]} />
    <S v={cat} set={setCat} ph="Capped/Uncapped" opts={[['Capped', 'Capped'], ['Uncapped', 'Uncapped']]} />
    <S v={st} set={setSt} ph="All status" opts={[['sold', 'SOLD'], ['unsold', 'UNSOLD'], ['pending', 'PENDING']]} />
    <S v={sort} set={setSort} ph="Auction order" opts={[['role', 'Group by category'], ['price', 'Sort: price'], ['team', 'Sort: team'], ['name', 'Sort: A–Z']]} />
    <button className="btn bg-white/10" onClick={csv}>Export CSV (opens in Excel)</button></div>
    <p className="text-xs text-slate-400">{rows.length} players · base prices are the official IPL 2026 reserve prices</p>
    <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="text-left text-slate-400"><tr>{['Player', 'Role', 'Nationality', 'Cat.', 'Set', 'Base', 'Sold', 'Bought by', 'Status'].map((h) => <th key={h} className="p-2">{h}</th>)}</tr></thead>
      <tbody>{rows.map(({ r, p }) => <tr key={r.id} className="border-t border-white/10"><td className="p-2 font-medium">{p.name}</td><td>{p.role}</td><td>{p.country}</td><td>{p.capped}</td><td>{p.set_code}</td>
        <td>{isHost && r.status === 'pending' ? <button className="underline" onClick={() => { const v = prompt('New base price in lakh', r.base_lakh); v && act('host_set_base', { p_rp: r.id, p_lakh: +v }); }}>{cr(r.base_lakh)}</button> : cr(r.base_lakh)}</td>
        <td>{cr(r.sold_lakh)}</td><td>{FR[r.sold_to]?.team || '—'}</td>
        <td className={r.status === 'sold' ? 'text-green-400' : r.status === 'unsold' ? 'text-red-400' : 'text-slate-400'}>{r.status.toUpperCase()}</td></tr>)}</tbody></table></div></div>);
}

function Squad({ f, room, rps, P }) {
  const sq = rps.filter((r) => r.sold_to === f.id).map((r) => ({ ...r, p: P[r.player_id] }));
  const cnt = (role) => sq.filter((x) => x.p?.role === role).length;
  const top = sq.reduce((m, x) => (x.sold_lakh > (m?.sold_lakh || 0) ? x : m), null);
  return (<div className="card space-y-2" style={{ borderColor: f.color }}>
    <h3 className="flex items-center gap-2 text-xl font-bold" style={{ color: f.color }}><Logo team={f.team} size={32} />{f.team} <span className="text-sm text-slate-400">— {f.owner}</span></h3>
    <div className="grid grid-cols-3 gap-2 text-center text-sm"><div className="rounded bg-black/30 p-2">Purse<br /><b>{cr(room.purse_lakh - f.spent_lakh)}</b></div>
      <div className="rounded bg-black/30 p-2">Spent<br /><b>{cr(f.spent_lakh)}</b></div><div className="rounded bg-black/30 p-2">Avg<br /><b>{sq.length ? cr(Math.round(f.spent_lakh / sq.length)) : '—'}</b></div></div>
    <p className="text-sm text-slate-300">{f.squad_count}/{room.max_squad} players (min {room.min_squad}) · 🇮🇳 {f.squad_count - f.os_count} · ✈ {f.os_count}/{room.max_overseas} · Slots left {room.max_squad - f.squad_count}</p>
    <p className="text-sm text-slate-300">BAT {cnt('Batter')} · BOWL {cnt('Bowler')} · AR {cnt('All-rounder')} · WK {cnt('Wicketkeeper')}{top && ` · Top buy: ${top.p.name} (${cr(top.sold_lakh)})`}</p>
    {ROLES.map(([role, label]) => { const g = sq.filter((x) => x.p?.role === role); return g.length ? <div key={role}>
      <div className="mt-2 flex justify-between border-b border-white/20 pb-1 text-xs font-semibold uppercase tracking-wide text-amber-300"><span>{label}</span><span>{g.length}</span></div>
      <ul className="divide-y divide-white/10 text-sm">{g.map((x) => <li key={x.id} className="flex justify-between py-1"><span>{x.p?.name} <span className="text-slate-400">{x.p?.country}</span></span><b>{cr(x.sold_lakh)}</b></li>)}</ul></div> : null; })}</div>);
}

// ---------- team strength (game estimates, NOT official ratings) ----------
// Player rating comes from the player's base-price tier (+3 if capped). Team scores use the best players per area.
const baseRating = (rp, p) => { const b = rp.base_lakh; const r = b >= 200 ? 90 : b >= 150 ? 80 : b >= 125 ? 75 : b >= 100 ? 70 : b >= 75 ? 62 : b >= 50 ? 52 : b >= 40 ? 46 : 40; return Math.min(99, r + (p.capped === 'Capped' ? 3 : 0)); };
const EXPECT = [[40, 40], [46, 70], [52, 120], [62, 250], [70, 450], [80, 700], [90, 1200], [99, 1700]];   // rating -> typical price (lakh)
const expectedPrice = (r) => { for (let i = 1; i < EXPECT.length; i++) if (r <= EXPECT[i][0]) { const [a, b] = [EXPECT[i - 1], EXPECT[i]]; return a[1] + (b[1] - a[1]) * (r - a[0]) / (b[0] - a[0]); } return EXPECT[EXPECT.length - 1][1]; };
const avgTop = (arr, n, fill = 25) => { const t = [...arr].sort((a, b) => b - a).slice(0, n); while (t.length < n) t.push(fill); return t.reduce((a, b) => a + b, 0) / n; };
function strength(sq, room) {
  const by = (role) => sq.filter((x) => x.p.role === role).map((x) => x.r);
  const bat = avgTop([...by('Batter'), ...by('Wicketkeeper'), ...by('All-rounder').map((r) => r * 0.9)], 6);
  const bowl = avgTop([...by('Bowler'), ...by('All-rounder').map((r) => r * 0.85)], 5);
  const ar = avgTop(by('All-rounder'), 3);
  const keep = by('Wicketkeeper').length ? Math.max(...by('Wicketkeeper')) : 20;
  let bal = 100;
  Object.entries(TARGETS).forEach(([role, t]) => { bal -= Math.max(t - by(role).length, 0) * 8; });
  bal = Math.max(0, bal - Math.max(room.min_squad - sq.length, 0) * 3);
  const overall = bat * 0.30 + bowl * 0.30 + ar * 0.15 + keep * 0.10 + bal * 0.15;
  const grade = overall >= 85 ? 'A+' : overall >= 78 ? 'A' : overall >= 70 ? 'B+' : overall >= 62 ? 'B' : overall >= 52 ? 'C' : 'D';
  return { bat, bowl, ar, keep, bal, overall, grade };
}
const GCOL = { 'A+': 'text-green-400', A: 'text-green-300', 'B+': 'text-amber-300', B: 'text-amber-400', C: 'text-orange-400', D: 'text-red-400' };
const Bar = ({ v, color }) => <div className="h-2 rounded bg-white/10"><div className="h-2 rounded" style={{ width: `${Math.min(100, Math.max(0, v))}%`, background: color }} /></div>;
const METRICS = [['bat', 'Batting'], ['bowl', 'Bowling'], ['ar', 'All-rounders'], ['keep', 'Wicketkeeping'], ['bal', 'Squad balance']];

function Final({ rps, P, FR, fr, room }) {
  const sold = rps.filter((r) => r.status === 'sold');
  const teams = fr.map((f) => {
    const sq = sold.filter((r) => r.sold_to === f.id).map((rp) => ({ rp, p: P[rp.player_id] })).filter((x) => x.p).map((x) => ({ ...x, r: baseRating(x.rp, x.p) }));
    return { f, sq, st: strength(sq, room) };
  }).sort((a, b) => b.st.overall - a.st.overall);
  const deals = sold.map((rp) => { const p = P[rp.player_id]; if (!p) return null; const r = baseRating(rp, p); const e = expectedPrice(r); return { rp, p, r, e, save: e - rp.sold_lakh }; }).filter(Boolean);
  const bestValue = [...deals].filter((d) => d.r >= 62).sort((a, b) => b.save - a.save).slice(0, 3);
  const overpaid = [...deals].sort((a, b) => a.save - b.save).slice(0, 3);
  const top = [...sold].sort((a, b) => b.sold_lakh - a.sold_lakh)[0];
  const spenders = [...fr].sort((a, b) => b.spent_lakh - a.spent_lakh);
  const most = [...fr].sort((a, b) => b.squad_count - a.squad_count)[0];
  const [ia, setIa] = useState(0), [ib, setIb] = useState(1), [busy, setBusy] = useState('');
  const A = teams[ia] || teams[0], B = teams[ib] || teams[1];
  const finished = room.status === 'done' || room.status === 'review';
  const dealName = (d) => `${d.p.name} → ${FR[d.rp.sold_to]?.team} for ${cr(d.rp.sold_lakh)}`;
  const run = async (key, fn) => { setBusy(key); try { await fn(); } catch (e) { alert('Could not create the image: ' + e.message); } setBusy(''); };
  const shareSquad = (t) => run(t.f.id, async () => {
    const blob = await squadImage({ team: t.f.team, owner: t.f.owner, color: t.f.color, isBot: t.f.is_bot, grade: t.st.grade, st: t.st, spent: t.f.spent_lakh, purse: room.purse_lakh - t.f.spent_lakh,
      count: t.f.squad_count, os: t.f.os_count, minSquad: room.min_squad, roomName: room.name, code: room.code, rank: teams.indexOf(t) + 1, teamCount: teams.length,
      players: t.sq.map((x) => ({ name: x.p.name, role: x.p.role, overseas: x.p.overseas, price: x.rp.sold_lakh })) });
    await shareBlob(blob, `${t.f.team.replace(/\s+/g, '-')}-squad.png`, `${t.f.team} squad`);
  });
  const shareBoard = () => run('board', async () => {
    const blob = await leaderboardImage({ roomName: room.name, code: room.code,
      rows: teams.map((t) => ({ team: t.f.team, color: t.f.color, owner: t.f.owner, isBot: t.f.is_bot, count: t.f.squad_count, spent: t.f.spent_lakh, grade: t.st.grade, overall: t.st.overall })),
      extra: [top ? `💰 Most expensive: ${P[top.player_id]?.name} — ${cr(top.sold_lakh)} (${FR[top.sold_to]?.team})` : '', bestValue[0] ? `🏆 Best value buy: ${dealName(bestValue[0])}` : ''].filter(Boolean) });
    await shareBlob(blob, `leaderboard-${room.code}.png`, 'Auction leaderboard');
  });
  const Row = ({ l, v }) => <div className="flex justify-between gap-3 border-b border-white/10 py-2 text-sm"><span className="text-slate-400">{l}</span><b className="text-right">{v}</b></div>;
  return (<div className="space-y-4">
    {!finished && <p className="rounded-lg bg-amber-400/15 p-2 text-center text-sm text-amber-200">Auction still running — grades below are provisional and will change as squads fill up.</p>}
    <div className="card"><div className="mb-2 flex flex-wrap items-center gap-2"><h3 className="text-lg font-bold">🏆 Leaderboard — team strength grades</h3>
      <button disabled={busy === 'board'} onClick={shareBoard} className="btn ml-auto bg-amber-400 py-1 text-sm text-black">{busy === 'board' ? 'Creating…' : '📷 Share leaderboard image'}</button></div>
      <p className="mb-2 text-xs text-slate-400">Grades are <b>game estimates</b> from player base-price tiers and squad balance — not official IPL ratings.</p>
      <div className="space-y-3">{teams.map((t, i) => <div key={t.f.id} className={`rounded-xl p-3 ${i === 0 ? 'bg-amber-400/10 ring-1 ring-amber-300/50' : 'bg-white/5'}`}>
        <div className="flex items-center gap-3"><span className="w-8 text-center text-xl font-black text-amber-300">{i === 0 ? '👑' : `#${i + 1}`}</span><Logo team={t.f.team} size={38} />
          <div className="min-w-0 flex-1"><div className="truncate font-semibold">{t.f.team}{t.f.is_bot ? ' 🤖' : ''}</div><div className="text-xs text-slate-400">{t.f.owner} · {t.f.squad_count} players · spent {cr(t.f.spent_lakh)}</div></div>
          <div className="text-right"><div className={`text-3xl font-black ${GCOL[t.st.grade]}`}>{t.st.grade}</div><div className="text-xs text-slate-400">{Math.round(t.st.overall)}/100</div></div></div>
        <div className="mt-2 grid grid-cols-5 gap-2 text-center text-[11px] text-slate-400">{METRICS.map(([k, l]) => <div key={k}><Bar v={t.st[k]} color={t.f.color} />{l} {Math.round(t.st[k])}</div>)}</div>
        <div className="mt-2 text-right"><button disabled={busy === t.f.id} onClick={() => shareSquad(t)} className="btn bg-white/10 py-1 text-xs">{busy === t.f.id ? 'Creating…' : '📷 Share squad image'}</button></div></div>)}</div></div>
    <div className="grid gap-4 md:grid-cols-2">
      <div className="card"><h3 className="mb-2 text-lg font-bold">🏅 Awards</h3>
        <Row l="Most expensive player" v={top ? `${P[top.player_id]?.name} — ${cr(top.sold_lakh)} (${FR[top.sold_to]?.team})` : '—'} />
        <Row l="Best value buy" v={bestValue[0] ? dealName(bestValue[0]) : '—'} />
        <Row l="Biggest overpay" v={overpaid[0] && overpaid[0].save < 0 ? dealName(overpaid[0]) : '—'} />
        <Row l="Highest spender" v={spenders[0] ? `${spenders[0].team} (${cr(spenders[0].spent_lakh)})` : '—'} />
        <Row l="Lowest spender" v={spenders.length ? `${spenders.at(-1).team} (${cr(spenders.at(-1).spent_lakh)})` : '—'} />
        <Row l="Most purchases" v={most ? `${most.team} (${most.squad_count})` : '—'} />
        <Row l="Total spent" v={cr(fr.reduce((a, f) => a + f.spent_lakh, 0))} />
        <Row l="Sold / Unsold / Remaining" v={`${sold.length} / ${rps.filter((r) => r.status === 'unsold').length} / ${rps.filter((r) => r.status === 'pending').length}`} />
        {bestValue.length > 1 && <p className="pt-2 text-xs text-slate-400">Other bargains: {bestValue.slice(1).map(dealName).join(' · ')}</p>}
        <p className="pt-1 text-xs text-slate-500">“Value” compares the price paid with a typical price for that player’s rating tier (an estimate).</p></div>
      <div className="card"><h3 className="mb-2 text-lg font-bold">⚔ Compare two teams</h3>
        {teams.length < 2 ? <p className="text-sm text-slate-400">Need two teams.</p> : <>
          <div className="mb-3 grid grid-cols-2 gap-2"><select className="inp" value={ia} onChange={(e) => setIa(+e.target.value)}>{teams.map((t, i) => <option key={t.f.id} value={i}>{t.f.team}</option>)}</select>
            <select className="inp" value={ib} onChange={(e) => setIb(+e.target.value)}>{teams.map((t, i) => <option key={t.f.id} value={i}>{t.f.team}</option>)}</select></div>
          {METRICS.map(([k, l]) => <div key={k} className="mb-2 text-xs"><div className="mb-1 flex justify-between"><b>{Math.round(A.st[k])}</b><span className="text-slate-400">{l}</span><b>{Math.round(B.st[k])}</b></div>
            <div className="grid grid-cols-2 gap-1"><div className="rotate-180"><Bar v={A.st[k]} color={A.f.color} /></div><Bar v={B.st[k]} color={B.f.color} /></div></div>)}
          <div className="mt-2 flex justify-between text-sm font-bold"><span className={GCOL[A.st.grade]}>{A.f.team}: {A.st.grade}</span><span className={GCOL[B.st.grade]}>{B.f.team}: {B.st.grade}</span></div></>}</div></div>
    <div className="card"><h3 className="mb-2 text-lg font-bold">Spending by franchise</h3>{spenders.map((f) => <div key={f.id} className="mb-2 text-sm"><div className="flex justify-between"><span>{f.team}</span><span>{cr(f.spent_lakh)}</span></div>
      <div className="h-2 rounded bg-white/10"><div className="h-2 rounded" style={{ width: `${(f.spent_lakh / room.purse_lakh) * 100}%`, background: f.color }} /></div></div>)}</div>
  </div>);
}
