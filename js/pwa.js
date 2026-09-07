/* ---------------------------------------------------------------------------
 * Power Fund — PWA glue
 *
 * Service-worker registration, install prompt (Android/Chromium), iOS
 * "Add to Home Screen" hint, a non-blocking update prompt, an offline notice,
 * and the iOS-standalone file-save fallback used by app.js.
 *
 * This file adds NO business logic. It never caches or persists fund/member
 * data and never persists the treasurer-unlocked state. "Offline" is shown as a
 * plain reconnect notice — every fund operation still requires a live Supabase
 * connection (that logic lives untouched in app.js / database.js).
 * ------------------------------------------------------------------------- */
(function () {
  "use strict";

  // ===================================================================
  // Environment helpers
  // ===================================================================
  function isStandalone() {
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      window.matchMedia("(display-mode: fullscreen)").matches ||
      window.matchMedia("(display-mode: minimal-ui)").matches ||
      window.navigator.standalone === true
    );
  }

  function isIOS() {
    var ua = navigator.userAgent || "";
    if (/iPad|iPhone|iPod/.test(ua)) return true;
    // iPadOS 13+ reports as a Mac; disambiguate by touch support.
    return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  }

  function isIOSSafari() {
    if (!isIOS()) return false;
    var ua = navigator.userAgent || "";
    // Only Safari can add a PWA to the iOS home screen. Exclude the other iOS
    // browsers and the common in-app webviews so the hint is never misleading.
    return !/CriOS|FxiOS|EdgiOS|OPiOS|mercury|FBAN|FBAV|Instagram|Line\//i.test(ua);
  }

  function lsGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }
  function lsSet(key, val) {
    try {
      window.localStorage.setItem(key, val);
    } catch (e) {
      /* private mode / storage blocked — non-fatal */
    }
  }

  var DISMISS_INSTALL = "pf_pwa_install_dismissed";
  var DISMISS_IOS = "pf_pwa_ios_hint_dismissed";

  // ===================================================================
  // The notice strip (offline / update / install / iOS hint)
  // ===================================================================
  var strip = null;
  var rows = null;

  function buildStrip() {
    strip = document.createElement("div");
    strip.id = "pf-pwa";
    strip.setAttribute("aria-live", "polite");
    strip.innerHTML =
      '<div class="pf-pwa-item pf-pwa-offline" hidden>' +
        "<span>⚠ Offline — reconnect to manage fund data.</span>" +
      "</div>" +
      '<div class="pf-pwa-item pf-pwa-update" hidden>' +
        "<span>A new version of Power Fund is ready.</span>" +
        '<button type="button" class="pf-pwa-btn" data-act="reload">Reload</button>' +
      "</div>" +
      '<div class="pf-pwa-item pf-pwa-install" hidden>' +
        "<span>Install Power Fund on this device.</span>" +
        '<button type="button" class="pf-pwa-btn" data-act="install">Install</button>' +
        '<button type="button" class="pf-pwa-x" data-act="x-install" aria-label="Dismiss">✕</button>' +
      "</div>" +
      '<div class="pf-pwa-item pf-pwa-ios" hidden>' +
        "<span>To install: tap <b>Share</b>, then <b>Add to Home Screen</b>.</span>" +
        '<button type="button" class="pf-pwa-x" data-act="x-ios" aria-label="Dismiss">✕</button>' +
      "</div>";

    document.body.insertBefore(strip, document.body.firstChild);

    rows = {
      offline: strip.querySelector(".pf-pwa-offline"),
      update: strip.querySelector(".pf-pwa-update"),
      install: strip.querySelector(".pf-pwa-install"),
      ios: strip.querySelector(".pf-pwa-ios"),
    };

    strip.addEventListener("click", onStripClick);
    window.addEventListener("resize", syncHeight);
  }

  function showRow(name, on) {
    if (!rows || !rows[name]) return;
    rows[name].hidden = !on;
    syncHeight();
  }

  // Reserve exactly the strip's current height at the top of the page so the
  // fixed strip never covers the header. --pf-bar-h is 0px when nothing shows.
  function syncHeight() {
    var h = strip ? strip.getBoundingClientRect().height : 0;
    document.documentElement.style.setProperty(
      "--pf-bar-h",
      (h ? Math.round(h) : 0) + "px"
    );
  }

  function onStripClick(e) {
    var btn = e.target.closest("[data-act]");
    if (!btn) return;
    var act = btn.getAttribute("data-act");
    if (act === "reload") doReload();
    else if (act === "install") doInstall();
    else if (act === "x-install") {
      lsSet(DISMISS_INSTALL, "1");
      showRow("install", false);
    } else if (act === "x-ios") {
      lsSet(DISMISS_IOS, "1");
      showRow("ios", false);
    }
  }

  // ===================================================================
  // Service worker + update prompt
  // ===================================================================
  var hadController = false;
  var wantsReload = false;

  function registerSW() {
    if (!("serviceWorker" in navigator)) return;
    hadController = !!navigator.serviceWorker.controller;

    navigator.serviceWorker
      .register("/sw.js")
      .then(function (reg) {
        reg.addEventListener("updatefound", function () {
          var nw = reg.installing;
          if (!nw) return;
          nw.addEventListener("statechange", function () {
            if (nw.state === "installed" && navigator.serviceWorker.controller) {
              showRow("update", true);
            }
          });
        });
      })
      .catch(function (err) {
        console.warn("[pwa] service worker registration failed:", err);
      });

    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (wantsReload) {
        window.location.reload();
        return;
      }
      // A new worker claimed the page on its own (skipWaiting). Offer a reload —
      // never force one, a write may be in flight.
      if (hadController) showRow("update", true);
    });
  }

  function doReload() {
    wantsReload = true;
    if (!("serviceWorker" in navigator)) {
      window.location.reload();
      return;
    }
    navigator.serviceWorker.getRegistration().then(
      function (reg) {
        if (reg && reg.waiting) {
          reg.waiting.postMessage("SKIP_WAITING");
          // controllerchange -> reload; fall back in case it doesn't fire.
          setTimeout(function () {
            window.location.reload();
          }, 2000);
        } else {
          window.location.reload();
        }
      },
      function () {
        window.location.reload();
      }
    );
  }

  // ===================================================================
  // Install prompt (Android / Chromium)
  // ===================================================================
  var deferredPrompt = null;

  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferredPrompt = e;
    if (!isStandalone() && lsGet(DISMISS_INSTALL) !== "1") {
      showRow("install", true);
    }
  });

  function doInstall() {
    showRow("install", false);
    if (!deferredPrompt) return;
    var p = deferredPrompt;
    deferredPrompt = null;
    try {
      p.prompt();
    } catch (e) {
      /* prompt can only be called once — ignore */
    }
    if (p.userChoice && typeof p.userChoice.then === "function") {
      p.userChoice.catch(function () {});
    }
  }

  window.addEventListener("appinstalled", function () {
    deferredPrompt = null;
    lsSet(DISMISS_INSTALL, "1");
    showRow("install", false);
    showRow("ios", false);
  });

  // ===================================================================
  // iOS "Add to Home Screen" hint
  // ===================================================================
  function maybeShowIOSHint() {
    if (isStandalone() || !isIOSSafari() || lsGet(DISMISS_IOS) === "1") return;
    setTimeout(function () {
      if (!isStandalone()) showRow("ios", true);
    }, 2500);
  }

  // ===================================================================
  // Online / offline notice
  // ===================================================================
  function syncOnline() {
    showRow("offline", navigator.onLine === false);
  }
  window.addEventListener("online", syncOnline);
  window.addEventListener("offline", syncOnline);

  // ===================================================================
  // File-save fallback for installed iOS PWAs
  //
  // app.js's downloadFile() calls window.PowerFundPWA.saveFile() ONLY when
  // needsSaveFallback() is true (installed + iOS, where <a download> is inert).
  // Every other browser keeps the normal download path untouched. The CSV/JSON
  // content itself is produced by app.js and passed through verbatim.
  // ===================================================================
  function needsSaveFallback() {
    return isIOS() && isStandalone();
  }

  function saveFile(content, filename, type) {
    var file = null;
    try {
      file = new File([content], filename, { type: type || "text/plain" });
    } catch (e) {
      file = null;
    }
    var canShareFile =
      file &&
      typeof navigator.canShare === "function" &&
      typeof navigator.share === "function";
    try {
      canShareFile = canShareFile && navigator.canShare({ files: [file] });
    } catch (e) {
      canShareFile = false;
    }
    if (canShareFile) {
      var p;
      try {
        p = navigator.share({ files: [file], title: filename });
      } catch (e) {
        p = null; // threw synchronously (e.g. no user activation)
      }
      if (p && typeof p.then === "function") {
        p.catch(function (err) {
          if (err && err.name === "AbortError") return; // user cancelled — fine
          showFileModal(content, filename);
        });
        return;
      }
    }
    showFileModal(content, filename);
  }

  function showFileModal(content, filename) {
    var overlay = document.createElement("div");
    overlay.className = "modal-overlay pf-file-overlay";
    overlay.innerHTML =
      '<div class="modal" role="dialog" aria-modal="true" aria-label="Save file" tabindex="-1">' +
        "<h3>Save " + escapeHtml(filename) + "</h3>" +
        '<p class="modal-sub">This device won’t download files from an installed app. ' +
        "Copy everything below into a note or file (or use Copy, then paste it).</p>" +
        '<textarea class="share-text-area" readonly></textarea>' +
        '<div class="modal-actions">' +
          '<button type="button" class="modal-btn-primary" data-act="copy">Copy all</button>' +
          '<button type="button" class="modal-btn-secondary" data-act="close">Close</button>' +
        "</div>" +
      "</div>";

    var ta = overlay.querySelector("textarea");
    ta.value = content;

    function close() {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
    }
    function onKey(e) {
      if (e.key === "Escape") close();
    }

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) return close();
      var b = e.target.closest("[data-act]");
      if (!b) return;
      var act = b.getAttribute("data-act");
      if (act === "close") return close();
      if (act === "copy") {
        ta.focus();
        ta.select();
        var done = function () {
          b.textContent = "Copied";
          setTimeout(function () {
            b.textContent = "Copy all";
          }, 1500);
        };
        var legacy = function () {
          try {
            document.execCommand("copy");
            done();
          } catch (e2) {
            /* nothing else to try */
          }
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(content).then(done, legacy);
        } else {
          legacy();
        }
      }
    });

    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
    ta.focus();
    ta.select();
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  window.PowerFundPWA = {
    isStandalone: isStandalone,
    needsSaveFallback: needsSaveFallback,
    saveFile: saveFile,
  };

  // ===================================================================
  // Boot
  // ===================================================================
  function start() {
    buildStrip();
    syncOnline();
    if (isStandalone()) lsSet(DISMISS_INSTALL, "1"); // never nag once installed
    maybeShowIOSHint();
    registerSW();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
