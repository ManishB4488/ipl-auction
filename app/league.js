'use client';
// "League" tab: after the auction every team's final XI (captain, vice-captain, backups) plays a simulated season,
// then playoffs and a final. Results are deterministic per season number, so all friends see the same thing.
import { useEffect, useMemo, useState } from 'react';
import { Logo } from './components';
import { baseRating, buildTeamXI, autoFill } from './lineup';
import { simulateSeason, aggregate, strength } from './leaguesim';

const FILLER = 28;

export function prepTeams(fr, rows, rps, P) {
  return [...fr].sort((a, b) => (a.id < b.id ? -1 : 1)).map((f) => {
    const row = (rows || []).find((r) => r.franchise_id === f.id);
    let { lu, kind, owned, stateOf } = buildTeamXI(f, row, rps, P);
    const completed = kind !== 'locked';
    if (completed) lu = autoFill(lu, owned, stateOf, P);                       // fills gaps in drafts / bot / missing XIs
    const rate = (o) => Math.min(99, baseRating(o.rp, o.p) + Math.min(10, (o.rp.sold_lakh || 0) / 250));
    const pool = new Map(owned.map((o) => [o.pid, { pid: o.pid, p: o.p, rating: rate(o) }]));
    const xi = lu.slots.map((s, i) => { const q = s.pid != null ? pool.get(s.pid) : null; return q ? { slot: i, ...q } : { slot: i, pid: null, p: null, rating: FILLER }; });
    const inXI = new Set(xi.map((x) => x.pid));
    const backups = {}; lu.slots.forEach((s, i) => { backups[i] = (lu.backups[i] || []).filter((pid) => pool.has(pid) && !inXI.has(pid)); });
    return { id: f.id, team: f.team, color: f.color, owner: f.owner, is_bot: !!f.is_bot, kind, completed, xi, pool, backups, captain: lu.captain, vice: lu.vice };
  });
}

const score = (s) => `${s.runs}/${s.wk}`;
const nrrText = (v) => (v >= 0 ? '+' : '') + v.toFixed(2);

