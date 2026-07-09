/*
 * partner-api.js
 * ------------------------------------------------------------------
 * Integration seam between the GUIDE Partnership Portal and the REAL
 * MedBetterHealth Partner Dashboard system (mbh-dashboard-api).
 *
 * As of 2026-07-09 this is wired to the REAL backend for dashboard
 * access — not a demo stub. Registering here calls the exact same
 * `/api/send-invitation` endpoint the admin's "Manage Referral Source
 * Access" button calls (see main-dashboard/dashboard.js), so a
 * partner's dashboard access is created automatically at registration
 * instead of requiring an admin to type their email in manually. Local
 * portal login (DataStore.registerUser) is unrelated — it only signs a
 * partner into THIS GUIDE portal, not the main dashboard.
 *
 * IMPORTANT — the partner still gets exactly ONE email to click after
 * registering, same as the manual flow. That step (setting a password
 * on partner.html and creating the authenticated session) happens
 * entirely on the main dashboard's backend, which we don't own the
 * source of. There's no safe way to skip it without that backend
 * accepting a pre-chosen password from an unauthenticated caller,
 * which would be a security hole — see the "What still needs backend
 * work" note in dashboard.js. What's automated here is the ADMIN's
 * manual step (typing the email into "Manage Referral Source Access"),
 * not the partner's one-click activation email.
 *
 * CORS REQUIREMENT: the mbh-dashboard-api Function App's CORS settings
 * must allow THIS GitHub Pages origin (not just
 * https://mbhdashboard.z13.web.core.windows.net, which is already
 * allowed for the admin dashboard). If registration reports "dashboard
 * access could not be created automatically", check that first — Azure
 * Portal → mbh-dashboard-api Function App → CORS → Allowed Origins.
 * Until that's added, createPartnerDashboardAccess() will fail with a
 * network/CORS error, get recorded as status:'failed' via
 * DataStore.setDashboardAccessStatus(), and the admin can always fall
 * back to the existing manual invite for that partner — registration
 * itself never fails because of this.
 * ------------------------------------------------------------------
 */
const PartnerAPI = (() => {
  // Real endpoint behind the admin's "Manage Referral Source Access →
  // Send Invitation" button. Calling it here from registration is the
  // automation that replaces the admin doing it by hand.
  const SEND_INVITATION_API_URL = 'https://mbh-dashboard-api-eebbhjdxfrgxdfex.eastus2-01.azurewebsites.net/api/send-invitation';
  // The REAL dashboard's partner-facing login/accept page — a different
  // page than the admin's dashboard.html, living on the main dashboard's
  // own Azure origin.
  const PARTNER_DASHBOARD_ORIGIN = 'https://mbhdashboard.z13.web.core.windows.net';

  // ---- token generation — byte-for-byte identical to the admin --------
  // dashboard's generateInvitationToken()/_b64UrlEncode()/_makeNonce()
  // (main-dashboard/dashboard.js) so a token minted here decodes
  // correctly on partner.html, which shares that exact decode logic.
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
      const isAbort = e.name === 'AbortError';
      throw new Error(
        isAbort
          ? 'Dashboard access request timed out.'
          : 'Could not reach the dashboard access service (' + (e.message || e) + '). This is often a CORS setting on mbh-dashboard-api that needs this site\'s origin added.'
      );
    }
    clearTimeout(timer);
    let parsed = null;
    try { parsed = await res.json(); } catch (_) {}
    if (!res.ok || !(parsed && parsed.ok)) {
      throw new Error((parsed && parsed.error) || ('HTTP ' + res.status));
    }
    return parsed;
  }

  // ---- 1. Partner registration: local GUIDE-portal profile ------------
  // Unrelated to the main dashboard's own login — this is only what lets
  // a partner sign into THIS portal (portal.html/login.html).
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
      const result = await postJson(SEND_INVITATION_API_URL, {
        orgName: referralSourceName,
        contactName,
        contactEmail: email,
        invitationLink
      }, 20000);
      DataStore.setDashboardAccessStatus(email, {
        status: 'sent',
        token,
        invitationLink,
        referralSourceName,
        requestedAt: new Date().toISOString(),
        messageId: result.messageId || null,
        error: null
      });
      return { sent: true, invitationLink };
    } catch (e) {
      // Registration must NOT fail just because the auto-invite email
      // failed (CORS not yet allowlisted, backend briefly asleep, etc).
      // Record it so the portal can show a clear message, and the admin
      // can always fall back to the existing manual "Manage Referral
      // Source Access" flow for this partner.
      DataStore.setDashboardAccessStatus(email, {
        status: 'failed',
        token,
        invitationLink,
        referralSourceName,
        requestedAt: new Date().toISOString(),
        error: e.message || String(e)
      });
      return { sent: false, error: e.message || String(e), invitationLink };
    }
  }

  // ---- 4. Full registration: profile + referral source + dashboard ----
  // access, in that order. Same name/shape as before so index.html's
  // call site doesn't need to change.
  async function createPartnerAccount({ email, password, companyName, firstName, lastName, phone }) {
    const user = await createPartnerProfile({ email, password, companyName, firstName, lastName, phone });
    await createReferralSource(companyName);
    const contactName = `${firstName} ${lastName}`.trim();
    const access = await createPartnerDashboardAccess({ email, referralSourceName: companyName, contactName });
    return { ...user, dashboardAccess: access };
  }

  // ---- 5. Look up a partner's local access record by email ------------
  function getPartnerAccessByEmail(email) {
    return DataStore.getDashboardAccessStatus(email);
  }

  // ---- 6/7. Aggregate stats + referral rows, scoped to one company. ---
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

  // ---- 8. Dashboard lookup for whoever is currently logged in ----------
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
    getPartnerAccessByEmail,
    getPartnerDashboardData,
    getPartnerDashboardByLoggedInUser,
    getReferralsByReferralSource,
    getPartnerReferrals,
    partnerInvitationLink
  };
})();
