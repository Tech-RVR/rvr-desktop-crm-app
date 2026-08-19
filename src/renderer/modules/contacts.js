'use strict';

(function () {
  // Same textFilter pattern already proven working against this EspoCRM
  // instance in case-new.js/case-detail.js's contact-picker search — it
  // matches name, email and phone in one go, which is what someone typing a
  // client's name into a search box expects.
  async function searchContacts(term) {
    const query = {
      select: 'firstName,lastName,emailAddress,phoneNumber',
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

  function renderTable(contacts, ctx) {
    if (contacts.length === 0) {
      return '<div class="empty-state">No contacts match your search.</div>';
    }
    return `
      <table class="data-table">
        <thead><tr><th>Name</th><th>Email</th><th>Phone</th></tr></thead>
        <tbody>
          ${contacts.map((c) => `
            <tr>
              <td>${ctx.escapeHtml(`${c.firstName || ''} ${c.lastName || ''}`.trim())}</td>
              <td>${ctx.escapeHtml(c.emailAddress || '—')}</td>
              <td>${ctx.escapeHtml(c.phoneNumber || '—')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  async function render(container, ctx) {
    container.innerHTML = `
      <h1 class="module-title">Contacts</h1>
      <p class="module-subtitle">Contacts visible to your account.</p>
      <div class="panel">
        <div class="field" style="max-width:360px;">
          <label for="contacts-search">Search</label>
          <input type="text" id="contacts-search" placeholder="Search by name, email or phone…" autocomplete="off">
        </div>
        <div id="contacts-list"><div class="loading-state">Loading…</div></div>
      </div>
    `;

    const listEl = container.querySelector('#contacts-list');
    const searchEl = container.querySelector('#contacts-search');
    if (!listEl) return;

    let searchToken = 0;

    async function runSearch(term) {
      const token = ++searchToken;
      listEl.innerHTML = '<div class="loading-state">Loading…</div>';
      const result = await searchContacts(term.trim());
      if (ctx.isStale() || token !== searchToken) return;
      if (!result.ok) {
        listEl.innerHTML = `<div class="empty-state">Could not load contacts (${ctx.escapeHtml(result.message || 'unknown error')}).</div>`;
        return;
      }
      listEl.innerHTML = renderTable(result.list, ctx);
    }

    let debounceTimer = null;
    searchEl.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => runSearch(searchEl.value), 300);
    });

    await runSearch('');
  }

  window.rvrModules.contacts = { render };
})();
