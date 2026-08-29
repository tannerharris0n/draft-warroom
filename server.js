import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const MODEL = process.env.MODEL || "claude-sonnet-5";
const SEASON = process.env.SEASON || "2026";
const LAST_SEASON = String(Number(SEASON) - 1);

// ------------------------------------------------------------
// tiny cache
// ------------------------------------------------------------
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  return v;
}

const norm = (s) =>
  (s || "")
    .toLowerCase()
    .replace(/[.'’\-]/g, "")
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

// ------------------------------------------------------------
// /api/board — live merged rankings
//   FantasyCalc  -> current redraft rank/value + sleeperId + team/pos
//   FFCalculator -> current PPR ADP (attribution required — see README)
//   Sleeper      -> last season total PPR points (by sleeperId)
// ------------------------------------------------------------
app.get("/api/board", async (req, res) => {
  const teams = ["8", "10", "12", "14"].includes(req.query.teams) ? req.query.teams : "12";
  try {
    const board = await cached(`board:${teams}`, 30 * 60 * 1000, async () => {
      const [fcRes, adpRes, statsRes] = await Promise.allSettled([
        fetch(
          `https://api.fantasycalc.com/values/current?isDynasty=false&numQbs=1&numTeams=${teams}&ppr=1&includeAdp=true`
        ).then((r) => r.json()),
        fetch(
          `https://fantasyfootballcalculator.com/api/v1/adp/ppr?teams=${teams}&year=${SEASON}`
        ).then((r) => r.json()),
        fetch(`https://api.sleeper.app/v1/stats/nfl/regular/${LAST_SEASON}`).then((r) => r.json()),
      ]);

      if (fcRes.status !== "fulfilled" || !Array.isArray(fcRes.value)) {
        throw new Error("FantasyCalc unavailable");
      }
      const fc = fcRes.value;
      const adpByName = new Map();
      if (adpRes.status === "fulfilled" && adpRes.value?.players) {
        for (const p of adpRes.value.players) adpByName.set(norm(p.name), p);
      }
      const stats = statsRes.status === "fulfilled" ? statsRes.value : {};

      // last-season positional ranks from sleeper stats
      const lastPts = {};
      for (const [sid, st] of Object.entries(stats)) {
        if (st && typeof st.pts_ppr === "number") lastPts[sid] = st.pts_ppr;
      }

      const players = fc.slice(0, 300).map((row, i) => {
        const name = row.player?.name || "";
        const pos = (row.player?.position || "").toUpperCase();
        const sid = row.player?.sleeperId ? String(row.player.sleeperId) : null;
        const adpRow = adpByName.get(norm(name));
        return {
          id: i + 1,
          name,
          pos: pos === "DEF" ? "DST" : pos,
          team: row.player?.maybeTeam || adpRow?.team || "FA",
          rank: row.overallRank || i + 1,
          posRank: row.positionRank || null,
          adp: adpRow ? Number(adpRow.adp) : null,
          value: row.value || null,
          trend30: row.trend30Day || 0,
          lastPts: sid && lastPts[sid] != null ? Math.round(lastPts[sid] * 10) / 10 : null,
        };
      });

      // last-season positional finish (WR4, RB12 …) computed across returned pool
      const byPos = {};
      for (const p of players.filter((p) => p.lastPts != null)) {
        (byPos[p.pos] = byPos[p.pos] || []).push(p);
      }
      for (const pos of Object.keys(byPos)) {
        byPos[pos]
          .sort((a, b) => b.lastPts - a.lastPts)
          .forEach((p, idx) => (p.lastFinish = `${pos}${idx + 1}`));
      }

      return { season: SEASON, lastSeason: LAST_SEASON, updated: new Date().toISOString(), players };
    });
    res.json(board);
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

// ------------------------------------------------------------
// /api/espn/draft — poll live draft picks from an ESPN league
// Requires env: ESPN_S2, ESPN_SWID (private leagues), ESPN_LEAGUE_ID optional default
// ------------------------------------------------------------
async function espnPlayerMap() {
  return cached("espn:players", 24 * 60 * 60 * 1000, async () => {
    const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${SEASON}/players?view=players_wl`;
    const r = await fetch(url, {
      headers: {
        "X-Fantasy-Filter": JSON.stringify({ filterActive: { value: true } }),
        ...espnCookieHeader(),
      },
    });
    if (!r.ok) throw new Error(`ESPN players ${r.status}`);
    const arr = await r.json();
    const map = {};
    for (const p of arr) map[p.id] = { name: p.fullName };
    return map;
  });
}

function espnCookieHeader() {
  const { ESPN_S2, ESPN_SWID } = process.env;
  if (!ESPN_S2 || !ESPN_SWID) return {};
  return { Cookie: `espn_s2=${ESPN_S2}; SWID=${ESPN_SWID}` };
}

app.get("/api/espn/draft", async (req, res) => {
  const leagueId = req.query.leagueId || process.env.ESPN_LEAGUE_ID;
  if (!leagueId) return res.status(400).json({ error: "leagueId required" });
  try {
    const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${SEASON}/segments/0/leagues/${leagueId}?view=mDraftDetail`;
    const r = await fetch(url, { headers: espnCookieHeader() });
    if (!r.ok) throw new Error(`ESPN ${r.status} — check league id + cookies`);
    const data = await r.json();
    const picks = data?.draftDetail?.picks || [];
    let names = {};
    try {
      names = await espnPlayerMap();
    } catch (_) {}
    res.json({
      inProgress: data?.draftDetail?.inProgress ?? null,
      drafted: data?.draftDetail?.drafted ?? null,
      picks: picks.map((p) => ({
        overall: p.overallPickNumber,
        round: p.roundId,
        roundPick: p.roundPickNumber,
        teamId: p.teamId,
        keeper: !!p.keeper,
        playerId: p.playerId,
        playerName: names[p.playerId]?.name || null,
      })),
    });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

// ------------------------------------------------------------
// /api/analyze — Anthropic proxy (key stays server-side)
// ------------------------------------------------------------
app.post("/api/analyze", async (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });
  const { prompt } = req.body || {};
  if (!prompt) return res.status(400).json({ error: "prompt required" });
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1200,
        messages: [{ role: "user", content: prompt }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    res.json({ text });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

// ------------------------------------------------------------
app.use(express.static(path.join(__dirname, "dist")));
app.get("*", (_, res) => res.sendFile(path.join(__dirname, "dist", "index.html")));

app.listen(PORT, () => console.log(`war room on :${PORT}`));
