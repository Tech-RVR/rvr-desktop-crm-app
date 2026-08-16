'use strict';

(function () {
  function money(n) {
    if (n === null || n === undefined || n === '') return '—';
    const num = Number(n);
    if (Number.isNaN(num)) return String(n);
    return num.toLocaleString('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 });
  }

  // Renders one cases table. `notMine` adds the "assigned to someone else"
  // treatment (a left accent border + an Assigned To column) so a caseworker
  // scanning the Team Cases panel can tell at a glance these aren't theirs,
  // without needing to read every row's assignee name to know that.
  function renderTable(cases, ctx, opts) {
    const notMine = !!(opts && opts.notMine);
    if (cases.length === 0) {
      return `<div class="empty-state">${opts && opts.emptyText ? opts.emptyText : 'No cases here.'}</div>`;
    }
    return `
      <table class="data-table">
        <thead><tr>
          <th>Case</th><th>Client</th><th>Property</th><th>Stage</th>
          ${notMine ? '<th>Assigned To</th>' : ''}
          <th>Relief Type</th><th>RV Before &rarr; After</th><th>Annual Saving</th>
        </tr></thead>
        <tbody>
          ${cases.map((c) => `
            <tr class="clickable-row${notMine ? ' team-case-row' : ''}" data-case-id="${ctx.escapeHtml(c.id)}">
              <td><b>#${ctx.escapeHtml(c.number)}</b>${c.name ? ` — ${ctx.escapeHtml(c.name)}` : ''}</td>
              <td>${ctx.escapeHtml(c.contactName || '—')}</td>
              <td>${ctx.escapeHtml([c.cPropertyAddressStreet, c.cPropertyAddressCity].filter(Boolean).join(', ') || '—')}</td>
              <td><span class="${window.rvrStageBadgeClass(c.cCaseStage)}">${ctx.escapeHtml(c.cCaseStage || 'No stage set')}</span></td>
              ${notMine ? `<td><span class="pill neutral">${ctx.escapeHtml(c.assignedUserName || 'Unclaimed')}</span></td>` : ''}
              <td>${ctx.escapeHtml(c.cReliefType || '—')}</td>
              <td class="money">${c.cRateableValueBefore || c.cRateableValueAfter ? `${money(c.cRateableValueBefore)} &rarr; ${money(c.cRateableValueAfter)}` : '—'}</td>
              <td class="money save-pos">${c.cAnnualSaving ? money(c.cAnnualSaving) : '—'}</td>
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
          <h1 class="module-title">Cases</h1>
          <p class="module-subtitle">Cases visible to your account, per your EspoCRM role and access.</p>
        </div>
        <button class="btn btn-primary" id="cases-new">+ New case</button>
      </div>
      <div class="panel">
        <h3 class="panel-heading" id="cases-mine-heading">My Cases</h3>
        <div id="cases-mine-list"><div class="loading-state">Loading…</div></div>
      </div>
      <div class="panel">
        <h3 class="panel-heading" id="cases-team-heading">Team Cases</h3>
        <p style="color:var(--muted); font-size:12px; margin:-6px 0 12px;">Cases your team can see but aren't assigned to you. You can open these to check progress and update the contact's details — you can't edit the case itself unless it's assigned to you.</p>
        <div id="cases-team-list"><div class="loading-state">Loading…</div></div>
      </div>
    `;

    container.querySelector('#cases-new').addEventListener('click', () => ctx.navigateTo('case-new'));

    const res = await window.rvr.espo.request('Case', {
      query: {
        select: 'number,name,cCaseStage,contactName,cPropertyAddressStreet,cPropertyAddressCity,cReliefType,cRateableValueBefore,cRateableValueAfter,cAnnualSaving,createdAt,assignedUserId,assignedUserName',
        maxSize: 50,
        orderBy: 'createdAt',
        order: 'desc'
      }
    });

    const mineListEl = container.querySelector('#cases-mine-list');
    const teamListEl = container.querySelector('#cases-team-list');
    // Belt-and-braces: the router now hands each render its own container, so
    // this should never be null. Bailing out quietly beats throwing if it ever is.
    if (!mineListEl || !teamListEl) return;

    if (!res.ok) {
      const msg = `<div class="empty-state">Could not load cases (${ctx.escapeHtml(res.message || 'unknown error')}).</div>`;
      mineListEl.innerHTML = msg;
      teamListEl.innerHTML = '';
      return;
    }

    const cases = (res.data && res.data.list) || [];
    const myId = ctx.user && ctx.user.id;
    const mine = cases.filter((c) => c.assignedUserId === myId);
    const team = cases.filter((c) => c.assignedUserId !== myId);

    container.querySelector('#cases-mine-heading').textContent = `My Cases (${mine.length})`;
    container.querySelector('#cases-team-heading').textContent = `Team Cases (${team.length})`;

    mineListEl.innerHTML = renderTable(mine, ctx, { emptyText: 'No cases assigned to you yet.' });
    teamListEl.innerHTML = renderTable(team, ctx, { notMine: true, emptyText: "No other team cases visible right now." });

    if (cases.length > 0) {
      const note = document.createElement('p');
      note.style.cssText = 'color:var(--muted); font-size:12px; margin-top:4px;';
      note.textContent = 'Showing the 50 most recent cases visible to you, split by who they’re assigned to. Click a row to open it.';
      teamListEl.after(note);
    }

    container.querySelectorAll('tr.clickable-row').forEach((row) => {
      row.addEventListener('click', () => ctx.openCase(row.dataset.caseId));
    });
  }

  window.rvrModules.cases = { render };
})();
