const axios = require('axios');
const { escapeHtml } = require('./format');

// =====================
// PARSE AKUN DARI ENV
// =====================
// Format di .env: "username1,username2,username3"
function parseAccounts(envValue, defaults) {
  if (!envValue) return defaults;
  return envValue.split(',')
    .map(u => u.trim())
    .filter(Boolean)
    .map(username => ({ username, label: username }));
}

const DEFAULT_X = [
  { username: 'OfficialFPL', label: 'FPL Official' },
  { username: 'FPLStatus', label: 'FPL Status (Harga & Cedera)' },
  { username: 'BenCrellin', label: 'Ben Crellin (DGW/BGW)' },
  { username: 'FFScout', label: 'FF Scout' },
  { username: 'FPL_Rockstar', label: 'FPL Rockstar' },
];

const DEFAULT_IG = [
  { username: 'officialfpl', label: 'FPL Official' },
  { username: 'premierleague', label: 'Premier League' },
  { username: 'fantasyfootballscout', label: 'FF Scout' },
  { username: 'faborefpl', label: 'Fabore FPL' },
  { username: 'fpl.focal', label: 'FPL Focal' },
];

// Getter functions — selalu baca dari process.env terbaru
function getAccountsX() {
  return parseAccounts(process.env.X_ACCOUNTS, DEFAULT_X);
}
function getAccountsIG() {
  return parseAccounts(process.env.IG_ACCOUNTS, DEFAULT_IG);
}

// Backward compatible exports (dynamic getter)
// Export langsung pakai getter functions

// =====================
// HELPERS
// =====================
function sanitizeText(text) {
  // Hapus karakter non-UTF-8 / surrogate pairs yang rusak
  return text
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')  // lone high surrogate
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')  // lone low surrogate
    .replace(/[\uFFFE\uFFFF]/g, '')                         // non-characters
    .replace(/[^\x09\x0A\x0D\x20-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '') // invalid XML chars
    .trim();
}

// =====================
// X / TWITTER
// =====================
async function fetchTweets(username, count = 5) {
  try {
    const { data } = await axios.get(
      `https://syndication.twitter.com/srv/timeline-profile/screen-name/${username}`,
      {
        timeout: 12000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html',
        },
      }
    );

    // Extract __NEXT_DATA__ JSON dari HTML
    const match = data.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
    if (!match) return [];

    const nextData = JSON.parse(match[1]);
    const entries = nextData?.props?.pageProps?.timeline?.entries || [];

    return entries.slice(0, count).map(entry => {
      const tweet = entry.content?.tweet;
      if (!tweet) return null;
      return {
        text: sanitizeText(tweet.full_text || tweet.text || ''),
        date: tweet.created_at || '',
        likes: tweet.favorite_count || 0,
        retweets: tweet.retweet_count || 0,
        url: `https://x.com/${username}/status/${tweet.id_str || tweet.id}`,
      };
    }).filter(Boolean);
  } catch (err) {
    console.warn(`Failed to fetch tweets for @${username}:`, err.message);
    return [];
  }
}

// =====================
// INSTAGRAM
// =====================

// Metode 1: Via RSS-Bridge (publik, gratis, paling reliable)
async function fetchInstagramViaBridge(username, count = 2) {
  const endpoints = [
    `https://rss-bridge.org/bridge01/?action=display&bridge=Instagram&context=Username&u=${username}&media_type=all&format=Json`,
  ];

  for (const url of endpoints) {
    try {
      const { data } = await axios.get(url, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });

      const items = (data.items || []).slice(0, count).map(item => {
        // Extract image URL dari content_html
        const imgMatch = (item.content_html || '').match(/<img[^>]+src="([^"]+)"/i);
        const imageUrl = imgMatch ? imgMatch[1] : null;

        // Bersihkan HTML dari content
        const cleanText = (item.content_html || item.title || '')
          .replace(/<a[^>]*>.*?<\/a>/gi, '')
          .replace(/<img[^>]*>/gi, '')
          .replace(/<br\s*\/?>/gi, ' ')
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&#\d+;/g, '')
          .replace(/\s+/g, ' ')
          .trim();

        return {
          text: sanitizeText(cleanText || item.title || '(tanpa caption)'),
          date: item.date_modified || item.date_published || '',
          url: item.url || `https://instagram.com/${username}`,
          imageUrl,
        };
      });

      if (items.length > 0) return items;
    } catch {
      continue;
    }
  }

  return [];
}

