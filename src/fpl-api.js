const axios = require('axios');
const axiosRetry = require('axios-retry').default || require('axios-retry');
const crypto = require('crypto');

const { trackApiCall } = require('./monitor');

const BASE = 'https://fantasy.premierleague.com/api';

// Create axios instance with retry logic
const fplClient = axios.create({ timeout: 15000 });

// Track API call performance
fplClient.interceptors.request.use(config => {
  config._startTime = Date.now();
  return config;
});

fplClient.interceptors.response.use(
  response => {
    const duration = Date.now() - (response.config._startTime || Date.now());
    trackApiCall(duration, true, !!response.config['axios-retry']);
    return response;
  },
  error => {
    const duration = Date.now() - (error.config?._startTime || Date.now());
    trackApiCall(duration, false, !!error.config?.['axios-retry']);
    return Promise.reject(error);
  }
);

axiosRetry(fplClient, {
  retries: 3,
  retryDelay: (retryCount) => axiosRetry.exponentialDelay(retryCount),
  retryCondition: (error) =>
    axiosRetry.isNetworkOrIdempotentRequestError(error) ||
    error.response?.status === 429 ||
    error.response?.status >= 500,
  onRetry: (retryCount, error) => {
    console.warn(`[FPL API] Retry ${retryCount}: ${error.message}`);
  },
});

let cache = { bootstrap: null, fixtures: null, bootstrapTs: 0, fixturesTs: 0 };
const CACHE_TTL = 3600_000; // 1 jam

async function fetchBootstrap() {
  const now = Date.now();
  if (cache.bootstrap && now - cache.bootstrapTs < CACHE_TTL) return cache.bootstrap;

  const { data } = await fplClient.get(`${BASE}/bootstrap-static/`);
  cache.bootstrap = data;
  cache.bootstrapTs = now;
  return data;
}

async function fetchFixtures() {
  const now = Date.now();
  if (cache.fixtures && now - cache.fixturesTs < CACHE_TTL) return cache.fixtures;

  const { data } = await fplClient.get(`${BASE}/fixtures/`);
  cache.fixtures = data;
  cache.fixturesTs = now;
  return data;
}

async function fetchPlayerHistory(playerId) {
  const { data } = await fplClient.get(`${BASE}/element-summary/${playerId}/`);
  return data;
}

// Manager info & squad
async function fetchManagerInfo(managerId) {
  const { data } = await fplClient.get(`${BASE}/entry/${managerId}/`);
  return data;
}

async function fetchManagerPicks(managerId, gw) {
  const { data } = await fplClient.get(`${BASE}/entry/${managerId}/event/${gw}/picks/`);
  return data;
}

async function fetchManagerTransfers(managerId) {
  const { data } = await fplClient.get(`${BASE}/entry/${managerId}/transfers/`);
  return data;
}

function clearCache() {
  cache = { bootstrap: null, fixtures: null, bootstrapTs: 0, fixturesTs: 0 };
}

// =====================
// FPL LOGIN & MY-TEAM (live squad sebelum deadline)
// Per-user session store
// =====================

// Per-user sessions: Map<chatId, { session, refreshToken }>
const userSessions = new Map();
// Per-user PKCE state: Map<chatId, { codeVerifier, state }>
const pendingPkceMap = new Map();

// Legacy globals for owner auto-login (env-based)
let fplLoginError = null;
let fplLoginDebug = null;

function getUserSession(userId) {
  return userSessions.get(String(userId));
}

function setUserSession(userId, session, refreshToken) {
  userSessions.set(String(userId), { session, refreshToken: refreshToken || null });
}

function clearUserSession(userId) {
  userSessions.delete(String(userId));
}

// Restore sessions from DB on startup
function restoreSessions(tokens) {
  for (const t of tokens) {
    if (t.fpl_token) {
      userSessions.set(String(t.chat_id), {
        session: t.fpl_token,
        refreshToken: t.fpl_refresh_token || null,
      });
    }
  }
  if (tokens.length > 0) console.log(`[FPL] Restored ${tokens.length} user sessions from DB`);
}

