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

  const DOCUMENT_OPTIONS = [
    'Business Rates Bill', 'Lease / Tenancy Agreement', 'Letter of Authority (signed)',
    'Terms of Engagement (signed)', 'Fee Agreement (signed)', 'Floor Plans',
    'Property Photographs', 'Rental Evidence', 'Comparable Properties Evidence',
    'Market Reports', 'VOA / Council Correspondence', 'Council Relief Application Form',
    'Savings Confirmation'
  ];

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
        <div><label>Assigned to</label><div>${esc(c.assignedUserName || 'Unassigned')}</div></div>
        <div><label>Property address</label><div>${esc(formatAddress(c))}</div></div>
        <div><label>Relief type</label><div>${esc(c.cReliefType || '—')}</div></div>
        <div><label>Rateable value (before)</label><div>${formatCurrency(c.cRateableValueBefore)}</div></div>
        <div><label>Rateable value (after)</label><div>${formatCurrency(c.cRateableValueAfter)}</div></div>
        <div><label>Annual saving</label><div style="color:var(--ok); font-weight:600;">${formatCurrency(c.cAnnualSaving)}</div></div>
        <div><label>Created</label><div>${formatDate(c.createdAt)}</div></div>
      </div>
    `;
  }

  async function renderCaseDetailsEditForm(c, reliefOptions) {
    return `
      <div class="form-grid">
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
      bodyEl.innerHTML = await renderCaseDetailsEditForm(current, reliefOptions);

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

        const body = {
          cReliefType: bodyEl.querySelector('#edit-relief').value || null,
          cPropertyAddressStreet: bodyEl.querySelector('#edit-street').value.trim(),
          cPropertyAddressCity: bodyEl.querySelector('#edit-city').value.trim(),
          cPropertyAddressState: bodyEl.querySelector('#edit-state').value.trim(),
          cPropertyAddressPostalCode: bodyEl.querySelector('#edit-postcode').value.trim()
        };
        if (rvBeforeRaw) body.cRateableValueBefore = Number(rvBeforeRaw);
        if (rvAfterRaw) body.cRateableValueAfter = Number(rvAfterRaw);

        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';
        showStatus('Saving…', 'info');

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
            <div id="details-body"></div>
          </div>

          <div class="panel">
            <h3 class="panel-heading">Documents received (${documentsReceived.length}/${DOCUMENT_OPTIONS.length})</h3>
            <div class="doc-checklist">
              ${DOCUMENT_OPTIONS.map((doc) => `
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
      await wireDocumentsPanel(docPanel, caseId, ctx);
    }

    const detailsPanel = body.querySelector('#details-panel');
    if (detailsPanel) {
      await wireCaseDetailsPanel(detailsPanel, c, caseId, ctx);
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
