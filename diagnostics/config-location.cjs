/**
 * Where does the API look for its configuration, on Hostinger's real layouts?
 *
 * The question exists because the answer used to be wrong for a subdomain.
 * The config was looked for "one level above the site's folder", on the
 * assumption that the site's folder was public_html and its parent private.
 * Hostinger serves a subdomain from a folder INSIDE the main domain's
 * public_html, so for map.dbotrealty.tech "one level above" is the web root of
 * dbotrealty.tech — the safest location became a publicly served one exactly
 * when the app moved to a subdomain.
 *
 *   node diagnostics/config-location.cjs
 *
 * Pure path arithmetic, so it runs ms_config_candidates() against invented
 * paths for each layout rather than needing a Hostinger account to test on.
 */
const { execFileSync } = require('child_process');
const path = require('path');

const REPO = path.join(__dirname, '..');

const R = [];
const ck = (n, p, d) => { R.push(p); console.log((p ? 'PASS ' : 'FAIL ') + n + (d ? '  — ' + d : '')); };

/** ms_config_candidates() and ms_account_home() for a pretend api/lib path. */
function where(libDir) {
  const env = Object.assign({}, process.env);
  delete env.MAPSTUDIO_CONFIG;          // the test harness's override must not leak in
  delete env.HOME;                      // as on a web server, where it is often unset
  return JSON.parse(String(execFileSync('php', ['-r', `
    require $argv[1];
    $home = ms_account_home($argv[2]);
    echo json_encode(['home' => $home, 'candidates' => ms_config_candidates($argv[2], $home)]);
  `, path.join(REPO, 'api', 'lib', 'config.php'), libDir], { env, stdio: ['ignore', 'pipe', 'pipe'] })));
}

const inside = p => /\/public_html(\/|$)/.test(path.dirname(p));

/* --- the subdomain: map.dbotrealty.tech ---------------------------------- */

const sub = where('/home/u123456789/domains/dbotrealty.tech/public_html/map/api/lib');
ck('on a subdomain, the account home directory is found',
  sub.home === '/home/u123456789', sub.home);
ck('and is the first place looked',
  sub.candidates[0] === '/home/u123456789/map-studio-config.php', sub.candidates[0]);
ck("and the main domain's public_html is NOT a place a config is looked for",
  !sub.candidates.includes('/home/u123456789/domains/dbotrealty.tech/public_html/map-studio-config.php'),
  sub.candidates.join(' | '));
ck('so every candidate but the .htaccess-guarded fallback is outside any web root',
  sub.candidates.slice(0, -1).every(c => !inside(c)), sub.candidates.join(' | '));
ck('and the fallback is the one beside the API',
  sub.candidates[sub.candidates.length - 1]
    === '/home/u123456789/domains/dbotrealty.tech/public_html/map/api/config.php');

/* --- a site at the root of a domain, current Hostinger layout ------------ */

const main = where('/home/u123456789/domains/dbotrealty.tech/public_html/api/lib');
ck('at a domain root, home comes first too',
  main.candidates[0] === '/home/u123456789/map-studio-config.php', main.candidates[0]);
ck('and the folder beside public_html is still accepted, as the old docs said',
  main.candidates.includes('/home/u123456789/domains/dbotrealty.tech/map-studio-config.php'));

/* --- the older single-site layout ---------------------------------------- */

const old = where('/home/u123456789/public_html/api/lib');
ck('on the older layout, home and "beside public_html" are the same place, listed once',
  old.candidates.filter(c => c === '/home/u123456789/map-studio-config.php').length === 1,
  old.candidates.join(' | '));

/* --- not a /home/ path at all -------------------------------------------- */

const other = where('/var/www/site/api/lib');
ck('elsewhere, it falls back without inventing a home directory',
  other.home === '' && other.candidates[other.candidates.length - 1] === '/var/www/site/api/config.php',
  other.candidates.join(' | '));

console.log('\n' + R.filter(Boolean).length + '/' + R.length + ' passed');
process.exit(R.every(Boolean) ? 0 : 1);