// Metode 2: Via RSSHub (fallback)
async function fetchInstagramViaRSS(username, count = 2) {
  const endpoints = [
    `https://rsshub.app/instagram/user/${username}`,
    `https://rsshub.rssforever.com/instagram/user/${username}`,
  ];

  for (const url of endpoints) {
    try {
      const { data } = await axios.get(url, {
        timeout: 12000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/rss+xml, application/xml, text/xml',
        },
      });

      const items = [];
      const itemRegex = /<item>([\s\S]*?)<\/item>/g;
      let match;
      while ((match = itemRegex.exec(data)) && items.length < count) {
        const itemXml = match[1];
        const title = extractTag(itemXml, 'title');
        const link = extractTag(itemXml, 'link');
        const pubDate = extractTag(itemXml, 'pubDate');
        const desc = extractTag(itemXml, 'description');

        const cleanDesc = desc
          .replace(/<br\s*\/?>/gi, ' ')
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&#\d+;/g, '')
          .trim();

        items.push({
          text: sanitizeText(cleanDesc || title || '(tanpa caption)'),
          date: pubDate || '',
          url: link || `https://instagram.com/${username}`,
        });
      }

      if (items.length > 0) return items;
    } catch {
      continue;
    }
  }

  return [];
}

// Gabungan: coba RSS-Bridge dulu, fallback ke RSSHub
async function fetchInstagramPosts(username, count = 2) {
  let posts = await fetchInstagramViaBridge(username, count);
  if (posts.length === 0) {
    posts = await fetchInstagramViaRSS(username, count);
  }
  return posts;
}

// =====================
// AGGREGATOR
// =====================

async function fetchAllFplNews() {
  const results = [];

  const fetches = getAccountsX().map(async (acc) => {
    const tweets = await fetchTweets(acc.username, 3);
    if (tweets.length > 0) {
      results.push({ platform: 'X', account: acc, posts: tweets });
    }
  });

  await Promise.all(fetches);
  return results;
}

async function fetchAllInstagramNews() {
  const results = [];

  // Fetch sequentially untuk IG (hindari rate limit)
  for (const acc of getAccountsIG()) {
    const posts = await fetchInstagramPosts(acc.username, 2);
    if (posts.length > 0) {
      results.push({ platform: 'IG', account: acc, posts });
    }
  }

  return results;
}

async function fetchAllNews() {
  const [xResults, igResults] = await Promise.all([
    fetchAllFplNews(),
    fetchAllInstagramNews(),
  ]);
  return [...xResults, ...igResults];
}

async function fetchAccountNews(query, platform = null) {
  const q = query.toLowerCase();

  // Cari di X
  if (!platform || platform === 'x') {
    const xAcc = getAccountsX().find(a =>
      a.username.toLowerCase().includes(q) || a.label.toLowerCase().includes(q)
    );
    if (xAcc) {
      const posts = await fetchTweets(xAcc.username, 5);
      return { platform: 'X', account: xAcc, posts };
    }
  }

  // Cari di IG
  if (!platform || platform === 'ig') {
    const igAcc = getAccountsIG().find(a =>
      a.username.toLowerCase().includes(q) || a.label.toLowerCase().includes(q)
    );
    if (igAcc) {
      const posts = await fetchInstagramPosts(igAcc.username, 2);
      return { platform: 'IG', account: igAcc, posts };
    }
  }

  // Coba sebagai username langsung
  if (platform === 'ig') {
    const posts = await fetchInstagramPosts(query, 2);
    return { platform: 'IG', account: { username: query, label: query }, posts };
  }

  const posts = await fetchTweets(query, 5);
  return { platform: 'X', account: { username: query, label: query }, posts };
}

// =====================
// FORMATTER
// =====================

