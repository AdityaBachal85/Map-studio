/**
 * ui/notifications.js — the status toast line at the bottom of the map.
 */

let statusTimer = null;

/**
 * Show a status message.
 *
 * @param {string} msg
 * @param {boolean} [sticky] Leave it up rather than clearing after 5s.
 * @param {{label:string, onClick:function, ms?:number}} [action]
 *   An inline button beside the message — used for "Location deleted · Undo".
 *   Offering the reversal here rather than asking "are you sure?" first is the
 *   deliberate choice: a confirmation interrupts every delete, including the
 *   99% that were meant, and people learn to dismiss it without reading. An
 *   undo costs nothing until it is needed.
 */
function status(msg, sticky, action) {
  const el = $('statusMsg');
  clearTimeout(statusTimer);
  el.textContent = msg || '';

  if (msg && action && typeof action.onClick === 'function') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'status-action';
    btn.textContent = action.label || 'Undo';
    btn.addEventListener('click', () => {
      clearTimeout(statusTimer);
      el.textContent = '';
      action.onClick();
    });
    // A space, so a screen reader reads "deleted Site A. Undo" rather than
    // running the sentence straight into the button's label.
    el.appendChild(document.createTextNode(' '));
    el.appendChild(btn);
    // An action needs longer than a plain message: the user has to notice the
    // thing they did was wrong before they can reach for the way back.
    statusTimer = setTimeout(() => { el.textContent = ''; }, action.ms || 12000);
    return;
  }

  if (msg && !sticky) statusTimer = setTimeout(() => { el.textContent = ''; }, 5000);
}
