require('dotenv').config();

const { Telegraf } = require('telegraf');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { registerCommands } = require('./commands');
const { registerAdminCommands } = require('./admin');
const { startScheduler } = require('./scheduler');
const { restoreSessions } = require('./fpl-api');
const { getAllFplTokens } = require('./database');
const webRoutes = require('./web/routes');

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const PORT = process.env.PORT || 3000;
const WEBHOOK_DOMAIN = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RENDER_EXTERNAL_HOSTNAME || process.env.WEBHOOK_DOMAIN;

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN environment variable is required.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// Register all commands
registerCommands(bot);
registerAdminCommands(bot);

// Handle unknown commands (runs after all command/text handlers in commands.js)
bot.on('text', ctx => {
  if (ctx.message.text.startsWith('/')) {
    ctx.reply('❓ Perintah tidak dikenal. Ketik /help untuk panduan.');
  }
});

// Error handling
const { trackError, getMetrics } = require('./monitor');
bot.catch((err, ctx) => {
  console.error(`❌ Bot error for ${ctx.updateType}:`, err.message);
  trackError(`bot:${ctx.updateType}`, err);
});

// === Express Web App ===
const app = express();
app.use(express.json());

// Start
async function main() {
  try {
    if (WEBHOOK_DOMAIN) {
      // === WEBHOOK MODE (Railway/Render/Production) ===
      const webhookSecret = crypto.randomBytes(32).toString('hex');
      const webhookPath = `/webhook/${BOT_TOKEN.split(':')[0]}`;
      const webhookUrl = `https://${WEBHOOK_DOMAIN}${webhookPath}`;

      // Telegram webhook handler via Express
      app.post(webhookPath, (req, res) => {
        const token = req.headers['x-telegram-bot-api-secret-token'];
        if (token !== webhookSecret) {
          return res.sendStatus(403);
        }
        bot.handleUpdate(req.body, res);
      });

      // Web app routes (after webhook, before 404)
      app.use(webRoutes);

      const server = http.createServer(app);
      server.listen(PORT, () => {
        console.log(`🌐 Server on port ${PORT} (Bot webhook + Web app)`);
      });

      await bot.telegram.setWebhook(webhookUrl, { secret_token: webhookSecret });
      console.log(`🔗 Webhook mode: ${webhookUrl}`);

    } else {
      // === POLLING MODE (Lokal/Development) ===
      // Web app routes
      app.use(webRoutes);

      const server = http.createServer(app);
      server.listen(PORT, () => {
        console.log(`🌐 Web app running on http://localhost:${PORT}`);
      });

      await bot.telegram.deleteWebhook({ drop_pending_updates: false });
      await bot.launch();
      console.log('🔗 Bot polling mode');
    }

    // Restore FPL sessions from DB
    try {
      const tokens = getAllFplTokens();
      if (tokens.length > 0) restoreSessions(tokens);
    } catch (err) {
      console.error('FPL session restore warning:', err.message);
    }

    startScheduler(bot, CHAT_ID);
    console.log('🤖 Mallempu Bot is running! (v7)');
    console.log(`📋 Admin CHAT_ID: ${CHAT_ID || '(not set)'}`);

    // Kirim notifikasi ke admin
    if (CHAT_ID) {
      try {
        await bot.telegram.sendMessage(CHAT_ID,
          '✅ <b>Bot sudah online!</b>\n\n' +
          `⏱ ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}\n\n` +
          'Ketik /start untuk lihat daftar perintah.',
          { parse_mode: 'HTML' }
        );
      } catch (e) {
        console.error('❌ Notification error:', e.message);
      }
    }
  } catch (err) {
    console.error('❌ Failed to start:', err.message);
    process.exit(1);
  }
}

main();

process.once('SIGINT', () => { bot.stop('SIGINT'); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); });
