# radical-movies-web

Frontend (vanilla-JS SPA) for **Radical Movies**, split out of the `radical-movies` monolith as part of the frontend/backend split + container migration.

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
Built and served as a container (see `Dockerfile`) in the container stack, or as static assets on any host. Cloudflare remains primary until the edge cutover (Phase 5).
