// Season simulator for the post-auction mini league. Pure functions, no React: the same seed always gives the same season,
// so every friend who opens "League" sees identical results without anything being stored in the database.
// All numbers are GAME ESTIMATES built from base-price tier + sold price - they are not real player ratings.

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const seedFrom = (str) => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
export const makeRng = (str) => { let a = seedFrom(str); return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const gauss = (r) => { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); };

const BW = [1.25, 1.25, 1.2, 1.15, 1.05, 0.95, 0.8, 0.55, 0.35, 0.2, 0.15];          // batting-order weights (slot 1..11)
const RF = { Batter: 1, Wicketkeeper: 0.98, 'All-rounder': 0.92, Bowler: 0.55 };      // how much of a player's rating counts as batting
const BASE_RUNS = 172, FILLER = 28, INJURY_CHANCE = 0.16;

// team = { id, team, color, xi:[{slot,pid,p,rating}], pool:Map(pid->{pid,p,rating}), backups:{slot:[pid]}, captain, vice }
export function strength(players, team, captainOut = false) {
  let bs = 0, ws = 0;
  players.forEach((x, i) => { bs += BW[i] * x.rating * (x.p ? RF[x.p.role] ?? 0.8 : 0.5); ws += BW[i]; });
  let bat = bs / ws;
  if (!players.some((x) => x.p?.role === 'Wicketkeeper')) bat -= 2;
  const eff = players.filter((x) => x.p && (x.p.role === 'Bowler' || x.p.role === 'All-rounder')).map((x) => (x.p.role === 'Bowler' ? x.rating : x.rating * 0.82)).sort((a, b) => b - a).slice(0, 5);
  while (eff.length < 5) eff.push(30);
  const bowl = eff.reduce((a, b) => a + b, 0) / 5;
  const cap = players.find((x) => x.pid != null && x.pid === team.captain), vc = players.find((x) => x.pid != null && x.pid === team.vice);
  const lr = cap && !captainOut ? cap.rating : vc ? vc.rating * 0.7 + 62 * 0.3 : 55;      // vice-captain takes over, a bit less effective
  const lead = clamp(((lr - 62) / 40) * 3, -1.5, 3);
  return { bat, bowl, lead, overall: 0.55 * bat + 0.45 * bowl + lead };
}

// pick today's XI: small chance a player is injured; the first backup of that slot steps in (no backup = a weak filler)
function todaysXI(team, r) {
  const players = team.xi.map((x) => ({ ...x })), injuries = []; let captainOut = false;
  if (r() < INJURY_CHANCE) {
    const idx = Math.floor(r() * 11), out = players[idx];
    if (out.p) {
      const bk = (team.backups[out.slot] || []).map((pid) => team.pool.get(pid)).find(Boolean);
      if (out.pid === team.captain) captainOut = true;
      players[idx] = bk ? { slot: out.slot, pid: bk.pid, p: bk.p, rating: bk.rating, sub: true } : { slot: out.slot, pid: null, p: null, rating: FILLER, sub: true };
      injuries.push({ team: team.id, out: out.p.name, in: bk ? bk.p.name : null });
    }
  }
  return { players, injuries, captainOut };
}

const innings = (r, bS, wS) => ({
  runs: clamp(Math.round(BASE_RUNS + 0.85 * (bS.bat - wS.bowl) + 1.5 * (bS.lead - wS.lead) + gauss(r) * 22), 85, 255),
  wk: clamp(Math.round(6.6 + (wS.bowl - bS.bat) * 0.1 + gauss(r) * 1.7), 2, 10),
});
function pick(r, weights) { const t = weights.reduce((a, b) => a + b, 0); let x = r() * t; for (let i = 0; i < weights.length; i++) { x -= weights[i]; if (x <= 0) return i; } return weights.length - 1; }

function playerStats(r, players, runs, wicketsTaken) {
  const w = players.map((x, i) => BW[i] * Math.pow(x.rating / 60, 2) * (x.p ? RF[x.p.role] ** 2 : 0.2) * (0.35 + r() * 1.3));
  const tot = w.reduce((a, b) => a + b, 0), net = Math.round(runs * 0.94);
  const bw = players.map((x) => (x.p ? (x.p.role === 'Bowler' ? 1 : x.p.role === 'All-rounder' ? 0.45 : 0.03) * Math.pow(x.rating / 60, 2) * (0.5 + r()) : 0));
  const wk = players.map(() => 0); for (let k = 0; k < wicketsTaken; k++) wk[pick(r, bw.map((v) => v + 0.001))]++;
  return players.map((x, i) => { const rn = Math.round((net * w[i]) / tot); return { pid: x.pid, name: x.p?.name || 'Emergency fielder', runs: rn, balls: rn ? Math.max(1, Math.round(rn / (0.85 + r() * 0.9))) : 0, wkts: wk[i], sub: !!x.sub }; }).filter((s) => s.pid != null);
}

