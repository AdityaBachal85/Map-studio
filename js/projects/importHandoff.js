/**
 * projects/importHandoff.js — carry a dropped file from the projects page into
 * the studio that can read it.
 *
 * The Import button lives on the projects page, but every importer needs a map:
 * KML places become locations on it, shapes are registered against it, and the
 * view is fitted to what arrived. The projects page has no map, so it cannot do
 * the work — and a File object does not survive a page navigation, so it cannot
 * simply hand the file over either.
 *
 * So the bytes go through sessionStorage, base64-encoded, and the studio picks
 * them up once the new project has opened. sessionStorage rather than
 * localStorage because this is one hop between two pages of one tab: a stale
 * entry left by a crashed navigation dies with the tab instead of importing
 * itself into some unrelated project a week later.
 *
 * THE SIZE LIMIT IS REAL AND IS CHECKED. sessionStorage is a few megabytes per
 * origin, stores UTF-16, and base64 already costs a third on top — so a big
 * file must be refused *before* the project is created, with a sentence saying
 * where to import it instead. Silently creating an empty project and losing the
 * file is the failure mode this guard exists to prevent.
 */

const IMPORT_HANDOFF_KEY = 'dbot.pendingImport.v1';

/**
 * The largest file worth pushing through sessionStorage.
 *
 * 2 MB of bytes is ~2.7 MB of base64, which is ~5.3 MB as UTF-16 — already at
 * the edge of a typical quota with the session and autosave sharing it. Google
 * Earth's own exports are usually tens to hundreds of kilobytes; anything past
 * this is a survey dataset, and those belong in the studio's own Open button
 * where no copy through storage is needed.
 */
const IMPORT_HANDOFF_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Base64 without blowing the stack.
 *
 * `String.fromCharCode.apply(null, hugeArray)` throws on arguments beyond a few
 * tens of thousands of elements — the limit is the argument count, so it fails
 * on exactly the medium-sized files this is for while working fine in testing
 * with small ones.
 *
 * @param {ArrayBuffer} buf @returns {string}
 */
function importHandoffEncode(buf) {
  const bytes = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(out);
}

/** @param {string} b64 @returns {Uint8Array} */
function importHandoffDecode(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Stash a file for the studio to import once it has opened.
 *
 * @param {File} file
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function importHandoffPut(file) {
  if (!file) return { ok: false, error: 'No file was chosen.' };
  if (file.size > IMPORT_HANDOFF_MAX_BYTES) {
    return {
      ok: false,
      error: 'That file is ' + Math.round(file.size / 1048576) + ' MB, too large to carry between pages. '
        + 'Open any project first, then use “Open project or import…” in the Project tab — that path has no size limit.',
    };
  }

  let buf;
  try {
    buf = await file.arrayBuffer();
  } catch (e) {
    return { ok: false, error: 'That file could not be read.' };
  }

  try {
    sessionStorage.setItem(IMPORT_HANDOFF_KEY, JSON.stringify({
      name: file.name,
      type: file.type || '',
      b64: importHandoffEncode(buf),
      at: Date.now(),
    }));
  } catch (e) {
    // Quota, or private mode with storage disabled.
    return { ok: false, error: 'There was not enough browser storage to carry that file across. Try importing it from inside a project instead.' };
  }
  return { ok: true };
}

/**
 * Collect a stashed file, if there is one, and clear it.
 *
 * Cleared before the import runs rather than after, deliberately: a file that
 * makes the importer throw would otherwise be retried on every load of that
 * project, and the page would break the same way every time with no way out.
 *
 * @returns {File|null}
 */
function importHandoffTake() {
  let raw;
  try {
    raw = sessionStorage.getItem(IMPORT_HANDOFF_KEY);
    if (raw) sessionStorage.removeItem(IMPORT_HANDOFF_KEY);
  } catch (e) {
    return null;
  }
  if (!raw) return null;

  try {
    const rec = JSON.parse(raw);
    if (!rec || !rec.b64 || !rec.name) return null;
    return new File([importHandoffDecode(rec.b64)], rec.name, { type: rec.type || 'application/octet-stream' });
  } catch (e) {
    return null;
  }
}

/** @param {string} name @returns {string} the file name with its extension removed */
function importHandoffBaseName(name) {
  return String(name || '').replace(/\.[a-z0-9]+$/i, '').trim() || 'Imported map';
}
