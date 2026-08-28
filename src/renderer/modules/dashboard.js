'use strict';

(function () {
  // Fallback only — a case counts as "awaiting documents" while it has fewer
  // entries in cDocumentsReceived than the full checklist has options. The
  // real count is fetched live from EspoCRM's own Metadata (same principle
  // as case-detail.js's loadDocumentOptions) so this can never silently
  // drift out of sync with the CRM's actual cDocumentsReceived enum.
  const ALL_DOCS_COUNT_FALLBACK = 14;

  async function loadAllDocsCount() {
    try {
      const res = await window.rvr.espo.request('Metadata');
      const opts = res && res.ok && res.data && res.data.entityDefs
        && res.data.entityDefs.Case && res.data.entityDefs.Case.fields
        && res.data.entityDefs.Case.fields.cDocumentsReceived
        && res.data.entityDefs.Case.fields.cDocumentsReceived.options;
      if (Array.isArray(opts) && opts.length) return opts.length;
    } catch (err) { /* fall through to the baked-in count */ }
    return ALL_DOCS_COUNT_FALLBACK;
  }

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
      // 2026-08-28: this was ONE request capped at 200 with no paging, and
      // the `total` EspoCRM returns was fetched and never read. Closed cases
      // accumulate forever and are exactly what falls off the end, so the
      // first visible symptom would have been "Annual Savings Secured"
      // starting to go DOWN over time - the hardest kind of number to
      // disbelieve. Page through instead. 200 is EspoCRM's hard ceiling per
      // request; anything above it comes back as a bare 403.
      async function loadAllCases() {
        const PAGE = 200;
        const MAX_PAGES = 25; // 5,000 cases - far beyond realistic volume
        const all = [];
        for (let page = 0; page < MAX_PAGES; page += 1) {
          const pageRes = await window.rvr.espo.request('Case', {
            query: {
              select: 'number,name,contactName,cCaseStage,cDocumentsReceived,cInvoicePaid,cPaymentDueDate,cAnnualSaving,assignedUserId,assignedUserName',
              orderBy: 'createdAt',
              order: 'desc',
              maxSize: PAGE,
              offset: page * PAGE
            }
          });
          if (!pageRes.ok) return pageRes;
          const list = (pageRes.data && pageRes.data.list) || [];
          all.push(...list);
          const total = pageRes.data && pageRes.data.total;
          if (list.length < PAGE || (typeof total === 'number' && all.length >= total)) break;
        }
        return { ok: true, data: { list: all } };
      }

      const [res, allDocsCount] = await Promise.all([
        loadAllCases(),
        loadAllDocsCount()
      ]);

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
        return docsReceived < allDocsCount && !isClosed(c);
      }).length;

      // 2026-08-28: cPaymentDueDate is a DATE, not a datetime - EspoCRM
      // returns "2026-08-27". `new Date()` on that yields midnight, which was
      // then compared against the current MOMENT, so from just after midnight
      // an invoice due TODAY was already counted overdue and shown in red.
      // Against a two-day payment window, a whole day early is a third of it.
      // Compare date strings: both are YYYY-MM-DD, so this is exact and has
      // no timezone in it at all.
      const pad = (n) => String(n).padStart(2, '0');
      const now = new Date();
      const todayIso = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      const overdueInvoices = cases.filter((c) => {
        if (c.cInvoicePaid) return false;
        if (!c.cPaymentDueDate) return false;
        return String(c.cPaymentDueDate).slice(0, 10) < todayIso;
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
      // 2026-08-28: this used to collapse a FAILED read into 0, so a
      // permission problem or a server error rendered as a confident amber
      // zero saying "nothing waiting on you". null means "could not find
      // out", and the card renders a dash instead of a number.
      const pendingVerificationCount = pendingVerificationRes.ok
        ? ((pendingVerificationRes.data && pendingVerificationRes.data.total) || 0)
        : null;

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
          <div class="value" style="color:var(--warn)">${pendingVerificationCount === null ? '&mdash;' : pendingVerificationCount}</div>
          <div class="delta">${pendingVerificationCount === null ? 'count unavailable right now' : 'uploaded documents awaiting review &rarr;'}</div>
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