function formatNews(newsResults) {
  if (newsResults.length === 0) {
    return '❌ Tidak bisa mengambil berita saat ini. Coba lagi nanti.';
  }

  const lines = [];

  // Kelompokkan per platform
  const xResults = newsResults.filter(r => r.platform === 'X');
  const igResults = newsResults.filter(r => r.platform === 'IG');

  if (xResults.length > 0) {
    lines.push('<b>🐦 Berita dari X/Twitter</b>\n');
    for (const { account, posts } of xResults) {
      lines.push(`<b>@${account.username}</b> — ${account.label}`);
      lines.push('─────────────────');
      formatPosts(lines, posts, 'x');
    }
  }

  if (igResults.length > 0) {
    if (xResults.length > 0) lines.push('\n');
    lines.push('<b>📸 Berita dari Instagram</b>\n');
    for (const { account, posts } of igResults) {
      lines.push(`<b>@${account.username}</b> — ${account.label}`);
      lines.push('─────────────────');
      formatPosts(lines, posts, 'ig');
    }
  }

  return lines.join('\n');
}

function formatPosts(lines, posts, platform) {
  if (posts.length === 0) {
    lines.push('<i>  Tidak ada post terbaru</i>\n');
    return;
  }

  for (const p of posts) {
    let text = p.text.replace(/<[^>]+>/g, '').replace(/\n+/g, ' ');
    if (text.length > 200) text = text.substring(0, 197) + '...';
    text = escapeHtml(text);

    const time = p.date ? new Date(p.date).toLocaleString('id-ID', {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    }) : '';

    const icon = platform === 'x' ? '💬' : '📷';
    lines.push(`  ${icon} ${text}`);

    const meta = [];
    if (time) meta.push(time);
    if (p.likes) meta.push(`❤️ ${p.likes}`);
    if (p.retweets) meta.push(`🔁 ${p.retweets}`);
    if (meta.length > 0) lines.push(`     <i>${meta.join(' | ')}</i>`);

    const linkLabel = platform === 'x' ? 'Buka di X' : 'Buka di Instagram';
    lines.push(`     <a href="${p.url}">${linkLabel}</a>`);
    lines.push('');
  }
}

function formatSingleAccount(result) {
  if (!result || result.posts.length === 0) {
    return `❌ Tidak ada post dari @${result?.account?.username || '?'} (${result?.platform || '?'})`;
  }
  return formatNews([result]);
}

// Kirim IG posts dengan gambar via Telegram sendPhoto
async function sendIgPostsWithImages(ctx, igResults) {
  if (igResults.length === 0) return false;

  for (const { account, posts } of igResults) {
    if (posts.length === 0) continue;

    for (const p of posts) {
      let caption = `📸 <b>@${account.username}</b>\n\n`;
      let text = sanitizeText(p.text.replace(/<[^>]+>/g, '').replace(/\n+/g, ' '));
      if (text.length > 800) text = text.substring(0, 797) + '...';
      caption += escapeHtml(text);

      if (p.date) {
        const time = new Date(p.date).toLocaleString('id-ID', {
          day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
        });
        caption += `\n\n<i>${time}</i>`;
      }
      caption += `\n<a href="${p.url}">Buka di Instagram</a>`;

      // Kirim dengan gambar jika ada
      if (p.imageUrl) {
        try {
          await ctx.replyWithPhoto(p.imageUrl, {
            caption,
            parse_mode: 'HTML',
          });
          continue;
        } catch {
          // Fallback ke text jika gambar gagal
        }
      }

      // Fallback tanpa gambar
      await ctx.replyWithHTML(caption, { disable_web_page_preview: true });
    }
  }

  return true;
}

// =====================
// HELPERS
// =====================

