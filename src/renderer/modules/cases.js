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
              <td><b>${ctx.escapeHtml(c.cClientRef || ('#' + c.number))}</b>${c.cClientRef ? ` <small>#${ctx.escapeHtml(c.number)}</small>` : ''}${c.name ? ` — ${ctx.escapeHtml(c.name)}` : ''}</td>
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

  // Same textFilter search operator already proven working elsewhere in this
  // app against Contact (case-new.js/case-detail.js's contact picker) — on
  // EspoCRM this is a generic full-text match, wired by default to the
  // entity's own configured search fields (for Case: number, name, and
  // related contact/company name). Worth a quick live spot-check the first
  // time it's used for real, since this is the first time it's applied to
  // the Case entity specifically in this codebase.
  async function fetchCases(term) {
    const query = {
      select: 'number,cClientRef,name,cCaseStage,contactName,cPropertyAddressStreet,cPropertyAddressCity,cReliefType,cRateableValueBefore,cRateableValueAfter,cAnnualSaving,createdAt,assignedUserId,assignedUserName',
      // 2026-08-28: this used to be 50, and the two panel headings printed
      // "My Cases (n)" / "Team Cases (n)" as though they were real counts -
      // when they were only the split of whichever 50 cases happened to be
      // newest. For David, who sees the whole firm's work, that number could
      // be badly wrong and one of his own live cases simply absent. 200 is
      // EspoCRM's per-request ceiling; the footnote below now reports the
      // true total so a truncated list says so instead of lying quietly.
      maxSize: 200,
      orderBy: 'createdAt',
      order: 'desc'
    };
    if (term) {
      query['where[0][type]'] = 'textFilter';
      query['where[0][value]'] = term;
    }
    return window.rvr.espo.request('Case', { query });
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
        <div class="field" style="max-width:360px;">
          <label for="cases-search">Search</label>
          <input type="text" id="cases-search" placeholder="Search by reference, case number, client or address…" autocomplete="off">
        </div>
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

    const mineListEl = container.querySelector('#cases-mine-list');
    const teamListEl = container.querySelector('#cases-team-list');
    const searchEl = container.querySelector('#cases-search');
    // Belt-and-braces: the router now hands each render its own container, so
    // this should never be null. Bailing out quietly beats throwing if it ever is.
    if (!mineListEl || !teamListEl) return;

    let searchToken = 0;

    function wireRowClicks() {
      container.querySelectorAll('tr.clickable-row').forEach((row) => {
        row.addEventListener('click', () => ctx.openCase(row.dataset.caseId));
      });
    }

    async function runSearch(term) {
      const token = ++searchToken;
      mineListEl.innerHTML = '<div class="loading-state">Loading…</div>';
      teamListEl.innerHTML = '';

      const res = await fetchCases(term.trim());
      if (ctx.isStale() || token !== searchToken) return;

      if (!res.ok) {
        const msg = `<div class="empty-state">Could not load cases (${ctx.escapeHtml(res.message || 'unknown error')}).</div>`;
        mineListEl.innerHTML = msg;
        teamListEl.innerHTML = '';
        return;
      }

      const cases = (res.data && res.data.list) || [];
      // The true number matching, which may be larger than what came back.
      const totalMatching = (res.data && typeof res.data.total === 'number') ? res.data.total : cases.length;
      const truncated = totalMatching > cases.length;
      const myId = ctx.user && ctx.user.id;
      const mine = cases.filter((c) => c.assignedUserId === myId);
      const team = cases.filter((c) => c.assignedUserId !== myId);
      const searching = !!term.trim();

      // 2026-08-28: these counts are of what is ON SCREEN. While the list is
      // truncated they are not the whole picture, so say so rather than
      // printing a number that reads as authoritative and is not.
      container.querySelector('#cases-mine-heading').textContent =
        truncated ? `My Cases (${mine.length} shown)` : `My Cases (${mine.length})`;
      container.querySelector('#cases-team-heading').textContent =
        truncated ? `Team Cases (${team.length} shown)` : `Team Cases (${team.length})`;

      mineListEl.innerHTML = renderTable(mine, ctx, {
        emptyText: searching ? 'No matching cases assigned to you.' : 'No cases assigned to you yet.'
      });
      teamListEl.innerHTML = renderTable(team, ctx, {
        notMine: true,
        emptyText: searching ? 'No other matching team cases.' : 'No other team cases visible right now.'
      });

      const oldNote = container.querySelector('#cases-list-note');
      if (oldNote) oldNote.remove();
      if (cases.length > 0) {
        const note = document.createElement('p');
        note.id = 'cases-list-note';
        note.style.cssText = 'color:var(--muted); font-size:12px; margin-top:4px;';
        note.textContent = truncated
          ? `Showing the ${cases.length} most recent of ${totalMatching} cases. Search to narrow it down. Click a row to open it.`
          : (searching
            ? `Showing all ${cases.length} matching cases, split by who they're assigned to. Click a row to open it.`
            : `Showing all ${cases.length} cases visible to you, split by who they're assigned to. Click a row to open it.`);
        teamListEl.after(note);
      }

      wireRowClicks();
    }

    let debounceTimer = null;
    searchEl.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => runSearch(searchEl.value), 300);
    });

    await runSearch('');
  }

  window.rvrModules.cases = { render };
})();
