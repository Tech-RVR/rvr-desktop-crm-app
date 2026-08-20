'use strict';

/**
 * Security — three independent panels, each its own self-contained piece:
 *
 * 1. Two-factor authentication (self-service TOTP) — unchanged from the
 *    original build. See the big comment below for the full background.
 * 2. Change your password (self-service, every staff member) — new. Goes
 *    straight through EspoCRM's own `PUT UserSecurity/password`, which only
 *    ever operates on the CURRENTLY AUTHENTICATED user (see
 *    Espo\Tools\UserSecurity\Api\PutPassword — it reads the user id off the
 *    request's own auth, never a body parameter), so this can never be used
 *    to touch anyone else's password no matter what a caller sends.
 * 3. Reset a colleague's password (Director/Administrator role only) — new.
 *    EspoCRM's native "reset someone else's password" action
 *    (`POST UserSecurity/password/generate`) is hard-gated server-side to
 *    accounts whose EspoCRM user Type is literally Administrator/Super Admin
 *    (`Espo\Tools\UserSecurity\Password\Service::generateAndSendNewPasswordForUser`
 *    checks `$this->user->isAdmin()`, i.e. the `type` column — a Role like
 *    Director/Administrator does NOT satisfy this, confirmed by reading
 *    EspoCRM 10.0.4 source directly). David's account is Regular type with
 *    the Director/Administrator Role, not Administrator type, so this app
 *    can't call that endpoint directly on his behalf. Same wall the client
 *    portal's password reset hit before (see
 *    2026-08-17-portal-password-reset-v2-live-and-tested.md) — solved there
 *    with a dedicated n8n webhook backed by a privileged true-admin EspoCRM
 *    service account, never the requester's own login. This panel uses that
 *    same "proxy owns the data" pattern: the app forwards the logged-in
 *    staff member's own Basic Auth to the `rvr-staff-password-reset` n8n
 *    webhook (see n8nClient.js/main.js), which independently verifies that
 *    login AND that it holds the Director/Administrator role before using
 *    its own privileged credential to trigger EspoCRM's native
 *    generate-and-email action. This app never sees, sets, or carries
 *    around anyone else's new password — EspoCRM generates it and emails it
 *    straight to the colleague, same as EspoCRM's own Administration > Users
 *    panel would do it.
 *
 * Every call here goes through the existing generic window.rvr.espo.request
 * IPC path (or, for panel 3, the dedicated window.rvr.security.* path) — no
 * client-side re-implementation of EspoCRM's own ACL or the n8n webhook's
 * own role check; both are surfaced via whatever error message the real
 * backend gives back, same convention as the rest of this app.
 */

