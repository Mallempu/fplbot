// Price Warnings — predict price rises/falls from transfer activity

const TOTAL_MANAGERS = 11_000_000; // approximate total FPL managers
const MIN_THRESHOLD = 10_000;

function predictPriceChanges(scored) {
  const predictions = [];

  for (const p of scored) {
    if (p.minutes === 0) continue;

    const netTransfers = (p.transfers_in_event || 0) - (p.transfers_out_event || 0);
    if (netTransfers === 0) continue;

    const ownership = parseFloat(p.selected_by_percent) || 0;
    const totalOwners = (ownership / 100) * TOTAL_MANAGERS;
    const threshold = Math.max(totalOwners * 0.025, MIN_THRESHOLD);

    const progress = Math.round(Math.abs(netTransfers) / threshold * 100);
    if (progress < 30) continue; // too low to be relevant

    const direction = netTransfers > 0 ? 'rise' : 'fall';
    let likelihood;
    if (progress >= 90) likelihood = 'VERY_LIKELY';
    else if (progress >= 70) likelihood = 'LIKELY';
    else if (progress >= 50) likelihood = 'POSSIBLE';
    else likelihood = 'UNLIKELY';

    predictions.push({
      id: p.id,
      webName: p.web_name,
      elementType: p.element_type,
      team: p.teamData?.name || 'Unknown',
      teamShort: p.teamData?.short_name || '?',
      nowCost: p.now_cost,
      price: (p.now_cost / 10).toFixed(1),
      direction,
      likelihood,
      progress: Math.min(progress, 100),
      netTransfers,
      transfersIn: p.transfers_in_event || 0,
      transfersOut: p.transfers_out_event || 0,
      selectedByPercent: p.selected_by_percent,
      status: p.status,
      form: p.form,
      qualityScore: p.scoring?.qualityScore || 0,
    });
  }

  // Sort by progress descending
  predictions.sort((a, b) => b.progress - a.progress);

  const risers = predictions.filter(p => p.direction === 'rise').slice(0, 15);
  const fallers = predictions.filter(p => p.direction === 'fall').slice(0, 15);

  return { risers, fallers };
}

function flagSquadPlayers(predictions, squadPlayerIds, watchlistPlayerIds) {
  const squadIds = new Set(squadPlayerIds || []);
  const watchIds = new Set(watchlistPlayerIds || []);

  for (const p of [...predictions.risers, ...predictions.fallers]) {
    p.inSquad = squadIds.has(p.id);
    p.inWatchlist = watchIds.has(p.id);
  }

  return predictions;
}

module.exports = { predictPriceChanges, flagSquadPlayers };
