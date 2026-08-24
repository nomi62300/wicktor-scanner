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

  // Matches app.js's formatPrice() rules, kept local since render.js has
  // no dependency on app.js — used for the sloped-channel level value,
  // the one place render.js formats a raw number rather than a
  // pre-formatted string already prepared by app.js.
  function formatPriceForDisplay(n) {
    if (n == null || isNaN(n)) return '--';
    if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
    if (n >= 1) return n.toFixed(2);
    return n.toFixed(4);
  }

  // Fixed-size SVG icons for the 5-tier per-TF confidence state — Unicode
  // arrow glyphs (▲/↗/▼/↘/—) render thin, low-contrast, or near-illegible
  // at small sizes across different fonts/devices/OSes; explicit stroke
  // width and sizing keeps every state visually distinct at a glance.
  const TF_ICONS = {
    strong_bull: '<svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor"><path d="M6 1.5l5 9h-10z"/></svg>',
    weak_bull:   '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 9.5L9.5 2.5M4.5 2.5H9.5V7.5"/></svg>',
    strong_bear: '<svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor"><path d="M6 10.5l-5-9h10z"/></svg>',
    weak_bear:   '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 2.5L9.5 9.5M4.5 9.5H9.5V4.5"/></svg>',
    neutral:     '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2 6H10"/></svg>'
  };
  const TF_ICON_META = {
    strong_bull: ['tf-up', 'Clean uptrend'],
    weak_bull:   ['tf-weak-up', 'Weakening (recent lips dip)'],
    strong_bear: ['tf-down', 'Clean downtrend'],
    weak_bear:   ['tf-weak-down', 'Recovering (recent lips dip)'],
    neutral:     ['tf-flat', 'Neutral / mixed']
  };
  function tfArrowHtml(confidence) {
    const key = TF_ICON_META[confidence] ? confidence : 'neutral';
    const [cls, title] = TF_ICON_META[key];
    return `<span class="${cls}" title="${title}">${TF_ICONS[key]}</span>`;
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

  function crossingLipsChipHtml(warn) {
    if (!warn) return '';
    return `<span class="info-chip" style="color:var(--gold-text)">&#9888; Lips cross</span>`;
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
   *   ...scoring result fields (score, regime, direction, tfConfidence, rsiByTf,
   *        divergenceOverall, continuation, exhaustion, reversal)
   * }
   */
  function cardHtml(coin, idx) {
    const band = Scoring.bandLabel(coin.score, coin.unlock, coin.ceiling);
    const tfRow = coin.tfConfidence.map((c, i) =>
      `<span class="tf-item">${TF_LABELS[i]} ${tfArrowHtml(c)}</span>`).join('');
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
        ${crossingLipsChipHtml(coin.crossingLipsWarning)}
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

  // Continuation-only breakdown (Audit F3 follow-up): each item is a 0-100
  // sub-score now (see buildContinuation()'s own doc comment in scoring.js),
  // so a raw "+NN%" reads slower than a tier icon at a glance. Bucketed at
  // the same >=66/33-66/<33 cutoffs already used pre-redesign as breakout-
  // proximity's own "worth mentioning" threshold, so the tiering isn't a
  // new number pulled from nowhere. OI is shown as a 1-10 magnitude chip
  // instead of an icon, per the owner's request — a check/cross doesn't
  // suit "how much did open interest move," a number does. Items scoring
  // 0 stay visible but dimmed, not hidden — hiding them was the original
  // bug report: the visible list looked like it should sum to more than
  // the header score.
  function continuationTier(pct) {
    if (pct >= 66) return { icon: '&#10003;', color: 'var(--green-text)', bg: 'var(--green)' };
    if (pct >= 33) return { icon: '!', color: 'var(--gold-text)', bg: 'var(--gold)' };
    return { icon: '&#10005;', color: 'var(--text3)', bg: 'var(--surf2)' };
  }

  // Plain-English explanation per signal, matched by a stable substring
  // since labels carry dynamic content (weakening TFs, ADX value, OI %).
  // Checked in order — first match wins — so more specific patterns are
  // listed before their broader relatives (e.g. the two MACD-cross
  // variants before the plain "MACD trend-following cross").
  const CONTINUATION_EXPLANATIONS = [
    [/alligator aligned|not aligned/i, 'How many of the three timeframes (1H/15M/5M) currently agree with the trade’s bias, and whether any are showing early weakness.'],
    [/^AO /i, 'Awesome Oscillator momentum on 1H — confirms whether momentum is building in the trade’s direction.'],
    [/last (up|down) fractal/i, 'Whether price is currently past the most recent confirmed swing point on 1H.'],
    [/MFI Green/i, 'Money Flow Index volume+range read — green means healthy participation behind the move.'],
    [/key level/i, 'How close price is to — or already past — the nearest fractal-based level on 15M, in ATR terms.'],
    [/Perp OI/i, 'How much perpetual open interest moved in the last 15 minutes. A big swing means fresh capital is actively entering, not just existing positions drifting.'],
    [/EMA 9\/21/i, 'Whether the 9 and 21 EMA on 1H are stacked in the trade’s direction — a basic trend filter.'],
    [/MACD (bullish|bearish) cross on EMA21 pullback/i, 'A MACD cross on 15M that happened while price was pulled back near its 21 EMA — a timed entry, not just any cross.'],
    [/BB squeeze breakout/i, 'Bollinger Band width expanding while price closes outside the band on 15M — a volatility breakout moment.'],
    [/ADX trend strength/i, 'Average Directional Index on 15M — measures how strong the underlying trend is, regardless of direction.'],
    [/Breakout retest held/i, 'Price on 1H sitting back near a level it already broke past, holding above/below it — a retest-and-hold pattern.'],
    [/Squeeze momentum expansion/i, 'MACD histogram on 15M rising in the trade’s direction while volatility expands — oscillator-based momentum confirmation.'],
    [/Ichimoku cloud/i, 'Whether price on 1H sits above or below the Ichimoku cloud — a broader trend-position filter.'],
    [/Stochastic (bullish|bearish) entry/i, 'A Stochastic %K/%D cross on 15M coming out of oversold/overbought — a timing signal for entries.'],
    [/MACD trend-following cross/i, 'A plain directional MACD cross on 1H, independent of price location — confirms momentum turned in the trade’s direction.'],
    [/Pullback to EMA21/i, 'Price on 15M pulled back tightly to its 21 EMA with RSI in a healthy 40-60 range — not overextended, not reversing.']
  ];
  function continuationExplanation(label) {
    const hit = CONTINUATION_EXPLANATIONS.find(([re]) => re.test(label));
    return hit ? hit[1] : 'One of the signals feeding the Continuation score.';
  }

  // Splits a trailing "(...)" qualifier off a label so it can be colored
  // by its own sentiment independent of the leading tier icon — e.g. a
  // clean "3TF aligned" is still a green check, but the "(1H/15M
  // weakening)" qualifier inside it is worth flagging amber on its own,
  // not just folded into the same green as the rest of the line.
  function splitLabelQualifier(label) {
    const m = label.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
    if (!m) return { main: label, qualifier: null, qualifierColor: null };
    const [, main, qualifier] = m;
    let qualifierColor = null;
    if (/weakening/i.test(qualifier)) qualifierColor = 'var(--gold-text)';
    else if (/clean/i.test(qualifier)) qualifierColor = 'var(--green-text)';
    return { main, qualifier, qualifierColor };
  }

  function infoIconHtml(label) {
    return `<span class="cont-info" title="${esc(continuationExplanation(label))}">i</span>`;
  }

  function continuationItemHtml([label, pct]) {
    const isOi = label.startsWith('Perp OI');
    const { main, qualifier, qualifierColor } = splitLabelQualifier(label);
    const qualifierHtml = qualifier
      ? ` <span style="color:${qualifierColor || 'var(--text3)'}">(${esc(qualifier)})</span>` : '';
    const rowStyle = pct > 0 ? '' : ' style="opacity:0.5"';
    if (isOi) {
      const tier = continuationTier(pct);
      const tenScale = Math.round(pct / 10);
      return `<div class="breakdown-item"${rowStyle}>
        <span>${esc(main)}${qualifierHtml}${infoIconHtml(label)}</span>
        <span class="cont-chip" style="color:${tier.color};border-color:${tier.color}">${tenScale}/10</span>
      </div>`;
    }
    const tier = continuationTier(pct);
    return `<div class="breakdown-item"${rowStyle}>
      <span><span class="cont-icon" style="color:${tier.color};background:${tier.bg}22">${tier.icon}</span>${esc(main)}${qualifierHtml}${infoIconHtml(label)}</span>
    </div>`;
  }

  function continuationBlockHtml(score, items) {
    const rows = items.map(continuationItemHtml).join('');
    return `
    <div class="block">
      <div class="block-title-row"><span style="color:var(--green)">Continuation</span><span>${score}/100</span></div>
      <div class="bar-track"><div class="bar-fill" style="width:${score}%;background:var(--green)"></div></div>
      ${rows}
    </div>`;
  }

  function sentTagHtml(sent) {
    const map = { bull: ['Bullish', 'sent-bull'], bear: ['Bearish', 'sent-bear'], neutral: ['Neutral', 'sent-neutral'] };
    const [text, cls] = map[sent] || map.neutral;
    return `<span class="sent-tag ${cls}">${text}</span>`;
  }

  // CryptoFlash sources tweets as items whose url is an x.com/twitter.com
  // status link and whose `source` is the poster's @handle — flag those
  // with a small X badge so they read visibly differently from articles.
  function isTweetUrl(url) {
    return /(?:twitter\.com|x\.com)\/[^/]+\/status\//i.test(url || '');
  }
  const TWEET_ICON = '<svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><path d="M18.9 2H22l-7.6 8.7L23.3 22h-7.1l-5.5-6.9L4 22H1l8.2-9.3L1 2h7.3l5 6.3L18.9 2zm-1.2 18h1.9L7.4 4H5.3l12.4 16z"/></svg>';
  function tweetBadgeHtml(url) {
    if (!isTweetUrl(url)) return '';
    return `<span class="tweet-badge" title="Posted on X">${TWEET_ICON}</span>`;
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
    if (newsResult.error) {
      return `<div class="news-section-label">Latest news &amp; reports</div><div class="empty-note">News is temporarily unavailable.</div>`;
    }
    if (!newsResult.items || !newsResult.items.length) {
      return `<div class="news-section-label">Latest news &amp; reports</div><div class="empty-note">No recent news for this coin.</div>`;
    }
    const newsItemHtml = (n) => `
      <div class="news-item">
        <a href="${esc(n.url)}" target="_blank" rel="noopener noreferrer" class="news-headline">${esc(n.headline)}</a>
        <div class="news-meta">
          <span class="news-src">${tweetBadgeHtml(n.url)}${esc(n.source)} &middot; ${timeAgo(n.time)} ago</span>
          ${sentTagHtml(n.sentiment)}
        </div>
      </div>`;

    // Always show the first 2 items at their natural height; anything past
    // that sits in a fixed-height scrollable section revealed by "See
    // more", so the modal's own footprint never grows with the news count.
    const visible = newsResult.items.slice(0, 2).map(newsItemHtml).join('');
    const rest = newsResult.items.slice(2);
    const moreBlock = rest.length
      ? `<div class="news-more" hidden>${rest.map(newsItemHtml).join('')}</div>
         <button type="button" class="news-more-toggle" data-action="toggle-news-more" data-more-label="See ${rest.length} more" data-less-label="See less">See ${rest.length} more</button>`
      : '';
    return `<div class="news-section-label">Latest news &amp; reports</div><div class="news-visible">${visible}</div>${moreBlock}`;
  }

  function detailModalHtml(coin, newsResult) {
    const band = Scoring.bandLabel(coin.score, coin.unlock, coin.ceiling);
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
      ${continuationBlockHtml(coin.continuation.score, coin.continuation.items)}
      ${breakdownBlockHtml('Exhaustion', 'var(--gold)', coin.exhaustion.score, coin.exhaustion.items)}
      ${breakdownBlockHtml('Reversal', 'var(--text3)', coin.reversal.score, coin.reversal.items)}
      <div class="news-section-label" style="margin-top:2px;">Key levels</div>
      <div class="levels-grid">
        <div class="level-box">
          <div class="level-box-label">Resistance</div>
          <div class="level-box-value" style="color:var(--red-text)">$${esc(coin.resistance)}</div>
          ${coin.resistanceSloped ? `<div class="level-box-sloped">Channel: $${esc(formatPriceForDisplay(coin.resistanceSloped.value))} <span style="color:var(--text3)">(r&sup2; ${coin.resistanceSloped.r2.toFixed(2)})</span></div>` : ''}
        </div>
        <div class="level-box">
          <div class="level-box-label">Support</div>
          <div class="level-box-value" style="color:var(--green-text)">$${esc(coin.support)}</div>
          ${coin.supportSloped ? `<div class="level-box-sloped">Channel: $${esc(formatPriceForDisplay(coin.supportSloped.value))} <span style="color:var(--text3)">(r&sup2; ${coin.supportSloped.r2.toFixed(2)})</span></div>` : ''}
        </div>
      </div>
      <div class="news-section-label" style="margin-top:2px;">All timeframes</div>
      <div id="extended-tf-panel" class="extended-tf-panel">
        <div class="loading-state" style="padding:8px 0;">Loading...</div>
      </div>
      ${newsSectionHtml(newsResult)}
    `;
  }

  // Extended 7-timeframe panel (detail modal, lazy-loaded): last close +
  // last-candle % change per TF, informational only — no scoring here.
  const EXTENDED_TF_LABELS = { '1m': '1M', '5m': '5M', '15m': '15M', '30m': '30M', '1h': '1H', '4h': '4H', '1d': '1D' };

  function extendedTfPanelHtml(tfData) {
    const rows = Object.keys(EXTENDED_TF_LABELS).map(tf => {
      const candles = tfData[tf];
      if (!candles || candles.length < 2) {
        return `<div class="extended-tf-row">
            <span class="extended-tf-label">${EXTENDED_TF_LABELS[tf]}</span>
            <span style="color:var(--text3)">--</span>
          </div>`;
      }
      const last = candles[candles.length - 1];
      const prev = candles[candles.length - 2];
      const pctChange = prev.c ? ((last.c - prev.c) / prev.c) * 100 : 0;
      const color = pctChange >= 0 ? 'var(--green-text)' : 'var(--red-text)';
      const sign = pctChange >= 0 ? '+' : '';
      return `<div class="extended-tf-row">
          <span class="extended-tf-label">${EXTENDED_TF_LABELS[tf]}</span>
          <span class="mono">$${esc(String(last.c))}</span>
          <span style="color:${color}">${sign}${pctChange.toFixed(2)}%</span>
        </div>`;
    }).join('');
    return `<div class="extended-tf-grid">${rows}</div>`;
  }

  // ------------------------------------------------------------ Top strip

  // Shared market-overview tile builders — used by both the always-visible
  // top strip and the Dashboard tab, so the two stay visually consistent
  // and never drift into duplicated markup.
  function pulseTileHtml(label, val) {
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
  }

  function fngTileHtml(data) {
    const fngVal = data.fearGreed ? data.fearGreed.value : null;
    return `
      <div class="strip-tile">
        <div class="strip-label">Fear &amp; Greed</div>
        <div class="strip-value" style="color:var(--gold-text)">${fngVal != null ? fngVal + ' ' + data.fearGreed.label : '--'}</div>
        <div class="gauge-track fear-greed"><div class="gauge-dot" style="left:${fngVal != null ? fngVal : 50}%"></div></div>
        <div class="gauge-labels"><span>Fear</span><span>Greed</span></div>
      </div>`;
  }

  function domTileHtml(data) {
    return `
      <div class="strip-tile">
        <div class="strip-label">BTC Dominance</div>
        <div class="strip-value mono">${data.btcDominance != null ? data.btcDominance.toFixed(1) + '%' : '--'}</div>
        <div class="fill-bar"><div style="width:${data.btcDominance || 0}%"></div></div>
      </div>`;
  }

  function mcapTileHtml(data) {
    const mcapChangeColor = (data.mcapChange24h || 0) >= 0 ? 'var(--green-text)' : 'var(--red-text)';
    const mcapArrow = (data.mcapChange24h || 0) >= 0 ? '&#9650;' : '&#9660;';
    return `
      <div class="strip-tile">
        <div class="strip-label">Market Cap &middot; 24h</div>
        <div class="strip-value mono">${data.mcap || '--'} <span style="font-size:11px;color:${mcapChangeColor}">${mcapArrow} ${Math.abs(data.mcapChange24h || 0).toFixed(1)}%</span></div>
      </div>`;
  }

  // Top Sectors and Narratives used to be two separate tiles built from
  // the exact same state.narrativePerf array (just sliced to different
  // lengths) — genuinely redundant, especially obvious when only 1-2
  // sectors resolve and both tiles show the identical single entry.
  // Consolidated into one.
  function sectorTileHtml(data) {
    return (data.narrativeSectors && data.narrativeSectors.length)
      ? `<div class="strip-tile">
          <div class="strip-label">Top Sectors &middot; 7D</div>
          <div class="strip-list">
            ${data.narrativeSectors.map(s => {
              const color = s.weightedChange7d >= 0 ? 'var(--green-text)' : 'var(--red-text)';
              const sign  = s.weightedChange7d >= 0 ? '+' : '';
              return `<div><span>${esc(s.name)}</span><span style="color:${color}">${sign}${s.weightedChange7d.toFixed(1)}%</span></div>`;
            }).join('')}
          </div>
        </div>`
      : `<div class="strip-tile">
          <div class="strip-label">Top Sectors &middot; 7D</div>
          <div class="strip-value" style="color:var(--text3)">--</div>
        </div>`;
  }

  function moversListTileHtml(label, list, colorVar) {
    return `
      <div class="strip-tile">
        <div class="strip-label">${label} &middot; 24h</div>
        <div class="strip-list">
          ${(list || []).map(x => `<div><span>${esc(x.symbol)}</span><span style="color:${colorVar}">${x.change > 0 ? '+' : ''}${x.change.toFixed(1)}%</span></div>`).join('')}
        </div>
      </div>`;
  }

  function topStripHtml(data) {
    return [
      pulseTileHtml('Pulse Spot', data.pulseSpot),
      pulseTileHtml('Pulse Perp', data.pulsePerp),
      fngTileHtml(data), domTileHtml(data), mcapTileHtml(data), sectorTileHtml(data),
      moversListTileHtml('Top Gainers', data.gainers || [], 'var(--green-text)'),
      moversListTileHtml('Top Losers', data.losers || [], 'var(--red-text)')
    ].join('');
  }

  // Dashboard tab (B1): the always-visible top strip's tiles at full
  // depth — top 5 by market cap (new) and top 10 gainers/losers (vs the
  // strip's compact top 3) — plus the same dominance/mcap/F&G/sectors
  // tiles reused as-is. Altcoin Season Index is intentionally NOT built:
  // CoinGecko's free /coins/markets `price_change_percentage` param only
  // supports 1h/24h/7d/14d/30d/200d/1y, not a 90d window, so computing it
  // accurately would mean ~50-100 individual per-coin market_chart calls —
  // exactly the kind of load already producing live 429s/CORS failures on
  // the existing endpoints. Flagged back rather than shipping a silent
  // approximation on the wrong window.
  function top5MarketCapTileHtml(list) {
    if (!list || !list.length) {
      return `<div class="strip-tile">
          <div class="strip-label">Top 5 &middot; Market Cap</div>
          <div class="strip-value" style="color:var(--text3)">--</div>
        </div>`;
    }
    return `<div class="strip-tile">
        <div class="strip-label">Top 5 &middot; Market Cap</div>
        <div class="strip-list">
          ${list.map(c => {
            const chg = c.change24h;
            const color = chg >= 0 ? 'var(--green-text)' : 'var(--red-text)';
            const sign = chg >= 0 ? '+' : '';
            const price = c.price >= 1 ? c.price.toFixed(2) : c.price;
            return `<div><span>${esc(c.symbol)} <span class="mono" style="color:var(--text3)">$${esc(String(price))}</span></span><span style="color:${color}">${chg != null ? sign + chg.toFixed(1) + '%' : '--'}</span></div>`;
          }).join('')}
        </div>
      </div>`;
  }

  function dashboardHtml(data) {
    return [
      domTileHtml(data), mcapTileHtml(data), fngTileHtml(data), sectorTileHtml(data),
      top5MarketCapTileHtml(data.top5MarketCap),
      moversListTileHtml('Top 10 Gainers', data.gainers10 || [], 'var(--green-text)'),
      moversListTileHtml('Top 10 Losers', data.losers10 || [], 'var(--red-text)')
    ].join('');
  }

  // Market Flows (B2): sector/category cards with click-through to
  // constituent coins. `expandedIds` is a Set of categoryId strings
  // currently expanded — kept in app.js state, passed in here so this
  // stays a pure render function like everything else in this file.
  function pctCellHtml(val) {
    if (val == null) return '<span style="color:var(--text3)">--</span>';
    const color = val >= 0 ? 'var(--green-text)' : 'var(--red-text)';
    const sign = val >= 0 ? '+' : '';
    return `<span style="color:${color}">${sign}${val.toFixed(1)}%</span>`;
  }

  function marketFlowsHtml(sectorPerf, expandedIds) {
    if (!sectorPerf || !sectorPerf.length) {
      return '<div class="loading-state">Loading sector data...</div>';
    }
    const sorted = [...sectorPerf].sort((a, b) => (b.mcap || 0) - (a.mcap || 0));
    const rows = sorted.map(sector => {
      const isOpen = expandedIds && expandedIds.has(sector.categoryId);
      const coinRows = isOpen
        ? sector.coins.slice(0, 15).map(c => `
            <tr class="flows-coin-row">
              <td>${esc((c.symbol || '').toUpperCase())} <span style="color:var(--text3)">${esc(c.name || '')}</span></td>
              <td class="mono">${c.market_cap != null ? '$' + esc(String(Math.round(c.market_cap).toLocaleString())) : '--'}</td>
              <td>${pctCellHtml(c.price_change_percentage_24h_in_currency)}</td>
              <td>${pctCellHtml(c.price_change_percentage_7d_in_currency)}</td>
              <td>${pctCellHtml(c.price_change_percentage_30d_in_currency)}</td>
              <td>${pctCellHtml(c.price_change_percentage_1y_in_currency)}</td>
            </tr>`).join('')
        : '';
      return `
        <tr class="flows-row" data-category-id="${esc(sector.categoryId)}" role="button" tabindex="0" aria-expanded="${isOpen}">
          <td>${isOpen ? '&#9660;' : '&#9654;'} ${esc(sector.name)}</td>
          <td class="mono">${sector.mcap != null ? '$' + esc(String(Math.round(sector.mcap).toLocaleString())) : '--'}</td>
          <td>${pctCellHtml(sector.weightedChange24h)}</td>
          <td>${pctCellHtml(sector.weightedChange7d)}</td>
          <td>${pctCellHtml(sector.weightedChange30d)}</td>
          <td>${pctCellHtml(sector.weightedChange1y)}</td>
        </tr>
        ${isOpen ? `<tr class="flows-coins-wrap"><td colspan="6">
          <table class="flows-coins-table"><thead><tr>
            <th>Coin</th><th>Market Cap</th><th>24h</th><th>7d</th><th>30d</th><th>1y</th>
          </tr></thead><tbody>${coinRows}</tbody></table>
        </td></tr>` : ''}`;
    }).join('');

    return `
      <div class="flows-note">Market cap shown is the top-50-by-cap coins fetched per category, not the full category total. Click a row to see its coins. 30D/1Y come from a separate extended-window source and load a moment after the rest — a &quot;--&quot; there means that window isn&#39;t available for the sector, not that it&#39;s flat.</div>
      <table class="flows-table">
        <thead><tr><th>Category</th><th>Market Cap</th><th>24h</th><th>7d</th><th>30d</th><th>1y</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  // Heatmap (B5): flattens every coin across the same category set Flows
  // uses (dedup by symbol, keep the highest-mktcap instance — a coin can
  // appear in multiple categories), tile size ~ sqrt(market cap) (keeps
  // one giant BTC tile from swallowing the whole grid), color = 24h%. No
  // 1h toggle — that window isn't fetched anywhere else and this tab is
  // explicitly the lowest-priority one on the roadmap, not worth a new
  // CoinGecko window just for a toggle.
  function heatmapHtml(sectorPerf) {
    if (!sectorPerf || !sectorPerf.length) {
      return '<div class="loading-state">Loading sector data...</div>';
    }
    const bySymbol = new Map();
    sectorPerf.forEach(sector => {
      (sector.coins || []).forEach(c => {
        const existing = bySymbol.get(c.id);
        if (!existing || (c.market_cap || 0) > (existing.market_cap || 0)) {
          bySymbol.set(c.id, c);
        }
      });
    });
    const coins = [...bySymbol.values()]
      .filter(c => c.market_cap != null)
      .sort((a, b) => b.market_cap - a.market_cap)
      .slice(0, 120);
    if (!coins.length) return '<div class="loading-state">No coin data yet.</div>';

    const maxSqrt = Math.sqrt(coins[0].market_cap);
    const MIN_PX = 56, MAX_PX = 168;

    const tiles = coins.map(c => {
      const size = Math.round(MIN_PX + (Math.sqrt(c.market_cap) / maxSqrt) * (MAX_PX - MIN_PX));
      const chg = c.price_change_percentage_24h_in_currency;
      // Color intensity scales with |chg|, capped at 10% for full saturation
      // — keeps a +40% meme-coin spike from just looking identical to +11%.
      const intensity = chg == null ? 0 : Math.min(1, Math.abs(chg) / 10);
      const bg = chg == null
        ? 'var(--surf2)'
        : chg >= 0
          ? `color-mix(in srgb, var(--green) ${20 + intensity * 55}%, var(--surf2))`
          : `color-mix(in srgb, var(--red) ${20 + intensity * 55}%, var(--surf2))`;
      const fontSize = Math.max(10, Math.round(size / 6));
      return `
        <div class="heatmap-tile" style="width:${size}px;height:${size}px;background:${bg};font-size:${fontSize}px;" title="${esc((c.name || '').toString())}">
          <div class="heatmap-symbol">${esc((c.symbol || '').toUpperCase())}</div>
          <div class="heatmap-chg">${chg != null ? (chg >= 0 ? '+' : '') + chg.toFixed(1) + '%' : '--'}</div>
        </div>`;
    }).join('');

    return `<div class="heatmap-grid">${tiles}</div>`;
  }

  // Phase 8 News tab: a plain dense list of the existing Snitch feed
  // (already integrated for per-card badges/detail-modal sections) as
  // its own top-level tab — confirmed scope with the owner: an
  // additional surface, not a replacement for the existing per-card
  // treatment, which stays exactly as-is. Reuses the same
  // tweetBadgeHtml()/sentTagHtml()/timeAgo() helpers newsSectionHtml()
  // already uses, so the two surfaces render news identically.
  function newsFeedHtml(articles) {
    if (!articles) return '<div class="loading-state">Loading news...</div>';
    if (!articles.length) return '<div class="loading-state">No recent news.</div>';
    const rows = articles.map(a => `
      <div class="news-feed-item">
        <a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer" class="news-headline">${esc(a.headline)}</a>
        <div class="news-meta">
          <span class="news-src">${tweetBadgeHtml(a.url)}${esc(a.source)} &middot; ${timeAgo(a.time)} ago${a.tickers && a.tickers.length ? ' &middot; ' + esc(a.tickers.join(', ')) : ''}</span>
          ${sentTagHtml(a.sentiment)}
        </div>
      </div>`).join('');
    return `<div class="news-feed-list">${rows}</div>`;
  }

  // Phase 3: account-scoped Watchlist tab. `user` is a Supabase user
  // object or null (not signed in) — `rows` is [] either way a signed-in
  // user just hasn't starred anything yet, or price lookups failed.
  function watchlistHtml(user, rows) {
    if (!user) {
      return `<div class="loading-state">Sign in (account icon, top right) to build a watchlist that syncs across devices.</div>`;
    }
    if (!rows.length) {
      return `<div class="loading-state">No coins starred yet. Star a coin from the Scanner to add it here.</div>`;
    }
    const body = rows.map(r => `
      <tr>
        <td>${esc(r.symbol)} <span style="color:var(--text3);font-size:11px;">${esc(r.market)}</span></td>
        <td class="mono">${r.price != null ? '$' + esc(String(r.price)) : '--'}</td>
        <td>${pctCellHtml(r.change24h)}</td>
      </tr>`).join('');
    return `
      <table class="flows-table">
        <thead><tr><th>Coin</th><th>Price</th><th>24h</th></tr></thead>
        <tbody>${body}</tbody>
      </table>`;
  }

  return { renderCardGrid, cardHtml, detailModalHtml, topStripHtml, dashboardHtml, marketFlowsHtml, heatmapHtml, extendedTfPanelHtml, newsFeedHtml, newsSectionHtml, watchlistHtml, esc };
})();
