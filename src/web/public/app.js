// ===== Mallempu Web App =====

const API = '';
let currentTab = 'squad';
let squadData = null;
let autoRefreshTimer = null;
let countdownTimer = null;
let refreshSecondsLeft = 0;
const AUTO_REFRESH_INTERVAL = 120; // seconds

// Display preferences (persisted to localStorage)
const displayPrefs = {
  showScore: true,
  showPrice: true,
  showPosition: true,
  showTeam: true,
};

function loadDisplayPrefs() {
  try {
    const saved = localStorage.getItem('fpl_display_prefs');
    if (saved) Object.assign(displayPrefs, JSON.parse(saved));
  } catch {}
}

function saveDisplayPrefs() {
  try { localStorage.setItem('fpl_display_prefs', JSON.stringify(displayPrefs)); } catch {}
}

// ===== THEME =====
function initTheme() {
  const saved = localStorage.getItem('fpl_theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = saved || (prefersDark ? 'dark' : 'dark');
  document.documentElement.setAttribute('data-theme', theme);
  updateThemeButton(theme);
  // Update theme-color meta
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === 'light' ? '#f5f6f8' : '#111318';
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('fpl_theme', next);
  updateThemeButton(next);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = next === 'light' ? '#f5f6f8' : '#111318';
}

function updateThemeButton(theme) {
  const btn = document.getElementById('theme-btn');
  if (btn) btn.innerHTML = theme === 'dark' ? '&#9728;' : '&#127769;';
}

// ===== INIT =====
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  loadDisplayPrefs();
  setupTabs();
  loadGameweekInfo();
  initAuth();

  // Check URL params for auto-load
  const params = new URLSearchParams(window.location.search);
  const fplId = params.get('id') || params.get('fpl');
  if (fplId) {
    document.getElementById('fpl-id-input').value = fplId;
    loadSquad(fplId);
  }
});

// ===== TABS =====
function setupTabs() {
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      switchTab(target);
    });
  });
}

function switchTab(tab) {
  // Gate premium tabs
  if (!isTabAllowed(tab)) {
    if (!currentUser) {
      openAuthModal('login');
      return;
    }
    // Logged in but not premium
    const content = document.getElementById(`tab-${tab}`);
    if (content) {
      currentTab = tab;
      document.querySelectorAll('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('hidden', c.id !== `tab-${tab}`));
      const inner = content.querySelector('[id$="-content"]') || content;
      inner.innerHTML = `<div class="empty-state">
        <div class="icon">&#128274;</div>
        <h3 style="font-size:1rem;margin-bottom:6px">Fitur Premium</h3>
        <p style="color:var(--text-muted);font-size:0.82rem">Fitur ini hanya untuk member premium.<br>Hubungi admin untuk upgrade akun kamu.</p>
      </div>`;
    }
    return;
  }

  currentTab = tab;
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('hidden', c.id !== `tab-${tab}`));

  // Show floating legend only on squad tab
  ensureFloatingLegend();
  showLegendFab(tab === 'squad' && squadData != null);

  if (tab === 'players') loadTopPlayers();
  if (tab === 'differentials') loadDifferentials();
  if (tab === 'expert') loadExpertPicks();
  if (tab === 'prices') loadPriceWarnings();
  if (tab === 'lineups') loadLineupTeams();
  if (tab === 'chips') loadChipPlan();
}

// ===== GAMEWEEK INFO =====
async function loadGameweekInfo() {
  try {
    const res = await fetch(`${API}/api/gameweek`);
    const data = await res.json();
    const el = document.getElementById('gw-info');
    if (data.next) {
      const deadline = new Date(data.next.deadline);
      const now = new Date();
      const diff = deadline - now;
      let timeStr;
      if (diff > 0) {
        const days = Math.floor(diff / 86400000);
        const hours = Math.floor((diff % 86400000) / 3600000);
        timeStr = days > 0 ? `${days}d ${hours}h` : `${hours}h ${Math.floor((diff % 3600000) / 60000)}m`;
      } else {
        timeStr = 'In progress';
      }
      el.innerHTML = `
        <div>
          <span class="gw-label">${data.next.name}</span>
          ${data.current ? `<span class="gw-deadline hide-mobile"> | ${data.current.name} ${data.current.finished ? 'finished' : 'in progress'}</span>` : ''}
        </div>
        <div class="gw-deadline">Deadline: ${deadline.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} WIB (${timeStr})</div>
      `;
    }
  } catch {}
}

// ===== SQUAD =====
function handleSquadSearch(e) {
  if (e && e.key !== 'Enter') return;
  const id = document.getElementById('fpl-id-input').value.trim();
  if (!id || isNaN(id)) return;
  // Update URL
  history.replaceState(null, '', `?id=${id}`);
  loadSquad(id);
}

async function loadSquad(managerId) {
  const content = document.getElementById('squad-content');
  content.innerHTML = `<div class="loading"><div class="spinner"></div>Loading squad data...</div>`;
  stopAutoRefresh();

  try {
    const res = await apiFetch(`/api/squad/${managerId}`);
    if (!res.ok) {
      const err = await res.json();
      content.innerHTML = `<div class="empty-state"><div class="icon">&#10060;</div><p>${escHtml(err.error || 'Failed to load squad')}</p></div>`;
      return;
    }
    squadData = await res.json();
    renderSquad(squadData);
    showLegendFab(true);
    startAutoRefresh(managerId);
  } catch (err) {
    content.innerHTML = `<div class="empty-state"><div class="icon">&#9888;</div><p>Connection error. Try again.</p></div>`;
  }
}