// =====================
// FPL LOGIN via PingOne DaVinci SSO
// FPL migrated from users.premierleague.com to PingOne SSO (account.premierleague.com)
// Flow: authorize → DaVinci policy start → bot protection → login form → auth code → token → cookies
// =====================

const PINGONE_ENV_ID = '68340de1-dfb9-412e-937c-20172986d129';
const PINGONE_CLIENT_ID = '1f243d70-a140-4035-8c41-341f5af5aa12';
const PINGONE_AUTH_ROOT = 'https://account.premierleague.com';
const PINGONE_AUTH_ROOT_LEGACY = 'https://auth.pingone.eu';
const FPL_REDIRECT_URI = 'https://www.premierleague.com/';
const FPL_SCOPES = 'openid profile offline_access p1:update:user p1:read:device p1:reset:userPassword';

function extractSkProps(html) {
  const start = html.indexOf('var skProps = ') + 14;
  if (start < 14) return null;
  const fromStart = html.substring(start);
  let depth = 0, end = 0;
  for (let i = 0; i < fromStart.length; i++) {
    if (fromStart[i] === '{') depth++;
    if (fromStart[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  try { return JSON.parse(fromStart.substring(0, end)); } catch { return null; }
}

async function fplLogin() {
  const email = process.env.FPL_EMAIL;
  const password = process.env.FPL_PASSWORD;
  if (!email || !password) {
    fplLoginError = 'FPL_EMAIL atau FPL_PASSWORD belum di-set';
    fplLoginDebug = null;
    return null;
  }

  fplLoginDebug = { steps: [] };

  try {
    // Step 1: Start OAuth authorize — get DaVinci flow config
    const authResp = await axios.get(
      `${PINGONE_AUTH_ROOT}/as/authorize`,
      {
        params: {
          client_id: PINGONE_CLIENT_ID,
          response_type: 'code',
          redirect_uri: FPL_REDIRECT_URI,
          scope: FPL_SCOPES,
        },
        validateStatus: () => true,
        timeout: 15000,
      }
    );

    const skProps = extractSkProps(authResp.data);
    fplLoginDebug.steps.push({ step: 1, name: 'authorize', status: authResp.status, hasSkProps: !!skProps });
    if (!skProps?.accessToken || !skProps?.policyId) {
      fplLoginError = 'Gagal mendapatkan DaVinci flow config dari FPL';
      console.error('❌ FPL login: skProps not found in authorize response');
      return null;
    }

    const hdr = { 'X-SK-API-KEY': skProps.accessToken, 'Content-Type': 'application/json' };
    const base = `${skProps.apiRoot}/${skProps.companyId}`;

    // Step 2: Start DaVinci flow
    const flowResp = await axios.post(
      `${base}/davinci/policy/${skProps.policyId}/start`,
      {},
      { headers: hdr, validateStatus: () => true, timeout: 15000 }
    );
    const interactionId = flowResp.data.interactionId;
    fplLoginDebug.steps.push({ step: 2, name: 'flow-start', status: flowResp.status, hasInteraction: !!interactionId });
    if (!interactionId) {
      fplLoginError = 'Gagal memulai DaVinci login flow';
      return null;
    }

    // Step 3: Submit bot protection (protectsdk) — flat parameters
    console.log('DaVinci step3: submitting bot protection (flat)');
    const botResp = await axios.post(
      `${base}/davinci/connections/${flowResp.data.connectionId}/capabilities/${flowResp.data.capabilityName}`,
      {
        id: flowResp.data.id,
        eventName: 'continue',
        parameters: { protectsdk: '' },
      },
      { headers: { ...hdr, interactionid: interactionId }, validateStatus: () => true, timeout: 15000 }
    );

    console.log(`DaVinci step3 response: status=${botResp.status}, screen=${botResp.data.screen?.name}, connId=${botResp.data.connectionId}`);
    fplLoginDebug.steps.push({
      step: 3, name: 'bot-protection', status: botResp.status,
      screenName: botResp.data.screen?.name || null,
      hasConnectionId: !!botResp.data.connectionId,
    });

    // Step 4: Submit login credentials to the login form screen
    const loginConnId = botResp.data.connectionId || flowResp.data.connectionId;
    const loginCapName = botResp.data.capabilityName || flowResp.data.capabilityName;
    const loginId = botResp.data.id || flowResp.data.id;

    console.log(`DaVinci step4: submitting credentials to conn=${loginConnId}, cap=${loginCapName}`);
    const loginResp = await axios.post(
      `${base}/davinci/connections/${loginConnId}/capabilities/${loginCapName}`,
      {
        id: loginId,
        eventName: 'continue',
        parameters: {
          username: email,
          password: password,
          buttonValue: 'SIGNON',
        },
      },
      { headers: { ...hdr, interactionid: interactionId }, validateStatus: () => true, timeout: 15000 }
    );

    console.log(`FPL PingOne login: status=${loginResp.status}, respKeys=${Object.keys(loginResp.data || {}).join(',')}`);
    fplLoginDebug.steps.push({
      step: 4, name: 'login-submit', status: loginResp.status,
      hasAuthCode: !!loginResp.data.authorizeResponse?.code,
      errorCode: loginResp.data.code || null,
      errorReason: loginResp.data.error_reason || loginResp.data.description || null,
      screenName: loginResp.data.screen?.name || null,
      // Don't store raw response — may contain sensitive tokens
    });

    // Check for auth code in response
    if (loginResp.data.authorizeResponse?.code) {
      const authCode = loginResp.data.authorizeResponse.code;
      console.log('✅ FPL login: got auth code');

      // Step 5: Exchange auth code for session token via PingOne token endpoint
      const tokenResp = await axios.post(
        `${PINGONE_AUTH_ROOT}/as/token`,
        new URLSearchParams({
          grant_type: 'authorization_code',
          code: authCode,
          client_id: PINGONE_CLIENT_ID,
          redirect_uri: FPL_REDIRECT_URI,
        }).toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          validateStatus: () => true,
          timeout: 15000,
        }
      );

      if (tokenResp.data.access_token) {
        // Use the access token as Bearer for FPL API — store in owner session
        const session = `Bearer ${tokenResp.data.access_token}`;
        const ownerId = process.env.OWNER_ID || process.env.CHAT_ID || 'owner';
        setUserSession(ownerId, session, tokenResp.data.refresh_token);
        fplLoginError = null;
        console.log('✅ FPL login berhasil via PingOne SSO');
        return session;
      } else {
        fplLoginError = `Token exchange gagal: ${tokenResp.data.error || 'unknown'}`;
        console.error('❌ FPL token exchange failed:', JSON.stringify(tokenResp.data).substring(0, 200));
      }
    } else if (loginResp.status === 400) {
      // Login failed — extract reason
      const errMsg = loginResp.data.code || loginResp.data.error_reason || loginResp.data.description || '';
      if (errMsg.includes('Invalid username') || errMsg.includes('password')) {
        fplLoginError = 'Email atau password salah';
      } else if (errMsg.includes('locked') || errMsg.includes('blocked')) {
        fplLoginError = 'Akun terkunci. Coba reset password di premierleague.com';
      } else {
        fplLoginError = errMsg || 'Login gagal (400)';
      }
    } else if (loginResp.data.screen) {
      // Another screen appeared (e.g., 2FA, consent)
      fplLoginError = `Login butuh langkah tambahan: ${loginResp.data.screen.name || 'unknown screen'}`;
    } else {
      fplLoginError = `Login response tidak dikenali (status ${loginResp.status})`;
    }

    console.error('❌ FPL login gagal:', fplLoginError);
    return null;
  } catch (err) {
    fplLoginError = err.message;
    console.error('❌ FPL login error:', err.message);
    return null;
  }
}

function getFplLoginError() {
  return fplLoginError;
}

function getFplLoginDebug() {
  return fplLoginDebug;
}

// Per-user direct login (email + password) — same DaVinci flow as fplLogin() but per-user
async function fplLoginDirect(email, password, userId) {
  if (!email || !password) {
    return { success: false, error: 'Email dan password FPL wajib diisi' };
  }

  try {
    // Step 1: Start OAuth authorize
    const authResp = await axios.get(
      `${PINGONE_AUTH_ROOT}/as/authorize`,
      {
        params: {
          client_id: PINGONE_CLIENT_ID,
          response_type: 'code',
          redirect_uri: FPL_REDIRECT_URI,
          scope: FPL_SCOPES,
        },
        validateStatus: () => true,
        timeout: 15000,
      }
    );

    const skProps = extractSkProps(authResp.data);
    console.log(`[FPL Direct] Step 1: authorize status=${authResp.status}, hasSkProps=${!!skProps}, keys=${skProps ? Object.keys(skProps).join(',') : 'none'}`);
    if (skProps) {
      console.log(`[FPL Direct] skProps: apiRoot=${skProps.apiRoot}, companyId=${skProps.companyId}, policyId=${skProps.policyId}, hasToken=${!!skProps.accessToken}`);
    }
    if (!skProps?.accessToken || !skProps?.policyId) {
      console.error(`[FPL Direct] skProps missing required fields. authResp content-type: ${authResp.headers?.['content-type']}, body length: ${typeof authResp.data === 'string' ? authResp.data.length : 'not-string'}`);
      return { success: false, error: 'Gagal menghubungi server FPL. Coba lagi nanti.' };
    }

    const hdr = { 'X-SK-API-KEY': skProps.accessToken, 'Content-Type': 'application/json' };
    const base = `${skProps.apiRoot}/${skProps.companyId}`;

    // Step 2: Start DaVinci flow
    const flowStartUrl = `${base}/davinci/policy/${skProps.policyId}/start`;
    console.log(`[FPL Direct] Step 2: POST ${flowStartUrl}`);
    const flowResp = await axios.post(
      flowStartUrl,
      {},
      { headers: hdr, validateStatus: () => true, timeout: 15000 }
    );
    const interactionId = flowResp.data.interactionId;
    console.log(`[FPL Direct] Step 2 response: status=${flowResp.status}, hasInteraction=${!!interactionId}, keys=${Object.keys(flowResp.data || {}).join(',')}`);
    if (!interactionId) {
      console.error(`[FPL Direct] Flow start failed. Response:`, JSON.stringify(flowResp.data).substring(0, 500));
      return { success: false, error: 'Gagal memulai login flow. Coba lagi.' };
    }

    // Step 3: Bot protection
    const botResp = await axios.post(
      `${base}/davinci/connections/${flowResp.data.connectionId}/capabilities/${flowResp.data.capabilityName}`,
      {
        id: flowResp.data.id,
        eventName: 'continue',
        parameters: { protectsdk: '' },
      },
      { headers: { ...hdr, interactionid: interactionId }, validateStatus: () => true, timeout: 15000 }
    );

    // Step 4: Submit credentials
    const loginConnId = botResp.data.connectionId || flowResp.data.connectionId;
    const loginCapName = botResp.data.capabilityName || flowResp.data.capabilityName;
    const loginId = botResp.data.id || flowResp.data.id;

    const loginResp = await axios.post(
      `${base}/davinci/connections/${loginConnId}/capabilities/${loginCapName}`,
      {
        id: loginId,
        eventName: 'continue',
        parameters: { username: email, password: password, buttonValue: 'SIGNON' },
      },
      { headers: { ...hdr, interactionid: interactionId }, validateStatus: () => true, timeout: 15000 }
    );

    // Check for auth code
    if (loginResp.data.authorizeResponse?.code) {
      const authCode = loginResp.data.authorizeResponse.code;

      // Step 5: Exchange code for token
      const tokenResp = await axios.post(
        `${PINGONE_AUTH_ROOT}/as/token`,
        new URLSearchParams({
          grant_type: 'authorization_code',
          code: authCode,
          client_id: PINGONE_CLIENT_ID,
          redirect_uri: FPL_REDIRECT_URI,
        }).toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          validateStatus: () => true,
          timeout: 15000,
        }
      );

      if (tokenResp.data.access_token) {
        const session = `Bearer ${tokenResp.data.access_token}`;
        setUserSession(String(userId), session, tokenResp.data.refresh_token);
        console.log(`✅ FPL direct login berhasil for user ${userId}`);
        return { success: true };
      } else {
        return { success: false, error: 'Token exchange gagal. Coba lagi.' };
      }
    } else if (loginResp.status === 400) {
      const errMsg = loginResp.data.code || loginResp.data.error_reason || loginResp.data.description || '';
      if (errMsg.includes('Invalid username') || errMsg.includes('password')) {
        return { success: false, error: 'Email atau password FPL salah' };
      } else if (errMsg.includes('locked') || errMsg.includes('blocked')) {
        return { success: false, error: 'Akun FPL terkunci. Reset password di premierleague.com' };
      }
      return { success: false, error: errMsg || 'Login gagal' };
    } else if (loginResp.data.screen) {
      return { success: false, error: `Login butuh langkah tambahan: ${loginResp.data.screen.name || 'verifikasi'}` };
    }

    return { success: false, error: 'Login gagal. Coba lagi nanti.' };
  } catch (err) {
    console.error('FPL direct login error:', err.message);
    return { success: false, error: 'Koneksi ke server FPL gagal. Coba lagi.' };
  }
}

function setFplSession(token, userId) {
  const id = String(userId || process.env.OWNER_ID || process.env.CHAT_ID || 'owner');
  if (!token) {
    clearUserSession(id);
    return;
  }
  // Auto-detect format: Bearer token or cookie
  let session;
  if (token.startsWith('Bearer ')) {
    session = token;
  } else if (token.startsWith('ey')) {
    session = `Bearer ${token}`;
  } else {
    session = token.includes('=') ? token : `pl_profile=${token}`;
  }
  setUserSession(id, session, null);
  fplLoginError = null;
}

// =====================
// Authorization Code + PKCE Flow (per-user)
// User logs in via browser, copies redirect URL, bot exchanges code for token
// =====================

function generatePkce() {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('hex');
  return { codeVerifier, codeChallenge, state };
}

function startAuthCodeFlow(userId) {
  const pkce = generatePkce();
  pendingPkceMap.set(String(userId), { codeVerifier: pkce.codeVerifier, state: pkce.state });

  const params = new URLSearchParams({
    client_id: PINGONE_CLIENT_ID,
    response_type: 'code',
    redirect_uri: FPL_REDIRECT_URI,
    scope: FPL_SCOPES,
    code_challenge: pkce.codeChallenge,
    code_challenge_method: 'S256',
    state: pkce.state,
    language: 'en',
  });

  return `${PINGONE_AUTH_ROOT}/as/authorize?${params.toString()}`;
}

async function exchangeAuthCode(redirectUrl, userId) {
  const id = String(userId);
  const pendingPkce = pendingPkceMap.get(id);
  if (!pendingPkce) {
    return { success: false, error: 'Tidak ada login yang sedang berlangsung. Jalankan /fpllogin dulu.' };
  }

  // Extract code and state from redirect URL
  let code, state;
  try {
    const url = new URL(redirectUrl);
    code = url.searchParams.get('code');
    state = url.searchParams.get('state');
  } catch {
    code = redirectUrl.trim();
  }

  if (!code) {
    pendingPkceMap.delete(id);
    return { success: false, error: 'Tidak menemukan kode otorisasi di URL. Pastikan copy URL lengkap.' };
  }

  // Validate state parameter to prevent CSRF
  if (state && state !== pendingPkce.state) {
    pendingPkceMap.delete(id);
    return { success: false, error: 'State parameter tidak cocok. Coba /fpllogin lagi.' };
  }

  try {
    const { data } = await axios.post(
      `${PINGONE_AUTH_ROOT}/as/token`,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        client_id: PINGONE_CLIENT_ID,
        redirect_uri: FPL_REDIRECT_URI,
        code_verifier: pendingPkce.codeVerifier,
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        validateStatus: () => true,
        timeout: 15000,
      }
    );

    pendingPkceMap.delete(id);

    if (data.access_token) {
      const session = `Bearer ${data.access_token}`;
      setUserSession(id, session, data.refresh_token);
      fplLoginError = null;
      console.log(`✅ FPL auth code login berhasil (user ${id})`);
      return { success: true, token: session, refreshToken: data.refresh_token };
    }

    return { success: false, error: data.error_description || data.error || 'Token exchange gagal' };
  } catch (err) {
    pendingPkceMap.delete(id);
    return { success: false, error: err.message };
  }
}

