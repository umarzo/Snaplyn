const { CONFIG, EPHEMERAL_CONFIG, PREDEFINED_SKILLS, state, $, $$, escHtml,
  auth, db, ref, get, set, onValue, push, serverTimestamp, off, update, remove,
  signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut,
  deleteUser, reauthenticateWithPopup,
  Toast, ScreenManager, initSkillGrid, setSkillGridSelection, TagManager,
  compressImage, compressProfilePicture, getProfilePicUrl, canChangePfp,
  updatePfpUI, generateAvatarUrl, debounce, timeAgo, badgeHTML, linkify,
  getEmptySocialIntegrations, normalizeSocialIntegrations,
  setupConnectionMonitor, managePresence, loadAndApplyFeatureFlags,
  cleanupAllListeners, cleanupTimestamps, cacheUser, getUserCached } = window;

/* ═══════════════════════════════════════════════════
   CONNECTION & PRESENCE (Heartbeat + instant offline)
function setupConnectionMonitor() {
  const b = $('connection-bar'), ic = $('connection-icon'), t = $('connection-text');
  let wo = false, ht = null;
  onValue(ref(db, '.info/connected'), s => {
    const c = s.val() === true; clearTimeout(ht);
    if (!c) {
      wo = true;
      b.className = 'visible';
      ic.innerHTML = '<i data-lucide="zap" class="lucide" width="12" height="12"></i>';
      t.textContent = 'Reconnecting...';
      document.body.classList.add('offline-mode');
      // Disable send buttons while offline to prevent silent failures
      const sendBtn = $('send-btn');
      if (sendBtn && !sendBtn.dataset.offlineDisabled) {
        sendBtn.dataset.offlineDisabled = '1';
        sendBtn.title = 'You are offline — messages will send when reconnected';
      }
    } else {
      document.body.classList.remove('offline-mode');
      const sendBtn = $('send-btn');
      if (sendBtn && sendBtn.dataset.offlineDisabled) {
        delete sendBtn.dataset.offlineDisabled;
        sendBtn.title = '';
        updateSendBtn();
      }
      if (wo) {
        b.className = 'visible online';
        ic.textContent = '✓';
        t.textContent = 'Connected';
        ht = setTimeout(() => { b.className = ''; }, 2500);
      }
    }
  });
}

function managePresence(uid) {
  const userStatusRef = ref(db, `users/${uid}`);
  const connectedRef = ref(db, '.info/connected');

  onValue(connectedRef, s => {
    if (s.val() === true) {
      onDisconnect(userStatusRef).update({ status: 'offline', lastSeen: serverTimestamp() });
      update(userStatusRef, { status: 'online', lastSeen: serverTimestamp() }).catch(() => {});
    }
  });

  if (state.heartbeatInterval) clearInterval(state.heartbeatInterval);
  state.heartbeatInterval = setInterval(() => {
    if (state.currentUser && !document.hidden) {
      update(ref(db, `users/${uid}`), { lastSeen: serverTimestamp() }).catch(() => {});
    }
  }, CONFIG.HEARTBEAT_INTERVAL);

  const goOffline = () => {
    try {
      const payload = JSON.stringify({ status: 'offline', lastSeen: Date.now() });
      const url = `${FIREBASE_CONFIG.databaseURL}/users/${uid}.json`;
      if (navigator.sendBeacon) {
        navigator.sendBeacon(url, payload);
      }
    } catch (e) {}
    update(ref(db, `users/${uid}`), { status: 'offline', lastSeen: serverTimestamp() }).catch(() => {});
  };
  window.addEventListener('beforeunload', goOffline);
  window.addEventListener('pagehide', goOffline);

  document.addEventListener('visibilitychange', () => {
    if (!state.currentUser) return;
    if (document.hidden) {
      update(ref(db, `users/${uid}`), { status: 'offline', lastSeen: serverTimestamp() }).catch(() => {});
    } else {
      update(ref(db, `users/${uid}`), { status: 'online', lastSeen: serverTimestamp() }).catch(() => {});
    }
  });
}

function isUserTrulyOnline(userData) {
  if (!userData) return false;
  if (userData.status !== 'online') return false;
  if (userData.lastSeen) {
    const staleness = Date.now() - userData.lastSeen;
    if (staleness > CONFIG.PRESENCE_TIMEOUT) return false;
  }
  return true;
}

/* ═══════════════════════════════════════════════════
   FEATURE FLAGS — reads hq/features and enforces them
   ═══════════════════════════════════════════════════ */
async function loadAndApplyFeatureFlags() {
  try {
    const snap = await get(ref(db, 'hq/features'));
    const flags = snap.exists() ? snap.val() : {};

    // Store all flags in state for other checks
    state.featureFlags = flags;

    // Helper: flag is ON unless explicitly set to false
    const isOn = key => flags[key] !== false;

    // Track signup permission for the onboarding block
    state._signupsEnabled = isOn('new_signups_enabled');

    // Track pfp upload permission
    state._pfpUploadEnabled = isOn('pfp_upload_enabled');

    // Maintenance mode — show a persistent banner
    if (flags['maintenance_mode'] === true) {
      Toast.error('Golex is under maintenance. Some features may be unavailable.', 8000);
    }

    // Explore feed nav button
    const exploreNav = document.getElementById('nav-explore');
    if (exploreNav) exploreNav.style.display = isOn('explore_enabled') ? '' : 'none';

    // Guild chat nav button
    const guildNav = document.getElementById('nav-guild');
    if (guildNav) guildNav.style.display = isOn('guild_enabled') ? '' : 'none';

    // Create posts nav button
    const createNav = document.getElementById('nav-create');
    if (createNav) createNav.style.display = isOn('create_posts_enabled') ? '' : 'none';

    // Voice/video calls — hide call button
    const callBtn = document.getElementById('voice-call-btn');
    if (callBtn) callBtn.style.display = isOn('calls_enabled') ? '' : 'none';
    const projCallBtn = document.getElementById('proj-ws-voice-call-btn');
    if (projCallBtn && !isOn('calls_enabled')) projCallBtn.style.display = 'none';

    // Endorsements — hide endorse button if disabled
    const endorseBtn = document.getElementById('endorse-btn');
    if (endorseBtn) endorseBtn.style.display = isOn('endorsements_enabled') ? '' : 'none';

    log('[Golex] Feature flags loaded:', flags);
  } catch (e) {
    DEBUG && console.warn('[Golex] Could not load feature flags (non-fatal):', e.message);
  }
}

/* ═══════════════════════════════════════════════════
/* ═══════════════════════════════════════════════════
   AUTH STATE
   ═══════════════════════════════════════════════════ */
/* ── Pause all CSS animations when tab is hidden — saves significant GPU on mobile ── */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) document.body.classList.add('page-hidden');
  else document.body.classList.remove('page-hidden');
}, { passive: true });

