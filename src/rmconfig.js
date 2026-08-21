// Runtime API origin + cross-site auth for the static frontend.
//
// build.mjs replaces __API_BASE__ with the absolute API origin (e.g.
// https://movies.theradicalparty.com) for the GitHub Pages build, or "" for a
// same-origin build. Empty = SAME-ORIGIN, a total no-op (nothing changes where
// Node/the edge serves the app). When cross-origin, the app authenticates with a
// Bearer TOKEN (not cookies) because radicalmovies.org → movies.theradicalparty.com
// is cross-SITE and Safari/iOS block third-party cookies. The token is stored in
// localStorage('rm_token') at login and attached to every /api call here.
window.API_BASE = window.API_BASE || "__API_BASE__";
window.RM_TOKEN = function () { try { return localStorage.getItem("rm_token") || ""; } catch (e) { return ""; } };

(function () {
  var B = window.API_BASE;
  if (!B) return; // same-origin: leave fetch untouched (zero behaviour change)

  var _fetch = window.fetch.bind(window);
  var isApiPath = function (u) { return typeof u === "string" && u.charAt(0) === "/" && /^\/(api|socket\.io)\b/.test(u); };

  window.fetch = function (input, init) {
    init = init || {};
    try {
      var url = typeof input === "string" ? input : (input && input.url);
      if (isApiPath(url)) {
        if (typeof input === "string") input = B + input;
        else input = new Request(B + input.url, input);
        if (init.credentials == null) init.credentials = "include";
        var t = window.RM_TOKEN();
        if (t) {
          var h = new Headers(init.headers || (typeof input === "object" ? input.headers : null) || {});
          if (!h.has("Authorization")) h.set("Authorization", "Bearer " + t);
          init.headers = h;
        }
      }
    } catch (e) {}
    return _fetch(input, init);
  };
})();
