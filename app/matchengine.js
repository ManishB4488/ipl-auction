// Interactive T20 match engine. Pure functions (no React / DB), deterministic: the same state + choices always give the same ball,
// so two browsers can both compute it and agree. All ratings are game estimates built from the auction (base tier + price).
//
// Flow: toss -> innings 1 -> innings 2 -> finished. Each over has two kinds of steps:
//   step 'bowler' : the BOWLING side picks who bowls and a plan:   { bowler: xiIndex, plan: 'hunt'|'balanced'|'tight' }
//   step 'ball'   : the BATTING  side picks the shot for EVERY ball: { shot: 0|1|2|4|6 }   (0 = block)
// Either side may also add { impact: {out, in} } : swap ANY XI player with ANY bench player, once per match.
// Anybody who runs out of time (and bots) get aiChoice().
import { makeRng, clamp } from './leaguesim';

export const OVERS = 20;
export const MAX_BOWL_BALLS = 24;
export const DECIDE_MS = 30000;      // toss / choosing the bowler
export const BALL_MS = 20000;        // each ball
export const SHOTS = [1, 2, 4, 6, 0];
const WIDE = 0.035;
const RFB = { Batter: 1, Wicketkeeper: 0.98, 'All-rounder': 0.92, Bowler: 0.55 };       // share of rating that counts as batting skill
const BF = { Bowler: 1, 'All-rounder': 0.82, Wicketkeeper: 0.4, Batter: 0.45 };          // ... as bowling skill
export const other = (s) => (s === 'A' ? 'B' : 'A');
const clone = (o) => JSON.parse(JSON.stringify(o));
const FILLER = { pid: null, name: 'Emergency fielder', role: 'Batter', ovs: false, rt: 28 };

export function makeSide(team) {
  const xi = team.xi.map((x) => (x.p ? { pid: x.pid, name: x.p.name, role: x.p.role, ovs: !!x.p.overseas, rt: Math.round(x.rating) } : { ...FILLER }));
  const inXI = new Set(team.xi.map((x) => x.pid)), order = [];
  Object.values(team.backups).flat().forEach((pid) => { if (!order.includes(pid)) order.push(pid); });
  [...team.pool.keys()].forEach((pid) => { if (!inXI.has(pid) && !order.includes(pid)) order.push(pid); });
  const bench = order.slice(0, 7).map((pid) => { const q = team.pool.get(pid); return { pid, name: q.p.name, role: q.p.role, ovs: !!q.p.overseas, rt: Math.round(q.rating) }; });
  const slot = (pid) => { const i = team.xi.findIndex((x) => x.pid != null && x.pid === pid); return i >= 0 ? i : null; };
  return { fid: team.id, team: team.team, color: team.color, owner: team.owner, bot: !!team.is_bot, xi, bench, captain: slot(team.captain), vice: slot(team.vice), impactUsed: false };
}

export function newMatchState({ seed, A, B }) {
  const w = makeRng(seed + '-toss')() < 0.5 ? 'A' : 'B';
  return { v: 2, seed, sides: { A, B }, toss: { winner: w, elected: null }, status: 'toss', inn: 0, key: 0, innings: [], cur: null, choices: {}, deadline: null, target: null, result: null, log: [], lastBall: null };
}

// ---------- skills & shot model ----------
const lead = (sd) => { const c = sd.captain != null ? sd.xi[sd.captain] : null, v = sd.vice != null ? sd.xi[sd.vice] : null; const rt = c ? c.rt : v ? v.rt * 0.7 + 62 * 0.3 : 55; return clamp(((rt - 62) / 40) * 3, -1.5, 3); };
export const batSkill = (S, side, i) => { const p = S.sides[side].xi[i]; return p.rt * (RFB[p.role] ?? 0.8) + lead(S.sides[side]); };
export const bowlSkill = (S, side, i) => { const p = S.sides[side].xi[i]; return p.rt * (BF[p.role] ?? 0.45) + lead(S.sides[side]); };

