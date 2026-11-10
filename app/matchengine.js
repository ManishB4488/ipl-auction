// Interactive T20 match engine. Pure functions (no React / DB), deterministic: the same state + choices always give the same over,
// so two browsers can both compute it and agree. All ratings are game estimates built from the auction (base tier + price).
//
// Flow: toss -> innings 1 -> innings 2 -> finished. Every over BOTH sides lock in a decision:
//   batting side : { intent: 'defend'|'normal'|'attack', impact?: {out, in} }
//   bowling side : { bowler: xiIndex,                    impact?: {out, in} }
// Missing decisions (AFK past the deadline) and bots use aiChoice(). Impact player = swap one unused XI player with a bench player, once per match.
import { makeRng, clamp } from './leaguesim';

export const OVERS = 20;
export const MAX_BOWL_BALLS = 24;
export const DECIDE_MS = 30000;
const RFB = { Batter: 1, Wicketkeeper: 0.98, 'All-rounder': 0.92, Bowler: 0.55 };       // share of rating that counts as batting skill
const BF = { Bowler: 1, 'All-rounder': 0.82, Wicketkeeper: 0.4, Batter: 0.45 };          // ... as bowling skill
export const other = (s) => (s === 'A' ? 'B' : 'A');
const clone = (o) => JSON.parse(JSON.stringify(o));
const FILLER = { pid: null, name: 'Emergency fielder', role: 'Batter', ovs: false, rt: 28 };

// side = what is stored in the match: the XI (batting order), bench (backups) and captain / vice-captain slot numbers
export function makeSide(team) {
  const xi = team.xi.map((x) => (x.p ? { pid: x.pid, name: x.p.name, role: x.p.role, ovs: !!x.p.overseas, rt: Math.round(x.rating) } : { ...FILLER }));
  const inXI = new Set(team.xi.map((x) => x.pid)), order = [];
  Object.values(team.backups).flat().forEach((pid) => { if (!order.includes(pid)) order.push(pid); });
  [...team.pool.keys()].forEach((pid) => { if (!inXI.has(pid) && !order.includes(pid)) order.push(pid); });
  const bench = order.slice(0, 7).map((pid) => { const q = team.pool.get(pid); return { pid, name: q.p.name, role: q.p.role, ovs: !!q.p.overseas, rt: Math.round(q.rating) }; });
  const slot = (pid) => { const i = team.xi.findIndex((x) => x.pid != null && x.pid === pid); return i >= 0 ? i : null; };
  return { fid: team.id, team: team.team, color: team.color, owner: team.owner, bot: !!team.is_bot, xi, bench, captain: slot(team.captain), vice: slot(team.vice), used: {}, impactUsed: false };
}

export function newMatchState({ seed, A, B }) {
  const w = makeRng(seed + '-toss')() < 0.5 ? 'A' : 'B';
  return { v: 1, seed, sides: { A, B }, toss: { winner: w, elected: null }, status: 'toss', inn: 0, key: 0, innings: [], choices: {}, deadline: null, target: null, result: null, log: [] };
}

// ---------- skills & ball model ----------
const lead = (sd) => { const c = sd.captain != null ? sd.xi[sd.captain] : null, v = sd.vice != null ? sd.xi[sd.vice] : null; const rt = c ? c.rt : v ? v.rt * 0.7 + 62 * 0.3 : 55; return clamp(((rt - 62) / 40) * 3, -1.5, 3); };
export const batSkill = (S, side, i) => { const p = S.sides[side].xi[i]; return p.rt * (RFB[p.role] ?? 0.8) + lead(S.sides[side]); };
export const bowlSkill = (S, side, i) => { const p = S.sides[side].xi[i]; return p.rt * (BF[p.role] ?? 0.45) + lead(S.sides[side]); };

