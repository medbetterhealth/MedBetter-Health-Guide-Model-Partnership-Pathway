/*
 * partner-api.js
 * ------------------------------------------------------------------
 * Integration seam between the GUIDE Partnership Portal and the REAL
 * MedBetterHealth Partner Dashboard system (mbh-dashboard-api).
 *
 * As of 2026-07-09 this is the REAL cross-device authentication for
 * the portal — not a demo stub. Root cause fixed here: registration
 * and login used to go through DataStore's localStorage only, so an
 * account created on one browser/device was invisible everywhere else
 * ("works on my system, invalid on another"). Login/registration now
 * go through mbh-dashboard-api, the SAME backend that already powers
 * the main dashboard's partner.html — one real account, works on any
 * device from the moment it's activated. DataStore.registerUser() is
 * still called for local bookkeeping (referral-source stats for this
 * portal's own zero-state dashboard.html) but is NOT the source of
 * truth for login anymore — see loginPartner() below.
 *
 * REGISTRATION FLOW:
 *   1. createPartnerProfile()   — local bookkeeping only (data-store.js)
 *   2. createReferralSource()  — local "Referred By" record
 *   3. createPartnerDashboardAccess() — calls the REAL /send-invitation
 *      endpoint (same one the admin's "Manage Referral Source Access"
 *      button calls), which creates real backend access + emails a link.
 *   4. tryImmediateActivation() — BEST EFFORT: immediately calls the
 *      real /accept-invitation endpoint with the password the partner
 *      just chose, using the same token from step 3. If the backend
 *      allows it, the partner is instantly, really, cross-device
 *      logged in with zero waiting. If it doesn't work for any reason
 *      (network hiccup, backend requires the literal email click,
 *      etc.), that's fine — the invitation email from step 3 is the
 *      guaranteed fallback path, so registration never fails or blocks
 *      on this being unavailable.
 *
 * LOGIN FLOW: loginPartner() calls the REAL /partner-login endpoint —
 * the same one partner.html itself calls — so any device that knows
 * the email/password gets in, matching what you'd expect from a real
 * account system.
 *
 * CORS REQUIREMENT (read this if anything here reports a network
 * error): the mbh-dashboard-api Function App's CORS settings must
 * allow THIS GitHub Pages origin, not just
 * https://mbhdashboard.z13.web.core.windows.net (which is already
 * allowed for the admin/partner dashboard pages). Azure Portal →
 * mbh-dashboard-api Function App → CORS → Allowed Origins → add this
 * site's URL. Every real call in this file (send-invitation,
 * accept-invitation, partner-login) is blocked until that's done —
 * this is a one-time Azure config change, not a code change.
 * ------------------------------------------------------------------
 */
