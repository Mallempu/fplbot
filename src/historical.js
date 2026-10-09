const axios = require('axios');
const { getPool } = require('./database');

const GITHUB_RAW = 'https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data';
const SEASONS = ['2022-23', '2023-24', '2024-25'];

// =====================
// CSV PARSER
// =====================

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

function parseCSV(text) {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length === 0) return [];
  const headers = parseCSVLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    if (values.length !== headers.length) continue;
    const row = {};
    headers.forEach((h, idx) => { row[h] = values[idx]; });
    rows.push(row);
  }
  return rows;
}

// =====================
// DB SETUP
// =====================

async function initHistoricalTables() {
  const pool = getPool();
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS historical_seasons (
      player_key VARCHAR(255),
      season VARCHAR(255),
      web_name TEXT,
      first_name TEXT,
      second_name TEXT,
      position INTEGER,
      team_code INTEGER,
      total_points INTEGER,
      minutes INTEGER,
      goals_scored INTEGER,
      assists INTEGER,
      clean_sheets INTEGER,
      bonus INTEGER,
      bps INTEGER,
      xg FLOAT,
      xa FLOAT,
      xgi FLOAT,
      xgc FLOAT,
      now_cost INTEGER,
      selected_by_percent FLOAT,
      points_per_game FLOAT,
      starts INTEGER,
      ict_index FLOAT,
      influence FLOAT,
      creativity FLOAT,
      threat FLOAT,
      yellow_cards INTEGER,
      red_cards INTEGER,
      saves INTEGER,
      PRIMARY KEY (player_key, season)
    )
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS historical_meta (
      \`key\` VARCHAR(255) PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

// =====================
// PLAYER KEY MATCHING
// =====================

function makePlayerKey(firstName, secondName) {
  return `${(firstName || '').toLowerCase().trim()}|${(secondName || '').toLowerCase().trim()}`;
}

function makePlayerKeyFromRow(row) {
  return makePlayerKey(row.first_name, row.second_name);
}

// =====================
// FETCH & STORE
// =====================

async function fetchSeasonData(season) {
  const url = `${GITHUB_RAW}/${season}/players_raw.csv`;
  try {
    const { data } = await axios.get(url, { timeout: 30000, responseType: 'text' });
    return parseCSV(data);
  } catch (err) {
    console.error(`  ❌ Failed to fetch ${season}:`, err.message);
    return [];
  }
}

async function storeSeasonData(season, rows) {
  const conn = await getPool().getConnection();
  await conn.beginTransaction();
  try {
    for (const r of rows) {
      const key = makePlayerKeyFromRow(r);
      await conn.execute(
        `REPLACE INTO historical_seasons
        (player_key, season, web_name, first_name, second_name, position, team_code,
         total_points, minutes, goals_scored, assists, clean_sheets, bonus, bps,
         xg, xa, xgi, xgc, now_cost, selected_by_percent, points_per_game,
         starts, ict_index, influence, creativity, threat, yellow_cards, red_cards, saves)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          key, season,
          r.web_name || '', r.first_name || '', r.second_name || '',
          parseInt(r.element_type) || 0,
          parseInt(r.team_code) || 0,
          parseInt(r.total_points) || 0,
          parseInt(r.minutes) || 0,
          parseInt(r.goals_scored) || 0,
          parseInt(r.assists) || 0,
          parseInt(r.clean_sheets) || 0,
          parseInt(r.bonus) || 0,
          parseInt(r.bps) || 0,
          parseFloat(r.expected_goals) || 0,
          parseFloat(r.expected_assists) || 0,
          parseFloat(r.expected_goal_involvements) || 0,
          parseFloat(r.expected_goals_conceded) || 0,
          parseInt(r.now_cost) || 0,
          parseFloat(r.selected_by_percent) || 0,
          parseFloat(r.points_per_game) || 0,
          parseInt(r.starts) || 0,
          parseFloat(r.ict_index) || 0,
          parseFloat(r.influence) || 0,
          parseFloat(r.creativity) || 0,
          parseFloat(r.threat) || 0,
          parseInt(r.yellow_cards) || 0,
          parseInt(r.red_cards) || 0,
          parseInt(r.saves) || 0
        ]
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

async function refreshHistoricalData() {
  await initHistoricalTables();
  const results = {};
  for (const season of SEASONS) {
    console.log(`📊 Fetching historical data ${season}...`);
    const rows = await fetchSeasonData(season);
    if (rows.length > 0) {
      await storeSeasonData(season, rows);
      results[season] = rows.length;
      console.log(`  ✅ ${season}: ${rows.length} players`);
    }
  }
  await getPool().execute(
    'REPLACE INTO historical_meta (`key`, value, updated_at) VALUES (?, ?, NOW())',
    ['last_refresh', new Date().toISOString()]
  );
  return results;
}

async function needsRefresh() {
  await initHistoricalTables();
  const [rows] = await getPool().execute("SELECT value FROM historical_meta WHERE `key` = 'last_refresh'");
  if (!rows.length) return true;
  const lastRefresh = new Date(rows[0].value);
  return lastRefresh < new Date(Date.now() - 7 * 24 * 3600_000);
}

async function hasHistoricalData() {
  await initHistoricalTables();
  const [rows] = await getPool().execute('SELECT COUNT(*) as cnt FROM historical_seasons');
  return rows[0].cnt > 0;
}

// =====================
// QUERY
// =====================

async function getPlayerHistory(playerKey) {
  await initHistoricalTables();
  const [rows] = await getPool().execute(
    'SELECT * FROM historical_seasons WHERE player_key = ? ORDER BY season',
    [playerKey]
  );
  return rows;
}

async function getMultiSeasonPlayers() {
  await initHistoricalTables();
  const [rows] = await getPool().execute(`
    SELECT player_key, COUNT(DISTINCT season) as seasons
    FROM historical_seasons WHERE minutes > 0
    GROUP BY player_key HAVING seasons >= 2
  `);
  return rows;
}

// =====================
// MATH UTILITIES
// =====================

function linearRegression(values) {
  const n = values.length;
  if (n < 2) return { slope: 0, r2: 0, predicted: values[n - 1] || 0 };

  const xs = values.map((_, i) => i);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = values.reduce((a, b) => a + b, 0) / n;

  let ssXY = 0, ssXX = 0, ssYY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = values[i] - meanY;
    ssXY += dx * dy;
    ssXX += dx * dx;
    ssYY += dy * dy;
  }

  const slope = ssXX > 0 ? ssXY / ssXX : 0;
  const intercept = meanY - slope * meanX;
  const r2 = (ssXX > 0 && ssYY > 0) ? (ssXY * ssXY) / (ssXX * ssYY) : 0;
  const predicted = intercept + slope * n; // next season prediction

  return { slope, r2, predicted, intercept };
}

