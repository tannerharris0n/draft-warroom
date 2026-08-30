import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { DraftWatcher } from "./ocr.js";

/* ============================================================
   DRAFT WAR ROOM — deployed edition
   Live board (FantasyCalc + FFC ADP + Sleeper '25 PPR),
   ESPN league sync, screen-capture OCR, AI analyst.
   ============================================================ */

const POS_COLOR = {
  QB: "#ff4d5e", RB: "#2ee66b", WR: "#4da3ff",
  TE: "#ffb020", DST: "#b07cff", K: "#8d99a6", PK: "#8d99a6",
};

// minimal offline fallback if the board API is down
const FALLBACK = [
  ["Bijan Robinson","RB","ATL"],["Jahmyr Gibbs","RB","DET"],["Christian McCaffrey","RB","SF"],
  ["Ja'Marr Chase","WR","CIN"],["Puka Nacua","WR","LAR"],["Jaxon Smith-Njigba","WR","SEA"],
  ["Jonathan Taylor","RB","IND"],["De'Von Achane","RB","MIA"],["Amon-Ra St. Brown","WR","DET"],
  ["James Cook","RB","BUF"],["Derrick Henry","RB","BAL"],["Justin Jefferson","WR","MIN"],
  ["CeeDee Lamb","WR","DAL"],["Chase Brown","RB","CIN"],["Kenneth Walker III","RB","KC"],
  ["Brock Bowers","TE","LV"],["Drake London","WR","ATL"],["Trey McBride","TE","ARI"],
  ["Rashee Rice","WR","KC"],["Jeremiyah Love","RB","ARI"],["Saquon Barkley","RB","PHI"],
  ["Josh Jacobs","RB","GB"],["Omarion Hampton","RB","LAC"],["Ashton Jeanty","RB","LV"],
  ["Malik Nabers","WR","NYG"],["A.J. Brown","WR","NE"],["Chris Olave","WR","NO"],
  ["Josh Allen","QB","BUF"],["George Pickens","WR","DAL"],["Javonte Williams","RB","DAL"],
];

const LEAGUE_PRESETS = [
  { name: "Family Feud-- B Leaguers", teams: 12, keeper: false },
  { name: "Show us your TDs", teams: 10, keeper: false },
  { name: "Andy And The Boys", teams: 10, keeper: true },
];

