/**
 * ui/aiTab.js — AI Reports: pick a Site, generate a multi-section report from
 * the backend's agent pipeline (see server/), and ask follow-up questions
 * against it once it exists.
 *
 * Presented as a floating map panel (#aiBtn / #aiPanel) rather than a sidebar
 * tab. Two reasons: a sixth tab truncated every label in that bar, and a
 * report is about one specific place on the map, which makes a map control the
 * more natural home. It follows #layerBtn / #layerPanel exactly — same stack,
 * same panel chrome, same toggle behaviour.
 *
 * Owns its own trigger wiring rather than reaching into ui/sidebar.js,
 * matching the pattern the rest of the app uses for feature-specific triggers
 * (wirePptxExport(), wireSaveProject() in app.js).
 *
 * A report's id doubles as its job id — createReportJob() returns the same
 * identifier used to poll status and later to ask chat questions about it,
 * since a "job" and the "report" it produces are the same row in the backend.
 */

/** Nearby categories gathered as seed context for the Connectivity/Infrastructure agents. */
// Every category the Nearby service knows. Six of them fed the old prompts;
// the report now also *counts* them for the scorecard's infrastructure
// metric, and a metric computed from a partial list is a wrong number rather
// than a missing one. All twelve are cached and de-duplicated by
// services/placeCache.js, so a repeat report costs nothing.
const AI_REPORT_NEARBY_KEYS = [
  'school', 'college', 'hospital', 'pharmacy', 'transit', 'airport',
  'mall', 'fuel', 'hotel', 'restaurant', 'bank', 'park',
];
const AI_REPORT_RADIUS_M = 5000;
/** How often to poll a running job. */
const AI_POLL_MS = 4000;
/** Give up polling after this long — well past the backend worker's own timeout, so a
 *  stuck job (crashed before it could write its own 'error' status) doesn't poll forever. */
const AI_POLL_TIMEOUT_MS = 9 * 60 * 1000;

let aiCurrentJobId = null;
let aiPollTimer = null;
let aiPollStartedAt = 0;

/** Status → status-line text, matching the pipeline's step names in the design doc. */
const AI_STATUS_TEXT = {
  queued: 'Queued…',
  planning: 'Planning the report…',
  researching: 'Researching your site…',
  analysing: 'Analysing the findings…',
  writing: 'Writing the report…',
  rendering: 'Building the PDF and Word document…',
  storing: 'Saving your documents…',
};

/** Populate the site picker from locations tagged as a Site (loc.type === 'site'). */
function aiRenderSitePicker() {
  const sel = $('aiSitePicker');
  const btn = $('aiGenerateBtn');
  if (!sel || !btn) return;
  const prev = sel.value;
  const sites = locations.filter(l => l.type === 'site');
  sel.innerHTML = sites.length
    ? sites.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('')
    : '<option value="">No sites yet — tag a location as "Site ★" first</option>';
  if (sites.some(l => String(l.id) === prev)) sel.value = prev;
  btn.disabled = !sites.length;
}

/** Refresh the "usage today" line from the backend's self-counted ledger. */
async function aiRefreshUsage() {
  const line = $('aiUsageLine');
  if (!line) return;
  try {
    // The waiting is narrated here rather than left as a blank line, because
    // the free tier's cold start is most of a minute and an idle panel reads
    // as a broken one.
    const u = await getUsage({
      onWaking: secs => { line.textContent = 'Starting the report server… ' + secs + 's'; },
    });
    const g = u.gemini || {};
    const bits = [`${u.reportsGenerated ?? 0} of ${u.reportsCap ?? '?'} reports today`];
    if (g.totalTokens != null) bits.push(`${g.totalTokens.toLocaleString()} tokens used`);
    bits.push('resets at midnight IST');
    line.textContent = bits.join(' · ');
  } catch (e) {
    line.textContent = e.message;
    line.title = e.message;
  }
}

/**
 * Gather nearby-place context around a site, reusing the existing Nearby
 * services (js/services/nearbyPlaces.js) rather than duplicating a Places
 * lookup server-side. One category failing must not block the others.
 * @param {number} lat @param {number} lng @returns {Promise<object>}
 */