function renderSquad(data) {
  const content = document.getElementById('squad-content');

  // Status badge
  let statusHtml = '';
  if (data.isLive) statusHtml = '<span class="data-status live"><span class="dot"></span> Live</span>';
  else if (data.isProjected) statusHtml = '<span class="data-status projected"><span class="dot"></span> Projected</span>';
  else statusHtml = '<span class="data-status confirmed"><span class="dot"></span> GW' + data.gameweek + '</span>';

  // Manager info
  const mgr = data.manager;
  const eh = data.entryHistory;
  const managerHtml = `
    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">${escHtml(mgr.teamName)}</div>
          <div class="card-subtitle">${escHtml(mgr.name)} ${mgr.region ? '| ' + escHtml(mgr.region) : ''}</div>
        </div>
        <div style="display:flex;align-items:center;gap:12px;">
          ${statusHtml}
          <div class="refresh-indicator" id="refresh-timer"></div>
        </div>
      </div>
      <div class="manager-info">
        <div class="stat-box">
          <div class="stat-value">${mgr.overallPoints != null ? mgr.overallPoints.toLocaleString() : '-'}</div>
          <div class="stat-label">Total Points</div>
        </div>
        <div class="stat-box">
          <div class="stat-value">${mgr.overallRank != null ? formatRank(mgr.overallRank) : '-'}</div>
          <div class="stat-label">Overall Rank</div>
        </div>
        <div class="stat-box">
          <div class="stat-value">${data.totalQualityScore}</div>
          <div class="stat-label">Avg Quality</div>
        </div>
        ${eh ? `
        <div class="stat-box">
          <div class="stat-value">${eh.points || '-'}</div>
          <div class="stat-label">GW Points</div>
        </div>
        <div class="stat-box">
          <div class="stat-value">&pound;${((eh.bank || 0) / 10).toFixed(1)}m</div>
          <div class="stat-label">In Bank</div>
        </div>
        <div class="stat-box">
          <div class="stat-value">&pound;${((eh.value || 0) / 10).toFixed(1)}m</div>
          <div class="stat-label">Team Value</div>
        </div>` : ''}
      </div>
    </div>`;

  // Update floating legend checkboxes
  updateFloatingLegend();

  // Build pitch view — order like FPL app: GK → DEF → MID → FWD (top to bottom)
  const xi = data.startingXI;
  const grouped = { 1: [], 2: [], 3: [], 4: [] };
  for (const pick of xi) {
    if (pick.player) grouped[pick.player.elementType].push(pick);
  }

  const posLabels = { 1: 'GK', 2: 'DEF', 3: 'MID', 4: 'FWD' };
  let pitchHtml = '<div class="pitch">';
  // Render in FPL app order: GK → DEF → MID → FWD (top to bottom, like viewing the pitch)
  for (const posId of [1, 2, 3, 4]) {
    const players = grouped[posId];
    if (!players.length) continue;
    pitchHtml += `<div class="pitch-label">${posLabels[posId]}</div><div class="pitch-row">`;
    for (const pick of players) {
      pitchHtml += renderPitchPlayer(pick);
    }
    pitchHtml += '</div>';
  }

  // Bench — also sorted by position (GK → DEF → MID → FWD)
  const benchSorted = [...data.bench].sort((a, b) => {
    const posA = a.player?.elementType || 9;
    const posB = b.player?.elementType || 9;
    return posA - posB;
  });
  pitchHtml += '<div class="bench-section"><div class="pitch-label">BENCH</div><div class="pitch-row">';
  for (const pick of benchSorted) {
    pitchHtml += renderPitchPlayer(pick, true);
  }
  pitchHtml += '</div></div></div>';

  // Action buttons
  const best11Btn = `
    <div style="text-align:center;margin-top:16px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
      <button class="btn btn-secondary" onclick="manualRefresh()" title="Refresh data dari FPL">&#x1F504; Refresh</button>
      <button class="btn btn-secondary" onclick="loadBest11(${mgr.id})">Best XI</button>
      <button class="btn btn-secondary" onclick="openWhatIf()">What-If</button>
      <button class="btn btn-secondary" onclick="document.getElementById('planner-id-input').value='${mgr.id}';switchTab('planner');loadTransferPlan()">Transfer Plan</button>
    </div>`;

  content.innerHTML = managerHtml + pitchHtml + best11Btn + '<div id="best11-content"></div>';
}

function renderPitchPlayer(pick, isBench = false) {
  const p = pick.player;
  if (!p) return '<div class="player-chip" style="opacity:0.3"><div class="player-name">Unknown</div></div>';

  const scoreClass = p.qualityScore >= 65 ? 'score-high' : p.qualityScore >= 40 ? 'score-mid' : 'score-low';
  const injured = ['i', 'u', 's'].includes(p.status);
  const doubtful = p.status === 'd';

  let badge = '';
  if (pick.isCaptain) badge = '<div class="badge">C</div>';
  else if (pick.isViceCaptain) badge = '<div class="badge vc">V</div>';

  let statusIcon = '';
  if (injured) statusIcon = ' &#x1F3E5;';
  else if (doubtful) statusIcon = ' &#x26A0;';

  const _posNames = { 1: 'GK', 2: 'DEF', 3: 'MID', 4: 'FWD' };
  const _posClasses = { 1: 'pos-gk', 2: 'pos-def', 3: 'pos-mid', 4: 'pos-fwd' };

  const infoLine = [];
  if (displayPrefs.showPosition) infoLine.push(`<span class="pos-badge ${_posClasses[p.elementType]}" style="font-size:0.5rem;padding:1px 4px">${_posNames[p.elementType]}</span>`);
  if (displayPrefs.showTeam) infoLine.push(`<span class="player-team">${escHtml(p.teamShort)}</span>`);

  return `
    <div class="player-chip ${injured ? 'injured' : ''}" onclick='showPlayerDetail(${JSON.stringify(p).replace(/'/g, "&#39;")})'>
      ${badge}
      <div class="player-name">${escHtml(p.webName)}${statusIcon}</div>
      ${infoLine.length ? `<div class="player-info">${infoLine.join(' ')}</div>` : ''}
      ${displayPrefs.showScore ? `<div class="player-score ${scoreClass}">${p.qualityScore}</div>` : ''}
      ${displayPrefs.showPrice ? `<div class="player-price">&pound;${p.price}m</div>` : ''}
    </div>`;
}

// ===== FLOATING LEGEND =====
function ensureFloatingLegend() {
  if (document.getElementById('legend-fab')) return;
  const fab = document.createElement('div');
  fab.id = 'legend-fab';
  fab.className = 'legend-fab';
  fab.innerHTML = `
    <button class="legend-fab-btn" onclick="toggleLegendPanel()" title="Pengaturan tampilan">&#9881;</button>
    <div class="legend-panel">
      <div class="legend-panel-header">Pengaturan Tampilan</div>
      <div class="legend-panel-body">
        <div class="legend-grid" id="legend-checkboxes"></div>
        <div class="legend-separator"></div>
        <div class="legend-grid">
          <span class="legend-item" style="cursor:default"><span class="pos-badge pos-gk" style="font-size:0.55rem">GK</span> Kiper</span>
          <span class="legend-item" style="cursor:default"><span class="pos-badge pos-def" style="font-size:0.55rem">DEF</span> Bek</span>
          <span class="legend-item" style="cursor:default"><span class="pos-badge pos-mid" style="font-size:0.55rem">MID</span> Gelandang</span>
          <span class="legend-item" style="cursor:default"><span class="pos-badge pos-fwd" style="font-size:0.55rem">FWD</span> Penyerang</span>
          <span class="legend-item" style="cursor:default"><span class="score-high" style="font-weight:700">&#11044;</span> Bagus (&ge;65)</span>
          <span class="legend-item" style="cursor:default"><span class="score-mid" style="font-weight:700">&#11044;</span> Cukup (&ge;40)</span>
          <span class="legend-item" style="cursor:default"><span class="score-low" style="font-weight:700">&#11044;</span> Buruk (&lt;40)</span>
          <span class="legend-item" style="cursor:default">&#x1F3E5; Cedera &nbsp;&#x26A0; Ragu</span>
        </div>
        <div class="legend-hint">Klik pemain untuk detail skor dan jadwal</div>
      </div>
    </div>`;
  document.body.appendChild(fab);
}

function updateFloatingLegend() {
  ensureFloatingLegend();
  const container = document.getElementById('legend-checkboxes');
  if (!container) return;
  container.innerHTML = `
    <label class="legend-item"><input type="checkbox" ${displayPrefs.showScore ? 'checked' : ''} onchange="toggleDisplay('showScore',this.checked)"><span>Quality Score</span></label>
    <label class="legend-item"><input type="checkbox" ${displayPrefs.showPrice ? 'checked' : ''} onchange="toggleDisplay('showPrice',this.checked)"><span>Harga</span></label>
    <label class="legend-item"><input type="checkbox" ${displayPrefs.showPosition ? 'checked' : ''} onchange="toggleDisplay('showPosition',this.checked)"><span>Posisi</span></label>
    <label class="legend-item"><input type="checkbox" ${displayPrefs.showTeam ? 'checked' : ''} onchange="toggleDisplay('showTeam',this.checked)"><span>Tim</span></label>`;
}

