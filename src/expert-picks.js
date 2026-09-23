// Expert Picks — curated weekly recommendations

const { POSITION_NAMES } = require('./config');

// Budget thresholds per position (in tenths, e.g. 45 = £4.5m)
const BUDGET_THRESHOLDS = { 1: 45, 2: 45, 3: 55, 4: 55 };

function generateExpertPicks(scored, currentGw) {
  const safe = scored.filter(p => p.minutes > 0 && p.scoring.minutesSafe && p.status === 'a');

  // === Captain Pick ===
  // Weighted: quality 50%, fixture 30%, form 20%
  const captainCandidates = safe
    .filter(p => p.scoring.qualityScore >= 50)
    .map(p => ({
      ...p,
      captainScore: p.scoring.qualityScore * 0.5
        + (p.scoring.components.fixture || 0) * 100 * 0.3
        + (p.scoring.components.form || 0) * 100 * 0.2,
    }))
    .sort((a, b) => b.captainScore - a.captainScore);

  const captain = captainCandidates[0] || null;
  const captainAlts = captainCandidates.slice(1, 4);

  // === Transfer-In: top 3 per position ===
  const transfersIn = {};
  for (const pos of [1, 2, 3, 4]) {
    transfersIn[pos] = safe
      .filter(p => p.element_type === pos && p.scoring.qualityScore >= 55)
      .sort((a, b) => b.scoring.qualityScore - a.scoring.qualityScore)
      .slice(0, 3);
  }

  // === Differential Picks: top per position ===
  const differentials = {};
  for (const pos of [1, 2, 3, 4]) {
    differentials[pos] = safe
      .filter(p => p.element_type === pos && p.scoring.label === 'DIFFERENTIAL')
      .sort((a, b) => b.scoring.differentialScore - a.scoring.differentialScore)
      .slice(0, 2);
  }

  // === Budget Picks: affordable + good quality ===
  const budgetPicks = {};
  for (const pos of [1, 2, 3, 4]) {
    const threshold = BUDGET_THRESHOLDS[pos];
    budgetPicks[pos] = safe
      .filter(p => p.element_type === pos && p.now_cost <= threshold && p.scoring.qualityScore >= 35)
      .sort((a, b) => b.scoring.qualityScore - a.scoring.qualityScore)
      .slice(0, 2);
  }

  return { captain, captainAlts, transfersIn, differentials, budgetPicks, gw: currentGw };
}

function summarizePlayer(p, teams) {
  const team = teams?.find(t => t.id === p.team);
  return {
    id: p.id,
    webName: p.web_name,
    elementType: p.element_type,
    positionName: POSITION_NAMES[p.element_type],
    team: team?.name || p.teamData?.name || 'Unknown',
    teamShort: team?.short_name || p.teamData?.short_name || '?',
    price: (p.now_cost / 10).toFixed(1),
    form: p.form,
    totalPoints: p.total_points,
    selectedByPercent: p.selected_by_percent,
    qualityScore: p.scoring.qualityScore,
    differentialScore: p.scoring.differentialScore,
    label: p.scoring.label,
    captainScore: p.captainScore || null,
    components: p.scoring.components,
    nextFixtures: (p.nextFixtures || []).slice(0, 4).map(f => ({
      gw: f.gw, opponent: f.opponent, isHome: f.isHome, fdr: f.fdr,
    })),
  };
}

module.exports = { generateExpertPicks, summarizePlayer };
