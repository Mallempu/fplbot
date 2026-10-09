const mysql = require('mysql2/promise');

let pool;

function getPool() {
  if (pool) return pool;

  const dbUrl = process.env.MYSQL_URL || process.env.DATABASE_URL;

  if (dbUrl) {
    pool = mysql.createPool(dbUrl + (dbUrl.includes('?') ? '&' : '?') + 'waitForConnections=true&connectionLimit=10');
  } else {
    pool = mysql.createPool({
      host: process.env.MYSQLHOST || 'localhost',
      port: parseInt(process.env.MYSQLPORT || '3306'),
      user: process.env.MYSQLUSER || 'root',
      password: process.env.MYSQLPASSWORD || '',
      database: process.env.MYSQLDATABASE || process.env.MYSQL_DATABASE || 'railway',
      waitForConnections: true,
      connectionLimit: 10,
    });
  }

  return pool;
}

// Initialize all tables
async function initDb() {
  const p = getPool();

  await p.execute(`
    CREATE TABLE IF NOT EXISTS snapshots (
      player_id INT NOT NULL,
      date VARCHAR(20) NOT NULL,
      now_cost INT,
      status VARCHAR(10),
      chance_of_playing INT,
      form FLOAT,
      selected_by_percent FLOAT,
      PRIMARY KEY (player_id, date)
    )
  `);

  await p.execute(`
    CREATE TABLE IF NOT EXISTS watchlist (
      chat_id VARCHAR(64) NOT NULL,
      player_id INT NOT NULL,
      player_name VARCHAR(100),
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (chat_id, player_id)
    )
  `);

  await p.execute(`
    CREATE TABLE IF NOT EXISTS user_preferences (
      chat_id VARCHAR(64) PRIMARY KEY,
      notify_prices TINYINT DEFAULT 1,
      notify_status TINYINT DEFAULT 1,
      notify_watchlist TINYINT DEFAULT 1,
      notify_differentials TINYINT DEFAULT 0,
      watchlist_limit INT DEFAULT 10,
      lang VARCHAR(10) DEFAULT 'id',
      tier VARCHAR(20) DEFAULT 'free',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  await p.execute(`
    CREATE TABLE IF NOT EXISTS cache_meta (
      \`key\` VARCHAR(255) PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  await p.execute(`
    CREATE TABLE IF NOT EXISTS users (
      chat_id VARCHAR(64) PRIMARY KEY,
      fpl_id INT,
      username VARCHAR(100),
      first_name VARCHAR(100),
      last_name VARCHAR(100),
      language_code VARCHAR(10),
      registered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
      command_count INT DEFAULT 0,
      last_command VARCHAR(100),
      fpl_token TEXT,
      fpl_refresh_token TEXT
    )
  `);

  await p.execute(`
    CREATE TABLE IF NOT EXISTS user_activity (
      id INT AUTO_INCREMENT PRIMARY KEY,
      chat_id VARCHAR(64),
      command VARCHAR(100),
      args TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_activity_chat (chat_id),
      INDEX idx_activity_timestamp (timestamp)
    )
  `);

  await p.execute(`
    CREATE TABLE IF NOT EXISTS web_users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      name VARCHAR(100),
      fpl_id INT,
      tier VARCHAR(20) DEFAULT 'free',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_login DATETIME
    )
  `);

  console.log('[DB] MySQL tables initialized');
}

// ===== Snapshot =====
async function saveSnapshot(players, date) {
  const p = getPool();
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    for (const pl of players) {
      await conn.execute(
        `REPLACE INTO snapshots (player_id, date, now_cost, status, chance_of_playing, form, selected_by_percent)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [pl.id, date, pl.now_cost, pl.status, pl.chance_of_playing_next_round ?? null,
         parseFloat(pl.form) || 0, parseFloat(pl.selected_by_percent) || 0]
      );
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function getSnapshot(date) {
  const [rows] = await getPool().execute('SELECT * FROM snapshots WHERE date = ?', [date]);
  return rows;
}

async function getPreviousSnapshot(beforeDate) {
  const [rows] = await getPool().execute(
    'SELECT DISTINCT date FROM snapshots WHERE date < ? ORDER BY date DESC LIMIT 1', [beforeDate]
  );
  if (!rows.length) return [];
  return getSnapshot(rows[0].date);
}

// ===== Watchlist (per-user) =====
async function addToWatchlist(chatId, playerId, playerName) {
  await getPool().execute(
    'REPLACE INTO watchlist (chat_id, player_id, player_name) VALUES (?, ?, ?)',
    [String(chatId), playerId, playerName]
  );
}

async function removeFromWatchlist(chatId, playerId) {
  await getPool().execute('DELETE FROM watchlist WHERE chat_id = ? AND player_id = ?', [String(chatId), playerId]);
}

async function getWatchlist(chatId) {
  const [rows] = await getPool().execute('SELECT * FROM watchlist WHERE chat_id = ? ORDER BY added_at', [String(chatId)]);
  return rows;
}

async function getWatchlistCount(chatId) {
  const [rows] = await getPool().execute('SELECT COUNT(*) as cnt FROM watchlist WHERE chat_id = ?', [String(chatId)]);
  return rows[0].cnt;
}

async function isWatched(chatId, playerId) {
  const [rows] = await getPool().execute('SELECT 1 FROM watchlist WHERE chat_id = ? AND player_id = ?', [String(chatId), playerId]);
  return rows.length > 0;
}

async function getAllWatchedPlayerIds() {
  const [rows] = await getPool().execute('SELECT DISTINCT player_id FROM watchlist');
  return rows.map(r => r.player_id);
}

async function getUsersWatchingPlayer(playerId) {
  const [rows] = await getPool().execute('SELECT chat_id FROM watchlist WHERE player_id = ?', [playerId]);
  return rows.map(r => r.chat_id);
}

// ===== User Preferences =====
async function getUserPreferences(chatId) {
  const p = getPool();
  let [rows] = await p.execute('SELECT * FROM user_preferences WHERE chat_id = ?', [String(chatId)]);
  if (!rows.length) {
    await p.execute('INSERT IGNORE INTO user_preferences (chat_id) VALUES (?)', [String(chatId)]);
    [rows] = await p.execute('SELECT * FROM user_preferences WHERE chat_id = ?', [String(chatId)]);
  }
  return rows[0];
}

async function updateUserPreference(chatId, key, value) {
  const allowed = ['notify_prices', 'notify_status', 'notify_watchlist', 'notify_differentials'];
  if (!allowed.includes(key)) return false;
  await getPool().execute(
    `UPDATE user_preferences SET ${key} = ? WHERE chat_id = ?`,
    [value, String(chatId)]
  );
  return true;
}

// ===== FPL Token Storage =====
async function saveFplToken(chatId, token, refreshToken) {
  await getPool().execute(
    'UPDATE users SET fpl_token = ?, fpl_refresh_token = ? WHERE chat_id = ?',
    [token || null, refreshToken || null, String(chatId)]
  );
}

async function getFplToken(chatId) {
  const [rows] = await getPool().execute(
    'SELECT fpl_token, fpl_refresh_token FROM users WHERE chat_id = ?', [String(chatId)]
  );
  if (!rows.length || !rows[0].fpl_token) return null;
  return { token: rows[0].fpl_token, refreshToken: rows[0].fpl_refresh_token };
}

async function clearFplToken(chatId) {
  await getPool().execute(
    'UPDATE users SET fpl_token = NULL, fpl_refresh_token = NULL WHERE chat_id = ?', [String(chatId)]
  );
}

async function getAllFplTokens() {
  const [rows] = await getPool().execute(
    'SELECT chat_id, fpl_id, fpl_token, fpl_refresh_token FROM users WHERE fpl_token IS NOT NULL'
  );
  return rows;
}

// ===== Language =====
async function getUserLang(chatId) {
  const prefs = await getUserPreferences(chatId);
  return prefs?.lang || 'id';
}

async function setUserLang(chatId, lang) {
  await getUserPreferences(chatId); // ensure row exists
  await getPool().execute(
    'UPDATE user_preferences SET lang = ? WHERE chat_id = ?', [lang, String(chatId)]
  );
}

// ===== Tier =====
async function getUserTier(chatId) {
  const prefs = await getUserPreferences(chatId);
  return prefs?.tier || 'free';
}

async function setUserTier(chatId, tier) {
  await getUserPreferences(chatId); // ensure row exists
  await getPool().execute(
    'UPDATE user_preferences SET tier = ? WHERE chat_id = ?', [tier, String(chatId)]
  );
}

// ===== Notification Queries =====
async function getUsersWithNotification(prefKey) {
  const allowed = ['notify_prices', 'notify_status', 'notify_watchlist', 'notify_differentials'];
  if (!allowed.includes(prefKey)) return [];
  const defaultOn = ['notify_prices', 'notify_status', 'notify_watchlist'].includes(prefKey);
  if (defaultOn) {
    const [rows] = await getPool().execute(`
      SELECT u.chat_id FROM users u
      LEFT JOIN user_preferences p ON u.chat_id = p.chat_id
      WHERE p.${prefKey} = 1 OR p.chat_id IS NULL
    `);
    return rows.map(r => r.chat_id);
  } else {
    const [rows] = await getPool().execute(`
      SELECT u.chat_id FROM users u
      INNER JOIN user_preferences p ON u.chat_id = p.chat_id
      WHERE p.${prefKey} = 1
    `);
    return rows.map(r => r.chat_id);
  }
}

// ===== Users =====
async function registerUser(chatId, fplId, ctx) {
  const from = ctx?.from || {};
  await getPool().execute(`
    INSERT INTO users (chat_id, fpl_id, username, first_name, last_name, language_code)
    VALUES (?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      fpl_id = COALESCE(VALUES(fpl_id), fpl_id),
      username = COALESCE(VALUES(username), username),
      first_name = COALESCE(VALUES(first_name), first_name),
      last_name = COALESCE(VALUES(last_name), last_name),
      language_code = COALESCE(VALUES(language_code), language_code),
      last_seen = NOW()
  `, [
    String(chatId), fplId || null,
    from.username || null, from.first_name || null,
    from.last_name || null, from.language_code || null,
  ]);
}

async function getUser(chatId) {
  const [rows] = await getPool().execute('SELECT * FROM users WHERE chat_id = ?', [String(chatId)]);
  return rows[0] || null;
}

async function updateUserActivity(chatId, command, args) {
  const p = getPool();
  await p.execute(
    'UPDATE users SET last_seen = NOW(), command_count = command_count + 1, last_command = ? WHERE chat_id = ?',
    [command, String(chatId)]
  );
  await p.execute(
    'INSERT INTO user_activity (chat_id, command, args) VALUES (?, ?, ?)',
    [String(chatId), command, args || null]
  );
}

async function getUserActivity(chatId, limit = 20) {
  const [rows] = await getPool().execute(
    'SELECT * FROM user_activity WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?',
    [String(chatId), limit]
  );
  return rows;
}

async function getUserStats() {
  const p = getPool();
  const [[{ cnt: totalUsers }]] = await p.execute('SELECT COUNT(*) as cnt FROM users');
  const [[{ cnt: activeToday }]] = await p.execute(
    "SELECT COUNT(*) as cnt FROM users WHERE last_seen >= DATE_SUB(NOW(), INTERVAL 1 DAY)"
  );
  const [[{ cnt: activeWeek }]] = await p.execute(
    "SELECT COUNT(*) as cnt FROM users WHERE last_seen >= DATE_SUB(NOW(), INTERVAL 7 DAY)"
  );
  const [[{ cnt: totalCommands }]] = await p.execute(
    'SELECT COALESCE(SUM(command_count), 0) as cnt FROM users'
  );
  const [topCommands] = await p.execute(
    'SELECT command, COUNT(*) as cnt FROM user_activity GROUP BY command ORDER BY cnt DESC LIMIT 10'
  );
  return { totalUsers, activeToday, activeWeek, totalCommands, topCommands };
}

async function deleteUser(chatId) {
  const p = getPool();
  await p.execute('DELETE FROM user_activity WHERE chat_id = ?', [String(chatId)]);
  await p.execute('DELETE FROM watchlist WHERE chat_id = ?', [String(chatId)]);
  await p.execute('DELETE FROM user_preferences WHERE chat_id = ?', [String(chatId)]);
  await p.execute('DELETE FROM users WHERE chat_id = ?', [String(chatId)]);
}

async function getAllUsers(limit = 50, offset = 0) {
  const [rows] = await getPool().execute('SELECT * FROM users ORDER BY last_seen DESC LIMIT ? OFFSET ?', [limit, offset]);
  return rows;
}

// ===== Web Auth =====
async function createWebUser(email, passwordHash, name, fplId) {
  const [result] = await getPool().execute(
    'INSERT INTO web_users (email, password_hash, name, fpl_id) VALUES (?, ?, ?, ?)',
    [email.toLowerCase().trim(), passwordHash, name || null, fplId || null]
  );
  return { lastInsertRowid: result.insertId };
}

async function getWebUserByEmail(email) {
  const [rows] = await getPool().execute('SELECT * FROM web_users WHERE email = ?', [email.toLowerCase().trim()]);
  return rows[0] || null;
}

async function getWebUserById(id) {
  const [rows] = await getPool().execute(
    'SELECT id, email, name, fpl_id, tier, created_at, last_login FROM web_users WHERE id = ?', [id]
  );
  return rows[0] || null;
}

async function updateWebUserLogin(id) {
  await getPool().execute('UPDATE web_users SET last_login = NOW() WHERE id = ?', [id]);
}

async function updateWebUserTier(id, tier) {
  await getPool().execute('UPDATE web_users SET tier = ? WHERE id = ?', [tier, id]);
}

async function updateWebUserFplId(id, fplId) {
  await getPool().execute('UPDATE web_users SET fpl_id = ? WHERE id = ?', [fplId, id]);
}

module.exports = {
  getPool,
  initDb,
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
