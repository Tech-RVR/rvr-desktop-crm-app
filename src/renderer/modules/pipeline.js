'use strict';

(function () {
  // The real 12-stage pipeline + disputed flag, per
  // EspoCRM_Case_Entity_Scope_DRAFT.md (cCaseStage's actual enum order).
  // Kept here (rather than fetched) since the field's enum order is the
  // source of truth and rarely changes; a future iteration could read this
  // from Metadata instead of hardcoding it.
  // Corrected 2026-08-13 — the previous list here didn't match the live enum
  // at all (stale/guessed names from an earlier draft), so cards were being
  // grouped under stage names the field doesn't actually have.
  const STAGE_ORDER = [
    'Enquiry Received', 'Onboarding', 'Bill & Document Review', 'Relief Assessment',
    'Evidence Gathering / Site Inspection', 'Check', 'Challenge', 'Appeal',
    'Senior Sign-Off & Savings Confirmation', 'Invoiced', 'Payment / Arrears',
    'Closed', 'Closed Without Payment - Disputed'
  ];

  async function render(container, ctx) {
    container.innerHTML = `
      <h1 class="module-title">Pipeline</h1>
      <p class="module-subtitle">Cases visible to your account, grouped by stage.</p>
      <div id="pipeline-board"><div class="loading-state">Loading…</div></div>
    `;

    const res = await window.rvr.espo.request('Case', {
      query: { select: 'number,name,cCaseStage,contactName', maxSize: 200 }
    });

    const board = container.querySelector('#pipeline-board');
    if (!board) return;

    if (!res.ok) {
      board.innerHTML = `<div class="empty-state">Could not load the pipeline (${ctx.escapeHtml(res.message || 'unknown error')}).</div>`;
      return;
    }

    const cases = (res.data && res.data.list) || [];
    const byStage = {};
    cases.forEach((c) => {
      const stage = c.cCaseStage || '(no stage set)';
      if (!byStage[stage]) byStage[stage] = [];
      byStage[stage].push(c);
    });

    const stages = Array.from(new Set([...STAGE_ORDER, ...Object.keys(byStage)]));

    board.innerHTML = `
      <div class="kanban">
        ${stages.map((stage) => `
          <div class="kanban-col">
            <h3>${ctx.escapeHtml(stage)} (${(byStage[stage] || []).length})</h3>
            ${(byStage[stage] || []).map((c) => `
              <div class="kanban-card clickable-row" data-case-id="${ctx.escapeHtml(c.id)}">
                <div class="case-number">#${ctx.escapeHtml(c.number)}</div>
                <div class="case-contact">${ctx.escapeHtml(c.contactName || 'No contact linked')}</div>
              </div>
            `).join('') || '<div style="color:var(--slate); font-size:12px; padding:6px 8px;">Empty</div>'}
          </div>
        `).join('')}
      </div>
    `;

    board.querySelectorAll('.kanban-card.clickable-row').forEach((card) => {
      card.addEventListener('click', () => ctx.openCase(card.dataset.caseId));
    });
  }

  window.rvrModules.pipeline = { render };
})();
