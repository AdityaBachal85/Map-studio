/**
 * map/markers.js — location lifecycle: create/render pins, labels, distance
 * rings, change propagation, deletion.
 */
import L from 'leaflet';
import { PALETTE } from '../constants.js';
import { brand, bumpId, locations, newId, routes } from '../core/state.js';
import { makeLabelEl, makePinEl, removeBB, scheduleRepaint } from '../map/billboard.js';
import { svgForKey } from '../map/icons.js';
import { map, vectorRenderer } from '../map/mapEngine.js';
import { deleteRoute } from '../map/routes.js';
import { buildLocCard, rebuildLegend, refreshRouteSelects, syncEmpties } from '../ui/propertyPanel.js';
import { textOn } from '../utils/colors.js';

      // ---------- locations ----------
      export function locLabelIconHtml(loc) {
        // Small icon shown inside the label badge itself
        if (loc.iconImage) return `<img src="${loc.iconImage}">`;
        if (loc.iconUseProjectLogo && brand.projectLogo) return `<img src="${brand.projectLogo}">`;
        return svgForKey(loc.iconKey || (loc.type === 'site' ? 'star' : 'pin'), '#FFFFFF');
      }
      export function renderLocPin(loc) {
        const wasFirst = !loc._everRendered;
        if (loc._pinEl) removeBB(loc._pinEl);
        loc._pinEl = makePinEl(loc, wasFirst);
        loc._everRendered = true;
        loc.anchor = L.latLng(loc.lat, loc.lng);
        updateRings(loc);
        scheduleRepaint();
      }
      export function updateRings(loc) {
        (loc.ringLayers || []).forEach(l => map.removeLayer(l));
        (loc._ringLabelEls || []).forEach(removeBB);
        loc.ringLayers = [];
        loc._ringLabelEls = [];
        loc.ringLabels = [];
        (loc.rings || []).forEach(r => {
          const km = parseFloat(r.km);
          if (!km || km <= 0) return;
          const circ = L.circle([loc.lat, loc.lng], { radius: km * 1000, color: r.color, weight: 2, dashArray: '6,8', fillColor: r.color, fillOpacity: r.op, opacity: .9, interactive: false, renderer: vectorRenderer }).addTo(map);
          loc.ringLayers.push(circ);
          const ringEnt = {
            anchor: L.latLng(loc.lat + km / 111.32, loc.lng),
            labelOffset: { x: 0, y: -14 }, labelPinned: true, showLabel: true,
            _leaderColor: r.color
          };
          const wrap = makeLabelEl(ringEnt, 'ring', { klass: 'ring', text: km + ' km' });
          ringEnt._labelEl = wrap;
          ringEnt._el = wrap.firstChild;
          loc._ringLabelEls.push(wrap);
          loc.ringLabels.push({ latlng: [loc.lat + km / 111.32, loc.lng], color: r.color, text: km + ' km', ent: ringEnt, wrap: wrap });
        });
        scheduleRepaint();
      }
      export function updateLocLabel(loc) {
        const wasFirst = !loc._labelEverRendered;
        if (loc._labelEl) { removeBB(loc._labelEl); loc._labelEl = null; loc._el = null; }
        if (loc.showLabel && loc.type !== 'badge' && !loc.hideMarker) {
          const isSite = loc.type === 'site';
          const bg = loc.labelBg || (isSite ? '#0A1E3C' : '#FFFFFF');
          const el = makeLabelEl(loc, 'loc', {
            klass: isSite ? 'site' : '',
            bg: bg, color: textOn(bg), accent: loc.color,
            iconHtml: loc.labelShowIcon === false ? null : locLabelIconHtml(loc),
            iconPlain: !!loc.iconImage || (loc.iconUseProjectLogo && brand.projectLogo),
            text: loc.name
          }, wasFirst);
          loc._labelEl = el;
          loc._labelEverRendered = true;
          loc._el = el.firstChild;
          loc._leaderColor = isSite ? '#FF7A1A' : loc.color;
          loc.onLabelDblclick = () => {
            const v = prompt('Location name:', loc.name);
            if (v !== null) { loc.name = v; loc.card.querySelector('.nm').value = v; locChanged(loc); }
          };
        }
      }
      export function locChanged(loc) {
        renderLocPin(loc); updateLocLabel(loc);
        refreshRouteSelects(); rebuildLegend();
      }
      export function addLocation(opts) {
        opts = opts || {};
        let rings = opts.rings;
        if (!rings && opts.ringKm) {
          const km = parseFloat(opts.ringKm);
          rings = km > 0 ? [{ km: km, color: opts.color || '#2563EB', op: .08 }] : [];
        }
        const loc = {
          id: opts.id || newId(),
          name: opts.name || ('Location ' + (locations.length + 1)),
          lat: opts.lat, lng: opts.lng,
          color: opts.color || (opts.type === 'badge' ? '#F7C948' : (opts.type === 'site' ? '#0A1E3C' : PALETTE[locations.length % PALETTE.length])),
          type: opts.type || 'pin',
          badgeText: opts.badgeText || 'NH 66',
          showLabel: opts.showLabel !== undefined ? opts.showLabel : true,
          labelOffset: opts.labelOffset || { x: 22, y: -40 },
          labelPinned: !!opts.labelPinned,
          labelBg: opts.labelBg || (opts.type === 'site' ? '#0A1E3C' : '#FFFFFF'),
          labelShowIcon: opts.labelShowIcon !== false,
          // Icon customization
          iconKey: opts.iconKey || (opts.type === 'site' ? 'star' : 'pin'),
          iconImage: opts.iconImage || null,
          iconUseProjectLogo: !!opts.iconUseProjectLogo,
          iconSize: opts.iconSize || (opts.type === 'site' ? 44 : 36),
          iconFrame: opts.iconFrame || 'circle',
          iconBg: opts.iconBg || '#FFFFFF',
          iconBorder: opts.iconBorder !== undefined ? opts.iconBorder : 2,
          iconBorderColor: opts.iconBorderColor || (opts.color || (opts.type === 'site' ? '#FF7A1A' : '#FFFFFF')),
          iconShadow: opts.iconShadow !== undefined ? opts.iconShadow : 6,
          iconGlow: !!opts.iconGlow,
          hideMarker: !!opts.hideMarker,
          rings: rings || [], photo: opts.photo || null,
          _pinEl: null, _labelEl: null, _el: null, _ringLabelEls: [], ringLayers: [], ringLabels: [], anchor: null, card: null
        };
        // If it's a Site and the "default site logo" setting is on, opt in by default
        if (loc.type === 'site' && brand.siteUsesProjLogo && !opts.iconImage) loc.iconUseProjectLogo = true;
        bumpId(loc.id);
        locations.push(loc);
        buildLocCard(loc);
        renderLocPin(loc); updateLocLabel(loc);
        refreshRouteSelects(); rebuildLegend(); syncEmpties();
        return loc;
      }
      export function deleteLocation(loc) {
        routes.filter(r => r.fromId === loc.id || r.toId === loc.id).forEach(deleteRoute);
        if (loc._pinEl) removeBB(loc._pinEl);
        if (loc._labelEl) removeBB(loc._labelEl);
        (loc._ringLabelEls || []).forEach(removeBB);
        (loc.ringLayers || []).forEach(l => map.removeLayer(l));
        loc.card.remove();
        locations.splice(locations.indexOf(loc), 1);
        refreshRouteSelects(); rebuildLegend(); syncEmpties();
        scheduleRepaint();
      }
