const fs = require('fs');
const path = require('path');
const { escapeHtml } = require('./format');

const ENV_PATH = path.join(__dirname, '..', '.env');

// Whitelist key yang boleh diubah via bot
const ALLOWED_KEYS = [
  'BOT_TOKEN', 'CHAT_ID', 'OWNER_ID', 'FPL_ID', 'PORT',
  'EMAIL', 'IG_SESSION_ID', 'ADMIN_SECRET',
  'X_ACCOUNTS', 'IG_ACCOUNTS',
  'METRICS_ACTIVE', 'METRICS_WEIGHTS',
  'FPL_EMAIL', 'FPL_PASSWORD',
];

// Key yang nilainya di-mask saat ditampilkan
const SENSITIVE_KEYS = ['BOT_TOKEN', 'ADMIN_SECRET', 'IG_SESSION_ID', 'FPL_PASSWORD'];

function getOwnerId() {
  return process.env.OWNER_ID || process.env.CHAT_ID || '';
}

function isOwner(ctx) {
  const ownerId = getOwnerId();
  return ownerId && ctx.from?.id && String(ctx.from.id) === String(ownerId);
}

// Key sensitif yang hanya owner bisa ubah
const OWNER_ONLY_KEYS = ['BOT_TOKEN', 'CHAT_ID', 'OWNER_ID', 'FPL_EMAIL', 'FPL_PASSWORD', 'ADMIN_SECRET'];

function parseEnvFile() {
  if (!fs.existsSync(ENV_PATH)) return {};
  const content = fs.readFileSync(ENV_PATH, 'utf-8');
  const env = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.substring(0, eqIdx).trim();
    const val = trimmed.substring(eqIdx + 1).trim();
    env[key] = val;
  }
  return env;
}

function writeEnvFile(envObj) {
  const lines = [
    '# FPL Bot Environment Variables',
    '# Dikelola via /setenv — jangan edit manual saat bot jalan',
    '',
  ];
  for (const [key, val] of Object.entries(envObj)) {
    lines.push(`${key}=${val}`);
  }
  lines.push('');
  // Atomic write: write to temp file then rename
  const tmpPath = ENV_PATH + '.tmp';
  fs.writeFileSync(tmpPath, lines.join('\n'), 'utf-8');
  fs.renameSync(tmpPath, ENV_PATH);
}

function maskValue(key, value) {
  if (!value) return '(kosong)';
  if (SENSITIVE_KEYS.includes(key)) {
    if (value.length <= 8) return '****';
    return value.substring(0, 4) + '****' + value.substring(value.length - 4);
  }
  return value;
}