// =====================
// Device Code Flow — user authorizes in browser, bot gets token
// =====================

async function startDeviceCodeFlow() {
  try {
    const { data } = await axios.post(
      `${PINGONE_AUTH_ROOT}/as/device_authorization`,
      new URLSearchParams({
        client_id: PINGONE_CLIENT_ID,
        scope: FPL_SCOPES,
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000,
      }
    );
    return data; // { device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval }
  } catch (err) {
    console.error('Device code flow start failed:', err.response?.data || err.message);
    return null;
  }
}

async function pollDeviceCodeToken(deviceCode, userId, interval = 5, expiresIn = 600) {
  const id = String(userId || process.env.OWNER_ID || process.env.CHAT_ID || 'owner');
  const deadline = Date.now() + expiresIn * 1000;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, interval * 1000));

    try {
      const { data } = await axios.post(
        `${PINGONE_AUTH_ROOT}/as/token`,
        new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceCode,
          client_id: PINGONE_CLIENT_ID,
        }).toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          validateStatus: () => true,
          timeout: 15000,
        }
      );

      if (data.access_token) {
        const session = `Bearer ${data.access_token}`;
        setUserSession(id, session, data.refresh_token);
        fplLoginError = null;
        console.log(`✅ FPL device code login berhasil (user ${id})`);
        return { success: true, access_token: data.access_token, refreshToken: data.refresh_token };
      }

      if (data.error === 'authorization_pending') {
        continue; // user hasn't authorized yet
      }
      if (data.error === 'slow_down') {
        interval += 5; // back off
        continue;
      }

      // Other errors (expired_token, access_denied)
      return { success: false, error: data.error_description || data.error || 'Unknown error' };
    } catch (err) {
      // Network error — retry
      console.warn('Device code poll error:', err.message);
    }
  }

  return { success: false, error: 'Timeout — kamu tidak menyelesaikan login dalam waktu yang ditentukan' };
}

