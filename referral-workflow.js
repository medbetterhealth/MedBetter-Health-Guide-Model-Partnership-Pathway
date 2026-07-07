/*
 * referral-workflow.js
 * ------------------------------------------------------------------
 * Shared "Pending Referral" engine used by BOTH:
 *   - the GUIDE Partnership Portal (partner side: submits a referral)
 *   - the main MedBetterHealth Dashboard (admin side: approves/declines)
 *
 * IMPORTANT — CROSS-ORIGIN LIMITATION (read this before wiring anything up):
 * The GUIDE Partnership Portal is hosted on GitHub Pages and the main
 * Dashboard is hosted on Azure (mbhdashboard.z13.web.core.windows.net).
 * Those are two different origins, so localStorage CANNOT be shared
 * between them — a referral "saved" to localStorage on the portal is
 * invisible to the dashboard, full stop, no matter how this file is
 * written. The USE_REMOTE switch below exists for exactly this reason:
 * once a real endpoint exists on the dashboard's existing Azure Function
 * API (the same one PARTNER_LOGIN_API_URL / PARTNER_DATA_API_URL already
 * live on), flip USE_REMOTE to true and this file will POST/GET across
 * origins correctly. Until then, everything here runs on localStorage
 * purely so the two sides can be developed/tested independently (e.g.
 * opening both files from the same local origin) — per the explicit
 * instruction that localStorage is fine as TEMPORARY TESTING storage
 * only, never production.
 *
 * Data shape for a pending referral record:
 *   {
 *     id, status: 'pending' | 'approved' | 'declined',
 *     submittedAt, decidedAt, declineReason,
 *     referralSource,                 // the partner's company name — locked, never partner-editable
 *     referralDate,
 *     patient: { firstName, lastName, dob, gender, county, zip, medicareId },
 *     caregiver: { name, phone },
 *     notes
 *   }
 * Every field above maps 1:1 to an existing column in the live Excel-backed
 * Referrals list (see C / CNY in dashboard.js) — deliberately no fields that
 * would require packing extra data into Notes. Don't add one without adding
 * a matching column first.
 * ------------------------------------------------------------------
 */
const ReferralWorkflow = (() => {
  const USE_REMOTE = false;
  // Matches the naming convention already used by the main dashboard's
  // existing Azure Function API (see PARTNER_LOGIN_API_URL etc. in dashboard.js).
  const API_BASE = ''; // e.g. 'https://mbh-dashboard-api-eebbhjdxfrgxdfex.eastus2-01.azurewebsites.net/api'

  const PENDING_KEY = 'mbh_pending_referrals_v1';

  function readAll() {
    try {
      const raw = localStorage.getItem(PENDING_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      console.error('ReferralWorkflow: failed to read pending referrals', e);
      return [];
    }
  }

  function writeAll(list) {
    localStorage.setItem(PENDING_KEY, JSON.stringify(list));
  }

  function makeId() {
    return 'pref_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `Request failed (${res.status})`);
    }
    return res.json();
  }

  // ---- 1. Partner side: submit a new pending referral -------------------
  async function submitPendingReferral(referral) {
    if (USE_REMOTE) {
      return postJson(`${API_BASE}/submit-referral`, referral);
    }
    const record = {
      id: makeId(),
      status: 'pending',
      submittedAt: new Date().toISOString(),
      decidedAt: null,
      declineReason: '',
      ...referral
    };
    const list = readAll();
    list.unshift(record);
    writeAll(list);
    notifyNewReferral(record);
    return record;
  }

  // ---- 2. Admin side: read pending referrals -----------------------------
  async function getPendingReferrals() {
    if (USE_REMOTE) {
      const res = await fetch(`${API_BASE}/pending-referrals`);
      if (!res.ok) throw new Error('Could not load pending referrals.');
      return res.json();
    }
    return readAll().filter(r => r.status === 'pending');
  }

  async function getReferralById(id) {
    if (USE_REMOTE) {
      const res = await fetch(`${API_BASE}/pending-referrals/${encodeURIComponent(id)}`);
      if (!res.ok) return null;
      return res.json();
    }
    return readAll().find(r => r.id === id) || null;
  }

  // ---- 3. Admin side: approve ---------------------------------------------
  // NOTE: this only flips the pending record's status. Actually writing the
  // referral into the main Excel-backed Referrals list is dashboard-specific
  // (it needs Graph API access/column mapping the portal doesn't have) — see
  // moveReferralToMainList() in dashboard.js, which calls this function.
  async function approvePendingReferral(id) {
    if (USE_REMOTE) {
      return postJson(`${API_BASE}/approve-referral`, { id });
    }
    const list = readAll();
    const record = list.find(r => r.id === id);
    if (!record) throw new Error('Pending referral not found.');
    record.status = 'approved';
    record.decidedAt = new Date().toISOString();
    writeAll(list);
    return record;
  }

  // ---- 4. Admin side: decline (keeps an audit record, does not delete) ---
  async function declinePendingReferral(id, reason) {
    if (USE_REMOTE) {
      return postJson(`${API_BASE}/decline-referral`, { id, reason: reason || '' });
    }
    const list = readAll();
    const record = list.find(r => r.id === id);
    if (!record) throw new Error('Pending referral not found.');
    record.status = 'declined';
    record.decidedAt = new Date().toISOString();
    record.declineReason = reason || '';
    writeAll(list);
    return record;
  }

  // ---- 5. moveReferralToMainList() hook -----------------------------------
  // Intentionally a no-op placeholder here. The REAL implementation lives in
  // dashboard.js because only the dashboard has Microsoft Graph API access
  // (drive/item id + auth token) needed to append a row to the live Excel
  // workbook. dashboard.js's moveReferralToMainList(referral) does that work
  // and then calls ReferralWorkflow.approvePendingReferral(referral.id) here
  // to record the decision.
  function moveReferralToMainList() {
    console.warn('ReferralWorkflow.moveReferralToMainList() is a placeholder — the real version lives in dashboard.js.');
  }

  // ---- 6. Notifications ----------------------------------------------------
  // Simple pub/sub so a page (typically the dashboard) can react immediately
  // when a referral is submitted in the SAME browser/origin (useful for local
  // testing). Cross-origin real-time notification requires the dashboard to
  // poll getPendingReferrals() against the real API once USE_REMOTE is on —
  // see checkForNewReferrals() in dashboard.js.
  const listeners = [];
  function onNewReferral(fn) {
    listeners.push(fn);
  }
  function notifyNewReferral(record) {
    listeners.forEach(fn => {
      try { fn(record); } catch (e) { console.error('ReferralWorkflow listener error', e); }
    });
  }

  return {
    submitPendingReferral,
    getPendingReferrals,
    getReferralById,
    approvePendingReferral,
    declinePendingReferral,
    moveReferralToMainList,
    notifyNewReferral,
    onNewReferral
  };
})();
