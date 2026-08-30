import express from "express";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set("trust proxy", 1); // Railway sits behind a proxy — needed for real client IPs
app.use(express.json({ limit: "256kb" }));

const PORT = process.env.PORT || 3000;
const MODEL = process.env.MODEL || "claude-sonnet-5";
const SEASON = process.env.SEASON || "2026";
const LAST_SEASON = String(Number(SEASON) - 1);
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  crypto.createHash("sha256").update("warroom::" + APP_PASSWORD).digest("hex");
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ------------------------------------------------------------
// security headers
// ------------------------------------------------------------
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});

// ------------------------------------------------------------
// sessions: HMAC-signed expiry token in an httpOnly cookie
// ------------------------------------------------------------
const b64u = (s) => Buffer.from(s).toString("base64url");
const sign = (payload) =>
  crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
function issueToken() {
  const payload = String(Date.now() + SESSION_TTL_MS);
  return b64u(payload) + "." + sign(payload);
}
function verifyToken(token) {
  if (!token || !token.includes(".")) return false;
  const [p, sig] = token.split(".");
  let payload;
  try { payload = Buffer.from(p, "base64url").toString(); } catch { return false; }
  const expect = sign(payload);
  const a = Buffer.from(sig || "");
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return Number(payload) > Date.now();
}
function getCookie(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

// ------------------------------------------------------------
// rate limiting (in-memory; single-instance Railway is fine)
// ------------------------------------------------------------
function makeLimiter({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (now - v.t > windowMs) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const key = req.ip;
    const now = Date.now();
    const rec = hits.get(key);
    if (!rec || now - rec.t > windowMs) { hits.set(key, { t: now, n: 1 }); return next(); }
    if (++rec.n > max) {
      res.setHeader("Retry-After", Math.ceil((rec.t + windowMs - now) / 1000));
      return res.status(429).json({ error: "rate limited" });
    }
    next();
  };
}
const apiLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, max: 600 });
const loginLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, max: 5 });
const analyzeLimiter = makeLimiter({ windowMs: 5 * 60 * 1000, max: 12 });

app.use("/api", apiLimiter);

// ------------------------------------------------------------
// auth endpoints + gate
// ------------------------------------------------------------
function passwordMatches(supplied) {
  const a = crypto.createHash("sha256").update(String(supplied || "")).digest();
  const b = crypto.createHash("sha256").update(APP_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b); // constant time, length-independent via hashing
}

