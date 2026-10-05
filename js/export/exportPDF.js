/**
 * export/exportPDF.js — Print / Save-as-PDF via the browser's native print
 * dialog; the print stylesheet (css/layout.css) hides UI chrome.
 */

      function wirePrintExport() {
      $('printBtn').addEventListener('click', () => window.print());
      window.addEventListener('beforeprint', () => $('mapWrap').classList.add('capturing'));
      window.addEventListener('afterprint', () => $('mapWrap').classList.remove('capturing'));
      }

