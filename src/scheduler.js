const cron = require('node-cron');
const { fetchAll } = require('./fpl-api');
const { scoreAllPlayers } = require('./scoring');
const {
  saveSnapshot, getPreviousSnapshot,
  getWatchlist, getAllWatchedPlayerIds, getUsersWatchingPlayer,
  getUsersWithNotification, getAllUsers,
} = require('./database');
const fmt = require('./format');
const { trackError } = require('./monitor');

// Broadcast helper — send message to multiple users with rate limiting
async function broadcast(bot, chatIds, text, options = { parse_mode: 'HTML' }) {
  if (!text || chatIds.length === 0) return;
  let sent = 0;
  for (const chatId of chatIds) {
    try {
      await bot.telegram.sendMessage(chatId, text, options);
      sent++;
      // Telegram rate limit: max 30 messages/second
      if (sent % 25 === 0) {
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (err) {
      // User blocked bot or chat not found — log but don't crash
      if (err.response?.error_code === 403 || err.response?.error_code === 400) {
        console.warn(`[Broadcast] User ${chatId} unreachable: ${err.response?.description || err.message}`);
      } else {
        console.error(`[Broadcast] Error sending to ${chatId}:`, err.message);
      }
    }
  }
  console.log(`[Broadcast] Sent to ${sent}/${chatIds.length} users`);
}

function startScheduler(bot, adminChatId) {
  // Admin fallback — always notify admin even if no users
  const sendAdmin = (text) => {
    if (text && adminChatId) {
      bot.telegram.sendMessage(adminChatId, text, { parse_mode: 'HTML' }).catch(console.error);
    }
  };

  // Cek perubahan harga & status — setiap hari jam 08:00 WIB (01:00 UTC)
  cron.schedule('0 1 * * *', async () => {
    console.log('[Cron] Checking price & status changes...');
    try {
      const data = await fetchAll();
      const today = new Date().toISOString().slice(0, 10);

      // Simpan snapshot hari ini
      await saveSnapshot(data.players, today);

      // Bandingkan dengan snapshot sebelumnya
      const prev = await getPreviousSnapshot(today);
      if (prev.length === 0) {
        console.log('[Cron] No previous snapshot for comparison.');
        return;
      }

      const prevMap = {};
      for (const s of prev) prevMap[s.player_id] = s;

      // Track all watched player IDs across all users
      const allWatchedIds = new Set(await getAllWatchedPlayerIds());

      const priceChanges = [];
      const statusChanges = [];
      // Track which watched players had changes (for per-user watchlist notif)
      const watchedPriceChanges = [];
      const watchedStatusChanges = [];

      for (const p of data.players) {
        const old = prevMap[p.id];
        if (!old) {
          // New player — only track if watched
          if (allWatchedIds.has(p.id) && p.status !== 'a') {
            watchedStatusChanges.push({
              playerId: p.id,
              name: p.web_name,
              oldStatus: 'a',
              newStatus: p.status,
              chance: p.chance_of_playing_next_round,
            });
          }
          continue;
        }

        // Price change
        if (p.now_cost !== old.now_cost) {
          const change = {
            playerId: p.id,
            name: p.web_name,
            oldPrice: old.now_cost,
            newPrice: p.now_cost,
            diff: p.now_cost - old.now_cost,
          };
          // Popular player (EO > 5%) — broadcast to price subscribers
          if (parseFloat(p.selected_by_percent) > 5) {
            priceChanges.push(change);
          }
          // Watched player — notify watchers
          if (allWatchedIds.has(p.id)) {
            watchedPriceChanges.push(change);
          }
        }

        // Status change
        if (p.status !== old.status) {
          const change = {
            playerId: p.id,
            name: p.web_name,
            oldStatus: old.status,
            newStatus: p.status,
            chance: p.chance_of_playing_next_round,
          };
          if (parseFloat(p.selected_by_percent) > 5) {
            statusChanges.push(change);
          }
          if (allWatchedIds.has(p.id)) {
            watchedStatusChanges.push(change);
          }
        }
      }

      // === Broadcast popular price/status changes to subscribers ===
      const priceMsg = fmt.priceChangeNotif(priceChanges);
      if (priceMsg) {
        const priceUsers = await getUsersWithNotification('notify_prices');
        console.log(`[Cron] Broadcasting price changes to ${priceUsers.length} users`);
        await broadcast(bot, priceUsers, priceMsg);
      }

      const statusMsg = fmt.statusChangeNotif(statusChanges);
      if (statusMsg) {
        const statusUsers = await getUsersWithNotification('notify_status');
        console.log(`[Cron] Broadcasting status changes to ${statusUsers.length} users`);
        await broadcast(bot, statusUsers, statusMsg);
      }

      // === Per-user watchlist price/status notifications ===
      // Group changes by user — each user only gets notified about THEIR watched players
      if (watchedPriceChanges.length > 0 || watchedStatusChanges.length > 0) {
        const watchlistUsers = await getUsersWithNotification('notify_watchlist');
        const watchlistUserSet = new Set(watchlistUsers);

        // Build per-user notification
        const userNotifs = {}; // chatId -> { priceChanges: [], statusChanges: [] }

        for (const change of watchedPriceChanges) {
          const watchers = await getUsersWatchingPlayer(change.playerId);
          for (const chatId of watchers) {
            if (!watchlistUserSet.has(chatId)) continue;
            if (!userNotifs[chatId]) userNotifs[chatId] = { priceChanges: [], statusChanges: [] };
            userNotifs[chatId].priceChanges.push(change);
          }
        }
        for (const change of watchedStatusChanges) {
          const watchers = await getUsersWatchingPlayer(change.playerId);
          for (const chatId of watchers) {
            if (!watchlistUserSet.has(chatId)) continue;
            if (!userNotifs[chatId]) userNotifs[chatId] = { priceChanges: [], statusChanges: [] };
            userNotifs[chatId].statusChanges.push(change);
          }
        }

        // Send personalized watchlist notifications
        let sentCount = 0;
        for (const [chatId, notif] of Object.entries(userNotifs)) {
          const lines = ['<b>👁 Watchlist Alert</b>\n'];
          if (notif.priceChanges.length > 0) {
            const msg = fmt.priceChangeNotif(notif.priceChanges);
            if (msg) lines.push(msg);
          }
          if (notif.statusChanges.length > 0) {
            const msg = fmt.statusChangeNotif(notif.statusChanges);
            if (msg) lines.push(msg);
          }
          if (lines.length > 1) {
            try {
              await bot.telegram.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
              sentCount++;
              if (sentCount % 25 === 0) await new Promise(r => setTimeout(r, 1000));
            } catch (err) {
              console.warn(`[Cron] Watchlist notif failed for ${chatId}:`, err.message);
            }
          }
        }
        if (sentCount > 0) console.log(`[Cron] Sent watchlist alerts to ${sentCount} users`);
      }

    } catch (err) {
      console.error('[Cron] Error:', err.message);
      trackError('cron:daily', err);
    }
  });

  // Ringkasan differential — Jumat jam 18:00 WIB (11:00 UTC), menjelang deadline
  cron.schedule('0 11 * * 5', async () => {
    console.log('[Cron] Sending differential summary...');
    try {
      const data = await fetchAll();
      const scored = scoreAllPlayers(data.players);
      const diffs = scored
        .filter(p => p.scoring.label === 'DIFFERENTIAL' && p.minutes > 0 && p.scoring.minutesSafe)
        .sort((a, b) => b.scoring.differentialScore - a.scoring.differentialScore);

      const msg = fmt.rankingList(diffs, '💎 Differential Picks Minggu Ini', 15);
      const diffUsers = await getUsersWithNotification('notify_differentials');
      if (diffUsers.length > 0) {
        console.log(`[Cron] Broadcasting differentials to ${diffUsers.length} users`);
        await broadcast(bot, diffUsers, msg);
      } else {
        // Fallback: send to admin only
        sendAdmin(msg);
      }
    } catch (err) {
      console.error('[Cron] Error differential summary:', err.message);
      trackError('cron:differential', err);
    }
  });

  // Watchlist daily update — setiap hari jam 09:00 WIB (02:00 UTC)
  cron.schedule('0 2 * * *', async () => {
    console.log('[Cron] Sending watchlist daily updates...');
    try {
      const watchlistUsers = await getUsersWithNotification('notify_watchlist');
      if (watchlistUsers.length === 0) return;

      const data = await fetchAll();
      const scored = scoreAllPlayers(data.players);

      let sentCount = 0;
      for (const chatId of watchlistUsers) {
        const watchlist = await getWatchlist(chatId);
        if (watchlist.length === 0) continue;

        const lines = ['<b>👁 Watchlist Daily Update</b>\n'];
        for (const w of watchlist) {
          const p = scored.find(s => s.id === w.player_id);
          if (!p) continue;
          const s = p.scoring;
          lines.push(
            `• <b>${p.web_name}</b> Q:${s.qualityScore} D:${s.differentialScore} | ` +
            `Form:${p.form} | ${fmt.priceStr(p.now_cost)} | ${s.label}` +
            (s.regression ? ` | ${s.regression}` : '')
          );
        }

        if (lines.length <= 1) continue; // no valid players found

        try {
          await bot.telegram.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
          sentCount++;
          if (sentCount % 25 === 0) await new Promise(r => setTimeout(r, 1000));
        } catch (err) {
          console.warn(`[Cron] Watchlist update failed for ${chatId}:`, err.message);
        }
      }
      console.log(`[Cron] Sent watchlist updates to ${sentCount} users`);
    } catch (err) {
      console.error('[Cron] Error watchlist update:', err.message);
      trackError('cron:watchlist', err);
    }
  });

  console.log('✅ Scheduler started (UTC timezone)');
  console.log('   - Price/status check: daily 01:00 UTC (08:00 WIB)');
  console.log('   - Differential summary: Friday 11:00 UTC (18:00 WIB)');
  console.log('   - Watchlist update: daily 02:00 UTC (09:00 WIB)');
}

module.exports = { startScheduler };
