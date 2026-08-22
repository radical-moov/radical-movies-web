// Dependency-free static build for radical-movies-web (GitHub Pages target).
//
// IMPORTANT: src/ is mirrored from the monolith's public/ by the rm-sync job, so
// this build must NOT depend on files that only exist here (they get wiped on the
// next sync). ALL Pages-only, cross-origin/token logic therefore lives in THIS
// file (build.mjs is not under src/, so it survives the sync):
//   - generates rmconfig.js — API base + a fetch shim that reroutes /api and
//     /socket.io to the API origin, attaches the Bearer token, auto-captures the
//     token from login/signup responses, and clears it on logout.
//   - rewrites the io() call to send the token, and the socket.io client <script>.
//   - content-hashes app.js/admin.js/style.css, bakes the footer, CNAME, .nojekyll.
//
// Empty API_BASE => same-origin no-op (nothing changes; used for local dev).

import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, 'src');
const OUT = path.join(__dirname, 'dist');

const FOOTER_URL  = process.env.FOOTER_URL || 'https://theradicalparty.com/footer.js';
const API_BASE    = process.env.API_BASE || '';   // '' = same-origin; else absolute API origin
const PAGES_CNAME = process.env.PAGES_CNAME || ''; // writes dist/CNAME for the custom domain
const HASHED = ['app.js', 'admin.js', 'style.css'];
const PILL_PAGES = new Set(['login.html', 'tv.html']);

// rmconfig shim (injected first in <head>). __API_BASE__ replaced at build time.
// Note the doubled backslashes: they produce single backslashes in the emitted JS.
const RMCONFIG_JS = `window.API_BASE = window.API_BASE || "__API_BASE__";
window.RM_TOKEN = function(){ try { return localStorage.getItem("rm_token") || ""; } catch(e){ return ""; } };
(function(){
  var B = window.API_BASE;
  if (!B) return; // same-origin: no-op
  var _fetch = window.fetch.bind(window);
  var isApi = function(u){ return typeof u === "string" && u.charAt(0) === "/" && /^\\/(api|socket\\.io)\\b/.test(u); };
  var isAuth = function(u){ return typeof u === "string" && /\\/api\\/auth\\/(login|signup)\\b/.test(u); };
  var isLogout = function(u){ return typeof u === "string" && /\\/api\\/auth\\/logout\\b/.test(u); };
  window.fetch = function(input, init){
    init = init || {};
    var url = typeof input === "string" ? input : (input && input.url) || "";
    try {
      if (isApi(url)) {
        if (typeof input === "string") input = B + input; else input = new Request(B + input.url, input);
        if (init.credentials == null) init.credentials = "include";
        var t = window.RM_TOKEN();
        if (t) { var h = new Headers(init.headers || {}); if (!h.has("Authorization")) h.set("Authorization", "Bearer " + t); init.headers = h; }
      }
    } catch(e){}
    var p = _fetch(input, init);
    if (isLogout(url)) { try { localStorage.removeItem("rm_token"); } catch(e){} }
    if (isAuth(url)) {
      p = p.then(function(res){
        try { res.clone().json().then(function(d){ if (d && d.token){ try { localStorage.setItem("rm_token", d.token); } catch(e){} } }).catch(function(){}); } catch(e){}
        return res;
      });
    }
    return p;
  };
})();`;

// Same-origin io() → cross-origin + token (exact substring in app.js/admin.js).
const IO_FROM = "io({ transports: ['polling'] })";
const IO_TO   = "io(window.API_BASE || undefined, { transports: ['polling'], withCredentials: true, auth: { token: (window.RM_TOKEN && window.RM_TOKEN()) || undefined } })";

const hash8 = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 8);
const hashedName = (file, h) => file.replace(/\.(\w+)$/, `.${h}.$1`);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// 1) Hash fingerprinted assets; transform the io() call in JS on the way through.
const rename = {};
for (const file of HASHED) {
  const p = path.join(SRC, file);
  if (!fs.existsSync(p)) continue;
  let buf = fs.readFileSync(p);
  if (file.endsWith('.js')) buf = Buffer.from(fs.readFileSync(p, 'utf8').split(IO_FROM).join(IO_TO), 'utf8');
  const out = hashedName(file, hash8(buf));
  fs.writeFileSync(path.join(OUT, out), buf);
  rename[file] = out;
}

// 1b) Generate rmconfig.js (API base baked in), content-hash it.
const rmconfigJs = RMCONFIG_JS.replace('__API_BASE__', API_BASE);
const rmconfigOut = hashedName('rmconfig.js', hash8(Buffer.from(rmconfigJs)));
fs.writeFileSync(path.join(OUT, rmconfigOut), rmconfigJs);

// 2) Copy everything else (skip hashed sources + HTML).
function copyDir(rel = '') {
  for (const entry of fs.readdirSync(path.join(SRC, rel), { withFileTypes: true })) {
    const r = path.join(rel, entry.name);
    if (entry.isDirectory()) { fs.mkdirSync(path.join(OUT, r), { recursive: true }); copyDir(r); continue; }
    if (rel === '' && HASHED.includes(entry.name)) continue;
    if (rel === '' && entry.name.endsWith('.html')) continue;
    fs.copyFileSync(path.join(SRC, r), path.join(OUT, r));
  }
}
copyDir();

// 3) Process HTML: hashed refs, rmconfig first in <head>, socket.io -> API, footer, cfasync opt-out.
for (const file of fs.readdirSync(SRC).filter((f) => f.endsWith('.html'))) {
  let html = fs.readFileSync(path.join(SRC, file), 'utf8');
  for (const [from, to] of Object.entries(rename)) html = html.replaceAll(from, to);
  html = html.replace('<head>', `<head>\n  <script src="/${rmconfigOut}"></script>`);
  if (API_BASE) html = html.replaceAll('/socket.io/socket.io.js', `${API_BASE}/socket.io/socket.io.js`);
  const mode = PILL_PAGES.has(file) ? ' data-mode="pill"' : '';
  const footer = `<script src="${FOOTER_URL}"${mode} defer></script>`;
  html = html.includes('</body>') ? html.replace('</body>', `  ${footer}\n</body>`) : html + footer;
  html = html.replace(/<script(?![^>]*\bdata-cfasync\b)/g, '<script data-cfasync="false"');
  fs.writeFileSync(path.join(OUT, file), html);
}

// 4) GitHub Pages: custom-domain CNAME + disable Jekyll.
if (PAGES_CNAME) fs.writeFileSync(path.join(OUT, 'CNAME'), PAGES_CNAME + '\n');
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

console.log(`[build] dist/ ready — hashed ${Object.keys(rename).length} assets, rmconfig=${rmconfigOut}, API_BASE=${API_BASE || '(same-origin)'}, cname=${PAGES_CNAME || '(none)'}`);
