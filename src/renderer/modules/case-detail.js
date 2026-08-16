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

  // Every document on a case — client-uploaded and staff-uploaded — shown in
  // one place, per Tyrone's request: "if they need to pull up someones file
  // they can accsess all the documents from the app that are for that file."
  // No new backend needed here: EspoCRM's own Document ACL (mirrored to each
  // role's Case scope) already governs what a given staff member can see,
  // same as every other screen in this app.
  function reviewPillClass(status) {
    if (status === 'Verified') return 'good';
    if (status === 'Rejected') return 'bad';
    return 'warn';
  }

  function sourceBadgeClass(source) {
    return source === 'Client Upload' ? 'client' : 'staff';
  }

  function uploaderLabel(d) {
    if (d.cSource === 'Client Upload') {
      return d.cUploadedByContactName || 'Client';
    }
    return d.createdByName || d.assignedUserName || 'Staff';
  }

  function renderDocumentsList(documents, ctx) {
    if (!documents.length) {
      return '<div class="empty-state">No documents uploaded on this case yet.</div>';
    }
    return documents.map((d) => {
      const pending = d.cReviewStatus === 'Pending Review';
      return `
        <div class="doc-row ${pending ? 'pending-highlight' : ''}" data-doc-id="${ctx.escapeHtml(d.id)}">
          <div class="doc-main">
            <div class="doc-cat">
              <span class="doc-source-badge ${sourceBadgeClass(d.cSource)}">${d.cSource === 'Client Upload' ? 'Client' : 'Staff'}</span>
              ${ctx.escapeHtml(d.cCategory || d.name || 'Document')}
            </div>
            <div class="doc-meta">Uploaded by ${ctx.escapeHtml(uploaderLabel(d))} &middot; ${formatDate(d.createdAt)}</div>
          </div>
          <div class="doc-actions">
            <span class="pill ${reviewPillClass(d.cReviewStatus)}">${ctx.escapeHtml(d.cReviewStatus || 'Pending Review')}</span>
            <button class="btn btn-secondary btn-doc-download" data-doc-id="${ctx.escapeHtml(d.id)}" data-file-id="${ctx.escapeHtml(d.fileId || '')}" data-file-name="${ctx.escapeHtml(d.name || 'document')}">Download</button>
            ${pending ? `<button class="btn btn-ok btn-doc-verify" data-doc-id="${ctx.escapeHtml(d.id)}">Verify</button>` : ''}
            ${pending ? `<button class="btn btn-danger btn-doc-reject" data-doc-id="${ctx.escapeHtml(d.id)}">Reject</button>` : ''}
            <button class="btn btn-danger btn-doc-delete" data-doc-id="${ctx.escapeHtml(d.id)}">Delete</button>
          </div>
        </div>
      `;
    }).join('');
  }

  async function wireDocumentsPanel(panel, caseId, ctx) {
    const listEl = panel.querySelector('#doc-list');
    const uploadBtn = panel.querySelector('#doc-upload-btn');
    const categorySelect = panel.querySelector('#doc-upload-category');
    const fileInput = panel.querySelector('#doc-upload-file');
    const statusEl = panel.querySelector('#doc-upload-status');

    categorySelect.innerHTML = DOCUMENT_OPTIONS.map((d) => `<option value="${ctx.escapeHtml(d)}">${ctx.escapeHtml(d)}</option>`).join('');

    function showStatus(msg, kind) {
      statusEl.textContent = msg;
      statusEl.className = `status-banner show ${kind}`;
    }
    function clearStatus() {
      statusEl.className = 'status-banner';
    }

    async function loadDocuments() {
      listEl.innerHTML = '<div class="loading-state">Loading documents…</div>';
      const res = await window.rvr.espo.request('Document', {
        query: {
          'where[0][type]': 'equals',
          'where[0][attribute]': 'cCaseId',
          'where[0][value]': caseId,
          orderBy: 'createdAt',
          order: 'desc',
          maxSize: 100
        }
      });
      if (!res.ok) {
        listEl.innerHTML = `<div class="empty-state">Could not load documents (${ctx.escapeHtml(res.message || 'unknown error')}).</div>`;
        return;
      }
      const documents = (res.data && res.data.list) || [];
      listEl.innerHTML = renderDocumentsList(documents, ctx);
      wireRowActions();
    }

    function wireRowActions() {
      listEl.querySelectorAll('.btn-doc-download').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const fileId = btn.dataset.fileId;
          const fileName = btn.dataset.fileName;
          if (!fileId) { showStatus('This document has no file attached.', 'err'); return; }
          btn.disabled = true;
          const res = await window.rvr.espo.downloadFile(fileId, fileName);
          btn.disabled = false;
          if (res.ok) {
            showStatus(`Saved to ${res.path}`, 'ok');
          } else if (!res.canceled) {
            showStatus(res.message || 'Could not download that file.', 'err');
          }
        });
      });

      listEl.querySelectorAll('.btn-doc-verify').forEach((btn) => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          const res = await window.rvr.espo.request(`Document/${btn.dataset.docId}`, { method: 'PUT', body: { cReviewStatus: 'Verified' } });
          if (res.ok) { showStatus('Document verified.', 'ok'); loadDocuments(); }
          else { showStatus(res.message || 'Could not verify this document.', 'err'); btn.disabled = false; }
        });
      });

      listEl.querySelectorAll('.btn-doc-reject').forEach((btn) => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          const res = await window.rvr.espo.request(`Document/${btn.dataset.docId}`, { method: 'PUT', body: { cReviewStatus: 'Rejected' } });
          if (res.ok) { showStatus('Document rejected.', 'ok'); loadDocuments(); }
          else { showStatus(res.message || 'Could not reject this document.', 'err'); btn.disabled = false; }
        });
      });

      listEl.querySelectorAll('.btn-doc-delete').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!window.confirm('Delete this document? This can be undone by an admin if needed.')) return;
          btn.disabled = true;
          const res = await window.rvr.espo.request(`Document/${btn.dataset.docId}`, { method: 'DELETE' });
          if (res.ok) { showStatus('Document deleted.', 'ok'); loadDocuments(); }
          else { showStatus(res.message || 'Could not delete this document — you may not have permission.', 'err'); btn.disabled = false; }
        });
      });
    }

    function fileToBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result;
          const comma = result.indexOf(',');
          resolve(comma > -1 ? result.slice(comma + 1) : result);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    }

    uploadBtn.addEventListener('click', async () => {
      clearStatus();
      const file = fileInput.files && fileInput.files[0];
      if (!file) { showStatus('Choose a file to upload.', 'err'); return; }
      uploadBtn.disabled = true;
      uploadBtn.textContent = 'Uploading…';
      try {
        const fileBase64 = await fileToBase64(file);
        const mimeType = file.type || 'application/octet-stream';
        const attachRes = await window.rvr.espo.request('Attachment', {
          method: 'POST',
          body: { name: file.name, type: mimeType, role: 'Attachment', relatedType: 'Document', field: 'file', file: `data:${mimeType};base64,${fileBase64}` }
        });
        if (!attachRes.ok) { showStatus(attachRes.message || 'Could not upload the file.', 'err'); return; }

        const docRes = await window.rvr.espo.request('Document', {
          method: 'POST',
          body: {
            name: file.name,
            fileId: attachRes.data.id,
            cCategory: categorySelect.value,
            cSource: 'Staff Upload',
            cReviewStatus: 'Verified',
            cCaseId: caseId
          }
        });
        if (!docRes.ok) { showStatus(docRes.message || 'Could not save the document.', 'err'); return; }

        showStatus('Document uploaded.', 'ok');
        fileInput.value = '';
        await loadDocuments();
      } catch (e) {
        showStatus('Could not upload the file.', 'err');
      } finally {
        uploadBtn.disabled = false;
        uploadBtn.textContent = 'Upload';
      }
    });

    await loadDocuments();
  }

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
    if (!body) return;

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

      <div class="panel" id="doc-panel">
        <h3 class="panel-heading">Documents</h3>
        <p style="color:var(--muted); font-size:12px; margin-top:-8px;">Every document on this case &mdash; uploaded by the client through the portal, or by staff here. A pending client upload is highlighted until it's verified or rejected.</p>
        <div class="status-banner" id="doc-upload-status"></div>
        <div class="doc-upload-row">
          <div>
            <label for="doc-upload-category">Document type</label>
            <select id="doc-upload-category"></select>
          </div>
          <div>
            <label for="doc-upload-file">File</label>
            <input type="file" id="doc-upload-file">
          </div>
          <button class="btn btn-primary" id="doc-upload-btn">Upload</button>
        </div>
        <div id="doc-list"><div class="loading-state">Loading documents…</div></div>
      </div>

      <p style="color:var(--muted); font-size:12px;">
        Open the full record in EspoCRM for editing or the activity stream:
        <a href="https://crm.rvrratingpartners.co.uk/#Case/view/${encodeURIComponent(caseId)}" target="_blank" rel="noopener">Open in EspoCRM &rarr;</a>
      </p>
    `;

    const docPanel = body.querySelector('#doc-panel');
    if (docPanel) {
      await wireDocumentsPanel(docPanel, caseId, ctx);
    }
  }

  window.rvrModules['case-detail'] = { render };
})();