const INTENT = { attack: { dot: 0.78, r1: 0.9, r2: 1, r4: 1.35, r6: 1.65, W: 1.55 }, normal: {}, defend: { dot: 1.3, r1: 1.1, r2: 1, r4: 0.65, r6: 0.45, W: 0.65 } };
function ballProbs(bat, bowl, intent, over) {
  const d = clamp((bat - bowl) / 50, -0.8, 0.8);
  const w = { dot: 0.35, r1: 0.3, r2: 0.07, r3: 0.008, r4: 0.105, r6: 0.058, W: 0.046, wd: 0.037 };
  w.dot *= clamp(1 - 0.3 * d, 0.4, 1.6); w.r4 *= clamp(1 + 0.6 * d, 0.3, 2); w.r6 *= clamp(1 + 0.9 * d, 0.2, 2.5); w.W *= clamp(1 - 0.7 * d, 0.25, 2.2);
  const I = INTENT[intent] || {}; Object.keys(I).forEach((k) => { w[k] *= I[k]; });
  if (over < 6) { w.r4 *= 1.15; w.r6 *= 1.08; } else if (over >= 16) { w.r6 *= 1.15; w.r4 *= 1.05; w.W *= 1.1; } else w.dot *= 1.06;
  return w;
}
const draw = (r, w) => { const keys = Object.keys(w), t = keys.reduce((a, k) => a + w[k], 0); let x = r() * t; for (const k of keys) { x -= w[k]; if (x <= 0) return k; } return 'dot'; };

// ---------- AI (bots, and the default for anybody who runs out of time) ----------
function aiBowler(S, inn, r) {
  const sd = S.sides[inn.bowl];
  const cands = sd.xi.map((_, i) => i).filter((i) => (inn.bowlers[i]?.b || 0) < MAX_BOWL_BALLS && i !== inn.last);
  const pool = cands.length ? cands : sd.xi.map((_, i) => i).filter((i) => (inn.bowlers[i]?.b || 0) < MAX_BOWL_BALLS);
  const sc = (i) => bowlSkill(S, inn.bowl, i) - 2.5 * ((inn.bowlers[i]?.b || 0) / 6) + r() * 3 + (inn.over >= 16 ? 0.25 * bowlSkill(S, inn.bowl, i) * ((24 - (inn.bowlers[i]?.b || 0)) / 24) : 0);
  return (pool.length ? pool : [0]).sort((a, b) => sc(b) - sc(a))[0];
}
function aiIntent(S, inn) {
  const left = OVERS - inn.over, w = 10 - inn.wkts;
  if (S.inn === 2) {
    const need = S.target - inn.runs, rrr = need / left;
    if (rrr > 11 || (left <= 3 && rrr > 8.5)) return 'attack';
    if (w <= 3 && rrr < 9) return 'defend';
    return rrr < 7 && inn.over < 16 ? 'normal' : rrr > 9 ? 'attack' : 'normal';
  }
  if (inn.over >= 16) return 'attack';
  if (inn.wkts >= 5 && inn.over < 14) return 'defend';
  return inn.over < 3 ? 'normal' : 'normal';
}
export function aiChoice(S, side) {
  if (S.status === 'toss') return { elect: 'bowl' };
  const inn = S.innings[S.inn - 1], r = makeRng(`${S.seed}-ai-${S.key}-${side}`);
  const c = side === inn.bat ? { intent: aiIntent(S, inn) } : { bowler: aiBowler(S, inn, r) };
  const sd = S.sides[side];
  if (!sd.impactUsed && inn.over === 0 && S.inn === 1 && sd.bench.length) {            // bots use the impact player early if it is a clear upgrade
    const slots = sd.xi.map((p, i) => ({ p, i })).filter(({ i }) => !sd.used[i] && i !== sd.captain).sort((a, b) => a.p.rt - b.p.rt);
    const best = sd.bench.map((p, i) => ({ p, i })).sort((a, b) => b.p.rt - a.p.rt)[0];
    if (slots[0] && best && best.p.rt > slots[0].p.rt + 6) c.impact = { out: slots[0].i, in: best.i };
  }
  return c;
}

