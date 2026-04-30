const { CONFIG, EPHEMERAL_CONFIG, PREDEFINED_SKILLS, cleanupTimestamps,
  state, auth, db, ref, get, push, serverTimestamp } = window;

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { initializeAppCheck, ReCaptchaV3Provider } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app-check.js";
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut, deleteUser, reauthenticateWithPopup, createUserWithEmailAndPassword, signInWithEmailAndPassword, sendPasswordResetEmail, sendEmailVerification, EmailAuthProvider, reauthenticateWithCredential } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { getDatabase, ref, get, set, remove, onValue, onChildAdded, onChildChanged, onChildRemoved, push, serverTimestamp, onDisconnect, update, increment, off, query, orderByChild, orderByKey, equalTo, limitToLast, limitToFirst, endBefore, runTransaction } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";

// ── Debug logging (set to true during development only) ──
const DEBUG = false;

const FIREBASE_CONFIG = { apiKey: "AIzaSyCAqrHPZxtvIlMrF6O3AIeWPRWdG-mkKKI", authDomain: "golex-51625.firebaseapp.com", databaseURL: "https://golex-51625-default-rtdb.firebaseio.com", projectId: "golex-51625", storageBucket: "golex-51625.firebasestorage.app", messagingSenderId: "526349915922", appId: "1:526349915922:web:0e8968d99f9dd423b345cb" };
/* ── Debug logging — set _LOG=true locally to re-enable ── */
const _LOG = false;
const log = (...a) => _LOG && console.log(...a);
const CONFIG = { MAX_IMAGE_KB:400, MAX_FILE_KB:500, MAX_AUDIO_SECONDS:60, MAX_IMAGE_DIMENSION:800, JPEG_QUALITY:0.6, MAX_TAGS:10, MIN_USERNAME_LENGTH:3, MAX_USERNAME_LENGTH:24, TYPING_TIMEOUT:1500, TOAST_DURATION:2800, MESSAGE_LIMIT:200, DEBOUNCE_MS:150, SCROLL_THRESHOLD:100, PFP_COOLDOWN_DAYS:10, PFP_MAX_KB:200, PFP_DIMENSION:256, HEARTBEAT_INTERVAL:30000, PRESENCE_TIMEOUT:90000 };
const EPHEMERAL_CONFIG = { TTL:{ image:24*60*60*1000, file:48*60*60*1000, audio:12*60*60*1000, text:30*24*60*60*1000 }, CLEANUP_COOLDOWN:60*1000, WARNING_THRESHOLD:0.25, CRITICAL_THRESHOLD:0.10 };
const PREDEFINED_SKILLS = ['Gamer','Editor','Designer','Coder','Writer','Artist','Musician','Marketer','Animator','Photographer','Streamer','Explorer'];
const cleanupTimestamps = new Map();

/* ─── TTL user cache helper (5-min expiry, max 500 entries) ─── */
const USER_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const USER_CACHE_MAX = 500;
function cacheUser(uid, data) {
  if (state.usersCache.size >= USER_CACHE_MAX) {
    // Evict the oldest entry
    const firstKey = state.usersCache.keys().next().value;
    state.usersCache.delete(firstKey);
  }
  state.usersCache.set(uid, { data, cachedAt: Date.now() });
}
function getUserCached(uid) {
  const entry = state.usersCache.get(uid);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > USER_CACHE_TTL) {
    state.usersCache.delete(uid);
    return null;
  }
  return entry.data;
}
const fbApp = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(fbApp);
const db = getDatabase(fbApp);

