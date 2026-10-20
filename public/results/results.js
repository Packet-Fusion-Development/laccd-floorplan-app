/**
 * Survey results page — /results/<project>.
 *
 * One page for two audiences. The API decides which version it returns:
 *   internal  Packet Fusion staff: who surveyed each record, engineers' notes,
 *             links into the survey app, and a "Preview customer view" switch.
 *   customer  Read-only, own project only: totals, sites, exceptions, export.
 *
 * Totals are calculated live by the API from the central database, so the
 * page is current whenever it loads; it also refreshes itself every minute.
 */
(function () {
  'use strict';

  const REFRESH_MS = 60 * 1000;
  const STATUS = [
    // order = order of the stacked bar
    { key: 'working', label: 'Working', color: 'var(--st-working)', icon: '✓' },
    { key: 'not_tested', label: "Can't test", color: 'var(--st-not-tested)', icon: '–' },
    { key: 'not_working', label: 'Not working', color: 'var(--st-not-working)', icon: '✕' },
    { key: 'not_found', label: "Couldn't find", color: 'var(--st-not-found)', icon: '?' },
    { key: 'done', label: 'Surveyed, no test', color: 'var(--st-done)', icon: '•' },
    { key: 'remaining', label: 'Remaining', color: 'var(--st-remaining)', icon: '○' },
  ];
  const STATUS_BY_KEY = Object.fromEntries(STATUS.map(s => [s.key, s]));
  const DISCREPANCY = {
    not_on_list: 'Not on the list', wrong_location: 'Not at the listed location',
    different_device: 'Different device or number', not_found: "Couldn't find it",
    damaged: 'Damaged', other: 'Something else',
  };
  const TABS = [
    { key: 'not_working', label: 'Not working', test: e => e.status === 'not_working' },
    { key: 'not_found', label: "Couldn't find", test: e => e.status === 'not_found' },
    { key: 'flagged', label: 'Discrepancies', test: e => e.on_list && e.discrepancy && e.discrepancy !== 'not_found' },
    { key: 'off_list', label: 'Not on the list', test: e => !e.on_list },
  ];

  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = n => Number(n).toLocaleString();
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const time = iso => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const date = iso => (iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '');

  const path = location.pathname.split('/').filter(Boolean);
  const code = path[1] ? decodeURIComponent(path[1]) : null;
  const params = new URLSearchParams(location.search);
  const previewCustomer = params.get('view') === 'customer';

  let data = null;
  const ui = { q: '', site: '', category: '', tab: 'not_working' };

  // ---- Data ---------------------------------------------------------------

  async function getJson(url) {
    const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
    if (res.status === 403) throw new Error("You don't have access to these results. Ask your Packet Fusion contact to add you.");
    if (!res.ok) throw new Error(`Could not load results (${res.status}).`);
    return res.json();
  }

  async function load() {
    if (!code) return chooseProject();
    try {
      const first = !data;
      data = await getJson(`/api/results/${encodeURIComponent(code)}${previewCustomer ? '?view=customer' : ''}`);
      // A refresh only redraws the numbers, so filters and search keep their state and focus.
      if (first || !$('totals')) render();
      else {
        $('subtitle').textContent = `${data.project.customer_name} · Updated ${time(data.generated_at)} · refreshes every minute`;
        drawAll();
      }
    } catch (err) {
      if (!data) {
        $('main').innerHTML = `<p class="rs-empty">${esc(err.message)}</p>`;
        $('subtitle').textContent = '';
      }
    }
  }

  async function chooseProject() {
    try {
      const projects = await getJson('/api/results');
      if (projects.length === 1) { location.replace(`/results/${encodeURIComponent(projects[0].code)}`); return; }
      $('projectName').textContent = 'Survey results';
      $('subtitle').textContent = projects.length ? 'Choose a project.' : '';
      $('main').innerHTML = projects.length
        ? `<div class="rs-sites">${projects.map(p => `
            <a class="rs-card rs-site" href="/results/${encodeURIComponent(p.code)}" style="text-decoration:none">
              <span class="code">${esc(p.customer_name)}</span><h3>${esc(p.name)}</h3></a>`).join('')}</div>`
        : '<p class="rs-empty">No projects have been shared with this account yet.</p>';
    } catch (err) {
      $('main').innerHTML = `<p class="rs-empty">${esc(err.message)}</p>`;
    }
  }

  // ---- Aggregation (rows: [site, building, floor, category, status, flagged, onList]) --

  function emptyCounts() {
    return { items: 0, done: 0, offList: 0, flagged: 0, working: 0, not_tested: 0, not_working: 0, not_found: 0, done_no_test: 0, remaining: 0, byCat: {} };
  }
  function add(c, r) {
    const [, , , cat, status, flagged, onList] = r;
    if (onList) {
      c.items++;
      if (status !== 'remaining') c.done++;
      c.byCat[cat] = c.byCat[cat] || { items: 0, done: 0 };
      c.byCat[cat].items++;
      if (status !== 'remaining') c.byCat[cat].done++;
      if (flagged) c.flagged++;
    } else {
      c.offList++;
    }
    if (status === 'done') c.done_no_test++;
    else c[status]++;
  }
  function filteredRows() {
    return data.rows.filter(r =>
      (ui.site === '' || r[0] === Number(ui.site)) && (ui.category === '' || r[3] === Number(ui.category)));
  }

  // ---- Render -------------------------------------------------------------

  function render() {
    const view = data.view;
    document.title = `${data.project.name} — Results`;
    $('projectName').textContent = data.project.name;
    $('subtitle').textContent = `${data.project.customer_name} · Updated ${time(data.generated_at)} · refreshes every minute`;

    const exportUrl = `/api/results/${encodeURIComponent(code)}/export.csv${view === 'customer' && data.can_preview ? '?view=customer' : ''}`;
    $('headerActions').innerHTML = `
      <span class="rs-badge ${view === 'customer' ? 'is-customer' : ''}">${view === 'customer' ? 'Customer view' : 'Internal view'}</span>
      ${data.can_preview ? (view === 'customer'
        ? `<a class="rs-hbtn" href="?">Back to internal view</a>`
        : `<a class="rs-hbtn" href="?view=customer">Preview customer view</a>
           <a class="rs-hbtn" href="/survey#/p/${encodeURIComponent(code)}">Open survey app</a>`) : ''}
      <a class="rs-hbtn is-primary" href="${exportUrl}">Export CSV</a>`;

    if (!data.rows.length) {
      $('main').innerHTML = '<p class="rs-empty">No device list has been loaded for this project yet.</p>';
      return;
    }

    const siteLabel = data.project.site_label?.plural || 'Sites';
    const site1 = data.project.site_label?.singular || 'Site';
    $('main').innerHTML = `
      <section aria-label="Totals" id="totals"></section>
      <section class="rs-card rs-filters" aria-label="Filters">
        <input id="q" type="search" placeholder="Search ${esc(siteLabel.toLowerCase())}, buildings, extensions or names…" value="${esc(ui.q)}" autocomplete="off">
        <div class="rs-filter-row">
          <select id="fSite" aria-label="${esc(site1)}"><option value="">All ${esc(siteLabel.toLowerCase())}</option>
            ${data.sites.map((s, i) => `<option value="${i}" ${String(i) === ui.site ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
          <select id="fCat" aria-label="Category"><option value="">All categories</option>
            ${data.categories.map((c, i) => `<option value="${i}" ${String(i) === ui.category ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select>
          <button class="rs-clear" type="button" id="clear">Clear filters</button>
        </div>
        <div class="rs-legend" aria-label="Legend">${STATUS.map(s => `<span><i class="rs-swatch" style="background:${s.color}"></i>${esc(s.label)}</span>`).join('')}</div>
      </section>
      <section aria-labelledby="sitesHead" style="display:grid;gap:12px">
        <div class="rs-section-head"><h2 id="sitesHead">${esc(siteLabel)}</h2><p class="rs-note" id="sitesNote"></p></div>
        <div class="rs-sites" id="sites"></div>
      </section>
      <section aria-labelledby="exHead" style="display:grid;gap:12px">
        <div class="rs-section-head"><h2 id="exHead">Needs attention</h2>
          <p class="rs-note">${view === 'customer' ? 'Items that are not working, could not be found, or do not match your list.' : 'Follow-up list. Open a record to review it in the survey app.'}</p></div>
        <div class="rs-card" id="exceptions"></div>
      </section>`;

    $('q').addEventListener('input', e => { ui.q = e.target.value; drawSites(); drawExceptions(); });
    $('fSite').addEventListener('change', e => { ui.site = e.target.value; drawAll(); });
    $('fCat').addEventListener('change', e => { ui.category = e.target.value; drawAll(); });
    $('clear').addEventListener('click', () => { Object.assign(ui, { q: '', site: '', category: '' }); render(); });
    drawAll();
  }

  function drawAll() { drawTotals(); drawSites(); drawExceptions(); }

  function drawTotals() {
    const t = emptyCounts();
    filteredRows().forEach(r => add(t, r));
    const records = t.working + t.not_tested + t.not_working + t.not_found + t.done_no_test;
    const tile = (label, value, status, hint) => `
      <div class="rs-card rs-tile" ${hint ? `title="${esc(hint)}"` : ''}>
        <span class="label">${status ? `<i class="rs-swatch" style="background:${STATUS_BY_KEY[status].color}"></i>` : ''}${esc(label)}</span>
        <span class="value">${fmt(value)}</span>
      </div>`;
    $('totals').innerHTML = `
      <div class="rs-totals">
        <div class="rs-card rs-hero">
          <span class="label">Surveyed</span>
          <span class="value">${pct(t.done, t.items)}%</span>
          <span class="sub">${fmt(t.done)} of ${fmt(t.items)} items on the list</span>
          ${bar(t, t.items + t.offList)}
        </div>
        ${tile('Remaining', t.remaining, 'remaining', 'On the list, not surveyed yet')}
        ${tile('Working', t.working, 'working', `Of ${fmt(records)} records`)}
        ${tile('Not working', t.not_working, 'not_working')}
        ${tile("Can't test", t.not_tested, 'not_tested')}
        ${tile("Couldn't find", t.not_found, 'not_found')}
        ${tile('Discrepancies', t.flagged, null, "Didn't match the list (location, device, number, damage)")}
        ${tile('Not on the list', t.offList, null, 'Found on site but missing from the list')}
        ${tile('Photos', data.photos, null)}
      </div>`;
    bindTooltips($('totals'));
  }

  /** Stacked status bar with an accessible text summary. */
  function bar(c, total, small) {
    const parts = STATUS.map(s => ({ s, n: s.key === 'done' ? c.done_no_test : c[s.key] })).filter(p => p.n > 0);
    const summary = parts.map(p => `${p.s.label} ${fmt(p.n)}`).join(', ');
    return `<div class="rs-bar ${small ? 'is-small' : ''}" role="img" aria-label="${esc(summary)}">
      ${parts.map(p => `<i style="flex:${p.n};background:${p.s.color}" data-tip="${esc(`${p.s.label}: ${fmt(p.n)} (${pct(p.n, total)}%)`)}"></i>`).join('')}
    </div>`;
  }

  function drawSites() {
    const q = ui.q.trim().toLowerCase();
    const bySite = data.sites.map(() => emptyCounts());
    filteredRows().forEach(r => { if (r[0] >= 0) add(bySite[r[0]], r); });
    const cards = data.sites.map((s, i) => ({ s, i, c: bySite[i] }))
      .filter(({ s, i, c }) => (c.items || c.offList) && (!q || `${s.name} ${s.code}`.toLowerCase().includes(q)
        || data.buildings.some(b => b.site === i && b.name.toLowerCase().includes(q))));
    $('sitesNote').textContent = `${cards.length} shown`;
    $('sites').innerHTML = cards.map(({ s, i, c }) => `
      <article class="rs-card rs-site">
        <span class="code">${esc(s.code)}</span>
        <h3>${esc(s.name)}</h3>
        <div class="pct"><span><b>${pct(c.done, c.items)}%</b> surveyed</span><span>${fmt(c.done)} of ${fmt(c.items)}</span></div>
        ${bar(c, c.items + c.offList)}
        <div class="rs-cats">${Object.entries(c.byCat).map(([k, v]) => `
          <div><span>${esc(data.categories[k]?.label ?? 'Other')}</span><span>${fmt(v.done)} / ${fmt(v.items)}</span></div>`).join('')}</div>
        <div class="rs-chips">
          ${c.not_working ? `<span class="rs-chip is-critical">✕ ${fmt(c.not_working)} not working</span>` : ''}
          ${c.not_found ? `<span class="rs-chip is-serious">? ${fmt(c.not_found)} couldn't find</span>` : ''}
          ${c.flagged ? `<span class="rs-chip is-flag">⚑ ${fmt(c.flagged)} discrepanc${c.flagged === 1 ? 'y' : 'ies'}</span>` : ''}
          ${c.offList ? `<span class="rs-chip">+ ${fmt(c.offList)} not on list</span>` : ''}
        </div>
        <button class="rs-site-btn" type="button" data-site="${i}">Buildings and floors</button>
      </article>`).join('') || '<p class="rs-empty">Nothing matches these filters.</p>';
    $('sites').querySelectorAll('[data-site]').forEach(b => b.addEventListener('click', () => openSite(Number(b.dataset.site))));
    bindTooltips($('sites'));
  }

  function openSite(si) {
    const s = data.sites[si];
    const bCounts = new Map(), fCounts = new Map();
    filteredRows().filter(r => r[0] === si).forEach(r => {
      if (!bCounts.has(r[1])) bCounts.set(r[1], emptyCounts());
      add(bCounts.get(r[1]), r);
      if (!fCounts.has(r[2])) fCounts.set(r[2], emptyCounts());
      add(fCounts.get(r[2]), r);
    });
    const line = (name, c, cls, toggle) => `
      <tr class="${cls || ''}">
        <td>${toggle || esc(name)}</td>
        <td class="rs-bar-cell">${bar(c, c.items + c.offList, true)}</td>
        <td class="num">${pct(c.done, c.items)}%</td>
        <td class="num">${fmt(c.done)} / ${fmt(c.items)}</td>
        <td class="num">${fmt(c.working)}</td>
        <td class="num">${fmt(c.not_working)}</td>
        <td class="num">${fmt(c.not_tested)}</td>
        <td class="num">${fmt(c.not_found)}</td>
        <td class="num">${fmt(c.flagged)}</td>
        <td class="num">${fmt(c.offList)}</td>
      </tr>`;
    const buildings = data.buildings.map((b, bi) => ({ b, bi })).filter(({ b, bi }) => b.site === si && bCounts.has(bi));
    const rows = buildings.map(({ b, bi }) => {
      const floors = data.floors.map((f, fi) => ({ f, fi })).filter(({ f, fi }) => f.building === bi && fCounts.has(fi));
      return line(b.name, bCounts.get(bi), '', floors.length
        ? `<button class="rs-row-toggle" type="button" aria-expanded="false" data-b="${bi}">${esc(b.name)}</button>` : esc(b.name))
        + floors.map(({ f, fi }) => line(f.name, fCounts.get(fi), `is-floor b-${bi}`)).join('');
    }).join('');
    const unplaced = bCounts.get(-1);

    $('detailContent').innerHTML = `
      <div><p class="rs-note">${esc(s.code)}</p><h2 id="detailTitle">${esc(s.name)}</h2></div>
      <div class="rs-legend">${STATUS.map(x => `<span><i class="rs-swatch" style="background:${x.color}"></i>${esc(x.label)}</span>`).join('')}</div>
      <div class="rs-card rs-table-wrap">
        <table class="rs-table">
          <thead><tr><th>Building / floor</th><th>Status</th><th class="num">Surveyed</th><th class="num">Done</th>
            <th class="num">Working</th><th class="num">Not working</th><th class="num">Can't test</th>
            <th class="num">Couldn't find</th><th class="num">Discrepancies</th><th class="num">Not on list</th></tr></thead>
          <tbody>${rows}${unplaced ? line('No building recorded', unplaced) : ''}</tbody>
        </table>
      </div>`;
    $('detailContent').querySelectorAll('tr.is-floor').forEach(tr => { tr.hidden = true; });
    $('detailContent').querySelectorAll('.rs-row-toggle').forEach(btn => btn.addEventListener('click', () => {
      const open = btn.getAttribute('aria-expanded') !== 'true';
      btn.setAttribute('aria-expanded', String(open));
      $('detailContent').querySelectorAll(`tr.b-${btn.dataset.b}`).forEach(tr => { tr.hidden = !open; });
    }));
    bindTooltips($('detailContent'));
    $('detailOverlay').hidden = false;
    $('detailClose').focus();
  }

  function drawExceptions() {
    const q = ui.q.trim().toLowerCase();
    const inFilter = data.exceptions.filter(e =>
      (ui.site === '' || e.site === Number(ui.site)) && (ui.category === '' || e.category === Number(ui.category)));
    const counts = Object.fromEntries(TABS.map(t => [t.key, inFilter.filter(t.test).length]));
    if (!counts[ui.tab]) ui.tab = TABS.find(t => counts[t.key])?.key ?? ui.tab;
    const tab = TABS.find(t => t.key === ui.tab);
    const where = e => [data.buildings[e.building]?.name, data.floors[e.floor]?.name].filter(Boolean).join(' · ');
    const list = inFilter.filter(tab.test).filter(e => !q || [
      data.sites[e.site]?.name, where(e), e.name, e.extension, e.phone_number, e.listed_location, e.discrepancy_note, e.location_note,
    ].join(' ').toLowerCase().includes(q));
    const internal = data.view === 'internal';
    const issue = e => {
      const st = STATUS_BY_KEY[e.status];
      const parts = [];
      if (e.status !== 'remaining') parts.push(`<span class="rs-status"><i class="rs-swatch" style="background:${st.color}"></i>${esc(st.label)}</span>`);
      if (e.discrepancy && e.discrepancy !== 'not_found') parts.push(`<span class="rs-chip is-flag">⚑ ${esc(DISCREPANCY[e.discrepancy] || e.discrepancy)}</span>`);
      return parts.join('<br>');
    };
    const recordLink = e => {
      const site = data.sites[e.site];
      const cat = data.categories[e.category]?.key || 'all';
      return site?.id && e.device_id ? `<a href="/survey#/p/${encodeURIComponent(code)}/site/${encodeURIComponent(site.id)}/c/${encodeURIComponent(cat)}/r/dev-${encodeURIComponent(e.device_id)}">Open</a>` : '';
    };

    $('exceptions').innerHTML = `
      <div class="rs-tabs" role="tablist">${TABS.map(t => `
        <button class="rs-tab" role="tab" type="button" data-tab="${t.key}" aria-selected="${t.key === ui.tab}">${esc(t.label)} (${fmt(counts[t.key])})</button>`).join('')}</div>
      <div class="rs-table-wrap">
        ${list.length ? `<table class="rs-table">
          <thead><tr><th>${esc(data.project.site_label?.singular || 'Site')}</th><th>Where</th><th>Item</th><th>Status</th><th>Note</th><th>Date</th>
            ${internal ? '<th>Surveyed by</th><th></th>' : ''}</tr></thead>
          <tbody>${list.slice(0, 500).map(e => `
            <tr>
              <td>${esc(data.sites[e.site]?.name ?? '')}</td>
              <td>${esc(where(e))}${e.listed_location ? `<br><span class="muted">Listed: ${esc(e.listed_location)}</span>` : ''}${e.location_note ? `<br><span class="muted">Found: ${esc(e.location_note)}</span>` : ''}</td>
              <td>${esc([e.extension || e.phone_number, e.name].filter(Boolean).join(' · ') || (e.on_list ? '' : esc(data.categories[e.category]?.title ?? 'Device')))}</td>
              <td>${issue(e)}</td>
              <td>${esc(e.discrepancy_note || '')}${internal && e.notes ? `<br><span class="muted">${esc(e.notes)}</span>` : ''}</td>
              <td class="muted">${esc(date(e.updated_at))}</td>
              ${internal ? `<td class="muted">${esc(e.surveyed_by || '')}</td><td>${recordLink(e)}</td>` : ''}
            </tr>`).join('')}</tbody>
        </table>${list.length > 500 ? `<p class="rs-note" style="padding:10px 12px">Showing 500 of ${fmt(list.length)}. Export CSV for the full list.</p>` : ''}`
          : `<p class="rs-empty">${q ? 'Nothing matches your search.' : 'Nothing in this list.'}</p>`}
      </div>`;
    $('exceptions').querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => { ui.tab = b.dataset.tab; drawExceptions(); }));
  }

  // ---- Tooltip, panel, refresh ---------------------------------------------

  const tip = $('tooltip');
  function bindTooltips(root) {
    root.querySelectorAll('[data-tip]').forEach(el => {
      el.addEventListener('mousemove', e => {
        tip.textContent = el.dataset.tip;
        tip.hidden = false;
        const x = Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 8);
        tip.style.left = `${x}px`;
        tip.style.top = `${e.clientY + 14}px`;
      });
      el.addEventListener('mouseleave', () => { tip.hidden = true; });
    });
  }

  const closePanel = () => { $('detailOverlay').hidden = true; };
  $('detailClose').addEventListener('click', closePanel);
  $('detailOverlay').addEventListener('click', e => { if (e.target.id === 'detailOverlay') closePanel(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closePanel(); });

  setInterval(() => {
    if (document.visibilityState === 'visible' && code && $('detailOverlay').hidden) load();
  }, REFRESH_MS);

  load();
})();
