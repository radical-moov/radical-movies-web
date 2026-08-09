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

// 2) Recursively copy everything else (skip the raw hashed sources).
function copyDir(rel = '') {
  for (const entry of fs.readdirSync(path.join(SRC, rel), { withFileTypes: true })) {
    const r = path.join(rel, entry.name);
    if (entry.isDirectory()) { fs.mkdirSync(path.join(OUT, r), { recursive: true }); copyDir(r); continue; }
    if (rel === '' && HASHED.includes(entry.name)) continue;     // hashed above
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
  const mode = PILL_PAGES.has(file) ? ' data-mode="pill"' : '';
  const footer = `<script src="${FOOTER_URL}"${mode} defer></script>`;
  html = html.includes('</body>') ? html.replace('</body>', `  ${footer}\n</body>`) : html + footer;
  fs.writeFileSync(path.join(OUT, file), html);
}

console.log(`[build] dist/ ready — hashed ${Object.keys(rename).length} assets, footer=${FOOTER_URL}`);
