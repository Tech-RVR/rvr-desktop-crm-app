'use strict';

(function () {
  // Matches DOCUMENT_OPTIONS.length in case-detail.js (the full 13-item
  // document checklist) — a case counts as "awaiting documents" while it
  // has fewer than this many entries in cDocumentsReceived.
  const ALL_DOCS_COUNT = 13;

  function money(n) {
    const num = Number(n) || 0;
    return num.toLocaleString('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 });
  }

  async function render(container, ctx) {
    container.innerHTML = `
      <h1 class="module-title">Dashboard</h1>
      <p class="module-subtitle">An overview of your cases, respecting your own EspoCRM role and access.</p>
      <div class="kpis" id="dash-kpis"><div class="loading-state">Loading…</div></div>
      <div class="panel">
        <h2>Cases by stage</h2>
        <p style="color:var(--muted); font-size:12px; margin:-8px 0 12px;"><span class="legend-swatch team-case"></span> Team case — assigned to a colleague, shown here so you can see how far it's got.</p>
        <div class="kanban" id="dash-mini-board"><div class="loading-state">Loading…</div></div>
      </div>
    `;

    try {
      // Broader select than a pure stage-count would need — cDocumentsReceived/
      // cInvoicePaid/cPaymentDueDate/cAnnualSaving are read here so the four
      // KPI cards below can be computed client-side from one request, the
      // same pattern used elsewhere in this app (e.g. cases.js's single list
      // query) rather than four separate round trips.
      const res = await window.rvr.espo.request('Case', {
        query: {
          select: 'number,name,contactName,cCaseStage,cDocumentsReceived,cInvoicePaid,cPaymentDueDate,cAnnualSaving,assignedUserId,assignedUserName',
          maxSize: 200
        }
      });

      if (!res.ok) {
        container.querySelector('#dash-kpis').innerHTML = `<div class="empty-state">Could not load your cases (${ctx.escapeHtml(res.message || 'unknown error')}).</div>`;
        container.querySelector('#dash-mini-board').innerHTML = '';
        return;
      }

      const cases = (res.data && res.data.list) || [];
      const isClosed = (c) => (c.cCaseStage || '').startsWith('Closed');
      const myId = ctx.user && ctx.user.id;
      const isMine = (c) => c.assignedUserId === myId;

      const openCases = cases.filter((c) => !isClosed(c));
      const openCount = openCases.length;
      const myOpenCount = openCases.filter(isMine).length;

      const annualSavings = cases
        .filter((c) => c.cCaseStage === 'Closed')
        .reduce((sum, c) => sum + (Number(c.cAnnualSaving) || 0), 0);

      const awaitingDocs = cases.filter((c) => {
        const docsReceived = Array.isArray(c.cDocumentsReceived) ? c.cDocumentsReceived.length : 0;
        return docsReceived < ALL_DOCS_COUNT && !isClosed(c);
      }).length;

      const today = new Date();
      const overdueInvoices = cases.filter((c) => {
        if (c.cInvoicePaid) return false;
        if (!c.cPaymentDueDate) return false;
        return new Date(c.cPaymentDueDate) < today;
      }).length;

      // Count-only query (maxSize:1, read the `total` EspoCRM always returns
      // on a list response) — distinct from "Awaiting Documents" above,
      // which is about missing checklist categories, not already-uploaded
      // files sitting unverified. See modules/verification.js.
      const pendingVerificationRes = await window.rvr.espo.request('Document', {
        query: {
          'where[0][type]': 'equals',
          'where[0][attribute]': 'cReviewStatus',
          'where[0][value]': 'Pending Review',
          maxSize: 1
        }
      });
      const pendingVerificationCount = (pendingVerificationRes.ok && pendingVerificationRes.data && pendingVerificationRes.data.total) || 0;

      container.querySelector('#dash-kpis').innerHTML = `
        <div class="kpi">
          <div class="label">Open Cases</div>
          <div class="value">${openCount}</div>
          <div class="delta">${myOpenCount} yours &middot; ${openCount - myOpenCount} team's</div>
        </div>
        <div class="kpi">
          <div class="label">Annual Savings Secured</div>
          <div class="value">${money(annualSavings)}</div>
          <div class="delta">across closed cases</div>
        </div>
        <div class="kpi">
          <div class="label">Awaiting Documents</div>
          <div class="value">${awaitingDocs}</div>
          <div class="delta">not yet fully documented</div>
        </div>
        <div class="kpi">
          <div class="label">Overdue Invoices</div>
          <div class="value" style="color:var(--danger)">${overdueInvoices}</div>
          <div class="delta" style="color:var(--danger)">past their payment due date</div>
        </div>
        <div class="kpi kpi-clickable" id="dash-kpi-verification">
          <div class="label">Pending Verification</div>
          <div class="value" style="color:var(--warn)">${pendingVerificationCount}</div>
          <div class="delta">uploaded documents awaiting review &rarr;</div>
        </div>
      `;

      const verificationKpi = container.querySelector('#dash-kpi-verification');
      if (verificationKpi) {
        verificationKpi.addEventListener('click', () => ctx.navigateTo('verification'));
      }

      const stageOrder = window.RVR_STAGE_ORDER || [];
      const byStage = {};
      cases.forEach((c) => {
        const stage = c.cCaseStage || '(no stage set)';
        (byStage[stage] = byStage[stage] || []).push(c);
      });
      const allStages = Array.from(new Set([...stageOrder, ...Object.keys(byStage)]));

      if (cases.length === 0) {
        container.querySelector('#dash-mini-board').innerHTML = '<div class="empty-state">No cases visible to your account yet.</div>';
        return;
      }

      // Mini kanban, same visual shape as the Pipeline board (mirroring the
      // mockup, which reuses one kanban rendering for both the Dashboard's
      // "cases by stage" panel and the full Pipeline view). Capped at 4
      // cards per column here since this is an overview, not the full list —
      // Pipeline is still the place to see every case in a stage.
      container.querySelector('#dash-mini-board').innerHTML = allStages.map((stage) => {
        const stageCases = byStage[stage] || [];
        return `
          <div class="kanban-col">
            <h3>${ctx.escapeHtml(stage)} (${stageCases.length})</h3>
            ${stageCases.slice(0, 4).map((c) => `
              <div class="kanban-card clickable-row${isMine(c) ? '' : ' team-case'}" data-case-id="${ctx.escapeHtml(c.id)}">
                <div class="case-number">#${ctx.escapeHtml(c.number)}</div>
                <div class="case-contact">${ctx.escapeHtml(c.contactName || 'No contact linked')}</div>
                ${isMine(c) ? '' : `<div class="case-assignee">${ctx.escapeHtml(c.assignedUserName || 'Unclaimed')}</div>`}
              </div>
            `).join('') || '<div style="color:var(--muted); font-size:12px; padding:6px 8px;">Empty</div>'}
            ${stageCases.length > 4 ? `<div style="color:var(--muted); font-size:11px; padding:2px 8px;">+${stageCases.length - 4} more</div>` : ''}
          </div>
        `;
      }).join('');

      container.querySelectorAll('#dash-mini-board .clickable-row').forEach((card) => {
        card.addEventListener('click', () => ctx.openCase(card.dataset.caseId));
      });
    } catch (err) {
      container.querySelector('#dash-kpis').innerHTML = '<div class="empty-state">Something went wrong loading the dashboard.</div>';
      container.querySelector('#dash-mini-board').innerHTML = '';
    }
  }

  window.rvrModules.dashboard = { render };
})();
