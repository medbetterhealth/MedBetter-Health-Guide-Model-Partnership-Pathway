/*
 * data-store.js
 * ══════════════════════════════════════════════════════════════════
 * ⚠️  AUTH NOTE (read before touching login/register) — as of
 * 2026-07-09, REAL authentication no longer lives in this file.
 * login.html and index.html call PartnerAPI.loginPartner() /
 * PartnerAPI.createPartnerAccount() (partner-api.js), which hit
 * the mbh-referral-endpoints backend (Table Storage + bcrypt). That's
 * what makes an account work across devices/browsers. This file's own
 * login()/registerUser() functions
 * below are localStorage-only and are kept only as an unused
 * fallback/reference — DO NOT wire a login form back to
 * DataStore.login() directly, that would silently reintroduce the
 * "works on my computer, invalid on another" bug this was built to fix.
 * ══════════════════════════════════════════════════════════════════
 * What THIS file still legitimately owns (all local/cosmetic, not
 * auth): referral-source records + stats/referrals for this portal's
 * own zero-state dashboard.html (root of the repo — the REAL partner
 * data view is the main dashboard's partner.html), the local
 * dashboardAccessStatus mirror (so the portal can show "activation
 * email sent" without an extra API call just to check), and getSession()
 * /setSession()/requireAuth()/logout(), which read/write one
 * localStorage key that PartnerAPI now populates from the REAL backend's
 * response — so every page reading DataStore.getSession() keeps working
 * unchanged no matter which backend actually authenticated the partner.
 *
 * Data model:
 *   users:            { id, email, password, companyName, firstName,
 *                        lastName, phone, referralSourceId, createdAt }
 *   referralSources:  { id, name, createdAt, stats:REFERRAL_STATUSES-shaped
 *                        object, referrals: [{id, status, receivedAt, note}] }
 *   session:          { userId, email, companyName, referralSourceId, loggedInAt }
 * ------------------------------------------------------------------
 */
