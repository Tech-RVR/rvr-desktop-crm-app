'use strict';

/**
 * Messages — a cross-case view of client-portal messages, so staff have one
 * place to see "who's messaged in" rather than having to open every case to
 * check. Reads CPortalMessage directly with the logged-in staff member's own
 * EspoCRM session (see case-detail.js's messages panel for the fuller
 * explanation of why no proxy is needed here, unlike the portal-client side).
 *
 * Requires the CPortalMessage staff-role ACL grant (read=team), which has
 * been live since 2026-08-17 — see infrastructure-status.md.
 *
 * 2026-08-27: this screen was broken by its own request, not by that grant.
 * It asked for maxSize: 300, over EspoCRM's hard cap of 200
 * (recordListMaxSizeLimit), and EspoCRM refuses an over-limit list with a
 * bare 403. The screen then caught that 403, assumed it was the ACL grant
 * and showed a reassuring "we're working on a fix" message — so its own bug
 * hid behind a note about somebody else's. It now pages at 200 and reports
 * whatever EspoCRM actually said.
 *
 * "Unread" is local-only bookkeeping (see main.js's Store defaults comment
 * on seenMessagesAt) — a genuine per-user server-side read receipt would
 * need a new EspoCRM field on CPortalMessage, which is a bigger, separate
 * change. This is a deliberately light v1: good enough to tell staff where
 * to look, not a guaranteed-consistent-across-devices read state.
 */

(function () {
  function formatWhen(value) {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    return sameDay
      ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  }

  async function render(container, ctx) {
    container.innerHTML = `
      <h1 class="module-title">Messages</h1>
      <p class="module-subtitle">Every case with a client-portal message, most recent first.</p>
      <div class="panel">
        <div id="messages-dash-list"><div class="loading-state">Loading…</div></div>
      </div>
    `;

    const listEl = container.querySelector('#messages-dash-list');

    // EspoCRM hard-caps a list request at 200 (recordListMaxSizeLimit) and
    // refuses anything larger with a bare 403 — see the note at the top of
    // this file. Page through instead of asking for more in one go.
    const PAGE_SIZE = 200;
    const MAX_MESSAGES = 1000;
    const all = [];
    let loadFailed = null;

    while (all.length < MAX_MESSAGES) {
      const res = await window.rvr.espo.request('CPortalMessage', {
        query: {
          select: 'caseId,createdAt,direction,senderName,messageBody',
          orderBy: 'createdAt',
          order: 'desc',
          maxSize: PAGE_SIZE,
          offset: all.length
        }
      });

      if (ctx.isStale()) return;

      if (!res.ok) { loadFailed = res; break; }

      const page = (res.data && res.data.list) || [];
      all.push(...page);
      if (page.length < PAGE_SIZE) break;
    }

    // A failed read and an empty inbox must never render the same (standing
    // rule). EspoCRM's own wording stays out of the UI — it goes to tech@ in
    // the error report instead; see staffFacingMessage in main.js.
    if (loadFailed) {
      listEl.innerHTML = '<div class="empty-state">Case messages aren\'t loading right now — a report has been sent to the team and we\'re working on a fix.</div>';
      return;
    }

    if (!all.length) {
      listEl.innerHTML = '<div class="empty-state">No client messages yet.</div>';
      return;
    }

    // Group to one row per case: the most recent message (any direction, for
    // context/preview) plus the most recent *client* message's timestamp
    // (what actually drives the unread state).
    const byCase = {};
    all.forEach((m) => {
      if (!m.caseId) return;
      if (!byCase[m.caseId]) byCase[m.caseId] = { latest: m, latestClientAt: null };
      if (new Date(m.createdAt) > new Date(byCase[m.caseId].latest.createdAt)) byCase[m.caseId].latest = m;
      if (m.direction === 'From Client') {
        if (!byCase[m.caseId].latestClientAt || new Date(m.createdAt) > new Date(byCase[m.caseId].latestClientAt)) {
          byCase[m.caseId].latestClientAt = m.createdAt;
        }
      }
    });

    const caseIds = Object.keys(byCase);
    const seenMap = (await window.rvr.messages.getSeen()) || {};
    if (ctx.isStale()) return;

    // One batched lookup for case numbers/contact names rather than N
    // requests — the same "in" filter shape used elsewhere in this app.
    // Same cap applies here. caseIds can also be empty (messages with no
    // case link), and a maxSize of 0 is not a valid request — skip it.
    const casesRes = caseIds.length
      ? await window.rvr.espo.request('Case', {
          query: {
            select: 'number,name,contactName',
            'where[0][type]': 'in',
            'where[0][attribute]': 'id',
            'where[0][value][]': caseIds,
            maxSize: Math.min(caseIds.length, 200)
          }
        })
      : { ok: true, data: { list: [] } };
    if (ctx.isStale()) return;

    const caseInfo = {};
    if (casesRes.ok) {
      ((casesRes.data && casesRes.data.list) || []).forEach((c) => { caseInfo[c.id] = c; });
    }

    const rows = caseIds
      .map((caseId) => {
        const entry = byCase[caseId];
        const info = caseInfo[caseId] || {};
        const seenAt = seenMap[caseId];
        const unread = entry.latestClientAt && (!seenAt || new Date(entry.latestClientAt) > new Date(seenAt));
        return { caseId, entry, info, unread };
      })
      .sort((a, b) => new Date(b.entry.latest.createdAt) - new Date(a.entry.latest.createdAt));

    listEl.innerHTML = `
      <table class="data-table">
        <thead>
          <tr><th></th><th>Case</th><th>Client</th><th>Latest message</th><th>When</th></tr>
        </thead>
        <tbody>
          ${rows.map((r) => `
            <tr class="clickable-row ${r.unread ? 'unread-row' : ''}" data-case-id="${ctx.escapeHtml(r.caseId)}">
              <td>${r.unread ? '<span class="unread-dot"></span>' : ''}</td>
              <td>#${ctx.escapeHtml(r.info.number || '—')}${r.info.name ? ` — ${ctx.escapeHtml(r.info.name)}` : ''}</td>
              <td>${ctx.escapeHtml(r.info.contactName || '—')}</td>
              <td class="message-preview">${ctx.escapeHtml((r.entry.latest.messageBody || '').slice(0, 90))}${(r.entry.latest.messageBody || '').length > 90 ? '…' : ''}</td>
              <td>${formatWhen(r.entry.latest.createdAt)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;

    listEl.querySelectorAll('.clickable-row').forEach((row) => {
      row.addEventListener('click', () => ctx.openCase(row.dataset.caseId));
    });
  }

  window.rvrModules.messages = { render };
})();