// what can happen on a ball when the batter tries for `shot` runs. r1..r6 = runs scored, dot = no run, W = out
const SHOT_BASE = {
  0: { dot: 0.93, r1: 0.045, W: 0.025 },
  1: { r1: 0.88, dot: 0.08, W: 0.015, r2: 0.025 },
  2: { r2: 0.47, r1: 0.23, dot: 0.12, W: 0.085, r3: 0.02, r4: 0.035 },
  4: { r4: 0.48, r1: 0.12, r2: 0.08, dot: 0.13, W: 0.15, r6: 0.015 },
  6: { r6: 0.32, r4: 0.09, r2: 0.04, r1: 0.06, dot: 0.2, W: 0.24 },
};
export function shotProbs(batSk, bowlSk, shot, plan, over) {
  const d = clamp((batSk - bowlSk) / 50, -0.8, 0.8), p = { ...SHOT_BASE[shot] }, key = 'r' + shot, big = shot >= 4;
  if (shot > 0) p[key] *= clamp(1 + (big ? 0.45 : 0.15) * d, 0.4, 1.7);
  p.W *= clamp(1 - 0.7 * d, 0.3, 2.2);
  if (plan === 'hunt') { p.W *= 1.35; if (big) p[key] *= 1.1; } else if (plan === 'tight') { p.W *= 0.75; if (big) p[key] *= 0.8; }
  if (over < 6) { if (big) p[key] *= 1.15; } else if (over >= 16) { if (shot === 6) p.r6 *= 1.1; p.W *= 1.05; }
  const t = Object.values(p).reduce((a, b) => a + b, 0); Object.keys(p).forEach((k) => { p[k] /= t; });
  return p;
}
// for the screen: chance of getting exactly the shot you wanted, and chance of getting out, for the CURRENT ball
export function shotTable(S, shot) {
  const inn = S.innings[S.inn - 1]; if (!inn || !S.cur) return null;
  const p = shotProbs(batSkill(S, inn.bat, inn.striker), bowlSkill(S, inn.bowl, S.cur.bowler), shot, S.cur.plan, inn.over);
  return { succ: shot === 0 ? p.dot : p['r' + shot] || 0, out: p.W };
}
const draw = (r, w) => { const keys = Object.keys(w), t = keys.reduce((a, k) => a + w[k], 0); let x = r() * t; for (const k of keys) { x -= w[k]; if (x <= 0) return k; } return 'dot'; };

// ---------- AI (bots, and the default for anybody who runs out of time) ----------
function aiBowler(S, inn, r) {
  const sd = S.sides[inn.bowl], all = sd.xi.map((_, i) => i);
  const cands = all.filter((i) => (inn.bowlers[i]?.b || 0) < MAX_BOWL_BALLS && i !== inn.last);
  const pool = cands.length ? cands : all.filter((i) => (inn.bowlers[i]?.b || 0) < MAX_BOWL_BALLS);
  const sc = (i) => bowlSkill(S, inn.bowl, i) - 2.5 * ((inn.bowlers[i]?.b || 0) / 6) + r() * 3 + (inn.over >= 16 ? 0.25 * bowlSkill(S, inn.bowl, i) * ((24 - (inn.bowlers[i]?.b || 0)) / 24) : 0);
  return (pool.length ? pool : [0]).sort((a, b) => sc(b) - sc(a))[0];
}
function aiPlan(S, inn) {
  if (S.inn === 2) { const rrr = ((S.target - inn.runs) / Math.max(1, OVERS * 6 - inn.balls)) * 6; return rrr > 10 ? 'tight' : rrr < 7 ? 'hunt' : 'balanced'; }
  return inn.over < 6 ? 'hunt' : inn.over >= 16 ? 'tight' : 'balanced';
}
function aiShot(S, inn, r) {
  const sk = batSkill(S, inn.bat, inn.striker), left = OVERS * 6 - inn.balls, wl = 10 - inn.wkts;
  let w = { 0: 0.04, 1: 0.46, 2: 0.2, 4: 0.2, 6: 0.1 };
  if (sk < 45) w = { 0: 0.12, 1: 0.62, 2: 0.2, 4: 0.05, 6: 0.01 };
  if (S.inn === 2) {
    const need = S.target - inn.runs, rrr = (need / Math.max(1, left)) * 6;
    if (rrr > 11) { w[4] *= 2; w[6] *= 3; w[1] *= 0.5; w[0] = 0.01; } else if (rrr > 8.5) { w[4] *= 1.4; w[6] *= 1.6; } else if (rrr < 6) { w[4] *= 0.6; w[6] *= 0.4; w[1] *= 1.2; }
    if (need <= 6 && left > 12) w = { 0: 0.02, 1: 0.6, 2: 0.28, 4: 0.1, 6: 0 };
  } else {
    if (inn.over >= 16) { w[6] *= 2; w[4] *= 1.4; w[1] *= 0.7; }
    if (inn.over < 2) { w[0] *= 1.5; w[6] *= 0.5; }
    if (wl <= 3 && inn.over < 15) { w[0] *= 1.5; w[4] *= 0.6; w[6] *= 0.3; w[1] *= 1.2; }
  }
  return +draw(r, w);
}
export function aiChoice(S, side) {
  if (S.status === 'toss') return { elect: 'bowl' };
  const inn = S.innings[S.inn - 1], r = makeRng(`${S.seed}-ai-${S.key}-${side}`);
  const c = S.cur ? { shot: aiShot(S, inn, r) } : { bowler: aiBowler(S, inn, r), plan: aiPlan(S, inn) };
  const sd = S.sides[side];
  if (!sd.impactUsed && S.inn === 1 && inn.over === 0 && (!S.cur || S.cur.att === 0) && sd.bench.length) {      // bots use the impact player early if it is a clear upgrade
    const slots = sd.xi.map((p, i) => ({ p, i })).filter(({ i }) => i !== sd.captain).sort((a, b) => a.p.rt - b.p.rt);
    const best = sd.bench.map((p, i) => ({ p, i })).sort((a, b) => b.p.rt - a.p.rt)[0];
    if (slots[0] && best && best.p.rt > slots[0].p.rt + 6) c.impact = { out: slots[0].i, in: best.i };
  }
  return c;
}

