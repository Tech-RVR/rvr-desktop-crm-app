'use strict';

(function () {
  // Real 12-stage pipeline + disputed flag, per EspoCRM_Case_Entity_Scope_DRAFT.md.
  const STAGE_ORDER = [
    'Enquiry Received', 'Onboarding', 'Bill & Document Review', 'Relief Assessment',
    'Evidence Gathering / Site Inspection', 'Check', 'Challenge', 'Appeal',
    'Senior Sign-Off & Savings Confirmation', 'Invoiced', 'Payment / Arrears',
    'Closed', 'Closed Without Payment - Disputed'
  ];

  const DOCUMENT_OPTIONS = [
    'Business Rates Bill', 'Lease / Tenancy Agreement', 'Letter of Authority (signed)',
    'Terms of Engagement (signed)', 'Fee Agreement (signed)', 'Floor Plans',
    'Property Photographs', 'Rental Evidence', 'Comparable Properties Evidence',
    'Market Reports', 'VOA / Council Correspondence', 'Council Relief Application Form',
    'Savings Confirmation'
  ];

  function formatCurrency(value) {
    if (value === null || value === undefined || value === '') return '—';
    const num = Number(value);
    if (Number.isNaN(num)) return String(value);
    return num.toLocaleString('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 });
  }

  function formatAddress(c) {
    return [c.cPropertyAddressStreet, c.cPropertyAddressCity, c.cPropertyAddressState, c.cPropertyAddressPostalCode]
      .filter(Boolean).join(', ') || '—';
  }

  function formatDate(value) {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  // Full pipeline stage-track — every stage as a pill, grey if upcoming,
  // green if passed, gold if current. The disputed terminal state is shown
  // as a single standalone red pill instead of the track, matching the
  // mockup's rvr_crm_mockup.html #detStageTrack behaviour exactly.
  function renderStageTrack(c) {
    if (c.cCaseStage === 'Closed Without Payment - Disputed') {
      return '<span class="stage-pill now disputed">Closed Without Payment - Disputed</span>';
    }
    const stageIndex = STAGE_ORDER.indexOf(c.cCaseStage);
    return STAGE_ORDER
      .filter((s) => s !== 'Closed Without Payment - Disputed')
      .map((s) => {
        const idx = STAGE_ORDER.indexOf(s);
        const cls = idx < stageIndex ? 'done' : (s === c.cCaseStage ? 'now' : '');
        return `<span class="stage-pill ${cls}">${s}</span>`;
      })
      .join('');
  }

  async function render(container, ctx) {
    const caseId = ctx.params && ctx.params.caseId;

    if (!caseId) {
      container.innerHTML = '<div class="empty-state">No case selected. Go back and pick one from Cases or the Pipeline.</div>';
      return;
    }

    container.innerHTML = `
      <a class="back-link" id="case-detail-back">&larr; Back</a>
      <div id="case-detail-body"><div class="loading-state">Loading case…</div></div>
    `;
    container.querySelector('#case-detail-back').addEventListener('click', () => ctx.goBack());

    const res = await window.rvr.espo.request(`Case/${caseId}`);
    const body = container.querySelector('#case-detail-body');

    if (!res.ok) {
      body.innerHTML = `<div class="empty-state">Could not load this case (${ctx.escapeHtml(res.message || 'unknown error')}).</div>`;
      return;
    }

    const c = res.data || {};
    const documentsReceived = Array.isArray(c.cDocumentsReceived) ? c.cDocumentsReceived : [];

    body.innerHTML = `
      <h1 class="module-title">Case #${ctx.escapeHtml(c.number)}${c.name ? ` — ${ctx.escapeHtml(c.name)}` : ''}</h1>
      <p class="module-subtitle">
        ${ctx.escapeHtml(formatAddress(c))}
        <span class="${window.rvrStageBadgeClass(c.cCaseStage)}" style="margin-left:8px;">${ctx.escapeHtml(c.cCaseStage || 'No stage set')}</span>
      </p>
      <div class="stage-track">${renderStageTrack(c)}</div>

      <div class="case-columns">
        <div>
          <div class="panel">
            <h3 class="panel-heading">Case details</h3>
            <div class="detail-grid">
              <div><label>Contact</label><div>${ctx.escapeHtml(c.contactName || '—')}</div></div>
              <div><label>Assigned to</label><div>${ctx.escapeHtml(c.assignedUserName || 'Unassigned')}</div></div>
              <div><label>Property address</label><div>${ctx.escapeHtml(formatAddress(c))}</div></div>
              <div><label>Relief type</label><div>${ctx.escapeHtml(c.cReliefType || '—')}</div></div>
              <div><label>Rateable value (before)</label><div>${formatCurrency(c.cRateableValueBefore)}</div></div>
              <div><label>Rateable value (after)</label><div>${formatCurrency(c.cRateableValueAfter)}</div></div>
              <div><label>Annual saving</label><div style="color:var(--ok); font-weight:600;">${formatCurrency(c.cAnnualSaving)}</div></div>
              <div><label>Created</label><div>${formatDate(c.createdAt)}</div></div>
            </div>
          </div>

          <div class="panel">
            <h3 class="panel-heading">Documents received (${documentsReceived.length}/${DOCUMENT_OPTIONS.length})</h3>
            <div class="doc-checklist">
              ${DOCUMENT_OPTIONS.map((doc) => `
                <span class="pill ${documentsReceived.includes(doc) ? 'good' : 'neutral'}">${documentsReceived.includes(doc) ? '&#10003; ' : ''}${ctx.escapeHtml(doc)}</span>
              `).join('')}
            </div>
          </div>
        </div>

        <div>
          <div class="panel">
            <h3 class="panel-heading">Invoicing</h3>
            <div class="detail-grid">
              <div><label>Invoice date</label><div>${formatDate(c.cInvoiceDate)}</div></div>
              <div><label>Payment due</label><div>${formatDate(c.cPaymentDueDate)}</div></div>
              <div><label>Invoice paid</label><div><span class="pill ${c.cInvoicePaid ? 'good' : 'neutral'}">${c.cInvoicePaid ? 'Paid' : 'Not yet paid'}</span></div></div>
              <div><label>Reminder sent</label><div>${c.cPaymentReminderSent ? 'Yes' : 'No'}</div></div>
            </div>
          </div>
        </div>
      </div>

      <p style="color:var(--muted); font-size:12px;">
        Open the full record in EspoCRM for editing, file uploads, or the activity stream:
        <a href="https://crm.rvrratingpartners.co.uk/#Case/view/${encodeURIComponent(caseId)}" target="_blank" rel="noopener">Open in EspoCRM &rarr;</a>
      </p>
    `;
  }

  window.rvrModules['case-detail'] = { render };
})();