/* ── Firebase App Check ─────────────────────────────────────────────────────
   Ties every Firebase request to this domain via reCAPTCHA v3 so no one
   can abuse your config key via external REST/SDK calls.
   SETUP: Go to Firebase Console → Build → App Check → Register this app
          using the "reCAPTCHA v3" provider, then copy your site key below.
          After registering, click "Enforce" on Realtime Database + Auth.
   REPLACE the placeholder key with your real reCAPTCHA v3 site key.
─────────────────────────────────────────────────────────────────────────── */
const _appCheckSiteKey = '6LcQCcYsAAAAAALDGXMbTKlSQJMjM-lIl0lOVTfp';
if (_appCheckSiteKey && _appCheckSiteKey !== 'REPLACE_WITH_YOUR_RECAPTCHA_V3_SITE_KEY') {
  try {
    initializeAppCheck(fbApp, {
      provider: new ReCaptchaV3Provider(_appCheckSiteKey),
      isTokenAutoRefreshEnabled: true
    });
  } catch(e) {
    DEBUG && console.warn('[AppCheck] Initialization failed:', e.message);
    // Surface failure after app boots so Toast is available
    window.addEventListener('golex:ready', () => Toast.error('Security check failed — please refresh the page.'), { once: true });
  }
} else {
  DEBUG && console.warn('[AppCheck] App Check not active — replace the site key in the source to enable it.');
  window.addEventListener('golex:ready', () => Toast.error('Security check not active — contact support.'), { once: true });
}
const $ = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);

/* ═══════════════════════════════════════════════════
   UTILITY FUNCTIONS
   ═══════════════════════════════════════════════════ */
