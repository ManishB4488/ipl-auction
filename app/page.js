'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { sb, ensureUser } from '../lib/supabase';
import { IPL_TEAMS, teamInfo } from '../lib/teams';
import { Logo } from './components';

function Form({ mode }) {
  const r = useRouter();
  const [f, setF] = useState({ code: '', room: '', owner: '', team: '', sets: 99, retained: true, order: 'role' });
  const [taken, setTaken] = useState([]);
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  useEffect(() => {
    if (mode !== 'join' || f.code.length < 6) { setTaken([]); return; }
    sb.rpc('room_by_code', { p_code: f.code }).then(({ data }) => setTaken((data && data.teams) || []));
  }, [f.code, mode]);
  async function go(e) {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      await ensureUser();
      const color = teamInfo(f.team).color;
      if (mode === 'create') {
        const { data, error } = await sb.rpc('create_room', { p_name: f.room, p_owner: f.owner, p_team: f.team, p_color: color, p_max_set: +f.sets, p_retained: f.retained, p_order: f.order });
        if (error) throw error; r.push(`/room/${data}`);
      } else {
        const { error } = await sb.rpc('join_room', { p_code: f.code, p_owner: f.owner, p_team: f.team, p_color: color });
        if (error) throw error; r.push(`/room/${f.code.toUpperCase()}`);
      }
    } catch (x) { setErr(/duplicate/i.test(x.message) ? 'That team is already taken in this room — pick another.' : x.message); setBusy(false); }
  }
  return (<form onSubmit={go} className="card space-y-3">
    <h2 className="text-lg font-bold">{mode === 'create' ? 'Create Auction (you are the host)' : 'Join Auction'}</h2>
    {mode === 'create' ? <input required className="inp" placeholder="Auction room name" value={f.room} onChange={set('room')} />
      : <input required className="inp uppercase" placeholder="Room code" value={f.code} onChange={set('code')} />}
    <input required className="inp" placeholder="Your display name" value={f.owner} onChange={set('owner')} />
    <div className="flex items-center gap-3">
      {f.team && <Logo team={f.team} size={40} />}
      <select required className="inp" value={f.team} onChange={set('team')}>
        <option value="">Choose your IPL franchise</option>
        {IPL_TEAMS.map((t) => <option key={t.name} value={t.name} disabled={taken.includes(t.name)}>{t.name}{taken.includes(t.name) ? ' (taken)' : ''}</option>)}
      </select></div>
    {mode === 'create' && <label className="block text-sm">Player pool: use first N auction sets (46 = all players)
      <input type="number" min="1" max="46" className="inp mt-1" value={f.sets} onChange={set('sets')} /></label>}
    {mode === 'create' && <label className="block text-sm">Auction order<select className="inp mt-1" value={f.order} onChange={set('order')}><option value="role">By category: Batters → Wicketkeepers → All-rounders → Bowlers</option><option value="sets">Official IPL set order</option></select></label>}
    {mode === 'create' && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.retained} onChange={(e) => setF({ ...f, retained: e.target.checked })} /> Include retained stars (Kohli, Gill, Rohit… auctioned first)</label>}
    {err && <p className="text-red-400 text-sm">{err}</p>}
    <button disabled={busy} className="btn w-full bg-amber-400 text-black">{mode === 'create' ? 'Create room' : 'Join room'}</button>
  </form>);
}
export default function Home() {
  return (<div className="space-y-6">
    <section className="text-center py-6"><h1 className="text-3xl md:text-5xl font-extrabold">Run your own IPL 2026 mega auction</h1>
      <p className="mt-3 text-slate-300">3–10 friends · pick an IPL franchise · ₹120 Cr purse · empty seats are filled by AI bot teams.</p></section>
    <div className="grid gap-4 md:grid-cols-2"><Form mode="create" /><Form mode="join" /></div>
    <p className="text-center text-sm text-slate-400">Spectators: just open the room link your host shares. · <a href="/rejoin" className="text-amber-400 underline">Lost access to your team? Rejoin with your PIN</a></p></div>);
}
