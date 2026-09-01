'use strict';

/**
 * New Case — case intake from inside the desktop app.
 *
 * Deliberately a *narrow* intake form, not a full Case editor. It captures
 * what's actually known when an enquiry first lands (per ONB-01 in the
 * Operations Manual) and leaves everything downstream — savings figures,
 * documents checklist, invoicing — to the EspoCRM record itself.
 *
 * Permissions are NOT decided here. The form posts to POST /api/v1/Case as
 * the logged-in user, so EspoCRM's own role ACL is the single source of
 * truth; a role without Case create simply gets a 403 and a plain-English
 * message. No permission logic is duplicated in the client.
 */

(function () {
  // Fallback only. These MUST match the cReliefType enum in EspoCRM exactly —
  // the API rejects anything else with a 400 "validation failure" and the user
  // just sees the save fail. 0.2.4 shipped with abbreviated labels taken from a
  // stale project doc, so every relief type chosen here was rejected.
  // The real list is fetched from Metadata at render time (see loadReliefTypes)
  // so it can never drift out of sync with the CRM again.
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

  // Every new case starts at the top of the 12-stage pipeline. Stage is
  // deliberately not user-editable here — moving a case on is a decision made
  // on the record (and is guarded by the Documents Received / DIR-04 rules).
  const INITIAL_STAGE = 'Enquiry Received';

  function contactLabel(c) {
    const name = `${c.firstName || ''} ${c.lastName || ''}`.trim() || c.name || '(no name)';
    return c.emailAddress ? `${name} — ${c.emailAddress}` : name;
  }

  async function searchContacts(term) {
    const query = {
      select: 'firstName,lastName,name,emailAddress',
      maxSize: 50,
      orderBy: 'createdAt',
      order: 'desc'
    };
    let w = 0;
    if (term) {
      // EspoCRM's bracket-notation where clause. textFilter matches name,
      // email and phone in one go, which is what a staff member typing a
      // client's name into a search box actually expects.
      query[`where[${w}][type]`] = 'textFilter';
      query[`where[${w}][value]`] = term;
      w += 1;
      query.orderBy = 'name';
      query.order = 'asc';
    }
    // 2026-09-01: archived clients are kept out of this list. A contact is
    // archived when their last case is deleted, and Tyrone's point was that
    // they should stop cluttering New Case - but NOT be lost, which is why
    // they are archived rather than deleted and why findArchivedContact below
    // offers them back if someone types their details in.
    //
    // isFalse, not equals. On this API `equals` against a real boolean column
    // silently matches nothing and returns HTTP 200 with an empty list, which
    // here would empty the contact picker entirely.
    query[`where[${w}][type]`] = 'isFalse';
    query[`where[${w}][attribute]`] = 'cArchived';

    const res = await window.rvr.espo.request('Contact', { query });
    if (!res.ok) return { ok: false, message: res.message };
    return { ok: true, list: (res.data && res.data.list) || [] };
  }

  // 2026-09-01: does what the person is typing match a client we archived?
  // Matched on email first, because that is the reliable identifier; falls
  // back to an exact name match when no email was given. Returns null on a
  // failed read as well as on no match - the caller treats "we could not
  // check" as "carry on and create", because blocking case creation over a
  // duplicate check would be a worse failure than a duplicate contact.
  async function findArchivedContact(email, fullName) {
    const query = {
      select: 'firstName,lastName,name,emailAddress,phoneNumber,cArchivedAt',
      maxSize: 1,
      'where[0][type]': 'isTrue',
      'where[0][attribute]': 'cArchived'
    };
    if (email) {
      query['where[1][type]'] = 'equals';
      query['where[1][attribute]'] = 'emailAddress';
      query['where[1][value]'] = email;
    } else if (fullName) {
      query['where[1][type]'] = 'equals';
      query['where[1][attribute]'] = 'name';
      query['where[1][value]'] = fullName;
    } else {
      return null;
    }
    const res = await window.rvr.espo.request('Contact', { query });
    if (!res || !res.ok) return null;
    const list = (res.data && res.data.list) || [];
    return list.length ? list[0] : null;
  }

  async function render(container, ctx) {
    container.innerHTML = `
      <h1 class="module-title">New Case</h1>
      <p class="module-subtitle">
        Log a new enquiry. It's created at stage &ldquo;${INITIAL_STAGE}&rdquo; and assigned to you.
      </p>

      <div class="panel form-panel">
        <h3 class="panel-heading">Client</h3>
        <div class="field">
          <label for="nc-contact-search">Find the client contact</label>
          <input type="text" id="nc-contact-search" placeholder="Type a name, email or phone number…" autocomplete="off">
        </div>
        <div class="field">
          <label for="nc-contact">Contact</label>
          <select id="nc-contact"><option value="">Loading contacts…</option></select>
          <span class="field-hint">Optional, but link the case to a contact whenever you can. If they're not in the list yet, add them in the CRM first.</span>
        </div>
      </div>

      <div class="panel form-panel">
        <h3 class="panel-heading">New company / contact</h3>
        <p class="field-hint">Use this only if the client isn't in the CRM yet — pick an existing contact above when you can. These fields are disabled once an existing contact is picked.</p>
        <div class="form-grid">
          <div class="field">
            <label for="nc-new-company">Company name</label>
            <input type="text" id="nc-new-company" autocomplete="off">
          </div>
          <div class="field">
            <label for="nc-new-contact-name">Contact name</label>
            <input type="text" id="nc-new-contact-name" autocomplete="off">
          </div>
          <div class="field">
            <label for="nc-new-phone">Phone number</label>
            <input type="text" id="nc-new-phone" autocomplete="off">
          </div>
          <div class="field">
            <label for="nc-new-email">Email</label>
            <input type="email" id="nc-new-email" autocomplete="off">
          </div>
        </div>
      </div>

      <div class="panel form-panel">
        <h3 class="panel-heading">Case</h3>
        <div class="field">
          <label for="nc-name">Case name <span class="req">*</span></label>
          <input type="text" id="nc-name" placeholder="e.g. Unit 4 High Street — SBRR review" maxlength="200">
        </div>
        <div class="field">
          <label for="nc-relief">Relief type being considered</label>
          <select id="nc-relief">
            <option value="">Not decided yet</option>
            ${RELIEF_TYPES_FALLBACK.map((r) => `<option value="${ctx.escapeHtml(r)}">${ctx.escapeHtml(r)}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label for="nc-rv-before">Rateable value (current)</label>
          <input type="number" id="nc-rv-before" placeholder="e.g. 24500" min="0" step="1">
        </div>
        <div class="field">
          <label for="nc-description">Enquiry notes</label>
          <textarea id="nc-description" rows="4" placeholder="What did the client ask for? Anything they've already told us?"></textarea>
        </div>
      </div>

      <div class="panel form-panel">
        <h3 class="panel-heading">Property address</h3>
        <div class="form-grid">
          <div class="field">
            <label for="nc-street">Street</label>
            <input type="text" id="nc-street" autocomplete="off">
          </div>
          <div class="field">
            <label for="nc-city">Town / city</label>
            <input type="text" id="nc-city" autocomplete="off">
          </div>
          <div class="field">
            <label for="nc-state">County</label>
            <input type="text" id="nc-state" autocomplete="off">
          </div>
          <div class="field">
            <label for="nc-postcode">Postcode</label>
            <input type="text" id="nc-postcode" autocomplete="off">
          </div>
        </div>
        <span class="field-hint">Needed later for field clock-in proximity checks, so worth filling in now if you have it.</span>
      </div>

      <div class="status-banner" id="nc-status"></div>
      <div class="form-actions">
        <button class="btn btn-secondary" id="nc-reset">Clear form</button>
        <button class="btn btn-primary" id="nc-submit">Create case</button>
      </div>
    `;

    const el = (id) => container.querySelector(`#${id}`);
    const statusEl = el('nc-status');
    const contactSelect = el('nc-contact');
    const searchInput = el('nc-contact-search');
    const submitBtn = el('nc-submit');
    const newCompanyEl = el('nc-new-company');
    const newContactNameEl = el('nc-new-contact-name');
    const newPhoneEl = el('nc-new-phone');
    const newEmailEl = el('nc-new-email');
    const newContactFields = [newCompanyEl, newContactNameEl, newPhoneEl, newEmailEl];

    function syncNewContactFieldsState() {
      const hasExisting = !!contactSelect.value;
      newContactFields.forEach((field) => { field.disabled = hasExisting; });
      if (hasExisting) newContactFields.forEach((field) => { field.value = ''; });
    }
    contactSelect.addEventListener('change', syncNewContactFieldsState);

    function showStatus(msg, kind) {
      statusEl.textContent = msg;
      statusEl.className = `status-banner show ${kind}`;
    }

    // 2026-08-28: every path in here replaces the select's innerHTML, which
    // wipes the user's selection but fires NO change event - so
    // syncNewContactFieldsState never re-ran and the four "new company /
    // contact" boxes stayed greyed out from an earlier pick. Search again,
    // find nobody, and you could neither pick an existing contact nor type a
    // new one; submitting from there created a case with no client attached
    // and no warning. Every exit from this function now re-syncs.
    function fillContacts(result) {
      if (!result.ok) {
        contactSelect.innerHTML = '<option value="">Could not load contacts</option>';
        syncNewContactFieldsState();
        return;
      }
      if (result.list.length === 0) {
        contactSelect.innerHTML = '<option value="">No matching contacts</option>';
        syncNewContactFieldsState();
        return;
      }
      contactSelect.innerHTML =
        '<option value="">— No contact linked —</option>' +
        result.list
          .map((c) => `<option value="${ctx.escapeHtml(c.id)}">${ctx.escapeHtml(contactLabel(c))}</option>`)
          .join('');
      syncNewContactFieldsState();
    }

    fillContacts(await searchContacts(''));

    // Replace the baked-in relief options with whatever the CRM actually has.
    const reliefEl = el('nc-relief');
    const reliefOpts = await loadReliefTypes();
    if (!ctx.isStale() && reliefOpts.join('|') !== RELIEF_TYPES_FALLBACK.join('|')) {
      reliefEl.innerHTML = '<option value="">Not decided yet</option>' +
        reliefOpts.map((r) => `<option value="${ctx.escapeHtml(r)}">${ctx.escapeHtml(r)}</option>`).join('');
    }

    // Debounced so a fast typist doesn't fire a request per keystroke, and
    // guarded by a sequence number so a slow earlier search can never
    // overwrite the results of a later one.
    let searchTimer = null;
    let searchSeq = 0;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(async () => {
        const mySeq = ++searchSeq;
        contactSelect.innerHTML = '<option value="">Searching…</option>';
        syncNewContactFieldsState();
        const result = await searchContacts(searchInput.value.trim());
        if (mySeq !== searchSeq || ctx.isStale()) return;
        fillContacts(result);
      }, 300);
    });

    el('nc-reset').addEventListener('click', () => {
      ['nc-name', 'nc-rv-before', 'nc-description', 'nc-street', 'nc-city', 'nc-state', 'nc-postcode', 'nc-contact-search', 'nc-new-company', 'nc-new-contact-name', 'nc-new-phone', 'nc-new-email']
        .forEach((id) => { el(id).value = ''; });
      el('nc-relief').value = '';
      contactSelect.value = '';
      createdInThisAttempt.contactId = '';
      createdInThisAttempt.accountId = '';
      createdInThisAttempt.archivedChoice = null;
      const oldChoicePanel = container.querySelector('#nc-archived-choice');
      if (oldChoicePanel) oldChoicePanel.remove();
      syncNewContactFieldsState();
      statusEl.className = 'status-banner';
    });

    // 2026-08-28: survives across click attempts on purpose - see the note
    // where it is read below. Cleared by "Clear form" and after a case is
    // successfully created.
    const createdInThisAttempt = { contactId: '', accountId: '', archivedChoice: null };

    submitBtn.addEventListener('click', async () => {
      const name = el('nc-name').value.trim();
      if (!name) {
        showStatus('Please give the case a name so it can be found later.', 'err');
        el('nc-name').focus();
        return;
      }

      const rvBeforeRaw = el('nc-rv-before').value.trim();
      if (rvBeforeRaw && Number.isNaN(Number(rvBeforeRaw))) {
        showStatus('Rateable value must be a number.', 'err');
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Creating…';
      // 2026-08-30: the CRM now REQUIRES a contact on a Case. Before that,
      // leaving this blank quietly created a case with no client attached;
      // now it comes back as a bare validation failure that means nothing to
      // the person looking at it. Ask properly, here, before anything is sent.
      if (!contactSelect.value
          && !newCompanyEl.value.trim()
          && !newContactNameEl.value.trim()) {
        showStatus('Please choose the client contact, or fill in the new contact boxes below, before creating the case.', 'err');
        contactSelect.focus();
        return;
      }

      showStatus('Creating the case…', 'info');

      const body = {
        name,
        cCaseStage: INITIAL_STAGE,
        assignedUserId: ctx.user && ctx.user.id
      };

      let contactId = contactSelect.value;
      let accountId = '';

      // 2026-08-28: creating a case is three steps - company, contact, case.
      // If the LAST one failed, the first two had already landed, but nothing
      // remembered them: contactId and accountId were declared inside this
      // handler, so pressing Create again created a SECOND contact. Third
      // press, third contact. (The company was always safe - it is looked up
      // by name and reused.) These two now survive a retry, so a second
      // attempt reuses what already exists instead of duplicating it.
      if (createdInThisAttempt.contactId) contactId = createdInThisAttempt.contactId;
      if (createdInThisAttempt.accountId) accountId = createdInThisAttempt.accountId;

      if (!contactId) {
        const newCompanyName = newCompanyEl.value.trim();
        const newContactName = newContactNameEl.value.trim();
        const newPhone = newPhoneEl.value.trim();
        const newEmail = newEmailEl.value.trim();

        if (newCompanyName || newContactName) {
          if (newCompanyName) {
            const existingAccountRes = await window.rvr.espo.request('Account', {
              query: {
                'where[0][type]': 'equals',
                'where[0][attribute]': 'name',
                'where[0][value]': newCompanyName,
                select: 'id,name',
                maxSize: 1
              }
            });
            if (ctx.isStale()) return;
            if (existingAccountRes.ok && existingAccountRes.data && existingAccountRes.data.list && existingAccountRes.data.list.length) {
              accountId = existingAccountRes.data.list[0].id;
            } else {
              // Assign to the staff member creating it. This is not cosmetic:
              // since assignmentPermission was set to `team` on 2026-08-20,
              // EspoCRM refuses to create a record that has neither an
              // assigned user nor a team (Acl/AssignmentChecker/Helper.php
              // isPermittedTeamsEmpty), which is what has been blocking new
              // companies with "Assignment failure: assigned user or team not
              // allowed." The Case body below has always set this; Account and
              // Contact did not.
              const accountBody = { name: newCompanyName };
              if (ctx.user && ctx.user.id) accountBody.assignedUserId = ctx.user.id;
              if (newPhone) accountBody.phoneNumber = newPhone;
              if (newEmail) accountBody.emailAddress = newEmail;
              const createAccountRes = await window.rvr.espo.request('Account', { method: 'POST', body: accountBody });
              if (ctx.isStale()) return;
              if (!createAccountRes.ok) {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Create case';
                showStatus(createAccountRes.message || 'Could not create the new company record.', 'err');
                return;
              }
              accountId = createAccountRes.data && createAccountRes.data.id;
              createdInThisAttempt.accountId = accountId;
            }
          }

          // -----------------------------------------------------------------
          // 2026-09-01: AN ARCHIVED CLIENT COMING BACK.
          //
          // Archived clients are hidden from the picker above, so somebody
          // re-entering a returning client types their details in here as if
          // they were new. Creating a second record would lose their history
          // and leave two contacts with the same email. Tyrone's own design:
          // if what has been typed matches an archived client, ask whether to
          // use the details already on file or update them with what has just
          // been typed - and bring the client out of the archive either way.
          // -----------------------------------------------------------------
          function showArchivedChoice(match) {
            const nm = `${match.firstName || ''} ${match.lastName || ''}`.trim() || match.name || 'this client';
            let panel = container.querySelector('#nc-archived-choice');
            if (!panel) {
              panel = document.createElement('div');
              panel.id = 'nc-archived-choice';
              panel.className = 'case-delete-confirm';
              statusEl.parentNode.insertBefore(panel, statusEl.nextSibling);
            }
            panel.innerHTML = `
              <p style="margin:0 0 10px;">
                <strong>${ctx.escapeHtml(nm)}</strong> is already on the system as an archived client
                ${match.emailAddress ? `(${ctx.escapeHtml(match.emailAddress)})` : ''}.
                They were archived when their last case was deleted.
              </p>
              <p style="margin:0 0 12px;">Use the details already on file, or replace them with what you have just typed?</p>
              <div class="case-delete-actions">
                <button type="button" class="btn btn-primary" id="nc-archived-use">Use their existing details</button>
                <button type="button" class="btn btn-secondary" id="nc-archived-update">Update with what I typed</button>
                <button type="button" class="btn btn-secondary" id="nc-archived-cancel">Cancel</button>
              </div>`;
            panel.querySelector('#nc-archived-use').addEventListener('click', () => {
              createdInThisAttempt.archivedChoice = { id: match.id, action: 'use' };
              panel.remove();
              submitBtn.click();
            });
            panel.querySelector('#nc-archived-update').addEventListener('click', () => {
              createdInThisAttempt.archivedChoice = { id: match.id, action: 'update' };
              panel.remove();
              submitBtn.click();
            });
            panel.querySelector('#nc-archived-cancel').addEventListener('click', () => {
              panel.remove();
              showStatus('Nothing created. Change the contact details, or pick a different client.', 'info');
            });
            showStatus(`${nm} is already on the system — choose how to bring them back.`, 'info');
          }

          if (newContactName && !createdInThisAttempt.archivedChoice) {
            const archivedMatch = await findArchivedContact(newEmail, newContactName);
            if (ctx.isStale()) return;
            if (archivedMatch && archivedMatch.id) {
              submitBtn.disabled = false;
              submitBtn.textContent = 'Create case';
              showArchivedChoice(archivedMatch);
              return;
            }
          }

          const archivedChoice = createdInThisAttempt.archivedChoice;
          if (newContactName && archivedChoice && archivedChoice.id) {
            const restoreBody = { cArchived: false, cArchivedAt: null };
            if (archivedChoice.action === 'update') {
              const parts = String(newContactName).trim().split(/\s+/).filter(Boolean);
              restoreBody.lastName = parts.length > 1 ? parts[parts.length - 1] : parts[0];
              restoreBody.firstName = parts.length > 1 ? parts.slice(0, -1).join(' ') : '';
              if (newPhone) restoreBody.phoneNumber = newPhone;
              if (newEmail) restoreBody.emailAddress = newEmail;
              if (accountId) restoreBody.accountId = accountId;
            }
            const restore = await window.rvr.espo.request(`Contact/${archivedChoice.id}`, { method: 'PUT', body: restoreBody });
            if (ctx.isStale()) return;
            if (!restore.ok) {
              submitBtn.disabled = false;
              submitBtn.textContent = 'Create case';
              showStatus(restore.message || 'Could not bring that archived client back out of the archive. Please try again.', 'err');
              return;
            }
            contactId = archivedChoice.id;
          }

          if (newContactName && !contactId) {
            // 2026-08-28: `"Madonna".split(' ')` never reaches pop(), so the
            // old inline version put the whole name in BOTH firstName and
            // lastName and the contact read "Madonna Madonna" everywhere -
            // the CRM, the portal, and any email merging a client's name in.
            const parts = String(newContactName).trim().split(/\s+/).filter(Boolean);
            const lastName = parts.length > 1 ? parts[parts.length - 1] : parts[0];
            const firstName = parts.length > 1 ? parts.slice(0, -1).join(' ') : '';
            const contactBody = { lastName };
            // Same reason as the Account create above.
            if (ctx.user && ctx.user.id) contactBody.assignedUserId = ctx.user.id;
            if (firstName) contactBody.firstName = firstName;
            if (newPhone) contactBody.phoneNumber = newPhone;
            if (newEmail) contactBody.emailAddress = newEmail;
            if (accountId) contactBody.accountId = accountId;
            const createContactRes = await window.rvr.espo.request('Contact', { method: 'POST', body: contactBody });
            if (ctx.isStale()) return;
            if (!createContactRes.ok) {
              submitBtn.disabled = false;
              submitBtn.textContent = 'Create case';
              showStatus(createContactRes.message || 'Could not create the new contact record.', 'err');
              return;
            }
            contactId = createContactRes.data && createContactRes.data.id;
            createdInThisAttempt.contactId = contactId;
          }
        }
      }

      if (contactId) body.contactId = contactId;
      if (accountId) body.accountId = accountId;

      const relief = el('nc-relief').value;
      if (relief) body.cReliefType = relief;

      if (rvBeforeRaw) body.cRateableValueBefore = Number(rvBeforeRaw);

      const description = el('nc-description').value.trim();
      if (description) body.description = description;

      const street = el('nc-street').value.trim();
      const city = el('nc-city').value.trim();
      const stateVal = el('nc-state').value.trim();
      const postcode = el('nc-postcode').value.trim();
      if (street) body.cPropertyAddressStreet = street;
      if (city) body.cPropertyAddressCity = city;
      if (stateVal) body.cPropertyAddressState = stateVal;
      if (postcode) body.cPropertyAddressPostalCode = postcode;
      if (street || city || stateVal || postcode) body.cPropertyAddressCountry = 'United Kingdom';

      const res = await window.rvr.espo.request('Case', { method: 'POST', body });

      submitBtn.disabled = false;
      submitBtn.textContent = 'Create case';

      if (ctx.isStale()) return;

      if (!res.ok) {
        if (res.status === 403) {
          showStatus('Your CRM role does not have permission to create cases. Ask an administrator to enable it for your role.', 'err');
        } else {
          showStatus(res.message || 'Could not create the case. Please try again.', 'err');
        }
        return;
      }

      const created = res.data || {};
      showStatus(`Case #${created.number || ''} created. Opening it now…`, 'ok');
      setTimeout(() => {
        if (ctx.isStale()) return;
        if (created.id) {
          ctx.openCase(created.id);
        } else {
          ctx.navigateTo('cases');
        }
      }, 900);
    });
  }

  window.rvrModules['case-new'] = { render };
})();
