const { state, $, $$, escHtml, Toast, debounce } = window;

const Toast = {
  _timer: null,
  show(msg, type = '', ms = CONFIG.TOAST_DURATION) {
    const el = $('toast'); if (!el) return;
    el.textContent = msg; el.className = 'show' + (type ? ' ' + type : '');
    clearTimeout(this._timer); this._timer = setTimeout(() => { el.className = ''; }, ms);
  },
  success(msg, ms) { this.show(msg, 'success', ms); },
  error(msg, ms) { this.show(msg, 'error', ms); },
  info(msg, ms) { this.show(msg, '', ms); }
};

/* ── Cached screen NodeList — avoids re-querying on every screen transition ── */
let _cachedScreens = null;
function getAllScreens() {
  if (!_cachedScreens) _cachedScreens = document.querySelectorAll('.screen');
  return _cachedScreens;
}
/* ── Batched lucide render — prevents multiple full DOM scans in one frame ── */
let _lucideRAF = 0;
function lucideCreate() {
  if (_lucideRAF) return;
  _lucideRAF = requestAnimationFrame(() => {
    _lucideRAF = 0;
    if (typeof lucide !== 'undefined') lucide.createIcons();
  });
}

const ScreenManager = {
  _preLoginScreens: ['loading-screen', 'login-screen', 'username-screen'],
  _prevScreen: null,

  // ── Per-screen teardown registry ──────────────────────────────────
  // Maps a screen ID to the cleanup that must run when navigating AWAY
  // from it. Add an entry here whenever a new screen attaches Firebase
  // listeners. The function is wrapped in try/catch so one bad cleanup
  // can never block navigation.
  _cleanup: {
    'chat-screen':             () => cleanupChatListeners(),
    'guild-screen':            () => cleanupGuildListeners(),
    'room-chat-screen':        () => { if (typeof RoomSystem !== 'undefined') RoomSystem.leaveRoomChat(); },
    'explore-screen':          () => { if (typeof _exploreUnsubscribe === 'function') { _exploreUnsubscribe(); _exploreUnsubscribe = null; } },
    'community-feed-screen':   () => { if (typeof cleanupCommunityFeedListeners === 'function') cleanupCommunityFeedListeners(); },
    'community-post-screen':   () => { if (typeof cleanupCommPostListeners === 'function') cleanupCommPostListeners(); },
    'project-workspace-screen':() => { if (typeof ProjectSystem !== 'undefined' && ProjectSystem._leaveWorkspace) ProjectSystem._leaveWorkspace(); },
  },

  show(id) {
    // ── Tear down the screen we're leaving ──────────────────────────
    const leaving = this._prevScreen;
    if (leaving && leaving !== id && this._cleanup[leaving]) {
      try { this._cleanup[leaving](); } catch (e) { DEBUG && console.warn('[ScreenManager] cleanup error for', leaving, e); }
    }
    this._prevScreen = id;

    getAllScreens().forEach(s => s.classList.remove('active'));
    const s = $(id); if (s) s.classList.add('active');

    // Toggle pre-login mode on #app (removes sidebar/grid on desktop)
    const app = document.getElementById('app');
    if (app) {
      if (this._preLoginScreens.includes(id)) {
        app.classList.add('pre-login');
      } else {
        app.classList.remove('pre-login');
      }
    }

    // Auto-show/hide nav and sync active tab
    const hideOn = ['loading-screen', 'login-screen', 'username-screen'];
    const nav = document.getElementById('main-nav');
    if (!nav) return;
    if (hideOn.includes(id) || !state.currentUser) {
      nav.classList.remove('visible');
    } else {
      nav.classList.add('visible');
      const map = {
        'user-list-screen': 'nav-chat',
        'chat-screen': 'nav-chat',
        'explore-screen': 'nav-explore',
        'communities-screen': 'nav-communities',
        'community-feed-screen': 'nav-communities',
        'community-post-screen': 'nav-communities',
        'community-create-screen': 'nav-communities',
        'create-screen': 'nav-create',
        // 'downloads-screen' retired
        'guild-screen': 'nav-guild',
        'rooms-screen': 'nav-rooms',
        'room-chat-screen': 'nav-rooms',
        'room-create-screen': 'nav-rooms',
      };
      if (!this._navBtns) this._navBtns = document.querySelectorAll('.nav-btn');
      this._navBtns.forEach(b => b.classList.remove('active'));
      const activeBtn = document.getElementById(map[id]);
      if (activeBtn) activeBtn.classList.add('active');
      // Re-render Lucide icons in case any were added after initial load
      lucideCreate();
    }

    // ── Always manage chat-empty-state visibility ──────────────────
    // This runs for ALL navigation (navTo() AND ScreenManager.show()
    // directly) so screens like Rooms, Guilds, and Projects correctly
    // hide the "Your conversations live here" placeholder on desktop.
    const ces = document.getElementById('chat-empty-state');
    if (ces) {
      const chatScreenIds = ['user-list-screen', 'loading-screen', 'login-screen', 'username-screen'];
      if (chatScreenIds.includes(id) && !(id === 'user-list-screen' && typeof state !== 'undefined' && state.chatId)) {
        ces.classList.add('visible');
      } else {
        ces.classList.remove('visible');
      }
    }
  }
};

