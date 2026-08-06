/* ==========================================================================
   Wicktor — Render Layer
   Pure(ish) functions that turn computed data into DOM. No fetching here.
   ========================================================================== */

const Render = (() => {

  const TF_LABELS = ['1H', '15M', '5M'];

  function esc(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function tfArrowHtml(v) {
    if (v === 1) return '<span class="tf-up">&#9650;</span>';
    if (v === -1) return '<span class="tf-down">&#9660;</span>';
    return '<span class="tf-flat">&mdash;</span>';
  }

  function rsiColor(v) {
    if (v == null) return 'var(--text3)';
    if (v >= 70) return 'var(--red-text)';
    if (v <= 35) return 'var(--green-text)';
    return 'var(--gold-text)';
  }

  function ringColor(score) {
    if (score >= 80) return 'var(--green)';
    if (score >= 50) return 'var(--gold)';
    return 'var(--text3)';
  }

  function toneColor(tone) {
    return { green: 'var(--green-text)', gold: 'var(--gold-text)',
             red: 'var(--red-text)', grey: 'var(--text3)' }[tone] || 'var(--text)';
  }

  function scoreRingSvg(score, size = 38, strokeW = 3) {
    const r = (size - strokeW * 2) / 2;
    const c = size / 2;
    const circ = 2 * Math.PI * r;
    const offset = circ - (score / 100) * circ;
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" class="score-ring">
      <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="var(--surf2)" stroke-width="${strokeW}"/>
      <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${ringColor(score)}" stroke-width="${strokeW}"
        stroke-dasharray="${circ}" stroke-dashoffset="${offset}" stroke-linecap="round"
        transform="rotate(-90 ${c} ${c})"/>
      <text x="${c}" y="${c + 4}" text-anchor="middle" font-size="${size * 0.29}" fill="var(--text)">${score}</text>
    </svg>`;
  }

  function directionGaugeHtml(dir) {
    const pct = ((dir + 100) / 200 * 100).toFixed(0);
    return `<div class="gauge-track"><div class="gauge-dot" style="left:${pct}%"></div></div>`;
  }

  function marketBadgeHtml(market) {
    const cls = market === 'PERP' ? 'perp' : 'spot';
    return `<span class="market-badge ${cls}">${market}</span>`;
  }

  function sideBadgeHtml(side) {
    const cls = (side === 'Sell' || side === 'Short') ? 'sell' : 'buy';
    return `<span class="side-badge ${cls}">${side}</span>`;
  }

  function divChipHtml(div) {
    const map = { bull: ['Bullish', 'var(--green-text)'], bear: ['Bearish', 'var(--red-text)'], none: ['None', 'var(--text3)'] };
    const [text, color] = map[div] || map.none;
    return `<span class="info-chip" style="color:${color}">Div: ${text}</span>`;
  }

  function volChipHtml(vol) {
    const color = (vol === 'High' || vol === 'Extreme') ? 'var(--red-text)' : 'var(--text2)';
    return `<span class="info-chip" style="color:${color}">Vol: ${vol}</span>`;
  }

  function unlockChipHtml(unlock) {
    if (!unlock) return '';
    const colorMap = { red: 'var(--red-text)', amber: 'var(--gold-text)', grey: 'var(--text2)' };
    const color = colorMap[unlock.severity] || colorMap.grey;
    return `<span class="info-chip" style="color:${color}">Unlock: ${unlock.days}d ${unlock.hours}h &middot; ${esc(unlock.amount)} (${unlock.pct}%)</span>`;
  }

  function newsCountHtml(newsMeta) {
    const count = newsMeta && newsMeta.count != null ? newsMeta.count : 0;
    const label = count > 9 ? '9+' : String(count);
    let color = 'var(--text3)';
    if (count > 0 && newsMeta.dominantSentiment) {
      color = { bull: 'var(--green)', bear: 'var(--red)', neutral: 'var(--gold)' }[newsMeta.dominantSentiment] || color;
    }
    return `<span class="news-count" style="background:${color}33;color:${color}">${label}</span>`;
  }

  /**
   * coin = {
   *   symbol, sector, price, market('SPOT'|'PERP'), side, discoveredAgo,
   *   mcap, volatility, unlock, newsMeta, watchlisted,
   *   ...scoring result fields (score, regime, direction, tfAlignment, rsiByTf,
   *        divergenceOverall, continuation, exhaustion, reversal)
   * }
   */
  function cardHtml(coin, idx) {
    const band = Scoring.bandLabel(coin.score, coin.unlock);
    const tfRow = coin.tfAlignment.map((v, i) =>
      `<span class="tf-item">${TF_LABELS[i]} ${tfArrowHtml(v)}</span>`).join('');
    const rsiRow = coin.rsiByTf.map((v, i) =>
      `<span style="color:${rsiColor(v)}">${TF_LABELS[i]} ${v != null ? v : '--'}</span>`).join(' &middot; ');
    const unlockSevereCls = coin.unlock && coin.unlock.severity === 'red' ? ' unlock-severe' : '';
    const sideCls = (coin.side === 'Buy' || coin.side === 'Long') ? ' side-buy'
                  : (coin.side === 'Sell' || coin.side === 'Short') ? ' side-sell'
                  : '';

    return `
    <div class="coin-card${unlockSevereCls}${sideCls}" data-idx="${idx}" tabindex="0" role="button" aria-label="${esc(coin.symbol)} details">
      <div class="card-row-top">
        <span class="card-time"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg> ${esc(coin.discoveredAgo)} ago</span>
        ${marketBadgeHtml(coin.market)}
      </div>
      <div class="card-head">
        ${scoreRingSvg(coin.score)}
        <div>
          <div class="card-sym">${esc(coin.symbol)}</div>
          <span class="sector-chip">${esc(coin.sector)}</span>
        </div>
      </div>
      <div class="card-band-row">
        <span class="regime-text" style="color:${coin.direction >= 0 ? 'var(--green-text)' : 'var(--red-text)'}">${esc(coin.regime)}</span>
        <span class="band-label" style="color:${toneColor(band.tone)}">${band.text}</span>
      </div>
      ${directionGaugeHtml(coin.direction)}
      <div class="card-price-row">
        <span class="card-price">$${esc(coin.price)}</span>
        ${sideBadgeHtml(coin.side)}
      </div>
      <div class="tf-label">Active TF</div>
      <div class="tf-row">${tfRow}</div>
      <div class="rsi-row">RSI: ${rsiRow}</div>
      <div class="cer-row">
        <span class="cer-cont">CONT ${coin.continuation.score}</span>
        <span class="cer-exh">EXH ${coin.exhaustion.score}</span>
        <span class="cer-rev">REV ${coin.reversal.score}</span>
      </div>
      <div class="chip-row">
        ${divChipHtml(coin.divergenceOverall)}
        ${volChipHtml(coin.volatility)}
        ${unlockChipHtml(coin.unlock)}
      </div>
      <div class="card-divider news-row">
        <span style="font-size:10px;color:var(--text2)">Latest News &amp; Reports</span>
        ${newsCountHtml(coin.newsMeta)}
      </div>
      <div class="card-divider card-foot">
        <span class="mcap-text">MCap $${esc(coin.mcap)}</span>
        <div class="foot-actions">
          <button class="icon-only star-btn${coin.watchlisted ? ' active' : ''}" data-action="star" data-idx="${idx}" aria-label="Toggle watchlist">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="${coin.watchlisted ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><polygon points="12 2 15 9 22 9 17 14 19 21 12 17 5 21 7 14 2 9 9 9"/></svg>
          </button>
          <button class="chart-btn" data-action="chart" data-idx="${idx}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/></svg>
            Chart
          </button>
        </div>
      </div>
    </div>`;
  }

  function renderCardGrid(container, coins) {
    if (!coins.length) {
      container.innerHTML = `<div class="empty-state">No coins match the current filters. Try widening your search or waiting for the next scan.</div>`;
      return;
    }
    container.innerHTML = coins.map((c, i) => cardHtml(c, i)).join('');
  }

  function breakdownBlockHtml(label, colorVar, val, items) {
    const rows = items.map(([label, pts]) =>
      `<div class="breakdown-item"><span>${esc(label)}</span><span style="color:${colorVar}">+${pts}</span></div>`
    ).join('');
    return `
    <div class="block">
      <div class="block-title-row"><span style="color:${colorVar}">${label}</span><span>${val}/100</span></div>
      <div class="bar-track"><div class="bar-fill" style="width:${val}%;background:${colorVar}"></div></div>
      ${rows}
    </div>`;
  }

  function sentTagHtml(sent) {
    const map = { bull: ['Bullish', 'sent-bull'], bear: ['Bearish', 'sent-bear'], neutral: ['Neutral', 'sent-neutral'] };
    const [text, cls] = map[sent] || map.neutral;
    return `<span class="sent-tag ${cls}">${text}</span>`;
  }

  function timeAgo(iso) {
    if (!iso) return '';
    const diffMs = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    return `${Math.floor(hrs / 24)}d`;
  }

  function newsSectionHtml(newsResult) {
    if (!newsResult) {
      return `<div class="news-section-label">Latest news &amp; reports</div><div class="empty-note">Loading news...</div>`;
    }
    if (newsResult.error === 'no-key') {
      return `<div class="news-section-label">Latest news &amp; reports</div><div class="empty-note">Add your FMP API key in Settings to see news for this coin.</div>`;
    }
    if (newsResult.error) {
      return `<div class="news-section-label">Latest news &amp; reports</div><div class="empty-note">News is temporarily unavailable.</div>`;
    }
    if (!newsResult.items || !newsResult.items.length) {
      return `<div class="news-section-label">Latest news &amp; reports</div><div class="empty-note">No recent news for this coin.</div>`;
    }
    const rows = newsResult.items.map(n => `
      <div class="news-item">
        <a href="${esc(n.url)}" target="_blank" rel="noopener noreferrer" class="news-headline">${esc(n.headline)}</a>
        <div class="news-meta">
          <span class="news-src">${esc(n.source)} &middot; ${timeAgo(n.time)} ago</span>
          ${sentTagHtml(n.sentiment)}
        </div>
      </div>`).join('');
    return `<div class="news-section-label">Latest news &amp; reports</div>${rows}`;
  }

  function detailModalHtml(coin, newsResult) {
    const band = Scoring.bandLabel(coin.score, coin.unlock);
    const dirPct = ((coin.direction + 100) / 200 * 100).toFixed(0);
    const unlockBlock = coin.unlock ? `
      <div class="block${coin.unlock.severity === 'red' ? ' block-warn' : ''}" style="color:${coin.unlock.severity === 'red' ? 'var(--red-text)' : 'var(--gold-text)'};font-size:11px;">
        ${coin.unlock.severity === 'red' ? '&#9888; ' : ''}Unlock in ${coin.unlock.days}d ${coin.unlock.hours}h &middot; ${esc(coin.unlock.amount)} tokens (${coin.unlock.pct}% of supply)
      </div>` : '';

    return `
      <div class="modal-head">
        <div style="display:flex;align-items:center;gap:10px;">
          ${scoreRingSvg(coin.score, 44, 3)}
          <div>
            <div style="font-size:16px;font-weight:500;">${esc(coin.symbol)} <span style="font-size:11px;color:var(--text3);font-weight:400;">${esc(coin.market)}</span></div>
            <div style="font-size:12px;color:${coin.direction >= 0 ? 'var(--green-text)' : 'var(--red-text)'}">$${esc(coin.price)} &middot; ${esc(coin.regime)} &middot; <span style="color:${toneColor(band.tone)}">${band.text}</span></div>
          </div>
        </div>
        <span class="modal-close" data-action="close-modal" role="button" aria-label="Close">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </span>
      </div>
      ${unlockBlock}
      <div class="block">
        <div class="block-title-row"><span>Direction</span><span style="color:${coin.direction >= 0 ? 'var(--green-text)' : 'var(--red-text)'}">${coin.direction > 0 ? '+' : ''}${coin.direction}</span></div>
        ${directionGaugeHtml(coin.direction)}
      </div>
      ${breakdownBlockHtml('Continuation', 'var(--green)', coin.continuation.score, coin.continuation.items)}
      ${breakdownBlockHtml('Exhaustion', 'var(--gold)', coin.exhaustion.score, coin.exhaustion.items)}
      ${breakdownBlockHtml('Reversal', 'var(--text3)', coin.reversal.score, coin.reversal.items)}
      <div class="news-section-label" style="margin-top:2px;">Key levels</div>
      <div class="levels-grid">
        <div class="level-box"><div class="level-box-label">Resistance</div><div class="level-box-value" style="color:var(--red-text)">$${esc(coin.resistance)}</div></div>
        <div class="level-box"><div class="level-box-label">Support</div><div class="level-box-value" style="color:var(--green-text)">$${esc(coin.support)}</div></div>
      </div>
      ${newsSectionHtml(newsResult)}
    `;
  }

  // ------------------------------------------------------------ Top strip

  function topStripHtml(data) {
    const pulseTile = (label, val) => {
      if (val == null) {
        return `
        <div class="strip-tile">
          <div class="strip-label">${label}</div>
          <div class="strip-value" style="color:var(--text3)">No data</div>
          <div class="gauge-track"><div class="gauge-dot" style="left:50%;opacity:0.3"></div></div>
          <div class="gauge-labels"><span>Bearish</span><span>Bullish</span></div>
        </div>`;
      }
      const biasLabel = val >= 0 ? 'Bullish' : 'Bearish';
      const colorVar = val >= 0 ? 'var(--green-text)' : 'var(--red-text)';
      return `
        <div class="strip-tile">
          <div class="strip-label">${label}</div>
          <div class="strip-value" style="color:${colorVar}">${biasLabel} ${Math.abs(val)}</div>
          <div class="gauge-track"><div class="gauge-dot" style="left:${((val + 100) / 200 * 100).toFixed(0)}%"></div></div>
          <div class="gauge-labels"><span>Bearish</span><span>Bullish</span></div>
        </div>`;
    };

    const fngVal = data.fearGreed ? data.fearGreed.value : null;
    const fngTile = `
      <div class="strip-tile">
        <div class="strip-label">Fear &amp; Greed</div>
        <div class="strip-value" style="color:var(--gold-text)">${fngVal != null ? fngVal + ' ' + data.fearGreed.label : '--'}</div>
        <div class="gauge-track fear-greed"><div class="gauge-dot" style="left:${fngVal != null ? fngVal : 50}%"></div></div>
        <div class="gauge-labels"><span>Fear</span><span>Greed</span></div>
      </div>`;

    const domTile = `
      <div class="strip-tile">
        <div class="strip-label">BTC Dominance</div>
        <div class="strip-value mono">${data.btcDominance != null ? data.btcDominance.toFixed(1) + '%' : '--'}</div>
        <div class="fill-bar"><div style="width:${data.btcDominance || 0}%"></div></div>
      </div>`;

    const mcapChangeColor = (data.mcapChange24h || 0) >= 0 ? 'var(--green-text)' : 'var(--red-text)';
    const mcapArrow = (data.mcapChange24h || 0) >= 0 ? '&#9650;' : '&#9660;';
    const mcapTile = `
      <div class="strip-tile">
        <div class="strip-label">Market Cap &middot; 24h</div>
        <div class="strip-value mono">${data.mcap || '--'} <span style="font-size:11px;color:${mcapChangeColor}">${mcapArrow} ${Math.abs(data.mcapChange24h || 0).toFixed(1)}%</span></div>
      </div>`;

    const sectorTile = `
      <div class="strip-tile">
        <div class="strip-label">Top Sector &middot; 24h</div>
        <div class="strip-value" style="color:var(--green-text)">${data.topSector ? esc(data.topSector.name) + ' +' + data.topSector.change.toFixed(1) + '%' : '--'}</div>
      </div>`;

    const listTile = (label, list, colorVar) => `
      <div class="strip-tile">
        <div class="strip-label">${label} &middot; 24h</div>
        <div class="strip-list">
          ${list.map(x => `<div><span>${esc(x.symbol)}</span><span style="color:${colorVar}">${x.change > 0 ? '+' : ''}${x.change.toFixed(1)}%</span></div>`).join('')}
        </div>
      </div>`;

    return [
      pulseTile('Pulse Spot', data.pulseSpot),
      pulseTile('Pulse Perp', data.pulsePerp),
      fngTile, domTile, mcapTile, sectorTile,
      listTile('Top Gainers', data.gainers || [], 'var(--green-text)'),
      listTile('Top Losers', data.losers || [], 'var(--red-text)')
    ].join('');
  }

  return { renderCardGrid, cardHtml, detailModalHtml, topStripHtml, newsSectionHtml, esc };
})();
