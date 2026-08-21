// Runtime API origin for the static frontend.
//
// The build (build.mjs) replaces the __API_BASE__ token with the absolute API
// origin (e.g. https://api.radicalmovies.org) when API_BASE is set, or with an
// empty string otherwise. Empty string = SAME-ORIGIN behaviour, identical to how
// the app worked when Node/the edge served it — so this file is a no-op there and
// nothing changes. On GitHub Pages (cross-origin) it points every /api and
// /socket.io call at the API and sends the auth cookie.
window.API_BASE = window.API_BASE || "__API_BASE__";

(function () {
  var B = window.API_BASE;
  if (!B) return; // same-origin: leave fetch/io untouched (zero behaviour change)

  // Rewrite server-relative /api and /socket.io requests to the API origin and
  // attach credentials so the cross-site session cookie rides along.
  var _fetch = window.fetch.bind(window);
  var isApiPath = function (u) { return typeof u === "string" && u.charAt(0) === "/" && /^\/(api|socket\.io)\b/.test(u); };
  window.fetch = function (input, init) {
    init = init || {};
    try {
      if (isApiPath(input)) {
        input = B + input;
        if (init.credentials == null) init.credentials = "include";
      } else if (input && typeof input === "object" && isApiPath(input.url)) {
        input = new Request(B + input.url, input);
        if (init.credentials == null) init.credentials = "include";
      }
    } catch (e) {}
    return _fetch(input, init);
  };
})();
