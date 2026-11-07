'use client';
// Playing XI planner: 11 slots in batting order, captain, vice-captain and up to 2 backups per slot.
// During the auction it is a private plan (slots may hold players you own or "targets" still to come) and it autosaves.
// When the auction is over the owner locks it; then everyone can see it in the Final tab.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { sb, cr } from '../lib/supabase';

export const MAX_OS_XI = 4;                      // IPL rule: at most 4 overseas players in the XI
export const WANTS = ['Batter', 'Wicketkeeper', 'All-rounder', 'Bowler'];
const DEFAULT_WANTS = ['Batter', 'Batter', 'Batter', 'Batter', 'Wicketkeeper', 'All-rounder', 'All-rounder', 'Bowler', 'Bowler', 'Bowler', 'Bowler'];
const SHORT = { Batter: 'BAT', Wicketkeeper: 'WK', 'All-rounder': 'AR', Bowler: 'BOWL' };
const FALLBACK = { Batter: ['Batter', 'All-rounder', 'Wicketkeeper'], Wicketkeeper: ['Wicketkeeper'], 'All-rounder': ['All-rounder', 'Batter', 'Bowler'], Bowler: ['Bowler', 'All-rounder'] };
const FREE = ['empty', 'lost', 'gone'];

export const blankLineup = () => ({ slots: DEFAULT_WANTS.map((want) => ({ want, pid: null })), backups: {}, captain: null, vice: null, locked: false });

// game estimate of a player's quality from the base-price tier (same formula the Final tab uses)
export const baseRating = (rp, p) => { const b = rp.base_lakh; const r = b >= 200 ? 90 : b >= 150 ? 80 : b >= 125 ? 75 : b >= 100 ? 70 : b >= 75 ? 62 : b >= 50 ? 52 : b >= 40 ? 46 : 40; return Math.min(99, r + (p.capped === 'Capped' ? 3 : 0)); };

const normalize = (row) => {
  if (!row || !Array.isArray(row.slots) || row.slots.length !== 11) return blankLineup();
  return {
    slots: row.slots.map((s, i) => ({ want: WANTS.includes(s?.want) ? s.want : DEFAULT_WANTS[i], pid: Number.isInteger(s?.pid) ? s.pid : null })),
    backups: row.backups && typeof row.backups === 'object' ? row.backups : {},
    captain: row.captain ?? null, vice: row.vice ?? null, locked: !!row.locked,
  };
};

// ---------- auto-fill (also used to show an XI for bot teams and for humans who never made one) ----------
export function autoFill(lu, owned, stateOf, P) {
  const slots = lu.slots.map((s) => ({ ...s }));
  slots.forEach((s) => { if (s.pid != null && FREE.includes(stateOf(s.pid).k)) s.pid = null; });
  const byPid = new Map(owned.map((o) => [o.pid, o]));
  const used = new Set(slots.map((s) => s.pid).filter((x) => x != null));
  let os = slots.filter((s) => s.pid != null && P[s.pid]?.overseas).length;
  const take = (s, roles) => {
    for (const role of roles) {
      const c = owned.filter((o) => !used.has(o.pid) && o.p.role === role && !(o.p.overseas && os >= MAX_OS_XI)).sort((a, b) => b.r - a.r)[0];
      if (c) { s.pid = c.pid; used.add(c.pid); if (c.p.overseas) os++; return; }
    }
  };
  slots.forEach((s) => { if (s.pid == null) take(s, [s.want]); });
  slots.forEach((s) => { if (s.pid == null) take(s, FALLBACK[s.want]); });
  slots.forEach((s) => { if (s.pid == null) take(s, ['Batter', 'All-rounder', 'Bowler', 'Wicketkeeper']); });

  const inXI = slots.map((s) => s.pid).filter((x) => x != null);
  let { captain, vice } = lu;
  if (!inXI.includes(captain)) captain = null;
  if (!inXI.includes(vice) || vice === captain) vice = null;
  const ranked = inXI.map((pid) => byPid.get(pid)).filter(Boolean).sort((a, b) => b.r - a.r);
  if (captain == null) captain = ranked.find((o) => o.pid !== vice)?.pid ?? null;
  if (vice == null) vice = ranked.find((o) => o.pid !== captain)?.pid ?? null;

  const backups = {}, usage = {};
  slots.forEach((s, i) => {
    const keep = (lu.backups[i] || []).filter((pid) => !used.has(pid) && !FREE.includes(stateOf(pid).k));
    const role = s.pid != null ? P[s.pid]?.role : s.want;
    const match = (o) => (o.p.role === role ? 2 : (FALLBACK[role] || []).includes(o.p.role) ? 1 : 0);
    const bench = owned.filter((o) => !used.has(o.pid) && !keep.includes(o.pid))
      .sort((a, b) => match(b) - match(a) || (usage[a.pid] || 0) - (usage[b.pid] || 0) || b.r - a.r);
    const list = [...keep];
    while (list.length < 2 && bench.length) list.push(bench.shift().pid);
    list.forEach((pid) => { usage[pid] = (usage[pid] || 0) + 1; });
    backups[i] = list;
  });
  return { ...lu, slots, backups, captain, vice };
}

