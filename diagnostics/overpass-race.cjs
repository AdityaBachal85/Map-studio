/**
 * Four Overpass mirrors, and which one the scan waits for.
 *
 * The ring scan asked the mirrors one at a time and rightly gave each the full
 * time Overpass is told it may take. So a first mirror that never answered
 * held the scan for twenty-eight seconds before the second was asked anything
 * — "The first OpenStreetMap server did not answer — trying number 2 of 4",
 * half a minute in, which read as the site being slow.
 *
 * Now a second mirror is asked alongside a slow one, the first complete answer
 * wins, and the one that won is asked first next time. Every case here plays
 * pretend servers against each other on a clock scaled down to milliseconds:
 * no network, no browser.
 *
 *   node diagnostics/overpass-race.cjs
 */
const path = require('path');
const REPO = path.join(__dirname, '..');

// The module keeps its mirror memory in localStorage; Node has none.
const store = {};
globalThis.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; },
};
const M = require(path.join(REPO, 'js/services/ringFeatures.js'));

const R = [];
const ck = (n, p, d) => { R.push(p); console.log((p ? 'PASS ' : 'FAIL ') + n + (d ? '  — ' + d : '')); };

/**
 * Pretend mirrors. Each url maps to how it behaves:
 *   { after, status, body }  answer after `after` ms
 *   { hang: true }           never answer
 *   { after, network: true } refuse the connection
 * Records when each was asked and whether it was cancelled.
 */
function servers(table) {
  const t0 = Date.now();
  const asked = {}, cancelled = new Set();
  const fetch = (url, init) => {
    asked[url] = Date.now() - t0;
    const b = table[url] || { hang: true };
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        cancelled.add(url);
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      };
      init.signal.addEventListener('abort', onAbort);
      if (b.hang) return;
      setTimeout(() => {
        init.signal.removeEventListener('abort', onAbort);
        if (b.network) return reject(new TypeError('Failed to fetch'));
        const status = b.status || 200;
        resolve({ status, ok: status >= 200 && status < 300,
          json: async () => b.body || { elements: [] } });
      }, b.after || 0);
    });
  };
  return { fetch, asked, cancelled, t0 };
}

/** The production timings, scaled down: 8 s hedge -> 100 ms. */
const FAST = { gate: () => Promise.resolve(), hedgeMs: 100, attemptMs: 400, minAttemptMs: 0, totalMs: 2000 };

