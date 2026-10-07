const {
  getPositionWeights, DIFFERENTIAL, FIXTURE_WEIGHTS,
  SHRINKAGE_MINUTES, MINUTES_SECURITY_GATE,
} = require('./config');
const { makePlayerKey, buildTrendMap, hasHistoricalData } = require('./historical');

// --- Utilitas normalisasi ---

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function percentileRank(value, sortedArr) {
  if (sortedArr.length <= 1) return 0.5;
  let count = 0;
  for (const v of sortedArr) {
    if (v < value) count++;
  }
  return count / (sortedArr.length - 1);
}

function minMax(x, lo, hi, invert = false) {
  if (hi === lo) return 0.5;
  const n = clamp((x - lo) / (hi - lo), 0, 1);
  return invert ? 1 - n : n;
}

function per90(stat, minutes) {
  return minutes > 0 ? (stat / minutes) * 90 : 0;
}

function shrink(playerValue, minutes, positionMean) {
  const w = Math.min(minutes / SHRINKAGE_MINUTES, 1);
  return w * playerValue + (1 - w) * positionMean;
}

// --- Fixture score ---

function fixtureScore(nextFixtures) {
  let score = 0;
  const slots = nextFixtures.slice(0, FIXTURE_WEIGHTS.length);
  slots.forEach((f, i) => {
    let ease = (6 - f.fdr) / 5;
    ease *= f.isHome ? 1.05 : 0.95;
    score += clamp(ease, 0, 1) * (FIXTURE_WEIGHTS[i] || 0);
  });
  return clamp(score, 0, 1);
}

// --- Minutes security ---

function minutesSecurity(p) {
  const pMain = (p.chance_of_playing_next_round ?? 100) / 100;
  const rasioStart = p.teamGames > 0 ? (p.starts || 0) / p.teamGames : 0;
  const tersedia = p.status === 'a' ? 1 : p.status === 'd' ? 0.5 : 0;
  return 0.5 * pMain + 0.3 * clamp(rasioStart, 0, 1) + 0.2 * tersedia;
}

// --- Build statistik populasi per posisi ---

function buildPositionStats(players, trendMap) {
  const groups = { 1: [], 2: [], 3: [], 4: [] };
  for (const p of players) {
    if (groups[p.element_type]) groups[p.element_type].push(p);
  }

  const stats = {};
  for (const [pos, group] of Object.entries(groups)) {
    const withMinutes = group.filter(p => p.minutes > 0);

    const xgi90Raw = withMinutes.map(p =>
      per90(parseFloat(p.expected_goal_involvements) || 0, p.minutes)
    );
    const xgi90Mean = xgi90Raw.length > 0
      ? xgi90Raw.reduce((a, b) => a + b, 0) / xgi90Raw.length : 0;

    const xgi90Shrunk = withMinutes.map(p =>
      shrink(per90(parseFloat(p.expected_goal_involvements) || 0, p.minutes), p.minutes, xgi90Mean)
    );

    const formValues = group.map(p => parseFloat(p.form) || 0);
    const valueValues = group
      .filter(p => p.now_cost > 0)
      .map(p => (parseFloat(p.form) || 0) / (p.now_cost / 10));

    const xgcNeg = withMinutes.map(p =>
      -per90(parseFloat(p.expected_goals_conceded) || 0, p.minutes)
    );

    // Trend scores for this position group
    const trendScores = group
      .map(p => {
        const key = makePlayerKey(p.first_name, p.second_name);
        return trendMap[key]?.trendScore ?? null;
      })
      .filter(v => v !== null)
      .sort((a, b) => a - b);

    stats[pos] = {
      xgi90Mean,
      xgi90Sorted: [...xgi90Shrunk].sort((a, b) => a - b),
      formLo: formValues.length > 0 ? Math.min(...formValues) : 0,
      formHi: formValues.length > 0 ? Math.max(...formValues) : 1,
      valueSorted: [...valueValues].sort((a, b) => a - b),
      xgcNegSorted: [...xgcNeg].sort((a, b) => a - b),
      trendSorted: trendScores,
    };
  }
  return stats;
}

// --- Skor komposit per pemain ---

