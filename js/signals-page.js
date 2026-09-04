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
  // LIST_LIMIT bounds the TABLE only (newest first) -- a UI display cap, not
  // the record itself. STATS_LIMIT feeds the summary tiles and tab counts,
  // which must reflect the WHOLE journal or they silently window to
  // whatever the table happens to show. These used to be the same number,
  // which was invisible while total rows stayed under 500; once the
  // universe went 120->350 (2026-09-04) the logging rate rose enough that
  // the newest 500 rows started covering ~2 days instead of the full
  // history, and the summary quietly started describing that 2-day slice
  // instead of the journal. Headroomed well above current volume (~800).
  const LIST_LIMIT = 500;
  const STATS_LIMIT = 20000;
  const BYBIT = 'https://api.bybit.com';
  // tp1_hit/tp2_hit/tp3_hit were added by the 20260826090000 migration —
  // rows resolved before that default to false regardless of what actually
  // happened, so the TP-hit-rate stat must exclude them or it understates
  // every rate. Rows are still shown in the table either way; this cutoff
  // only affects which ones count toward the aggregate.
  const TP_TRACKING_SINCE = Date.parse('2026-08-26T09:00:00Z');

  const summaryEl = document.getElementById('summary');
  const listEl = document.getElementById('list');
  const tableNoteEl = document.getElementById('table-note');

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

  const fmtR = v => v == null ? '--' : (v >= 0 ? '+' : '') + Number(v).toFixed(2) + 'R';
  const fmtPct = v => v == null ? '--' : (v >= 0 ? '+' : '') + Number(v).toFixed(0) + '%';
  const rColor = v => v == null ? 'var(--text3)' : (v >= 0 ? 'var(--green-text)' : 'var(--red-text)');
  const mean = xs => xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null;

  // Cached from the last successful load(), so switching the Long/Short tab
  // re-renders instantly from what's already in memory rather than
  // re-fetching — the tab is a client-side filter, not a new query.
  // rows = windowed (LIST_LIMIT, newest first) for the table.
  // statsRows = the whole journal (STATS_LIMIT, minimal columns) for the
  // summary tiles and tab counts, so they never describe a recent slice
  // instead of the record.
  const state = { rows: [], statsRows: [], marks: {}, filter: 'all' };

  function filtered() {
    if (state.filter === 'long') return state.rows.filter(r => r.direction === 1);
    if (state.filter === 'short') return state.rows.filter(r => r.direction === -1);
    return state.rows;
  }

  function statsFiltered() {
    if (state.filter === 'long') return state.statsRows.filter(r => r.direction === 1);
    if (state.filter === 'short') return state.statsRows.filter(r => r.direction === -1);
    return state.statsRows;
  }

  function stat(rows, key) {
    const val = r => Number(r[key]);
    const all = rows.filter(r => r[key] != null).map(val);
    // Direction-balanced, for the same reason every measurement in this
    // project is: in a trending market a long-heavy sample reads as skill.
    // (Balanced collapses to the plain mean when a Long/Short tab has
    // already restricted the sample to one direction — nothing left to
    // average against.)
    const bull = rows.filter(r => r.direction === 1 && r[key] != null).map(val);
    const bear = rows.filter(r => r.direction === -1 && r[key] != null).map(val);
    return {
      n: all.length,
      winPct: all.length ? all.filter(v => v > 0).length / all.length * 100 : null,
      mean: mean(all),
      balanced: (bull.length && bear.length) ? (mean(bull) + mean(bear)) / 2
        : (bull.length || bear.length) ? mean(all) : null
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
    const longs = rows.filter(r => r.direction === 1).length;
    const shorts = rows.filter(r => r.direction === -1).length;

    const baseTiles =
      tile('Logged', rows.length) +
      tile('Long', longs, 'var(--green-text)') +
      tile('Short', shorts, 'var(--red-text)') +
      tile('Open', open.length);

    if (!resolved.length) {
      summaryEl.innerHTML = baseTiles + tile('Resolved', 0) + tile('Status', 'Awaiting outcomes', 'var(--gold-text)');
      return;
    }

    const a = stat(resolved, 'outcome_a');
    const b = stat(resolved, 'outcome_b');

    // TP-hit rate, restricted to rows the tracking migration actually
    // covers — see TP_TRACKING_SINCE above.
    const tracked = resolved.filter(r => Date.parse(r.resolved_at) >= TP_TRACKING_SINCE);
    const tpRate = key => tracked.length ? tracked.filter(r => r[key]).length / tracked.length * 100 : null;

    summaryEl.innerHTML = baseTiles +
      tile('Resolved', resolved.length) +
      tile('Win rate · A', a.winPct != null ? a.winPct.toFixed(0) + '%' : '--',
        a.winPct != null && a.winPct >= 50 ? 'var(--green-text)' : 'var(--red-text)') +
      tile('Mean R · A', fmtR(a.mean), rColor(a.mean)) +
      tile('Balanced R · A', fmtR(a.balanced), rColor(a.balanced)) +
      tile('Mean R · B', fmtR(b.mean), rColor(b.mean)) +
      tile('Balanced R · B', fmtR(b.balanced), rColor(b.balanced)) +
      tile('TP1 Hit', tracked.length ? tpRate('tp1_hit').toFixed(0) + '% (n=' + tracked.length + ')' : '--') +
      tile('TP2 Hit', tracked.length ? tpRate('tp2_hit').toFixed(0) + '%' : '--') +
      tile('TP3 Hit', tracked.length ? tpRate('tp3_hit').toFixed(0) + '%' : '--');
  }

  function renderTabs() {
    const n = f => f === 'all' ? state.statsRows.length
      : state.statsRows.filter(r => r.direction === (f === 'long' ? 1 : -1)).length;
    const tabs = [['all', 'All'], ['long', 'Long'], ['short', 'Short']];
    document.getElementById('tabs').innerHTML = tabs.map(([key, label]) =>
      `<button class="chip${state.filter === key ? ' active' : ''}" data-filter="${key}">${label} (${n(key)})</button>`
    ).join('');
    document.getElementById('tabs').querySelectorAll('[data-filter]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.filter = btn.dataset.filter;
        renderTabs();
        renderSummary(statsFiltered());
        renderList(filtered(), state.marks);
      });
    });
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

  // % of the way from entry to the full target (TP3), in the SAME units for
  // open and resolved rows so the column reads consistently: for an open
  // row it's the live mark's progress; for a resolved one it's derived from
  // Plan B's outcome (a fixed-stop, single-target walk — the closest thing
  // to "how far did the market actually get" free of any partial-exit
  // bookkeeping). A stopped-out trade reads as a negative percentage, which
  // is the honest reading: it moved the equivalent distance against you.
  function progressPct(r, mark) {
    const entry = Number(r.entry), target = Number(r.target), stop = Number(r.stop);
    const risk = Math.abs(entry - stop);
    const targetDist = Math.abs(target - entry);
    if (!risk || !targetDist) return null;
    if (r.status === 'open') {
      if (mark == null) return null;
      return ((r.direction * (mark - entry)) / targetDist) * 100;
    }
    if (r.outcome_b == null) return null;
    const targetR = targetDist / risk;
    return (r.outcome_b / targetR) * 100;
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

  function tpBadge(hit, label) {
    const color = hit ? 'var(--green-text)' : 'var(--text3)';
    return `<span style="color:${color};font-size:11px;">${label}${hit ? ' ✓' : ''}</span>`;
  }

  function renderList(rows, marks) {
    if (!rows.length) {
      listEl.innerHTML = '<div class="empty-state">No signals in this view yet.</div>';
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
      const pct = progressPct(r, mark);
      const tracked = r.status === 'resolved' && Date.parse(r.resolved_at) >= TP_TRACKING_SINCE;
      const tpCell = r.status === 'open'
        ? `${tpBadge(mark != null && (r.direction === 1 ? mark >= tp1 : mark <= tp1), 'TP1')} ${tpBadge(mark != null && (r.direction === 1 ? mark >= tp2 : mark <= tp2), 'TP2')} ${tpBadge(mark != null && (r.direction === 1 ? mark >= tp3 : mark <= tp3), 'TP3')}`
        : tracked
          ? `${tpBadge(r.tp1_hit, 'TP1')} ${tpBadge(r.tp2_hit, 'TP2')} ${tpBadge(r.tp3_hit, 'TP3')}`
          : '<span style="color:var(--text3);font-size:11px;">not tracked</span>';
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
        <td style="white-space:nowrap;">${tpCell}</td>
        <td class="mono">${r.status === 'open' ? fmtPrice(mark) : '--'}</td>
        <td class="mono" style="color:${rColor(pnlR)}">${r.status === 'open' ? fmtR(pnlR) : '--'}</td>
        <td class="mono" style="color:${rColor(pct)}">${fmtPct(pct)}</td>
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
            <th>Entry</th><th>SL</th><th>TP1</th><th>TP2</th><th>TP3</th><th>TP Touches</th>
            <th>Mark</th><th>PnL</th><th>% to Target</th>
            <th>1R</th><th>Status</th><th>Plan A</th><th>Plan B</th><th>Logged</th>
          </tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>`;
  }

  async function load() {
    try {
      const headers = { apikey: KEY, Authorization: `Bearer ${KEY}` };
      const [listRes, statsRes] = await Promise.all([
        fetch(`${REST}?select=*&order=created_at.desc&limit=${LIST_LIMIT}`, { headers }),
        fetch(`${REST}?select=direction,status,outcome_a,outcome_b,tp1_hit,tp2_hit,tp3_hit,resolved_at&limit=${STATS_LIMIT}`, { headers })
      ]);
      if (!listRes.ok) throw new Error(`HTTP ${listRes.status}`);
      if (!statsRes.ok) throw new Error(`HTTP ${statsRes.status}`);
      state.rows = await listRes.json();
      state.statsRows = await statsRes.json();
      state.marks = await fetchMarkPrices(state.rows);
      tableNoteEl.textContent = state.statsRows.length > state.rows.length
        ? `Table shows the newest ${state.rows.length.toLocaleString()} of ${state.statsRows.length.toLocaleString()} logged signals. Summary and tab counts above reflect all ${state.statsRows.length.toLocaleString()}.`
        : '';
      renderTabs();
      renderSummary(statsFiltered());
      renderList(filtered(), state.marks);
    } catch (e) {
      summaryEl.innerHTML = '';
      listEl.innerHTML = `<div class="empty-state">Could not load the journal (${esc(e.message)}).</div>`;
    }
  }

  load();
  setInterval(load, 60000);
})();
