/**
 * app.js — application entry point.
 *
 * Every feature now lives in its own module (core/ map/ ui/ services/
 * project/ export/); this file only assembles them: sets the brand logo,
 * wires the billboard overlay to the map, wires every button/handler that
 * owns no other natural home, and prints the initial status message.
 */
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import html2canvas from 'html2canvas';
import { exportDeck } from './export/exportPPT.js';
import { LOGO_B64 } from './constants.js';
import { initBillboard } from './map/billboard.js';
import { syncEmpties, initLegendDrag } from './ui/propertyPanel.js';
import { status } from './ui/notifications.js';
import { wirePngExport } from './export/exportPNG.js';
import { wirePrintExport } from './export/exportPDF.js';
import { wirePptxExport } from './export/pptxHandler.js';
import { wireSaveProject } from './project/saveProject.js';
import { wireOpenProject } from './project/openProject.js';
// ui/toolbar.js and ui/sidebar.js wire their own buttons/tabs as a
// side-effect of being imported (all their listeners are plain top-level
// statements, matching the pattern map/mapEngine.js and map/routes.js use
// for the controls they each own).
import './ui/toolbar.js';
import './ui/sidebar.js';

// Exposed for the browser smoke test, console debugging, and the app's own
// PPTX button handler (export/pptxHandler.js) via this same reference.
window.DBOTExport = { exportDeck };

// ---------- DBOT brand asset ----------
document.querySelectorAll('.dbotLogo').forEach(i => { i.src = 'data:image/png;base64,' + LOGO_B64; });

// Wire the billboard overlay to the map (see map/billboard.js).
initBillboard();

// export/* and project/* each export a wire*() function instead of wiring at
// module-load time, so every DOM listener they own is visible from one place.
initLegendDrag();
wirePngExport();
wirePrintExport();
wirePptxExport();
wireSaveProject();
wireOpenProject();

syncEmpties();
status('Start blank: type in the search bar for live suggestions, paste "lat, lng" directly, or use Click-to-add.');
