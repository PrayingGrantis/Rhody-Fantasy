import fs from "fs";
import path from "path";

const LEAGUE_ID = "1389738151307649024";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed ${url}: ${res.status}`);
  return res.json();
}

async function main() {
  console.log("🐏 Starting 12-Hour Rhody Complete History & Roast Sync for " + LEAGUE_ID);

  // 1. Download Master NFL Player Dictionary so every ID becomes a real name
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
    for (let wk = 1; wk <= 18; wk++) {
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
            timestamp: tx.status_updated
          };
          if (tx.type === "trade") trades.push(summary);
          else if (tx.type === "waiver" || tx.type === "free_agent") waivers.push(summary);
        }
      } catch (_) {}
    }

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
          fpts,
          fptsAgainst: (r.settings?.fpts_against || 0) + ((r.settings?.fpts_against_decimal || 0) / 100),
          benchPointsLeftBehind: Math.max(0, maxFpts - fpts),
          faabUsed: r.settings?.waiver_budget_used || 0
        };
      }),
      trades,
      waivers: waivers.slice(0, 40)
    });

    currId = league.previous_league_id;
  }

  // 3. Generate Fresh Roasts via Gemini AI (if API key is present)
  let roasts = [];
  if (GEMINI_API_KEY) {
    const prompt = `
You are the savage, hilarious host of the "Rhody Gridiron Desk" (URI / Kingston themed fantasy football broadcast) covering Sleeper League "Rhody" (ID: 1389738151307649024).

MANDATORY LORE:
1. JewsinParis traded away Drake London for Jordan Mason.
2. Caaaam blew 50 FAAB in Week 1 on a defense and constantly vetos trades.
3. ELord11 makes a ridiculous volume of trades.
4. PrayingGrantis somehow ends up with a stacked Superteam.
5. Tylero0 attempts terrible fleece offers constantly.
6. CerealStroke has no idea what FAAB is and never waivers.
7. CarlaCote is in witness protection and accidentally wins.

Scan the latest trades, waiver moves, and standings in the JSON data below. Write 2 hilarious news articles/roasts highlighting recent trades, bad lineup decisions, or waiver blunders.

Live & Historical League Data:
${JSON.stringify(history, null, 2)}

Return ONLY valid JSON as an array of 2 objects with keys:
"category" (string), "headline" (string), "timestamp" (string), "body" (2-3 paragraphs).
`;

    try {
      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json" }
          })
        }
      );

      const geminiJson = await geminiRes.json();
      const rawText = geminiJson.candidates?.[0]?.content?.parts?.[0]?.text;
      if (rawText) roasts = JSON.parse(rawText);
    } catch (e) {
      console.log("Gemini API call skipped or failed, falling back to rotation engine:", e.message);
    }
  }

  fs.mkdirSync(path.join(process.cwd(), "data"), { recursive: true });
  fs.writeFileSync(
    path.join(process.cwd(), "data", "rhody-data.json"),
    JSON.stringify({ updatedAt: new Date().toISOString(), roasts, playerNames }, null, 2)
  );
  console.log("✅ Saved data/rhody-data.json successfully.");
}

main();
