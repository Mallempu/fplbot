const { fetchAll, fetchBootstrap, fetchFixtures, fetchManagerInfo, fetchManagerPicks, fetchManagerTransfers, fetchMyTeam, fplLogin, getFplLoginError, getFplLoginDebug, setFplSession, startAuthCodeFlow, exchangeAuthCode, getUserSession, clearUserSession } = require('./fpl-api');
const { scoreAllPlayers } = require('./scoring');
const {
  addToWatchlist, removeFromWatchlist, getWatchlist, getWatchlistCount,
  registerUser, getUser, getAllUsers, updateUserActivity, getUserActivity, getUserStats,
  getUserPreferences, updateUserPreference, deleteUser,
  getUserLang, setUserLang, getUserTier, setUserTier,
  saveFplToken, getFplToken, clearFplToken,
} = require('./database');
const { t, getSupportedLanguages } = require('./i18n');
const { trackCommand, trackError, getMetrics, resetMetrics } = require('./monitor');
const { PRO_COMMANDS, isCommandAllowed, getWatchlistLimit, formatUpgradeMessage, formatTierList, formatTierInfo } = require('./tiers');
const {
  POSITION_NAMES, POSITION_EMOJI, ALL_METRICS, METRIC_LABELS,
  getActiveMetrics, getPositionWeights, DEFAULT_WEIGHTS,
} = require('./config');
const { isOwner, getOwnerId } = require('./admin');
const fmt = require('./format');
const {
  ensureHistoricalData, refreshHistoricalData, makePlayerKey,
  analyzePlayerTrend, hasHistoricalData, SEASONS,
} = require('./historical');
const {
  fetchAllNews, fetchAllFplNews, fetchAllInstagramNews,
  fetchAccountNews, formatNews, formatSingleAccount,
  sendIgPostsWithImages,
  fetchNewsIntel, formatNewsIntel,
  getAccountsX, getAccountsIG,
} = require('./news');

// Track users waiting to paste FPL login redirect URL
const pendingFplLogin = new Set();

// Rate limiter per user
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60_000; // 1 menit
const RATE_LIMIT_MAX = 20; // max 20 commands per menit

function isRateLimited(userId) {
  const now = Date.now();
  const entry = rateLimitMap.get(userId);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW) {
    rateLimitMap.set(userId, { windowStart: now, count: 1 });
    return false;
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) return true;
  return false;
}

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [userId, entry] of rateLimitMap) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW * 2) rateLimitMap.delete(userId);
  }
}, 300_000);

// Cache scored players (refresh setiap fetch baru)
let cachedScored = null;
let cacheTs = 0;
let cachePromise = null; // mutex: prevent concurrent fetches
const CACHE_TTL = 600_000; // 10 menit

async function getScoredPlayers() {
  const now = Date.now();
  if (cachedScored && now - cacheTs < CACHE_TTL) return cachedScored;

  // If another request is already fetching, wait for it
  if (cachePromise) return cachePromise;

  cachePromise = (async () => {
    try {
      // Pastikan data historis sudah ada (lazy load, auto-refresh weekly)
      try {
        await ensureHistoricalData();
      } catch (err) {
        console.error('Historical data load warning:', err.message);
      }

      const data = await fetchAll();
      const scored = scoreAllPlayers(data.players);
      cachedScored = { scored, teams: data.teams, currentGw: data.currentGw };
      cacheTs = Date.now();
      return cachedScored;
    } catch (err) {
      cachePromise = null;
      throw err;
    } finally {
      cachePromise = null;
    }
  })();

  return cachePromise;
}

function findPlayer(scored, query) {
  const q = query.toLowerCase().trim();
  // Exact match first
  let found = scored.find(p => p.web_name.toLowerCase() === q);
  if (found) return found;
  // Partial match
  const matches = scored.filter(p =>
    p.web_name.toLowerCase().includes(q) ||
    (`${p.first_name} ${p.second_name}`).toLowerCase().includes(q)
  );
  return matches.length === 1 ? matches[0] : matches.length > 1 ? matches : null;
}

function posIdFromStr(str) {
  const s = str?.toUpperCase().trim();
  for (const [id, name] of Object.entries(POSITION_NAMES)) {
    if (name === s) return parseInt(id);
  }
  // Alias
  const alias = { GOALKEEPER: 1, KEEPER: 1, DEFENDER: 2, MIDFIELDER: 3, FORWARD: 4, STRIKER: 4, ATT: 4, MF: 3, DF: 2 };
  return alias[s] || null;
}

// Perintah yang bisa diakses tanpa registrasi
const PUBLIC_COMMANDS = ['start', 'myid', 'help', 'lang', 'pricing'];

// Ambil FPL ID user: dari registered user atau fallback ke env (owner)
async function getUserFplId(ctx) {
  const user = await getUser(ctx.from.id);
  if (user?.fpl_id) return user.fpl_id;
  if (isOwner(ctx) && process.env.FPL_ID) return parseInt(process.env.FPL_ID);
  return null;
}

