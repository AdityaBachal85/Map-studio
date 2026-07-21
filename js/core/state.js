/**
 * core/state.js — the application's shared mutable state.
 *
 * `locations` and `routes` are the single source of truth for everything on
 * the map; they are mutated in place (push/splice) by the modules that own
 * those flows. The id counter is private — use newId()/bumpId().
 */
export const locations = [];
export const routes = [];
let nextId = 1;

/** Find a location by id. @param {number} id @returns {object|undefined} */
export const locById = id => locations.find(l => l.id === id);

/** Allocate the next unique object id. @returns {number} */
export const newId = () => nextId++;

/** Ensure the id counter stays ahead of an externally supplied id (project load). @param {number} id */
export function bumpId(id) { if (id >= nextId) nextId = id + 1; }

/** Brand settings shared across markers, export and the Brand tab. */
export const brand = { projectLogo: null, siteUsesProjLogo: false };

/** Cross-module UI mode flags (click-to-add placement). */
export const uiState = { addingMode: false };
