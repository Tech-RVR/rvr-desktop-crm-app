'use strict';

(function () {
  async function render(container, ctx) {
    container.innerHTML = `
      <h1 class="module-title">Contacts</h1>
      <p class="module-subtitle">Contacts visible to your account.</p>
      <div class="panel">
        <div id="contacts-list"><div class="loading-state">Loading…</div></div>
      </div>
    `;

    const res = await window.rvr.espo.request('Contact', {
      query: { select: 'firstName,lastName,emailAddress,phoneNumber', maxSize: 50, orderBy: 'createdAt', order: 'desc' }
    });

    const listEl = container.querySelector('#contacts-list');

    if (!res.ok) {
      listEl.innerHTML = `<div class="empty-state">Could not load contacts (${ctx.escapeHtml(res.message || 'unknown error')}).</div>`;
      return;
    }

    const contacts = (res.data && res.data.list) || [];
    if (contacts.length === 0) {
      listEl.innerHTML = '<div class="empty-state">No contacts visible to your account yet.</div>';
      return;
    }

    listEl.innerHTML = `
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

  window.rvrModules.contacts = { render };
})();