async function refreshFplToken(userId) {
  const id = String(userId || process.env.OWNER_ID || process.env.CHAT_ID || 'owner');
  const session = getUserSession(id);
  if (!session?.refreshToken) return false;
  try {
    const { data } = await axios.post(
      `${PINGONE_AUTH_ROOT}/as/token`,
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: session.refreshToken,
        client_id: PINGONE_CLIENT_ID,
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        validateStatus: () => true,
        timeout: 15000,
      }
    );
    if (data.access_token) {
      setUserSession(id, `Bearer ${data.access_token}`, data.refresh_token || session.refreshToken);
      console.log(`✅ FPL token refreshed (user ${id})`);
      return true;
    }
    console.error('FPL token refresh failed:', data.error);
    clearUserSession(id);
    return false;
  } catch (err) {
    console.error('FPL token refresh error:', err.message);
    return false;
  }
}

function buildAuthHeaders(userId) {
  const id = String(userId || process.env.OWNER_ID || process.env.CHAT_ID || 'owner');
  const session = getUserSession(id);
  if (!session?.session) return null;
  // Support both Bearer token (PingOne) and Cookie (legacy)
  if (session.session.startsWith('Bearer ')) {
    return { Authorization: session.session };
  }
  return { Cookie: session.session };
}

async function fetchMyTeam(managerId, userId) {
  const id = String(userId || process.env.OWNER_ID || process.env.CHAT_ID || 'owner');
  let session = getUserSession(id);

  // If no per-user session, try owner env-based login as fallback (only for owner)
  if (!session) {
    const ownerId = String(process.env.OWNER_ID || process.env.CHAT_ID || 'owner');
    if (id === ownerId) {
      await fplLogin();
      session = getUserSession(id);
    }
  }
  if (!session) return null;

  const authHeaders = buildAuthHeaders(id);
  if (!authHeaders) return null;

  try {
    const { data } = await fplClient.get(`${BASE}/my-team/${managerId}/`, {
      headers: authHeaders,
    });
    return data;
  } catch (err) {
    // Session expired — try refresh then retry
    if (err.response?.status === 401 || err.response?.status === 403) {
      const refreshed = await refreshFplToken(id);
      if (!refreshed) {
        clearUserSession(id);
        return null;
      }
      try {
        const { data } = await fplClient.get(`${BASE}/my-team/${managerId}/`, {
          headers: buildAuthHeaders(id),
        });
        return data;
      } catch { return null; }
    }
    return null;
  }
}