// ---------- state transitions ----------
const mkBat = (S, side, i) => ({ n: S.sides[side].xi[i].name, r: 0, b: 0, f: 0, s: 0, out: null });
function startInnings(S, n, bat) {
  S.inn = n; S.cur = null;
  S.innings.push({ bat, bowl: other(bat), runs: 0, wkts: 0, balls: 0, extras: 0, striker: 0, non: 1, next: 2, batters: { 0: mkBat(S, bat, 0), 1: mkBat(S, bat, 1) }, bowlers: {}, last: null, fow: [], overs: [], over: 0, done: false });
  S.key = n * 10000;
}
// Impact player: ANY XI player can be swapped with ANY bench player, once per match (even mid-over / at the crease)
function applyImpact(S, side, imp) {
  const sd = S.sides[side];
  if (!imp || sd.impactUsed || !Number.isInteger(imp.out) || !Number.isInteger(imp.in)) return;
  if (imp.out < 0 || imp.out > 10 || imp.in < 0 || imp.in >= sd.bench.length) return;
  const old = sd.xi[imp.out], nw = sd.bench[imp.in];
  sd.xi[imp.out] = nw; sd.bench.splice(imp.in, 1); sd.impactUsed = true;
  if (sd.captain === imp.out) sd.captain = null; if (sd.vice === imp.out) sd.vice = null;
  const inn = S.innings[S.inn - 1];
  if (inn) {
    if (inn.bat === side) {
      const b = inn.batters[imp.out];
      if (b && b.out == null && (inn.striker === imp.out || inn.non === imp.out)) { inn.batters[imp.out + 'x'] = { ...b, out: 'retired (impact player)' }; inn.batters[imp.out] = mkBat(S, side, imp.out); }
    } else {
      const bw = inn.bowlers[imp.out]; if (bw) { inn.bowlers[imp.out + 'x'] = bw; delete inn.bowlers[imp.out]; }
      if (inn.last === imp.out) inn.last = null;
    }
  }
  S.log.push(`⚡ ${sd.team}: impact player ${nw.name} replaces ${old.name}`);
}

