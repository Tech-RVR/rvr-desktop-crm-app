'use strict';

/**
 * Wrapper around the n8n webhooks the app talks to directly (i.e. NOT through
 * the logged-in user's own EspoCRM session). These are the deliberate
 * exceptions where the app needs a privileged/automated path:
 *
 * - Case Claim Pool (list + submit) — a Caseworker's own EspoCRM ACL can't
 *   see unassigned cases outside their scope, so this goes through the
 *   dedicated n8n webhook instead.
 * - Clock In/Out — logs to the Time Tracking Log Google Sheet and (for field
 *   visits) runs the GPS proximity check against the Case's site coordinates.
 * - App Error Tracking / App Feedback — background error capture and the
 *   in-app Feedback button, both intentionally NOT routed through EspoCRM.
 */

const N8N_BASE = 'https://n8n.rvrratingpartners.co.uk/webhook';

async function postJson(path, body, extraHeaders) {
  const res = await fetch(`${N8N_BASE}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(extraHeaders || {}) },
    body: JSON.stringify(body || {})
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON response */ }
  return { ok: res.ok, status: res.status, data };
}

async function getJson(path, query) {
  let url = `${N8N_BASE}/${path}`;
  if (query && Object.keys(query).length) {
    const params = new URLSearchParams(query);
    url += `?${params.toString()}`;
  }
  const res = await fetch(url);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON response */ }
  return { ok: res.ok, status: res.status, data };
}

const n8nClient = {
  // Case Claim Pool
  listClaimableCases: () => getJson('rvr-case-claim-list'),
  submitClaim: (caseId, staffUserId) => postJson('rvr-case-claim-submit', { caseId, staffUserId }),

  // A staff member's own assigned cases with a saved site address (used for
  // the field clock-in case picker, both here and on the standalone
  // field-clock.html mobile page).
  listMyCases: (staffUserId) => getJson('rvr-my-cases', { staffUserId }),

  // Clock In/Out — returns { status, staffName, action, notes, withinRange,
  // distanceMetres, siteAddress } as of the 2026-08-12 payload extension.
  clockEvent: (payload) => postJson('rvr-clock-in-out', payload),

  // Background error capture — fire-and-forget from the app's own error
  // handlers (main + renderer process). No AI/LLM involvement by design.
  reportError: (payload) => postJson('rvr-app-error-tracking', payload),

  // In-app Feedback button (Bug / Feature Request / Something else).
  submitFeedback: (payload) => postJson('rvr-app-feedback', payload),

  // Reset a colleague's password (Security screen, Director/Administrator
  // role only — see security.js). The requesting staff member's own EspoCRM
  // Basic Auth header is forwarded as-is so the webhook can verify their real
  // identity and role membership itself; this app never touches, sees, or
  // sets the target's new password directly. The actual write happens
  // server-side in n8n via a dedicated privileged EspoCRM service account
  // (the same "proxy owns the data" pattern used for the client portal's
  // password reset), calling EspoCRM's native generate-and-email action —
  // never a raw password field this app would have to carry around.
  resetColleaguePassword: (authHeader, targetUserId) => postJson(
    'rvr-staff-password-reset',
    { targetUserId },
    { Authorization: authHeader }
  )
};

module.exports = { n8nClient };
