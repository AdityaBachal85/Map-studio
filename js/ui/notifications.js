/**
 * ui/notifications.js — the status toast line at the bottom of the map.
 */

let statusTimer = null;
/** Show a status message; auto-clears in 5s unless sticky. @param {string} msg @param {boolean} [sticky] */
function status(msg, sticky) {
  $('statusMsg').textContent = msg || '';
  clearTimeout(statusTimer);
  if (msg && !sticky) statusTimer = setTimeout(() => { $('statusMsg').textContent = ''; }, 5000);
}