/* ── Cached escHtml element — avoids creating a new DOM node on every call ── */
const _escNode = document.createElement('span');
function escHtml(s) { if (!s) return ''; _escNode.textContent = s; return _escNode.innerHTML; }
function linkify(t) { return escHtml(t).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'); }
function initials(n) { return n ? n.slice(0, 2).toUpperCase() : '??'; }
function timeAgo(ts) { if (!ts) return 'a while ago'; const s = Math.floor((Date.now() - ts) / 1000); if (s < 60) return 'just now'; const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`; const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`; const d = Math.floor(h / 24); if (d === 1) return 'yesterday'; if (d < 7) return `${d}d ago`; return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' }); }
function formatTime(ts) { return ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''; }
function formatDate(ts) { if (!ts) return ''; const d = new Date(ts), n = new Date(); if (d.toDateString() === n.toDateString()) return 'Today'; const y = new Date(); y.setDate(y.getDate() - 1); if (d.toDateString() === y.toDateString()) return 'Yesterday'; return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() !== n.getFullYear() ? 'numeric' : undefined }); }
function formatFileSize(b) { if (!b || b <= 0) return '0B'; if (b < 1024) return b + 'B'; if (b < 1048576) return (b / 1024).toFixed(1) + 'KB'; return (b / 1048576).toFixed(1) + 'MB'; }
function formatRecDuration(sec) { return `${Math.floor(sec / 60)}:${(sec % 60).toString().padStart(2, '0')}`; }
function fileIcon(n) { const e = (n || '').split('.').pop().toLowerCase(); const map = { pdf:'file-text',doc:'file-text',docx:'file-text',xls:'bar-chart-2',xlsx:'bar-chart-2',ppt:'bar-chart-2',pptx:'bar-chart-2',zip:'archive',rar:'archive','7z':'archive',mp3:'music',wav:'music',mp4:'film',mov:'film',avi:'film',py:'code',js:'code',ts:'code',html:'code',css:'code',json:'code',xml:'code',txt:'file',md:'file',csv:'bar-chart-2',svg:'image',png:'image',jpg:'image',gif:'image',webp:'image' }; return map[e] || 'file'; }
function badgeHTML(s, l, p) { const lc = (l || 'Beginner').toLowerCase(); return `<span class="badge badge-${escHtml(lc)}">${escHtml(s || 'Explorer')} · ${escHtml(l || 'Beginner')}</span><span class="rep">⭐${p || 0}</span>`; }
function generateAvatarUrl(uid) { return `https://api.dicebear.com/7.x/avataaars/svg?seed=${uid}`; }
function generateChatId(u1, u2) { return u1 < u2 ? `${u1}_${u2}` : `${u2}_${u1}`; }
function debounce(fn, delay) {
  let t;
  return function(...a) {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), delay);
  };
}
function rafThrottle(fn) {
  let pendingFrameId = 0, lastArgs, lastThis;
  return function (...args) {
    lastArgs = args; lastThis = this;
    if (pendingFrameId) return;
    pendingFrameId = requestAnimationFrame(() => {
      pendingFrameId = 0;
      fn.apply(lastThis, lastArgs);
    });
  };
}
let _lucidePatched = false;
function optimizeLucideRendering() {
  if (_lucidePatched || typeof window === 'undefined') return;
  if (typeof window.lucide === 'undefined' || typeof window.lucide.createIcons !== 'function') return;
  const originalCreateIcons = window.lucide.createIcons.bind(window.lucide);
  let queued = false;
  window.lucide.createIcons = (...args) => {
    if (args.length > 0) return originalCreateIcons(...args);
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      originalCreateIcons();
    });
  };
  _lucidePatched = true;
}
optimizeLucideRendering();
if (!_lucidePatched) window.addEventListener('load', optimizeLucideRendering, { once: true });
function getMessageTTL(t) { return EPHEMERAL_CONFIG.TTL[t] || EPHEMERAL_CONFIG.TTL.text; }
function getExpiryInfo(m) { const t = m.type || 'text', ttl = getMessageTTL(t), ts = m.timestamp; if (!ts) return { remainingMs: ttl, ttlMs: ttl, expired: false, pctRemaining: 1 }; const elapsed = Date.now() - ts, rem = ttl - elapsed; return { remainingMs: Math.max(0, rem), ttlMs: ttl, expired: rem <= 0, pctRemaining: Math.max(0, rem / ttl) }; }
function formatRemainingTime(ms) { if (ms <= 0) return 'expired'; const m = Math.floor(ms / (60 * 1000)); if (m < 1) return '< 1m'; if (m < 60) return `${m}m`; const h = Math.floor(m / 60); if (h < 24) return `${h}h`; const d = Math.floor(h / 24); return `${d}d`; }
function getExpiryClass(p) { if (p <= EPHEMERAL_CONFIG.CRITICAL_THRESHOLD) return 'expiry-critical'; if (p <= EPHEMERAL_CONFIG.WARNING_THRESHOLD) return 'expiry-warning'; return 'expiry-safe'; }
function isAttachmentType(t) { return t === 'image' || t === 'file' || t === 'audio'; }
function isAttachmentExpired(m) { if (!isAttachmentType(m.type)) return false; return m.expired === true || (!m.dataUrl && !m.url); }
function seenTimeAgo(ts) { if (!ts) return 'Seen'; const s = Math.floor((Date.now() - ts) / 1000); if (s < 10) return 'Seen just now'; if (s < 60) return `Seen ${s}s ago`; const m = Math.floor(s / 60); if (m < 60) return `Seen ${m}m ago`; const h = Math.floor(m / 60); if (h < 24) return `Seen ${h}h ago`; return 'Seen ' + new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' }); }

/* ═══════════════════════════════════════════════════
   PROFILE PICTURE HELPERS
   ═══════════════════════════════════════════════════ */
function compressProfilePicture(f) {
  return new Promise((res, rej) => {
    if (!f || !f.type.startsWith('image/')) return rej(new Error('Invalid image'));
    const r = new FileReader();
    r.onerror = () => rej(new Error('Read fail'));
    r.onload = e => {
      const img = new Image();
      img.onerror = () => rej(new Error('Decode fail'));
      img.onload = () => {
        let w = img.width, h = img.height;
        const md = CONFIG.PFP_DIMENSION;
        const minD = Math.min(w, h);
        const sx = (w - minD) / 2, sy = (h - minD) / 2;
        const c = document.createElement('canvas');
        c.width = md; c.height = md;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, sx, sy, minD, minD, 0, 0, md, md);
        let q = 0.7, du = c.toDataURL('image/jpeg', q);
        const maxB = CONFIG.PFP_MAX_KB * 1370;
        let att = 0;
        while (du.length > maxB && q > 0.15 && att < 10) { q -= 0.08; du = c.toDataURL('image/jpeg', q); att++; }
        res(du);
      };
      img.src = e.target.result;
    };
    r.readAsDataURL(f);
  });
}

function getProfilePicUrl(userData, uid) {
  if (userData && userData.pfpUrl) return userData.pfpUrl;
  return generateAvatarUrl(uid);
}