export function LeagueTab({ fr, lus, rps, P, room, mine }) {
  const [season, setSeason] = useState(1), [shown, setShown] = useState(0), [auto, setAuto] = useState(false);
  const done = room.status === 'done';
  const teams = useMemo(() => (done ? prepTeams(fr, lus, rps, P) : []), [done, fr, lus, rps, P]);
  const sim = useMemo(() => (teams.length ? simulateSeason(teams, `${room.code}-S${season}`) : null), [teams, room.code, season]);
  const total = sim ? sim.matches.length : 0;
  const byId = useMemo(() => Object.fromEntries(teams.map((t) => [t.id, t])), [teams]);
  const view = useMemo(() => (sim ? aggregate(sim.matches.slice(0, shown), teams) : null), [sim, shown, teams]);
  const ratings = useMemo(() => teams.map((t) => ({ t, s: strength(t.xi, t) })).sort((a, b) => b.s.overall - a.s.overall), [teams]);
  const crowned = sim && sim.champion && shown >= total;
  const bits = useMemo(() => Array.from({ length: 36 }, (_, i) => ({ left: Math.random() * 100, delay: Math.random() * 1.5, dur: 2.5 + Math.random() * 2, color: ['#ff8a1f', '#fbbf24', '#3b82f6', '#22c55e', '#f43f5e'][i % 5] })), [crowned]);

  useEffect(() => { setShown(0); setAuto(false); }, [season]);
  useEffect(() => {
    if (!auto) return;
    if (shown >= total) { setAuto(false); return; }
    const id = setTimeout(() => setShown((n) => Math.min(total, n + 1)), 750);
    return () => clearTimeout(id);
  }, [auto, shown, total]);

  if (!done) return <div className="card text-center"><h2 className="font-display text-3xl font-extrabold uppercase">🏆 The League</h2>
    <p className="mt-2 text-slate-300">When the auction ends, every team&apos;s final XI plays a simulated season — league matches, playoffs and a final. Make your XI, captain, vice-captain and backups count!</p></div>;
  if (!sim || sim.error) return <p className="card">{sim?.error || 'Loading…'}</p>;

  const leagueDone = shown >= sim.leagueCount;
  const shownPlayoffs = sim.matches.slice(sim.leagueCount, shown);
  const feed = sim.matches.slice(0, shown).map((m, i) => ({ m, i })).reverse();
  const myT = mine ? byId[mine.id] : null;
  const myPos = myT ? view.table.findIndex((x) => x.id === myT.id) + 1 : 0, myRow = myT ? view.table.find((x) => x.id === myT.id) : null;
  const myInj = myT ? sim.matches.slice(0, shown).flatMap((m) => m.inj.filter((j) => j.team === myT.id)) : [];
  const myPlayers = myT ? sim.matches.slice(0, shown).flatMap((m) => m.stats[myT.id] || []) : [];
  const tally = {}; myPlayers.forEach((s) => { const t = tally[s.pid] || (tally[s.pid] = { name: s.name, runs: 0, wkts: 0 }); t.runs += s.runs; t.wkts += s.wkts; });
  const myTop = Object.values(tally).sort((a, b) => b.runs + 24 * b.wkts - (a.runs + 24 * a.wkts))[0];
  const tag = (id, size = 22) => { const t = byId[id]; return t ? <span className="inline-flex items-center gap-1"><Logo team={t.team} size={size} /><b style={{ color: t.color }}>{t.team}</b></span> : null; };
  const stageBadge = (m) => <span className={`rounded px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider ${m.stage === 'Final' ? 'bg-amber-400 text-black' : m.stage === 'league' ? 'bg-white/10 text-slate-300' : 'bg-sky-500/30 text-sky-200'}`}>{m.stage === 'league' ? 'League' : m.stage}</span>;

  return (<div className="space-y-4">
    {crowned && <>{bits.map((b, i) => <span key={i} className="confetti" style={{ left: `${b.left}%`, animationDelay: `${b.delay}s`, animationDuration: `${b.dur}s`, background: b.color }} />)}
      <div className="card pop text-center" style={{ borderColor: sim.champion.color, background: `linear-gradient(135deg, ${sim.champion.color}55, rgba(10,18,48,.8))` }}>
        <p className="font-display text-sm font-bold uppercase tracking-[.4em] text-amber-300">Season {season} champions</p>
        <div className="my-2 flex justify-center"><Logo team={sim.champion.team} size={96} /></div>
        <h2 className="font-display text-5xl font-extrabold uppercase" style={{ color: sim.champion.color }}>🏆 {sim.champion.team}</h2>
        <p className="text-slate-300">Owner: {sim.champion.owner} · Runners-up: {sim.runnerUp.team}</p></div></>}

    <div className="card space-y-3">
      <div className="flex flex-wrap items-center gap-2"><h2 className="mr-auto font-display text-3xl font-extrabold uppercase">🏆 The League <span className="text-lg text-amber-400">Season {season}</span></h2>
        <span className="text-xs text-slate-400">{shown}/{total} matches played</span></div>
      <div className="h-2 rounded-full bg-white/10"><div className="h-2 rounded-full bg-gradient-to-r from-amber-300 to-amber-500" style={{ width: `${(shown / Math.max(total, 1)) * 100}%` }} /></div>
      <div className="flex flex-wrap gap-2">
        <button disabled={shown >= total} onClick={() => setShown((n) => Math.min(total, n + 1))} className="btn bg-amber-400 py-1 text-black">▶ Next match</button>
        <button disabled={shown >= total} onClick={() => setAuto((a) => !a)} className="btn bg-white/10 py-1">{auto ? '⏸ Pause' : '⏵ Auto-play'}</button>
        <button disabled={leagueDone} onClick={() => setShown(sim.leagueCount)} className="btn bg-white/10 py-1">⏩ End of league</button>
        <button disabled={shown >= total} onClick={() => setShown(total)} className="btn bg-white/10 py-1">⏭ Finish season</button>
        <button onClick={() => setSeason((s) => s + 1)} className="btn bg-white/10 py-1">🔁 New season</button></div>
      <p className="text-xs text-slate-400">Everyone sees the same results for the same season number. Game estimates only: strength comes from each team&apos;s XI (batting order, bowling options, keeper, captain / vice-captain) and a small chance of injuries, where a good backup steps in. Teams with a missing keeper, fewer than 5 bowling options or no backups are punished. Unlocked or missing XIs are auto-completed for the simulation.</p></div>

    <div className="grid gap-4 lg:grid-cols-2">
      <div className="card"><h3 className="mb-2 font-display text-xl uppercase tracking-wide">Points table</h3>
        <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="text-left font-display text-base uppercase tracking-wider text-amber-400"><tr><th className="p-1">#</th><th>Team</th><th>P</th><th>W</th><th>L</th><th>NRR</th><th>Pts</th></tr></thead>
          <tbody>{view.table.map((x, i) => { const t = byId[x.id]; return (<tr key={x.id} className={`border-t border-white/10 ${i < (teams.length >= 4 ? 4 : 2) && leagueDone ? 'bg-green-600/10' : ''} ${mine?.id === x.id ? 'font-semibold' : ''}`}>
            <td className="p-1 text-slate-400">{i + 1}</td><td><span className="flex items-center gap-1"><Logo team={t.team} size={22} /><span style={{ color: t.color }}>{t.team}</span>{t.is_bot && ' 🤖'}{mine?.id === x.id && <span className="rounded bg-white/15 px-1 text-[10px]">YOU</span>}</span></td>
            <td>{x.P}</td><td>{x.W}</td><td>{x.L}</td><td className="text-xs">{nrrText(x.nrr)}</td><td className="score text-lg font-bold text-amber-400">{x.pts}</td></tr>); })}</tbody></table></div>
        {leagueDone && <p className="mt-1 text-xs text-green-400">Top {teams.length >= 4 ? 4 : 2} (green) go to the playoffs.</p>}</div>

      <div className="card space-y-2"><h3 className="font-display text-xl uppercase tracking-wide">Team strength <span className="text-xs font-normal normal-case text-slate-400">(from the final XIs, before injuries)</span></h3>
        {ratings.map(({ t, s }) => (<div key={t.id} className="text-sm"><div className="flex items-center gap-2"><Logo team={t.team} size={20} /><span className="flex-1 truncate">{t.team}{mine?.id === t.id && <span className="ml-1 rounded bg-white/15 px-1 text-[10px]">YOU</span>}</span>
          <span className="text-xs text-slate-400">BAT {s.bat.toFixed(0)} · BOWL {s.bowl.toFixed(0)}{s.lead >= 1 ? ' · 🧢 +' : s.lead < 0 ? ' · 🧢 −' : ''}</span><b className="score w-8 text-right text-lg">{s.overall.toFixed(0)}</b></div>
          <div className="mt-0.5 h-1.5 rounded-full bg-white/10"><div className="h-1.5 rounded-full" style={{ width: `${clampPct((s.overall - 35) / 45)}%`, background: t.color }} /></div></div>))}</div>
    </div>

    {shownPlayoffs.length > 0 && <div className="card space-y-2"><h3 className="font-display text-xl uppercase tracking-wide">Playoffs</h3>
      <div className="grid gap-2 md:grid-cols-2">{shownPlayoffs.map((m, i) => (<div key={i} className="rounded-xl border border-white/10 bg-black/25 p-3 text-sm" style={{ borderLeft: `4px solid ${byId[m.winner]?.color}` }}>
        <div className="mb-1">{stageBadge(m)}</div>
        <div className="flex justify-between"><span>{tag(m.a, 18)}</span><b>{score(m.sA)}</b></div><div className="flex justify-between"><span>{tag(m.b, 18)}</span><b>{score(m.sB)}</b></div>
        <p className="mt-1 text-amber-300">{m.result}</p></div>))}</div></div>}

    {view && shown > 0 && <div className="grid gap-4 md:grid-cols-3">
      <div className="card"><h3 className="mb-1 font-display text-xl uppercase tracking-wide text-amber-400">🧢 Orange cap</h3>{view.orange.map((p, i) => (<div key={p.pid} className="flex justify-between border-b border-white/5 py-0.5 text-sm"><span>{i + 1}. {p.name} <span className="text-xs text-slate-500">{byId[p.team]?.team}</span></span><b>{p.runs}</b></div>))}</div>
      <div className="card"><h3 className="mb-1 font-display text-xl uppercase tracking-wide text-purple-400">🧢 Purple cap</h3>{view.purple.map((p, i) => (<div key={p.pid} className="flex justify-between border-b border-white/5 py-0.5 text-sm"><span>{i + 1}. {p.name} <span className="text-xs text-slate-500">{byId[p.team]?.team}</span></span><b>{p.wkts}</b></div>))}</div>
      <div className="card"><h3 className="mb-1 font-display text-xl uppercase tracking-wide text-green-400">⭐ MVP</h3>{view.mvp.map((p, i) => (<div key={p.pid} className="flex justify-between border-b border-white/5 py-0.5 text-sm"><span>{i + 1}. {p.name} <span className="text-xs text-slate-500">{byId[p.team]?.team}</span></span><b>{p.pts}</b></div>))}</div></div>}

    {myT && shown > 0 && myRow && <div className="card space-y-1" style={{ borderColor: myT.color }}><h3 className="font-display text-xl uppercase tracking-wide" style={{ color: myT.color }}>My team report</h3>
      <p className="text-sm">{myT.team}: <b>{myRow.W}W – {myRow.L}L</b>, {myRow.pts} pts, <b>#{myPos}</b> in the table{leagueDone ? (myPos <= (teams.length >= 4 ? 4 : 2) ? ' — qualified for the playoffs 🎉' : ' — missed the playoffs') : ''}.</p>
      {myTop && <p className="text-sm text-slate-300">Star performer so far: <b>{myTop.name}</b> ({myTop.runs} runs, {myTop.wkts} wickets).</p>}
      {myInj.length > 0 ? <ul className="text-xs text-slate-300">{myInj.slice(-4).map((j, i) => <li key={i}>🩹 {j.out} was injured — {j.in ? `backup ${j.in} stepped in` : 'no backup, a weak filler played'}.</li>)}</ul>
        : <p className="text-xs text-slate-500">No injuries yet. Backups matter when a player gets injured.</p>}</div>}

    <div className="space-y-2"><h3 className="font-display text-xl uppercase tracking-wide">Match feed</h3>
      {feed.length === 0 && <p className="card text-sm text-slate-400">Press “Next match” or “Auto-play” to start the season.</p>}
      {feed.slice(0, 40).map(({ m, i }) => (<div key={i} className="rounded-xl border border-white/10 bg-black/25 p-3 text-sm" style={{ borderLeft: `4px solid ${byId[m.winner]?.color}` }}>
        <div className="mb-1 flex items-center gap-2">{stageBadge(m)}<span className="text-xs text-slate-500">Match {i + 1}</span></div>
        <div className={`flex justify-between ${m.winner === m.a ? 'font-bold' : ''}`}><span>{tag(m.a, 18)}</span><span>{score(m.sA)} <span className="text-xs text-slate-400">(20)</span></span></div>
        <div className={`flex justify-between ${m.winner === m.b ? 'font-bold' : ''}`}><span>{tag(m.b, 18)}</span><span>{score(m.sB)} <span className="text-xs text-slate-400">({m.sB.overs.toFixed(1).replace('.0', '')})</span></span></div>
        <p className="mt-1 text-amber-300">{m.result}</p>
        <p className="text-xs text-slate-300">⭐ Player of the match: <b>{m.potm.name}</b> ({m.potm.line}) — {byId[m.potm.team]?.team}</p>
        {m.inj.map((j, k) => <p key={k} className="text-xs text-slate-400">🩹 {byId[j.team]?.team}: {j.out} injured — {j.in ? `${j.in} (backup) played` : 'no backup, a weak filler played'}</p>)}</div>))}
      {feed.length > 40 && <p className="text-center text-xs text-slate-500">Showing the latest 40 of {feed.length} matches.</p>}</div>
  </div>);
}
const clampPct = (v) => Math.max(4, Math.min(100, v * 100));
