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
  constructor(message, status) {
    super(message);
    this.name = 'EspoAuthError';
    this.status = status;
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
   * Attempt to log in with a real EspoCRM username/password.
   * Confirms the credentials by calling GET /App/user, which EspoCRM only
   * answers successfully for a genuinely authenticated request.
   */
  async login(userName, password) {
    if (!userName || !password) {
      throw new EspoAuthError('Username and password are required.', 400);
    }

    const authHeader = 'Basic ' + Buffer.from(`${userName}:${password}`).toString('base64');

    const res = await fetch(`${BASE_URL}/App/user`, {
      method: 'GET',
      headers: { Authorization: authHeader }
    });

    if (res.status === 401 || res.status === 403) {
      throw new EspoAuthError('Incorrect username or password.', res.status);
    }
    if (!res.ok) {
      throw new EspoAuthError(`EspoCRM returned an unexpected error (HTTP ${res.status}). Please try again.`, res.status);
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
      throw new EspoAuthError(
        'Signed in, but EspoCRM did not return a user record. Please contact support.',
        res.status
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
      type: user.type || ''
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
      throw new EspoAuthError('Not logged in.', 401);
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
      throw new EspoAuthError('Your session has expired. Please log in again.', 401);
    }

    if (!res.ok) {
      let message = `EspoCRM request failed (HTTP ${res.status}).`;
      try {
        const errBody = await res.json();
        if (errBody && errBody.message) message = errBody.message;
      } catch (_) { /* ignore parse failure, keep generic message */ }
      throw new EspoAuthError(message, res.status);
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
      throw new EspoAuthError('Not logged in.', 401);
    }

    const res = await fetch(`${BASE_URL}/Attachment/file/${encodeURIComponent(fileId)}`, {
      method: 'GET',
      headers: { Authorization: this._authHeader }
    });

    if (res.status === 401) {
      this.logout();
      throw new EspoAuthError('Your session has expired. Please log in again.', 401);
    }
    if (!res.ok) {
      throw new EspoAuthError(`Could not download that file (HTTP ${res.status}).`, res.status);
    }

    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}

module.exports = { EspoClient, EspoAuthError, BASE_URL };
