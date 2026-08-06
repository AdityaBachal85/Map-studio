/**
 * config.js — external service endpoints.
 */

/** OSRM routing hosts per travel profile; first host is primary, rest are fallbacks. */
const ROUTERS = {
  car: ['https://routing.openstreetmap.de/routed-car', 'https://router.project-osrm.org'],
  bike: ['https://routing.openstreetmap.de/routed-bike'],
  foot: ['https://routing.openstreetmap.de/routed-foot']
};

/**
 * Geoapify API key for search (services/geoapify.js) and nearby-places
 * discovery (services/nearbyPlaces.js). This app has no backend, so this key
 * is visible to anyone who views the deployed page's source -- restrict it to
 * this site's domain in Geoapify's dashboard ("referrer restrictions") if it
 * hasn't been already. Leave empty to disable Geoapify and use only the
 * existing free fallbacks (Nominatim search, no nearby-places).
 */
const GEOAPIFY_API_KEY = '72551776e5ff41cca6cec522fa9062cd';

/**
 * Basemap provider API keys — the FALLBACK source only.
 *
 * PREFER THE IN-APP FIELD. Basemap manager → Provider keys stores a key in this
 * browser's preferences, on this device. That is the right place for a metered
 * credential when the app is deployed from a public repository: a key written
 * into this file is readable by anyone who views the deployed page's source or
 * clones the repo, and an ArcGIS key bills against your allowance. The in-app
 * key wins over anything set here (see basemapKey() in map/basemapProviders.js),
 * so these constants are for private forks and internal deployments where
 * committing a key is genuinely fine.
 *
 * The catalogue in map/basemapProviders.js hides any basemap whose key is
 * missing, so leaving these empty simply falls back to the keyless
 * Esri/Carto/OSM tiles — nothing breaks.
 *
 * `arcgis` — an ArcGIS Location Platform key (free tier at
 *   location.arcgis.com). Unlocks the "Imagery Hybrid HD" / "Navigation HD"
 *   basemaps: 512px tiles rendered from Esri's Basemap Styles v2 vector styles,
 *   which is the cartography the ArcGIS attribution in the brief refers to.
 *   This is the single biggest available upgrade to map quality.
 *
 * `google` — a Google Maps Platform key with the **Map Tiles API** enabled and
 *   billing on. Adds Google's satellite/roads/terrain as ON-SCREEN basemaps.
 *   Google's terms do not cover copying map content into files, so exports
 *   render the equivalent Esri imagery instead — see `displayOnly` and
 *   `exportFallback` in map/basemapProviders.js. Tiles are metered per request:
 *   restrict the key by HTTP referrer and set a quota cap.
 *
 * `mappls` — a Mappls (MapmyIndia) map key. See the Mappls block below: the
 *   credential type matters, and it is probably not the one from the REST API
 *   page.
 */
const MAP_PROVIDER_KEYS = {
  arcgis: '',
  // Committed on the owner's explicit instruction, so search and nearby places
  // work for everyone without each person pasting a key. Same trade as
  // GEOAPIFY_API_KEY above, and the same mitigation applies and is the *only*
  // thing making it acceptable: this key MUST carry an HTTP-referrer
  // restriction in the Google Cloud console limiting it to this site, plus a
  // quota cap. Referrer-restricted browser keys are what Google designs these
  // APIs around — the key is visible by necessity, and the restriction is what
  // stops a third party spending against it. Without that restriction this line
  // is an open invoice.
  //
  // MOVING TO THE PAID KEY: replace this one string. Nothing else.
  //
  // Every Google call in the app resolves its key through basemapKey('google')
  // → googleKey(), so no service, screen or feature holds a key of its own —
  // deliberately, so that a key swap is never a code change. There is exactly
  // one other switch to consider, GOOGLE_BASEMAPS_ENABLED below, and that one
  // is about which APIs are enabled on the project, not about the key.
  google: 'AIzaSyCguQVakAfL4rwbtf4KwDzDgUBSmQFnhOQ',
  mappls: 'qvbbxilcnllctbsgabklmdpsxnoucoabncre'
};

/*
 * Google basemaps: OFF.
 *
 * Verified against this key: Places and Routes answer, but Map Tiles returns
 * 403 — "Map Tiles API has not been used in project 153913703230 before or it
 * is disabled". Offering three basemaps that cannot draw is the "stranded on a
 * blank map" failure this app has already been through once, so they stay out
 * of the picker until the API is enabled. Search, nearby and routing are
 * unaffected and are the reason the key is here.
 *
 * Flip to true once "Map Tiles API" is enabled in the Cloud console.
 */
