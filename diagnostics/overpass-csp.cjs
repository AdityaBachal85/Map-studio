/**
 * A page whose own security policy blocks Overpass, told apart from a firewall.
 *
 * The VPS copy of the site failed every ring scan with "Could not reach any
 * Overpass server … an office firewall or a DNS filter", while the same
 * browser on the same network scanned fine from the GitHub Pages copy. The
 * request was byte-for-byte the same; the page was not. To fetch(), a
 * Content-Security-Policy refusal and a firewall are the same TypeError — but
 * the browser also tells the document which it was, and the scan now listens.
 *
 * Real Chromium, three pages served with three different policies.
 *
 *   python3 -m http.server 8000 &   (from the repository root)
 *   node diagnostics/overpass-csp.cjs
 */
const { chromium } = require('playwright');

const BASE = 'http://127.0.0.1:8000';
const R = [];
const ck = (n, p, d) => { R.push(p); console.log((p ? 'PASS ' : 'FAIL ') + n + (d ? '  — ' + d : '')); };

const PAGE = '<!doctype html><meta charset="utf-8"><title>csp</title>'
  + '<script src="/js/constants.js"></script><script src="/js/services/ringFeatures.js"></script>';
const OVERPASS_HOSTS = 'https://overpass-api.de https://overpass.openstreetmap.fr'
  + ' https://overpass.private.coffee https://maps.mail.ru';

(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME || undefined });

  /** Load the scan module on a page sent with `csp`, mirrors behaving per `mirrors`. */
  async function scan(csp, mirrors) {
    const p = await b.newPage();
    const hit = [];
    await p.route('**', r => {
      const u = r.request().url();
      if (u === BASE + '/csp-test.html') {
        return r.fulfill({ status: 200, contentType: 'text/html',
          headers: csp ? { 'Content-Security-Policy': csp } : {}, body: PAGE });
      }
      if (/interpreter/.test(u)) { hit.push(u); return mirrors(r); }
      return u.startsWith(BASE) ? r.continue() : r.abort();
    });
    await p.goto(BASE + '/csp-test.html');
    const res = await p.evaluate(async () => {
      const r = await fetchOverpassFeatures(19.10, 72.88, 2000, ['station'], null);
      return { ok: r.ok, reason: r.reason, msg: r.ok ? '' : ringFeatureMessage(r.reason),
        retry: r.ok ? null : ringFeatureRetryable(r.reason) };
    });
    await p.close();
    return Object.assign(res, { hit: hit.length });
  }

  const refuse = r => r.abort('connectionrefused');
  const answer = r => r.fulfill({ status: 200, contentType: 'application/json',
    headers: { 'Access-Control-Allow-Origin': '*' }, body: '{"elements":[]}' });

  // 1. The VPS's case: a policy that allows the page's own origin and nothing else.
  const blocked = await scan("default-src 'self'; connect-src 'self'", answer);
  ck('a page whose own policy blocks Overpass is told so, not sent to its IT department',
    !blocked.ok && blocked.reason === 'csp', blocked.reason);
  ck('and the message says it is the site\'s settings, not the network',
    /security settings/.test(blocked.msg) && /not your network/.test(blocked.msg) && !/firewall/.test(blocked.msg),
    blocked.msg.slice(0, 70));
  ck('the browser refused before any request left — no mirror was ever asked',
    blocked.hit === 0, blocked.hit + ' requests');
  ck('and "try again" is not offered: retrying cannot get past a policy',
    blocked.retry === false);

  // 2. A real firewall: no policy, every connection refused.
  const firewall = await scan(null, refuse);
  ck('with no such policy, refused connections are still reported as the network',
    !firewall.ok && firewall.reason === 'network' && /firewall/.test(firewall.msg), firewall.reason);

  // 3. The fix tools/vps-update.sh applies: the four servers in connect-src.
  const allowed = await scan("default-src 'self'; connect-src 'self' " + OVERPASS_HOSTS, answer);
  ck('once the four servers are in connect-src, the same page scans',
    allowed.ok && allowed.hit >= 1, allowed.ok ? 'answered' : allowed.reason);

  await b.close();
  console.log('\n' + R.filter(Boolean).length + '/' + R.length + ' passed');
  process.exit(R.filter(Boolean).length === R.length ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(1); });
