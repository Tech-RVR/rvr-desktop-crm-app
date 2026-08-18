'use strict';

/**
 * First-run tour step definitions — shared/onboarding.js walks through
 * these in order. Each step targets a stable element that already exists
 * regardless of role — mostly the sidebar nav buttons and top bar, which
 * this app deliberately never hides per role (it relies on EspoCRM's own
 * server-side ACL rather than a client-side replica of it, same as every
 * other screen). Keeping steps scoped to the shell means this file never
 * needs to reach into any individual screen's internal markup.
 *
 * requiresAcl, when present, is checked against the ACL object EspoCRM
 * returns at login (see espoClient.js's login(), state.user.acl) before a
 * step is included for a given person — a soft, best-effort relevance
 * filter, not a security boundary. EspoCRM's own server-side ACL remains
 * the only real enforcement, exactly as everywhere else in this app. A
 * step with no requiresAcl is shown to everyone.
 */

// True unless the named scope/action is explicitly denied — fails open
// (shows the step) on missing/unrecognised ACL shapes, matching this app's
// existing convention of degrading gracefully rather than guessing wrong.
function rvrAclAllows(acl, scope, action) {
  if (!acl || !acl[scope]) return true;
  const value = acl[scope][action];
  if (value === undefined || value === null) return true;
  if (value === false || value === 'no') return false;
  return true;
}

window.RVR_TOUR_STEPS = [
  {
    id: 'welcome',
    selector: '#topbar-avatar',
    title: 'Welcome to the RVR Ratings CRM',
    body: 'This is a quick tour of the main screens. Click Next to keep going, or Skip at any point — you can always replay this later from the ? menu in the top right.'
  },
  {
    id: 'dashboard',
    selector: '.nav-item[data-module-id="dashboard"]',
    title: 'Dashboard',
    body: 'Your starting point — an overview of the caseload, including counts for things that need attention.'
  },
  {
    id: 'claim-pool',
    selector: '.nav-item[data-module-id="claim-pool"]',
    title: 'Claim a Case',
    body: 'Unassigned cases waiting to be picked up. Claiming one here assigns it to you.',
    requiresAcl: (acl) => rvrAclAllows(acl, 'Case', 'edit')
  },
  {
    id: 'cases',
    selector: '.nav-item[data-module-id="cases"]',
    title: 'Cases',
    body: 'The full case list. Open any case here to see its details, documents, notes, and message history.'
  },
  {
    id: 'case-new',
    selector: '.nav-item[data-module-id="case-new"]',
    title: 'New Case',
    body: 'Start a brand new case from scratch.',
    requiresAcl: (acl) => rvrAclAllows(acl, 'Case', 'create')
  },
  {
    id: 'pipeline',
    selector: '.nav-item[data-module-id="pipeline"]',
    title: 'Pipeline',
    body: 'Every case grouped by its current stage, so you can see the whole caseload move through the process at a glance.'
  },
  {
    id: 'contacts',
    selector: '.nav-item[data-module-id="contacts"]',
    title: 'Contacts',
    body: 'The clients behind each case.'
  },
  {
    id: 'messages',
    selector: '.nav-item[data-module-id="messages"]',
    title: 'Messages',
    body: 'Client portal messages across every case you can see, most recent first. The badge here shows how many cases have something unread.'
  },
  {
    id: 'verification',
    selector: '.nav-item[data-module-id="verification"]',
    title: 'Verification',
    body: 'Every document waiting on staff review, across all cases, in one list.',
    requiresAcl: (acl) => rvrAclAllows(acl, 'Document', 'edit')
  },
  {
    id: 'security',
    selector: '.nav-item[data-module-id="security"]',
    title: 'Security',
    body: 'Turn on two-factor authentication for your own account here — optional, but recommended.'
  },
  {
    id: 'help-menu',
    selector: '#topbar-help',
    title: "That's it",
    body: "You're set. Come back to this ? menu any time to replay this tour."
  }
];