const GOOGLE_BASEMAPS_ENABLED = false;

/* ---------------------------------------------------------------------------
 * Mappls (MapmyIndia)
 * -------------------------------------------------------------------------
 *
 * WHICH KEY. Mappls issues four separate credentials and they are NOT
 * interchangeable: MAP_SDK_KEY, REST_API_KEY, CLIENT_ID and CLIENT_SECRET.
 * Map tiles and `map_load` authenticate with the **Map SDK key**. A key taken
 * from the REST API page (the one that lists Auto Suggest, Nearby, Geocoding,
 * Routing…) will authenticate those REST calls but will be rejected for tiles.
 * If the Mappls basemap loads blank or grey, that mismatch is the first thing
 * to check — the app will say so in the status line, because tile auth
 * failures are counted and reported.
 *
 * TILE URL. Mappls documents its web integration through the `map_load` JS
 * SDK rather than a public XYZ tile template, so the template below could not
 * be confirmed against the live service from the build environment. It is
 * exposed here rather than buried in the catalogue precisely so it can be
 * corrected without touching the provider code. If Mappls support gives you a
 * different pattern, paste it here — `{token}` is replaced with the key above.
 *
 * EXPORT SAFETY is no longer assumed either way. Whether these tiles can be
 * rasterised into a PNG/PPTX depends on a response header we cannot see from
 * here, so the app now *measures* it: the first tile that loads is drawn into a
 * scratch canvas, and if reading it back throws a SecurityError the basemap is
 * marked export-blocked at runtime (see attachExportSafetyProbe in
 * map/mapEngine.js). Turn this on, look at the map, and the app will tell you
 * where it stands rather than relying on a guess baked into the source.
 * ------------------------------------------------------------------------- */
/*
 * OFF — pending an answer from Mappls support.
 *
 * Established by testing against the live service from a whitelisted browser:
 *   - the Static Key is valid. Requests return HTTP 412 (precondition failed),
 *     not 401/403, which is what Mappls answers for a recognised key;
 *   - the domain https://adityabachal85.github.io IS whitelisted in the console;
 *   - the account's Credentials tab offers a Static Key and nothing else — no
 *     separate Map SDK key exists on this plan;
 *   - despite "Raster Tiles SDK" showing Active under Allocations, the SDK
 *     loader script, 44 direct tile URLs and every List Styles request all fail.
 *
 * Since <script> and <img> requests ignore CORS, their failing too means the
 * service is refusing the key for tiles rather than serving a wrong path. No
 * tile URL will work until the account is entitled, so both Mappls basemaps stay
 * hidden rather than offering something known to be broken. Flip this back to
 * true once support confirms tile access; diagnostics/mappls-tiles.html will
 * then find the layer name in one click.
 */
const MAPPLS_ENABLED = false;

/**
 * Mappls ROAD basemap — needs a direct tile URL, which Mappls does not publish.
 *
 * Mappls ships its road basemap through its own Web SDK loader:
 *   https://apis.mappls.com/advancedmaps/api/<key>/map_sdk?v=3.0&layer=raster
 * That script brings its own bundled copy of Leaflet and expects to construct
 * the map itself (`new mappls.Map(...)`). Running it alongside the Leaflet
 * instance this app already owns means two Leaflet globals fighting over the
 * same container, so it is not a drop-in tile layer.
 *
 * There is no publicly documented XYZ template for the road basemap. Guessing
 * layer names does not work — `map_tiles`, `raster_tiles`, `standard` and
 * `tiles` were all tried against the live service and all 404.
 *
 * The URL *shape* is documented, and `bhuvan_imagery` below proves the pattern:
 *   https://apis.mappls.com/advancedmaps/v1/<key>/<layer>/{z}/{x}/{y}.png
 *
 * To enable the road basemap, get the correct <layer> name — from the
 * **List Styles API** (allocated on this account) or from Mappls support — and
 * paste the whole template here. The entry stays hidden from the basemap
 * switcher until this is filled in, so nobody can select a basemap that cannot
 * draw. `{token}` ← MAP_PROVIDER_KEYS.mappls.
 */
const MAPPLS_TILE_URL = '';

/**
 * Optional templates to try automatically, in order, when MAPPLS_TILE_URL is
 * empty. Left deliberately empty: shotgunning guessed layer names produced
 * nothing but 404s and a blank map. Add candidates here only if you have
 * reason to believe they exist.
 */
