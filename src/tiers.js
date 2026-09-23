// Freemium tier system — FREE / PRO / TEAM

const TIERS = {
  free: {
    name: 'Free',
    emoji: '🆓',
    watchlistLimit: 5,
    commands: [
      'start', 'help', 'myid', 'lang', 'settings', 'refresh',
      'player', 'best', 'fixtures', 'trending', 'nettransfer',
      'news', 'newslist', 'watch', 'unwatch', 'watchlist',
      'export_data', 'delete_account', 'metrics',
    ],
    dailyCommandLimit: 50,
    features: {
      analyze: false,
      history: false,
      compare: false,
      differentials: false,
      regression: false,
      squad: true,
      best11: false,
      suggest: false,
    },
  },
  pro: {
    name: 'Pro',
    emoji: '⭐',
    watchlistLimit: 20,
    commands: 'all', // semua command
    dailyCommandLimit: 500,
    features: {
      analyze: true,
      history: true,
      compare: true,
      differentials: true,
      regression: true,
      squad: true,
      best11: true,
      suggest: true,
    },
  },
  team: {
    name: 'Team',
    emoji: '👑',
    watchlistLimit: 50,
    commands: 'all',
    dailyCommandLimit: Infinity,
    features: {
      analyze: true,
      history: true,
      compare: true,
      differentials: true,
      regression: true,
      squad: true,
      best11: true,
      suggest: true,
    },
  },
};

// Commands that require a specific tier (PRO+)
const PRO_COMMANDS = [
  'analyze', 'history', 'compare', 'differentials', 'regression', 'best11', 'suggest',
  'expertpicks', 'picks', 'pricewarning', 'prices', 'lineup',
  'chipplan', 'chips', 'plan', 'transferplan', 'whatif',
];

function getTierConfig(tierName) {
  return TIERS[tierName] || TIERS.free;
}

function isCommandAllowed(tierName, command) {
  const tier = getTierConfig(tierName);
  if (tier.commands === 'all') return true;
  return tier.commands.includes(command);
}

function getWatchlistLimit(tierName) {
  return getTierConfig(tierName).watchlistLimit;
}

function getDailyLimit(tierName) {
  return getTierConfig(tierName).dailyCommandLimit;
}

function formatTierInfo(tierName) {
  const tier = getTierConfig(tierName);
  return `${tier.emoji} ${tier.name}`;
}

function formatUpgradeMessage(command, currentTier) {
  const tier = getTierConfig(currentTier);
  return (
    `🔒 <b>Fitur Pro</b>\n\n` +
    `Perintah <code>/${command}</code> memerlukan <b>⭐ Pro</b> atau lebih tinggi.\n` +
    `Kamu saat ini: ${tier.emoji} <b>${tier.name}</b>\n\n` +
    `<b>Upgrade ke Pro untuk akses:</b>\n` +
    `• Analisa mendalam (/analyze)\n` +
    `• Data historis 3 musim (/history)\n` +
    `• Perbandingan pemain (/compare)\n` +
    `• Differential picks (/differentials)\n` +
    `• Analisis regresi (/regression)\n` +
    `• Best Starting XI (/best11)\n` +
    `• Saran transfer (/suggest)\n` +
    `• Expert Picks mingguan (/expertpicks)\n` +
    `• Price Warnings (/pricewarning)\n` +
    `• Predicted Lineups (/lineup)\n` +
    `• What-If Simulator (/whatif)\n` +
    `• Transfer Planner (/plan)\n` +
    `• Chip Planning GW1-38 (/chipplan)\n` +
    `• Watchlist sampai 20 pemain\n\n` +
    `Hubungi @Abulkhaer untuk upgrade.`
  );
}

function formatTierList() {
  const lines = ['<b>📊 Paket Langganan</b>\n'];

  lines.push('🆓 <b>Free</b> — Gratis selamanya');
  lines.push('  • Info pemain dasar (/player)');
  lines.push('  • Top pemain (/best)');
  lines.push('  • Transfer trending');
  lines.push('  • Berita FPL');
  lines.push('  • Watchlist (5 pemain)');
  lines.push('  • 50 perintah/hari');
  lines.push('');

  lines.push('⭐ <b>Pro</b> — Analisis lengkap');
  lines.push('  • Semua fitur Free +');
  lines.push('  • Analisis mendalam (/analyze)');
  lines.push('  • Data historis 3 musim (/history)');
  lines.push('  • Perbandingan pemain (/compare)');
  lines.push('  • Differential picks');
  lines.push('  • Best XI & saran transfer');
  lines.push('  • Expert Picks mingguan');
  lines.push('  • Price Warnings');
  lines.push('  • Predicted Lineups');
  lines.push('  • What-If Simulator');
  lines.push('  • Transfer Planner');
  lines.push('  • Chip Planning GW1-38');
  lines.push('  • Watchlist (20 pemain)');
  lines.push('  • 500 perintah/hari');
  lines.push('');

  lines.push('👑 <b>Team</b> — Unlimited');
  lines.push('  • Semua fitur Pro +');
  lines.push('  • Watchlist (50 pemain)');
  lines.push('  • Unlimited perintah');
  lines.push('  • Prioritas support');
  lines.push('');

  lines.push('💬 Hubungi @Abulkhaer untuk upgrade.');

  return lines.join('\n');
}

module.exports = {
  TIERS, PRO_COMMANDS,
  getTierConfig, isCommandAllowed, getWatchlistLimit, getDailyLimit,
  formatTierInfo, formatUpgradeMessage, formatTierList,
};
