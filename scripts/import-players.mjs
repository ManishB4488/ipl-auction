// Downloads the OFFICIAL IPL 2026 auction list PDF, parses every row and writes supabase/seed_players.sql
// Usage: node scripts/import-players.mjs [path-or-url-to-pdf]
import fs from 'fs';
import { createRequire } from 'module';
const URL_DEFAULT = 'https://documents.iplt20.com/bcci/documents/1765197869375_TATA-IPL-2026-Auction-List-8.12.25.pdf';
const COUNTRIES = ['South Africa', 'New Zealand', 'Sri Lanka', 'West Indies', 'Afghanistan', 'Bangladesh', 'Australia', 'England', 'Ireland', 'Malaysia', 'India'];
const ROLE = { BATTER: 'Batter', BOWLER: 'Bowler', 'ALL-ROUNDER': 'All-rounder', WICKETKEEPER: 'Wicketkeeper' };
const ROW = /^(\d+)\s+(\d+)\s+([A-Z]+\d+)\s+(.+?)\s+(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d+)\s+(BATTER|BOWLER|ALL-ROUNDER|WICKETKEEPER)\s+(RHB|LHB)\s*(.*?)\s*\b(Capped|Uncapped|Associate)\s+(\d+)\s+\S.*$/;
const CTRY = new RegExp(`^(.+?)\\s+(${COUNTRIES.join('|')})(?:\\s+.*)?$`);
const BOWL = /(RIGHT ARM|LEFT ARM)\s+(Fast Medium|Fast|Medium|Leg Spin|Off Spin|Slow Orthodox|Slow Unorthodox|Slow)/;
const TEAM = /\b(CSK|MI|RCB|KKR|DC|SRH|RR|PBKS|LSG|GT)\b(?:\s+(\d+))?/;

export function parseLine(raw) {
  const line = raw.replace(/\s+/g, ' ').trim();
  const m = line.match(ROW);
  if (!m) return null;
  const c = m[4].match(CTRY);
  if (!c) return null;
  let mid = m[9], bowl = null;
  const b = mid.match(BOWL);
  if (b) { bowl = `${b[1][0] + b[1].slice(1).toLowerCase()} ${b[2]}`; mid = mid.replace(b[0], ''); }
  const t = mid.match(TEAM);
  return { list_no: +m[1], set_no: +m[2], set_code: m[3], name: c[1], country: c[2], overseas: c[2] !== 'India',
    dob: m[5], role: ROLE[m[7]], bat: m[8], bowl, capped: m[10], base_lakh: +m[11],
    ipl_team_2025: t ? t[1] : null, ipl_matches: t && t[2] ? +t[2] : null, caps_raw: mid.replace(TEAM, '').trim() || null };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) {
  const src = process.argv[2] || URL_DEFAULT;
  const buf = /^https?:/.test(src) ? Buffer.from(await (await fetch(src)).arrayBuffer()) : fs.readFileSync(src);
  const pdf = createRequire(import.meta.url)('pdf-parse');
  const { text } = await pdf(buf);
  fs.writeFileSync('pdf_text_debug.txt', text);
  const rows = [], bad = [];
  const flat = text.replace(/\s+/g, ' ');
  for (const l of flat.split(/\s(?=\d{1,3} \d{1,2} [A-Z]{2,4}\d{1,2} [A-Z])/)) {
    if (!/^\d{1,3} \d{1,2} [A-Z]{2,4}\d{1,2} /.test(l)) continue;
    const r = parseLine(l); r ? rows.push(r) : bad.push(l);
  }
  const q = (v) => (v == null ? 'null' : typeof v === 'number' ? v : typeof v === 'boolean' ? v : `'${String(v).replace(/'/g, "''")}'`);
  const cols = ['list_no', 'set_no', 'set_code', 'name', 'country', 'overseas', 'capped', 'role', 'bat', 'bowl', 'base_lakh', 'ipl_team_2025', 'ipl_matches', 'dob', 'caps_raw'];
  const sql = `-- Generated from the official IPL 2026 auction list PDF\ntruncate players restart identity cascade;\ninsert into players(${cols.join(',')}) values\n` +
    rows.map((r) => `(${cols.map((k) => q(r[k])).join(',')})`).join(',\n') + ';\n';
  fs.writeFileSync('supabase/seed_players.sql', sql);
  console.log(`Parsed ${rows.length} players -> supabase/seed_players.sql`);
  if (bad.length) console.log(`WARNING: ${bad.length} rows not parsed:\n` + bad.join('\n'));
}