function canChangePfp() {
  if (!state.pfpChangedAt) return { allowed: true, daysLeft: 0 };
  const elapsed = Date.now() - state.pfpChangedAt;
  const cooldownMs = CONFIG.PFP_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
  if (elapsed >= cooldownMs) return { allowed: true, daysLeft: 0 };
  const daysLeft = Math.ceil((cooldownMs - elapsed) / (24 * 60 * 60 * 1000));
  return { allowed: false, daysLeft };
}

function updatePfpUI() {
  const { allowed, daysLeft } = canChangePfp();
  const label = $('pfp-change-label');
  const cooldownText = $('pfp-cooldown-text');
  if (allowed) {
    label.textContent = 'Change photo';
    label.classList.remove('disabled');
    cooldownText.style.display = 'none';
  } else {
    label.textContent = 'Photo locked';
    label.classList.add('disabled');
    cooldownText.style.display = 'block';
    cooldownText.textContent = `Can change again in ${daysLeft} day${daysLeft > 1 ? 's' : ''}`;
  }
}

/* ═══════════════════════════════════════════════════
   IMAGE / FILE / AUDIO PROCESSING
   ═══════════════════════════════════════════════════ */
function compressImage(f) {
  return new Promise((res, rej) => {
    if (!f || !f.type.startsWith('image/')) return rej(new Error('Invalid image'));
    const r = new FileReader();
    r.onerror = () => rej(new Error('Read fail'));
    r.onload = e => {
      const img = new Image();
      img.onerror = () => rej(new Error('Decode fail'));
      img.onload = () => {
        let w = img.width, h = img.height;
        const md = CONFIG.MAX_IMAGE_DIMENSION;
        if (w > md || h > md) { if (w > h) { h = Math.round(h * (md / w)); w = md; } else { w = Math.round(w * (md / h)); h = md; } }
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, w, h);
        let q = CONFIG.JPEG_QUALITY, du = c.toDataURL('image/jpeg', q);
        const maxB = CONFIG.MAX_IMAGE_KB * 1370; let att = 0;
        while (du.length > maxB && q > 0.1 && att < 10) { q -= 0.08; du = c.toDataURL('image/jpeg', q); att++; }
        res({ dataUrl: du, width: w, height: h, sizeKB: Math.round(du.length / 1370), quality: Math.round(q * 100) / 100 });
      };
      img.src = e.target.result;
    };
    r.readAsDataURL(f);
  });
}

function fileToBase64(f) {
  return new Promise((res, rej) => {
    // ── PRO MEDIA: Dynamic file limit ──
    if (f.size > ProMedia.getMaxFileBytes()) return rej(new Error(`File too large (max ${ProMedia.getMaxFileMB()})`));
    const r = new FileReader();
    r.onerror = () => rej(new Error('Read fail'));
    r.onload = () => res(r.result);
    r.readAsDataURL(f);
  });
}

function audioToBase64(b) {
  return new Promise((res, rej) => {
    if (!b || b.size === 0) return rej(new Error('Empty audio'));
    const r = new FileReader();
    r.onerror = () => rej(new Error('Process fail'));
    r.onload = () => {
      const max = CONFIG.MAX_IMAGE_KB * 1370 * 2;
      if (r.result.length > max) return rej(new Error('Voice note too large'));
      res(r.result);
    };
    r.readAsDataURL(b);
  });
}

function downloadBase64(d, f) { try { const a = document.createElement('a'); a.href = d; a.download = f || 'download'; document.body.appendChild(a); a.click(); a.remove(); } catch (e) { } }

/* ═══════════════════════════════════════════════════
   EPHEMERAL CLEANUP
   ═══════════════════════════════════════════════════ */
