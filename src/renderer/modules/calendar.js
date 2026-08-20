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

  function todayDateStr() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function dateStrOf(year, month, day) { return `${year}-${pad(month + 1)}-${pad(day)}`; }

  // Meeting datetimes come back as "YYYY-MM-DD HH:MM:SS" (see loadMeetingsFrom
  // below) — fixed-width and zero-padded, so slicing is safe and avoids any
  // timezone ambiguity that constructing Date objects from these strings
  // would introduce.
  function dateOf(dtStr) { return (dtStr || '').slice(0, 10); }
  function timeOf(dtStr) { return (dtStr || '').slice(11, 16); }
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
  async function loadMeetingsFrom(startStr, limit) {
    try {
      const res = await window.rvr.espo.request('Meeting', {
        query: {
          'where[0][type]': 'greaterThanOrEquals',
          'where[0][attribute]': 'dateStart',
          'where[0][value]': startStr,
          orderBy: 'dateStart',
          order: 'asc',
          maxSize: limit,
          select: 'id,name,dateStart,dateEnd,assignedUserId,assignedUserName,cLocation,parentId,parentType,parentName,status,acceptanceStatus,cAcceptanceStatus'
        }
      });
      if (res && res.ok && res.data && Array.isArray(res.data.list)) return res.data.list;
    } catch (err) { /* fall through to the null "could not load" result below */ }
    // NOT an empty array. Returning [] here is what made the 2026-08-19
    // month-view 403 invisible, and — worse — it makes conflictFor() see a
    // surveyor with no appointments, so a failed fetch reads as "everyone is
    // free" and the double-booking guard silently passes. null means "we do
    // not know", and every caller must treat that differently from "empty".
    return null;
  }

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
      m.assignedUserId === surveyorId &&
      m.id !== excludeMeetingId &&
      m.cAcceptanceStatus !== 'Declined' &&
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
              <label for="cal-case">Linked case ID (optional)</label>
              <input type="text" id="cal-case" placeholder="Case ID, if this visit relates to an existing case" autocomplete="off">
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
        const dayMeetings = dayMeetingsFor(dateStr);
        const surveyorIds = [...new Set(dayMeetings.map((m) => m.assignedUserId).filter(Boolean))];
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
      const monthStartStr = `${dateStrOf(year, month, 1)} 00:00:00`;
      const nextMonth = month === 11 ? { y: year + 1, m: 0 } : { y: year, m: month + 1 };
      const nextMonthStartStr = `${dateStrOf(nextMonth.y, nextMonth.m, 1)} 00:00:00`;
      // EspoCRM's API hard-caps maxSize at 200 per request (recordListMaxSizeLimit,
      // default Espo\Core\Record\SearchParamsFetcher::MAX_SIZE_LIMIT) and returns a
      // bare 403 for anything over that, regardless of how many records actually
      // match. 300 always tripped it — every month-grid load 403'd and silently
      // fell back to an empty list (see loadMeetingsFrom's catch). 200 is the
      // most a single request can ask for; if a month ever has more meetings than
      // that, this will need real pagination (offset) rather than a bigger number.
      const fetched = await loadMeetingsFrom(monthStartStr, 200);
      if (fetched === null) {
        state.monthLoadFailed = true;
        state.monthMeetings = [];
        return;
      }
      state.monthLoadFailed = false;
      state.monthMeetings = fetched.filter((m) => m.dateStart < nextMonthStartStr);
    }

    async function loadMonth(year, month) {
      state.viewYear = year;
      state.viewMonth = month;
      daysEl.innerHTML = '<div class="loading-state">Loading…</div>';
      await ensureMonthLoaded(year, month);
      if (ctx.isStale()) return;
      renderMonthGrid();
      if (state.monthLoadFailed) {
        showStatus('Could not load this month\u2019s appointments, so the calendar below is not showing existing bookings. New bookings are blocked until it loads, to avoid double-booking a surveyor. Try switching month, or reopening the Calendar.', 'err');
      }
    }

    function renderEventRow(m) {
      const color = surveyorColor(m.assignedUserId);
      const canRespond = ctx.user && m.assignedUserId && ctx.user.id === m.assignedUserId;
      return `
        <div class="cal-event-row">
          <div class="cal-event-time">${ctx.escapeHtml(formatTimeRange(timeOf(m.dateStart), timeOf(m.dateEnd)))}</div>
          <div class="chip-avatar" style="background:${color}; margin-right:4px;" title="${ctx.escapeHtml(m.assignedUserName || 'Unassigned')}">${ctx.escapeHtml(initialsOf(m.assignedUserName))}</div>
          <div class="cal-event-main">
            <div class="cal-event-place">${ctx.escapeHtml(m.cLocation || '—')}</div>
            <div class="cal-event-meta">
              ${ctx.escapeHtml(m.assignedUserName || 'Unassigned')}
              ${m.parentType === 'Case' && m.parentName ? ` · <span class="cal-case-link" data-case-id="${ctx.escapeHtml(m.parentId)}" style="cursor:pointer; text-decoration:underline;">${ctx.escapeHtml(m.parentName)}</span>` : ''}
              · <span class="${acceptancePillClass(m.cAcceptanceStatus)}">${ctx.escapeHtml((m.cAcceptanceStatus && m.cAcceptanceStatus !== 'None') ? m.cAcceptanceStatus : 'Pending')}</span>
            </div>
          </div>
          ${canRespond ? `
            <div>
              <button class="btn btn-secondary btn-sm meeting-accept" data-meeting-id="${ctx.escapeHtml(m.id)}">Accept</button>
              <button class="btn btn-secondary btn-sm meeting-decline" data-meeting-id="${ctx.escapeHtml(m.id)}">Decline</button>
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
      }
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
      const meetings = await loadMeetingsFrom(`${todayDateStr()} 00:00:00`, 100);
      if (ctx.isStale()) return;
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
                <td>${ctx.escapeHtml(new Date(`${dateOf(m.dateStart)}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }))}</td>
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
      if (state.monthLoadFailed) {
        // The re-check above is the last line of defence against a double
        // booking. If it could not read the existing appointments, refuse
        // rather than book blind — a blocked booking is recoverable, two
        // surveyors sent to different sites at the same time is not.
        submitBtn.disabled = false;
        submitBtn.textContent = 'Book appointment';
        showStatus('Not booked \u2014 the existing appointments for this month could not be loaded, so this surveyor\u2019s availability cannot be checked. Please try again in a moment.', 'err');
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

      const dateStart = `${dateStr} ${start}:00`;
      const dateEnd = `${dateStr} ${end}:00`;
      const token = Math.random().toString(36).slice(2) + Date.now().toString(36);

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
      if (caseId) { body.parentType = 'Case'; body.parentId = caseId; }

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