/* ═══════════════════════════════════════════════════
   APP STATE
   ═══════════════════════════════════════════════════ */
   GOLEX TITLE EXPANSION
   ═══════════════════════════════════════════════════ */
// Golex expand overlay: chrome title bar removed — expand feature disabled
$('golex-expand-dismiss').addEventListener('click', () => {
  $('golex-expand-overlay').classList.remove('active');
  state.golexExpanded = false;
  $$('.screen.golex-hidden').forEach(s => s.classList.remove('golex-hidden'));
});
$('golex-expand-overlay').addEventListener('click', (e) => {
  if (e.target === $('golex-expand-overlay')) {
    $('golex-expand-overlay').classList.remove('active');
    state.golexExpanded = false;
    $$('.screen.golex-hidden').forEach(s => s.classList.remove('golex-hidden'));
  }
});
function toggleGolexExpand() { /* no-op: chrome title bar removed */ }

/* ═══════════════════════════════════════════════════
/* ═══════════════════════════════════════════════════
   PLATFORM: NAVIGATION
   ═══════════════════════════════════════════════════ */

// This controls which tab is active and which screen shows
function navTo(screenId, btnId) {
  if (screenId === 'user-list-screen' && state.chatId) {
    cleanupChatListeners();
    state.chatId = null;
    state.chatPartnerId = null;
  }
  ScreenManager.show(screenId);
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById(btnId);
  if (btn) btn.classList.add('active');
  if (screenId === 'explore-screen') { loadExploreFeed(); }
  if (screenId === 'communities-screen') { loadCommunitiesScreen(); }
  if (screenId === 'downloads-screen') openSavedPanel();

  // chat-empty-state visibility is now managed centrally inside ScreenManager.show()
}

// Wire up nav buttons via addEventListener (required for type="module" scripts)
document.getElementById('nav-chat').addEventListener('click', () => navTo('user-list-screen', 'nav-chat'));
document.getElementById('nav-explore').addEventListener('click', () => navTo('explore-screen', 'nav-explore'));
document.getElementById('nav-communities').addEventListener('click', () => navTo('communities-screen', 'nav-communities'));
document.getElementById('nav-create').addEventListener('click', () => navTo('create-screen', 'nav-create'));
// nav-downloads removed; saved panel via #saved-panel-btn

// Show nav bar when user is logged in and on main screens
function showNavBar() {
  const nav = document.getElementById('main-nav');
  if (nav) nav.classList.add('visible');
}
function hideNavBar() {
  const nav = document.getElementById('main-nav');
  if (nav) nav.classList.remove('visible');
}



/* ═══════════════════════════════════════════════════

// ── Export to window ──
Object.assign(window, { ScreenManager });
