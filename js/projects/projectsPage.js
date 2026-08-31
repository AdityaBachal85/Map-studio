/**
 * projects/projectsPage.js — drives projects.html.
 *
 * The list is the product's front door, so the things that matter here are
 * that it is honest about where projects live, that destructive actions are
 * recoverable or confirmed, and that it stays usable when the browser refuses
 * storage entirely.
 *
 * Nothing in this file talks to localStorage or IndexedDB directly — it goes
 * through auth/session.js and projects/projectStore.js, which is what lets a
 * real account server replace the local ones later without touching the page.
 */

(async function () {
  'use strict';

  applyTheme();
  initFreshness();
  document.querySelectorAll('.dbotLogo').forEach(i => { i.src = 'data:image/png;base64,' + LOGO_B64; });

  // Must settle before the guard: Supabase may need a network round trip to
  // refresh an expired token, and asking too early would bounce a signed-in
  // person back to the sign-in page.
  await sessionInit();

  const user = requireSession('login.html');
  if (!user) return;   // a redirect is already in flight

  /** Where the studio looks for the project to open. */
  const ACTIVE_KEY = 'dbot.activeProject';

  const $ = id => document.getElementById(id);
  const listWrap = $('pjListWrap');

  let rows = [];
  let sortKey = 'modified';     // 'modified' | 'created' | 'name' | 'bytes'
  let query = '';
  let openMenuFor = null;

  const SORTS = [
    { key: 'modified', label: 'Last modified' },
    { key: 'created', label: 'Date created' },
    { key: 'name', label: 'Name' },
    { key: 'bytes', label: 'Size' },
  ];

  /* -------------------------------------------------------------------------
   * Formatting
   * ---------------------------------------------------------------------- */

  /** @param {number} n @returns {string} */
  function bytes(n) {
    if (!n) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  /**
   * Dates people can act on: recent ones relative, older ones absolute. "3
   * days ago" is what you want for something you touched this week and
   * useless for something from March.
   * @param {number} ts @returns {string}
   */
  function when(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    const mins = Math.round((Date.now() - ts) / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return mins + (mins === 1 ? ' minute ago' : ' minutes ago');
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + (hrs === 1 ? ' hour ago' : ' hours ago');
    const days = Math.round(hrs / 24);
    if (days < 7) return days + (days === 1 ? ' day ago' : ' days ago');
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  /** @param {object} c @returns {string} the subtitle under a project name */
  function summary(c) {
    if (!c) return 'Empty';
    const bits = [];
    if (c.locations) bits.push(c.locations + (c.locations === 1 ? ' location' : ' locations'));
    if (c.sites) bits.push(c.sites + (c.sites === 1 ? ' site' : ' sites'));
    if (c.routes) bits.push(c.routes + (c.routes === 1 ? ' route' : ' routes'));
    if (c.shapes) bits.push(c.shapes + (c.shapes === 1 ? ' shape' : ' shapes'));
    return bits.length ? bits.join(' · ') : 'Empty';
  }

  /** Escape for interpolation into markup. */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* -------------------------------------------------------------------------
   * The name-and-location dialog
   * ---------------------------------------------------------------------- */

  /**
   * Ask for a project's name and where it is.
   *
   * Replaces prompt(), which was a browser strip in the browser's own type with
   * room for exactly one field — which is why a project could be named and not
   * placed. Returns a promise so the callers read the way they did before.
   *
   * @param {object} o title, note, ok label, and the current name and place
   * @returns {Promise<?{name:string, place:string}>} null if cancelled
   */
  function askProject(o) {
    const wrap = $('pjModal');
    const name = $('pjModalName');
    const place = $('pjModalPlace');
    $('pjModalTitle').textContent = o.title;
    $('pjModalNote').textContent = o.note;
    $('pjModalOk').textContent = o.ok;
    name.value = o.name || '';
    place.value = o.place || '';
    wrap.hidden = false;
    name.focus();
    name.select();

    return new Promise(resolve => {
      const done = v => {
        wrap.hidden = true;
        wrap.removeEventListener('click', onBack);
        document.removeEventListener('keydown', onKey);
        $('pjModalOk').removeEventListener('click', onOk);
        $('pjModalCancel').removeEventListener('click', onCancel);
        resolve(v);
      };
      const onOk = () => done({ name: name.value.trim(), place: place.value.trim() });
      const onCancel = () => done(null);
      // Escape closes, Enter commits from either field — the two keys anybody
      // reaches for, and the two the prompt() this replaced already had.
      const onKey = e => {
        if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        else if (e.key === 'Enter' && wrap.contains(document.activeElement)) { e.preventDefault(); onOk(); }
      };
      const onBack = e => { if (e.target === wrap) onCancel(); };
      $('pjModalOk').addEventListener('click', onOk);
      $('pjModalCancel').addEventListener('click', onCancel);
      document.addEventListener('keydown', onKey);
      wrap.addEventListener('click', onBack);
    });
  }

  /* -------------------------------------------------------------------------
   * Rendering
   * ---------------------------------------------------------------------- */

  function visible() {
    const q = query.trim().toLowerCase();
    // Name OR location. Somebody looking for "the Thane one" knows where it is
    // long before they remember what they called it.
    const out = q
      ? rows.filter(r => r.name.toLowerCase().includes(q)
        || String(r.place || '').toLowerCase().includes(q))
      : rows.slice();
    out.sort((a, b) => {
      if (sortKey === 'name') return a.name.localeCompare(b.name);
      if (sortKey === 'bytes') return (b.bytes || 0) - (a.bytes || 0);
      if (sortKey === 'created') return (b.created || 0) - (a.created || 0);
      return (b.modified || 0) - (a.modified || 0);
    });
    return out;
  }

  function render() {
    const list = visible();
    $('pjCount').textContent = rows.length
      ? (list.length === rows.length
        ? rows.length + (rows.length === 1 ? ' project' : ' projects')
        : list.length + ' of ' + rows.length)
      : '';

    if (!list.length) {
      listWrap.innerHTML = rows.length
        ? `<div class="pj-empty"><b>Nothing matches “${esc(query)}”.</b>Try a shorter search, or clear it to see all ${rows.length}.</div>`
        : `<div class="pj-empty"><b>No projects yet.</b>Start one with <b style="display:inline;font-size:inherit">New project</b>, or bring in a map you exported earlier with <b style="display:inline;font-size:inherit">Import a .json project</b>.</div>`;
      return;
    }

    listWrap.innerHTML = `
      <table class="pj-table">
        <thead>
          <tr>
            <th>Name</th>
            <th class="col-owner">Owner</th>
            <th class="col-size num">Size</th>
            <th>Last modified</th>
            <th><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          ${list.map(p => `
            <tr tabindex="0" data-id="${esc(p.id)}" data-open="1">
              <td>
                <div class="pj-name">
                  <span class="ic">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
                      stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                      <polygon points="1 6 8 3 16 6 23 3 23 18 16 21 8 18 1 21 1 6"/><path d="M8 3v15M16 6v15"/>
                    </svg>
                  </span>
                  <span class="tx">
                    <span class="t">${esc(p.name)}</span>
                    <span class="s">${p.place ? `<span class="p"><svg viewBox="0 0 24 24" width="11" height="11"
                        fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"
                        stroke-linejoin="round"><path d="M12 21s7-6 7-11a7 7 0 1 0-14 0c0 5 7 11 7 11z"/>
                        <circle cx="12" cy="10" r="2.4"/></svg>${esc(p.place)}</span><span class="dot">·</span>` : ''
                      }${esc(summary(p.counts))}</span>
                  </span>
                </div>
              </td>
              <td class="col-owner">
                <span class="pj-owner">
                  <span class="av" style="background:${esc(user.color)}">${esc(user.initials)}</span>
                  ${esc(p.ownerName || user.name)}
                </span>
              </td>
              <td class="col-size num">${bytes(p.bytes)}</td>
              <td class="when" title="${esc(new Date(p.modified).toLocaleString())}">${esc(when(p.modified))}</td>
              <td class="pj-rowmenu">
                <button class="pj-menubtn" type="button" data-menu="${esc(p.id)}"
                  aria-label="Actions for ${esc(p.name)}" aria-haspopup="menu">
                  <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor">
                    <circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/>
                  </svg>
                </button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  }

  async function refresh() {
    try {
      rows = await projectsList(user.id);
    } catch (e) {
      // A cloud failure is reported, never papered over with local rows —
      // showing a different store's contents under the same heading is how
      // someone concludes their work has vanished.
      listWrap.innerHTML = `<div class="pj-empty"><b>Your projects could not be loaded.</b>${esc(e.message)}</div>`;
      $('pjCount').textContent = '';
      return;
    }
    render();
    meter();
    markSource();
  }

  /** Say where these rows came from, rather than leaving the toggle decorative. */
  function markSource() {
    const cloud = typeof projectsSource === 'function' && projectsSource() === 'cloud';
    const local = $('pjSrcLocal'), remote = $('pjSrcCloud');
    local.setAttribute('aria-pressed', String(!cloud));
    remote.setAttribute('aria-pressed', String(cloud));
    remote.disabled = !cloud;
    local.disabled = cloud;
    remote.title = cloud
      ? 'Your projects are stored in your account and follow you between devices.'
      : 'Cloud projects need an account. Not signed in to one yet.';
    local.title = cloud
      ? 'Signed in to an account, so projects live there rather than on this device.'
      : 'Projects are stored in this browser only.';
  }

  async function meter() {
    let s;
    try { s = await projectsStorage(user.id); }
    catch (e) { $('pjStorageCap').textContent = 'Unavailable'; return; }

    const cap = $('pjStorageCap');
    const cloud = typeof projectsSource === 'function' && projectsSource() === 'cloud';

    if (!s.count) {
      // bytes() renders 0 as an em dash — right in a table cell, where a dash
      // reads as "nothing to report", and wrong here, where "— used" reads as
      // a value that failed to load.
      $('pjStorageFill').style.width = '0%';
      cap.textContent = cloud ? 'Nothing stored yet' : 'Nothing stored on this device';
      return;
    }

    if (s.quota) {
      const pct = Math.min(100, (s.bytes / s.quota) * 100);
      // A real project rounds to 0% against a multi-gigabyte quota; show the
      // sliver anyway so the bar reads as "working" rather than "broken".
      $('pjStorageFill').style.width = Math.max(pct, 1.5) + '%';
      cap.textContent = `${bytes(s.bytes)} of ${bytes(s.quota)} available`;
      return;
    }

    // Cloud mode has no per-user quota to divide by — Supabase's limit covers
    // the whole database — so the bar would be inventing a denominator.
    $('pjStorageFill').style.width = '8%';
    cap.textContent = bytes(s.bytes) + ' in your account';
  }

  /* -------------------------------------------------------------------------
   * Row actions
   * ---------------------------------------------------------------------- */

  function closeMenu() {
    document.querySelectorAll('.pj-menu').forEach(m => m.remove());
    openMenuFor = null;
  }

  /** @param {HTMLElement} btn @param {string} id */
  function showMenu(btn, id) {
    const wasOpen = openMenuFor === id;
    closeMenu();
    if (wasOpen) return;
    openMenuFor = id;

    const menu = document.createElement('div');
    menu.className = 'pj-menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = `
      <button type="button" role="menuitem" data-act="open">Open</button>
      <button type="button" role="menuitem" data-act="rename">Rename…</button>
      <button type="button" role="menuitem" data-act="duplicate">Make a copy</button>
      <button type="button" role="menuitem" data-act="export">Download .json</button>
      <button type="button" role="menuitem" data-act="delete" class="danger">Delete</button>`;
    btn.parentElement.appendChild(menu);
    menu.querySelector('button').focus();

    menu.addEventListener('click', async e => {
      const act = e.target.closest('button');
      if (!act) return;
      e.stopPropagation();
      closeMenu();
      await runAction(act.dataset.act, id);
    });
  }

  /** @param {string} act @param {string} id */
  async function runAction(act, id) {
    const meta = rows.find(r => r.id === id);
    if (!meta) return;

    if (act === 'open') return openProject(id);

    if (act === 'rename') {
      const got = await askProject({
        title: 'Project details', note: 'Rename it, or say where it is.',
        ok: 'Save', name: meta.name, place: meta.place || '',
      });
      if (!got) return;
      if (!await projectsRename(id, got.name || meta.name, got.place)) {
        alert('Could not save — storage refused the write.');
      }
      return refresh();
    }

    if (act === 'duplicate') {
      if (!await projectsDuplicate(id, user.id)) alert('Could not copy — storage refused the write.');
      return refresh();
    }

    if (act === 'export') {
      const payload = await projectsLoad(id);
      if (!payload) return alert('That project could not be read.');
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = meta.name.replace(/[^\w\s.-]+/g, '').trim().replace(/\s+/g, '-') + '.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      return;
    }

    if (act === 'delete') {
      // Named in the prompt, and the counts repeated, because "Are you sure?"
      // on a list of similar rows is a question you cannot actually answer.
      const ok = confirm(`Delete “${meta.name}”?\n\n${summary(meta.counts)}\n\n`
        + 'This removes it from this browser and cannot be undone. '
        + 'Download a .json copy first if you might want it back.');
      if (!ok) return;
      if (!await projectsDelete(id)) alert('Could not delete — storage refused the write.');
      return refresh();
    }
  }

  /** @param {string} id */
  function openProject(id) {
    localStorage.setItem(ACTIVE_KEY, id);
    location.href = vlink('index.html?project=' + encodeURIComponent(id));
  }

  /* -------------------------------------------------------------------------
   * Wiring
   * ---------------------------------------------------------------------- */

  // Plain <a> links between pages need the same stamp as the scripted
  // navigations: without it, clicking "Open the studio" can land on a cached
  // document from a previous release.
  document.querySelectorAll('a[href$=".html"], a[href^="./"]').forEach(a => {
    const href = a.getAttribute('href');
    if (href && !/^https?:|^\/\//.test(href) && !/[?&]v=/.test(href)) a.setAttribute('href', vlink(href));
  });

  // Which build this is. Same purpose as the studio's version chip: without
  // it, a feature that has not arrived yet is indistinguishable from one that
  // is broken — GitHub Pages caches the HTML itself, and the ?v= on the assets
  // cannot bust the document that references them.
  if ($('pjVer')) $('pjVer').textContent = 'v' + APP_VERSION;

  // Account
  $('pjWhoName').textContent = user.name;
  $('pjWhoEmail').textContent = user.email || '';
  const av = $('pjAvatar');
  av.textContent = user.initials;
  av.style.background = user.color;
  av.title = user.name + ' — account';
  av.setAttribute('aria-label', 'Account menu for ' + user.name);

  // A menu rather than a bare sign-out on click. An unlabelled avatar that
  // logs you out the moment you touch it is both undiscoverable — nobody
  // guesses it — and hostile once discovered, since there is no way to click
  // it and change your mind.
  av.addEventListener('click', e => {
    e.stopPropagation();
    const open = document.getElementById('pjAcctMenu');
    if (open) { open.remove(); return; }

    const menu = document.createElement('div');
    menu.id = 'pjAcctMenu';
    menu.className = 'pj-menu pj-acct-menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = `
      <div class="pj-acct-head">
        <div class="nm"></div>
        <div class="em"></div>
        <div class="src"></div>
      </div>
      <button type="button" role="menuitem" data-act="signout" class="danger">Sign out</button>`;
    // textContent for anything that came from the account — a display name
    // arrives from an identity provider and is not ours to trust as markup.
    menu.querySelector('.nm').textContent = user.name;
    menu.querySelector('.em').textContent = user.email || '';
    menu.querySelector('.src').textContent = (typeof projectsSource === 'function' && projectsSource() === 'cloud')
      ? 'Projects saved to your account'
      : 'Projects saved on this device';

    av.parentElement.appendChild(menu);
    menu.querySelector('button').focus();
    menu.addEventListener('click', async ev => {
      const b = ev.target.closest('button');
      if (!b) return;
      ev.stopPropagation();
      menu.remove();
      if (b.dataset.act === 'signout') {
        await signOut();
        location.replace(vlink('login.html'));
      }
    });
  });

  // Theme
  $('pjTheme').addEventListener('click', () => {
    setPref('theme', effectiveTheme() === 'light' ? 'dark' : 'light');
    applyTheme();
  });

  // New
  $('pjNew').addEventListener('click', async () => {
    const got = await askProject({
      title: 'New project', note: 'Give it a name and say where it is.',
      ok: 'Create project', name: '', place: '',
    });
    if (!got) return;
    const meta = await projectsSave({
      name: got.name || 'Untitled map project',
      place: got.place,
      ownerId: user.id,
      ownerName: user.name,
      // An empty document with the shape applyProject() expects, so the studio
      // opens a blank map rather than tripping over a missing field.
      project: { locations: [], routes: [], geometries: [], brand: {}, uiState: {} },
    });
    if (!meta) return alert('Could not create the project — this browser refused storage. '
      + 'Private/incognito windows often do.');
    openProject(meta.id);
  });

  // Search
  $('pjSearch').addEventListener('input', e => { query = e.target.value; render(); });

  // Sort
  $('pjSort').addEventListener('click', () => {
    const i = SORTS.findIndex(s => s.key === sortKey);
    const next = SORTS[(i + 1) % SORTS.length];
    sortKey = next.key;
    $('pjSortLabel').textContent = next.label;
    render();
  });

  // Import
  $('pjImport').addEventListener('click', () => $('pjImportFile').click());
  $('pjImportFile').addEventListener('change', async e => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';               // so the same file can be picked twice
    if (!file) return;

    // A saved project is the one format this page can finish by itself: it is
    // already the shape the store holds, so it goes straight in without a map
    // ever being drawn. Everything else — KMZ, KML, GPX, GeoJSON, CSV — has to
    // be read against a live map, so it travels to the studio instead.
    if (/\.json$/i.test(file.name)) {
      let project = null;
      try { project = JSON.parse(await file.text()); } catch (ex) { project = null; }
      if (project && typeof project === 'object' && Array.isArray(project.locations)) {
        const meta = await projectsSave({
          name: importHandoffBaseName(file.name),
          ownerId: user.id,
          ownerName: user.name,
          project,
        });
        if (!meta) return alert('Could not save the imported project — storage refused the write.');
        return refresh();
      }
      if (!project) {
        return alert('That file is not valid JSON, so it is neither a Map Studio project nor GeoJSON.');
      }
      // Valid JSON that is not a project: fall through — it may well be GeoJSON,
      // which the studio importer knows how to read.
    }

    const stashed = await importHandoffPut(file);
    if (!stashed.ok) return alert(stashed.error);

    // An empty project to import into. Named after the file, because "Imported
    // project 3" tells nobody which of the three it is.
    const meta = await projectsSave({
      name: importHandoffBaseName(file.name),
      ownerId: user.id,
      ownerName: user.name,
      project: { locations: [], routes: [], geometries: [] },
    });
    if (!meta) return alert('Could not create a project for that file — storage refused the write.');
    openProject(meta.id);
  });

  // One delegated listener for the whole table, so re-rendering never leaves
  // stale handlers behind.
  listWrap.addEventListener('click', e => {
    const menuBtn = e.target.closest('[data-menu]');
    if (menuBtn) { e.stopPropagation(); return showMenu(menuBtn, menuBtn.dataset.menu); }
    const row = e.target.closest('tr[data-open]');
    if (row) openProject(row.dataset.id);
  });

  listWrap.addEventListener('keydown', e => {
    const row = e.target.closest('tr[data-open]');
    if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openProject(row.dataset.id); }
  });

  document.addEventListener('click', closeMenu);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });

  // Sign-out in another tab should not leave this one showing a list.
  onSessionChange(u => { if (!u) location.replace(vlink('login.html')); });

  // Ask the browser to keep this data rather than evicting it under pressure.
  // Best effort — Chrome grants it silently on engaged sites, others decline.
  projectsRequestPersistence();

  // First sign-in on a machine with existing local work: offer it up to the
  // account rather than stranding it. Copies, never moves — see the note on
  // cloudMigrateLocalProjects().
  (async function migrateThenLoad() {
    if (typeof projectsSource === 'function' && projectsSource() === 'cloud'
        && typeof cloudMigrateLocalProjects === 'function') {
      try {
        const r = await cloudMigrateLocalProjects();
        if (r.migrated) {
          alert(`${r.migrated} project${r.migrated === 1 ? '' : 's'} from this device `
            + `${r.migrated === 1 ? 'has' : 'have'} been copied into your account.`
            + (r.failed ? `\n\n${r.failed} could not be copied and are still on this device.` : ''));
        }
      } catch (e) {
        console.warn('Projects: migration failed —', e && e.message);
      }
    }
    await refresh();
  })().catch(() => {
    listWrap.innerHTML = '<div class="pj-empty"><b>Storage is unavailable.</b>'
      + 'This browser refused access to IndexedDB, which is where projects are kept. '
      + 'Private or incognito windows usually block it — try a normal window.</div>';
  });
})();
