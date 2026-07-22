/**
 * export/captureMap.js — shared map rasteriser for PNG and PPTX export.
 */


      /**
       * Rasterise the map + overlays to a canvas via html2canvas.
       * @param {string} [extraClass] Extra CSS class applied to #mapWrap during
       *   capture (e.g. 'pptx-capture' to hide the DOM label chips).
       * @returns {Promise<HTMLCanvasElement>}
       */
      async function captureMap(extraClass) {
        const wrap = $('mapWrap');
        const stage = $('tiltStage');
        const savedTransform = stage.style.transform;
        const wasTilted = wrap.classList.contains('tilted');
        stage.style.transform = '';
        wrap.classList.remove('tilted');            // billboard correction off for the flat pass
        wrap.classList.add('capturing');
        if (extraClass) wrap.classList.add(extraClass);
        try {
          // foreignObjectRendering delegates to the browser's own native rendering for
          // the captured subtree. Without it, html2canvas's own re-implemented CSS engine
          // fails to draw text inside elements positioned via a JS-applied CSS transform
          // (the location/route label chips) -- the chip's background/border render fine,
          // but the name/text inside is silently skipped. This was confirmed by direct
          // testing: switching this on is what makes labels actually appear in exports.
          //
          // BUT: foreignObjectRendering serialises the subtree to an SVG <foreignObject>,
          // and the browser refuses to draw *cross-origin images* (the map tiles) inside an
          // SVG-drawn-to-canvas -- so tiles come out as broken-image placeholders. For the
          // PPTX capture that does not matter and must be avoided: the label chips are
          // hidden (.pptx-capture) and re-added as native PowerPoint objects by the export
          // engine, so this pass only needs the tiles + route lines. Use the standard
          // renderer there so the basemap actually rasterises.
          const pptxPass = extraClass === 'pptx-capture';
          const opts = { useCORS: true, allowTaint: false, scale: 2, logging: false, backgroundColor: '#0d1522' };
          if (pptxPass) {
            return await html2canvas(wrap, opts);
          }
          try {
            return await html2canvas(wrap, { ...opts, foreignObjectRendering: true });
          } catch (foErr) {
            // Rare fallback: some older/locked-down browsers don't support foreignObjectRendering
            // well. Degrade to the standard renderer rather than failing the export outright.
            return await html2canvas(wrap, opts);
          }
        } finally {
          wrap.classList.remove('capturing');
          if (extraClass) wrap.classList.remove(extraClass);
          stage.style.transform = savedTransform;
          if (wasTilted) wrap.classList.add('tilted');
        }
      }