async function performLazyCleanup(chatId) {
  if (!chatId) return { deleted: 0, stripped: 0 };
  const last = cleanupTimestamps.get(chatId) || 0;
  if (Date.now() - last < EPHEMERAL_CONFIG.CLEANUP_COOLDOWN) return { deleted: 0, stripped: 0 };
  cleanupTimestamps.set(chatId, Date.now());
  const s = $('cleanup-status'), st = $('cleanup-status-text');
  if (s) s.classList.add('visible'); if (st) st.textContent = 'Scanning for expired messages...';
  try {
    const snap = await get(ref(db, `chats/${chatId}/messages`));
    if (!snap.exists()) { if (s) s.classList.remove('visible'); return { deleted: 0, stripped: 0 }; }
    const msgs = snap.val(), now = Date.now(), upd = {}; let del = 0, str = 0;
    for (const [mid, msg] of Object.entries(msgs)) {
      if (!msg || !msg.timestamp) continue;
      const type = msg.type || 'text', ttl = getMessageTTL(type), age = now - msg.timestamp;
      if (age > ttl) {
        if (type === 'text') { upd[mid] = null; del++; }
        else if (msg.dataUrl || msg.url) {
          upd[`${mid}/dataUrl`] = null; if (msg.url) upd[`${mid}/url`] = null;
          upd[`${mid}/expired`] = true; upd[`${mid}/expiredAt`] = now; str++;
        }
      }
    }
    const total = del + str;
    if (total > 0) {
      if (st) st.textContent = `Cleaning ${total} expired item${total > 1 ? 's' : ''}...`;
      await update(ref(db, `chats/${chatId}/messages`), upd);
      const pinnedSnap = await get(ref(db, `chats/${chatId}/pinned`));
      if (pinnedSnap.exists()) {
        const pinData = pinnedSnap.val();
        if (upd[pinData.mid] === null) {
          await remove(ref(db, `chats/${chatId}/pinned`));
        }
      }
      if (st) st.textContent = `Cleaned ${total} expired item${total > 1 ? 's' : ''}`;
      setTimeout(() => { if (s) s.classList.remove('visible'); }, 2000);
    } else if (s) s.classList.remove('visible');
    return { deleted: del, stripped: str };
  } catch (e) { if (s) s.classList.remove('visible'); return { deleted: 0, stripped: 0 }; }
}

/* ═══════════════════════════════════════════════════
   TOAST & SCREEN MANAGER
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
/* ═══════════════════════════════════════════════════
   SCROLL TO BOTTOM BUTTON
   ═══════════════════════════════════════════════════ */
function initScrollButton() {
  const btn = $('scroll-bottom-btn');
  const wrap = $('msgs-wrap');
  if (!btn || !wrap) return;
  state.scrollBottomBtn = btn;
  const checkScroll = () => {
    if (!wrap) return;
    const nearBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < CONFIG.SCROLL_THRESHOLD;
    const next = nearBottom ? 'none' : 'flex';
    if (btn.style.display !== next) btn.style.display = next;
  };
  wrap.addEventListener('scroll', rafThrottle(checkScroll), { passive: true });
  btn.addEventListener('click', () => {
    wrap.scrollTo({ top: wrap.scrollHeight, behavior: 'smooth' });
  });
  checkScroll();
}

/* ═══════════════════════════════════════════════════
   SKILL GRID SELECTION — event-delegated for performance
   ═══════════════════════════════════════════════════ */
function initSkillGrid(gridId, onSelect) {
  const grid = $(gridId);
  if (!grid) return;
  grid.addEventListener('click', e => {
    const pill = e.target.closest('.skill-select-pill');
    if (!pill) return;
    grid.querySelectorAll('.skill-select-pill').forEach(p => p.classList.remove('selected'));
    pill.classList.add('selected');
    onSelect(pill.dataset.skill);
  });
}

function setSkillGridSelection(gridId, skill) {
  // Handle old-style pills (modal profile editor uses these)
  document.querySelectorAll(`#${gridId} .skill-select-pill`).forEach(p => {
    p.classList.toggle('selected', p.dataset.skill === skill);
  });
  // Handle new-style cards (onboarding uses these)
  document.querySelectorAll(`#${gridId} .skill-card`).forEach(c => {
    c.classList.toggle('selected', c.dataset.skill === skill);
  });
}

initSkillGrid('setup-skill-grid', (skill) => {
  state.setupSelectedSkill = skill;
  $('setup-skill-input').value = skill;
});

initSkillGrid('modal-skill-grid', (skill) => {
  state.modalSelectedSkill = skill;
  $('modal-skill-input').value = skill;
});

/* ═══════════════════════════════════════════════════
   TAG & PILL MANAGERS
   ═══════════════════════════════════════════════════ */
