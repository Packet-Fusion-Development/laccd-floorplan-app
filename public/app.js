const PAGE_SIZE = 30;
let ALL = [];
let state = { q: "", campus: "", building: "", page: 1 };
let currentPageRows = [];

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// Encode each path segment separately. Drawing filenames contain spaces, "&",
// and "#" ("Parking Structure #8.pdf") — encodeURI() leaves "#" intact and the
// browser would read it as a fragment delimiter, truncating the URL.
function assetUrl(relPath) {
  return '/' + String(relPath).split('/').map(encodeURIComponent).join('/');
}

/**
 * Populates the header chip from the Cloudflare Access session.
 *
 * /cdn-cgi/access/get-identity is served by Cloudflare on the app's own
 * hostname, so this needs no Worker route. It returns 400 when there is no
 * Access session — running locally, for instance — in which case the chip
 * stays hidden rather than showing a half-empty control.
 */
async function initUserChip() {
  let identity;
  try {
    const res = await fetch('/cdn-cgi/access/get-identity', { credentials: 'same-origin' });
    if (!res.ok) return;
    identity = await res.json();
  } catch {
    return;
  }

  const email = identity.email || '';
  const name = identity.name || email;
  if (!name) return;

  const menu = document.getElementById('userMenu');
  const chip = document.getElementById('userChip');
  const dropdown = document.getElementById('userDropdown');

  document.getElementById('userAvatar').textContent = initials(name, email);
  document.getElementById('userName').textContent = name;
  document.getElementById('userMenuName').textContent = name;
  document.getElementById('userMenuEmail').textContent = email;
  chip.setAttribute('aria-label', `Signed in as ${name}`);
  menu.hidden = false;

  const setOpen = (open) => {
    dropdown.hidden = !open;
    chip.setAttribute('aria-expanded', String(open));
  };

  chip.addEventListener('click', e => {
    e.stopPropagation();
    setOpen(dropdown.hidden);
  });

  document.addEventListener('click', e => {
    if (!menu.contains(e.target)) setOpen(false);
  });

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || dropdown.hidden) return;
    // Claim Escape so it does not also fall through to the detail overlay.
    e.stopPropagation();
    setOpen(false);
    chip.focus();
  }, true);
}

/** Two letters: initials of a display name, else the start of the email. */
function initials(name, email) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const source = words[0] || email || '?';
  return source.replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '?';
}

