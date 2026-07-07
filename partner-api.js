/*
 * partner-api.js
 * ------------------------------------------------------------------
 * Integration seam between the GUIDE Partnership Portal and the main
 * Partner Dashboard system (the one that already sends invitation links
 * and shows partners their own referrals/statuses).
 *
 * Every function below is named to match a real backend operation:
 *   - createPartnerAccount(profile)         partner registers -> account +
 *                                            referral source + dashboard
 *                                            profile all get created
 *   - createReferralSource(companyName)     "Referred By" record for a company
 *   - getPartnerDashboardData(referralSource)  aggregate stats for one partner
 *   - getPartnerReferrals(referralSource)      that partner's own referral rows
 *
 * TO CONNECT THE REAL BACKEND:
 *   1. Set USE_REMOTE = true below.
 *   2. Set BACKEND_BASE_URL to the main dashboard's API base URL.
 *   3. Each function's `if (USE_REMOTE)` branch already has the intended
 *      fetch() call shaped out — fill in the real endpoint paths/auth
 *      headers the main dashboard's API expects and remove the fallback.
 * Nothing in index.html or dashboard.html needs to change when you do this
 * — they only ever call PartnerAPI.*, never DataStore.* directly.
 *
 * UNTIL THEN: every function below runs against DataStore's localStorage
 * engine (see data-store.js) purely as a demo fallback. Do not treat that
 * as production storage — see data-store.js's header for why.
 *
 * `referralSource` parameters below are always the plain company name
 * string (e.g. "ABC Home Care"), because that is the literal "Referred By"
 * value the main dashboard filters on — not an internal id.
 * ------------------------------------------------------------------
 */
const PartnerAPI = (() => {
  const USE_REMOTE = false;
  const BACKEND_BASE_URL = ''; // e.g. 'https://api.medbetterhealth.org/partners'

  function authHeaders() {
    // TODO(backend): attach whatever the main dashboard's API needs to
    // identify the caller (e.g. a session cookie is sent automatically,
    // or add 'Authorization': `Bearer ${token}` here).
    return { 'Content-Type': 'application/json' };
  }

  // ---- 1. Registration: save account info, save company name, ----------
  // ---- auto-create the Referral Source, provision the dashboard profile.
  async function createPartnerAccount({ email, password, companyName, firstName, lastName, phone }) {
    if (USE_REMOTE) {
      const res = await fetch(`${BACKEND_BASE_URL}/partners`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ email, password, companyName, firstName, lastName, phone })
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || 'Registration failed.');
      }
      return res.json();
    }

    // Demo fallback. DataStore.registerUser already: validates input,
    // blocks duplicate emails, and calls createReferralSourceForCompany
    // internally (step 3) so the matching Referral Source always exists
    // by the time this returns (step 4 — the "dashboard profile" for a
    // company is that Referral Source record; see getPartnerDashboardData).
    return DataStore.registerUser({ email, password, companyName, firstName, lastName, phone });
  }

  // ---- 3 in isolation: create/find the Referral Source for a company. --
  // Exposed separately in case the real backend wants this decoupled from
  // account creation (e.g. re-syncing a company that already exists).
  async function createReferralSource(companyName) {
    if (USE_REMOTE) {
      const res = await fetch(`${BACKEND_BASE_URL}/referral-sources`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ name: companyName })
      });
      if (!res.ok) throw new Error('Could not create the referral source.');
      return res.json();
    }
    return DataStore.createReferralSourceForCompany(companyName);
  }

  // ---- 5/6/8. Aggregate stats for the logged-in partner's dashboard, ---
  // scoped strictly to their own company/Referral Source.
  //
  // SECURITY NOTE: always pass the referralSource that came from
  // DataStore.getSession() (i.e. the logged-in partner's own company) —
  // never a value taken from a URL parameter or other user-editable
  // input. True enforcement of "a partner can only ever see their own
  // data" has to happen server-side once the real backend is connected;
  // client-side code can restrict what the UI *shows*, but cannot by
  // itself stop someone from calling this function with a different
  // company name in the browser console. See the "what still needs
  // backend connection" notes for how the real API should enforce this
  // (e.g. deriving the company from the authenticated session server-side
  // rather than trusting whatever value the client sends).
  async function getPartnerDashboardData(referralSource) {
    if (USE_REMOTE) {
      const res = await fetch(`${BACKEND_BASE_URL}/referral-sources/${encodeURIComponent(referralSource)}/stats`, {
        headers: authHeaders()
      });
      if (!res.ok) throw new Error('Could not load dashboard data.');
      return res.json();
    }
    const source = DataStore.getReferralSourceByName(referralSource);
    return (source && source.stats) || DataStore.emptyStats();
  }

  // ---- 6/7. That partner's own referral rows, same scoping rules as ----
  // getPartnerDashboardData above.
  async function getPartnerReferrals(referralSource) {
    if (USE_REMOTE) {
      const res = await fetch(`${BACKEND_BASE_URL}/referral-sources/${encodeURIComponent(referralSource)}/referrals`, {
        headers: authHeaders()
      });
      if (!res.ok) throw new Error('Could not load referrals.');
      return res.json();
    }
    const source = DataStore.getReferralSourceByName(referralSource);
    return (source && source.referrals) || [];
  }

  return {
    createPartnerAccount,
    createReferralSource,
    getPartnerDashboardData,
    getPartnerReferrals
  };
})();
