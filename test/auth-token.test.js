'use strict';

/**
 * test/auth-token.test.js — added 2026-09-01 with the 2FA lockout fix.
 *
 * Runs the REAL shipped src/main/espoClient.js against a stand-in EspoCRM
 * that behaves the way the running container's Authentication.php actually
 * behaves (read from the container on 2026-09-01):
 *
 *   - the second-step (2FA) check runs whenever there is no auth token:
 *       !$authToken && $this->getTwoFactorEnabled()
 *   - a token is looked up from the PASSWORD position of the credentials,
 *     unconditionally:  $authToken = $this->authTokenManager->get($password)
 *   - a token is only MINTED when the login request carried EspoCRM's own
 *     'Espo-Authorization' header, not the standard 'Authorization' one.
 *
 * The point of the file is to prove both halves in one run: that the old
 * behaviour genuinely locked a 2FA user out, and that the new behaviour does
 * not. A test that only shows the new code working would not tell us the old
 * code was broken.
 */

const assert = require('assert');
const path = require('path');
const { EspoClient } = require(path.join(__dirname, '..', 'src', 'main', 'espoClient.js'));

const USER = 'david.b';
const PASSWORD = 'not-a-real-password-just-a-fixture';
const CODE = '123456';
const TOKEN = 'tok_abc123';

