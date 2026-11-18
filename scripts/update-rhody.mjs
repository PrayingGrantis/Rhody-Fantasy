import fs from "fs";
import path from "path";

const LEAGUE_ID = "1389738151307649024";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchWithTimeout(url, options = {}, timeoutMs = 45000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getJSON(url, retries = 3) {
  for (let i = 1; i <= retries; i++) {
    try {
      const res = await fetchWithTimeout(url, {}, 20000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i === retries) throw new Error(`Failed ${url}: ${err.message}`);
      await sleep(2000 * i);
    }
  }
}

async function callGeminiHydrogen(prompt) {
  const modelsToTry = [
    "gemini-4-hydrogen",
    "gemini-3.8-flash",
    "gemini-3.5-flash-lite"
  ];
  let lastError = null;

  for (const model of modelsToTry) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`🤖 Calling ${model} (Attempt ${attempt}/3)...`);
        const res = await fetchWithTimeout(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: {
                responseMimeType: "application/json"
              }
            })
          },
          60000
        );

        const json = await res.json();
        if (!res.ok || json.error) {
          throw new Error(json.error?.message || `HTTP ${res.status}`);
        }

        // Extract the final non-thought text part from Gemini 4 Hydrogen
        const parts = json.candidates?.[0]?.content?.parts || [];
        const textPart = parts.filter((p) => !p.thought && typeof p.text === "string").pop() || parts[parts.length - 1];
        let rawText = (textPart?.text || "{}").trim();
        rawText = rawText.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();

        const parsed = JSON.parse(rawText);
        if (parsed && Array.isArray(parsed.roasts) && parsed.roasts.length > 0) {
          console.log(`✅ Daily broadcast package generated with ${model}!`);
          return { modelUsed: model, package: parsed };
        }
        throw new Error("Returned incomplete JSON structure");
      } catch (err) {
        lastError = err.message;
        console.warn(`⚠️ ${model} attempt ${attempt} failed: ${lastError}`);
        if (attempt < 3) await sleep(attempt * 5000);
      }
    }
  }

  throw new Error(`All Gemini models failed. Last error: ${lastError}`);
}

