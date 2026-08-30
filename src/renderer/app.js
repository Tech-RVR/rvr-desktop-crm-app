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
  { id: 'calendar', label: 'Calendar', icon: '\u{1F4C5}' },
  { id: 'bookings', label: 'Bookings', icon: '\u{1F4CB}' },
  { id: 'contacts', label: 'Contacts', icon: '\u{1F464}' },
  { id: 'messages', label: 'Messages', icon: '\u{1F4AC}', badgeId: 'messages-badge' },
  { id: 'verification', label: 'Verification', icon: '\u{2705}' },
  { id: 'security', label: 'Security', icon: '\u{1F510}' }
];

// Sidebar entries that are actions/personal-settings rather than lists. They
// still get a nav button, but they must never become the "back" target for
// Case detail — going back from a case into a blank creation form (or a
// personal Security screen that never linked to a case) reads as a bug.
const NON_LIST_MODULES = ['case-new', 'security'];

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
      <div class="subtitle" id="login-subtitle">Sign in with your EspoCRM account</div>
      <div class="status-banner" id="login-status"></div>
      <div id="login-step-credentials">
        <div class="field">
          <label for="login-username">Username</label>
          <input type="text" id="login-username" value="${escapeHtml(lastUserName)}" autocomplete="username">
        </div>
        <div class="field">
          <label for="login-password">Password</label>
          <input type="password" id="login-password" autocomplete="current-password">
        </div>
      </div>
      <div class="field" id="login-step-code" style="display:none;">
        <label for="login-code">Authenticator code</label>
        <input type="text" id="login-code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="6-digit code">
      </div>
      <button class="btn btn-primary" id="login-submit">Sign in</button>
      <div class="forgot-link"><a id="login-forgot">Forgot password?</a></div>
    </div>
  `;

  const usernameEl = document.getElementById('login-username');
  const passwordEl = document.getElementById('login-password');
  const codeEl = document.getElementById('login-code');
  const statusEl = document.getElementById('login-status');
  const submitBtn = document.getElementById('login-submit');
  const subtitleEl = document.getElementById('login-subtitle');
  const credentialsStepEl = document.getElementById('login-step-credentials');
  const codeStepEl = document.getElementById('login-step-code');

  // Two-factor accounts: EspoCRM answers a code-less login with a distinct
  // "second step required" signal rather than a plain failure (see
  // espoClient.js's login() for the full explanation). When that happens we
  // don't treat it as a wrong password — we swap to a code prompt and keep
  // the same username/password in memory for the follow-up request, exactly
  // as if the user had typed the code the first time.
  let awaitingCode = false;

  function showStatus(msg, kind) {
    statusEl.textContent = msg;
    statusEl.className = `status-banner show ${kind}`;
  }

  function enterCodeStep() {
    awaitingCode = true;
    credentialsStepEl.style.display = 'none';
    codeStepEl.style.display = '';
    subtitleEl.textContent = 'Enter the code from your authenticator app';
    codeEl.value = '';
    codeEl.focus();
  }

  async function doLogin() {
    const userName = usernameEl.value.trim();
    const password = passwordEl.value;
    const code = codeEl.value.trim();

    if (!awaitingCode && (!userName || !password)) {
      showStatus('Please enter your username and password.', 'err');
      return;
    }
    if (awaitingCode && !code) {
      showStatus('Enter the 6-digit code from your authenticator app.', 'err');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Signing in…';
    statusEl.className = 'status-banner';

    const res = await window.rvr.auth.login(userName, password, awaitingCode ? code : undefined);

    submitBtn.disabled = false;
    submitBtn.textContent = 'Sign in';

    if (!res.ok) {
      if (res.secondStepRequired) {
        if (!awaitingCode) {
          enterCodeStep();
        } else {
          showStatus(res.message || 'That code was not accepted. Please try again.', 'err');
        }
        return;
      }
      // 2026-08-28: a WRONG six-digit code comes back down the ordinary
      // failed-login path with no second-step header, so this used to throw
      // the user all the way back to the username and password screen saying
      // "Incorrect username or password." for a fat-fingered digit - and
      // worst case they went and reset a password that was fine. Keep them on
      // the code step and say what actually happened; only a genuinely
      // unrecoverable failure sends them back to the start.
      if (awaitingCode) {
        const looksLikeSession = res.status === 401 && /session|expired/i.test(res.message || '');
        if (!looksLikeSession) {
          showStatus(
            'That code was not accepted. Check the current code in your authenticator app - they change every 30 seconds - and make sure your phone\u2019s clock is set automatically.',
            'err'
          );
          return;
        }
        awaitingCode = false;
        credentialsStepEl.style.display = '';
        codeStepEl.style.display = 'none';
        subtitleEl.textContent = 'Sign in with your EspoCRM account';
      }
      showStatus(res.message || 'Sign in failed. Please try again.', 'err');
      return;
    }

    state.user = res.user;
    const loginScreen = document.getElementById('login-screen');
    // 2026-08-28: the login card was only hidden, never cleared, so the
    // staff member's real EspoCRM password sat in the page for the whole
    // session - which contradicts espoClient.js's own statement that
    // credentials live only in the main process. No route to reach it (the
    // CSP blocks inline script, contextIsolation and sandbox are on), so
    // this is defence in depth rather than a hole, but it is two lines.
    const pwEl = document.getElementById('login-password');
    if (pwEl) pwEl.value = '';
    const codeEl = document.getElementById('login-code');
    if (codeEl) codeEl.value = '';
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
  codeEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

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
    btn.innerHTML = `
      <span class="nav-icon">${mod.icon}</span><span>${escapeHtml(mod.label)}</span>
      ${mod.badgeId ? `<span class="nav-badge" id="${mod.badgeId}" style="display:none;"></span>` : ''}
    `;
    btn.addEventListener('click', () => navigateTo(mod.id));
    nav.appendChild(btn);
  });

  document.getElementById('sidebar-logout').addEventListener('click', async () => {
    clearInterval(messagesPollTimer);
    await window.rvr.auth.logout();
    window.location.reload();
  });

  document.getElementById('topbar-feedback').addEventListener('click', openFeedbackModal);
  wireFeedbackModal();

  renderClockWidget();
  navigateTo(state.activeModule);
  startMessagesPolling();
  // First-run tour + top-bar help menu — see shared/onboarding.js. Kept
  // as the very last step here so a broken tour init can never block the
  // rest of the shell (nav, messages polling, clock widget) from working.
  if (window.rvrOnboarding) window.rvrOnboarding.init(state.user);
}

// ---------------------------------------------------------------------------
// Messages unread badge — a lightweight poll while the app is open, not a
// true push notification (the app has no push infrastructure to build on;
// this was the deliberately-chosen tradeoff — see the Messages dashboard
// module for the full explanation). Silently shows no badge on a 403 rather
// than erroring, same as every other screen's permission handling in this
// app — that 403 is expected until the CPortalMessage staff ACL grant lands
// (see infrastructure-status.md).
// ---------------------------------------------------------------------------
const MESSAGES_POLL_INTERVAL_MS = 2 * 60 * 1000; // every 2 minutes
let messagesPollTimer = null;

async function refreshMessagesBadge() {
  const badge = document.getElementById('messages-badge');
  if (!badge) return; // shell not built, or user has navigated away from it

  // Tyrone's decision (2026-08-28): the badge counts YOUR OWN CASES that have
  // new client messages. "3" means three of your clients are waiting on you,
  // which is the thing a person acts on. Not a message total, and not other
  // people's cases — the Messages screen still lists everyone's, and marks
  // the ones that are not yours with the owner's colour and initials.
  const myCaseIds = await myOpenCaseIds();
  if (myCaseIds === null) { showBadgeUnavailable(badge); return; }
  if (myCaseIds.length === 0) { badge.style.display = 'none'; return; }

  const res = await window.rvr.espo.request('CPortalMessage', {
    query: {
      select: 'caseId,createdAt,direction',
      'where[0][type]': 'equals',
      'where[0][attribute]': 'direction',
      'where[0][value]': 'From Client',
      'where[1][type]': 'in',
      'where[1][attribute]': 'caseId',
      'where[1][value][]': myCaseIds,
      orderBy: 'createdAt',
      order: 'desc',
      maxSize: 200
    }
  });
  // 2026-08-28: this used to hide the badge on ANY failure, which looks
  // exactly like "no unread messages" and stayed that way for the whole
  // session on a 2-minute poll. The comment above justified it by a
  // CPortalMessage ACL gap that has been closed since 2026-08-17.
  if (!res.ok) { showBadgeUnavailable(badge); return; }

  const seenMap = (await window.rvr.messages.getSeen()) || {};

  // Count distinct CASES that have at least one client message newer than the
  // last time this person opened that case's messages.
  const casesWithNews = new Set();
  ((res.data && res.data.list) || []).forEach((m) => {
    if (!m.caseId) return;
    const seenAt = seenMap[m.caseId];
    if (!seenAt || new Date(m.createdAt) > new Date(seenAt)) casesWithNews.add(m.caseId);
  });
  const unreadCaseCount = casesWithNews.size;

  badge.classList.remove('nav-badge-unknown');
  badge.removeAttribute('title');
  if (unreadCaseCount > 0) {
    badge.textContent = unreadCaseCount > 99 ? '99+' : String(unreadCaseCount);
    badge.title = unreadCaseCount === 1
      ? '1 of your cases has a new client message'
      : `${unreadCaseCount} of your cases have new client messages`;
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}

// The cases assigned to the signed-in staff member. Returns null - never an
// empty array - when the read FAILED, so the caller can tell "you have no
// cases" apart from "we could not find out".
async function myOpenCaseIds() {
  const myId = state.user && state.user.id;
  if (!myId) return null;
  const res = await window.rvr.espo.request('Case', {
    query: {
      select: 'id',
      'where[0][type]': 'equals',
      'where[0][attribute]': 'assignedUserId',
      'where[0][value]': myId,
      maxSize: 200
    }
  });
  if (!res.ok) return null;
  return ((res.data && res.data.list) || []).map((c) => c.id).filter(Boolean);
}

// A badge that cannot be calculated must not look like a badge of zero.
function showBadgeUnavailable(badge) {
  badge.textContent = '!';
  badge.classList.add('nav-badge-unknown');
  badge.title = 'The count of cases with new messages is unavailable right now.';
  badge.style.display = '';
}

function startMessagesPolling() {
  refreshMessagesBadge();
  clearInterval(messagesPollTimer);
  messagesPollTimer = setInterval(refreshMessagesBadge, MESSAGES_POLL_INTERVAL_MS);
}

// Exposed so case-detail.js and messages.js can trigger an immediate
// refresh right after the user reads/replies to a case's messages, rather
// than leaving the badge stale until the next poll tick.
window.rvrRefreshMessagesBadge = () => refreshMessagesBadge();

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
// 2026-08-28: this used to be set to [] on failure as well as on success,
// and [] is truthy - so one failed lookup (patchy signal in a car park is
// the obvious one) was cached for the rest of the session. The dropdown said
// "No assigned cases with a saved site address" and kept saying it, telling a
// surveyor standing at a site that they had no cases, with the only fix being
// a restart that nothing on screen suggested. Only a SUCCESSFUL read is
// cached now.
let myCasesCache = null;

// 2026-08-28: see preload's session.onExpired. Returns the user to the login
// card once, cleanly, instead of stranding them on a dead screen.
let sessionExpiryHandled = false;
function wireSessionExpiry() {
  if (!window.rvr.session || typeof window.rvr.session.onExpired !== 'function') return;
  window.rvr.session.onExpired(() => {
    if (sessionExpiryHandled) return;
    sessionExpiryHandled = true;
    const loginScreen = document.getElementById('login-screen');
    const appShell = document.getElementById('app-shell');
    if (!loginScreen || !appShell) return;
    if (messagesPollTimer) { clearInterval(messagesPollTimer); messagesPollTimer = null; }
    appShell.style.display = 'none';
    loginScreen.style.display = '';
    const banner = document.getElementById('login-status');
    if (banner) {
      banner.textContent = 'Your session has expired. Please sign in again.';
      banner.className = 'status-banner show err';
    }
    state.user = null;
    sessionExpiryHandled = false;
  });
}

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
    if (!res.ok) {
      // Do NOT cache a failure. This is the whole bug: [] is truthy, so one
      // dropped connection meant the lookup was never retried and a surveyor
      // standing at a site was told they had no cases for the rest of the
      // session.
      select.innerHTML = '<option value="">Could not load your cases - close this and try again</option>';
      return;
    }
    myCasesCache = (res.data && res.data.cases) || [];
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
// Registered once, at boot, rather than per login - re-registering on every
// sign-in would stack a listener each time.
wireSessionExpiry();
