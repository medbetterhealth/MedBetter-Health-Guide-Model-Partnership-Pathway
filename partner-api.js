/*
 * partner-api.js
 * ------------------------------------------------------------------
 * Partner authentication via the custom mbh-referral-endpoints backend
 * (Table Storage for accounts/sessions/reset-tokens, bcrypt password
 * hashing, Excel for profile details only). This is back to the
 * approach that already worked for register/login — the Supabase
 * detour was reverted per explicit request; only the password-reset
 * EMAIL step changed since then, from SendGrid to Microsoft Graph
 * sendMail (shared/email.js), reusing the same Azure AD app already
 * configured for Excel — no new email service to set up.
 *
 * Where things live:
 *   - Passwords, sessions, reset tokens -> Azure Table Storage
 *     (PartnerAccounts / PartnerSessions / PartnerResetTokens), inside
 *     the register-partner/login-partner/etc. Function code. NEVER in
 *     Excel, never in localStorage.
 *   - Profile details (company, name, phone, referral source, status)
 *     -> the "Partners" worksheet in the same Excel workbook Pending
 *     Referrals already uses, written by register-partner via Graph.
 *   - Password reset emails -> Microsoft Graph /sendMail, called from
 *     the request-password-reset Function.
 *
 * CORS REQUIREMENT: mbh-referral-endpoints' CORS settings must allow
 * THIS GitHub Pages origin (Azure Portal -> mbh-referral-endpoints ->
 * CORS -> Allowed Origins).
 * ------------------------------------------------------------------
 */
