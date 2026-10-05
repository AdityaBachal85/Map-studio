/**
 * services/places.js — infer a display icon/emoji from a Nominatim result's
 * class/type, used by the search results dropdown.
 */

function iconFor(c, t) {
        if (c === 'railway' || t === 'station' || t === 'halt') return '🚉';
        if (c === 'aeroway' || t === 'aerodrome') return '✈️';
        if (t === 'hospital' || t === 'clinic' || t === 'doctors') return '🏥';
        if (t === 'school' || t === 'college' || t === 'university') return '🎓';
        if (c === 'highway') return '🛣️';
        if (t === 'bus_station' || t === 'bus_stop') return '🚌';
        if (c === 'shop' || t === 'mall' || t === 'marketplace') return '🛍️';
        if (c === 'leisure' || c === 'natural' || t === 'park') return '🌳';
        if (c === 'place' || t === 'suburb' || t === 'neighbourhood' || t === 'city' || t === 'town' || t === 'village') return '🏙️';
        if (c === 'building' || t === 'apartments' || t === 'residential') return '🏢';
        return '📍';
      }
