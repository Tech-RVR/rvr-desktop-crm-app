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

// 2026-08-28: these calls had no time limit and no error handling, so a
// dropped connection or a restarting n8n rejected the promise all the way
// back into the calling screen. On Claim a Case that left every button
// disabled reading "Claiming..." until the app was restarted, with nothing
// on screen to say why. Nothing in here rejects any more - a failure comes
// back as { ok: false } like every other outcome, which is what the screens
// already know how to handle.
const N8N_TIMEOUT_MS = 20000;

function n8nTimeoutSignal() {
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      return AbortSignal.timeout(N8N_TIMEOUT_MS);
    }
  } catch (_) { /* older runtime - no timeout, same as before */ }
  return undefined;
}

function unreachable(err) {
  const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
  return {
    ok: false,
    status: 0,
    data: {
      message: timedOut
        ? 'That did not respond in time. Please try again.'
        : 'Could not reach the server. Check your connection and try again.'
    }
  };
}

async function postJson(path, body, extraHeaders) {
  let res;
  try {
    res = await fetch(`${N8N_BASE}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(extraHeaders || {}) },
      body: JSON.stringify(body || {}),
      signal: n8nTimeoutSignal()
    });
  } catch (err) {
    return unreachable(err);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON response */ }
  return { ok: res.ok, status: res.status, data };
}

async function getJson(path, query, extraHeaders) {
  let url = `${N8N_BASE}/${path}`;
  if (query && Object.keys(query).length) {
    const params = new URLSearchParams(query);
    url += `?${params.toString()}`;
  }
  let res;
  try {
    res = await fetch(url, {
      headers: { ...(extraHeaders || {}) },
      signal: n8nTimeoutSignal()
    });
  } catch (err) {
    return unreachable(err);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON response */ }
  return { ok: res.ok, status: res.status, data };
}

const n8nClient = {
  // Case Claim Pool.
  // 2026-08-29: these three carried no Authorization header, but the n8n side
  // has checked the caller's EspoCRM session since 16 August, so Claim a Case
  // had been answering "Please sign in to view the case list." to everyone.
  // Proven live on 29 Aug: a header-less call to rvr-case-claim-list came back
  // with exactly that message. Nobody had hit it because the system is not in
  // real use yet. They now send the signed-in person's own session header, and
  // the n8n side answers with that verified person's cases - the staffUserId
  // travelling in the URL or body is no longer trusted for anything.
  listClaimableCases: (authHeader) => getJson('rvr-case-claim-list', null, { Authorization: authHeader }),
  submitClaim: (authHeader, caseId, staffUserId) => postJson(
    'rvr-case-claim-submit',
    { caseId, staffUserId },
    { Authorization: authHeader }
  ),

  // A staff member's own assigned cases with a saved site address (used for
  // the field clock-in case picker, both here and on the standalone
  // field-clock.html mobile page).
  listMyCases: (authHeader) => getJson('rvr-my-cases', null, { Authorization: authHeader }),

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