function toggleLegendPanel() {
  const fab = document.getElementById('legend-fab');
  if (fab) fab.classList.toggle('open');
}

function showLegendFab(show) {
  const fab = document.getElementById('legend-fab');
  if (fab) fab.classList.toggle('visible', show);
}

function toggleDisplay(key, checked) {
  displayPrefs[key] = checked;
  saveDisplayPrefs();
  if (squadData) renderSquad(squadData);
}

// Close legend panel when clicking outside
document.addEventListener('click', (e) => {
  const fab = document.getElementById('legend-fab');
  if (fab && fab.classList.contains('open') && !fab.contains(e.target)) {
    fab.classList.remove('open');
  }
});

// ===== BEST XI =====
async function loadBest11(managerId) {
  const content = document.getElementById('best11-content');
  content.innerHTML = `<div class="loading" style="padding:30px"><div class="spinner"></div>Calculating...</div>`;

  try {
    const res = await apiFetch(`/api/best11/${managerId}`);
    if (!res.ok) { content.innerHTML = ''; return; }
    const data = await res.json();
    renderBest11(data);
  } catch {
    content.innerHTML = '';
  }
}

function renderBest11(data) {
  const content = document.getElementById('best11-content');
  const grouped = { 1: [], 2: [], 3: [], 4: [] };
  for (const p of data.startingXI) grouped[p.elementType].push(p);

  const posLabels = { 1: 'GK', 2: 'DEF', 3: 'MID', 4: 'FWD' };

  let pitchHtml = `
    <div class="card" style="margin-top:24px">
      <div class="card-header">
        <div>
          <div class="card-title">Best XI Recommendation</div>
          <div class="card-subtitle">Formation: ${data.formation} | Score: ${data.totalScore}</div>
        </div>
        <div>
          <span class="card-subtitle">C: ${escHtml(data.captain.webName)} (${data.captain.qualityScore}) | VC: ${escHtml(data.viceCaptain.webName)} (${data.viceCaptain.qualityScore})</span>
        </div>
      </div>
      <div class="pitch">`;

  for (const posId of [4, 3, 2, 1]) {
    const players = grouped[posId];
    if (!players.length) continue;
    pitchHtml += `<div class="pitch-label">${posLabels[posId]}</div><div class="pitch-row">`;
    for (const p of players) {
      const scoreClass = p.qualityScore >= 65 ? 'score-high' : p.qualityScore >= 40 ? 'score-mid' : 'score-low';
      let badge = '';
      if (p.role === 'captain') badge = '<div class="badge">C</div>';
      else if (p.role === 'vice-captain') badge = '<div class="badge vc">V</div>';
      pitchHtml += `
        <div class="player-chip">
          ${badge}
          <div class="player-name">${escHtml(p.webName)}</div>
          <div class="player-team">${escHtml(p.teamShort)}</div>
          <div class="player-score ${scoreClass}">${p.qualityScore}</div>
          <div class="player-price">&pound;${p.price}m</div>
        </div>`;
    }
    pitchHtml += '</div>';
  }

  // Bench
  pitchHtml += '<div class="bench-section"><div class="pitch-label">BENCH</div><div class="pitch-row">';
  for (const p of data.bench) {
    const scoreClass = p.qualityScore >= 65 ? 'score-high' : p.qualityScore >= 40 ? 'score-mid' : 'score-low';
    pitchHtml += `
      <div class="player-chip">
        <div class="player-name">${escHtml(p.webName)}</div>
        <div class="player-team">${escHtml(p.teamShort)}</div>
        <div class="player-score ${scoreClass}">${p.qualityScore}</div>
        <div class="player-price">&pound;${p.price}m</div>
      </div>`;
  }
  pitchHtml += '</div></div></div></div>';

  content.innerHTML = pitchHtml;
}

// ===== TOP PLAYERS =====
let currentPosFilter = 0;

async function loadTopPlayers(position) {
  if (position !== undefined) currentPosFilter = position;
  const content = document.getElementById('players-content');
  content.innerHTML = `<div class="loading"><div class="spinner"></div>Loading players...</div>`;

  // Update filter buttons
  document.querySelectorAll('.pos-filter').forEach(f => f.classList.toggle('active', parseInt(f.dataset.pos) === currentPosFilter));

  try {
    const res = await apiFetch(`/api/players/top?position=${currentPosFilter}&limit=30`);
    const data = await res.json();
    renderPlayerTable(data.players, content, data.currentGw);
  } catch {
    content.innerHTML = `<div class="empty-state"><div class="icon">&#9888;</div><p>Failed to load players</p></div>`;
  }
}

// ===== DIFFERENTIALS =====
async function loadDifferentials() {
  const content = document.getElementById('differentials-content');
  content.innerHTML = `<div class="loading"><div class="spinner"></div>Loading differentials...</div>`;

  try {
    const res = await apiFetch(`/api/players/differentials?limit=25`);
    const data = await res.json();
    renderPlayerTable(data.players, content, data.currentGw, true);
  } catch {
    content.innerHTML = `<div class="empty-state"><div class="icon">&#9888;</div><p>Failed to load differentials</p></div>`;
  }
}

function renderPlayerTable(players, container, currentGw, isDiff = false) {
  if (!players.length) {
    container.innerHTML = `<div class="empty-state"><div class="icon">&#128373;</div><p>No players found</p></div>`;
    return;
  }

  const scoreCol = isDiff ? 'Diff Score' : 'Quality';
  let html = `<table class="player-table"><thead><tr>
    <th>#</th><th>Player</th><th class="hide-mobile">Team</th><th>Pos</th>
    <th>Price</th><th class="hide-mobile">Form</th><th class="hide-mobile">Pts</th>
    <th>${scoreCol}</th><th class="hide-mobile">EO%</th>
    <th class="hide-mobile">Label</th>
  </tr></thead><tbody>`;

  players.forEach((p, i) => {
    const posClass = ['', 'pos-gk', 'pos-def', 'pos-mid', 'pos-fwd'][p.elementType];
    const score = isDiff ? p.differentialScore : p.qualityScore;
    const scoreClass = score >= 65 ? 'score-high' : score >= 40 ? 'score-mid' : 'score-low';
    const labelClass = p.label === 'DIFFERENTIAL' ? 'label-differential' : p.label === 'TEMPLATE' ? 'label-template' : 'label-regular';
    const statusIcon = ['i','u','s'].includes(p.status) ? ' &#x1F3E5;' : p.status === 'd' ? ' &#x26A0;' : '';

    html += `<tr>
      <td>${i + 1}</td>
      <td><strong>${escHtml(p.webName)}</strong>${statusIcon}</td>
      <td class="hide-mobile">${escHtml(p.teamShort)}</td>
      <td><span class="pos-badge ${posClass}">${p.positionName}</span></td>
      <td>&pound;${p.price}m</td>
      <td class="hide-mobile">${p.form}</td>
      <td class="hide-mobile">${p.totalPoints || '-'}</td>
      <td>
        <div class="quality-bar">
          <span class="${scoreClass}" style="font-weight:700">${score}</span>
          <div class="quality-bar-track"><div class="quality-bar-fill" style="width:${score}%;background:${score >= 65 ? 'var(--accent)' : score >= 40 ? 'var(--gold)' : 'var(--red)'}"></div></div>
        </div>
      </td>
      <td class="hide-mobile">${p.selectedByPercent}%</td>
      <td class="hide-mobile"><span class="label-badge ${labelClass}">${p.label}</span></td>
    </tr>`;
  });

  html += '</tbody></table>';
  container.innerHTML = html;
}