function beginOver(S, ch) {                       // bowling side's decision for the over
  const inn = S.innings[S.inn - 1], bowlS = S.sides[inn.bowl];
  let bi = ch.bowler;
  const ok = Number.isInteger(bi) && bi >= 0 && bi <= 10 && (inn.bowlers[bi]?.b || 0) < MAX_BOWL_BALLS && bi !== inn.last;
  if (!ok) bi = aiBowler(S, inn, makeRng(`${S.seed}-fb-${S.key}`));
  const plan = ['hunt', 'balanced', 'tight'].includes(ch.plan) ? ch.plan : 'balanced';
  if (!inn.bowlers[bi]) inn.bowlers[bi] = { n: bowlS.xi[bi].name, b: 0, r: 0, w: 0 };
  S.cur = { bowler: bi, plan, att: 0, legal: 0, runs: 0, w: 0, tok: [] };
}

const COMM = {
  W: (b, bw, how) => `OUT! ${b} ${how}`, 6: (b) => `SIX! ${b} sends it over the rope`, 4: (b) => `FOUR! ${b} finds the gap`,
  3: (b) => `${b} runs three`, 2: (b) => `${b} scampers back for two`, 1: (b) => `${b} takes a single`, 0: (b) => `Dot ball — ${b} can't get it away`,
};
function playBall(S, shot) {
  const inn = S.innings[S.inn - 1], cur = S.cur, bowlS = S.sides[inn.bowl];
  const r = makeRng(`${S.seed}-${S.inn}-${inn.over}-${cur.att}`); cur.att++;
  const bw = inn.bowlers[cur.bowler] || (inn.bowlers[cur.bowler] = { n: bowlS.xi[cur.bowler].name, b: 0, r: 0, w: 0 });
  if (r() < WIDE) { inn.runs++; inn.extras++; bw.r++; cur.runs++; cur.tok.push('Wd'); S.lastBall = { tok: 'Wd', txt: `Wide! ${bw.n} strays down the leg side` }; return; }
  const bat = inn.batters[inn.striker], sh = SHOTS.includes(shot) ? shot : 1;
  const o = draw(r, shotProbs(batSkill(S, inn.bat, inn.striker), bowlSkill(S, inn.bowl, cur.bowler), sh, cur.plan, inn.over));
  inn.balls++; bw.b++; bat.b++; cur.legal++;
  if (o === 'W') {
    inn.wkts++; bw.w++; cur.w++; cur.tok.push('W');
    const kind = r(), fielder = bowlS.xi[Math.floor(r() * 11)].name;
    const how = kind < 0.25 ? `b ${bw.n}` : kind < 0.4 ? `lbw b ${bw.n}` : `c ${fielder === bw.n ? '&' : fielder} b ${bw.n}`;
    bat.out = how; inn.fow.push(`${inn.runs}-${inn.wkts} (${bat.n}, ${inn.over}.${cur.legal})`);
    S.lastBall = { tok: 'W', txt: COMM.W(bat.n, bw.n, how) };
    if (inn.wkts >= 10) inn.done = true;
    else { inn.striker = inn.next++; inn.batters[inn.striker] = mkBat(S, inn.bat, inn.striker); }
  } else {
    const runs = o === 'dot' ? 0 : +o.slice(1);
    inn.runs += runs; bat.r += runs; bw.r += runs; cur.runs += runs; cur.tok.push(runs === 0 ? '•' : String(runs));
    if (runs === 4) bat.f++; if (runs === 6) bat.s++;
    S.lastBall = { tok: runs === 0 ? '•' : String(runs), txt: COMM[runs](bat.n) + (sh > runs && runs > 0 && sh >= 4 ? ' (mistimed it)' : '') };
    if (runs % 2 === 1) [inn.striker, inn.non] = [inn.non, inn.striker];
    if (S.inn === 2 && inn.runs >= S.target) inn.done = true;
  }
  if (cur.legal === 6 || inn.done) endOver(S);
}
function endOver(S) {
  const inn = S.innings[S.inn - 1], cur = S.cur;
  if (!inn.done || cur.legal === 6) [inn.striker, inn.non] = [inn.non, inn.striker];     // strike changes at the end of an over
  inn.overs.push({ n: inn.over + 1, bowler: inn.bowlers[cur.bowler]?.n || '', plan: cur.plan, runs: cur.runs, w: cur.w, tok: cur.tok });
  inn.last = cur.bowler; inn.over++; S.cur = null;
  if (inn.over >= OVERS) inn.done = true;
}

