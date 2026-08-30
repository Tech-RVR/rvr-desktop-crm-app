/* Checks the paging helper against every answer EspoCRM can give.
   Run: node test/paged-read.test.js   (no network, no Electron) */
'use strict';
const fs = require('fs');
const path = require('path');

// Load the real shipped file rather than a copy of it.
global.window = {};
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'shared', 'paged-read.js'), 'utf8');
eval(src);
const readAll = global.window.rvrPagedRead.readAll;

function stub(pages) {
  const calls = [];
  global.window.rvr = {
    espo: {
      request: async function (entity, opts) {
        calls.push({ maxSize: opts.query.maxSize, offset: opts.query.offset });
        const p = pages[calls.length - 1];
        if (p === 'FAIL') return { ok: false, message: 'nope' };
        if (p === 'THROW') throw new Error('network died');
        return { ok: true, data: { list: p.list, total: p.total } };
      }
    }
  };
  return calls;
}
const rows = (n, from) => Array.from({ length: n }, (_, i) => ({ id: 'r' + ((from || 0) + i) }));

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok ? '' : '\n   got  ' + JSON.stringify(got) + '\n   want ' + JSON.stringify(want)));
}

(async function () {
  stub([{ list: rows(12), total: 12 }]);
  let r = await readAll('Case', { orderBy: 'number' });
  check('a single short page', { n: r.list.length, truncated: r.truncated }, { n: 12, truncated: false });

  let calls = stub([{ list: rows(200), total: 200 }]);
  r = await readAll('Case', {});
  check('exactly 200 and the total agrees - no second request', { n: r.list.length, truncated: r.truncated, requests: calls.length }, { n: 200, truncated: false, requests: 1 });

  calls = stub([{ list: rows(200), total: 350 }, { list: rows(150, 200), total: 350 }]);
  r = await readAll('Case', {});
  check('350 across two pages', { n: r.list.length, truncated: r.truncated, requests: calls.length }, { n: 350, truncated: false, requests: 2 });
  check('second page asked with the right offset', calls[1], { maxSize: 200, offset: 200 });

  stub(['FAIL']);
  r = await readAll('Case', {});
  check('a refused read returns null, not an empty list', r, null);

  stub([{ list: rows(200), total: 400 }, 'FAIL']);
  r = await readAll('Case', {});
  check('a failure on page two returns null, not half a list', r, null);

  stub(['THROW']);
  r = await readAll('Case', {});
  check('a thrown error returns null', r, null);

  stub([{ list: rows(200), total: 5000 }, { list: rows(200, 200), total: 5000 }]);
  r = await readAll('Case', {}, 400);
  check('stopped by the caller limit, and admits it', { n: r.list.length, truncated: r.truncated }, { n: 400, truncated: true });

  stub([{ list: rows(200), total: null }, { list: rows(3, 200), total: null }]);
  r = await readAll('Case', {}, 1000);
  check('no total, short second page, still complete', { n: r.list.length, truncated: r.truncated }, { n: 203, truncated: false });

  stub([{ list: [], total: 0 }]);
  r = await readAll('Case', {});
  check('genuinely empty is an empty list, not null', { n: r.list.length, truncated: r.truncated }, { n: 0, truncated: false });

  calls = stub([{ list: rows(200), total: 250 }, { list: rows(50, 200), total: 250 }]);
  await readAll('Meeting', { orderBy: 'dateStart', order: 'asc' });
  check('never asks for more than 200 at once', calls.every(function (c) { return c.maxSize <= 200; }), true);

  console.log('---');
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