// ===== PLAYER SEARCH =====
let searchTimeout = null;

function handlePlayerSearch(e) {
  clearTimeout(searchTimeout);
  const query = e.target.value.trim();
  if (query.length < 2) {
    document.getElementById('search-results').innerHTML = '';
    return;
  }
  searchTimeout = setTimeout(() => searchPlayer(query), 300);
}

async function searchPlayer(query) {
  const content = document.getElementById('search-results');
  try {
    const res = await apiFetch(`/api/player/search?q=${encodeURIComponent(query)}`);
    const data = await res.json();
    if (!data.results?.length) {
      content.innerHTML = `<div class="empty-state" style="padding:20px"><p>No results for "${escHtml(query)}"</p></div>`;
      return;
    }
    renderPlayerTable(data.results, content, null);
  } catch {
    content.innerHTML = '';
  }
}

// ===== PLAYER DETAIL MODAL =====
function showPlayerDetail(player) {
  const overlay = document.getElementById('player-modal');
  const body = document.getElementById('modal-body');

  const scoreClass = player.qualityScore >= 65 ? 'score-high' : player.qualityScore >= 40 ? 'score-mid' : 'score-low';
  const posClass = ['', 'pos-gk', 'pos-def', 'pos-mid', 'pos-fwd'][player.elementType];
  const c = player.components || {};

  const statusText = { a: 'Available', d: 'Doubtful', i: 'Injured', u: 'Unavailable', s: 'Suspended', n: 'On Loan' };

  let fixturesHtml = '';
  if (player.nextFixtures?.length) {
    fixturesHtml = `<div style="margin-top:16px"><strong>Next Fixtures</strong><div class="fixture-list" style="margin-top:8px;flex-wrap:wrap">`;
    for (const f of player.nextFixtures) {
      fixturesHtml += `<span class="fixture-badge fdr-${f.fdr}">${f.opponent} ${f.isHome ? '(H)' : '(A)'}</span>`;
    }
    fixturesHtml += '</div></div>';
  }

  body.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:16px">
      <div>
        <h3 style="font-size:1.25rem">${escHtml(player.webName)}</h3>
        <div style="color:var(--text-muted)">${escHtml(player.team)} | <span class="pos-badge ${posClass}">${player.positionName}</span></div>
      </div>
      <div style="text-align:right">
        <div class="${scoreClass}" style="font-size:2rem;font-weight:700">${player.qualityScore}</div>
        <div style="font-size:0.7rem;color:var(--text-muted)">QUALITY SCORE</div>
      </div>
    </div>

    <div class="manager-info" style="margin-bottom:16px">
      <div class="stat-box">
        <div class="stat-value">&pound;${player.price}m</div>
        <div class="stat-label">Price</div>
      </div>
      <div class="stat-box">
        <div class="stat-value">${player.form}</div>
        <div class="stat-label">Form</div>
      </div>
      <div class="stat-box">
        <div class="stat-value">${player.totalPoints || '-'}</div>
        <div class="stat-label">Points</div>
      </div>
      <div class="stat-box">
        <div class="stat-value">${player.selectedByPercent}%</div>
        <div class="stat-label">Ownership</div>
      </div>
    </div>

    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
      <span class="label-badge ${player.label === 'DIFFERENTIAL' ? 'label-differential' : player.label === 'TEMPLATE' ? 'label-template' : 'label-regular'}">${player.label}</span>
      ${player.regression ? `<span class="label-badge" style="background:rgba(245,159,0,0.2);color:var(--gold)">${player.regression}</span>` : ''}
      <span class="label-badge" style="background:${player.minutesSafe ? 'rgba(55,178,77,0.15);color:var(--accent)' : 'rgba(224,49,49,0.15);color:var(--red)'}">
        ${player.minutesSafe ? 'Minutes Safe' : 'Rotation Risk'}
      </span>
      <span class="label-badge" style="background:rgba(139,148,158,0.15);color:var(--text-muted)">${statusText[player.status] || player.status}</span>
    </div>

    <div style="margin-bottom:12px;font-size:0.85rem;color:var(--text-muted)">
      ${player.goalsScored != null ? `Goals: ${player.goalsScored} | Assists: ${player.assists} | CS: ${player.cleanSheets} | Mins: ${player.minutes}` : ''}
    </div>

    <strong>Score Components</strong>
    <div class="component-grid">
      ${componentItem('xGI/90', c.xgi)}
      ${componentItem('Form', c.form)}
      ${componentItem('Fixture', c.fixture)}
      ${componentItem('Minutes', c.minutes)}
      ${componentItem('Value', c.value)}
      ${c.def > 0 ? componentItem('Defense', c.def) : ''}
      ${c.trend != null ? componentItem('Trend', c.trend) : ''}
    </div>

    ${fixturesHtml}
  `;

  overlay.classList.add('active');
}

function componentItem(label, value) {
  if (value == null) return '';
  const pct = Math.round(value * 100);
  const color = pct >= 70 ? 'var(--accent)' : pct >= 40 ? 'var(--gold)' : 'var(--red)';
  return `<div class="component-item">
    <div class="component-label">${label}</div>
    <div class="component-value" style="color:${color}">${pct}%</div>
  </div>`;
}

function closeModal() {
  document.getElementById('player-modal').classList.remove('active');
}

// Close modal on overlay click
document.addEventListener('click', (e) => {
  if (e.target.id === 'player-modal') closeModal();
  if (e.target.id === 'whatif-modal') closeWhatIf();
  if (e.target.id === 'auth-modal') closeAuthModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeModal(); closeWhatIf(); closeAuthModal(); }
});

// ===== AUTO REFRESH =====
function startAutoRefresh(managerId) {
  stopAutoRefresh();
  refreshSecondsLeft = AUTO_REFRESH_INTERVAL;
  updateRefreshDisplay();

  countdownTimer = setInterval(() => {
    refreshSecondsLeft--;
    updateRefreshDisplay();
    if (refreshSecondsLeft <= 0) {
      refreshSecondsLeft = AUTO_REFRESH_INTERVAL;
      silentRefresh(managerId);
    }
  }, 1000);
}

function stopAutoRefresh() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = null;
}

function updateRefreshDisplay() {
  const el = document.getElementById('refresh-timer');
  if (el) {
    const mins = Math.floor(refreshSecondsLeft / 60);
    const secs = refreshSecondsLeft % 60;
    el.innerHTML = `&#x1F504; <span class="countdown">${mins}:${secs.toString().padStart(2, '0')}</span>`;
  }
}

