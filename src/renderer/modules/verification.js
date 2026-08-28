'use strict';

/**
 * Verification — every Document across every case sitting at
 * cReviewStatus = "Pending Review", in one list. Distinct from the
 * Dashboard's "Awaiting Documents" KPI, which counts cases whose
 * cDocumentsReceived checklist isn't full — that's about which *categories*
 * are still missing, not which already-uploaded files are waiting on a
 * human to actually check them. This screen is the latter.
 */

(function () {
  function formatWhen(value) {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  async function render(container, ctx) {
    container.innerHTML = `
      <h1 class="module-title">Verification</h1>
      <p class="module-subtitle">Documents waiting to be verified, across every case.</p>
      <div class="panel">
        <div id="verification-list"><div class="loading-state">Loading…</div></div>
      </div>
    `;

    const listEl = container.querySelector('#verification-list');

    const docsRes = await window.rvr.espo.request('Document', {
      query: {
        select: 'name,cCategory,cSource,cCaseId,cUploadedByContactName,createdByName,createdAt',
        'where[0][type]': 'equals',
        'where[0][attribute]': 'cReviewStatus',
        'where[0][value]': 'Pending Review',
        orderBy: 'createdAt',
        order: 'asc',
        maxSize: 200
      }
    });

    if (ctx.isStale()) return;

    if (!docsRes.ok) {
      listEl.innerHTML = `<div class="empty-state">Could not load documents (${ctx.escapeHtml(docsRes.message || 'unknown error')}).</div>`;
      return;
    }

    const docs = (docsRes.data && docsRes.data.list) || [];
    if (!docs.length) {
      listEl.innerHTML = '<div class="empty-state">Nothing waiting on verification right now.</div>';
      return;
    }

    const caseIds = Array.from(new Set(docs.map((d) => d.cCaseId).filter(Boolean)));
    const casesRes = caseIds.length
      ? await window.rvr.espo.request('Case', {
          query: {
            select: 'number,name,contactName',
            'where[0][type]': 'in',
            'where[0][attribute]': 'id',
            'where[0][value][]': caseIds,
            // 2026-08-28: this used to be caseIds.length, unbounded. EspoCRM
            // refuses any maxSize over 200 with a bare 403, so once more than
            // 200 cases had a document waiting the whole screen went blank.
            // The document query above is itself capped at 200, so 200 here
            // can never truncate the result.
            maxSize: 200
          }
        })
      : { ok: true, data: { list: [] } };
    if (ctx.isStale()) return;

    const caseInfo = {};
    if (casesRes.ok) {
      ((casesRes.data && casesRes.data.list) || []).forEach((c) => { caseInfo[c.id] = c; });
    } else {
      // 2026-08-28: there was no else here. When this second lookup failed,
      // every row still rendered -- with '#--' for the case number and a
      // blank client column -- which reads as corrupted data rather than as
      // a failed read. Standing rule: 'could not load' and 'there is nothing'
      // must never be the same thing on screen. Fail closed and say so.
      listEl.innerHTML = `<div class="empty-state">Found ${docs.length} document${docs.length === 1 ? '' : 's'} waiting, but the case details behind them could not be loaded (${ctx.escapeHtml(casesRes.message || 'unknown error')}). Please try again in a moment.</div>`;
      return;
    }

    listEl.innerHTML = `
      <table class="data-table">
        <thead>
          <tr><th>Case</th><th>Client</th><th>Document</th><th>Uploaded by</th><th>Uploaded</th><th></th></tr>
        </thead>
        <tbody>
          ${docs.map((d) => {
            const info = caseInfo[d.cCaseId] || {};
            const uploader = d.cSource === 'Client Upload'
              ? (d.cUploadedByContactName || 'Client')
              : (d.createdByName || 'Staff');
            return `
              <tr class="clickable-row" data-case-id="${ctx.escapeHtml(d.cCaseId || '')}">
                <td>#${ctx.escapeHtml(info.number || '—')}${info.name ? ` — ${ctx.escapeHtml(info.name)}` : ''}</td>
                <td>${ctx.escapeHtml(info.contactName || '—')}</td>
                <td>
                  <span class="doc-source-badge ${d.cSource === 'Client Upload' ? 'client' : 'staff'}">${d.cSource === 'Client Upload' ? 'Client' : 'Staff'}</span>
                  ${ctx.escapeHtml(d.cCategory || d.name || 'Document')}
                </td>
                <td>${ctx.escapeHtml(uploader)}</td>
                <td>${formatWhen(d.createdAt)}</td>
                <td><span class="pill warn">Pending Review</span></td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
      <p style="color:var(--muted); font-size:12px; margin-top:12px;">Click a row to open the case and verify or reject the document there.</p>
    `;

    listEl.querySelectorAll('.clickable-row').forEach((row) => {
      row.addEventListener('click', () => {
        if (row.dataset.caseId) ctx.openCase(row.dataset.caseId);
      });
    });
  }

  window.rvrModules.verification = { render };
})();
