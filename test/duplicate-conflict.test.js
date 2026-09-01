'use strict';

/**
 * test/duplicate-conflict.test.js — added 2026-09-01 with the App Error
 * Tracking report of a "duplicate" EspoAuthError on POST Contact.
 *
 * EspoCRM answers a Contact/Account/etc. create that matches an existing
 * record with HTTP 409 and the reason header set to the bare word
 * "duplicate" — that is EspoCRM's own duplicate-detection doing its job, not
 * a bug. Before this fix, request() fell through to the generic error path:
 * `expected` only became true when the JSON body carried a `message` key,
 * which EspoCRM's 409 body does not, so the raw word "duplicate" surfaced
 * to staff as "Something went wrong" and fired a false-alarm report to
 * tech@ for a routine, expected outcome.
 */

const assert = require('assert');
const path = require('path');
const { EspoClient, EspoAuthError } = require(path.join(__dirname, '..', 'src', 'main', 'espoClient.js'));

let passed = 0;
let failed = 0;

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ok   ${name}`); })
    .catch((err) => { failed++; console.log(`  FAIL ${name}\n       ${err && err.message}`); });
}

function makeResponse(status, body, reason) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (k) => (String(k).toLowerCase() === 'x-status-reason' ? (reason || null) : null)
    },
    json: async () => body
  };
}

function loggedInClient() {
  const espo = new EspoClient();
  espo._authHeader = 'Basic dGVzdDp0ZXN0';
  return espo;
}

async function main() {
  await check('a 409 with EspoCRM\'s bare "duplicate" reason is marked expected', async () => {
    global.fetch = async () => makeResponse(409, {}, 'duplicate');
    const espo = loggedInClient();
    await assert.rejects(
      () => espo.request('Contact', { method: 'POST', body: { lastName: 'Test' } }),
      (err) => {
        assert.ok(err instanceof EspoAuthError);
        assert.strictEqual(err.status, 409);
        assert.strictEqual(err.expected, true, 'a routine duplicate-record refusal must not be reported as an unexpected failure');
        assert.notStrictEqual(err.message, 'duplicate', 'staff should see an actionable sentence, not the raw CRM reason word');
        return true;
      }
    );
  });

  await check('a 409 with no reason header at all is still marked expected', async () => {
    global.fetch = async () => makeResponse(409, {});
    const espo = loggedInClient();
    await assert.rejects(
      () => espo.request('Account', { method: 'POST', body: { name: 'Test Co' } }),
      (err) => {
        assert.ok(err instanceof EspoAuthError);
        assert.strictEqual(err.status, 409);
        assert.strictEqual(err.expected, true);
        return true;
      }
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