// ---------- state transitions ----------
function startInnings(S, n, bat) {
  S.inn = n;
  const mk = (i) => ({ n: S.sides[bat].xi[i].name, r: 0, b: 0, f: 0, s: 0, out: null });
  S.innings.push({ bat, bowl: other(bat), runs: 0, wkts: 0, balls: 0, extras: 0, striker: 0, non: 1, next: 2, batters: { 0: mk(0), 1: mk(1) }, bowlers: {}, last: null, fow: [], overs: [], over: 0, done: false });
  S.sides[bat].used[0] = true; S.sides[bat].used[1] = true; S.key = n * 100;
}
function applyImpact(S, side, imp) {
  const sd = S.sides[side];
  if (!imp || sd.impactUsed || !Number.isInteger(imp.out) || !Number.isInteger(imp.in)) return;
  if (imp.out < 0 || imp.out > 10 || imp.in < 0 || imp.in >= sd.bench.length || sd.used[imp.out]) return;
  const old = sd.xi[imp.out], nw = sd.bench[imp.in];
  sd.xi[imp.out] = nw; sd.bench.splice(imp.in, 1); sd.impactUsed = true;
  if (sd.captain === imp.out) sd.captain = null; if (sd.vice === imp.out) sd.vice = null;
  S.log.push(`⚡ ${sd.team}: impact player ${nw.name} replaces ${old.name}`);
}

function playOver(S, ch) {
  const inn = S.innings[S.inn - 1], batS = S.sides[inn.bat], bowlS = S.sides[inn.bowl];
  applyImpact(S, inn.bat, ch[inn.bat]?.impact); applyImpact(S, inn.bowl, ch[inn.bowl]?.impact);
  const r = makeRng(`${S.seed}-${S.inn}-${inn.over}`);
  let bi = ch[inn.bowl]?.bowler;
  const okBowler = Number.isInteger(bi) && bi >= 0 && bi <= 10 && (inn.bowlers[bi]?.b || 0) < MAX_BOWL_BALLS && bi !== inn.last;
  if (!okBowler) bi = aiBowler(S, inn, makeRng(`${S.seed}-fb-${S.key}`));
  const intent = ['defend', 'normal', 'attack'].includes(ch[inn.bat]?.intent) ? ch[inn.bat].intent : aiIntent(S, inn);
  bowlS.used[bi] = true;
  const bw = inn.bowlers[bi] || (inn.bowlers[bi] = { n: bowlS.xi[bi].name, b: 0, r: 0, w: 0 });
  const over = { n: inn.over + 1, bowler: bowlS.xi[bi].name, intent, runs: 0, w: 0, tok: [] };
  let legal = 0;
  while (legal < 6 && !inn.done) {
    const bat = inn.batters[inn.striker];
    const o = draw(r, ballProbs(batSkill(S, inn.bat, inn.striker), bowlSkill(S, inn.bowl, bi), intent, inn.over));
    if (o === 'wd') { inn.runs++; inn.extras++; bw.r++; over.runs++; over.tok.push('Wd'); }
    else {
      legal++; inn.balls++; bw.b++; bat.b++;
      if (o === 'W') {
        inn.wkts++; bw.w++; over.w++; over.tok.push('W');
        const kind = r(); const fielder = bowlS.xi[Math.floor(r() * 11)].name;
        bat.out = kind < 0.25 ? `b ${bw.n}` : kind < 0.4 ? `lbw b ${bw.n}` : `c ${fielder === bw.n ? '&' : fielder} b ${bw.n}`;
        inn.fow.push(`${inn.runs}-${inn.wkts} (${bat.n}, ${inn.over}.${legal})`);
        if (inn.wkts >= 10) inn.done = true;
        else { inn.striker = inn.next++; batS.used[inn.striker] = true; inn.batters[inn.striker] = { n: batS.xi[inn.striker].name, r: 0, b: 0, f: 0, s: 0, out: null }; }
      } else {
        const runs = o === 'dot' ? 0 : +o.slice(1);
        inn.runs += runs; bat.r += runs; bw.r += runs; over.runs += runs; over.tok.push(runs === 0 ? '•' : String(runs));
        if (runs === 4) bat.f++; if (runs === 6) bat.s++;
        if (runs % 2 === 1) [inn.striker, inn.non] = [inn.non, inn.striker];
        if (S.inn === 2 && inn.runs >= S.target) inn.done = true;
      }
    }
  }
  if (!inn.done || legal === 6) [inn.striker, inn.non] = [inn.non, inn.striker];       // end-of-over strike change
  inn.last = bi; inn.overs.push(over); inn.over++;
  if (inn.over >= OVERS) inn.done = true;
}