const PartnerAPI = (() => {
  const _API = 'https://mbh-referral-endpoints-a9gtfycygpa8fgbs.centralus-01.azurewebsites.net/api';
  const REGISTER_URL      = _API + '/register-partner';
  const LOGIN_URL         = _API + '/login-partner';
  const REQUEST_RESET_URL = _API + '/request-password-reset';
  const RESET_URL         = _API + '/reset-password';
  const PROFILE_URL       = _API + '/get-partner-profile';

  function _networkError(context, e) {
    const isAbort = e && e.name === 'AbortError';
    return new Error(
      (isAbort ? context + ' timed out.' : 'Could not reach ' + context + ' (' + (e.message || e) + ').') +
      ' If this keeps happening, check that this site\'s origin is allowed in mbh-referral-endpoints\' CORS settings.'
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
    return { res, parsed: parsed || {} };
  }

  // ---- 1/2. Register: account (Table Storage) + profile (Excel) -------
  // Done together in one backend call (register-partner) so an account
  // can never exist without its Excel profile row, or vice versa. Active
  // immediately — no invitation, no approval step.
  async function createPartnerAccount({ email, password, companyName, firstName, lastName, phone }) {
    const { res, parsed } = await postJson(REGISTER_URL, { email, password, companyName, firstName, lastName, phone });
    if (!res.ok || !parsed.ok) {
      throw new Error(parsed.error || ('Registration failed (HTTP ' + res.status + ').'));
    }
    DataStore.createReferralSourceForCompany(companyName);
    return parsed; // { ok, partnerId, email, companyName }
  }

  // ---- 3. Login: real, cross-device --------------------------------
  async function loginPartner(email, password) {
    const { res, parsed } = await postJson(LOGIN_URL, { email, password });
    if (res.status === 404 || parsed.code === 'not_found') {
      throw new Error('No account found for this email. Check that you registered with this exact email, or create an account first.');
    }
    if (res.status === 403 && parsed.code === 'inactive') {
      throw new Error(parsed.error || 'This account is not active. Please contact MedBetterHealth.');
    }
    if (!res.ok || !parsed.ok) {
      throw new Error(parsed.error || 'Incorrect email or password.');
    }
    const session = {
      userId: null,
      email: parsed.email,
      companyName: parsed.companyName,
      firstName: '', lastName: '',
      referralSourceId: null,
      referralSource: parsed.referralSource || parsed.companyName,
      partnerId: parsed.partnerId,
      sessionToken: parsed.token,
      loggedInAt: new Date().toISOString()
    };
    DataStore.setSession(session);
    DataStore.createReferralSourceForCompany(session.companyName);
    return session;
  }

  // ---- 4. Forgot password: real email via Microsoft Graph -------------
  // Longer timeout than the default -- this call makes two sequential
  // hops (Microsoft login token, then Graph sendMail), which can be slow
  // right after a Function App cold start.
  async function sendPasswordResetEmail(email) {
    const { res, parsed } = await postJson(REQUEST_RESET_URL, { email }, 35000);
    if (!res.ok) {
      throw new Error(parsed.error || 'Could not send the reset email. Please try again.');
    }
    return parsed; // { ok: true, message }
  }

  // ---- 5. Complete the reset with the token from the emailed link -----
  async function resetPassword(token, newPassword) {
    const { res, parsed } = await postJson(RESET_URL, { token, newPassword });
    if (!res.ok || !parsed.ok) {
      throw new Error(parsed.error || 'Could not reset your password. The link may have expired.');
    }
    return parsed;
  }

  // ---- 6. Profile lookup (Table Storage, fast; not the Excel sheet) ---
  async function getPartnerProfileByEmail(email) {
    let res, parsed;
    try {
      res = await fetch(PROFILE_URL + '?email=' + encodeURIComponent(email));
      parsed = await res.json().catch(() => ({}));
    } catch (e) {
      throw _networkError('the account service', e);
    }
    if (!res.ok || !parsed.ok) return null;
    return parsed;
  }

  // ---- 7. Who's logged in right now ------------------------------------
  function getLoggedInPartner() {
    return DataStore.getSession();
  }

  // ---- 8/9. Local zero-state dashboard data (dashboard.html at the ----
  // repo root only — NOT the real MedBetterHealth referral dashboard.
  async function getPartnerDashboardData(referralSource) {
    const source = DataStore.getReferralSourceByName(referralSource);
    return (source && source.stats) || DataStore.emptyStats();
  }
  async function getReferralsByReferralSource(referralSource) {
    const source = DataStore.getReferralSourceByName(referralSource);
    return (source && source.referrals) || [];
  }
  const getPartnerReferrals = getReferralsByReferralSource;
  async function getPartnerDashboardByLoggedInUser() {
    const session = DataStore.getSession();
    if (!session) throw new Error('Not logged in.');
    return getPartnerDashboardData(session.companyName);
  }

  // ---- 10. SSO handoff to the real MBH dashboard ----------------------
  // Backed by mbh-referral-endpoints' /create-dashboard-handoff,
  // /send-verification-email and /verify-email.
  //
  // Security notes (why these calls are shaped this way):
  //  - Every call sends the CURRENT PORTAL SESSION TOKEN in the
  //    Authorization header, never the email/password -- the backend
  //    re-derives the email server-side from that session.
  //  - createDashboardHandoff() returns a short-lived (~90s), single-use,
  //    opaque code -- NOT the partner's email, NOT a reusable token. The
  //    caller must navigate to the dashboard with ONLY ?handoff=<code>.
  //  - The dashboard authorizes against its OWN existing Active partner
  //    account for that email; nothing from Portal registration is used.
  //  - The backend refuses a handoff (403 email_not_verified) until the
  //    partner has proven they own their email: a 6-digit code emailed by
  //    sendVerificationEmail() and entered via verifyEmailCode() in this
  //    same signed-in session (or completing an emailed password reset).
  async function _authedPost(path, body, timeoutMs, context) {
    const session = DataStore.getSession();
    if (!session || !session.sessionToken) throw new Error('Not logged in.');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 20000);
    let res;
    try {
      res = await fetch(_API + path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + session.sessionToken
        },
        body: JSON.stringify(body || {}),
        signal: ctrl.signal
      });
    } catch (e) {
      clearTimeout(timer);
      throw _networkError(context, e);
    }
    clearTimeout(timer);
    let parsed = {};
    try { parsed = await res.json(); } catch (_) {}
    if (res.status === 401 && parsed.code === 'not_signed_in') {
      const e = new Error(parsed.error || 'Your session has expired. Please sign in again.');
      e.code = 'not_signed_in';
      throw e;
    }
    return { res, parsed };
  }

  async function sendVerificationEmail() {
    const { res, parsed } = await _authedPost('/send-verification-email', {}, 35000, 'the verification service');
    if (!res.ok || !parsed.ok) {
      throw new Error(parsed.error || 'Could not send the verification email. Please try again.');
    }
    return parsed; // { ok: true, message } or { ok: true, alreadyVerified: true }
  }

  async function verifyEmailCode(code) {
    const { res, parsed } = await _authedPost('/verify-email', { code }, 20000, 'the verification service');
    if (!res.ok || !parsed.ok) {
      throw new Error(parsed.error || 'That code is incorrect or has expired.');
    }
    return parsed;
  }

  async function createDashboardHandoff() {
    const { res, parsed } = await _authedPost('/create-dashboard-handoff', {}, 20000, 'the dashboard handoff service');
    if (res.status === 403 && parsed.code === 'email_not_verified') {
      const e = new Error(parsed.error || 'Please verify your email before opening the dashboard.');
      e.code = 'email_not_verified';
      throw e;
    }
    if (!res.ok || !parsed.ok || !parsed.code) {
      throw new Error(parsed.error || 'Could not prepare dashboard sign-in. Please try again.');
    }
    return parsed.code; // opaque, single-use, ~90s TTL -- never the email
  }

  return {
    createPartnerAccount,
    loginPartner,
    sendPasswordResetEmail,
    resetPassword,
    getPartnerProfileByEmail,
    getLoggedInPartner,
    getPartnerDashboardData,
    getReferralsByReferralSource,
    getPartnerReferrals,
    getPartnerDashboardByLoggedInUser,
    sendVerificationEmail,
    verifyEmailCode,
    createDashboardHandoff
  };
})();
