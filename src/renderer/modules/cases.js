'use strict';

(function () {
  async function render(container, ctx) {
    container.innerHTML = `
      <h1 class="module-title">Cases</h1>
      <p class="module-subtitle">Cases visible to your account, per your EspoCRM role and access.</p>
      <div id="cases-list"><div class="loading-state">Loading…</div></div>
    `;

    const res = await window.rvr.espo.request('Case', {
      query: {
        select: 'number,name,cCaseStage,contactName,cPropertyAddressStreet,cPropertyAddressCity,createdAt',
        maxSize: 50,
        orderBy: 'createdAt',
        order: 'desc'
      }
    });

    const listEl = container.querySelector('#cases-list');

    if (!res.ok) {
      listEl.innerHTML = `<div class="empty-state">Could not load cases (${ctx.escapeHtml(res.message || 'unknown error')}).</div>`;
      return;
    }

    const cases = (res.data && res.data.list) || [];
    if (cases.length === 0) {
      listEl.innerHTML = '<div class="empty-state">No cases visible to your account yet.</div>';
      return;
    }

    listEl.innerHTML = `
      <table class="data-table">
        <thead><tr><th>Case</th><th>Stage</th><th>Contact</th><th>Address</th></tr></thead>
        <tbody>
          ${cases.map((c) => `
            <tr>
              <td>#${ctx.escapeHtml(c.number)} — ${ctx.escapeHtml(c.name || '')}</td>
              <td>${ctx.escapeHtml(c.cCaseStage || '—')}</td>
              <td>${ctx.escapeHtml(c.contactName || '—')}</td>
              <td>${ctx.escapeHtml([c.cPropertyAddressStreet, c.cPropertyAddressCity].filter(Boolean).join(', ') || '—')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      <p style="color:var(--slate); font-size:12px; margin-top:12px;">Showing the 50 most recent cases visible to you. A detail view / filters are a natural next iteration.</p>
    `;
  }

  window.rvrModules.cases = { render };
})();
