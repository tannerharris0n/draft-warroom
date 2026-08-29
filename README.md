# Draft War Room

Live snake-draft assistant: real-time rankings, ESPN draft sync, screen-capture OCR pick detection, and an AI analyst that reads your live draft state.

## Data sources (live, no baked rankings)

Merged server-side at `/api/board`, cached 30 minutes:

- **FantasyCalc** — current redraft consensus rank, value, 30-day trend, Sleeper IDs
- **Fantasy Football Calculator** — current PPR ADP for your league size (free API; attribution required, which the app displays in the board footer)
- **Sleeper** — last season's total PPR points per player, converted into positional finishes (e.g. '25 WR4)

## Deploy on Railway

1. Push this folder to a GitHub repo.
2. Railway → New Project → Deploy from GitHub repo. Nixpacks detects Node, runs `npm install`, `npm run build`, `npm start` automatically.
3. Set environment variables (Variables tab):
   - `ANTHROPIC_API_KEY` — required for the analyst
   - `MODEL` — defaults to `claude-sonnet-5`; verify current model strings at docs.claude.com
   - `ESPN_LEAGUE_ID`, `ESPN_S2`, `ESPN_SWID` — for ESPN sync (below)
4. Generate a domain under Settings → Networking. Done.

Local dev: `npm install`, then `npm run dev` (Vite on 5173) and `node server.js` in another terminal. Copy `.env.example` to `.env` and export the vars, or use `node --env-file=.env server.js` (Node 20+).

## ESPN live sync (recommended over OCR)

Polls your league's draft endpoint every 6 seconds and auto-logs picks in order. This is the reliable path: no OCR ambiguity, works even if your laptop lid is closed.

Getting the cookies (private leagues):
1. Log into fantasy.espn.com in Chrome.
2. DevTools → Application → Cookies → fantasy.espn.com.
3. Copy `espn_s2` (long string) and `SWID` (including the curly braces) into Railway variables.
4. League ID is in your league URL: `leagueId=XXXXXX`.

In the app: SYNC tab → enter league ID → SYNC. Picks appear in the log tagged ⇄.

Note: this uses ESPN's unofficial fantasy API — the same one their own apps use, but it can change without notice. If sync breaks mid-draft, fall back to OCR or manual logging; nothing else in the app depends on it.

## Screen OCR watcher

For when API sync isn't an option:

1. SYNC tab → START SCREEN CAPTURE → share the browser tab or window showing your ESPN draft room.
2. Drag a rectangle over the **Pick History** panel (not the full screen — a tight crop on the region where completed picks appear is what makes OCR accurate).
3. New player names appearing in that region are flagged as picks. Confirm each from the toast, or enable **auto-log** once you trust it.

Tips: keep the draft room at 100% zoom, light-on-dark regions OCR fine, and the watcher only matches against undrafted players so false positives are rare. OCR runs entirely in your browser (Tesseract.js) — no frames leave your machine.

## AI analyst

The ⚡ AI tab sends your live state (roster construction, picks until your turn, top available with ADP and last-year finishes, recent draft runs) to Claude via your server-side API key, with web search enabled for injury/news verification. Returns a recommendation, confidence, alternatives, and a next-pick plan. One-tap draft button when you're on the clock.

## Notes

- Draft state persists in localStorage; refresh mid-draft and hit RESUME.
- Keeper leagues: set keepers via the KEEPERS menu; they auto-fill when their round arrives.
- The board API returns the top 300; add deeper players via + PLAYER.
