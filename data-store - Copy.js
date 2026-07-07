/*
 * data-store.js
 * ------------------------------------------------------------------
 * Client-side persistence layer for the GUIDE Partnership Portal.
 *
 * Everything in this file reads/writes to the browser's localStorage.
 * That is intentional for now — there is no backend yet. Every function
 * is written as an async function returning data/throwing errors the
 * same way a real fetch() call to a server would, so the ONLY thing
 * that needs to change when a real backend/database exists is the
 * inside of these functions — every page that calls DataStore.* does
 * not need to change at all.
 *
 * Data model:
 *   users:            { id, email, password, companyName, firstName,
 *                        lastName, phone, referralSourceId, createdAt }
 *   referralSources:  { id, name, createdAt, stats:{referrals, approved} }
 *   session:          { userId, email, companyName, referralSourceId, loggedInAt }
 * ------------------------------------------------------------------
 */
const DataStore = (() => {
  const USERS_KEY = 'guide_users_v1';
  const SOURCES_KEY = 'guide_referral_sources_v1';
  const SESSION_KEY = 'guide_session_v1';

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
  // Home Care"). This is what the future Referral Dashboard will read from.
  function createReferralSourceForCompany(companyName) {
    const name = String(companyName || '').trim();
    const sources = readAll(SOURCES_KEY);
    const existing = sources.find(s => s.name.toLowerCase() === name.toLowerCase());
    if (existing) return existing;

    const source = {
      id: makeId('rs'),
      name,
      createdAt: new Date().toISOString(),
      stats: { referrals: 0, approved: 0 }
    };
    sources.push(source);
    writeAll(SOURCES_KEY, sources);
    return source;
  }

  function getReferralSource(id) {
    return readAll(SOURCES_KEY).find(s => s.id === id) || null;
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
    if (users.some(u => u.email === norm)) {
      throw new Error('An account with this email already exists. Please sign in instead.');
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

  async function login(email, password) {
    const user = await findUserByEmail(email);
    if (!user || user.password !== password) {
      throw new Error('Incorrect email or password.');
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
    requireAuth,
    findUserByEmail,
    createReferralSourceForCompany,
    getReferralSource,
    requestPasswordReset
  };
})();
