/**
 * ui/appMode.js — one app, three layouts.
 *
 * `map` is the studio as it has always been: full-screen map, tools in the
 * sidebar. It stays the default, because that is what this tool is for and
 * nobody should have to travel through a dashboard to move a pin.
 *
 * `dashboard` shrinks the map into a panel and fills the rest with cards you
 * fill in yourself — the board you build a report on top of.
 *
 * `report` puts the map in the middle of an A4 sheet with the legend, the
 * distances, the highlights and the comment around it: the thing that actually
 * goes to a client.
 *
 * THE MAP IS NEVER MOVED OR REBUILT. Every mode is the same CSS grid with the
 * map as one of its items, so switching changes which cell it occupies and
 * nothing else. The alternative — a wrapper element per mode, with the map
 * relocated into it — means `appendChild` on the Leaflet container, which tears
 * down and rebuilds its DOM: every pin, shape, label and boundary would have to
 * be re-created, and anything that failed to would be silently gone. A layout
 * switch that can lose work is not worth having.
 *
 * The two things that DO need saying after a switch are size and position:
 * Leaflet caches the container's dimensions, and the billboard layer positions
 * pins from them, so both are told the box changed.
 */

const APP_MODES = ['map', 'dashboard', 'report'];

/** Where the search box lives in map mode, so it can be put back. */
let appModeSearchHome = null;

/** Whether it was collapsed before the dashboard borrowed it. */
let appModeSearchWasCollapsed = true;

/** @returns {string} the current mode */
function appMode() {
  const m = document.getElementById('app');
  return (m && m.dataset.mode) || 'map';
}

/**
 * Switch layout.
 *
 * @param {string} mode one of APP_MODES
 * @param {object} [opts] `{silent}` to skip the status line
 */
function setAppMode(mode, opts) {
  if (APP_MODES.indexOf(mode) === -1) mode = 'map';
  const app = document.getElementById('app');
  if (!app || app.dataset.mode === mode) return;

  app.dataset.mode = mode;

  // The tools overlay is per-visit, not a setting: leaving the board closes it
  // rather than leaving a panel hanging over whatever you switch to.
  app.classList.remove('dash-side-open');
  const toolsBtn = document.getElementById('dnTools');
  if (toolsBtn) { toolsBtn.classList.remove('on'); toolsBtn.setAttribute('aria-pressed', 'false'); }

  // The search box is one element with one set of handlers and one results
  // list. In dashboard mode it belongs in the top bar, so it is re-parented
  // rather than duplicated — a second search input would be a second thing to
  // keep in step with the first.
  const search = document.getElementById('searchBox');
  const slot = document.getElementById('dashTopSearch');
  if (search && slot) {
    if (mode === 'dashboard') {
      if (!appModeSearchHome) appModeSearchHome = search.parentNode;
      // Remember how it was left on the map, so coming back does not silently
      // change a control the user had already set the way they wanted.
      appModeSearchWasCollapsed = search.classList.contains('collapsed');
      if (search.parentNode !== slot) slot.appendChild(search);
      search.classList.remove('collapsed');
    } else if (appModeSearchHome && search.parentNode !== appModeSearchHome) {
      appModeSearchHome.appendChild(search);
      if (appModeSearchWasCollapsed) search.classList.add('collapsed');
    }
    // On the sheet it is a tool, not part of the page — collapsed to its icon
    // so a 300px search bar is not lying across the middle of the map.
    if (mode === 'report') search.classList.add('collapsed');
  }

  document.querySelectorAll('[data-mode-btn]').forEach(b => {
    const on = b.dataset.modeBtn === mode;
    b.classList.toggle('on', on);
    b.setAttribute('aria-current', on ? 'page' : 'false');
  });

  // On the board the map is a tile on the canvas, so it moves into it — and
  // back out again for the other two modes, where it is a grid item. Moving it
  // costs the map nothing but its cached size (see dashLayout.js), and it has
  // to happen before the board renders so the layout can measure it.
  if (typeof dashMapToCanvas === 'function') dashMapToCanvas(mode === 'dashboard');

  if (mode === 'dashboard' && typeof renderDashboard === 'function') renderDashboard();
  if (mode === 'report' && typeof renderReportSheet === 'function') renderReportSheet();

  // Leaflet caches the container size and will keep drawing to the old one —
  // a map that thinks it is 1400px wide inside a 700px panel renders half its
  // tiles off the edge and puts every click in the wrong place.
  const settle = () => {
    try { map.invalidateSize({ animate: false }); } catch (e) { /* not up yet */ }
    if (typeof scheduleRepaint === 'function') scheduleRepaint();
  };
  requestAnimationFrame(() => { settle(); setTimeout(settle, 240); });

  try { localStorage.setItem('dbot.appMode', mode); } catch (e) { /* private mode */ }

  if (!(opts && opts.silent) && typeof status === 'function') {
    if (mode === 'dashboard') status('Dashboard. The map is still live — draw, drag and edit exactly as before.');
    else if (mode === 'report') status('Report sheet. Every panel is editable; the map in the middle is the real map.');
    else status('Map studio.');
  }
}

/**
 * Fill the AI-reports popover.
 *
 * Lists what this browser has a record of, and says so plainly when the
 * backend's count is higher — a report generated on another machine is not
 * downloadable from here, and pretending the list is complete would send
 * someone hunting for a file that was never in this browser.
 *
 * @param {number|null} serverCount today's count from the backend, if known
 */
