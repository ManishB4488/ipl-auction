'use client';
// "Arena" tab: play a T20 match, over by over, with your own squad against a friend or a bot.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { sb } from '../lib/supabase';
import { Logo } from './components';
import { prepTeams } from './league';
import { strength } from './leaguesim';
import { advance, newMatchState, makeSide, oversText, chaseInfo, MAX_BOWL_BALLS, OVERS, bowlSkill } from './matchengine';

const SHORT = { Batter: 'BAT', Wicketkeeper: 'WK', 'All-rounder': 'AR', Bowler: 'BOWL' };
const LIST_COLS = 'id,fa,fb,status,winner,created_at,ver,result:state->result';
const tokCls = (t) => (t === 'W' ? 'bg-red-500' : t === '4' ? 'bg-sky-500' : t === '6' ? 'bg-purple-500' : t === 'Wd' ? 'bg-amber-600' : 'bg-white/15');
const Tok = ({ t }) => <span className={`inline-grid h-6 min-w-[1.5rem] place-items-center rounded-full px-1 text-xs font-bold ${tokCls(t)}`}>{t}</span>;

export function MatchTab({ fr, lus, rps, P, room, mine }) {
  const [list, setList] = useState(null), [cur, setCur] = useState(null), [openId, setOpenId] = useState(null), [skip, setSkip] = useState(null), [msg, setMsg] = useState(''), [now, setNow] = useState(Date.now());
  const busy = useRef(false);
  const done = room.status === 'done';
  const teams = useMemo(() => (done ? prepTeams(fr, lus, rps, P) : []), [done, fr, lus, rps, P]);
  const FR = useMemo(() => Object.fromEntries(fr.map((f) => [f.id, f])), [fr]);

  const loadList = useCallback(async () => {
    const { data, error } = await sb.from('matches').select(LIST_COLS).eq('room_id', room.id).order('created_at', { ascending: false });
    if (error) { setMsg(error.message.includes('matches') ? 'Run supabase/update_match.sql in Supabase first.' : error.message); setList([]); } else setList(data || []);
  }, [room.id]);
  const loadCur = useCallback(async () => {
    if (!openId) { setCur(null); return; }
    const { data } = await sb.from('matches').select('*').eq('id', openId).maybeSingle();
    if (data) setCur(data);
  }, [openId]);

  useEffect(() => { if (!done) return; loadList(); const id = setInterval(loadList, 3000); return () => clearInterval(id); }, [done, loadList]);
  useEffect(() => { loadCur(); if (!openId) return; const id = setInterval(loadCur, 1500); return () => clearInterval(id); }, [openId, loadCur]);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);

  const myActive = useMemo(() => (list || []).find((m) => (m.status === 'pending' || m.status === 'playing') && mine && (m.fa === mine.id || m.fb === mine.id)), [list, mine]);
  useEffect(() => { if (myActive && !openId && myActive.status === 'playing' && myActive.id !== skip) setOpenId(myActive.id); }, [myActive, openId, skip]);

  // a participant's browser applies the next state when both sides have chosen (or the clock ran out). Deterministic, so both browsers agree.
  useEffect(() => {
    if (!cur || !mine || cur.status !== 'playing' || busy.current) return;
    if (cur.fa !== mine.id && cur.fb !== mine.id) return;
    const nx = advance(cur.state, Date.now()); if (!nx) return;
    busy.current = true;
    (async () => { await sb.rpc('match_apply', { p_match: cur.id, p_ver: cur.ver, p_state: nx }); await loadCur(); await loadList(); busy.current = false; })();
  }, [cur, now]);

  if (!done) return <div className="card text-center"><h2 className="font-display text-3xl font-extrabold uppercase">⚔️ Match Arena</h2>
    <p className="mt-2 text-slate-300">When the auction ends you can challenge a friend (or a bot) and play a T20 match over by over with your own XI, captain and backups.</p></div>;
  if (!mine) return <p className="card">Only players with a team can play matches.</p>;

  const challenge = async (opp) => {
    setMsg('');
    const tA = teams.find((t) => t.id === mine.id), tB = teams.find((t) => t.id === opp.id);
    const st = newMatchState({ seed: (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)), A: makeSide(tA), B: makeSide(tB) });
    const { data, error } = await sb.rpc('match_create', { p_room: room.id, p_opp: opp.id, p_state: st });
    if (error || !String(data).startsWith('ok:')) { setMsg(error?.message || data); return; }
    if (opp.is_bot) setOpenId(data.slice(3));
    loadList();
  };
  const respond = async (m, accept) => { const { data, error } = await sb.rpc('match_respond', { p_match: m.id, p_accept: accept }); if (error || data !== 'ok') setMsg(error?.message || data); else { if (accept) setOpenId(m.id); loadList(); } };

  if (openId && cur && cur.id === openId) return <MatchView {...{ m: cur, mine, FR, now, back: () => { setSkip(openId); setOpenId(null); setCur(null); loadList(); }, reload: async () => { await loadCur(); await loadList(); }, setMsg, msg }} />;

  const incoming = (list || []).filter((m) => m.status === 'pending' && m.fb === mine.id);
  const outgoing = (list || []).filter((m) => m.status === 'pending' && m.fa === mine.id);
  const live = (list || []).filter((m) => m.status === 'playing');
  const fin = (list || []).filter((m) => m.status === 'done');
  const wins = {}, played = {};
  fin.forEach((m) => { [m.fa, m.fb].forEach((x) => { played[x] = (played[x] || 0) + 1; }); if (m.winner) wins[m.winner] = (wins[m.winner] || 0) + 1; });
  const board = fr.filter((f) => played[f.id]).map((f) => ({ f, w: wins[f.id] || 0, p: played[f.id] })).sort((a, b) => b.w - a.w || a.p - b.p);
  const busyHuman = (id) => (list || []).some((m) => (m.status === 'pending' || m.status === 'playing') && (m.fa === id || m.fb === id));
  const strengthOf = (id) => { const t = teams.find((x) => x.id === id); return t ? strength(t.xi, t).overall : 0; };

  return (<div className="space-y-4">
    <div className="card space-y-2"><h2 className="font-display text-3xl font-extrabold uppercase">⚔️ Match Arena</h2>
      <p className="text-sm text-slate-300">Play a 20-over match with your own squad. Every over <b>both captains lock in a decision</b>: the batting side picks <b>Defend / Normal / Attack</b>, the bowling side picks <b>who bowls</b> (max 4 overs each, not two in a row). Once per match you can bring in an <b>Impact Player</b> from your backups. If you take more than 30 seconds the AI decides for you. Bots accept instantly.</p>
      {msg && <p className="rounded bg-red-500/20 p-2 text-sm text-red-200">{msg}</p>}</div>

    {incoming.map((m) => <div key={m.id} className="card flex flex-wrap items-center gap-2 border-amber-400"><span className="mr-auto">⚔️ <b style={{ color: FR[m.fa]?.color }}>{FR[m.fa]?.team}</b> ({FR[m.fa]?.owner}) challenged you!</span>
      <button className="btn bg-green-500 py-1 text-black" onClick={() => respond(m, true)}>Accept</button><button className="btn bg-white/10 py-1" onClick={() => respond(m, false)}>Decline</button></div>)}
    {outgoing.map((m) => <div key={m.id} className="card flex flex-wrap items-center gap-2"><span className="mr-auto">⏳ Waiting for <b>{FR[m.fb]?.team}</b> to accept…</span><button className="btn bg-white/10 py-1" onClick={() => respond(m, false)}>Cancel</button></div>)}
    {myActive && myActive.status === 'playing' && <div className="card flex items-center gap-2 border-green-500"><span className="mr-auto">🏏 Your match vs <b>{FR[myActive.fa === mine.id ? myActive.fb : myActive.fa]?.team}</b> is in progress</span><button className="btn bg-green-500 py-1 text-black" onClick={() => { setSkip(null); setOpenId(myActive.id); }}>Resume</button></div>}

    <div className="card space-y-2"><h3 className="font-display text-xl uppercase tracking-wide">Choose your opponent</h3>
      {fr.filter((f) => f.id !== mine.id).map((f) => { const human = !f.is_bot, taken = human && busyHuman(f.id); return (
        <div key={f.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-white/10 bg-black/20 p-2" style={{ borderLeft: `4px solid ${f.color}` }}>
          <Logo team={f.team} size={30} /><span className="mr-auto"><b>{f.team}</b> <span className="text-xs text-slate-400">{f.owner}{f.is_bot ? ' · 🤖 bot (accepts instantly)' : ''}</span></span>
          <span className="text-xs text-slate-400">Strength <b className="text-white">{strengthOf(f.id).toFixed(0)}</b></span>
          <button disabled={!!myActive || taken} onClick={() => challenge(f)} className="btn bg-amber-400 py-1 text-black">{taken ? 'In a match' : '⚔ Challenge'}</button></div>); })}
      <p className="text-xs text-slate-400">Your strength: <b className="text-white">{strengthOf(mine.id).toFixed(0)}</b> (from your current XI). Unlocked or missing XIs are auto-completed.</p></div>

    {live.filter((m) => m.fa !== mine.id && m.fb !== mine.id).length > 0 && <div className="card space-y-1"><h3 className="font-display text-xl uppercase tracking-wide">Live now</h3>
      {live.filter((m) => m.fa !== mine.id && m.fb !== mine.id).map((m) => <div key={m.id} className="flex items-center gap-2 text-sm"><span className="mr-auto">{FR[m.fa]?.team} vs {FR[m.fb]?.team}</span><button className="btn bg-white/10 py-1" onClick={() => setOpenId(m.id)}>👀 Watch</button></div>)}</div>}

    {board.length > 0 && <div className="grid gap-4 md:grid-cols-2">
      <div className="card"><h3 className="mb-1 font-display text-xl uppercase tracking-wide">Arena standings</h3>{board.map(({ f, w, p }, i) => <div key={f.id} className="flex items-center gap-2 border-b border-white/5 py-1 text-sm"><span className="w-5 text-slate-500">{i + 1}</span><Logo team={f.team} size={20} /><span className="flex-1">{f.team}</span><b>{w}W</b><span className="text-xs text-slate-400">{p - w}L</span></div>)}</div>
      <div className="card"><h3 className="mb-1 font-display text-xl uppercase tracking-wide">Recent results</h3>{fin.slice(0, 8).map((m) => <button key={m.id} onClick={() => setOpenId(m.id)} className="block w-full border-b border-white/5 py-1 text-left text-sm hover:bg-white/5"><span className="text-xs text-slate-400">{FR[m.fa]?.team} vs {FR[m.fb]?.team}</span><br />{m.result?.text}</button>)}</div></div>}
  </div>);
}

