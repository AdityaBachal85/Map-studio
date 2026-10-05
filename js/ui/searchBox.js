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
//   expanded, typed  -> submit (exactly what Enter does, predictions included)
$('searchIconBtn').addEventListener('click', () => {
  const box = $('searchBox');
  if (box.classList.contains('collapsed')) { expandSearch(); return; }
  if ($('searchInput').value.trim()) submitSearch();
  else collapseSearch();
});

// The box ships collapsed in the HTML (class="search-box collapsed") so the
// compact magnifier is the initial render on every screen with no expanded
// flash; this line is a belt-and-suspenders guarantee if that class is ever
// dropped. Click the magnifier to expand.
$('searchBox').classList.add('collapsed');
