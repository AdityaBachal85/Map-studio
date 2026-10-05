/**
 * core/state.js — the application's shared mutable state.
 *
 * `locations` and `routes` are the single source of truth for everything on
 * the map; they are mutated in place (push/splice) by the modules that own
 * those flows. The id counter is private — use newId()/bumpId().
 */
const locations = [];
const routes = [];
let nextId = 1;

/** Find a location by id. @param {number} id @returns {object|undefined} */
const locById = id => locations.find(l => l.id === id);

/**
 * The locations a person put on the map, excluding routing scaffolding.
 *
 * `routeAnchor` locations are the two invisible endpoints the road tool creates
 * to hold a traced road (a route is `{fromId, toId}` and cannot exist without
 * them — see map/roadDraw.js). They are real locations so that routing,
 * serialisation, undo and cascade-delete all keep working unchanged, but they
 * are not *yours* and must never appear in a list, a count or an export.
 *
 * This exists as one helper rather than a `.filter()` repeated at each call
 * site because the failure is silent: a missed one puts two junk rows per road
 * into whatever it feeds, and the worst of those feeds a client's spreadsheet.
 *
 * @returns {object[]}
 */
const realLocations = () => locations.filter(l => !l.routeAnchor);

/** Allocate the next unique object id. @returns {number} */
const newId = () => nextId++;

/** Ensure the id counter stays ahead of an externally supplied id (project load). @param {number} id */
function bumpId(id) { if (id >= nextId) nextId = id + 1; }

/** Brand settings shared across markers, export and the Brand tab. */
const brand = { projectLogo: null, siteUsesProjLogo: false };

/** Cross-module UI mode flags (click-to-add placement). */
const uiState = { addingMode: false };