const lsKey = (league) => "ffdraft:v2:" + league;
const LAST_LEAGUE_KEY = "ffdraft:lastLeague";
const loadLeague = (league) => { try { return JSON.parse(localStorage.getItem(lsKey(league)) || "null"); } catch (_) { return null; } };
const norm = (s) => (s || "").toLowerCase().replace(/[.'’\-]/g, "").replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "").replace(/\s+/g, " ").trim();

// snake math
const teamForPick = (overall, T) => {
  const r = Math.ceil(overall / T);
  const idx = overall - (r - 1) * T;
  return r % 2 === 1 ? idx : T - idx + 1;
};
const roundOf = (overall, T) => Math.ceil(overall / T);
const pickInRound = (overall, T) => overall - (roundOf(overall, T) - 1) * T;
const myPickNumbers = (slot, T, rounds) => {
  const out = [];
  for (let p = 1; p <= T * rounds; p++) if (teamForPick(p, T) === slot) out.push(p);
  return out;
};

const SLOTS = ["QB","RB","RB","WR","WR","TE","FLEX","D/ST","K"];
function slotRoster(players) {
  const list = players.map((p) => ({ ...p }));
  const grab = (pred) => {
    for (const p of list) if (!p._used && pred(p)) { p._used = true; return p; }
    return null;
  };
  const slots = SLOTS.map((s) => ({
    slot: s,
    player: s === "FLEX" ? grab((p) => ["RB","WR","TE"].includes(p.pos))
      : s === "D/ST" ? grab((p) => p.pos === "DST")
      : s === "K" ? grab((p) => p.pos === "K" || p.pos === "PK")
      : grab((p) => p.pos === s),
  }));
  return { slots, bench: list.filter((p) => !p._used) };
}

export default function App() {
  const [phase, setPhase] = useState("setup");
  const [authed, setAuthed] = useState(null); // null = checking, false = login, true = in
  const [cfg, setCfg] = useState({ league: "Family Feud-- B Leaguers", teams: 12, slot: 1, rounds: 16, keeper: false });
  const [players, setPlayers] = useState([]);
  const [boardMeta, setBoardMeta] = useState(null);
  const [boardErr, setBoardErr] = useState(null);
  const [picks, setPicks] = useState([]);
  const [keepers, setKeepers] = useState([]);
  const [queue, setQueue] = useState([]);

  const [tab, setTab] = useState("board");
  const [posFilter, setPosFilter] = useState("ALL");
  const [search, setSearch] = useState("");
  const [confirmPlayer, setConfirmPlayer] = useState(null);
  const [showKeeperModal, setShowKeeperModal] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);

  // AI
  const [aiBusy, setAiBusy] = useState(false);
  const [aiResult, setAiResult] = useState(null);
  const [aiError, setAiError] = useState(null);
  const [aiQuestion, setAiQuestion] = useState("");

  // ESPN sync
  const [espnLeagueId, setEspnLeagueId] = useState("");
  const [espnOn, setEspnOn] = useState(false);
  const [espnStatus, setEspnStatus] = useState("");

  // OCR
  const watcherRef = useRef(null);
  const [ocrOn, setOcrOn] = useState(false);
  const [ocrStatus, setOcrStatus] = useState("");
  const [ocrAuto, setOcrAuto] = useState(false);
  const [pending, setPending] = useState([]); // detected players awaiting confirm
  const [cropMode, setCropMode] = useState(false);
  const previewRef = useRef(null);
  const cropDrag = useRef(null);

  // ---------- board load ----------
  const loadBoard = useCallback(async (teams) => {
    try {
      const r = await fetch(`/api/board?teams=${teams}`);
      if (!r.ok) throw new Error("board api " + r.status);
      const data = await r.json();
      setPlayers(data.players.map((p) => ({ ...p, custom: false })));
      setBoardMeta(data);
      setBoardErr(null);
    } catch (e) {
      setBoardErr("Live board unavailable — using offline fallback.");
      setPlayers(FALLBACK.map((p, i) => ({ id: i + 1, name: p[0], pos: p[1], team: p[2], rank: i + 1, adp: null, lastPts: null, lastFinish: null, custom: false })));
    }
  }, []);

  const applySaved = (saved) => {
    setPicks(saved?.picks || []); setKeepers(saved?.keepers || []);
    setQueue(saved?.queue || []); setEspnLeagueId(saved?.espnLeagueId || "");
    if (saved?.cfg) setCfg((c) => ({ ...c, ...saved.cfg }));
  };

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/session");
        const s = await r.json();
        if (!s.authed) { setAuthed(false); return; }
      } catch (_) { setAuthed(false); return; }
      setAuthed(true);
      const league = localStorage.getItem(LAST_LEAGUE_KEY) || cfg.league;
      const preset = LEAGUE_PRESETS.find((x) => x.name === league);
      const saved = loadLeague(league);
      const teams = saved?.cfg?.teams || (preset ? preset.teams : cfg.teams);
      setCfg((c) => ({ ...c, league, teams, keeper: preset ? preset.keeper : c.keeper }));
      applySaved(saved);
      loadBoard(teams);
    })();
    // eslint-disable-next-line
  }, []);

  useEffect(() => {
    if (phase !== "draft") return;
    localStorage.setItem(lsKey(cfg.league), JSON.stringify({ cfg, picks, keepers, queue, espnLeagueId }));
    localStorage.setItem(LAST_LEAGUE_KEY, cfg.league);
  }, [phase, cfg, picks, keepers, queue, espnLeagueId]);

  // ---------- derived ----------
  const T = cfg.teams;
  const totalPicks = T * cfg.rounds;
  const currentOverall = picks.length + 1;
  const draftDone = picks.length >= totalPicks;
  const onClockSlot = draftDone ? null : teamForPick(currentOverall, T);
  const iAmOnClock = onClockSlot === cfg.slot;
  const myPicks = useMemo(() => myPickNumbers(cfg.slot, T, cfg.rounds), [cfg.slot, T, cfg.rounds]);
  const myNextPick = myPicks.find((p) => p >= currentOverall);
  const picksUntilMe = myNextPick ? myNextPick - currentOverall : null;
  const myPickAfter = myPicks.find((p) => p > (myNextPick || 0));

  const draftedIds = useMemo(() => new Set(picks.map((p) => p.playerId)), [picks]);
  const undrafted = useMemo(() => players.filter((p) => !draftedIds.has(p.id)), [players, draftedIds]);
  const available = useMemo(() =>
    undrafted
      .filter((p) => posFilter === "ALL" || p.pos === posFilter)
      .filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))
      .sort((a, b) => a.rank - b.rank),
    [undrafted, posFilter, search]);

  const myRosterPlayers = useMemo(() =>
    picks.filter((p) => teamForPick(p.overall, T) === cfg.slot)
      .map((p) => players.find((x) => x.id === p.playerId)).filter(Boolean),
    [picks, players, cfg.slot, T]);

  const teamName = (slot) => (slot === cfg.slot ? "YOU" : `Team ${slot}`);

  // keeper auto-fill
  useEffect(() => {
    if (phase !== "draft" || draftDone) return;
    const r = roundOf(currentOverall, T);
    const slot = teamForPick(currentOverall, T);
    const k = keepers.find((k) => k.teamSlot === slot && k.round === r && !draftedIds.has(k.playerId));
    if (k) setPicks((prev) => [...prev, { overall: prev.length + 1, playerId: k.playerId, keeper: true, src: "keeper" }]);
  }, [phase, currentOverall, keepers, T, draftDone, draftedIds]);

  const doPick = (playerId, src = "manual") => {
    setPicks((prev) => (prev.some((p) => p.playerId === playerId) ? prev : [...prev, { overall: prev.length + 1, playerId, src }]));
    setQueue((q) => q.filter((id) => id !== playerId));
    setConfirmPlayer(null);
    setPending((pd) => pd.filter((p) => p.id !== playerId));
  };
  const undo = () => setPicks((prev) => prev.slice(0, -1));
  const toggleQueue = (id) => setQueue((q) => (q.includes(id) ? q.filter((x) => x !== id) : [...q, id]));
  const matchByName = useCallback((name) => {
    const n = norm(name);
    return players.find((p) => norm(p.name) === n) || players.find((p) => n && norm(p.name).includes(n)) || players.find((p) => n.includes(norm(p.name)) && norm(p.name).length > 6);
  }, [players]);

  // ---------- ESPN sync ----------
  useEffect(() => {
    if (!espnOn || phase !== "draft") return;
    let dead = false;
    const poll = async () => {
      try {
        const r = await fetch(`/api/espn/draft?leagueId=${encodeURIComponent(espnLeagueId)}`);
        const data = await r.json();
        if (dead) return;
        if (data.error) { setEspnStatus("✕ " + data.error); return; }
        setEspnStatus(`synced ${data.picks.length} picks · ${data.inProgress ? "draft live" : "idle"}`);
        // replay any picks we don't have, in overall order
        setPicks((prev) => {
          const have = prev.length;
          const incoming = data.picks.filter((p) => p.overall > have && p.playerName).sort((a, b) => a.overall - b.overall);
          if (!incoming.length) return prev;
          const next = [...prev];
          for (const ip of incoming) {
            if (ip.overall !== next.length + 1) break; // keep strict order
            const match = matchByName(ip.playerName);
            if (!match || next.some((x) => x.playerId === match.id)) break;
            next.push({ overall: next.length + 1, playerId: match.id, keeper: ip.keeper, src: "espn" });
          }
          return next;
        });
      } catch (e) {
        if (!dead) setEspnStatus("✕ sync error");
      }
    };
    poll();
    const t = setInterval(poll, 6000);
    return () => { dead = true; clearInterval(t); };
  }, [espnOn, espnLeagueId, phase, matchByName]);

  // ---------- OCR ----------
  const startOcr = async () => {
    setOcrStatus("starting…");
    const w = new DraftWatcher({
      onStatus: setOcrStatus,
      onDetect: (found) => {
        setPending((prev) => {
          const ids = new Set(prev.map((p) => p.id));
          return [...prev, ...found.filter((p) => !ids.has(p.id))];
        });
      },
    });
    try {
      const video = await w.start();
      watcherRef.current = w;
      setOcrOn(true);
      setCropMode(true);
      // paint preview for crop selection
      const paint = () => {
        const cv = previewRef.current;
        if (!cv || !watcherRef.current) return;
        const ctx = cv.getContext("2d");
        const vw = video.videoWidth, vh = video.videoHeight;
        if (vw) {
          cv.width = 640; cv.height = Math.round((640 * vh) / vw);
          ctx.drawImage(video, 0, 0, cv.width, cv.height);
          if (cropDrag.current?.rect) {
            const r = cropDrag.current.rect;
            ctx.strokeStyle = "#2ee66b"; ctx.lineWidth = 2;
            ctx.strokeRect(r.x, r.y, r.w, r.h);
          }
        }
        if (watcherRef.current) requestAnimationFrame(paint);
      };
      requestAnimationFrame(paint);
      w.watch(() => undrafted.slice(0, 250));
    } catch (e) {
      setOcrStatus("✕ capture cancelled");
    }
  };
  const stopOcr = () => {
    watcherRef.current?.stop();
    watcherRef.current = null;
    setOcrOn(false); setCropMode(false); setPending([]);
  };
  // keep watcher's undrafted list fresh
  useEffect(() => {
    if (watcherRef.current) {
      clearInterval(watcherRef.current.timer);
      watcherRef.current.watch(() => undrafted.slice(0, 250));
    }
  }, [undrafted]);
  // auto-confirm detections
  useEffect(() => {
    if (ocrAuto && pending.length) {
      const p = pending[0];
      doPick(p.id, "ocr");
    }
    // eslint-disable-next-line
  }, [ocrAuto, pending]);

  const cropHandlers = {
    onMouseDown: (e) => {
      const rect = previewRef.current.getBoundingClientRect();
      cropDrag.current = { sx: e.clientX - rect.left, sy: e.clientY - rect.top, rect: null };
    },
    onMouseMove: (e) => {
      if (!cropDrag.current) return;
      const rect = previewRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      const { sx, sy } = cropDrag.current;
      cropDrag.current.rect = { x: Math.min(sx, x), y: Math.min(sy, y), w: Math.abs(x - sx), h: Math.abs(y - sy) };
    },
    onMouseUp: () => {
      const r = cropDrag.current?.rect;
      const w = watcherRef.current;
      if (r && w && r.w > 20 && r.h > 20) {
        const scale = w.video.videoWidth / previewRef.current.width;
        w.setCrop({ x: r.x * scale, y: r.y * scale, w: r.w * scale, h: r.h * scale });
        setOcrStatus("watching cropped region");
        setCropMode(false);
      }
      cropDrag.current = null;
    },
  };

  // ---------- AI ----------
  const runAnalysis = async (question) => {
    setAiBusy(true); setAiError(null); setAiResult(null); setTab("ai");
    const topAvail = [...undrafted].sort((a, b) => a.rank - b.rank);
    const fmt = (p) => `${p.pos} ${p.name} (${p.team}, rk ${p.rank}${p.adp ? ", adp " + p.adp : ""}${p.lastFinish ? ", '25 " + p.lastFinish + " " + p.lastPts + "pts" : ""})`;
    const byPos = {};
    ["QB","RB","WR","TE","DST","K"].forEach((pos) => {
      byPos[pos] = topAvail.filter((p) => p.pos === pos || (pos === "K" && p.pos === "PK")).slice(0, 6).map(fmt);
    });
    const roster = myRosterPlayers.map((p) => `${p.pos} ${p.name}`).join("; ") || "empty";
    const recent = picks.slice(-8).map((p) => { const pl = players.find((x) => x.id === p.playerId); return pl ? `${pl.pos} ${pl.name}` : "?"; }).join(", ");

    // computed signals: positional runs + ADP value deltas
    const last10 = picks.slice(-10).map((p) => players.find((x) => x.id === p.playerId)).filter(Boolean);
    const runCounts = {};
    last10.forEach((p) => (runCounts[p.pos] = (runCounts[p.pos] || 0) + 1));
    const runs = Object.entries(runCounts).filter(([, n]) => n >= 4).map(([pos, n]) => `${pos} run (${n} of last 10)`).join(", ") || "none";
    const values = topAvail.slice(0, 12).filter((p) => p.adp).map((p) => ({ n: p.name, d: Math.round((p.adp - currentOverall) * 10) / 10 }))
      .filter((v) => v.d < -3).map((v) => `${v.n} falling ${Math.abs(v.d)} past ADP`).join("; ") || "none notable";
    const myCounts = {};
    myRosterPlayers.forEach((p) => (myCounts[p.pos] = (myCounts[p.pos] || 0) + 1));

    const prompt = `You are an elite fantasy football draft analyst working a LIVE snake draft. Sharp, decisive, current.

STRATEGY DOCTRINE (full-PPR, ${T}-team, apply strictly):
- Tiers over rigid rank: a falling player one tier up beats a same-tier "need" pick. Value = ADP minus current pick.
- Rounds 1-3: lock elite volume. Bell-cow RBs and target-hog WRs only. No QB/TE unless a truly elite tier outlier is falling well past ADP.
- Rounds 4-7: best value vs need; secure RB2/WR3, take an elite TE or top-tier QB only at a discount. Prioritize proven target share and pass-game RB usage (PPR floor).
- Rounds 8-11: upside over floor. Ambiguous-backfield RBs with standalone pass-down roles, second-year WR breakouts, QB if still unfilled.
- Rounds 12+: high-ceiling lottery tickets, handcuff only elite backfields you roster, DST and K in the FINAL two rounds, never earlier.
- Positional runs: if a run starts 4+ picks before my turn, get ahead of the NEXT tier cliff rather than chasing the current run late.
- ${T >= 12 ? "12-team: scarcity bites harder — lean slightly earlier on RB volume and elite TE." : "10-team: waivers are rich — draft ceiling over depth, wait on QB."}
- Last-season finish is context, not gospel: weight situation changes (team, scheme, target competition) via the live data and news.

LEAGUE: ${cfg.league} — ${T} teams, full PPR, head-to-head, ESPN. Lineup QB/2RB/2WR/TE/FLEX/DST/K + bench.${cfg.keeper ? " Keeper league." : ""}
MY SLOT: ${cfg.slot}/${T}. CURRENT PICK: overall ${currentOverall} (rd ${roundOf(currentOverall, T)}.${pickInRound(currentOverall, T)}). ${iAmOnClock ? "I AM ON THE CLOCK." : `Picks until me: ${picksUntilMe}.`} My next picks: ${myNextPick || "-"}${myPickAfter ? ", " + myPickAfter : ""}.
MY ROSTER: ${roster} (counts: ${JSON.stringify(myCounts)})
LAST 8 PICKS: ${recent || "none"}
POSITIONAL RUNS: ${runs}
VALUE FALLING PAST ADP: ${values}
TOP AVAILABLE: ${topAvail.slice(0, 15).map(fmt).join("; ")}
BY POSITION: ${JSON.stringify(byPos)}
Rankings include current ADP and last season (2025) PPR finish.
${question ? "MY QUESTION: " + question : ""}

Use web search only to verify injury/news on top 2-3 candidates. Max 2 quick searches, this is live.

Respond ONLY with JSON, no fences:
{"recommendation":"Player Name","confidence":"high|medium|low","reasoning":"2-3 sharp sentences using roster construction, scarcity, ADP value","alternatives":[{"name":"Player","why":"one sentence"},{"name":"Player","why":"one sentence"}],"lookAhead":"one sentence: what to target at my NEXT pick","warning":"injury/news flag or empty string"}`;
    try {
      const r = await fetch("/api/analyze", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const data = await r.json();
      if (data.error) throw new Error(data.error?.message || JSON.stringify(data.error));
      const clean = (data.text || "").replace(/```json|```/g, "").trim();
      const a = clean.indexOf("{"), b = clean.lastIndexOf("}");
      if (a === -1) throw new Error("no json in response");
      setAiResult(JSON.parse(clean.slice(a, b + 1)));
    } catch (e) {
      setAiError("Analysis failed: " + String(e.message || e));
    } finally { setAiBusy(false); }
  };

  // ============================ CSS ============================
  const css = `
    @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
    .wr * { box-sizing:border-box; margin:0; }
    .wr { --bg:#0a0d10; --panel:#11161c; --panel2:#161d25; --line:#212b36; --ink:#e8edf2; --dim:#8595a6; --acc:#2ee66b; --amber:#ffb020; --red:#ff4d5e;
      background:var(--bg); color:var(--ink); min-height:100vh; font-family:'IBM Plex Mono',monospace; font-size:13px;
      background-image:radial-gradient(ellipse 80% 50% at 50% -10%, rgba(46,230,107,0.06), transparent); }
    .wr .disp { font-family:'Barlow Condensed',sans-serif; }
    .wr .hdr { position:sticky; top:0; z-index:20; background:rgba(10,13,16,0.92); backdrop-filter:blur(8px); border-bottom:1px solid var(--line); padding:10px 14px; }
    .wr .brand { font-family:'Barlow Condensed'; font-weight:800; font-size:15px; letter-spacing:3px; color:var(--acc); }
    .wr .bignum { font-family:'Barlow Condensed'; font-weight:800; font-size:34px; line-height:1; }
    .wr .onclock { animation:pulse 1.4s ease-in-out infinite; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.55} }
    .wr .tabs { display:flex; border-bottom:1px solid var(--line); background:var(--panel); position:sticky; top:73px; z-index:19; }
    .wr .tab { flex:1; padding:10px 2px; text-align:center; font-family:'Barlow Condensed'; font-weight:700; font-size:13px; letter-spacing:1px; color:var(--dim); border:none; background:none; cursor:pointer; border-bottom:2px solid transparent; }
    .wr .tab.on { color:var(--acc); border-bottom-color:var(--acc); }
    .wr .chip { padding:5px 11px; border-radius:3px; border:1px solid var(--line); background:var(--panel); color:var(--dim); font-family:'IBM Plex Mono'; font-size:11px; font-weight:600; cursor:pointer; }
    .wr .chip.on { background:var(--acc); color:#06130a; border-color:var(--acc); }
    .wr input, .wr select { background:var(--panel2); border:1px solid var(--line); color:var(--ink); padding:9px 11px; border-radius:4px; font-family:'IBM Plex Mono'; font-size:13px; width:100%; }
    .wr .row { display:flex; align-items:center; gap:10px; padding:9px 12px; border-bottom:1px solid var(--line); }
    .wr .posb { font-family:'Barlow Condensed'; font-weight:800; font-size:12px; letter-spacing:1px; padding:2px 6px; border-radius:3px; min-width:34px; text-align:center; }
    .wr .btn { border:none; border-radius:4px; padding:10px 16px; font-family:'Barlow Condensed'; font-weight:800; font-size:15px; letter-spacing:2px; cursor:pointer; }
    .wr .btn.p { background:var(--acc); color:#06130a; } .wr .btn.g { background:var(--panel2); color:var(--ink); border:1px solid var(--line); } .wr .btn.d { background:var(--red); color:#fff; }
    .wr .modal { position:fixed; inset:0; background:rgba(0,0,0,.75); z-index:50; display:flex; align-items:flex-end; justify-content:center; }
    .wr .sheet { background:var(--panel); border-top:2px solid var(--acc); width:100%; max-width:560px; padding:18px 16px 26px; border-radius:12px 12px 0 0; }
    .wr .card { background:var(--panel); border:1px solid var(--line); border-radius:6px; padding:14px; }
    .wr .toast { position:fixed; bottom:14px; left:50%; transform:translateX(-50%); z-index:60; width:min(94vw,520px); }
  `;

  const PosBadge = ({ pos }) => (
    <span className="posb" style={{ background: (POS_COLOR[pos] || "#888") + "22", color: POS_COLOR[pos] || "#888", border: `1px solid ${POS_COLOR[pos] || "#888"}55` }}>{pos}</span>
  );
  const StatLine = ({ p }) => (
    <span style={{ color: "var(--dim)", fontSize: 10 }}>
      {p.team}{p.adp ? ` · adp ${p.adp}` : ""}{p.lastFinish ? ` · '25 ${p.lastFinish}` : ""}
    </span>
  );

  // ---------- AUTH GATE ----------
  if (authed === null) {
    return <div className="wr" style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}><style>{css}</style>
      <div className="disp" style={{ fontSize: 18, letterSpacing: 3, color: "var(--acc)" }}>CHECKING ACCESS…</div></div>;
  }
  if (authed === false) {
    return <LoginGate css={css} onSuccess={() => window.location.reload()} />;
  }

  // ---------- SETUP ----------
  if (phase === "setup") {
    const savedDraft = picks.length > 0 || keepers.length > 0;
    return (
      <div className="wr"><style>{css}</style>
        <div style={{ padding: "34px 18px 24px" }}>
          <div className="brand">◤ DRAFT WAR ROOM</div>
          <div className="disp" style={{ fontSize: 42, fontWeight: 800, lineHeight: 1, margin: "10px 0 4px" }}>2026 SEASON</div>
          <div style={{ color: "var(--dim)", fontSize: 12, marginBottom: 8 }}>full PPR · snake · live pick intelligence</div>
          <div style={{ color: boardErr ? "var(--amber)" : "var(--acc)", fontSize: 11, marginBottom: 20 }}>
            {boardErr || (boardMeta ? `● live board loaded — ${boardMeta.players.length} players · updated ${new Date(boardMeta.updated).toLocaleTimeString()}` : "loading live rankings…")}
          </div>

          {savedDraft && (
            <div className="card" style={{ marginBottom: 18, borderColor: "var(--amber)" }}>
              <div className="disp" style={{ fontWeight: 700, fontSize: 16, color: "var(--amber)" }}>
                SAVED — {cfg.league}: {picks.length} picks{keepers.length ? ` · ${keepers.length} keepers` : ""}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button className="btn p" onClick={() => setPhase("draft")}>RESUME</button>
                <button className="btn g" onClick={() => { setPicks([]); setKeepers([]); setQueue([]); localStorage.removeItem(lsKey(cfg.league)); }}>DISCARD</button>
              </div>
            </div>
          )}

          <div style={{ display: "grid", gap: 14 }}>
            <div>
              <div style={{ fontSize: 11, color: "var(--dim)", marginBottom: 6 }}>LEAGUE</div>
              <select value={cfg.league} onChange={(e) => {
                const league = e.target.value;
                const p = LEAGUE_PRESETS.find((x) => x.name === league);
                const saved = loadLeague(league);
                const teams = saved?.cfg?.teams || (p ? p.teams : cfg.teams);
                setCfg((c) => ({ ...c, league, teams, keeper: p ? p.keeper : false }));
                applySaved(saved);
                localStorage.setItem(LAST_LEAGUE_KEY, league);
                loadBoard(teams);
              }}>
                {LEAGUE_PRESETS.map((p) => <option key={p.name}>{p.name}</option>)}
                <option>Custom league</option>
              </select>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
              <div><div style={{ fontSize: 11, color: "var(--dim)", marginBottom: 6 }}>TEAMS</div>
                <input type="number" min="4" max="20" value={cfg.teams} onChange={(e) => { const t = +e.target.value || 10; setCfg((c) => ({ ...c, teams: t })); loadBoard(t); }} /></div>
              <div><div style={{ fontSize: 11, color: "var(--dim)", marginBottom: 6 }}>MY SLOT</div>
                <input type="number" min="1" max={cfg.teams} value={cfg.slot} onChange={(e) => setCfg((c) => ({ ...c, slot: +e.target.value || 1 }))} /></div>
              <div><div style={{ fontSize: 11, color: "var(--dim)", marginBottom: 6 }}>ROUNDS</div>
                <input type="number" min="8" max="25" value={cfg.rounds} onChange={(e) => setCfg((c) => ({ ...c, rounds: +e.target.value || 16 }))} /></div>
            </div>
            <button className="btn p" style={{ padding: 14, fontSize: 18 }} onClick={() => { setPicks([]); setQueue([]); localStorage.setItem(LAST_LEAGUE_KEY, cfg.league); setPhase("draft"); }}>
              {picks.length ? "START FRESH DRAFT →" : "ENTER THE WAR ROOM →"}
            </button>
            <div style={{ color: "var(--dim)", fontSize: 11, lineHeight: 1.6 }}>
              Rankings: FantasyCalc consensus + Fantasy Football Calculator ADP + Sleeper 2025 PPR results, refreshed live. Auto-capture picks via ESPN Sync or Screen OCR in the SYNC tab.
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ---------- DRAFT ----------
  const curRound = draftDone ? cfg.rounds : roundOf(currentOverall, T);
  const curPickInRound = draftDone ? T : pickInRound(currentOverall, T);
  const rosterView = slotRoster(myRosterPlayers);
  const queuedAvail = queue.map((id) => players.find((p) => p.id === id)).filter((p) => p && !draftedIds.has(p.id));

  return (
    <div className="wr"><style>{css}</style>

      <div className="hdr">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div className="brand">◤ WAR ROOM</div>
          <div style={{ display: "flex", gap: 6 }}>
            <button className="chip" onClick={() => { if (watcherRef.current) stopOcr(); setEspnOn(false); setPhase("setup"); }}>⌂ HOME</button>
            {cfg.keeper && <button className="chip" onClick={() => setShowKeeperModal(true)}>KEEPERS</button>}
            <button className="chip" onClick={() => setShowAddModal(true)}>+ PLAYER</button>
            <button className="chip" onClick={undo} disabled={!picks.length} style={{ opacity: picks.length ? 1 : 0.4 }}>UNDO</button>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, marginTop: 6 }}>
          {draftDone ? <div className="bignum" style={{ color: "var(--acc)" }}>DRAFT COMPLETE</div> : (<>
            <div>
              <span className="bignum">{curRound}<span style={{ color: "var(--dim)", fontSize: 20 }}>.{String(curPickInRound).padStart(2, "0")}</span></span>
              <span style={{ color: "var(--dim)", fontSize: 11, marginLeft: 8 }}>OVR {currentOverall}</span>
            </div>
            <div style={{ textAlign: "right" }}>
              {iAmOnClock
                ? <div className="disp onclock" style={{ color: "var(--acc)", fontWeight: 800, fontSize: 20, letterSpacing: 2 }}>⬤ YOU'RE ON THE CLOCK</div>
                : <><div className="disp" style={{ fontWeight: 700, fontSize: 16 }}>{teamName(onClockSlot)} picking</div>
                  <div style={{ color: "var(--amber)", fontSize: 11 }}>{picksUntilMe} pick{picksUntilMe === 1 ? "" : "s"} until you (ovr {myNextPick})</div></>}
            </div>
          </>)}
        </div>
      </div>

      <div className="tabs">
        {[["board","BOARD"],["roster","TEAM"],["log","PICKS"],["sync","SYNC"],["ai","⚡ AI"]].map(([k, label]) => (
          <button key={k} className={`tab ${tab === k ? "on" : ""}`} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>

      <div style={{ paddingBottom: 100 }}>

        {tab === "board" && (
          <div>
            <div style={{ padding: "10px 12px", display: "flex", gap: 6, flexWrap: "wrap" }}>
              {["ALL","QB","RB","WR","TE","DST","K"].map((p) => (
                <button key={p} className={`chip ${posFilter === p ? "on" : ""}`} onClick={() => setPosFilter(p)}>{p}</button>
              ))}
            </div>
            <div style={{ padding: "0 12px 10px" }}>
              <input placeholder="Search player…" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            {queuedAvail.length > 0 && posFilter === "ALL" && !search && (
              <div style={{ padding: "0 12px 8px" }}>
                <div style={{ fontSize: 10, letterSpacing: 2, color: "var(--amber)", marginBottom: 4 }}>★ MY QUEUE</div>
                {queuedAvail.map((p) => (
                  <div key={p.id} className="row" style={{ background: "var(--panel)", borderRadius: 4, border: "1px solid var(--line)", marginBottom: 4 }}>
                    <span style={{ color: "var(--dim)", width: 30, fontSize: 11 }}>{p.rank}</span>
                    <PosBadge pos={p.pos} />
                    <span style={{ flex: 1, fontWeight: 600 }}>{p.name}<br /><StatLine p={p} /></span>
                    <button className="btn p" style={{ padding: "6px 12px", fontSize: 13 }} onClick={() => setConfirmPlayer(p)}>DRAFT</button>
                  </div>
                ))}
              </div>
            )}
            {available.slice(0, 100).map((p) => (
              <div key={p.id} className="row">
                <span style={{ color: "var(--dim)", width: 30, fontSize: 11 }}>{p.rank}</span>
                <PosBadge pos={p.pos} />
                <span style={{ flex: 1, fontWeight: 600 }} onClick={() => toggleQueue(p.id)}>
                  {p.name}{queue.includes(p.id) && <span style={{ color: "var(--amber)" }}> ★</span>}<br /><StatLine p={p} />
                </span>
                <button className="btn g" style={{ padding: "6px 12px", fontSize: 13 }} onClick={() => setConfirmPlayer(p)}>DRAFT</button>
              </div>
            ))}
            <div style={{ padding: 14, color: "var(--dim)", fontSize: 11, textAlign: "center" }}>
              tap a name to ★ queue · showing top 100 of {available.length}
              {boardMeta && <><br />rankings updated {new Date(boardMeta.updated).toLocaleTimeString()} · ADP by Fantasy Football Calculator</>}
            </div>
          </div>
        )}

        {tab === "roster" && (
          <div style={{ padding: 12 }}>
            <div className="disp" style={{ fontSize: 22, fontWeight: 800, marginBottom: 10 }}>MY ROSTER — SLOT {cfg.slot}</div>
            {rosterView.slots.map((s, i) => (
              <div key={i} className="row" style={{ background: s.player ? "var(--panel)" : "transparent" }}>
                <span style={{ width: 44, color: "var(--dim)", fontSize: 11 }}>{s.slot}</span>
                {s.player ? <><PosBadge pos={s.player.pos} /><span style={{ fontWeight: 600 }}>{s.player.name} <StatLine p={s.player} /></span></>
                  : <span style={{ color: "var(--line)" }}>— open —</span>}
              </div>
            ))}
            {rosterView.bench.length > 0 && <>
              <div style={{ fontSize: 10, letterSpacing: 2, color: "var(--dim)", margin: "14px 0 4px" }}>BENCH</div>
              {rosterView.bench.map((p, i) => (
                <div key={i} className="row"><span style={{ width: 44, color: "var(--dim)", fontSize: 11 }}>BN</span>
                  <PosBadge pos={p.pos} /><span style={{ fontWeight: 600 }}>{p.name} <StatLine p={p} /></span></div>
              ))}
            </>}
          </div>
        )}

        {tab === "log" && (
          <div>
            {[...picks].reverse().map((p) => {
              const pl = players.find((x) => x.id === p.playerId);
              const slot = teamForPick(p.overall, T);
              return (
                <div key={p.overall} className="row" style={slot === cfg.slot ? { background: "rgba(46,230,107,0.07)" } : {}}>
                  <span style={{ width: 46, color: "var(--dim)", fontSize: 11 }}>{roundOf(p.overall, T)}.{String(pickInRound(p.overall, T)).padStart(2, "0")}</span>
                  {pl && <PosBadge pos={pl.pos} />}
                  <span style={{ flex: 1, fontWeight: 600 }}>{pl ? pl.name : "?"}
                    {p.keeper && <span style={{ color: "var(--amber)", fontSize: 10 }}> KEEPER</span>}
                    {p.src === "espn" && <span style={{ color: "var(--acc)", fontSize: 10 }}> ⇄</span>}
                    {p.src === "ocr" && <span style={{ color: "var(--acc)", fontSize: 10 }}> ⌖</span>}
                  </span>
                  <span style={{ color: slot === cfg.slot ? "var(--acc)" : "var(--dim)", fontSize: 11 }}>{teamName(slot)}</span>
                </div>
              );
            })}
            {!picks.length && <div style={{ padding: 20, color: "var(--dim)", textAlign: "center" }}>No picks yet.</div>}
          </div>
        )}

        {tab === "sync" && (
          <div style={{ padding: 12, display: "grid", gap: 14 }}>
            <div className="card">
              <div className="disp" style={{ fontSize: 18, fontWeight: 800, color: "var(--acc)" }}>⇄ ESPN LEAGUE SYNC</div>
              <div style={{ color: "var(--dim)", fontSize: 11, margin: "4px 0 10px", lineHeight: 1.6 }}>
                Polls your league's draft every 6s and logs picks automatically. Most reliable option. Needs espn_s2 + SWID cookies set on the server for private leagues (see README).
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <input placeholder="ESPN League ID" value={espnLeagueId} onChange={(e) => setEspnLeagueId(e.target.value)} />
                <button className={`btn ${espnOn ? "d" : "p"}`} onClick={() => setEspnOn(!espnOn)}>{espnOn ? "STOP" : "SYNC"}</button>
              </div>
              {espnStatus && <div style={{ fontSize: 11, color: espnStatus.startsWith("✕") ? "var(--red)" : "var(--acc)", marginTop: 8 }}>{espnStatus}</div>}
            </div>

            <div className="card">
              <div className="disp" style={{ fontSize: 18, fontWeight: 800, color: "var(--amber)" }}>⌖ SCREEN OCR WATCHER</div>
              <div style={{ color: "var(--dim)", fontSize: 11, margin: "4px 0 10px", lineHeight: 1.6 }}>
                Shares your draft-room tab/window, then drag a box over the PICK HISTORY panel. New names in that region get flagged as picks. Confirm each, or flip auto-log.
              </div>
              {!ocrOn
                ? <button className="btn p" onClick={startOcr}>START SCREEN CAPTURE</button>
                : <div style={{ display: "grid", gap: 8 }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <button className="btn d" onClick={stopOcr}>STOP</button>
                      <button className="chip" onClick={() => setCropMode(true)}>RE-CROP</button>
                      <label style={{ fontSize: 11, color: "var(--dim)", display: "flex", alignItems: "center", gap: 6 }}>
                        <input type="checkbox" style={{ width: "auto" }} checked={ocrAuto} onChange={(e) => setOcrAuto(e.target.checked)} /> auto-log
                      </label>
                      <span style={{ fontSize: 11, color: "var(--acc)" }}>{ocrStatus}</span>
                    </div>
                    {cropMode && <div style={{ fontSize: 11, color: "var(--amber)" }}>Drag a rectangle over the pick history area ↓</div>}
                    <canvas ref={previewRef} style={{ width: "100%", borderRadius: 6, border: "1px solid var(--line)", cursor: cropMode ? "crosshair" : "default", display: ocrOn ? "block" : "none" }}
                      {...(cropMode ? cropHandlers : {})} />
                  </div>}
            </div>
          </div>
        )}

        {tab === "ai" && (
          <div style={{ padding: 12 }}>
            <div className="disp" style={{ fontSize: 22, fontWeight: 800 }}>THE ANALYST</div>
            <div style={{ color: "var(--dim)", fontSize: 12, margin: "4px 0 14px" }}>Reads your live state, checks news, makes the call.</div>
            <button className="btn p" style={{ width: "100%", padding: 14, fontSize: 17 }} disabled={aiBusy} onClick={() => runAnalysis("")}>
              {aiBusy ? "ANALYZING…" : iAmOnClock ? "⚡ WHO DO I TAKE RIGHT NOW" : "⚡ ANALYZE UPCOMING PICK"}
            </button>
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <input placeholder="Or ask anything…" value={aiQuestion} onChange={(e) => setAiQuestion(e.target.value)} />
              <button className="btn g" disabled={aiBusy || !aiQuestion.trim()} onClick={() => runAnalysis(aiQuestion)}>ASK</button>
            </div>
            {aiError && <div className="card" style={{ marginTop: 14, borderColor: "var(--red)", color: "var(--red)" }}>{aiError}</div>}
            {aiResult && (
              <div style={{ marginTop: 16, display: "grid", gap: 10 }}>
                <div className="card" style={{ borderColor: "var(--acc)", background: "rgba(46,230,107,0.05)" }}>
                  <div style={{ fontSize: 10, letterSpacing: 2, color: "var(--acc)" }}>RECOMMENDATION · {(aiResult.confidence || "").toUpperCase()}</div>
                  <div className="disp" style={{ fontSize: 30, fontWeight: 800, margin: "4px 0" }}>{aiResult.recommendation}</div>
                  <div style={{ fontSize: 12, lineHeight: 1.6 }}>{aiResult.reasoning}</div>
                  {(() => {
                    const rec = matchByName(aiResult.recommendation);
                    return rec && !draftedIds.has(rec.id) && iAmOnClock
                      ? <button className="btn p" style={{ marginTop: 10 }} onClick={() => doPick(rec.id)}>DRAFT {rec.name.toUpperCase()} ✓</button>
                      : null;
                  })()}
                </div>
                {aiResult.warning && <div className="card" style={{ borderColor: "var(--amber)", color: "var(--amber)", fontSize: 12 }}>⚠ {aiResult.warning}</div>}
                {(aiResult.alternatives || []).map((a, i) => (
                  <div key={i} className="card">
                    <div className="disp" style={{ fontWeight: 700, fontSize: 16 }}>{a.name}</div>
                    <div style={{ color: "var(--dim)", fontSize: 12 }}>{a.why}</div>
                  </div>
                ))}
                {aiResult.lookAhead && <div className="card" style={{ fontSize: 12 }}><span style={{ color: "var(--acc)", letterSpacing: 2, fontSize: 10 }}>NEXT PICK PLAN · </span>{aiResult.lookAhead}</div>}
              </div>
            )}
          </div>
        )}
      </div>

      {/* OCR pending detections toast */}
      {pending.length > 0 && !ocrAuto && (
        <div className="toast">
          <div className="card" style={{ borderColor: "var(--amber)" }}>
            <div style={{ fontSize: 10, letterSpacing: 2, color: "var(--amber)", marginBottom: 6 }}>⌖ OCR DETECTED PICK</div>
            {pending.slice(0, 3).map((p) => (
              <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <PosBadge pos={p.pos} />
                <span style={{ flex: 1, fontWeight: 600 }}>{p.name}</span>
                <button className="btn p" style={{ padding: "5px 10px", fontSize: 12 }} onClick={() => doPick(p.id, "ocr")}>LOG</button>
                <button className="chip" onClick={() => setPending((pd) => pd.filter((x) => x.id !== p.id))}>✕</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {confirmPlayer && (
        <div className="modal" onClick={() => setConfirmPlayer(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div style={{ fontSize: 10, letterSpacing: 2, color: "var(--dim)" }}>PICK {curRound}.{String(curPickInRound).padStart(2, "0")} · {teamName(onClockSlot)}</div>
            <div className="disp" style={{ fontSize: 28, fontWeight: 800, margin: "6px 0 2px" }}>{confirmPlayer.name}</div>
            <div style={{ marginBottom: 16 }}><PosBadge pos={confirmPlayer.pos} /> <StatLine p={confirmPlayer} /></div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className={`btn ${iAmOnClock ? "p" : "d"}`} style={{ flex: 1, padding: 13 }} onClick={() => doPick(confirmPlayer.id)}>
                {iAmOnClock ? "✓ DRAFT TO MY TEAM" : `LOG TO ${teamName(onClockSlot).toUpperCase()}`}
              </button>
              <button className="btn g" onClick={() => setConfirmPlayer(null)}>CANCEL</button>
            </div>
          </div>
        </div>
      )}

      {showAddModal && <AddPlayerSheet onAdd={(name, pos, team) => {
        const id = 100000 + players.filter((p) => p.custom).length;
        setPlayers((prev) => [...prev, { id, name, pos, team, rank: 999, adp: null, lastPts: null, lastFinish: null, custom: true }]);
        setShowAddModal(false);
      }} onClose={() => setShowAddModal(false)} />}

      {showKeeperModal && (
        <KeeperSheet players={players} keepers={keepers} teams={T} rounds={cfg.rounds} teamName={teamName}
          onSave={setKeepers} onClose={() => setShowKeeperModal(false)} />
      )}
    </div>
  );
}

function AddPlayerSheet({ onAdd, onClose }) {
  const [name, setName] = useState(""); const [pos, setPos] = useState("RB"); const [team, setTeam] = useState("");
  return (
    <div className="modal" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="disp" style={{ fontSize: 20, fontWeight: 800, marginBottom: 12 }}>ADD PLAYER</div>
        <div style={{ display: "grid", gap: 10 }}>
          <input placeholder="Player name" value={name} onChange={(e) => setName(e.target.value)} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <select value={pos} onChange={(e) => setPos(e.target.value)}>
              {["QB","RB","WR","TE","DST","K"].map((p) => <option key={p}>{p}</option>)}
            </select>
            <input placeholder="Team" value={team} onChange={(e) => setTeam(e.target.value)} />
          </div>
          <button className="btn p" disabled={!name.trim()} onClick={() => onAdd(name.trim(), pos, team.toUpperCase() || "FA")}>ADD TO BOARD</button>
        </div>
      </div>
    </div>
  );
}

function KeeperSheet({ players, keepers, teams, rounds, teamName, onSave, onClose }) {
  const [list, setList] = useState(keepers);
  const [pid, setPid] = useState(""); const [slot, setSlot] = useState(1); const [rd, setRd] = useState(1); const [q, setQ] = useState("");
  const matches = q.length > 1 ? players.filter((p) => p.name.toLowerCase().includes(q.toLowerCase())).slice(0, 5) : [];
  return (
    <div className="modal" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} style={{ maxHeight: "85vh", overflowY: "auto" }}>
        <div className="disp" style={{ fontSize: 20, fontWeight: 800, marginBottom: 4 }}>KEEPERS</div>
        <div style={{ color: "var(--dim)", fontSize: 11, marginBottom: 12 }}>Each keeper auto-fills its team's pick when that round arrives.</div>
        {list.map((k, i) => {
          const p = players.find((x) => x.id === k.playerId);
          return (
            <div key={i} className="row">
              <span style={{ flex: 1, fontWeight: 600 }}>{p?.name} <span style={{ color: "var(--dim)", fontSize: 11 }}>→ {teamName(k.teamSlot)}, rd {k.round}</span></span>
              <button className="chip" onClick={() => setList((l) => l.filter((_, j) => j !== i))}>✕</button>
            </div>
          );
        })}
        <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
          <input placeholder="Search player to keep…" value={q} onChange={(e) => { setQ(e.target.value); setPid(""); }} />
          {matches.map((m) => (
            <button key={m.id} className="chip" style={pid === m.id ? { background: "var(--acc)", color: "#06130a" } : {}} onClick={() => { setPid(m.id); setQ(m.name); }}>
              {m.name} ({m.pos}, {m.team})
            </button>
          ))}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <select value={slot} onChange={(e) => setSlot(+e.target.value)}>
              {Array.from({ length: teams }, (_, i) => <option key={i} value={i + 1}>{teamName(i + 1)}</option>)}
            </select>
            <select value={rd} onChange={(e) => setRd(+e.target.value)}>
              {Array.from({ length: rounds }, (_, i) => <option key={i} value={i + 1}>Round {i + 1}</option>)}
            </select>
          </div>
          <button className="btn g" disabled={pid === ""} onClick={() => { setList((l) => [...l, { playerId: pid, teamSlot: slot, round: rd }]); setQ(""); setPid(""); }}>+ ADD KEEPER</button>
          <button className="btn p" onClick={() => { onSave(list); onClose(); }}>SAVE KEEPERS</button>
        </div>
      </div>
    </div>
  );
}

function LoginGate({ css, onSuccess }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!pw || busy) return;
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      if (r.status === 429) { setErr("Too many attempts. Wait a few minutes."); return; }
      if (!r.ok) { setErr("Invalid password."); return; }
      onSuccess();
    } catch (_) {
      setErr("Connection error.");
    } finally { setBusy(false); }
  };
  return (
    <div className="wr" style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", padding: 18 }}>
      <style>{css}</style>
      <div style={{ width: "100%", maxWidth: 380 }}>
        <div className="brand">◤ DRAFT WAR ROOM</div>
        <div className="disp" style={{ fontSize: 34, fontWeight: 800, margin: "8px 0 18px" }}>RESTRICTED</div>
        <div style={{ display: "grid", gap: 10 }}>
          <input type="password" placeholder="Access password" value={pw} autoFocus
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()} />
          <button className="btn p" style={{ padding: 13 }} disabled={busy || !pw} onClick={submit}>
            {busy ? "…" : "ENTER"}
          </button>
          {err && <div style={{ color: "var(--red)", fontSize: 12 }}>{err}</div>}
        </div>
      </div>
    </div>
  );
}
