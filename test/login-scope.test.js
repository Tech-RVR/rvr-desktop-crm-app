// Regression test for the sign-in crash that shipped in v0.2.26 and stayed
// live until v0.2.32.
//
// doLogin() read `codeEl.value` near the top, and further down the SAME
// function a second `const codeEl = ...` was added. A `const` belongs to the
// whole function scope, so that later declaration put the outer codeEl into
// the temporal dead zone for all of doLogin - and the first read threw
// "Cannot access 'codeEl' before initialization". Every fresh sign-in failed.
// It went unnoticed for six releases because an already-signed-in session
// never runs this path, and `node --check` cannot see it: it is a scope
// error, not a syntax error.
//
// This test pulls the real doLogin() out of the shipped file and runs it, so
// it fails if anyone reintroduces a shadowing declaration.
//
// Run with:  node test/login-scope.test.js

const fs = require('fs');
const path = require('path');

const APP_JS = path.join(__dirname, '..', 'src', 'renderer', 'app.js');

function extractDoLogin(src) {
  const marker = 'async function doLogin() {';
  const start = src.indexOf(marker);
  if (start < 0) throw new Error('doLogin() not found in app.js');
  let depth = 0, end = -1;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  if (end < 0) throw new Error('could not find the end of doLogin()');
  return src.slice(start, end);
}

// Just enough of the login screen's scope for doLogin to run. With an empty
// username and password it should hit its own guard and return, without ever
// calling the CRM.
function buildDoLogin(fnSrc) {
  const body = [
    "let awaitingCode = false;",
    "const stub = () => ({ value: '', focus() {}, style: {}, addEventListener() {} });",
    "const usernameEl = stub(), passwordEl = stub(), codeEl = stub();",
    "const statusEl = { textContent: '', className: '' };",
    "const submitBtn = { disabled: false, textContent: '' };",
    "const credentialsStepEl = { style: {} }, codeStepEl = { style: {} };",
    "const subtitleEl = { textContent: '' };",
    "function showStatus() {}",
    "function enterCodeStep() {}",
    "const state = {};",
    "const document = { getElementById: () => stub() };",
    "const window = { rvr: { auth: { login: async () => ({ ok: false, message: 'stub' }) } } };",
    fnSrc,
    "return doLogin;"
  ].join('\n');
  return new Function(body)();
}

(async () => {
  let failures = 0;

  try {
    const doLogin = buildDoLogin(extractDoLogin(fs.readFileSync(APP_JS, 'utf8')));
    await doLogin();
    console.log('PASS  doLogin() runs without throwing on an empty sign-in');
  } catch (e) {
    failures++;
    console.log('FAIL  doLogin() threw: ' + e.message);
    if (/before initialization/.test(e.message)) {
      console.log('      That is the shadowing bug again. Something inside doLogin');
      console.log('      redeclares a variable that is already declared above it.');
    }
  }

  // Belt and braces: no second declaration of codeEl anywhere in the file.
  // Strip comments first - the explanation of this very bug sits in a comment
  // in app.js and quotes the old line, which would otherwise count as a second
  // declaration and fail the test for no reason.
  const withoutComments = fs.readFileSync(APP_JS, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const decls = (withoutComments.match(/\b(const|let|var)\s+codeEl\b/g) || []).length;
  if (decls === 1) {
    console.log('PASS  codeEl is declared exactly once');
  } else {
    failures++;
    console.log('FAIL  codeEl is declared ' + decls + ' times - expected exactly 1');
  }

  console.log(failures === 0 ? '\nAll checks passed.' : '\n' + failures + ' check(s) failed.');
  process.exit(failures === 0 ? 0 : 1);
})();
