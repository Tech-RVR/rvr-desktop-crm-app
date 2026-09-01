'use strict';

/**
 * test/changelog.test.js — added 2026-09-01 with the "What's new" feature.
 *
 * Runs the REAL shipped src/renderer/shared/changelog.js under `vm` with a
 * stubbed window, so the version maths and the entry list are checked against
 * the file that actually ships rather than a copy of the logic.
 *
 * The entry-list checks matter as much as the maths. The failure mode for a
 * changelog is not a crash - it is a release going out with its notes in the
 * wrong order, or notes written for a version that has not shipped, and
 * nobody noticing because the modal still looks fine.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP_ROOT = path.join(__dirname, '..');
const SRC = path.join(APP_ROOT, 'src', 'renderer', 'shared', 'changelog.js');
const PKG = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'));

const sandbox = {
  window: { rvr: {} },
  document: { getElementById: () => null, createElement: () => ({}), body: { appendChild: () => {} } }
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: 'changelog.js' });

const cl = sandbox.window.rvrChangelog;

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (err) { failed++; console.log(`  FAIL ${name}\n       ${err && err.message}`); }
}

console.log('changelog checks\n');

check('the file exposes window.rvrChangelog', () => {
  assert.ok(cl, 'window.rvrChangelog was not set - check the IIFE runs');
  assert.strictEqual(typeof cl.showIfNew, 'function');
  assert.strictEqual(typeof cl.showAll, 'function');
  assert.strictEqual(typeof cl.markUpToDate, 'function');
});

check('version comparison orders correctly', () => {
  assert.ok(cl.compareVersions('0.2.38', '0.2.35') > 0);
  assert.ok(cl.compareVersions('0.2.35', '0.2.38') < 0);
  assert.strictEqual(cl.compareVersions('0.2.35', '0.2.35'), 0);
  assert.ok(cl.compareVersions('0.3.0', '0.2.99') > 0, 'minor must outrank patch');
  assert.ok(cl.compareVersions('1.0.0', '0.9.9') > 0, 'major must outrank minor');
});

check('version comparison is numeric, not alphabetical', () => {
  // The bug this guards: '0.2.9' sorts AFTER '0.2.38' as a string, so a
  // string compare would show nothing to anyone on 0.2.9.
  assert.ok(cl.compareVersions('0.2.38', '0.2.9') > 0);
});

// An array built inside the vm context has that context's Array prototype,
// not this one's, so deepStrictEqual fails on identical values. Compare the
// shape as JSON instead - the values are what matter here, not the realm.
function versionsOf(since) {
  return JSON.stringify(cl.entriesNewerThan(since).map((e) => e.version));
}

// 2026-09-01: these two were written against hardcoded version numbers and
// broke the moment a release was added - the behaviour was right, the
// expectation was stale. Derived from ENTRIES instead, so they keep testing
// the logic without needing an edit every time we ship.
check('only entries newer than the last seen version are returned', () => {
  const second = cl.ENTRIES[1].version;
  assert.strictEqual(versionsOf(second), JSON.stringify([cl.ENTRIES[0].version]),
    'somebody on the second-newest release should be shown exactly the newest one');
});

check('somebody several releases behind gets all of them', () => {
  const oldest = cl.ENTRIES[cl.ENTRIES.length - 1].version;
  const allButOldest = cl.ENTRIES.slice(0, -1).map((e) => e.version);
  assert.strictEqual(versionsOf(oldest), JSON.stringify(allButOldest),
    'somebody on the oldest release we have notes for should be shown every later one');
});

check('an unknown last-seen version returns nothing rather than everything', () => {
  assert.strictEqual(versionsOf(undefined), '[]');
  assert.strictEqual(versionsOf(''), '[]');
});

check('somebody already on the newest version is shown nothing', () => {
  assert.strictEqual(versionsOf(cl.ENTRIES[0].version), '[]');
});

check('entries are strictly newest-first', () => {
  for (let i = 1; i < cl.ENTRIES.length; i += 1) {
    const newer = cl.ENTRIES[i - 1].version;
    const older = cl.ENTRIES[i].version;
    assert.ok(
      cl.compareVersions(newer, older) > 0,
      `entry ${newer} should come after ${older} - the list must be newest-first or entriesNewerThan misreports`
    );
  }
});

check('every entry says something, and says it in plain English', () => {
  assert.ok(cl.ENTRIES.length > 0, 'there must be at least one entry');
  for (const e of cl.ENTRIES) {
    assert.ok(/^\d+\.\d+\.\d+$/.test(e.version), `bad version string: ${e.version}`);
    assert.ok(e.headline && e.headline.trim().length > 3, `entry ${e.version} has no headline`);
    assert.ok(Array.isArray(e.items) && e.items.length > 0, `entry ${e.version} has no items`);
    for (const item of e.items) {
      assert.ok(typeof item === 'string' && item.trim().length > 10, `entry ${e.version} has an empty or stub item`);
    }
  }
});

check('no notes are written for a version that has not shipped', () => {
  // Guards the mistake of writing next release's notes and forgetting to bump
  // package.json - staff would be told about something they do not have.
  const newest = cl.ENTRIES[0].version;
  assert.ok(
    cl.compareVersions(newest, PKG.version) <= 0,
    `changelog's newest entry (${newest}) is ahead of package.json (${PKG.version})`
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
