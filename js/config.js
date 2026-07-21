/**
 * config.js — external service endpoints.
 */

/** OSRM routing hosts per travel profile; first host is primary, rest are fallbacks. */
export const ROUTERS = {
  car: ['https://routing.openstreetmap.de/routed-car', 'https://router.project-osrm.org'],
  bike: ['https://routing.openstreetmap.de/routed-bike'],
  foot: ['https://routing.openstreetmap.de/routed-foot']
};
