'use strict';

/**
 * App bootstrap: login screen -> app shell with sidebar nav + module router.
 * No framework — each module is a plain object with a render(container, ctx)
 * function, matching the "each screen built as its own module against one
 * shared EspoCRM API wrapper" extensibility goal from the addendum.
 */

const MODULES = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'claim-pool', label: 'Claim a Case' },
  { id: 'cases', label: 'Cases' },
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'contacts', label: 'Contacts' }
];

const state = {
  user: null,
  activeModule: 'dashboard'
};

// ---------------------------------------------------------------------------
// Background renderer-process error capture -> main -> App Error Tracking.
// ---------------------------------------------------------------------------
window.addEventListener('error', (event) => {
  window.rvr.app.reportRendererError({
    errorMessage: event.message,
    stackTrace: event.error && event.error.stack ? event.error.stack : '(no stack trace)',
    userAction: `On screen: ${state.activeModule}`
  });
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  window.rvr.app.reportRendererError({
    errorMessage: reason && reason.message ? reason.message : String(reason),
    stackTrace: reason && reason.stack ? reason.stack : '(no stack trace)',
    userAction: `On screen: ${state.activeModule} (unhandled promise rejection)`
  });
});

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ---------------------------------------------------------------------------
// Login screen
// ---------------------------------------------------------------------------
async function renderLoginScreen() {
  const container = document.getElementById('login-screen');
  const lastUserName = await window.rvr.auth.lastUserName();

  container.innerHTML = `
    <div class="login-card">
      <h1>RVR Ratings CRM</h1>
      <div class="subtitle">Sign in with your EspoCRM account</div>
      <div class="status-banner" id="login-status"></div>
      <div class="field">
        <label for="login-username">Username</label>
        <input type="text" id="login-username" value="${escapeHtml(lastUserName)}" autocomplete="username">
      </div>
      <div class="field">
        <label for="login-password">Password</label>
        <input type="password" id="login-password" autocomplete="current-password">
      </div>
      <button class="btn btn-primary" id="login-submit">Sign in</button>
      <div class="forgot-link"><a id="login-forgot">Forgot password?</a></div>
    </div>
  `;

  const usernameEl = document.getElementById('login-username');
  const passwordEl = document.getElementById('login-password');
  const statusEl = document.getElementById('login-status');
  const submitBtn = document.getElementById('login-submit');

  function showStatus(msg, kind) {
    statusEl.textContent = msg;
    statusEl.className = `status-banner show ${kind}`;
  }

  async function doLogin() {
    const userName = usernameEl.value.trim();
    const password = passwordEl.value;
    if (!userName || !password) {
      showStatus('Please enter your username and password.', 'err');
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = 'Signing in…';
    statusEl.className = 'status-banner';

    const res = await window.rvr.auth.login(userName, password);

    submitBtn.disabled = false;
    submitBtn.textContent = 'Sign in';

    if (!res.ok) {
      showStatus(res.message || 'Sign in failed. Please try again.', 'err');
      return;
    }

    state.user = res.user;
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app-shell').style.display = 'flex';
    initAppShell();
  }

  submitBtn.addEventListener('click', doLogin);
  passwordEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

  document.getElementById('login-forgot').addEventListener('click', async () => {
    const url = await window.rvr.auth.forgotPasswordUrl();
    // Opens in the OS browser via the main window's window-open handler is
    // for target=_blank links; for a plain anchor click we ask main to open
    // it directly through the same external-link path used elsewhere.
    window.open(url, '_blank');
  });
}

// ---------------------------------------------------------------------------
// App shell: sidebar, topbar, module router
// ---------------------------------------------------------------------------
function initAppShell() {
  document.getElementById('topbar-user').textContent = `${state.user.firstName || ''} ${state.user.lastName || ''}`.trim() || state.user.userName;

  const nav = document.getElementById('sidebar-nav');
  nav.innerHTML = '';
  MODULES.forEach((mod) => {
    const btn = document.createElement('button');
    btn.textContent = mod.label;
    btn.dataset.moduleId = mod.id;
    btn.addEventListener('click', () => navigateTo(mod.id));
    nav.appendChild(btn);
  });

  document.getElementById('sidebar-logout').addEventListener('click', async () => {
    await window.rvr.auth.logout();
    window.location.reload();
  });

  document.getElementById('topbar-feedback').addEventListener('click', openFeedbackModal);
  wireFeedbackModal();

  renderClockWidget();
  navigateTo(state.activeModule);
}

function navigateTo(moduleId) {
  state.activeModule = moduleId;
  document.querySelectorAll('#sidebar-nav button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.moduleId === moduleId);
  });

  const mod = window.rvrModules && window.rvrModules[moduleId];
  const container = document.getElementById('module-content');
  if (!mod) {
    container.innerHTML = `<div class="empty-state">Screen "${escapeHtml(moduleId)}" is not wired up yet.</div>`;
    return;
  }
  mod.render(container, { user: state.user, escapeHtml });
}

// ---------------------------------------------------------------------------
// Topbar Clock In/Out widget (office always; Field option Surveyor-only —
// role check is a simple placeholder here since EspoCRM's own ACL is the
// real enforcement; this just controls whether the Field option is offered).
// ---------------------------------------------------------------------------
function renderClockWidget() {
  const el = document.getElementById('topbar-clock-widget');
  el.innerHTML = `
    <button id="clock-in-btn">Clock In</button>
    <button id="clock-out-btn">Clock Out</button>
  `;
  document.getElementById('clock-in-btn').addEventListener('click', () => submitClock('in'));
  document.getElementById('clock-out-btn').addEventListener('click', () => submitClock('out'));
}

async function submitClock(action) {
  const payload = { staffName: `${state.user.firstName || ''} ${state.user.lastName || ''}`.trim() || state.user.userName, type: 'office', action };
  const res = await window.rvr.clock.event(payload);
  if (res.ok) {
    alert(`Clocked ${action} successfully.`);
  } else {
    alert('Could not log the clock event. Please try again.');
  }
}

// ---------------------------------------------------------------------------
// Feedback modal
// ---------------------------------------------------------------------------
function openFeedbackModal() {
  document.getElementById('feedback-modal-backdrop').classList.add('show');
}

function wireFeedbackModal() {
  const backdrop = document.getElementById('feedback-modal-backdrop');
  document.getElementById('feedback-cancel').addEventListener('click', () => backdrop.classList.remove('show'));

  document.getElementById('feedback-submit').addEventListener('click', async () => {
    const type = document.getElementById('feedback-type').value;
    const message = document.getElementById('feedback-message').value.trim();
    const statusEl = document.getElementById('feedback-status');

    if (!message) {
      statusEl.textContent = 'Please enter a message.';
      statusEl.className = 'status-banner show err';
      return;
    }

    const staffName = `${state.user.firstName || ''} ${state.user.lastName || ''}`.trim() || state.user.userName;
    const res = await window.rvr.feedback.submit({ type, message, staffName });

    if (res.ok) {
      statusEl.textContent = 'Thanks — your feedback has been sent.';
      statusEl.className = 'status-banner show ok';
      document.getElementById('feedback-message').value = '';
      setTimeout(() => backdrop.classList.remove('show'), 1200);
    } else {
      statusEl.textContent = 'Could not send feedback right now. Please try again.';
      statusEl.className = 'status-banner show err';
    }
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
renderLoginScreen();
