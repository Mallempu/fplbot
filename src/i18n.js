// Multi-language support (Indonesian + English)

const strings = {
  id: {
    // Common
    owner_only: '🚫 Hanya pemilik bot yang bisa menggunakan perintah ini.',
    not_registered: '❌ Kamu belum terdaftar.',
    fetch_error: '❌ Gagal mengambil data. Coba lagi nanti.',
    rate_limited: '⚠️ Terlalu banyak request. Tunggu sebentar sebelum mencoba lagi.',
    unknown_command: '❓ Perintah tidak dikenal. Ketik /help untuk panduan.',
    loading: '⏳ Mengambil data...',

    // /start
    welcome_title: '👋 <b>Selamat Datang di Mallempu Bot!</b>',
    welcome_intro: (name) => `Halo <b>${name}</b>! Bot ini akan membantu kamu:`,
    welcome_features: [
      '⚽ Analisa pemain dengan metrik canggih + data 3 musim',
      '📊 Rekomendasi transfer berdasarkan quality score',
      '💎 Temukan differential picks tersembunyi',
      '📰 Update berita FPL dari X & Instagram',
      '📈 Tren transfer in/out terpopuler',
    ],
    register_prompt: '<b>Untuk mulai, daftarkan FPL ID kamu:</b>',
    register_example: '<b>Contoh:</b> <code>/start 1234567</code>',
    register_howto_title: '<b>Cara cari FPL ID:</b>',
    register_howto: [
      '1. Buka fantasy.premierleague.com',
      '2. Login → klik "Points" atau "My Team"',
      '3. Lihat angka di URL: /entry/<b>XXXXX</b>/event/...',
    ],
    fpl_id_tip: '💡 FPL ID bukan username, tapi angka di URL halaman tim kamu.',
    register_success: '✅ <b>Registrasi Berhasil!</b>',
    fpl_id_saved: (id) => `FPL ID kamu (<code>${id}</code>) sudah tersimpan.`,
    start_features_unlocked: 'Sekarang kamu bisa menggunakan semua fitur bot!',
    fpl_id_invalid: '❌ FPL ID harus berupa angka. Contoh: /start 1234567',
    fpl_id_not_found: (id) => `❌ FPL ID ${id} tidak ditemukan. Pastikan ID-nya benar.`,
    fpl_id_verify_fail: '❌ Gagal memverifikasi FPL ID. Coba lagi nanti.',
    need_register: (name) =>
      `👋 <b>Halo ${name}!</b>\n\n` +
      `Sebelum menggunakan bot ini, kamu perlu mendaftarkan FPL ID kamu dulu.\n\n` +
      `Ketik /start untuk mulai registrasi.`,
    help_tip: '💡 Ketik /help untuk panduan interaktif lengkap.',

    // /help
    help_title: '<b>📖 Bantuan Mallempu Bot</b>\n\nPilih kategori di bawah untuk melihat panduan:',
    help_btn_analysis: '📊 Analisa Pemain',
    help_btn_squad: '👤 Squad & Transfer',
    help_btn_news: '📰 Berita & Info',
    help_btn_watchlist: '📋 Watchlist',
    help_btn_settings: '⚙️ Pengaturan',
    help_btn_back: '⬅️ Kembali',

    // Player
    player_usage: 'Gunakan: /player <nama pemain>',
    player_too_long: '❌ Nama terlalu panjang.',
    player_not_found: (q) => `❌ Pemain "${q}" tidak ditemukan.`,
    player_ambiguous: (count) => `Ditemukan ${count} pemain:`,
    player_be_specific: 'Coba lebih spesifik.',

    // Watchlist
    watchlist_full: '❌ Watchlist penuh (maks 20 pemain). Hapus pemain dulu dengan /unwatch.',
    watchlist_added: (name, count) => `✅ ${name} ditambahkan ke watchlist kamu. (${count}/20)`,
    watchlist_removed: (name) => `✅ ${name} dihapus dari watchlist kamu.`,
    watchlist_empty: '📋 Watchlist kosong. Gunakan /watch <nama> untuk menambahkan.',
    watchlist_title: (count) => `<b>📋 Watchlist Kamu (${count}/20)</b>`,
    watchlist_settings_tip: '💡 /settings — atur notifikasi watchlist',

    // Settings
    settings_title: '<b>⚙️ Pengaturan Notifikasi</b>',
    settings_prices: '<b>Harga</b> — Perubahan harga pemain populer',
    settings_status: '<b>Status</b> — Cedera, suspensi, ketersediaan',
    settings_watchlist: '<b>Watchlist</b> — Update harian pemain di watchlist kamu',
    settings_differentials: '<b>Differentials</b> — Ringkasan mingguan (Jumat)',
    settings_toggle_title: '<b>Toggle notifikasi:</b>',
    settings_invalid: (arg) => `❌ Opsi tidak dikenal: "${arg}"\n\nGunakan: /settings <prices|status|watchlist|differentials>`,
    settings_toggled_on: (name) => `✅ ON — Notifikasi ${name} diaktifkan.`,
    settings_toggled_off: (name) => `❌ OFF — Notifikasi ${name} dinonaktifkan.`,

    // Privacy
    delete_account_title: '<b>⚠️ Hapus Akun</b>',
    delete_account_warning: 'Ini akan menghapus <b>semua data kamu</b>:\n• Profil & FPL ID\n• Watchlist\n• Preferensi notifikasi\n• Riwayat aktivitas\n\n<b>Tindakan ini tidak bisa dibatalkan.</b>',
    delete_account_confirm: '✅ Ya, hapus akun saya',
    delete_account_cancel: '❌ Batal',
    delete_account_done: '✅ Akun dan semua data kamu berhasil dihapus.\n\nKamu bisa mendaftar lagi kapan saja dengan /start <FPL ID>.',
    delete_account_cancelled: '👍 Penghapusan akun dibatalkan.',
    export_data_caption: '📦 Ini semua data kamu yang tersimpan di bot.',

    // Squad
    squad_loading: '⏳ Mengambil data squad...',
    squad_no_data: '❌ Belum ada data squad. Pastikan kamu sudah set squad di aplikasi FPL.',
    squad_need_fpl_id: 'FPL ID belum terdaftar.\n\nGunakan <code>/start [FPL ID]</code> untuk mendaftar.',

    // Language
    lang_changed: (lang) => `✅ Bahasa diubah ke <b>${lang === 'id' ? 'Indonesia' : 'English'}</b>.`,
    lang_usage: 'Gunakan: /lang <id|en>\n\n🇮🇩 <code>/lang id</code> — Bahasa Indonesia\n🇬🇧 <code>/lang en</code> — English',
  },

  en: {
    // Common
    owner_only: '🚫 Only the bot owner can use this command.',
    not_registered: '❌ You are not registered yet.',
    fetch_error: '❌ Failed to fetch data. Try again later.',
    rate_limited: '⚠️ Too many requests. Please wait before trying again.',
    unknown_command: '❓ Unknown command. Type /help for guidance.',
    loading: '⏳ Fetching data...',

    // /start
    welcome_title: '👋 <b>Welcome to Mallempu Bot!</b>',
    welcome_intro: (name) => `Hey <b>${name}</b>! This bot helps you with:`,
    welcome_features: [
      '⚽ Advanced player analysis with 3-season historical data',
      '📊 Transfer recommendations based on quality score',
      '💎 Find hidden differential picks',
      '📰 FPL news from X & Instagram',
      '📈 Popular transfer in/out trends',
    ],
    register_prompt: '<b>To get started, register your FPL ID:</b>',
    register_example: '<b>Example:</b> <code>/start 1234567</code>',
    register_howto_title: '<b>How to find your FPL ID:</b>',
    register_howto: [
      '1. Go to fantasy.premierleague.com',
      '2. Login → click "Points" or "My Team"',
      '3. Look for the number in the URL: /entry/<b>XXXXX</b>/event/...',
    ],
    fpl_id_tip: '💡 FPL ID is the number in your team page URL, not your username.',
    register_success: '✅ <b>Registration Successful!</b>',
    fpl_id_saved: (id) => `Your FPL ID (<code>${id}</code>) has been saved.`,
    start_features_unlocked: 'You can now use all bot features!',
    fpl_id_invalid: '❌ FPL ID must be a number. Example: /start 1234567',
    fpl_id_not_found: (id) => `❌ FPL ID ${id} not found. Make sure the ID is correct.`,
    fpl_id_verify_fail: '❌ Failed to verify FPL ID. Try again later.',
    need_register: (name) =>
      `👋 <b>Hey ${name}!</b>\n\n` +
      `You need to register your FPL ID first before using this bot.\n\n` +
      `Type /start to begin registration.`,
    help_tip: '💡 Type /help for an interactive guide.',

    // /help
    help_title: '<b>📖 Mallempu Bot Help</b>\n\nSelect a category below:',
    help_btn_analysis: '📊 Player Analysis',
    help_btn_squad: '👤 Squad & Transfer',
    help_btn_news: '📰 News & Info',
    help_btn_watchlist: '📋 Watchlist',
    help_btn_settings: '⚙️ Settings',
    help_btn_back: '⬅️ Back',

    // Player
    player_usage: 'Usage: /player <player name>',
    player_too_long: '❌ Name too long.',
    player_not_found: (q) => `❌ Player "${q}" not found.`,
    player_ambiguous: (count) => `Found ${count} players:`,
    player_be_specific: 'Try to be more specific.',

    // Watchlist
    watchlist_full: '❌ Watchlist full (max 20 players). Remove a player first with /unwatch.',
    watchlist_added: (name, count) => `✅ ${name} added to your watchlist. (${count}/20)`,
    watchlist_removed: (name) => `✅ ${name} removed from your watchlist.`,
    watchlist_empty: '📋 Watchlist empty. Use /watch <name> to add players.',
    watchlist_title: (count) => `<b>📋 Your Watchlist (${count}/20)</b>`,
    watchlist_settings_tip: '💡 /settings — manage watchlist notifications',

    // Settings
    settings_title: '<b>⚙️ Notification Settings</b>',
    settings_prices: '<b>Prices</b> — Popular player price changes',
    settings_status: '<b>Status</b> — Injuries, suspensions, availability',
    settings_watchlist: '<b>Watchlist</b> — Daily watchlist player updates',
    settings_differentials: '<b>Differentials</b> — Weekly summary (Friday)',
    settings_toggle_title: '<b>Toggle notifications:</b>',
    settings_invalid: (arg) => `❌ Unknown option: "${arg}"\n\nUsage: /settings <prices|status|watchlist|differentials>`,
    settings_toggled_on: (name) => `✅ ON — ${name} notifications enabled.`,
    settings_toggled_off: (name) => `❌ OFF — ${name} notifications disabled.`,

    // Privacy
    delete_account_title: '<b>⚠️ Delete Account</b>',
    delete_account_warning: 'This will delete <b>all your data</b>:\n• Profile & FPL ID\n• Watchlist\n• Notification preferences\n• Activity history\n\n<b>This action cannot be undone.</b>',
    delete_account_confirm: '✅ Yes, delete my account',
    delete_account_cancel: '❌ Cancel',
    delete_account_done: '✅ Your account and all data have been deleted.\n\nYou can register again anytime with /start <FPL ID>.',
    delete_account_cancelled: '👍 Account deletion cancelled.',
    export_data_caption: '📦 Here is all your data stored in the bot.',

    // Squad
    squad_loading: '⏳ Fetching squad data...',
    squad_no_data: '❌ No squad data yet. Make sure you\'ve set your squad in the FPL app.',
    squad_need_fpl_id: 'FPL ID not registered.\n\nUse <code>/start [FPL ID]</code> to register.',

    // Language
    lang_changed: (lang) => `✅ Language changed to <b>${lang === 'id' ? 'Indonesia' : 'English'}</b>.`,
    lang_usage: 'Usage: /lang <id|en>\n\n🇮🇩 <code>/lang id</code> — Bahasa Indonesia\n🇬🇧 <code>/lang en</code> — English',
  },
};

// Default language
const DEFAULT_LANG = 'id';

// Get translated string
function t(lang, key, ...args) {
  const l = strings[lang] || strings[DEFAULT_LANG];
  const val = l[key] ?? strings[DEFAULT_LANG][key];
  if (typeof val === 'function') return val(...args);
  return val;
}

// Get all supported languages
function getSupportedLanguages() {
  return Object.keys(strings);
}

module.exports = { t, getSupportedLanguages, DEFAULT_LANG };
