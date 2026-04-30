/* ══════════════════════════════════════════════════════════════════
   app.js — Golex main entry point
   Loaded absolutely last. All modules are already initialised via
   their own side-effects and window exports. This file only does
   final top-level wiring that requires every other module to exist.
   ══════════════════════════════════════════════════════════════════ */

const {
  $, $$, state, db, ref, get,
  Toast, ScreenManager,
  StoriesSystem, NotifSystem, FollowSystem,
  RoomSystem, ProjectSystem,
  checkProfileLinkOnLoad,
  optimizeLucideRendering,
  initScrollButton,
  PeopleSearch,
  GOLEX_PRO
} = window;

// ── 1. Optimise Lucide icon rendering ──
if (typeof optimizeLucideRendering === 'function') optimizeLucideRendering();

// ── 2. First Lucide pass ──
if (typeof lucide !== 'undefined') lucide.createIcons();

// ── 3. Scroll-to-bottom button ──
if (typeof initScrollButton === 'function') initScrollButton();

// ── 4. Deep-link: ?uid= opens user profile sheet on load ──
if (typeof checkProfileLinkOnLoad === 'function') checkProfileLinkOnLoad();

// ── 5. People Search tab observer ──
if (typeof PeopleSearch !== 'undefined' && PeopleSearch.init) {
  try { PeopleSearch.init(); } catch (e) { console.warn('[app] PeopleSearch.init', e); }
}

console.log('%c[Golex] ✅ app.js loaded — all modules ready', 'color:#059669;font-weight:bold');
