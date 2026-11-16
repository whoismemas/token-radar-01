// Token Launch Radar's dashboard. It reads window.RADAR (written beside dashboard/ by main.ts)
// and renders the ranked board, its filters, a per-protocol detail view with the model's own
// arithmetic, and the model panel. No network: every byte it shows is in data.js, and the detail
// view recomputes its row from the peer ratios in that data, landing on board.json's number.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', chain: 'all', watch: false, tab: 'pre', sort: 'implied', dir: -1, selected: null };

  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function fmtMult(n) { return 'x' + n.toFixed(3); }

  // The model, recomputed in the page from data.js's own figures, exactly as lib/model.ts scores
  // it: peer ratios -> category quartiles -> shrinkage -> the three adjustments -> implied value.
  function medianOf(values) {
    if (values.length === 0) return 0;
    var s = values.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(s.length / 2);
    return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }
  function quantileOf(values, t) {
    if (values.length === 0) return 0;
    var s = values.slice().sort(function (a, b) { return a - b; });
    return s[Math.min(s.length - 1, Math.floor(t * s.length))];
  }
  function statsOf(list) {
    return { peers: list.length, q25: quantileOf(list, 0.25), median: medianOf(list), q75: quantileOf(list, 0.75) };
  }
  function shrunk(catValue, globalValue, peers, k) { return (peers * catValue + k * globalValue) / (peers + k); }
  function recompute(row) {
    var m = DATA.model;
    var global = statsOf(DATA.all_ratios);
    var list = row.category ? DATA.peer_ratios[row.category] : undefined;
    var cat = list && list.length > 0 ? statsOf(list) : { peers: 0, q25: global.q25, median: global.median, q75: global.q75 };
    var multiple = shrunk(cat.median, global.median, cat.peers, m.shrink_k);
    var lowMult = shrunk(cat.q25, global.q25, cat.peers, m.shrink_k);
    var highMult = shrunk(cat.q75, global.q75, cat.peers, m.shrink_k);
    var raw = row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d;
    var pct = Math.min(m.momentum_cap_pct, Math.max(m.momentum_floor_pct, raw));
    var momentum = Math.max(m.momentum_min_mult, 1 + (pct / 100) * m.momentum_weight);
    var ageFor = row.age_days === null || row.age_days === undefined ? DATA.unknown_age_days : row.age_days;
    var ageMult = m.age_base + (Math.min(Math.max(ageFor, 0), m.age_cap_days) / m.age_cap_days) * m.age_range;
    var chainMult = 1 + m.chain_step * Math.min(Math.max(row.chains.length - 1, 0), m.chain_cap);
    var factor = momentum * ageMult * chainMult;
    return {
      peers: cat.peers, catMedian: cat.median, multiple: multiple,
      momentum: momentum, ageMult: ageMult, chainMult: chainMult,
      implied: Math.max(1, Math.round(row.tvl_usd * multiple * factor)),
      low: Math.min(Math.max(1, Math.round(row.tvl_usd * multiple * factor)), Math.max(1, Math.round(row.tvl_usd * lowMult * factor))),
      high: Math.max(Math.max(1, Math.round(row.tvl_usd * multiple * factor)), Math.max(1, Math.round(row.tvl_usd * highMult * factor)))
    };
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('p')) state.selected = params.get('p');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('chain')) state.chain = params.get('chain');
    if (params.get('watch') === '1') state.watch = true;
    if (params.get('tab') === 'live') state.tab = 'live';
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.watch) params.set('watch', '1');
    if (state.tab === 'live') params.set('tab', 'live');
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function rows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.watch && !r.watchlist) return false;
      if (state.category !== 'all' && (r.category || '') !== state.category) return false;
      if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category || '', (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sortedRows(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else if (key === 'multiple') { av = a.peer_multiple; bv = b.peer_multiple; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' },
        el('span', { class: 'mark' }),
        el('div', null,
          el('div', { class: 'brand-name', text: 'Token Launch Radar' }),
          el('div', { class: 'brand-sub', text: 'pre-token protocols, ranked by implied value' })
        )
      ),
      el('div', { class: 'top-meta' },
        el('span', { text: 'Snapshot ' + DATA.as_of }),
        el('span', { text: 'Model ' + DATA.model_version }),
        el('span', { text: DATA.stats.protocols + ' protocols read' })
      )
    );
  }

  function lede() {
    var s = DATA.stats;
    return el('section', { class: 'lede' },
      el('div', null,
        el('h1', { text: 'What a launch would be worth, before there is a token' }),
        el('p', null,
          'Every protocol on this board records no token yet. Each is priced by the market\'s own evidence: the market-cap-to-TVL multiples of the ',
          el('b', { text: DATA.global_peers.peers + ' tokenized protocols' }),
          ' in its category, adjusted for its TVL growth, its years without a token and its chain spread. The house watchlist of ',
          el('b', { text: s.watchlist_size + ' protocols over $' + Math.round(DATA.floor_usd / 1e6) + 'M' }),
          ' is the floor of the board, not its ceiling: the radar also ranks ' + (s.board_size - s.watchlist_size) + ' earlier protocols below it.'
        )
      ),
      el('div', { class: 'facts' },
        el('div', { class: 'fact' }, el('span', { text: 'Watchlist covered' }), el('b', { text: s.watchlist_size + ' / ' + s.watchlist_size })),
        el('div', { class: 'fact' }, el('span', { text: 'Pre-token rows ranked' }), el('b', { text: String(s.board_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Global peer median' }), el('b', { text: fmtMult(DATA.global_peers.median) + ' of TVL' })),
        el('div', { class: 'fact' }, el('span', { text: 'Already trading, set aside' }), el('b', { text: String(DATA.live_total) })),
        el('div', { class: 'fact' }, el('span', { text: 'Wrapped/staked products aside' }), el('b', { text: String(s.set_aside) }))
      )
    );
  }

  function controls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || ''; }))).sort();
    var chains = Array.from(new Set(DATA.rows.reduce(function (acc, r) { return acc.concat(r.chains || []); }, []))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    var catSelect = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) { return el('option', { value: c, text: c === '' ? 'Uncategorized' : c, selected: c === state.category ? 'selected' : null }); })
    );
    catSelect.addEventListener('change', function () { state.category = catSelect.value; writeHash(); render(); });
    var chainSelect = el('select', { id: 'chain', 'aria-label': 'Filter by chain' },
      el('option', { value: 'all', text: 'All chains' }),
      chains.map(function (c) { return el('option', { value: c, text: c, selected: c === state.chain ? 'selected' : null }); })
    );
    chainSelect.addEventListener('change', function () { state.chain = chainSelect.value; writeHash(); render(); });
    var watchBox = el('input', { type: 'checkbox', id: 'watch', 'aria-label': 'Watchlist only' });
    watchBox.checked = state.watch;
    watchBox.addEventListener('change', function () { state.watch = watchBox.checked; writeHash(); render(); });
    var pre = el('button', { type: 'button', 'aria-pressed': state.tab === 'pre' ? 'true' : 'false', text: 'Pre-token', onclick: function () { state.tab = 'pre'; writeHash(); render(); } });
    var live = el('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Already trading', onclick: function () { state.tab = 'live'; writeHash(); render(); } });
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), catSelect),
      el('div', { class: 'field' }, el('label', { for: 'chain', text: 'Chain' }), chainSelect),
      el('label', { class: 'check' }, watchBox, 'Watchlist only'),
      el('div', { class: 'field' }, el('span', { class: 'lab', text: 'Token status' }), el('div', { class: 'tabs' }, pre, live)),
      el('span', { class: 'count', text: state.tab === 'pre' ? rows().length + ' rows shown' : DATA.live.length + ' of ' + DATA.live_total + ' trading' })
    );
  }

  function sortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } render(); } },
        label,
        state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' v' : ' ^' }) : null
      )
    );
  }

  function boardTable() {
    var list = sortedRows(rows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another category or chain to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; state.watch = false; writeHash(); render(); } })
      ));
    }
    var max = Math.max.apply(null, list.map(function (r) { return r.implied_value_usd; }).concat([1]));
    var tbody = el('tbody');
    list.forEach(function (r) {
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'rank', text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' },
          el('b', { text: r.name }),
          el('span', { class: 'sub', text: (r.category || 'Uncategorized') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 3).join(', ') : 'an unnamed chain') })
        )),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtMult(r.peer_multiple) }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) })
        )),
        el('td', null, el('span', { class: 'conf ' + r.confidence, text: r.confidence })),
        el('td', null, r.watchlist ? el('span', { class: 'chip', text: 'watchlist' }) : el('span', { class: 'sub', text: 'early' }))
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Pre-token protocols ranked by implied value: what a token would be worth if it launched at the protocol\'s current record. Select a row for its model and farm plan.' }),
          el('thead', null, el('tr', null,
            sortHeader('implied', 'Rank'),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('multiple', 'Peer x'),
            sortHeader('implied', 'Implied value'),
            el('th', { scope: 'col', text: 'Confidence' }),
            el('th', { scope: 'col', text: 'List' })
          )),
          tbody
        )
      )
    );
  }

  function liveTable() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', null, el('span', { class: 'status', text: r.symbol || 'live' })),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Uncategorized') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 3).join(', ') : 'an unnamed chain') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', { class: 'num', text: r.mcap_usd !== null && r.tvl_usd > 0 ? fmtMult(r.mcap_usd / r.tvl_usd) : 'n/a' })
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Already trading: these protocols have a token, so their market cap is a fact, not a model. They are the peer evidence the board\'s multiples come from, and they are never ranked as launches.' }),
          el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Token' }), el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: '7d' }), el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'Actual x' }))),
          tbody
        )
      )
    );
  }

  function modelPanel() {
    var m = DATA.model;
    var g = DATA.global_peers;
    var topCats = DATA.categories.slice(0, 10);
    var tbody = el('tbody');
    topCats.forEach(function (c) {
      tbody.appendChild(el('tr', null,
        el('td', { text: c.category }),
        el('td', { class: 'num', text: String(c.peers) }),
        el('td', { class: 'num', text: fmtMult(c.q25) }),
        el('td', { class: 'num', text: fmtMult(c.median) }),
        el('td', { class: 'num', text: fmtMult(c.q75) })
      ));
    });
    return el('section', { class: 'panel model' },
      el('h2', { text: 'How implied value is computed' }),
      el('p', null,
        'One function scores every row, from the snapshot\'s own figures; no protocol name is special-cased and no row is hand-picked. ',
        'A protocol\'s category contributes the market caps of its tokenized peers, as multiples of their TVL; a category\'s median is shrunk toward the global median (',
        el('b', { text: fmtMult(g.median) + ' across ' + g.peers + ' peers' }),
        ') by how many peers it has, so one loud peer cannot set a category\'s price. The quartiles, shrunk the same way, give each row its low-high band.'
      ),
      el('div', { class: 'formula', text: 'implied = round( TVL x M ) adjusted: momentum x' + ' (1 + clamp(7d, ' + m.momentum_floor_pct + ', ' + m.momentum_cap_pct + ') / 100 x ' + m.momentum_weight + ', min ' + m.momentum_min_mult + '), age x (' + m.age_base + ' + ' + m.age_range + ' x min(age_days, ' + m.age_cap_days + ') / ' + m.age_cap_days + '), chains x (1 + ' + m.chain_step + ' x min(chains - 1, ' + m.chain_cap + ')); M = (n x category median + ' + m.shrink_k + ' x global median) / (n + ' + m.shrink_k + ')' }),
      el('ul', null,
        el('li', null, el('b', { text: 'Separation. ' }), 'The board ranks only protocols that record no token and are not a wrapped, staked or bridged product of one that trades; trading protocols sit in the Already trading view at the market\'s own values.'),
        el('li', null, el('b', { text: 'Age. ' }), 'A protocol that has run for years with no token has the strongest launch record there is; the age term pays for it. A listing date the snapshot does not carry scores as the board\'s median age, ' + DATA.unknown_age_days + ' days.'),
        el('li', null, el('b', { text: 'Confidence. ' }), 'A row is high when its category has at least 8 peers and a narrow band, low when the peer basis is thin or the band is wide: the spread is printed, never hidden.')
      ),
      el('div', { class: 'table-wrap' },
        el('table', { class: 'peers' },
          el('caption', { class: 'sub', text: 'Peer evidence by category: market cap as a multiple of TVL, tokenized protocols only.' }),
          el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Category' }), el('th', { scope: 'col', text: 'Peers' }), el('th', { scope: 'col', text: 'Q1 x' }), el('th', { scope: 'col', text: 'Median x' }), el('th', { scope: 'col', text: 'Q3 x' }))),
          tbody
        )
      )
    );
  }

  function footer() {
    return el('footer', { class: 'foot' },
      el('p', { text: 'Data: ' + DATA.source + ' Snapshot date ' + DATA.as_of + '. Implied value is this board\'s own model claim about a launch at the protocol\'s current record; it is not a price, not a prediction that a token will be issued, and not advice.' }),
      el('p', { text: 'Farm plans are generated from each protocol\'s category, chains, TVL, age and momentum by the same code that writes board.json; costs are planning estimates in USD, and gas moves with the chain.' })
    );
  }

  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); render(); });

  function whySentence(row, rc) {
    var parts = [];
    parts.push(row.name + ' ranks #' + row.rank + ' because ' + fmtUsd(row.tvl_usd) + ' of TVL is priced at ' + fmtMult(row.peer_multiple) + ', the ' + (row.peer_count > 0 ? row.category + ' peer median shrunk toward the global ' + fmtMult(DATA.global_peers.median) : 'global peer median') + '.');
    if (row.change_7d !== null && row.change_7d >= 10) parts.push('Its TVL grew ' + fmtPct(row.change_7d) + ' this week, which the momentum term pays for.');
    else if (row.change_7d !== null && row.change_7d <= -10) parts.push('Its TVL fell ' + fmtPct(row.change_7d) + ' this week, which the momentum term charges it for.');
    if (row.age_days !== null && row.age_days >= 1095) parts.push('It has run ' + fmtAge(row.age_days) + ' with no token, near the top of the age term.');
    if (row.chains.length >= 6) parts.push('It is live on ' + row.chains.length + ' chains, the widest distribution the chain term pays for.');
    if (row.confidence === 'low') parts.push('Read the band, not the point: the peer basis here is thin, so the honest claim is the range.');
    return parts.join(' ');
  }

  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.selected = slug;
    writeHash();
    var rc = recompute(row);
    dialog.textContent = '';
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + DATA.stats.board_size }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Uncategorized') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') + (row.watchlist ? ' - on the house watchlist' : ' - early, below the watchlist floor') })
      ),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Implied value' }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'TVL (snapshot)' }), el('b', { class: 'num', text: fmtUsd(row.tvl_usd) })),
        el('div', null, el('span', { text: 'Peer basis' }), el('b', { class: 'num', text: row.peer_count > 0 ? row.peer_count + ' ' + row.category + ' peers' : 'global, no category peers' })),
        el('div', null, el('span', { text: 'Category median' }), el('b', { class: 'num', text: row.peer_count > 0 ? fmtMult(rc.catMedian) : 'n/a' })),
        el('div', null, el('span', { text: 'Multiple M (shrunk)' }), el('b', { class: 'num', text: fmtMult(row.peer_multiple) })),
        el('div', null, el('span', { text: 'Momentum x (7d ' + fmtPct(row.change_7d) + ')' }), el('b', { class: 'num', text: 'x' + rc.momentum.toFixed(3) })),
        el('div', null, el('span', { text: 'Age x (' + fmtAge(row.age_days) + ' tokenless)' }), el('b', { class: 'num', text: 'x' + rc.ageMult.toFixed(3) })),
        el('div', null, el('span', { text: 'Chains x (' + row.chains.length + ')' }), el('b', { class: 'num', text: 'x' + rc.chainMult.toFixed(3) })),
        el('div', { class: 'total' }, el('span', { text: 'Implied value' }), el('b', { class: 'num', text: fmtUsd(row.implied_value_usd) })),
        el('div', null, el('span', { text: 'Peer band' }), el('b', { class: 'num', text: fmtUsd(row.band_low_usd) + ' - ' + fmtUsd(row.band_high_usd) }))
      ),
      el('p', { class: 'why', text: whySentence(row, rc) }),
      el('p', { class: 'sub', text: 'Model ' + DATA.model_version + '. This page recomputes the row from the figures above and its own peer data: ' + fmtUsd(rc.implied) + (rc.implied === row.implied_value_usd ? ', the same number board.json carries.' : ', which differs from board.json\'s ' + fmtUsd(row.implied_value_usd) + '.') + ' Confidence: ' + row.confidence + '. An estimate, not a price.' })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan' }),
      el('ol', { class: 'steps' }, row.farm_steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail }));
      }))
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Snapshot record' }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'Listed since' }), el('b', { class: 'num', text: row.listed_at || 'not recorded' })),
        el('div', null, el('span', { text: 'Token on record' }), el('b', { class: 'num', text: 'none recorded' })),
        el('div', null, el('span', { text: 'Slug' }), el('b', { class: 'num', text: row.slug }))
      )
    ));
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(lede());
    shell.appendChild(controls());
    shell.appendChild(state.tab === 'pre' ? boardTable() : liveTable());
    if (state.tab === 'pre') shell.appendChild(modelPanel());
    shell.appendChild(footer());
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    if (state.selected) openDetail(state.selected);
  }

  readHash();
  render();
})();

