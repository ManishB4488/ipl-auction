import { createClient } from '@supabase/supabase-js';
export const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
// Guest session: Supabase anonymous auth, persisted by the browser, so refresh/reconnect keeps the same identity.
export async function ensureUser() {
  let { data: { session } } = await sb.auth.getSession();
  if (!session) {
    const { data, error } = await sb.auth.signInAnonymously();
    if (error) throw error;
    session = data.session;
  }
  return session.user;
}
export const cr = (l) => (l == null ? '—' : l >= 100 ? `₹${+(l / 100).toFixed(2)} Cr` : `₹${l} L`);
export const SET_LABELS = { BA: 'Capped Batters', AL: 'Capped All-rounders', WK: 'Capped Wicketkeepers', FA: 'Capped Fast Bowlers', SP: 'Capped Spinners', RBA: 'Retained Stars – Batters', RAL: 'Retained Stars – All-rounders', RWK: 'Retained Stars – Wicketkeepers', RBO: 'Retained Stars – Bowlers', UBA: 'Uncapped Batters', UAL: 'Uncapped All-rounders', UWK: 'Uncapped Wicketkeepers', UFA: 'Uncapped Fast Bowlers', USP: 'Uncapped Spinners' };
export const setLabel = (code) => `${SET_LABELS[code.replace(/\d+/g, '')] || code} (${code})`;