async function silentRefresh(managerId) {
  try {
    const res = await apiFetch(`/api/squad/${managerId}`);
    if (!res.ok) return;
    squadData = await res.json();
    renderSquad(squadData);
  } catch {}
}

// ===== API HELPER (attaches auth token) =====
function apiFetch(url, options = {}) {
  const token = localStorage.getItem('mallempu_token');
  if (token) {
    options.headers = { ...options.headers, 'Authorization': `Bearer ${token}` };
  }
  return fetch(`${API}${url}`, options);
}

// Free features (no login needed): squad, top players, prices
// Premium features (login + admin approval): expert, differentials, lineups, planner, chips, whatif
const FREE_TABS = ['squad', 'players', 'prices'];

function isTabAllowed(tab) {
  if (FREE_TABS.includes(tab)) return true;
  if (!currentUser) return false;
  return currentUser.tier === 'pro' || currentUser.tier === 'team';
}

// ===== UTILS =====
function escHtml(text) {
  if (!text) return '';
  const el = document.createElement('span');
  el.textContent = text;
  return el.innerHTML;
}

function formatRank(rank) {
  if (rank >= 1000000) return (rank / 1000000).toFixed(1) + 'M';
  if (rank >= 1000) return (rank / 1000).toFixed(0) + 'K';
  return rank.toLocaleString();
}

function fdrClass(fdr) { return 'fdr-' + Math.max(1, Math.min(5, fdr)); }
function fixturesBadges(fixtures) {
  if (!fixtures?.length) return '';
  return '<div class="fixture-list">' + fixtures.map(f =>
    `<span class="fixture-badge ${fdrClass(f.fdr)}">${escHtml(f.opponent)} ${f.isHome ? '(H)' : '(A)'}</span>`
  ).join('') + '</div>';
}
const posNames = { 1: 'GK', 2: 'DEF', 3: 'MID', 4: 'FWD' };
const posClasses = { 1: 'pos-gk', 2: 'pos-def', 3: 'pos-mid', 4: 'pos-fwd' };

// ===== EXPERT PICKS =====
let expertLoaded = false;
async function loadExpertPicks() {
  if (expertLoaded) return;
  const content = document.getElementById('expert-content');
  content.innerHTML = `<div class="loading"><div class="spinner"></div>Analyzing expert picks...</div>`;

  try {
    const res = await apiFetch(`/api/expert-picks`);
    const data = await res.json();
    expertLoaded = true;
    renderExpertPicks(data, content);
  } catch {
    content.innerHTML = `<div class="empty-state"><div class="icon">&#9888;</div><p>Failed to load expert picks</p></div>`;
  }
}

function renderExpertPicks(data, container) {
  let html = '';

  // Captain
  if (data.captain) {
    const c = data.captain;
    html += `<div class="card">
      <div class="card-header"><div class="card-title">&#128081; Captain Pick — GW${data.gw}</div></div>
      <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
        <div style="text-align:center">
          <div class="stat-value score-high" style="font-size:2rem">${c.qualityScore}</div>
          <div class="stat-label">Quality</div>
        </div>
        <div>
          <strong style="font-size:1.1rem">${escHtml(c.webName)}</strong>
          <div style="color:var(--text-muted)">${escHtml(c.team)} | &pound;${c.price}m | Form ${c.form}</div>
          <div style="margin-top:8px">${fixturesBadges(c.nextFixtures)}</div>
        </div>
      </div>
      ${data.captainAlts?.length ? `<div style="margin-top:12px;font-size:0.85rem;color:var(--text-muted)">Alternatives: ${data.captainAlts.map(a => `${escHtml(a.webName)} (${a.qualityScore})`).join(', ')}</div>` : ''}
    </div>`;
  }

  // Transfer-In, Differentials, Budget — each as a card
  const sections = [
    { key: 'transfersIn', title: '&#128229; Best Transfer-In', scoreKey: 'qualityScore' },
    { key: 'differentials', title: '&#128142; Differential Picks', scoreKey: 'differentialScore' },
    { key: 'budgetPicks', title: '&#128176; Budget Picks', scoreKey: 'qualityScore' },
  ];

  for (const sec of sections) {
    const items = data[sec.key];
    if (!items) continue;
    html += `<div class="card"><div class="card-title">${sec.title}</div><div style="margin-top:12px">`;
    for (const pos of [1,2,3,4]) {
      const players = items[pos];
      if (!players?.length) continue;
      html += `<div style="margin-bottom:8px"><span class="pos-badge ${posClasses[pos]}">${posNames[pos]}</span></div>`;
      for (const p of players) {
        const sc = p[sec.scoreKey] || p.qualityScore;
        const scoreClass = sc >= 65 ? 'score-high' : sc >= 40 ? 'score-mid' : 'score-low';
        html += `<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)">
          <div><strong>${escHtml(p.webName)}</strong> <span style="color:var(--text-muted)">${escHtml(p.teamShort)} | &pound;${p.price}m</span></div>
          <div style="display:flex;align-items:center;gap:8px">
            ${fixturesBadges(p.nextFixtures)}
            <span class="${scoreClass}" style="font-weight:700;min-width:30px;text-align:right">${sc}</span>
          </div>
        </div>`;
      }
    }
    html += '</div></div>';
  }

  container.innerHTML = html;
}

// ===== PRICE WARNINGS =====
let pricesLoaded = false;
async function loadPriceWarnings() {
  if (pricesLoaded) return;
  const content = document.getElementById('prices-content');
  content.innerHTML = `<div class="loading"><div class="spinner"></div>Analyzing transfer activity...</div>`;

  try {
    const res = await apiFetch(`/api/price-warnings`);
    const data = await res.json();
    pricesLoaded = true;
    renderPriceWarnings(data, content);
  } catch {
    content.innerHTML = `<div class="empty-state"><div class="icon">&#9888;</div><p>Failed to load price data</p></div>`;
  }
}