app.post("/api/login", loginLimiter, (req, res) => {
  if (!APP_PASSWORD) return res.status(500).json({ error: "APP_PASSWORD not configured" });
  if (!passwordMatches(req.body?.password)) {
    return res.status(401).json({ error: "invalid credentials" });
  }
  res.setHeader(
    "Set-Cookie",
    `wr_session=${issueToken()}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`
  );
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  res.setHeader("Set-Cookie", "wr_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
  res.json({ ok: true });
});

app.get("/api/session", (req, res) => {
  res.json({ authed: verifyToken(getCookie(req, "wr_session")) });
});

// everything below requires a valid session
app.use("/api", (req, res, next) => {
  if (verifyToken(getCookie(req, "wr_session"))) return next();
  res.status(401).json({ error: "auth required" });
});

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
// ------------------------------------------------------------
app.get("/api/board", async (req, res) => {
  const teams = ["8", "10", "12", "14"].includes(req.query.teams) ? req.query.teams : "12";
  try {
    const board = await cached(`board:${teams}`, 30 * 60 * 1000, async () => {
      const [fcRes, adpRes, statsRes] = await Promise.allSettled([
        fetch(`https://api.fantasycalc.com/values/current?isDynasty=false&numQbs=1&numTeams=${teams}&ppr=1&includeAdp=true`).then((r) => r.json()),
        fetch(`https://fantasyfootballcalculator.com/api/v1/adp/ppr?teams=${teams}&year=${SEASON}`).then((r) => r.json()),
        fetch(`https://api.sleeper.app/v1/stats/nfl/regular/${LAST_SEASON}`).then((r) => r.json()),
      ]);
      if (fcRes.status !== "fulfilled" || !Array.isArray(fcRes.value)) throw new Error("rankings source unavailable");
      const fc = fcRes.value;
      const adpByName = new Map();
      if (adpRes.status === "fulfilled" && adpRes.value?.players) {
        for (const p of adpRes.value.players) adpByName.set(norm(p.name), p);
      }
      const stats = statsRes.status === "fulfilled" ? statsRes.value : {};
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
          id: i + 1, name,
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
      const byPos = {};
      for (const p of players.filter((p) => p.lastPts != null)) (byPos[p.pos] = byPos[p.pos] || []).push(p);
      for (const pos of Object.keys(byPos)) {
        byPos[pos].sort((a, b) => b.lastPts - a.lastPts).forEach((p, idx) => (p.lastFinish = `${pos}${idx + 1}`));
      }
      return { season: SEASON, lastSeason: LAST_SEASON, updated: new Date().toISOString(), players };
    });
    res.json(board);
  } catch (e) {
    res.status(502).json({ error: "board unavailable" });
  }
});

// ------------------------------------------------------------
// /api/espn/draft — validated league id, cookies stay server-side
// ------------------------------------------------------------
function espnCookieHeader() {
  const { ESPN_S2, ESPN_SWID } = process.env;
  if (!ESPN_S2 || !ESPN_SWID) return {};
  return { Cookie: `espn_s2=${ESPN_S2}; SWID=${ESPN_SWID}` };
}

async function espnPlayerMap() {
  return cached("espn:players", 24 * 60 * 60 * 1000, async () => {
    const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${SEASON}/players?view=players_wl`;
    const r = await fetch(url, {
      headers: { "X-Fantasy-Filter": JSON.stringify({ filterActive: { value: true } }), ...espnCookieHeader() },
    });
    if (!r.ok) throw new Error("espn players");
    const arr = await r.json();
    const map = {};
    for (const p of arr) map[p.id] = { name: p.fullName };
    return map;
  });
}

app.get("/api/espn/draft", async (req, res) => {
  const leagueId = String(req.query.leagueId || process.env.ESPN_LEAGUE_ID || "");
  if (!/^\d{1,12}$/.test(leagueId)) return res.status(400).json({ error: "invalid league id" });
  try {
    const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${SEASON}/segments/0/leagues/${leagueId}?view=mDraftDetail`;
    const r = await fetch(url, { headers: espnCookieHeader() });
    if (!r.ok) throw new Error("espn " + r.status);
    const data = await r.json();
    const picks = data?.draftDetail?.picks || [];
    let names = {};
    try { names = await espnPlayerMap(); } catch (_) {}
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
    res.status(502).json({ error: "espn sync failed — check league id and cookies" });
  }
});

// ------------------------------------------------------------
// /api/analyze — authenticated + tightly rate limited + capped
// ------------------------------------------------------------
app.post("/api/analyze", analyzeLimiter, async (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });
  const { prompt } = req.body || {};
  if (typeof prompt !== "string" || !prompt.trim()) return res.status(400).json({ error: "prompt required" });
  if (prompt.length > 20000) return res.status(413).json({ error: "prompt too large" });
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1200,
        messages: [{ role: "user", content: prompt }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error: "analysis provider error" });
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    res.json({ text });
  } catch (e) {
    res.status(502).json({ error: "analysis failed" });
  }
});

// ------------------------------------------------------------
app.use(express.static(path.join(__dirname, "dist")));
app.get("*", (_, res) => res.sendFile(path.join(__dirname, "dist", "index.html")));

app.listen(PORT, () => {
  if (!APP_PASSWORD) console.warn("WARNING: APP_PASSWORD not set — all API routes will refuse login");
  console.log(`war room on :${PORT}`);
});
