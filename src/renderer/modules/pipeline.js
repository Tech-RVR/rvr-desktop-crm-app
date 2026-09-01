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
    'Evidence Gathering / Site Inspection', 'Site Inspection / Case Rejection',
  'Check', 'Challenge', 'Appeal',
    'Senior Sign-Off & Savings Confirmation', 'Invoiced', 'Payment / Arrears',
    'Closed', 'Closed Without Payment - Disputed'
  ];

  async function render(container, ctx) {
    container.innerHTML = `
      <h1 class="module-title">Pipeline</h1>
      <p class="module-subtitle">Cases visible to your account, grouped by stage.</p>
      <div id="pipeline-board"><div class="loading-state">Loading…</div></div>
    `;

    // 2026-08-28: added an explicit ordering. Without one, EspoCRM's default
    // decided which 200 cases survived the cap, so the board could quietly
    // reshuffle between loads as well as under-count.
    // 2026-08-30: it no longer stops at 200 either — it pages. A board that
    // silently omits the 201st case is worse than one that says it is short.
    const read = await window.rvrPagedRead.readAll('Case', {
      select: 'number,name,cCaseStage,contactName',
      orderBy: 'createdAt',
      order: 'desc'
    });

    const board = container.querySelector('#pipeline-board');
    if (!board) return;

    if (read === null) {
      board.innerHTML = '<div class="empty-state">Could not load the pipeline. This is a problem reading the cases, not an empty board — please try again.</div>';
      return;
    }

    const cases = read.list;
    if (read.truncated) {
      const warn = document.createElement('p');
      warn.className = 'module-subtitle';
      warn.textContent = 'There are more cases than this board can read in one go. The most recent are shown.';
      board.parentNode.insertBefore(warn, board);
    }
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
