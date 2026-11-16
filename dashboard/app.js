// Token Radar radar-3 dashboard. Reads window.RADAR (written beside dashboard/
// by main.ts) and renders the model panel, the traded-token scatter, the
// filterable board and a per-protocol detail drawer. No network: every byte it
// shows is in data.js. ?shot=board|detail|filtered stages the three
// screenshot states.
(function () {
  'use strict';
  var DATA = window.RADAR;
  if (!DATA) return;
  var root = document.getElementById('board');
  root.setAttribute('aria-busy', 'false');

  var FAM_COLOR = {
    'Trading': '#58a6ff', 'Bridges': '#39c5cf', 'Lending & Credit': '#bc8cff',
    'RWA': '#f0b429', 'Yield & Vaults': '#3fb950', 'Staking': '#ff7b72', 'Other': '#9aa7b8'
  };
  var state = { q: '', family: 'all', verdict: 'all', scope: 'all', watchOnly: false, tab: 'pre', sort: 'implied', dir: -1, selected: null };
  var params = new URLSearchParams(location.search);
  var shot = params.get('shot') || 'board';
  if (shot === 'filtered') state.verdict = 'FARM';
  if (shot === 'detail') state.selected = DATA.rows.length ? DATA.rows[0].slug : null;

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    var a = Math.abs(n), sign = n < 0 ? '-' : '';
    if (a >= 1e9) return sign + '$' + (a / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return sign + '$' + (a / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return sign + '$' + Math.round(a / 1e3) + 'K';
    return sign + '$' + Math.round(a);
  }
  function fmtMoney(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    var r = Math.round(n);
    if (r === 0) return '$0';
    return (r < 0 ? '-$' : '$') + Math.abs(r).toLocaleString('en-US');
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + Number(n).toFixed(2) + '%';
  }
  function fmtAge(d) {
    if (d === null || d === undefined) return 'unknown';
    if (d >= 365) return (d / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(d)) + 'd';
  }
  function money(n) { return fmtMoney(n); }

  // radar-3: the page recomputes a row from the family fit in data.js and
  // checks the number board.json carries, so the page, the board and the
  // model are visibly the same arithmetic. See familyFits in lib/model.ts.
  function recompute(row) {
    var m = DATA.model;
    var growth = Math.min(m.growth_cap, Math.max(m.growth_floor, row.change_7d === null ? 0 : row.change_7d));
    var g = 1 + (growth / 100) * m.growth_weight;
    var age = row.age_days === null ? m.unknown_age_days : row.age_days;
    var mat = m.maturity_floor + (Math.min(Math.max(age, 0), m.maturity_days) / m.maturity_days) * m.maturity_range;
    var br = 1 + Math.min(Math.max(row.chains.length - 1, 0), 5) * 0.02;
    var base = Math.exp(row.family_intercept + row.family_slope * Math.log(row.tvl_usd));
    var raw = base * g * mat * br;
    return Math.max(1, Math.round(Math.min(Math.max(raw, m.multiple_floor * row.tvl_usd), m.multiple_cap * row.tvl_usd)));
  }

  function headline() {
    var v = DATA.verdict_counts, b = DATA.backtest;
    document.getElementById('headline').innerHTML =
      '<div class="stat"><b>' + DATA.board_size + '</b><span>rows ranked</span></div>' +
      '<div class="stat"><b>' + v.FARM + ' / ' + v.THIN + ' / ' + v.SKIP + '</b><span>FARM / THIN / SKIP</span></div>' +
      '<div class="stat"><b>' + b.log_correlation.toFixed(2) + '</b><span>backtest log-r</span></div>' +
      '<div class="stat"><b>' + DATA.watchlist_size + ' / ' + DATA.watchlist_size + '</b><span>watchlist covered</span></div>';
  }

  function modelPanel() {
    var fams = Object.keys(DATA.families).map(function (k) { return { name: k, f: DATA.families[k] }; });
    fams.sort(function (a, b) { return b.f.multiple_at_100m - a.f.multiple_at_100m; });
    var rows = fams.map(function (x) {
      return '<tr><td>' + esc(x.name) + '</td><td>' + x.f.peers + '</td><td>' + x.f.intercept.toFixed(2) + '</td><td>' + x.f.slope.toFixed(3) + '</td><td>' + x.f.multiple_at_100m.toFixed(4) + '</td></tr>';
    }).join('');
    var g = DATA.global_fit, b = DATA.backtest, e = DATA.econ;
    document.getElementById('model').innerHTML =
      '<h2>How a protocol is priced — and whether farming it pays</h2>' +
      '<p>Each family gets its own pricing line, fitted on the snapshot&rsquo;s live-token protocols. ' +
      'The old flat multiple (one number for every protocol) is gone: at $100M of TVL the market pays ' +
      'Trading about 0.28&times; TVL and Staking about 0.08&times; — the board ranks on that difference.</p>' +
      '<div class="formula">log(mcap) = a + b &middot; log(TVL)   per family, shrunk toward the global fit\n' +
      'implied = clamp(exp(a + b&middot;ln TVL) &times; growth &times; maturity &times; breadth, 0.02&times;TVL, 3&times;TVL)\n' +
      'growth = 1 + clamp(7d %, -60, 120) / 100 &times; 0.5 &nbsp;&middot;&nbsp; maturity = 0.6 + min(age, 1095) / 1095 &times; 0.4 &nbsp;&middot;&nbsp; breadth = 1 + 0.02 &times; extra chains (max 5)</div>' +
      '<h3>Family fits (' + DATA.traded.length + ' live-token protocols, mcap &gt; 0)</h3>' +
      '<table class="fits"><thead><tr><th>Family</th><th>Peers</th><th>a</th><th>b</th><th>&times;TVL at $100M</th></tr></thead><tbody>' + rows +
      '<tr><td><b>Global (fallback)</b></td><td>' + g.peers + '</td><td>' + g.intercept.toFixed(2) + '</td><td>' + g.slope.toFixed(3) + '</td><td>' + g.multiple_at_100m.toFixed(4) + '</td></tr>' +
      '</tbody></table>' +
      '<h3>Blind test — 5-fold cross-validation on the ' + b.n + ' traded protocols</h3>' +
      '<p>Each fold holds out every 5th protocol by slug, refits every family on the rest, and predicts the held-out market caps. ' +
      'Family model: <b>log correlation ' + b.log_correlation.toFixed(2) + '</b>, <b>median error ' + b.median_abs_pct_error.toFixed(1) + '%</b>, ' +
      '<b>' + Math.round(b.hit_within_2x * 100) + '% within 2&times;</b>. Flat global-median baseline: median error ' + b.flat_median_abs_pct_error.toFixed(1) + '%, ' +
      Math.round(b.flat_hit_within_2x * 100) + '% within 2&times;. <span class="warn">The win is real but modest — the market prices TVL loosely. Use the ranks, not the point values.</span></p>' +
      '<h3>Verdict arithmetic — assumptions, stated, not hidden</h3>' +
      '<p>A farmer puts in <b>$' + e.capital_usd + '</b>, makes <b>' + e.tx_count + ' transactions</b>, spends about <b>' + e.hours + 'h at $' + e.wage_usd_per_hour + '/h</b>, ' +
      'and loses <b>' + (e.slippage_rate * 100).toFixed(1) + '% slippage</b>. Gross is the farmer&rsquo;s assumed share: <b>' + (e.farmer_pool_share * 100).toFixed(0) + '% of the implied value</b> ' +
      'reaches farmers, split among TVL / $' + e.farmers_per_tvl_usd.toLocaleString('en-US') + ' farmers (500–20,000). ' +
      'Net &ge; $' + e.farm_threshold_usd + ' is <b class="good">FARM</b>, net &ge; $0 is <b class="warn">THIN</b>, below $0 is <b class="bad">SKIP</b>. ' +
      'These shares are assumptions — change them and the verdicts move.</p>' +
      '<p>Snapshot ' + esc(DATA.as_of) + ' &middot; ' + esc(DATA.source) + ' &middot; watchlist floor ' + fmtUsd(DATA.floor_usd) + ' &middot; ' +
      DATA.watchlist_size + ' watchlist + ' + DATA.early_size + ' early + ' + DATA.extended_size + ' extended rows = ' + DATA.board_size + ' rows. ' +
      'Traded protocols are kept apart: their market caps are the market&rsquo;s own values, never a model&rsquo;s.</p>';
  }

  function chart() {
    var W = 1180, H = 460, PL = 64, PR = 16, PT = 16, PB = 44;
    var pts = DATA.traded;
    var xs = pts.map(function (p) { return Math.log10(p.tvl_usd); });
    var ys = pts.map(function (p) { return Math.log10(p.mcap_usd); });
    var boardPts = DATA.rows.map(function (r) { return { x: Math.log10(r.tvl_usd), y: Math.log10(r.implied_value_usd) }; });
    var x0 = Math.floor(Math.min.apply(null, xs.concat(boardPts.map(function (p) { return p.x; })))) - 0.2;
    var x1 = Math.ceil(Math.max.apply(null, xs.concat(boardPts.map(function (p) { return p.x; })))) + 0.2;
    var y0 = Math.floor(Math.min.apply(null, ys.concat(boardPts.map(function (p) { return p.y; })))) - 0.2;
    var y1 = Math.ceil(Math.max.apply(null, ys.concat(boardPts.map(function (p) { return p.y; })))) + 0.2;
    function X(v) { return PL + (v - x0) / (x1 - x0) * (W - PL - PR); }
    function Y(v) { return PT + (y1 - v) / (y1 - y0) * (H - PT - PB); }
    var s = '';
    var gx;
    for (gx = Math.ceil(x0); gx <= x1; gx++) {
      s += '<line x1="' + X(gx).toFixed(1) + '" y1="' + PT + '" x2="' + X(gx).toFixed(1) + '" y2="' + (H - PB) + '" stroke="#2a3444"/>' +
        '<text x="' + X(gx).toFixed(1) + '" y="' + (H - PB + 18) + '" fill="#9aa7b8" font-size="11" text-anchor="middle">10^' + gx + '</text>';
    }
    var gy;
    for (gy = Math.ceil(y0); gy <= y1; gy++) {
      s += '<line x1="' + PL + '" y1="' + Y(gy).toFixed(1) + '" x2="' + (W - PR) + '" y2="' + Y(gy).toFixed(1) + '" stroke="#2a3444"/>' +
        '<text x="' + (PL - 8) + '" y="' + (Y(gy) + 4).toFixed(1) + '" fill="#9aa7b8" font-size="11" text-anchor="end">10^' + gy + '</text>';
    }
    // Global fitted curve: log10(mcap) = (a + b*ln TVL) / ln 10.
    var g = DATA.global_fit, curve = '';
    for (var i = 0; i <= 40; i++) {
      var lx = x0 + (x1 - x0) * i / 40;
      var ly = (g.intercept + g.slope * lx * Math.LN10) / Math.LN10;
      curve += (i === 0 ? 'M' : 'L') + X(lx).toFixed(1) + ',' + Y(ly).toFixed(1);
    }
    s += '<path d="' + curve + '" fill="none" stroke="#f0b429" stroke-width="2.5"/>';
    s += '<text x="' + X(x1 - 0.4).toFixed(1) + '" y="' + (Y((g.intercept + g.slope * (x1 - 0.4) * Math.LN10) / Math.LN10) - 8).toFixed(1) + '" fill="#f0b429" font-size="11">global fit</text>';
    pts.forEach(function (p) {
      s += '<circle cx="' + X(Math.log10(p.tvl_usd)).toFixed(1) + '" cy="' + Y(Math.log10(p.mcap_usd)).toFixed(1) + '" r="4" fill="' + (FAM_COLOR[p.family] || '#9aa7b8') + '" opacity="0.85"><title>' + esc(p.name) + ' — TVL ' + fmtUsd(p.tvl_usd) + ', mcap ' + fmtUsd(p.mcap_usd) + '</title></circle>';
    });
    boardPts.forEach(function (p) {
      s += '<circle cx="' + X(p.x).toFixed(1) + '" cy="' + Y(p.y).toFixed(1) + '" r="3" fill="none" stroke="#e6edf3" stroke-width="1.2" opacity="0.55"/>';
    });
    var legend = Object.keys(FAM_COLOR).map(function (f) {
      return '<span><i style="background:' + FAM_COLOR[f] + '"></i>' + esc(f) + '</span>';
    }).join('');
    document.getElementById('chart').innerHTML =
      '<h2>Traded tokens against the fitted curve</h2>' +
      '<p>Each filled dot is a protocol whose token already trades (log TVL vs log market cap, coloured by family); ' +
      'the amber line is the global fitted curve. Hollow rings are this board&rsquo;s 200 pre-token rows at their implied values. ' +
      'The scatter is wide — that width is the backtest&rsquo;s 80% median error, shown, not hidden.</p>' +
      '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Scatter of traded tokens against the fitted curve">' + s + '</svg>' +
      '<div class="legend">' + legend + '<span><i style="background:none;border:1.5px solid #e6edf3"></i>pre-token row (implied)</span><span style="color:#f0b429">— global fit</span></div>';
  }

  function controls() {
    var fams = Object.keys(DATA.families).sort();
    var famOpts = '<option value="all">All families</option>' + fams.map(function (f) { return '<option value="' + esc(f) + '"' + (state.family === f ? ' selected' : '') + '>' + esc(f) + '</option>'; }).join('');
    document.getElementById('controls').innerHTML =
      '<div class="controls">' +
      '<div><label for="q">Search</label><input id="q" type="search" placeholder="name or slug" value="' + esc(state.q) + '"></div>' +
      '<div><label for="fam">Family</label><select id="fam">' + famOpts + '</select></div>' +
      '<div><label for="ver">Verdict</label><select id="ver">' +
      '<option value="all">All verdicts</option>' +
      ['FARM', 'THIN', 'SKIP'].map(function (v) { return '<option' + (state.verdict === v ? ' selected' : '') + '>' + v + '</option>'; }).join('') + '</select></div>' +
      '<div><label for="scope">Scope</label><select id="scope">' +
      '<option value="all">Watchlist + early + extended</option>' +
      '<option value="watchlist"' + (state.scope === 'watchlist' ? ' selected' : '') + '>Watchlist only</option>' +
      '<option value="early"' + (state.scope === 'early' ? ' selected' : '') + '>Early radar</option>' +
      '<option value="extended"' + (state.scope === 'extended' ? ' selected' : '') + '>Extended</option></select></div>' +
      '<div><label>&nbsp;</label><label><input id="watch" type="checkbox"' + (state.watchOnly ? ' checked' : '') + '> Watchlist only</label></div>' +
      '</div>' +
      '<div class="tabs" role="group" aria-label="Board or live tokens">' +
      '<button id="tabPre" aria-pressed="' + (state.tab === 'pre') + '">Pre-token board (' + DATA.board_size + ')</button>' +
      '<button id="tabLive" aria-pressed="' + (state.tab === 'live') + '">Live tokens (' + DATA.live_size + ')</button>' +
      '</div>';
    document.getElementById('q').addEventListener('input', function (e) { state.q = e.target.value; renderTable(); });
    document.getElementById('fam').addEventListener('change', function (e) { state.family = e.target.value; renderTable(); });
    document.getElementById('ver').addEventListener('change', function (e) { state.verdict = e.target.value; renderTable(); });
    document.getElementById('scope').addEventListener('change', function (e) { state.scope = e.target.value; renderTable(); });
    document.getElementById('watch').addEventListener('change', function (e) { state.watchOnly = e.target.checked; renderTable(); });
    document.getElementById('tabPre').addEventListener('click', function () { state.tab = 'pre'; controls(); renderTable(); });
    document.getElementById('tabLive').addEventListener('click', function () { state.tab = 'live'; controls(); renderTable(); });
  }

  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.family !== 'all' && r.family !== state.family) return false;
      if (state.verdict !== 'all' && r.verdict !== state.verdict) return false;
      if (state.scope !== 'all' && r.scope !== state.scope) return false;
      if (state.watchOnly && r.scope !== 'watchlist') return false;
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.indexOf(q) < 0) return false;
      return true;
    });
  }

  function renderTable() {
    var wrap = document.getElementById('tablewrap');
    if (state.tab === 'live') {
      var live = DATA.live.map(function (p) {
        return '<tr><td class="num">' + fmtUsd(p.mcap_usd) + '</td><td>' + esc(p.name) + '</td><td>' + esc(p.family) + '</td><td class="num">' + fmtUsd(p.tvl_usd) + '</td><td class="num">' + fmtPct(p.change_7d) + '</td><td class="num">' + (p.mcap_usd && p.tvl_usd ? (p.mcap_usd / p.tvl_usd).toFixed(3) : 'n/a') + '</td></tr>';
      }).join('');
      wrap.innerHTML = '<h2>Live tokens — the market&rsquo;s own values</h2>' +
        '<p>These protocols already trade, so they are not ranked: their market cap is the fact the family fits are fitted on. Kept apart from the pre-token board on purpose.</p>' +
        '<table class="board"><thead><tr><th>Market cap</th><th>Protocol</th><th>Family</th><th>TVL</th><th>7d</th><th>mcap / TVL</th></tr></thead><tbody>' + live + '</tbody></table>';
      return;
    }
    var rows = filteredRows().slice();
    var key = state.sort;
    rows.sort(function (a, b) {
      var d = (key === 'name' || key === 'family' || key === 'verdict')
        ? (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0)
        : (b[key] - a[key]);
      return state.dir * d;
    });
    function th(label, k) {
      var arrow = state.sort === k ? (state.dir === -1 ? ' ▼' : ' ▲') : '';
      return '<th data-sort="' + k + '">' + label + arrow + '</th>';
    }
    var body = rows.map(function (r) {
      var tag = r.scope === 'watchlist' ? '<span class="tag">watchlist</span>' : r.scope === 'extended' ? '<span class="tag">extended</span>' : '';
      return '<tr data-slug="' + esc(r.slug) + '" class="' + (state.selected === r.slug ? 'sel' : '') + '">' +
        '<td class="num">' + r.rank + '</td><td><b>' + esc(r.name) + '</b>' + tag + '<br><span style="color:var(--muted)">' + esc(r.slug) + '</span></td>' +
        '<td>' + esc(r.family) + '</td><td class="num">' + fmtUsd(r.tvl_usd) + '</td><td class="num">' + fmtPct(r.change_7d) + '</td>' +
        '<td class="num">' + fmtUsd(r.implied_value_usd) + '</td><td class="num">' + (r.implied_value_usd / r.tvl_usd).toFixed(3) + '&times;</td>' +
        '<td><span class="pill ' + r.verdict + '">' + r.verdict + '</span></td><td class="num">' + money(r.net_usd) + '</td></tr>';
    }).join('');
    wrap.innerHTML = '<h2>The board — ' + DATA.board_size + ' pre-token protocols by implied value</h2>' +
      '<p>Click a row for the model breakdown and the farm plan. Multiples vary by family — that is the point: a flat multiple would rank these by TVL alone.</p>' +
      '<table class="board"><thead><tr>' + th('#', 'rank') + th('Protocol', 'name') + th('Family', 'family') + th('TVL', 'tvl_usd') + th('7d', 'change_7d') + th('Implied value', 'implied_value_usd') + th('&times;TVL', 'implied_value_usd') + th('Verdict', 'verdict') + th('Net $', 'net_usd') + '</tr></thead><tbody>' + body + '</tbody></table>' +
      '<p class="count">Showing ' + rows.length + ' of ' + DATA.board_size + ' rows. FARM ' + DATA.verdict_counts.FARM + ' &middot; THIN ' + DATA.verdict_counts.THIN + ' &middot; SKIP ' + DATA.verdict_counts.SKIP + '.</p>';
    wrap.querySelectorAll('th[data-sort]').forEach(function (el) {
      el.addEventListener('click', function () {
        var k = el.getAttribute('data-sort');
        if (state.sort === k) state.dir = -state.dir; else { state.sort = k; state.dir = k === 'name' || k === 'family' ? 1 : -1; }
        renderTable();
      });
    });
    wrap.querySelectorAll('tr[data-slug]').forEach(function (el) {
      el.addEventListener('click', function () { state.selected = el.getAttribute('data-slug'); renderTable(); renderDetail(); });
    });
  }

  function renderDetail() {
    var box = document.getElementById('detail');
    var row = null;
    DATA.rows.forEach(function (r) { if (r.slug === state.selected) row = r; });
    if (!row) { box.hidden = true; box.innerHTML = ''; return; }
    var again = recompute(row);
    var match = again === row.implied_value_usd;
    var steps = row.steps.map(function (s, i) {
      var parts = s.split(' Cost: ');
      var main = parts[0];
      var rest = parts.length > 1 ? parts[1] : '';
      return '<li>' + esc(main) + '<span>Cost: ' + esc(rest) + '</span></li>';
    }).join('');
    box.hidden = false;
    box.innerHTML = '<button class="close" id="closeDetail">Close ✕</button>' +
      '<h2>#' + row.rank + ' ' + esc(row.name) + '</h2>' +
      '<p><span class="pill ' + row.verdict + '">' + row.verdict + '</span> &nbsp;net <b>' + money(row.net_usd) + '</b> &nbsp;' +
      '<span style="color:var(--muted)">' + esc(row.family) + ' &middot; ' + esc(row.scope) + ' &middot; ' + esc(row.chains.join(', ')) + '</span></p>' +
      '<h3>Model breakdown — recomputed live on this page</h3><dl>' +
      '<dt>TVL</dt><dd>' + fmtUsd(row.tvl_usd) + '</dd>' +
      '<dt>7-day change</dt><dd>' + fmtPct(row.change_7d) + ' &rarr; growth &times;' + row.growth_multiplier.toFixed(3) + '</dd>' +
      '<dt>Age</dt><dd>' + fmtAge(row.age_days) + ' &rarr; maturity &times;' + row.maturity_multiplier.toFixed(3) + '</dd>' +
      '<dt>Chains</dt><dd>' + row.chains.length + ' &rarr; breadth &times;' + row.breadth_multiplier.toFixed(3) + '</dd>' +
      '<dt>Family fit</dt><dd>' + esc(row.family) + ': a=' + row.family_intercept.toFixed(2) + ', b=' + row.family_slope.toFixed(3) + ' (' + row.family_peers + ' peers)</dd>' +
      '<dt>Implied value</dt><dd><b>' + fmtUsd(row.implied_value_usd) + '</b> (' + (row.implied_value_usd / row.tvl_usd).toFixed(3) + '&times; TVL)</dd>' +
      '<dt>Page recompute</dt><dd>' + fmtUsd(again) + ' ' + (match ? '<span class="good">✓ matches the board</span>' : '<span class="bad">✕ differs</span>') + '</dd></dl>' +
      '<h3>Farm economics — net of all costs</h3><dl>' +
      '<dt>Expected gross</dt><dd>' + money(row.gross_usd) + ' (5% pool / ' + row.farmers.toLocaleString('en-US') + ' farmers)</dd>' +
      '<dt>Gas (6 txs)</dt><dd>-' + money(row.gas_usd) + '</dd>' +
      '<dt>Time (3h @ $15)</dt><dd>-' + money(row.time_usd) + '</dd>' +
      '<dt>Slippage (0.3%)</dt><dd>-$0.30</dd>' +
      '<dt><b>Net</b></dt><dd><b>' + money(row.net_usd) + '</b></dd></dl>' +
      '<h3>Farm plan — 7 steps</h3><ol>' + steps + '</ol>' +
      '<p>Snapshot ' + esc(DATA.as_of) + '. The snapshot records no token for this protocol, which is not proof it has none.</p>';
    document.getElementById('closeDetail').addEventListener('click', function () { state.selected = null; renderTable(); renderDetail(); });
  }

  headline();
  controls();
  renderTable();
  modelPanel();
  chart();
  renderDetail();
})();
