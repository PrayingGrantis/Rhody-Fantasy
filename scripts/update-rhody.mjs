import fs from "fs";
import path from "path";

const LEAGUE_ID = "1389738151307649024";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed ${url}: ${res.status}`);
  return res.json();
}

async function callGeminiWithFallback(prompt) {
  const modelsToTry = ["gemini-3.8-flash", "gemini-flash-latest", "gemini-3.0-flash"];
  let lastError = null;

  for (const model of modelsToTry) {
    console.log(`🤖 Trying Gemini model: ${model}...`);
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 1.0
          }
        })
      }
    );

    const geminiJson = await geminiRes.json();
    if (geminiRes.ok && !geminiJson.error) {
      console.log(`✅ Success with ${model}!`);
      return geminiJson;
    }

    console.warn(`⚠️ Model ${model} returned status ${geminiRes.status}: ${geminiJson.error?.message}`);
    lastError = geminiJson.error?.message || geminiRes.statusText;
  }

  throw new Error(`All Gemini models failed. Last error: ${lastError}`);
}

async function main() {
  console.log("🐏 Starting 12-Hour Rhody Complete History & Roast Sync for " + LEAGUE_ID);

  // 1. Download Master NFL Player Dictionary
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

  // 2. Crawl ALL seasons via previous_league_id
  const history = [];
  let currId = LEAGUE_ID;
  while (currId && currId !== "0" && history.length < 10) {
    const league = await getJSON(`https://api.sleeper.app/v1/league/${currId}`);
    const users = await getJSON(`https://api.sleeper.app/v1/league/${currId}/users`);
    const rosters = await getJSON(`https://api.sleeper.app/v1/league/${currId}/rosters`);

    const userMap = Object.fromEntries(users.map(u => [u.user_id, u.display_name]));
    const rosterMap = Object.fromEntries(
      rosters.map(r => [r.roster_id, userMap[r.owner_id] || `Roster ${r.roster_id}`])
    );

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
            managers: (tx.roster_ids || []).map(rid => rosterMap[rid]),
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
      standings: rosters.map(r => {
        const fpts = (r.settings?.fpts || 0) + ((r.settings?.fpts_decimal || 0) / 100);
        const maxFpts = (r.settings?.ppts || 0) + ((r.settings?.ppts_decimal || 0) / 100);
        return {
          manager: rosterMap[r.roster_id],
          wins: r.settings?.wins || 0,
          losses: r.settings?.losses || 0,
          fpts: Number(fpts.toFixed(2)),
          fptsAgainst: Number(((r.settings?.fpts_against || 0) + ((r.settings?.fpts_against_decimal || 0) / 100)).toFixed(2)),
          benchPointsLeftBehind: Number(Math.max(0, maxFpts - fpts).toFixed(2)),
          faabUsed: r.settings?.waiver_budget_used || 0
        };
      }).sort((a, b) => b.wins - a.wins || b.fpts - a.fpts),
      trades,
      waivers: waivers.slice(0, 25)
    });

    currId = league.previous_league_id;
  }

  const currentSeason = history[0] || {};
  const recentTrades = (currentSeason.trades || []).slice(0, 8);
  const recentWaivers = (currentSeason.waivers || []).slice(0, 12);

  if (!GEMINI_API_KEY) {
    throw new Error("❌ GEMINI_API_KEY is missing!");
  }

  const prompt = `
You are the savage, hilarious host of the "Rhody Gridiron Desk" (URI / Kingston themed fantasy football broadcast) covering Sleeper League "Rhody".
Today's Date: ${new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" })}.

LEAGUE LORE (Use for flavor, but focus heavily on the NEWEST trades, waivers, and standings below!):
- JewsinParis once traded away Drake London for Jordan Mason.
- Caaaam blew 50 FAAB in Week 1 on a defense and loves vetoing trades.
- ELord11 is a trade addict.
- PrayingGrantis builds stacked superteams.
- Tylero0 sends terrible fleece offers.
- CerealStroke ignores FAAB/waivers.
- CarlaCote is in witness protection and still wins.

=== BREAKING / MOST RECENT TRADES THIS SEASON (Newest First) ===
${JSON.stringify(recentTrades, null, 2)}

=== MOST RECENT WAIVER & FREE AGENT MOVES ===
${JSON.stringify(recentWaivers, null, 2)}

=== CURRENT STANDINGS (${currentSeason.season}) ===
${JSON.stringify(currentSeason.standings, null, 2)}

TASK:
Write 4 fresh, savage, hilarious broadcast articles/roasts specifically breaking down the NEWEST trades above (name the exact players traded and roast the managers involved), recent waiver wire panic moves, and the current standings race. 

Return ONLY a valid JSON array of 4 objects with these exact keys:
[
  {
    "category": "BREAKING TRADE DESK" | "WAIVER WIRE AUTOPSY" | "CONTENDER WATCH" | "KINGSTON PANIC METER",
    "headline": "Punchy headline naming the managers/players",
    "timestamp": "LIVE • ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })} Edition",
    "body": "2-3 witty, detailed paragraphs breaking down the specific trade or league update."
  }
]
`;

  const geminiJson = await callGeminiWithFallback(prompt);
  let rawText = geminiJson.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
  rawText = rawText.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
  const roasts = JSON.parse(rawText);

  console.log(`✅ Generated ${roasts.length} fresh AI articles!`);

  fs.mkdirSync(path.join(process.cwd(), "data"), { recursive: true });
  fs.writeFileSync(
    path.join(process.cwd(), "data", "rhody-data.json"),
    JSON.stringify({
      updatedAt: new Date().toISOString(),
      roasts,
      recentTrades,
      recentWaivers,
      currentStandings: currentSeason.standings,
      history,
      playerNames
    }, null, 2)
  );
  console.log("✅ Saved data/rhody-data.json successfully.");
}

main();
