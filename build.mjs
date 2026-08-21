// Dependency-free static build for radical-movies-web.
//
// - Content-hashes app.js / admin.js / style.css (replaces the old runtime
//   ?v=BUILD_ID cache-bust the monolith did at serve time) and rewrites the
//   HTML references to the hashed filenames.
// - Bakes the shared cross-subdomain footer <script> into every HTML page
//   (pill mode on /login and /tv), so the edge no longer needs to rewrite HTML.
// - Copies everything else (icons, manifest, sw.js, images, other HTML) as-is.
//
// Output: dist/ — a plain static bundle served by any web server (nginx/Caddy).

import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, 'src');
const OUT = path.join(__dirname, 'dist');

const FOOTER_URL = process.env.FOOTER_URL || 'https://theradicalparty.com/footer.js';
// API origin for the static frontend. '' = same-origin (edge/local). On GitHub
// Pages set API_BASE=https://api.radicalmovies.org so /api + /socket.io resolve
// to the backend cross-origin. PAGES_CNAME writes dist/CNAME for the custom domain.
const API_BASE = process.env.API_BASE || '';
const PAGES_CNAME = process.env.PAGES_CNAME || '';
const HASHED = ['app.js', 'admin.js', 'style.css']; // assets to content-hash
const PILL_PAGES = new Set(['login.html', 'tv.html']); // corner-badge footer mode

const hash8 = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 8);
const hashedName = (file, h) => file.replace(/\.(\w+)$/, `.${h}.$1`);

// Clean output
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// 1) Hash the fingerprinted assets, write them under their hashed names.
const rename = {};
for (const file of HASHED) {
  const p = path.join(SRC, file);
  if (!fs.existsSync(p)) continue;
  const buf = fs.readFileSync(p);
  const out = hashedName(file, hash8(buf));
  fs.writeFileSync(path.join(OUT, out), buf);
  rename[file] = out;
}

// 1b) rmconfig.js — bake the API base in, content-hash it, inject first in <head>.
let rmconfigOut = null;
{
  const p = path.join(SRC, 'rmconfig.js');
  if (fs.existsSync(p)) {
    const js = fs.readFileSync(p, 'utf8').replaceAll('__API_BASE__', API_BASE);
    rmconfigOut = hashedName('rmconfig.js', hash8(Buffer.from(js)));
    fs.writeFileSync(path.join(OUT, rmconfigOut), js);
  }
}

// 2) Recursively copy everything else (skip the raw hashed sources).
function copyDir(rel = '') {
  for (const entry of fs.readdirSync(path.join(SRC, rel), { withFileTypes: true })) {
    const r = path.join(rel, entry.name);
    if (entry.isDirectory()) { fs.mkdirSync(path.join(OUT, r), { recursive: true }); copyDir(r); continue; }
    if (rel === '' && HASHED.includes(entry.name)) continue;     // hashed above
    if (rel === '' && entry.name === 'rmconfig.js') continue;    // hashed above (1b)
    if (rel === '' && entry.name.endsWith('.html')) continue;    // processed below
    fs.copyFileSync(path.join(SRC, r), path.join(OUT, r));
  }
}
copyDir();

// 3) Process HTML: rewrite asset refs to hashed names + inject the footer.
for (const file of fs.readdirSync(SRC).filter((f) => f.endsWith('.html'))) {
  let html = fs.readFileSync(path.join(SRC, file), 'utf8');
  for (const [from, to] of Object.entries(rename)) {
    html = html.replaceAll(from, to);
  }
  // Inject rmconfig first in <head> (installs the API-base fetch shim before any
  // inline script runs). Point the socket.io client lib at the API when cross-origin.
  if (rmconfigOut) html = html.replace('<head>', `<head>\n  <script src="/${rmconfigOut}"></script>`);
  if (API_BASE) html = html.replaceAll('/socket.io/socket.io.js', `${API_BASE}/socket.io/socket.io.js`);
  const mode = PILL_PAGES.has(file) ? ' data-mode="pill"' : '';
  const footer = `<script src="${FOOTER_URL}"${mode} defer></script>`;
  html = html.includes('</body>') ? html.replace('</body>', `  ${footer}\n</body>`) : html + footer;
  // Opt every <script> out of Cloudflare Rocket Loader. On the tunneled edge
  // (Phase 5) CF applies zone-level Rocket Loader to proxied HTML, which mangles
  // `type="module"` (app.js) and breaks the SPA. data-cfasync="false" is CF's
  // documented opt-out; it's an inert no-op on the Worker-fronted prod and on any
  // non-CF host, so the built HTML stays portable and cutover-safe.
  html = html.replace(/<script(?![^>]*\bdata-cfasync\b)/g, '<script data-cfasync="false"');
  fs.writeFileSync(path.join(OUT, file), html);
}

// 4) GitHub Pages: custom-domain CNAME + disable Jekyll processing.
if (PAGES_CNAME) fs.writeFileSync(path.join(OUT, 'CNAME'), PAGES_CNAME + '\n');
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

console.log(`[build] dist/ ready — hashed ${Object.keys(rename).length} assets, footer=${FOOTER_URL}, API_BASE=${API_BASE || '(same-origin)'}, cname=${PAGES_CNAME || '(none)'}`);
