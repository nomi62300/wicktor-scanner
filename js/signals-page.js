/* ==========================================================================
   Wicktor — Signal Journal page

   Reads the journal straight from PostgREST with the publishable key. No
   login and no access gate: signal_journal is public-select by design (a
   market observation is not personal data), and the value of this page is
   that the record can be checked by someone who does not have to be
   trusted — gating it would defeat that.

   Deliberately standalone, like journal.html: no app.js, no scanner state,
   nothing that can break when the scanner changes.
   ========================================================================== */

(() => {
  const REST = 'https://fpyfetynfobfrpunnnhv.supabase.co/rest/v1/signal_journal';
  const KEY = 'sb_publishable_95VI9mw_oHduFoqUlToCmg_CpfPucLC';
  const LIMIT = 500;

  const summaryEl = document.getElementById('summary');
  const listEl = document.getElementById('list');

  function esc(str) {
    const d = document.createElement('div');
    d.textContent = str == null ? '' : String(str);
    return d.innerHTML;
  }

  // Same theme key/behaviour as the other pages, kept as its own small copy
  // rather than coupling this page to app.js.
  const themeBtn = document.getElementById('theme-btn');
  const ICON_SUN = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/></svg>';
  const ICON_MOON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>';
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    themeBtn.innerHTML = t === 'light' ? ICON_SUN : ICON_MOON;
  }
  applyTheme(localStorage.getItem('wicktor:theme') || 'dark');
  themeBtn.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    localStorage.setItem('wicktor:theme', next);
    applyTheme(next);
  });

  const BYBIT = 'https://api.bybit.com';

  const fmtR = v => v == null ? '--' : (v >= 0 ? '+' : '') + Number(v).toFixed(2) + 'R';
  const rColor = v => v == null ? 'var(--text3)' : (v >= 0 ? 'var(--green-text)' : 'var(--red-text)');
  const mean = xs => xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null;

  function stat(rows, key) {
    const val = r => Number(r[key]);
    const all = rows.filter(r => r[key] != null).map(val);
    // Direction-balanced, for the same reason every measurement in this
    // project is: in a trending market a long-heavy sample reads as skill.
    const bull = rows.filter(r => r.direction === 1 && r[key] != null).map(val);
    const bear = rows.filter(r => r.direction === -1 && r[key] != null).map(val);
    return {
      n: all.length,
      winPct: all.length ? all.filter(v => v > 0).length / all.length * 100 : null,
      mean: mean(all),
      balanced: (bull.length && bear.length) ? (mean(bull) + mean(bear)) / 2 : null
    };
  }

  const tile = (label, value, color) => `
    <div class="strip-tile">
      <div class="strip-label">${label}</div>
      <div class="strip-value"${color ? ` style="color:${color}"` : ''}>${value}</div>
    </div>`;

  function renderSummary(rows) {
    const resolved = rows.filter(r => r.status === 'resolved');
    const open = rows.filter(r => r.status === 'open');

    if (!resolved.length) {
      summaryEl.innerHTML =
        tile('Logged', rows.length) +
        tile('Open', open.length) +
        tile('Resolved', 0) +
        tile('Status', 'Awaiting outcomes', 'var(--gold-text)');
      return;
    }

    const a = stat(resolved, 'outcome_a');
    const b = stat(resolved, 'outcome_b');
    summaryEl.innerHTML =
      tile('Logged', rows.length) +
      tile('Open', open.length) +
      tile('Resolved', resolved.length) +
      tile('Win rate · A', a.winPct != null ? a.winPct.toFixed(0) + '%' : '--',
        a.winPct != null && a.winPct >= 50 ? 'var(--green-text)' : 'var(--red-text)') +
      tile('Mean R · A', fmtR(a.mean), rColor(a.mean)) +
      tile('Balanced R · A', fmtR(a.balanced), rColor(a.balanced)) +
      tile('Mean R · B', fmtR(b.mean), rColor(b.mean)) +
      tile('Balanced R · B', fmtR(b.balanced), rColor(b.balanced));
  }

  function statusCell(r) {
    if (r.status === 'open') return '<span style="color:var(--gold-text);">Open</span>';
    if (r.status === 'expired') return '<span style="color:var(--text3);">Expired</span>';
    return `<span style="color:var(--text2);text-transform:capitalize;">${esc(r.exit_reason || 'resolved')}</span>`;
  }

  // Matches app.js's formatPrice() convention, kept local since this page
  // is deliberately standalone.
  function fmtPrice(n) {
    if (n == null || isNaN(n)) return '--';
    n = Number(n);
    if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
    if (n >= 1) return n.toFixed(2);
    if (n >= 0.01) return n.toFixed(4);
    // Sub-cent alts (meme coins etc.) lose all information at 4dp -- show
    // enough significant figures to actually see the level.
    return n.toPrecision(4);
  }

  // TP1/TP2/TP3 are Plan A's rungs (js/signals.js PLAN_A): a third off at
  // 1/3 of the target, a third at 2/3, the rest at the full target. The
  // stored `target` column IS TP3 -- entry and target are the two real
  // numbers the model committed to; TP1/TP2 are interpolated for display.
  function tpLevels(r) {
    const entry = Number(r.entry), target = Number(r.target);
    const dist = target - entry;
    return [1 / 3, 2 / 3, 1].map(f => entry + dist * f);
  }

  // Mark price for every OPEN row, fetched once per load() cycle (not on a
  // separate timer) -- exactly two requests regardless of how many open
  // rows there are, since Bybit's tickers endpoint returns the whole
  // category in one call. Missing/failed fetch degrades to '--' rather than
  // breaking the page; this is a display convenience, not the journal's
  // record of truth (that's still entry/stop/target, fixed at signal time).
  async function fetchMarkPrices(rows) {
    const open = rows.filter(r => r.status === 'open');
    if (!open.length) return {};
    const needSpot = open.some(r => r.market === 'SPOT');
    const needPerp = open.some(r => r.market === 'PERP');
    const marks = {};
    await Promise.all([
      needSpot ? fetchCategory('spot', marks) : null,
      needPerp ? fetchCategory('linear', marks) : null
    ]);
    return marks;

    async function fetchCategory(category, out) {
      try {
        const res = await fetch(`${BYBIT}/v5/market/tickers?category=${category}`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.retCode !== 0) return;
        const market = category === 'linear' ? 'PERP' : 'SPOT';
        for (const t of data.result.list) out[`${t.symbol}:${market}`] = parseFloat(t.lastPrice);
      } catch (e) { console.warn('[SignalsPage] mark price fetch failed', category, e.message); }
    }
  }

  function renderList(rows, marks) {
    if (!rows.length) {
      listEl.innerHTML = '<div class="empty-state">No signals logged yet. The journal fills up as the scanner finds EXCELLENT (score 80+) setups while signed in.</div>';
      return;
    }
    const body = rows.map(r => {
      const [tp1, tp2, tp3] = tpLevels(r);
      const mark = r.status === 'open' ? marks[`${r.symbol}:${r.market}`] : null;
      // Running R against the SAME risk unit the trade was specified with —
      // mark-to-market, not a claim about how the trade will actually exit
      // (partial takes / breakeven only apply once a TP is genuinely hit).
      const risk = Math.abs(r.entry - r.stop);
      const pnlR = (mark != null && risk) ? (r.direction * (mark - r.entry)) / risk : null;
      return `
      <tr>
        <td>${esc(r.symbol.replace(/USDT$/, ''))} <span style="color:var(--text3);font-size:11px;">${esc(r.market)}</span></td>
        <td style="color:${r.direction === 1 ? 'var(--green-text)' : 'var(--red-text)'};">${r.direction === 1 ? 'Long' : 'Short'}</td>
        <td class="mono">${esc(r.score)}</td>
        <td style="font-size:11px;color:var(--text2);">${esc(r.trigger_name || '--')}</td>
        <td style="font-size:11px;color:var(--text2);">${esc(r.context_regime || '--')}</td>
        <td class="mono">${fmtPrice(r.entry)}</td>
        <td class="mono" style="color:var(--red-text);">${fmtPrice(r.stop)}</td>
        <td class="mono" style="color:var(--green-text);">${fmtPrice(tp1)}</td>
        <td class="mono" style="color:var(--green-text);">${fmtPrice(tp2)}</td>
        <td class="mono" style="color:var(--green-text);">${fmtPrice(tp3)}</td>
        <td class="mono">${r.status === 'open' ? fmtPrice(mark) : '--'}</td>
        <td class="mono" style="color:${rColor(pnlR)}">${r.status === 'open' ? fmtR(pnlR) : '--'}</td>
        <td class="mono">${r.risk_pct != null ? Number(r.risk_pct).toFixed(2) + '%' : '--'}</td>
        <td>${statusCell(r)}</td>
        <td class="mono" style="color:${rColor(r.outcome_a)}">${fmtR(r.outcome_a)}</td>
        <td class="mono" style="color:${rColor(r.outcome_b)}">${fmtR(r.outcome_b)}</td>
        <td style="color:var(--text3);font-size:11px;white-space:nowrap;">${esc(new Date(r.created_at).toLocaleString())}</td>
      </tr>`;
    }).join('');

    listEl.innerHTML = `
      <div style="overflow-x:auto;">
        <table class="flows-table">
          <thead><tr>
            <th>Coin</th><th>Side</th><th>Score</th><th>Trigger</th><th>Regime</th>
            <th>Entry</th><th>SL</th><th>TP1</th><th>TP2</th><th>TP3</th>
            <th>Mark</th><th>PnL</th>
            <th>1R</th><th>Status</th><th>Plan A</th><th>Plan B</th><th>Logged</th>
          </tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>`;
  }

  async function load() {
    try {
      const res = await fetch(`${REST}?select=*&order=created_at.desc&limit=${LIMIT}`, {
        headers: { apikey: KEY, Authorization: `Bearer ${KEY}` }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = await res.json();
      const marks = await fetchMarkPrices(rows);
      renderSummary(rows);
      renderList(rows, marks);
    } catch (e) {
      summaryEl.innerHTML = '';
      listEl.innerHTML = `<div class="empty-state">Could not load the journal (${esc(e.message)}).</div>`;
    }
  }

  load();
  setInterval(load, 60000);
})();
