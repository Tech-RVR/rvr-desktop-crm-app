'use strict';

/**
 * Read every record of something, not just the first 200.
 *
 * EspoCRM caps a single list read at 200 (recordListMaxSizeLimit) and answers
 * a bare 403 if you ask for more, so any screen that simply set maxSize: 200
 * was silently showing a partial answer the moment the 201st record existed.
 * The calendar hit this for real on 2026-08-19: a busy month returned only the
 * first 200 appointments, later days looked free, and the double-booking guard
 * would have waved a clash straight through.
 *
 * This is that fix, lifted out of calendar.js so every screen can use it.
 *
 * TWO RULES IT ENFORCES, both learned the hard way:
 *
 * 1. A FAILURE IS NOT AN EMPTY LIST. It returns `null` when the read failed and
 *    `{ list, truncated }` when it worked. Returning [] for a failure is what
 *    made the 2026-08-19 403 invisible. Every caller must branch on null
 *    separately and say "could not load", never "there is nothing".
 *
 * 2. IT ADMITS WHEN IT GAVE UP. `truncated` is true when a ceiling stopped it
 *    before it had everything, so the screen can say so rather than presenting
 *    a short list as the whole picture.
 *
 * Always pass an explicit orderBy. Without one, EspoCRM's own default decides
 * which records survive the cap, so a truncated list can quietly reshuffle
 * between loads as well as being short.
 */
(function () {
  const PAGE = 200;          // EspoCRM's hard ceiling for one read
  const DEFAULT_LIMIT = 2000; // a sane stopping point; raise deliberately, not by accident

  async function readAll(entity, query, limit) {
    const cap = typeof limit === 'number' && limit > 0 ? limit : DEFAULT_LIMIT;
    const list = [];
    try {
      while (list.length < cap) {
        const res = await window.rvr.espo.request(entity, {
          query: Object.assign({}, query, {
            maxSize: Math.min(PAGE, cap - list.length),
            offset: list.length
          })
        });
        if (!(res && res.ok && res.data && Array.isArray(res.data.list))) return null;

        const page = res.data.list;
        list.push.apply(list, page);

        const total = typeof res.data.total === 'number' ? res.data.total : null;
        if (total !== null && list.length >= total) return { list: list, truncated: false, total: total };
        if (page.length === 0) return { list: list, truncated: false, total: total };
        if (page.length < PAGE) return { list: list, truncated: false, total: total };
        if (list.length >= cap) {
          return { list: list, truncated: total === null ? true : total > list.length, total: total };
        }
      }
      return { list: list, truncated: false, total: null };
    } catch (err) {
      // Deliberately falls through to null. A thrown error is a failed read,
      // and a failed read must never look like an empty result.
    }
    return null;
  }

  window.rvrPagedRead = { readAll: readAll, PAGE: PAGE };
})();
