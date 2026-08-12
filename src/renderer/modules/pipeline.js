'use strict';

(function () {
  // Matches the 12-stage pipeline referenced throughout the project docs.
  // Kept here (rather than fetched) since EspoCRM's own field-level enum
  // order is the source of truth and rarely changes; a future iteration
  // could read this from Metadata instead of hardcoding it.
  const STAGE_ORDER = [
    'New', 'Check', 'Challenge', 'Evidence Gathering', 'Site Inspection',
    'Bill & Document Review', 'Bill Review & Relief Assessment', 'Invoiced',
    'Closed', 'Closed Without Payment', 'Closed Without Payment - Disputed'
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
              <div class="kanban-card">
                <div class="case-number">#${ctx.escapeHtml(c.number)}</div>
                <div class="case-contact">${ctx.escapeHtml(c.contactName || 'No contact linked')}</div>
              </div>
            `).join('') || '<div style="color:var(--slate); font-size:12px; padding:6px 8px;">Empty</div>'}
          </div>
        `).join('')}
      </div>
    `;
  }

  window.rvrModules.pipeline = { render };
})();