function extractTag(xml, tag) {
  const regex = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>|<${tag}[^>]*>([\\s\\S]*?)</${tag}>`);
  const match = xml.match(regex);
  return match ? (match[1] || match[2] || '').trim() : '';
}

// =====================
// NEWS CACHE (short TTL for deduplication)
// =====================
let newsCacheData = null;
let newsCacheTs = 0;
const NEWS_CACHE_TTL = 300_000; // 5 menit

async function getCachedAllPosts() {
  const now = Date.now();
  if (newsCacheData && now - newsCacheTs < NEWS_CACHE_TTL) return newsCacheData;

  const allTweets = [];
  const fetches = getAccountsX().map(async (acc) => {
    const tweets = await fetchTweets(acc.username, 10);
    for (const t of tweets) allTweets.push({ ...t, source: acc.username });
  });
  await Promise.all(fetches);

  const allIgPosts = [];
  for (const acc of getAccountsIG()) {
    const posts = await fetchInstagramPosts(acc.username, 5);
    for (const p of posts) allIgPosts.push({ ...p, source: acc.username });
  }

  newsCacheData = [...allTweets, ...allIgPosts];
  newsCacheTs = now;
  return newsCacheData;
}

// =====================
// NEWS INTEL (scan berita untuk pemain tertentu)
// =====================

const NEGATIVE_KEYWORDS = [
  'injured', 'injury', 'out', 'doubt', 'doubtful', 'ruled out', 'miss',
  'missed', 'sidelined', 'setback', 'surgery', 'operation', 'scan',
  'hamstring', 'knee', 'ankle', 'muscle', 'groin', 'calf', 'thigh',
  'suspended', 'suspension', 'red card', 'ban', 'banned',
  'dropped', 'benched', 'rotation', 'rotated', 'rested',
  'price drop', 'falling', 'flagged',
  'cedera', 'absen', 'tidak main', 'diragukan', 'kartu merah', 'diskors',
];

const POSITIVE_KEYWORDS = [
  'back', 'returned', 'fit', 'available', 'starts', 'starting',
  'goal', 'assist', 'brace', 'hat-trick', 'hatrick', 'hattrick',
  'form', 'inform', 'in-form', 'essential', 'must-have', 'must have',
  'price rise', 'rising',
  'kembali', 'pulih', 'siap main', 'starter', 'gol',
];

async function fetchNewsIntel(playerNames) {
  const intel = {};

  // Use cached posts to avoid redundant fetches
  const allPosts = await getCachedAllPosts();

  for (const name of playerNames) {
    const nameLower = name.toLowerCase();
    // Juga cek nama belakang saja (misal "Salah" dari "M. Salah")
    const parts = name.split(/[\s.]+/).filter(p => p.length > 2);

    const mentions = allPosts.filter(post => {
      const text = post.text.toLowerCase();
      if (text.includes(nameLower)) return true;
      // Cek per bagian nama (minimal 3 huruf untuk hindari false positive)
      return parts.some(part => {
        const partLower = part.toLowerCase();
        // Pastikan match sebagai kata utuh
        const regex = new RegExp(`\\b${partLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        return regex.test(post.text);
      });
    });

    if (mentions.length === 0) continue;

    const alerts = [];
    for (const m of mentions) {
      const textLower = m.text.toLowerCase();
      const negHits = NEGATIVE_KEYWORDS.filter(kw => textLower.includes(kw));
      const posHits = POSITIVE_KEYWORDS.filter(kw => textLower.includes(kw));

      if (negHits.length > 0 || posHits.length > 0) {
        alerts.push({
          type: negHits.length >= posHits.length ? 'negative' : 'positive',
          text: m.text.length > 150 ? m.text.substring(0, 147) + '...' : m.text,
          source: m.source,
          url: m.url,
          negKeywords: negHits,
          posKeywords: posHits,
        });
      }
    }

    if (alerts.length > 0) {
      intel[name] = alerts;
    }
  }

  return intel;
}

function formatNewsIntel(intel) {
  if (Object.keys(intel).length === 0) return '';

  const lines = ['\n<b>📰 Info dari Berita (X & Instagram)</b>\n'];

  for (const [name, alerts] of Object.entries(intel)) {
    for (const alert of alerts.slice(0, 2)) {
      const icon = alert.type === 'negative' ? '🚨' : '✅';
      const cleanText = alert.text.replace(/<[^>]+>/g, '').replace(/\n+/g, ' ');
      lines.push(`${icon} <b>${name}</b> — @${alert.source}`);
      lines.push(`   <i>${cleanText}</i>`);
      if (alert.url) lines.push(`   <a href="${alert.url}">Buka</a>`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

module.exports = {
  fetchAllFplNews, fetchAllInstagramNews, fetchAllNews,
  fetchAccountNews, formatNews, formatSingleAccount,
  sendIgPostsWithImages,
  fetchNewsIntel, formatNewsIntel,
  getAccountsX, getAccountsIG,
};
