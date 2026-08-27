'use strict';

/**
 * Thin wrapper around the EspoCRM REST API.
 *
 * Design (per infrastructure-status.md / RVR_Handover.md, confirmed 2026-08-12):
 * - Each staff member logs in with their OWN real EspoCRM username/password.
 * - The app is a genuine EspoCRM API client — it inherits EspoCRM's existing
 *   6-role ACL model for free. No permission logic is duplicated here.
 * - Auth uses EspoCRM's HTTP Basic Auth support on the REST API (username:password
 *   base64-encoded in the Authorization header, sent per request). This is the
 *   standard EspoCRM API auth method for a "real user" login, distinct from the
 *   separate API-Key auth used by the n8n automation user.
 * - Credentials are held ONLY in memory in the main process for the life of the
 *   session (never written to disk in plaintext). A future iteration could use
 *   the OS keychain (e.g. via `keytar`) for an opt-in "remember me".
 *
 * The Claim a Case screen is the one deliberate exception: it calls the
 * dedicated n8n webhooks (rvr-case-claim-list / rvr-case-claim-submit) instead
 * of the logged-in user's own EspoCRM token, since a Caseworker's own ACL
 * can't see unassigned cases outside their scope.
 */

const BASE_URL = 'https://crm.rvrratingpartners.co.uk/api/v1';

class EspoAuthError extends Error {
  /**
   * `expected` marks a failure as a routine, understood, staff-facing outcome
   * (wrong password, no permission on a specific record, a validation
   * message EspoCRM itself supplied, needs-a-2FA-code) as opposed to
   * something that actually broke (a bare/generic failure with no reason
   * given, a malformed response, a network error). Added 2026-08-18 so the
   * main process can decide what's worth reporting to App Error Tracking
   * without every screen needing its own opinion — see main.js's
   * `reportUnexpectedApiFailure`. Defaults to false (report it) so a new
   * failure path added later fails safe toward visibility, not silence.
   */
  constructor(message, status, expected = false) {
    super(message);
    this.name = 'EspoAuthError';
    this.status = status;
    this.expected = expected;
  }
}

class EspoClient {
  constructor() {
    this._authHeader = null;
    this._userName = null;
    this._userId = null;
  }

  isAuthenticated() {
    return !!this._authHeader;
  }

  getSessionInfo() {
    return { userName: this._userName, userId: this._userId };
  }

  /**
   * The current session's raw HTTP Basic Auth header (or null if not logged
   * in). Exposed ONLY so main.js can forward the logged-in staff member's own
   * identity to the small set of n8n webhooks that need to verify who's
   * calling (e.g. the Director/Administrator-gated colleague password reset,
   * see n8nClient.js) — the renderer never sees this value, same boundary as
   * everything else in this file.
   */
  getAuthHeader() {
    return this._authHeader;
  }

  /**
   * Attempt to log in with a real EspoCRM username/password.
   * Confirms the credentials by calling GET /App/user, which EspoCRM only
   * answers successfully for a genuinely authenticated request.
   *
   * `code` is an optional TOTP code for accounts with EspoCRM's own
   * two-factor authentication turned on (Administration > 2FA is per-user
   * self-service, confirmed live 2026-08-17 against EspoCRM's own source:
   * application/Espo/Core/Api/Auth.php's handleSecondStepRequired()). When a
   * 2FA-enabled account logs in WITHOUT a code, EspoCRM returns HTTP 401 with
   * a distinct `X-Status-Reason: second-step-required` header (not a generic
   * "wrong credentials" failure) — that's what lets the login screen tell
   * "needs a code" apart from "wrong password" and prompt accordingly rather
   * than showing a confusing error. The code, once known, is sent as its own
   * header (`Espo-Authorization-Code`), alongside the same Basic Auth header,
   * verified fresh on every request since this app doesn't keep a session.
   *
   * This only ever affects real human logins: EspoCRM's 2FA enrollment
   * (Tools/UserSecurity/Service.php) only allows admin/regular users to set
   * it up on their own account — API-key/automation users structurally can't
   * have 2FA applied to them, so this can never touch the n8n/portal-proxy
   * credentials.
   */
  async login(userName, password, code) {
    if (!userName || !password) {
      throw new EspoAuthError('Username and password are required.', 400, true);
    }

    const authHeader = 'Basic ' + Buffer.from(`${userName}:${password}`).toString('base64');
    const headers = { Authorization: authHeader };
    if (code) headers['Espo-Authorization-Code'] = code;

    const res = await fetch(`${BASE_URL}/App/user`, {
      method: 'GET',
      headers
    });

    if (res.status === 401 || res.status === 403) {
      const reason = res.headers.get('X-Status-Reason');
      if (reason === 'second-step-required') {
        const err = new EspoAuthError(
          code
            ? 'That code was not accepted. Please try the current code from your authenticator app.'
            : 'Enter the 6-digit code from your authenticator app.',
          res.status,
          true
        );
        err.secondStepRequired = true;
        throw err;
      }
      // A routine, staff-facing outcome (typo'd password, expired account) —
      // not worth an App Error Tracking email. Contrast with the generic
      // fallback below, which means EspoCRM refused for some OTHER reason.
      throw new EspoAuthError('Incorrect username or password.', res.status, true);
    }
    if (!res.ok) {
      // No known/expected reason for this one — genuinely unexpected.
      throw new EspoAuthError(`EspoCRM returned an unexpected error (HTTP ${res.status}). Please try again.`, res.status, false);
    }

    // GET App/user does NOT return a bare user record. EspoCRM wraps it:
    //   { user: {...}, acl: {...}, preferences: {...}, settings: {...},
    //     appParams: {...}, token: "..." }
    // (see EspoCRM's own client/src/app.js -> onAuth: `data.user`).
    // Reading `.userName`/`.id` straight off the envelope silently yields
    // undefined, which is what broke the app shell in 0.2.1 — the topbar
    // avatar called .trim() on an undefined display name and every
    // user.id-dependent call (claim-a-case, Field clock-in) sent undefined.
    // `|| payload` keeps this working if a future Espo version ever returns
    // the record unwrapped.
    const payload = await res.json();
    const user = (payload && payload.user) || payload || {};

    if (!user.id) {
      // A 200 with no usable user record is a structural surprise, not a
      // credentials problem — worth reporting even though the HTTP call
      // itself "succeeded".
      throw new EspoAuthError(
        'Signed in, but EspoCRM did not return a user record. Please contact support.',
        res.status,
        false
      );
    }

    this._authHeader = authHeader;
    this._userName = user.userName || userName;
    this._userId = user.id;

    return {
      id: user.id,
      userName: user.userName || userName,
      firstName: user.firstName || '',
      lastName: user.lastName || '',
      type: user.type || '',
      // Full EspoCRM-computed ACL for this user, straight from the same
      // GET /App/user response already read above (payload.acl) — not a
      // new call, not a client-side ACL re-implementation. Used only for
      // soft, best-effort UI decisions (e.g. which first-run tour steps
      // are relevant to this person's role, see shared/tour-steps.js) —
      // EspoCRM's own server-side ACL remains the only real enforcement,
      // exactly as everywhere else in this app.
      acl: payload.acl || {}
    };
  }

