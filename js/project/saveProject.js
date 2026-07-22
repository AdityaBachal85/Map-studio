/**
 * project/saveProject.js — serialise the current map state to a downloadable
 * .json project file.
 */







      function wireSaveProject() {
      $('saveBtn').addEventListener('click', () => {
        const proj = {
          v: 4.96, title: $('titleCard').textContent, legendTitle: $('legendTitle').textContent,
          view: { c: [map.getCenter().lat, map.getCenter().lng], z: map.getZoom() },
          basemap: activeKey, tilt: tiltDeg, hill: $('hillTgl').checked, chipPct: chipPct,
          hd: $('hdTgl').checked, brand: $('brandTgl').checked, north: $('northTgl').checked,
          projectLogo: brand.projectLogo, siteUsesProjLogo: brand.siteUsesProjLogo,
          locations: locations.map(l => ({
            id: l.id, name: l.name, lat: l.lat, lng: l.lng, color: l.color, type: l.type, badgeText: l.badgeText,
            showLabel: l.showLabel, labelOffset: l.labelOffset, labelPinned: l.labelPinned, labelBg: l.labelBg,
            iconKey: l.iconKey, iconImage: l.iconImage, iconUseProjectLogo: l.iconUseProjectLogo,
            iconSize: l.iconSize, iconFrame: l.iconFrame, iconBg: l.iconBg,
            iconBorder: l.iconBorder, iconBorderColor: l.iconBorderColor, iconShadow: l.iconShadow, iconGlow: l.iconGlow,
            hideMarker: l.hideMarker,
            rings: l.rings
          })),
          routes: routes.map(r => {
            const alt = r.alts && r.alts[r.altIndex];
            return {
              id: r.id, fromId: r.fromId, toId: r.toId, mode: r.mode, color: r.color, weight: r.weight, dash: r.dash, offsetPx: r.offsetPx, labelText: r.labelText, showLabel: r.showLabel, labelOffset: r.labelOffset, labelBg: r.labelBg,
              viaPoints: (r.viaPoints || []).map(v => ({ lat: v.lat, lng: v.lng })),
              saved: alt ? { d: alt.d, t: alt.t, coords: alt.coords, approx: r.approx } : null
            };
          }),
          geometries: geometries.map(geomToGeoJSONFeature)
        };
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([JSON.stringify(proj)], { type: 'application/json' }));
        a.download = 'property-map-project.json';
        a.click();
        URL.revokeObjectURL(a.href);
        status('Project saved — open it later with "Open project".');
      });
      }

