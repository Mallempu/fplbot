const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'fpl.db');

let db;

function getDb() {
  if (db) return db;

  const fs = require('fs');
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshots (
      player_id INTEGER,
      date TEXT,
      now_cost INTEGER,
      status TEXT,
      chance_of_playing INTEGER,
      form REAL,
      selected_by_percent REAL,
      PRIMARY KEY (player_id, date)
    );

    CREATE TABLE IF NOT EXISTS watchlist (
      chat_id TEXT,
      player_id INTEGER,
      player_name TEXT,
      added_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (chat_id, player_id)
    );

    CREATE TABLE IF NOT EXISTS user_preferences (
      chat_id TEXT PRIMARY KEY,
      notify_prices INTEGER DEFAULT 1,
      notify_status INTEGER DEFAULT 1,
      notify_watchlist INTEGER DEFAULT 1,
      notify_differentials INTEGER DEFAULT 0,
      watchlist_limit INTEGER DEFAULT 10,
      lang TEXT DEFAULT 'id',
      tier TEXT DEFAULT 'free',
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS cache_meta (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      chat_id TEXT PRIMARY KEY,
      fpl_id INTEGER,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      language_code TEXT,
      registered_at TEXT DEFAULT (datetime('now')),
      last_seen TEXT DEFAULT (datetime('now')),
      command_count INTEGER DEFAULT 0,
      last_command TEXT
    );

    CREATE TABLE IF NOT EXISTS user_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT,
      command TEXT,
      args TEXT,
      timestamp TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_watchlist_player ON watchlist(player_id);
    CREATE INDEX IF NOT EXISTS idx_activity_chat ON user_activity(chat_id);
    CREATE INDEX IF NOT EXISTS idx_activity_timestamp ON user_activity(timestamp);
  `);

  // Migrasi: tambah kolom baru jika belum ada (untuk DB yang sudah ada)
  const userCols = db.pragma('table_info(users)').map(c => c.name);
  const addCol = (col, type) => {
    if (!userCols.includes(col)) {
      db.exec(`ALTER TABLE users ADD COLUMN ${col} ${type}`);
    }
  };
  addCol('last_name', 'TEXT');
  addCol('language_code', 'TEXT');
  addCol('last_seen', "TEXT DEFAULT (datetime('now'))");
  addCol('command_count', 'INTEGER DEFAULT 0');
  addCol('last_command', 'TEXT');
  addCol('fpl_token', 'TEXT');
  addCol('fpl_refresh_token', 'TEXT');

  // Migrasi: tambah kolom baru di user_preferences jika belum ada
  const prefCols = db.pragma('table_info(user_preferences)').map(c => c.name);
  if (!prefCols.includes('lang')) {
    db.exec("ALTER TABLE user_preferences ADD COLUMN lang TEXT DEFAULT 'id'");
  }
  if (!prefCols.includes('tier')) {
    db.exec("ALTER TABLE user_preferences ADD COLUMN tier TEXT DEFAULT 'free'");
  }

  // Web auth table for website login
  db.exec(`
    CREATE TABLE IF NOT EXISTS web_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT,
      fpl_id INTEGER,
      tier TEXT DEFAULT 'free',
      created_at TEXT DEFAULT (datetime('now')),
      last_login TEXT
    )
  `);

  // Migrasi watchlist: jika tabel lama tanpa chat_id, rebuild
  const watchCols = db.pragma('table_info(watchlist)').map(c => c.name);
  if (!watchCols.includes('chat_id')) {
    console.log('[DB] Migrating watchlist to per-user...');
    const oldData = db.prepare('SELECT * FROM watchlist').all();
    db.exec('DROP TABLE watchlist');
    db.exec(`
      CREATE TABLE watchlist (
        chat_id TEXT,
        player_id INTEGER,
        player_name TEXT,
        added_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (chat_id, player_id)
      )
    `);
    // Migrate old watchlist to owner's chat_id
    const ownerChatId = process.env.OWNER_ID || process.env.CHAT_ID || '';
    if (ownerChatId && oldData.length > 0) {
      const stmt = db.prepare('INSERT OR IGNORE INTO watchlist (chat_id, player_id, player_name, added_at) VALUES (?, ?, ?, ?)');
      for (const w of oldData) {
        stmt.run(ownerChatId, w.player_id, w.player_name, w.added_at);
      }
      console.log(`[DB] Migrated ${oldData.length} watchlist items to owner ${ownerChatId}`);
    }
  }

  return db;
}

// Snapshot: simpan data harian untuk deteksi perubahan
function saveSnapshot(players, date) {
  const d = getDb();
  const stmt = d.prepare(`
    INSERT OR REPLACE INTO snapshots (player_id, date, now_cost, status, chance_of_playing, form, selected_by_percent)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = d.transaction(() => {
    for (const p of players) {
      stmt.run(
        p.id, date, p.now_cost, p.status,
        p.chance_of_playing_next_round ?? null,
        parseFloat(p.form) || 0,
        parseFloat(p.selected_by_percent) || 0
      );
    }
  });
  tx();
}