function scorePlayer(p, posStats, trendMap) {
  const w = getPositionWeights()[p.element_type];
  if (!w) return { qualityScore: 0, differentialScore: 0, components: {}, label: 'UNKNOWN' };

  const pop = posStats[p.element_type];

  // Komponen
  const xgi90Raw = per90(parseFloat(p.expected_goal_involvements) || 0, p.minutes);
  const xgi90 = shrink(xgi90Raw, p.minutes, pop.xgi90Mean);
  const form = parseFloat(p.form) || 0;
  const value = p.now_cost > 0 ? form / (p.now_cost / 10) : 0;
  const fixture = fixtureScore(p.nextFixtures || []);
  const minSec = minutesSecurity(p);

  // Trend dari data historis
  const playerKey = makePlayerKey(p.first_name, p.second_name);
  const trendData = trendMap[playerKey] || null;
  let trendNorm = 0.5; // default: neutral jika tidak ada data historis
  if (trendData && pop.trendSorted.length > 1) {
    trendNorm = percentileRank(trendData.trendScore, pop.trendSorted);
  }

  // Normalisasi
  const n = {
    xgi: percentileRank(xgi90, pop.xgi90Sorted),
    form: minMax(form, pop.formLo, pop.formHi),
    fixture,
    minutes: minSec,
    value: percentileRank(value, pop.valueSorted),
    def: w.def > 0
      ? percentileRank(
          -per90(parseFloat(p.expected_goals_conceded) || 0, p.minutes),
          pop.xgcNegSorted
        )
      : 0,
    trend: trendNorm,
  };

  // Quality score
  const qualityScore =
    w.xgi * n.xgi + w.form * n.form + w.fixture * n.fixture +
    w.minutes * n.minutes + w.value * n.value + w.def * n.def +
    (w.trend || 0) * n.trend;

  // Differential score
  const ownership = parseFloat(p.selected_by_percent) || 0;
  const eoFactor = 1 - minMax(ownership, 0, 100);
  const differentialScore = qualityScore * (DIFFERENTIAL.blendBase + DIFFERENTIAL.blendBonus * eoFactor);

  // Label
  let label = 'REGULAR';
  if (ownership < DIFFERENTIAL.ownershipThreshold && qualityScore >= DIFFERENTIAL.qualityPercentile) {
    label = 'DIFFERENTIAL';
  } else if (ownership > 40) {
    label = 'TEMPLATE';
  }

  // Regression signal (multi-season enhanced)
  const goalsScored = p.goals_scored || 0;
  const xG = parseFloat(p.expected_goals) || 0;
  const regressionDiff = goalsScored - xG;
  let regression = null;

  if (trendData) {
    // Pakai data historis: jika overperform multi-musim, ini skill bukan luck
    const historicalOP = trendData.overperformance.goals;
    if (regressionDiff > 2 && historicalOP > 3) {
      // Konsisten overperform across seasons = skill, bukan regresi
      regression = 'CLINICAL_FINISHER';
    } else if (regressionDiff > 2 && historicalOP <= 1) {
      regression = 'OVERPERFORMING';
    } else if (regressionDiff < -2 && historicalOP < -3) {
      regression = 'POOR_FINISHER';
    } else if (regressionDiff < -2) {
      regression = 'UNDERPERFORMING';
    }
  } else {
    if (regressionDiff > 2) regression = 'OVERPERFORMING';
    else if (regressionDiff < -2) regression = 'UNDERPERFORMING';
  }

  return {
    qualityScore: Math.round(qualityScore * 100),
    differentialScore: Math.round(differentialScore * 100),
    components: n,
    label,
    regression,
    regressionDiff: Math.round(regressionDiff * 10) / 10,
    minutesSafe: minSec >= MINUTES_SECURITY_GATE,
    trendData: trendData ? {
      trendScore: trendData.trendScore,
      trendLabel: trendData.trendLabel,
      consistency: trendData.consistency,
      seasonsCount: trendData.seasonsCount,
      changedTeam: trendData.changedTeam,
      predictedPP90: trendData.predictedPP90,
      overperformance: trendData.overperformance,
    } : null,
  };
}

// Score semua pemain
function scoreAllPlayers(players) {
  // Build trend map dari data historis (jika ada)
  let trendMap = {};
  try {
    if (hasHistoricalData()) {
      trendMap = buildTrendMap();
    }
  } catch (err) {
    console.error('Warning: historical trend data unavailable:', err.message);
  }

  const posStats = buildPositionStats(players, trendMap);
  return players.map(p => ({
    ...p,
    scoring: scorePlayer(p, posStats, trendMap),
  }));
}

module.exports = { scoreAllPlayers, scorePlayer, buildPositionStats, fixtureScore, minutesSecurity, per90 };
