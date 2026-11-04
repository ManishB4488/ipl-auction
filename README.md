# IPL 2026 Friends Auction (Next.js + Supabase)

Real-time multiplayer auction for 3–10 people. All rules (bid validation, purse, squad limits, sales, undo) run
**inside Postgres functions**; browsers only have read access, so purses and ownership can't be tampered with.

## 1. Supabase setup (free tier is fine)
1. Create a project at https://supabase.com.
2. **Authentication → Providers → enable "Anonymous Sign-Ins"** (this is the guest session system).
3. **SQL Editor** → paste and run `supabase/schema.sql`.
4. Generate the player data (needs Node 18+ and internet):
   ```bash
   npm install
   npm run import-players      # downloads the official IPL PDF, writes supabase/seed_players.sql
   ```
   It prints `Parsed N players` (the official list has 359 rows) and lists any row it could not parse.
   Paste `supabase/seed_players.sql` into the SQL Editor and run it. **Check the count: `select count(*) from players;`**
5. **Project Settings → API**: copy the Project URL and the `anon` public key.
6. Realtime is enabled by the last line of schema.sql. (If that line errors, enable Realtime for
   tables rooms, franchises, room_players, bids under Database → Replication. The app also polls every 5 s as a fallback.)

## 2. Run locally
```bash
cp .env.example .env.local   # fill in the two values
npm run dev                  # http://localhost:3000
```
Open it in several browser windows/profiles (each one is a separate guest) to test.

## 3. Deploy on Vercel
1. Push this folder to a GitHub repo.
2. vercel.com → New Project → import it.
3. Add env vars `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
4. Deploy. Your public URL is what you share. Optionally add a custom domain in Vercel.

## How to play
Home → host creates room → shares link/code → friends join (name, franchise, colour) → host sets rules and starts
(min 3 franchises) → bid with the BID button / PASS → results are saved in the DB and shown in "Results Table".
Spectators open the room link without joining (host can disable this in the lobby).

## Rules implemented
- Purse ₹120 Cr, squad 18–25, overseas max 8 (editable by host in lobby). Money stored in lakh.
- Increments: 5 L below ₹1 Cr, 10 L to ₹2 Cr, 20 L to ₹5 Cr, 25 L above. Edit `inc_for()` in the SQL and `inc()` in `page.js`
  if you want different values. **Verify against the official IPL increment rules; I did not confirm them.**
- A bid must exactly equal the server-computed next bid (stale/duplicate clicks are rejected); concurrent bids are serialised by a row lock.
- A team must keep 30 L per remaining slot to reach the minimum squad.
- Timer resets on every bid; clients call `tick()` when it hits zero and the server decides.
- Guest identity lives in the browser's Supabase session. Clearing site data = losing that identity (the franchise stays in the DB but can't be reclaimed).

## Data notes
- Players, countries, roles, batting/bowling styles, capped/uncapped, base prices and IPL-2025 team come from the official PDF.
  The "Wicketkeeper" role covers keepers (the PDF does not separate keeper-batters). `caps_raw` holds the raw caps numbers
  from the PDF unparsed because the PDF leaves empty columns blank, so test/ODI/T20 split is not reliable.
- Players are not pre-assigned to real franchises. No official photos are bundled (licensing).