let passed = 0;
let failed = 0;

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ok   ${name}`); })
    .catch((err) => { failed++; console.log(`  FAIL ${name}\n       ${err && err.message}`); });
}

function decodeBasic(header) {
  return Buffer.from(String(header || '').replace(/^Basic /, ''), 'base64').toString('utf8');
}

function makeResponse(status, body, reason) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (k) => (String(k).toLowerCase() === 'x-status-reason' ? (reason || null) : null)
    },
    json: async () => body,
    arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer
  };
}

/**
 * @param twoFactor  is 2FA switched on for this account
 * @param mintToken  does the server hand back a token (only ever when the
 *                   request carried Espo-Authorization — which is exactly the
 *                   header the pre-fix app never sent)
 */
function makeEspo({ twoFactor = true, mintToken = true } = {}) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    const headers = opts.headers || {};
    calls.push({ url: String(url), headers });

    const [, secret] = decodeBasic(headers.Authorization).split(':');
    const usingToken = secret === TOKEN;
    const code = headers['Espo-Authorization-Code'];

    // Authentication.php: the second step is skipped entirely when a token
    // authenticated the request.
    if (twoFactor && !usingToken && code !== CODE) {
      return makeResponse(401, {}, 'second-step-required');
    }

    if (String(url).endsWith('/App/user')) {
      const body = { user: { id: 'u1', userName: USER }, acl: { table: {} } };
      if (mintToken && headers['Espo-Authorization']) body.token = TOKEN;
      return makeResponse(200, body);
    }

    return makeResponse(200, { list: [], total: 0 });
  };
  return { calls, impl };
}

async function main() {
  console.log('espoClient auth-token / 2FA checks\n');

  // -- 1. A 2FA account with no code still gets the "enter your code" prompt.
  await check('2FA account with no code asks for a code, not a wrong-password error', async () => {
    const espo = makeEspo({ twoFactor: true });
    global.fetch = espo.impl;
    const client = new EspoClient();
    let thrown = null;
    try { await client.login(USER, PASSWORD); } catch (e) { thrown = e; }
    assert.ok(thrown, 'login should have thrown');
    assert.strictEqual(thrown.secondStepRequired, true, 'should be flagged as second-step-required');
  });

  // -- 2. THE FIX. The call straight after a successful 2FA login must work.
  await check('after a 2FA login, the next request succeeds (the reported bug)', async () => {
    const espo = makeEspo({ twoFactor: true });
    global.fetch = espo.impl;
    const client = new EspoClient();
    await client.login(USER, PASSWORD, CODE);
    const out = await client.request('Case', { query: { maxSize: 20 } });
    assert.deepStrictEqual(out, { list: [], total: 0 });
    assert.ok(client.isAuthenticated(), 'should still be signed in');
  });

  // -- 3. The login call sends Espo-Authorization, raw base64, no "Basic ".
  await check('login sends Espo-Authorization as raw base64 (this is what mints the token)', async () => {
    const espo = makeEspo({ twoFactor: true });
    global.fetch = espo.impl;
    const client = new EspoClient();
    await client.login(USER, PASSWORD, CODE);
    const login = espo.calls[0];
    const sent = login.headers['Espo-Authorization'];
    assert.ok(sent, 'Espo-Authorization header was not sent');
    assert.ok(!/^Basic /.test(sent), 'Espo-Authorization must NOT carry a "Basic " prefix');
    assert.strictEqual(Buffer.from(sent, 'base64').toString('utf8'), `${USER}:${PASSWORD}`);
  });

  // -- 4. The password is not carried around after sign-in.
  await check('once a token is held, the stored header carries the token and not the password', async () => {
    const espo = makeEspo({ twoFactor: true });
    global.fetch = espo.impl;
    const client = new EspoClient();
    await client.login(USER, PASSWORD, CODE);
    const stored = decodeBasic(client.getAuthHeader());
    assert.strictEqual(stored, `${USER}:${TOKEN}`);
    assert.ok(!stored.includes(PASSWORD), 'the password must not survive the login');
  });

  // -- 5. Token requests declare themselves as token requests.
  await check('requests on a token session send Espo-Authorization-By-Token', async () => {
    const espo = makeEspo({ twoFactor: true });
    global.fetch = espo.impl;
    const client = new EspoClient();
    await client.login(USER, PASSWORD, CODE);
    await client.request('Case');
    const after = espo.calls[espo.calls.length - 1];
    assert.strictEqual(after.headers['Espo-Authorization-By-Token'], 'true');
  });

  // -- 6. THE OLD BEHAVIOUR, REPRODUCED. A server that mints no token is
  //       exactly the situation the pre-fix app put itself in every time.
  await check('OLD BEHAVIOUR: with no token, the next request 401s and reports "session has expired"', async () => {
    const espo = makeEspo({ twoFactor: true, mintToken: false });
    global.fetch = espo.impl;
    const client = new EspoClient();
    await client.login(USER, PASSWORD, CODE);
    assert.ok(client.isAuthenticated(), 'the login itself succeeds — that is why this was confusing');
    let thrown = null;
    try { await client.request('Case'); } catch (e) { thrown = e; }
    assert.ok(thrown, 'the request should have failed');
    assert.match(thrown.message, /session has expired/i);
    assert.strictEqual(client.isAuthenticated(), false, 'and it logs the user straight back out');
  });

  // -- 7. A no-token fallback must not send the By-Token header.
  await check('a session with no token does not claim to be using one', async () => {
    const espo = makeEspo({ twoFactor: false, mintToken: false });
    global.fetch = espo.impl;
    const client = new EspoClient();
    await client.login(USER, PASSWORD);
    await client.request('Case');
    const after = espo.calls[espo.calls.length - 1];
    assert.strictEqual(after.headers['Espo-Authorization-By-Token'], undefined);
    assert.strictEqual(decodeBasic(client.getAuthHeader()), `${USER}:${PASSWORD}`);
  });

  // -- 8. Accounts without 2FA are unaffected, and still get a token.
  await check('a non-2FA account signs in and runs on a token too', async () => {
    const espo = makeEspo({ twoFactor: false });
    global.fetch = espo.impl;
    const client = new EspoClient();
    const user = await client.login(USER, PASSWORD);
    assert.strictEqual(user.id, 'u1');
    assert.strictEqual(decodeBasic(client.getAuthHeader()), `${USER}:${TOKEN}`);
    await client.request('Contact');
  });

  // -- 9. File downloads go out on the same credential.
  await check('downloadFile uses the token session as well', async () => {
    const espo = makeEspo({ twoFactor: true });
    global.fetch = espo.impl;
    const client = new EspoClient();
    await client.login(USER, PASSWORD, CODE);
    const buf = await client.downloadFile('att1');
    assert.ok(Buffer.isBuffer(buf) && buf.length === 4);
    const after = espo.calls[espo.calls.length - 1];
    assert.strictEqual(after.headers['Espo-Authorization-By-Token'], 'true');
    assert.strictEqual(decodeBasic(after.headers.Authorization), `${USER}:${TOKEN}`);
  });

  // -- 10. Signing out forgets that it was a token session.
  await check('logout clears the token session', async () => {
    const espo = makeEspo({ twoFactor: true });
    global.fetch = espo.impl;
    const client = new EspoClient();
    await client.login(USER, PASSWORD, CODE);
    client.logout();
    assert.strictEqual(client.isAuthenticated(), false);
    assert.deepStrictEqual(client._authExtraHeaders(), {});
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
