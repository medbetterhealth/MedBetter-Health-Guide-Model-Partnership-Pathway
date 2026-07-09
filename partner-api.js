/*
 * partner-api.js
 * ------------------------------------------------------------------
 * Partner authentication via Supabase Auth — replaces the earlier
 * custom Azure Functions + Table Storage + SendGrid approach entirely.
 * Supabase handles password hashing, sessions, cross-device login, and
 * password-reset emails out of the box — no SendGrid account needed.
 *
 * Only ONE Azure Function is still used from here: save-partner-profile
 * (mbh-referral-endpoints), which writes profile details — never the
 * password — to the "Partners" Excel worksheet via the same Graph API
 * pattern Pending Referrals already uses. That one stays server-side
 * because the Graph API credentials are secrets; they can't be called
 * directly from the browser the way Supabase's public anon key can be.
 *
 * Requires supabase-client.js (creates `supabaseClient`) loaded first,
 * which itself requires the Supabase JS SDK CDN script loaded before it:
 *   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
 *   <script src="supabase-client.js"></script>
 *   <script src="data-store.js"></script>
 *   <script src="partner-api.js"></script>
 *
 * SUPABASE PROJECT SETTINGS THIS RELIES ON (see setup notes given to
 * the user separately):
 *   - Authentication -> Providers -> Email -> "Confirm email" turned OFF,
 *     so signUp() returns a usable session immediately (no waiting on an
 *     email click before a partner can sign in).
 *   - Authentication -> URL Configuration -> Redirect URLs includes this
 *     site's reset-password.html URL, or resetPasswordForEmail()'s
 *     redirect will be rejected.
 * ------------------------------------------------------------------
 */
const PartnerAPI = (() => {
  const SAVE_PROFILE_URL = 'https://mbh-referral-endpoints-a9gtfycygpa8fgbs.centralus-01.azurewebsites.net/api/save-partner-profile';

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
      throw new Error('Could not save your profile details right now (' + (e.message || e) + ').');
    }
    clearTimeout(timer);
    let parsed = null;
    try { parsed = await res.json(); } catch (_) {}
    return { res, parsed: parsed || {} };
  }

  function _storeSession(session, user, companyNameHint) {
    const meta = (user && user.user_metadata) || {};
    const companyName = companyNameHint || meta.companyName || '';
    DataStore.setSession({
      userId: user ? user.id : null,
      email: user ? user.email : '',
      companyName,
      firstName: meta.firstName || '',
      lastName: meta.lastName || '',
      referralSourceId: null,
      referralSource: companyName,
      partnerId: user ? user.id : null,
      sessionToken: session ? session.access_token : null,
      loggedInAt: new Date().toISOString()
    });
  }

  // ---- 1. Register: Supabase Auth user + Excel profile row -----------
  // companyName/firstName/lastName/phone are also stashed in Supabase's
  // user_metadata at signup time, so they come back for free on every
  // future login without a second network call.
  async function createPartnerAccount({ email, password, companyName, firstName, lastName, phone }) {
    const { data, error } = await supabaseClient.auth.signUp({
      email, password,
      options: { data: { companyName, firstName, lastName, phone } }
    });
    if (error) throw new Error(error.message || 'Registration failed.');

    const partnerId = data.user && data.user.id;

    try {
      const { res, parsed } = await postJson(SAVE_PROFILE_URL, { partnerId, companyName, firstName, lastName, email, phone });
      if (!res.ok || !parsed.ok) {
        console.warn('[partner-api] Excel profile save failed:', parsed.error || res.status);
      }
    } catch (e) {
      // The Supabase account is already real and usable — don't fail
      // registration just because the Excel write hiccuped. Log it so it
      // can be manually backfilled into the Partners sheet if needed.
      console.warn('[partner-api] Excel profile save failed:', e.message);
    }

    DataStore.createReferralSourceForCompany(companyName);

    // If "Confirm email" is off in Supabase, a session comes back
    // immediately and the partner is already logged in.
    if (data.session) _storeSession(data.session, data.user, companyName);

    return { ok: true, partnerId, email, companyName, signedIn: !!data.session };
  }

  // ---- 2. Login: real, cross-device (Supabase Auth) -------------------
  async function loginPartner(email, password) {
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message || 'Incorrect email or password.');
    const meta = (data.user && data.user.user_metadata) || {};
    _storeSession(data.session, data.user, meta.companyName);
    DataStore.createReferralSourceForCompany(meta.companyName);
    return DataStore.getSession();
  }

  // ---- 3. Forgot password: real Supabase reset email -------------------
  async function sendPasswordResetEmail(email) {
    const redirectTo = window.location.origin + '/reset-password.html';
    const { error } = await supabaseClient.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) throw new Error(error.message || 'Could not send the reset email.');
    return { ok: true };
  }

  // ---- 4. Complete the reset -- call from reset-password.html AFTER the
  // partner arrives via the emailed link. Supabase's SDK auto-detects the
  // recovery session from the URL on page load, so no manual token is
  // needed here, unlike the earlier custom-token approach.
  async function resetPassword(newPassword) {
    const { error } = await supabaseClient.auth.updateUser({ password: newPassword });
    if (error) throw new Error(error.message || 'Could not reset your password. The link may have expired — request a new one.');
    return { ok: true };
  }

  // ---- 5. Who's logged in right now (local session mirror) ------------
  function getLoggedInPartner() {
    return DataStore.getSession();
  }

  // ---- 6/7. Local zero-state dashboard data (dashboard.html at the ----
  // repo root only — NOT the real MedBetterHealth referral dashboard,
  // and unrelated to the Supabase account system above.
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

  return {
    createPartnerAccount,
    loginPartner,
    sendPasswordResetEmail,
    resetPassword,
    getLoggedInPartner,
    getPartnerDashboardData,
    getReferralsByReferralSource,
    getPartnerReferrals,
    getPartnerDashboardByLoggedInUser
  };
})();
