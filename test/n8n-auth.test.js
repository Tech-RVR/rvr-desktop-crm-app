// Every n8n webhook the app talks to, and whether it sends the signed-in
// person's own EspoCRM login with the request.
//
// This exists because the same fault has now happened twice:
//   29 Aug - the claim pool webhooks started checking the caller's login on
//            16 August. The app was never changed to send one, so Claim a Case
//            silently refused everyone for nearly two weeks.
//   30 Aug - the clock in/out webhook was locked the same way, and the desktop
//            app's clock screen was missed again. Broken within the hour.
//
// Both times the n8n side gained a check and nobody walked the callers. This
// test is the walk. If you add a webhook here, add it to the list below and
// say deliberately whether it carries a login.
//
// Run with:  node test/n8n-auth.test.js

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'main', 'n8nClient.js'),
  'utf8'
);

// path -> must it send an Authorization header?
const EXPECTED = {
  'rvr-case-claim-list': true,
  'rvr-case-claim-submit': true,
  'rvr-my-cases': true,
  'rvr-clock-in-out': true,
  'rvr-app-feedback': true,
  'rvr-staff-password-reset': true,
  // Deliberately NOT authenticated. The app's own error handlers fire this,
  // including from the login screen and after a session has gone, which is
  // exactly when there is no header to send. Locking it would throw away the
  // reports that matter most. It is protected instead by the receiving
  // workflow treating everything in it as inert text - see task #180.
  'rvr-app-error-tracking': false
};

// Pull the call for one webhook path out of the source: from the quoted path
// to the end of that call's argument list.
function callSiteFor(webhookPath) {
  const marker = "'" + webhookPath + "'";
  const start = SRC.indexOf(marker);
  if (start < 0) return null;
  let depth = 1; // we are already inside postJson( / getJson(
  for (let i = start; i < SRC.length; i++) {
    if (SRC[i] === '(') depth++;
    else if (SRC[i] === ')') { depth--; if (depth === 0) return SRC.slice(start, i); }
  }
  return SRC.slice(start, start + 400);
}

let failures = 0;
const seen = [];

for (const [webhookPath, needsAuth] of Object.entries(EXPECTED)) {
  const call = callSiteFor(webhookPath);
  if (call === null) {
    failures++;
    console.log('FAIL  ' + webhookPath + ' - not found in n8nClient.js at all');
    continue;
  }
  seen.push(webhookPath);
  const sendsAuth = /Authorization/.test(call);
  if (sendsAuth === needsAuth) {
    console.log('PASS  ' + webhookPath.padEnd(26) + (needsAuth ? 'sends a login' : 'deliberately anonymous'));
  } else {
    failures++;
    if (needsAuth) {
      console.log('FAIL  ' + webhookPath.padEnd(26) + 'sends NO login, but the webhook checks for one');
      console.log('      That is the bug that broke Claim a Case and then clock in/out.');
    } else {
      console.log('FAIL  ' + webhookPath.padEnd(26) + 'sends a login, but is listed as deliberately anonymous');
      console.log('      Either the list is out of date or this was changed by accident.');
    }
  }
}

// Catch a webhook added to the client but never listed here.
const allPaths = (SRC.match(/'(rvr-[a-z0-9-]+)'/g) || [])
  .map((s) => s.replace(/'/g, ''));
const unlisted = [...new Set(allPaths)].filter((p) => !(p in EXPECTED));
if (unlisted.length === 0) {
  console.log('PASS  no webhook in n8nClient.js is missing from this list');
} else {
  failures++;
  console.log('FAIL  webhook(s) not covered by this test: ' + unlisted.join(', '));
  console.log('      Add each one above and say whether it should carry a login.');
}

console.log(failures === 0 ? '\nAll checks passed.' : '\n' + failures + ' check(s) failed.');
process.exit(failures === 0 ? 0 : 1);
