'use strict';

(function () {
  function money(n) {
    if (n === null || n === undefined || n === '') return '—';
    const num = Number(n);
    if (Number.isNaN(num)) return String(n);
    return num.toLocaleString('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 });
  }

  async function render(container, ctx) {
    container.innerHTML = `
      <h1 class="module-title">Cases</h1>
      <p class="module-subtitle">Cases visible to your account, per your EspoCRM role and access.</p>
      <div class="panel">
        <div id="cases-list"><div class="loading-state">Loading…</div></div>
      </div>
    `;

    const res = await window.rvr.espo.request('Case', {
      query: {
        select: 'number,name,cCaseStage,contactName,cPropertyAddressStreet,cPropertyAddressCity,cReliefType,cRateableValueBefore,cRateableValueAfter,cAnnualSaving,createdAt',
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
        <thead><tr><th>Case</th><th>Client</th><th>Property</th><th>Stage</th><th>Relief Type</th><th>RV Before &rarr; After</th><th>Annual Saving</th></tr></thead>
        <tbody>
          ${cases.map((c) => `
            <tr class="clickable-row" data-case-id="${ctx.escapeHtml(c.id)}">
              <td><b>#${ctx.escapeHtml(c.number)}</b>${c.name ? ` — ${ctx.escapeHtml(c.name)}` : ''}</td>
              <td>${ctx.escapeHtml(c.contactName || '—')}</td>
              <td>${ctx.escapeHtml([c.cPropertyAddressStreet, c.cPropertyAddressCity].filter(Boolean).join(', ') || '—')}</td>
              <td><span class="${window.rvrStageBadgeClass(c.cCaseStage)}">${ctx.escapeHtml(c.cCaseStage || 'No stage set')}</span></td>
              <td>${ctx.escapeHtml(c.cReliefType || '—')}</td>
              <td class="money">${c.cRateableValueBefore || c.cRateableValueAfter ? `${money(c.cRateableValueBefore)} &rarr; ${money(c.cRateableValueAfter)}` : '—'}</td>
              <td class="money save-pos">${c.cAnnualSaving ? money(c.cAnnualSaving) : '—'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      <p style="color:var(--muted); font-size:12px; margin-top:12px;">Showing the 50 most recent cases visible to you. Click a row to open it. Filters are a natural next iteration.</p>
    `;

    listEl.querySelectorAll('tr.clickable-row').forEach((row) => {
      row.addEventListener('click', () => ctx.openCase(row.dataset.caseId));
    });
  }

  window.rvrModules.cases = { render };
})();
