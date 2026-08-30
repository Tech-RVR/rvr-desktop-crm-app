'use strict';

/**
 * Bookings — every site visit and where it has got to.
 *
 * Tyrone's ask: "show site visits and what stage each one is at, alongside
 * Dashboard, Cases and Messages."
 *
 * The Calendar screen answers "what is happening on the 12th". This one answers
 * "what have we got booked, and is it actually going to happen" — which is a
 * different question and needs a list, not a grid.
 *
 * Two things it deliberately keeps separate, because this app has been bitten
 * by conflating them before:
 *   - a read that FAILED and a genuinely EMPTY list are different states with
 *     different words on screen;
 *   - the visit's own status (is it still on?) and the surveyor's answer (have
 *     they said yes?) are two different columns. A visit nobody has accepted is
 *     not the same as a cancelled one, and hiding that behind one label is how
 *     a visit ends up with nobody attending.
 */
(function () {
  // Visits are attached to a Case, an Account, a Lead, a Contact or an
  // Opportunity. Only the Case ones can show a case stage, and only they open
  // a case when clicked.
  function isCaseVisit(m) { return m && m.parentType === 'Case' && m.parentId; }

  function visitStatus(m) {
    if (!m) return { label: '—', tone: 'muted' };
    if (m.status === 'Not Held') return { label: 'Cancelled', tone: 'bad' };
    if (m.status === 'Held') return { label: 'Done', tone: 'good' };
    return { label: 'Booked', tone: 'muted' };
  }

  // cAcceptanceStatus is what the surveyor's Accept/Decline email writes.
  // 'None' is the unanswered value, not a missing field.
  function surveyorAnswer(m) {
    const raw = String((m && m.cAcceptanceStatus) || '').trim();
    if (raw === 'Accepted') return { label: 'Accepted', tone: 'good' };
    if (raw === 'Declined') return { label: 'Declined', tone: 'bad' };
    return { label: 'No answer yet', tone: 'warn' };
  }

  function toneStyle(tone) {
    if (tone === 'good') return 'color:#1c7c4a;font-weight:600;';
    if (tone === 'bad') return 'color:#a63d2f;font-weight:600;';
    if (tone === 'warn') return 'color:#8a6d1f;font-weight:600;';
    return 'color:var(--slate);';
  }

  function when(value) {
    try { return window.rvrTime.formatDateTime(value); } catch (e) { return String(value || '—'); }
  }

  async function render(container, ctx) {
    container.innerHTML = `
      <h1 class="module-title">Bookings</h1>
      <p class="module-subtitle">Site visits, who is going, and whether they have said yes.</p>
      <div id="bookings-note" style="margin:0 0 12px;color:var(--slate);font-size:13px;"></div>
      <div id="bookings-body"><div class="loading-state">Loading…</div></div>
    `;

    const body = container.querySelector('#bookings-body');
    const note = container.querySelector('#bookings-note');
    if (!body) return;

    // From the start of today, so a visit happening this morning is still here.
    const from = window.rvrTime.crmDayStart
      ? window.rvrTime.crmDayStart(new Date())
      : new Date().toISOString().slice(0, 10) + ' 00:00:00';

    const read = await window.rvrPagedRead.readAll('Meeting', {
      'where[0][type]': 'greaterThanOrEquals',
      'where[0][attribute]': 'dateStart',
      'where[0][value]': from,
      orderBy: 'dateStart',
      order: 'asc',
      select: 'id,name,dateStart,dateEnd,status,cAcceptanceStatus,cLocation,assignedUserId,assignedUserName,parentId,parentType,parentName'
    });

    if (ctx.isStale && ctx.isStale()) return;

    // A failed read must never be shown as "nothing booked".
    if (read === null) {
      body.innerHTML = '<div class="empty-state">Could not load the bookings. This is a problem reading them, not an empty diary — please try again, and tell the office if it keeps happening.</div>';
      return;
    }

    const visits = read.list;
    if (read.truncated) {
      note.textContent = 'There are more bookings than this screen can read in one go. The soonest are shown.';
    }

    if (visits.length === 0) {
      body.innerHTML = '<div class="empty-state">No site visits booked from today onwards.</div>';
      return;
    }

    // Pull the stage for the cases these visits hang off. One read, not one per
    // row. If it fails the table still renders — a missing stage is worth far
    // less than the booking itself, so it must not take the screen down with it.
    const caseIds = Array.from(new Set(visits.filter(isCaseVisit).map((m) => m.parentId)));
    const stageById = {};
    if (caseIds.length) {
      const caseRead = await window.rvrPagedRead.readAll('Case', {
        'where[0][type]': 'in',
        'where[0][attribute]': 'id',
        'where[0][value]': caseIds,
        orderBy: 'number',
        order: 'asc',
        select: 'id,number,cCaseStage,contactName'
      });
      if (caseRead && Array.isArray(caseRead.list)) {
        caseRead.list.forEach((c) => { stageById[c.id] = c; });
      }
    }
    if (ctx.isStale && ctx.isStale()) return;

    body.innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th>When</th>
            <th>Case</th>
            <th>Client</th>
            <th>Surveyor</th>
            <th>Where</th>
            <th>Visit</th>
            <th>Surveyor's answer</th>
            <th>Case stage</th>
          </tr>
        </thead>
        <tbody>
          ${visits.map((m) => {
            const st = visitStatus(m);
            const ans = surveyorAnswer(m);
            const c = isCaseVisit(m) ? stageById[m.parentId] : null;
            const caseCell = isCaseVisit(m)
              ? `<span class="clickable-row" data-case-id="${ctx.escapeHtml(m.parentId)}" style="cursor:pointer;text-decoration:underline;">${ctx.escapeHtml(c && c.number ? ('#' + c.number) : (m.parentName || 'Case'))}</span>`
              : `<span style="color:var(--slate);">${ctx.escapeHtml(m.parentType ? (m.parentName || m.parentType) : 'Not linked to a case')}</span>`;
            return `
              <tr>
                <td>${ctx.escapeHtml(when(m.dateStart))}</td>
                <td>${caseCell}</td>
                <td>${ctx.escapeHtml((c && c.contactName) || m.parentName || '—')}</td>
                <td>${ctx.escapeHtml(m.assignedUserName || 'Nobody assigned')}</td>
                <td>${ctx.escapeHtml(m.cLocation || '—')}</td>
                <td><span style="${toneStyle(st.tone)}">${ctx.escapeHtml(st.label)}</span></td>
                <td><span style="${toneStyle(ans.tone)}">${ctx.escapeHtml(ans.label)}</span></td>
                <td>${ctx.escapeHtml((c && c.cCaseStage) || '—')}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;

    body.querySelectorAll('.clickable-row[data-case-id]').forEach((el) => {
      el.addEventListener('click', () => ctx.openCase(el.dataset.caseId));
    });
  }

  window.rvrModules.bookings = { render: render };
})();
