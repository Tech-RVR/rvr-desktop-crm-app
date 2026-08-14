'use strict';

/**
 * App bootstrap: login screen -> app shell with sidebar nav + module router.
 * No framework — each module is a plain object with a render(container, ctx)
 * function, matching the "each screen built as its own module against one
 * shared EspoCRM API wrapper" extensibility goal from the addendum.
 */

const MODULES = [
  { id: 'dashboard', label: 'Dashboard', icon: '\u{1F4CA}' },
  { id: 'claim-pool', label: 'Claim a Case', icon: '\u{1F4E5}' },
  { id: 'cases', label: 'Cases', icon: '\u{1F4C1}' },
  { id: 'case-new', label: 'New Case', icon: '\u{2795}' },
  { id: 'pipeline', label: 'Pipeline', icon: '\u{1F9ED}' },
  { id: 'contacts', label: 'Contacts', icon: '\u{1F464}' }
];

// Sidebar entries that are actions rather than lists. They still get a nav
// button, but they must never become the "back" target for Case detail —
// going back from a case into a blank creation form reads as a bug.
const NON_LIST_MODULES = ['case-new'];

const state = {
  user: null,
  activeModule: 'dashboard',
  lastListModule: 'dashboard'
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
    const loginScreen = document.getElementById('login-screen');
    loginScreen.style.display = 'none';
    // The app shell's own CSS class (.app) sets `display:grid` for the
    // topbar-spans-full-width layout — must match that here, not the old
    // pre-restyle 'flex' value, or this inline style wins (higher
    // specificity than the stylesheet rule) and silently breaks the grid.
    const appShell = document.getElementById('app-shell');
    appShell.style.display = 'grid';

    // If the shell fails to build, put the user back on the login screen with
    // a message rather than leaving them on a blank window. 0.2.1 shipped
    // without this: initAppShell threw, the login screen was already hidden,
    // and staff saw an empty app with no way to retry.
    try {
      initAppShell();
    } catch (err) {
      appShell.style.display = 'none';
      loginScreen.style.display = '';
      showStatus('Signed in, but the app failed to load. Please try again.', 'err');
      window.rvr.app.reportRendererError({
        errorMessage: err && err.message ? err.message : String(err),
        stackTrace: err && err.stack ? err.stack : '(no stack trace)',
        userAction: 'Building the app shell immediately after a successful sign-in'
      });
    }
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
  // Never let an incomplete user record take the whole shell down — this is
  // the first thing that runs after login, so anything that throws here
  // leaves the user staring at a blank window with no way forward.
  const user = state.user || {};
  const fullName =
    `${user.firstName || ''} ${user.lastName || ''}`.trim() ||
    user.userName ||
    'Signed in';
  document.getElementById('topbar-user').textContent = fullName;
  const avatarEl = document.getElementById('topbar-avatar');
  avatarEl.textContent = fullName.charAt(0).toUpperCase() || '?';
  avatarEl.title = fullName;

  const nav = document.getElementById('sidebar-nav');
  nav.innerHTML = '';
  MODULES.forEach((mod) => {
    const btn = document.createElement('button');
    btn.className = 'nav-item';
    btn.dataset.moduleId = mod.id;
    btn.innerHTML = `<span class="nav-icon">${mod.icon}</span><span>${escapeHtml(mod.label)}</span>`;
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

// Incremented on every navigation. A module's render() is async — it paints a
// skeleton, awaits an EspoCRM call, then fills in the result. If the user
// clicks another sidebar item while that call is in flight, the old render
// resumes against a screen that no longer exists. In 0.2.2 that threw
// "Cannot set properties of null (setting 'innerHTML')" out of cases.js.
let navSeq = 0;

function navigateTo(moduleId, params) {
  // Sidebar-nav modules (dashboard, cases, pipeline, etc.) double as the
  // "back" target for screens reached by clicking into a record, like
  // Case detail — those aren't in MODULES/the sidebar, so they don't
  // overwrite lastListModule. Action screens (New Case) are excluded too.
  if (MODULES.some((m) => m.id === moduleId) && !NON_LIST_MODULES.includes(moduleId)) {
    state.lastListModule = moduleId;
  }
  state.activeModule = moduleId;
  document.querySelectorAll('#sidebar-nav button.nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.moduleId === moduleId);
  });

  const seq = ++navSeq;

  // Give every navigation its OWN content element rather than reusing (and
  // overwriting) one shared node. A render still mid-await when the user
  // navigates away then finishes harmlessly against a detached element:
  // its container.querySelector() calls still resolve, so nothing throws,
  // and nothing it writes reaches the screen. This protects every module at
  // once, including any added later, instead of patching each one.
  const previous = document.getElementById('module-content');
  const container = document.createElement('div');
  container.id = 'module-content';
  container.className = previous ? previous.className : '';
  if (previous) {
    previous.replaceWith(container);
  } else {
    document.querySelector('.main-col').appendChild(container);
  }

  const mod = window.rvrModules && window.rvrModules[moduleId];
  if (!mod) {
    container.innerHTML = `<div class="empty-state">Screen "${escapeHtml(moduleId)}" is not wired up yet.</div>`;
    return;
  }

  let result;
  try {
    result = mod.render(container, {
      user: state.user,
      escapeHtml,
      params: params || {},
      // True once the user has navigated elsewhere. Modules doing anything
      // beyond painting into their own container after an await — showing a
      // toast, navigating, starting a poll — should check this first.
      isStale: () => seq !== navSeq,
      navigateTo: (id, p) => navigateTo(id, p),
      openCase: (caseId) => navigateTo('case-detail', { caseId }),
      goBack: () => navigateTo(state.lastListModule)
    });
  } catch (err) {
    reportModuleFailure(moduleId, container, seq, err);
    return;
  }

  // A rejected render used to surface as a bare unhandled promise rejection —
  // reported to App Error Tracking, but leaving the user on a stuck "Loading…"
  // with no explanation. Now it reports AND says something on screen.
  if (result && typeof result.catch === 'function') {
    result.catch((err) => reportModuleFailure(moduleId, container, seq, err));
  }
}

function reportModuleFailure(moduleId, container, seq, err) {
  if (seq === navSeq && container.isConnected) {
    container.innerHTML = `
      <div class="empty-state">
        Sorry — the ${escapeHtml(moduleId)} screen couldn't load.<br>
        Please try again, or use the Feedback button if it keeps happening.
      </div>`;
  }
  window.rvr.app.reportRendererError({
    errorMessage: err && err.message ? err.message : String(err),
    stackTrace: err && err.stack ? err.stack : '(no stack trace)',
    userAction: `Rendering the "${moduleId}" screen`
  });
}

// ---------------------------------------------------------------------------
// Topbar Clock In/Out widget. Opens a modal with an Office/Field toggle.
// Field mode loads the staff member's own assigned cases with a saved site
// address (via the rvr-my-cases webhook), captures GPS at submit time, and
// posts to the same rvr-clock-in-out webhook field-clock.html already uses —
// so the proximity check and Time Tracking Log behave identically either way.
// ---------------------------------------------------------------------------
let clockType = 'office';
let myCasesCache = null;

function renderClockWidget() {
  const el = document.getElementById('topbar-clock-widget');
  el.innerHTML = '<button id="clock-open-btn">Clock In / Out</button>';
  document.getElementById('clock-open-btn').addEventListener('click', openClockModal);
  wireClockModal();
}

function openClockModal() {
  const statusEl = document.getElementById('clock-status');
  statusEl.className = 'status-banner';
  statusEl.textContent = '';
  document.getElementById('clock-modal-backdrop').classList.add('show');
  setClockType('office');
}

function setClockType(type) {
  clockType = type;
  document.querySelectorAll('#clock-type-toggle .toggle-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.type === type);
  });
  const caseField = document.getElementById('clock-case-field');
  if (type === 'field') {
    caseField.style.display = '';
    loadMyCasesIntoSelect();
  } else {
    caseField.style.display = 'none';
  }
}

async function loadMyCasesIntoSelect() {
  const select = document.getElementById('clock-case-select');
  select.innerHTML = '<option value="">Loading your cases…</option>';

  if (!myCasesCache) {
    const res = await window.rvr.clock.myCases(state.user.id);
    myCasesCache = (res.ok && res.data && res.data.cases) || [];
  }

  if (myCasesCache.length === 0) {
    select.innerHTML = '<option value="">No assigned cases with a saved site address</option>';
    return;
  }

  select.innerHTML = `
    <option value="">Select a case…</option>
    ${myCasesCache.map((c) => `<option value="${escapeHtml(c.id)}">#${escapeHtml(c.number)} — ${escapeHtml(c.address || 'No address on file')}</option>`).join('')}
  `;
}

function getGeolocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Location is not available on this device.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
      (err) => reject(new Error(err && err.message ? err.message : 'Could not get your location.')),
      { enableHighAccuracy: true, timeout: 15000 }
    );
  });
}

function wireClockModal() {
  document.querySelectorAll('#clock-type-toggle .toggle-btn').forEach((btn) => {
    btn.addEventListener('click', () => setClockType(btn.dataset.type));
  });
  document.getElementById('clock-cancel').addEventListener('click', () => {
    document.getElementById('clock-modal-backdrop').classList.remove('show');
  });
  document.getElementById('clock-in-submit').addEventListener('click', () => submitClock('in'));
  document.getElementById('clock-out-submit').addEventListener('click', () => submitClock('out'));
}

async function submitClock(action) {
  const statusEl = document.getElementById('clock-status');
  const submitBtns = [document.getElementById('clock-in-submit'), document.getElementById('clock-out-submit')];
  const staffName = `${state.user.firstName || ''} ${state.user.lastName || ''}`.trim() || state.user.userName;
  const payload = { staffName, type: clockType, action };

  if (clockType === 'field') {
    const caseId = document.getElementById('clock-case-select').value;
    if (!caseId) {
      statusEl.textContent = "Please select which case you're visiting.";
      statusEl.className = 'status-banner show err';
      return;
    }
    payload.caseId = caseId;

    statusEl.textContent = 'Getting your location…';
    statusEl.className = 'status-banner show info';
    try {
      const pos = await getGeolocation();
      payload.currentLat = pos.latitude;
      payload.currentLng = pos.longitude;
    } catch (err) {
      statusEl.textContent = `${err.message} Check location permissions and try again.`;
      statusEl.className = 'status-banner show err';
      return;
    }
  }

  submitBtns.forEach((btn) => { btn.disabled = true; });
  statusEl.textContent = 'Logging…';
  statusEl.className = 'status-banner show info';

  const res = await window.rvr.clock.event(payload);

  submitBtns.forEach((btn) => { btn.disabled = false; });

  if (!res.ok) {
    statusEl.textContent = 'Could not log the clock event. Please try again.';
    statusEl.className = 'status-banner show err';
    return;
  }

  const data = res.data || {};
  statusEl.textContent = `Clocked ${action} successfully.${data.notes ? ` — ${data.notes}` : ''}`;
  statusEl.className = 'status-banner show ok';

  setTimeout(() => {
    document.getElementById('clock-modal-backdrop').classList.remove('show');
  }, 1800);
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
