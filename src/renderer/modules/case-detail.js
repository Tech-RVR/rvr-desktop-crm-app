'use strict';

(function () {
  // A local copy of the same escaping used everywhere else in this app
  // (app.js's escapeHtml, also handed in as ctx.escapeHtml to render()) —
  // needed here because renderCaseDetailsView/renderCaseDetailsEditForm are
  // pure template helpers that don't receive ctx.
  function esc(str) {
    return String(str || '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // Real 12-stage pipeline + disputed flag, per EspoCRM_Case_Entity_Scope_DRAFT.md.
  const STAGE_ORDER = [
    'Enquiry Received', 'Onboarding', 'Bill & Document Review', 'Relief Assessment',
    'Evidence Gathering / Site Inspection', 'Check', 'Challenge', 'Appeal',
    'Senior Sign-Off & Savings Confirmation', 'Invoiced', 'Payment / Arrears',
    'Closed', 'Closed Without Payment - Disputed'
  ];

  // Fallback only — the real options are fetched live from EspoCRM's own
  // Metadata at render time (see loadDocumentOptions), same principle as
  // loadReliefTypes below, so this list can never silently drift out of
  // sync with the CRM's actual cDocumentsReceived / Document.cCategory
  // enums (e.g. the Fee Agreement + Terms of Engagement merge, or a future
  // document type being added/renamed in the CRM only).
  const DOCUMENTS_RECEIVED_FALLBACK = [
    'Business Rates Bill', 'Lease / Tenancy Agreement', 'Letter of Authority (signed)',
    'Floor Plans', 'Property Photographs', 'Rental Evidence', 'Comparable Properties Evidence',
    'Market Reports', 'VOA / Council Correspondence', 'Council Relief Application Form',
    'Savings Confirmation', 'Questionnaire Form', 'Other', 'Fee Agreement & Terms of Engagement (signed)'
  ];

  const DOCUMENT_CATEGORY_FALLBACK = [
    'Business Rates Bill', 'Lease / Tenancy Agreement', 'Letter of Authority (signed)',
    'Floor Plans', 'Property Photographs', 'Rental Evidence', 'Comparable Properties Evidence',
    'Market Reports', 'VOA / Council Correspondence', 'Council Relief Application Form',
    'Savings Confirmation', 'Other', 'Fee Agreement & Terms of Engagement (signed)', 'Questionnaire Form'
  ];

  // Fetches the live option lists for both the "Documents received" checklist
  // (Case.cDocumentsReceived) and the upload-category dropdown
  // (Document.cCategory) from EspoCRM's Metadata API in one request, falling
  // back to the baked-in lists above only if that fetch fails (offline, etc).
  async function loadDocumentOptions() {
    try {
      const res = await window.rvr.espo.request('Metadata');
      if (res && res.ok && res.data && res.data.entityDefs) {
        const caseFields = res.data.entityDefs.Case && res.data.entityDefs.Case.fields;
        const docFields = res.data.entityDefs.Document && res.data.entityDefs.Document.fields;
        const received = caseFields && caseFields.cDocumentsReceived && caseFields.cDocumentsReceived.options;
        const category = docFields && docFields.cCategory && docFields.cCategory.options;
        return {
          received: Array.isArray(received) && received.length ? received : DOCUMENTS_RECEIVED_FALLBACK,
          category: Array.isArray(category) && category.length ? category : DOCUMENT_CATEGORY_FALLBACK
        };
      }
    } catch (err) { /* fall through to the baked-in lists */ }
    return { received: DOCUMENTS_RECEIVED_FALLBACK, category: DOCUMENT_CATEGORY_FALLBACK };
  }

  const SIGNOFF_STAGES = [
    { field: 'cSeniorSignOffCheck', label: 'Check' },
    { field: 'cSeniorSignOffChallenge', label: 'Challenge' },
    { field: 'cSeniorSignOffAppeal', label: 'Appeal' }
  ];
  const SIGNOFF_STATUSES = ['Not Requested', 'Requested', 'Approved'];

  // Fallback only, mirroring case-new.js's own note on this exact list: the
  // real options are fetched from Metadata at render time so an edit can
  // never drift out of sync with EspoCRM's actual cReliefType enum.
  const RELIEF_TYPES_FALLBACK = [
    'Small Business Rate Relief (SBRR)', 'Retail, Hospitality & Leisure Relief',
    'Empty Property Relief', 'Charitable Relief', 'Rural Rate Relief',
    'Improvement Relief', 'Heat Network Relief', 'Exemption', 'None'
  ];

  async function loadReliefTypes() {
    try {
      const res = await window.rvr.espo.request('Metadata');
      const opts = res && res.ok && res.data && res.data.entityDefs
        && res.data.entityDefs.Case && res.data.entityDefs.Case.fields
        && res.data.entityDefs.Case.fields.cReliefType
        && res.data.entityDefs.Case.fields.cReliefType.options;
      if (Array.isArray(opts) && opts.length) return opts;
    } catch (err) { /* fall through to the baked-in list */ }
    return RELIEF_TYPES_FALLBACK;
  }

  // The staff who can be assigned/reassigned a case — real caseworkers only
  // (EspoCRM User.type "regular"), not the admin/API/portal accounts that
  // also live in the Users table. Used to populate the "Assigned to"
  // dropdown on every case, per Tyrone's request that David be able to
  // reassign any case (unassigned or already assigned) to anyone else.
  // Falls back to an empty list on failure — the dropdown then degrades to
  // just showing whoever the case is already assigned to (see
  // wireAssignPanel), same "don't duplicate EspoCRM's own ACL" principle
  // used everywhere else in this app: if this staff member's role can't see
  // the Users list, they simply won't be offered a picker.
  async function loadAssignableUsers() {
    try {
      const res = await window.rvr.espo.request('User', {
        query: {
          'where[0][type]': 'equals',
          'where[0][attribute]': 'type',
          'where[0][value]': 'regular',
          'where[1][type]': 'equals',
          'where[1][attribute]': 'isActive',
          'where[1][value]': true,
          orderBy: 'name',
          maxSize: 200,
          select: 'id,name'
        }
      });
      if (res && res.ok && res.data && Array.isArray(res.data.list)) return res.data.list;
    } catch (err) { /* fall through */ }
    return [];
  }

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

  async function wireDocumentsPanel(panel, caseId, ctx, categoryOptions) {
    const listEl = panel.querySelector('#doc-list');
    const uploadBtn = panel.querySelector('#doc-upload-btn');
    const categorySelect = panel.querySelector('#doc-upload-category');
    const otherSpecifyWrap = panel.querySelector('#doc-upload-other-specify-wrap');
    const otherSpecifyInput = panel.querySelector('#doc-upload-other-specify');
    const fileInput = panel.querySelector('#doc-upload-file');
    const statusEl = panel.querySelector('#doc-upload-status');

    categorySelect.innerHTML = categoryOptions.map((d) => `<option value="${ctx.escapeHtml(d)}">${ctx.escapeHtml(d)}</option>`).join('');

    // "Other" needs a free-text "please specify" field, mirroring the same
    // Dynamic Logic condition set up on Document.cCategoryOtherSpecify in
    // EspoCRM (visible + required only when Category = Other).
    function syncOtherSpecifyVisibility() {
      const isOther = categorySelect.value === 'Other';
      otherSpecifyWrap.style.display = isOther ? '' : 'none';
      if (!isOther) otherSpecifyInput.value = '';
    }
    categorySelect.addEventListener('change', syncOtherSpecifyVisibility);
    syncOtherSpecifyVisibility();

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
      const otherSpecify = otherSpecifyInput.value.trim();
      if (categorySelect.value === 'Other' && !otherSpecify) {
        showStatus('Please specify the document type in the box below "Other".', 'err');
        return;
      }
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

        const docBody = {
          name: file.name,
          fileId: attachRes.data.id,
          cCategory: categorySelect.value,
          cSource: 'Staff Upload',
          cReviewStatus: 'Verified',
          cCaseId: caseId
        };
        if (categorySelect.value === 'Other') docBody.cCategoryOtherSpecify = otherSpecify;

        const docRes = await window.rvr.espo.request('Document', {
          method: 'POST',
          body: docBody
        });
        if (!docRes.ok) { showStatus(docRes.message || 'Could not save the document.', 'err'); return; }

        showStatus('Document uploaded.', 'ok');
        fileInput.value = '';
        otherSpecifyInput.value = '';
        syncOtherSpecifyVisibility();
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

  // ---------------------------------------------------------------------------
  // Case details — view/edit toggle.
  //
  // Permission is NOT decided here, same principle as case-new.js: the Save
  // button just PATCHes /Case/{id} as the logged-in user, and a 403 comes back
  // with a plain-English message rather than the app trying to duplicate
  // EspoCRM's own role/team ACL logic (own vs team edit rights differ by
  // role — Caseworker is "own" only, Surveyor/Admin are "team" — see
  // infrastructure-status.md's role-scope table). The Edit button is always
  // shown; EspoCRM's own ACL is the single source of truth for whether a
  // save actually succeeds.
  // ---------------------------------------------------------------------------
  function renderCaseDetailsView(c) {
    return `
      <div class="detail-grid">
        <div><label>Contact</label><div>${esc(c.contactName || '—')}</div></div>
        <div><label>Company</label><div>${esc(c.accountName || '—')}</div></div>
        <div><label>Property address</label><div>${esc(formatAddress(c))}</div></div>
        <div><label>Relief type</label><div>${esc(c.cReliefType || '—')}</div></div>
        <div><label>Rateable value (before)</label><div>${formatCurrency(c.cRateableValueBefore)}</div></div>
        <div><label>Rateable value (after)</label><div>${formatCurrency(c.cRateableValueAfter)}</div></div>
        <div><label>Annual saving</label><div style="color:var(--ok); font-weight:600;">${formatCurrency(c.cAnnualSaving)}</div></div>
        <div><label>Created</label><div>${formatDate(c.createdAt)}</div></div>
      </div>
    `;
  }

  // Only relevant when cCaseStage = 'Closed Without Payment - Disputed' -- matches
  // the cDisputeReason field's options in EspoCRM exactly (Field Manager, added
  // 2026-08-17). Tick-all-that-apply; the automated client email composes a
  // paragraph per reason selected. Required server-side (Dynamic Logic +
  // beforeSaveCustomScript both enforce this) whenever the case moves to that
  // stage, whether via this app's own PATCH or EspoCRM's own web UI.
  const DISPUTE_REASON_OPTIONS = [
  'Client disputes the outcome', 'VOA/council dispute unresolved', 'Internal/fee dispute'
  ];

  async function renderCaseDetailsEditForm(c, reliefOptions, linkedContact, linkedAccount) {
  const currentDisputeReasons = Array.isArray(c.cDisputeReason) ? c.cDisputeReason : [];
  const disputeReasonHidden = c.cCaseStage !== 'Closed Without Payment - Disputed';
    return `
      <div class="form-grid">
        <div class="field">
          <label for="edit-contact-search">Find existing contact</label>
          <input type="text" id="edit-contact-search" placeholder="Type a name, email or phone number…" autocomplete="off">
        </div>
        <div class="field">
          <label for="edit-contact-select">Contact</label>
          <select id="edit-contact-select"><option value="">Loading contacts…</option></select>
          <span class="field-hint">Pick an existing contact, or leave as “— No contact linked —” and fill in the fields below to add a new one.</span>
        </div>
        <div class="field">
          <label for="edit-contact-name">Contact name</label>
          <input type="text" id="edit-contact-name" value="${esc(linkedContact ? `${linkedContact.firstName || ''} ${linkedContact.lastName || ''}`.trim() : '')}" autocomplete="off">
        </div>
        <div class="field">
          <label for="edit-contact-phone">Contact phone</label>
          <input type="text" id="edit-contact-phone" value="${esc(linkedContact ? (linkedContact.phoneNumber || '') : '')}" autocomplete="off">
        </div>
        <div class="field">
          <label for="edit-contact-email">Contact email</label>
          <input type="email" id="edit-contact-email" value="${esc(linkedContact ? (linkedContact.emailAddress || '') : '')}" autocomplete="off">
        </div>
        <div class="field">
          <label for="edit-company-name">Company name</label>${linkedAccount ? ' <button type="button" id="edit-company-remove" style="background:none;border:none;padding:0;margin-left:8px;color:#2563eb;text-decoration:underline;cursor:pointer;font-size:0.85em;">Remove company</button>' : ''}
          <input type="text" id="edit-company-name" value="${esc(linkedAccount ? (linkedAccount.name || '') : '')}" autocomplete="off">
          <span class="field-hint" id="edit-company-hint">Leave blank for no company. Enter a name to link an existing company of that name or create a new one.</span>
        </div>
        <div class="field">
          <label for="edit-company-phone">Company phone</label>
          <input type="text" id="edit-company-phone" value="${esc(linkedAccount ? (linkedAccount.phoneNumber || '') : '')}" autocomplete="off">
        </div>
        <div class="field">
          <label for="edit-company-email">Company email</label>
          <input type="email" id="edit-company-email" value="${esc(linkedAccount ? (linkedAccount.emailAddress || '') : '')}" autocomplete="off">
        </div>
        <div class="field">
          <label for="edit-stage">Case stage</label>
          <select id="edit-stage">
            ${STAGE_ORDER.map((s) => `<option value="${esc(s)}" ${c.cCaseStage === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
          </select>
          <span class="field-hint">Moving a case on may be guarded by EspoCRM's own rules (Documents Received, Director-only stages) -- any block comes back as a message below.</span>
        </div>
        <div class="field" id="edit-dispute-reason-field" style="${disputeReasonHidden ? 'display:none;' : ''}">
          <label>Dispute reason(s) <span class="req">*</span></label>
            ${DISPUTE_REASON_OPTIONS.map((r) => `<label style="display:flex; align-items:center; gap:6px; font-weight:400; margin:4px 0;"><input type="checkbox" class="edit-dispute-reason-cb" value="${esc(r)}" ${currentDisputeReasons.includes(r) ? 'checked' : ''}> ${esc(r)}</label>`).join('')}
          <span class="field-hint">Tick all that apply -- the client email adapts to match. Required to close a case this way.</span>
        </div>
        <div class="field">
          <label for="edit-relief">Relief type</label>
          <select id="edit-relief">
            <option value="">Not decided yet</option>
            ${reliefOptions.map((r) => `<option value="${esc(r)}" ${c.cReliefType === r ? 'selected' : ''}>${esc(r)}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label for="edit-rv-before">Rateable value (before)</label>
          <input type="number" id="edit-rv-before" min="0" step="1" value="${c.cRateableValueBefore != null ? c.cRateableValueBefore : ''}">
        </div>
        <div class="field">
          <label for="edit-rv-after">Rateable value (after)</label>
          <input type="number" id="edit-rv-after" min="0" step="1" value="${c.cRateableValueAfter != null ? c.cRateableValueAfter : ''}">
        </div>
        <div class="field">
          <label for="edit-street">Street</label>
          <input type="text" id="edit-street" value="${esc(c.cPropertyAddressStreet || '')}">
        </div>
        <div class="field">
          <label for="edit-city">Town / city</label>
          <input type="text" id="edit-city" value="${esc(c.cPropertyAddressCity || '')}">
        </div>
        <div class="field">
          <label for="edit-state">County</label>
          <input type="text" id="edit-state" value="${esc(c.cPropertyAddressState || '')}">
        </div>
        <div class="field">
          <label for="edit-postcode">Postcode</label>
          <input type="text" id="edit-postcode" value="${esc(c.cPropertyAddressPostalCode || '')}">
        </div>
      </div>
      <div class="form-actions" style="margin-bottom:0;">
        <button class="btn btn-secondary" id="edit-cancel-btn">Cancel</button>
        <button class="btn btn-primary" id="edit-save-btn">Save</button>
      </div>
    `;
  }

  async function wireCaseDetailsPanel(panel, initialCase, caseId, ctx) {
    let current = initialCase;
    const bodyEl = panel.querySelector('#details-body');
    const editBtn = panel.querySelector('#details-edit-btn');
    const statusEl = panel.querySelector('#details-status');

    function showStatus(msg, kind) {
      statusEl.textContent = msg;
      statusEl.className = `status-banner show ${kind}`;
    }
    function clearStatus() {
      statusEl.className = 'status-banner';
    }

    function paintView() {
      editBtn.style.display = '';
      editBtn.textContent = 'Edit';
      bodyEl.innerHTML = renderCaseDetailsView(current);
    }

    async function paintEdit() {
      editBtn.style.display = 'none';
      clearStatus();
      bodyEl.innerHTML = '<div class="loading-state">Loading…</div>';
      const reliefOptions = await loadReliefTypes();
      if (ctx.isStale()) return;

      const originalContactId = current.contactId || '';
      const originalAccountId = current.accountId || '';
      const linkedContactRes = originalContactId
        ? await window.rvr.espo.request(`Contact/${originalContactId}`)
        : null;
      if (ctx.isStale()) return;
      const linkedContact = linkedContactRes && linkedContactRes.ok ? linkedContactRes.data : null;
      const linkedAccountRes = originalAccountId
        ? await window.rvr.espo.request(`Account/${originalAccountId}`)
        : null;
      if (ctx.isStale()) return;
      const linkedAccount = linkedAccountRes && linkedAccountRes.ok ? linkedAccountRes.data : null;

      bodyEl.innerHTML = await renderCaseDetailsEditForm(current, reliefOptions, linkedContact, linkedAccount);

      // --- Contact search / select -------------------------------------------
      // Same UX as case-new.js's contact typeahead: a debounced free-text
      // search box drives a <select> of matches. Selecting a different
      // existing contact just repoints the Case's contactId at save time --
      // it never edits that contact's own record. Editing the fields below
      // while the *currently linked* contact stays selected instead PUTs
      // those changes onto that Contact. Selecting "-- No contact linked --"
      // and typing a name creates a brand-new Contact, mirroring case-new.js's
      // create-or-find logic.
      const contactSearchInput = bodyEl.querySelector('#edit-contact-search');
      const contactSelectEl = bodyEl.querySelector('#edit-contact-select');
      const contactNameEl = bodyEl.querySelector('#edit-contact-name');
      const contactPhoneEl = bodyEl.querySelector('#edit-contact-phone');
      const contactEmailEl = bodyEl.querySelector('#edit-contact-email');
      const companyNameEl = bodyEl.querySelector('#edit-company-name');
      const companyPhoneEl = bodyEl.querySelector('#edit-company-phone');
      const companyEmailEl = bodyEl.querySelector('#edit-company-email');
      const companyRemoveBtn = bodyEl.querySelector('#edit-company-remove');
      const companyHintEl = bodyEl.querySelector('#edit-company-hint');
      const companyOriginalValues = {
        name: companyNameEl.value,
        phone: companyPhoneEl.value,
        email: companyEmailEl.value
      };
      const companyRemovedHintText = 'Company removed — Save to confirm.';
      const companyDefaultHintText = 'Leave blank for no company. Enter a name to link an existing company of that name or create a new one.';
      let companyRemoved = false;

      function setCompanyRemoved(removed) {
        companyRemoved = removed;
        if (companyRemoveBtn) companyRemoveBtn.textContent = removed ? 'Undo remove' : 'Remove company';
        if (companyHintEl) companyHintEl.textContent = removed ? companyRemovedHintText : companyDefaultHintText;
      }

      if (companyRemoveBtn) {
        companyRemoveBtn.addEventListener('click', () => {
          if (companyRemoved) {
            companyNameEl.value = companyOriginalValues.name;
            companyPhoneEl.value = companyOriginalValues.phone;
            companyEmailEl.value = companyOriginalValues.email;
            setCompanyRemoved(false);
          } else {
            companyNameEl.value = '';
            companyPhoneEl.value = '';
            companyEmailEl.value = '';
            setCompanyRemoved(true);
          }
        });
      }

      [companyNameEl, companyPhoneEl, companyEmailEl].forEach((el) => {
        el.addEventListener('input', () => {
          if (companyRemoved) setCompanyRemoved(false);
        });
      });

      function contactLabel(rec) {
        const name = `${rec.firstName || ''} ${rec.lastName || ''}`.trim() || rec.name || '(no name)';
        return rec.emailAddress ? `${name} — ${rec.emailAddress}` : name;
      }

      async function searchContactsForEdit(term) {
        const query = {
          select: 'firstName,lastName,name,emailAddress,phoneNumber',
          maxSize: 50,
          orderBy: 'createdAt',
          order: 'desc'
        };
        if (term) {
          query['where[0][type]'] = 'textFilter';
          query['where[0][value]'] = term;
          query.orderBy = 'name';
          query.order = 'asc';
        }
        const res = await window.rvr.espo.request('Contact', { query });
        if (!res.ok) return { ok: false, message: res.message };
        return { ok: true, list: (res.data && res.data.list) || [] };
      }

      let contactsById = {};
      if (originalContactId && linkedContact) {
        contactsById[originalContactId] = Object.assign({ id: originalContactId }, linkedContact);
      }

      function fillContactSelect(result, preselectId) {
        if (!result.ok) {
          contactSelectEl.innerHTML = '<option value="">Could not load contacts</option>';
          return;
        }
        result.list.forEach((rec) => { contactsById[rec.id] = rec; });
        const options = result.list.slice();
        if (preselectId && contactsById[preselectId] && !options.some((rec) => rec.id === preselectId)) {
          options.unshift(contactsById[preselectId]);
        }
        contactSelectEl.innerHTML =
          '<option value="">— No contact linked —</option>' +
          options.map((rec) => `<option value="${esc(rec.id)}" ${rec.id === preselectId ? 'selected' : ''}>${esc(contactLabel(rec))}</option>`).join('');
      }

      function applyContactFields(id) {
        if (id && contactsById[id]) {
          const rec = contactsById[id];
          contactNameEl.value = `${rec.firstName || ''} ${rec.lastName || ''}`.trim();
          contactPhoneEl.value = rec.phoneNumber || '';
          contactEmailEl.value = rec.emailAddress || '';
        } else if (!id) {
          contactNameEl.value = '';
          contactPhoneEl.value = '';
          contactEmailEl.value = '';
        }
      }

      fillContactSelect(await searchContactsForEdit(''), originalContactId);
      if (ctx.isStale()) return;

      contactSelectEl.addEventListener('change', () => {
        applyContactFields(contactSelectEl.value);
      });

      let contactSearchTimer = null;
      let contactSearchSeq = 0;
      contactSearchInput.addEventListener('input', () => {
        clearTimeout(contactSearchTimer);
        contactSearchTimer = setTimeout(async () => {
          const mySeq = ++contactSearchSeq;
          const prevValue = contactSelectEl.value;
          contactSelectEl.innerHTML = '<option value="">Searching…</option>';
          const result = await searchContactsForEdit(contactSearchInput.value.trim());
          if (mySeq !== contactSearchSeq || ctx.isStale()) return;
          fillContactSelect(result, prevValue);
        }, 300);
      });

      const stageSelect = bodyEl.querySelector('#edit-stage');
      const disputeReasonField = bodyEl.querySelector('#edit-dispute-reason-field');
      function syncDisputeReasonVisibility() {
        disputeReasonField.style.display = stageSelect.value === 'Closed Without Payment - Disputed' ? '' : 'none';
      }
      stageSelect.addEventListener('change', syncDisputeReasonVisibility);

      bodyEl.querySelector('#edit-cancel-btn').addEventListener('click', () => {
        editBtn.style.display = '';
        clearStatus();
        paintView();
      });

      bodyEl.querySelector('#edit-save-btn').addEventListener('click', async () => {
        const saveBtn = bodyEl.querySelector('#edit-save-btn');
        const rvBeforeRaw = bodyEl.querySelector('#edit-rv-before').value.trim();
        const rvAfterRaw = bodyEl.querySelector('#edit-rv-after').value.trim();
        if ((rvBeforeRaw && Number.isNaN(Number(rvBeforeRaw))) || (rvAfterRaw && Number.isNaN(Number(rvAfterRaw)))) {
          showStatus('Rateable values must be numbers.', 'err');
          return;
        }

        const stageVal = bodyEl.querySelector('#edit-stage').value;
        const disputeReasonsChecked = Array.from(bodyEl.querySelectorAll('.edit-dispute-reason-cb:checked')).map((cb) => cb.value);
        if (stageVal === 'Closed Without Payment - Disputed' && disputeReasonsChecked.length === 0) {
          showStatus('Select at least one dispute reason before closing a case this way.', 'err');
          return;
        }

        const body = {
          cCaseStage: stageVal,
          cReliefType: bodyEl.querySelector('#edit-relief').value || null,
          cPropertyAddressStreet: bodyEl.querySelector('#edit-street').value.trim(),
          cPropertyAddressCity: bodyEl.querySelector('#edit-city').value.trim(),
          cPropertyAddressState: bodyEl.querySelector('#edit-state').value.trim(),
          cPropertyAddressPostalCode: bodyEl.querySelector('#edit-postcode').value.trim()
        };
        if (rvBeforeRaw) body.cRateableValueBefore = Number(rvBeforeRaw);
        if (rvAfterRaw) body.cRateableValueAfter = Number(rvAfterRaw);
        if (stageVal === 'Closed Without Payment - Disputed') body.cDisputeReason = disputeReasonsChecked;

        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';
        showStatus('Saving…', 'info');

        // Resolve the Contact/Company panel before touching the Case itself.
        // Mirrors case-new.js's create-or-find logic, plus two extra branches
        // for a Case that already has a link: editing the currently-linked
        // record in place, and switching to a different existing contact
        // without touching either contact's own fields.
        async function resolveContactAndAccount() {
          const selectedContactId = contactSelectEl.value;
          const contactNameVal = contactNameEl.value.trim();
          const contactPhoneVal = contactPhoneEl.value.trim();
          const contactEmailVal = contactEmailEl.value.trim();
          const companyNameVal = companyNameEl.value.trim();
          const companyPhoneVal = companyPhoneEl.value.trim();
          const companyEmailVal = companyEmailEl.value.trim();

          let resolvedAccountId = originalAccountId;

          if (companyRemoved) {
            resolvedAccountId = '';
          } else if (originalAccountId) {
            if (linkedAccount) {
              const accountBody = {};
              if (companyNameVal !== (linkedAccount.name || '')) accountBody.name = companyNameVal;
              if (companyPhoneVal !== (linkedAccount.phoneNumber || '')) accountBody.phoneNumber = companyPhoneVal;
              if (companyEmailVal !== (linkedAccount.emailAddress || '')) accountBody.emailAddress = companyEmailVal;
              if (Object.keys(accountBody).length) {
                const acctRes = await window.rvr.espo.request(`Account/${originalAccountId}`, { method: 'PUT', body: accountBody });
                if (ctx.isStale()) return { ok: false, stale: true };
                if (!acctRes.ok) return { ok: false, message: acctRes.message || 'Could not update the company record.' };
              }
            }
          } else if (companyNameVal) {
            const existingAccountRes = await window.rvr.espo.request('Account', {
              query: {
                'where[0][type]': 'equals',
                'where[0][attribute]': 'name',
                'where[0][value]': companyNameVal,
                select: 'id,name',
                maxSize: 1
              }
            });
            if (ctx.isStale()) return { ok: false, stale: true };
            if (existingAccountRes.ok && existingAccountRes.data && existingAccountRes.data.list && existingAccountRes.data.list.length) {
              resolvedAccountId = existingAccountRes.data.list[0].id;
            } else {
              const accountBody = { name: companyNameVal };
              if (companyPhoneVal) accountBody.phoneNumber = companyPhoneVal;
              if (companyEmailVal) accountBody.emailAddress = companyEmailVal;
              const createAccountRes = await window.rvr.espo.request('Account', { method: 'POST', body: accountBody });
              if (ctx.isStale()) return { ok: false, stale: true };
              if (!createAccountRes.ok) return { ok: false, message: createAccountRes.message || 'Could not create the new company record.' };
              resolvedAccountId = createAccountRes.data && createAccountRes.data.id;
            }
          }

          let resolvedContactId = originalContactId;

          if (selectedContactId && selectedContactId === originalContactId) {
            if (linkedContact) {
              const nameParts = contactNameVal.split(' ').filter(Boolean);
              const lastName = nameParts.length > 1 ? nameParts.pop() : contactNameVal;
              const firstName = nameParts.join(' ');
              const origName = `${linkedContact.firstName || ''} ${linkedContact.lastName || ''}`.trim();
              const contactBody = {};
              if (contactNameVal !== origName) {
                contactBody.lastName = lastName || linkedContact.lastName || '';
                contactBody.firstName = firstName;
              }
              if (contactPhoneVal !== (linkedContact.phoneNumber || '')) contactBody.phoneNumber = contactPhoneVal;
              if (contactEmailVal !== (linkedContact.emailAddress || '')) contactBody.emailAddress = contactEmailVal;
              if (Object.keys(contactBody).length) {
                const contactRes = await window.rvr.espo.request(`Contact/${originalContactId}`, { method: 'PUT', body: contactBody });
                if (ctx.isStale()) return { ok: false, stale: true };
                if (!contactRes.ok) return { ok: false, message: contactRes.message || 'Could not update the contact record.' };
              }
            }
            resolvedContactId = selectedContactId;
          } else if (selectedContactId && selectedContactId !== originalContactId) {
            resolvedContactId = selectedContactId;
          } else if (!selectedContactId && contactNameVal) {
            const nameParts = contactNameVal.split(' ').filter(Boolean);
            const lastName = nameParts.length > 1 ? nameParts.pop() : contactNameVal;
            const firstName = nameParts.join(' ');
            const contactBody = { lastName };
            if (firstName) contactBody.firstName = firstName;
            if (contactPhoneVal) contactBody.phoneNumber = contactPhoneVal;
            if (contactEmailVal) contactBody.emailAddress = contactEmailVal;
            if (resolvedAccountId) contactBody.accountId = resolvedAccountId;
            const createContactRes = await window.rvr.espo.request('Contact', { method: 'POST', body: contactBody });
            if (ctx.isStale()) return { ok: false, stale: true };
            if (!createContactRes.ok) return { ok: false, message: createContactRes.message || 'Could not create the new contact record.' };
            resolvedContactId = createContactRes.data && createContactRes.data.id;
          } else {
            resolvedContactId = '';
          }

          return { ok: true, contactId: resolvedContactId, accountId: resolvedAccountId };
        }

        const resolved = await resolveContactAndAccount();
        if (resolved.stale) return;
        if (!resolved.ok) {
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save';
          showStatus(resolved.message || 'Could not save the linked contact/company.', 'err');
          return;
        }
        if (resolved.contactId !== originalContactId) body.contactId = resolved.contactId || null;
        if (resolved.accountId !== originalAccountId) body.accountId = resolved.accountId || null;

        const res = await window.rvr.espo.request(`Case/${caseId}`, { method: 'PUT', body });

        if (ctx.isStale()) return;
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save';

        if (!res.ok) {
          if (res.status === 403) {
            showStatus("You don't have permission to edit this case. It may not be assigned to you.", 'err');
          } else {
            showStatus(res.message || 'Could not save these changes. Please try again.', 'err');
          }
          return;
        }

        current = Object.assign({}, current, res.data || body);
        showStatus('Saved.', 'ok');
        paintView();
      });
    }

    editBtn.addEventListener('click', paintEdit);
    paintView();
  }

  // ---------------------------------------------------------------------------
  // Assigned to — a standalone dropdown (not gated behind the Case details
  // Edit toggle above) so David/any staff member can reassign a case to
  // anyone else in one click, whether it's currently unassigned or already
  // held by a colleague. PATCHes assignedUserId directly on the Case, same
  // as every other in-place edit in this app; EspoCRM's own ACL is still the
  // real gatekeeper (a 403 here just means this role can't reassign).
  // ---------------------------------------------------------------------------
  async function wireAssignPanel(panel, initialCase, caseId, ctx) {
    let currentAssignedId = initialCase.assignedUserId || '';
    const selectEl = panel.querySelector('#assign-user-select');
    const statusEl = panel.querySelector('#assign-status');

    function showStatus(msg, kind) {
      statusEl.textContent = msg;
      statusEl.className = `status-banner show ${kind}`;
    }
    function clearStatus() {
      statusEl.className = 'status-banner';
    }

    selectEl.disabled = true;
    selectEl.innerHTML = '<option>Loading…</option>';

    const users = await loadAssignableUsers();
    if (ctx.isStale()) return;

    // If the case is currently assigned to someone who isn't in the fetched
    // (active, regular-staff) list — e.g. a deactivated account — keep them
    // selectable so this control never silently reassigns the case just by
    // rendering it.
    const options = users.slice();
    if (currentAssignedId && !options.some((u) => u.id === currentAssignedId)) {
      options.unshift({ id: currentAssignedId, name: initialCase.assignedUserName || 'Currently assigned user' });
    }

    selectEl.innerHTML = `
      <option value="">Unassigned</option>
      ${options.map((u) => `<option value="${ctx.escapeHtml(u.id)}" ${u.id === currentAssignedId ? 'selected' : ''}>${ctx.escapeHtml(u.name)}</option>`).join('')}
    `;
    selectEl.disabled = false;

    if (!users.length) {
      showStatus('Could not load the staff list — you may not have permission to view all users.', 'err');
    }

    selectEl.addEventListener('change', async () => {
      const newUserId = selectEl.value;
      clearStatus();
      selectEl.disabled = true;
      const res = await window.rvr.espo.request(`Case/${caseId}`, { method: 'PUT', body: { assignedUserId: newUserId || null } });
      if (ctx.isStale()) return;
      selectEl.disabled = false;

      if (!res.ok) {
        if (res.status === 403) {
          showStatus("You don't have permission to reassign this case.", 'err');
        } else {
          showStatus(res.message || 'Could not reassign this case. Please try again.', 'err');
        }
        selectEl.value = currentAssignedId;
        return;
      }

      currentAssignedId = newUserId;
      const selectedOption = options.find((u) => u.id === newUserId);
      showStatus(newUserId ? `Reassigned to ${selectedOption ? selectedOption.name : 'selected user'}.` : 'Case unassigned.', 'ok');
    });
  }

  // ---------------------------------------------------------------------------
  // Senior Sign-Off — Check/Challenge/Appeal each need a senior sign-off
  // before the case can move past that stage (enforced server-side by the
  // Case entity's Before-Save Formula script). Setting a row to "Requested"
  // triggers the EspoCRM webhook -> n8n automation that emails the senior
  // caseworkers; a senior/director then sets it to "Approved" to unblock the
  // case. Shown here so the status is visible without leaving the app, and
  // actionable by whoever's role/permissions allow it (EspoCRM ACL decides,
  // same principle as everywhere else — a 403 here is expected for staff who
  // shouldn't be able to grant their own sign-off).
  // ---------------------------------------------------------------------------
  function signOffPillClass(status) {
    if (status === 'Approved') return 'good';
    if (status === 'Requested') return 'warn';
    return 'neutral';
  }

  function renderSignOffRow(stage, c) {
    const value = c[stage.field] || 'Not Requested';
    return `
      <div class="signoff-row" data-stage-field="${stage.field}">
        <label>${esc(stage.label)} sign-off</label>
        <div style="display:flex; align-items:center; gap:8px;">
          <span class="pill ${signOffPillClass(value)}">${esc(value)}</span>
          <select class="signoff-select" data-stage-field="${stage.field}">
            ${SIGNOFF_STATUSES.map((s) => `<option value="${esc(s)}" ${s === value ? 'selected' : ''}>${esc(s)}</option>`).join('')}
          </select>
        </div>
      </div>
    `;
  }

  async function wireSignOffPanel(panel, initialCase, caseId, ctx) {
    const statusEl = panel.querySelector('#signoff-status');

    function showStatus(msg, kind) {
      statusEl.textContent = msg;
      statusEl.className = `status-banner show ${kind}`;
    }
    function clearStatus() {
      statusEl.className = 'status-banner';
    }

    panel.querySelectorAll('.signoff-select').forEach((selectEl) => {
      const field = selectEl.dataset.stageField;
      const rowEl = panel.querySelector(`.signoff-row[data-stage-field="${field}"]`);
      const pillEl = rowEl.querySelector('.pill');
      let previousValue = selectEl.value;

      selectEl.addEventListener('change', async () => {
        const newValue = selectEl.value;
        clearStatus();
        selectEl.disabled = true;
        const res = await window.rvr.espo.request(`Case/${caseId}`, { method: 'PUT', body: { [field]: newValue } });
        if (ctx.isStale()) return;
        selectEl.disabled = false;

        if (!res.ok) {
          if (res.status === 403) {
            showStatus("You don't have permission to change this sign-off status.", 'err');
          } else {
            showStatus(res.message || 'Could not update sign-off status. Please try again.', 'err');
          }
          selectEl.value = previousValue;
          return;
        }

        previousValue = newValue;
        pillEl.textContent = newValue;
        pillEl.className = `pill ${signOffPillClass(newValue)}`;
        let message = 'Sign-off status updated.';
        if (newValue === 'Requested') {
          message = 'Sign-off requested — the senior caseworkers have been emailed automatically.';
        } else if (newValue === 'Approved') {
          message = 'Sign-off approved — the caseworker has been emailed automatically.';
        }
        showStatus(message, 'ok');
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Notes — a thin UI over EspoCRM's own Stream/Note API (POST /Note with
  // type:'Post', parentType/parentId pointing at this Case), so notes show up
  // in EspoCRM's own activity stream too rather than living in a second,
  // bespoke store nobody else can see. Marked isInternal so they never
  // surface anywhere client-facing.
  // ---------------------------------------------------------------------------
  function renderNotesList(notes, ctx) {
    if (!notes.length) {
      return '<div class="empty-state">No notes on this case yet.</div>';
    }
    return notes.map((n) => `
      <div class="note-row">
        <div class="note-meta"><strong>${ctx.escapeHtml(n.createdByName || 'Staff')}</strong> &middot; ${formatDate(n.createdAt)}</div>
        <div class="note-body">${ctx.escapeHtml(n.post || '')}</div>
      </div>
    `).join('');
  }

  async function wireNotesPanel(panel, caseId, ctx) {
    const listEl = panel.querySelector('#notes-list');
    const textEl = panel.querySelector('#notes-new-text');
    const addBtn = panel.querySelector('#notes-add-btn');
    const statusEl = panel.querySelector('#notes-status');

    function showStatus(msg, kind) {
      statusEl.textContent = msg;
      statusEl.className = `status-banner show ${kind}`;
    }

    async function loadNotes() {
      listEl.innerHTML = '<div class="loading-state">Loading notes…</div>';
      const res = await window.rvr.espo.request(`Case/${caseId}/stream`, {
        query: { maxSize: 100, orderBy: 'createdAt', order: 'desc' }
      });
      if (ctx.isStale()) return;
      if (!res.ok) {
        listEl.innerHTML = `<div class="empty-state">Could not load notes (${ctx.escapeHtml(res.message || 'unknown error')}).</div>`;
        return;
      }
      const all = (res.data && res.data.list) || [];
      // The stream mixes system entries (stage changes, field updates) in
      // with genuine human notes — only "Post" type entries are notes
      // someone actually wrote, which is what this panel is for.
      const notes = all.filter((n) => n.type === 'Post');
      listEl.innerHTML = renderNotesList(notes, ctx);
    }

    addBtn.addEventListener('click', async () => {
      const text = textEl.value.trim();
      if (!text) { showStatus('Write something before adding a note.', 'err'); return; }
      addBtn.disabled = true;
      addBtn.textContent = 'Adding…';
      const res = await window.rvr.espo.request('Note', {
        method: 'POST',
        body: { type: 'Post', parentType: 'Case', parentId: caseId, post: text, isInternal: true }
      });
      if (ctx.isStale()) return;
      addBtn.disabled = false;
      addBtn.textContent = 'Add note';
      if (!res.ok) {
        showStatus(res.message || 'Could not add the note. Please try again.', 'err');
        return;
      }
      textEl.value = '';
      showStatus('', '');
      await loadNotes();
    });

    await loadNotes();
  }

  // ---------------------------------------------------------------------------
  // Client messages — reads/writes CPortalMessage directly with the logged-in
  // staff member's own EspoCRM session (no proxy needed; the proxy pattern
  // elsewhere in this project exists specifically because *portal clients*
  // can't be trusted with a privileged credential — staff already have their
  // own real, role-scoped EspoCRM login for everything else in this app).
  // Requires the CPortalMessage staff-role ACL grant (read/create, team-
  // scoped) — see infrastructure-status.md; until that lands, this panel
  // degrades to a plain "can't load messages" state rather than erroring,
  // same 403-handling convention as the rest of the app.
  // ---------------------------------------------------------------------------
  function renderMessagesThread(messages, ctx) {
    if (!messages.length) {
      return '<div class="empty-state">No messages on this case yet.</div>';
    }
    return messages.map((m) => {
      const fromClient = m.direction === 'From Client';
      return `
        <div class="message-bubble ${fromClient ? 'from-client' : 'to-client'}">
          <div class="message-meta">
            <strong>${ctx.escapeHtml(m.senderName || (fromClient ? 'Client' : 'Staff'))}</strong>
            &middot; ${formatDate(m.createdAt)}
          </div>
          <div class="message-body">${ctx.escapeHtml(m.messageBody || '')}</div>
        </div>
      `;
    }).join('');
  }

  async function wireMessagesPanel(panel, c, caseId, ctx) {
    const threadEl = panel.querySelector('#messages-thread');
    const textEl = panel.querySelector('#messages-reply-text');
    const sendBtn = panel.querySelector('#messages-reply-btn');
    const statusEl = panel.querySelector('#messages-status');

    function showStatus(msg, kind) {
      statusEl.textContent = msg;
      statusEl.className = `status-banner show ${kind}`;
    }

    let latestClientMessageAt = null;

    async function loadMessages() {
      threadEl.innerHTML = '<div class="loading-state">Loading messages…</div>';
      const res = await window.rvr.espo.request('CPortalMessage', {
        query: {
          'where[0][type]': 'equals',
          'where[0][attribute]': 'caseId',
          'where[0][value]': caseId,
          orderBy: 'createdAt',
          order: 'asc',
          maxSize: 200
        }
      });
      if (ctx.isStale()) return;
      if (!res.ok) {
        if (res.status === 403) {
          threadEl.innerHTML = '<div class="empty-state">Your role does not yet have access to case messages. Ask an administrator to enable it.</div>';
        } else {
          threadEl.innerHTML = `<div class="empty-state">Could not load messages (${ctx.escapeHtml(res.message || 'unknown error')}).</div>`;
        }
        return;
      }
      const messages = (res.data && res.data.list) || [];
      threadEl.innerHTML = renderMessagesThread(messages, ctx);
      threadEl.scrollTop = threadEl.scrollHeight;

      // Mark this case's newest client message as "seen" so the Messages
      // nav badge and dashboard stop counting it — local-only bookkeeping,
      // see main.js's Store defaults comment.
      const clientMessages = messages.filter((m) => m.direction === 'From Client');
      if (clientMessages.length) {
        latestClientMessageAt = clientMessages[clientMessages.length - 1].createdAt;
        await window.rvr.messages.setSeen(caseId, latestClientMessageAt);
        if (window.rvrRefreshMessagesBadge) window.rvrRefreshMessagesBadge();
      }
    }

    sendBtn.addEventListener('click', async () => {
      const text = textEl.value.trim();
      if (!text) { showStatus('Write a reply before sending.', 'err'); return; }
      sendBtn.disabled = true;
      sendBtn.textContent = 'Sending…';
      const senderName = (ctx.user && (`${ctx.user.firstName || ''} ${ctx.user.lastName || ''}`.trim() || ctx.user.userName)) || 'Staff';

      const res = await window.rvr.espo.request('CPortalMessage', {
        method: 'POST',
        body: {
          caseId,
          contactId: c.contactId || null,
          direction: 'To Client',
          senderName,
          messageBody: text
        }
      });

      if (ctx.isStale()) return;
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send';

      if (!res.ok) {
        if (res.status === 403) {
          showStatus("You don't have permission to reply on this case. It may not be assigned to you.", 'err');
        } else {
          showStatus(res.message || 'Could not send the reply. Please try again.', 'err');
        }
        return;
      }

      textEl.value = '';
      showStatus('', '');
      await loadMessages();
    });

    await loadMessages();
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
    const docOptions = await loadDocumentOptions();
    if (ctx.isStale()) return;

    body.innerHTML = `
      <h1 class="module-title">Case #${ctx.escapeHtml(c.number)}${c.name ? ` — ${ctx.escapeHtml(c.name)}` : ''}</h1>
      <p class="module-subtitle">
        ${ctx.escapeHtml(formatAddress(c))}
        <span class="${window.rvrStageBadgeClass(c.cCaseStage)}" style="margin-left:8px;">${ctx.escapeHtml(c.cCaseStage || 'No stage set')}</span>
      </p>
      <div class="stage-track">${renderStageTrack(c)}</div>

      <div class="case-columns">
        <div>
          <div class="panel" id="details-panel">
            <div class="panel-heading-row">
              <h3 class="panel-heading">Case details</h3>
              <button class="btn btn-secondary btn-sm" id="details-edit-btn">Edit</button>
            </div>
            <div class="status-banner" id="details-status"></div>
            <div class="field" style="margin-bottom:14px;">
              <label for="assign-user-select">Assigned to</label>
              <select id="assign-user-select"><option>Loading…</option></select>
              <div class="status-banner" id="assign-status"></div>
            </div>
            <div id="details-body"></div>
          </div>

          <div class="panel">
            <h3 class="panel-heading">Documents received (${documentsReceived.length}/${docOptions.received.length})</h3>
            <div class="doc-checklist">
              ${docOptions.received.map((doc) => `
                <span class="pill ${documentsReceived.includes(doc) ? 'good' : 'neutral'}">${documentsReceived.includes(doc) ? '&#10003; ' : ''}${ctx.escapeHtml(doc)}</span>
              `).join('')}
            </div>
          </div>

          <div class="panel" id="notes-panel">
            <h3 class="panel-heading">Notes</h3>
            <p style="color:var(--muted); font-size:12px; margin-top:-8px;">Internal staff notes on this case &mdash; not visible to the client.</p>
            <div class="status-banner" id="notes-status"></div>
            <div class="note-add-row">
              <textarea id="notes-new-text" rows="2" placeholder="Add a note about this case…"></textarea>
              <button class="btn btn-primary" id="notes-add-btn">Add note</button>
            </div>
            <div id="notes-list"><div class="loading-state">Loading notes…</div></div>
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

          <div class="panel" id="signoff-panel">
            <h3 class="panel-heading">Senior Sign-Off</h3>
            <p style="color:var(--muted); font-size:12px; margin-top:-8px;">Required before this case can move past Check, Challenge, or Appeal. Setting a stage to "Requested" automatically emails the senior caseworkers.</p>
            <div class="status-banner" id="signoff-status"></div>
            <div class="signoff-list">
              ${SIGNOFF_STAGES.map((stage) => renderSignOffRow(stage, c)).join('')}
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
          <div id="doc-upload-other-specify-wrap" style="display:none;">
            <label for="doc-upload-other-specify">Please specify</label>
            <input type="text" id="doc-upload-other-specify" placeholder="What kind of document is this?">
          </div>
          <div>
            <label for="doc-upload-file">File</label>
            <input type="file" id="doc-upload-file">
          </div>
          <button class="btn btn-primary" id="doc-upload-btn">Upload</button>
        </div>
        <div id="doc-list"><div class="loading-state">Loading documents…</div></div>
      </div>

      <div class="panel" id="messages-panel">
        <h3 class="panel-heading">Client messages</h3>
        <p style="color:var(--muted); font-size:12px; margin-top:-8px;">
          Messages sent through the client portal for this case. Visible to any teammate who can see this case;
          replying is limited to whoever can edit it, same as everywhere else in this app.
        </p>
        <div class="status-banner" id="messages-status"></div>
        <div id="messages-thread"><div class="loading-state">Loading messages…</div></div>
        <div class="message-reply-row">
          <textarea id="messages-reply-text" rows="2" placeholder="Reply to the client…"></textarea>
          <button class="btn btn-primary" id="messages-reply-btn">Send</button>
        </div>
      </div>

      <p style="color:var(--muted); font-size:12px;">
        Open the full record in EspoCRM for the record's own activity stream:
        <a href="https://crm.rvrratingpartners.co.uk/#Case/view/${encodeURIComponent(caseId)}" target="_blank" rel="noopener">Open in EspoCRM &rarr;</a>
      </p>
    `;

    const docPanel = body.querySelector('#doc-panel');
    if (docPanel) {
      await wireDocumentsPanel(docPanel, caseId, ctx, docOptions.category);
    }

    const detailsPanel = body.querySelector('#details-panel');
    if (detailsPanel) {
      await wireCaseDetailsPanel(detailsPanel, c, caseId, ctx);
      await wireAssignPanel(detailsPanel, c, caseId, ctx);
    }

    const signoffPanel = body.querySelector('#signoff-panel');
    if (signoffPanel) {
      await wireSignOffPanel(signoffPanel, c, caseId, ctx);
    }

    const notesPanel = body.querySelector('#notes-panel');
    if (notesPanel) {
      await wireNotesPanel(notesPanel, caseId, ctx);
    }

    const messagesPanel = body.querySelector('#messages-panel');
    if (messagesPanel) {
      await wireMessagesPanel(messagesPanel, c, caseId, ctx);
    }
  }

  window.rvrModules['case-detail'] = { render };
})();