function getSnapshot(date) {
  return getDb().prepare('SELECT * FROM snapshots WHERE date = ?').all(date);
}

function getPreviousSnapshot(beforeDate) {
  const row = getDb().prepare(
    'SELECT DISTINCT date FROM snapshots WHERE date < ? ORDER BY date DESC LIMIT 1'
  ).get(beforeDate);
  if (!row) return [];
  return getSnapshot(row.date);
}

// Watchlist (per-user)
function addToWatchlist(chatId, playerId, playerName) {
  getDb().prepare(
    'INSERT OR REPLACE INTO watchlist (chat_id, player_id, player_name) VALUES (?, ?, ?)'
  ).run(String(chatId), playerId, playerName);
}

function removeFromWatchlist(chatId, playerId) {
  getDb().prepare('DELETE FROM watchlist WHERE chat_id = ? AND player_id = ?').run(String(chatId), playerId);
}

function getWatchlist(chatId) {
  return getDb().prepare('SELECT * FROM watchlist WHERE chat_id = ? ORDER BY added_at').all(String(chatId));
}

function getWatchlistCount(chatId) {
  return getDb().prepare('SELECT COUNT(*) as cnt FROM watchlist WHERE chat_id = ?').get(String(chatId)).cnt;
}

function isWatched(chatId, playerId) {
  return !!getDb().prepare('SELECT 1 FROM watchlist WHERE chat_id = ? AND player_id = ?').get(String(chatId), playerId);
}

// Get all unique watched player IDs across all users (for scheduler)
function getAllWatchedPlayerIds() {
  return getDb().prepare('SELECT DISTINCT player_id FROM watchlist').all().map(r => r.player_id);
}

// Get all users who watch a specific player
function getUsersWatchingPlayer(playerId) {
  return getDb().prepare('SELECT chat_id FROM watchlist WHERE player_id = ?').all(playerId).map(r => r.chat_id);
}

// User preferences
function getUserPreferences(chatId) {
  const db = getDb();
  let prefs = db.prepare('SELECT * FROM user_preferences WHERE chat_id = ?').get(String(chatId));
  if (!prefs) {
    db.prepare('INSERT OR IGNORE INTO user_preferences (chat_id) VALUES (?)').run(String(chatId));
    prefs = db.prepare('SELECT * FROM user_preferences WHERE chat_id = ?').get(String(chatId));
  }
  return prefs;
}

function updateUserPreference(chatId, key, value) {
  const allowed = ['notify_prices', 'notify_status', 'notify_watchlist', 'notify_differentials'];
  if (!allowed.includes(key)) return false;
  getDb().prepare(`UPDATE user_preferences SET ${key} = ?, updated_at = datetime('now') WHERE chat_id = ?`)
    .run(value, String(chatId));
  return true;
}

