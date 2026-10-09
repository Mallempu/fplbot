const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { fetchManagerInfo, fetchManagerPicks, fetchBootstrap, fetchFixtures, fetchManagerTransfers, fetchMyTeam, getUserSession, startAuthCodeFlow, exchangeAuthCode, clearUserSession } = require('../fpl-api');
const { getScoredPlayers, findPlayer } = require('../commands');
const { getUser, getUserStats, createWebUser, getWebUserByEmail, getWebUserById, updateWebUserLogin, updateWebUserTier, updateWebUserFplId, getPool } = require('../database');
const { getMetrics } = require('../monitor');
const { POSITION_NAMES } = require('../config');
const { generateExpertPicks, summarizePlayer } = require('../expert-picks');
const { predictPriceChanges } = require('../price-warnings');
const { predictLineup, predictAllLineups } = require('../predicted-lineups');
const { analyzeChipTiming } = require('../chip-planner');
const { buildTransferPlan } = require('../transfer-planner');
const { simulateTransfers } = require('../whatif');

const router = express.Router();

// ===== Simple token auth (HMAC-based, no JWT dependency) =====
const AUTH_SECRET = process.env.AUTH_SECRET || crypto.randomBytes(32).toString('hex');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const parts = stored.split(':');
  if (parts.length !== 2) return false;
  const [salt, hash] = parts;
  try {
    const test = crypto.scryptSync(password, salt, 64).toString('hex');
    return test === hash;
  } catch {
    return false;
  }
}

function generateToken(userId) {
  const payload = JSON.stringify({ id: userId, exp: Date.now() + 7 * 24 * 3600_000 }); // 7 days
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('hex');
  return Buffer.from(payload).toString('base64url') + '.' + sig;
}