function renderPriceWarnings(data, container) {
  const renderList = (items, direction) => {
    if (!items?.length) return `<div class="empty-state" style="padding:20px"><p>No ${direction} warnings</p></div>`;
    let html = '';
    for (const p of items) {
      const color = p.likelihood === 'VERY_LIKELY' ? 'var(--red)' : p.likelihood === 'LIKELY' ? 'var(--gold)' : 'var(--text-muted)';
      html += `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border)">
        <div>
          <strong>${escHtml(p.webName)}</strong> <span style="color:var(--text-muted)">${escHtml(p.teamShort)} | &pound;${p.price}m</span>
          <div style="font-size:0.75rem;color:var(--text-muted)">Net: ${p.netTransfers > 0 ? '+' : ''}${p.netTransfers.toLocaleString()} | EO: ${p.selectedByPercent}%</div>
        </div>
        <div style="text-align:right;min-width:120px">
          <div style="font-size:0.75rem;color:${color};font-weight:600">${p.likelihood.replace('_', ' ')}</div>
          <div class="quality-bar-track" style="margin-top:4px">
            <div class="quality-bar-fill" style="width:${p.progress}%;background:${color}"></div>
          </div>
          <div style="font-size:0.65rem;color:var(--text-muted)">${p.progress}%</div>
        </div>
      </div>`;
    }
    return html;
  };

  container.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
      <div class="card">
        <div class="card-title">&#128200; Likely to Rise</div>
        ${renderList(data.risers, 'rise')}
      </div>
      <div class="card">
        <div class="card-title">&#128201; Likely to Fall</div>
        ${renderList(data.fallers, 'fall')}
      </div>
    </div>`;
}

// ===== PREDICTED LINEUPS =====
let lineupTeamsLoaded = false;
async function loadLineupTeams() {
  if (lineupTeamsLoaded) return;
  try {
    const res = await apiFetch(`/api/predicted-lineups`);
    const data = await res.json();
    lineupTeamsLoaded = true;
    const select = document.getElementById('lineup-team-select');
    for (const l of data.lineups) {
      const opt = document.createElement('option');
      opt.value = l.teamShort;
      opt.textContent = `${l.teamName} (${l.formation})`;
      select.appendChild(opt);
    }
    // Cache for later
    window._allLineups = data.lineups;
  } catch {}
}

async function loadTeamLineup(teamShort) {
  if (!teamShort) return;
  const content = document.getElementById('lineups-content');
  content.innerHTML = `<div class="loading"><div class="spinner"></div>Loading lineup...</div>`;

  // Use cached data if available
  const cached = window._allLineups?.find(l => l.teamShort === teamShort);
  if (cached) { renderLineup(cached, content); return; }

  try {
    const res = await apiFetch(`/api/predicted-lineup/${encodeURIComponent(teamShort)}`);
    if (!res.ok) { content.innerHTML = `<div class="empty-state"><p>Team not found</p></div>`; return; }
    const data = await res.json();
    renderLineup(data, content);
  } catch {
    content.innerHTML = `<div class="empty-state"><p>Failed to load lineup</p></div>`;
  }
}

function renderLineup(data, container) {
  if (!data.startingXI?.length) { container.innerHTML = `<div class="empty-state"><p>No lineup data available</p></div>`; return; }
  const grouped = { 1: [], 2: [], 3: [], 4: [] };
  for (const p of data.startingXI) grouped[p.elementType].push(p);

  let pitchHtml = `
    <div class="card">
      <div class="card-header">
        <div class="card-title">${escHtml(data.teamName)} — Predicted XI</div>
        <div class="card-subtitle">Formation: ${data.formation} | Avg Confidence: ${data.avgProbability}%</div>
      </div>
      <div class="pitch">`;

  for (const posId of [4, 3, 2, 1]) {
    const players = grouped[posId];
    if (!players.length) continue;
    pitchHtml += `<div class="pitch-label">${posNames[posId]}</div><div class="pitch-row">`;
    for (const p of players) {
      const confClass = p.startProbability >= 80 ? 'score-high' : p.startProbability >= 50 ? 'score-mid' : 'score-low';
      pitchHtml += `
        <div class="player-chip">
          <div class="player-name">${escHtml(p.webName)}</div>
          <div class="player-score ${confClass}">${p.startProbability}%</div>
          <div class="player-price">&pound;${p.price}m | QS ${p.qualityScore}</div>
        </div>`;
    }
    pitchHtml += '</div>';
  }

  // Bench
  if (data.bench?.length) {
    pitchHtml += `<div class="bench-section"><div class="pitch-label">BENCH</div><div class="pitch-row">`;
    for (const p of data.bench.slice(0, 5)) {
      pitchHtml += `
        <div class="player-chip">
          <div class="player-name">${escHtml(p.webName)}</div>
          <div class="player-score score-low">${p.startProbability}%</div>
          <div class="player-price">${posNames[p.elementType]}</div>
        </div>`;
    }
    pitchHtml += '</div></div>';
  }

  pitchHtml += '</div></div>';
  container.innerHTML = pitchHtml;
}

// ===== CHIP PLAN =====
let chipsLoaded = false;
async function loadChipPlan() {
  if (chipsLoaded) return;
  const content = document.getElementById('chips-content');
  content.innerHTML = `<div class="loading"><div class="spinner"></div>Analyzing chip timing...</div>`;

  try {
    const res = await apiFetch(`/api/chip-plan`);
    const data = await res.json();
    chipsLoaded = true;
    renderChipPlan(data, content);
  } catch {
    content.innerHTML = `<div class="empty-state"><div class="icon">&#9888;</div><p>Failed to analyze chip plan</p></div>`;
  }
}

function renderChipPlan(data, container) {
  const chipMeta = {
    wildcard1: { name: 'Wildcard 1', emoji: '&#127183;', desc: 'GW1-19' },
    wildcard2: { name: 'Wildcard 2', emoji: '&#127183;', desc: 'GW20-38' },
    freeHit: { name: 'Free Hit', emoji: '&#127919;', desc: 'One-week squad' },
    benchBoost: { name: 'Bench Boost', emoji: '&#128203;', desc: 'All 15 players score' },
    tripleCaptain: { name: 'Triple Captain', emoji: '&#128081;', desc: '3x captain points' },
  };
  const confColors = { HIGH: 'var(--accent)', MEDIUM: 'var(--gold)', LOW: 'var(--red)' };

  // Chip cards
  let html = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px;margin-bottom:24px">';
  for (const [key, meta] of Object.entries(chipMeta)) {
    const chip = data.chips[key];
    if (!chip) {
      html += `<div class="card" style="opacity:0.5"><div class="card-title">${meta.emoji} ${meta.name}</div><div class="card-subtitle">${meta.desc}</div><p style="color:var(--text-muted);margin-top:8px">Not enough data</p></div>`;
      continue;
    }
    html += `<div class="card">
      <div class="card-header">
        <div class="card-title">${meta.emoji} ${meta.name}</div>
        <span class="label-badge" style="background:${confColors[chip.confidence]}20;color:${confColors[chip.confidence]}">${chip.confidence}</span>
      </div>
      <div class="stat-value" style="font-size:1.5rem;margin:8px 0">GW${chip.gw}</div>
      <div style="font-size:0.85rem;color:var(--text-muted)">${escHtml(chip.reason)}</div>
      ${chip.isDGW ? '<div style="margin-top:4px"><span class="label-badge" style="background:rgba(151,117,250,0.2);color:var(--purple)">DGW</span></div>' : ''}
      ${chip.isBGW ? '<div style="margin-top:4px"><span class="label-badge" style="background:rgba(224,49,49,0.2);color:var(--red)">BGW</span></div>' : ''}
    </div>`;
  }
  html += '</div>';

  // GW difficulty timeline
  html += '<div class="card"><div class="card-title">Season Difficulty Overview</div><div style="margin-top:12px;display:flex;flex-wrap:wrap;gap:3px">';
  for (const gw of data.gwDifficulty) {
    const color = gw.avgFdr < 2.7 ? 'var(--fdr1)' : gw.avgFdr < 3.0 ? 'var(--fdr2)' : gw.avgFdr < 3.3 ? 'var(--fdr3)' : gw.avgFdr < 3.6 ? 'var(--fdr4)' : 'var(--fdr5)';
    const chipOnGw = Object.entries(data.chips).find(([, c]) => c?.gw === gw.gw);
    const chipLabel = chipOnGw ? chipMeta[chipOnGw[0]]?.emoji || '' : '';
    html += `<div style="width:28px;text-align:center;cursor:default" title="GW${gw.gw} | Avg FDR: ${gw.avgFdr.toFixed(1)} | Easy: ${gw.easyCount} | Hard: ${gw.hardCount}${gw.isDGW ? ' | DGW' : ''}${gw.isBGW ? ' | BGW' : ''}">
      <div style="font-size:0.55rem;color:var(--text-muted)">${gw.gw}</div>
      <div style="height:24px;border-radius:3px;background:${color};display:flex;align-items:center;justify-content:center;font-size:0.55rem">${chipLabel}</div>
    </div>`;
  }
  html += '</div></div>';

  container.innerHTML = html;
}