(function () {
  // Director/Administrator EspoCRM Role id — same id the live DIR-04 Formula
  // rule on Case checks (see infrastructure-status.md /
  // EspoCRM_Case_Entity_Scope_DRAFT.md). Used here purely as a soft,
  // best-effort client-side hint for whether to show panel 3 at all — real
  // enforcement is server-side in the n8n webhook, which does its own live
  // role lookup rather than trusting anything the app sends.
  const DIRECTOR_ADMIN_ROLE_ID = '6a6d2924bb6f8918c';

  async function fetchStatus(userId) {
    const res = await window.rvr.espo.request(`UserSecurity/${userId}`);
    if (!res.ok) return { ok: false, message: res.message };
    return { ok: true, enabled: !!(res.data && res.data.auth2FA), method: res.data && res.data.auth2FAMethod };
  }

  // Best-effort: is the logged-in staff member either true EspoCRM
  // Administrator/Super Admin type, or a holder of the Director/
  // Administrator Role? Either way they're a reasonable candidate to see the
  // "reset a colleague's password" panel — the n8n webhook re-checks this
  // independently before it ever touches anyone's password, so a wrong
  // answer here only ever hides or shows a button, it can't grant access.
  async function isPrivilegedForReset(user) {
    if (!user || !user.id) return false;
    if (user.type === 'admin' || user.type === 'super-admin') return true;
    const res = await window.rvr.espo.request(`User/${user.id}`, { query: { select: 'rolesIds' } });
    if (!res.ok || !res.data) return false;
    const rolesIds = res.data.rolesIds || [];
    return rolesIds.includes(DIRECTOR_ADMIN_ROLE_ID);
  }

  async function fetchResettableStaff(excludeUserId) {
    const res = await window.rvr.espo.request('User', {
      query: {
        'where[0][type]': 'in',
        'where[0][attribute]': 'type',
        'where[0][value][]': ['regular', 'admin'],
        // See the note in calendar.js: equals+true serialises the boolean to
        // the string "true" and silently matches zero rows. 'isTrue' takes no
        // value and is the correct operator for a bool column.
        'where[1][type]': 'isTrue',
        'where[1][attribute]': 'isActive',
        orderBy: 'name',
        maxSize: 200,
        select: 'id,name,userName,emailAddress'
      }
    });
    if (!res.ok || !res.data || !Array.isArray(res.data.list)) return [];
    return res.data.list.filter((u) => u.id !== excludeUserId);
  }

  async function render(container, ctx) {
    const userId = ctx.user && ctx.user.id;

    container.innerHTML = `
      <h1 class="module-title">Security</h1>
      <p class="module-subtitle">Two-factor authentication and password for your own sign-in.</p>

      <div class="panel" id="security-panel" style="max-width:520px;">
        <h2>Two-factor authentication</h2>
        <div id="security-body"><div class="loading-state">Loading…</div></div>
      </div>

      <div class="panel" id="password-panel" style="max-width:520px;">
        <h2>Change your password</h2>
        <div id="password-body"></div>
      </div>

      <div class="panel" id="admin-reset-panel" style="max-width:520px; display:none;">
        <h2>Reset a colleague's password</h2>
        <p style="color:var(--muted); font-size:12px;">Director/Administrator only. EspoCRM generates a brand-new password and emails it straight to them — you won't see or set it yourself.</p>
        <div id="admin-reset-body"><div class="loading-state">Loading…</div></div>
      </div>
    `;

    const bodyEl = container.querySelector('#security-body');

    if (!userId) {
      bodyEl.innerHTML = '<div class="empty-state">Could not determine your account.</div>';
      container.querySelector('#password-panel').style.display = 'none';
      return;
    }

    // ------------------------------------------------------------------
    // Panel 1 — Two-factor authentication (unchanged behaviour)
    // ------------------------------------------------------------------
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

    // ------------------------------------------------------------------
    // Panel 2 — Change your own password (new)
    // ------------------------------------------------------------------
    const passwordBodyEl = container.querySelector('#password-body');

    function paintPasswordForm() {
      passwordBodyEl.innerHTML = `
        <div class="status-banner" id="password-status"></div>
        <div class="field">
          <label for="password-current">Current password</label>
          <input type="password" id="password-current" autocomplete="current-password">
        </div>
        <div class="field">
          <label for="password-new">New password</label>
          <input type="password" id="password-new" autocomplete="new-password">
        </div>
        <div class="field">
          <label for="password-confirm">Confirm new password</label>
          <input type="password" id="password-confirm" autocomplete="new-password">
        </div>
        <button class="btn btn-primary" id="password-submit-btn">Change password</button>
      `;

      function showPasswordStatus(msg, kind) {
        const el = passwordBodyEl.querySelector('#password-status');
        if (!el) return;
        el.textContent = msg;
        el.className = `status-banner show ${kind}`;
      }

      passwordBodyEl.querySelector('#password-submit-btn').addEventListener('click', async () => {
        const currentPassword = passwordBodyEl.querySelector('#password-current').value;
        const newPassword = passwordBodyEl.querySelector('#password-new').value;
        const confirmPassword = passwordBodyEl.querySelector('#password-confirm').value;

        if (!currentPassword || !newPassword || !confirmPassword) {
          showPasswordStatus('Fill in all three fields.', 'err');
          return;
        }
        if (newPassword !== confirmPassword) {
          showPasswordStatus('New password and confirmation do not match.', 'err');
          return;
        }
        if (newPassword === currentPassword) {
          showPasswordStatus('New password must be different from your current password.', 'err');
          return;
        }

        const btn = passwordBodyEl.querySelector('#password-submit-btn');
        btn.disabled = true;
        btn.textContent = 'Changing…';

        // EspoCRM's own PUT UserSecurity/password only ever changes the
        // CURRENTLY AUTHENTICATED user's password — it reads the user id off
        // the request's own login, not a body parameter, so this can never
        // touch anyone else's account (see Api/PutPassword.php).
        const res = await window.rvr.espo.request('UserSecurity/password', {
          method: 'PUT',
          body: { password: newPassword, currentPassword }
        });

        if (ctx.isStale()) return;
        btn.disabled = false;
        btn.textContent = 'Change password';

        if (!res.ok) {
          showPasswordStatus(res.message || 'Could not change your password. Check your current password and try again.', 'err');
          return;
        }

        showPasswordStatus('Password changed.', 'ok');
        passwordBodyEl.querySelector('#password-current').value = '';
        passwordBodyEl.querySelector('#password-new').value = '';
        passwordBodyEl.querySelector('#password-confirm').value = '';
      });
    }

    paintPasswordForm();

    // ------------------------------------------------------------------
    // Panel 3 — Reset a colleague's password (Director/Administrator only)
    // ------------------------------------------------------------------
    const adminPanelEl = container.querySelector('#admin-reset-panel');
    const adminBodyEl = container.querySelector('#admin-reset-body');

    async function paintAdminResetPanel() {
      const staff = await fetchResettableStaff(userId);
      if (ctx.isStale()) return;

      if (staff.length === 0) {
        adminBodyEl.innerHTML = '<div class="empty-state">No other active staff accounts found.</div>';
        return;
      }

      adminBodyEl.innerHTML = `
        <div class="status-banner" id="admin-reset-status"></div>
        ${staff.map((u) => `
          <div class="doc-row" data-user-id="${ctx.escapeHtml(u.id)}">
            <div class="doc-main">
              <span class="doc-cat">${ctx.escapeHtml(u.name || u.userName)}</span>
              <span class="doc-meta">${ctx.escapeHtml(u.userName || '')}${u.emailAddress ? ` · ${ctx.escapeHtml(u.emailAddress)}` : ''}</span>
            </div>
            <div class="doc-actions">
              <button class="btn btn-secondary admin-reset-btn" data-user-id="${ctx.escapeHtml(u.id)}">Send new password</button>
            </div>
          </div>
        `).join('')}
      `;

      function showAdminStatus(msg, kind) {
        const el = adminBodyEl.querySelector('#admin-reset-status');
        if (!el) return;
        el.textContent = msg;
        el.className = `status-banner show ${kind}`;
      }

      adminBodyEl.querySelectorAll('.admin-reset-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const targetUserId = btn.dataset.userId;
          const row = staff.find((u) => u.id === targetUserId);
          const targetName = (row && (row.name || row.userName)) || 'this person';

          btn.disabled = true;
          const originalText = btn.textContent;
          btn.textContent = 'Sending…';

          const res = await window.rvr.security.resetColleaguePassword(targetUserId);

          if (ctx.isStale()) return;
          btn.disabled = false;
          btn.textContent = originalText;

          const success = res.ok && res.data && res.data.success;
          if (!success) {
            const message = (res.data && res.data.message) || 'Could not reset that password right now. Please try again.';
            showAdminStatus(message, 'err');
            return;
          }
          showAdminStatus(`A new password has been generated and emailed to ${targetName}.`, 'ok');
        });
      });
    }

    isPrivilegedForReset(ctx.user).then((privileged) => {
      if (ctx.isStale()) return;
      if (!privileged) return;
      adminPanelEl.style.display = '';
      paintAdminResetPanel();
    });

    await paintStatus();
  }

  window.rvrModules.security = { render };
})();