// FPL token storage (per-user)
function saveFplToken(chatId, token, refreshToken) {
  getDb().prepare(
    "UPDATE users SET fpl_token = ?, fpl_refresh_token = ? WHERE chat_id = ?"
  ).run(token || null, refreshToken || null, String(chatId));
}

function getFplToken(chatId) {
  const row = getDb().prepare(
    'SELECT fpl_token, fpl_refresh_token FROM users WHERE chat_id = ?'
  ).get(String(chatId));
  if (!row || !row.fpl_token) return null;
  return { token: row.fpl_token, refreshToken: row.fpl_refresh_token };
}

function clearFplToken(chatId) {
  getDb().prepare(
    "UPDATE users SET fpl_token = NULL, fpl_refresh_token = NULL WHERE chat_id = ?"
  ).run(String(chatId));
}

// Get all users with FPL tokens (for session restore on startup)
function getAllFplTokens() {
  return getDb().prepare(
    'SELECT chat_id, fpl_id, fpl_token, fpl_refresh_token FROM users WHERE fpl_token IS NOT NULL'
  ).all();
}

// Language preference
function getUserLang(chatId) {
  const prefs = getUserPreferences(chatId);
  return prefs?.lang || 'id';
}

function setUserLang(chatId, lang) {
  const db = getDb();
  // Ensure preferences row exists
  getUserPreferences(chatId);
  db.prepare("UPDATE user_preferences SET lang = ?, updated_at = datetime('now') WHERE chat_id = ?")
    .run(lang, String(chatId));
}

// Tier management
function getUserTier(chatId) {
  const prefs = getUserPreferences(chatId);
  return prefs?.tier || 'free';
}

function setUserTier(chatId, tier) {
  const db = getDb();
  getUserPreferences(chatId);
  db.prepare("UPDATE user_preferences SET tier = ?, updated_at = datetime('now') WHERE chat_id = ?")
    .run(tier, String(chatId));
}

// Get all users with a specific notification preference enabled
function getUsersWithNotification(prefKey) {
  const allowed = ['notify_prices', 'notify_status', 'notify_watchlist', 'notify_differentials'];
  if (!allowed.includes(prefKey)) return [];
  // Users who have preferences set + the pref is enabled
  // Also include users WITHOUT preferences row (defaults are ON for prices/status/watchlist)
  const defaultOn = ['notify_prices', 'notify_status', 'notify_watchlist'].includes(prefKey);
  if (defaultOn) {
    // Users with pref ON, OR users without pref row at all (default ON)
    return getDb().prepare(`
      SELECT u.chat_id FROM users u
      LEFT JOIN user_preferences p ON u.chat_id = p.chat_id
      WHERE p.${prefKey} = 1 OR p.chat_id IS NULL
    `).all().map(r => r.chat_id);
  } else {
    // Only users who explicitly opted in
    return getDb().prepare(`
      SELECT u.chat_id FROM users u
      INNER JOIN user_preferences p ON u.chat_id = p.chat_id
      WHERE p.${prefKey} = 1
    `).all().map(r => r.chat_id);
  }
}

// Users
function registerUser(chatId, fplId, ctx) {
  const from = ctx?.from || {};
  getDb().prepare(`
    INSERT INTO users (chat_id, fpl_id, username, first_name, last_name, language_code)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET
      fpl_id = COALESCE(excluded.fpl_id, fpl_id),
      username = COALESCE(excluded.username, username),
      first_name = COALESCE(excluded.first_name, first_name),
      last_name = COALESCE(excluded.last_name, last_name),
      language_code = COALESCE(excluded.language_code, language_code),
      last_seen = datetime('now')
  `).run(
    String(chatId), fplId || null,
    from.username || null,
    from.first_name || null,
    from.last_name || null,
    from.language_code || null
  );
}

function getUser(chatId) {
  return getDb().prepare('SELECT * FROM users WHERE chat_id = ?').get(String(chatId));
}