function renderReportsMenu(serverCount) {
  const host = document.getElementById('dtReports');
  if (!host) return;
  const list = (typeof aiReportLog === 'function') ? aiReportLog() : [];

  let html = '<h4>Your reports</h4>';
  if (!list.length) {
    html += '<div class="dt-empty">Nothing to download yet. Generate one with '
      + '<b>New research</b> — the PDF and Word links land here and stay for 48 hours.</div>';
  } else {
    html += list.map(r =>
      '<div class="dt-rep"><div class="dt-rep-main">'
      + '<div class="dt-rep-name">' + esc(r.site || 'Site report') + '</div>'
      + '<div class="dt-rep-meta">' + esc(aiReportWhen(r.createdAt))
      + (r.expiresAt ? ' · ' + esc(aiReportLeft(r.expiresAt)) : '') + '</div></div>'
      + (r.pdfUrl ? '<a href="' + esc(r.pdfUrl) + '" data-dl="PDF">PDF</a>' : '')
      + (r.docxUrl ? '<a href="' + esc(r.docxUrl) + '" data-dl="Word document">Word</a>' : '')
      + '</div>').join('');
  }

  if (typeof serverCount === 'number' && serverCount > list.length) {
    html += '<div class="dt-empty">' + serverCount + ' report'
      + (serverCount === 1 ? ' was' : 's were') + ' generated on this account today, but only '
      + list.length + ' ' + (list.length === 1 ? 'is' : 'are') + ' saved in this browser. '
      + 'The rest were made elsewhere — the download links only exist where the report was made.</div>';
  }

  host.innerHTML = html;
  host.querySelectorAll('[data-dl]').forEach(a => {
    a.addEventListener('click', e => {
      if (typeof aiDownload !== 'function') return;   // let the plain link work
      e.preventDefault();
      aiDownload(a.getAttribute('href'), a.dataset.dl);
    });
  });
}

(function wireAppMode() {
  document.querySelectorAll('[data-mode-btn]').forEach(b => {
    b.addEventListener('click', () => setAppMode(b.dataset.modeBtn));
  });

  const tools = document.getElementById('dnTools');
  if (tools) {
    tools.addEventListener('click', () => {
      // The studio's sidebar is absolutely positioned and works in every mode;
      // this slides it back in over the board, so the full toolset is one click
      // away from the dashboard rather than a mode switch away.
      //
      // A class of its own rather than reusing `side-hidden`: that one is the
      // studio's own preference, and opening the tools over the dashboard must
      // not change what you see when you go back to the map.
      const app = document.getElementById('app');
      if (!app) return;
      const open = app.classList.toggle('dash-side-open');
      tools.classList.toggle('on', open);
      tools.setAttribute('aria-pressed', open ? 'true' : 'false');
    });
  }

  const editBtn = document.getElementById('dashEditBtn');
  if (editBtn) editBtn.addEventListener('click', () => setDashEditing(!dashEditing));

  // "New research" opens the AI panel rather than starting a run: which site
  // the report is for is a choice, and a button that picked one for you would
  // spend a report on the wrong place.
  const cta = document.getElementById('dtNewReport');
  if (cta) {
    cta.addEventListener('click', () => {
      const ai = document.getElementById('aiBtn');
      if (ai && typeof openAiPanel === 'function') openAiPanel();
      else if (ai) ai.click();
    });
  }

  // The allowance is the backend's own count, fetched once when the board is
  // first opened. Left as an em-dash rather than a guess if it cannot be
  // reached — a made-up quota is worse than a visibly absent one.
  const usage = document.getElementById('dtUsageVal');
  let usageCount = null;
  if (usage) {
    const fill = () => {
      if (typeof getUsage !== 'function') { usage.textContent = 'not configured'; return; }
      getUsage()
        .then(u => {
          usageCount = u.reportsGenerated ?? 0;
          usage.textContent = usageCount + ' / ' + (u.reportsCap ?? '?') + ' today';
        })
        .catch(() => { usage.textContent = 'unavailable'; });
    };
    let asked = false;
    document.querySelectorAll('[data-mode-btn="dashboard"]').forEach(b =>
      b.addEventListener('click', () => { if (!asked) { asked = true; fill(); } }));
  }

  /* ---- the two top-bar popovers ---- */

  // One handler for both: only one may be open, and a click anywhere else
  // closes whichever is.
  const pops = [['dtUsage', 'dtReports'], ['dashExportBtn', 'dashExportMenu']];
  const closeAll = except => pops.forEach(([bid, mid]) => {
    const m = document.getElementById(mid), b = document.getElementById(bid);
    if (!m || m === except) return;
    m.hidden = true;
    if (b) b.setAttribute('aria-expanded', 'false');
  });

  pops.forEach(([bid, mid]) => {
    const b = document.getElementById(bid), m = document.getElementById(mid);
    if (!b || !m) return;
    b.addEventListener('click', e => {
      e.stopPropagation();
      const open = m.hidden;
      closeAll(open ? m : null);
      m.hidden = !open;
      b.setAttribute('aria-expanded', String(open));
      if (open && mid === 'dtReports') renderReportsMenu(usageCount);
    });
    m.addEventListener('click', e => e.stopPropagation());
  });

  document.addEventListener('click', () => closeAll(null));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAll(null); });

  // Restore the last view. Deliberately not part of the project file: which
  // layout someone was looking at is about them, not about the map, and a
  // project opened by a colleague should not drag them into a mode.
  let saved = null;
  try { saved = localStorage.getItem('dbot.appMode'); } catch (e) { /* ignore */ }
  if (saved && saved !== 'map') setTimeout(() => setAppMode(saved, { silent: true }), 400);
  else document.querySelectorAll('[data-mode-btn="map"]').forEach(b => b.classList.add('on'));
})();
