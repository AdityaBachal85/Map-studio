/**
 * ui/reportSheet.js — the A4 connectivity sheet, with the live map in it.
 *
 * This is the thing that leaves the building: a header band, a legend of what
 * the lines and marks mean, the map, then the distances, the highlights and
 * the employment hubs down the right, and the comment and rating across the
 * bottom.
 *
 * THE MAP IN THE MIDDLE IS THE MAP. Not an image of it, not a second copy —
 * the same Leaflet container, in a different grid cell. Which means the sheet
 * is composed by moving the map around it: pan, zoom, drag a label, add a
 * boundary, and the sheet updates because there is nothing to update. See
 * ui/appMode.js for why that mattered enough to build the layout around it.
 *
 * WHAT IS LIVE AND WHAT IS TYPED, and the line between them is deliberate.
 * The distances table is live — it is the routes you drew, through the same
 * rows the Key Distances card uses, so the sheet cannot contradict the map.
 * Everything else on the sheet is prose about a place: what the highlights
 * are, which employers matter, what the location is worth out of ten. None of
 * that is derivable, all of it is judgement, and the app's job is to hold it,
 * not to guess it.
 */

/** Everything on the sheet that is not the map or the distances table. */
let reportSheet = null;

/** @returns {object} a blank sheet */
function reportSheetDefaults() {
  return {
    title: 'CONNECTIVITY MAP',
    subA: 'Project Location: —',
    subB: 'Locality, City',
    lines: [
      { color: '#1E7A4A', label: 'Outer Ring Road' },
      { color: '#7C3AED', label: 'Expressway' },
      { color: '#F59E0B', label: 'Major Roads' },
      { color: '#64748B', label: 'Railway Line' },
    ],
    marks: [
      { iconKey: 'building', color: '#0E7490', label: 'IT / Employment Hubs' },
      { iconKey: 'airport', color: '#0369A1', label: 'Airport' },
      { iconKey: 'train', color: '#1E7A4A', label: 'Railway Station' },
      { iconKey: 'hospital', color: '#B91C1C', label: 'Hospital' },
      { iconKey: 'school', color: '#7C3AED', label: 'Educational Institutions' },
    ],
    highlights: [
      'Type a connectivity highlight here.',
    ],
    hubs: [
      { name: 'Employment hub', meta: '—' },
    ],
    comment: 'Type the location comment that closes the sheet.',
    ratingTitle: 'Overall rating (location perspective)',
    score: '—',
    scoreNote: 'Say what the score is based on.',
  };
}

/** @returns {object} the sheet, created on first use */
function reportSheetData() {
  if (!reportSheet) reportSheet = reportSheetDefaults();
  return reportSheet;
}

/**
 * Redraw only the distances panel.
 *
 * Its own function, and its own element, because it is the one part of the
 * sheet that changes without anybody editing the sheet: routes measure
 * asynchronously, so the table is empty for a second or two after the sheet
 * opens and then fills in. Re-rendering the whole sheet on every route update
 * would be the easy way to catch that and would throw away whatever somebody
 * was typing into a hub or a highlight at the time.
 */
function rsRefreshDistances() {
  const host = document.getElementById('rsDist');
  if (!host) return;
  const rows = (typeof legendRows === 'function') ? legendRows() : [];
  const pending = !rows.length && typeof routes !== 'undefined' && routes && routes.length;
  host.innerHTML =
    '<h3>Key connectivity — approx. distances</h3>'
    + (rows.length
      ? '<table class="rs-rows"><tbody>' + rows.map(r =>
          '<tr><td style="width:22px;line-height:0">'
          + (typeof legendMarkHtml === 'function' ? legendMarkHtml(r) : '') + '</td>'
          + '<td>' + esc(r.name) + '</td>'
          + '<td class="num">' + esc(r.km) + '</td></tr>').join('')
        + '</tbody></table>'
      : '<div class="rs-body" style="font-size:11px;color:#5B6779">'
        + (pending
          ? 'Measuring ' + routes.length + ' route' + (routes.length === 1 ? '' : 's') + '…'
          : 'Draw a route and it appears here. Edit the wording on the Key Distances card over the map.')
        + '</div>');
}

/** @param {string} path @param {*} v @param {string} cls @param {string} [tag] */
function rsField(path, v, cls, tag) {
  const t = tag || 'div';
  const text = String(v == null || v === '' ? '—' : v);
  return '<' + t + ' class="' + cls + '" data-rs="' + path + '" contenteditable="true" spellcheck="false">'
    + esc(text) + '</' + t + '>';
}