// ===== TRANSFER PLANNER =====
async function loadTransferPlan() {
  const id = document.getElementById('planner-id-input').value.trim() || document.getElementById('fpl-id-input').value.trim();
  if (!id) return;
  const content = document.getElementById('planner-content');
  content.innerHTML = `<div class="loading"><div class="spinner"></div>Building transfer plan...</div>`;

  try {
    const res = await apiFetch(`/api/transfer-plan/${id}`);
    if (!res.ok) { const err = await res.json(); content.innerHTML = `<div class="empty-state"><p>${escHtml(err.error || 'Unknown error')}</p></div>`; return; }
    const data = await res.json();
    renderTransferPlan(data, content);
  } catch {
    content.innerHTML = `<div class="empty-state"><p>Failed to build transfer plan</p></div>`;
  }
}

function renderTransferPlan(data, container) {
  let html = '';

  // Fixture swings
  if (data.swings?.length) {
    html += '<div class="card"><div class="card-title">&#128200; Key Fixture Swings</div><div style="margin-top:8px">';
    for (const s of data.swings.slice(0, 6)) {
      const icon = s.direction === 'improving' ? '&#128994;' : '&#128308;';
      html += `<div style="padding:4px 0;font-size:0.85rem">${icon} <strong>${escHtml(s.teamShort)}</strong> GW${s.gw}: ${s.fdrBefore} &#8594; ${s.fdrAfter} (${s.direction})</div>`;
    }
    html += '</div></div>';
  }

  // Per-GW plan
  html += '<div class="card"><div class="card-title">&#128203; GW-by-GW Plan</div>';
  for (const gw of data.plan) {
    const fdrColor = parseFloat(gw.avgSquadFdr) < 2.8 ? 'var(--accent)' : parseFloat(gw.avgSquadFdr) < 3.3 ? 'var(--gold)' : 'var(--red)';
    const actionIcon = gw.action === 'transfer' ? '&#128260;' : '&#128190;';
    const actionLabel = gw.action === 'transfer' ? 'TRANSFER' : 'HOLD';
    const actionColor = gw.action === 'transfer' ? 'var(--accent)' : 'var(--text-muted)';

    html += `<div style="padding:12px 0;border-bottom:1px solid var(--border)">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <strong>GW${gw.gw}</strong>
          <span class="label-badge" style="background:${actionColor}20;color:${actionColor};margin-left:8px">${actionIcon} ${actionLabel}</span>
          <span style="font-size:0.75rem;color:var(--text-muted);margin-left:8px">FT: ${gw.freeTransfers}</span>
        </div>
        <div style="font-size:0.8rem;color:${fdrColor}">Squad FDR: ${gw.avgSquadFdr}</div>
      </div>`;

    if (gw.action === 'transfer' && gw.suggestedOut && gw.suggestedIn) {
      html += `<div style="margin-top:8px;font-size:0.85rem">
        &#10060; ${escHtml(gw.suggestedOut.webName)} (${escHtml(gw.suggestedOut.team)}) QS ${gw.suggestedOut.qualityScore}
        &#8594; &#9989; ${escHtml(gw.suggestedIn.webName)} (${escHtml(gw.suggestedIn.team)}) QS ${gw.suggestedIn.qualityScore} (+${gw.suggestedIn.improvement})
      </div>`;
    } else {
      html += `<div style="margin-top:4px;font-size:0.8rem;color:var(--text-muted)">${escHtml(gw.reason)}</div>`;
    }
    html += '</div>';
  }
  html += '</div>';

  container.innerHTML = html;
}

// ===== WHAT-IF SIMULATOR =====
function openWhatIf() {
  document.getElementById('whatif-modal').classList.add('active');
  document.getElementById('whatif-result').innerHTML = '';
}
function closeWhatIf() {
  document.getElementById('whatif-modal').classList.remove('active');
}

async function runWhatIf() {
  const outName = document.getElementById('whatif-out').value.trim();
  const inName = document.getElementById('whatif-in').value.trim();
  if (!outName || !inName) return;

  const managerId = document.getElementById('fpl-id-input').value.trim();
  if (!managerId) { document.getElementById('whatif-result').innerHTML = '<p style="color:var(--red)">Load your squad first</p>'; return; }

  const resultEl = document.getElementById('whatif-result');
  resultEl.innerHTML = '<div class="loading" style="padding:10px"><div class="spinner"></div></div>';

  try {
    // First search for players to get IDs
    const [outRes, inRes] = await Promise.all([
      apiFetch(`/api/player/search?q=${encodeURIComponent(outName)}`),
      apiFetch(`/api/player/search?q=${encodeURIComponent(inName)}`),
    ]);
    const outData = await outRes.json();
    const inData = await inRes.json();

    if (!outData.results?.length) { resultEl.innerHTML = `<p style="color:var(--red)">Player "${escHtml(outName)}" not found</p>`; return; }
    if (!inData.results?.length) { resultEl.innerHTML = `<p style="color:var(--red)">Player "${escHtml(inName)}" not found</p>`; return; }

    const res = await apiFetch(`/api/whatif`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        managerId: parseInt(managerId),
        transfers: [{ outId: outData.results[0].id, inId: inData.results[0].id }],
      }),
    });

    const data = await res.json();
    if (!data.valid) {
      resultEl.innerHTML = `<p style="color:var(--red)">${(data.errors || ['Simulation failed']).map(e => escHtml(e)).join('<br>')}</p>`;
      return;
    }

    let html = '';
    for (const t of data.transfers) {
      const qDiff = t.qualityDiff;
      const qColor = qDiff > 0 ? 'var(--accent)' : qDiff < 0 ? 'var(--red)' : 'var(--text-muted)';
      html += `<div style="padding:12px;background:var(--bg-hover);border-radius:8px;margin-bottom:8px">
        <div>&#10060; <strong>${escHtml(t.out.webName)}</strong> (${escHtml(t.out.teamShort)}) QS ${t.out.qualityScore}</div>
        <div>&#9989; <strong>${escHtml(t.in.webName)}</strong> (${escHtml(t.in.teamShort)}) QS ${t.in.qualityScore}</div>
        <div style="margin-top:8px;font-size:0.85rem">Quality: <span style="color:${qColor};font-weight:700">${qDiff > 0 ? '+' : ''}${qDiff}</span> | Cost: ${t.costDiff > 0 ? '+' : ''}&pound;${(t.costDiff / 10).toFixed(1)}m</div>
      </div>`;
    }

    const imp = data.impact;
    const iqColor = imp.qualityDiff > 0 ? 'var(--accent)' : imp.qualityDiff < 0 ? 'var(--red)' : 'var(--text-muted)';
    html += `<div style="font-size:0.85rem;margin-top:8px">
      <div>Avg Quality: ${data.before.avgQuality} &#8594; ${data.after.avgQuality} <span style="color:${iqColor}">(${imp.qualityDiff > 0 ? '+' : ''}${imp.qualityDiff})</span></div>
      <div>Bank: &pound;${(data.before.bank / 10).toFixed(1)}m &#8594; &pound;${(data.after.bank / 10).toFixed(1)}m</div>
    </div>`;

    resultEl.innerHTML = html;
  } catch {
    resultEl.innerHTML = '<p style="color:var(--red)">Simulation error</p>';
  }
}

