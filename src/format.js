const { POSITION_NAMES, POSITION_EMOJI, getActiveMetrics, getPositionWeights, METRIC_LABELS } = require('./config');

function escapeHtml(text) {
  if (!text) return '';
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function posLabel(elementType) {
  return `${POSITION_EMOJI[elementType] || ''} ${POSITION_NAMES[elementType] || '?'}`;
}

function priceStr(nowCost) {
  return `£${(nowCost / 10).toFixed(1)}m`;
}

function colorIcon(value, thresholds = [70, 40]) {
  if (value >= thresholds[0]) return '🟢';
  if (value >= thresholds[1]) return '🟡';
  return '🔴';
}

function bar(value, max = 1, len = 10) {
  const filled = Math.min(Math.max(Math.round((value / max) * len), 0), len);
  return '█'.repeat(filled) + '░'.repeat(len - filled);
}

function playerCard(p) {
  const s = p.scoring;
  const fix = (p.nextFixtures || []).slice(0, 4).map(f =>
    `${f.isHome ? '(H)' : '(A)'} ${p.teamData ? '' : ''}GW${f.gw} FDR${f.fdr}`
  ).join(', ');

  const lines = [
    `<b>${escapeHtml(p.web_name)}</b> — ${posLabel(p.element_type)}`,
    `${p.teamData?.name || 'Unknown'} | ${priceStr(p.now_cost)} | EO: ${p.selected_by_percent}%`,
    ``,
    `📊 <b>Quality Score: ${s.qualityScore}/100</b>`,
    `🎯 <b>Differential Score: ${s.differentialScore}/100</b>`,
    `🏷 Label: <b>${s.label}</b>`,
    ``,
    `<b>Komponen:</b>`,
    `  xGI/90  ${bar(s.components.xgi)} ${(s.components.xgi * 100).toFixed(0)}%`,
    `  Form    ${bar(s.components.form)} ${(s.components.form * 100).toFixed(0)}%`,
    `  Fixture ${bar(s.components.fixture)} ${(s.components.fixture * 100).toFixed(0)}%`,
    `  Minutes ${bar(s.components.minutes)} ${(s.components.minutes * 100).toFixed(0)}%`,
    `  Value   ${bar(s.components.value)} ${(s.components.value * 100).toFixed(0)}%`,
  ];

  if (s.components.def > 0) {
    lines.push(`  Defense ${bar(s.components.def)} ${(s.components.def * 100).toFixed(0)}%`);
  }

  lines.push('');
  lines.push(`📈 Form: ${p.form} | PPG: ${p.points_per_game} | Pts: ${p.total_points}`);
  lines.push(`⏱ Menit: ${p.minutes} | Start: ${p.starts || 0}`);

  if (s.regression) {
    const emoji = s.regression === 'OVERPERFORMING' ? '⚠️' : '💎';
    lines.push(`${emoji} ${s.regression} (Goals - xG: ${s.regressionDiff > 0 ? '+' : ''}${s.regressionDiff})`);
  }

  if (!s.minutesSafe) {
    lines.push(`🚨 <b>RISIKO ROTASI/CEDERA</b> — keamanan menit rendah`);
  }

  if (p.minutes < 270) {
    lines.push(`⚠️ <i>Sample size kecil (${p.minutes} menit) — data belum stabil</i>`);
  }

  if (fix) {
    lines.push(`\n📅 Fixture: ${fix}`);
  }

  return lines.join('\n');
}

function compareCard(a, b) {
  const sa = a.scoring, sb = b.scoring;
  const better = (va, vb) => va > vb ? '✅' : va < vb ? '❌' : '➖';

  return [
    `<b>${escapeHtml(a.web_name)}</b> vs <b>${escapeHtml(b.web_name)}</b>`,
    `${posLabel(a.element_type)} | ${posLabel(b.element_type)}`,
    ``,
    `<pre>`,
    `Metrik         ${a.web_name.padEnd(12)} ${b.web_name.padEnd(12)}`,
    `─────────────────────────────────────`,
    `Quality     ${better(sa.qualityScore, sb.qualityScore)} ${String(sa.qualityScore).padEnd(12)} ${better(sb.qualityScore, sa.qualityScore)} ${sb.qualityScore}`,
    `Diff Score  ${better(sa.differentialScore, sb.differentialScore)} ${String(sa.differentialScore).padEnd(12)} ${better(sb.differentialScore, sa.differentialScore)} ${sb.differentialScore}`,
    `Form           ${String(a.form).padEnd(12)} ${b.form}`,
    `Price          ${priceStr(a.now_cost).padEnd(12)} ${priceStr(b.now_cost)}`,
    `EO             ${(a.selected_by_percent + '%').padEnd(12)} ${b.selected_by_percent}%`,
    `xGI/90         ${(sa.components.xgi * 100).toFixed(0).padEnd(12)} ${(sb.components.xgi * 100).toFixed(0)}`,
    `Minutes        ${String(a.minutes).padEnd(12)} ${b.minutes}`,
    `</pre>`,
    ``,
    `🏷 ${escapeHtml(a.web_name)}: ${sa.label} | ${escapeHtml(b.web_name)}: ${sb.label}`,
  ].join('\n');
}

function rankingList(players, title, limit = 10) {
  const lines = [`<b>${title}</b>\n`];
  players.slice(0, limit).forEach((p, i) => {
    const s = p.scoring;
    const medal = i < 3 ? ['🥇', '🥈', '🥉'][i] : `${i + 1}.`;
    lines.push(
      `${medal} <b>${escapeHtml(p.web_name)}</b> (${p.teamData?.short_name || '?'}) — ` +
      `Q:${s.qualityScore} D:${s.differentialScore} | ` +
      `${priceStr(p.now_cost)} | EO:${p.selected_by_percent}% | ${s.label}`
    );
  });
  return lines.join('\n');
}

function fixtureTable(teamName, fixtures, teams) {
  const lines = [`<b>📅 Fixture ${teamName}</b>\n`];
  fixtures.slice(0, 8).forEach(f => {
    const opp = teams[f.opponent];
    const oppName = opp?.short_name || `Team${f.opponent}`;
    const fdrEmojis = ['🟢', '🟡', '🟠', '🔴', '🔴'];
    const fdrEmoji = fdrEmojis[f.fdr - 1] || '⚪';
    lines.push(
      `GW${f.gw}: ${f.isHome ? '🏠' : '✈️'} ${oppName} (FDR ${f.fdr} ${fdrEmoji})`
    );
  });
  return lines.join('\n');
}

function priceChangeNotif(changes) {
  if (changes.length === 0) return null;
  const lines = ['<b>💰 Perubahan Harga</b>\n'];
  for (const c of changes) {
    const arrow = c.diff > 0 ? '📈' : '📉';
    lines.push(`${arrow} <b>${escapeHtml(c.name)}</b>: ${priceStr(c.oldPrice)} → ${priceStr(c.newPrice)} (${c.diff > 0 ? '+' : ''}${priceStr(c.diff)})`);
  }
  return lines.join('\n');
}

function statusChangeNotif(changes) {
  if (changes.length === 0) return null;
  const statusEmoji = { a: '✅', d: '⚠️', i: '🏥', s: '❌', u: '❓' };
  const statusLabel = { a: 'Available', d: 'Doubtful', i: 'Injured', s: 'Suspended', u: 'Unknown' };
  const lines = ['<b>🏥 Perubahan Status Pemain</b>\n'];
  for (const c of changes) {
    lines.push(
      `${statusEmoji[c.newStatus] || '❓'} <b>${escapeHtml(c.name)}</b>: ` +
      `${statusLabel[c.oldStatus] || c.oldStatus} → ${statusLabel[c.newStatus] || c.newStatus}` +
      (c.chance != null ? ` (${c.chance}% chance)` : '')
    );
  }
  return lines.join('\n');
}

function squadCard(manager, picks, scoredPlayers, teams, currentGw) {
  const lines = [
    `<b>👤 ${escapeHtml(manager.player_first_name)} ${escapeHtml(manager.player_last_name)}</b>`,
    `📋 ${escapeHtml(manager.name)}`,
    `🏆 Overall Rank: ${manager.summary_overall_rank?.toLocaleString() || 'N/A'} | Points: ${manager.summary_overall_points || 0}`,
    `💰 Bank: £${((picks.entry_history?.bank || 0) / 10).toFixed(1)}m | Value: £${((picks.entry_history?.value || 0) / 10).toFixed(1)}m`,
    `📅 GW${currentGw} Points: ${picks.entry_history?.points || 0} | 🪑 Bench Pts: ${picks.entry_history?.points_on_bench || 0}`,
    ``,
  ];

  // Grup per posisi
  const posGroups = { 1: [], 2: [], 3: [], 4: [] };
  const benchIds = new Set();

  for (const pick of picks.picks) {
    const p = scoredPlayers.find(sp => sp.id === pick.element);
    if (!p) continue;

    const entry = {
      ...p,
      isCaptain: pick.is_captain,
      isViceCaptain: pick.is_vice_captain,
      multiplier: pick.multiplier,
      position: pick.position,
    };

    if (pick.position > 11) {
      benchIds.add(pick.element);
    }

    posGroups[p.element_type].push(entry);
  }

  // Starting XI
  lines.push('<b>⚽ Starting XI</b>');
  for (const pos of [1, 2, 3, 4]) {
    const group = posGroups[pos]
      .filter(p => !benchIds.has(p.id))
      .sort((a, b) => a.position - b.position);

    if (group.length === 0) continue;

    for (const p of group) {
      const badge = p.isCaptain ? ' ©️' : p.isViceCaptain ? ' (VC)' : '';
      const statusIcon = p.status !== 'a' ? ` ${p.status === 'd' ? '⚠️' : '🏥'}` : '';
      lines.push(
        `  ${posLabel(pos)} <b>${escapeHtml(p.web_name)}</b>${badge}${statusIcon} — ` +
        `${colorIcon(p.scoring.qualityScore)}Q:${p.scoring.qualityScore} | ${priceStr(p.now_cost)} | ${colorIcon(parseFloat(p.form), [6, 3])}F:${p.form}`
      );
    }
  }

  // Bench
  lines.push('\n<b>🪑 Bench</b>');
  const bench = picks.picks
    .filter(pk => pk.position > 11)
    .sort((a, b) => a.position - b.position);

  for (const pick of bench) {
    const p = scoredPlayers.find(sp => sp.id === pick.element);
    if (!p) {
      lines.push(`  ❓ Pemain ID ${pick.element} — data tidak tersedia`);
      continue;
    }
    lines.push(
      `  ${posLabel(p.element_type)} ${escapeHtml(p.web_name)} — ${colorIcon(p.scoring.qualityScore)}Q:${p.scoring.qualityScore} | ${priceStr(p.now_cost)}`
    );
  }

  // Active chip
  if (picks.active_chip) {
    lines.push(`\n🃏 Chip aktif: <b>${picks.active_chip.toUpperCase()}</b>`);
  }

  return lines.join('\n');
}

function transferSuggestions(suggestions) {
  if (suggestions.length === 0) {
    return '<b>🔄 Transfer Suggestions</b>\n\nTidak ada saran transfer — squad sudah optimal!';
  }

  const lines = ['<b>🔄 Transfer Suggestions GW Berikutnya</b>\n'];

  suggestions.forEach((s, i) => {
    const priority = i === 0 ? '🔥' : i === 1 ? '⭐' : '💡';

    // Trend badges
    const trendBadge = (t) => {
      if (!t.trendLabel) return '';
      const icon = t.trendLabel === 'IMPROVING' ? '📈' : t.trendLabel === 'DECLINING' ? '📉' : '➡️';
      return ` ${icon}${t.trendScore}`;
    };

    lines.push(
      `${priority} <b>Prioritas ${i + 1}</b>`,
      `  ❌ OUT: <b>${escapeHtml(s.out.web_name)}</b> (${s.out.teamShort}) — Q:${s.out.qualityScore} | ${priceStr(s.out.nowCost)}${trendBadge(s.out)}`,
      `  ✅ IN:  <b>${escapeHtml(s.in.web_name)}</b> (${s.in.teamShort}) — Q:${s.in.qualityScore} | ${priceStr(s.in.nowCost)}${trendBadge(s.in)}`,
      `  📈 Skor naik: +${s.scoreDiff} | 💰 ${s.costDiff >= 0 ? 'Hemat' : 'Tambah'}: ${priceStr(Math.abs(s.costDiff))}`,
      `  💬 ${s.reason}`,
      '',
    );
  });

  lines.push('<i>⚠️ Saran berdasarkan quality score, fixture & tren historis 3 musim.</i>');
  return lines.join('\n');
}

function getPlayerTag(p) {
  const q = p.scoring.qualityScore;
  const safe = p.scoring.minutesSafe;
  const fixture = p.scoring.components.fixture;
  const form = parseFloat(p.form) || 0;

  // Recommended: quality tinggi + aman menit + fixture bagus
  if (q >= 65 && safe && fixture >= 0.5 && form >= 4) {
    if (p.scoring.label === 'DIFFERENTIAL') return '💎 PICK DIFFERENTIAL';
    return '✅ RECOMMENDED';
  }
  // Bagus tapi ada risiko
  if (q >= 55 && safe) return '👍 LAYAK DIPERTIMBANGKAN';
  // Overhyped: banyak dibeli tapi skor rendah atau overperforming
  if (q < 40 || (p.scoring.regression === 'OVERPERFORMING' && q < 60)) return '⚠️ OVERHYPED';
  return '';
}

function getHoldTag(p) {
  const q = p.scoring.qualityScore;
  const safe = p.scoring.minutesSafe;

  // Pemain yang dijual tapi sebenarnya masih bagus
  if (q >= 65 && safe && p.status === 'a') return '🔒 HOLD — Jangan jual!';
  if (q >= 50 && safe && p.status === 'a' && p.scoring.regression === 'UNDERPERFORMING') return '💎 HOLD — Potensi regresi naik';
  if (p.status !== 'a') return ''; // memang wajar dijual
  if (q >= 50 && safe) return '🤔 PERTIMBANGKAN HOLD';
  return '';
}

function trendingCard(transfersIn, currentGw) {
  const lines = [];

  lines.push(`<b>📈 TRANSFER IN — GW${currentGw}</b>`);
  lines.push('');
  transfersIn.slice(0, 10).forEach((p, i) => {
    const num = `${i + 1}`.padStart(2, ' ');
    const qIcon = p.scoring.qualityScore >= 70 ? '🟢' : p.scoring.qualityScore >= 40 ? '🟡' : '🔴';
    const tag = getPlayerTag(p);

    lines.push(`${num}. <b>${escapeHtml(p.web_name)}</b> — ${p.teamData?.short_name || '?'}`);
    lines.push(`      +${p.transfers_in_event.toLocaleString()} transfers`);
    lines.push(`      ${qIcon} Q:${p.scoring.qualityScore} · ${priceStr(p.now_cost)} · EO ${p.selected_by_percent}%`);
    if (tag) lines.push(`      <b>${tag}</b>`);
    lines.push('');
  });

  return lines.join('\n');
}

function trendingOutCard(transfersOut, currentGw) {
  const lines = [];

  lines.push(`<b>📉 TRANSFER OUT — GW${currentGw}</b>`);
  lines.push('');
  transfersOut.slice(0, 10).forEach((p, i) => {
    const num = `${i + 1}`.padStart(2, ' ');
    const reasons = [];
    if (p.status === 'i') reasons.push('🏥 Cedera');
    else if (p.status === 's') reasons.push('❌ Suspended');
    else if (p.status === 'd') reasons.push('⚠️ Doubtful');
    if (p.scoring.regression === 'OVERPERFORMING') reasons.push('📉 Overperform');
    const holdTag = getHoldTag(p);

    lines.push(`${num}. <b>${escapeHtml(p.web_name)}</b> — ${p.teamData?.short_name || '?'}`);
    lines.push(`      -${p.transfers_out_event.toLocaleString()} transfers`);
    if (reasons.length > 0) {
      lines.push(`      ${reasons.join(' · ')}`);
    }
    lines.push(`      Q:${p.scoring.qualityScore} · ${priceStr(p.now_cost)} · EO ${p.selected_by_percent}%`);
    if (holdTag) lines.push(`      <b>${holdTag}</b>`);
    lines.push('');
  });

  lines.push('<i>💡 Cek quality score sebelum ikut-ikutan transfer.</i>');
  return lines.join('\n');
}

function netTransferCard(players, currentGw) {
  const withNet = players
    .filter(p => p.minutes > 0)
    .map(p => ({
      ...p,
      netTransfer: p.transfers_in_event - p.transfers_out_event,
    }));

  const gainers = [...withNet].sort((a, b) => b.netTransfer - a.netTransfer).slice(0, 10);
  const losers = [...withNet].sort((a, b) => a.netTransfer - b.netTransfer).slice(0, 10);

  const lines = [];
  lines.push(`<b>⚡ NET TRANSFERS — GW${currentGw}</b>`);
  lines.push('');

  lines.push('<b>🚀 Top Gainers</b>');
  lines.push('');
  gainers.forEach((p, i) => {
    const num = `${i + 1}`.padStart(2, ' ');
    lines.push(`${num}. <b>${escapeHtml(p.web_name)}</b> (${p.teamData?.short_name || '?'}) · <b>+${p.netTransfer.toLocaleString()}</b> · Q:${p.scoring.qualityScore}`);
  });

  lines.push('');
  lines.push('<b>🧊 Top Losers</b>');
  lines.push('');
  losers.forEach((p, i) => {
    const num = `${i + 1}`.padStart(2, ' ');
    lines.push(`${num}. <b>${escapeHtml(p.web_name)}</b> (${p.teamData?.short_name || '?'}) · <b>${p.netTransfer.toLocaleString()}</b> · Q:${p.scoring.qualityScore}`);
  });

  return lines.join('\n');
}

function analyzeCard(p, currentGw) {
  const s = p.scoring;
  const active = getActiveMetrics();
  const weights = getPositionWeights()[p.element_type];

  const lines = [
    `<b>🔬 ANALISIS MENDALAM</b>`,
    ``,
    `<b>${escapeHtml(p.web_name)}</b> — ${posLabel(p.element_type)}`,
    `${p.teamData?.name || 'Unknown'} | ${priceStr(p.now_cost)} | EO: ${p.selected_by_percent}%`,
    ``,
  ];

  // === Quality & Differential Score ===
  const qIcon = colorIcon(s.qualityScore);
  lines.push(`${qIcon} <b>Quality Score: ${s.qualityScore}/100</b>`);
  lines.push(`🎯 <b>Differential Score: ${s.differentialScore}/100</b>`);
  lines.push(`🏷 Label: <b>${s.label}</b>`);
  lines.push('');

  // === Metric Components ===
  lines.push('<b>📊 Komponen Metrik (aktif)</b>');
  lines.push('');

  const metricKeys = {
    xgi: 'xGI/90',
    form: 'Form',
    fixture: 'Fixture',
    minutes: 'Minutes',
    value: 'Value',
    def: 'Defense',
    trend: 'Trend 3 Musim',
  };

  for (const metric of active) {
    const val = s.components[metric] || 0;
    const w = weights[metric] || 0;
    const pct = (val * 100).toFixed(0);
    const wPct = Math.round(w * 100);
    const icon = val >= 0.7 ? '🟢' : val >= 0.4 ? '🟡' : '🔴';
    lines.push(`${icon} <b>${metricKeys[metric] || metric}</b> (bobot ${wPct}%)`);
    lines.push(`   ${bar(val)} ${pct}/100`);
  }
  lines.push('');

  // === Raw Stats ===
  lines.push('<b>📈 Statistik Dasar</b>');
  lines.push(`  Form: <b>${p.form}</b> | PPG: ${p.points_per_game} | Total Pts: ${p.total_points}`);
  lines.push(`  Goals: ${p.goals_scored || 0} | Assists: ${p.assists || 0}`);
  lines.push(`  xG: ${(parseFloat(p.expected_goals) || 0).toFixed(2)} | xA: ${(parseFloat(p.expected_assists) || 0).toFixed(2)} | xGI: ${(parseFloat(p.expected_goal_involvements) || 0).toFixed(2)}`);
  lines.push(`  Menit: ${p.minutes} | Start: ${p.starts || 0} | CS: ${p.clean_sheets || 0}`);
  lines.push(`  Bonus: ${p.bonus || 0} | BPS: ${p.bps || 0}`);
  lines.push('');

  // === Fixture Analysis ===
  const fixtures = (p.nextFixtures || []).slice(0, 6);
  if (fixtures.length > 0) {
    lines.push('<b>📅 Fixture Analysis</b>');
    const fdrEmojis = ['🟢', '🟡', '🟠', '🔴', '🔴'];
    for (const f of fixtures) {
      const fdrEmoji = fdrEmojis[f.fdr - 1] || '⚪';
      lines.push(`  GW${f.gw}: ${f.isHome ? '🏠' : '✈️'} ${f.opponent_name || `Team${f.opponent}`} — FDR ${f.fdr} ${fdrEmoji}`);
    }
    const avgFdr = fixtures.reduce((sum, f) => sum + f.fdr, 0) / fixtures.length;
    const fdrVerdict = avgFdr <= 2.5 ? '🟢 Sangat Mudah' : avgFdr <= 3 ? '🟡 Cukup Baik' : avgFdr <= 3.5 ? '🟠 Rata-rata' : '🔴 Sulit';
    lines.push(`  <b>Rata-rata FDR: ${avgFdr.toFixed(1)}</b> — ${fdrVerdict}`);
    lines.push('');
  }

  // === Transfer Activity ===
  lines.push('<b>🔄 Transfer Activity</b>');
  lines.push(`  Transfer In (GW): +${(p.transfers_in_event || 0).toLocaleString()}`);
  lines.push(`  Transfer Out (GW): -${(p.transfers_out_event || 0).toLocaleString()}`);
  const net = (p.transfers_in_event || 0) - (p.transfers_out_event || 0);
  lines.push(`  Net: <b>${net >= 0 ? '+' : ''}${net.toLocaleString()}</b>`);
  lines.push('');

  // === Regression Analysis ===
  const goalsScored = p.goals_scored || 0;
  const xG = parseFloat(p.expected_goals) || 0;
  const assists = p.assists || 0;
  const xA = parseFloat(p.expected_assists) || 0;
  const goalDiff = goalsScored - xG;
  const assistDiff = assists - xA;

  lines.push('<b>📉 Analisis Regresi</b>');
  lines.push(`  Goals vs xG: ${goalsScored} vs ${xG.toFixed(1)} (${goalDiff >= 0 ? '+' : ''}${goalDiff.toFixed(1)})`);
  lines.push(`  Assists vs xA: ${assists} vs ${xA.toFixed(1)} (${assistDiff >= 0 ? '+' : ''}${assistDiff.toFixed(1)})`);

  if (s.regression === 'CLINICAL_FINISHER') {
    lines.push(`  🎯 <b>CLINICAL FINISHER</b> — konsisten outperform xG multi-musim (skill, bukan luck)`);
  } else if (s.regression === 'OVERPERFORMING') {
    lines.push(`  ⚠️ <b>OVERPERFORMING</b> — waspada regresi turun`);
  } else if (s.regression === 'POOR_FINISHER') {
    lines.push(`  📉 <b>POOR FINISHER</b> — konsisten underperform xG multi-musim`);
  } else if (s.regression === 'UNDERPERFORMING') {
    lines.push(`  💎 <b>UNDERPERFORMING</b> — potensi regresi naik, beli murah!`);
  } else {
    lines.push(`  ✅ Output sesuai dengan expected stats`);
  }
  lines.push('');

  // === Minutes Security ===
  lines.push('<b>⏱ Keamanan Menit</b>');
  const chancePlay = p.chance_of_playing_next_round ?? 100;
  const statusLabel = { a: '✅ Available', d: '⚠️ Doubtful', i: '🏥 Injured', s: '❌ Suspended', u: '❓ Unknown' };
  lines.push(`  Status: ${statusLabel[p.status] || p.status}`);
  lines.push(`  Chance of playing: ${chancePlay}%`);
  lines.push(`  ${s.minutesSafe ? '✅ Aman' : '🚨 RISIKO ROTASI/CEDERA'}`);
  if (p.minutes < 270) {
    lines.push(`  ⚠️ Sample size kecil (${p.minutes} menit)`);
  }
  lines.push('');

  // === Historical Trend ===
  if (s.trendData) {
    const td = s.trendData;
    const trendIcon = td.trendLabel === 'IMPROVING' ? '📈' : td.trendLabel === 'DECLINING' ? '📉' : '➡️';
    lines.push('<b>📜 Tren Historis (3 Musim)</b>');
    lines.push(`  ${trendIcon} Tren: <b>${td.trendLabel}</b> (${td.trendScore}/100)`);
    lines.push(`  🔄 Konsistensi: ${td.consistency}/100`);
    lines.push(`  📊 Data: ${td.seasonsCount} musim`);
    lines.push(`  🔮 Prediksi PP90: ${td.predictedPP90}`);
    if (td.changedTeam) lines.push(`  🔀 Pernah pindah klub`);
    const opG = td.overperformance.goals;
    const opA = td.overperformance.assists;
    if (Math.abs(opG) > 1 || Math.abs(opA) > 1) {
      lines.push(`  ⚡ Overperformance kumulatif: Goals ${opG >= 0 ? '+' : ''}${opG} | Assists ${opA >= 0 ? '+' : ''}${opA}`);
    }
    lines.push('');
  } else {
    lines.push('<i>📜 Data historis tidak tersedia (pemain baru/promosi)</i>');
    lines.push('');
  }

  // === Final Verdict ===
  lines.push('<b>🏁 VERDICT</b>');
  const verdicts = [];
  if (s.qualityScore >= 70 && s.minutesSafe) {
    verdicts.push('✅ <b>SANGAT DIREKOMENDASIKAN</b> — Skor tinggi & aman menit');
  } else if (s.qualityScore >= 55 && s.minutesSafe) {
    verdicts.push('👍 <b>LAYAK DIPILIH</b> — Performa solid');
  } else if (s.qualityScore >= 40) {
    verdicts.push('🤔 <b>PERTIMBANGKAN</b> — Ada pro & kontra');
  } else {
    verdicts.push('❌ <b>TIDAK DIREKOMENDASIKAN</b> — Skor terlalu rendah');
  }

  if (s.label === 'DIFFERENTIAL') verdicts.push('💎 Differential pick — ownership rendah');
  if (s.regression === 'CLINICAL_FINISHER') verdicts.push('🎯 Clinical finisher — overperformance = skill');
  if (s.regression === 'UNDERPERFORMING') verdicts.push('📈 Potensi regresi naik — value buy');
  if (s.regression === 'OVERPERFORMING') verdicts.push('📉 Hati-hati regresi turun');
  if (s.regression === 'POOR_FINISHER') verdicts.push('⚠️ Poor finisher — jangan harap outperform xG');
  if (!s.minutesSafe) verdicts.push('🚨 Risiko menit bermain');
  if (s.trendData?.trendLabel === 'IMPROVING') verdicts.push('📈 Tren naik — performa membaik multi-musim');
  if (s.trendData?.trendLabel === 'DECLINING') verdicts.push('📉 Tren turun — hati-hati penurunan performa');
  if (s.trendData?.consistency >= 80) verdicts.push('🔒 Sangat konsisten — low risk pick');

  lines.push(verdicts.join('\n'));

  return lines.join('\n');
}

function historyCard(p, trend) {
  const lines = [
    `<b>📜 DATA HISTORIS 3 MUSIM</b>`,
    ``,
    `<b>${escapeHtml(p.web_name)}</b> — ${posLabel(p.element_type)}`,
    `${p.teamData?.name || 'Unknown'} | ${priceStr(p.now_cost)}`,
    ``,
  ];

  if (!trend) {
    lines.push('<i>Tidak ada data historis untuk pemain ini.</i>');
    lines.push('Kemungkinan: pemain baru, baru promosi, atau nama berubah.');
    return lines.join('\n');
  }

  // === Trend Overview ===
  const trendIcon = trend.trendLabel === 'IMPROVING' ? '📈' : trend.trendLabel === 'DECLINING' ? '📉' : '➡️';
  lines.push(`${trendIcon} <b>Tren: ${trend.trendLabel}</b> — Skor: ${trend.trendScore}/100`);
  lines.push(`🔄 Konsistensi: ${trend.consistency}/100`);
  if (trend.changedTeam) lines.push('🔀 Pernah pindah klub selama 3 musim');
  lines.push('');

  // === Per-Season Breakdown ===
  lines.push('<b>📊 Data Per Musim</b>');
  lines.push('');

  for (const s of trend.seasons) {
    const pos = { 1: 'GK', 2: 'DEF', 3: 'MID', 4: 'FWD' }[s.position] || '?';
    lines.push(`<b>${s.season}</b>`);
    lines.push(`  Menit: ${s.minutes} | Start: ${s.starts} | Pts: ${s.totalPoints}`);
    lines.push(`  PPG: ${s.ppg} | PP90: ${s.pp90.toFixed(2)}`);
    lines.push(`  Goals: ${s.goals} (xG: ${s.xg.toFixed(1)}) | Assists: ${s.assists} (xA: ${s.xa.toFixed(1)})`);
    lines.push(`  xGI/90: ${s.xgi90.toFixed(2)} | CS: ${s.cleanSheets} | Bonus: ${Math.round(s.bonus90 * 10) / 10}/90`);
    lines.push(`  ICT: ${s.ict} | Harga: ${priceStr(s.cost)}`);
    lines.push('');
  }

  // === Trend Components ===
  lines.push('<b>📈 Analisis Tren</b>');
  const arw = (v) => v > 0.15 ? '📈' : v < -0.15 ? '📉' : '➡️';
  const tc = trend.components;
  lines.push(`  ${arw(tc.pp90)} PP90: ${tc.pp90 > 0 ? '+' : ''}${(tc.pp90 * 100).toFixed(0)}% (R²: ${(trend.trends.pp90.r2 * 100).toFixed(0)}%)`);
  lines.push(`  ${arw(tc.xgi90)} xGI/90: ${tc.xgi90 > 0 ? '+' : ''}${(tc.xgi90 * 100).toFixed(0)}%`);
  lines.push(`  ${arw(tc.minutes)} Menit: ${tc.minutes > 0 ? '+' : ''}${(tc.minutes * 100).toFixed(0)}%`);
  lines.push(`  ${arw(tc.ict)} ICT: ${tc.ict > 0 ? '+' : ''}${(tc.ict * 100).toFixed(0)}%`);
  lines.push('');

  // === Overperformance ===
  const opG = trend.overperformance.goals;
  const opA = trend.overperformance.assists;
  lines.push('<b>⚡ Overperformance Kumulatif (3 Musim)</b>');
  lines.push(`  Goals vs xG: ${opG >= 0 ? '+' : ''}${opG} ${opG > 3 ? '(clinical!)' : opG < -3 ? '(poor finisher)' : '(normal)'}`);
  lines.push(`  Assists vs xA: ${opA >= 0 ? '+' : ''}${opA}`);
  lines.push('');

  // === Prediction ===
  lines.push('<b>🔮 Prediksi</b>');
  lines.push(`  Estimated PP90 next season: <b>${trend.predictedPP90}</b>`);

  const lastSeason = trend.seasons[trend.seasons.length - 1];
  if (lastSeason) {
    const diff = trend.predictedPP90 - lastSeason.pp90;
    if (diff > 0.3) {
      lines.push(`  📈 Diperkirakan <b>naik</b> dari musim lalu`);
    } else if (diff < -0.3) {
      lines.push(`  📉 Diperkirakan <b>turun</b> dari musim lalu`);
    } else {
      lines.push(`  ➡️ Diperkirakan <b>stabil</b>`);
    }
  }

  lines.push('');
  lines.push(`<i>💡 Gunakan /analyze ${escapeHtml(p.web_name)} untuk analisis lengkap musim ini</i>`);

  return lines.join('\n');
}

function bestXICard(manager, result, currentGw) {
  const lines = [
    `<b>⭐ Best Starting XI — GW${currentGw}</b>`,
    `<b>👤 ${escapeHtml(manager.player_first_name)} ${escapeHtml(manager.player_last_name)}</b> | ${escapeHtml(manager.name)}`,
    ``,
    `<b>📐 Formasi: ${result.formation}</b>`,
    `<b>📊 Total Quality Score: ${result.totalScore}</b>`,
    ``,
    `<b>⚽ Starting XI</b>`,
  ];

  // Group starting XI by position
  const posGroups = { 1: [], 2: [], 3: [], 4: [] };
  for (const p of result.starting) {
    posGroups[p.element_type].push(p);
  }

  for (const pos of [1, 2, 3, 4]) {
    const group = posGroups[pos];
    if (group.length === 0) continue;
    for (const p of group) {
      const badge = p.isCaptain ? ' ©️' : p.isViceCaptain ? ' (VC)' : '';
      const statusIcon = p.status !== 'a' ? ` ${p.status === 'd' ? '⚠️' : '🏥'}` : '';
      const fixtureStr = p.nextFixtures?.[0]
        ? ` vs ${p.nextFixtures[0].opponent_name}(${p.nextFixtures[0].isHome ? 'H' : 'A'})`
        : '';
      lines.push(
        `  ${posLabel(pos)} <b>${escapeHtml(p.web_name)}</b>${badge}${statusIcon} — ` +
        `${colorIcon(p.scoring.qualityScore)}Q:${p.scoring.qualityScore} | ` +
        `F:${p.form} | ${priceStr(p.now_cost)}${fixtureStr}`
      );
    }
  }

  // Bench
  lines.push('');
  lines.push('<b>🪑 Bench (urut prioritas)</b>');
  for (let i = 0; i < result.bench.length; i++) {
    const p = result.bench[i];
    const statusIcon = p.status !== 'a' ? ` ${p.status === 'd' ? '⚠️' : '🏥'}` : '';
    lines.push(
      `  ${i + 1}. ${posLabel(p.element_type)} ${escapeHtml(p.web_name)}${statusIcon} — ` +
      `${colorIcon(p.scoring.qualityScore)}Q:${p.scoring.qualityScore} | F:${p.form}`
    );
  }

  // Captain reasoning
  lines.push('');
  lines.push('<b>👑 Rekomendasi Kapten</b>');
  const cap = result.starting.find(p => p.isCaptain);
  const vc = result.starting.find(p => p.isViceCaptain);
  if (cap) {
    const capFixture = cap.nextFixtures?.[0];
    lines.push(
      `  ©️ <b>${cap.web_name}</b> — Q:${cap.scoring.qualityScore} | F:${cap.form}` +
      (capFixture ? ` | vs ${capFixture.opponent_name}(${capFixture.isHome ? 'H' : 'A'}) FDR:${capFixture.fdr}` : '')
    );
  }
  if (vc) {
    lines.push(`  VC: ${vc.web_name} — Q:${vc.scoring.qualityScore} | F:${vc.form}`);
  }

  // Comparison with current lineup if different
  if (result.changes?.length > 0) {
    lines.push('');
    lines.push('<b>🔄 Perubahan dari lineup saat ini:</b>');
    for (const ch of result.changes) {
      lines.push(`  ➡️ ${ch}`);
    }
  }

  return lines.join('\n');
}

module.exports = {
  playerCard, compareCard, rankingList, fixtureTable,
  priceChangeNotif, statusChangeNotif, squadCard, transferSuggestions,
  trendingCard, trendingOutCard, netTransferCard,
  analyzeCard, historyCard, bestXICard, posLabel, priceStr, escapeHtml,
  expertPicksCard, priceWarningCard, lineupCard,
  chipPlanCard, transferPlanCard, whatIfCard,
};

// ========== Expert Picks Card ==========

function expertPicksCard(picks) {
  const lines = [
    `🏆 <b>Expert Picks — GW${picks.gw}</b>`,
    ``,
  ];

  // Captain
  if (picks.captain) {
    const c = picks.captain;
    lines.push(`👑 <b>Captain Pick</b>`);
    lines.push(`  <b>${escapeHtml(c.web_name)}</b> (${c.teamData?.short_name || '?'}) — QS ${c.scoring.qualityScore} | Form ${c.form} | ${priceStr(c.now_cost)}`);
    if (picks.captainAlts?.length) {
      lines.push(`  Alternatif: ${picks.captainAlts.map(a => `${escapeHtml(a.web_name)} (${a.scoring.qualityScore})`).join(', ')}`);
    }
    lines.push('');
  }

  // Transfer-In per position
  lines.push(`📥 <b>Best Transfer-In</b>`);
  for (const pos of [1, 2, 3, 4]) {
    const players = picks.transfersIn[pos];
    if (!players?.length) continue;
    lines.push(`  ${posLabel(pos)}`);
    for (const p of players) {
      lines.push(`    ${colorIcon(p.scoring.qualityScore)} <b>${escapeHtml(p.web_name)}</b> (${p.teamData?.short_name || '?'}) — ${p.scoring.qualityScore} | ${priceStr(p.now_cost)}`);
    }
  }
  lines.push('');

  // Differentials
  lines.push(`💎 <b>Differential Picks</b> (<12% EO)`);
  for (const pos of [1, 2, 3, 4]) {
    const players = picks.differentials[pos];
    if (!players?.length) continue;
    for (const p of players) {
      lines.push(`  ${posLabel(pos)} <b>${escapeHtml(p.web_name)}</b> (${p.teamData?.short_name || '?'}) — DS ${p.scoring.differentialScore} | EO ${p.selected_by_percent}% | ${priceStr(p.now_cost)}`);
    }
  }
  lines.push('');

  // Budget picks
  lines.push(`💰 <b>Budget Picks</b>`);
  for (const pos of [1, 2, 3, 4]) {
    const players = picks.budgetPicks[pos];
    if (!players?.length) continue;
    for (const p of players) {
      lines.push(`  ${posLabel(pos)} <b>${escapeHtml(p.web_name)}</b> (${p.teamData?.short_name || '?'}) — QS ${p.scoring.qualityScore} | ${priceStr(p.now_cost)}`);
    }
  }

  return lines.join('\n');
}

// ========== Price Warning Card ==========

function priceWarningCard(risers, fallers) {
  const lines = [
    `📈📉 <b>Price Warnings</b>`,
    ``,
  ];

  const progressBar = (pct) => {
    const filled = Math.min(Math.round(pct / 10), 10);
    return '▓'.repeat(filled) + '░'.repeat(10 - filled);
  };

  const likelihoodEmoji = { VERY_LIKELY: '🔴', LIKELY: '🟠', POSSIBLE: '🟡', UNLIKELY: '⚪' };

  if (risers.length > 0) {
    lines.push(`📈 <b>Likely to RISE</b>`);
    for (const p of risers.slice(0, 10)) {
      const flag = p.inSquad ? ' 📋' : p.inWatchlist ? ' 👁' : '';
      lines.push(`  ${likelihoodEmoji[p.likelihood] || '⚪'} <b>${escapeHtml(p.webName)}</b> (${p.teamShort}) ${priceStr(p.nowCost)}${flag}`);
      lines.push(`    ${progressBar(p.progress)} ${p.progress}% | +${p.netTransfers.toLocaleString()} net`);
    }
    lines.push('');
  }

  if (fallers.length > 0) {
    lines.push(`📉 <b>Likely to FALL</b>`);
    for (const p of fallers.slice(0, 10)) {
      const flag = p.inSquad ? ' 📋' : p.inWatchlist ? ' 👁' : '';
      lines.push(`  ${likelihoodEmoji[p.likelihood] || '⚪'} <b>${escapeHtml(p.webName)}</b> (${p.teamShort}) ${priceStr(p.nowCost)}${flag}`);
      lines.push(`    ${progressBar(p.progress)} ${p.progress}% | ${p.netTransfers.toLocaleString()} net`);
    }
  }

  if (risers.length === 0 && fallers.length === 0) {
    lines.push(`Tidak ada perubahan harga signifikan saat ini.`);
  }

  return lines.join('\n');
}

// ========== Predicted Lineup Card ==========

function lineupCard(lineup) {
  if (!lineup) return '❌ Data lineup tidak tersedia.';

  const lines = [
    `⚽ <b>Predicted Lineup — ${escapeHtml(lineup.teamName)}</b>`,
    `📐 Formation: <b>${lineup.formation}</b> | Avg Confidence: ${lineup.avgProbability}%`,
    ``,
  ];

  // Group XI by position
  const grouped = { 1: [], 2: [], 3: [], 4: [] };
  for (const p of lineup.startingXI) {
    grouped[p.elementType].push(p);
  }

  for (const pos of [1, 2, 3, 4]) {
    if (!grouped[pos].length) continue;
    lines.push(`${posLabel(pos)}`);
    for (const p of grouped[pos]) {
      const conf = p.startProbability >= 80 ? '🟢' : p.startProbability >= 50 ? '🟡' : '🔴';
      const statusIcon = p.status === 'i' ? ' 🏥' : p.status === 'd' ? ' ⚠️' : '';
      lines.push(`  ${conf} <b>${escapeHtml(p.webName)}</b> — ${p.startProbability}% | QS ${p.qualityScore} | £${p.price}m${statusIcon}`);
    }
  }

  if (lineup.bench?.length) {
    lines.push('');
    lines.push(`<b>Bench:</b>`);
    for (const p of lineup.bench.slice(0, 5)) {
      lines.push(`  ⬜ ${escapeHtml(p.webName)} (${POSITION_NAMES[p.elementType]}) — ${p.startProbability}%`);
    }
  }

  return lines.join('\n');
}

// ========== Chip Plan Card ==========

function chipPlanCard(result) {
  const { chips, gwDifficulty } = result;
  const lines = [
    `🎯 <b>Chip Plan — Season Strategy</b>`,
    ``,
  ];

  const chipEmoji = {
    wildcard1: '🃏', wildcard2: '🃏',
    freeHit: '🎯', benchBoost: '📋', tripleCaptain: '👑',
  };
  const chipNames = {
    wildcard1: 'Wildcard 1 (GW1-19)',
    wildcard2: 'Wildcard 2 (GW20-38)',
    freeHit: 'Free Hit',
    benchBoost: 'Bench Boost',
    tripleCaptain: 'Triple Captain',
  };
  const confEmoji = { HIGH: '🟢', MEDIUM: '🟡', LOW: '🔴' };

  for (const [key, name] of Object.entries(chipNames)) {
    const chip = chips[key];
    if (!chip) {
      lines.push(`${chipEmoji[key]} <b>${name}</b>: ❓ Belum bisa ditentukan`);
      continue;
    }
    lines.push(`${chipEmoji[key]} <b>${name}</b> → <b>GW${chip.gw}</b> ${confEmoji[chip.confidence] || ''}`);
    lines.push(`  ${chip.reason}`);
    if (chip.isDGW) lines.push(`  ⚡ Double Gameweek`);
    if (chip.isBGW) lines.push(`  ⚠️ Blank Gameweek`);
    lines.push('');
  }

  // Mini difficulty chart (every 5 GWs)
  lines.push(`<b>Difficulty Overview:</b>`);
  const chunks = [];
  for (let i = 0; i < gwDifficulty.length; i += 5) {
    const chunk = gwDifficulty.slice(i, i + 5);
    const avgFdr = chunk.reduce((s, g) => s + g.avgFdr, 0) / chunk.length;
    const icon = avgFdr < 2.7 ? '🟢' : avgFdr < 3.2 ? '🟡' : '🔴';
    chunks.push(`GW${chunk[0].gw}-${chunk[chunk.length - 1].gw} ${icon}`);
  }
  lines.push(chunks.join(' | '));

  return lines.join('\n');
}

// ========== Transfer Plan Card ==========

function transferPlanCard(result) {
  const { plan, swings } = result;
  const lines = [
    `📋 <b>Transfer Plan</b>`,
    ``,
  ];

  for (const gw of plan) {
    const icon = gw.action === 'transfer' ? '🔄' : '💾';
    const fdrIcon = parseFloat(gw.avgSquadFdr) < 2.8 ? '🟢' : parseFloat(gw.avgSquadFdr) < 3.3 ? '🟡' : '🔴';

    lines.push(`<b>GW${gw.gw}</b> ${icon} ${fdrIcon} FDR ${gw.avgSquadFdr} | FT: ${gw.freeTransfers}`);

    if (gw.action === 'transfer' && gw.suggestedOut && gw.suggestedIn) {
      lines.push(`  ❌ ${escapeHtml(gw.suggestedOut.webName)} (${gw.suggestedOut.team}) QS ${gw.suggestedOut.qualityScore}`);
      lines.push(`  ✅ ${escapeHtml(gw.suggestedIn.webName)} (${gw.suggestedIn.team}) QS ${gw.suggestedIn.qualityScore} | £${gw.suggestedIn.price}m (+${gw.suggestedIn.improvement})`);
    } else {
      lines.push(`  ${gw.reason}`);
    }

    if (gw.swings?.length) {
      for (const s of gw.swings) {
        const dir = s.direction === 'improving' ? '📈' : '📉';
        lines.push(`  ${dir} ${escapeHtml(s.teamShort)} fixtures ${s.direction} (${s.fdrBefore}→${s.fdrAfter})`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ========== What-If Card ==========

function whatIfCard(result) {
  if (!result.valid) {
    return `❌ <b>Simulasi Gagal</b>\n\n${result.errors.join('\n')}`;
  }

  const lines = [
    `🔮 <b>What-If Simulator</b>`,
    ``,
  ];

  // Transfers
  for (const t of result.transfers) {
    lines.push(`🔄 <b>${escapeHtml(t.out.webName)}</b> (${t.out.teamShort}) → <b>${escapeHtml(t.in.webName)}</b> (${t.in.teamShort})`);
    const qsDiff = t.qualityDiff > 0 ? `+${t.qualityDiff}` : `${t.qualityDiff}`;
    const costSave = t.costDiff > 0 ? `+£${(t.costDiff / 10).toFixed(1)}m` : `-£${(Math.abs(t.costDiff) / 10).toFixed(1)}m`;
    lines.push(`  QS: ${t.out.qualityScore} → ${t.in.qualityScore} (${qsDiff}) | Budget: ${costSave}`);
    lines.push('');
  }

  // Impact summary
  const imp = result.impact;
  const qIcon = imp.qualityDiff > 0 ? '📈' : imp.qualityDiff < 0 ? '📉' : '➡️';
  const fIcon = imp.fixtureDiff > 0 ? '📈' : imp.fixtureDiff < 0 ? '📉' : '➡️';

  lines.push(`<b>Impact Summary</b>`);
  lines.push(`  ${qIcon} Avg Quality: ${result.before.avgQuality} → ${result.after.avgQuality} (${imp.qualityDiff > 0 ? '+' : ''}${imp.qualityDiff})`);
  lines.push(`  ${fIcon} Fixture Score: ${result.before.avgFixture} → ${result.after.avgFixture} (${imp.fixtureDiff > 0 ? '+' : ''}${imp.fixtureDiff})`);
  lines.push(`  💰 Bank: £${(result.before.bank / 10).toFixed(1)}m → £${(result.after.bank / 10).toFixed(1)}m`);

  return lines.join('\n');
}