async function aiGatherNearbyContext(lat, lng) {
  const out = {};
  const results = await Promise.allSettled(AI_REPORT_NEARBY_KEYS.map(async key => {
    const cat = nearbyCatByKey(key);
    if (!cat) return;
    // 20, not 5: the agents still only quote the closest few, but the
    // scorecard counts what is here, and a list truncated at five makes
    // "5 schools" indistinguishable from "fifty". 20 is Google's own ceiling
    // on one Nearby response.
    const rows = await fetchNearbyCategory(lat, lng, AI_REPORT_RADIUS_M, cat, 20);
    out[key] = (rows || []).map(r => ({ name: r.name, lat: r.lat, lng: r.lng, distance: r.distance }));
  }));
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.warn('Nearby context (' + AI_REPORT_NEARBY_KEYS[i] + ') failed:', r.reason && r.reason.message);
  });
  return out;
}

/**
 * Fetch a finished report and hand it to the browser as a file.
 *
 * WHY NOT JUST FOLLOW THE LINK. A plain navigation to an attachment works, but
 * when it doesn't it fails invisibly: a blocked popup, an expired report, a
 * cold backend still waking up — all of them look identical from the user's
 * chair, which is "I clicked Download and nothing happened".
 *
 * So this fetches first, which turns each of those into a sentence. If the
 * fetch itself cannot run — the backend has no ALLOWED_ORIGIN set, so no CORS
 * header comes back — it falls through to the navigation, which needs no CORS
 * at all. Worse errors, but it downloads, and downloading is the point.
 *
 * @param {string} url @param {string} label
 */
async function aiDownload(url, label) {
  if (!url || url === '#') { status('That download link is missing — try generating the report again.'); return; }
  status('Preparing your ' + label + '…', true);
  try {
    const res = await fetch(url);
    if (!res.ok) {
      // The endpoint distinguishes 410 (existed, expired) from 404, and both
      // carry a written reason. Passing that through beats "failed".
      let msg = 'The report could not be downloaded (HTTP ' + res.status + ').';
      try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (e) { /* not JSON */ }
      status(msg, true);
      return;
    }
    const blob = await res.blob();
    const name = (res.headers.get('content-disposition') || '').match(/filename="?([^"]+)"?/);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name ? name[1] : ('map-studio-report.' + (label === 'PDF' ? 'pdf' : 'docx'));
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    status('Downloaded ' + a.download + '.');
  } catch (e) {
    // Almost always CORS, because the backend is on another origin and
    // ALLOWED_ORIGIN is unset. Navigation is not subject to CORS, so it works.
    console.warn('AI report: fetch download failed, falling back to navigation —', e && e.message);
    status('Downloading your ' + label + '…');
    location.href = url;
  }
}

/** Show the finished report's download links + the (non-recoverable-after) expiry notice. */
function aiShowResults(job) {
  $('aiResults').style.display = '';
  $('aiPdfLink').href = job.pdfUrl || '#';
  $('aiDocxLink').href = job.docxUrl || '#';
  // Logged so a download that misbehaves can be reproduced by opening the URL
  // directly, which separates "the link is wrong" from "the browser refused".
  console.log('AI report ready:', { pdf: job.pdfUrl, docx: job.docxUrl });
  $('aiPdfLink').onclick = e => { e.preventDefault(); aiDownload(job.pdfUrl, 'PDF'); };
  $('aiDocxLink').onclick = e => { e.preventDefault(); aiDownload(job.docxUrl, 'Word document'); };
  const when = job.expiresAt ? new Date(job.expiresAt).toLocaleString() : null;
  $('aiExpiryLine').textContent = (when ? `These links expire ${when}` : 'These links expire in 48 hours')
    + " — download now, they can't be recovered after that.";
  $('aiChatHistory').innerHTML = '';
  $('aiChatField').style.display = '';
}

function aiStopPolling() {
  clearTimeout(aiPollTimer);
  aiPollTimer = null;
}

async function aiPollJob() {
  if (!aiCurrentJobId) return;
  if (Date.now() - aiPollStartedAt > AI_POLL_TIMEOUT_MS) {
    aiStopPolling();
    status('This report is taking much longer than expected — it may have stalled. Try generating it again.', true);
    return;
  }
  try {
    const job = await getReportStatus(aiCurrentJobId);
    if (job.status === 'done') {
      aiStopPolling();
      aiShowResults(job);
      status('Report ready.');
      aiRefreshUsage();
      return;
    }
    if (job.status === 'error') {
      aiStopPolling();
      status(job.error || 'Report generation failed.', true);
      aiRefreshUsage();
      return;
    }
    status(AI_STATUS_TEXT[job.status] || 'Working…', true);
    aiPollTimer = setTimeout(aiPollJob, AI_POLL_MS);
  } catch (e) {
    aiStopPolling();
    status('Lost track of the report — ' + e.message, true);
  }
}

