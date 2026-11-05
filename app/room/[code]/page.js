'use client';
import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { sb, ensureUser, cr, setLabel } from '../../../lib/supabase';
import { Logo } from '../../components';

const inc = (c) => (c < 100 ? 5 : c < 200 ? 10 : c < 500 ? 20 : 25);
const photoCache = {};
function Photo({ name, size = 96 }) {
  const [src, setSrc] = useState(photoCache[name]);
  useEffect(() => {
    if (photoCache[name] !== undefined) { setSrc(photoCache[name]); return; }
    let dead = false;
    fetch('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(name.replace(/ /g, '_')))
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { const ok = j && /cricket/i.test(j.description || '') && j.thumbnail && j.thumbnail.source; photoCache[name] = ok ? j.thumbnail.source : null; if (!dead) setSrc(photoCache[name]); })
      .catch(() => { photoCache[name] = null; });
    return () => { dead = true; };
  }, [name]);
  const initials = name.split(' ').map((w) => w[0]).slice(0, 2).join('');
  const box = { width: size, height: size };
  return src ? <img src={src} alt={name} referrerPolicy="no-referrer" style={box} className="shrink-0 rounded-2xl bg-white/10 object-cover object-top" />
    : <div style={box} className="grid shrink-0 place-items-center rounded-2xl bg-white/10 font-bold text-amber-300">{initials}</div>;
}
const ROLES = [['Batter', 'Batters'], ['Wicketkeeper', 'Wicketkeepers'], ['All-rounder', 'All-rounders'], ['Bowler', 'Bowlers']];
function Upcoming({ rps, P, cur, isHost, act }) {
  const [role, setRole] = useState(null);
  const active = role || P[cur?.player_id]?.role || 'Batter';
  const pend = rps.filter((x) => x.status === 'pending' || x.status === 'live');
  const by = (r) => pend.filter((x) => P[x.player_id]?.role === r);
  const total = (r) => rps.filter((x) => P[x.player_id]?.role === r).length;
  const list = by(active).slice(0, 15);
  return (<div className="card"><h3 className="mb-2 font-semibold">Coming up by category <span className="text-xs font-normal text-slate-400">(remaining/total)</span></h3>
    <div className="mb-2 flex flex-wrap gap-1">{ROLES.map(([r, l]) => <button key={r} onClick={() => setRole(r)} className={`rounded-full px-2 py-1 text-xs ${active === r ? 'bg-amber-400 text-black' : 'bg-white/10'}`}>{l} {by(r).length}/{total(r)}</button>)}</div>
    <ul className="max-h-56 divide-y divide-white/10 overflow-y-auto text-sm">{list.map((x) => { const p = P[x.player_id]; return <li key={x.id} className="flex justify-between py-1"><span>{p?.name} <span className="text-slate-400">{p?.country}</span></span><span className="flex items-center gap-2">{cr(x.base_lakh)}{isHost && x.status === 'pending' && <button title="Bots sit out this player" onClick={() => act('host_bots_skip', { p_rp: x.id, p_skip: !x.bots_skip })} className={`rounded px-1 text-xs ${x.bots_skip ? 'bg-red-500/70' : 'bg-white/10'}`}>{x.bots_skip ? '🚫🤖' : '🤖'}</button>}</span></li>; })}
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
  const [fr, setFr] = useState([]), [rps, setRps] = useState([]), [bids, setBids] = useState([]), [P, setP] = useState({});
  const [pin, setPin] = useState(null);
  const [tab, setTab] = useState('Live'), [msg, setMsg] = useState(''), [now, setNow] = useState(Date.now()), [err, setErr] = useState('');

  const load = useCallback(async (id) => {
    const [r, f, p, b] = await Promise.all([
      sb.from('rooms').select('*').eq('id', id).maybeSingle(),
      sb.from('franchises').select('*').eq('room_id', id).order('created_at'),
      sb.from('room_players').select('*').eq('room_id', id).order('seq').limit(1000),
      sb.from('bids').select('*').eq('room_id', id).order('id', { ascending: false }).limit(300)]);
    setRoom(r.data); setFr(f.data || []); setRps(p.data || []); setBids(b.data || []);
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
  const soundRef = useRef(true), seenSale = useRef(null), lastSec = useRef(null), lastBid = useRef(null), momentTimer = useRef(null);
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
    if (v) { unlockAudio(); sfx.bid(); }
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
  useEffect(() => {   // beeps for the last 5 seconds
    if (room?.status !== 'live' || !room.ends_at) { lastSec.current = null; return; }
    const s = Math.ceil(left / 1000);
    if (s !== lastSec.current) { lastSec.current = s; if (s >= 1 && s <= 5) play(s === 1 ? 'beepHi' : 'beep'); }
  }, [left, room?.status, room?.ends_at]);
  useEffect(() => {   // soft tick when a new bid arrives
    if (!room) return;
    const id = bids[0] ? bids[0].id : 0;
    if (lastBid.current === null) { lastBid.current = id; return; }
    if (id > lastBid.current) { lastBid.current = id; play('bid'); }
  }, [bids, room]);

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
      <h1 className="text-xl font-bold mr-auto">{room.name} <span className="text-sm text-slate-400">#{room.code} · {room.status.toUpperCase()}</span></h1>
      <button onClick={toggleSound} className="btn bg-white/10 text-sm">{sound ? '🔊 Sound ON' : '🔇 Sound OFF'}</button>
      {room.status !== 'lobby' && <span className="rounded-full bg-white/10 px-2 py-1 text-xs">🤖 Bots {room.fill_bots ? 'ON' : 'OFF'}</span>}
      {mine && pin && <PinBadge pin={pin} />}
      {TABS.map((t) => <button key={t} onClick={() => setTab(t)} className={`btn text-sm ${tab === t ? 'bg-amber-400 text-black' : 'bg-white/10'}`}>{t}</button>)}
    </div>
    {msg && <p className="rounded-lg bg-red-500/20 p-2 text-sm">{msg}</p>}
    {!mine && <p className="rounded-lg bg-white/10 p-2 text-sm">You are watching as a spectator. Are you a player? <a className="text-amber-400 underline" href={`/rejoin?code=${code}`}>Rejoin with your PIN</a></p>}
    {tab === 'Live' && <Live {...{ room, cur, left, P, FR, fr, rps, bids, mine, isHost, act }} />}
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

function Live({ room, cur, left, P, FR, fr, rps, bids, mine, isHost, act }) {
  const p = cur && P[cur.player_id];
  const recent = [...rps].filter((x) => x.sold_at).sort((a, b) => new Date(b.sold_at) - new Date(a.sold_at)).slice(0, 6);
  const last = recent[0];
  const next = !cur ? 0 : room.cur_bidder ? room.cur_bid + inc(room.cur_bid) : cur.base_lakh;
  const done = rps.filter((x) => x.status === 'sold' || x.status === 'unsold').length;
  const total = rps.length, sold = rps.filter((x) => x.status === 'sold').length;
  const myBids = bids.filter((b) => cur && b.rp_id === cur.id);
  return (<div className="grid gap-4 lg:grid-cols-3">
    <div className="lg:col-span-2 space-y-4">
      {last && <div key={last.id} className="pop flex items-center justify-center gap-3 rounded-xl p-3 text-center font-bold" style={{ background: last.status === 'sold' ? '#16a34a55' : '#dc262655' }}><Photo name={P[last.player_id]?.name || '?'} size={56} />
        {last.status === 'sold' ? `🔨 SOLD! ${P[last.player_id]?.name} → ${FR[last.sold_to]?.team} for ${cr(last.sold_lakh)}` : `❌ UNSOLD: ${P[last.player_id]?.name}`}</div>}
      {p ? <div className="card pop" key={cur.id}>
        <div className="flex flex-wrap items-center gap-4">
          <Photo name={p.name} />
          <div className="flex-1"><h2 className="text-3xl font-extrabold">{p.name}</h2>
            <p className="text-slate-300"><span className="mr-2 rounded bg-amber-400 px-2 py-0.5 text-xs font-bold text-black">{p.role.toUpperCase()}</span>{p.country} · {p.capped} · {p.bat}{p.bowl ? ` · ${p.bowl}` : ''}</p>
            <p className="text-xs text-slate-400">{setLabel(p.set_code)} · {p.retained ? `Retained by ${p.ipl_team_2025} · custom base ${cr(cur.base_lakh)} (not official)` : `IPL 2025: ${p.ipl_team_2025 || '—'} · Base ${cr(cur.base_lakh)} (official reserve price)`}</p></div>
          <div className={`text-5xl font-black tabular-nums ${left < 5000 ? 'text-red-400' : 'text-amber-400'}`}>{Math.ceil(left / 1000)}s</div></div>
        <div className="mt-4 grid grid-cols-2 gap-3 text-center">
          <div className="rounded-xl bg-black/30 p-3"><div className="text-xs text-slate-400">CURRENT BID</div><div className="text-3xl font-bold">{room.cur_bidder ? cr(room.cur_bid) : 'No bids'}</div></div>
          <div className="rounded-xl bg-black/30 p-3" style={{ borderBottom: `4px solid ${FR[room.cur_bidder]?.color || 'transparent'}` }}><div className="text-xs text-slate-400">HIGHEST BIDDER</div><div className="flex items-center justify-center gap-2 text-xl font-bold">{room.cur_bidder && <Logo team={FR[room.cur_bidder]?.team} size={32} />}{FR[room.cur_bidder]?.team || '—'}</div></div></div>
        {mine && room.status === 'live' && <div className="mt-4 flex gap-3">
          <button disabled={room.cur_bidder === mine.id} onClick={() => act('bid', { p_amount: next })} className="btn flex-1 bg-amber-400 py-4 text-xl text-black">BID {cr(next)}</button>
          <button onClick={() => act('pass')} className="btn bg-white/10 py-4">PASS</button></div>}
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
      <Upcoming rps={rps} P={P} cur={cur} isHost={isHost} act={act} />
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

function Final({ rps, P, FR, fr, room }) {
  const sold = rps.filter((r) => r.status === 'sold');
  const top = [...sold].sort((a, b) => b.sold_lakh - a.sold_lakh)[0];
  const by = [...fr].sort((a, b) => b.spent_lakh - a.spent_lakh);
  const most = [...fr].sort((a, b) => b.squad_count - a.squad_count)[0];
  const Row = ({ l, v }) => <div className="flex justify-between border-b border-white/10 py-2"><span className="text-slate-400">{l}</span><b>{v}</b></div>;
  return (<div className="grid gap-4 md:grid-cols-2"><div className="card"><h3 className="mb-2 text-lg font-bold">Auction summary</h3>
    <Row l="Most expensive player" v={top ? `${P[top.player_id]?.name} — ${cr(top.sold_lakh)} (${FR[top.sold_to]?.team})` : '—'} />
    <Row l="Highest spender" v={by[0] ? `${by[0].team} (${cr(by[0].spent_lakh)})` : '—'} />
    <Row l="Lowest spender" v={by.length ? `${by.at(-1).team} (${cr(by.at(-1).spent_lakh)})` : '—'} />
    <Row l="Most purchases" v={most ? `${most.team} (${most.squad_count})` : '—'} />
    <Row l="Total spent" v={cr(fr.reduce((s, f) => s + f.spent_lakh, 0))} /><Row l="Sold / Unsold / Remaining" v={`${sold.length} / ${rps.filter((r) => r.status === 'unsold').length} / ${rps.filter((r) => r.status === 'pending').length}`} /></div>
    <div className="card"><h3 className="mb-2 text-lg font-bold">Spending by franchise</h3>{by.map((f) => <div key={f.id} className="mb-2 text-sm"><div className="flex justify-between"><span>{f.team}</span><span>{cr(f.spent_lakh)}</span></div>
      <div className="h-2 rounded bg-white/10"><div className="h-2 rounded" style={{ width: `${(f.spent_lakh / room.purse_lakh) * 100}%`, background: f.color }} /></div></div>)}</div></div>);
}