const DataStore = (() => {
  // Only affects THIS file's own login()/registerUser() (unused by any
  // page — see header). Real auth is PartnerAPI.loginPartner(), backed
  // by mbh-dashboard-api, not this flag.
  const DEMO_MODE = true;
  if (DEMO_MODE && typeof console !== 'undefined') {
    console.warn(
      '%c[DataStore] Note: DataStore.login()/registerUser() are localStorage-only and unused by the live login/register forms.\n' +
      'Real authentication is PartnerAPI.loginPartner()/createPartnerAccount() (partner-api.js), backed by mbh-referral-endpoints (Table Storage + bcrypt).\n' +
      'See the header comment in data-store.js for details.',
      'color:#b45309;font-weight:bold;'
    );
  }
  const USERS_KEY = 'guide_users_v1';
  const SOURCES_KEY = 'guide_referral_sources_v1';
  const SESSION_KEY = 'guide_session_v1';
  const ACCESS_KEY = 'guide_dashboard_access_v1';

  // ---- low-level storage helpers -----------------------------------
  function readAll(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      console.error('DataStore: failed to read', key, e);
      return [];
    }
  }

  function writeAll(key, arr) {
    localStorage.setItem(key, JSON.stringify(arr));
  }

  function makeId(prefix) {
    return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
  }

  // ---- validation helpers (exported for reuse in forms) --------------
  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
  }

  function isValidPhone(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    return digits.length === 10;
  }

  // ---- referral sources ------------------------------------------------
  // Requirement: when a new company registers, a matching Referral Source
  // record is auto-created (e.g. "ABC Home Care" -> Referral Source "ABC
  // Home Care"). This is what the live Partner Dashboard filters referrals
  // by ("Referred By" = this exact company name).

  // Every status a referral can be in on the main dashboard. Keys here are
  // used both as the per-referral `status` value and as the dashboard's
  // per-status counter name -- keep them in sync with the main dashboard's
  // own status list when the real backend is connected.
  const REFERRAL_STATUSES = [
    'submittedToMedicare',
    'scheduled',
    'approved',
    'denied',
    'notInterested',
    'noDementia',
    'unreachable'
  ];

  const STATUS_LABELS = {
    submittedToMedicare: 'Submitted to Medicare',
    scheduled: 'Scheduled',
    approved: 'Approved',
    denied: 'Denied',
    notInterested: 'Not Interested',
    noDementia: 'No Dementia',
    unreachable: 'Unreachable'
  };

  // The zero-state every new partner dashboard starts from.
  function emptyStats() {
    const stats = { total: 0 };
    REFERRAL_STATUSES.forEach(key => { stats[key] = 0; });
    return stats;
  }

  function createReferralSourceForCompany(companyName) {
    const name = String(companyName || '').trim();
    const sources = readAll(SOURCES_KEY);
    const existing = sources.find(s => s.name.toLowerCase() === name.toLowerCase());
    if (existing) return existing;

    const source = {
      id: makeId('rs'),
      name,
      createdAt: new Date().toISOString(),
      stats: emptyStats(),
      referrals: [] // {id, status, receivedAt, note} -- populated once referrals flow in from the main dashboard
    };
    sources.push(source);
    writeAll(SOURCES_KEY, sources);
    return source;
  }

  function getReferralSource(id) {
    return readAll(SOURCES_KEY).find(s => s.id === id) || null;
  }

  // Look up by the exact company/"Referred By" name rather than the
  // internal id -- this is the lookup key the real backend will actually
  // filter on, so PartnerAPI is built around this function.
  function getReferralSourceByName(name) {
    const norm = String(name || '').trim().toLowerCase();
    return readAll(SOURCES_KEY).find(s => s.name.toLowerCase() === norm) || null;
  }

  // ---- DEMO/QA ONLY --------------------------------------------------
  // Simulates a referral arriving from the main dashboard under a given
  // company name, so the portal's dashboard can be tested end-to-end
  // before the real backend is connected. Never call this from production
  // code paths -- it exists purely so you (or QA) can open the browser
  // console and verify the dashboard updates correctly. See the "How to
  // test" notes for exact console commands.
  function simulateReferral(companyName, status, note) {
    if (!REFERRAL_STATUSES.includes(status)) {
      throw new Error('Unknown status "' + status + '". Expected one of: ' + REFERRAL_STATUSES.join(', '));
    }
    const sources = readAll(SOURCES_KEY);
    const source = sources.find(s => s.name.toLowerCase() === String(companyName || '').trim().toLowerCase());
    if (!source) throw new Error('No referral source found for "' + companyName + '".');

    if (!source.stats) source.stats = emptyStats();
    if (!source.referrals) source.referrals = [];

    const referral = { id: makeId('ref'), status, receivedAt: new Date().toISOString(), note: note || '' };
    source.referrals.unshift(referral);
    source.stats.total = (source.stats.total || 0) + 1;
    source.stats[status] = (source.stats[status] || 0) + 1;

    writeAll(SOURCES_KEY, sources);
    return source;
  }

  // ---- users / auth ------------------------------------------------
  async function findUserByEmail(email) {
    const norm = normalizeEmail(email);
    return readAll(USERS_KEY).find(u => u.email === norm) || null;
  }

  async function registerUser({ email, password, companyName, firstName, lastName, phone }) {
    const norm = normalizeEmail(email);
    if (!isValidEmail(norm)) throw new Error('Please enter a valid email address.');
    if (!companyName || !firstName || !lastName) throw new Error('Please fill in all required fields.');
    if (!isValidPhone(phone)) throw new Error('Please enter a valid 10-digit phone number.');

    const users = readAll(USERS_KEY);
    // DEMO_MODE limitation worth knowing: this duplicate check only sees
    // accounts already registered in THIS browser. If the same partner
    // already registered on a different device/browser, this will NOT
    // catch it — they'll silently get a second, separate local account
    // with no warning. That's another symptom of the same root cause
    // (no shared backend), not a separate bug.
    if (users.some(u => u.email === norm)) {
      throw new Error('An account with this email already exists on this device/browser. Please sign in instead.');
    }

    const referralSource = createReferralSourceForCompany(companyName);

    // NOTE: password is stored as plain text only because this is a
    // client-only prototype with no server. A real backend must hash
    // and salt passwords server-side before persisting them — never
    // store or compare plain-text passwords once a backend exists.
    const user = {
      id: makeId('u'),
      email: norm,
      password,
      companyName: String(companyName).trim(),
      firstName: String(firstName).trim(),
      lastName: String(lastName).trim(),
      phone: String(phone).trim(),
      referralSourceId: referralSource.id,
      createdAt: new Date().toISOString()
    };
    users.push(user);
    writeAll(USERS_KEY, users);
    return user;
  }

  // As of 2026-07-09, login.html no longer calls this function — real
  // login goes through PartnerAPI.loginPartner(), which hits the real
  // mbh-dashboard-api backend and is correct across devices. This
  // function is kept only as a fallback/reference and is NOT wired into
  // any page's login form anymore. Do not re-wire a login form to call
  // this directly — that would silently reintroduce the cross-device bug.
  async function login(email, password) {
    const user = await findUserByEmail(email);
    // DEMO_MODE distinction (see file header): "no user found" almost
    // always means "this account was registered on a different browser
    // or device" rather than a typo, since accounts never leave the
    // browser they were created in. Say that plainly instead of a
    // generic "invalid password" that sends people down the wrong
    // troubleshooting path.
    if (!user) {
      throw new Error(
        DEMO_MODE
          ? 'Account not found on this device/browser. This portal currently stores accounts locally per-browser (demo mode) — if you registered on a different computer or browser, that account will not be found here. A shared production backend is required to fix this permanently; contact MedBetterHealth if you need access restored now.'
          : 'Incorrect email or password.'
      );
    }
    if (user.password !== password) {
      throw new Error('Incorrect password. Please try again.');
    }
    const session = {
      userId: user.id,
      email: user.email,
      companyName: user.companyName,
      firstName: user.firstName,
      lastName: user.lastName,
      referralSourceId: user.referralSourceId,
      loggedInAt: new Date().toISOString()
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    return session;
  }

  function getSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  // Writes a session object directly (same shape/key as login() used to
  // produce). PartnerAPI.loginPartner()/tryImmediateActivation() call
  // this after a REAL mbh-dashboard-api login/activation succeeds, so
  // every page that already reads DataStore.getSession()/requireAuth()
  // (portal.html, dashboard.html) keeps working with zero changes,
  // regardless of which backend actually authenticated the partner.
  function setSession(session) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    return session;
  }

  function logout() {
    localStorage.removeItem(SESSION_KEY);
  }

  // Call at the top of any page that requires a logged-in partner.
  // Redirects to login.html (preserving where the user was headed) if
  // there is no active session, and returns null so callers can bail out.
  function requireAuth(loginPage = 'login.html') {
    const session = getSession();
    if (!session) {
      const next = encodeURIComponent(window.location.pathname.split('/').pop() || '');
      window.location.href = `${loginPage}${next ? `?next=${next}` : ''}`;
      return null;
    }
    return session;
  }

  // ---- main dashboard access record (mirrors the real backend's -------
  // invitation state locally, purely so THIS portal can show the
  // partner/admin a status like "activation email sent" without calling
  // the real API just to check). This is NOT the source of truth for
  // login — mbh-dashboard-api is. See partner-api.js's
  // createPartnerDashboardAccess() for the real call this mirrors.
  //   { accessId, partnerId, email, referralSourceName,
  //     status: 'pending' | 'sent' | 'failed',
  //     token, invitationLink, requestedAt, messageId, error, lastLoginAt }
  function setDashboardAccessStatus(email, patch) {
    const norm = normalizeEmail(email);
    const all = readAll(ACCESS_KEY);
    const user = readAll(USERS_KEY).find(u => u.email === norm);
    let rec = all.find(a => a.email === norm);
    if (!rec) {
      rec = {
        accessId: makeId('acc'),
        partnerId: user ? user.id : null,
        email: norm,
        referralSourceName: user ? user.companyName : null,
        status: 'pending',
        createdAt: new Date().toISOString(),
        lastLoginAt: null
      };
      all.push(rec);
    }
    Object.assign(rec, patch);
    writeAll(ACCESS_KEY, all);
    return rec;
  }

  function getDashboardAccessStatus(email) {
    const norm = normalizeEmail(email);
    return readAll(ACCESS_KEY).find(a => a.email === norm) || null;
  }

  // ---- password reset (placeholder only) ----------------------------
  // Intentionally does NOT implement real recovery logic. This is a stub
  // so the UI/flow is in place; wire it up to a real email service (e.g.
  // SendGrid, SES, Postmark) from a real backend when one exists. It
  // never reveals whether an email is registered.
  async function requestPasswordReset(email) {
    if (!isValidEmail(email)) throw new Error('Please enter a valid email address.');
    // TODO(backend): POST { email } to /api/auth/forgot-password, which
    // should generate a signed, expiring token and email a reset link.
    return { requested: true };
  }

  return {
    isValidEmail,
    isValidPhone,
    registerUser,
    login,
    logout,
    getSession,
    setSession,
    requireAuth,
    findUserByEmail,
    createReferralSourceForCompany,
    getReferralSource,
    getReferralSourceByName,
    setDashboardAccessStatus,
    getDashboardAccessStatus,
    requestPasswordReset,
    REFERRAL_STATUSES,
    STATUS_LABELS,
    emptyStats,
    simulateReferral
  };
})();