// ---------- the hook: lives in the Room component so the plan survives tab changes ----------
export function useLineup({ rows, room, mine, rps, P, act }) {
  const [lu, setLu] = useState(null), [status, setStatus] = useState(''), [note, setNote] = useState('');
  const [autoplace, setAutoplaceS] = useState(true);
  const dirty = useRef(false), seen = useRef(null), initFor = useRef(null), timer = useRef(null), latest = useRef(null);
  const mineId = mine?.id, roomId = room?.id;
  latest.current = lu;
  const myRow = rows ? rows.find((r) => r.franchise_id === mineId) : null;

  useEffect(() => { try { setAutoplaceS(localStorage.getItem('xi-autoplace') !== 'off'); } catch (e) {} }, []);
  useEffect(() => {   // load once from the server, then only follow the locked flag
    if (!mineId || rows === null) return;
    if (initFor.current !== mineId) { initFor.current = mineId; seen.current = null; dirty.current = false; setLu(normalize(myRow)); return; }
    if (myRow && latest.current && myRow.locked !== latest.current.locked) setLu((p) => p && { ...p, locked: myRow.locked });
  }, [mineId, rows]);

  const info = useMemo(() => { const m = {}; rps.forEach((r) => { m[r.player_id] = r; }); return m; }, [rps]);
  const stateOf = useCallback((pid) => {
    if (pid == null) return { k: 'empty' };
    const rp = info[pid];
    if (!rp) return { k: 'gone' };
    if (rp.status === 'sold') return rp.sold_to === mineId ? { k: 'owned', rp } : { k: 'lost', rp };
    if (rp.status === 'unsold') return { k: 'unsold', rp };
    return { k: 'target', rp };
  }, [info, mineId]);
  const owned = useMemo(() => rps.filter((r) => r.status === 'sold' && r.sold_to === mineId && P[r.player_id])
    .map((r) => ({ pid: r.player_id, p: P[r.player_id], rp: r, r: baseRating(r, P[r.player_id]) + r.sold_lakh / 100000 })), [rps, P, mineId]);

  // ---- autosave (700 ms after the last change) ----
  useEffect(() => {
    if (!dirty.current || !lu || !roomId) return;
    setStatus('saving');
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      dirty.current = false;
      const { data, error } = await sb.rpc('save_lineup', { p_room: roomId, p_slots: lu.slots, p_backups: lu.backups, p_captain: lu.captain, p_vice: lu.vice });
      setStatus(error ? 'Could not save: ' + error.message : data && data !== 'ok' ? data : 'saved');
    }, 700);
    return () => clearTimeout(timer.current);
  }, [lu]);

  const edit = useCallback((fn) => setLu((p) => { if (!p || p.locked) return p; dirty.current = true; return fn(p); }), []);

  const setPlayer = (i, pid) => edit((p) => {
    const slots = p.slots.map((s) => ({ ...s })), old = slots[i].pid;
    if (pid != null) slots.forEach((s) => { if (s.pid === pid) s.pid = null; });
    slots[i].pid = pid;
    const backups = {}; Object.entries(p.backups).forEach(([k, a]) => { backups[k] = (a || []).filter((x) => x !== pid); });
    let { captain, vice } = p;
    if (old != null && old !== pid) { if (captain === old) captain = null; if (vice === old) vice = null; }
    return { ...p, slots, backups, captain, vice };
  });
  const setWant = (i, want) => edit((p) => ({ ...p, slots: p.slots.map((s, k) => (k === i ? { ...s, want } : s)) }));
  const move = (i, d) => edit((p) => {
    const j = i + d; if (j < 0 || j > 10) return p;
    const slots = p.slots.map((s) => ({ ...s })); [slots[i], slots[j]] = [slots[j], slots[i]];
    const backups = { ...p.backups }; const a = backups[i], b = backups[j]; backups[i] = b || []; backups[j] = a || [];
    return { ...p, slots, backups };
  });
  const setBackup = (i, j, pid) => edit((p) => {
    const a = [...(p.backups[i] || [])]; a[j] = pid == null ? undefined : pid;
    return { ...p, backups: { ...p.backups, [i]: [0, 1].map((x) => a[x]).filter((x) => x != null) } };
  });
  const setLeader = (kind, pid) => edit((p) => {
    let { captain, vice } = p;
    if (kind === 'captain') { captain = captain === pid ? null : pid; if (vice === pid) vice = null; }
    else { vice = vice === pid ? null : pid; if (captain === pid) captain = null; }
    return { ...p, captain, vice };
  });
  const clear = () => edit((p) => ({ ...p, slots: p.slots.map((s) => ({ ...s, pid: null })), backups: {}, captain: null, vice: null }));
  const fill = () => edit((p) => autoFill(p, owned, stateOf, P));
  const setAutoplace = (v) => { setAutoplaceS(v); try { localStorage.setItem('xi-autoplace', v ? 'on' : 'off'); } catch (e) {} };

  // ---- every new buy is dropped into the first open slot of the same position (if auto-place is on) ----
  const ownedKey = owned.map((o) => o.pid).sort((a, b) => a - b).join(',');
  useEffect(() => {
    if (!lu || !mineId || rps.length === 0) return;
    const pids = owned.map((o) => o.pid);
    if (seen.current === null) { seen.current = new Set(pids); return; }
    const fresh = pids.filter((pid) => !seen.current.has(pid));
    if (!fresh.length) return;
    fresh.forEach((pid) => seen.current.add(pid));
    if (!autoplace || lu.locked) return;
    edit((p) => {
      const slots = p.slots.map((s) => ({ ...s })); let os = slots.filter((s) => s.pid != null && P[s.pid]?.overseas).length;
      fresh.forEach((pid) => {
        const pl = P[pid]; if (!pl || slots.some((s) => s.pid === pid)) return;
        if (pl.overseas && os >= MAX_OS_XI) return;
        const i = slots.findIndex((s) => s.want === pl.role && FREE.includes(stateOf(s.pid).k));
        if (i >= 0) { slots[i].pid = pid; if (pl.overseas) os++; setNote(`📋 ${pl.name} was added to your XI at #${i + 1}`); }
      });
      return { ...p, slots };
    });
  }, [ownedKey, lu !== null]);

  // ---- summary + checks ----
  const summary = useMemo(() => {
    if (!lu) return null;
    const xi = lu.slots.map((s) => ({ s, st: stateOf(s.pid), p: s.pid != null ? P[s.pid] : null }));
    const live = xi.filter((x) => x.p && !FREE.includes(x.st.k));
    const ownedN = xi.filter((x) => x.st.k === 'owned').length;
    const os = live.filter((x) => x.p.overseas).length;
    const wk = live.filter((x) => x.p.role === 'Wicketkeeper').length;
    const bowl = live.filter((x) => x.p.role === 'Bowler' || x.p.role === 'All-rounder').length;
    const inXI = live.map((x) => x.p.id);
    const capOk = lu.captain != null && inXI.includes(lu.captain), viceOk = lu.vice != null && inXI.includes(lu.vice) && lu.vice !== lu.captain;
    const problems = [];
    if (ownedN < 11) problems.push(`${11 - ownedN} slot${11 - ownedN === 1 ? ' is' : 's are'} not filled with a player you own`);
    if (os > MAX_OS_XI) problems.push(`${os} overseas players in the XI (max ${MAX_OS_XI})`);
    if (!capOk) problems.push('Pick a captain (C)');
    if (!viceOk) problems.push('Pick a different vice-captain (VC)');
    const warnings = [];
    if (!wk) warnings.push('No wicketkeeper in your XI');
    if (bowl < 5) warnings.push(`Only ${bowl} bowling option${bowl === 1 ? '' : 's'} (bowlers + all-rounders) — 5 is the usual minimum`);
    const open = {}; xi.forEach((x) => { if (FREE.includes(x.st.k)) open[x.s.want] = (open[x.s.want] || 0) + 1; });
    return { planned: live.length, ownedN, os, wk, bowl, capOk, viceOk, problems, warnings, open };
  }, [lu, stateOf, P]);

  const lock = async () => {
    clearTimeout(timer.current);
    if (dirty.current && latest.current) {
      dirty.current = false; const l = latest.current;
      await sb.rpc('save_lineup', { p_room: roomId, p_slots: l.slots, p_backups: l.backups, p_captain: l.captain, p_vice: l.vice });
    }
    await act('lock_lineup');
  };
  const unlock = () => act('unlock_lineup');

  return { lu, status, note, setNote, autoplace, setAutoplace, stateOf, owned, summary, setPlayer, setWant, move, setBackup, setLeader, clear, fill, lock, unlock };
}