function registerAdminCommands(bot) {

  // /setenv KEY VALUE — update satu variabel
  bot.command('setenv', (ctx) => {
    if (!isOwner(ctx)) return ctx.reply('🚫 Hanya pemilik bot yang bisa menggunakan perintah ini.');

    const args = ctx.message.text.replace(/^\/setenv\s*/i, '').trim();
    const spaceIdx = args.indexOf(' ');
    if (spaceIdx === -1) {
      return ctx.replyWithHTML(
        '<b>Gunakan:</b> /setenv &lt;KEY&gt; &lt;VALUE&gt;\n\n' +
        '<b>Key yang tersedia:</b>\n' +
        ALLOWED_KEYS.map(k => `• <code>${k}</code>`).join('\n') +
        '\n\n<b>Contoh:</b>\n<code>/setenv FPL_ID 1234567</code>'
      );
    }

    const key = args.substring(0, spaceIdx).toUpperCase().trim();
    const value = args.substring(spaceIdx + 1).trim();

    if (!ALLOWED_KEYS.includes(key)) {
      return ctx.reply(`❌ Key "${key}" tidak diizinkan.\n\nKey yang tersedia: ${ALLOWED_KEYS.join(', ')}`);
    }

    if (OWNER_ONLY_KEYS.includes(key) && !isOwner(ctx)) {
      return ctx.reply('🚫 Key ini hanya bisa diubah oleh pemilik bot (@Abulkhaer).');
    }

    if (!value) return ctx.reply('❌ Value tidak boleh kosong.');

    try {
      const env = parseEnvFile();
      const oldValue = env[key];
      env[key] = value;
      writeEnvFile(env);

      // Update process.env juga agar langsung aktif (tanpa restart untuk beberapa config)
      process.env[key] = value;

      const masked = maskValue(key, value);
      const oldMasked = oldValue ? maskValue(key, oldValue) : '(belum di-set)';

      ctx.replyWithHTML(
        `✅ <b>${key}</b> berhasil diupdate\n` +
        `   Lama: <code>${oldMasked}</code>\n` +
        `   Baru: <code>${masked}</code>\n\n` +
        `💡 Beberapa perubahan langsung aktif. Untuk perubahan BOT_TOKEN, gunakan /restart.`
      );
    } catch (err) {
      console.error('Error /setenv:', err.message);
      ctx.reply('❌ Gagal menyimpan. Cek log server.');
    }
  });

  // /getenv — lihat semua config (masked)
  bot.command('getenv', (ctx) => {
    if (!isOwner(ctx)) return ctx.reply('🚫 Hanya pemilik bot.');

    try {
      const env = parseEnvFile();
      const lines = ['<b>⚙️ Konfigurasi Bot (.env)</b>\n'];

      for (const key of ALLOWED_KEYS) {
        const val = env[key] || process.env[key];
        const status = val ? '✅' : '⬜';
        lines.push(`${status} <code>${key}</code> = <code>${maskValue(key, val)}</code>`);
      }

      lines.push('\n<b>Runtime:</b>');
      lines.push(`⏱ Uptime: ${formatUptime(process.uptime())}`);
      lines.push(`🆔 Chat ID kamu: <code>${ctx.from.id}</code>`);
      lines.push('\n💡 Gunakan /setenv KEY VALUE untuk mengubah.');

      ctx.replyWithHTML(lines.join('\n'));
    } catch (err) {
      console.error('Error /getenv:', err.message);
      ctx.reply('❌ Gagal membaca config.');
    }
  });

  // /delenv KEY — hapus variabel
  bot.command('delenv', (ctx) => {
    if (!isOwner(ctx)) return ctx.reply('🚫 Hanya pemilik bot.');

    const key = ctx.message.text.replace(/^\/delenv\s*/i, '').trim().toUpperCase();
    if (!key) return ctx.reply('Gunakan: /delenv <KEY>');

    if (['BOT_TOKEN', 'CHAT_ID'].includes(key)) {
      return ctx.reply('❌ Tidak bisa menghapus BOT_TOKEN atau CHAT_ID — bot butuh ini untuk jalan.');
    }

    try {
      const env = parseEnvFile();
      if (!(key in env)) return ctx.reply(`⬜ ${key} sudah tidak ada di .env`);

      delete env[key];
      delete process.env[key];
      writeEnvFile(env);

      ctx.reply(`✅ ${key} dihapus dari .env`);
    } catch (err) {
      console.error('Error /delenv:', err.message);
      ctx.reply('❌ Gagal menghapus.');
    }
  });

  // /restart — restart bot
  bot.command('restart', async (ctx) => {
    if (!isOwner(ctx)) return ctx.reply('🚫 Hanya pemilik bot.');

    await ctx.reply('🔄 Bot akan restart dalam 3 detik...');

    console.log('🔄 Restart requested via /restart command');

    setTimeout(() => {
      process.exit(1); // Railway restart policy: On Failure → auto restart
    }, 3000);
  });

  // /myid — cek chat ID sendiri (berguna untuk setup awal)
  bot.command('myid', (ctx) => {
    ctx.replyWithHTML(
      `🆔 <b>Info Akun Telegram Kamu:</b>\n\n` +
      `Chat ID: <code>${ctx.from.id}</code>\n` +
      `Username: ${ctx.from.username ? '@' + escapeHtml(ctx.from.username) : '(tidak ada)'}\n` +
      `Nama: ${escapeHtml(ctx.from.first_name)} ${escapeHtml(ctx.from.last_name)}\n\n` +
      `💡 Gunakan Chat ID di atas untuk CHAT_ID di .env:\n` +
      `<code>/setenv CHAT_ID ${ctx.from.id}</code>`
    );
  });
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}

module.exports = { registerAdminCommands, isOwner, getOwnerId };