async function init() {
  initUserChip();

  try {
    const res = await fetch('/catalog.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    ALL = await res.json();
  } catch (err) {
    document.getElementById('subtitle').textContent = 'Could not load the catalog.';
    document.getElementById('resultsGrid').innerHTML =
      `<div class="empty-state">Failed to load catalog data (${esc(err.message)}). Please refresh.</div>`;
    return;
  }

  document.getElementById('subtitle').textContent =
    `${ALL.length} floor plans across ${new Set(ALL.map(r => r.campus_code)).size} campuses`;
  populateCampusFilter();
  populateBuildingFilter();
  render();

  document.getElementById('searchInput').addEventListener('input', e => {
    state.q = e.target.value.toLowerCase();
    state.page = 1;
    render();
  });
  document.getElementById('filterCampus').addEventListener('change', e => {
    state.campus = e.target.value;
    state.building = "";
    state.page = 1;
    populateBuildingFilter();
    render();
  });
  document.getElementById('filterBuilding').addEventListener('change', e => {
    state.building = e.target.value;
    state.page = 1;
    render();
  });
  document.getElementById('clearFilters').addEventListener('click', () => {
    state = { q: "", campus: "", building: "", page: 1 };
    document.getElementById('searchInput').value = "";
    document.getElementById('filterCampus').value = "";
    populateBuildingFilter();
    document.getElementById('filterBuilding').value = "";
    render();
  });
}

function populateCampusFilter() {
  const sel = document.getElementById('filterCampus');
  const campuses = [...new Map(ALL.map(r => [r.campus_code, r.campus_name])).entries()]
    .sort((a, b) => a[0].localeCompare(b[0]));
  sel.innerHTML = '<option value="">All campuses</option>' +
    campuses.map(([code, name]) => `<option value="${esc(code)}">${esc(code)} — ${esc(name)}</option>`).join('');
}

function populateBuildingFilter() {
  const sel = document.getElementById('filterBuilding');
  const scoped = state.campus ? ALL.filter(r => r.campus_code === state.campus) : ALL;
  const buildings = [...new Set(scoped.map(r => r.building))].sort();
  sel.innerHTML = '<option value="">All buildings</option>' +
    buildings.map(b => `<option value="${esc(b)}">${esc(b)}</option>`).join('');
}

function filteredRows() {
  return ALL.filter(r => {
    if (state.campus && r.campus_code !== state.campus) return false;
    if (state.building && r.building !== state.building) return false;
    if (state.q) {
      const hay = `${r.campus_code} ${r.campus_name} ${r.building} ${r.floor} ${r.filename} ${(r.room_numbers||[]).join(' ')} ${(r.room_names||[]).join(' ')}`.toLowerCase();
      if (!hay.includes(state.q)) return false;
    }
    return true;
  });
}

function render() {
  const rows = filteredRows();
  document.getElementById('resultCount').textContent =
    `${rows.length} result${rows.length === 1 ? '' : 's'}`;

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (state.page > totalPages) state.page = totalPages;
  const start = (state.page - 1) * PAGE_SIZE;
  const pageRows = rows.slice(start, start + PAGE_SIZE);

  const grid = document.getElementById('resultsGrid');
  if (pageRows.length === 0) {
    grid.innerHTML = '<div class="empty-state">No floor plans match these filters.</div>';
  } else {
    grid.innerHTML = pageRows.map((r, idx) => {
      const roomCount = (r.room_numbers || []).length;
      const roomTags = (r.room_names || []).slice(0, 4);
      const extraRooms = (r.room_names || []).length - roomTags.length;
      const metaBits = [];
      if (r.wing_section) metaBits.push(esc(r.wing_section));
      if (r.draft_date) metaBits.push('Draft ' + esc(r.draft_date));
      if (r.sheet_numbers && r.sheet_numbers.length) metaBits.push(esc(r.sheet_numbers.join(', ')));
      return `
      <div class="result-card" data-idx="${idx}" role="button" tabindex="0">
        <a class="thumb-link" href="${assetUrl(r.rel_path)}" target="_blank" rel="noopener" title="Open PDF" data-no-detail>
          <img class="thumb" src="${assetUrl(r.thumb_path)}" alt="Preview of ${esc(r.filename)}" loading="lazy">
        </a>
        <div class="campus">${esc(r.campus_code)}</div>
        <h3>${esc(r.building)}</h3>
        <div class="meta-line">${esc(r.floor)}${metaBits.length ? ' · ' + metaBits.join(' · ') : ''}</div>
        <div class="pill-row">
          ${r.is_supporting_document ? '<span class="pill doc">Supporting Document</span>' : `<span class="pill">${esc(r.campus_name)}</span>`}
          ${roomCount ? `<span class="pill">${roomCount} room${roomCount === 1 ? '' : 's'}</span>` : ''}
        </div>
        ${roomTags.length ? `<div class="pill-row">${roomTags.map(t => `<span class="pill room">${esc(t)}</span>`).join('')}${extraRooms > 0 ? `<span class="pill more">+${extraRooms} more</span>` : ''}</div>` : ''}
        <div class="card-footer">
          <span>${r.size_kb >= 1024 ? (r.size_kb/1024).toFixed(1) + ' MB' : r.size_kb + ' KB'}</span>
          <a class="pdf-link" href="${assetUrl(r.rel_path)}" target="_blank" rel="noopener" data-no-detail>Open PDF</a>
        </div>
      </div>
    `;
    }).join('');
  }

  currentPageRows = pageRows;
  grid.querySelectorAll('.result-card').forEach(card => {
    card.addEventListener('click', e => {
      if (e.target.closest('[data-no-detail]')) return;
      openDetail(currentPageRows[parseInt(card.dataset.idx, 10)]);
    });
    card.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openDetail(currentPageRows[parseInt(card.dataset.idx, 10)]);
      }
    });
  });

  renderPagination(totalPages);
}