class TagManager {
  constructor(i, b, w, t) {
    this.input = $(i); this.btn = $(b); this.wrap = $(w); this.tags = t;
    this.btn.addEventListener('click', () => this.addTag());
    this.input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); this.addTag(); } });
    this.render();
  }
  addTag() {
    // Sanitize: only allow alphanumeric, spaces, hyphens, dots — strip everything else
    const raw = this.input.value.trim();
    const v = raw.replace(/[^a-zA-Z0-9 \-_.+#]/g, '').trim().slice(0, 20);
    if (!v) { if (raw) Toast.info('Only letters, numbers, spaces and basic symbols allowed'); return; }
    if (this.tags.map(t => t.toLowerCase()).includes(v.toLowerCase())) { Toast.info('Tag exists'); return; }
    if (this.tags.length >= CONFIG.MAX_TAGS) { Toast.info(`Max ${CONFIG.MAX_TAGS} tags`); return; }
    this.tags.push(v); this.input.value = ''; this.render();
  }
  removeTag(i) { this.tags.splice(i, 1); this.render(); }
  render() {
    this.wrap.innerHTML = '';
    this.tags.forEach((t, i) => {
      const e = document.createElement('div'); e.className = 'skill-tag';
      e.innerHTML = `${escHtml(t)}<span class="tag-remove" aria-label="Remove ${escHtml(t)}"><i data-lucide="x" class="lucide" width="12" height="12"></i></span>`;
      e.querySelector('.tag-remove').addEventListener('click', () => this.removeTag(i));
      this.wrap.appendChild(e);
    });
  }
  setTags(t) { this.tags.length = 0; this.tags.push(...t); this.render(); }
}

class PillManager {
  constructor(g, d, k) { this.grid = $(g); this.data = d; this.dataKey = k; this.init(); }
  init() {
    if (!this.grid) return;
    this.grid.querySelectorAll(`[data-${this.dataKey}]`).forEach(p => p.addEventListener('click', () => this.toggle(p)));
    this.sync();
  }
  toggle(p) {
    const k = p.dataset[this.dataKey] || p.dataset.goal || p.dataset.avail;
    const idx = this.data.indexOf(k);
    if (idx >= 0) { this.data.splice(idx, 1); p.classList.remove('selected'); }
    else { this.data.push(k); p.classList.add('selected'); }
  }
  sync() {
    if (!this.grid) return;
    this.grid.querySelectorAll(`[data-goal],[data-avail]`).forEach(p => {
      const k = p.dataset.goal || p.dataset.avail;
      p.classList.toggle('selected', this.data.includes(k));
    });
  }
  rebind() {
    if (!this.grid) return;
    this.grid.querySelectorAll(`[data-goal],[data-avail]`).forEach(p => {
      const c = p.cloneNode(true); p.replaceWith(c);
      c.addEventListener('click', () => this.toggle(c));
    });
    this.sync();
  }
}

const setupTagManager = new TagManager('setup-tag-input', 'setup-tag-add', 'setup-tags-wrap', state.setupTags);
const modalTagManager = new TagManager('modal-tag-input', 'modal-tag-add', 'modal-tags-wrap', state.modalTags);
const setupGoalsPills = new PillManager('setup-goals-grid', state.goals, 'goal');
const setupAvailPills = new PillManager('setup-avail-grid', state.availability, 'avail');

/* ═══════════════════════════════════════════════════
   GOLEX TITLE EXPANSION

// ── Export to window ──
Object.assign(window, {
  $, $$, escHtml, linkify, initials, timeAgo, formatTime, formatDate,
  formatFileSize, formatRecDuration, fileIcon, badgeHTML, generateAvatarUrl,
  generateChatId, debounce, rafThrottle, optimizeLucideRendering,
  getMessageTTL, getExpiryInfo, formatRemainingTime, getExpiryClass,
  isAttachmentType, isAttachmentExpired, seenTimeAgo,
  compressProfilePicture, getProfilePicUrl, canChangePfp, updatePfpUI,
  compressImage, fileToBase64, audioToBase64, downloadBase64,
  cleanupMessages, Toast, ScreenManager, initScrollButton, initSkillGrid,
  setSkillGridSelection, TagManager
});
