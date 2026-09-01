'use strict';

(function () {
  // Role id for "Business Rates Consultant/Surveyor", confirmed live in
  // EspoCRM. The surveyor picker below is populated dynamically from
  // whoever currently holds this role, so a newly added surveyor shows up
  // automatically without a code change.
  const SURVEYOR_ROLE_ID = '6a6d295e313f68302';

  // Business-hours slot grid used for the "available time slots" dropdown.
  // There's no per-surveyor working-hours record in EspoCRM to read yet, so
  // this is a fixed 09:00-17:00, one-hour-slot grid. Change DAY_START_HOUR /
  // DAY_END_HOUR / SLOT_MINUTES here if that ever needs to differ.
  const DAY_START_HOUR = 9;
  const DAY_END_HOUR = 17;
  const SLOT_MINUTES = 60;

  // One colour per surveyor, assigned deterministically from their user id
  // so it's stable across sessions/reloads without needing a colour field on
  // the User record. Deliberately distinct from the status colours already
  // in use (--ok green = Accepted, --danger red = Declined, --warn amber =
  // Tentative) so a surveyor's colour is never confused with a status.
  const SURVEYOR_PALETTE = [
    '#3b6ea8', '#7a4fb5', '#c2570c', '#1f8f7a',
    '#a63d7a', '#5b7f1f', '#2b6f79', '#8a5a2b'
  ];

  function pad(n) { return String(n).padStart(2, '0'); }

  // 2026-08-29: today in BRITAIN, not in whatever timezone the machine is set
  // to. Tyrone's own machine was set to UTC, which is exactly how this kind of
  // fault stays invisible to the person testing it.
  function todayDateStr() { return window.rvrTime.todayDateStr(); }

  function dateStrOf(year, month, day) { return `${year}-${pad(month + 1)}-${pad(day)}`; }

  // Meeting datetimes come back as "YYYY-MM-DD HH:MM:SS" with no timezone
  // marker on the end, and EspoCRM stores them as UTC.
  // 2026-08-29: these used to slice the raw string, which showed whatever the
  // CRM had stored. The CRM stores UTC, so through British Summer Time every
  // appointment on this screen read an hour early, and one stored late in the
  // evening showed on the wrong day entirely. They now convert properly.
  function dateOf(dtStr) { return window.rvrTime.dateOf(dtStr); }
  function timeOf(dtStr) { return window.rvrTime.timeOf(dtStr); }
  function minutesOfDay(hhmm) {
    const parts = String(hhmm || '0:0').split(':');
    return (Number(parts[0]) || 0) * 60 + (Number(parts[1]) || 0);
  }
  function meetingMinuteRange(m) {
    const start = minutesOfDay(timeOf(m.dateStart));
    const end = m.dateEnd ? minutesOfDay(timeOf(m.dateEnd)) : start + SLOT_MINUTES;
    return { start, end: Math.max(end, start + 1) };
  }
  function rangesOverlap(aStart, aEnd, bStart, bEnd) { return aStart < bEnd && bStart < aEnd; }

  function formatDateLong(dateStr) {
    if (!dateStr) return '—';
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(y, (m || 1) - 1, d || 1);
    if (Number.isNaN(dt.getTime())) return dateStr;
    return dt.toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
  }

  function formatTimeRange(startHHMM, endHHMM) { return endHHMM ? `${startHHMM}–${endHHMM}` : startHHMM; }

  function acceptancePillClass(status) {
    if (status === 'Accepted') return 'pill good';
    if (status === 'Declined') return 'pill bad';
    if (status === 'Tentative') return 'pill warn';
    return 'pill neutral';
  }

  function surveyorColor(id) {
    let hash = 0;
    const s = String(id || '');
    for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
    return SURVEYOR_PALETTE[hash % SURVEYOR_PALETTE.length];
  }

  function initialsOf(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function buildSlots() {
    const slots = [];
    for (let mins = DAY_START_HOUR * 60; mins + SLOT_MINUTES <= DAY_END_HOUR * 60; mins += SLOT_MINUTES) {
      const start = `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
      const end = `${pad(Math.floor((mins + SLOT_MINUTES) / 60))}:${pad((mins + SLOT_MINUTES) % 60)}`;
      slots.push({ start, end });
    }
    return slots;
  }

  // Users holding the surveyor role, filtered live via role membership (not
  // a hardcoded name list) — this is what restricts the booking picker to
  // surveyors only.
  //
  // EspoCRM unconditionally rejects any `where` filter that targets the
  // `roles` link (a blanket request-validation restriction, not an ACL
  // check -- it fires before ACL even runs, and even a fully-privileged API
  // key gets the same bare 400, `X-Status-Reason: "Forbidden link 'roles'
  // in where."`). So instead of filtering server-side on `roles`, this
  // fetches every active regular staff member (the same proven filter
  // shape as case-detail.js's loadAssignableUsers(): `type: 'regular'` +
  // `isActive: true`) with `rolesIds` included, then filters to the
  // Surveyor role client-side. Same visible behaviour, different mechanism.
  async function loadSurveyors() {
    try {
      const res = await window.rvr.espo.request('User', {
        query: {
          'where[0][type]': 'equals',
          'where[0][attribute]': 'type',
          'where[0][value]': 'regular',
          // 'isTrue', NOT equals+true. `query` is serialised with
          // URLSearchParams, so a JS boolean becomes the STRING "true", and
          // EspoCRM's `equals` comparison against a real bool column then
          // matches nothing at all — a silent, total wipe of the result set
          // rather than an error. Proven live 2026-08-20 with a throwaway
          // account: equals+true -> total 0, isTrue -> total 7.
          'where[1][type]': 'isTrue',
          'where[1][attribute]': 'isActive',
          orderBy: 'name',
          maxSize: 200,
          select: 'id,name,rolesIds'
        }
      });
      if (res && res.ok && res.data && Array.isArray(res.data.list)) {
        return res.data.list.filter((u) => Array.isArray(u.rolesIds) && u.rolesIds.includes(SURVEYOR_ROLE_ID));
      }
    } catch (err) { /* fall through to the null "could not load" result below */ }
    // null, not [] — an empty surveyor list and a failed surveyor lookup look
    // identical to the booking form otherwise, and "No surveyors found" is a
    // misleading thing to tell someone whose request actually 403'd. Same
    // reasoning as loadMeetingsFrom below.
    return null;
  }

  // Fetches every Meeting from startStr onward, ordered ascending, up to
  // `limit`. Only 'greaterThanOrEquals' is used as a server-side filter —
  // that's the only comparison operator already proven against this
  // EspoCRM instance elsewhere in the app (see case-detail.js/case-new.js),
  // so any additional narrowing (an upper date bound, a single day) is done
  // client-side on the returned list rather than guessing at an unverified
  // 'lessThan'-style operator name.
  // 2026-08-28: this asked for one page of `limit` records and took whatever
  // came back. EspoCRM caps a page at 200, so a month with more than 200
  // appointments returned exactly 200 and the calendar treated that as the
  // whole month -- every appointment past the 200th was invisible, those days
  // looked free, and the double-booking guard would have waved a clash
  // straight through. It now pages with `offset` and, when it still cannot
  // read everything, says so (`truncated`) instead of quietly returning a
  // partial answer that looks complete.
  //
  // Returns { list, truncated } on success, or null when the read FAILED --
  // never an empty array for a failure. Returning [] here is what made the
  // 2026-08-19 month-view 403 invisible, and -- worse -- it makes
  // conflictFor() see a surveyor with no appointments, so a failed fetch
  // reads as "everyone is free" and the double-booking guard silently
  // passes. Every caller must treat null and empty differently.
  const MEETINGS_PAGE_SIZE = 200; // EspoCRM's recordListMaxSizeLimit

  async function loadMeetingsFrom(startStr, limit) {
    const list = [];
    try {
      while (list.length < limit) {
        const res = await window.rvr.espo.request('Meeting', {
          query: {
            'where[0][type]': 'greaterThanOrEquals',
            'where[0][attribute]': 'dateStart',
            'where[0][value]': startStr,
            orderBy: 'dateStart',
            order: 'asc',
            maxSize: Math.min(MEETINGS_PAGE_SIZE, limit - list.length),
            offset: list.length,
            select: 'id,name,dateStart,dateEnd,assignedUserId,assignedUserName,cLocation,parentId,parentType,parentName,status,acceptanceStatus,cAcceptanceStatus,usersIds'
          }
        });
        if (!(res && res.ok && res.data && Array.isArray(res.data.list))) return null;
        const page = res.data.list;
        list.push(...page);
        const total = typeof res.data.total === 'number' ? res.data.total : null;
        if (total !== null && list.length >= total) return { list, truncated: false };
        if (page.length < MEETINGS_PAGE_SIZE) return { list, truncated: false };
        if (list.length >= limit) return { list, truncated: total === null ? true : total > list.length };
      }
      return { list, truncated: false };
    } catch (err) { /* fall through to the null "could not load" result below */ }
    return null;
  }

  // A cancelled visit ("Not Held") is not a booking any more. It must not
  // block a slot (see conflictFor), must not put a dot on the month grid and
  // must not sit in Upcoming Appointments as though someone is attending it.
  // It is still listed inside the day pop-up, marked cancelled, so nothing
  // vanishes without explanation.
  function isLiveBooking(m) { return m && m.status !== 'Not Held'; }

  function buildMonthCells(year, month) {
    const firstWeekday = new Date(year, month, 1).getDay(); // 0=Sun..6=Sat
    const leadBlanks = (firstWeekday + 6) % 7; // convert to a Monday-first grid
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysInPrevMonth = new Date(year, month, 0).getDate();
    const cells = [];
    for (let i = leadBlanks - 1; i >= 0; i--) {
      const day = daysInPrevMonth - i;
      const m = month === 0 ? 11 : month - 1;
      const y = month === 0 ? year - 1 : year;
      cells.push({ year: y, month: m, day, otherMonth: true });
    }
    for (let day = 1; day <= daysInMonth; day++) cells.push({ year, month, day, otherMonth: false });
    while (cells.length % 7 !== 0) {
      const last = cells[cells.length - 1];
      const next = new Date(last.year, last.month, last.day + 1);
      cells.push({ year: next.getFullYear(), month: next.getMonth(), day: next.getDate(), otherMonth: true });
    }
    return cells;
  }

  // A surveyor is unavailable for a slot if any of their OWN meetings that
  // day overlap it and haven't been declined. A declined meeting frees the
  // slot back up; anything else (booked, pending, tentative) blocks it —
  // better to force a conscious rebook than risk a silent double-booking.
  function conflictFor(surveyorId, slotStart, slotEnd, dayMeetings, excludeMeetingId) {
    return dayMeetings.find((m) => (
      // 2026-08-28: this only ever matched the ASSIGNED user, so a visit
      // created in the EspoCRM web UI or by an automation with the surveyor
      // as an attendee - assigned to whoever booked it - was invisible here
      // and the surveyor was shown as free. Bookings made through this screen
      // set both, so this is belt and braces for anything created elsewhere.
      // `usersIds` is now in the select at loadMeetingsFrom; if EspoCRM ever
      // stops returning it, this degrades to exactly the old behaviour.
      (m.assignedUserId === surveyorId
        || (Array.isArray(m.usersIds) && m.usersIds.indexOf(surveyorId) !== -1)) &&
      m.id !== excludeMeetingId &&
      m.cAcceptanceStatus !== 'Declined' &&
      // 2026-08-28: `status` was fetched and then never read, so an abandoned
      // or cancelled visit blocked that surveyor's slot for ever with the
      // tooltip "Already booked", forcing a pointless rebook - and still drew
      // a dot on the month grid as though it were live.
      m.status !== 'Not Held' &&
      rangesOverlap(minutesOfDay(slotStart), minutesOfDay(slotEnd), meetingMinuteRange(m).start, meetingMinuteRange(m).end)
    )) || null;
  }

  async function render(container, ctx) {
    const today = new Date();
    const state = {
      viewYear: today.getFullYear(),
      viewMonth: today.getMonth(),
      monthMeetings: [],
      // True when the last month fetch failed outright (permissions, network,
      // an API cap). While this is true the calendar must not present itself
      // as an authoritative view of who is free — see ensureMonthLoaded and
      // the booking submit handler.
      monthLoadFailed: false,
      // True when the month loaded but we know we did not get all of it (more
      // appointments than the API will hand over). Treated exactly like a
      // failure for booking purposes — see the submit handler.
      monthTruncated: false,
      surveyors: [],
      // Same distinction as monthLoadFailed, for the surveyor lookup.
      surveyorsLoadFailed: false,
      selectedDate: null,
      selectedSurveyorId: null
    };

    container.innerHTML = `
      <div class="module-header">
        <div>
          <h1 class="module-title">Calendar</h1>
          <p class="module-subtitle">Surveyor site visits — tap a date to view or book an appointment.</p>
        </div>
        <button class="btn btn-primary" id="cal-today-book">+ Book Appointment</button>
      </div>

      <div class="panel">
        <div class="cal-toolbar">
          <button class="btn btn-secondary cal-nav-btn" id="cal-prev" aria-label="Previous month">&larr;</button>
          <h2 id="cal-month-label"></h2>
          <button class="btn btn-secondary cal-nav-btn" id="cal-next" aria-label="Next month">&rarr;</button>
        </div>
        <div class="cal-grid cal-weekdays" id="cal-weekdays"></div>
        <div class="cal-grid cal-days" id="cal-days"><div class="loading-state">Loading…</div></div>
        <div class="cal-legend" id="cal-legend"></div>
      </div>

      <div class="panel">
        <h3 class="panel-heading">Upcoming Appointments</h3>
        <div id="cal-upcoming"><div class="loading-state">Loading…</div></div>
      </div>

      <div class="modal-backdrop cal-day-modal" id="cal-day-modal">
        <div class="modal">
          <h2 id="cal-modal-title">Appointments</h2>
          <div id="cal-modal-events"></div>

          <div class="panel form-panel" id="cal-form-panel" style="display:none; margin-top:14px; padding:14px;">
            <h3 class="panel-heading">Book Appointment</h3>
            <div class="field">
              <label>Date</label>
              <div id="cal-form-date-display" style="font-size:14px; padding:2px 0 6px;"></div>
            </div>
            <div class="field">
              <label for="cal-slot">Time slot <span class="req">*</span></label>
              <select id="cal-slot"><option value="">Select a time slot…</option></select>
            </div>
            <div class="field">
              <label>Surveyor <span class="req">*</span></label>
              <div class="surveyor-chip-row" id="cal-surveyor-chips">
                <span class="field-hint">Pick a time slot to see who's available.</span>
              </div>
            </div>
            <div class="field">
              <label for="cal-location">Site address <span class="req">*</span></label>
              <input type="text" id="cal-location" placeholder="Property being surveyed" autocomplete="off">
            </div>
            <div class="field">
              <label for="cal-case">Linked case <span class="req">*</span></label>
              <input type="text" id="cal-case" placeholder="Case number, e.g. 104" autocomplete="off">
              <span class="field-hint">The case number shown on the Cases screen. Every site visit has to be attached to a case.</span>
            </div>
            <div class="field">
              <label for="cal-notes">Notes</label>
              <textarea id="cal-notes" rows="3" placeholder="Anything the surveyor should know before attending."></textarea>
            </div>
            <div class="status-banner" id="cal-status"></div>
            <div class="form-actions" style="margin:4px 0 0;">
              <button class="btn btn-secondary" id="cal-cancel">Cancel</button>
              <button class="btn btn-primary" id="cal-submit">Book appointment</button>
            </div>
          </div>

          <div class="modal-actions">
            <button class="btn btn-secondary" id="cal-modal-book-toggle">+ Book appointment</button>
            <button class="btn btn-secondary" id="cal-modal-close">Close</button>
          </div>
        </div>
      </div>
    `;

    const el = (id) => container.querySelector(`#${id}`);
    const monthLabelEl = el('cal-month-label');
    const weekdaysEl = el('cal-weekdays');
    const daysEl = el('cal-days');
    const legendEl = el('cal-legend');
    const upcomingEl = el('cal-upcoming');
    const modalEl = el('cal-day-modal');
    const modalTitleEl = el('cal-modal-title');
    const modalEventsEl = el('cal-modal-events');
    const formPanel = el('cal-form-panel');
    const formDateDisplay = el('cal-form-date-display');
    const slotSelect = el('cal-slot');
    const surveyorChipsEl = el('cal-surveyor-chips');
    const statusEl = el('cal-status');
    const submitBtn = el('cal-submit');

    weekdaysEl.innerHTML = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
      .map((d) => `<div class="cal-weekday">${d}</div>`).join('');

    function showStatus(msg, kind) {
      statusEl.textContent = msg;
      statusEl.className = `status-banner show ${kind}`;
    }

    // 2026-08-28: showStatus writes into #cal-status, which lives inside
    // #cal-form-panel (display:none) inside #cal-day-modal (a hidden
    // backdrop). So the careful fail-closed messages this screen produces had
    // nowhere visible to go: a month that failed to load painted a completely
    // empty grid, offered "3 surveyors available" on every slot, and only
    // told anyone at the final Book click. This puts the same message
    // somewhere a person can actually see it.
    function showMonthBanner(msg) {
      let b = container.querySelector('#cal-month-banner');
      if (!b) {
        b = document.createElement('div');
        b.id = 'cal-month-banner';
        daysEl.parentNode.insertBefore(b, daysEl);
      }
      b.className = 'status-banner show err';
      b.textContent = msg;
    }

    function clearMonthBanner() {
      const b = container.querySelector('#cal-month-banner');
      if (b) b.remove();
    }

    // Used where a failure can happen with the day pop-up open - the message
    // goes to every place the user might be looking.
    function showAnywhere(msg) {
      showStatus(msg, 'err');
      showMonthBanner(msg);
      const openModal = container.querySelector('#cal-day-modal.show');
      if (openModal && modalEventsEl) {
        let mb = container.querySelector('#cal-modal-banner');
        if (!mb) {
          mb = document.createElement('div');
          mb.id = 'cal-modal-banner';
          modalEventsEl.parentNode.insertBefore(mb, modalEventsEl);
        }
        mb.className = 'status-banner show err';
        mb.textContent = msg;
      }
    }

    function dayMeetingsFor(dateStr) {
      return state.monthMeetings.filter((m) => dateOf(m.dateStart) === dateStr);
    }

    function renderLegend() {
      if (state.surveyors.length === 0) {
        legendEl.innerHTML = state.surveyorsLoadFailed
          ? '<span class="field-hint">Could not load the surveyor list.</span>'
          : '<span class="field-hint">No surveyors found.</span>';
        return;
      }
      legendEl.innerHTML = state.surveyors.map((u) => `
        <span class="cal-legend-item">
          <span class="cal-legend-dot" style="background:${surveyorColor(u.id)}"></span>${ctx.escapeHtml(u.name)}
        </span>
      `).join('');
    }

    function renderMonthGrid() {
      monthLabelEl.textContent = new Date(state.viewYear, state.viewMonth, 1)
        .toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

      const cells = buildMonthCells(state.viewYear, state.viewMonth);
      const todayStr = todayDateStr();

      daysEl.innerHTML = cells.map((c) => {
        const dateStr = dateStrOf(c.year, c.month, c.day);
        // 2026-08-28: cancelled visits were still dotted here, so a day that
        // had been called off still read as booked at a glance. Also, a visit
        // the surveyor only ATTENDS (assigned to whoever booked it) was
        // coloured by the booker, whose colour is not even in the legend -
        // use everyone involved instead.
        const dayMeetings = dayMeetingsFor(dateStr).filter(isLiveBooking);
        const surveyorIds = [...new Set(dayMeetings.reduce((acc, m) => {
          if (m.assignedUserId) acc.push(m.assignedUserId);
          if (Array.isArray(m.usersIds)) acc.push(...m.usersIds);
          return acc;
        }, []).filter(Boolean))];
        const shown = surveyorIds.slice(0, 4);
        const extra = surveyorIds.length - shown.length;
        const classes = ['cal-day'];
        if (c.otherMonth) classes.push('other-month');
        if (dateStr === todayStr) classes.push('today');
        if (dateStr === state.selectedDate) classes.push('selected');
        return `
          <div class="${classes.join(' ')}" data-date="${dateStr}">
            <div class="cal-day-num">${c.day}</div>
            <div class="cal-day-dots">
              ${shown.map((id) => `<span class="cal-dot" style="background:${surveyorColor(id)}"></span>`).join('')}
              ${extra > 0 ? `<span class="cal-day-more">+${extra}</span>` : ''}
            </div>
          </div>
        `;
      }).join('');

      daysEl.querySelectorAll('.cal-day').forEach((cell) => {
        cell.addEventListener('click', () => openDate(cell.dataset.date));
      });
    }

    async function ensureMonthLoaded(year, month) {
      const nextMonth = month === 11 ? { y: year + 1, m: 0 } : { y: year, m: month + 1 };
      // EspoCRM's API hard-caps maxSize at 200 per request (recordListMaxSizeLimit,
      // default Espo\Core\Record\SearchParamsFetcher::MAX_SIZE_LIMIT) and returns a
      // bare 403 for anything over that, regardless of how many records actually
      // match. 300 always tripped it — every month-grid load 403'd and silently
      // fell back to an empty list (see loadMeetingsFrom's catch). 200 is the
      // most a single request can ask for; if a month ever has more meetings than
      // that, this will need real pagination (offset) rather than a bigger number.
      // 2026-08-28: the grid draws the tail of the previous month and the
      // head of the next as grey lead-in / lead-out days, but the data was
      // trimmed to this month exactly - so those days ALWAYS looked free,
      // whether or not anything was booked. This is a calendar people scan
      // rather than click, so an at-a-glance read of "1-3 September are
      // clear" was simply wrong. Fetch a week either side and keep it.
      // 2026-08-29: both bounds are now BRITISH midnight, converted to the UTC
      // the CRM actually stores and compares against. Built the same way so the
      // start bound (which is sent to the CRM) and the end bound (which is only
      // compared here) can never disagree by an hour.
      const pad = (n) => String(n).padStart(2, '0');
      const dayStr = (dt) => `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
      const windowStart = new Date(Date.UTC(year, month, 1));
      windowStart.setUTCDate(windowStart.getUTCDate() - 7);
      const windowStartStr = window.rvrTime.crmDayStart(dayStr(windowStart));
      const windowEnd = new Date(Date.UTC(nextMonth.y, nextMonth.m, 1));
      windowEnd.setUTCDate(windowEnd.getUTCDate() + 7);
      const windowEndStr = window.rvrTime.crmDayStart(dayStr(windowEnd));

      // 1000 = five full pages. Far more than a real month of site visits,
      // and a hard stop so a runaway data set can never spin here.
      const fetched = await loadMeetingsFrom(windowStartStr, 1000);
      if (fetched === null) {
        state.monthLoadFailed = true;
        state.monthTruncated = false;
        state.monthMeetings = [];
        return;
      }
      state.monthLoadFailed = false;
      state.monthTruncated = fetched.truncated;
      state.monthMeetings = fetched.list.filter((m) => m.dateStart < windowEndStr);
    }

    async function loadMonth(year, month) {
      state.viewYear = year;
      state.viewMonth = month;
      daysEl.innerHTML = '<div class="loading-state">Loading…</div>';
      await ensureMonthLoaded(year, month);
      if (ctx.isStale()) return;
      renderMonthGrid();
      if (state.monthLoadFailed) {
        const msg = 'Could not load this month\u2019s appointments, so the calendar below is NOT showing existing bookings \u2014 an empty day here does not mean the day is free. New bookings are blocked until it loads, to avoid double-booking a surveyor. Try switching month, or reopening the Calendar.';
        showStatus(msg, 'err');
        showMonthBanner(msg);
      } else if (state.monthTruncated) {
        const msg = 'There are more appointments this month than this screen can read in one go, so some are not shown and an empty slot here may not really be free. New bookings are blocked while that is true, to avoid double-booking a surveyor. Please report this — it needs a change to the app.';
        showStatus(msg, 'err');
        showMonthBanner(msg);
      } else {
        clearMonthBanner();
      }
    }

    function renderEventRow(m) {
      const color = surveyorColor(m.assignedUserId);
      // No point offering Accept/Decline on a visit that has been called off.
      const canRespond = ctx.user && m.assignedUserId && ctx.user.id === m.assignedUserId && isLiveBooking(m);
      // 2026-09-01: an answered appointment still showed both buttons, so a
      // surveyor who had already accepted could click Accept again and get
      // nothing, or click Decline with no warning that they were reversing
      // themselves. Reported by Tyrone as "once it has been accepted it is
      // still able to be clicked and accepted and declined".
      //
      // The button for the answer already given is dropped, and the other one
      // says "instead" so it reads as a change of mind rather than a first
      // answer. Deliberately NOT hiding both: a surveyor who accepts and then
      // cannot attend has to be able to say so, and taking the control away
      // would push that conversation into a phone call nobody records.
      const answer = (m.cAcceptanceStatus && m.cAcceptanceStatus !== 'None') ? m.cAcceptanceStatus : null;
      return `
        <div class="cal-event-row">
          <div class="cal-event-time">${ctx.escapeHtml(formatTimeRange(timeOf(m.dateStart), timeOf(m.dateEnd)))}</div>
          <div class="chip-avatar" style="background:${color}; margin-right:4px;" title="${ctx.escapeHtml(m.assignedUserName || 'Unassigned')}">${ctx.escapeHtml(initialsOf(m.assignedUserName))}</div>
          <div class="cal-event-main">
            <div class="cal-event-place">${ctx.escapeHtml(m.cLocation || '—')}</div>
            <div class="cal-event-meta">
              ${ctx.escapeHtml(m.assignedUserName || 'Unassigned')}
              ${m.parentType === 'Case' && m.parentName ? ` · <span class="cal-case-link" data-case-id="${ctx.escapeHtml(m.parentId)}" style="cursor:pointer; text-decoration:underline;">${ctx.escapeHtml(m.parentName)}</span>` : ''}
              · ${isLiveBooking(m)
                ? `<span class="${acceptancePillClass(m.cAcceptanceStatus)}">${ctx.escapeHtml((m.cAcceptanceStatus && m.cAcceptanceStatus !== 'None') ? m.cAcceptanceStatus : 'Pending')}</span>`
                : '<span class="pill neutral">Cancelled</span>'}
            </div>
          </div>
          ${canRespond ? `
            <div>
              ${answer !== 'Accepted' ? `<button class="btn btn-secondary btn-sm meeting-accept" data-meeting-id="${ctx.escapeHtml(m.id)}">${answer ? 'Accept instead' : 'Accept'}</button>` : ''}
              ${answer !== 'Declined' ? `<button class="btn btn-secondary btn-sm meeting-decline" data-meeting-id="${ctx.escapeHtml(m.id)}">${answer ? 'Decline instead' : 'Decline'}</button>` : ''}
            </div>
          ` : ''}
        </div>
      `;
    }

    async function setAcceptance(meetingId, status) {
      // Deliberately NOT using Meeting/action/setAcceptanceStatus here: that's
      // a self-service EspoCRM action which only ever sets the acceptance
      // status of the currently-authenticated user, and only works if
      // they're an invitee on the Meeting. cAcceptanceStatus is a plain
      // custom field, so a normal PATCH lets any authorized user record the
      // response — this mirrors how the emailed Accept/Decline links work.
      const res = await window.rvr.espo.request(`Meeting/${meetingId}`, {
        method: 'PATCH',
        body: { cAcceptanceStatus: status }
      });
      if (ctx.isStale()) return;
      if (res && res.ok) {
        await ensureMonthLoaded(state.viewYear, state.viewMonth);
        if (ctx.isStale()) return;
        renderMonthGrid();
        openDate(state.selectedDate, { keepForm: true });
        refreshUpcoming();
        return;
      }
      // 2026-08-28: there was no else branch at all. A refused update - which
      // is what a surveyor gets on a colleague's appointment, since Meeting
      // edit is scoped to their own - produced absolutely nothing on screen,
      // so they clicked Accept, saw it still say Pending, and clicked again.
      showAnywhere(
        (res && res.message)
          || 'That response could not be saved. If this is a colleague\u2019s appointment, only the surveyor it is assigned to can accept or decline it.'
      );
    }

    function wireEventRows(scopeEl) {
      scopeEl.querySelectorAll('.meeting-accept').forEach((btn) => {
        btn.addEventListener('click', () => setAcceptance(btn.dataset.meetingId, 'Accepted'));
      });
      scopeEl.querySelectorAll('.meeting-decline').forEach((btn) => {
        btn.addEventListener('click', () => setAcceptance(btn.dataset.meetingId, 'Declined'));
      });
      scopeEl.querySelectorAll('.cal-case-link').forEach((el2) => {
        el2.addEventListener('click', () => ctx.openCase(el2.dataset.caseId));
      });
    }

    function renderSlotOptions(dateStr) {
      // 2026-08-28: renderLegend and renderSurveyorChips both honour
      // surveyorsLoadFailed and say honestly that availability could not be
      // read. This one did not - with no surveyors loaded, every slot from
      // 09:00 to 17:00 rendered "- fully booked" and disabled, so staff
      // concluded there was no capacity that day and could not even reach the
      // message that would have told them otherwise, because it only appears
      // once a slot is picked and no slot could be picked.
      if (state.surveyors.length === 0) {
        slotSelect.innerHTML = state.surveyorsLoadFailed
          ? '<option value="">Surveyor availability could not be loaded \u2014 booking is unavailable</option>'
          : '<option value="">No surveyors found</option>';
        return;
      }
      const dayMeetings = dayMeetingsFor(dateStr);
      const slots = buildSlots();
      slotSelect.innerHTML = '<option value="">Select a time slot…</option>' + slots.map((s) => {
        const availableCount = state.surveyors.filter((u) => !conflictFor(u.id, s.start, s.end, dayMeetings)).length;
        const full = availableCount === 0;
        return `<option value="${s.start}|${s.end}" ${full ? 'disabled' : ''}>
          ${s.start}–${s.end} ${full ? '— fully booked' : `(${availableCount} surveyor${availableCount === 1 ? '' : 's'} available)`}
        </option>`;
      }).join('');
    }

    function renderSurveyorChips(dateStr, slotStart, slotEnd) {
      if (!slotStart) {
        surveyorChipsEl.innerHTML = '<span class="field-hint">Pick a time slot to see who\'s available.</span>';
        state.selectedSurveyorId = null;
        return;
      }
      const dayMeetings = dayMeetingsFor(dateStr);
      if (state.surveyors.length === 0) {
        surveyorChipsEl.innerHTML = state.surveyorsLoadFailed
          ? '<span class="field-hint">Could not load the surveyor list \u2014 this is not the same as there being none. Try reopening the Calendar; if it keeps happening, report it.</span>'
          : '<span class="field-hint">No surveyors found.</span>';
        return;
      }
      surveyorChipsEl.innerHTML = state.surveyors.map((u) => {
        const conflict = conflictFor(u.id, slotStart, slotEnd, dayMeetings);
        const color = surveyorColor(u.id);
        const selected = state.selectedSurveyorId === u.id;
        const title = conflict
          ? `Already booked ${ctx.escapeHtml(formatTimeRange(timeOf(conflict.dateStart), timeOf(conflict.dateEnd)))} at ${ctx.escapeHtml(conflict.cLocation || 'another site')}`
          : ctx.escapeHtml(u.name);
        return `
          <button type="button" class="surveyor-chip${selected ? ' selected' : ''}${conflict ? ' busy' : ''}"
            data-surveyor-id="${ctx.escapeHtml(u.id)}" ${conflict ? 'disabled' : ''} title="${title}">
            <span class="chip-avatar" style="background:${color}">${ctx.escapeHtml(initialsOf(u.name))}</span>
            ${ctx.escapeHtml(u.name)}${conflict ? ' — busy' : ''}
          </button>
        `;
      }).join('');

      surveyorChipsEl.querySelectorAll('.surveyor-chip:not(.busy)').forEach((chip) => {
        chip.addEventListener('click', () => {
          state.selectedSurveyorId = chip.dataset.surveyorId;
          renderSurveyorChips(dateStr, slotStart, slotEnd);
        });
      });
    }

    function resetForm() {
      slotSelect.value = '';
      el('cal-location').value = '';
      el('cal-case').value = '';
      el('cal-notes').value = '';
      state.selectedSurveyorId = null;
      renderSurveyorChips(state.selectedDate, null, null);
      statusEl.className = 'status-banner';
    }

    function openDate(dateStr, opts) {
      opts = opts || {};
      const inView = dateStr.startsWith(`${state.viewYear}-${pad(state.viewMonth + 1)}`);
      const proceed = () => {
        state.selectedDate = dateStr;
        modalTitleEl.textContent = formatDateLong(dateStr);
        const dayMeetings = dayMeetingsFor(dateStr).sort((a, b) => a.dateStart.localeCompare(b.dateStart));
        modalEventsEl.innerHTML = dayMeetings.length
          ? dayMeetings.map(renderEventRow).join('')
          : '<div class="empty-state">No appointments booked for this day.</div>';
        wireEventRows(modalEventsEl);
        formDateDisplay.textContent = formatDateLong(dateStr);
        renderSlotOptions(dateStr);
        if (!opts.keepForm) {
          formPanel.style.display = 'none';
          resetForm();
        } else {
          renderSurveyorChips(dateStr, null, null);
        }
        renderMonthGrid();
        modalEl.classList.add('show');
        if (opts.openForm) {
          formPanel.style.display = '';
        }
      };
      if (!inView) {
        const [y, m] = dateStr.split('-').map(Number);
        loadMonth(y, m - 1).then(() => { if (!ctx.isStale()) proceed(); });
      } else {
        proceed();
      }
    }

    function closeModal() {
      modalEl.classList.remove('show');
      formPanel.style.display = 'none';
    }

    el('cal-prev').addEventListener('click', () => {
      const m = state.viewMonth === 0 ? 11 : state.viewMonth - 1;
      const y = state.viewMonth === 0 ? state.viewYear - 1 : state.viewYear;
      loadMonth(y, m);
    });
    el('cal-next').addEventListener('click', () => {
      const m = state.viewMonth === 11 ? 0 : state.viewMonth + 1;
      const y = state.viewMonth === 11 ? state.viewYear + 1 : state.viewYear;
      loadMonth(y, m);
    });
    el('cal-today-book').addEventListener('click', () => openDate(todayDateStr(), { openForm: true }));
    el('cal-modal-book-toggle').addEventListener('click', () => {
      formPanel.style.display = formPanel.style.display === 'none' ? '' : 'none';
    });
    el('cal-modal-close').addEventListener('click', closeModal);
    el('cal-cancel').addEventListener('click', () => { resetForm(); formPanel.style.display = 'none'; });
    modalEl.addEventListener('click', (e) => { if (e.target === modalEl) closeModal(); });

    slotSelect.addEventListener('change', () => {
      const [start, end] = slotSelect.value ? slotSelect.value.split('|') : [null, null];
      state.selectedSurveyorId = null;
      renderSurveyorChips(state.selectedDate, start, end);
    });

    async function refreshUpcoming() {
      upcomingEl.innerHTML = '<div class="loading-state">Loading…</div>';
      // British midnight today, expressed the way the CRM stores it.
      const fetched = await loadMeetingsFrom(window.rvrTime.crmDayStart(todayDateStr()), 200);
      if (ctx.isStale()) return;
      // Cancelled visits are not upcoming appointments. They stay visible in
      // the day pop-up, marked cancelled, but nobody is attending them.
      const meetings = fetched === null ? null : fetched.list.filter(isLiveBooking);
      if (meetings === null) {
        upcomingEl.innerHTML = '<div class="empty-state">Could not load upcoming appointments \u2014 this is not the same as there being none. Try reopening the Calendar; if it keeps happening, report it.</div>';
        return;
      }
      if (meetings.length === 0) {
        upcomingEl.innerHTML = '<div class="empty-state">No upcoming appointments booked.</div>';
        return;
      }
      upcomingEl.innerHTML = `
        <table class="data-table">
          <thead><tr><th>Date</th><th>Time</th><th>Surveyor</th><th>Place</th><th>Case</th><th>Status</th></tr></thead>
          <tbody>
            ${meetings.map((m) => `
              <tr class="clickable-row" data-date="${dateOf(m.dateStart)}">
                <td>${ctx.escapeHtml(window.rvrTime.formatDate(dateOf(m.dateStart)))}</td>
                <td>${ctx.escapeHtml(formatTimeRange(timeOf(m.dateStart), timeOf(m.dateEnd)))}</td>
                <td>
                  <span class="chip-avatar chip-avatar-sm" style="background:${surveyorColor(m.assignedUserId)}">${ctx.escapeHtml(initialsOf(m.assignedUserName))}</span>
                  ${ctx.escapeHtml(m.assignedUserName || '—')}
                </td>
                <td>${ctx.escapeHtml(m.cLocation || '—')}</td>
                <td>${m.parentType === 'Case' && m.parentName ? ctx.escapeHtml(m.parentName) : '—'}</td>
                <td><span class="${acceptancePillClass(m.cAcceptanceStatus)}">${ctx.escapeHtml((m.cAcceptanceStatus && m.cAcceptanceStatus !== 'None') ? m.cAcceptanceStatus : 'Pending')}</span></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
      upcomingEl.querySelectorAll('.clickable-row').forEach((row) => {
        row.addEventListener('click', () => openDate(row.dataset.date));
      });
    }

    submitBtn.addEventListener('click', async () => {
      const dateStr = state.selectedDate;
      const [start, end] = slotSelect.value ? slotSelect.value.split('|') : [null, null];
      const location = el('cal-location').value.trim();
      const surveyorId = state.selectedSurveyorId;
      const caseId = el('cal-case').value.trim();
      const notes = el('cal-notes').value.trim();

      if (!start) { showStatus('Please select a time slot.', 'err'); return; }
      if (!location) { showStatus('Site address is required.', 'err'); return; }
      if (!surveyorId) { showStatus('Please select an available surveyor.', 'err'); return; }

      // Re-check for a conflict right before booking, against a freshly
      // reloaded day, not just the possibly-stale in-memory list — closes
      // the race where two staff book the same surveyor/slot at almost the
      // same moment. This is what makes double-booking actually impossible,
      // not just visually discouraged.
      submitBtn.disabled = true;
      submitBtn.textContent = 'Checking availability…';
      await ensureMonthLoaded(state.viewYear, state.viewMonth);
      if (ctx.isStale()) return;
      if (state.monthLoadFailed || state.monthTruncated) {
        // The re-check above is the last line of defence against a double
        // booking. If it could not read the existing appointments, refuse
        // rather than book blind — a blocked booking is recoverable, two
        // surveyors sent to different sites at the same time is not.
        submitBtn.disabled = false;
        submitBtn.textContent = 'Book appointment';
        showStatus(state.monthTruncated
          ? 'Not booked \u2014 there are more appointments this month than this screen can read in one go, so this surveyor\u2019s availability cannot be checked properly. Please report this.'
          : 'Not booked \u2014 the existing appointments for this month could not be loaded, so this surveyor\u2019s availability cannot be checked. Please try again in a moment.', 'err');
        return;
      }
      const freshConflict = conflictFor(surveyorId, start, end, dayMeetingsFor(dateStr));
      if (freshConflict) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Book appointment';
        showStatus('That surveyor now has a conflicting booking for this slot — pick another slot or surveyor.', 'err');
        renderSlotOptions(dateStr);
        renderSurveyorChips(dateStr, start, end);
        return;
      }

      // 2026-08-28: whatever was typed in the case box was attached to the
      // Meeting without ever being checked. A typo, a case number typed where
      // an id was wanted, or a stray space produced a booking silently linked
      // to nothing - and nobody found out until someone went looking for the
      // visit on the case. Look it up first, accept a plain case NUMBER as
      // well as an id, and refuse to book rather than link to thin air.
      // 2026-09-01: THE CASE IS NOW COMPULSORY, because the CRM says so.
      // Meeting.parent is `required: true` on this instance (read live from
      // Metadata; the required list is name, dateStart, dateEnd, parent,
      // assignedUser). A booking with an empty case box therefore came back
      // as "Field validation failure; entityType: Meeting, field: parent,
      // type: required." and NOTHING WAS CREATED - which is why Tyrone booked
      // a visit on the Calendar and then could not find it on Bookings.
      // Confirmed twice: the 400 is in data/logs/espo-2026-08-31.log at
      // 07:40:12, and the app reported the same failure to App Error Tracking
      // in the same second.
      //
      // Same treatment as New Case got on 2026-08-30 when the contact became
      // compulsory: refuse up front with a sentence that means something,
      // rather than letting the person hit a bare validation failure from the
      // CRM. The old copy actively told them to leave the box empty, which
      // has been impossible since parent became required.
      let resolvedCase = null;
      if (!caseId) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Book appointment';
        showStatus('Not booked — every site visit has to be attached to a case. Copy the case number from the Cases screen into the case box.', 'err');
        return;
      }
      {
        const looksLikeNumber = /^[0-9]+$/.test(caseId);
        const lookup = looksLikeNumber
          ? await window.rvr.espo.request('Case', {
            query: {
              select: 'id,name,number',
              'where[0][type]': 'equals',
              'where[0][attribute]': 'number',
              'where[0][value]': Number(caseId),
              maxSize: 2
            }
          })
          : await window.rvr.espo.request(`Case/${encodeURIComponent(caseId)}`, {});
        if (ctx.isStale()) return;
        const found = looksLikeNumber
          ? ((lookup && lookup.ok && lookup.data && lookup.data.list) || [])[0]
          : (lookup && lookup.ok ? lookup.data : null);
        if (!found || !found.id) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Book appointment';
          showStatus(`Not booked — no case matches "${caseId}". Copy the case number from the Cases screen.`, 'err');
          return;
        }
        resolvedCase = found;
      }

      // 2026-08-29: THE SHARP EDGE OF THE WHOLE TIMEZONE MOVE.
      // This used to send the digits the user picked straight through, so a
      // 9am booking was stored as 9am UTC. Once the CRM is on Europe/London
      // that same record reads as 10am in the CRM and in the client's
      // confirmation email - a surveyor sent to a site an hour after the
      // client is expecting them. The picked time is a BRITISH wall clock;
      // it is converted to the instant it actually is before being stored.
      const dateStart = window.rvrTime.crmStampFromUk(dateStr, start);
      const dateEnd = window.rvrTime.crmStampFromUk(dateStr, end);
      if (!dateStart || !dateEnd) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Book appointment';
        showStatus('Not booked — that date and time could not be read. Please pick the slot again.', 'err');
        return;
      }
      // 2026-08-29: this used to be Math.random() + Date.now(), which is
      // guessable and, worse, not a fixed length - Math.random() can return a
      // short base-36 string, and the automation that checks the link refuses
      // anything under 16 characters. The automation now makes its own link
      // when one is missing or too short, so this is belt and braces, but it
      // should still produce a proper one: 32 hex characters from the
      // browser's cryptographic random source.
      const tokenBytes = new Uint8Array(16);
      crypto.getRandomValues(tokenBytes);
      const token = Array.from(tokenBytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

      const body = {
        name: `Site Visit — ${location}`,
        dateStart,
        dateEnd,
        assignedUserId: surveyorId,
        usersIds: [surveyorId],
        status: 'Planned',
        cLocation: location,
        cResponseToken: token
      };
      if (notes) body.description = notes;
      if (resolvedCase) { body.parentType = 'Case'; body.parentId = resolvedCase.id; }

      submitBtn.textContent = 'Booking…';
      showStatus('Booking the appointment…', 'info');

      const res = await window.rvr.espo.request('Meeting', { method: 'POST', body });

      submitBtn.disabled = false;
      submitBtn.textContent = 'Book appointment';

      if (ctx.isStale()) return;

      if (!res.ok) {
        showStatus(res.message || 'Could not book the appointment. Please try again.', 'err');
        return;
      }

      showStatus('Appointment booked.', 'ok');
      await ensureMonthLoaded(state.viewYear, state.viewMonth);
      if (ctx.isStale()) return;
      renderMonthGrid();
      refreshUpcoming();
      openDate(dateStr, { keepForm: false });
    });

    await loadMonth(state.viewYear, state.viewMonth);
    if (ctx.isStale()) return;
    const loadedSurveyors = await loadSurveyors();
    state.surveyorsLoadFailed = loadedSurveyors === null;
    state.surveyors = loadedSurveyors || [];
    if (ctx.isStale()) return;
    renderLegend();
    renderMonthGrid();
    refreshUpcoming();
  }

  window.rvrModules['calendar'] = { render };
})();