(async () => {
  /* ---- the case that was reported ------------------------------------------ */

  {
    const s = servers({ A: { hang: true }, B: { after: 30, body: { elements: [{ id: 'b' }] } } });
    const steps = [];
    const got = await M.overpassRace('q', Object.assign({}, FAST,
      { mirrors: ['A', 'B', 'C', 'D'], fetch: s.fetch, onStep: st => steps.push(st) }));
    const ms = Date.now() - s.t0;
    ck('a dead first server no longer holds the scan for its whole timeout',
      got.ok && got.host === 'B' && ms < 250, (got.host || 'none') + ' answered, ' + ms + 'ms of a 400ms timeout');
    ck('the second is asked once the hedge passes, not before',
      s.asked.B >= 90 && s.asked.B < 160, 'asked at ' + s.asked.B + 'ms');
    ck('and the dead one is cancelled once the live one answers', s.cancelled.has('A'));
    ck('the third and fourth are never bothered', !('C' in s.asked) && !('D' in s.asked));
    ck('the panel is told the second is asked alongside, not instead',
      steps.length === 2 && steps[1].mirror === 2 && steps[1].live === 2,
      JSON.stringify(steps));
  }

  /* ---- a slow server is still allowed to win ------------------------------- */

  {
    const s = servers({ A: { after: 180, body: { elements: [{ id: 'a' }] } }, B: { after: 300 } });
    const got = await M.overpassRace('q', Object.assign({}, FAST, { mirrors: ['A', 'B'], fetch: s.fetch }));
    ck('a slow live server is not hung up on when the second is asked',
      got.ok && got.host === 'A', (got.host || 'none') + ' won');
    ck('and the second is cancelled once the first answers', s.cancelled.has('B'));
  }

  /* ---- a server that fails at once ----------------------------------------- */

  {
    const s = servers({ A: { after: 10, network: true }, B: { after: 10 } });
    const steps = [];
    const got = await M.overpassRace('q', Object.assign({}, FAST,
      { mirrors: ['A', 'B'], fetch: s.fetch, onStep: st => steps.push(st) }));
    ck('a server that refuses outright hands over at once, without waiting out the hedge',
      got.ok && got.host === 'B' && s.asked.B < 60, 'B asked at ' + s.asked.B + 'ms');
    ck('and the panel is told the first did not answer, not that it is slow',
      steps[1] && steps[1].live === 1, JSON.stringify(steps[1]));
  }

  {
    // Overpass reports its own timeout as a 200 with a remark and whatever it
    // got through. Taken as an answer, it was a confident near-empty scan,
    // cached for a week.
    const s = servers({
      A: { after: 10, body: { elements: [], remark: 'runtime error: Query timed out in "query" at line 3 after 26 seconds.' } },
      B: { after: 20, body: { elements: [{ id: 'b' }] } },
    });
    const got = await M.overpassRace('q', Object.assign({}, FAST, { mirrors: ['A', 'B'], fetch: s.fetch }));
    ck('a 200 that says the query timed out is not taken as the answer',
      got.ok && got.host === 'B' && got.json.elements.length === 1, (got.host || 'none') + ' won');
  }

  {
    const s = servers({ A: { after: 10, status: 400 }, B: { after: 10 } });
    const got = await M.overpassRace('q', Object.assign({}, FAST, { mirrors: ['A', 'B'], fetch: s.fetch }));
    ck('a 400 stops the race: the query is just as wrong at every mirror',
      !got.ok && got.reasons.indexOf('http-400') >= 0 && !('B' in s.asked),
      JSON.stringify(got.reasons));
  }

  /* ---- when nothing answers ------------------------------------------------ */

  {
    const s = servers({
      A: { after: 10, status: 504 }, B: { after: 10, network: true },
      C: { after: 10, status: 429 }, D: { hang: true },
    });
    const got = await M.overpassRace('q', Object.assign({}, FAST,
      { mirrors: ['A', 'B', 'C', 'D'], fetch: s.fetch, attemptMs: 150 }));
    const ms = Date.now() - s.t0;
    ck('when every mirror fails, every mirror was asked', Object.keys(s.asked).length === 4);
    ck('and the most useful reason is the one reported',
      !got.ok && M.overpassWorstReason(got.reasons) === 'http-429', JSON.stringify(got.reasons));
    ck('without waiting longer than the slowest one was allowed', ms < 260, ms + 'ms');
  }

  {
    const s = servers({ A: { hang: true }, B: { hang: true }, C: { hang: true }, D: { hang: true } });
    const got = await M.overpassRace('q', Object.assign({}, FAST,
      { mirrors: ['A', 'B', 'C', 'D'], fetch: s.fetch, attemptMs: 10000, totalMs: 300 }));
    const ms = Date.now() - s.t0;
    ck('the whole race is bounded, whatever each mirror is allowed',
      !got.ok && got.reasons.indexOf('timeout') >= 0 && ms < 360, ms + 'ms of a 300ms total');
    ck('and nothing it asked is left running behind it',
      Object.keys(s.asked).length >= 3 && Object.keys(s.asked).every(h => s.cancelled.has(h)),
      Object.keys(s.asked).length + ' asked, ' + s.cancelled.size + ' cancelled');
  }

  /* ---- the next scan asks the server that answered ------------------------- */

  {
    const [m0, m1, m2, m3] = M.OVERPASS_MIRRORS;
    ck('with nothing known, the mirrors are asked in their listed order',
      M.overpassMirrorOrder().join() === M.OVERPASS_MIRRORS.join());

    const s = servers({ [m0]: { hang: true }, [m1]: { after: 20 } });
    await M.overpassRace('q', Object.assign({}, FAST, { mirrors: M.OVERPASS_MIRRORS, fetch: s.fetch }));
    const order = M.overpassMirrorOrder();
    ck('the mirror that answered is asked first next time', order[0] === m1, order.map(short).join(' > '));
    // Cancelled is not stopped: that server is still running our query and
    // holding the slot, so asking it straight away would queue behind our own.
    ck('and the one left running our cancelled query is asked last', order[3] === m0,
      order.map(short).join(' > '));

    // Two that have answered: the faster leads.
    store[M.OVERPASS_MIRROR_KEY] = JSON.stringify({
      [m2]: { ok: Date.now() - 1000, ms: 900 }, [m3]: { ok: Date.now() - 1000, ms: 300 },
    });
    const o2 = M.overpassMirrorOrder(Date.now() + 26000);   // after m0's ghost has cleared
    ck('between two that answered, the faster is asked first',
      o2[0] === m3 && o2[1] === m2, o2.map(short).join(' > '));

    // One that failed lately goes behind the ones that did not.
    store[M.OVERPASS_MIRROR_KEY] = JSON.stringify({ [m0]: { fail: Date.now() - 60e3 } });
    const o3 = M.overpassMirrorOrder(Date.now() + 26000);
    ck('a mirror that failed in the last half hour is asked after the others',
      o3[o3.length - 1] === m0, o3.map(short).join(' > '));
    const o4 = M.overpassMirrorOrder(Date.now() + M.OVERPASS_DEMOTE_MS + 26000);
    ck('and gets its place back once that has passed', o4[0] === m0, o4.map(short).join(' > '));
    delete store[M.OVERPASS_MIRROR_KEY];
  }

  /* ---- the production numbers ---------------------------------------------- */

  ck('a second server is asked well before a dead one would be given up on',
    M.OVERPASS_HEDGE_MS < M.OVERPASS_TIMEOUT_S * 1000 / 2,
    (M.OVERPASS_HEDGE_MS / 1000) + 's, against ' + M.OVERPASS_TIMEOUT_S + 's');
  ck('but not so soon that a healthy one is doubled up on for an ordinary ring',
    M.OVERPASS_HEDGE_MS >= 5000, (M.OVERPASS_HEDGE_MS / 1000) + 's');
  ck('every mirror can be asked and given a full attempt inside the total',
    (M.OVERPASS_MIRRORS.length - 1) * M.OVERPASS_HEDGE_MS + M.OVERPASS_FETCH_MS <= M.OVERPASS_TOTAL_MS,
    ((M.OVERPASS_MIRRORS.length - 1) * M.OVERPASS_HEDGE_MS + M.OVERPASS_FETCH_MS) / 1000
      + 's of ' + M.OVERPASS_TOTAL_MS / 1000 + 's');

  /* ---- the ring scan itself, through the real fetch ------------------------ */

  {
    // Real gate, real hedge: the first mirror answers with Overpass's own
    // timeout remark, the next with an empty but complete answer.
    let calls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      calls++;
      const body = calls === 1
        ? { elements: [], remark: 'runtime error: Query timed out in "query" at line 3 after 26 seconds.' }
        : { elements: [] };
      return { status: 200, ok: true, json: async () => body };
    };
    const t0 = Date.now();
    const a = await M.fetchOverpassFeatures(19.10, 72.88, 2000, ['rail'], null);
    const cache = JSON.parse(store['dbot.overpassCache.v2'] || '{}');
    ck('a scan whose first mirror timed out on its side takes the next mirror\'s answer',
      a.ok && calls === 2 && Date.now() - t0 < 4000, calls + ' requests, ' + (Date.now() - t0) + 'ms');
    ck('and caches that answer, which is a real one', Object.keys(cache).length === 1);

    calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return { status: 200, ok: true, json: async () => ({ elements: [], remark: 'runtime error: Query run out of memory' }) };
    };
    const b = await M.fetchOverpassFeatures(19.20, 72.90, 2000, ['rail'], null);
    const cache2 = JSON.parse(store['dbot.overpassCache.v2'] || '{}');
    ck('a scan every mirror gave up on is reported as a timeout, not as "nothing here"',
      !b.ok && b.reason === 'timeout', JSON.stringify(b));
    ck('and is not cached as if it were an answer', Object.keys(cache2).length === 1);
    globalThis.fetch = realFetch;
  }

  /* ---- through the site's own server, where it relays ---------------------- */

  {
    // A browser behind a firewall that blocks every mirror — the scan that
    // came back "Could not reach any Overpass server (tried 4)" in under a
    // second — on a site that relays. A fresh copy of the module, because
    // whether the site relays is asked once per page and remembered.
    const file = path.join(REPO, 'js/services/ringFeatures.js');
    const fresh = () => { delete require.cache[require.resolve(file)]; return require(file); };
    const realFetch = globalThis.fetch;
    delete store[M.OVERPASS_MIRROR_KEY];
    globalThis.location = { protocol: 'https:' };
    const asked = [];
    globalThis.fetch = async (url) => {
      asked.push(url);
      if (url === '/osm/overpass/ping') return { ok: true, status: 200, text: async () => 'map-studio-overpass\n' };
      if (/^https:/.test(url)) throw new TypeError('Failed to fetch');
      return { ok: true, status: 200, json: async () => ({ elements: [] }) };
    };
    const A = fresh();
    const list = await A.overpassMirrorList();
    // Direct first: where the browser can reach the mirrors — as it could
    // from the GitHub Pages copy all along — that is the fast path, and each
    // person's queries count against their own address, not the server's.
    ck('a site that relays lists the mirrors direct first, then its own routes',
      list.length === 8 && list[0] === A.OVERPASS_MIRRORS[0] && list[4] === '/osm/overpass/de',
      short(list[0]) + ' … ' + list.slice(4, 6).join(' '));
    const t0 = Date.now();
    const got = await A.overpassRace('q', { gate: () => Promise.resolve() });
    ck('so a browser that cannot reach any mirror still gets its answer, through the site',
      got.ok && got.host === '/osm/overpass/de', got.host || JSON.stringify(got.reasons));
    ck('and the blocked mirrors in front of it cost no wait: they fail at once and hand over',
      asked.filter(u => /^https:/.test(u)).length === 4 && Date.now() - t0 < 300,
      asked.filter(u => /^https:/.test(u)).length + ' refused, ' + (Date.now() - t0) + 'ms');
    await A.overpassRace('q', { gate: () => Promise.resolve() });
    ck('and the site is asked whether it relays once per page, not once per scan',
      asked.filter(u => /ping$/.test(u)).length === 1);
    ck('with the relay on, a failure does not tell anyone to switch it on',
      !/relaying scans/.test(A.ringFeatureMessage('network')));

    // A site without the relay: nginx's 404, or an HTML page served for any
    // path. Neither may be taken for it.
    for (const [what, reply] of [
      ['a 404', { ok: false, status: 404, text: async () => '<html>404</html>' }],
      ['an HTML page for any path', { ok: true, status: 200, text: async () => '<!doctype html><title>Map Studio</title>' }],
    ]) {
      globalThis.fetch = async (url) => (url === '/osm/overpass/ping' ? reply
        : { ok: true, status: 200, json: async () => ({ elements: [] }) });
      const B = fresh();
      const l = await B.overpassMirrorList();
      ck('a site answering the ping with ' + what + ' is not taken for a relay',
        l.join() === B.OVERPASS_MIRRORS.join(), l.length + ' routes');
      if (what === 'a 404') {
        ck('and there, the firewall message says the relay would fix it for everyone',
          /relaying scans/.test(B.ringFeatureMessage('network')));
      }
    }
    globalThis.fetch = realFetch;
    delete globalThis.location;
    delete store[M.OVERPASS_MIRROR_KEY];
  }

  /* ---- the site's own server: public first, then this ---------------------- */

  {
    // The owner's order: the public servers first, the site's own after. And
    // never for a place it has no data for — its empty answer would be read as
    // "nothing is mapped here".
    const poly = M.parseOsmPoly('india\n1\n  68.0 6.5\n  97.5 6.5\n  97.5 35.7\n  68.0 35.7\nEND\n'
      + '!hole\n  80.0 20.0\n  81.0 20.0\n  81.0 21.0\n  80.0 21.0\nEND\nEND\n');
    ck('a Geofabrik .poly outline is read, holes and all',
      poly.outers.length === 1 && poly.holes.length === 1 && poly.outers[0][0][0] === 6.5,
      poly.outers.length + ' outer, ' + poly.holes.length + ' hole');
    ck('Mumbai is inside it, Dubai is not, and a hole is not',
      M.polyCovers([19.07, 72.88], poly) && !M.polyCovers([25.2, 55.27], poly)
      && !M.polyCovers([20.5, 80.5], poly));

    const file = path.join(REPO, 'js/services/ringFeatures.js');
    const fresh = () => { delete require.cache[require.resolve(file)]; return require(file); };
    const realFetch = globalThis.fetch;
    delete store[M.OVERPASS_MIRROR_KEY];
    globalThis.location = { protocol: 'https:' };
    const POLY = 'india\n1\n  68.0 6.5\n  97.5 6.5\n  97.5 35.7\n  68.0 35.7\nEND\nEND\n';
    const asked = [];
    let ping = 'map-studio-overpass\nlocal\n';
    globalThis.fetch = async (url, init) => {
      asked.push({ url, at: Date.now() });
      if (url === '/osm/overpass/ping') return { ok: true, status: 200, text: async () => ping };
      if (url === '/osm/overpass/coverage') return { ok: true, status: 200, text: async () => POLY };
      if (url === '/osm/overpass/local') {
        return { ok: true, status: 200, json: async () => ({ elements: [{ id: 'own' }] }) };
      }
      // Every public route hangs, as overpass-api.de did all October.
      return new Promise((resolve, reject) => init.signal.addEventListener('abort', () =>
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    };
    const L = fresh();
    const mumbai = await L.overpassRoutes([19.07, 72.88]);
    ck('in India, the own server is asked second — right after the best public server',
      mumbai[0] === L.OVERPASS_MIRRORS[0] && mumbai[1] === L.OVERPASS_LOCAL_ROUTE,
      short(mumbai[0]) + ', then ' + mumbai[1]);
    const dubai = await L.overpassRoutes([25.2, 55.27]);
    ck('outside its outline it is not asked at all', dubai.indexOf(L.OVERPASS_LOCAL_ROUTE) < 0);
    ck('nor for a request that does not say where it is',
      (await L.overpassRoutes()).indexOf(L.OVERPASS_LOCAL_ROUTE) < 0);

    asked.length = 0;
    const t0 = Date.now();
    const got = await L.overpassRace('q', { at: [19.07, 72.88], gate: () => Promise.resolve(), hedgeMs: 120 });
    const firstPublic = asked.find(a => /^https:/.test(a.url));
    const own = asked.find(a => a.url === L.OVERPASS_LOCAL_ROUTE);
    ck('with the public servers silent, the own server answers the scan',
      got.ok && got.own === true && got.json.elements[0].id === 'own', got.host);
    ck('but only after the public server has had its head start',
      firstPublic && own && own.at - firstPublic.at >= 100,
      own && firstPublic ? (own.at - firstPublic.at) + 'ms after ' + short(firstPublic.url) : 'not asked');
    ck('and the public server it was waiting on is cancelled once it has',
      Date.now() - t0 < 1000, (Date.now() - t0) + 'ms in all');
    const after = await L.overpassRoutes([19.07, 72.88]);
    ck('winning does not move it to the front: next time the public server is still asked first',
      after[0] !== L.OVERPASS_LOCAL_ROUTE && after[1] === L.OVERPASS_LOCAL_ROUTE, after.slice(0, 2).map(short).join(', '));

    ping = 'map-studio-overpass\n';
    const N = fresh();
    ck('a site whose relay names no own server never asks one',
      (await N.overpassRoutes([19.07, 72.88])).indexOf(N.OVERPASS_LOCAL_ROUTE) < 0);
    globalThis.fetch = realFetch;
    delete globalThis.location;
    delete store[M.OVERPASS_MIRROR_KEY];
  }

  console.log('\n' + R.filter(Boolean).length + '/' + R.length + ' passed');
  process.exit(R.filter(Boolean).length === R.length ? 0 : 1);
})();

function short(u) { return u.replace(/^https:\/\//, '').split('/')[0]; }