function renderPagination(totalPages) {
  const nav = document.getElementById('pagination');
  if (totalPages <= 1) { nav.innerHTML = ''; return; }
  let html = `<button ${state.page === 1 ? 'disabled' : ''} data-page="${state.page - 1}">Prev</button>`;
  const windowSize = 5;
  let lo = Math.max(1, state.page - Math.floor(windowSize/2));
  let hi = Math.min(totalPages, lo + windowSize - 1);
  lo = Math.max(1, hi - windowSize + 1);
  for (let p = lo; p <= hi; p++) {
    html += `<button class="${p === state.page ? 'active' : ''}" data-page="${p}">${p}</button>`;
  }
  html += `<button ${state.page === totalPages ? 'disabled' : ''} data-page="${state.page + 1}">Next</button>`;
  nav.innerHTML = html;
  nav.querySelectorAll('button[data-page]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.page = parseInt(btn.dataset.page, 10);
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });
}

function openDetail(r) {
  if (!r) return;
  const kv = (label, value) => value ? `<div class="kv-row"><div class="k">${esc(label)}</div><div>${esc(value)}</div></div>` : '';

  const roomNumbers = r.room_numbers || [];
  const roomNames = r.room_names || [];
  const sheetNumbers = r.sheet_numbers || [];

  let roomsSection = '<p class="no-data-note">No room data on file for this sheet.</p>';
  if (roomNames.length || roomNumbers.length) {
    roomsSection = '';
    if (roomNames.length) {
      roomsSection += `<div style="font-size:12px; color:var(--muted); font-weight:600; margin-bottom:6px;">Room names</div>`;
      roomsSection += `<div class="tag-list">${roomNames.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>`;
    }
    if (roomNumbers.length) {
      roomsSection += `<div style="font-size:12px; color:var(--muted); font-weight:600; margin:${roomNames.length ? '14px' : '0'} 0 6px;">Room numbers</div>`;
      roomsSection += `<div class="tag-list">${roomNumbers.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>`;
    }
  }

  document.getElementById('detailContent').innerHTML = `
    <a href="${assetUrl(r.rel_path)}" target="_blank" rel="noopener" title="Open PDF">
      <img class="detail-thumb" src="${assetUrl(r.thumb_path)}" alt="Preview of ${esc(r.filename)}">
    </a>
    <div class="detail-campus">${esc(r.campus_code)} — ${esc(r.campus_name)}</div>
    <h2>${esc(r.building)}</h2>
    <div class="detail-subline">${esc(r.floor)}</div>
    <a class="detail-open-pdf" href="${assetUrl(r.rel_path)}" target="_blank" rel="noopener">Open PDF</a>

    <div class="detail-section">
      <h4>Sheet details</h4>
      ${kv('Filename', r.filename)}
      ${kv('Wing / Section', r.wing_section)}
      ${kv('Draft date', r.draft_date)}
      ${kv('Revision number', r.revision_number)}
      ${kv('Project number', r.project_number)}
      ${kv('Sheet numbers', sheetNumbers.join(', '))}
      ${kv('File size', r.size_kb >= 1024 ? (r.size_kb/1024).toFixed(1) + ' MB' : r.size_kb + ' KB')}
    </div>

    <div class="detail-section">
      <h4>Rooms (${roomNames.length} name${roomNames.length === 1 ? '' : 's'}, ${roomNumbers.length} number${roomNumbers.length === 1 ? '' : 's'})</h4>
      ${roomsSection}
    </div>

    ${r.additional_notes ? `
    <div class="detail-section">
      <h4>Additional notes</h4>
      <div class="notes-box">${esc(r.additional_notes)}</div>
    </div>` : ''}
  `;

  document.getElementById('detailOverlay').classList.remove('hidden');
}

function closeDetail() {
  document.getElementById('detailOverlay').classList.add('hidden');
}

document.getElementById('closeDetail').addEventListener('click', closeDetail);
document.getElementById('detailOverlay').addEventListener('click', e => {
  if (e.target.id === 'detailOverlay') closeDetail();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeDetail();
});

init();
