# Deploying this site

GitHub Pages, serving the repository root of whichever branch is selected in
**Settings → Pages**. No build step: the files in the repo are the files that
are served.

## `.nojekyll`

An empty file at the repository root, and it must stay there.

Without it, Pages runs the site through Jekyll before publishing. This project
is not a Jekyll site and gains nothing from it, but inherits its rules:

- Anything beginning with `_` or `.` is dropped from the output.
- Files carrying YAML front matter are rendered as Liquid templates. The
  application JavaScript contains dozens of `{{` and `{%` sequences — template
  literals, object literals inside strings — which Liquid would read as tags.
  None of those files carry front matter today, so none are processed, but the
  hazard is one stray `---` away from a mangled bundle or a failed build.
- A failed Jekyll build does not take the site down. It leaves the **previous**
  build serving, silently. The dashboard still reports a deployment.

That last point is the expensive one: source is correct, Pages says deployed,
and the live site is old, with nothing anywhere that says why.

## Caching, and why a fresh URL is not proof

Two caches sit between a push and a browser:

1. **The Pages CDN**, roughly ten minutes, keyed by path. Query strings are not
   part of that key, so `login.html?x=99` is served from the same cached object
   as `login.html`. Adding a parameter proves nothing about the CDN.
2. **The browser**, honouring whatever Cache-Control Pages sent.

Every asset carries `?v=APP_VERSION`, so a release busts its own scripts and
styles. Nothing busts the HTML that names them — which is how a page ends up
loading a perfectly consistent set of *old* assets and looking entirely
correct, just missing whatever shipped last.

**So check the version, not the feature.** Both `login.html` and
`projects.html` print their build at the bottom, the studio shows one in the
sidebar, and `js/core/freshness.js` compares the loaded version against the
deployed one and offers a reload when they differ.

If the version is behind after a push: wait out the ten minutes, then
hard-refresh (Ctrl/Cmd+Shift+R). If it is still behind, the deployment is the
problem, not the cache — check **Actions → pages build and deployment** for
which commit last succeeded.
