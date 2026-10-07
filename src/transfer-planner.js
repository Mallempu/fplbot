// Transfer Planner — multi-GW transfer planning with fixture swing detection

const { POSITION_NAMES } = require('./config');

function calculateTeamFDR(fixtures, teamId, fromGW, windowSize = 4) {
  const teamFixtures = fixtures
    .filter(f => f.event >= fromGW && f.event < fromGW + windowSize && (f.team_h === teamId || f.team_a === teamId));

  if (teamFixtures.length === 0) return { avg: 3, fixtures: [] };

  let totalFdr = 0;
  const details = [];
  for (const f of teamFixtures) {
    const isHome = f.team_h === teamId;
    const fdr = isHome ? f.team_h_difficulty : f.team_a_difficulty;
    const opponent = isHome ? f.team_a : f.team_h;
    totalFdr += fdr || 3;
    details.push({ gw: f.event, opponent, isHome, fdr: fdr || 3 });
  }

  return { avg: totalFdr / teamFixtures.length, fixtures: details };
}

function detectFixtureSwings(fixtures, teams, fromGW, toGW) {
  const swings = [];

  for (const team of teams) {
    const windows = [];
    for (let gw = fromGW; gw <= toGW - 3; gw++) {
      const fdr = calculateTeamFDR(fixtures, team.id, gw);
      windows.push({ gw, avgFdr: fdr.avg });
    }

    // Find swing points: where avg FDR drops significantly (hard → easy)
    for (let i = 1; i < windows.length; i++) {
      const prev = windows[i - 1];
      const curr = windows[i];
      const diff = prev.avgFdr - curr.avgFdr;

      if (Math.abs(diff) >= 0.8) {
        swings.push({
          teamId: team.id,
          teamName: team.name,
          teamShort: team.short_name,
          gw: curr.gw,
          direction: diff > 0 ? 'improving' : 'worsening',
          fdrBefore: prev.avgFdr.toFixed(1),
          fdrAfter: curr.avgFdr.toFixed(1),
          magnitude: Math.abs(diff).toFixed(1),
        });
      }
    }
  }

  // Sort by magnitude descending
  swings.sort((a, b) => parseFloat(b.magnitude) - parseFloat(a.magnitude));
  return swings;
}

function buildTransferPlan(squadPicks, scored, fixtures, teams, fromGW, toGW, bank = 0) {
  const teamMap = {};
  for (const t of teams) teamMap[t.id] = t;

  // Get squad players with scores
  const squadPlayers = squadPicks.map(pk => {
    const p = scored.find(sp => sp.id === pk.element);
    if (!p) return null;
    return { ...p, pickPosition: pk.position };
  }).filter(Boolean);

  const startingXI = squadPlayers.filter(p => p.pickPosition <= 11);

  // Detect fixture swings across the planning window
  const swings = detectFixtureSwings(fixtures, teams, fromGW, toGW);

  // Build per-GW plan
  const plan = [];
  let freeTransfers = 1; // assume 1 FT, capped at 5 (new FPL rules)
  let currentBank = bank;
  const currentSquadIds = new Set(squadPicks.map(pk => pk.element));

  for (let gw = fromGW; gw <= toGW; gw++) {
    // Evaluate each starting player's fixture for this GW window
    const playerOutlook = startingXI.map(p => {
      const fdr = calculateTeamFDR(fixtures, p.team, gw);
      return {
        id: p.id,
        webName: p.web_name,
        elementType: p.element_type,
        team: teamMap[p.team]?.short_name || '?',
        qualityScore: p.scoring.qualityScore,
        avgFdr: fdr.avg,
        status: p.status,
        minutesSafe: p.scoring.minutesSafe,
      };
    });

    // Find weakest player (worst combination of quality + fixture)
    const weakest = [...playerOutlook]
      .sort((a, b) => {
        const aScore = a.qualityScore * 0.6 + (5 - a.avgFdr) / 5 * 100 * 0.4;
        const bScore = b.qualityScore * 0.6 + (5 - b.avgFdr) / 5 * 100 * 0.4;
        return aScore - bScore;
      });

    const target = weakest[0];

    // Find best replacement
    let suggestedIn = null;
    if (target) {
      const budget = (scored.find(p => p.id === target.id)?.now_cost || 0) + currentBank;
      const candidates = scored
        .filter(p =>
          p.element_type === target.elementType
          && !currentSquadIds.has(p.id)
          && p.now_cost <= budget
          && p.minutes > 0
          && p.scoring.minutesSafe
        );

      const candidateFdr = candidates.map(p => {
        const fdr = calculateTeamFDR(fixtures, p.team, gw);
        const combinedScore = p.scoring.qualityScore * 0.6 + (5 - fdr.avg) / 5 * 100 * 0.4;
        return { ...p, avgFdr: fdr.avg, combinedScore };
      });

      candidateFdr.sort((a, b) => b.combinedScore - a.combinedScore);
      const best = candidateFdr[0];

      if (best) {
        const improvement = best.combinedScore - (target.qualityScore * 0.6 + (5 - target.avgFdr) / 5 * 100 * 0.4);
        if (improvement > 5) {
          suggestedIn = {
            id: best.id,
            webName: best.web_name,
            elementType: best.element_type,
            team: teamMap[best.team]?.short_name || '?',
            qualityScore: best.scoring.qualityScore,
            price: (best.now_cost / 10).toFixed(1),
            avgFdr: best.avgFdr,
            improvement: Math.round(improvement),
          };
        }
      }
    }

    // Relevant swings for this GW
    const gwSwings = swings.filter(s => s.gw === gw).slice(0, 3);

    const action = suggestedIn && freeTransfers > 0 ? 'transfer' : 'hold';

    plan.push({
      gw,
      action,
      freeTransfers,
      suggestedOut: action === 'transfer' && target ? {
        id: target.id,
        webName: target.webName,
        team: target.team,
        qualityScore: target.qualityScore,
        avgFdr: target.avgFdr,
      } : null,
      suggestedIn: action === 'transfer' ? suggestedIn : null,
      reason: action === 'transfer' && target
        ? `${target.webName} has tough fixtures (avg FDR ${target.avgFdr.toFixed(1)})`
        : freeTransfers < 2 ? 'Bank free transfer for flexibility' : 'No clear upgrade available',
      swings: gwSwings,
      // Overall GW difficulty for squad
      avgSquadFdr: playerOutlook.length > 0
        ? (playerOutlook.reduce((s, p) => s + p.avgFdr, 0) / playerOutlook.length).toFixed(1)
        : '3.0',
    });

    // Update state: each GW gains 1 FT, using a transfer costs 1
    if (action === 'transfer') {
      // Used 1 FT this GW, then gain 1 for next GW = net zero change
      freeTransfers = Math.min(freeTransfers - 1 + 1, 5);
    } else {
      // Banked: gain 1 FT for next GW
      freeTransfers = Math.min(freeTransfers + 1, 5);
    }
  }

  return { plan, swings: swings.slice(0, 10) };
}

module.exports = { buildTransferPlan, detectFixtureSwings, calculateTeamFDR };