function playMatch(r, t1, t2, stage) {
  const [A, B] = r() < 0.5 ? [t1, t2] : [t2, t1];                                   // A bats first (toss)
  const a = todaysXI(A, r), b = todaysXI(B, r);
  const sA = strength(a.players, A, a.captainOut), sB = strength(b.players, B, b.captainOut);
  const iA = innings(r, sA, sB), iB = innings(r, sB, sA);
  let winner, scoreA = { runs: iA.runs, wk: iA.wk, overs: 20 }, scoreB, result;
  if (iB.runs > iA.runs) {                                                          // B chases it down
    const wLost = clamp(iB.wk, 2, 9), left = clamp(Math.round(3 + (iB.runs - iA.runs) * 0.8 + r() * 12), 1, 66);
    scoreB = { runs: iA.runs + 1 + Math.floor(r() * 5), wk: wLost, overs: 20 - left / 6 }; winner = B;
    result = `${B.team} won by ${10 - wLost} wicket${10 - wLost === 1 ? '' : 's'} (${left} balls left)`;
  } else if (iB.runs < iA.runs) {
    scoreB = { runs: iB.runs, wk: clamp(iB.wk, 3, 10), overs: 20 }; winner = A;
    result = `${A.team} won by ${iA.runs - iB.runs} run${iA.runs - iB.runs === 1 ? '' : 's'}`;
  } else {
    scoreB = { runs: iA.runs, wk: clamp(iB.wk, 3, 9), overs: 20 };
    winner = r() < 0.5 + (sA.overall - sB.overall) * 0.01 ? A : B; result = `Scores level - ${winner.team} won the Super Over`;
  }
  const stA = playerStats(r, a.players, scoreA.runs, scoreB.wk), stB = playerStats(r, b.players, scoreB.runs, scoreA.wk);
  const wst = winner === A ? stA : stB;
  const potm = [...wst].sort((x, y) => (y.runs + 24 * y.wkts + r()) - (x.runs + 24 * x.wkts + r()))[0];
  const line = [potm.runs > 0 ? `${potm.runs} (${potm.balls})` : '', potm.wkts > 0 ? `${potm.wkts} wkt${potm.wkts > 1 ? 's' : ''}` : ''].filter(Boolean).join(' & ');
  return { stage, a: A.id, b: B.id, sA: scoreA, sB: scoreB, winner: winner.id, result, potm: { ...potm, team: winner.id, line },
    inj: [...a.injuries, ...b.injuries], stats: { [A.id]: stA, [B.id]: stB } };
}

// matches = array of match objects (any prefix of the season). Table counts league matches only; caps count everything.
export function aggregate(matches, teams) {
  const T = {}; teams.forEach((t) => { T[t.id] = { id: t.id, P: 0, W: 0, L: 0, pts: 0, rf: 0, of: 0, ra: 0, oa: 0, nrr: 0 }; });
  const pl = {};
  matches.forEach((m) => {
    if (m.stage === 'league') {
      const a = T[m.a], b = T[m.b]; a.P++; b.P++;
      a.rf += m.sA.runs; a.of += m.sA.overs; a.ra += m.sB.runs; a.oa += m.sB.overs;
      b.rf += m.sB.runs; b.of += m.sB.overs; b.ra += m.sA.runs; b.oa += m.sA.overs;
      const w = T[m.winner], l = T[m.winner === m.a ? m.b : m.a]; w.W++; w.pts += 2; l.L++;
    }
    Object.entries(m.stats).forEach(([tid, list]) => list.forEach((s) => {
      const p = pl[s.pid] || (pl[s.pid] = { pid: s.pid, name: s.name, team: tid, runs: 0, balls: 0, wkts: 0, mom: 0 });
      p.runs += s.runs; p.balls += s.balls; p.wkts += s.wkts;
    }));
    if (pl[m.potm.pid]) pl[m.potm.pid].mom++;
  });
  const table = Object.values(T).map((x) => ({ ...x, nrr: (x.of ? x.rf / x.of : 0) - (x.oa ? x.ra / x.oa : 0) })).sort((p, q) => q.pts - p.pts || q.nrr - p.nrr);
  const all = Object.values(pl);
  return { table, orange: [...all].sort((p, q) => q.runs - p.runs).slice(0, 5), purple: [...all].sort((p, q) => q.wkts - p.wkts || q.runs - p.runs).slice(0, 5),
    mvp: [...all].map((p) => ({ ...p, pts: p.runs + 24 * p.wkts + 30 * p.mom })).sort((p, q) => q.pts - p.pts).slice(0, 5) };
}

export function simulateSeason(teams, seed) {
  const r = makeRng(seed), n = teams.length;
  if (n < 3) return { matches: [], leagueCount: 0, champion: null, runnerUp: null, error: 'Need at least 3 teams' };
  const arr = [...teams]; if (arr.length % 2) arr.push(null);
  const m = arr.length, rounds = [];
  for (let k = 0; k < m - 1; k++) { const pairs = []; for (let i = 0; i < m / 2; i++) { const a = arr[i], b = arr[m - 1 - i]; if (a && b) pairs.push([a, b]); } rounds.push(pairs); arr.splice(1, 0, arr.pop()); }
  const fixtures = []; for (let leg = 0; leg < (n >= 8 ? 1 : 2); leg++) rounds.forEach((p) => p.forEach((f) => fixtures.push(f)));
  for (let i = fixtures.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [fixtures[i], fixtures[j]] = [fixtures[j], fixtures[i]]; }   // seeded shuffle
  const matches = fixtures.map(([a, b]) => playMatch(r, a, b, 'league'));
  const byId = Object.fromEntries(teams.map((t) => [t.id, t]));
  const top = aggregate(matches, teams).table.map((x) => byId[x.id]);
  const loser = (mm) => byId[mm.winner === mm.a ? mm.b : mm.a], win = (mm) => byId[mm.winner];
  let final;
  if (n === 3) { final = playMatch(r, top[0], top[1], 'Final'); matches.push(final); }
  else {
    const q1 = playMatch(r, top[0], top[1], 'Qualifier 1'), el = playMatch(r, top[2], top[3], 'Eliminator');
    const q2 = playMatch(r, loser(q1), win(el), 'Qualifier 2'); final = playMatch(r, win(q1), win(q2), 'Final');
    matches.push(q1, el, q2, final);
  }
  return { matches, leagueCount: fixtures.length, champion: byId[final.winner], runnerUp: loser(final) };
}