async function main() {
  console.log("🐏 Starting 8:00 AM Rhody Daily Broadcast Sync for " + LEAGUE_ID);

  if (!GEMINI_API_KEY) {
    throw new Error("❌ GEMINI_API_KEY is missing in Repository Secrets!");
  }

  // 1. Get live NFL State (current week & season)
  const nflState = await getJSON("https://api.sleeper.app/v1/state/nfl");
  const activeWeek = Math.max(1, Math.min(18, Number(nflState.week || nflState.display_week || 1)));

  // 2. Download Master NFL Player Dictionary
  const playersRaw = await getJSON("https://api.sleeper.app/v1/players/nfl");
  const playerNames = {};
  for (const [id, p] of Object.entries(playersRaw)) {
    const fullName = p.full_name || `${p.first_name || ""} ${p.last_name || ""}`.trim();
    if (fullName) {
      playerNames[id] = {
        name: fullName,
        pos: p.position || "FLEX",
        team: p.team || "FA"
      };
    }
  }

  const formatPlayer = (pid) => {
    const entry = playerNames[pid];
    if (!entry) return `Player #${pid}`;
    return `${entry.name} (${entry.pos} - ${entry.team})`;
  };

  // 3. Crawl ALL seasons via previous_league_id
  const history = [];
  let currId = LEAGUE_ID;
  let currentWeekMatchups = [];
  let lastWeekMatchups = [];

  while (currId && currId !== "0" && history.length < 10) {
    const league = await getJSON(`https://api.sleeper.app/v1/league/${currId}`);
    const users = await getJSON(`https://api.sleeper.app/v1/league/${currId}/users`);
    const rosters = await getJSON(`https://api.sleeper.app/v1/league/${currId}/rosters`);

    const userMap = Object.fromEntries(users.map((u) => [u.user_id, u.display_name]));
    const rosterMap = Object.fromEntries(
      rosters.map((r) => [r.roster_id, userMap[r.owner_id] || `Roster ${r.roster_id}`])
    );

    // If this is the active league, pull current week & previous week head-to-head matchups
    if (currId === LEAGUE_ID) {
      const parseMatchups = (rawList, wkNum) => {
        const groups = {};
        for (const m of rawList || []) {
          if (!m.matchup_id) continue;
          if (!groups[m.matchup_id]) groups[m.matchup_id] = [];
          groups[m.matchup_id].push({
            manager: rosterMap[m.roster_id] || `Roster ${m.roster_id}`,
            points: Number((m.points || 0).toFixed(2)),
            topStarters: (m.starters || []).slice(0, 4).map((pid) => formatPlayer(pid))
          });
        }
        return Object.values(groups).filter((g) => g.length === 2).map(([a, b]) => ({
          week: wkNum,
          teamA: a.manager,
          scoreA: a.points,
          teamB: b.manager,
          scoreB: b.points
        }));
      };

      try {
        const mCurr = await getJSON(`https://api.sleeper.app/v1/league/${currId}/matchups/${activeWeek}`);
        currentWeekMatchups = parseMatchups(mCurr, activeWeek);
      } catch (_) {}

      if (activeWeek > 1) {
        try {
          const mPrev = await getJSON(`https://api.sleeper.app/v1/league/${currId}/matchups/${activeWeek - 1}`);
          lastWeekMatchups = parseMatchups(mPrev, activeWeek - 1);
        } catch (_) {}
      }
    }

    const trades = [];
    const waivers = [];
    for (let wk = 18; wk >= 1; wk--) {
      try {
        const txs = await getJSON(`https://api.sleeper.app/v1/league/${currId}/transactions/${wk}`);
        for (const tx of txs) {
          if (tx.status !== "complete") continue;
          const summary = {
            season: league.season,
            week: wk,
            type: tx.type,
            managers: (tx.roster_ids || []).map((rid) => rosterMap[rid]),
            added: Object.entries(tx.adds || {}).map(
              ([pid, rid]) => `${rosterMap[rid]} received ${formatPlayer(pid)}`
            ),
            dropped: Object.entries(tx.drops || {}).map(
              ([pid, rid]) => `${rosterMap[rid]} dropped ${formatPlayer(pid)}`
            ),
            faabBid: tx.settings?.waiver_bid || 0,
            timestamp: tx.status_updated,
            date: new Date(tx.status_updated).toLocaleString("en-US", { timeZone: "America/New_York" })
          };
          if (tx.type === "trade") trades.push(summary);
          else if (tx.type === "waiver" || tx.type === "free_agent") waivers.push(summary);
        }
      } catch (_) {}
    }

    trades.sort((a, b) => b.timestamp - a.timestamp);
    waivers.sort((a, b) => b.timestamp - a.timestamp);

    history.push({
      season: league.season,
      league_id: currId,
      standings: rosters
        .map((r) => {
          const fpts = (r.settings?.fpts || 0) + (r.settings?.fpts_decimal || 0) / 100;
          const maxFpts = (r.settings?.ppts || 0) + (r.settings?.ppts_decimal || 0) / 100;
          return {
            manager: rosterMap[r.roster_id],
            wins: r.settings?.wins || 0,
            losses: r.settings?.losses || 0,
            fpts: Number(fpts.toFixed(2)),
            fptsAgainst: Number(
              ((r.settings?.fpts_against || 0) + (r.settings?.fpts_against_decimal || 0) / 100).toFixed(2)
            ),
            benchPointsLeftBehind: Number(Math.max(0, maxFpts - fpts).toFixed(2)),
            faabUsed: r.settings?.waiver_budget_used || 0,
            streak: r.metadata?.streak || ""
          };
        })
        .sort((a, b) => b.wins - a.wins || b.fpts - a.fpts),
      trades,
      waivers: waivers.slice(0, 30)
    });

    currId = league.previous_league_id;
  }

  const currentSeason = history[0] || {};
  const recentTrades = (currentSeason.trades || []).slice(0, 10);
  const recentWaivers = (currentSeason.waivers || []).slice(0, 15);
  const todayFormatted = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York"
  });

  const prompt = `
You are the savage, hilarious executive producer and host of the "Rhody Gridiron Desk" (a URI / Kingston-themed daily fantasy football broadcast) covering the Sleeper league "Rhody".
Today's Morning Broadcast Date: ${todayFormatted} (8:00 AM EST Release)
Current NFL Week: Week ${activeWeek} (${currentSeason.season} Season)

BACKGROUND LORE (Use only as seasoning—your primary job is to report on and roast WHAT IS HAPPENING RIGHT NOW in the live standings, matchups, trades, and waivers below):
- JewsinParis infamously traded Drake London for Jordan Mason.
- Caaaam blew 50 FAAB in Week 1 on a defense, loves vetoing trades, and writes league newsletters.
- ELord11 is a compulsive trade addict.
- PrayingGrantis builds stacked superteams.
- Tylero0 sends terrible fleece offers.
- CerealStroke ignores FAAB/waivers.
- CarlaCote is in witness protection and still sneaks into wins.

=== CURRENT STANDINGS (Week ${activeWeek}) ===
${JSON.stringify(currentSeason.standings, null, 2)}

=== THIS WEEK'S LIVE / UPCOMING MATCHUPS (Week ${activeWeek}) ===
${JSON.stringify(currentWeekMatchups, null, 2)}

=== LAST WEEK'S FINAL SCORES (Week ${activeWeek - 1}) ===
${JSON.stringify(lastWeekMatchups, null, 2)}

=== MOST RECENT COMPLETED TRADES (Newest First) ===
${JSON.stringify(recentTrades, null, 2)}

=== MOST RECENT WAIVER & FREE AGENT MOVES ===
${JSON.stringify(recentWaivers, null, 2)}

Generate a complete, fresh 8:00 AM Daily Update for the entire website. Every section must reflect the exact records, points, matchups, trades, and waiver moves above.

Return ONLY valid JSON matching this exact structure:
{
  "dailyHeadline": "Main banner headline summarizing the #1 storyline in the Rhody league today",
  "dailySubhead": "1-2 sentence sub-banner teasing today's matchups, newest trades, or standings chaos",
  "tickerTape": [
    "6 punchy breaking-news ticker items (include actual scores, records, traded players, and FAAB bids)"
  ],
  "roasts": [
    {
      "category": "BREAKING TRADE DESK" | "MATCHUP SPOTLIGHT" | "WAIVER WIRE AUTOPSY" | "STANDINGS & PLAYOFF PICTURE",
      "headline": "Specific, witty headline naming managers and players",
      "timestamp": "8:00 AM DAILY EDITION • ${todayFormatted}",
      "body": "2-3 detailed, hilarious paragraphs analyzing the specific trade, matchup, waiver move, or standings battle."
    }
  ],
  "powerRankings": [
    {
      "rank": 1,
      "manager": "Exact manager name from standings",
      "tier": "KEANEY CONTENDER" | "FRINGE PLAYOFF THREAT" | "KINGSTON MID-PACK" | "DUMPSTER FIRE",
      "trend": "UP" | "DOWN" | "HOLD",
      "panicLevel": 15,
      "blurb": "2 fresh sentences roasting or praising their current record, points scored, bench mistakes, and latest trades/waivers."
    }
  ],
  "tradeGrades": [
    {
      "week": 1,
      "managers": "Manager A & Manager B",
      "summary": "Exact players exchanged",
      "winner": "Name of manager who won the deal (or 'BOTH FLEECED')",
      "gradeA": "Manager A: Grade (e.g., B+)",
      "gradeB": "Manager B: Grade (e.g., D-)",
      "verdict": "1-2 sentences grading this specific real trade from the data."
    }
  ]
}
Requirements:
- "roasts" must contain 4 distinct articles.
- "powerRankings" must include EVERY manager in currentStandings ranked 1 to ${currentSeason.standings?.length || 10}.
- "tradeGrades" must grade the top 4 most recent trades from the data above.
`;

  const { modelUsed, package: aiData } = await callGeminiHydrogen(prompt);

  const outputPayload = {
    updatedAt: new Date().toISOString(),
    editionDate: todayFormatted,
    modelUsed,
    activeWeek,
    dailyHeadline: aiData.dailyHeadline || "Rhody Gridiron Desk: 8:00 AM Morning Edition",
    dailySubhead: aiData.dailySubhead || "Live standings, trade grades, and daily power rankings from Kingston.",
    tickerTape: aiData.tickerTape || [],
    roasts: aiData.roasts || [],
    powerRankings: aiData.powerRankings || [],
    tradeGrades: aiData.tradeGrades || [],
    currentWeekMatchups,
    lastWeekMatchups,
    recentTrades,
    recentWaivers,
    currentStandings: currentSeason.standings || [],
    history
  };

  fs.mkdirSync(path.join(process.cwd(), "data"), { recursive: true });
  fs.writeFileSync(
    path.join(process.cwd(), "data", "rhody-data.json"),
    JSON.stringify(outputPayload, null, 2)
  );
  console.log("✅ Saved full daily broadcast package to data/rhody-data.json!");
}

main();