const MAPPLS_TILE_CANDIDATES = [];

/** Documented Mappls satellite layer (ISRO Bhuvan imagery) — a direct template. */
const MAPPLS_IMAGERY_URL = 'https://apis.mappls.com/advancedmaps/v1/{token}/bhuvan_imagery/{z}/{x}/{y}.png';

/**
 * Search provider endpoints
 */
const SEARCH_PROVIDERS = Object.freeze({
  geoapify: {
    autocomplete: "https://api.geoapify.com/v1/geocode/autocomplete",
    search: "https://api.geoapify.com/v1/geocode/search",
    reverse: "https://api.geoapify.com/v1/geocode/reverse"
  },

  photon: {
    autocomplete: "https://photon.komoot.io/api"
  },

  nominatim: {
    search: "https://nominatim.openstreetmap.org/search",
    reverse: "https://nominatim.openstreetmap.org/reverse"
  }
});

const PLACES_PROVIDERS = Object.freeze({

  geoapify: {
    nearby: "https://api.geoapify.com/v2/places"
  },

  overpass: {
    nearby: "https://overpass-api.de/api/interpreter"
  }

});

/* ---------------------------------------------------------------------------
 * Supabase — accounts and cloud projects
 * -------------------------------------------------------------------------
 *
 * These two values are the whole client-side configuration for sign-in and
 * cloud project storage. The browser talks to Supabase directly; the Render
 * backend above is not involved in authentication at all.
 *
 * THE ANON KEY IS MEANT TO BE PUBLIC. It identifies the project, not a person,
 * and it grants nothing on its own — every table is protected by Row Level
 * Security policies evaluated inside Postgres against the signed-in user's
 * token. That is what makes it safe to commit here, the same way the Google
 * browser key above is. See sql/supabase-auth.sql for the policies that do the
 * actual enforcing; without them this key WOULD be an open door, so do not
 * create tables without policies.
 *
 * NEVER put the `service_role` key here. That one bypasses RLS entirely and
 * belongs only in server environment variables.
 *
 * Leave either value empty to run fully offline: sign-in falls back to the
 * local profile and projects stay in this browser (see js/auth/session.js).
 */
const SUPABASE_URL = 'https://sacyafztfticssuzkrze.supabase.co';

/**
 * Supabase → Project Settings → API Keys. Either format works, verified
 * against the vendored client (2.112.1) by watching what it puts on the wire:
 * both are sent as the `apikey` header and as `Authorization: Bearer`.
 *
 *   - `sb_publishable_…` — the current format, and the one used here. It can
 *     be revoked on its own if it ever needs replacing.
 *   - `eyJ…` — the older anon JWT. Still accepted, but it is derived from the
 *     project's JWT secret, so rotating it disturbs more than just this.
 *
 * NEVER the `sb_secret_…` / `service_role` key. That one bypasses every Row
 * Level Security policy by design; in a browser it would hand every visitor
 * full read and write access to the whole database.
 */
const SUPABASE_ANON_KEY = 'sb_publishable_TvDdOBCIhz2RI1Xv7pb4ow_YCt3nEtW';

/**
 * Restrict sign-in to one email domain, or '' to allow any.
 *
 * Belt and braces only — this is a client-side check and a determined person
 * can skip it. The binding restriction is configured in Supabase (and, for
 * Microsoft sign-in, in the Entra tenant), which is where it cannot be
 * bypassed. This exists so someone with a personal address gets a clear
 * "use your work account" instead of a confusing permissions error later.
 */
const AUTH_ALLOWED_EMAIL_DOMAIN = 'dbotrealty.com';

/**
 * AI report backend (Cloud Functions) base URL — e.g.
 * 'https://asia-south1-your-project.cloudfunctions.net'.
 *
 * Unlike the keys above, this app never holds a Gemini credential of its
 * own: the AI Reports tab (js/ui/aiTab.js, js/services/aiReports.js) only
 * ever talks to this one HTTPS base, and the backend behind it owns the
 * Gemini key, the research pipeline, and every dollar it can spend. Leave
 * empty to disable the AI Reports tab — it fails with a clear message
 * ("not configured yet") rather than a raw network error.
 *
 * Deploy the backend first (see docs/AI-REPORTS-SETUP.md), then paste its
 * URL here.
 */
const AI_FUNCTIONS_BASE_URL = 'https://map-studio-ai-reports.onrender.com';