// ---------------------------------------------------------------- one match
export function MatchView({ m, mine, FR, now, back, reload, setMsg, msg }) {
  const S = m.state, mySide = mine.id === m.fa ? 'A' : mine.id === m.fb ? 'B' : null;
  const [tab, setTab] = useState('live'), [intent, setIntent] = useState('normal'), [bowler, setBowler] = useState(null), [impOpen, setImpOpen] = useState(false), [imp, setImp] = useState({ out: '', in: '' }), [sending, setSending] = useState(false);
  useEffect(() => { setIntent('normal'); setBowler(null); setImpOpen(false); setImp({ out: '', in: '' }); }, [S.key]);
  const bits = useMemo(() => Array.from({ length: 36 }, (_, i) => ({ left: Math.random() * 100, delay: Math.random() * 1.5, dur: 2.5 + Math.random() * 2, color: ['#ff8a1f', '#fbbf24', '#3b82f6', '#22c55e', '#f43f5e'][i % 5] })), []);

  const inn = S.innings[S.inn - 1];
  const secs = S.deadline ? Math.max(0, Math.ceil((S.deadline - now) / 1000)) : null;
  const sideTeam = (x) => S.sides[x];
  const score = (x) => { const i = S.innings.find((v) => v.bat === x); return i ? `${i.runs}/${i.wkts}` : '—'; };
  const ovr = (x) => { const i = S.innings.find((v) => v.bat === x); return i ? oversText(i.balls) : ''; };
  const send = async (choice) => {
    setSending(true); setMsg('');
    const { data, error } = await sb.rpc('match_choose', { p_match: m.id, p_key: S.key, p_choice: choice });
    setSending(false);
    if (error) setMsg(error.message); else if (data !== 'ok') setMsg(data === 'stale' ? 'That over has already been played.' : data);
    reload();
  };
  const sd = mySide ? S.sides[mySide] : null;
  const myChoice = mySide ? S.choices[mySide] : null;
  const impactChoice = impOpen && imp.out !== '' && imp.in !== '' ? { impact: { out: +imp.out, in: +imp.in } } : {};
  const Header = (<div className="card" style={{ background: 'linear-gradient(90deg, rgba(27,75,214,.25), rgba(10,18,48,.6))' }}>
    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-center">
      {['A', 'B'].map((x, k) => { const t = sideTeam(x); return (<div key={x} className={k ? 'order-3' : ''}><div className="flex items-center justify-center gap-2"><Logo team={t.team} size={34} /><b className="font-display text-xl uppercase" style={{ color: t.color }}>{t.team}</b></div>
        <div className="score text-4xl font-extrabold">{score(x)}</div><div className="text-xs text-slate-400">{ovr(x) && `(${ovr(x)} ov)`}{mySide === x ? ' · YOU' : ''}</div></div>); })}
      <div className="order-2 font-display text-2xl text-amber-400">VS</div></div></div>);

  const Back = <button onClick={back} className="btn bg-white/10 py-1 text-sm">← Arena</button>;

  // ---- finished
  if (S.status === 'finished') {
    const won = S.result.fid === mine.id;
    return (<div className="space-y-4"><div>{Back}</div>{won && bits.map((b, i) => <span key={i} className="confetti" style={{ left: `${b.left}%`, animationDelay: `${b.delay}s`, animationDuration: `${b.dur}s`, background: b.color }} />)}
      {Header}
      <div className="card pop text-center" style={{ borderColor: S.sides[S.result.side].color, background: `linear-gradient(135deg, ${S.sides[S.result.side].color}55, rgba(10,18,48,.8))` }}>
        <p className="font-display text-sm font-bold uppercase tracking-[.4em] text-amber-300">{mySide ? (won ? '🏆 You won!' : 'You lost') : 'Match over'}</p>
        <h2 className="font-display text-4xl font-extrabold uppercase" style={{ color: S.sides[S.result.side].color }}>{S.result.text}</h2>
        {S.result.potm && <p className="mt-1 text-slate-200">⭐ Player of the match: <b>{S.result.potm.name}</b> ({S.result.potm.line}) — {S.result.potm.team}</p>}</div>
      <Scorecards S={S} /></div>);
  }

  // ---- toss
  if (S.status === 'toss') {
    const w = S.toss.winner, iWon = mySide === w;
    return (<div className="space-y-4"><div>{Back}</div>{Header}
      <div className="card space-y-3 text-center"><h3 className="font-display text-3xl font-extrabold uppercase">🪙 {S.sides[w].team} won the toss</h3>
        {iWon ? (S.choices[w] ? <p>Choice locked ✓ — starting…</p> : <div className="flex justify-center gap-3"><button disabled={sending} onClick={() => send({ elect: 'bat' })} className="btn bg-amber-400 px-8 py-3 font-display text-2xl uppercase text-black">🏏 Bat first</button><button disabled={sending} onClick={() => send({ elect: 'bowl' })} className="btn bg-white/15 px-8 py-3 font-display text-2xl uppercase">🎯 Bowl first</button></div>)
          : <p className="text-slate-300">Waiting for {S.sides[w].team} to choose…</p>}
        {secs != null && <p className="text-xs text-slate-400">Auto-decides in {secs}s</p>}{msg && <p className="text-sm text-red-300">{msg}</p>}</div></div>);
  }

  // ---- playing
  const batSide = inn.bat, bowlSide = inn.bowl, bT = S.sides[batSide], wT = S.sides[bowlSide];
  const ci = chaseInfo(S), crr = inn.balls ? (inn.runs / inn.balls) * 6 : 0;
  const last = inn.overs[inn.overs.length - 1];
  const imBat = mySide === batSide, imBowl = mySide === bowlSide;
  const canImpact = sd && !sd.impactUsed && sd.bench.length > 0;
  const unusedXI = sd ? sd.xi.map((p, i) => ({ p, i })).filter(({ i }) => !sd.used[i]) : [];
  const bowlerRows = imBowl ? wT.xi.map((p, i) => ({ p, i, b: inn.bowlers[i]?.b || 0, sk: bowlSkill(S, bowlSide, i) })) : [];
  const bestBowler = bowlerRows.filter((x) => x.b < MAX_BOWL_BALLS && x.i !== inn.last).sort((a, b) => b.sk - a.sk)[0]?.i;
  const chosenBowler = bowler ?? bestBowler;
  const waiting = myChoice && <p className="rounded bg-green-600/20 p-2 text-center text-sm">✅ Locked in — waiting for the other side… {secs != null && <span className="text-slate-300">({secs}s)</span>}</p>;

  return (<div className="space-y-4"><div>{Back}</div>{Header}
    <div className="flex gap-2">{[['live', 'Live'], ['card', 'Scorecard'], ['overs', 'Overs']].map(([k, l]) => <button key={k} onClick={() => setTab(k)} className={`tab-pill ${tab === k ? 'tab-on' : ''}`}>{l}</button>)}</div>
    {tab === 'card' && <Scorecards S={S} />}
    {tab === 'overs' && <OverList S={S} />}
    {tab === 'live' && <>
      <div className="card space-y-2 spot" style={{ '--glow': bT.color }}>
        <div className="flex flex-wrap items-center gap-2"><b className="font-display text-2xl uppercase" style={{ color: bT.color }}>{bT.team}</b><span className="score text-3xl font-extrabold">{inn.runs}/{inn.wkts}</span><span className="text-slate-300">({oversText(inn.balls)} ov)</span>
          <span className="ml-auto text-sm text-slate-300">CRR {crr.toFixed(2)}</span></div>
        {ci ? <p className="rounded bg-amber-400/15 p-2 text-sm text-amber-100">🎯 Need <b>{ci.need}</b> off <b>{ci.left}</b> balls · RRR <b>{ci.rrr.toFixed(2)}</b></p> : <p className="text-sm text-slate-400">Innings 1 · {OVERS} overs</p>}
        <div className="grid gap-2 sm:grid-cols-2 text-sm">
          {[inn.striker, inn.non].map((i, k) => { const b = inn.batters[i]; return <div key={i} className="stat-tile flex justify-between"><span>{b.n}{k === 0 ? ' *' : ''}</span><b>{b.r} <span className="text-xs text-slate-400">({b.b})</span></b></div>; })}</div>
        {last && <div className="flex flex-wrap items-center gap-1 text-xs text-slate-300">Last over ({last.bowler}, {last.runs} runs{last.w ? `, ${last.w} wkt` : ''}): {last.tok.map((t, i) => <Tok key={i} t={t} />)}</div>}
        {S.log.slice(-3).map((l, i) => <p key={i} className="text-xs text-slate-400">{l}</p>)}</div>

      {mySide ? (<div className="card space-y-3"><div className="flex items-center gap-2"><h3 className="mr-auto font-display text-2xl uppercase tracking-wide">Over {inn.over + 1} — {imBat ? 'you are batting' : 'you are bowling'}</h3>{secs != null && <span className={`score text-2xl font-bold ${secs <= 8 ? 'text-red-400' : 'text-amber-400'}`}>{secs}s</span>}</div>
        {myChoice ? waiting : <>
          {imBat && <div className="grid gap-2 sm:grid-cols-3">{[['defend', '🛡 Defend', 'Fewer boundaries, fewer wickets'], ['normal', '🏏 Normal', 'Balanced'], ['attack', '🔥 Attack', 'More runs, more wickets risk']].map(([k, l, d]) => <button key={k} onClick={() => setIntent(k)} className={`rounded-xl border p-3 text-left ${intent === k ? 'border-amber-400 bg-amber-400/15' : 'border-white/10 bg-black/20'}`}><b className="font-display text-xl uppercase">{l}</b><br /><span className="text-xs text-slate-400">{d}</span></button>)}</div>}
          {imBowl && <div className="space-y-1"><p className="text-xs text-slate-400">Pick the bowler for this over (max {MAX_BOWL_BALLS / 6} overs each, not two in a row). Skill = rating × bowling ability — batters bowl badly.</p>
            {bowlerRows.map(({ p, i, b, sk }) => { const off = b >= MAX_BOWL_BALLS || i === inn.last; return <button key={i} disabled={off} onClick={() => setBowler(i)} className={`flex w-full items-center gap-2 rounded-lg border p-2 text-left text-sm disabled:opacity-35 ${chosenBowler === i ? 'border-amber-400 bg-amber-400/15' : 'border-white/10 bg-black/20'}`}>
              <span className="w-6 text-slate-500">{i + 1}</span><span className="flex-1">{p.name} <span className="text-xs text-slate-400">{SHORT[p.role]}{p.ovs ? ' ✈' : ''}</span>{i === inn.last && <span className="ml-1 text-xs text-slate-500">(bowled last over)</span>}</span>
              <span className="text-xs text-slate-400">{oversText(b)}/{MAX_BOWL_BALLS / 6} ov</span><b className="w-8 text-right">{sk.toFixed(0)}</b>{bestBowler === i && <span className="text-xs text-green-400">best</span>}</button>; })}</div>}
          {canImpact && <div className="rounded-xl border border-white/10 bg-black/20 p-2 text-sm"><label className="flex items-center gap-2"><input type="checkbox" checked={impOpen} onChange={(e) => setImpOpen(e.target.checked)} /> ⚡ Use my Impact Player (once per match)</label>
            {impOpen && <div className="mt-2 grid gap-2 sm:grid-cols-2"><select className="inp py-1 text-sm" value={imp.out} onChange={(e) => setImp({ ...imp, out: e.target.value })}><option value="">Take out…</option>{unusedXI.map(({ p, i }) => <option key={i} value={i}>#{i + 1} {p.name} ({SHORT[p.role]} {p.rt})</option>)}</select>
              <select className="inp py-1 text-sm" value={imp.in} onChange={(e) => setImp({ ...imp, in: e.target.value })}><option value="">Bring in…</option>{sd.bench.map((p, i) => <option key={i} value={i}>{p.name} ({SHORT[p.role]} {p.rt})</option>)}</select>
              <p className="text-xs text-slate-400 sm:col-span-2">Only players who haven&apos;t batted or bowled yet can be swapped out.</p></div>}</div>}
          <button disabled={sending || (imBowl && chosenBowler == null)} onClick={() => send(imBat ? { intent, ...impactChoice } : { bowler: chosenBowler, ...impactChoice })} className="btn w-full bg-amber-400 py-3 font-display text-2xl uppercase text-black">🔒 Lock in over {inn.over + 1}</button>
          <p className="text-xs text-slate-500">If you don&apos;t lock in before the clock ends, the AI picks for you.</p></>}
        {msg && <p className="text-sm text-red-300">{msg}</p>}</div>)
        : <p className="card text-center text-slate-300">👀 You are watching. Over {inn.over + 1}: {bT.team} batting, {wT.team} bowling.</p>}
    </>}
  </div>);
}

function OverList({ S }) {
  return <div className="space-y-3">{S.innings.map((inn, k) => <div key={k} className="card space-y-1"><h3 className="font-display text-xl uppercase tracking-wide">{S.sides[inn.bat].team} innings</h3>
    {inn.overs.length === 0 && <p className="text-xs text-slate-500">No overs yet.</p>}
    {inn.overs.map((o) => <div key={o.n} className="flex flex-wrap items-center gap-2 border-b border-white/5 py-1 text-sm"><span className="w-12 text-slate-400">Ov {o.n}</span><span className="w-32 truncate">{o.bowler}</span><span className="flex flex-wrap gap-1">{o.tok.map((t, i) => <Tok key={i} t={t} />)}</span><b className="ml-auto">{o.runs}{o.w ? ` · ${o.w}W` : ''}</b></div>)}</div>)}</div>;
}

function Scorecards({ S }) {
  return <div className="grid gap-4 lg:grid-cols-2">{S.innings.map((inn, k) => { const bt = S.sides[inn.bat], bw = S.sides[inn.bowl]; return (
    <div key={k} className="card space-y-2 text-sm" style={{ borderColor: bt.color }}>
      <h3 className="font-display text-2xl font-extrabold uppercase" style={{ color: bt.color }}>{bt.team} {inn.runs}/{inn.wkts} <span className="text-sm text-slate-400">({oversText(inn.balls)} ov)</span></h3>
      <table className="w-full"><thead className="text-left text-xs text-slate-400"><tr><th>Batter</th><th></th><th>R</th><th>B</th><th>4s</th><th>6s</th></tr></thead>
        <tbody>{Object.entries(inn.batters).map(([i, b]) => <tr key={i} className="border-t border-white/5"><td className="py-0.5 font-medium">{b.n}</td><td className="text-xs text-slate-400">{b.out || 'not out'}</td><td><b>{b.r}</b></td><td>{b.b}</td><td>{b.f}</td><td>{b.s}</td></tr>)}</tbody></table>
      <p className="text-xs text-slate-400">Extras {inn.extras}{inn.fow.length ? ` · FOW: ${inn.fow.join(', ')}` : ''}</p>
      <table className="w-full"><thead className="text-left text-xs text-slate-400"><tr><th>{bw.team} bowling</th><th>O</th><th>R</th><th>W</th><th>Econ</th></tr></thead>
        <tbody>{Object.values(inn.bowlers).map((b, i) => <tr key={i} className="border-t border-white/5"><td className="py-0.5">{b.n}</td><td>{oversText(b.b)}</td><td>{b.r}</td><td><b>{b.w}</b></td><td className="text-xs">{b.b ? ((b.r / b.b) * 6).toFixed(1) : '-'}</td></tr>)}</tbody></table></div>); })}</div>;
}
