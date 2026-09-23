// Predicted Lineups — predict starting XI per team using FPL data

const { POSITION_NAMES } = require('./config');

const FORMATIONS = [
  [4, 3, 3],
  [4, 4, 2],
  [3, 5, 2],
  [3, 4, 3],
  [5, 3, 2],
  [5, 4, 1],
  [4, 2, 3, 1], // treated as 4-5-1 in FPL terms (AM counted as MID)
  [4, 5, 1],
];

// Normalized formations for FPL positions (DEF, MID, FWD)
const FPL_FORMATIONS = [
  [3, 4, 3], [3, 5, 2],
  [4, 3, 3], [4, 4, 2], [4, 5, 1],
  [5, 3, 2], [5, 4, 1],
];

function calculateStartProbability(player, teamGames) {
  if (!teamGames || teamGames === 0) return 0;

  const startsRatio = (player.starts || 0) / teamGames;
  const minsPer90 = Math.min((player.minutes || 0) / (teamGames * 90), 1);

  const chanceRaw = player.chance_of_playing_next_round;
  const chanceOfPlaying = chanceRaw != null ? chanceRaw / 100 : (player.status === 'a' ? 1 : 0);

  let statusScore = 0;
  if (player.status === 'a') statusScore = 1;
  else if (player.status === 'd') statusScore = 0.3;
  // i, u, s, n = 0

  const probability = startsRatio * 0.40
    + minsPer90 * 0.25
    + chanceOfPlaying * 0.20
    + statusScore * 0.15;

  return Math.round(probability * 100);
}

function predictLineup(teamPlayers, teamGames, teamName) {
  // Calculate start probability for each player
  const players = teamPlayers.map(p => ({
    id: p.id,
    webName: p.web_name,
    elementType: p.element_type,
    positionName: POSITION_NAMES[p.element_type],
    price: (p.now_cost / 10).toFixed(1),
    form: p.form,
    status: p.status,
    minutes: p.minutes,
    starts: p.starts || 0,
    qualityScore: p.scoring?.qualityScore || 0,
    startProbability: calculateStartProbability(p, teamGames),
    chanceOfPlaying: p.chance_of_playing_next_round,
  }));

  // Group by position and sort by probability
  const byPos = { 1: [], 2: [], 3: [], 4: [] };
  for (const p of players) {
    if (byPos[p.elementType]) byPos[p.elementType].push(p);
  }
  for (const pos of [1, 2, 3, 4]) {
    byPos[pos].sort((a, b) => b.startProbability - a.startProbability);
  }

  // Find best formation
  let bestFormation = null;
  let bestScore = -1;
  let bestXI = null;

  if (byPos[1].length < 1) return null; // No GKs available

  for (const [nDef, nMid, nFwd] of FPL_FORMATIONS) {
    if (byPos[2].length < nDef || byPos[3].length < nMid || byPos[4].length < nFwd) continue;

    const gk = [byPos[1][0]];
    const defs = byPos[2].slice(0, nDef);
    const mids = byPos[3].slice(0, nMid);
    const fwds = byPos[4].slice(0, nFwd);
    const xi = [...gk, ...defs, ...mids, ...fwds];

    const totalScore = xi.reduce((sum, p) => sum + p.startProbability, 0);
    if (totalScore > bestScore) {
      bestScore = totalScore;
      bestFormation = `${nDef}-${nMid}-${nFwd}`;
      bestXI = xi;
    }
  }

  if (!bestXI) return null;

  // Determine bench (remaining players sorted by probability)
  const xiIds = new Set(bestXI.map(p => p.id));
  const bench = players
    .filter(p => !xiIds.has(p.id) && p.startProbability > 0)
    .sort((a, b) => b.startProbability - a.startProbability)
    .slice(0, 7);

  return {
    teamName,
    formation: bestFormation,
    avgProbability: Math.round(bestScore / 11),
    startingXI: bestXI,
    bench,
  };
}

function predictAllLineups(scored, teams) {
  const lineups = [];

  for (const team of teams) {
    const teamPlayers = scored.filter(p => p.team === team.id);
    if (teamPlayers.length < 11) continue;

    // Estimate team games from max starts among squad regulars
    const maxStarts = Math.max(...teamPlayers.map(p => p.starts || 0), 1);
    const teamGames = maxStarts;

    const lineup = predictLineup(teamPlayers, teamGames, team.name);
    if (lineup) {
      lineup.teamId = team.id;
      lineup.teamShort = team.short_name;
      lineups.push(lineup);
    }
  }

  lineups.sort((a, b) => a.teamName.localeCompare(b.teamName));
  return lineups;
}

module.exports = { predictLineup, predictAllLineups, calculateStartProbability };
