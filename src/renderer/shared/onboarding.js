'use strict';

/**
 * First-run tour engine. See this project's own planning doc,
 * "2026-08-18-onboarding-tour-and-whats-new-plan.md", for the full design
 * rationale. Short version: per-user (not per-install) state via a new
 * onboarding:getState/setState IPC pair (main.js), because whether
 * someone's seen the tour is a property of the person, not the machine —
 * this matters specifically for the Surveyor role, where individual
 * accounts rotate through shared machines over time.
 *
 * Tour steps live in shared/tour-steps.js (window.RVR_TOUR_STEPS), each
 * optionally filtered by the real ACL EspoCRM returned at login
 * (state.user.acl) rather than a guessed role name — a soft, best-effort
 * relevance filter only, same non-enforcing spirit as every other
 * ACL-adjacent client-side check in this app.
 *
 * This file only ever touches its own overlay DOM (appended to
 * document.body) and the existing #topbar-help / #topbar-help-menu
 * markup — it never reaches into another screen's internal elements
 * beyond the sidebar nav buttons themselves, which exist any time the
 * app shell is up, regardless of which screen is currently active.
 */
(function () {
  let overlayEl = null;
  let tooltipEl = null;
  let activeSteps = [];
  let activeIndex = 0;
  let currentUser = null;

  function relevantSteps(user) {
    const acl = (user && user.acl) || {};
    return (window.RVR_TOUR_STEPS || []).filter((step) => {
      if (typeof step.requiresAcl !== 'function') return true;
      try {
        return !!step.requiresAcl(acl);
      } catch (err) {
        return true; // fail open — never let a bad predicate hide a step
      }
    });
  }

  function buildOverlay() {
    if (overlayEl) return;
    overlayEl = document.createElement('div');
    overlayEl.id = 'rvr-tour-overlay';
    overlayEl.innerHTML =
      '<div id="rvr-tour-spotlight"></div>' +
      '<div id="rvr-tour-tooltip">' +
        '<div class="rvr-tour-title" id="rvr-tour-title"></div>' +
        '<div class="rvr-tour-body" id="rvr-tour-body"></div>' +
        '<div class="rvr-tour-footer">' +
          '<label class="rvr-tour-dontshow">' +
            '<input type="checkbox" id="rvr-tour-dontshow" /> Don\'t show this again' +
          '</label>' +
          '<div class="rvr-tour-actions">' +
            '<button class="btn btn-secondary" id="rvr-tour-skip">Skip</button>' +
            '<button class="btn btn-primary" id="rvr-tour-next">Next</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlayEl);
    tooltipEl = overlayEl.querySelector('#rvr-tour-tooltip');

    overlayEl.querySelector('#rvr-tour-skip').addEventListener('click', finishTour);
    overlayEl.querySelector('#rvr-tour-next').addEventListener('click', () => {
      if (activeIndex >= activeSteps.length - 1) {
        finishTour();
      } else {
        activeIndex += 1;
        paintStep();
      }
    });
  }

  function positionAround(target) {
    const spotlight = overlayEl.querySelector('#rvr-tour-spotlight');
    if (!target) {
      // Target not currently on screen — centre the tooltip instead of
      // pointing at nothing (every Phase 1 step targets shell-level
      // elements that are always present, so this is a defensive
      // fallback, not an expected path).
      spotlight.style.display = 'none';
      tooltipEl.style.top = '50%';
      tooltipEl.style.left = '50%';
      tooltipEl.style.transform = 'translate(-50%, -50%)';
      return;
    }
    const rect = target.getBoundingClientRect();
    spotlight.style.display = 'block';
    spotlight.style.top = (rect.top - 8) + 'px';
    spotlight.style.left = (rect.left - 8) + 'px';
    spotlight.style.width = (rect.width + 16) + 'px';
    spotlight.style.height = (rect.height + 16) + 'px';

    const tooltipTop = Math.min(rect.bottom + 14, window.innerHeight - 220);
    const tooltipLeft = Math.min(Math.max(rect.left, 16), window.innerWidth - 340);
    tooltipEl.style.transform = 'none';
    tooltipEl.style.top = Math.max(tooltipTop, 16) + 'px';
    tooltipEl.style.left = tooltipLeft + 'px';
  }

  function paintStep() {
    const step = activeSteps[activeIndex];
    if (!step) { finishTour(); return; }
    overlayEl.querySelector('#rvr-tour-title').textContent = step.title;
    overlayEl.querySelector('#rvr-tour-body').textContent = step.body;
    overlayEl.querySelector('#rvr-tour-next').textContent =
      activeIndex >= activeSteps.length - 1 ? 'Done' : 'Next';
    const target = step.selector ? document.querySelector(step.selector) : null;
    positionAround(target);
  }

  async function finishTour() {
    const dontShowBox = overlayEl && overlayEl.querySelector('#rvr-tour-dontshow');
    const dontShowAgain = !!(dontShowBox && dontShowBox.checked);
    if (overlayEl) {
      overlayEl.remove();
      overlayEl = null;
      tooltipEl = null;
    }
    if (currentUser && currentUser.id) {
      try {
        await window.rvr.onboarding.setState(currentUser.id, {
          hasSeenTour: true,
          dontShowAgain: dontShowAgain
        });
      } catch (err) {
        // Never let a failed write block the UI from closing cleanly —
        // worst case the tour just offers to run again next login.
      }
    }
  }

  function showTour(user) {
    currentUser = user;
    activeSteps = relevantSteps(user);
    activeIndex = 0;
    if (!activeSteps.length) return;
    buildOverlay();
    paintStep();
  }

  function closeHelpMenu() {
    const menu = document.getElementById('topbar-help-menu');
    if (menu) menu.classList.remove('show');
  }

  function wireHelpMenu(user) {
    const helpBtn = document.getElementById('topbar-help');
    const menu = document.getElementById('topbar-help-menu');
    const tourBtn = document.getElementById('help-show-tour');
    if (!helpBtn || !menu || !tourBtn) return;

    helpBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      menu.classList.toggle('show');
    });
    document.addEventListener('click', closeHelpMenu);
    menu.addEventListener('click', (event) => event.stopPropagation());

    tourBtn.addEventListener('click', () => {
      closeHelpMenu();
      showTour(user);
    });
  }

  async function init(user) {
    wireHelpMenu(user);
    if (!user || !user.id) return;
    try {
      const state = await window.rvr.onboarding.getState(user.id);
      if (!state || (!state.hasSeenTour && !state.dontShowAgain)) {
        showTour(user);
      }
    } catch (err) {
      // Never let a broken onboarding-state read block the rest of the
      // app shell's own init from finishing — same fail-safe spirit as
      // every other non-critical panel in this app.
    }
  }

  window.rvrOnboarding = { init, showTour };
})();
