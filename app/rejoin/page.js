'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { sb, ensureUser } from '../../lib/supabase';
import { IPL_TEAMS } from '../../lib/teams';

export default function Rejoin() {
  const r = useRouter();
  const [f, setF] = useState({ code: '', team: '', pin: '' });
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { const c = new URLSearchParams(window.location.search).get('code'); if (c) setF((x) => ({ ...x, code: c.toUpperCase() })); }, []);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function go(e) {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      await ensureUser();
      const { data, error } = await sb.rpc('recover_franchise', { p_code: f.code, p_team: f.team, p_pin: f.pin });
      if (error) throw error;
      if (data !== 'ok') { setErr(data); setBusy(false); return; }
      r.push('/room/' + f.code.toUpperCase());
    } catch (x) { setErr(x.message); setBusy(false); }
  }
  return (<form onSubmit={go} className="card mx-auto mt-6 max-w-md space-y-3">
    <h1 className="text-xl font-bold">Rejoin with your recovery PIN</h1>
    <p className="text-sm text-slate-300">Switched phone or cleared your browser? Enter your room code, your franchise and the 6-digit PIN shown on your lobby / room page (🔑 button). If you were the host, you get host controls back too.</p>
    <input required className="inp uppercase" placeholder="Room code" value={f.code} onChange={set('code')} />
    <select required className="inp" value={f.team} onChange={set('team')}><option value="">Your franchise</option>{IPL_TEAMS.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}</select>
    <input required inputMode="numeric" pattern="[0-9]{6}" maxLength={6} className="inp tracking-widest" placeholder="6-digit PIN" value={f.pin} onChange={set('pin')} />
    {err && <p className="text-sm text-red-400">{err}</p>}
    <button disabled={busy} className="btn w-full bg-amber-400 text-black">Rejoin my franchise</button>
    <a href="/" className="block text-center text-sm text-slate-400 underline">Back to home</a>
  </form>);
}
