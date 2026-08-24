/* ==========================================================================
   Wicktor — Outcome Journal page logic
   Reads/writes via js/outcomes.js. No dependency on app.js/render.js —
   this page is deliberately isolated from the main scanning screen.
   ========================================================================== */

(() => {
  function esc(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  // ---------------------------------------------------------------- Theme
  // Same localStorage key/logic as app.js's initTheme/toggleTheme, kept
  // as its own small copy rather than a shared module — a few lines,
  // not worth coupling this isolated page to app.js's DOM assumptions.
  const themeBtn = document.getElementById('theme-btn');
  function updateThemeIcon(theme) {
    themeBtn.innerHTML = theme === 'light'
      ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/></svg>'
      : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>';
  }
  function initTheme() {
    const saved = localStorage.getItem('wicktor:theme') || 'dark';
    document.documentElement.setAttribute('data-theme', saved);
    updateThemeIcon(saved);
  }
  themeBtn.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('wicktor:theme', next);
    updateThemeIcon(next);
  });
  initTheme();

  // -------------------------------------------------------------- Render
  const statsEl = document.getElementById('journal-stats');
  const listEl = document.getElementById('journal-list');

  function bandColor(band) {
    if (band === 'Excellent') return 'var(--green-text)';
    if (band === 'Watch') return 'var(--gold-text)';
    return 'var(--text3)';
  }

  function renderStats(entries) {
    const resolved = entries.filter(e => e.outcome != null);
    const wins = resolved.filter(e => e.outcome === 'win').length;
    const losses = resolved.filter(e => e.outcome === 'loss').length;
    const breakeven = resolved.filter(e => e.outcome === 'breakeven').length;
    const winRate = resolved.length ? (wins / resolved.length * 100) : null;

    const tile = (label, value, colorVar) => `
      <div class="strip-tile">
        <div class="strip-label">${label}</div>
        <div class="strip-value"${colorVar ? ` style="color:${colorVar}"` : ''}>${value}</div>
      </div>`;

    statsEl.innerHTML = [
      tile('Logged', entries.length),
      tile('Resolved', resolved.length),
      tile('Win Rate', winRate != null ? winRate.toFixed(0) + '%' : '--', winRate != null && winRate >= 50 ? 'var(--green-text)' : 'var(--red-text)'),
      tile('Wins', wins, 'var(--green-text)'),
      tile('Losses', losses, 'var(--red-text)'),
      tile('Breakeven', breakeven)
    ].join('');
  }

  function renderList(entries) {
    if (!entries.length) {
      listEl.innerHTML = '<div class="loading-state">No calls logged yet — open a coin\'s detail modal in the scanner to start tracking.</div>';
      return;
    }
    const rows = entries.map((e, i) => {
      const [symbol, market] = (e.key || '').split(':');
      const outcomeCell = e.outcome == null
        ? `<div style="display:flex;gap:4px;">
            <button class="btn" data-action="set-outcome" data-idx="${i}" data-outcome="win" style="padding:4px 8px;font-size:11px;">Win</button>
            <button class="btn" data-action="set-outcome" data-idx="${i}" data-outcome="loss" style="padding:4px 8px;font-size:11px;">Loss</button>
            <button class="btn" data-action="set-outcome" data-idx="${i}" data-outcome="breakeven" style="padding:4px 8px;font-size:11px;">BE</button>
          </div>`
        : `<span style="color:${e.outcome === 'win' ? 'var(--green-text)' : e.outcome === 'loss' ? 'var(--red-text)' : 'var(--text3)'};text-transform:capitalize;">${esc(e.outcome)}</span>`;
      return `
        <tr>
          <td>${esc(symbol)} <span style="color:var(--text3);font-size:11px;">${esc(market || '')}</span></td>
          <td style="color:${bandColor(e.band)}">${esc(e.band || '--')}</td>
          <td class="mono">${e.score != null ? e.score : '--'}</td>
          <td>${esc(e.side || '--')}</td>
          <td class="mono">${e.entryPrice != null ? '$' + esc(String(e.entryPrice)) : '--'}</td>
          <td style="color:var(--text3);font-size:11px;">${esc(new Date(e.timestamp).toLocaleString())}</td>
          <td>${outcomeCell}</td>
        </tr>`;
    }).join('');

    listEl.innerHTML = `
      <table class="flows-table">
        <thead><tr><th>Coin</th><th>Band</th><th>Score</th><th>Side</th><th>Entry</th><th>Logged</th><th>Outcome</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  function renderAll() {
    const entries = Outcomes.loadAll();
    renderStats(entries);
    renderList(entries);
  }

  listEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="set-outcome"]');
    if (!btn) return;
    Outcomes.setOutcome(parseInt(btn.dataset.idx, 10), btn.dataset.outcome);
    renderAll();
  });

  renderAll();
})();