/** Redraw every panel of the sheet. */
function renderReportSheet() {
  const d = reportSheetData();

  const head = document.getElementById('rsHead');
  if (head) {
    const set = (id, v) => { const el = document.getElementById(id); if (el && el.textContent !== v) el.textContent = v; };
    set('rsTitle', d.title);
    set('rsSubA', d.subA);
    set('rsSubB', d.subB);
  }

  /* ---- left: what the map's lines and marks mean ---- */
  const leg = document.getElementById('rsLegend');
  if (leg) {
    leg.innerHTML =
      '<div class="rs-panel"><h3>Legend</h3><div class="rs-body">'
      + d.lines.map((l, i) =>
        '<div class="rs-line"><span class="rs-swatch" style="background:' + esc(l.color) + '"></span>'
        + rsField('lines.' + i + '.label', l.label, '', 'span')
        + '<button class="legend-x rs-del" data-rs-del="lines.' + i + '" title="Remove">&times;</button></div>').join('')
      + d.marks.map((m, i) =>
        '<div class="rs-line"><span class="rs-ico">'
        + (typeof iconPaths === 'function'
          ? '<svg viewBox="0 0 24 24" width="14" height="14">' + iconPaths(m.iconKey, m.color) + '</svg>' : '')
        + '</span>'
        + rsField('marks.' + i + '.label', m.label, '', 'span')
        + '<button class="legend-x rs-del" data-rs-del="marks.' + i + '" title="Remove">&times;</button></div>').join('')
      + '<div style="display:flex;gap:6px;margin-top:8px">'
      + '<button class="rs-add" data-rs-add="lines">+ Line</button>'
      + '<button class="rs-add" data-rs-add="marks">+ Mark</button></div>'
      + '</div></div>';
  }

  /* ---- right: the live distances, then the prose ---- */
  const right = document.getElementById('rsRight');
  if (right) {
    right.innerHTML =
      '<div class="rs-panel" id="rsDist"></div>'

      + '<div class="rs-panel"><h3>Connectivity highlights</h3><div class="rs-body">'
      + '<ul class="rs-bullets">' + d.highlights.map((h, i) =>
        '<li>' + rsField('highlights.' + i, h, '', 'span')
        + '<button class="legend-x rs-del" data-rs-del="highlights.' + i + '" title="Remove">&times;</button></li>').join('')
      + '</ul><button class="rs-add" data-rs-add="highlights">+ Highlight</button></div></div>'

      + '<div class="rs-panel"><h3>Employment hubs driving demand</h3>'
      + '<table class="rs-rows"><tbody>' + d.hubs.map((h, i) =>
        '<tr><td>' + rsField('hubs.' + i + '.name', h.name, '', 'span') + '</td>'
        + '<td class="num">' + rsField('hubs.' + i + '.meta', h.meta, '', 'span') + '</td>'
        + '<td style="width:16px"><button class="legend-x rs-del" data-rs-del="hubs.' + i + '" title="Remove">&times;</button></td></tr>').join('')
      + '</tbody></table><div class="rs-body" style="padding-top:0">'
      + '<button class="rs-add" data-rs-add="hubs">+ Hub</button></div></div>';
    rsRefreshDistances();
  }

  /* ---- bottom: the comment and the score ---- */
  const foot = document.getElementById('rsFoot');
  if (foot) {
    foot.innerHTML =
      '<div class="rs-foot-card">'
      + '<div class="rs-foot-badge">'
      + '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#17624a" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z"/></svg>'
      + 'Location<br>comment</div>'
      + rsField('comment', d.comment, 'rs-foot-text') + '</div>'
      + '<div class="rs-rating">'
      + rsField('ratingTitle', d.ratingTitle, '', 'h4')
      + rsField('score', d.score, 'rs-score')
      + rsField('scoreNote', d.scoreNote, 'rs-score-note') + '</div>';
  }
}

/* ---------------------------------------------------------------------------
 * Editing
 * ------------------------------------------------------------------------ */

/** @param {object} root @param {string} path @param {*} value */
function rsSet(root, path, value) {
  const keys = path.split('.');
  let node = root;
  for (let i = 0; i < keys.length - 1; i++) node = node[keys[i]];
  node[keys[keys.length - 1]] = value;
}

/** @param {object} root @param {string} path removes an array entry */
function rsRemove(root, path) {
  const keys = path.split('.');
  const idx = +keys.pop();
  let node = root;
  keys.forEach(k => { node = node[k]; });
  if (Array.isArray(node) && isFinite(idx)) node.splice(idx, 1);
}

(function wireReportSheet() {
  const app = document.getElementById('app');
  if (!app) return;
  const inSheet = e => e.target.closest && e.target.closest('#rsHead, #rsLegend, #rsRight, #rsFoot');

  app.addEventListener('blur', e => {
    if (!inSheet(e)) return;
    const el = e.target.closest('[data-rs], #rsTitle, #rsSubA, #rsSubB');
    if (!el) return;
    const d = reportSheetData();
    const text = el.textContent.trim();
    const val = text === '—' ? '' : text;
    if (el.id === 'rsTitle') d.title = val;
    else if (el.id === 'rsSubA') d.subA = val;
    else if (el.id === 'rsSubB') d.subB = val;
    else rsSet(d, el.dataset.rs, val);
  }, true);

  app.addEventListener('click', e => {
    if (!inSheet(e)) return;
    const d = reportSheetData();

    const del = e.target.closest('[data-rs-del]');
    if (del) { rsRemove(d, del.dataset.rsDel); renderReportSheet(); return; }

    const add = e.target.closest('[data-rs-add]');
    if (add) {
      const k = add.dataset.rsAdd;
      if (k === 'lines') d.lines.push({ color: '#1E7A4A', label: 'New line' });
      if (k === 'marks') d.marks.push({ iconKey: 'pin', color: '#0E7490', label: 'New mark' });
      if (k === 'highlights') d.highlights.push('New highlight');
      if (k === 'hubs') d.hubs.push({ name: 'Hub', meta: '—' });
      renderReportSheet();
    }
  });

  // Enter commits rather than splitting a bullet in two, except in the comment
  // where paragraphs are the point.
  app.addEventListener('keydown', e => {
    if (!inSheet(e)) return;
    const el = e.target.closest('[data-rs], #rsTitle, #rsSubA, #rsSubB');
    if (e.key === 'Enter' && el && el.dataset.rs !== 'comment' && !e.shiftKey) {
      e.preventDefault();
      el.blur();
    }
  });
})();