// Ambil semua data yang dibutuhkan
async function fetchAll() {
  const [bootstrap, fixtures] = await Promise.all([fetchBootstrap(), fetchFixtures()]);

  const teams = {};
  for (const t of bootstrap.teams) {
    teams[t.id] = t;
  }

  // Hitung jumlah laga tim (dari fixtures yang sudah selesai)
  const teamGames = {};
  for (const f of fixtures) {
    if (f.finished) {
      teamGames[f.team_h] = (teamGames[f.team_h] || 0) + 1;
      teamGames[f.team_a] = (teamGames[f.team_a] || 0) + 1;
    }
  }

  // Current gameweek
  const currentGw = bootstrap.events.find(e => e.is_current)?.id
    || bootstrap.events.find(e => e.is_next)?.id
    || 1;

  // Upcoming fixtures per tim (belum selesai, urut GW)
  const upcomingByTeam = {};
  for (const f of fixtures) {
    if (f.finished || !f.event) continue;
    for (const side of ['team_h', 'team_a']) {
      const tid = f[side];
      if (!upcomingByTeam[tid]) upcomingByTeam[tid] = [];
      const oppId = side === 'team_h' ? f.team_a : f.team_h;
      upcomingByTeam[tid].push({
        gw: f.event,
        opponent: oppId,
        opponent_name: teams[oppId]?.short_name || `Team${oppId}`,
        isHome: side === 'team_h',
        fdr: side === 'team_h' ? f.team_h_difficulty : f.team_a_difficulty,
      });
    }
  }
  for (const tid in upcomingByTeam) {
    upcomingByTeam[tid].sort((a, b) => a.gw - b.gw);
  }

  // Enrich players
  const players = bootstrap.elements.map(p => ({
    ...p,
    teamData: teams[p.team],
    teamGames: teamGames[p.team] || 0,
    nextFixtures: (upcomingByTeam[p.team] || []).slice(0, 6),
  }));

  return { players, teams, fixtures, currentGw, events: bootstrap.events };
}

module.exports = {
  fetchAll, fetchBootstrap, fetchFixtures, fetchPlayerHistory,
  fetchManagerInfo, fetchManagerPicks, fetchManagerTransfers, clearCache,
  fetchMyTeam, fplLogin, fplLoginDirect, getFplLoginError, getFplLoginDebug, setFplSession,
  startDeviceCodeFlow, pollDeviceCodeToken, refreshFplToken,
  startAuthCodeFlow, exchangeAuthCode,
  getUserSession, clearUserSession, restoreSessions,
};
