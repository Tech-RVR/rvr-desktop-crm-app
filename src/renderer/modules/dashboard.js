'use strict';

(function () {
  async function render(container, ctx) {
    container.innerHTML = `
      <h1 class="module-title">Dashboard</h1>
      <p class="module-subtitle">An overview of your cases, respecting your own EspoCRM role and access.</p>
      <div class="kpi-row" id="dash-kpis"><div class="loading-state">Loading…</div></div>
      <div class="panel">
        <h3 style="margin-top:0;">Cases by stage</h3>
        <div id="dash-stage-breakdown"><div class="loading-state">Loading…</div></div>
      </div>
    `;

    try {
      // select is deliberately minimal — cCaseStage only — since this is
      // purely a client-side aggregate for the KPI row, not a case list.
      const res = await window.rvr.espo.request('Case', { query: { select: 'cCaseStage', maxSize: 200 } });

      if (!res.ok) {
        container.querySelector('#dash-kpis').innerHTML = `<div class="empty-state">Could not load your cases (${ctx.escapeHtml(res.message || 'unknown error')}).</div>`;
        container.querySelector('#dash-stage-breakdown').innerHTML = '';
        return;
      }

      const cases = (res.data && res.data.list) || [];
      const total = res.data && typeof res.data.total === 'number' ? res.data.total : cases.length;

      const byStage = {};
      cases.forEach((c) => {
        const stage = c.cCaseStage || '(no stage set)';
        byStage[stage] = (byStage[stage] || 0) + 1;
      });

      const openCount = cases.filter((c) => !(c.cCaseStage || '').startsWith('Closed')).length;
      const closedCount = cases.filter((c) => (c.cCaseStage || '').startsWith('Closed')).length;

      container.querySelector('#dash-kpis').innerHTML = `
        <div class="kpi-card"><div class="kpi-value">${total}</div><div class="kpi-label">Visible cases</div></div>
        <div class="kpi-card"><div class="kpi-value">${openCount}</div><div class="kpi-label">Open</div></div>
        <div class="kpi-card"><div class="kpi-value">${closedCount}</div><div class="kpi-label">Closed</div></div>
      `;

      const stageEntries = Object.entries(byStage).sort((a, b) => b[1] - a[1]);
      if (stageEntries.length === 0) {
        container.querySelector('#dash-stage-breakdown').innerHTML = '<div class="empty-state">No cases visible to your account yet.</div>';
      } else {
        container.querySelector('#dash-stage-breakdown').innerHTML = `
          <table class="data-table">
            <thead><tr><th>Stage</th><th>Count</th></tr></thead>
            <tbody>
              ${stageEntries.map(([stage, count]) => `<tr><td>${ctx.escapeHtml(stage)}</td><td>${count}</td></tr>`).join('')}
            </tbody>
          </table>
        `;
      }
    } catch (err) {
      container.querySelector('#dash-kpis').innerHTML = '<div class="empty-state">Something went wrong loading the dashboard.</div>';
    }
  }

  window.rvrModules.dashboard = { render };
})();
