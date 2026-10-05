/**
 * core/freshness.js — tell people when the page they are looking at is old.
 *
 * WHY THIS EXISTS. Every asset carries ?v=APP_VERSION, so a release busts its
 * own scripts and styles. Nothing busts the HTML that references them. On
 * GitHub Pages the document is served with a Cache-Control this project does
 * not control, and a browser is free to keep serving it — along with the
 * matching, equally stale set of assets it names.
 *
 * The result is a page that looks entirely correct and is simply missing
 * whatever shipped most recently. "The feature isn't there" and "your copy is
 * old" produce identical screenshots, and the difference has twice cost a
 * round of back-and-forth to establish.
 *
 * WHAT IT DOES. Fetches constants.js with a cache-defeating parameter — a URL
 * the browser has never seen and therefore must go to the network for — reads
 * the APP_VERSION out of it, and compares that with the version this page
 * actually loaded. If they differ, the page says so and offers a reload.
 *
 * WHY IT COMPARES SOURCE RATHER THAN A version.json. One fewer file to keep
 * in step. A separate manifest is another thing that can be forgotten at
 * release time, and forgetting it would break exactly the check that exists to
 * catch things being forgotten.
 *
 * Silent on every failure. Offline, blocked, or served something unparseable,
 * this says nothing — a false "you are out of date" is worse than no notice.
 */

/** Long enough that a deploy has landed, short enough to matter within a session. */
const FRESHNESS_RECHECK_MS = 10 * 60 * 1000;

/**
 * @returns {Promise<string|null>} the released APP_VERSION, or null if unknown
 */
async function fetchReleasedVersion() {
  try {
    // The cache-buster must be a value the browser has never requested, so a
    // timestamp rather than the version — asking for ?v=<current> would be
    // answered from the same cache entry that is the problem.
    const res = await fetch('./js/constants.js?cb=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return null;
    const src = await res.text();
    const m = src.match(/APP_VERSION\s*=\s*['"]([\w.]+)['"]/);
    return m ? m[1] : null;
  } catch (e) {
    return null;   // offline, blocked, or not deployed — say nothing
  }
}

/** Draw the notice. Idempotent: repeated checks never stack banners. */
function showStaleNotice(released) {
  if (document.getElementById('freshBar')) return;

  const bar = document.createElement('div');
  bar.id = 'freshBar';
  bar.className = 'fresh-bar';
  bar.setAttribute('role', 'status');
  bar.innerHTML = '<span></span><button type="button">Reload</button>';
  bar.querySelector('span').textContent =
    'This page is version ' + APP_VERSION + '; ' + released + ' has been released. '
    + 'Reload to get the newer one.';
  bar.querySelector('button').addEventListener('click', () => {
    // location.reload(true) is long gone and was never honoured consistently.
    // A URL the browser has not seen is the reliable way to force the document
    // itself — not just its assets — to come from the network.
    const u = new URL(location.href);
    u.searchParams.set('r', Date.now().toString(36));
    location.replace(u.toString());
  });
  document.body.appendChild(bar);
}

/**
 * Compare what is loaded against what is released, and say so if they differ.
 * @returns {Promise<void>}
 */
async function checkFreshness() {
  if (typeof APP_VERSION !== 'string') return;
  const released = await fetchReleasedVersion();
  if (!released || released === APP_VERSION) return;
  console.warn('Map Studio: running ' + APP_VERSION + ', but ' + released + ' is released.');
  showStaleNotice(released);
}

/**
 * Check now, and again when the tab is returned to — someone who left a tab
 * open over a deploy is the exact case this is for.
 */
function initFreshness() {
  let last = 0;
  const run = () => {
    if (Date.now() - last < FRESHNESS_RECHECK_MS) return;
    last = Date.now();
    checkFreshness();
  };
  run();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') run();
  });
}

/**
 * A same-site URL that a browser cannot answer from a stale cache entry.
 *
 * Every asset carries ?v=APP_VERSION and busts on release. The HTML does not:
 * GitHub Pages sets its own Cache-Control on documents, and the CDN in front
 * of it keys on path, so neither a reload nor an invented query parameter
 * reliably refetches the page itself.
 *
 * Stamping the version onto internal navigations closes that. login.html?v=6.0034
 * is a different cache key from login.html?v=6.0033, so the first visit after
 * a release always goes to the network — and every visit after it is served
 * from cache as normal. No cost, no thundering herd, no "hard-refresh and try
 * again" as a support instruction.
 *
 * @param {string} url e.g. 'login.html' or 'projects.html?next=index.html'
 * @returns {string}
 */
function versioned(url) {
  if (typeof APP_VERSION !== 'string') return url;
  const [path, hash] = String(url).split('#');
  const sep = path.includes('?') ? '&' : '?';
  return path + sep + 'v=' + encodeURIComponent(APP_VERSION) + (hash ? '#' + hash : '');
}