function finish(S) {
  const [i1, i2] = S.innings, bat1 = S.sides[i1.bat], bat2 = S.sides[i2.bat];
  let side, text, tie = false;
  if (i2.runs >= S.target) { side = i2.bat; const left = OVERS * 6 - i2.balls; text = `${bat2.team} won by ${10 - i2.wkts} wicket${10 - i2.wkts === 1 ? '' : 's'} (${left} balls left)`; }
  else if (i2.runs < i1.runs) { side = i1.bat; text = `${bat1.team} won by ${i1.runs - i2.runs} run${i1.runs - i2.runs === 1 ? '' : 's'}`; }
  else { tie = true; side = makeRng(S.seed + '-coin')() < 0.5 ? 'A' : 'B'; text = `Scores level — ${S.sides[side].team} won the coin toss decider`; }
  const pts = {};
  [i1, i2].forEach((inn) => { Object.values(inn.batters).forEach((b) => { if (S.sides[inn.bat] && side === inn.bat) { pts[b.n] = pts[b.n] || { n: b.n, r: 0, b: 0, w: 0 }; pts[b.n].r += b.r; pts[b.n].b += b.b; } });
    Object.values(inn.bowlers).forEach((b) => { if (side === inn.bowl) { pts[b.n] = pts[b.n] || { n: b.n, r: 0, b: 0, w: 0 }; pts[b.n].w += b.w; } }); });
  const potm = Object.values(pts).sort((a, b) => (b.r + 24 * b.w) - (a.r + 24 * a.w))[0];
  const line = potm ? [potm.r > 0 ? `${potm.r} (${potm.b})` : '', potm.w > 0 ? `${potm.w} wkt${potm.w > 1 ? 's' : ''}` : ''].filter(Boolean).join(' & ') : '';
  S.status = 'finished'; S.deadline = null; S.choices = {};
  S.result = { side, fid: S.sides[side].fid, text, tie, potm: potm ? { name: potm.n, line, team: S.sides[side].team } : null };
}

// Returns the next state if something should happen now (arm the clock, toss decided, over played, ...), otherwise null.
export function advance(st, now) {
  if (!st || st.status === 'finished') return null;
  const S = clone(st);
  if (S.deadline == null) { S.deadline = now + DECIDE_MS; return S; }
  if (S.status === 'toss') {
    const w = S.toss.winner, c = S.choices[w], bot = S.sides[w].bot;
    if (!(bot || c || now >= S.deadline)) return null;
    const elect = bot ? 'bowl' : c?.elect === 'bowl' ? 'bowl' : c?.elect === 'bat' ? 'bat' : 'bat';
    S.toss.elected = elect; S.log.push(`🪙 ${S.sides[w].team} won the toss and chose to ${elect}`);
    S.status = 'playing'; S.choices = {}; startInnings(S, 1, elect === 'bat' ? w : other(w)); S.deadline = now + DECIDE_MS; return S;
  }
  const inn = S.innings[S.inn - 1], ready = (x) => S.sides[x].bot || S.choices[x];
  if (!((ready('A') && ready('B')) || now >= S.deadline)) return null;
  const ch = { A: S.choices.A || aiChoice(S, 'A'), B: S.choices.B || aiChoice(S, 'B') };
  playOver(S, ch); S.choices = {};
  if (inn.done) {
    if (S.inn === 1) { S.target = inn.runs + 1; S.log.push(`⏸ Innings break: ${S.sides[inn.bat].team} ${inn.runs}/${inn.wkts}. Target ${S.target}`); startInnings(S, 2, inn.bowl); }
    else finish(S);
  } else S.key = S.inn * 100 + inn.over;
  S.deadline = S.status === 'finished' ? null : now + DECIDE_MS;
  if (S.log.length > 30) S.log = S.log.slice(-30);
  return S;
}

// small helpers for the screen
export const oversText = (balls) => `${Math.floor(balls / 6)}.${balls % 6}`;
export function chaseInfo(S) {
  if (S.inn !== 2 || !S.target) return null;
  const inn = S.innings[1], need = S.target - inn.runs, left = OVERS * 6 - inn.balls;
  return { need, left, rrr: left > 0 ? (need / left) * 6 : 0 };
}