const PartnerAPI = (() => {
  const _API = 'https://mbh-dashboard-api-eebbhjdxfrgxdfex.eastus2-01.azurewebsites.net/api';
  const SEND_INVITATION_API_URL   = _API + '/send-invitation';
  const ACCEPT_INVITATION_API_URL = _API + '/accept-invitation';
  const PARTNER_LOGIN_API_URL     = _API + '/partner-login';
  const PARTNER_DATA_API_URL      = _API + '/partner-referrals';

  // The REAL dashboard's partner-facing login/accept page — a different
  // page than the admin's dashboard.html, living on the main dashboard's
  // own Azure origin. Only used to build the link that goes in the
  // invitation email; this file talks to the API directly, not this page.
  const PARTNER_DASHBOARD_ORIGIN = 'https://mbhdashboard.z13.web.core.windows.net';

  // ---- token generation — byte-for-byte identical to the admin --------
  // dashboard's generateInvitationToken()/_b64UrlEncode()/_makeNonce()
  // (main-dashboard/dashboard.js) so a token minted here decodes
  // correctly on partner.html / the real backend, which share that
  // exact encode/decode logic.
  function _b64UrlEncode(s) {
    return btoa(unescape(encodeURIComponent(s)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function _makeNonce() {
    const a = new Uint8Array(12);
    crypto.getRandomValues(a);
    return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
  }
  function generateInvitationToken(orgName, email, contactName, expiresInDays) {
    const payload = {
      org: orgName,
      email: email,
      contact: contactName,
      iat: Date.now(),
      exp: Date.now() + (expiresInDays || 30) * 24 * 60 * 60 * 1000,
      nonce: _makeNonce()
    };
    return 'v1.' + _b64UrlEncode(JSON.stringify(payload));
  }
  function partnerInvitationLink(token) {
    return `${PARTNER_DASHBOARD_ORIGIN}/partner.html?invite=${token}`;
  }

  function _networkError(context, e) {
    const isAbort = e && e.name === 'AbortError';
    return new Error(
      (isAbort ? context + ' timed out.' : 'Could not reach ' + context + ' (' + (e.message || e) + ').') +
      ' If this keeps happening, check that this site\'s origin is allowed in mbh-dashboard-api\'s CORS settings.'
    );
  }

  async function postJson(url, body, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 20000);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
    } catch (e) {
      clearTimeout(timer);
      throw _networkError('the account service', e);
    }
    clearTimeout(timer);
    let parsed = null;
    try { parsed = await res.json(); } catch (_) {}
    return { res, parsed };
  }

  // ---- 1. Partner registration: local GUIDE-portal bookkeeping --------
  // NOT the source of truth for login (see file header) — kept only so
  // this portal's own zero-state dashboard.html has something to key
  // referral-source stats off of locally.
  async function createPartnerProfile({ email, password, companyName, firstName, lastName, phone }) {
    return DataStore.registerUser({ email, password, companyName, firstName, lastName, phone });
  }

  // ---- 2. Referral Source: "Referred By" record for a company ---------
  async function createReferralSource(companyName) {
    return DataStore.createReferralSourceForCompany(companyName);
  }

  // ---- 3. Dashboard access: the real automation ------------------------
  // Calls the exact same backend endpoint the admin's "Manage Referral
  // Source Access → Send Invitation" button calls. On success the
  // partner receives a real invitation email from the main dashboard
  // system, identical to what an admin sending it by hand would trigger.
  async function createPartnerDashboardAccess({ email, referralSourceName, contactName }) {
    const token = generateInvitationToken(referralSourceName, email, contactName, 30);
    const invitationLink = partnerInvitationLink(token);
    try {
      const { res, parsed } = await postJson(SEND_INVITATION_API_URL, {
        orgName: referralSourceName,
        contactName,
        contactEmail: email,
        invitationLink
      }, 20000);
      if (!res.ok || !(parsed && parsed.ok)) {
        throw new Error((parsed && parsed.error) || ('HTTP ' + res.status));
      }
      DataStore.setDashboardAccessStatus(email, {
        status: 'sent', token, invitationLink, referralSourceName,
        requestedAt: new Date().toISOString(),
        messageId: parsed.messageId || null, error: null
      });
      return { sent: true, invitationLink, token };
    } catch (e) {
      // Registration must NOT fail just because the auto-invite email
      // failed (CORS not yet allowlisted, backend briefly asleep, etc).
      // Record it so the portal can show a clear message, and the admin
      // can always fall back to the existing manual "Manage Referral
      // Source Access" flow for this partner.
      DataStore.setDashboardAccessStatus(email, {
        status: 'failed', token, invitationLink, referralSourceName,
        requestedAt: new Date().toISOString(), error: e.message || String(e)
      });
      return { sent: false, error: e.message || String(e), invitationLink, token };
    }
  }

  // ---- 3b. Best-effort instant activation ------------------------------
  // Tries to complete the real backend's account-creation step (normally
  // triggered by the partner clicking the invitation email and typing a
  // password on partner.html) immediately, using the password they just
  // chose during registration. Returns the real session on success, or
  // null if it didn't work for any reason — callers must treat null as
  // "fall back to the email-activation flow", not an error.
  async function tryImmediateActivation(token, password) {
    if (!token || !password || password.length < 6) return null;
    let res, parsed;
    try {
      ({ res, parsed } = await postJson(ACCEPT_INVITATION_API_URL, { invitationToken: token, password }, 20000));
    } catch (e) {
      console.warn('[partner-api] Instant activation unreachable, falling back to email flow:', e.message);
      return null;
    }
    if (!res.ok || !parsed) return null;
    if (parsed.alreadyActive) return null; // existing account -- let them sign in normally instead
    if (!parsed.sessionToken) return null;
    const session = {
      userId: null,
      email: parsed.email,
      companyName: parsed.orgName,
      firstName: '', lastName: '',
      referralSourceId: null,
      referralSource: parsed.referralSource || parsed.orgName,
      sessionToken: parsed.sessionToken,
      loggedInAt: new Date().toISOString()
    };
    DataStore.setSession(session);
    return session;
  }

  // ---- 4. Full registration: profile + referral source + dashboard ----
  // access + best-effort instant activation, in that order. Same
  // name/shape as before so index.html's call site barely changes.
  async function createPartnerAccount({ email, password, companyName, firstName, lastName, phone }) {
    const user = await createPartnerProfile({ email, password, companyName, firstName, lastName, phone });
    await createReferralSource(companyName);
    const contactName = `${firstName} ${lastName}`.trim();
    const access = await createPartnerDashboardAccess({ email, referralSourceName: companyName, contactName });

    let activatedSession = null;
    if (access.sent && access.token) {
      activatedSession = await tryImmediateActivation(access.token, password);
    }
    return { ...user, dashboardAccess: access, activatedSession };
  }

  // ---- 5. Login: the real fix for "works on one device, not another" -
  // Calls the exact same /partner-login endpoint partner.html uses.
  // Any device that knows the correct email/password gets a real
  // session — no localStorage lookup, no per-browser account.
  async function loginPartner(email, password) {
    let res, parsed;
    try {
      ({ res, parsed } = await postJson(PARTNER_LOGIN_API_URL, { email, password }, 20000));
    } catch (e) {
      throw _networkError('the account service', e);
    }
    parsed = parsed || {};
    if (res.status === 403 && parsed.code === 'revoked') {
      throw new Error(parsed.error || 'Your access has been revoked. Please contact MedBetterHealth.');
    }
    if (res.status === 404 || parsed.code === 'not_found') {
      throw new Error('No account found for this email. If you just registered, check your email for the activation link first. If you registered a while ago on a different device, make sure you completed activation there.');
    }
    if (!res.ok || !parsed.ok) {
      throw new Error(parsed.error || 'Incorrect email or password.');
    }
    const session = {
      userId: null,
      email: parsed.email,
      companyName: parsed.orgName,
      firstName: '', lastName: '',
      referralSourceId: null,
      referralSource: parsed.referralSource || parsed.orgName,
      sessionToken: parsed.sessionToken,
      loggedInAt: new Date().toISOString()
    };
    DataStore.setSession(session);
    // Keep the local demo dashboard's referral-source record in sync too,
    // purely cosmetic for dashboard.html (root) — the real data view is
    // partner.html.
    DataStore.createReferralSourceForCompany(session.companyName);
    return session;
  }

  // ---- 6. Who's logged in right now, and is that session still good ---
  function getLoggedInPartner() {
    return DataStore.getSession();
  }
  async function verifySession() {
    const session = DataStore.getSession();
    if (!session || !session.sessionToken) return null;
    try {
      const { res, parsed } = await postJson(PARTNER_DATA_API_URL, {
        sessionToken: session.sessionToken,
        email: session.email
      }, 15000);
      if (res.status === 403 && parsed && parsed.code === 'revoked') {
        DataStore.logout();
        return null;
      }
      if (!res.ok || !(parsed && parsed.ok)) return null;
      return session;
    } catch (e) {
      // Fail open on a transient network error -- don't sign someone out
      // just because one background check timed out.
      console.warn('[partner-api] verifySession network error, keeping existing session:', e.message);
      return session;
    }
  }

  // ---- 7. Look up a partner's local access record by email ------------
  function getPartnerAccessByEmail(email) {
    return DataStore.getDashboardAccessStatus(email);
  }

  // ---- 8/9. Aggregate stats + referral rows, scoped to one company. ---
  // SECURITY NOTE: always pass the referralSource that came from
  // DataStore.getSession() (the logged-in partner's own company) — never
  // a value taken from a URL parameter or other user-editable input.
  // This local copy only feeds THIS portal's own zero-state dashboard.html
  // (root of the repo) — the REAL partner data view, with real
  // server-side enforcement, is the main dashboard's partner.html,
  // reached via "Open Referral Dashboard".
  async function getPartnerDashboardData(referralSource) {
    const source = DataStore.getReferralSourceByName(referralSource);
    return (source && source.stats) || DataStore.emptyStats();
  }
  async function getReferralsByReferralSource(referralSource) {
    const source = DataStore.getReferralSourceByName(referralSource);
    return (source && source.referrals) || [];
  }
  // Back-compat alias for the original name used elsewhere in this project.
  const getPartnerReferrals = getReferralsByReferralSource;

  // ---- 10. Dashboard lookup for whoever is currently logged in ---------
  async function getPartnerDashboardByLoggedInUser() {
    const session = DataStore.getSession();
    if (!session) throw new Error('Not logged in.');
    return getPartnerDashboardData(session.companyName);
  }

  return {
    createPartnerProfile,
    createReferralSource,
    createPartnerDashboardAccess,
    createPartnerAccount,
    loginPartner,
    getLoggedInPartner,
    verifySession,
    getPartnerAccessByEmail,
    getPartnerDashboardData,
    getPartnerDashboardByLoggedInUser,
    getReferralsByReferralSource,
    getPartnerReferrals,
    partnerInvitationLink
  };
})();
