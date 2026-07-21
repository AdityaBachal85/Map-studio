/**
 * export/exportPNG.js — PNG export: capture the map, apply the 3D
 * perspective warp if tilted, and download.
 */
import { warpPerspective, tiltDeg } from '../map/mapEngine.js';
import { status } from '../ui/notifications.js';
import { $ } from '../utils/dom.js';
import { captureMap } from './captureMap.js';

      export function wirePngExport() {
      $('pngBtn').addEventListener('click', async () => {
        status('Rendering PNG… (a few seconds)', true);
        try {
          let canvas = await captureMap();
          if (tiltDeg > 0) canvas = warpPerspective(canvas, tiltDeg);
          canvas.toBlob(blob => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'property-access-map.png';
            a.click();
            URL.revokeObjectURL(a.href);
            status(tiltDeg > 0 ? 'PNG downloaded with the 3D perspective applied.' : 'PNG downloaded.');
          });
        } catch (e) {
          status('PNG export failed on this basemap/browser — use Print / Save as PDF or a screenshot instead.');
        }
      });
      }

