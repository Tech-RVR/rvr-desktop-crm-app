'use strict';

(function () {
  // Role id for "Business Rates Consultant/Surveyor", confirmed live in
  // EspoCRM. The surveyor dropdown below is populated dynamically from
  // whoever currently holds this role, so a newly added surveyor shows up
  // automatically without a code change.
  const SURVEYOR_ROLE_ID = '6a6d295e313f68302';

  function pad(n) { return String(n).padStart(2, '0'); }

  function todayDateStr() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function formatDate(dtStr) {
    if (!dtStr) return '—';
    const d = new Date(dtStr.replace(' ', 'T'));
    if (Number.isNaN(d.getTime())) return dtStr;
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function formatTime(dtStr) {
    if (!dtStr) return '';
    const d = new Date(dtStr.replace(' ', 'T'));
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }

  function acceptancePillClass(status) {
    if (status === 'Accepted') return 'pill good';
    if (status === 'Declined') return 'pill bad';
    if (status === 'Tentative') return 'pill warn';
    return 'pill neutral';
  }

  // Users holding the surveyor role, filtered live via role membership
  // (not a hardcoded name list) — mirrors the loadAssignableUsers() pattern
  // in case-detail.js, adapted to filter by role instead of user type.
  async function loadSurveyors() {
    try {
      const res = await window.rvr.espo.request('User', {
        query: {
          'where[0][type]': 'linkedWith',
          'where[0][attribute]': 'roles',
          'where[0][value][]': SURVEYOR_ROLE_ID,
          'where[1][type]': 'equals',
          'where[1][attribute]': 'isActive',
          'where[1][value]': true,
          orderBy: 'name',
          maxSize: 200,
          select: 'id,name'
        }
      });
      if (res && res.ok && res.data && Array.isArray(res.data.list)) return res.data.list;
    } catch (err) { /* fall through to an empty list */ }
    return [];
  }

  async function loadUpcomingMeetings() {
    try {
      const res = await window.rvr.espo.request('Meeting', {
        query: {
          'where[0][type]': 'greaterThanOrEquals',
          'where[0][attribute]': 'dateStart',
          'where[0][value]': `${todayDateStr()} 00:00:00`,
          orderBy: 'dateStart',
          order: 'asc',
          maxSize: 100,
          select: 'id,name,dateStart,dateEnd,assignedUserId,assignedUserName,cLocation,parentId,parentType,parentName,status,acceptanceStatus'
        }
      });
      if (res && res.ok && res.data && Array.isArray(res.data.list)) return res.data.list;
    } catch (err) { /* fall through to an empty list */ }
    return [];
  }

  function renderTable(meetings, ctx) {
    if (meetings.length === 0) {
      return '<div class="empty-state">No upcoming appointments booked.</div>';
    }
    return `
      <table class="data-table">
        <thead><tr>
          <th>Date</th><th>Time</th><th>Surveyor</th><th>Place</th><th>Case</th><th>Status</th><th></th>
        </tr></thead>
        <tbody>
          ${meetings.map((m) => `
            <tr>
              <td>${ctx.escapeHtml(formatDate(m.dateStart))}</td>
              <td>${ctx.escapeHtml(formatTime(m.dateStart))}${m.dateEnd ? ` – ${ctx.escapeHtml(formatTime(m.dateEnd))}` : ''}</td>
              <td>${ctx.escapeHtml(m.assignedUserName || '—')}</td>
              <td>${ctx.escapeHtml(m.cLocation || '—')}</td>
              <td>${m.parentType === 'Case' && m.parentName ? ctx.escapeHtml(m.parentName) : '—'}</td>
              <td><span class="${acceptancePillClass(m.acceptanceStatus)}">${ctx.escapeHtml(m.acceptanceStatus || 'None')}</span></td>
              <td>
                ${ctx.user && m.assignedUserId && ctx.user.id === m.assignedUserId ? `
                  <button class="btn btn-secondary meeting-accept" data-meeting-id="${ctx.escapeHtml(m.id)}">Accept</button>
                  <button class="btn btn-secondary meeting-decline" data-meeting-id="${ctx.escapeHtml(m.id)}">Decline</button>
                ` : ''}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  async function render(container, ctx) {
    container.innerHTML = `
      <div class="module-header">
        <div>
          <h1 class="module-title">Calendar</h1>
          <p class="module-subtitle">Upcoming surveyor site visits and appointments.</p>
        </div>
        <button class="btn btn-primary" id="cal-new">+ Book Appointment</button>
      </div>

      <div class="panel form-panel" id="cal-form-panel" style="display:none;">
        <h3 class="panel-heading">Book Appointment</h3>
        <div class="form-grid">
          <div class="field">
            <label for="cal-date">Date <span class="req">*</span></label>
            <input type="date" id="cal-date">
          </div>
          <div class="field">
            <label for="cal-start">Start time <span class="req">*</span></label>
            <input type="time" id="cal-start">
          </div>
          <div class="field">
            <label for="cal-end">End time <span class="req">*</span></label>
            <input type="time" id="cal-end">
          </div>
          <div class="field">
            <label for="cal-surveyor">Surveyor <span class="req">*</span></label>
            <select id="cal-surveyor"><option value="">Loading surveyors…</option></select>
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
        <div class="form-actions">
          <button class="btn btn-secondary" id="cal-cancel">Cancel</button>
          <button class="btn btn-primary" id="cal-submit">Book appointment</button>
        </div>
      </div>

      <div class="panel">
        <h3 class="panel-heading">Upcoming Appointments</h3>
        <div id="cal-list"><div class="loading-state">Loading…</div></div>
      </div>
    `;

    const el = (id) => container.querySelector(`#${id}`);
    const formPanel = el('cal-form-panel');
    const statusEl = el('cal-status');
    const surveyorSelect = el('cal-surveyor');
    const listEl = el('cal-list');
    const submitBtn = el('cal-submit');

    function showStatus(msg, kind) {
      statusEl.textContent = msg;
      statusEl.className = `status-banner show ${kind}`;
    }

    function resetForm() {
      ['cal-date', 'cal-start', 'cal-end', 'cal-location', 'cal-case', 'cal-notes'].forEach((id) => { el(id).value = ''; });
      surveyorSelect.value = '';
      statusEl.className = 'status-banner';
    }

    el('cal-new').addEventListener('click', () => {
      formPanel.style.display = formPanel.style.display === 'none' ? '' : 'none';
    });
    el('cal-cancel').addEventListener('click', () => {
      resetForm();
      formPanel.style.display = 'none';
    });

    loadSurveyors().then((surveyors) => {
      if (ctx.isStale()) return;
      if (surveyors.length === 0) {
        surveyorSelect.innerHTML = '<option value="">No surveyors found</option>';
        return;
      }
      surveyorSelect.innerHTML = '<option value="">Select a surveyor…</option>' +
        surveyors.map((u) => `<option value="${ctx.escapeHtml(u.id)}">${ctx.escapeHtml(u.name)}</option>`).join('');
    });

    async function setAcceptance(meetingId, status) {
      const res = await window.rvr.espo.request('Meeting/action/setAcceptanceStatus', {
        method: 'POST',
        body: { id: meetingId, status }
      });
      if (ctx.isStale()) return;
      if (res && res.ok) refreshList();
    }

    async function refreshList() {
      listEl.innerHTML = '<div class="loading-state">Loading…</div>';
      const meetings = await loadUpcomingMeetings();
      if (ctx.isStale()) return;
      listEl.innerHTML = renderTable(meetings, ctx);
      listEl.querySelectorAll('.meeting-accept').forEach((btn) => {
        btn.addEventListener('click', () => setAcceptance(btn.dataset.meetingId, 'Accepted'));
      });
      listEl.querySelectorAll('.meeting-decline').forEach((btn) => {
        btn.addEventListener('click', () => setAcceptance(btn.dataset.meetingId, 'Declined'));
      });
    }

    submitBtn.addEventListener('click', async () => {
      const date = el('cal-date').value;
      const start = el('cal-start').value;
      const end = el('cal-end').value;
      const location = el('cal-location').value.trim();
      const surveyorId = surveyorSelect.value;
      const caseId = el('cal-case').value.trim();
      const notes = el('cal-notes').value.trim();

      if (!date || !start || !end) {
        showStatus('Date, start time and end time are all required.', 'err');
        return;
      }
      if (!location) {
        showStatus('Site address is required.', 'err');
        return;
      }
      if (!surveyorId) {
        showStatus('Please select a surveyor.', 'err');
        return;
      }

      const dateStart = `${date} ${start}:00`;
      const dateEnd = `${date} ${end}:00`;
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
      if (caseId) {
        body.parentType = 'Case';
        body.parentId = caseId;
      }

      submitBtn.disabled = true;
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
      resetForm();
      refreshList();
      setTimeout(() => {
        if (ctx.isStale()) return;
        formPanel.style.display = 'none';
      }, 900);
    });

    refreshList();
  }

  window.rvrModules['calendar'] = { render };
})();