// ---------- small helpers ----------
const lab = (p) => `${p.overseas ? '✈ ' : ''}${p.name} · ${SHORT[p.role] || p.role}`;
const targetLabel = (rp, rps) => rp.status === 'live' ? 'ON NOW' : (() => { const n = rps.filter((x) => x.status === 'pending' && x.seq < rp.seq).length; return n === 0 ? 'NEXT UP' : `${n} before`; })();

function StatusLine({ st, want, rps, FR }) {
  if (st.k === 'empty') return <span className="text-amber-300">Need a {want}</span>;
  if (st.k === 'owned') return <span className="text-green-400">✅ Yours · {cr(st.rp.sold_lakh)}</span>;
  if (st.k === 'target') return <span className="text-sky-300">🎯 Target · {targetLabel(st.rp, rps)} · base {cr(st.rp.base_lakh)}</span>;
  if (st.k === 'unsold') return <span className="text-orange-300">⚠ Unsold so far (may return in the accelerated round)</span>;
  return <span className="text-red-400">❌ Lost — sold to {FR[st.rp?.sold_to]?.team || 'another team'}{st.rp ? ` for ${cr(st.rp.sold_lakh)}` : ''}. Pick another.</span>;
}

// ---------- full planner (tab "My XI") ----------
export function XiEditor({ xi, room, rps, P, FR, watch }) {
  const { lu, summary: S, stateOf, owned } = xi;
  const watchSet = useMemo(() => new Set((watch || []).map((w) => w.player_id)), [watch]);
  if (!lu || !S) return <p className="card">Loading your XI…</p>;
  const locked = lu.locked, done = room.status === 'done';
  const inXI = new Set(lu.slots.map((s) => s.pid).filter((x) => x != null));
  const targets = rps.filter((r) => (r.status === 'pending' || r.status === 'live') && P[r.player_id])
    .sort((a, b) => (watchSet.has(b.player_id) ? 1 : 0) - (watchSet.has(a.player_id) ? 1 : 0) || a.seq - b.seq);
  const bench = owned.filter((o) => !inXI.has(o.pid));
  const nameOf = (pid) => P[pid]?.name || '—';
  const chip = (t, ok) => <span className={`rounded-full px-2 py-1 text-xs font-semibold ${ok === true ? 'bg-green-600/30' : ok === false ? 'bg-red-500/30' : ok === 'warn' ? 'bg-amber-400/25' : 'bg-white/10'}`}>{t}</span>;

  const playerOptions = (i, s) => {
    const cur = s.pid;
    const mineOpts = owned.filter((o) => !inXI.has(o.pid) || o.pid === cur);
    const tg = targets.filter((r) => P[r.player_id].role === s.want && (!inXI.has(r.player_id) || r.player_id === cur)).slice(0, 80);
    const curSt = stateOf(cur);
    const extra = cur != null && !mineOpts.some((o) => o.pid === cur) && !tg.some((r) => r.player_id === cur) && P[cur] ? [cur] : [];
    return (<>
      <option value="">— empty (need a {s.want}) —</option>
      {mineOpts.length > 0 && <optgroup label="My squad">{mineOpts.map((o) => <option key={o.pid} value={o.pid}>{lab(o.p)} ({cr(o.rp.sold_lakh)})</option>)}</optgroup>}
      {tg.length > 0 && <optgroup label={`🎯 Targets still to come (${s.want}s)`}>{tg.map((r) => <option key={r.player_id} value={r.player_id}>{watchSet.has(r.player_id) ? '★ ' : ''}{lab(P[r.player_id])} (base {cr(r.base_lakh)})</option>)}</optgroup>}
      {extra.map((pid) => <option key={pid} value={pid}>{curSt.k === 'lost' ? '(lost) ' : ''}{lab(P[pid])}</option>)}
    </>);
  };
  const backupOptions = (i, s, j) => {
    const have = lu.backups[i] || [], cur = have[j];
    const b = bench.filter((o) => !have.includes(o.pid) || o.pid === cur);
    const role = s.pid != null ? P[s.pid]?.role : s.want;
    const tg = targets.filter((r) => P[r.player_id].role === role && !inXI.has(r.player_id) && (!have.includes(r.player_id) || r.player_id === cur)).slice(0, 40);
    return (<>
      <option value="">— none —</option>
      {b.length > 0 && <optgroup label="My bench">{b.map((o) => <option key={o.pid} value={o.pid}>{lab(o.p)}</option>)}</optgroup>}
      {tg.length > 0 && <optgroup label="🎯 Targets">{tg.map((r) => <option key={r.player_id} value={r.player_id}>{watchSet.has(r.player_id) ? '★ ' : ''}{lab(P[r.player_id])}</option>)}</optgroup>}
      {cur != null && !b.some((o) => o.pid === cur) && !tg.some((r) => r.player_id === cur) && P[cur] && <option value={cur}>{lab(P[cur])}</option>}
    </>);
  };

  return (<div className="space-y-4">
    <div className="card space-y-3">
      <div className="flex flex-wrap items-center gap-2"><h2 className="mr-auto text-xl font-bold">📋 My Playing XI</h2>
        <span className="text-xs text-slate-400">{xi.status === 'saving' ? 'Saving…' : xi.status === 'saved' ? '✓ Saved' : xi.status}</span></div>
      {locked
        ? <p className="rounded-lg bg-green-600/25 p-2 text-sm">🔒 <b>Finalised.</b> Everyone can see your XI in the Final tab. <button className="ml-2 underline" onClick={xi.unlock}>Unlock to edit</button></p>
        : done ? <p className="rounded-lg bg-amber-400/15 p-2 text-sm text-amber-100">The auction is over — fill all 11 slots with players you own, pick C and VC, then lock it.</p>
          : <p className="rounded-lg bg-white/10 p-2 text-sm text-slate-300">Plan your XI while the auction runs. Empty slots show the positions you still need, and you can put <b>targets</b> (players still to come) in a slot. It autosaves and stays private until the auction ends. You can lock it once the auction is over.</p>}
      <div className="flex flex-wrap gap-2">
        {chip(`XI ${S.planned}/11`, S.planned === 11 ? true : null)}
        {chip(`✈ ${S.os}/${MAX_OS_XI} overseas`, S.os > MAX_OS_XI ? false : null)}
        {chip(`🧤 ${S.wk ? 'Keeper ✓' : 'No keeper'}`, S.wk ? true : 'warn')}
        {chip(`🎳 ${S.bowl} bowling options`, S.bowl >= 5 ? true : 'warn')}
        {chip(`C: ${S.capOk ? nameOf(lu.captain) : '—'}`, S.capOk ? true : null)}
        {chip(`VC: ${S.viceOk ? nameOf(lu.vice) : '—'}`, S.viceOk ? true : null)}
      </div>
      {xi.note && <p className="rounded bg-green-600/20 p-1 text-center text-xs">{xi.note} <button className="ml-1 text-slate-400" onClick={() => xi.setNote('')}>✕</button></p>}
      {!locked && <div className="flex flex-wrap items-center gap-2">
        <button className="btn bg-amber-400 py-1 text-sm text-black" onClick={xi.fill}>✨ Auto-fill empty slots, C/VC &amp; backups</button>
        <button className="btn bg-white/10 py-1 text-sm" onClick={() => confirm('Clear all 11 slots, backups and C/VC?') && xi.clear()}>Clear XI</button>
        <label className="flex items-center gap-1 text-xs text-slate-300"><input type="checkbox" checked={xi.autoplace} onChange={(e) => xi.setAutoplace(e.target.checked)} /> Auto-place new buys into open slots</label></div>}
    </div>

    <div className="space-y-2">{lu.slots.map((s, i) => {
      const st = xi.stateOf(s.pid), has = s.pid != null && P[s.pid], bk = lu.backups[i] || [];
      return (<div key={i} className="card space-y-1 p-3" style={{ borderColor: lu.captain === s.pid && s.pid != null ? '#fbbf24' : undefined }}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="w-7 text-center text-lg font-black text-amber-300">{i + 1}</span>
          <select disabled={locked} className="inp w-auto py-1 text-xs" value={s.want} onChange={(e) => xi.setWant(i, e.target.value)} title="Position you want for this slot">{WANTS.map((w) => <option key={w} value={w}>{SHORT[w]}</option>)}</select>
          <select disabled={locked} className="inp min-w-[11rem] flex-1 py-1 text-sm" value={s.pid ?? ''} onChange={(e) => xi.setPlayer(i, e.target.value === '' ? null : +e.target.value)}>{playerOptions(i, s)}</select>
          <button disabled={locked || !has} onClick={() => xi.setLeader('captain', s.pid)} className={`btn px-2 py-1 text-xs ${lu.captain === s.pid && has ? 'bg-amber-400 text-black' : 'bg-white/10'}`} title="Captain">C</button>
          <button disabled={locked || !has} onClick={() => xi.setLeader('vice', s.pid)} className={`btn px-2 py-1 text-xs ${lu.vice === s.pid && has ? 'bg-sky-400 text-black' : 'bg-white/10'}`} title="Vice-captain">VC</button>
          {!locked && <><button className="btn bg-white/10 px-2 py-1 text-xs" disabled={i === 0} onClick={() => xi.move(i, -1)} title="Move up the batting order">▲</button>
            <button className="btn bg-white/10 px-2 py-1 text-xs" disabled={i === 10} onClick={() => xi.move(i, 1)} title="Move down the batting order">▼</button></>}</div>
        <div className="pl-9 text-xs"><StatusLine st={st} want={s.want} rps={rps} FR={FR} />
          {has && P[s.pid].overseas && <span className="ml-2 text-sky-300">✈ {P[s.pid].country}</span>}</div>
        <div className="flex flex-wrap items-center gap-2 pl-9 text-xs">
          <span className="text-slate-400">Backup:</span>
          <select disabled={locked} className="inp w-auto max-w-[12rem] py-1 text-xs" value={bk[0] ?? ''} onChange={(e) => xi.setBackup(i, 0, e.target.value === '' ? null : +e.target.value)}>{backupOptions(i, s, 0)}</select>
          {bk[0] != null && <select disabled={locked} className="inp w-auto max-w-[12rem] py-1 text-xs" value={bk[1] ?? ''} onChange={(e) => xi.setBackup(i, 1, e.target.value === '' ? null : +e.target.value)}>{backupOptions(i, s, 1)}</select>}</div>
      </div>);
    })}</div>

    <div className="card space-y-2 text-sm">
      <h3 className="font-semibold">Bench ({bench.length})</h3>
      {bench.length === 0 ? <p className="text-xs text-slate-400">Players you buy that are not in the XI show up here.</p>
        : <p className="text-xs text-slate-300">{bench.map((o) => `${o.p.name} (${SHORT[o.p.role]})`).join(' · ')}</p>}
      {S.warnings.map((w) => <p key={w} className="text-xs text-amber-300">⚠ {w}</p>)}
      {done && !locked && <div className="space-y-2 border-t border-white/10 pt-2">
        {S.problems.length > 0 && <ul className="list-disc pl-5 text-xs text-red-300">{S.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
        <button disabled={S.problems.length > 0} onClick={xi.lock} className="btn w-full bg-green-500 py-3 text-lg text-black">🔒 Lock my final XI</button></div>}
      {!done && !locked && <p className="border-t border-white/10 pt-2 text-xs text-slate-400">🔒 The “Lock final XI” button appears here when the auction ends.</p>}
    </div>
  </div>);
}

// ---------- compact card for the Live tab ----------
export function XiMini({ xi, setTab, P }) {
  const { lu, summary: S, stateOf } = xi;
  if (!lu || !S) return null;
  const icon = { owned: '✅', target: '🎯', lost: '❌', unsold: '⚠', gone: '', empty: '' };
  return (<div className="card space-y-1">
    <div className="flex items-center justify-between"><h3 className="font-semibold">📋 My XI <span className="text-xs font-normal text-slate-400">{S.planned}/11 planned · {S.ownedN} owned</span></h3>
      <button onClick={() => setTab('My XI')} className="rounded bg-white/10 px-2 py-0.5 text-xs">{lu.locked ? '🔒 View' : 'Edit'}</button></div>
    {xi.note && <p className="rounded bg-green-600/20 p-1 text-xs">{xi.note}</p>}
    <ul className="divide-y divide-white/10 text-xs">{lu.slots.map((s, i) => {
      const st = stateOf(s.pid), pl = s.pid != null && !FREE.includes(st.k) ? P[s.pid] : null;
      return (<li key={i} className="flex items-center gap-2 py-0.5">
        <span className="w-4 text-slate-500">{i + 1}</span>
        <span className="flex-1 truncate">{pl ? pl.name : <span className={st.k === 'lost' ? 'text-red-400' : 'text-amber-300'}>{st.k === 'lost' ? 'lost — pick another' : `need ${s.want}`}</span>}</span>
        <span>{pl && lu.captain === s.pid ? <b className="text-amber-300">C </b> : pl && lu.vice === s.pid ? <b className="text-sky-300">VC </b> : null}{icon[st.k]}</span></li>);
    })}</ul>
    {S.problems.length === 0 && <p className="text-xs text-green-400">XI is complete ✔</p>}</div>);
}

// ---------- "plan this player for my XI" (Live tab, current lot) ----------
export function QuickSlot({ xi, p }) {
  const { lu, stateOf } = xi;
  if (!lu || lu.locked) return null;
  const at = lu.slots.findIndex((s) => s.pid === p.id);
  if (at >= 0) return <div className="mt-2 text-xs text-green-300">📋 In your XI at #{at + 1} <button className="ml-1 underline" onClick={() => xi.setPlayer(at, null)}>remove</button></div>;
  const free = lu.slots.map((s, i) => ({ s, i })).filter(({ s }) => FREE.includes(stateOf(s.pid).k)).sort((a, b) => (b.s.want === p.role) - (a.s.want === p.role));
  if (!free.length) return null;
  return (<label className="mt-2 flex flex-wrap items-center gap-2 text-xs"><span className="text-slate-300">📋 Plan for my XI:</span>
    <select className="inp w-auto py-1 text-xs" value="" onChange={(e) => e.target.value !== '' && xi.setPlayer(+e.target.value, p.id)}>
      <option value="">choose a slot…</option>{free.map(({ s, i }) => <option key={i} value={i}>#{i + 1} {s.want}{s.want === p.role ? ' ✓' : ''}</option>)}</select></label>);
}

// ---------- Final tab: every team's XI with C / VC / backups ----------
function XiCard({ f, row, rps, P, FR }) {
  const owned = useMemo(() => rps.filter((r) => r.status === 'sold' && r.sold_to === f.id && P[r.player_id])
    .map((r) => ({ pid: r.player_id, p: P[r.player_id], rp: r, r: baseRating(r, P[r.player_id]) + r.sold_lakh / 100000 })), [rps, P, f.id]);
  const stateOf = (pid) => (pid == null ? { k: 'empty' } : rps.find((r) => r.player_id === pid && r.sold_to === f.id && r.status === 'sold') ? { k: 'owned' } : { k: 'lost' });
  const [lu, kind] = useMemo(() => {
    if (row) return [normalize(row), row.locked ? 'locked' : 'draft'];
    return [autoFill(blankLineup(), owned, stateOf, P), f.is_bot ? 'bot' : 'auto'];
  }, [row, owned]);
  const badge = kind === 'locked' ? ['🔒 Finalised', 'bg-green-600/30'] : kind === 'draft' ? ['📝 Draft (not locked)', 'bg-amber-400/20'] : kind === 'bot' ? ['🤖 Auto-picked', 'bg-white/10'] : ['⚙ No XI submitted — auto-picked', 'bg-white/10'];
  const ok = (pid) => pid != null && stateOf(pid).k === 'owned' && P[pid];
  const os = lu.slots.filter((s) => ok(s.pid) && P[s.pid].overseas).length;
  return (<div className="card space-y-2" style={{ borderColor: f.color }}>
    <div className="flex flex-wrap items-center gap-2"><h3 className="mr-auto text-lg font-bold" style={{ color: f.color }}>{f.team}</h3><span className={`rounded-full px-2 py-1 text-xs ${badge[1]}`}>{badge[0]}</span></div>
    <p className="text-xs text-slate-400">{f.owner} · ✈ {os}/{MAX_OS_XI} overseas in XI</p>
    <ol className="divide-y divide-white/10 text-sm">{lu.slots.map((s, i) => {
      const pl = ok(s.pid) ? P[s.pid] : null, bk = (lu.backups[i] || []).filter((pid) => P[pid] && stateOf(pid).k === 'owned');
      return (<li key={i} className="py-1"><div className="flex items-center gap-2"><span className="w-5 text-xs text-slate-500">{i + 1}</span>
        <span className="flex-1 truncate">{pl ? <>{pl.name} {pl.overseas && <span className="text-sky-300">✈</span>} <span className="text-xs text-slate-400">{SHORT[pl.role]}</span></> : <span className="text-slate-500">— empty —</span>}</span>
        {lu.captain === s.pid && pl && <b className="rounded bg-amber-400 px-1.5 text-xs text-black">C</b>}{lu.vice === s.pid && pl && <b className="rounded bg-sky-400 px-1.5 text-xs text-black">VC</b>}</div>
        {bk.length > 0 && <div className="pl-7 text-xs text-slate-400">Backup: {bk.map((pid) => P[pid].name).join(' › ')}</div>}</li>);
    })}</ol></div>);
}

export function XiShowcase({ fr, rows, rps, P, FR, room, mine }) {
  if (room.status !== 'done') return <div className="card text-sm text-slate-300">🏏 Playing XIs with captains and backups are revealed here when the auction ends.{mine ? ' Plan yours any time in the “My XI” tab.' : ''}</div>;
  const ordered = [...fr].sort((a, b) => (a.id === mine?.id ? -1 : b.id === mine?.id ? 1 : 0));
  return (<div className="space-y-2"><h3 className="text-lg font-bold">📋 Playing XIs</h3>
    <div className="grid gap-4 md:grid-cols-2">{ordered.map((f) => <XiCard key={f.id} f={f} row={(rows || []).find((r) => r.franchise_id === f.id)} rps={rps} P={P} FR={FR} />)}</div></div>);
}