  logout() {
    this._authHeader = null;
    this._userName = null;
    this._userId = null;
  }

  /**
   * Generic authenticated request against the EspoCRM REST API, using the
   * currently logged-in user's own credentials (and therefore their own ACL).
   */
  async request(path, { method = 'GET', query, body } = {}) {
    if (!this._authHeader) {
      throw new EspoAuthError('Not logged in.', 401, true);
    }

    let url = `${BASE_URL}/${path.replace(/^\//, '')}`;
    if (query && Object.keys(query).length) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) params.append(key, value);
      }
      url += `?${params.toString()}`;
    }

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: this._authHeader,
        'Content-Type': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined
    });

    if (res.status === 401) {
      // Session-equivalent expired / credentials no longer valid.
      this.logout();
      throw new EspoAuthError('Your session has expired. Please log in again.', 401, true);
    }

    if (!res.ok) {
      // 2026-08-18: whether EspoCRM gave a real, specific reason is exactly
      // the signal for whether this was an "expected" outcome (a permission
      // message, a validation failure) or a genuine unexplained failure (a
      // bare/empty error body — e.g. EspoCRM's own `throw new Forbidden()`
      // with no message, as hit by the 2FA-setup 403 that prompted this).
      // See main.js's `reportUnexpectedApiFailure` for what happens with it.
      let message = `EspoCRM request failed (HTTP ${res.status}).`;
      let expected = false;

      // 2026-08-27: EspoCRM returns its 403s with an EMPTY body and puts the
      // explanation in the X-Status-Reason HEADER. Verified live against the
      // running CRM: a deliberate over-limit list request came back with a
      // zero-length body and the header reading "Max size should not exceed
      // 200. Use offset and limit." Reading only the JSON body therefore
      // discarded EspoCRM's reason on every single 403, which is why three
      // completely unrelated failures on 2026-08-27 (a blocked company
      // create, the Messages screen, a password change) all arrived as the
      // same contentless "HTTP 403" and were misdiagnosed as one permission
      // gap. Read the header first; the body still wins if it has anything,
      // since that is the richer source when EspoCRM does populate it.
      //
      // Note on `expected`: a reason header deliberately does NOT mark the
      // failure as expected. Some of these ARE our own bugs (the maxSize one
      // above), and this file's standing principle is to fail toward
      // visibility. The reports now carry a real sentence instead of nothing.
      const reasonHeader = res.headers.get('X-Status-Reason');
      if (reasonHeader && reasonHeader.trim()) {
        message = reasonHeader.trim();
      }

      try {
        const errBody = await res.json();
        if (errBody && errBody.message) {
          message = errBody.message;
          expected = true;
        }
      } catch (_) { /* ignore parse failure, keep generic message */ }
      throw new EspoAuthError(message, res.status, expected);
    }

    if (res.status === 204) return null;
    return res.json();
  }

  /**
   * Downloads an Attachment's raw file bytes, using the logged-in user's own
   * credentials (so it's governed by the same Document ACL as everything
   * else — a caseworker can only download a file on a case they can see).
   * Returns a Node Buffer; the renderer never touches the auth header.
   */
  async downloadFile(fileId) {
    if (!this._authHeader) {
      throw new EspoAuthError('Not logged in.', 401, true);
    }

    const res = await fetch(`${BASE_URL}/Attachment/file/${encodeURIComponent(fileId)}`, {
      method: 'GET',
      headers: { Authorization: this._authHeader }
    });

    if (res.status === 401) {
      this.logout();
      throw new EspoAuthError('Your session has expired. Please log in again.', 401, true);
    }
    if (!res.ok) {
      // This one never reads the response body, so there's no expected/
      // unexpected distinction to make — always report it.
      throw new EspoAuthError(`Could not download that file (HTTP ${res.status}).`, res.status, false);
    }

    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}

module.exports = { EspoClient, EspoAuthError, BASE_URL };
