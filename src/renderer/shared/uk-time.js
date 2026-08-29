'use strict';

/**
 * UK time — the one place this app converts between what EspoCRM stores and
 * what a person in Britain reads on the screen.
 *
 * WHY THIS EXISTS (2026-08-29)
 *
 * EspoCRM hands a datetime back over the API as "2026-08-28 09:00:00" with no
 * timezone marker on the end, and stores it as UTC. JavaScript parses a string
 * in that shape as LOCAL time. Until now this app made both mistakes at once:
 * it read the string as local and printed it back as local, so the digits that
 * came out were the digits that went in and every screen agreed with every
 * other screen. Internally consistent, and an hour out for seven months of the
 * year.
 *
 * The moment the CRM's own timeZone setting becomes Europe/London, EspoCRM
 * starts converting and this app does not — so the CRM shows 10:00 for a visit
 * this app shows as 09:00. Read AND write have to be fixed together, in the
 * same release, or a 9am booking gets stored as 9am UTC and the client is told
 * to expect a surveyor at 10.
 *
 * Everything here works off the browser's own Intl database, so it follows the
 * BST/GMT switch by itself. No library, no hardcoded +1.
 */

(function () {
  const TZ = 'Europe/London';

  function pad(n) { return String(n).padStart(2, '0'); }

  // Split an instant into its Europe/London wall-clock parts.
  function londonParts(date) {
    const dtf = new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    const out = {};
    dtf.formatToParts(date).forEach((p) => { out[p.type] = p.value; });
    return {
      year: Number(out.year),
      month: Number(out.month),
      day: Number(out.day),
      // Some browsers render midnight as "24" under hour12:false.
      hour: Number(out.hour) % 24,
      minute: Number(out.minute),
      second: Number(out.second)
    };
  }

  // How far ahead of UTC London is at this instant: 0 in winter, +1h in summer.
  function londonOffsetMs(date) {
    const p = londonParts(date);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
      - (date.getTime() - date.getMilliseconds());
  }

  // ---- READING what the CRM gave us -------------------------------------

  // "2026-08-28 09:00:00" -> a real instant. Anything already carrying a
  // marker (a trailing Z, or +01:00) is left alone and parsed as-is.
  function parseCrm(value) {
    if (!value) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    const s = String(value).trim();
    if (!s) return null;
    // A date with no time at all is a plain calendar date, not an instant.
    // Treat it as midday UTC so no timezone shift can move it to another day.
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const d = new Date(s + 'T12:00:00Z');
      return Number.isNaN(d.getTime()) ? null : d;
    }
    const hasZone = /[Zz]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s);
    const d = new Date(s.replace(' ', 'T') + (hasZone ? '' : 'Z'));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // "YYYY-MM-DD" as it falls in Britain.
  function dateOf(value) {
    const d = parseCrm(value);
    if (!d) return '';
    const p = londonParts(d);
    return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  }

  // "HH:MM" as it reads on a British clock.
  function timeOf(value) {
    const d = parseCrm(value);
    if (!d) return '';
    const p = londonParts(d);
    return `${pad(p.hour)}:${pad(p.minute)}`;
  }

  function formatDate(value, opts) {
    const d = parseCrm(value);
    if (!d) return '—';
    return d.toLocaleDateString('en-GB', Object.assign(
      { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric' }, opts || {}
    ));
  }

  function formatTime(value) {
    const d = parseCrm(value);
    if (!d) return '—';
    return d.toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  }

  function formatDateTime(value) {
    const d = parseCrm(value);
    if (!d) return '—';
    const time = formatTime(d);
    return isToday(d) ? time : `${formatDate(d)}, ${time}`;
  }

  function isToday(value) {
    const d = parseCrm(value);
    if (!d) return false;
    const a = londonParts(d);
    const b = londonParts(new Date());
    return a.year === b.year && a.month === b.month && a.day === b.day;
  }

  // Today's date in Britain, as "YYYY-MM-DD".
  function todayDateStr() {
    const p = londonParts(new Date());
    return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  }

  // ---- WRITING something the CRM will store correctly --------------------

  // Turn a British wall-clock moment into the instant it actually is.
  // Applied twice so a guess that lands on the wrong side of a clock change
  // is corrected. This is the sharp edge of the whole exercise: get it wrong
  // and a 9am booking is stored as an hour later than everyone intended.
  function ukWallClockToDate(y, m, d, hh, mm, ss) {
    const wall = Date.UTC(y, m - 1, d, hh || 0, mm || 0, ss || 0);
    let ts = wall;
    for (let i = 0; i < 2; i++) ts = wall - londonOffsetMs(new Date(ts));
    return new Date(ts);
  }

  // "YYYY-MM-DD HH:MM:SS" in UTC — the shape EspoCRM expects on a write.
  function toCrmStamp(date) {
    if (!date) return null;
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
      + ` ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  }

  // The two the app actually calls when saving.
  // ("2026-09-11", "09:00") -> "2026-09-11 08:00:00" during British Summer Time.
  function crmStampFromUk(dateStr, hhmm) {
    const [y, m, d] = String(dateStr || '').split('-').map(Number);
    const [hh, mm] = String(hhmm || '00:00').split(':').map(Number);
    if (!y || !m || !d) return null;
    return toCrmStamp(ukWallClockToDate(y, m, d, hh || 0, mm || 0, 0));
  }

  // A whole-day boundary: British midnight, expressed the way the CRM stores it.
  function crmDayStart(dateStr) { return crmStampFromUk(dateStr, '00:00'); }

  window.rvrTime = {
    TZ,
    parseCrm,
    dateOf,
    timeOf,
    formatDate,
    formatTime,
    formatDateTime,
    isToday,
    todayDateStr,
    ukWallClockToDate,
    toCrmStamp,
    crmStampFromUk,
    crmDayStart,
    londonOffsetMs,
    londonParts
  };
})();
