# radical-movies-web

Frontend (vanilla-JS SPA) for **Radical Movies**. This repo (with `radical-movies-api`) is now the **source of truth** — the old `radical-movies` monolith has been archived and all pushes go here. (Historically `src/` was mirrored from the monolith's `public/`; that one-way sync is retired.)

- **Source:** `src/` — `index.html`, `app.js`, `admin.html`, `admin.js`, `style.css`, `login.html`, `tv.html`, `upgrade.html`, `link.html`, `generatelinks.html`, `sw.js`, `manifest.json`, icons/images.
- **Build:** `npm run build` → `dist/` (dependency-free `build.mjs`): content-hashes `app.js`/`admin.js`/`style.css`, rewrites HTML refs, and bakes the shared footer `<script>` into every page (pill mode on `/login` and `/tv`). This replaces the old runtime `?v=BUILD_ID` cache-bust and the edge HTML-rewrite.
- **Serve:** static `dist/` behind the edge (nginx `Dockerfile` provided). The edge routes `/api` + `/socket.io` to `radical-movies-api`, everything else here — so the app stays **same-origin** (cookies + Socket.IO unchanged).

## Contract with the backend
All API calls are **relative** (`/api/...`) and Socket.IO connects via `io()` (same origin). Do not hardcode the API origin — same-origin is preserved by the edge. See `radical-movies-api` for the route/event contract.

## Dev
```
npm run build        # -> dist/
npm run serve        # build + static server on :5173 (API calls need the edge in front)
```

## Deploy
Built and served as a container (see `Dockerfile`) in the container stack, or as static assets on any host. The GitHub Pages build (`.github/workflows/pages.yml`) bakes an absolute `API_BASE` (repo var, default `https://movies.theradicalparty.com`) and `PAGES_CNAME` (repo var, default `radicalmovies.org`) into the bundle.

### Staging — `beta.radicalmovies.org`
Staging is the same SPA published to the owned **`beta.radicalmovies.org`** host (ingress already exists on Patrick's Cloudflare — we don't touch DNS), pointed at the staging API. Build with:
```
PAGES_CNAME=beta.radicalmovies.org API_BASE=<staging API origin> node build.mjs
```
The staging API serves media from the owned **`jellyfinmovies.com`** CDN (`R2_CDN_URL`); see `radical-movies-api/deploy/STAGING.md`. Because GitHub Pages binds one custom domain per repo, publish the beta build to its existing Cloudflare origin (the `dist/` output is host-agnostic apart from the baked `API_BASE`/`CNAME`).
