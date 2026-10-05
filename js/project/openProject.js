/**
 * project/openProject.js — restore a previously saved .json project: view,
 * basemap, tilt, chip scale, brand, and every location/route.
 */










/* Reading and routing files by format used to live here, one hand-written
   FileReader per extension. It moved to project/importFiles.js when KMZ, GPX
   and CSV joined the list — the projects page needs the same routing, and two
   copies of "which format is this" would drift the moment one gained a format
   the other did not. */

/* `clearAll` used to be defined here *and* again inside `wireOpenProject`, and
   the inner one — the one the Open handler actually saw — had no
   `clearAllGeometries`. Loading a project therefore left the previous drawing on
   the map and accumulated shapes. Both are gone; `clearProject()` in
   project/projectState.js is the single definition. */

function wireOpenProject() {
  const input = $('loadInput');
  // Set from IMPORT_EXTENSIONS rather than typed into the markup, so adding a
  // format is one edit and the picker can never disagree with the dispatcher.
  if (typeof IMPORT_ACCEPT === 'string') input.setAttribute('accept', IMPORT_ACCEPT);

  $('loadBtn').addEventListener('click', () => input.click());
  input.addEventListener('change', e => {
    const f = e.target.files[0];
    e.target.value = '';               // so the same file can be picked twice
    if (f) importMapFileAndReport(f);
  });

  // Dragging a file onto the map is what people try first with Google Earth
  // files, and it did nothing — the browser navigated away from the app to
  // display the raw XML, losing unsaved work in the process.
  wireMapFileDrop();
}

/**
 * Accept a file dropped anywhere on the map.
 *
 * `dragover` must be cancelled on both the enter and over events or the browser
 * keeps its own handler, which replaces the page with the file. Only files are
 * accepted — dragging selected text or an image out of another tab also fires
 * these events, and should go on doing nothing.
 */
function wireMapFileDrop() {
  const host = document.getElementById('mapWrap') || document.body;
  const carriesFile = e => Array.from((e.dataTransfer && e.dataTransfer.types) || []).indexOf('Files') !== -1;

  ['dragenter', 'dragover'].forEach(type => {
    host.addEventListener(type, e => {
      if (!carriesFile(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      host.classList.add('file-over');
    });
  });

  ['dragleave', 'dragend'].forEach(type => {
    host.addEventListener(type, e => {
      // Moving between children fires dragleave on the parent; only a pointer
      // that has actually left the element should clear the highlight.
      if (type === 'dragleave' && e.relatedTarget && host.contains(e.relatedTarget)) return;
      host.classList.remove('file-over');
    });
  });

  host.addEventListener('drop', e => {
    if (!carriesFile(e)) return;
    e.preventDefault();
    host.classList.remove('file-over');
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) importMapFileAndReport(f);
  });
}