function finish(S) {
  const [i1, i2] = S.innings, bat1 = S.sides[i1.bat], bat2 = S.sides[i2.bat];
  let side, text, tie = false;
  if (i2.runs >= S.target) { side = i2.bat; const left = OVERS * 6 - i2.balls; text = `${bat2.team} won by ${10 - i2.wkts} wicket${10 - i2.wkts === 1 ? '' : 's'} (${left} balls left)`; }
  else if (i2.runs < i1.runs) { side = i1.bat; text = `${bat1.team} won by ${i1.runs - i2.runs} run${i1.runs - i2.runs === 1 ? '' : 's'}`; }
  else { tie = true; side = makeRng(S.seed + '-coin')() < 0.5 ? 'A' : 'B'; text = `Scores level — ${S.sides[side].team} won the coin toss decider`; }
  const pts = {};
  [i1, i2].forEach((inn) => {
    Object.values(inn.batters).forEach((b) => { if (side === inn.bat) { const q = pts[b.n] || (pts[b.n] = { n: b.n, r: 0, b: 0, w: 0 }); q.r += b.r; q.b += b.b; } });
    Object.values(inn.bowlers).forEach((b) => { if (side === inn.bowl) { const q = pts[b.n] || (pts[b.n] = { n: b.n, r: 0, b: 0, w: 0 }); q.w += b.w; } });
  });
  const potm = Object.values(pts).sort((a, b) => (b.r + 24 * b.w) - (a.r + 24 * a.w))[0];
  const line = potm ? [potm.r > 0 ? `${potm.r} (${potm.b})` : '', potm.w > 0 ? `${potm.w} wkt${potm.w > 1 ? 's' : ''}` : ''].filter(Boolean).join(' & ') : '';
  S.status = 'finished'; S.deadline = null; S.choices = {}; S.cur = null;
  S.result = { side, fid: S.sides[side].fid, text, tie, potm: potm ? { name: potm.n, line, team: S.sides[side].team } : null };
}

// which side must decide right now
export function stepInfo(S) {
  if (S.status === 'toss') return { step: 'toss', need: S.toss.winner };
  const inn = S.innings[S.inn - 1];
  return S.cur ? { step: 'ball', need: inn.bat } : { step: 'bowler', need: inn.bowl };
}
const decided = (step, c) => !!c && (step === 'toss' ? c.elect === 'bat' || c.elect === 'bowl' : step === 'ball' ? c.shot !== undefined : Number.isInteger(c.bowler));

// Returns the next state if something should happen now (arm the clock, toss decided, a bowler picked, a ball played), otherwise null.
export function advance(st, now) {
  if (!st || st.status === 'finished') return null;
  const S = clone(st);
  if (S.deadline == null) { S.deadline = now + DECIDE_MS; return S; }
  const { step, need } = stepInfo(S);
  if (!(S.sides[need].bot || decided(step, S.choices[need]) || now >= S.deadline)) return null;
  if (step === 'toss') {
    const c = S.choices[need], elect = S.sides[need].bot ? 'bowl' : c?.elect === 'bowl' ? 'bowl' : 'bat';
    S.toss.elected = elect; S.log.push(`🪙 ${S.sides[need].team} won the toss and chose to ${elect}`);
    S.status = 'playing'; S.choices = {}; startInnings(S, 1, elect === 'bat' ? need : other(need)); S.deadline = now + DECIDE_MS; return S;
  }
  const inn = S.innings[S.inn - 1];
  applyImpact(S, inn.bat, S.choices[inn.bat]?.impact); applyImpact(S, inn.bowl, S.choices[inn.bowl]?.impact);
  const mine = S.choices[need], c = decided(step, mine) ? mine : aiChoice(S, need);
  if (step === 'bowler') beginOver(S, c); else playBall(S, c.shot);
  S.choices = {};
  if (inn.done) {
    if (S.inn === 1) { S.target = inn.runs + 1; S.log.push(`⏸ Innings break: ${S.sides[inn.bat].team} ${inn.runs}/${inn.wkts}. Target ${S.target}`); startInnings(S, 2, inn.bowl); }
    else finish(S);
  } else S.key = S.inn * 10000 + inn.over * 100 + (S.cur ? 1 + S.cur.att : 0);
  S.deadline = S.status === 'finished' ? null : now + (S.cur ? BALL_MS : DECIDE_MS);
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