function verifyToken(token) {
  if (!token) return null;
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) return null;
  try {
    const payload = Buffer.from(payloadB64, 'base64url').toString();
    const expected = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('hex');
    if (sig !== expected) return null;
    const data = JSON.parse(payload);
    if (data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

async function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  const data = verifyToken(token);
  req.userId = data?.id || null;
  next();
}

// --- Static frontend ---
router.use(express.static(path.join(__dirname, 'public')));

// --- API Endpoints ---

// Health / status
router.get('/api/health', (req, res) => {
  const m = getMetrics();
  res.json({ status: 'ok', uptime: m.uptime, memoryMB: m.memoryMB, commands: m.commands.total });
});

// Current GW info
router.get('/api/gameweek', async (req, res) => {
  try {
    const bootstrap = await fetchBootstrap();
    const current = bootstrap.events.find(e => e.is_current);
    const next = bootstrap.events.find(e => e.is_next);
    res.json({
      current: current ? { id: current.id, name: current.name, deadline: current.deadline_time, finished: current.finished } : null,
      next: next ? { id: next.id, name: next.name, deadline: next.deadline_time } : null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch gameweek data' });
  }
});

// Squad endpoint - the main real-time feature
router.get('/api/squad/:managerId', authMiddleware, async (req, res) => {
  const managerId = parseInt(req.params.managerId);
  if (!managerId || isNaN(managerId)) {
    return res.status(400).json({ error: 'Invalid manager ID' });
  }

  try {
    const [manager, { scored, teams, currentGw }, transfers] = await Promise.all([
      fetchManagerInfo(managerId),
      getScoredPlayers(),
      fetchManagerTransfers(managerId).catch(() => []),
    ]);

    const bootstrap = await fetchBootstrap();
    const nextGw = bootstrap.events.find(e => e.is_next)?.id || currentGw;

    let picks = null;
    let displayGw = currentGw;
    let isLive = false;
    let isProjected = false;

    // 1) Try live data via authenticated my-team endpoint
    //    Check if web user has a linked FPL session, or fallback to owner session
    let liveSessionId = null;
    if (req.userId) {
      const webUser = await getWebUserById(req.userId);
      if (webUser?.fpl_id === managerId) {
        liveSessionId = `web_${req.userId}`;
      }
    }
    // Fallback: try owner session for any manager (owner's FPL creds)
    if (!liveSessionId) {
      const ownerId = String(process.env.OWNER_ID || process.env.CHAT_ID || 'owner');
      if (getUserSession(ownerId)) liveSessionId = ownerId;
    }

    if (liveSessionId) {
      try {
        const myTeam = await fetchMyTeam(managerId, liveSessionId);
        if (myTeam?.picks) {
          picks = { picks: myTeam.picks, entry_history: null };
          displayGw = nextGw;
          isLive = true;
        }
      } catch (err) {
        console.warn('Live squad fetch failed:', err.message);
      }
    }

    // 2) Fallback to public picks endpoint
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
        } catch (err) {
          console.warn(`Picks fetch GW${gw} failed:`, err.message);
        }
      }
    }

    if (!picks) {
      return res.status(404).json({ error: 'No squad data found' });
    }

    // Apply pending transfers (only if not already live)
    if (!isLive) {
      const pendingTransfers = transfers.filter(t => t.event > displayGw);
      if (pendingTransfers.length > 0) {
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

    // Enrich picks with player data
    const enrichedPicks = picks.picks.map(pick => {
      const player = scored.find(p => p.id === pick.element);
      if (!player) return { ...pick, player: null };
      const team = teams[player.team];
      return {
        position: pick.position,
        isCaptain: pick.is_captain,
        isViceCaptain: pick.is_vice_captain,
        multiplier: pick.multiplier,
        player: {
          id: player.id,
          webName: player.web_name,
          firstName: player.first_name,
          secondName: player.second_name,
          elementType: player.element_type,
          positionName: POSITION_NAMES[player.element_type],
          team: team?.name || 'Unknown',
          teamShort: team?.short_name || '?',
          nowCost: player.now_cost,
          price: (player.now_cost / 10).toFixed(1),
          form: player.form,
          totalPoints: player.total_points,
          pointsPerGame: player.points_per_game,
          selectedByPercent: player.selected_by_percent,
          minutes: player.minutes,
          status: player.status,
          chanceOfPlayingNextRound: player.chance_of_playing_next_round,
          goalsScored: player.goals_scored,
          assists: player.assists,
          cleanSheets: player.clean_sheets,
          qualityScore: player.scoring?.qualityScore || 0,
          differentialScore: player.scoring?.differentialScore || 0,
          label: player.scoring?.label || '',
          regression: player.scoring?.regression || null,
          components: player.scoring?.components || {},
          minutesSafe: player.scoring?.minutesSafe || false,
          nextFixtures: (player.nextFixtures || []).slice(0, 4).map(f => ({
            gw: f.gw,
            opponent: f.opponent,
            isHome: f.isHome,
            fdr: f.fdr,
          })),
        },
      };
    });

    // Split into starting XI and bench
    const startingXI = enrichedPicks.filter(p => p.position <= 11);
    const bench = enrichedPicks.filter(p => p.position > 11);

    // Entry history
    const entryHistory = picks.entry_history ? {
      points: picks.entry_history.points,
      totalPoints: picks.entry_history.total_points,
      rank: picks.entry_history.rank,
      overallRank: picks.entry_history.overall_rank,
      bank: picks.entry_history.bank,
      value: picks.entry_history.value,
      eventTransfers: picks.entry_history.event_transfers,
      eventTransfersCost: picks.entry_history.event_transfers_cost,
      pointsOnBench: picks.entry_history.points_on_bench,
    } : null;

    res.json({
      manager: {
        id: manager.id,
        name: `${manager.player_first_name} ${manager.player_last_name}`,
        teamName: manager.name,
        region: manager.player_region_name,
        overallPoints: manager.summary_overall_points,
        overallRank: manager.summary_overall_rank,
        startedEvent: manager.started_event,
      },
      gameweek: displayGw,
      isLive,
      isProjected,
      startingXI,
      bench,
      entryHistory,
      totalQualityScore: Math.round(
        startingXI.reduce((sum, p) => sum + (p.player?.qualityScore || 0), 0) / 11
      ),
    });
  } catch (err) {
    console.error('API /squad error:', err.message);
    if (err.response?.status === 404) {
      return res.status(404).json({ error: `Manager ID ${managerId} not found` });
    }
    res.status(500).json({ error: 'Failed to fetch squad data' });
  }
});

// Best XI calculation
router.get('/api/best11/:managerId', async (req, res) => {
  const managerId = parseInt(req.params.managerId);
  if (!managerId || isNaN(managerId)) {
    return res.status(400).json({ error: 'Invalid manager ID' });
  }

  try {
    const [manager, { scored, teams, currentGw }] = await Promise.all([
      fetchManagerInfo(managerId),
      getScoredPlayers(),
    ]);

    const bootstrap = await fetchBootstrap();
    const nextGw = bootstrap.events.find(e => e.is_next)?.id || currentGw;

    let picks = null;
    let displayGw = currentGw;

    const gwsToTry = [];
    if (nextGw > currentGw) gwsToTry.push(nextGw);
    gwsToTry.push(currentGw);
    for (let gw = currentGw - 1; gw >= Math.max(1, currentGw - 3); gw--) gwsToTry.push(gw);
    for (const gw of gwsToTry) {
      if (picks) break;
      try { picks = await fetchManagerPicks(managerId, gw); displayGw = gw; } catch (err) { console.warn(`Best11 picks GW${gw} failed:`, err.message); }
    }

    if (!picks) return res.status(404).json({ error: 'No squad data' });

    const squadPlayers = picks.picks.map(pick => {
      const p = scored.find(sp => sp.id === pick.element);
      if (!p) return null;
      const team = teams[p.team];
      return { ...p, currentPosition: pick.position, teamInfo: team };
    }).filter(Boolean);

    if (squadPlayers.length < 15) return res.status(400).json({ error: 'Incomplete squad' });

    const FORMATIONS = [[3,4,3],[3,5,2],[4,3,3],[4,4,2],[4,5,1],[5,3,2],[5,4,1]];
    const byPos = { 1: [], 2: [], 3: [], 4: [] };
    for (const p of squadPlayers) byPos[p.element_type].push(p);
    for (const pos of [1,2,3,4]) byPos[pos].sort((a,b) => b.scoring.qualityScore - a.scoring.qualityScore);

    let bestFormation = null, bestScore = -1, bestStarting = null;
    for (const [nDef, nMid, nFwd] of FORMATIONS) {
      if (byPos[2].length < nDef || byPos[3].length < nMid || byPos[4].length < nFwd) continue;
      const starting = [byPos[1][0], ...byPos[2].slice(0, nDef), ...byPos[3].slice(0, nMid), ...byPos[4].slice(0, nFwd)];
      const totalScore = starting.reduce((sum, p) => {
        let qs = p.scoring.qualityScore;
        if (['i','u','s'].includes(p.status)) qs *= 0.1;
        else if (p.status === 'd') qs *= 0.7;
        return sum + qs;
      }, 0);
      if (totalScore > bestScore) { bestScore = totalScore; bestFormation = `${nDef}-${nMid}-${nFwd}`; bestStarting = starting; }
    }

    if (!bestStarting) return res.status(400).json({ error: 'No valid formation' });

    const startingIds = new Set(bestStarting.map(p => p.id));
    const benchPlayers = squadPlayers.filter(p => !startingIds.has(p.id))
      .sort((a,b) => { if (a.element_type === 1 && b.element_type !== 1) return 1; if (a.element_type !== 1 && b.element_type === 1) return -1; return b.scoring.qualityScore - a.scoring.qualityScore; });

    const captainCandidates = [...bestStarting].sort((a,b) => { const d = b.scoring.qualityScore - a.scoring.qualityScore; return d !== 0 ? d : b.element_type - a.element_type; });

    const formatPlayer = (p, role) => {
      const team = teams[p.team];
      return {
        id: p.id, webName: p.web_name, elementType: p.element_type, positionName: POSITION_NAMES[p.element_type],
        team: team?.name || 'Unknown', teamShort: team?.short_name || '?',
        price: (p.now_cost / 10).toFixed(1), qualityScore: p.scoring.qualityScore,
        form: p.form, status: p.status, role,
        nextFixtures: (p.nextFixtures || []).slice(0, 4).map(f => ({ gw: f.gw, opponent: f.opponent, isHome: f.isHome, fdr: f.fdr })),
      };
    };

    res.json({
      manager: { id: manager.id, name: `${manager.player_first_name} ${manager.player_last_name}`, teamName: manager.name },
      gameweek: displayGw,
      formation: bestFormation,
      totalScore: Math.round(bestScore),
      startingXI: bestStarting.map((p, i) => formatPlayer(p, i === bestStarting.indexOf(captainCandidates[0]) ? 'captain' : i === bestStarting.indexOf(captainCandidates[1]) ? 'vice-captain' : null)),
      bench: benchPlayers.map(p => formatPlayer(p, null)),
      captain: { webName: captainCandidates[0].web_name, qualityScore: captainCandidates[0].scoring.qualityScore },
      viceCaptain: { webName: captainCandidates[1].web_name, qualityScore: captainCandidates[1].scoring.qualityScore },
    });
  } catch (err) {
    console.error('API /best11 error:', err.message);
    if (err.response?.status === 404) return res.status(404).json({ error: 'Manager not found' });
    res.status(500).json({ error: 'Failed to calculate Best XI' });
  }
});

// Top players by position
router.get('/api/players/top', async (req, res) => {
  try {
    const { scored, teams, currentGw } = await getScoredPlayers();
    const pos = parseInt(req.query.position) || 0;
    const limit = Math.min(parseInt(req.query.limit) || 15, 50);

    let filtered = scored;
    if (pos >= 1 && pos <= 4) filtered = scored.filter(p => p.element_type === pos);

    const top = filtered
      .filter(p => p.minutes > 0)
      .sort((a, b) => b.scoring.qualityScore - a.scoring.qualityScore)
      .slice(0, limit)
      .map(p => {
        const team = teams[p.team];
        return {
          id: p.id, webName: p.web_name, elementType: p.element_type,
          positionName: POSITION_NAMES[p.element_type],
          team: team?.name || 'Unknown', teamShort: team?.short_name || '?',
          price: (p.now_cost / 10).toFixed(1), form: p.form,
          totalPoints: p.total_points, selectedByPercent: p.selected_by_percent,
          qualityScore: p.scoring.qualityScore, differentialScore: p.scoring.differentialScore,
          label: p.scoring.label, status: p.status,
        };
      });

    res.json({ players: top, position: pos, currentGw });
  } catch (err) {
    console.error('API /players/top error:', err.message);
    res.status(500).json({ error: 'Failed to fetch top players' });
  }
});

// Differentials
router.get('/api/players/differentials', async (req, res) => {
  try {
    const { scored, teams, currentGw } = await getScoredPlayers();
    const limit = Math.min(parseInt(req.query.limit) || 15, 50);

    const diffs = scored
      .filter(p => p.scoring.label === 'DIFFERENTIAL' && p.minutes > 0)
      .sort((a, b) => b.scoring.differentialScore - a.scoring.differentialScore)
      .slice(0, limit)
      .map(p => {
        const team = teams[p.team];
        return {
          id: p.id, webName: p.web_name, elementType: p.element_type,
          positionName: POSITION_NAMES[p.element_type],
          team: team?.name || 'Unknown', teamShort: team?.short_name || '?',
          price: (p.now_cost / 10).toFixed(1), form: p.form,
          selectedByPercent: p.selected_by_percent,
          qualityScore: p.scoring.qualityScore, differentialScore: p.scoring.differentialScore,
          status: p.status,
        };
      });

    res.json({ players: diffs, currentGw });
  } catch (err) {
    console.error('API /differentials error:', err.message);
    res.status(500).json({ error: 'Failed to fetch differentials' });
  }
});

// Player search
router.get('/api/player/search', async (req, res) => {
  const query = req.query.q?.trim();
  if (!query || query.length < 2) return res.status(400).json({ error: 'Query too short (min 2 chars)' });

  try {
    const { scored, teams } = await getScoredPlayers();
    const q = query.toLowerCase();
    const matches = scored
      .filter(p => p.web_name.toLowerCase().includes(q) || `${p.first_name} ${p.second_name}`.toLowerCase().includes(q))
      .slice(0, 10)
      .map(p => {
        const team = teams[p.team];
        return {
          id: p.id, webName: p.web_name, fullName: `${p.first_name} ${p.second_name}`,
          elementType: p.element_type, positionName: POSITION_NAMES[p.element_type],
          team: team?.name || 'Unknown', teamShort: team?.short_name || '?',
          price: (p.now_cost / 10).toFixed(1), form: p.form,
          totalPoints: p.total_points, selectedByPercent: p.selected_by_percent,
          qualityScore: p.scoring.qualityScore, differentialScore: p.scoring.differentialScore,
          label: p.scoring.label, regression: p.scoring.regression,
          status: p.status, minutes: p.minutes,
          goalsScored: p.goals_scored, assists: p.assists, cleanSheets: p.clean_sheets,
          components: p.scoring.components,
          nextFixtures: (p.nextFixtures || []).slice(0, 4).map(f => ({
            gw: f.gw, opponent: f.opponent, isHome: f.isHome, fdr: f.fdr,
          })),
        };
      });

    res.json({ results: matches, query });
  } catch (err) {
    console.error('API /player/search error:', err.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ===== NEW FEATURES API =====

// Expert Picks
router.get('/api/expert-picks', async (req, res) => {
  try {
    const { scored, teams, currentGw } = await getScoredPlayers();
    const teamsArr = Object.values(teams);
    const picks = generateExpertPicks(scored, currentGw);

    res.json({
      gw: currentGw,
      captain: picks.captain ? summarizePlayer(picks.captain, teamsArr) : null,
      captainAlts: (picks.captainAlts || []).map(p => summarizePlayer(p, teamsArr)),
      transfersIn: Object.fromEntries(
        Object.entries(picks.transfersIn).map(([pos, players]) => [pos, players.map(p => summarizePlayer(p, teamsArr))])
      ),
      differentials: Object.fromEntries(
        Object.entries(picks.differentials).map(([pos, players]) => [pos, players.map(p => summarizePlayer(p, teamsArr))])
      ),
      budgetPicks: Object.fromEntries(
        Object.entries(picks.budgetPicks).map(([pos, players]) => [pos, players.map(p => summarizePlayer(p, teamsArr))])
      ),
    });
  } catch (err) {
    console.error('API /expert-picks error:', err.message);
    res.status(500).json({ error: 'Failed to generate expert picks' });
  }
});

// Price Warnings
router.get('/api/price-warnings', async (req, res) => {
  try {
    const { scored } = await getScoredPlayers();
    const result = predictPriceChanges(scored);
    res.json(result);
  } catch (err) {
    console.error('API /price-warnings error:', err.message);
    res.status(500).json({ error: 'Failed to predict price changes' });
  }
});

// Predicted Lineups — all teams
router.get('/api/predicted-lineups', async (req, res) => {
  try {
    const { scored, teams } = await getScoredPlayers();
    const lineups = predictAllLineups(scored, Object.values(teams));
    res.json({ lineups });
  } catch (err) {
    console.error('API /predicted-lineups error:', err.message);
    res.status(500).json({ error: 'Failed to predict lineups' });
  }
});

// Predicted Lineup — single team
router.get('/api/predicted-lineup/:team', async (req, res) => {
  try {
    const { scored, teams } = await getScoredPlayers();
    const teamsArr = Object.values(teams);
    const q = req.params.team.toLowerCase();
    const team = teamsArr.find(t =>
      t.name.toLowerCase() === q ||
      t.short_name.toLowerCase() === q ||
      t.name.toLowerCase().includes(q)
    );
    if (!team) return res.status(404).json({ error: `Team "${req.params.team}" not found` });

    const teamPlayers = scored.filter(p => p.team === team.id);
    const maxStarts = Math.max(...teamPlayers.map(p => p.starts || 0), 1);
    const lineup = predictLineup(teamPlayers, maxStarts, team.name);
    if (!lineup) return res.status(404).json({ error: 'Not enough data for this team' });
    lineup.teamId = team.id;
    lineup.teamShort = team.short_name;
    res.json(lineup);
  } catch (err) {
    console.error('API /predicted-lineup error:', err.message);
    res.status(500).json({ error: 'Failed to predict lineup' });
  }
});

// Chip Plan
router.get('/api/chip-plan', async (req, res) => {
  try {
    const { scored, teams } = await getScoredPlayers();
    const fixtures = await fetchFixtures();
    const result = analyzeChipTiming(fixtures, Object.values(teams), scored);
    res.json(result);
  } catch (err) {
    console.error('API /chip-plan error:', err.message);
    res.status(500).json({ error: 'Failed to analyze chip timing' });
  }
});

// Transfer Plan
router.get('/api/transfer-plan/:managerId', async (req, res) => {
  const managerId = parseInt(req.params.managerId);
  if (!managerId || isNaN(managerId)) return res.status(400).json({ error: 'Invalid manager ID' });

  try {
    const [{ scored, teams, currentGw }, fixtures] = await Promise.all([
      getScoredPlayers(),
      fetchFixtures(),
    ]);
    const bootstrap = await fetchBootstrap();
    const nextGw = bootstrap.events.find(e => e.is_next)?.id || currentGw;

    let picks = null;
    const gwsToTry = [nextGw, currentGw];
    for (let gw = currentGw - 1; gw >= Math.max(1, currentGw - 3); gw--) gwsToTry.push(gw);
    for (const gw of gwsToTry) {
      if (picks) break;
      try { picks = await fetchManagerPicks(managerId, gw); } catch (err) { console.warn(`Transfer plan picks GW${gw} failed:`, err.message); }
    }
    if (!picks) return res.status(404).json({ error: 'No squad data' });

    const bank = picks.entry_history?.bank || 0;
    const fromGW = parseInt(req.query.from) || nextGw;
    const toGW = parseInt(req.query.to) || Math.min(fromGW + 5, 38);

    const result = buildTransferPlan(picks.picks, scored, fixtures, Object.values(teams), fromGW, toGW, bank);
    res.json(result);
  } catch (err) {
    console.error('API /transfer-plan error:', err.message);
    if (err.response?.status === 404) return res.status(404).json({ error: 'Manager not found' });
    res.status(500).json({ error: 'Failed to build transfer plan' });
  }
});

// What-If Simulator
router.post('/api/whatif', async (req, res) => {
  const { managerId, transfers } = req.body;
  if (!managerId || !transfers?.length) {
    return res.status(400).json({ error: 'managerId and transfers[] required' });
  }

  try {
    const { scored, teams, currentGw } = await getScoredPlayers();
    const bootstrap = await fetchBootstrap();
    const nextGw = bootstrap.events.find(e => e.is_next)?.id || currentGw;

    let picks = null;
    const gwsToTry = [nextGw, currentGw];
    for (const gw of gwsToTry) { if (picks) break; try { picks = await fetchManagerPicks(managerId, gw); } catch (err) { console.warn(`Whatif picks GW${gw} failed:`, err.message); } }
    if (!picks) return res.status(404).json({ error: 'No squad data' });

    const bank = picks.entry_history?.bank || 0;
    const result = simulateTransfers(picks.picks, scored, transfers, bank);
    res.json(result);
  } catch (err) {
    console.error('API /whatif error:', err.message);
    res.status(500).json({ error: 'Simulation failed' });
  }
});

// ===== AUTH ENDPOINTS =====
router.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name, fplId } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email dan password wajib diisi' });
    if (password.length < 6) return res.status(400).json({ error: 'Password minimal 6 karakter' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Format email tidak valid' });

    const existing = await getWebUserByEmail(email);
    if (existing) return res.status(409).json({ error: 'Email sudah terdaftar. Silakan login.' });

    const passwordHash = hashPassword(password);
    const result = await createWebUser(email, passwordHash, name, fplId || null);
    if (!result?.lastInsertRowid) {
      return res.status(500).json({ error: 'Gagal membuat user' });
    }
    const user = await getWebUserById(result.lastInsertRowid);
    if (!user) {
      return res.status(500).json({ error: 'Gagal membuat user' });
    }
    const token = generateToken(user.id);

    res.json({ token, user: { id: user.id, email: user.email, name: user.name, fplId: user.fpl_id, tier: user.tier } });
  } catch (err) {
    console.error('Register error:', err.message);
    res.status(500).json({ error: 'Registrasi gagal' });
  }
});

router.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email dan password wajib diisi' });

    const user = await getWebUserByEmail(email);
    if (!user) return res.status(401).json({ error: 'Email atau password salah' });

    if (!verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Email atau password salah' });
    }

    await updateWebUserLogin(user.id);
    const token = generateToken(user.id);

    res.json({ token, user: { id: user.id, email: user.email, name: user.name, fplId: user.fpl_id, tier: user.tier } });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Login gagal' });
  }
});

router.get('/api/auth/me', authMiddleware, async (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Tidak terautentikasi' });
  const user = await getWebUserById(req.userId);
  if (!user) return res.status(401).json({ error: 'User tidak ditemukan' });
  res.json({ id: user.id, email: user.email, name: user.name, fplId: user.fpl_id, tier: user.tier });
});

router.post('/api/auth/update', authMiddleware, async (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Tidak terautentikasi' });
  const { fplId } = req.body;
  if (fplId != null) await updateWebUserFplId(req.userId, parseInt(fplId) || null);
  const user = await getWebUserById(req.userId);
  res.json({ id: user.id, email: user.email, name: user.name, fplId: user.fpl_id, tier: user.tier });
});

// ===== FPL LOGIN (Web — PKCE OAuth) =====

// Step 1: Start FPL login — returns auth URL for user to open
router.post('/api/fpl/start-login', authMiddleware, (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Login ke Mallempu dulu' });

  const webUserId = `web_${req.userId}`;
  const authUrl = startAuthCodeFlow(webUserId);
  res.json({ authUrl });
});

// Step 2: Exchange redirect URL for FPL session token
router.post('/api/fpl/exchange-code', authMiddleware, async (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Login ke Mallempu dulu' });

  const { redirectUrl } = req.body;
  if (!redirectUrl) return res.status(400).json({ error: 'Redirect URL wajib diisi' });

  const webUserId = `web_${req.userId}`;
  const result = await exchangeAuthCode(redirectUrl, webUserId);

  if (result.success) {
    res.json({ success: true, message: 'FPL login berhasil! Squad realtime aktif.' });
  } else {
    res.status(400).json({ error: result.error || 'FPL login gagal' });
  }
});

// Check FPL session status
router.get('/api/fpl/status', authMiddleware, (req, res) => {
  if (!req.userId) return res.status(401).json({ connected: false });

  const webUserId = `web_${req.userId}`;
  const session = getUserSession(webUserId);
  res.json({ connected: !!session });
});

// Disconnect FPL session
router.post('/api/fpl/disconnect', authMiddleware, (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Tidak terautentikasi' });

  const webUserId = `web_${req.userId}`;
  clearUserSession(webUserId);
  res.json({ success: true, message: 'FPL session disconnected' });
});

// ===== ADMIN ENDPOINTS =====
// List all web users (admin only — protected by ADMIN_KEY env var)
router.get('/api/admin/users', async (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  const provided = req.headers['x-admin-key'] || req.query.key;
  if (!adminKey || provided !== adminKey) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  try {
    const pool = getPool();
    const [users] = await pool.execute('SELECT id, email, name, fpl_id, tier, created_at, last_login FROM web_users ORDER BY created_at DESC');
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Set user tier (admin only)
router.post('/api/admin/set-tier', async (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  const provided = req.headers['x-admin-key'] || req.query.key;
  if (!adminKey || provided !== adminKey) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  const { userId, tier } = req.body;
  if (!userId || !['free', 'pro', 'team'].includes(tier)) {
    return res.status(400).json({ error: 'Invalid userId or tier' });
  }
  try {
    await updateWebUserTier(userId, tier);
    const user = await getWebUserById(userId);
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SPA fallback — serve index.html for non-API routes
router.get('/{*path}', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

module.exports = router;