async function aiGenerateReport() {
  const sel = $('aiSitePicker');
  const btn = $('aiGenerateBtn');
  const site = locations.find(l => String(l.id) === sel.value);
  if (!site) { status('Tag a location as "Site ★" first, in the Locations tab.'); return; }

  btn.disabled = true;
  $('aiResults').style.display = 'none';
  $('aiChatField').style.display = 'none';
  aiCurrentJobId = null;
  aiStopPolling();

  try {
    status('Gathering nearby context…', true);
    const nearby = await aiGatherNearbyContext(site.lat, site.lng);

    status(aiBackendIsAwake() ? 'Sending to AI…' : 'Starting the report server…', true);
    const { jobId } = await createReportJob({
      site: { name: site.name, lat: site.lat, lng: site.lng },
      nearby,
    }, {
      onWaking: secs => status('Starting the report server… ' + secs + 's. '
        + 'It sleeps after 15 minutes of no use and takes about a minute to wake.', true),
    });
    aiCurrentJobId = jobId;
    aiPollStartedAt = Date.now();
    aiPollJob();
  } catch (e) {
    // Some of these messages are already whole sentences that explain
    // themselves; prefixing those produced "Could not start the report — The
    // report server did not respond…", which reads like two separate faults.
    status(/^(The|Could not|No |AI reports are)/.test(e.message)
      ? e.message
      : 'Could not start the report — ' + e.message, true);
  } finally {
    btn.disabled = false;
  }
}

function aiAppendChatLine(who, text) {
  const host = $('aiChatHistory');
  const row = document.createElement('div');
  row.className = 'ai-chat-line ai-chat-' + who;
  row.innerHTML = `<b>${who === 'user' ? 'You' : 'AI'}:</b> ${esc(text)}`;
  host.appendChild(row);
  host.scrollTop = host.scrollHeight;
}

async function aiSendChat() {
  const input = $('aiChatInput');
  const sendBtn = $('aiChatSendBtn');
  const msg = input.value.trim();
  if (!msg || !aiCurrentJobId) return;
  input.value = '';
  aiAppendChatLine('user', msg);
  sendBtn.disabled = true;
  try {
    const { reply } = await sendChatMessage(aiCurrentJobId, msg);
    aiAppendChatLine('ai', reply || '(no reply)');
  } catch (e) {
    aiAppendChatLine('ai', 'Could not answer that — ' + e.message);
  } finally {
    sendBtn.disabled = false;
  }
}

/**
 * Open the panel, refreshing what it shows.
 *
 * The site list is rebuilt on every open rather than kept in sync as
 * locations change: the panel is closed most of the time, and a list built at
 * the moment it opens can't drift from the Locations tab.
 */
function openAiPanel() {
  $('aiPanel').hidden = false;
  $('aiBtn').classList.add('toggled');
  aiRenderSitePicker();
  // Doubles as the wake-up call. The server sleeps when idle and takes about a
  // minute to start; spending that minute while a site is being chosen is the
  // difference between a feature that works and one that fails on first press
  // with a message nobody can act on.
  aiRefreshUsage();
}

function closeAiPanel() {
  $('aiPanel').hidden = true;
  $('aiBtn').classList.remove('toggled');
}

function initAiTab() {
  const btn = $('aiBtn');
  if (!btn) return;
  btn.addEventListener('click', () => { $('aiPanel').hidden ? openAiPanel() : closeAiPanel(); });
  $('aiClose').addEventListener('click', closeAiPanel);
  $('aiGenerateBtn').addEventListener('click', aiGenerateReport);
  $('aiChatSendBtn').addEventListener('click', aiSendChat);
  $('aiChatInput').addEventListener('keydown', e => { if (e.key === 'Enter') aiSendChat(); });
  // Esc closes it, matching every other dismissible surface in the app. Left
  // alone while a job runs, so a stray keypress can't hide a report in flight.
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('aiPanel').hidden && !aiCurrentJobId) closeAiPanel();
  });
}
