// Chip Planner — optimal chip timing across GW1-38

function analyzeGWDifficulty(fixtures, teams) {
  const gwMap = {};

  for (const f of fixtures) {
    const gw = f.event;
    if (gw == null) continue;
    if (!gwMap[gw]) gwMap[gw] = { gw, fixtures: [], easyCount: 0, hardCount: 0, totalFdr: 0, fixtureCount: 0, isDGW: false, teams: {} };

    const entry = gwMap[gw];
    entry.fixtures.push(f);
    entry.fixtureCount++;

    // Track per-team appearances (DGW detection)
    entry.teams[f.team_h] = (entry.teams[f.team_h] || 0) + 1;
    entry.teams[f.team_a] = (entry.teams[f.team_a] || 0) + 1;

    const hFdr = f.team_h_difficulty || 3;
    const aFdr = f.team_a_difficulty || 3;
    entry.totalFdr += hFdr + aFdr;

    if (hFdr <= 2) entry.easyCount++;
    if (aFdr <= 2) entry.easyCount++;
    if (hFdr >= 4) entry.hardCount++;
    if (aFdr >= 4) entry.hardCount++;
  }

  // Post-process
  const gwAnalysis = [];
  for (const gw of Object.values(gwMap)) {
    gw.avgFdr = gw.fixtureCount > 0 ? (gw.totalFdr / (gw.fixtureCount * 2)).toFixed(2) : '3.00';
    // Detect DGW: any team appears 2+ times
    gw.isDGW = Object.values(gw.teams).some(count => count >= 2);
    gw.dgwTeams = Object.entries(gw.teams).filter(([, c]) => c >= 2).map(([id]) => parseInt(id));
    // Detect BGW: fewer than 10 fixtures (20 teams = 10 matches normally)
    gw.isBGW = gw.fixtureCount < 9;
    delete gw.teams;
    delete gw.totalFdr;
    delete gw.fixtureCount;
    gwAnalysis.push(gw);
  }

  gwAnalysis.sort((a, b) => a.gw - b.gw);
  return gwAnalysis;
}

function calculateFixtureSwingScore(gwAnalysis, gw, windowSize = 4) {
  // Compare difficulty of next [windowSize] GWs vs previous [windowSize] GWs
  const idx = gwAnalysis.findIndex(g => g.gw === gw);
  if (idx < windowSize || idx + windowSize > gwAnalysis.length) return 0;

  const before = gwAnalysis.slice(idx - windowSize, idx);
  const after = gwAnalysis.slice(idx, idx + windowSize);

  const avgBefore = before.reduce((s, g) => s + parseFloat(g.avgFdr), 0) / windowSize;
  const avgAfter = after.reduce((s, g) => s + parseFloat(g.avgFdr), 0) / windowSize;

  // Positive = fixtures getting easier, negative = getting harder
  return parseFloat((avgBefore - avgAfter).toFixed(2));
}

