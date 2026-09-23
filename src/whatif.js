// What-If Simulator — simulate transfers and compare impact

const { POSITION_NAMES } = require('./config');

function simulateTransfers(squadPicks, scored, transfers, bank = 0) {
  const errors = [];

  // Build current squad
  const currentSquad = squadPicks.map(pk => {
    const player = scored.find(p => p.id === pk.element);
    return {
      pickElement: pk.element,
      pickPosition: pk.position,
      isCaptain: pk.is_captain,
      isViceCaptain: pk.is_vice_captain,
      player,
    };
  });

  // Validate and apply transfers
  const appliedTransfers = [];
  const newSquad = [...currentSquad];
  let newBank = bank;
  const teamCount = {};

  // Count current team distribution
  for (const sq of currentSquad) {
    if (sq.player) {
      teamCount[sq.player.team] = (teamCount[sq.player.team] || 0) + 1;
    }
  }

  for (const { outId, inId } of transfers) {
    const outIdx = newSquad.findIndex(sq => sq.pickElement === outId);
    if (outIdx === -1) {
      errors.push(`Player ID ${outId} not in squad`);
      continue;
    }

    const outPlayer = newSquad[outIdx].player;
    const inPlayer = scored.find(p => p.id === inId);

    if (!inPlayer) {
      errors.push(`Player ID ${inId} not found`);
      continue;
    }

    if (!outPlayer) {
      errors.push(`Cannot find data for outgoing player ${outId}`);
      continue;
    }

    // Position check
    if (outPlayer.element_type !== inPlayer.element_type) {
      errors.push(`Position mismatch: ${outPlayer.web_name} (${POSITION_NAMES[outPlayer.element_type]}) vs ${inPlayer.web_name} (${POSITION_NAMES[inPlayer.element_type]})`);
      continue;
    }

    // Already in squad check
    if (newSquad.some(sq => sq.pickElement === inId)) {
      errors.push(`${inPlayer.web_name} is already in your squad`);
      continue;
    }

    // Budget check
    const costDiff = inPlayer.now_cost - outPlayer.now_cost;
    if (costDiff > newBank) {
      errors.push(`Cannot afford ${inPlayer.web_name}: need £${((costDiff - newBank) / 10).toFixed(1)}m more`);
      continue;
    }

    // Team limit check (max 3 per team)
    const newTeamCount = { ...teamCount };
    newTeamCount[outPlayer.team] = (newTeamCount[outPlayer.team] || 1) - 1;
    newTeamCount[inPlayer.team] = (newTeamCount[inPlayer.team] || 0) + 1;
    if (newTeamCount[inPlayer.team] > 3) {
      errors.push(`Team limit: already have 3 players from ${inPlayer.teamData?.name || 'that team'}`);
      continue;
    }

    // Apply transfer
    newSquad[outIdx] = {
      ...newSquad[outIdx],
      pickElement: inId,
      player: inPlayer,
    };
    newBank -= costDiff;
    teamCount[outPlayer.team]--;
    teamCount[inPlayer.team] = (teamCount[inPlayer.team] || 0) + 1;

    appliedTransfers.push({
      out: summarize(outPlayer),
      in: summarize(inPlayer),
      costDiff: -costDiff, // positive = saving money
      qualityDiff: Math.round((inPlayer.scoring?.qualityScore || 0) - (outPlayer.scoring?.qualityScore || 0)),
      fixtureDiff: parseFloat(((inPlayer.scoring?.components?.fixture || 0) - (outPlayer.scoring?.components?.fixture || 0)).toFixed(2)),
    });
  }

  if (errors.length > 0 && appliedTransfers.length === 0) {
    return { valid: false, errors };
  }

  // Calculate before/after metrics
  const beforeXI = currentSquad.filter(sq => sq.pickPosition <= 11 && sq.player);
  const afterXI = newSquad.filter(sq => sq.pickPosition <= 11 && sq.player);

  const before = {
    avgQuality: calcAvg(beforeXI.map(sq => sq.player.scoring?.qualityScore || 0)),
    avgFixture: calcAvg(beforeXI.map(sq => (sq.player.scoring?.components?.fixture || 0) * 100)),
    totalValue: beforeXI.reduce((s, sq) => s + sq.player.now_cost, 0),
    bank,
  };

  const after = {
    avgQuality: calcAvg(afterXI.map(sq => sq.player.scoring?.qualityScore || 0)),
    avgFixture: calcAvg(afterXI.map(sq => (sq.player.scoring?.components?.fixture || 0) * 100)),
    totalValue: afterXI.reduce((s, sq) => s + sq.player.now_cost, 0),
    bank: newBank,
  };

  const impact = {
    qualityDiff: Math.round(after.avgQuality - before.avgQuality),
    fixtureDiff: Math.round(after.avgFixture - before.avgFixture),
    valueDiff: after.totalValue - before.totalValue,
    bankDiff: newBank - bank,
  };

  return {
    valid: true,
    transfers: appliedTransfers,
    before,
    after,
    impact,
    errors: errors.length > 0 ? errors : null,
  };
}

function summarize(p) {
  return {
    id: p.id,
    webName: p.web_name,
    elementType: p.element_type,
    positionName: POSITION_NAMES[p.element_type],
    team: p.teamData?.name || 'Unknown',
    teamShort: p.teamData?.short_name || '?',
    price: (p.now_cost / 10).toFixed(1),
    qualityScore: p.scoring.qualityScore,
    form: p.form,
    fixtureScore: Math.round((p.scoring.components.fixture || 0) * 100),
    selectedByPercent: p.selected_by_percent,
    nextFixtures: (p.nextFixtures || []).slice(0, 4).map(f => ({
      gw: f.gw, opponent: f.opponent, isHome: f.isHome, fdr: f.fdr,
    })),
  };
}

function calcAvg(arr) {
  return arr.length > 0 ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
}

module.exports = { simulateTransfers };