function updateUserActivity(chatId, command, args) {
  const db = getDb();
  db.prepare(`
    UPDATE users SET last_seen = datetime('now'), command_count = command_count + 1, last_command = ?
    WHERE chat_id = ?
  `).run(command, String(chatId));

  db.prepare(`
    INSERT INTO user_activity (chat_id, command, args) VALUES (?, ?, ?)
  `).run(String(chatId), command, args || null);
}

function getUserActivity(chatId, limit = 20) {
  return getDb().prepare(
    'SELECT * FROM user_activity WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?'
  ).all(String(chatId), limit);
}

function getUserStats() {
  const db = getDb();
  const totalUsers = db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;
  const activeToday = db.prepare(
    "SELECT COUNT(*) as cnt FROM users WHERE last_seen >= datetime('now', '-1 day')"
  ).get().cnt;
  const activeWeek = db.prepare(
    "SELECT COUNT(*) as cnt FROM users WHERE last_seen >= datetime('now', '-7 days')"
  ).get().cnt;
  const totalCommands = db.prepare(
    'SELECT COALESCE(SUM(command_count), 0) as cnt FROM users'
  ).get().cnt;
  const topCommands = db.prepare(`
    SELECT command, COUNT(*) as cnt FROM user_activity
    GROUP BY command ORDER BY cnt DESC LIMIT 10
  `).all();
  return { totalUsers, activeToday, activeWeek, totalCommands, topCommands };
}

function deleteUser(chatId) {
  const db = getDb();
  db.prepare('DELETE FROM user_activity WHERE chat_id = ?').run(String(chatId));
  db.prepare('DELETE FROM watchlist WHERE chat_id = ?').run(String(chatId));
  db.prepare('DELETE FROM user_preferences WHERE chat_id = ?').run(String(chatId));
  db.prepare('DELETE FROM users WHERE chat_id = ?').run(String(chatId));
}

function getAllUsers(limit = 50, offset = 0) {
  return getDb().prepare('SELECT * FROM users ORDER BY last_seen DESC LIMIT ? OFFSET ?').all(limit, offset);
}

// ===== Web Auth =====
function createWebUser(email, passwordHash, name, fplId) {
  return getDb().prepare(
    'INSERT INTO web_users (email, password_hash, name, fpl_id) VALUES (?, ?, ?, ?)'
  ).run(email.toLowerCase().trim(), passwordHash, name || null, fplId || null);
}

function getWebUserByEmail(email) {
  return getDb().prepare('SELECT * FROM web_users WHERE email = ?').get(email.toLowerCase().trim());
}

function getWebUserById(id) {
  return getDb().prepare('SELECT id, email, name, fpl_id, tier, created_at, last_login FROM web_users WHERE id = ?').get(id);
}

function updateWebUserLogin(id) {
  getDb().prepare("UPDATE web_users SET last_login = datetime('now') WHERE id = ?").run(id);
}

function updateWebUserTier(id, tier) {
  getDb().prepare("UPDATE web_users SET tier = ? WHERE id = ?").run(tier, id);
}

function updateWebUserFplId(id, fplId) {
  getDb().prepare("UPDATE web_users SET fpl_id = ? WHERE id = ?").run(fplId, id);
}

module.exports = {
  getDb,
  saveSnapshot,
  getSnapshot,
  getPreviousSnapshot,
  addToWatchlist,
  removeFromWatchlist,
  getWatchlist,
  getWatchlistCount,
  isWatched,
  getAllWatchedPlayerIds,
  getUsersWatchingPlayer,
  getUserPreferences,
  updateUserPreference,
  getUsersWithNotification,
  saveFplToken,
  getFplToken,
  clearFplToken,
  getAllFplTokens,
  getUserLang,
  setUserLang,
  getUserTier,
  setUserTier,
  registerUser,
  getUser,
  updateUserActivity,
  getUserActivity,
  getUserStats,
  deleteUser,
  getAllUsers,
  createWebUser,
  getWebUserByEmail,
  getWebUserById,
  updateWebUserLogin,
  updateWebUserTier,
  updateWebUserFplId,
};