onAuthStateChanged(auth, async u => {
  // ── Clear the pre-paint auth hint regardless of outcome ──
  document.documentElement.removeAttribute('data-authed-hint');
  if (u) {
    // ── EMAIL VERIFICATION GATE ──────────────────────────────────────────────
    // Google sign-ins are always pre-verified; skip the check for them.
    // For email/password accounts, block entry until the email is confirmed.
    const isGoogleProvider = u.providerData && u.providerData[0] && u.providerData[0].providerId === 'google.com';
    if (!isGoogleProvider && !u.emailVerified) {
      ScreenManager.show('login-screen');
      showAuthMsg(
        'Please verify your email before signing in. Check your inbox (and spam folder) for the verification link.',
        false
      );
      // Sign them out so a page refresh doesn't bypass the gate
      await signOut(auth);
      try { localStorage.removeItem('golex-authed'); } catch(e) {}
      return;
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Persist login hint for next visit (enables loading-screen skip)
    try { localStorage.setItem('golex-authed', '1'); } catch(e) {}
    state.currentUser = u;
    setupConnectionMonitor();
    try {
      // ── PARALLEL FETCH: ban status + user data + mute status in one round-trip ──
      const [banSnap, snap, muteSnap] = await Promise.all([
        get(ref(db, 'hq/bans/' + u.uid)),
        get(ref(db, 'users/' + u.uid)),
        get(ref(db, 'hq/mutes/' + u.uid))
      ]);

      // ── CHECK BAN STATUS — banned users get signed out immediately ──
      if (banSnap.exists()) {
        Toast.error('Your account has been suspended. Contact support.');
        setTimeout(() => signOut(auth), 2000);
        return;
      }

      if (snap.exists() && snap.val().username) {
        const d = snap.val();
        let normalizedSkill = d.skill || 'Explorer';
        if (!PREDEFINED_SKILLS.includes(normalizedSkill)) {
          normalizedSkill = 'Explorer';
          update(ref(db, 'users/' + u.uid), { skill: normalizedSkill }).catch(() => {});
        }

        // ── MUTE STATUS (already fetched in parallel above) ──
        state.isMuted = muteSnap.exists();

        Object.assign(state, {
          username: d.username, skill: normalizedSkill, level: d.level || 'Beginner',
          points: d.points || 0, bio: d.bio || '', tags: d.tags || [], expertise: d.expertise || null,
          socialIntegrations: normalizeSocialIntegrations(d.socialIntegrations || null),
          goals: d.goals || [], availability: d.availability || [],
          pfpUrl: d.pfpUrl || '', pfpChangedAt: d.pfpChangedAt || null,
          /* ── Pro ── */
          isPro: d.isPro === true, proSince: d.proSince || null,
          proExpiry: d.proExpiry || null, tagline: d.tagline || ''
        });
        /* ── Check pro expiry silently ── */
        checkProExpiry(u.uid).catch(() => {});

        if (state.isMuted) {
          Toast.error('You are muted. You can read but cannot send messages or posts.', 6000);
        }

        const ph = getProfilePicUrl(d, u.uid);
        $('profile-icon-btn').src = ph;
        $('modal-avatar').src = ph;
        $('modal-email').textContent = u.email;
        managePresence(u.uid);
        checkProfileBanner();

        // ── LOAD FEATURE FLAGS + show screen in parallel (flags don't block UI) ──
        loadAndApplyFeatureFlags().catch(() => {}); // non-blocking — flags apply when ready

        // ── FAST-PATH: show UI first, load directory after paint ──
        ScreenManager.show('user-list-screen');
        requestAnimationFrame(() => { loadDirectory(); renderProStatusUI(); });
        // Signal app is ready (used by App Check failure toast and other deferred hooks)
        window.dispatchEvent(new Event('golex:ready'));

// Start notification listener (keep immediate — users expect notifs)
      NotifSystem.init(u.uid);
      // Deep link check for project invites — defer, not critical
      setTimeout(() => { if (typeof ProjectSystem !== 'undefined') ProjectSystem.handleDeepLink(); }, 800);
// Initialize Follow System — defer one tick to not block first paint
      setTimeout(() => FollowSystem.init(u.uid), 0);
// Initialize Stories System — defer one tick to not block first paint
      setTimeout(() => StoriesSystem.init(), 0);
// Check for profile link in URL
      setTimeout(() => checkProfileLinkOnLoad(), 800);
      initRoomLinkCheck();
        showNavBar();
        listenForIncomingCalls(); // ← starts AFTER user is fully loaded
      } else {
        // No user record found in DB — either genuinely new, or account was deleted
        // Check if signups are disabled
        if (state._signupsEnabled === false) {
          Toast.error('New signups are currently disabled. Please try again later.');
          setTimeout(() => signOut(auth), 2500);
          return;
        }

        // Safety check: clean up any leftover data from a previous account with this uid.
        // FIX: get(ref(db,'chats')) always threw PERMISSION_DENIED — chats/ has no
        // root .read rule (private messages). The old scan was silently failing and
        // doing nothing. For a genuinely new uid there are no leftover chats anyway
        // (Firebase Auth uids are globally unique and never reused), so this block
        // is now a lightweight no-op that tries to remove a follows/followers node
        // in case of any truly orphaned data from a prior failed account setup.
        await Promise.all([
          remove(ref(db, `follows/${u.uid}`)).catch(() => {}),
          remove(ref(db, `followers/${u.uid}`)).catch(() => {}),
        ]);

        ScreenManager.show('username-screen');
      }
    } catch (e) {
      Toast.error('Connection error — retrying...');
      setTimeout(() => location.reload(), 4000);
    }
  } else {
    // User signed out — clear auth hint so next visit shows loading screen normally
    try { localStorage.removeItem('golex-authed'); } catch(e) {}
    // User signed out — fully clean up everything
    // (cleanupAllListeners also resets state.currentUser and clears caches)
    cleanupAllListeners();
    ScreenManager.show('login-screen');
  }
});

/* ═══════════════════════════════════════════════════
   LOGIN / LOGOUT  — Email/Password + Google
   ═══════════════════════════════════════════════════ */

// ── Auth tab state ──
let _authCurrentTab = 'signin';
function setAuthTab(tab) {
  _authCurrentTab = tab;
  const isSignup = tab === 'signup';
  $('tab-signin').classList.toggle('auth-tab-btn--active', !isSignup);
  $('tab-signup').classList.toggle('auth-tab-btn--active', isSignup);
  $('auth-confirm-pw-wrap').style.display = isSignup ? 'block' : 'none';
  $('auth-submit-btn').textContent = isSignup ? 'Create Account' : 'Sign In';
  $('auth-forgot-btn').style.display = isSignup ? 'none' : 'block';
  $('auth-password').placeholder = isSignup ? 'Password (min 8 chars, 1 uppercase, 1 number)' : 'Password';
  $('auth-password').autocomplete = isSignup ? 'new-password' : 'current-password';
  $('auth-error-msg').style.display = 'none';
}
$('tab-signin').addEventListener('click', () => setAuthTab('signin'));
$('tab-signup').addEventListener('click', () => setAuthTab('signup'));

// ── Password show/hide toggles ──
$('auth-pw-eye').addEventListener('click', () => {
  const inp = $('auth-password');
  inp.type = inp.type === 'password' ? 'text' : 'password';
});
$('auth-confirm-pw-eye').addEventListener('click', () => {
  const inp = $('auth-confirm-password');
  inp.type = inp.type === 'password' ? 'text' : 'password';
});

// ── Error / success message helper ──
function showAuthMsg(msg, isSuccess = false) {
  const el = $('auth-error-msg');
  el.textContent = msg;
  const col = isSuccess ? 'var(--success-light)' : 'var(--danger-light)';
  const bg  = isSuccess ? 'rgba(16,185,129,0.08)' : 'rgba(239,68,68,0.08)';
  el.style.cssText = `display:block;font-size:12px;text-align:center;padding:6px 10px;border-radius:var(--radius-xs);color:${col};background:${bg}`;
}

// ── Forgot password ──
$('auth-forgot-btn').addEventListener('click', async () => {
  const email = $('auth-email').value.trim();
  if (!email) { showAuthMsg('Enter your email address first.'); return; }
  const btn = $('auth-forgot-btn');
  btn.disabled = true; btn.textContent = 'Sending...';
  try {
    await sendPasswordResetEmail(auth, email);
    showAuthMsg('Reset email sent! Check your inbox.', true);
  } catch (e) {
    const c = e.code || '';
    if (c === 'auth/user-not-found') showAuthMsg('No account found with that email.');
    else if (c === 'auth/invalid-email') showAuthMsg('Invalid email address.');
    else showAuthMsg('Could not send reset email. Try again.');
  } finally { btn.disabled = false; btn.textContent = 'Forgot password?'; }
});

// ── Email / Password sign in or sign up ──
$('auth-submit-btn').addEventListener('click', async () => {
  const email    = $('auth-email').value.trim();
  const password = $('auth-password').value;
  $('auth-error-msg').style.display = 'none';

  if (!email)    { showAuthMsg('Please enter your email.');    return; }
  if (!password) { showAuthMsg('Please enter your password.'); return; }

  if (_authCurrentTab === 'signup') {
    if (password.length < 8) { showAuthMsg('Password must be at least 8 characters.'); return; }
    if (!/[A-Z]/.test(password)) { showAuthMsg('Password must contain at least one uppercase letter.'); return; }
    if (!/[0-9]/.test(password)) { showAuthMsg('Password must contain at least one number.'); return; }
    const confirmPw = $('auth-confirm-password').value;
    if (password !== confirmPw) { showAuthMsg('Passwords do not match.'); return; }
  }

  const btn  = $('auth-submit-btn');
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = _authCurrentTab === 'signup' ? 'Creating account...' : 'Signing in...';

  try {
    if (_authCurrentTab === 'signup') {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      // Send verification email immediately — user must confirm before entering
      try { await sendEmailVerification(cred.user); } catch(verErr) { DEBUG && console.warn('Verification email failed:', verErr); }
      // Sign out so they cannot enter the app until email is verified
      await signOut(auth);
      showAuthMsg(
        'Account created! We\'ve sent a verification link to ' + email + '. Click it, then sign in here.',
        true
      );
      setAuthTab('signin');
      return; // Do NOT let onAuthStateChanged proceed into the app
    } else {
      await signInWithEmailAndPassword(auth, email, password);
    }
    // onAuthStateChanged fires automatically and handles navigation
  } catch (e) {
    const c = e.code || '';
    let msg = 'Something went wrong. Try again.';
    if (c === 'auth/user-not-found' || c === 'auth/wrong-password' || c === 'auth/invalid-credential') {
      msg = 'Incorrect email or password.';
    } else if (c === 'auth/email-already-in-use') {
      msg = 'Account already exists. Sign in instead.';
      setAuthTab('signin');
    } else if (c === 'auth/invalid-email')      { msg = 'Invalid email address.'; }
    else if (c === 'auth/weak-password')         { msg = 'Password must be at least 8 characters with an uppercase letter and a number.'; }
    else if (c === 'auth/too-many-requests')     { msg = 'Too many attempts. Please wait and try again.'; }
    else if (c === 'auth/network-request-failed'){ msg = 'Network error. Check your connection.'; }
    showAuthMsg(msg);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
});

// ── Allow pressing Enter in password field to submit ──
$('auth-password').addEventListener('keydown', e => { if (e.key === 'Enter') $('auth-submit-btn').click(); });
$('auth-confirm-password').addEventListener('keydown', e => { if (e.key === 'Enter') $('auth-submit-btn').click(); });

// ── Google sign-in (works in browser; may not work in WebView app) ──
$('google-login-btn').addEventListener('click', async () => {
  const b = $('google-login-btn'), orig = b.innerHTML;
  b.disabled = true; b.textContent = 'Connecting...';
  try { await signInWithPopup(auth, new GoogleAuthProvider()); }
  catch (e) {
    if (e.code === 'auth/popup-closed-by-user') Toast.info('Login cancelled');
    else if (e.code === 'auth/popup-blocked') Toast.error('Popup blocked — use email login instead');
    else if (e.code !== 'auth/cancelled-popup-request') Toast.error('Google login failed — try email login instead');
  } finally { b.disabled = false; b.innerHTML = orig; }
});

async function doLogout() {
  const _logoutOk = await ConfirmModal.show({ icon: 'log-out', title: 'Log out of Golex?', sub: 'You will need to sign in again.', confirmText: 'Log Out', cancelText: 'Stay', danger: true });
  if (!_logoutOk) return;

  // Mark offline in DB before we wipe state
  if (state.currentUser) {
    await update(ref(db, `users/${state.currentUser.uid}`), { status: 'offline', lastSeen: serverTimestamp() }).catch(() => {});
  }

  // Stop ALL listeners and clear ALL in-memory state
  cleanupAllListeners();

  // Clear locally saved posts from this device (IndexedDB)
  await IDB.clearAll().catch(() => {});

  // Close any open modals
  $('profile-modal').classList.remove('open');

  // Sign out of Firebase Auth
  await signOut(auth).catch(() => {});
}
$('logout-btn').addEventListener('click', doLogout);

/* ═══════════════════════════════════════════════════
/* ═══════════════════════════════════════════════════
   MULTI-STEP ONBOARDING NAVIGATION
   ═══════════════════════════════════════════════════ */

// This variable tracks which step (1–5) we are currently on
let onboardCurrentStep = 1;

// This function shows a specific step and hides all others.
// It also animates the transition direction (forward = slide right, back = slide left).
function showOnboardStep(stepNum) {
  // Hide all steps
  document.querySelectorAll('.onboard-step').forEach(el => {
    el.classList.remove('active');
  });

  // Show the requested step
  const target = document.getElementById('onboard-step-' + stepNum);
  if (target) {
    target.classList.add('active');
    onboardCurrentStep = stepNum;
  }
}

// ── STEP 1 EXIT: "Cancel" button on step 1 logs out (same as before)
$('cancel-username-btn').addEventListener('click', doLogout);

// ── STEP 1 NEXT: Validate username then go to step 2
$('onboard-next-1').addEventListener('click', async () => {
  const raw = $('username-input').value.trim().toLowerCase();
  const n = raw.replace(/[^a-z0-9_]/g, '');

  // Fix auto-corrected input
  if (n !== raw) {
    $('username-input').value = n;
    Toast.info('Only letters, numbers, and underscores allowed');
    return;
  }
  // Check minimum length
  if (n.length < CONFIG.MIN_USERNAME_LENGTH) {
    Toast.error(`Username must be at least ${CONFIG.MIN_USERNAME_LENGTH} characters`);
    return;
  }
  // Check maximum length
  if (n.length > CONFIG.MAX_USERNAME_LENGTH) {
    Toast.error(`Username must be under ${CONFIG.MAX_USERNAME_LENGTH} characters`);
    return;
  }

  // Check Firebase if username is already taken
  const btn = $('onboard-next-1');
  btn.textContent = 'Checking...';
  btn.disabled = true;
  try {
    const snap = await get(ref(db, 'usernames/' + n));
    if (snap.exists()) {
      $('username-error').style.display = 'block';
      btn.textContent = 'Continue →';
      btn.disabled = false;
      return;
    }
    $('username-error').style.display = 'none';
    // Username is available — go to step 2
    showOnboardStep(2);
  } catch (e) {
    Toast.error('Could not verify username — check connection');
  } finally {
    btn.textContent = 'Continue →';
    btn.disabled = false;
  }
});

// ── STEP 2 BACK: Go back to step 1
$('onboard-back-2').addEventListener('click', () => showOnboardStep(1));

// ── STEP 2 NEXT: Validate skill selected then go to step 3
$('onboard-next-2').addEventListener('click', () => {
  const sk = state.setupSelectedSkill;
  if (!sk) {
    Toast.info('Please pick your primary skill first!');
    return;
  }
  showOnboardStep(3);
});

// ── STEP 2: Skill card click logic
document.getElementById('setup-skill-grid').addEventListener('click', (e) => {
  const card = e.target.closest('.skill-card');
  if (!card) return;
  // Deselect all cards
  document.querySelectorAll('#setup-skill-grid .skill-card').forEach(c => c.classList.remove('selected'));
  // Select the clicked card
  card.classList.add('selected');
  // Save the selected skill in state
  state.setupSelectedSkill = card.dataset.skill;
  $('setup-skill-input').value = card.dataset.skill;
});

// ── STEP 3 BACK: Go back to step 2
$('onboard-back-3').addEventListener('click', () => showOnboardStep(2));

// ── STEP 3 NEXT: Validate level selected then go to step 4
$('onboard-next-3').addEventListener('click', () => {
  const lv = $('setup-level-input').value;
  if (!lv) {
    Toast.info('Please choose your experience level!');
    return;
  }
  showOnboardStep(4);
});

// ── STEP 3: Level card click logic
document.getElementById('setup-level-cards').addEventListener('click', (e) => {
  const card = e.target.closest('.level-card');
  if (!card) return;
  // Deselect all level cards
  document.querySelectorAll('#setup-level-cards .level-card').forEach(c => c.classList.remove('selected'));
  // Select the clicked one
  card.classList.add('selected');
  // Store value in the hidden input
  $('setup-level-input').value = card.dataset.level;
});

// ── STEP 4 BACK: Go back to step 3
$('onboard-back-4').addEventListener('click', () => showOnboardStep(3));

// ── STEP 4 NEXT: Bio and tags are optional, just proceed
$('onboard-next-4').addEventListener('click', () => {
  showOnboardStep(5);
});

// ── STEP 5 BACK: Go back to step 4
$('onboard-back-5').addEventListener('click', () => showOnboardStep(4));
// ══════════════════════════════════════════════════════════
// EXPERTISE MODULE — FULLY ISOLATED
// Does NOT modify: debounce, animations, state, or core utils
// Safe insertion point: after step-5 back handler
// ══════════════════════════════════════════════════════════
const ExpertiseModule = (() => {
  // Internal state — completely separate from global state
  const _ex = {
    type: null,       // 'link' | 'image' | 'code' | 'audio' | 'file'
    linkUrl: '',
    images: [],       // array of { name, dataUrl, size }
    code: '',
    audioFile: null,  // { name, dataUrl, size }
    file: null,       // { name, dataUrl, size, mimeType }
  };

  // Max sizes in bytes
  const MAX_IMAGE_SIZE = 2 * 1024 * 1024;   // 2MB
  const MAX_AUDIO_SIZE = 5 * 1024 * 1024;   // 5MB
  const MAX_FILE_SIZE  = 5 * 1024 * 1024;   // 5MB
  const MAX_IMAGES     = 3;

  // Allowed MIME types — strict whitelist
  const ALLOWED_IMAGES = ['image/jpeg','image/png','image/gif','image/webp'];
  const ALLOWED_AUDIO  = ['audio/mpeg','audio/mp3','audio/wav','audio/ogg'];
  const ALLOWED_FILES  = [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain','text/markdown','text/csv',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ];

  // Helper: read a file as base64 data URL — safe, no side effects
  function _readAsDataURL(file) {
    return new Promise((resolve, reject) => {
      try {
        const r = new FileReader();
        r.onload = e => resolve(e.target.result);
        r.onerror = () => reject(new Error('File read failed'));
        r.readAsDataURL(file);
      } catch (e) {
        reject(e);
      }
    });
  }

  // Helper: sanitize text for display (prevent XSS)
  function _esc(t) {
    const d = document.createElement('div');
    d.textContent = t || '';
    return d.innerHTML;
  }

  // Helper: validate URL — basic safe check
  function _isValidUrl(url) {
    if (!url) return false;
    try {
      const u = new URL(url);
      return (u.protocol === 'https:' || u.protocol === 'http:');
    } catch { return false; }
  }

  // Show/hide the correct input block based on selected type
  function _showInputBlock(type) {
    const blocks = ['link','image','code','audio','file'];
    blocks.forEach(b => {
      const el = document.getElementById('expertise-input-' + b);
      if (el) el.style.display = (b === type) ? '' : 'none';
    });
  }

  // Reset all internal expertise state
  function reset() {
    _ex.type = null;
    _ex.linkUrl = '';
    _ex.images = [];
    _ex.code = '';
    _ex.audioFile = null;
    _ex.file = null;

    // Reset type buttons
    document.querySelectorAll('.expertise-type-btn').forEach(b => b.classList.remove('active'));
    // Hide all blocks
    _showInputBlock(null);
    // Clear inputs safely
    const linkInput = document.getElementById('expertise-link-input');
    if (linkInput) linkInput.value = '';
    const codeInput = document.getElementById('expertise-code-input');
    if (codeInput) codeInput.value = '';
    const codeCount = document.getElementById('expertise-code-count');
    if (codeCount) codeCount.textContent = '0';
    // Clear file previews
    const imgWrap = document.getElementById('expertise-image-preview-wrap');
    if (imgWrap) imgWrap.innerHTML = '';
    const audioWrap = document.getElementById('expertise-audio-preview-wrap');
    if (audioWrap) audioWrap.innerHTML = '';
    const fileWrap = document.getElementById('expertise-file-preview-wrap');
    if (fileWrap) fileWrap.innerHTML = '';
    // Clear errors
    ['expertise-link-error','expertise-image-error','expertise-audio-error','expertise-file-error'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
    // Reset file inputs
    ['expertise-image-input','expertise-audio-input','expertise-file-input'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
  }

  // Serialize expertise data for Firebase (compact and clean)
  function serialize() {
    if (!_ex.type) return null;
    const base = { type: _ex.type };
    if (_ex.type === 'link') {
      if (!_isValidUrl(_ex.linkUrl)) return null;
      base.url = _ex.linkUrl;
    } else if (_ex.type === 'image') {
      if (!_ex.images.length) return null;
      base.images = _ex.images.map(i => ({ name: i.name, dataUrl: i.dataUrl }));
    } else if (_ex.type === 'code') {
      if (!_ex.code.trim()) return null;
      base.code = _ex.code;
    } else if (_ex.type === 'audio') {
      if (!_ex.audioFile) return null;
      base.audio = { name: _ex.audioFile.name, dataUrl: _ex.audioFile.dataUrl };
    } else if (_ex.type === 'file') {
      if (!_ex.file) return null;
      base.file = { name: _ex.file.name, dataUrl: _ex.file.dataUrl, mimeType: _ex.file.mimeType };
    }
    return base;
  }

  // Build the display HTML for expertise inside profile/chat panels
  function buildDisplayHTML(expertiseData) {
    if (!expertiseData || !expertiseData.type) return '';
    const type = expertiseData.type;
    let inner = '';

    if (type === 'link') {
      const url = expertiseData.url || '';
      if (!_isValidUrl(url)) return '';
      inner = `<a class="expertise-link-pill" href="${_esc(url)}" target="_blank" rel="noopener noreferrer"><i data-lucide="link" class="lucide" width="12" height="12"></i> ${_esc(url.replace(/^https?:\/\//, '').slice(0, 60))}${url.length > 60 ? '…' : ''}</a>`;
    } else if (type === 'image') {
      const imgs = expertiseData.images || [];
      if (!imgs.length) return '';
      const thumbs = imgs.map((img, i) => {
        if (!img.dataUrl || !img.dataUrl.startsWith('data:image/')) {
          return `<a class="expertise-fallback-btn" href="${_esc(img.dataUrl || '')}" download="${_esc(img.name || 'image')}">⬇ Download image</a>`;
        }
        return `<img class="expertise-display-img" src="${_esc(img.dataUrl)}" alt="Expertise image ${i+1}" loading="lazy" onclick="if(this.src.startsWith('data:'))window.open(this.src)">`;
      }).join('');
      inner = `<div class="expertise-images-display">${thumbs}</div>`;
    } else if (type === 'code') {
      const code = expertiseData.code || '';
      if (!code.trim()) return '';
      inner = `<pre class="expertise-code-display">${_esc(code)}</pre>`;
    } else if (type === 'audio') {
      const audio = expertiseData.audio || {};
      if (!audio.dataUrl) return '';
      if (audio.dataUrl.startsWith('data:audio/')) {
        inner = `<audio class="expertise-audio-display" controls preload="none" src="${_esc(audio.dataUrl)}"></audio>`;
      } else {
        inner = `<a class="expertise-fallback-btn" href="${_esc(audio.dataUrl)}" download="${_esc(audio.name || 'audio')}">⬇ Download audio</a>`;
      }
    } else if (type === 'file') {
      const file = expertiseData.file || {};
      if (!file.dataUrl) return '';
      inner = `<div class="expertise-fallback-row">
        <a class="expertise-fallback-btn" href="${_esc(file.dataUrl)}" target="_blank" rel="noopener noreferrer"><i data-lucide="eye" class="lucide" width="16" height="16"></i> View file</a>
        <a class="expertise-fallback-btn" href="${_esc(file.dataUrl)}" download="${_esc(file.name || 'file')}">⬇ Download</a>
      </div>
      <div style="font-size:11px;color:var(--muted);font-family:var(--font-mono);margin-top:4px;">${_esc(file.name || '')}</div>`;
    } else {
      return '';
    }

    return `<div class="expertise-display-block">
      <div class="expertise-display-label"><i data-lucide="star" class="lucide" width="16" height="16"></i> Expertise Proof</div>
      ${inner}
    </div>`;
  }

  // Update the expertise display inside an element by ID
  function renderInPanel(containerId, expertiseData) {
    try {
      const container = document.getElementById(containerId);
      if (!container) return;
      // Remove old expertise block if present
      const old = container.querySelector('.expertise-display-block');
      if (old) old.remove();
      // Only insert if we have data
      const html = buildDisplayHTML(expertiseData);
      if (html) {
        container.insertAdjacentHTML('beforeend', html);
      }
    } catch (e) {
      // Silent fail — never break the panel
    }
  }

  // Wire all UI events — called once after DOM is ready
  function init() {
    // Guard: only run if the Step 6 element exists
    if (!document.getElementById('onboard-step-6')) return;

    // ── Type selector buttons
    const typeGrid = document.getElementById('expertise-type-grid');
    if (typeGrid) {
      typeGrid.addEventListener('click', e => {
        const btn = e.target.closest('.expertise-type-btn');
        if (!btn) return;
        document.querySelectorAll('.expertise-type-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _ex.type = btn.dataset.type || null;
        _showInputBlock(_ex.type);
      });
    }

    // ── Link input listener
    const linkInput = document.getElementById('expertise-link-input');
    if (linkInput) {
      linkInput.addEventListener('input', () => {
        _ex.linkUrl = linkInput.value.trim();
        const errEl = document.getElementById('expertise-link-error');
        if (errEl) errEl.style.display = 'none';
      });
    }

    // ── Image file input
    const imageInput = document.getElementById('expertise-image-input');
    if (imageInput) {
      imageInput.addEventListener('change', async () => {
        const errEl = document.getElementById('expertise-image-error');
        const previewWrap = document.getElementById('expertise-image-preview-wrap');
        if (errEl) errEl.style.display = 'none';
        _ex.images = [];
        if (previewWrap) previewWrap.innerHTML = '';

        const files = Array.from(imageInput.files || []).slice(0, MAX_IMAGES);
        for (const file of files) {
          if (!ALLOWED_IMAGES.includes(file.type)) {
            if (errEl) { errEl.textContent = 'Only JPEG, PNG, GIF, or WEBP images allowed'; errEl.style.display = 'block'; }
            continue;
          }
          if (file.size > MAX_IMAGE_SIZE) {
            if (errEl) { errEl.textContent = `"${file.name}" is over 2MB — skipped`; errEl.style.display = 'block'; }
            continue;
          }
          try {
            const dataUrl = await _readAsDataURL(file);
            _ex.images.push({ name: file.name, dataUrl, size: file.size });
            if (previewWrap) {
              const wrap = document.createElement('div');
              wrap.className = 'expertise-img-thumb-wrap';
              const img = document.createElement('img');
              img.className = 'expertise-img-thumb';
              img.src = dataUrl;
              img.alt = file.name;
              const removeBtn = document.createElement('button');
              removeBtn.className = 'expertise-img-remove';
              removeBtn.type = 'button';
              removeBtn.innerHTML = '<i data-lucide="x" class="lucide" width="12" height="12"></i>';
              const idx = _ex.images.length - 1;
              removeBtn.addEventListener('click', () => {
                _ex.images.splice(idx, 1);
                wrap.remove();
              });
              wrap.appendChild(img);
              wrap.appendChild(removeBtn);
              previewWrap.appendChild(wrap);
            }
          } catch (e) { /* skip unreadable file */ }
        }
      });
    }

    // ── Code textarea
    const codeInput = document.getElementById('expertise-code-input');
    const codeCount = document.getElementById('expertise-code-count');
    if (codeInput) {
      codeInput.addEventListener('input', () => {
        _ex.code = codeInput.value;
        if (codeCount) codeCount.textContent = codeInput.value.length;
      });
    }

    // ── Audio file input
    const audioInput = document.getElementById('expertise-audio-input');
    if (audioInput) {
      audioInput.addEventListener('change', async () => {
        const errEl = document.getElementById('expertise-audio-error');
        const previewWrap = document.getElementById('expertise-audio-preview-wrap');
        if (errEl) errEl.style.display = 'none';
        _ex.audioFile = null;
        if (previewWrap) previewWrap.innerHTML = '';

        const file = audioInput.files && audioInput.files[0];
        if (!file) return;
        if (!ALLOWED_AUDIO.includes(file.type) && !file.name.match(/\.(mp3|wav|ogg)$/i)) {
          if (errEl) { errEl.textContent = 'Only MP3, WAV, or OGG audio allowed'; errEl.style.display = 'block'; }
          return;
        }
        if (file.size > MAX_AUDIO_SIZE) {
          if (errEl) { errEl.textContent = 'Audio file must be under 5MB'; errEl.style.display = 'block'; }
          return;
        }
        try {
          const dataUrl = await _readAsDataURL(file);
          _ex.audioFile = { name: file.name, dataUrl, size: file.size };
          if (previewWrap) {
            const audio = document.createElement('audio');
            audio.className = 'expertise-audio-player';
            audio.controls = true;
            audio.preload = 'none';
            audio.src = dataUrl;
            previewWrap.appendChild(audio);
          }
        } catch (e) {
          if (errEl) { errEl.textContent = 'Could not read audio file'; errEl.style.display = 'block'; }
        }
      });
    }

    // ── Generic file input
    const fileInput = document.getElementById('expertise-file-input');
    if (fileInput) {
      fileInput.addEventListener('change', async () => {
        const errEl = document.getElementById('expertise-file-error');
        const previewWrap = document.getElementById('expertise-file-preview-wrap');
        if (errEl) errEl.style.display = 'none';
        _ex.file = null;
        if (previewWrap) previewWrap.innerHTML = '';

        const file = fileInput.files && fileInput.files[0];
        if (!file) return;
        if (!ALLOWED_FILES.includes(file.type) && !file.name.match(/\.(pdf|doc|docx|txt|md|csv|ppt|pptx|xls|xlsx)$/i)) {
          if (errEl) { errEl.textContent = 'File type not supported'; errEl.style.display = 'block'; }
          return;
        }
        if (file.size > MAX_FILE_SIZE) {
          if (errEl) { errEl.textContent = 'File must be under 5MB'; errEl.style.display = 'block'; }
          return;
        }
        try {
          const dataUrl = await _readAsDataURL(file);
          _ex.file = { name: file.name, dataUrl, size: file.size, mimeType: file.type };
          if (previewWrap) {
            const chip = document.createElement('div');
            chip.className = 'expertise-file-chip';
            chip.innerHTML = `<span><i data-lucide="file" class="lucide" width="16" height="16"></i></span><span class="expertise-file-chip-name">${_esc(file.name)}</span><span style="font-family:var(--font-mono);font-size:10px;color:var(--muted);flex-shrink:0;">${(file.size/1024).toFixed(1)}KB</span>`;
            previewWrap.appendChild(chip);
          }
        } catch (e) {
          if (errEl) { errEl.textContent = 'Could not read file'; errEl.style.display = 'block'; }
        }
      });
    }
  }

  // Expose public API
  return { init, reset, serialize, buildDisplayHTML, renderInPanel };
})();

// ── Wire Step 5 → Step 6 navigation
const _onboardNext5Btn = document.getElementById('onboard-next-5');
if (_onboardNext5Btn) {
  _onboardNext5Btn.addEventListener('click', () => {
    ExpertiseModule.reset(); // fresh state each time
    showOnboardStep(6);
  });
}

// ── Step 6 BACK: Go back to step 5
const _onboardBack6Btn = document.getElementById('onboard-back-6');
if (_onboardBack6Btn) {
  _onboardBack6Btn.addEventListener('click', () => showOnboardStep(5));
}

// ── Step 6 SKIP: Skip expertise and go straight to submit
const _expertiseSkipBtn = document.getElementById('expertise-skip-btn');
if (_expertiseSkipBtn) {
  _expertiseSkipBtn.addEventListener('click', () => {
    ExpertiseModule.reset();
    // Trigger the final save with no expertise
    const saveBtn = document.getElementById('save-username-btn');
    if (saveBtn) saveBtn.click();
  });
}

// ── Initialize ExpertiseModule UI listeners safely after DOM is parsed
setTimeout(() => { ExpertiseModule.init(); }, 0);
// ══════════════════════════════════════════════════════════
// END EXPERTISE MODULE
// ══════════════════════════════════════════════════════════

const SocialIntegrationsModule = (() => {
  let _loading = { github: false, dribbble: false };
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

  function _esc(t) {
    const d = document.createElement('div');
    d.textContent = t == null ? '' : String(t);
    return d.innerHTML;
  }

  function _getTokenKey(provider) {
    const uid = state.currentUser?.uid || 'anon';
    return `golex-${provider}-token-${uid}`;
  }

  function _setSessionToken(provider, token) {
    try {
      if (!token) sessionStorage.removeItem(_getTokenKey(provider));
      else sessionStorage.setItem(_getTokenKey(provider), token);
    } catch (_) {}
  }

  function _getSessionToken(provider) {
    try { return sessionStorage.getItem(_getTokenKey(provider)) || ''; } catch { return ''; }
  }

  async function _persistIfPossible() {
    if (!state.currentUser || !state.username) return;
    try {
      await update(ref(db, `users/${state.currentUser.uid}`), {
        socialIntegrations: state.socialIntegrations || getEmptySocialIntegrations()
      });
    } catch (_) {}
  }

  function _setLoading(provider, on, busyText) {
    _loading[provider] = !!on;
    const fetchBtn = document.getElementById(`${provider}-fetch-btn`);
    const connectBtn = document.getElementById(`${provider}-connect-btn`);
    if (fetchBtn) {
      fetchBtn.disabled = !!on;
      fetchBtn.textContent = on ? (busyText || 'Loading...') : 'Fetch Data';
    }
    if (connectBtn) connectBtn.disabled = !!on;
  }

  function _setStatus(provider, connected, text) {
    const statusEl = document.getElementById(`${provider}-connect-status`);
    if (!statusEl) return;
    statusEl.textContent = text || (connected ? 'Connected' : 'Not connected');
    statusEl.classList.toggle('connected', !!connected);
  }

  function _platformSummary(provider, data) {
    if (!data || !data.connected) return '';
    if (provider === 'github') {
      const count = Array.isArray(data.repos) ? data.repos.length : 0;
      const contributionsCount = Number(data.contributions30d || 0);
      return `${_esc(data.username || '')} · ${count} repo${count === 1 ? '' : 's'} · ${contributionsCount} recent contributions`;
    }
    const shots = Array.isArray(data.shots) ? data.shots.length : 0;
    const projects = Array.isArray(data.projects) ? data.projects.length : 0;
    return `${_esc(data.username || '')} · ${shots} shot${shots === 1 ? '' : 's'} · ${projects} project${projects === 1 ? '' : 's'}`;
  }

  function _normalizeHandle(v, maxLen = 60) {
    return (v || '').trim().replace(/^@+/, '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, maxLen);
  }

  function refreshOnboardingUI() {
    const social = normalizeSocialIntegrations(state.socialIntegrations);
    state.socialIntegrations = social;

    _setStatus('github', social.github.connected, social.github.connected ? 'Connected' : 'Not connected');
    _setStatus('dribbble', social.dribbble.connected, social.dribbble.connected ? 'Connected' : 'Not connected');

    const ghDataEl = document.getElementById('github-onboard-data');
    const drDataEl = document.getElementById('dribbble-onboard-data');
    if (ghDataEl) ghDataEl.textContent = _platformSummary('github', social.github);
    if (drDataEl) drDataEl.textContent = _platformSummary('dribbble', social.dribbble);
  }

  async function connectGithub() {
    if (_loading.github) return;
    const usernameInput = document.getElementById('github-username-input');
    const tokenInput = document.getElementById('github-token-input');
    const username = _normalizeHandle(usernameInput?.value || state.socialIntegrations?.github?.username || '', 39);
    if (!username) { Toast.error('Enter a valid GitHub username first'); return; }
    const tokenHint = (tokenInput?.value || '').trim();
    _setSessionToken('github', tokenHint || '');
    if (usernameInput) usernameInput.value = username;

    state.socialIntegrations = normalizeSocialIntegrations(state.socialIntegrations);
    state.socialIntegrations.github.connected = true;
    state.socialIntegrations.github.username = username;
    state.socialIntegrations.github.lastError = '';
    refreshOnboardingUI();
    await _persistIfPossible();
    Toast.success('GitHub connected');
  }

  async function connectDribbble() {
    if (_loading.dribbble) return;
    const usernameInput = document.getElementById('dribbble-username-input');
    const tokenInput = document.getElementById('dribbble-token-input');
    const username = _normalizeHandle(usernameInput?.value || state.socialIntegrations?.dribbble?.username || '');
    if (!username) { Toast.error('Enter a valid Dribbble username first'); return; }
    const token = (tokenInput?.value || '').trim();
    _setSessionToken('dribbble', token || '');
    if (usernameInput) usernameInput.value = username;

    state.socialIntegrations = normalizeSocialIntegrations(state.socialIntegrations);
    state.socialIntegrations.dribbble.connected = true;
    state.socialIntegrations.dribbble.username = username;
    state.socialIntegrations.dribbble.lastError = '';
    refreshOnboardingUI();
    await _persistIfPossible();
    Toast.success('Dribbble connected');
  }

  async function fetchGithubData() {
    state.socialIntegrations = normalizeSocialIntegrations(state.socialIntegrations);
    const gh = state.socialIntegrations.github;
    if (!gh.username) { Toast.error('Connect GitHub first'); return; }
    if (_loading.github) return;

    _setLoading('github', true, 'Fetching...');
    try {
      const headers = { Accept: 'application/vnd.github+json' };
      const token = _getSessionToken('github');
      if (token) headers.Authorization = `Bearer ${token}`;

      const userRes = await fetch(`https://api.github.com/users/${encodeURIComponent(gh.username)}`, { headers });
      if (!userRes.ok) throw new Error(userRes.status === 404 ? 'GitHub user not found' : 'GitHub request failed');
      const profile = await userRes.json();

      const reposRes = await fetch(`https://api.github.com/users/${encodeURIComponent(gh.username)}/repos?sort=updated&per_page=6`, { headers });
      const reposRaw = reposRes.ok ? await reposRes.json() : [];
      const repos = Array.isArray(reposRaw) ? reposRaw.map(r => ({
        name: r.name || '',
        html_url: r.html_url || '',
        stargazers_count: r.stargazers_count || 0,
        language: r.language || '',
        updated_at: r.updated_at || '',
        description: r.description || ''
      })) : [];

      const eventsRes = await fetch(`https://api.github.com/users/${encodeURIComponent(gh.username)}/events/public?per_page=100`, { headers });
      let contributions30d = 0;
      if (eventsRes.ok) {
        const events = await eventsRes.json();
        const cutoff = Date.now() - THIRTY_DAYS_MS;
        if (Array.isArray(events)) {
          events.forEach(ev => {
            const created = ev?.created_at ? Date.parse(ev.created_at) : 0;
            if (!created || created < cutoff) return;
            if (ev?.type === 'PushEvent') contributions30d += (ev?.payload?.size || ev?.payload?.commits?.length || 1);
            else contributions30d += 1;
          });
        }
      }

      state.socialIntegrations.github = {
        ...state.socialIntegrations.github,
        connected: true,
        profile: {
          login: profile.login || gh.username,
          name: profile.name || '',
          bio: profile.bio || '',
          avatar_url: profile.avatar_url || '',
          html_url: profile.html_url || '',
          followers: profile.followers || 0,
          following: profile.following || 0,
          public_repos: profile.public_repos || repos.length
        },
        repos,
        contributions30d,
        lastFetchedAt: Date.now(),
        lastError: ''
      };

      refreshOnboardingUI();
      await _persistIfPossible();
      Toast.success('GitHub data fetched');
    } catch (e) {
      state.socialIntegrations.github.lastError = e?.message || 'Fetch failed';
      refreshOnboardingUI();
      Toast.error(state.socialIntegrations.github.lastError);
    } finally {
      _setLoading('github', false);
    }
  }

  async function fetchDribbbleData() {
    state.socialIntegrations = normalizeSocialIntegrations(state.socialIntegrations);
    const dr = state.socialIntegrations.dribbble;
    if (!dr.username) { Toast.error('Connect Dribbble first'); return; }
    if (_loading.dribbble) return;

    _setLoading('dribbble', true, 'Fetching...');
    try {
      const token = _getSessionToken('dribbble');
      if (!token) {
        const safeDribbbleUsername = _normalizeHandle(dr.username);
        const profileUrl = `https://dribbble.com/${encodeURIComponent(safeDribbbleUsername)}`;
        state.socialIntegrations.dribbble = {
          ...state.socialIntegrations.dribbble,
          connected: true,
          profile: { name: safeDribbbleUsername, html_url: profileUrl, username: safeDribbbleUsername },
          shots: [],
          projects: [],
          lastFetchedAt: Date.now(),
          lastError: ''
        };
        refreshOnboardingUI();
        await _persistIfPossible();
        Toast.info('Dribbble profile linked. Add OAuth token for shots/projects.');
        return;
      }

      const headers = { Authorization: `Bearer ${token}` };
      const [userRes, shotsRes, projectsRes] = await Promise.all([
        fetch('https://api.dribbble.com/v2/user', { headers }),
        fetch('https://api.dribbble.com/v2/user/shots?per_page=6', { headers }),
        fetch('https://api.dribbble.com/v2/user/projects?per_page=6', { headers })
      ]);
      if (!userRes.ok) throw new Error(userRes.status === 401 ? 'Invalid Dribbble token' : 'Dribbble request failed');

      const profile = await userRes.json();
      const shotsRaw = shotsRes.ok ? await shotsRes.json() : [];
      const projectsRaw = projectsRes.ok ? await projectsRes.json() : [];

      const shots = Array.isArray(shotsRaw) ? shotsRaw.map(s => ({
        id: s.id,
        title: s.title || '',
        html_url: s.html_url || '',
        likes_count: s.likes_count || 0
      })) : [];
      const projects = Array.isArray(projectsRaw) ? projectsRaw.map(p => ({
        id: p.id,
        name: p.name || '',
        description: p.description || ''
      })) : [];

      state.socialIntegrations.dribbble = {
        ...state.socialIntegrations.dribbble,
        connected: true,
        username: profile.username || dr.username,
        profile: {
          username: profile.username || dr.username,
          name: profile.name || '',
          html_url: profile.html_url || `https://dribbble.com/${encodeURIComponent(profile.username || dr.username)}`,
          followers_count: profile.followers_count || 0,
          shots_count: profile.shots_count || shots.length
        },
        shots,
        projects,
        lastFetchedAt: Date.now(),
        lastError: ''
      };

      refreshOnboardingUI();
      await _persistIfPossible();
      Toast.success('Dribbble data fetched');
    } catch (e) {
      state.socialIntegrations.dribbble.lastError = e?.message || 'Fetch failed';
      refreshOnboardingUI();
      Toast.error(state.socialIntegrations.dribbble.lastError);
    } finally {
      _setLoading('dribbble', false);
    }
  }

  function renderInPanel(containerId, socialData) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const social = normalizeSocialIntegrations(socialData);
    const hasGitHub = !!social.github.connected;
    const hasDribbble = !!social.dribbble.connected;
    if (!hasGitHub && !hasDribbble) {
      el.innerHTML = '<div class="social-proof-empty">No GitHub or Dribbble data shared yet.</div>';
      return;
    }

    const githubHtml = hasGitHub ? `
      <div class="social-proof-card">
        <div class="social-proof-card-head">
          <span class="social-proof-card-icon"><i data-lucide="github" class="lucide" width="16" height="16"></i></span>
          <div class="social-proof-card-title">GitHub</div>
        </div>
        <div class="social-proof-card-meta">
          ${_esc(social.github.profile?.name || social.github.profile?.login || social.github.username || '')}
          ${social.github.profile?.html_url ? ` · <a href="${_esc(social.github.profile.html_url)}" target="_blank" rel="noopener noreferrer">View</a>` : ''}
          ${social.github.contributions30d ? ` · ${Number(social.github.contributions30d)} recent contributions` : ''}
        </div>
        ${(social.github.repos || []).length ? `
          <ul class="social-proof-list">
            ${social.github.repos.slice(0, 3).map(r => `<li><a href="${_esc(r.html_url || '#')}" target="_blank" rel="noopener noreferrer">${_esc(r.name || 'Repository')}</a></li>`).join('')}
          </ul>
        ` : '<div class="social-proof-empty">No repositories fetched.</div>'}
      </div>` : '';

    const dribbbleHtml = hasDribbble ? `
      <div class="social-proof-card">
        <div class="social-proof-card-head">
          <span class="social-proof-card-icon"><i data-lucide="dribbble" class="lucide" width="16" height="16"></i></span>
          <div class="social-proof-card-title">Dribbble</div>
        </div>
        <div class="social-proof-card-meta">
          ${_esc(social.dribbble.profile?.name || social.dribbble.profile?.username || social.dribbble.username || '')}
          ${(social.dribbble.profile?.html_url || social.dribbble.username) ? ` · <a href="${_esc(social.dribbble.profile?.html_url || ('https://dribbble.com/' + social.dribbble.username))}" target="_blank" rel="noopener noreferrer">View</a>` : ''}
        </div>
        ${(social.dribbble.shots || []).length ? `
          <ul class="social-proof-list">
            ${social.dribbble.shots.slice(0, 3).map(s => `<li><a href="${_esc(s.html_url || '#')}" target="_blank" rel="noopener noreferrer">${_esc(s.title || 'Shot')}</a></li>`).join('')}
          </ul>
        ` : '<div class="social-proof-empty">No shots fetched.</div>'}
      </div>` : '';

    el.innerHTML = `<div class="social-proof-wrap">${githubHtml}${dribbbleHtml}</div>`;
  }

  function init() {
    const ghInput = document.getElementById('github-username-input');
    const drInput = document.getElementById('dribbble-username-input');
    if (ghInput) ghInput.value = state.socialIntegrations?.github?.username || '';
    if (drInput) drInput.value = state.socialIntegrations?.dribbble?.username || '';
    document.getElementById('github-connect-btn')?.addEventListener('click', connectGithub);
    document.getElementById('github-fetch-btn')?.addEventListener('click', fetchGithubData);
    document.getElementById('dribbble-connect-btn')?.addEventListener('click', connectDribbble);
    document.getElementById('dribbble-fetch-btn')?.addEventListener('click', fetchDribbbleData);
    refreshOnboardingUI();
  }

  return { init, refreshOnboardingUI, renderInPanel };
})();

setTimeout(() => { try { SocialIntegrationsModule.init(); } catch(_) {} }, 0);


// ── STEP 5 FINAL SUBMIT: Save everything to Firebase (same logic as before)
$('save-username-btn').addEventListener('click', async () => {
  // Get username from step 1 input
  const raw = $('username-input').value.trim().toLowerCase();
  const n = raw.replace(/[^a-z0-9_]/g, '');

  // Get skill from state (set when user clicked a skill card in step 2)
  const sk = state.setupSelectedSkill || 'Explorer';

  // Get level from hidden input (set when user clicked a level card in step 3)
  const lv = $('setup-level-input').value || 'Beginner';

  // Get bio from step 4
  const bio = $('setup-bio-input').value.trim();

  // Basic validation (shouldn't be needed since steps already validated, but just in case)
  if (n.length < CONFIG.MIN_USERNAME_LENGTH) {
    Toast.error('Something went wrong — please go back to step 1');
    showOnboardStep(1);
    return;
  }

  // ── BLOCK SIGNUPS IF ADMIN HAS DISABLED THEM ──
  if (state._signupsEnabled === false) {
    Toast.error('New signups are currently disabled. Please try again later.');
    return;
  }

  const btn = $('save-username-btn');
  btn.textContent = 'Launching...';
  btn.disabled = true;

  try {
    // Double-check username isn't taken (safety check)
    const snap = await get(ref(db, 'usernames/' + n));
    if (snap.exists()) {
      Toast.error('Username was just taken — please pick a new one');
      showOnboardStep(1);
      btn.innerHTML = '<i data-lucide="rocket" class="lucide" width="16" height="16"></i> Enter Golex';
      btn.disabled = false;
      return;
    }

    // Reserve username
    await set(ref(db, 'usernames/' + n), state.currentUser.uid);

    // Save user data to Firebase
    // Serialize expertise safely — null if nothing selected
    const expertiseData = (typeof ExpertiseModule !== 'undefined' && ExpertiseModule.serialize)
      ? ExpertiseModule.serialize()
      : null;
    const socialData = normalizeSocialIntegrations(state.socialIntegrations);

    await set(ref(db, 'users/' + state.currentUser.uid), {
      username: n,
      email: state.currentUser.email,
      status: 'online',
      lastSeen: serverTimestamp(),
      skill: sk,
      level: lv,
      points: 0,
      bio: bio,
      tags: state.setupTags.slice(),
      goals: state.goals.slice(),
      availability: state.availability.slice(),
      expertise: expertiseData,
      socialIntegrations: socialData,
      createdAt: serverTimestamp()
    });

    // Update app state
    Object.assign(state, {
      username: n,
      skill: sk,
      level: lv,
      bio: bio,
      tags: state.setupTags.slice(),
      expertise: expertiseData,
      socialIntegrations: socialData
    });

    // Update UI
    const ph = getProfilePicUrl(null, state.currentUser.uid);
    $('profile-icon-btn').src = ph;
    $('modal-avatar').src = ph;
    $('modal-email').textContent = state.currentUser.email;

    managePresence(state.currentUser.uid);
    checkProfileBanner();
    loadDirectory();
    ScreenManager.show('user-list-screen');
    showNavBar();
    // Initialize new systems for fresh user
    FollowSystem.init(state.currentUser.uid);
    StoriesSystem.init();

    Toast.success('Welcome to Golex!');
  } catch (e) {
    Toast.error('Error saving profile — please try again');
    DEBUG && console.error('[Onboarding Save]', e);
  } finally {
    btn.innerHTML = '<i data-lucide="rocket" class="lucide" width="16" height="16"></i> Enter Golex';
    btn.disabled = false;
  }
});

// ── Reset onboarding to step 1 when user-screen is shown
// (So if user logs out and logs back in, they start from step 1 again)
const _origScreenManagerShow = ScreenManager.show.bind(ScreenManager);
// We patch this by resetting step when username-screen is activated
const _onboardObserver = new MutationObserver(() => {
  const us = document.getElementById('username-screen');
  if (us && us.classList.contains('active')) {
    showOnboardStep(1);
    // Reset skill card selections
    document.querySelectorAll('#setup-skill-grid .skill-card').forEach(c => c.classList.remove('selected'));
    // Reset level card selections
    document.querySelectorAll('#setup-level-cards .level-card').forEach(c => c.classList.remove('selected'));
    // Reset hidden inputs
    const si = document.getElementById('setup-skill-input');
    const li = document.getElementById('setup-level-input');
    if (si) si.value = '';
    if (li) li.value = 'Beginner';
    state.setupSelectedSkill = null;
    // Reset expertise module (safe guard — only runs if module is ready)
    if (typeof ExpertiseModule !== 'undefined' && ExpertiseModule.reset) {
      try { ExpertiseModule.reset(); } catch(e) {}
    }
    state.socialIntegrations = getEmptySocialIntegrations();
    if (typeof SocialIntegrationsModule !== 'undefined' && SocialIntegrationsModule.refreshOnboardingUI) {
      try { SocialIntegrationsModule.refreshOnboardingUI(); } catch(_) {}
    }
  }
});
_onboardObserver.observe(document.getElementById('username-screen'), { attributes: true, attributeFilter: ['class'] });


// ── Export to window ──
Object.assign(window, {
  setupConnectionMonitor, managePresence, isUserTrulyOnline,
  loadAndApplyFeatureFlags, ExpertiseModule, SocialIntegrationsModule,
  showOnboardStep
});
