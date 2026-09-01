'use strict';

// Loaded first among the renderer scripts (see index.html) for two reasons:
//
// 1. It initializes window.rvrModules. This used to be an inline
//    <script>window.rvrModules = {};</script> tag in index.html, but this
//    page's CSP is `script-src 'self'` with no `unsafe-inline` — Chromium/
//    Electron would silently block that inline script in the real built
//    app, leaving window.rvrModules undefined and every module's own
//    `window.rvrModules.dashboard = {...}` registration throwing against
//    undefined. Moving the init into this external, CSP-compliant file
//    fixes it.
// 2. It gives every module one shared source for stage colours/ordering
//    instead of each screen re-deriving its own, matching the 13-stage
//    colour grouping from the RVR CRM mockup (rvr_crm_mockup.html).
window.rvrModules = window.rvrModules || {};

const RVR_STAGE_CLASS = {
  'Enquiry Received': 'b-enquiry',
  'Onboarding': 'b-onboard',
  'Bill & Document Review': 'b-review',
  'Relief Assessment': 'b-relief',
  'Evidence Gathering / Site Inspection': 'b-evidence',
  'Check': 'b-check',
  'Challenge': 'b-challenge',
  'Appeal': 'b-appeal',
  'Senior Sign-Off & Savings Confirmation': 'b-signoff',
  'Invoiced': 'b-invoiced',
  'Payment / Arrears': 'b-payment',
  'Closed': 'b-closed',
  'Site Inspection / Case Rejection': 'b-disputed',
  'Closed Without Payment - Disputed': 'b-disputed'
};

// Returns a ready-to-use class attribute value, e.g. "badge b-check".
// Unknown/blank stages fall back to the neutral "closed" grey rather than
// leaving a case with no visible stage indicator at all.
window.rvrStageBadgeClass = function rvrStageBadgeClass(stage) {
  return 'badge ' + (RVR_STAGE_CLASS[stage] || 'b-closed');
};

// The real 12-stage pipeline + the disputed terminal state, in enum order —
// same list already independently verified against the live cCaseStage
// field by pipeline.js and case-detail.js. Exposed globally so a screen
// that only needs the ordering (e.g. Dashboard's "cases by stage" board)
// doesn't have to duplicate it a third time.
window.RVR_STAGE_ORDER = [
  'Enquiry Received', 'Onboarding', 'Bill & Document Review', 'Relief Assessment',
  'Evidence Gathering / Site Inspection', 'Site Inspection / Case Rejection',
  'Check', 'Challenge', 'Appeal',
  'Senior Sign-Off & Savings Confirmation', 'Invoiced', 'Payment / Arrears',
  'Closed', 'Closed Without Payment - Disputed'
];
