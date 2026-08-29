'use strict';

(function () {
  function formatDate(iso, escapeHtml) {
    if (!iso) return '';
    // 2026-08-29: this already treated the CRM value as UTC, but then printed
    // it in the machine's timezone. Pinned to Europe/London like everywhere
    // else, through the one shared converter.
    return escapeHtml(window.rvrTime.formatDate(iso, { day: 'numeric' }));
  }

  async function render(container, ctx) {
    // 2026-08-28: this flag used to sit at module scope, so it outlived the
    // screen. One failed claim left it stuck true and every Claim button
    // disabled reading "Claiming..." for the rest of the session - navigating
    // away and back did not clear it, because render() never reset it.
    let isClaiming = false;

    container.innerHTML = `
      <h1 class="module-title">Claim a Case</h1>
      <p class="module-subtitle">Unclaimed cases — new incoming and existing unassigned. Claim one to start work; the office is notified automatically.</p>
      <div class="status-banner" id="claim-status"></div>
      <div class="panel" style="display:flex; justify-content:space-between; align-items:center;">
        <span style="color:var(--slate); font-size:13px;">Signed in as <strong>${ctx.escapeHtml((ctx.user && (`${ctx.user.firstName || ''} ${ctx.user.lastName || ''}`.trim() || ctx.user.userName)) || 'you')}</strong></span>
        <button class="btn btn-secondary" id="claim-refresh">Refresh list</button>
      </div>
      <div id="claim-case-list"><div class="loading-state">Loading unclaimed cases…</div></div>
    `;

    function showStatus(msg, kind) {
      const el = container.querySelector('#claim-status');
      el.textContent = msg;
      el.className = `status-banner show ${kind}`;
    }
    function clearStatus() {
      container.querySelector('#claim-status').className = 'status-banner';
    }

    async function loadList() {
      const listEl = container.querySelector('#claim-case-list');
      listEl.innerHTML = '<div class="loading-state">Loading unclaimed cases…</div>';

      const res = await window.rvr.claimPool.list();
      if (!res.ok) {
        listEl.innerHTML = `<div class="empty-state">Could not load the claim pool (${ctx.escapeHtml((res.data && res.data.message) || 'unknown error')}).</div>`;
        return;
      }

      const cases = (res.data && res.data.cases) || [];
      if (cases.length === 0) {
        listEl.innerHTML = '<div class="empty-state">No unclaimed cases right now — nice and clear.</div>';
        return;
      }

      listEl.innerHTML = `
        <table class="data-table">
          <thead><tr><th>Case</th><th>Stage</th><th>Contact</th><th>Address</th><th>Created</th><th></th></tr></thead>
          <tbody>
            ${cases.map((c) => `
              <tr>
                <td>#${ctx.escapeHtml(c.number)}</td>
                <td>${ctx.escapeHtml(c.stage || '—')}</td>
                <td>${ctx.escapeHtml(c.contactName || '—')}</td>
                <td>${ctx.escapeHtml(c.address || '—')}</td>
                <td>${formatDate(c.createdAt, ctx.escapeHtml)}</td>
                <td><button class="btn btn-primary btn-claim" data-case-id="${ctx.escapeHtml(c.id)}" data-case-number="${ctx.escapeHtml(c.number)}">Claim</button></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;

      listEl.querySelectorAll('.btn-claim').forEach((btn) => {
        btn.addEventListener('click', () => doClaim(btn.dataset.caseId, btn.dataset.caseNumber));
      });
    }

    async function doClaim(caseId, caseNumber) {
      if (isClaiming) return;
      isClaiming = true;
      clearStatus();
      container.querySelectorAll('.btn-claim').forEach((b) => { b.disabled = true; b.textContent = 'Claiming…'; });

      let res;
      try {
        res = await window.rvr.claimPool.submit(caseId, ctx.user.id);
      } catch (err) {
        // Belt and braces. n8nClient no longer rejects, but if anything else
        // in the bridge throws, this screen must still come back to life
        // rather than freezing every button on it.
        res = { ok: false, data: null };
      } finally {
        isClaiming = false;
      }

      if (res.ok && res.data && res.data.success) {
        showStatus(`You've claimed Case #${caseNumber} — the office has been notified.`, 'ok');
        loadList();
      } else {
        showStatus((res.data && res.data.message) || 'This case could not be claimed — it may have just been claimed by someone else.', 'err');
        loadList();
      }
    }

    container.querySelector('#claim-refresh').addEventListener('click', loadList);
    loadList();
  }

  window.rvrModules['claim-pool'] = { render };
})();
