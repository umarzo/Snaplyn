// ── Golex Theme Toggle — Warm Dark Slate ↔ Dev/Cyberdeck Mode (View Transitions API) ──
   THEME TOGGLE — Warm Dark Slate ↔ Dev / Cyberdeck Mode
   ══════════════════════════════════════════════════════════════ */
(function() {
  const STORAGE_KEY = 'golex-theme';
  const DEV_THEME   = 'dev';

  const track  = document.getElementById('theme-toggle-track');
  const root   = document.documentElement;

  function getIsDevMode() {
    return root.getAttribute('data-theme') === DEV_THEME;
  }

  // ── Lazy-load IBM Plex fonts only when dev theme is first activated ──
  let _ibmPlexLoaded = false;
  function ensureDevFonts() {
    if (_ibmPlexLoaded) return;
    _ibmPlexLoaded = true;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@300;400;500;600;700&family=IBM+Plex+Mono:wght@300;400;500;600;700&display=swap';
    document.head.appendChild(link);
  }

  function applyTheme(isDev, animate) {
    // ── The actual DOM mutation that switches the theme ──
    function doSwitch() {
      if (isDev) {
        ensureDevFonts();
        root.setAttribute('data-theme', DEV_THEME);
        if (track) track.setAttribute('aria-checked', 'true');
      } else {
        root.removeAttribute('data-theme');
        if (track) track.setAttribute('aria-checked', 'false');
      }
      try { localStorage.setItem(STORAGE_KEY, isDev ? DEV_THEME : 'default'); } catch(e) {}
    }

    // ── Non-animated (initial load): just switch instantly ──
    if (!animate) {
      doSwitch();
      return;
    }

    // ── PRIMARY PATH: View Transitions API (Chrome 111+) ──
    // Browser captures before/after screenshots and crossfades them.
    // The UI is ALWAYS fully visible — zero flicker, zero blank state.
    if (typeof document.startViewTransition === 'function') {
      document.startViewTransition(doSwitch);
      return;
    }

    // ── FALLBACK PATH: CSS transition class + requestAnimationFrame ──
    // CRITICAL FIX: We must NOT call doSwitch() in the same synchronous
    // block as classList.add(). If we do, the browser batches both into
    // one style recalculation — the transition class and the new theme
    // apply together, so there is no "before" state to transition from,
    // and the change is instant/glitchy.
    //
    // The fix: add the class first → force a layout flush → then switch
    // the theme in the next animation frame so the browser sees two
    // distinct paint states and can smoothly interpolate between them.
    root.classList.add('theme-transitioning');

    // Force a synchronous layout so the browser locks in the CURRENT
    // (old) computed styles as the transition start-point.
    void root.offsetHeight;

    // Switch theme in the next frame — at this point the browser has
    // already committed the old styles + active transition declarations,
    // so it will properly animate to the new values.
    requestAnimationFrame(function() {
      doSwitch();
      // Remove helper class after transition finishes (650ms + buffer)
      setTimeout(function() {
        root.classList.remove('theme-transitioning');
      }, 900);
    });
  }

  function toggleTheme() {
    applyTheme(!getIsDevMode(), true);
  }

  // Bind click on track
  if (track) {
    track.addEventListener('click', toggleTheme);
    track.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleTheme(); }
    });
  }

  // Sync initial aria-checked state
  applyTheme(getIsDevMode(), false);
})();

// (self-contained IIFE — no window exports needed)