// ===== AUTH SYSTEM =====
let currentUser = null;

function initAuth() {
  const token = localStorage.getItem('mallempu_token');
  if (token) {
    fetchMe(token);
  }
}

async function fetchMe(token) {
  try {
    const res = await fetch(`${API}/api/auth/me`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (res.ok) {
      currentUser = await res.json();
      renderAuthArea();
      // Auto-fill FPL ID if user has one saved
      if (currentUser.fplId && !document.getElementById('fpl-id-input').value) {
        document.getElementById('fpl-id-input').value = currentUser.fplId;
      }
    } else {
      localStorage.removeItem('mallempu_token');
      currentUser = null;
      renderAuthArea();
    }
  } catch {
    currentUser = null;
    renderAuthArea();
  }
}

function renderAuthArea() {
  const area = document.getElementById('auth-area');
  if (currentUser) {
    const tierBadge = currentUser.tier === 'pro'
      ? '<span class="label-badge" style="background:var(--gold-subtle);color:var(--gold);margin-left:4px">PRO</span>'
      : currentUser.tier === 'team'
      ? '<span class="label-badge" style="background:var(--purple-subtle);color:var(--purple);margin-left:4px">TEAM</span>'
      : '';
    area.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;position:relative" id="user-menu-wrap">
        <button class="btn btn-secondary" onclick="toggleUserMenu()" style="padding:5px 12px;font-size:0.75rem">
          ${escHtml(currentUser.name || currentUser.email.split('@')[0])}${tierBadge} &#9662;
        </button>
        <div id="user-dropdown" style="display:none;position:absolute;top:100%;right:0;margin-top:4px;background:var(--bg-card);border:1px solid var(--border-strong);border-radius:var(--radius-sm);box-shadow:var(--shadow-lg);min-width:180px;z-index:200;overflow:hidden">
          <div style="padding:12px 14px;border-bottom:1px solid var(--border);font-size:0.75rem;color:var(--text-muted)">${escHtml(currentUser.email)}</div>
          <div style="padding:8px 14px;font-size:0.78rem;color:var(--text-secondary)">
            Tier: <strong style="color:var(--text)">${currentUser.tier.toUpperCase()}</strong>
            ${currentUser.tier === 'free' ? '<div style="margin-top:4px;font-size:0.7rem;color:var(--accent)">Upgrade ke Pro untuk fitur lengkap</div>' : ''}
          </div>
          <button onclick="doLogout()" style="width:100%;text-align:left;padding:10px 14px;background:none;border:none;border-top:1px solid var(--border);color:var(--red);cursor:pointer;font-size:0.78rem;font-family:var(--font)">Logout</button>
        </div>
      </div>`;
  } else {
    area.innerHTML = `
      <button class="btn btn-secondary" onclick="openAuthModal('login')" style="padding:5px 12px;font-size:0.75rem">Login</button>
      <button class="btn btn-primary" onclick="openAuthModal('register')" style="padding:5px 12px;font-size:0.75rem">Daftar</button>`;
  }
}

function toggleUserMenu() {
  const dd = document.getElementById('user-dropdown');
  if (dd) dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
}

// Close user menu when clicking outside
document.addEventListener('click', (e) => {
  const wrap = document.getElementById('user-menu-wrap');
  const dd = document.getElementById('user-dropdown');
  if (dd && wrap && !wrap.contains(e.target)) dd.style.display = 'none';
});

function openAuthModal(form) {
  document.getElementById('auth-modal').classList.add('active');
  switchAuthForm(form || 'login');
}

function closeAuthModal() {
  document.getElementById('auth-modal').classList.remove('active');
  document.getElementById('login-error').style.display = 'none';
  document.getElementById('reg-error').style.display = 'none';
}

function switchAuthForm(form) {
  document.getElementById('auth-login').style.display = form === 'login' ? 'block' : 'none';
  document.getElementById('auth-register').style.display = form === 'register' ? 'block' : 'none';
}

async function doLogin() {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  errEl.style.display = 'none';

  if (!email || !password) { errEl.textContent = 'Email dan password wajib diisi'; errEl.style.display = 'block'; return; }

  try {
    const res = await fetch(`${API}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error; errEl.style.display = 'block'; return; }

    localStorage.setItem('mallempu_token', data.token);
    currentUser = data.user;
    closeAuthModal();
    renderAuthArea();
    if (currentUser.fplId && !document.getElementById('fpl-id-input').value) {
      document.getElementById('fpl-id-input').value = currentUser.fplId;
    }
  } catch {
    errEl.textContent = 'Koneksi gagal'; errEl.style.display = 'block';
  }
}

async function doRegister() {
  const name = document.getElementById('reg-name').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-password').value;
  const fplId = document.getElementById('reg-fplid').value.trim();
  const errEl = document.getElementById('reg-error');
  errEl.style.display = 'none';

  if (!email || !password) { errEl.textContent = 'Email dan password wajib diisi'; errEl.style.display = 'block'; return; }
  if (password.length < 6) { errEl.textContent = 'Password minimal 6 karakter'; errEl.style.display = 'block'; return; }

  try {
    const res = await fetch(`${API}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name, fplId: fplId || null }),
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error; errEl.style.display = 'block'; return; }

    localStorage.setItem('mallempu_token', data.token);
    currentUser = data.user;
    closeAuthModal();
    renderAuthArea();
    if (currentUser.fplId) {
      document.getElementById('fpl-id-input').value = currentUser.fplId;
    }
  } catch {
    errEl.textContent = 'Koneksi gagal'; errEl.style.display = 'block';
  }
}

function doLogout() {
  localStorage.removeItem('mallempu_token');
  currentUser = null;
  renderAuthArea();
}

// ===== MANUAL REFRESH =====
async function manualRefresh() {
  const id = document.getElementById('fpl-id-input').value.trim();
  if (!id || !squadData) return;
  stopAutoRefresh();
  const content = document.getElementById('squad-content');
  content.innerHTML = `<div class="loading"><div class="spinner"></div>Refreshing...</div>`;
  try {
    const res = await apiFetch(`/api/squad/${id}`);
    if (res.ok) {
      squadData = await res.json();
      renderSquad(squadData);
      showLegendFab(true);
    }
  } catch {}
  startAutoRefresh(id);
}