function analyzeChipTiming(fixtures, teams, scored, squadPlayerIds) {
  const gwAnalysis = analyzeGWDifficulty(fixtures, teams);
  const teamNames = {};
  for (const t of teams) teamNames[t.id] = t.short_name;

  const chips = {
    benchBoost: null,
    tripleCaptain: null,
    freeHit: null,
    wildcard1: null,
    wildcard2: null,
  };

  // === Bench Boost ===
  // Best GW: most easy fixtures, prefer DGW
  const bbCandidates = [...gwAnalysis]
    .filter(g => !g.isBGW)
    .sort((a, b) => {
      // DGW bonus
      const dgwA = a.isDGW ? 5 : 0;
      const dgwB = b.isDGW ? 5 : 0;
      return (b.easyCount + dgwB) - (a.easyCount + dgwA);
    });

  if (bbCandidates.length > 0) {
    const bb = bbCandidates[0];
    chips.benchBoost = {
      gw: bb.gw,
      reason: bb.isDGW
        ? `DGW with ${bb.easyCount} easy fixtures — all 15 players likely to score`
        : `${bb.easyCount} easy fixtures — maximize bench points`,
      confidence: bb.easyCount >= 10 ? 'HIGH' : bb.easyCount >= 7 ? 'MEDIUM' : 'LOW',
      isDGW: bb.isDGW,
      easyCount: bb.easyCount,
      dgwTeams: bb.dgwTeams?.map(id => teamNames[id] || id) || [],
    };
  }

  // === Triple Captain ===
  // Best GW for a standout captain: easy fixture at home
  // Find GW where the most top players (attackers) have FDR 1-2 at home
  const tcScores = gwAnalysis.map(g => {
    let score = 0;
    for (const f of g.fixtures) {
      if (f.team_h_difficulty <= 2) score += 2; // Easy home fixture = great for captain
      if (f.team_h_difficulty === 1) score += 1; // Extra bonus for FDR 1
    }
    if (g.isDGW) score += 5; // DGW captain = double points
    return { gw: g.gw, score, isDGW: g.isDGW, easyCount: g.easyCount };
  }).sort((a, b) => b.score - a.score);

  if (tcScores.length > 0) {
    const tc = tcScores[0];
    chips.tripleCaptain = {
      gw: tc.gw,
      reason: tc.isDGW
        ? `DGW — captain plays twice with easy fixtures`
        : `Multiple premium options with FDR 1-2 at home`,
      confidence: tc.score >= 15 ? 'HIGH' : tc.score >= 10 ? 'MEDIUM' : 'LOW',
      isDGW: tc.isDGW,
    };
  }

  // === Free Hit ===
  // Best GW: when squad has worst fixtures, or BGW
  const fhCandidates = [...gwAnalysis]
    .sort((a, b) => {
      // BGW gets highest priority
      if (a.isBGW && !b.isBGW) return -1;
      if (!a.isBGW && b.isBGW) return 1;
      // Then by hard fixture count
      return b.hardCount - a.hardCount;
    });

  if (fhCandidates.length > 0) {
    const fh = fhCandidates[0];
    chips.freeHit = {
      gw: fh.gw,
      reason: fh.isBGW
        ? `Blank GW — build a full squad for one week only`
        : `${fh.hardCount} hard fixtures — temporary squad avoids tough matchups`,
      confidence: fh.isBGW ? 'HIGH' : fh.hardCount >= 10 ? 'HIGH' : 'MEDIUM',
      isBGW: fh.isBGW,
      hardCount: fh.hardCount,
    };
  }

  // === Wildcards ===
  // Find biggest fixture swing points in each half of the season
  for (const [label, range] of [['wildcard1', [2, 19]], ['wildcard2', [20, 37]]]) {
    let bestGw = null;
    let bestSwing = -Infinity;

    for (const g of gwAnalysis) {
      if (g.gw < range[0] || g.gw > range[1]) continue;
      const swing = calculateFixtureSwingScore(gwAnalysis, g.gw);
      if (swing > bestSwing) {
        bestSwing = swing;
        bestGw = g.gw;
      }
    }

    if (bestGw) {
      chips[label] = {
        gw: bestGw,
        reason: bestSwing > 0.5
          ? `Major fixture swing — multiple teams go from hard to easy fixtures`
          : `Best fixture transition point in ${label === 'wildcard1' ? 'first' : 'second'} half`,
        confidence: bestSwing > 0.8 ? 'HIGH' : bestSwing > 0.4 ? 'MEDIUM' : 'LOW',
        swingScore: bestSwing,
      };
    }
  }

  // Ensure chips don't overlap — shift until free GW found
  const usedGws = new Set();
  for (const [key, chip] of Object.entries(chips)) {
    if (!chip) continue;
    while (usedGws.has(chip.gw) && chip.gw <= 38) {
      chip.gw++;
    }
    if (chip.gw > 38) chip.gw = 38; // cap at last GW
    usedGws.add(chip.gw);
  }

  // GW difficulty summary for visualization
  const gwSummary = gwAnalysis.map(g => ({
    gw: g.gw,
    avgFdr: parseFloat(g.avgFdr),
    easyCount: g.easyCount,
    hardCount: g.hardCount,
    isDGW: g.isDGW,
    isBGW: g.isBGW,
  }));

  return { chips, gwDifficulty: gwSummary };
}

module.exports = { analyzeChipTiming, analyzeGWDifficulty };
