'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { sb, ensureUser } from '../lib/supabase';

function Form({ mode }) {
  const r = useRouter();
  const [f, setF] = useState({ code: '', room: '', owner: '', team: '', color: '#f59e0b', sets: 99 });
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function go(e) {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      await ensureUser();
      if (mode === 'create') {
        const { data, error } = await sb.rpc('create_room', { p_name: f.room, p_owner: f.owner, p_team: f.team, p_color: f.color, p_max_set: +f.sets });
        if (error) throw error; r.push(`/room/${data}`);
      } else {
        const { error } = await sb.rpc('join_room', { p_code: f.code, p_owner: f.owner, p_team: f.team, p_color: f.color });
        if (error) throw error; r.push(`/room/${f.code.toUpperCase()}`);
      }
    } catch (x) { setErr(x.message); setBusy(false); }
  }
  return (<form onSubmit={go} className="card space-y-3">
    <h2 className="text-lg font-bold">{mode === 'create' ? 'Create Auction (you are the host)' : 'Join Auction'}</h2>
    {mode === 'create' ? <input required className="inp" placeholder="Auction room name" value={f.room} onChange={set('room')} />
      : <input required className="inp uppercase" placeholder="Room code" value={f.code} onChange={set('code')} />}
    <input required className="inp" placeholder="Your display name" value={f.owner} onChange={set('owner')} />
    <input required className="inp" placeholder="Franchise name" value={f.team} onChange={set('team')} />
    <label className="flex items-center gap-3 text-sm">Team colour <input type="color" value={f.color} onChange={set('color')} /></label>
    {mode === 'create' && <label className="block text-sm">Player pool: use first N auction sets (42 = all players)
      <input type="number" min="1" max="42" className="inp mt-1" value={f.sets} onChange={set('sets')} /></label>}
    {err && <p className="text-red-400 text-sm">{err}</p>}
    <button disabled={busy} className="btn w-full bg-amber-400 text-black">{mode === 'create' ? 'Create room' : 'Join room'}</button>
  </form>);
}
export default function Home() {
  return (<div className="space-y-6">
    <section className="text-center py-6"><h1 className="text-3xl md:text-5xl font-extrabold">Run your own IPL 2026 mega auction</h1>
      <p className="mt-3 text-slate-300">3–10 friends · one franchise each · ₹120 Cr purse · real-time bidding on the official IPL 2026 auction list.</p></section>
    <div className="grid gap-4 md:grid-cols-2"><Form mode="create" /><Form mode="join" /></div>
    <p className="text-center text-sm text-slate-400">Spectators: just open the room link your host shares.</p></div>);
}