function coefficientOfVariation(values) {
  const n = values.length;
  if (n < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (mean === 0) return 1;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / n;
  return Math.sqrt(variance) / Math.abs(mean);
}

function clamp01(x) { return Math.max(0, Math.min(1, x)); }

// =====================
// TREND ANALYSIS
// =====================

async function analyzePlayerTrend(playerKey) {
  const history = await getPlayerHistory(playerKey);
  if (history.length < 2) return null;

  // Hanya musim dengan menit bermain cukup
  const valid = history.filter(h => h.minutes >= 450);
  if (valid.length < 2) return null;

  // Per-90 stats tiap musim
  const seasons = valid.map(s => {
    const m = s.minutes || 1;
    return {
      season: s.season,
      team_code: s.team_code,
      position: s.position,
      minutes: s.minutes,
      totalPoints: s.total_points,
      ppg: s.points_per_game,
      pp90: (s.total_points / m) * 90,
      gp90: (s.goals_scored / m) * 90,
      ap90: (s.assists / m) * 90,
      xgi90: (s.xgi / m) * 90,
      xgc90: (s.xgc / m) * 90,
      cs90: (s.clean_sheets / m) * 90,
      bonus90: (s.bonus / m) * 90,
      bps90: (s.bps / m) * 90,
      ict: s.ict_index,
      influence: s.influence,
      creativity: s.creativity,
      threat: s.threat,
      cost: s.now_cost,
      goals: s.goals_scored,
      assists: s.assists,
      xg: s.xg,
      xa: s.xa,
      xgi: s.xgi,
      starts: s.starts,
      cleanSheets: s.clean_sheets,
    };
  });

  // ---- Trends (linear regression) ----
  const pp90Trend = linearRegression(seasons.map(s => s.pp90));
  const xgi90Trend = linearRegression(seasons.map(s => s.xgi90));
  const minutesTrend = linearRegression(seasons.map(s => s.minutes));
  const ictTrend = linearRegression(seasons.map(s => s.ict));
  const bps90Trend = linearRegression(seasons.map(s => s.bps90));

  // ---- Consistency (lower CV = more consistent) ----
  const pp90CV = coefficientOfVariation(seasons.map(s => s.pp90));
  const xgi90CV = coefficientOfVariation(seasons.map(s => s.xgi90));
  const consistencyScore = clamp01(1 - (0.6 * pp90CV + 0.4 * xgi90CV));

  // ---- Normalize slopes to -1..1 ----
  const normSlope = (slope, scale) => Math.max(-1, Math.min(1, slope / scale));

  const components = {
    pp90: normSlope(pp90Trend.slope, 1.5),
    xgi90: normSlope(xgi90Trend.slope, 0.3),
    minutes: normSlope(minutesTrend.slope, 1000),
    ict: normSlope(ictTrend.slope, 50),
    bps90: normSlope(bps90Trend.slope, 3),
    consistency: consistencyScore,
  };

  // ---- Overall trend score (0-100) ----
  // 0.5 = neutral, >0.5 = improving, <0.5 = declining
  const raw =
    0.30 * (components.pp90 + 1) / 2 +
    0.25 * (components.xgi90 + 1) / 2 +
    0.15 * (components.minutes + 1) / 2 +
    0.10 * (components.ict + 1) / 2 +
    0.05 * (components.bps90 + 1) / 2 +
    0.15 * components.consistency;

  const trendScore = Math.round(raw * 100);

  // ---- Label ----
  let trendLabel;
  if (trendScore >= 65) trendLabel = 'IMPROVING';
  else if (trendScore <= 35) trendLabel = 'DECLINING';
  else trendLabel = 'CONSISTENT';

  // ---- Predicted next-season pp90 ----
  const predictedPP90 = Math.max(0, pp90Trend.predicted);

  // ---- Team change flag ----
  const teamCodes = seasons.map(s => s.team_code);
  const changedTeam = new Set(teamCodes).size > 1;

  // ---- Overperformance trend (goals vs xG across seasons) ----
  const totalGoals = seasons.reduce((s, v) => s + v.goals, 0);
  const totalXG = seasons.reduce((s, v) => s + v.xg, 0);
  const totalAssists = seasons.reduce((s, v) => s + v.assists, 0);
  const totalXA = seasons.reduce((s, v) => s + v.xa, 0);
  const overperformGoals = totalGoals - totalXG;
  const overperformAssists = totalAssists - totalXA;

  return {
    seasons,
    seasonsCount: valid.length,
    trendScore,
    trendLabel,
    components,
    trends: {
      pp90: pp90Trend,
      xgi90: xgi90Trend,
      minutes: minutesTrend,
      ict: ictTrend,
      bps90: bps90Trend,
    },
    consistency: Math.round(consistencyScore * 100),
    predictedPP90: Math.round(predictedPP90 * 100) / 100,
    changedTeam,
    overperformance: {
      goals: Math.round(overperformGoals * 10) / 10,
      assists: Math.round(overperformAssists * 10) / 10,
    },
  };
}

// Build trend map for all players (keyed by player_key)
async function buildTrendMap() {
  const multi = await getMultiSeasonPlayers();
  const map = {};
  for (const { player_key } of multi) {
    const t = await analyzePlayerTrend(player_key);
    if (t) map[player_key] = t;
  }
  return map;
}

// Auto-ensure data, lazy load
let _ensured = false;
async function ensureHistoricalData() {
  if (_ensured && await hasHistoricalData()) return;
  if (await needsRefresh() || !await hasHistoricalData()) {
    await refreshHistoricalData();
  }
  _ensured = true;
}

module.exports = {
  refreshHistoricalData,
  needsRefresh,
  hasHistoricalData,
  ensureHistoricalData,
  getPlayerHistory,
  analyzePlayerTrend,
  buildTrendMap,
  getMultiSeasonPlayers,
  makePlayerKey,
  SEASONS,
  initHistoricalTables,
};
