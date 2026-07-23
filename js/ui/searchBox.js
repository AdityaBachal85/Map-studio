/**
 * ui/searchBox.js — modern search-box chrome: expand/collapse behaviour and
 * the leading magnifier button. Purely presentational — it never touches the
 * search engine (services/geocoder.js still owns doSearch, the input listeners,
 * recents, keyboard nav, spinner). It only shows/hides the box and forwards a
 * submit when appropriate.
 */

/** Expand the box to the full search field and focus the input. */
function expandSearch() {
  $('searchBox').classList.remove('collapsed');
  setTimeout(() => $('searchInput').focus(), 70); // after the width transition starts
}

/** Collapse the box down to the floating round magnifier button. */
function collapseSearch() {
  $('searchBox').classList.add('collapsed');
  $('searchResults').style.display = 'none';
}

// The leading magnifier is the collapse/expand handle and doubles as a submit:
//   collapsed        -> expand + focus
//   expanded, empty  -> collapse (frees the map)
//   expanded, typed  -> run the search (like pressing Enter)
$('searchIconBtn').addEventListener('click', () => {
  const box = $('searchBox');
  if (box.classList.contains('collapsed')) { expandSearch(); return; }
  if ($('searchInput').value.trim()) doSearch(false);
  else collapseSearch();
});

// Start collapsed on every screen — a compact magnifier button that expands on
// click (so the expand/collapse affordance is discoverable, and the map isn't
// covered until the user actually wants to search).
$('searchBox').classList.add('collapsed');