function registerCommands(bot) {

  // =====================
  // MIDDLEWARE: Cek registrasi + tracking aktivitas
  // =====================
  bot.use(async (ctx, next) => {
    if (!ctx.message?.text) return next();

    const text = ctx.message.text;
    const command = text.startsWith('/') ? text.split(/[\s@]/)[0].substring(1).toLowerCase() : null;

    // Public commands selalu diizinkan
    if (!command || PUBLIC_COMMANDS.includes(command)) return next();

    // Rate limit check (owner exempt)
    if (!isOwner(ctx) && isRateLimited(ctx.from.id)) {
      const lang = await getUserLang(ctx.from.id);
      return ctx.reply(t(lang, 'rate_limited'));
    }

    // Owner selalu bisa akses
    if (isOwner(ctx)) {
      // Track aktivitas owner juga
      if (command) {
        trackCommand(command);
        try { await updateUserActivity(ctx.from.id, command, text.replace(/^\/\S+\s*/, '').trim() || null); } catch {}
      }
      return next();
    }

    // Cek registrasi
    const user = await getUser(ctx.from.id);
    if (!user) {
      const lang = ctx.from.language_code?.startsWith('en') ? 'en' : 'id';
      return ctx.replyWithHTML(t(lang, 'need_register', ctx.from.first_name || 'Sobat FPL'));
    }

    // Tier check — pro commands gated
    const userTier = await getUserTier(ctx.from.id);
    if (command && !isCommandAllowed(userTier, command)) {
      return ctx.replyWithHTML(formatUpgradeMessage(command, userTier));
    }

    // Track aktivitas user terdaftar
    if (command) {
      trackCommand(command);
      try { await updateUserActivity(ctx.from.id, command, text.replace(/^\/\S+\s*/, '').trim() || null); } catch {}
    }

    return next();
  });

  // =====================
  // /start — Welcome & Registrasi
  // =====================
  bot.command('start', async ctx => {
    const user = await getUser(ctx.from.id);
    const arg = ctx.message.text.replace(/^\/start\s*/i, '').trim();

    // Cek apakah ada FPL ID di argumen (registrasi atau update)
    if (arg) {
      const fplId = parseInt(arg);
      if (!fplId || isNaN(fplId)) {
        return ctx.reply('❌ FPL ID harus berupa angka. Contoh: /start 1234567');
      }

      // Validasi FPL ID
      try {
        const manager = await fetchManagerInfo(fplId);
        await registerUser(ctx.from.id, fplId, ctx);

        const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return ctx.replyWithHTML([
          `✅ <b>Registrasi Berhasil!</b>`,
          ``,
          `👤 <b>${esc(manager.player_first_name)} ${esc(manager.player_last_name)}</b>`,
          `📋 ${esc(manager.name)}`,
          `🏆 Overall Rank: ${manager.summary_overall_rank?.toLocaleString() || 'N/A'}`,
          `📊 Total Points: ${manager.summary_overall_points || 0}`,
          ``,
          `FPL ID kamu (<code>${fplId}</code>) sudah tersimpan.`,
          `Sekarang kamu bisa menggunakan semua fitur bot!`,
          ``,
          `Ketik /start lagi untuk melihat daftar perintah.`,
        ].join('\n'));
      } catch (err) {
        if (err.response?.status === 404) {
          return ctx.reply(`❌ FPL ID ${fplId} tidak ditemukan. Pastikan ID-nya benar.`);
        }
        return ctx.reply('❌ Gagal memverifikasi FPL ID. Coba lagi nanti.');
      }
    }

    // User belum terdaftar & tidak kirim FPL ID → tampilkan welcome
    if (!user && !isOwner(ctx)) {
      return ctx.replyWithHTML([
        `👋 <b>Selamat Datang di Mallempu Bot!</b>`,
        ``,
        `Halo <b>${ctx.from.first_name || 'Sobat FPL'}</b>! Bot ini akan membantu kamu:`,
        ``,
        `⚽ Analisa pemain dengan metrik canggih + data 3 musim`,
        `📊 Rekomendasi transfer berdasarkan quality score`,
        `💎 Temukan differential picks tersembunyi`,
        `📰 Update berita FPL dari X & Instagram`,
        `📈 Tren transfer in/out terpopuler`,
        ``,
        `<b>Untuk mulai, daftarkan FPL ID kamu:</b>`,
        `<code>/start [FPL ID]</code>`,
        ``,
        `<b>Contoh:</b> <code>/start 1234567</code>`,
        ``,
        `<b>Cara cari FPL ID:</b>`,
        `1. Buka fantasy.premierleague.com`,
        `2. Login → klik "Points" atau "My Team"`,
        `3. Lihat angka di URL: /entry/<b>XXXXX</b>/event/...`,
        ``,
        `💡 FPL ID bukan username, tapi angka di URL halaman tim kamu.`,
      ].join('\n'));
    }

    // User sudah terdaftar atau owner → tampilkan menu
    const userInfo = user ? ` (FPL ID: <code>${user.fpl_id}</code>)` : '';
    ctx.replyWithHTML([
      `<b>⚽ Mallempu Bot</b>${userInfo}`,
      '',
      '💡 Ketik /help untuk panduan interaktif lengkap.',
      '',
      '<b>📊 Analisa Pemain:</b>',
      '/player &lt;nama&gt; — Detail pemain',
      '/analyze &lt;nama&gt; — Analisa mendalam pemain',
      '/history &lt;nama&gt; — Data historis 3 musim',
      '/compare &lt;A&gt; vs &lt;B&gt; — Bandingkan 2 pemain',
      '/best &lt;posisi&gt; — Top pemain per posisi',
      '/differentials [posisi] — Top differential picks',
      '/regression — Pemain over/underperform vs xG',
      '',
      '<b>👤 Squad & Transfer:</b>',
      '/squad — Lihat squad kamu',
      '/best11 — Starting XI terbaik dari squad kamu',
      '/suggest — Saran transfer terbaik',
      '/trending — Transfer in &amp; out terpopuler',
      '/nettransfer — Net transfer (gainers vs losers)',
      '',
      '<b>📰 Berita & Info:</b>',
      '/news — Berita FPL (X + IG)',
      '/newslist — Daftar akun sumber berita',
      '/fixtures &lt;tim&gt; — Jadwal & FDR',
      '',
      '<b>📋 Watchlist:</b>',
      '/watch &lt;nama&gt; — Tambah ke watchlist',
      '/unwatch &lt;nama&gt; — Hapus dari watchlist',
      '/watchlist — Lihat watchlist',
      '',
      '<b>⚙️ Pengaturan:</b>',
      '/start &lt;FPL ID&gt; — Ubah FPL ID',
      '/settings — Notifikasi &amp; preferensi',
      '/metrics — Konfigurasi metrik scoring',
      '/refresh — Refresh data',
      '/pricing — Lihat paket langganan',
      '/lang &lt;id|en&gt; — Ubah bahasa',
      '/export_data — Export semua data kamu',
      '/delete_account — Hapus akun &amp; data',
      '',
      '<b>🔐 FPL Login (Live Squad):</b>',
      '/fpllogin — Login FPL via browser',
      '/fpltoken — Set token FPL manual',
      '/fpllogout — Hapus sesi FPL',
      ...(isOwner(ctx) ? [
        '',
        '<b>🔒 Admin (@Abulkhaer):</b>',
        '/stats — Bot health dashboard',
        '/users — Dashboard & monitor user',
        '/settier &lt;chat_id&gt; &lt;tier&gt; — Set tier user',
        '/removeuser &lt;chat_id&gt; — Hapus user',
        '/xadd · /xdel — Kelola akun X',
        '/igadd · /igdel — Kelola akun IG',
        '/fplstatus — Cek status FPL login & data',
        '/setenv · /getenv · /delenv · /restart',
        '/refreshhistory — Refresh data historis',
      ] : []),
    ].join('\n'));
  });

  // /help — Panduan lengkap dengan inline keyboard
  bot.command('help', ctx => {
    const { Markup } = require('telegraf');
    ctx.replyWithHTML(
      '<b>📖 Bantuan Mallempu Bot</b>\n\n' +
      'Pilih kategori di bawah untuk melihat panduan:',
      Markup.inlineKeyboard([
        [Markup.button.callback('📊 Analisa Pemain', 'help_analysis')],
        [Markup.button.callback('👤 Squad & Transfer', 'help_squad')],
        [Markup.button.callback('📰 Berita & Info', 'help_news')],
        [Markup.button.callback('📋 Watchlist', 'help_watchlist')],
        [Markup.button.callback('⚙️ Pengaturan', 'help_settings')],
      ])
    );
  });

  // Inline keyboard callback handlers for /help
  bot.action('help_analysis', ctx => {
    ctx.answerCbQuery();
    ctx.editMessageText(
      '<b>📊 Analisa Pemain</b>\n\n' +
      '/player &lt;nama&gt; — Info singkat pemain\n' +
      '/analyze &lt;nama&gt; — Analisa mendalam (xG, regresi, fixture)\n' +
      '/history &lt;nama&gt; — Data historis 3 musim\n' +
      '/compare &lt;A&gt; vs &lt;B&gt; — Bandingkan 2 pemain\n' +
      '/best &lt;GK|DEF|MID|FWD&gt; — Top pemain per posisi\n' +
      '/differentials [posisi] — Differential picks\n' +
      '/regression — Pemain over/underperform vs xG\n\n' +
      '<b>Contoh:</b>\n' +
      '<code>/player Salah</code>\n' +
      '<code>/compare Salah vs Palmer</code>\n' +
      '<code>/best MID</code>',
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '⬅️ Kembali', callback_data: 'help_back' }]] } }
    );
  });

  bot.action('help_squad', ctx => {
    ctx.answerCbQuery();
    ctx.editMessageText(
      '<b>👤 Squad & Transfer</b>\n\n' +
      '/squad [FPL ID] — Lihat squad (opsional: cek squad orang lain)\n' +
      '/best11 [FPL ID] — Starting XI terbaik dari squad\n' +
      '/suggest [FPL ID] — Saran transfer berdasarkan quality score\n' +
      '/trending [in|out] — Transfer terpopuler\n' +
      '/nettransfer — Net transfer (gainers vs losers)\n\n' +
      '<b>Tips:</b> Jika FPL ID sudah terdaftar via /start, cukup ketik tanpa ID.',
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '⬅️ Kembali', callback_data: 'help_back' }]] } }
    );
  });

  bot.action('help_news', ctx => {
    ctx.answerCbQuery();
    ctx.editMessageText(
      '<b>📰 Berita & Info</b>\n\n' +
      '/news — Semua berita FPL (X + Instagram)\n' +
      '/news x — Berita dari X/Twitter saja\n' +
      '/news ig — Berita dari Instagram saja\n' +
      '/news &lt;akun&gt; — Berita dari akun tertentu\n' +
      '/newslist — Daftar akun sumber berita\n' +
      '/fixtures &lt;tim&gt; — Jadwal & FDR tim\n\n' +
      '<b>Contoh:</b>\n' +
      '<code>/news FPLStatus</code>\n' +
      '<code>/fixtures Arsenal</code>',
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '⬅️ Kembali', callback_data: 'help_back' }]] } }
    );
  });

  bot.action('help_watchlist', ctx => {
    ctx.answerCbQuery();
    ctx.editMessageText(
      '<b>📋 Watchlist</b>\n\n' +
      '/watch &lt;nama&gt; — Tambah pemain ke watchlist (maks 20)\n' +
      '/unwatch &lt;nama&gt; — Hapus dari watchlist\n' +
      '/watchlist — Lihat semua pemain di watchlist\n\n' +
      '<b>Notifikasi otomatis:</b>\n' +
      '• Perubahan harga pemain di watchlist\n' +
      '• Perubahan status (cedera/suspensi)\n' +
      '• Update harian skor & form\n\n' +
      'Atur notifikasi via /settings',
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '⬅️ Kembali', callback_data: 'help_back' }]] } }
    );
  });

  bot.action('help_settings', ctx => {
    ctx.answerCbQuery();
    ctx.editMessageText(
      '<b>⚙️ Pengaturan</b>\n\n' +
      '/settings — Lihat & toggle notifikasi\n' +
      '/metrics — Konfigurasi metrik scoring\n' +
      '/refresh — Refresh data dari FPL API\n' +
      '/start &lt;FPL ID&gt; — Ubah FPL ID\n' +
      '/delete_account — Hapus akun & semua data\n' +
      '/export_data — Export semua data kamu\n\n' +
      '<b>Notifikasi yang tersedia:</b>\n' +
      '• Harga — perubahan harga pemain populer\n' +
      '• Status — cedera, suspensi, ketersediaan\n' +
      '• Watchlist — update harian watchlist kamu\n' +
      '• Differentials — ringkasan mingguan (Jumat)',
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '⬅️ Kembali', callback_data: 'help_back' }]] } }
    );
  });

  bot.action('help_back', ctx => {
    const { Markup } = require('telegraf');
    ctx.answerCbQuery();
    ctx.editMessageText(
      '<b>📖 Bantuan Mallempu Bot</b>\n\n' +
      'Pilih kategori di bawah untuk melihat panduan:',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📊 Analisa Pemain', 'help_analysis')],
          [Markup.button.callback('👤 Squad & Transfer', 'help_squad')],
          [Markup.button.callback('📰 Berita & Info', 'help_news')],
          [Markup.button.callback('📋 Watchlist', 'help_watchlist')],
          [Markup.button.callback('⚙️ Pengaturan', 'help_settings')],
        ]),
      }
    );
  });

  // /player <nama>
  bot.command('player', async ctx => {
    const query = ctx.message.text.replace(/^\/player\s*/i, '').trim();
    if (!query) return ctx.reply('Gunakan: /player <nama pemain>');
    if (query.length > 100) return ctx.reply('❌ Nama terlalu panjang.');

    try {
      const { scored } = await getScoredPlayers();
      const result = findPlayer(scored, query);

      if (!result) return ctx.reply(`❌ Pemain "${query}" tidak ditemukan.`);
      if (Array.isArray(result)) {
        const names = result.slice(0, 10).map(p => `• ${p.web_name} (${p.teamData?.short_name || '?'})`);
        return ctx.replyWithHTML(`Ditemukan ${result.length} pemain:\n${names.join('\n')}\n\nCoba lebih spesifik.`);
      }

      ctx.replyWithHTML(fmt.playerCard(result));
    } catch (err) {
      console.error('Error /player:', err.message);
      ctx.reply('❌ Gagal mengambil data. Coba lagi nanti.');
    }
  });

  // /compare <A> vs <B>
  bot.command('compare', async ctx => {
    const text = ctx.message.text.replace(/^\/compare\s*/i, '').trim();
    const parts = text.split(/\s+vs\s+/i);
    if (parts.length !== 2) return ctx.reply('Gunakan: /compare <pemain A> vs <pemain B>');

    try {
      const { scored } = await getScoredPlayers();
      const a = findPlayer(scored, parts[0]);
      const b = findPlayer(scored, parts[1]);

      if (!a || Array.isArray(a)) return ctx.reply(`❌ Pemain "${parts[0]}" tidak ditemukan atau ambigu.`);
      if (!b || Array.isArray(b)) return ctx.reply(`❌ Pemain "${parts[1]}" tidak ditemukan atau ambigu.`);

      ctx.replyWithHTML(fmt.compareCard(a, b));
    } catch (err) {
      console.error('Error /compare:', err.message);
      ctx.reply('❌ Gagal mengambil data.');
    }
  });

  // /best <posisi>
  bot.command('best', async ctx => {
    const posStr = ctx.message.text.replace(/^\/best\s*/i, '').trim();
    const posId = posIdFromStr(posStr);
    if (!posId) return ctx.reply('Gunakan: /best <GK|DEF|MID|FWD>');

    try {
      const { scored } = await getScoredPlayers();
      const filtered = scored
        .filter(p => p.element_type === posId && p.minutes > 0)
        .sort((a, b) => b.scoring.qualityScore - a.scoring.qualityScore);

      const title = `🏆 Top ${POSITION_NAMES[posId]} — Quality Score`;
      ctx.replyWithHTML(fmt.rankingList(filtered, title, 15));
    } catch (err) {
      console.error('Error /best:', err.message);
      ctx.reply('❌ Gagal mengambil data.');
    }
  });

  // /differentials [posisi]
  bot.command('differentials', async ctx => {
    const posStr = ctx.message.text.replace(/^\/differentials\s*/i, '').trim();
    const posId = posStr ? posIdFromStr(posStr) : null;

    try {
      const { scored } = await getScoredPlayers();
      let filtered = scored.filter(p =>
        p.scoring.label === 'DIFFERENTIAL' && p.minutes > 0 && p.scoring.minutesSafe
      );
      if (posId) filtered = filtered.filter(p => p.element_type === posId);

      filtered.sort((a, b) => b.scoring.differentialScore - a.scoring.differentialScore);

      const posLabel = posId ? ` ${POSITION_NAMES[posId]}` : '';
      const title = `💎 Top Differential Picks${posLabel}`;
      ctx.replyWithHTML(fmt.rankingList(filtered, title, 15));
    } catch (err) {
      console.error('Error /differentials:', err.message);
      ctx.reply('❌ Gagal mengambil data.');
    }
  });

  // /fixtures <tim>
  bot.command('fixtures', async ctx => {
    const query = ctx.message.text.replace(/^\/fixtures\s*/i, '').trim();
    if (!query) return ctx.reply('Gunakan: /fixtures <nama tim>');

    try {
      const { scored, teams } = await getScoredPlayers();
      const q = query.toLowerCase();
      const team = Object.values(teams).find(t =>
        t.name.toLowerCase().includes(q) || t.short_name.toLowerCase() === q
      );
      if (!team) return ctx.reply(`❌ Tim "${query}" tidak ditemukan.`);

      const player = scored.find(p => p.team === team.id);
      if (!player || !player.nextFixtures?.length) {
        return ctx.reply(`Tidak ada fixture upcoming untuk ${team.name}.`);
      }

      ctx.replyWithHTML(fmt.fixtureTable(team.name, player.nextFixtures, teams));
    } catch (err) {
      console.error('Error /fixtures:', err.message);
      ctx.reply('❌ Gagal mengambil data.');
    }
  });

  // /regression
  bot.command('regression', async ctx => {
    try {
      const { scored } = await getScoredPlayers();
      const withRegression = scored
        .filter(p => p.scoring.regression && p.minutes >= 270)
        .sort((a, b) => Math.abs(b.scoring.regressionDiff) - Math.abs(a.scoring.regressionDiff));

      const over = withRegression.filter(p => p.scoring.regression === 'OVERPERFORMING');
      const under = withRegression.filter(p => p.scoring.regression === 'UNDERPERFORMING');

      const lines = ['<b>📊 Analisis Regresi (Goals vs xG)</b>\n'];

      lines.push('<b>⚠️ Overperforming (waspada regresi turun):</b>');
      over.slice(0, 8).forEach(p => {
        lines.push(`  • ${p.web_name}: Goals ${p.goals_scored} vs xG ${(parseFloat(p.expected_goals) || 0).toFixed(1)} (${p.scoring.regressionDiff > 0 ? '+' : ''}${p.scoring.regressionDiff})`);
      });

      lines.push('\n<b>💎 Underperforming (potensi regresi naik — beli murah):</b>');
      under.slice(0, 8).forEach(p => {
        lines.push(`  • ${p.web_name}: Goals ${p.goals_scored} vs xG ${(parseFloat(p.expected_goals) || 0).toFixed(1)} (${p.scoring.regressionDiff > 0 ? '+' : ''}${p.scoring.regressionDiff})`);
      });

      ctx.replyWithHTML(lines.join('\n'));
    } catch (err) {
      console.error('Error /regression:', err.message);
      ctx.reply('❌ Gagal mengambil data.');
    }
  });

  // /trending [in|out] — Transfer in/out terpopuler
  bot.command('trending', async ctx => {
    const arg = ctx.message.text.replace(/^\/trending\s*/i, '').trim().toLowerCase();

    try {
      const { scored, currentGw } = await getScoredPlayers();

      if (arg === 'out') {
        const transfersOut = [...scored]
          .filter(p => p.transfers_out_event > 0)
          .sort((a, b) => b.transfers_out_event - a.transfers_out_event);
        ctx.replyWithHTML(fmt.trendingOutCard(transfersOut, currentGw));
      } else {
        // Default: transfer in
        const transfersIn = [...scored]
          .filter(p => p.transfers_in_event > 0)
          .sort((a, b) => b.transfers_in_event - a.transfers_in_event);
        ctx.replyWithHTML(fmt.trendingCard(transfersIn, currentGw));

        // Jika tanpa argumen, kirim juga transfer out sebagai pesan kedua
        if (!arg) {
          const transfersOut = [...scored]
            .filter(p => p.transfers_out_event > 0)
            .sort((a, b) => b.transfers_out_event - a.transfers_out_event);
          ctx.replyWithHTML(fmt.trendingOutCard(transfersOut, currentGw));
        }
      }
    } catch (err) {
      console.error('Error /trending:', err.message);
      ctx.reply('❌ Gagal mengambil data.');
    }
  });

  // /nettransfer — Net transfer (gainers vs losers)
  bot.command('nettransfer', async ctx => {
    try {
      const { scored, currentGw } = await getScoredPlayers();
      ctx.replyWithHTML(fmt.netTransferCard(scored, currentGw));
    } catch (err) {
      console.error('Error /nettransfer:', err.message);
      ctx.reply('❌ Gagal mengambil data.');
    }
  });

  // /watch <nama>
  bot.command('watch', async ctx => {
    const query = ctx.message.text.replace(/^\/watch\s*/i, '').trim();
    if (!query) return ctx.reply('Gunakan: /watch <nama pemain>');

    try {
      const chatId = ctx.from.id;
      const tier = await getUserTier(chatId);
      const limit = getWatchlistLimit(tier);
      const count = await getWatchlistCount(chatId);
      if (count >= limit) {
        return ctx.reply(`❌ Watchlist penuh (maks ${limit} pemain). Hapus pemain dulu dengan /unwatch.${tier === 'free' ? '\n\n💡 Upgrade ke Pro untuk watchlist sampai 20 pemain.' : ''}`);
      }

      const { scored } = await getScoredPlayers();
      const result = findPlayer(scored, query);

      if (!result || Array.isArray(result)) {
        return ctx.reply(`❌ Pemain "${query}" tidak ditemukan atau ambigu.`);
      }

      await addToWatchlist(chatId, result.id, result.web_name);
      ctx.reply(`✅ ${result.web_name} ditambahkan ke watchlist kamu. (${count + 1}/${limit})`);
    } catch (err) {
      console.error('Error /watch:', err.message);
      ctx.reply('❌ Gagal menambahkan.');
    }
  });

  // /unwatch <nama>
  bot.command('unwatch', async ctx => {
    const query = ctx.message.text.replace(/^\/unwatch\s*/i, '').trim();
    if (!query) return ctx.reply('Gunakan: /unwatch <nama pemain>');

    try {
      const { scored } = await getScoredPlayers();
      const result = findPlayer(scored, query);

      if (!result || Array.isArray(result)) {
        return ctx.reply(`❌ Pemain "${query}" tidak ditemukan atau ambigu.`);
      }

      await removeFromWatchlist(ctx.from.id, result.id);
      ctx.reply(`✅ ${result.web_name} dihapus dari watchlist kamu.`);
    } catch (err) {
      console.error('Error /unwatch:', err.message);
      ctx.reply('❌ Gagal menghapus.');
    }
  });

  // /watchlist
  bot.command('watchlist', async ctx => {
    try {
      const chatId = ctx.from.id;
      const list = await getWatchlist(chatId);
      if (list.length === 0) return ctx.reply('📋 Watchlist kosong. Gunakan /watch <nama> untuk menambahkan.');

      const { scored } = await getScoredPlayers();
      const wlLimit = getWatchlistLimit(await getUserTier(chatId));
      const lines = [`<b>📋 Watchlist Kamu (${list.length}/${wlLimit})</b>\n`];
      for (const w of list) {
        const p = scored.find(s => s.id === w.player_id);
        if (p) {
          lines.push(
            `• <b>${p.web_name}</b> (${p.teamData?.short_name || '?'}) — ` +
            `Q:${p.scoring.qualityScore} D:${p.scoring.differentialScore} | ` +
            `${fmt.priceStr(p.now_cost)} | ${p.scoring.label}`
          );
        } else {
          lines.push(`• ${w.player_name} (data tidak tersedia)`);
        }
      }
      lines.push('\n💡 /settings — atur notifikasi watchlist');
      ctx.replyWithHTML(lines.join('\n'));
    } catch (err) {
      console.error('Error /watchlist:', err.message);
      ctx.reply('❌ Gagal memuat watchlist.');
    }
  });

  // /squad [FPL ID]
  bot.command('squad', async ctx => {
    const input = ctx.message.text.replace(/^\/squad\s*/i, '').trim();
    const managerId = parseInt(input) || await getUserFplId(ctx);
    if (!managerId || isNaN(managerId)) {
      return ctx.replyWithHTML(
        'FPL ID belum terdaftar.\n\n' +
        'Gunakan <code>/start [FPL ID]</code> untuk mendaftar.\n' +
        'Atau: <code>/squad [FPL ID]</code> untuk cek squad orang lain.'
      );
    }

    try {
      ctx.reply('⏳ Mengambil data squad...');
      const [manager, { scored, teams, currentGw }, transfers] = await Promise.all([
        fetchManagerInfo(managerId),
        getScoredPlayers(),
        fetchManagerTransfers(managerId).catch(err => {
          console.warn('Transfers fetch failed (non-fatal):', err.message);
          return [];
        }),
      ]);

      // Tentukan GW yang sedang ditampilkan
      const bootstrap = await fetchBootstrap();
      const nextGw = bootstrap.events.find(e => e.is_next)?.id || currentGw;

      let picks;
      let displayGw = currentGw;
      let isProjected = false;
      let isLive = false;

      // 1. Coba ambil live squad via my-team (user harus login dengan akun FPL-nya sendiri)
      const chatId = String(ctx.from.id);
      const user = await getUser(chatId);
      const userFplId = user?.fpl_id;
      // my-team only works with the token owner's own FPL ID
      if (managerId === userFplId && getUserSession(chatId)) {
        try {
          const myTeam = await fetchMyTeam(managerId, chatId);
          if (myTeam?.picks) {
            picks = {
              picks: myTeam.picks,
              entry_history: null, // my-team tidak punya entry_history
            };
            displayGw = nextGw;
            isLive = true;
          }
        } catch (err) {
          console.error('my-team fallback:', err.message);
        }
      }

      // 2. Coba ambil picks: nextGw → currentGw → GW sebelumnya
      const gwsToTry = [];
      if (nextGw > currentGw) gwsToTry.push(nextGw);
      gwsToTry.push(currentGw);
      for (let gw = currentGw - 1; gw >= Math.max(1, currentGw - 3); gw--) {
        gwsToTry.push(gw);
      }

      for (const gw of gwsToTry) {
        if (picks) break;
        try {
          picks = await fetchManagerPicks(managerId, gw);
          displayGw = gw;
        } catch {
          // GW ini tidak tersedia, coba yang berikutnya
        }
      }

      if (!picks) {
        return ctx.reply('❌ Belum ada data squad. Pastikan kamu sudah set squad di aplikasi FPL.');
      }

      // 4. Terapkan transfer pending (jika bukan live data)
      if (!isLive) {
        const pendingTransfers = transfers.filter(t => t.event > displayGw);
        if (pendingTransfers.length > 0 && picks) {
          isProjected = true;
          const updatedPicks = [...picks.picks];
          for (const tr of pendingTransfers) {
            const idx = updatedPicks.findIndex(pk => pk.element === tr.element_out);
            if (idx !== -1) {
              updatedPicks[idx] = { ...updatedPicks[idx], element: tr.element_in };
            }
          }
          picks = { ...picks, picks: updatedPicks };
          displayGw = nextGw;
        }
      }

      let output = fmt.squadCard(manager, picks, scored, teams, displayGw);

      // Tambah info status data
      if (isLive) {
        output += `\n\n✅ <i>Data live — termasuk perubahan lineup & kapten terbaru.</i>`;
      } else if (isProjected) {
        output += `\n\n📌 <i>Squad diproyeksikan dari GW${currentGw} + transfer pending.`;
        output += `\nPerubahan lineup (bench/kapten) belum terlihat.</i>`;
      } else if (nextGw > displayGw) {
        output += `\n\n📌 <i>Menampilkan squad GW${displayGw} (terakhir dikonfirmasi).`;
        output += `\nPerubahan untuk GW${nextGw} terlihat setelah deadline.</i>`;
        // Suggest login if viewing own squad without session
        if (managerId === userFplId && !getUserSession(chatId)) {
          output += `\n\n💡 <i>Gunakan /fpllogin untuk melihat squad live sebelum deadline.</i>`;
        }
      }

      ctx.replyWithHTML(output);
    } catch (err) {
      console.error('Error /squad:', err.message, err.stack);
      if (err.response?.status === 404) {
        return ctx.reply(`❌ FPL ID ${managerId} tidak ditemukan. Pastikan ID-nya benar.`);
      }
      ctx.reply('❌ Gagal mengambil data squad. Coba lagi nanti.');
    }
  });

  // /best11 [FPL ID]
  bot.command('best11', async ctx => {
    const input = ctx.message.text.replace(/^\/best11\s*/i, '').trim();
    const managerId = parseInt(input) || await getUserFplId(ctx);
    if (!managerId || isNaN(managerId)) {
      return ctx.replyWithHTML(
        'FPL ID belum terdaftar.\n\n' +
        'Gunakan <code>/start [FPL ID]</code> untuk mendaftar.\n' +
        'Atau: <code>/best11 [FPL ID]</code>'
      );
    }

    try {
      ctx.reply('⏳ Menghitung Best Starting XI...');
      const [manager, { scored, teams, currentGw }] = await Promise.all([
        fetchManagerInfo(managerId),
        getScoredPlayers(),
      ]);

      const bootstrap = await fetchBootstrap();
      const nextGw = bootstrap.events.find(e => e.is_next)?.id || currentGw;

      // Get current picks
      let picks;
      let displayGw = currentGw;

      const chatId = String(ctx.from.id);
      const user = await getUser(chatId);
      const userFplId = user?.fpl_id;
      if (managerId === userFplId && getUserSession(chatId)) {
        try {
          const myTeam = await fetchMyTeam(managerId, chatId);
          if (myTeam?.picks) {
            picks = { picks: myTeam.picks };
            displayGw = nextGw;
          }
        } catch {}
      }

      if (!picks) {
        const gwsToTry = [];
        if (nextGw > currentGw) gwsToTry.push(nextGw);
        gwsToTry.push(currentGw);
        for (let gw = currentGw - 1; gw >= Math.max(1, currentGw - 3); gw--) {
          gwsToTry.push(gw);
        }
        for (const gw of gwsToTry) {
          if (picks) break;
          try {
            picks = await fetchManagerPicks(managerId, gw);
            displayGw = gw;
          } catch {}
        }
      }

      if (!picks) {
        return ctx.reply('❌ Belum ada data squad.');
      }

      // Get squad players with scores
      const squadPlayers = picks.picks.map(pick => {
        const p = scored.find(sp => sp.id === pick.element);
        if (!p) return null;
        return { ...p, currentPosition: pick.position };
      }).filter(Boolean);

      if (squadPlayers.length < 15) {
        return ctx.reply('❌ Squad tidak lengkap — tidak bisa menghitung Best XI.');
      }

      // Valid formations: [DEF, MID, FWD]
      const FORMATIONS = [
        [3, 4, 3], [3, 5, 2],
        [4, 3, 3], [4, 4, 2], [4, 5, 1],
        [5, 3, 2], [5, 4, 1],
      ];

      // Group by position
      const byPos = { 1: [], 2: [], 3: [], 4: [] };
      for (const p of squadPlayers) {
        byPos[p.element_type].push(p);
      }
      // Sort each position group by quality score descending
      for (const pos of [1, 2, 3, 4]) {
        byPos[pos].sort((a, b) => b.scoring.qualityScore - a.scoring.qualityScore);
      }

      // Find best formation
      let bestFormation = null;
      let bestScore = -1;
      let bestStarting = null;

      for (const [nDef, nMid, nFwd] of FORMATIONS) {
        if (byPos[2].length < nDef || byPos[3].length < nMid || byPos[4].length < nFwd) continue;

        const gk = byPos[1][0]; // Best GK
        const defs = byPos[2].slice(0, nDef);
        const mids = byPos[3].slice(0, nMid);
        const fwds = byPos[4].slice(0, nFwd);

        const starting = [gk, ...defs, ...mids, ...fwds];

        // Penalize unavailable players
        const totalScore = starting.reduce((sum, p) => {
          let qs = p.scoring.qualityScore;
          if (p.status === 'i' || p.status === 'u' || p.status === 's') qs *= 0.1;
          else if (p.status === 'd') qs *= 0.7;
          return sum + qs;
        }, 0);

        if (totalScore > bestScore) {
          bestScore = totalScore;
          bestFormation = `${nDef}-${nMid}-${nFwd}`;
          bestStarting = starting;
        }
      }

      if (!bestStarting) {
        return ctx.reply('❌ Tidak bisa menemukan formasi valid.');
      }

      // Determine bench (players not in starting XI)
      const startingIds = new Set(bestStarting.map(p => p.id));
      const bench = squadPlayers
        .filter(p => !startingIds.has(p.id))
        .sort((a, b) => {
          // GK bench goes last
          if (a.element_type === 1 && b.element_type !== 1) return 1;
          if (a.element_type !== 1 && b.element_type === 1) return -1;
          return b.scoring.qualityScore - a.scoring.qualityScore;
        });

      // Captain = highest quality score in starting XI (prefer attackers for tiebreak)
      const captainCandidates = [...bestStarting]
        .sort((a, b) => {
          const aDiff = b.scoring.qualityScore - a.scoring.qualityScore;
          if (aDiff !== 0) return aDiff;
          return b.element_type - a.element_type; // prefer FWD > MID > DEF
        });
      captainCandidates[0].isCaptain = true;
      captainCandidates[1].isViceCaptain = true;

      // Detect changes from current lineup
      const currentStartingIds = new Set(
        picks.picks.filter(pk => pk.position <= 11).map(pk => pk.element)
      );
      const changes = [];
      for (const p of bestStarting) {
        if (!currentStartingIds.has(p.id)) {
          changes.push(`${p.web_name} masuk Starting XI`);
        }
      }
      for (const p of bench) {
        if (currentStartingIds.has(p.id)) {
          changes.push(`${p.web_name} ke Bench`);
        }
      }
      // Captain change
      const currentCaptain = picks.picks.find(pk => pk.is_captain);
      if (currentCaptain && currentCaptain.element !== captainCandidates[0].id) {
        const oldCap = scored.find(sp => sp.id === currentCaptain.element);
        changes.push(`Kapten: ${oldCap?.web_name || '?'} → ${captainCandidates[0].web_name}`);
      }

      const result = {
        formation: bestFormation,
        totalScore: Math.round(bestScore),
        starting: bestStarting,
        bench,
        changes: changes.length > 0 ? changes : null,
      };

      ctx.replyWithHTML(fmt.bestXICard(manager, result, displayGw));
    } catch (err) {
      console.error('Error /best11:', err.message, err.stack);
      if (err.response?.status === 404) {
        return ctx.reply(`❌ FPL ID ${managerId} tidak ditemukan.`);
      }
      ctx.reply('❌ Gagal menghitung Best XI. Coba lagi nanti.');
    }
  });

  // /suggest [FPL ID]
  bot.command('suggest', async ctx => {
    const input = ctx.message.text.replace(/^\/suggest\s*/i, '').trim();
    const managerId = parseInt(input) || await getUserFplId(ctx);
    if (!managerId || isNaN(managerId)) {
      return ctx.replyWithHTML(
        'FPL ID belum terdaftar.\n\n' +
        'Gunakan <code>/start [FPL ID]</code> untuk mendaftar.\n' +
        'Atau: <code>/suggest [FPL ID]</code>'
      );
    }

    try {
      ctx.reply('⏳ Menganalisa squad & mencari transfer terbaik...');
      const [manager, { scored, teams, currentGw }, transfers] = await Promise.all([
        fetchManagerInfo(managerId),
        getScoredPlayers(),
        fetchManagerTransfers(managerId).catch(err => {
          console.warn('Transfers fetch failed (non-fatal):', err.message);
          return [];
        }),
      ]);

      const bootstrap = await fetchBootstrap();
      const nextGw = bootstrap.events.find(e => e.is_next)?.id || currentGw;

      let picks;
      let isLive = false;

      // Try live squad via per-user session
      const chatId = String(ctx.from.id);
      const user = await getUser(chatId);
      const userFplId = user?.fpl_id;
      if (managerId === userFplId && getUserSession(chatId)) {
        try {
          const myTeam = await fetchMyTeam(managerId, chatId);
          if (myTeam?.picks) {
            picks = { picks: myTeam.picks, entry_history: null };
            isLive = true;
          }
        } catch {}
      }

      if (!picks) {
        const gwsToTry = [];
        if (nextGw > currentGw) gwsToTry.push(nextGw);
        gwsToTry.push(currentGw);
        for (let gw = currentGw - 1; gw >= Math.max(1, currentGw - 3); gw--) {
          gwsToTry.push(gw);
        }
        for (const gw of gwsToTry) {
          if (picks) break;
          try { picks = await fetchManagerPicks(managerId, gw); } catch {}
        }
      }
      if (!picks) {
        return ctx.reply('❌ Belum ada data squad. Pastikan kamu sudah set squad di aplikasi FPL.');
      }

      // Terapkan transfer pending (skip if live data)
      const picksGw = picks.entry_history?.event || currentGw;
      const pendingTransfers = isLive ? [] : transfers.filter(t => t.event > picksGw);
      if (pendingTransfers.length > 0) {
        const updatedPicks = [...picks.picks];
        for (const tr of pendingTransfers) {
          const idx = updatedPicks.findIndex(pk => pk.element === tr.element_out);
          if (idx !== -1) {
            updatedPicks[idx] = { ...updatedPicks[idx], element: tr.element_in };
          }
        }
        picks = { ...picks, picks: updatedPicks };
      }

      const bank = (picks.entry_history?.bank || 0);
      const squadPlayerIds = new Set(picks.picks.map(pk => pk.element));
      const squadPlayers = picks.picks.map(pk => scored.find(p => p.id === pk.element)).filter(Boolean);

      // Hitung jumlah pemain per tim di squad
      const teamCount = {};
      for (const p of squadPlayers) {
        teamCount[p.team] = (teamCount[p.team] || 0) + 1;
      }

      // Pre-build index per posisi (O(n) sekali, bukan O(n) per iterasi)
      const candidatesByPos = { 1: [], 2: [], 3: [], 4: [] };
      const trendBonus = (p) => {
        if (!p.scoring.trendData) return 0;
        if (p.scoring.trendData.trendLabel === 'IMPROVING') return 5;
        if (p.scoring.trendData.trendLabel === 'DECLINING') return -5;
        return 0;
      };
      for (const p of scored) {
        if (p.minutes > 0 && p.scoring.minutesSafe && !squadPlayerIds.has(p.id) && candidatesByPos[p.element_type]) {
          candidatesByPos[p.element_type].push(p);
        }
      }
      // Pre-sort each position group by quality + trend
      for (const pos of [1, 2, 3, 4]) {
        candidatesByPos[pos].sort((a, b) =>
          (b.scoring.qualityScore + trendBonus(b)) - (a.scoring.qualityScore + trendBonus(a))
        );
      }

      // Cari pemain terlemah per posisi (dari starting XI)
      const startingIds = new Set(picks.picks.filter(pk => pk.position <= 11).map(pk => pk.element));
      const startingPlayers = squadPlayers.filter(p => startingIds.has(p.id));

      const suggestions = [];

      // Sort starting players by quality score (worst first)
      const weakest = [...startingPlayers].sort((a, b) => a.scoring.qualityScore - b.scoring.qualityScore);

      for (const out of weakest.slice(0, 5)) {
        const budget = out.now_cost + bank;

        // Cari pengganti terbaik dari pre-built index
        const best = candidatesByPos[out.element_type].find(p =>
          p.now_cost <= budget &&
          (teamCount[p.team] || 0) < 3 &&
          p.scoring.qualityScore > out.scoring.qualityScore
        );
        if (!best) continue;

        const scoreDiff = best.scoring.qualityScore - out.scoring.qualityScore;
        if (scoreDiff < 5) continue; // minimal peningkatan signifikan

        // Buat alasan
        const reasons = [];
        if (best.scoring.components.fixture > out.scoring.components.fixture + 0.1) {
          reasons.push('fixture lebih mudah');
        }
        if (parseFloat(best.form) > parseFloat(out.form)) {
          reasons.push('form lebih baik');
        }
        if (best.scoring.label === 'DIFFERENTIAL') {
          reasons.push('differential pick');
        }
        if (!out.scoring.minutesSafe) {
          reasons.push(`${out.web_name} risiko rotasi`);
        }
        // Regression — termasuk label historis baru
        if (out.scoring.regression === 'OVERPERFORMING') {
          reasons.push(`${out.web_name} overperforming`);
        }
        if (best.scoring.regression === 'UNDERPERFORMING') {
          reasons.push(`${best.web_name} potensi regresi naik`);
        }
        if (best.scoring.regression === 'CLINICAL_FINISHER') {
          reasons.push(`${best.web_name} clinical finisher (multi-musim)`);
        }
        // Trend historis
        if (best.scoring.trendData?.trendLabel === 'IMPROVING') {
          reasons.push(`${best.web_name} tren naik ${best.scoring.trendData.seasonsCount} musim`);
        }
        if (out.scoring.trendData?.trendLabel === 'DECLINING') {
          reasons.push(`${out.web_name} tren menurun`);
        }
        if (best.scoring.trendData?.consistency >= 80) {
          reasons.push(`${best.web_name} sangat konsisten`);
        }
        if (out.scoring.regression === 'POOR_FINISHER') {
          reasons.push(`${out.web_name} poor finisher (multi-musim)`);
        }

        // Trend info untuk tampilan
        const outTrend = out.scoring.trendData;
        const inTrend = best.scoring.trendData;

        suggestions.push({
          out: {
            web_name: out.web_name,
            teamShort: out.teamData?.short_name || '?',
            qualityScore: out.scoring.qualityScore,
            nowCost: out.now_cost,
            trendLabel: outTrend?.trendLabel || null,
            trendScore: outTrend?.trendScore || null,
            consistency: outTrend?.consistency || null,
          },
          in: {
            web_name: best.web_name,
            teamShort: best.teamData?.short_name || '?',
            qualityScore: best.scoring.qualityScore,
            nowCost: best.now_cost,
            trendLabel: inTrend?.trendLabel || null,
            trendScore: inTrend?.trendScore || null,
            consistency: inTrend?.consistency || null,
          },
          scoreDiff,
          costDiff: out.now_cost - best.now_cost,
          reason: reasons.length > 0 ? reasons.join(', ') : 'quality score jauh lebih tinggi',
        });
      }

      // Sort by score improvement, take top 3
      suggestions.sort((a, b) => b.scoreDiff - a.scoreDiff);
      const top = suggestions.slice(0, 3);

      // Kumpulkan nama pemain yang relevan untuk cek berita
      const relevantNames = [];
      for (const s of top) {
        relevantNames.push(s.out.web_name, s.in.web_name);
      }
      // Tambah semua pemain squad juga
      for (const p of squadPlayers) {
        if (!relevantNames.includes(p.web_name)) {
          relevantNames.push(p.web_name);
        }
      }

      // Fetch berita terkait pemain
      let newsSection = '';
      try {
        const intel = await fetchNewsIntel(relevantNames);
        newsSection = formatNewsIntel(intel);
      } catch (err) {
        console.error('News intel error:', err.message);
      }

      const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const header = `<b>👤 ${esc(manager.player_first_name)} ${esc(manager.player_last_name)}</b> — ${esc(manager.name)}\n💰 Bank: £${(bank / 10).toFixed(1)}m\n\n`;
      ctx.replyWithHTML(header + fmt.transferSuggestions(top) + newsSection, { disable_web_page_preview: true });
    } catch (err) {
      console.error('Error /suggest:', err.message, err.stack);
      if (err.response?.status === 404) {
        return ctx.reply(`❌ FPL ID ${managerId} tidak ditemukan.`);
      }
      ctx.reply('❌ Gagal menganalisa squad. Coba lagi nanti.');
    }
  });

  // /news [platform] [akun]
  bot.command('news', async ctx => {
    const args = ctx.message.text.replace(/^\/news\s*/i, '').trim();

    try {
      // Parse: /news, /news x, /news ig, /news x FPLStatus, /news ig officialfpl, /news FPLStatus
      const parts = args.split(/\s+/);
      const firstArg = parts[0]?.toLowerCase();
      let platform = null;
      let query = null;

      if (['x', 'twitter'].includes(firstArg)) {
        platform = 'x';
        query = parts.slice(1).join(' ') || null;
      } else if (['ig', 'instagram', 'insta'].includes(firstArg)) {
        platform = 'ig';
        query = parts.slice(1).join(' ') || null;
      } else if (firstArg) {
        query = args;
      }

      ctx.reply(`⏳ Mengambil berita${platform ? ` dari ${platform === 'x' ? 'X' : 'Instagram'}` : ''}...`);

      if (query) {
        const result = await fetchAccountNews(query, platform);
        // IG dengan gambar
        if (result && result.platform === 'IG' && result.posts.length > 0) {
          await sendIgPostsWithImages(ctx, [result]);
        } else {
          ctx.replyWithHTML(formatSingleAccount(result), { disable_web_page_preview: true });
        }
      } else if (platform === 'x') {
        const results = await fetchAllFplNews();
        ctx.replyWithHTML(formatNews(results), { disable_web_page_preview: true });
      } else if (platform === 'ig') {
        const results = await fetchAllInstagramNews();
        if (results.length > 0) {
          await sendIgPostsWithImages(ctx, results);
        } else {
          ctx.reply('❌ Tidak bisa mengambil berita Instagram saat ini.');
        }
      } else {
        // Semua platform — X sebagai text, IG dengan gambar
        const [xResults, igResults] = await Promise.all([
          fetchAllFplNews(),
          fetchAllInstagramNews(),
        ]);
        if (xResults.length > 0) {
          ctx.replyWithHTML(formatNews(xResults), { disable_web_page_preview: true });
        }
        if (igResults.length > 0) {
          await sendIgPostsWithImages(ctx, igResults);
        }
        if (xResults.length === 0 && igResults.length === 0) {
          ctx.reply('❌ Tidak bisa mengambil berita saat ini. Coba lagi nanti.');
        }
      }
    } catch (err) {
      console.error('Error /news:', err.message);
      ctx.reply('❌ Gagal mengambil berita. Coba lagi nanti.');
    }
  });

  // /newslist — Lihat daftar akun sumber berita
  // /newslist — Lihat daftar akun sumber berita (semua user)
  bot.command('newslist', ctx => {
    const xAccounts = getAccountsX();
    const igAccounts = getAccountsIG();

    const lines = ['<b>📰 Daftar Akun Sumber Berita</b>\n'];

    lines.push('<b>🐦 X/Twitter:</b>');
    if (xAccounts.length === 0) {
      lines.push('  <i>Belum ada akun</i>');
    } else {
      xAccounts.forEach((a, i) => lines.push(`  ${i + 1}. ${a.username}`));
    }

    lines.push('\n<b>📸 Instagram:</b>');
    if (igAccounts.length === 0) {
      lines.push('  <i>Belum ada akun</i>');
    } else {
      igAccounts.forEach((a, i) => lines.push(`  ${i + 1}. ${a.username}`));
    }

    if (isOwner(ctx)) {
      lines.push('\n<b>⚙️ Kelola Akun (Owner):</b>');
      lines.push('/xadd &lt;username&gt; — Tambah akun X');
      lines.push('/xdel &lt;username&gt; — Hapus akun X');
      lines.push('/igadd &lt;username&gt; — Tambah akun IG');
      lines.push('/igdel &lt;username&gt; — Hapus akun IG');
    }

    ctx.replyWithHTML(lines.join('\n'));
  });

  // --- Helper: update akun di env & .env file ---
  function updateAccountEnv(key, accounts) {
    const value = accounts.join(',');
    process.env[key] = value;
    // Persist ke .env file (atomic write)
    try {
      const fs = require('fs');
      const path = require('path');
      const envPath = path.join(__dirname, '..', '.env');
      if (fs.existsSync(envPath)) {
        let content = fs.readFileSync(envPath, 'utf-8');
        const regex = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=.*$`, 'm');
        if (regex.test(content)) {
          content = content.replace(regex, `${key}=${value}`);
        } else {
          content = content.trimEnd() + `\n${key}=${value}\n`;
        }
        const tmpPath = envPath + '.tmp';
        fs.writeFileSync(tmpPath, content, 'utf-8');
        fs.renameSync(tmpPath, envPath);
      }
    } catch (err) {
      console.error('Error saving .env:', err.message);
    }
  }

  function getCurrentUsernames(envKey, getterFn) {
    return getterFn().map(a => a.username);
  }

  // /xadd <username> — Tambah akun X (owner only)
  bot.command('xadd', ctx => {
    if (!isOwner(ctx)) return ctx.reply('🚫 Hanya pemilik bot.');
    const username = ctx.message.text.replace(/^\/xadd\s*/i, '').trim().replace(/^@/, '');
    if (!username) return ctx.reply('Gunakan: /xadd <username>');

    const current = getCurrentUsernames('X_ACCOUNTS', getAccountsX);
    if (current.map(u => u.toLowerCase()).includes(username.toLowerCase())) {
      return ctx.reply(`⚠️ ${username} sudah ada di daftar X.`);
    }
    current.push(username);
    updateAccountEnv('X_ACCOUNTS', current);
    ctx.replyWithHTML(`✅ <b>${username}</b> ditambahkan ke sumber X.\n\nTotal: ${current.length} akun`);
  });

  // /xdel <username> — Hapus akun X (owner only)
  bot.command('xdel', ctx => {
    if (!isOwner(ctx)) return ctx.reply('🚫 Hanya pemilik bot.');
    const username = ctx.message.text.replace(/^\/xdel\s*/i, '').trim().replace(/^@/, '');
    if (!username) return ctx.reply('Gunakan: /xdel <username>');

    const current = getCurrentUsernames('X_ACCOUNTS', getAccountsX);
    const idx = current.findIndex(u => u.toLowerCase() === username.toLowerCase());
    if (idx === -1) return ctx.reply(`❌ ${username} tidak ada di daftar X.`);

    const removed = current.splice(idx, 1)[0];
    updateAccountEnv('X_ACCOUNTS', current);
    ctx.replyWithHTML(`✅ <b>${removed}</b> dihapus dari sumber X.\n\nSisa: ${current.length} akun`);
  });

  // /igadd <username> — Tambah akun IG (owner only)
  bot.command('igadd', ctx => {
    if (!isOwner(ctx)) return ctx.reply('🚫 Hanya pemilik bot.');
    const username = ctx.message.text.replace(/^\/igadd\s*/i, '').trim().replace(/^@/, '');
    if (!username) return ctx.reply('Gunakan: /igadd <username>');

    const current = getCurrentUsernames('IG_ACCOUNTS', getAccountsIG);
    if (current.map(u => u.toLowerCase()).includes(username.toLowerCase())) {
      return ctx.reply(`⚠️ ${username} sudah ada di daftar IG.`);
    }
    current.push(username);
    updateAccountEnv('IG_ACCOUNTS', current);
    ctx.replyWithHTML(`✅ <b>${username}</b> ditambahkan ke sumber IG.\n\nTotal: ${current.length} akun`);
  });

  // /igdel <username> — Hapus akun IG (owner only)
  bot.command('igdel', ctx => {
    if (!isOwner(ctx)) return ctx.reply('🚫 Hanya pemilik bot.');
    const username = ctx.message.text.replace(/^\/igdel\s*/i, '').trim().replace(/^@/, '');
    if (!username) return ctx.reply('Gunakan: /igdel <username>');

    const current = getCurrentUsernames('IG_ACCOUNTS', getAccountsIG);
    const idx = current.findIndex(u => u.toLowerCase() === username.toLowerCase());
    if (idx === -1) return ctx.reply(`❌ ${username} tidak ada di daftar IG.`);

    const removed = current.splice(idx, 1)[0];
    updateAccountEnv('IG_ACCOUNTS', current);
    ctx.replyWithHTML(`✅ <b>${removed}</b> dihapus dari sumber IG.\n\nSisa: ${current.length} akun`);
  });

  // /metrics — lihat dan kelola metrik scoring
  bot.command('metrics', async ctx => {
    const args = ctx.message.text.replace(/^\/metrics\s*/i, '').trim();
    const parts = args.split(/\s+/);
    const action = parts[0]?.toLowerCase();

    // /metrics — tampilkan konfigurasi saat ini
    if (!action) {
      const active = getActiveMetrics();
      const weights = getPositionWeights();
      const lines = ['<b>⚙️ Konfigurasi Metrik Scoring</b>\n'];

      for (const metric of ALL_METRICS) {
        const isOn = active.includes(metric);
        const icon = isOn ? '✅' : '❌';
        lines.push(`${icon} <b>${metric.toUpperCase()}</b> — ${METRIC_LABELS[metric]}`);
        if (isOn) {
          const w = [1, 2, 3, 4].map(pos =>
            `${POSITION_NAMES[pos]}:${Math.round(weights[pos][metric] * 100)}%`
          ).join(' · ');
          lines.push(`      ${w}`);
        }
        lines.push('');
      }

      lines.push('<b>Perintah:</b>');
      lines.push('<code>/metrics on &lt;metric&gt;</code> — Aktifkan metrik');
      lines.push('<code>/metrics off &lt;metric&gt;</code> — Nonaktifkan metrik');
      lines.push('<code>/metrics weight &lt;metric&gt; &lt;GK&gt; &lt;DEF&gt; &lt;MID&gt; &lt;FWD&gt;</code>');
      lines.push('<code>/metrics reset</code> — Reset ke default');
      lines.push('\n<i>Metrik: xgi, form, fixture, minutes, value, def</i>');

      return ctx.replyWithHTML(lines.join('\n'));
    }

    // Modifikasi metrik hanya untuk owner
    if (['on', 'off', 'weight', 'reset'].includes(action) && !isOwner(ctx)) {
      return ctx.reply('🚫 Hanya pemilik bot yang bisa mengubah konfigurasi metrik.');
    }

    // /metrics on <metric>
    if (action === 'on') {
      const metric = parts[1]?.toLowerCase();
      if (!metric || !ALL_METRICS.includes(metric)) {
        return ctx.reply(`❌ Metrik tidak valid. Pilih: ${ALL_METRICS.join(', ')}`);
      }
      const active = getActiveMetrics();
      if (active.includes(metric)) return ctx.reply(`✅ ${metric.toUpperCase()} sudah aktif.`);
      active.push(metric);
      process.env.METRICS_ACTIVE = active.join(',');
      cachedScored = null; cacheTs = 0; cachePromise = null;
      return ctx.reply(`✅ ${metric.toUpperCase()} diaktifkan. Data akan di-recalculate.`);
    }

    // /metrics off <metric>
    if (action === 'off') {
      const metric = parts[1]?.toLowerCase();
      if (!metric || !ALL_METRICS.includes(metric)) {
        return ctx.reply(`❌ Metrik tidak valid. Pilih: ${ALL_METRICS.join(', ')}`);
      }
      const active = getActiveMetrics().filter(m => m !== metric);
      if (active.length === 0) return ctx.reply('❌ Tidak bisa menonaktifkan semua metrik.');
      process.env.METRICS_ACTIVE = active.join(',');
      cachedScored = null; cacheTs = 0; cachePromise = null;
      return ctx.reply(`❌ ${metric.toUpperCase()} dinonaktifkan. Data akan di-recalculate.`);
    }

    // /metrics weight <metric> <GK> <DEF> <MID> <FWD>
    if (action === 'weight') {
      const metric = parts[1]?.toLowerCase();
      if (!metric || !ALL_METRICS.includes(metric)) {
        return ctx.reply(`❌ Metrik tidak valid. Pilih: ${ALL_METRICS.join(', ')}`);
      }
      if (parts.length < 6) {
        return ctx.replyWithHTML(
          `<b>Format:</b> <code>/metrics weight ${metric} GK DEF MID FWD</code>\n\n` +
          `Contoh: <code>/metrics weight xgi 5 15 32 38</code>\n` +
          `<i>Nilai dalam persen (0-100). Akan di-normalize otomatis.</i>`
        );
      }
      const vals = parts.slice(2, 6).map(Number);
      if (vals.some(isNaN)) return ctx.reply('❌ Semua nilai harus angka.');

      // Update env
      const currentWeights = process.env.METRICS_WEIGHTS || '';
      const entries = currentWeights ? currentWeights.split(',').filter(e => !e.startsWith(metric + ':')) : [];
      entries.push(`${metric}:${vals.join(':')}`);
      process.env.METRICS_WEIGHTS = entries.join(',');
      cachedScored = null; cacheTs = 0; cachePromise = null;

      return ctx.replyWithHTML(
        `✅ <b>${metric.toUpperCase()}</b> weights updated:\n` +
        `GK:${vals[0]}% · DEF:${vals[1]}% · MID:${vals[2]}% · FWD:${vals[3]}%\n\n` +
        `<i>Data akan di-recalculate otomatis.</i>`
      );
    }

    // /metrics reset
    if (action === 'reset') {
      delete process.env.METRICS_ACTIVE;
      delete process.env.METRICS_WEIGHTS;
      cachedScored = null; cacheTs = 0; cachePromise = null;
      return ctx.reply('✅ Metrik di-reset ke default. Data akan di-recalculate.');
    }

    ctx.reply('❓ Perintah tidak dikenal. Ketik /metrics untuk lihat opsi.');
  });

  // /settings — Notifikasi & preferensi user
  bot.command('settings', async ctx => {
    const chatId = ctx.from.id;
    const prefs = await getUserPreferences(chatId);
    const args = ctx.message.text.replace(/^\/settings\s*/i, '').trim().toLowerCase();

    // Toggle a preference
    if (args) {
      const toggleMap = {
        'prices': 'notify_prices',
        'harga': 'notify_prices',
        'status': 'notify_status',
        'watchlist': 'notify_watchlist',
        'differentials': 'notify_differentials',
        'differential': 'notify_differentials',
      };

      const prefKey = toggleMap[args];
      if (!prefKey) {
        return ctx.reply(`❌ Opsi tidak dikenal: "${args}"\n\nGunakan: /settings <prices|status|watchlist|differentials>`);
      }

      const currentVal = prefs[prefKey];
      const newVal = currentVal ? 0 : 1;
      await updateUserPreference(chatId, prefKey, newVal);
      const label = newVal ? '✅ ON' : '❌ OFF';
      return ctx.reply(`${label} — Notifikasi ${args} ${newVal ? 'diaktifkan' : 'dinonaktifkan'}.`);
    }

    // Show current preferences
    const on = (v) => v ? '✅ ON' : '❌ OFF';
    const tier = await getUserTier(chatId);
    const tierInfo = formatTierInfo(tier);
    const wlLimit = getWatchlistLimit(tier);
    ctx.replyWithHTML([
      '<b>⚙️ Pengaturan Notifikasi</b>\n',
      `📊 Tier: ${tierInfo}`,
      `🌐 Bahasa: ${prefs.lang === 'en' ? '🇬🇧 English' : '🇮🇩 Indonesia'}`,
      '',
      `${on(prefs.notify_prices)} <b>Harga</b> — Perubahan harga pemain populer`,
      `${on(prefs.notify_status)} <b>Status</b> — Cedera, suspensi, ketersediaan`,
      `${on(prefs.notify_watchlist)} <b>Watchlist</b> — Update harian pemain di watchlist kamu`,
      `${on(prefs.notify_differentials)} <b>Differentials</b> — Ringkasan mingguan (Jumat)`,
      '',
      '<b>Toggle notifikasi:</b>',
      '<code>/settings prices</code> — Toggle harga',
      '<code>/settings status</code> — Toggle status',
      '<code>/settings watchlist</code> — Toggle watchlist',
      '<code>/settings differentials</code> — Toggle differentials',
      '',
      `📋 Watchlist: ${await getWatchlistCount(chatId)}/${wlLimit} pemain`,
      tier === 'free' ? '\n💡 /pricing — lihat paket upgrade' : '',
    ].join('\n'));
  });

  // /pricing — Lihat paket langganan
  bot.command('pricing', ctx => {
    ctx.replyWithHTML(formatTierList());
  });

  // /lang — Ubah bahasa (ID/EN)
  bot.command('lang', async ctx => {
    const chatId = ctx.from.id;
    const arg = ctx.message.text.replace(/^\/lang\s*/i, '').trim().toLowerCase();
    const currentLang = await getUserLang(chatId);

    if (!arg) {
      return ctx.replyWithHTML(t(currentLang, 'lang_usage'));
    }

    const supported = getSupportedLanguages();
    if (!supported.includes(arg)) {
      return ctx.replyWithHTML(t(currentLang, 'lang_usage'));
    }

    await setUserLang(chatId, arg);
    ctx.replyWithHTML(t(arg, 'lang_changed', arg));
  });

  // /delete_account — Hapus akun sendiri dan semua data
  bot.command('delete_account', async ctx => {
    const { Markup } = require('telegraf');
    const user = await getUser(ctx.from.id);
    if (!user) return ctx.reply('❌ Kamu belum terdaftar.');

    ctx.replyWithHTML(
      '<b>⚠️ Hapus Akun</b>\n\n' +
      'Ini akan menghapus <b>semua data kamu</b>:\n' +
      '• Profil & FPL ID\n' +
      '• Watchlist\n' +
      '• Preferensi notifikasi\n' +
      '• Riwayat aktivitas\n\n' +
      '<b>Tindakan ini tidak bisa dibatalkan.</b>',
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ Ya, hapus akun saya', 'confirm_delete_account')],
        [Markup.button.callback('❌ Batal', 'cancel_delete_account')],
      ])
    );
  });

  bot.action('confirm_delete_account', async ctx => {
    ctx.answerCbQuery();
    const chatId = ctx.from.id;
    const user = await getUser(chatId);
    if (!user) {
      return ctx.editMessageText('❌ Akun tidak ditemukan.');
    }
    clearUserSession(String(chatId));
    await deleteUser(chatId);
    ctx.editMessageText(
      '✅ Akun dan semua data kamu berhasil dihapus.\n\n' +
      'Kamu bisa mendaftar lagi kapan saja dengan /start <FPL ID>.'
    );
  });

  bot.action('cancel_delete_account', ctx => {
    ctx.answerCbQuery();
    ctx.editMessageText('👍 Penghapusan akun dibatalkan.');
  });

  // /export_data — Export semua data user
  bot.command('export_data', async ctx => {
    const chatId = ctx.from.id;
    const user = await getUser(chatId);
    if (!user) return ctx.reply('❌ Kamu belum terdaftar.');

    const watchlist = await getWatchlist(chatId);
    const prefs = await getUserPreferences(chatId);
    const activity = await getUserActivity(chatId, 100);

    const exportData = {
      exported_at: new Date().toISOString(),
      profile: {
        chat_id: user.chat_id,
        fpl_id: user.fpl_id,
        username: user.username,
        first_name: user.first_name,
        last_name: user.last_name,
        registered_at: user.registered_at,
        last_seen: user.last_seen,
        command_count: user.command_count,
      },
      preferences: {
        notify_prices: !!prefs.notify_prices,
        notify_status: !!prefs.notify_status,
        notify_watchlist: !!prefs.notify_watchlist,
        notify_differentials: !!prefs.notify_differentials,
      },
      watchlist: watchlist.map(w => ({
        player_id: w.player_id,
        player_name: w.player_name,
        added_at: w.added_at,
      })),
      recent_activity: activity.map(a => ({
        command: a.command,
        args: a.args,
        timestamp: a.timestamp,
      })),
    };

    const json = JSON.stringify(exportData, null, 2);
    ctx.replyWithDocument(
      { source: Buffer.from(json, 'utf-8'), filename: `fpl_bot_data_${chatId}.json` },
      { caption: '📦 Ini semua data kamu yang tersimpan di bot.' }
    );
  });

  // /analyze <nama> — Analisa mendalam pemain
  bot.command('analyze', async ctx => {
    const query = ctx.message.text.replace(/^\/analyze\s*/i, '').trim();
    if (!query) return ctx.reply('Gunakan: /analyze <nama pemain>');

    try {
      const { scored, teams, currentGw } = await getScoredPlayers();
      const result = findPlayer(scored, query);

      if (!result) return ctx.reply(`❌ Pemain "${query}" tidak ditemukan.`);
      if (Array.isArray(result)) {
        const names = result.slice(0, 10).map(p => `• ${p.web_name} (${p.teamData?.short_name || '?'})`);
        return ctx.replyWithHTML(`Ditemukan ${result.length} pemain:\n${names.join('\n')}\n\nCoba lebih spesifik.`);
      }

      ctx.replyWithHTML(fmt.analyzeCard(result, currentGw));
    } catch (err) {
      console.error('Error /analyze:', err.message);
      ctx.reply('❌ Gagal mengambil data.');
    }
  });

  // /history <nama> — Lihat data historis pemain 3 musim
  bot.command('history', async ctx => {
    const query = ctx.message.text.replace(/^\/history\s*/i, '').trim();
    if (!query) return ctx.reply('Gunakan: /history <nama pemain>');

    try {
      if (!hasHistoricalData()) {
        ctx.reply('⏳ Mengunduh data historis 3 musim... (pertama kali)');
        await refreshHistoricalData();
      }

      const { scored } = await getScoredPlayers();
      const result = findPlayer(scored, query);

      if (!result) return ctx.reply(`❌ Pemain "${query}" tidak ditemukan.`);
      if (Array.isArray(result)) {
        const names = result.slice(0, 10).map(p => `• ${p.web_name} (${p.teamData?.short_name || '?'})`);
        return ctx.replyWithHTML(`Ditemukan ${result.length} pemain:\n${names.join('\n')}\n\nCoba lebih spesifik.`);
      }

      const playerKey = makePlayerKey(result.first_name, result.second_name);
      const trend = analyzePlayerTrend(playerKey);

      ctx.replyWithHTML(fmt.historyCard(result, trend));
    } catch (err) {
      console.error('Error /history:', err.message);
      ctx.reply('❌ Gagal mengambil data historis.');
    }
  });

  // /users — Dashboard user lengkap (owner only)
  bot.command('users', async ctx => {
    if (!isOwner(ctx)) return ctx.reply('🚫 Hanya pemilik bot (@Abulkhaer).');

    const args = ctx.message.text.replace(/^\/users\s*/i, '').trim();

    // /users <chat_id> — Detail user tertentu
    if (args) {
      const targetId = args;
      const user = await getUser(targetId);
      if (!user) return ctx.reply(`❌ User dengan ID ${targetId} tidak ditemukan.`);

      const activity = await getUserActivity(targetId, 20);
      const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const lines = [
        `<b>👤 Detail User</b>\n`,
        `🆔 Chat ID: <code>${user.chat_id}</code>`,
        `📋 Nama: <b>${esc(user.first_name) || '-'}${user.last_name ? ' ' + esc(user.last_name) : ''}</b>`,
        `🏷 Username: ${user.username ? '@' + esc(user.username) : '(tidak ada)'}`,
        `🌐 Bahasa: ${user.language_code || '-'}`,
        `⚽ FPL ID: <code>${user.fpl_id}</code>`,
        `📅 Terdaftar: ${user.registered_at}`,
        `🕐 Terakhir aktif: ${user.last_seen}`,
        `📊 Total perintah: ${user.command_count}`,
        `🔄 Perintah terakhir: /${user.last_command || '-'}`,
        ``,
      ];

      if (activity.length > 0) {
        lines.push('<b>📜 Aktivitas Terakhir:</b>');
        activity.forEach(a => {
          const time = a.timestamp.split(' ')[1] || a.timestamp;
          const date = a.timestamp.split(' ')[0] || '';
          lines.push(`  ${date} ${time} — /${a.command}${a.args ? ' ' + a.args.substring(0, 30) : ''}`);
        });
      }

      lines.push('\n<b>Aksi:</b>');
      lines.push(`<code>/removeuser ${user.chat_id}</code> — Hapus user ini`);

      return ctx.replyWithHTML(lines.join('\n'));
    }

    // /users — Dashboard overview (paginated)
    const users = await getAllUsers(50);
    const stats = await getUserStats();

    const lines = [
      `<b>👥 DASHBOARD USER</b>`,
      ``,
      `<b>📊 Statistik:</b>`,
      `  Total user: <b>${stats.totalUsers}</b>`,
      `  Aktif hari ini: <b>${stats.activeToday}</b>`,
      `  Aktif 7 hari: <b>${stats.activeWeek}</b>`,
      `  Total perintah: <b>${stats.totalCommands}</b>`,
      ``,
    ];

    if (stats.topCommands.length > 0) {
      lines.push('<b>🔥 Perintah Terpopuler:</b>');
      stats.topCommands.forEach(c => {
        lines.push(`  /${c.command} — ${c.cnt}x`);
      });
      lines.push('');
    }

    if (users.length > 0) {
      lines.push('<b>👤 Daftar User:</b>');
      lines.push('');
      const escU = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      users.forEach((u, i) => {
        const isActive = u.last_seen && new Date(u.last_seen + 'Z') > new Date(Date.now() - 86400000);
        const dot = isActive ? '🟢' : '⚪';
        lines.push(
          `${dot} ${i + 1}. <b>${escU(u.first_name) || 'Unknown'}${u.last_name ? ' ' + escU(u.last_name) : ''}</b>` +
          `${u.username ? ' (@' + escU(u.username) + ')' : ''}`
        );
        lines.push(
          `      FPL: <code>${u.fpl_id}</code> · Cmd: ${u.command_count} · Last: ${u.last_seen?.split(' ')[0] || '-'}`
        );
      });
      lines.push('');
      if (stats.totalUsers > 50) {
        lines.push(`<i>Menampilkan 50 dari ${stats.totalUsers} user.</i>`);
      }
      lines.push('<i>💡 Ketik /users [chat_id] untuk detail user</i>');
    } else {
      lines.push('<i>Belum ada user terdaftar.</i>');
    }

    ctx.replyWithHTML(lines.join('\n'));
  });

  // /removeuser <chat_id> — Hapus user (owner only)
  bot.command('removeuser', async ctx => {
    if (!isOwner(ctx)) return ctx.reply('🚫 Hanya pemilik bot.');

    const targetId = ctx.message.text.replace(/^\/removeuser\s*/i, '').trim();
    if (!targetId) return ctx.reply('Gunakan: /removeuser <chat_id>');

    if (String(targetId) === String(getOwnerId())) return ctx.reply('❌ Tidak bisa menghapus pemilik bot.');

    const user = await getUser(targetId);
    if (!user) return ctx.reply(`❌ User ${targetId} tidak ditemukan.`);

    clearUserSession(String(targetId));
    await deleteUser(targetId);
    ctx.replyWithHTML(
      `✅ User <b>${fmt.escapeHtml(user.first_name || 'Unknown')}</b> (${user.chat_id}) berhasil dihapus.\n` +
      `Data aktivitas juga dihapus.`
    );
  });

  // /settier <chat_id> <free|pro|team> — Ubah tier user (owner only)
  bot.command('settier', async ctx => {
    if (!isOwner(ctx)) return ctx.reply('🚫 Hanya pemilik bot.');

    const args = ctx.message.text.replace(/^\/settier\s*/i, '').trim().split(/\s+/);
    if (args.length < 2) {
      return ctx.replyWithHTML('Gunakan: <code>/settier [chat_id] [free|pro|team]</code>');
    }

    const targetId = args[0];
    const tier = args[1].toLowerCase();
    if (!['free', 'pro', 'team'].includes(tier)) {
      return ctx.reply('❌ Tier harus: free, pro, atau team.');
    }

    const user = await getUser(targetId);
    if (!user) return ctx.reply(`❌ User ${targetId} tidak ditemukan.`);

    await setUserTier(targetId, tier);
    const info = formatTierInfo(tier);
    ctx.replyWithHTML(`✅ Tier <b>${fmt.escapeHtml(user.first_name || targetId)}</b> diubah ke ${info}.`);

    // Notify the user
    try {
      bot.telegram.sendMessage(targetId,
        `🎉 Tier kamu telah diupgrade ke ${info}!\n\nKetik /help untuk lihat fitur yang tersedia.`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    } catch {}
  });

  // /stats — Bot health monitoring dashboard (owner only)
  bot.command('stats', async ctx => {
    if (!isOwner(ctx)) return ctx.reply('🚫 Hanya pemilik bot.');

    const m = getMetrics();
    const userStats = await getUserStats();

    const lines = [
      '<b>📊 BOT HEALTH DASHBOARD</b>',
      '',
      '<b>⏱ Uptime:</b>',
      `  ${m.uptime}`,
      '',
      '<b>💻 System:</b>',
      `  Memory: ${m.memoryMB}MB heap / ${m.memoryTotalMB}MB RSS`,
      `  Node.js: ${process.version}`,
      '',
      '<b>👥 Users:</b>',
      `  Total: ${userStats.totalUsers}`,
      `  Active today: ${userStats.activeToday}`,
      `  Active 7d: ${userStats.activeWeek}`,
      '',
      '<b>📨 Commands (since restart):</b>',
      `  Total: ${m.commands.total}`,
      `  Errors: ${m.commands.errors} (${m.commands.errorRate}%)`,
      '',
      '<b>🌐 FPL API:</b>',
      `  Calls: ${m.api.calls}`,
      `  Errors: ${m.api.errors} (${m.api.errorRate}%)`,
      `  Retries: ${m.api.retries}`,
      `  Avg latency: ${m.api.avgMs}ms`,
      '',
      '<b>📤 Messages:</b>',
      `  Sent: ${m.messages.sent}`,
      `  Failed: ${m.messages.failed}`,
    ];

    if (m.recentErrors.length > 0) {
      lines.push('');
      lines.push('<b>🚨 Recent Errors:</b>');
      for (const err of m.recentErrors) {
        const time = err.timestamp.split('T')[1]?.split('.')[0] || '';
        lines.push(`  ${time} [${err.context}] ${err.message.substring(0, 80)}`);
      }
    }

    if (userStats.topCommands.length > 0) {
      lines.push('');
      lines.push('<b>🔥 Top Commands (all time):</b>');
      userStats.topCommands.slice(0, 5).forEach(c => {
        lines.push(`  /${c.command} — ${c.cnt}x`);
      });
    }

    lines.push('');
    lines.push('<code>/stats reset</code> — Reset counters');

    ctx.replyWithHTML(lines.join('\n'));
  });

  // /stats reset handler (inline within stats)
  bot.hears(/^\/stats\s+reset$/i, ctx => {
    if (!isOwner(ctx)) return;
    resetMetrics();
    ctx.reply('✅ Metrics counters reset.');
  });

  // /refreshhistory — Force refresh data historis (owner only)
  bot.command('refreshhistory', async ctx => {
    if (!isOwner(ctx)) return ctx.reply('🚫 Hanya pemilik bot.');
    try {
      ctx.reply('⏳ Mengunduh ulang data historis 3 musim...');
      const results = await refreshHistoricalData();
      const lines = ['✅ Data historis berhasil diperbarui:\n'];
      for (const [season, count] of Object.entries(results)) {
        lines.push(`  ${season}: ${count} pemain`);
      }
      cachedScored = null; cacheTs = 0; cachePromise = null;
      lines.push('\n💡 Quality score semua pemain akan di-recalculate.');
      ctx.reply(lines.join('\n'));
    } catch (err) {
      console.error('Error /refreshhistory:', err.message);
      ctx.reply('❌ Gagal refresh data historis.');
    }
  });

  // /fplstatus — Cek status FPL login & data GW (owner only)
  bot.command('fplstatus', async ctx => {
    if (!isOwner(ctx)) return ctx.reply('🚫 Hanya pemilik bot.');

    const lines = ['<b>🔍 FPL Status Check</b>\n'];

    // 1. Cek env
    const email = process.env.FPL_EMAIL;
    const password = process.env.FPL_PASSWORD;
    const fplId = parseInt(process.env.FPL_ID);

    lines.push('<b>⚙️ Konfigurasi:</b>');

    // Email diagnostic — show masked but verifiable
    if (email) {
      const trimmed = email.trim();
      const hasWhitespace = email !== trimmed;
      const hasQuotes = email.startsWith('"') || email.startsWith("'");
      const parts = trimmed.replace(/['"]/g, '').split('@');
      const user = parts[0] || '';
      const domain = parts[1] || '';
      const maskedUser = user.length <= 3 ? user + '***' : user.substring(0, 3) + '*'.repeat(Math.min(user.length - 3, 5));
      const maskedDomain = domain.length <= 4 ? domain : domain.substring(0, 3) + '*'.repeat(domain.length - 6) + domain.slice(-3);
      lines.push(`  FPL_EMAIL: ✅ ${maskedUser}@${maskedDomain} (${trimmed.length} char)`);
      if (hasWhitespace) lines.push('  ⚠️ Email mengandung spasi di awal/akhir!');
      if (hasQuotes) lines.push('  ⚠️ Email mengandung tanda kutip!');
    } else {
      lines.push('  FPL_EMAIL: ❌ Belum di-set');
    }

    // Password diagnostic
    if (password) {
      const trimmed = password.trim();
      const hasWhitespace = password !== trimmed;
      const hasQuotes = password.startsWith('"') || password.startsWith("'");
      lines.push(`  FPL_PASSWORD: ✅ ${'*'.repeat(Math.min(password.length, 10))} (${password.length} char)`);
      if (hasWhitespace) lines.push('  ⚠️ Password mengandung spasi di awal/akhir!');
      if (hasQuotes) lines.push('  ⚠️ Password mengandung tanda kutip!');
    } else {
      lines.push('  FPL_PASSWORD: ❌ Belum di-set');
    }

    lines.push(`  FPL_ID: ${fplId ? '✅ ' + fplId : '❌ Belum di-set'}`);
    lines.push('');

    // 2. Cek GW info
    try {
      const bootstrap = await fetchBootstrap();
      const currentGw = bootstrap.events.find(e => e.is_current);
      const nextGw = bootstrap.events.find(e => e.is_next);

      lines.push('<b>📅 Gameweek Info:</b>');
      if (currentGw) {
        lines.push(`  Current: GW${currentGw.id} (${currentGw.finished ? 'selesai' : 'berlangsung'})`);
        lines.push(`  Deadline: ${new Date(currentGw.deadline_time).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`);
      }
      if (nextGw) {
        lines.push(`  Next: GW${nextGw.id}`);
        lines.push(`  Deadline: ${new Date(nextGw.deadline_time).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`);
      }
      lines.push('');

      // 3. Cek picks availability
      if (fplId) {
        lines.push('<b>📋 Squad Data (picks):</b>');
        const gwsToCheck = [];
        if (nextGw) gwsToCheck.push(nextGw.id);
        if (currentGw) gwsToCheck.push(currentGw.id);
        if (currentGw) {
          for (let gw = currentGw.id - 1; gw >= Math.max(1, currentGw.id - 2); gw--) {
            gwsToCheck.push(gw);
          }
        }

        for (const gw of gwsToCheck) {
          try {
            const picks = await fetchManagerPicks(fplId, gw);
            const captain = picks.picks?.find(p => p.is_captain);
            lines.push(`  GW${gw}: ✅ tersedia (${picks.picks?.length} pemain, captain ID: ${captain?.element || '?'})`);
          } catch (err) {
            lines.push(`  GW${gw}: ❌ ${err.response?.status === 404 ? 'belum tersedia' : err.message}`);
          }
        }
        lines.push('');
      }

      // 4. Test FPL login
      lines.push('<b>🔐 FPL Login Test:</b>');
      if (!email || !password) {
        lines.push('  ⚠️ Email/password belum di-set. Login tidak bisa diuji.');
        lines.push('  Set via: <code>/setenv FPL_EMAIL your@email.com</code>');
        lines.push('  Dan: <code>/setenv FPL_PASSWORD yourpassword</code>');
      } else {
        try {
          const session = await fplLogin();
          if (session) {
            lines.push('  ✅ Login BERHASIL — session cookie didapat.');

            // 5. Test my-team
            if (fplId) {
              try {
                const myTeam = await fetchMyTeam(fplId);
                if (myTeam?.picks) {
                  const captain = myTeam.picks.find(p => p.is_captain);
                  const viceCaptain = myTeam.picks.find(p => p.is_vice_captain);
                  lines.push(`  ✅ My-team OK — ${myTeam.picks.length} pemain`);
                  lines.push(`  👑 Captain ID: ${captain?.element || '?'}, VC ID: ${viceCaptain?.element || '?'}`);
                  lines.push(`  💰 Bank: £${((myTeam.transfers?.bank || 0) / 10).toFixed(1)}m`);
                  lines.push(`  🔄 Free transfers: ${myTeam.transfers?.limit ?? '?'}`);
                  lines.push('');
                  lines.push('  <i>✅ Data live squad (sebelum deadline) AKTIF.</i>');
                } else {
                  lines.push('  ⚠️ My-team response kosong — mungkin bukan FPL ID kamu.');
                }
              } catch (err) {
                lines.push(`  ❌ My-team gagal: ${err.message}`);
                lines.push('  <i>Pastikan FPL_ID adalah ID tim kamu sendiri.</i>');
              }
            }
          } else {
            const reason = getFplLoginError() || 'tidak dapat session';
            lines.push(`  ❌ Login GAGAL — ${reason}`);
            lines.push('');
            lines.push('  <i>⚠️ PingOne Protect memblokir login otomatis dari server.</i>');
            lines.push('  <i>Kredensial mungkin benar, tapi bot protection menolak tanpa browser.</i>');
            lines.push('');
            lines.push('  <i>💡 Gunakan token manual sebagai alternatif:</i>');
            lines.push('  <code>/fpltoken</code> — lihat panduan lengkap');
            lines.push('');
            lines.push('  <i>Squad tetap bisa dilihat via /squad setelah deadline GW lewat.</i>');

            // Show debug info for login flow
            const debug = getFplLoginDebug();
            if (debug?.steps?.length) {
              lines.push('');
              lines.push('<b>🔧 Login Flow Debug:</b>');
              for (const s of debug.steps) {
                const info = [`Step ${s.step} (${s.name}): HTTP ${s.status}`];
                if (s.detectedFields?.length) info.push(`fields=[${s.detectedFields.join(',')}]`);
                if (s.errorCode) info.push(`err=${s.errorCode}`);
                if (s.errorReason) info.push(`reason=${s.errorReason}`);
                if (s.screenName) info.push(`screen=${s.screenName}`);
                lines.push(`  ${info.join(' | ')}`);
              }
              // Response snippets omitted for security
            }
          }
        } catch (err) {
          lines.push(`  ❌ Login ERROR: ${err.message}`);
        }
      }

    } catch (err) {
      lines.push(`❌ Gagal mengambil data FPL API: ${err.message}`);
    }

    ctx.replyWithHTML(lines.join('\n'));
  });

  // /fpllogin — Auth Code + PKCE login (all users)
  bot.command('fpllogin', async ctx => {
    const chatId = String(ctx.from.id);
    const authUrl = startAuthCodeFlow(chatId);

    // Mark user as waiting for redirect URL
    pendingFplLogin.add(chatId);
    // Auto-expire after 10 minutes
    setTimeout(() => pendingFplLogin.delete(chatId), 600_000);

    return ctx.replyWithHTML(
      '🔐 <b>FPL Login</b>\n\n' +
      '<b>Langkah 1:</b> Klik tombol di bawah untuk login FPL\n' +
      '<b>Langkah 2:</b> Setelah login, copy <b>seluruh URL</b> dari address bar\n' +
      '<b>Langkah 3:</b> Langsung paste URL-nya di chat ini\n\n' +
      '💡 <i>Cukup paste URL-nya saja, tidak perlu ketik perintah apapun.</i>',
      {
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔑 Login FPL', url: authUrl }],
          ],
        },
      }
    );
  });

  // /fplcode — Exchange auth code from redirect URL (all users)
  bot.command('fplcode', async ctx => {
    const chatId = String(ctx.from.id);
    const input = ctx.message.text.split(' ').slice(1).join(' ').trim();
    if (!input) {
      return ctx.reply('Paste URL redirect setelah login.\nContoh: /fplcode https://www.premierleague.com/?code=abc123&state=xyz');
    }

    try {
      const msg = await ctx.reply('🔄 Menukar kode otorisasi...');

      const result = await exchangeAuthCode(input, chatId);

      if (result.success) {
        // Persist token to DB
        await saveFplToken(chatId, result.token, result.refreshToken);

        // Test with user's FPL ID
        const user = await getUser(chatId);
        const fplId = user?.fpl_id;
        let teamInfo = '';
        if (fplId) {
          try {
            const myTeam = await fetchMyTeam(fplId, chatId);
            if (myTeam?.picks) {
              const captain = myTeam.picks.find(p => p.is_captain);
              teamInfo = `\n\n👥 ${myTeam.picks.length} pemain\n` +
                `👑 Captain ID: ${captain?.element || '?'}\n` +
                `💰 Bank: £${((myTeam.transfers?.bank || 0) / 10).toFixed(1)}m\n` +
                `🔄 Free transfers: ${myTeam.transfers?.limit ?? '?'}`;
            }
          } catch {}
        }

        await ctx.telegram.editMessageText(
          ctx.chat.id, msg.message_id, null,
          `✅ <b>Login Berhasil!</b>${teamInfo}\n\n` +
          `<i>Token akan auto-refresh. Jika expired, jalankan /fpllogin lagi.</i>`,
          { parse_mode: 'HTML' }
        );
      } else {
        await ctx.telegram.editMessageText(
          ctx.chat.id, msg.message_id, null,
          `❌ <b>Login Gagal</b>\n\nCoba /fpllogin lagi untuk generate link baru.`,
          { parse_mode: 'HTML' }
        );
      }
    } catch (err) {
      console.error('Error /fplcode:', err.message);
      ctx.reply('❌ Terjadi kesalahan saat login. Coba /fpllogin lagi.');
    }
  });

  // /fpltoken — manual token input for FPL login (all users)
  bot.command('fpltoken', async ctx => {
    const chatId = String(ctx.from.id);
    const token = ctx.message.text.split(' ').slice(1).join(' ').trim();

    if (!token) {
      return ctx.replyWithHTML(
        '<b>🔑 FPL Token Manual</b>\n\n' +
        'Gunakan token manual dari browser jika /fpllogin tidak berhasil:\n\n' +
        '<b>Cara mendapatkan token:</b>\n' +
        '1. Buka <code>https://fantasy.premierleague.com</code> di browser\n' +
        '2. Login seperti biasa\n' +
        '3. Buka Developer Tools (F12) → tab Network\n' +
        '4. Cari request ke <code>api/my-team/</code> atau <code>api/me/</code>\n' +
        '5. Di Headers, copy nilai <code>Cookie</code> (terutama <code>pl_profile=...</code>)\n' +
        '   ATAU copy <code>Authorization: Bearer ...</code> token\n\n' +
        '<b>Paste token:</b>\n' +
        '<code>/fpltoken pl_profile=eyJ...token...</code>\n' +
        'atau\n' +
        '<code>/fpltoken Bearer eyJ...token...</code>\n\n' +
        '⚠️ Token akan expired setelah beberapa jam. Ulangi jika perlu.\n' +
        '⚠️ Token hanya bisa melihat squad dari akun FPL <b>kamu sendiri</b>.'
      );
    }

    setFplSession(token, chatId);
    // Persist to DB
    await saveFplToken(chatId, token, null);

    // Test token with user's FPL ID
    const user = await getUser(chatId);
    const fplId = user?.fpl_id;
    if (!fplId) {
      return ctx.replyWithHTML('✅ Token disimpan.\n⚠️ FPL ID belum di-set. Gunakan <code>/start [FPL ID]</code> dulu.');
    }

    try {
      const myTeam = await fetchMyTeam(fplId, chatId);
      if (myTeam?.picks) {
        const captain = myTeam.picks.find(p => p.is_captain);
        ctx.replyWithHTML(
          '✅ Token VALID!\n\n' +
          `👥 ${myTeam.picks.length} pemain\n` +
          `👑 Captain ID: ${captain?.element || '?'}\n` +
          `💰 Bank: £${((myTeam.transfers?.bank || 0) / 10).toFixed(1)}m\n` +
          `🔄 Free transfers: ${myTeam.transfers?.limit ?? '?'}\n\n` +
          '<i>Live squad sebelum deadline sekarang aktif.</i>'
        );
      } else {
        ctx.reply('⚠️ Token disimpan tapi my-team response kosong. Pastikan FPL ID benar dan token dari akun yang sama.');
      }
    } catch (err) {
      if (err.response?.status === 401 || err.response?.status === 403) {
        setFplSession(null, chatId);
        await clearFplToken(chatId);
        ctx.reply('❌ Token ditolak (401/403). Pastikan token masih valid dan belum expired.');
      } else {
        ctx.reply('⚠️ Token disimpan tapi gagal test. Coba lagi nanti.');
      }
    }
  });

  // /fpllogout — clear FPL session (all users)
  bot.command('fpllogout', async ctx => {
    const chatId = String(ctx.from.id);
    clearUserSession(chatId);
    await clearFplToken(chatId);
    ctx.reply('✅ Sesi FPL kamu sudah dihapus. Gunakan /fpllogin untuk login kembali.');
  });

  // /refresh
  bot.command('refresh', async ctx => {
    try {
      cachedScored = null;
      cacheTs = 0;
      cachePromise = null;
      require('./fpl-api').clearCache();
      await getScoredPlayers();
      ctx.reply('✅ Data di-refresh dari FPL API.\n💡 Untuk refresh data historis: /refreshhistory');
    } catch (err) {
      console.error('Error /refresh:', err.message);
      ctx.reply('❌ Gagal refresh data.');
    }
  });

  // Auto-detect FPL login redirect URL (pasted after /fpllogin)
  bot.on('text', async (ctx, next) => {
    const text = (ctx.message.text || '').trim();

    // Skip commands
    if (text.startsWith('/')) return next();

    const chatId = String(ctx.from.id);

    // Only process if user has a pending login
    if (!pendingFplLogin.has(chatId)) return next();

    // Check if text looks like a redirect URL with auth code
    const looksLikeRedirect = text.includes('code=') &&
      (text.includes('premierleague.com') || text.includes('state='));

    if (!looksLikeRedirect) return next();

    // Process the redirect URL
    pendingFplLogin.delete(chatId);

    try {
      const msg = await ctx.reply('🔄 Menukar kode otorisasi...');

      const result = await exchangeAuthCode(text, chatId);

      if (result.success) {
        await saveFplToken(chatId, result.token, result.refreshToken);

        const user = await getUser(chatId);
        const fplId = user?.fpl_id;
        let teamInfo = '';
        if (fplId) {
          try {
            const myTeam = await fetchMyTeam(fplId, chatId);
            if (myTeam?.picks) {
              const captain = myTeam.picks.find(p => p.is_captain);
              teamInfo = `\n\n👥 ${myTeam.picks.length} pemain\n` +
                `👑 Captain ID: ${captain?.element || '?'}\n` +
                `💰 Bank: £${((myTeam.transfers?.bank || 0) / 10).toFixed(1)}m\n` +
                `🔄 Free transfers: ${myTeam.transfers?.limit ?? '?'}`;
            }
          } catch {}
        }

        await ctx.telegram.editMessageText(
          ctx.chat.id, msg.message_id, null,
          `✅ <b>Login Berhasil!</b>${teamInfo}\n\n` +
          `<i>Token akan auto-refresh. Jika expired, jalankan /fpllogin lagi.</i>`,
          { parse_mode: 'HTML' }
        );
      } else {
        await ctx.telegram.editMessageText(
          ctx.chat.id, msg.message_id, null,
          `❌ <b>Login Gagal</b>\n\nCoba /fpllogin lagi untuk generate link baru.`,
          { parse_mode: 'HTML' }
        );
      }
    } catch (err) {
      console.error('Error auto-fplcode:', err.message);
      ctx.reply('❌ Terjadi kesalahan saat login. Coba /fpllogin lagi.');
    }
  });

  // =====================
  // 6 NEW FEATURES
  // =====================

  const { generateExpertPicks } = require('./expert-picks');
  const { predictPriceChanges, flagSquadPlayers } = require('./price-warnings');
  const { predictLineup, predictAllLineups } = require('./predicted-lineups');
  const { analyzeChipTiming } = require('./chip-planner');
  const { buildTransferPlan } = require('./transfer-planner');
  const { simulateTransfers } = require('./whatif');

  // /expertpicks (alias /picks)
  const expertPicksHandler = async ctx => {
    try {
      ctx.reply('⏳ Menganalisa expert picks...');
      const { scored, teams, currentGw } = await getScoredPlayers();
      const picks = generateExpertPicks(scored, currentGw);
      ctx.replyWithHTML(fmt.expertPicksCard(picks));
    } catch (err) {
      console.error('Error /expertpicks:', err.message);
      ctx.reply('❌ Gagal menganalisa expert picks. Coba lagi nanti.');
    }
  };
  bot.command('expertpicks', expertPicksHandler);
  bot.command('picks', expertPicksHandler);

  // /pricewarning (alias /prices)
  const priceWarningHandler = async ctx => {
    try {
      ctx.reply('⏳ Menganalisa perubahan harga...');
      const { scored } = await getScoredPlayers();
      let result = predictPriceChanges(scored);

      // Flag squad/watchlist players if user is registered
      const chatId = String(ctx.from.id);
      const user = await getUser(chatId);
      if (user?.fpl_id) {
        try {
          const { scored: s, currentGw } = await getScoredPlayers();
          const bootstrap = await fetchBootstrap();
          const nextGw = bootstrap.events.find(e => e.is_next)?.id || currentGw;
          let picks;
          try { picks = await fetchManagerPicks(user.fpl_id, nextGw); } catch {}
          if (!picks) try { picks = await fetchManagerPicks(user.fpl_id, currentGw); } catch {}
          const squadIds = picks?.picks?.map(p => p.element) || [];
          const watchlist = await getWatchlist(chatId);
          const watchIds = watchlist.map(w => w.player_id);
          result = flagSquadPlayers(result, squadIds, watchIds);
        } catch {}
      }

      ctx.replyWithHTML(fmt.priceWarningCard(result.risers, result.fallers));
    } catch (err) {
      console.error('Error /pricewarning:', err.message);
      ctx.reply('❌ Gagal menganalisa perubahan harga. Coba lagi nanti.');
    }
  };
  bot.command('pricewarning', priceWarningHandler);
  bot.command('prices', priceWarningHandler);

  // /lineup <team>
  bot.command('lineup', async ctx => {
    const input = ctx.message.text.replace(/^\/lineup\s*/i, '').trim();
    if (!input) {
      return ctx.replyWithHTML('Gunakan: <code>/lineup [nama tim]</code>\nContoh: <code>/lineup Arsenal</code> atau <code>/lineup ARS</code>');
    }

    try {
      ctx.reply('⏳ Memprediksi lineup...');
      const { scored, teams } = await getScoredPlayers();
      const teamsArr = Object.values(teams);

      const q = input.toLowerCase();
      const team = teamsArr.find(t =>
        t.name.toLowerCase() === q ||
        t.short_name.toLowerCase() === q ||
        t.name.toLowerCase().includes(q)
      );
      if (!team) {
        return ctx.reply(`❌ Tim "${input}" tidak ditemukan. Gunakan nama lengkap atau kode (contoh: ARS, LIV, MCI).`);
      }

      const teamPlayers = scored.filter(p => p.team === team.id);
      const maxStarts = Math.max(...teamPlayers.map(p => p.starts || 0), 1);
      const lineup = predictLineup(teamPlayers, maxStarts, team.name);

      if (!lineup) {
        return ctx.reply('❌ Tidak cukup data untuk memprediksi lineup tim ini.');
      }

      ctx.replyWithHTML(fmt.lineupCard(lineup));
    } catch (err) {
      console.error('Error /lineup:', err.message);
      ctx.reply('❌ Gagal memprediksi lineup. Coba lagi nanti.');
    }
  });

  // /chipplan (alias /chips)
  const chipPlanHandler = async ctx => {
    try {
      ctx.reply('⏳ Menganalisa chip planning...');
      const { scored, teams } = await getScoredPlayers();
      const fixtures = await fetchFixtures();
      const result = analyzeChipTiming(fixtures, Object.values(teams), scored);
      ctx.replyWithHTML(fmt.chipPlanCard(result));
    } catch (err) {
      console.error('Error /chipplan:', err.message);
      ctx.reply('❌ Gagal menganalisa chip plan. Coba lagi nanti.');
    }
  };
  bot.command('chipplan', chipPlanHandler);
  bot.command('chips', chipPlanHandler);

  // /plan [managerId] (alias /transferplan)
  const transferPlanHandler = async ctx => {
    const input = ctx.message.text.replace(/^\/(plan|transferplan)\s*/i, '').trim();
    const managerId = parseInt(input) || await getUserFplId(ctx);
    if (!managerId || isNaN(managerId)) {
      return ctx.replyWithHTML(
        'FPL ID belum terdaftar.\n\n' +
        'Gunakan <code>/start [FPL ID]</code> untuk mendaftar.\n' +
        'Atau: <code>/plan [FPL ID]</code>'
      );
    }

    try {
      ctx.reply('⏳ Membuat transfer plan...');
      const [{ scored, teams, currentGw }] = await Promise.all([getScoredPlayers()]);
      const fixtures = await fetchFixtures();
      const bootstrap = await fetchBootstrap();
      const nextGw = bootstrap.events.find(e => e.is_next)?.id || currentGw;

      // Get squad
      let picks;
      const gwsToTry = [nextGw, currentGw];
      for (let gw = currentGw - 1; gw >= Math.max(1, currentGw - 3); gw--) gwsToTry.push(gw);
      for (const gw of gwsToTry) {
        if (picks) break;
        try { picks = await fetchManagerPicks(managerId, gw); } catch {}
      }
      if (!picks) return ctx.reply('❌ Belum ada data squad.');

      const bank = picks.entry_history?.bank || 0;
      const planEnd = Math.min(nextGw + 5, 38); // Plan next 6 GWs
      const result = buildTransferPlan(picks.picks, scored, fixtures, Object.values(teams), nextGw, planEnd, bank);
      ctx.replyWithHTML(fmt.transferPlanCard(result));
    } catch (err) {
      console.error('Error /plan:', err.message);
      if (err.response?.status === 404) return ctx.reply(`❌ FPL ID ${managerId} tidak ditemukan.`);
      ctx.reply('❌ Gagal membuat transfer plan. Coba lagi nanti.');
    }
  };
  bot.command('plan', transferPlanHandler);
  bot.command('transferplan', transferPlanHandler);

  // /whatif <PlayerOut> > <PlayerIn>
  bot.command('whatif', async ctx => {
    const input = ctx.message.text.replace(/^\/whatif\s*/i, '').trim();
    if (!input || !input.includes('>')) {
      return ctx.replyWithHTML(
        'Gunakan: <code>/whatif [pemain keluar] &gt; [pemain masuk]</code>\n' +
        'Contoh: <code>/whatif Salah &gt; Palmer</code>\n' +
        'Multi: <code>/whatif Salah &gt; Palmer, Haaland &gt; Isak</code>'
      );
    }

    const managerId = await getUserFplId(ctx);
    if (!managerId) {
      return ctx.replyWithHTML('FPL ID belum terdaftar. Gunakan <code>/start [FPL ID]</code>');
    }

    try {
      ctx.reply('⏳ Menjalankan simulasi...');
      const { scored, teams, currentGw } = await getScoredPlayers();
      const bootstrap = await fetchBootstrap();
      const nextGw = bootstrap.events.find(e => e.is_next)?.id || currentGw;

      // Get squad
      let picks;
      const chatId = String(ctx.from.id);
      const user = await getUser(chatId);
      if (managerId === user?.fpl_id && getUserSession(chatId)) {
        try {
          const myTeam = await fetchMyTeam(managerId, chatId);
          if (myTeam?.picks) picks = { picks: myTeam.picks, entry_history: null };
        } catch {}
      }
      if (!picks) {
        const gwsToTry = [nextGw, currentGw];
        for (const gw of gwsToTry) { if (picks) break; try { picks = await fetchManagerPicks(managerId, gw); } catch {} }
      }
      if (!picks) return ctx.reply('❌ Belum ada data squad.');

      // Parse transfers: "Salah > Palmer, Haaland > Isak"
      const parts = input.split(',').map(s => s.trim());
      const transfers = [];
      for (const part of parts) {
        const [outName, inName] = part.split('>').map(s => s.trim());
        if (!outName || !inName) continue;

        const outResult = findPlayer(scored, outName);
        const inResult = findPlayer(scored, inName);

        if (!outResult || Array.isArray(outResult)) {
          return ctx.reply(`❌ Pemain "${outName}" ${Array.isArray(outResult) ? 'ambigu — coba nama lebih spesifik' : 'tidak ditemukan'}.`);
        }
        if (!inResult || Array.isArray(inResult)) {
          return ctx.reply(`❌ Pemain "${inName}" ${Array.isArray(inResult) ? 'ambigu — coba nama lebih spesifik' : 'tidak ditemukan'}.`);
        }

        transfers.push({ outId: outResult.id, inId: inResult.id });
      }

      if (transfers.length === 0) {
        return ctx.reply('❌ Format salah. Contoh: /whatif Salah > Palmer');
      }

      const bank = picks.entry_history?.bank || 0;
      const result = simulateTransfers(picks.picks, scored, transfers, bank);
      ctx.replyWithHTML(fmt.whatIfCard(result));
    } catch (err) {
      console.error('Error /whatif:', err.message);
      ctx.reply('❌ Gagal menjalankan simulasi. Coba lagi nanti.');
    }
  });
}

module.exports = { registerCommands, getScoredPlayers, findPlayer };
