'use strict';

/**
 * Security — self-service two-factor authentication (TOTP), reached from the
 * app's own nav rather than sending staff out to EspoCRM's web UI. Uses
 * EspoCRM's own native 2FA (Administration > 2FA is enabled org-wide as
 * "Totp"; enrollment is per-user self-service) rather than a bespoke layer —
 * confirmed compatible with this app's Basic Auth login by reading EspoCRM's
 * own source (application/Espo/Core/Api/Auth.php, Tools/UserSecurity/*)
 * against the live instance on 2026-08-17. See espoClient.js's login() for
 * the login-side half of this.
 *
 * Every call here goes through the existing generic window.rvr.espo.request
 * IPC path — no new main-process code needed, since UserSecurity is just
 * another authenticated EspoCRM endpoint. EspoCRM itself restricts these
 * endpoints to admin-or-self (Controllers/UserSecurity.php), so this can
 * only ever set up 2FA on the currently logged-in staff member's own
 * account — never anyone else's, and never an automation/API-key account
 * (those aren't "regular" users, so EspoCRM's own UserSecurity::update()
 * allow-check refuses them structurally).
 */

(function () {
  async function fetchStatus(userId) {
    const res = await window.rvr.espo.request(`UserSecurity/${userId}`);
    if (!res.ok) return { ok: false, message: res.message };
    return { ok: true, enabled: !!(res.data && res.data.auth2FA), method: res.data && res.data.auth2FAMethod };
  }

  async function render(container, ctx) {
    const userId = ctx.user && ctx.user.id;

    container.innerHTML = `
      <h1 class="module-title">Security</h1>
      <p class="module-subtitle">Two-factor authentication for your own sign-in.</p>
      <div class="panel" id="security-panel" style="max-width:520px;">
        <div id="security-body"><div class="loading-state">Loading…</div></div>
      </div>
    `;

    const bodyEl = container.querySelector('#security-body');

    if (!userId) {
      bodyEl.innerHTML = '<div class="empty-state">Could not determine your account.</div>';
      return;
    }

    async function paintStatus() {
      bodyEl.innerHTML = '<div class="loading-state">Loading…</div>';
      const status = await fetchStatus(userId);
      if (ctx.isStale()) return;

      if (!status.ok) {
        bodyEl.innerHTML = `<div class="empty-state">Could not load your security settings (${ctx.escapeHtml(status.message || 'unknown error')}).</div>`;
        return;
      }

      if (status.enabled) {
        bodyEl.innerHTML = `
          <p><span class="pill good">Enabled</span> &nbsp;Two-factor authentication (authenticator app) is on for your account.</p>
          <p style="color:var(--muted); font-size:12px;">You'll be asked for a 6-digit code from your authenticator app each time you sign in here, in addition to your password.</p>
          <div class="status-banner" id="security-status"></div>
          <div class="field">
            <label for="security-disable-password">Current password</label>
            <input type="password" id="security-disable-password" autocomplete="current-password">
          </div>
          <button class="btn btn-danger" id="security-disable-btn">Turn off two-factor authentication</button>
        `;
        wireDisable();
      } else {
        bodyEl.innerHTML = `
          <p><span class="pill neutral">Off</span> &nbsp;Two-factor authentication is not set up for your account.</p>
          <p style="color:var(--muted); font-size:12px;">Adds a 6-digit code from an authenticator app (Google Authenticator, Authy, Microsoft Authenticator, etc.) on top of your password.</p>
          <div class="status-banner" id="security-status"></div>
          <div class="field">
            <label for="security-setup-password">Current password</label>
            <input type="password" id="security-setup-password" autocomplete="current-password">
          </div>
          <button class="btn btn-primary" id="security-start-btn">Set up two-factor authentication</button>
        `;
        wireStart();
      }
    }

    function showStatus(msg, kind) {
      const el = bodyEl.querySelector('#security-status');
      if (!el) return;
      el.textContent = msg;
      el.className = `status-banner show ${kind}`;
    }

    function wireDisable() {
      bodyEl.querySelector('#security-disable-btn').addEventListener('click', async () => {
        const password = bodyEl.querySelector('#security-disable-password').value;
        if (!password) { showStatus('Enter your current password to confirm.', 'err'); return; }
        const btn = bodyEl.querySelector('#security-disable-btn');
        btn.disabled = true;
        btn.textContent = 'Turning off…';

        const res = await window.rvr.espo.request(`UserSecurity/${userId}`, {
          method: 'PUT',
          body: { password, auth2FA: false }
        });

        if (ctx.isStale()) return;
        btn.disabled = false;
        btn.textContent = 'Turn off two-factor authentication';

        if (!res.ok) {
          showStatus(
            res.message || "Couldn't turn it off. If this keeps happening, you can also do it from your profile in EspoCRM's own web login (Preferences > Security).",
            'err'
          );
          return;
        }
        await paintStatus();
      });
    }

    let pendingSecret = null;

    function wireStart() {
      bodyEl.querySelector('#security-start-btn').addEventListener('click', async () => {
        const password = bodyEl.querySelector('#security-setup-password').value;
        if (!password) { showStatus('Enter your current password to continue.', 'err'); return; }
        const btn = bodyEl.querySelector('#security-start-btn');
        btn.disabled = true;
        btn.textContent = 'Generating…';

        const res = await window.rvr.espo.request('UserSecurity/action/getTwoFactorUserSetupData', {
          method: 'POST',
          body: { id: userId, password, auth2FAMethod: 'Totp', reset: false }
        });

        if (ctx.isStale()) return;
        btn.disabled = false;
        btn.textContent = 'Set up two-factor authentication';

        if (!res.ok) {
          showStatus(res.message || 'Could not start setup. Check your password and try again.', 'err');
          return;
        }

        const secret = res.data && res.data.auth2FATotpSecret;
        const label = (res.data && res.data.label) || (ctx.user && ctx.user.userName) || 'RVR Ratings CRM';
        if (!secret) {
          showStatus('EspoCRM did not return a setup code. Please try again.', 'err');
          return;
        }
        pendingSecret = secret;

        const otpauthUri = `otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent('RVR Ratings CRM')}`;

        bodyEl.innerHTML = `
          <p>In your authenticator app, add a new account and enter this key manually (no camera needed):</p>
          <div class="totp-secret-box">${ctx.escapeHtml(secret)}</div>
          <p style="color:var(--muted); font-size:12px; word-break:break-all;">${ctx.escapeHtml(otpauthUri)}</p>
          <div class="status-banner" id="security-status"></div>
          <div class="field">
            <label for="security-confirm-code">6-digit code from your app</label>
            <input type="text" id="security-confirm-code" inputmode="numeric" maxlength="7" autocomplete="one-time-code">
          </div>
          <div class="form-actions" style="margin-bottom:0;">
            <button class="btn btn-secondary" id="security-confirm-cancel">Cancel</button>
            <button class="btn btn-primary" id="security-confirm-btn">Confirm and turn on</button>
          </div>
        `;

        bodyEl.querySelector('#security-confirm-cancel').addEventListener('click', () => paintStatus());
        bodyEl.querySelector('#security-confirm-btn').addEventListener('click', async () => {
          const code = bodyEl.querySelector('#security-confirm-code').value.trim();
          if (!code) { showStatus('Enter the current code from your authenticator app.', 'err'); return; }
          const confirmBtn = bodyEl.querySelector('#security-confirm-btn');
          confirmBtn.disabled = true;
          confirmBtn.textContent = 'Confirming…';

          const confirmRes = await window.rvr.espo.request(`UserSecurity/${userId}`, {
            method: 'PUT',
            body: { password, code, secret: pendingSecret, auth2FAMethod: 'Totp' }
          });

          if (ctx.isStale()) return;
          confirmBtn.disabled = false;
          confirmBtn.textContent = 'Confirm and turn on';

          if (!confirmRes.ok) {
            showStatus(confirmRes.message || 'That code was not accepted. Check the time on your phone and try again.', 'err');
            return;
          }
          await paintStatus();
        });
      });
    }

    await paintStatus();
  }

  window.rvrModules.security = { render };
})();
