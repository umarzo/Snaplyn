const { state, $, $$, escHtml, Toast, auth, db, ref, get, set, update,
  serverTimestamp, CONFIG } = window;

/* ════════════════════════════════════════════════════════════════
   GOLEX PRO MEDIA SYSTEM
   Manages enhanced audio/video quality and file limits for Pro.

   DESIGN RATIONALE:
   ─ Audio: Pro gets explicit 48kHz stereo Opus constraints + 128kbps
     bitrate set on the RTCRtpSender after ICE connects. Free gets
     standard echo-cancelled mono (~32kbps Opus browser default).
   ─ Video DMs: Pro gets 720p (1280×720). Free stays at 480p (854×480).
   ─ Video Projects: Pro gets 1080p (1920×1080). Free stays at 720p.
   ─ Bitrate enforcement uses RTCRtpSender.setParameters() which is
     a real-time in-call operation — no renegotiation needed.
   ─ File uploads: Pro gets 2× the byte limit at every check point.
   ─ Voice recording: Pro gets 120s, free gets 60s.
   ════════════════════════════════════════════════════════════════ */
const ProMedia = {

  // ─── Audio constraints ─────────────────────────────────────────
  // Free: clean echo/noise cancelled mono (better than raw default)
  FREE_AUDIO_CONSTRAINTS: {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1
    },
    video: false
  },

  // Pro: studio-grade 48kHz stereo with AGC off (flat response)
  PRO_AUDIO_CONSTRAINTS: {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false,   // flat, uncolored signal
      sampleRate: 48000,
      channelCount: 2,          // stereo
      latency: 0.01             // low-latency hint
    },
    video: false
  },

  // ─── Video constraints ─────────────────────────────────────────
  // DM calls
  DM_VIDEO_FREE: {
    video: { facingMode: 'user', width: { ideal: 854 },  height: { ideal: 480 }, frameRate: { ideal: 30 } },
    audio: false
  },
  DM_VIDEO_PRO: {
    video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    audio: false
  },

  // Project calls
  PROJ_VIDEO_FREE: {
    video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720  }, frameRate: { ideal: 30, max: 30 } },
    audio: false
  },
  PROJ_VIDEO_PRO: {
    video: { facingMode: 'user', width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } },
    audio: false
  },

  // ─── Bitrate targets (bps) ─────────────────────────────────────
  AUDIO_BITRATE_FREE: 32000,    // ~32kbps  — browser default Opus
  AUDIO_BITRATE_PRO:  128000,   // 128kbps  — Discord Nitro equivalent
  VIDEO_BITRATE_FREE_DM:   800000,   // 800kbps  — good 480p
  VIDEO_BITRATE_PRO_DM:   2500000,   // 2.5Mbps  — crisp 720p
  VIDEO_BITRATE_FREE_PROJ: 1500000,  // 1.5Mbps  — good 720p
  VIDEO_BITRATE_PRO_PROJ:  5000000,  // 5Mbps    — 1080p broadcast quality

  // ─── File size limits ──────────────────────────────────────────
  FILE_KB_FREE:  500,   // 500KB  (CONFIG.MAX_FILE_KB)
  FILE_KB_PRO:   1000,  // 1MB    (2×)
  IMAGE_KB_FREE: 400,   // 400KB  (CONFIG.MAX_IMAGE_KB)
  IMAGE_KB_PRO:  800,   // 800KB  (2×)
  AUDIO_SEC_FREE: 60,   // 60s    (CONFIG.MAX_AUDIO_SECONDS)
  AUDIO_SEC_PRO:  120,  // 120s   (2×)

  // ─── Helpers ───────────────────────────────────────────────────
  isPro() { return state.isPro === true && (!state.proExpiry || state.proExpiry > Date.now()); },

  getAudioConstraints()    { return this.isPro() ? this.PRO_AUDIO_CONSTRAINTS    : this.FREE_AUDIO_CONSTRAINTS; },
  getDMVideoConstraints()  { return this.isPro() ? this.DM_VIDEO_PRO             : this.DM_VIDEO_FREE; },
  getProjVideoConstraints(){ return this.isPro() ? this.PROJ_VIDEO_PRO           : this.PROJ_VIDEO_FREE; },

  getMaxFileBytes()        { return (this.isPro() ? this.FILE_KB_PRO  : this.FILE_KB_FREE)  * 1024; },
  getMaxFileMB()           { return this.isPro() ? '1MB'  : '500KB'; },
  getMaxImageBytes()       { return (this.isPro() ? this.IMAGE_KB_PRO : this.IMAGE_KB_FREE) * 1024; },
  getMaxAudioSec()         { return this.isPro() ? this.AUDIO_SEC_PRO : this.AUDIO_SEC_FREE; },

  // DM video flip (same resolution tier as the initial call)
  getDMVideoFlipConstraints(facingMode) {
    const base = this.isPro() ? this.DM_VIDEO_PRO : this.DM_VIDEO_FREE;
    return { video: { ...base.video, facingMode: { exact: facingMode } }, audio: false };
  },
  getDMVideoFlipFallbackConstraints(facingMode) {
    const base = this.isPro() ? this.DM_VIDEO_PRO : this.DM_VIDEO_FREE;
    return { video: { ...base.video, facingMode }, audio: false };
  },

  // ─── Apply audio bitrate to an RTCPeerConnection's audio sender ─
  async applyAudioEncoding(pc) {
    if (!pc) return;
    try {
      const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
      if (!sender) return;
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      const target = this.isPro() ? this.AUDIO_BITRATE_PRO : this.AUDIO_BITRATE_FREE;
      params.encodings[0].maxBitrate = target;
      await sender.setParameters(params);
      DEBUG && console.log('[ProMedia] Audio bitrate set to', target/1000 + 'kbps');
    } catch(e) {
      DEBUG && console.warn('[ProMedia] Audio setParameters failed (non-fatal):', e.message);
    }
  },

  // ─── Apply video bitrate to an RTCPeerConnection's video sender ─
  async applyVideoEncoding(pc, isProject) {
    if (!pc) return;
    try {
      const sender = pc.getSenders().find(s => s.track?.kind === 'video');
      if (!sender) return;
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      let target;
      if (isProject) {
        target = this.isPro() ? this.VIDEO_BITRATE_PRO_PROJ : this.VIDEO_BITRATE_FREE_PROJ;
      } else {
        target = this.isPro() ? this.VIDEO_BITRATE_PRO_DM : this.VIDEO_BITRATE_FREE_DM;
      }
      params.encodings[0].maxBitrate = target;
      params.encodings[0].scaleResolutionDownBy = 1.0; // no scaling
      await sender.setParameters(params);
      DEBUG && console.log('[ProMedia] Video bitrate set to', Math.round(target/1000) + 'kbps');
    } catch(e) {
      DEBUG && console.warn('[ProMedia] Video setParameters failed (non-fatal):', e.message);
    }
  },

  // ─── Show quality badge in DM call overlay ─────────────────────
  showCallQualityBadge(hasVideo) {
    const badge = document.getElementById('call-quality-badge');
    if (!badge) return;
    if (this.isPro()) {
      badge.className = 'pro-hd';
      badge.textContent = hasVideo ? '⭐ Pro · 720p HD' : '⭐ Pro · 128kbps Audio';
    } else {
      badge.className = 'free-hd';
      badge.textContent = hasVideo ? '480p' : 'Voice';
    }
  },

  // ─── Show quality badge in project call ────────────────────────
  showProjCallQualityBadge(hasVideo) {
    const badge = document.getElementById('proj-call-quality-badge');
    if (!badge) return;
    if (this.isPro()) {
      badge.className = 'pro-hd';
      badge.textContent = hasVideo ? '⭐ 1080p HD' : '⭐ 128kbps';
    } else {
      badge.className = 'free-hd';
      badge.textContent = hasVideo ? '720p' : 'Voice';
    }
  },

  // ─── Apply encoding to all senders after call connects ─────────
  // Called from startCallTimer (DM calls) and proj call connected handler
  async applyAllEncodings(pc, isProject) {
    if (!pc) return;
    await this.applyAudioEncoding(pc);
    // video encoding applied when video is enabled, not upfront
    DEBUG && console.log('[ProMedia] Encoding applied. Pro:', this.isPro(), '| Context:', isProject ? 'project' : 'DM');
  }
};
/* END GOLEX PRO MEDIA SYSTEM */

function cleanupAllListeners() {
  // Stop chat listeners
  cleanupChatListeners();

  // Stop directory listeners
  cleanupDirectoryListeners();

  // Stop guild listeners
  cleanupGuildListeners();

  // Stop room chat listeners
  if (typeof RoomSystem !== 'undefined' && RoomSystem.leaveRoomChat) {
    RoomSystem.leaveRoomChat();
  }

  // Stop community post listeners
  if (typeof cleanupCommPostListeners === 'function') {
    cleanupCommPostListeners();
  }

  // Stop project workspace listeners
  if (typeof ProjectSystem !== 'undefined' && ProjectSystem._leaveWorkspace) {
    ProjectSystem._leaveWorkspace();
  }

  // Stop notification listener
  NotifSystem.stop();

  // Stop Follow System listener
  FollowSystem.stop();

  // Stop Stories System
  StoriesSystem.stop();

  // Stop explore (platform posts) listener
  if (typeof _exploreUnsubscribe === 'function') {
    _exploreUnsubscribe();
    _exploreUnsubscribe = null;
  }

  // Stop leaderboard listener
  if (typeof _lbUnsubscribe === 'function') {
    _lbUnsubscribe();
    _lbUnsubscribe = null;
  }

  // Stop any active call listeners
  if (state._unsubVideoRequest)       { state._unsubVideoRequest();       state._unsubVideoRequest = null; }
  if (state._unsubRenegotiate)        { state._unsubRenegotiate();        state._unsubRenegotiate = null; }
  if (state._unsubRenegotiationAnswer){ state._unsubRenegotiationAnswer();state._unsubRenegotiationAnswer = null; }
  if (state._unsubReceiverAnswer)     { state._unsubReceiverAnswer();     state._unsubReceiverAnswer = null; }
  if (state._unsubReceiverRenegotiate){ state._unsubReceiverRenegotiate();state._unsubReceiverRenegotiate = null; }
  if (state._unsubIceCaller)          { state._unsubIceCaller();          state._unsubIceCaller = null; }
  if (state._unsubIceReceiver)        { state._unsubIceReceiver();        state._unsubIceReceiver = null; }

  // Clear in-memory caches
  state.usersCache.clear();
  cleanupTimestamps.clear();
  state.renderedMsgIds.clear();
  state.directoryListeners.clear();

  // Clear heartbeat
  if (state.heartbeatInterval) {
    clearInterval(state.heartbeatInterval);
    state.heartbeatInterval = null;
  }

  // Reset key state fields
  state.currentUser = null;
  state.username = '';
  state.chatId = null;
  state.pfpUrl = '';
  state.pfpChangedAt = null;
  state.socialIntegrations = getEmptySocialIntegrations();
  state.isMuted = false;
}



/* ═══════════════════════════════════════════════════════════════════
   GOLEX PRO SYSTEM  v1.0
   ═══════════════════════════════════════════════════════════════════ */

/* ─── Configuration ─────────────────────────────────────────────── */
const GOLEX_PRO = {
  /* ▼▼▼ PASTE YOUR RAZORPAY KEY ID HERE ▼▼▼ */
  RAZORPAY_KEY: 'rzp_test_ShoodKFduogCOK',
  /* ▲▲▲ Get from: razorpay.com → Settings → API Keys ▲▲▲ */
  AMOUNT_PAISE: 9900,   // ₹99 in paise
  DAYS: 30,
  CURRENCY: 'INR',
  NAME: 'Golex'
};

/* ─── Expiry check: runs silently on every login ─────────────────── */
async function checkProExpiry(uid) {
  if (!uid || !state.proExpiry) return;
  if (state.proExpiry < Date.now()) {
    try {
      await update(ref(db, `users/${uid}`), { isPro: false });
      state.isPro = false;
    } catch(e) { /* non-fatal */ }
  }
}

/* ─── Pro modal open/close ───────────────────────────────────────── */
function openProModal() {
  document.getElementById('pro-upgrade-modal')?.classList.add('open');
}
function closeProModal() {
  document.getElementById('pro-upgrade-modal')?.classList.remove('open');
}

/* ─── Activate Pro after Razorpay success ───────────────────────── */
async function activateGolexPro(paymentId) {
  const uid = state.currentUser?.uid;
  if (!uid) return;
  const now    = Date.now();
  const expiry = now + GOLEX_PRO.DAYS * 86400000;
  try {
    const batch = {};
    batch[`users/${uid}/isPro`]          = true;
    batch[`users/${uid}/proSince`]       = state.proSince || now;
    batch[`users/${uid}/proExpiry`]      = expiry;
    batch[`users/${uid}/proPaymentId`]   = paymentId;
    await update(ref(db), batch);
    /* Local state */
    state.isPro      = true;
    state.proSince   = state.proSince || now;
    state.proExpiry  = expiry;
    /* HQ activation log */
    push(ref(db, 'hq/proActivations'), {
      uid, username: state.username || '', email: state.currentUser.email || '',
      paymentId, activatedAt: now, expiry
    }).catch(() => {});
    /* Update directory card glow immediately */
    const myCard = document.getElementById('u-' + uid);
    if (myCard) { myCard.classList.add('is-pro'); myCard.dataset.isPro = '1'; sortUserList(); }
    closeProModal();
    renderProStatusUI();
    Toast.success('<i data-lucide="award" class="lucide" width="16" height="16"></i> Golex Pro is active! Welcome to Pro.', 6000);
  } catch (e) {
    Toast.error('Activation error — save this payment ID and contact us: ' + paymentId);
    DEBUG && console.error('[GolexPro] activateGolexPro error:', e);
  }
}

/* ─── Launch Razorpay checkout ───────────────────────────────────── */
function launchRazorpay() {
  if (!state.currentUser) { Toast.error('Please sign in first.'); return; }
  const btn = document.getElementById('pro-pay-btn');
  if (GOLEX_PRO.RAZORPAY_KEY === 'YOUR_RAZORPAY_KEY_ID') {
    Toast.error('Add your Razorpay key to GOLEX_PRO.RAZORPAY_KEY in the code before going live.');
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = 'Opening payment...'; }
  const rzp = new Razorpay({
    key:         GOLEX_PRO.RAZORPAY_KEY,
    amount:      GOLEX_PRO.AMOUNT_PAISE,
    currency:    GOLEX_PRO.CURRENCY,
    name:        GOLEX_PRO.NAME,
    description: 'Golex Pro — 30 Day Membership',
    prefill: {
      email:   state.currentUser.email || '',
      name:    state.username || '',
      contact: ''
    },
    theme: { color: '#F59E0B' },
    handler: async (res) => {
      if (btn) { btn.textContent = 'Activating...'; }
      await activateGolexPro(res.razorpay_payment_id);
      if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="zap" class="lucide" width="16" height="16"></i> Pay ₹99 and Activate Pro'; }
    },
    modal: {
      ondismiss: () => {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="zap" class="lucide" width="16" height="16"></i> Pay ₹99 and Activate Pro'; }
      }
    }
  });
  rzp.on('payment.failed', (res) => {
    Toast.error('Payment failed: ' + (res.error?.description || 'Try again.'));
    if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="zap" class="lucide" width="16" height="16"></i> Pay ₹99 and Activate Pro'; }
  });
  rzp.open();
}

/* ─── renderProStatusUI: updates the Pro panel inside own modal ─── */
function renderProStatusUI() {
  const panel = document.getElementById('pro-status-panel');
  if (!panel) return;
  const now      = Date.now();
  const isPro    = state.isPro;
  const expiry   = state.proExpiry;
  const since    = state.proSince;
  const expired  = expiry && expiry < now;
  const nearExp  = expiry && expiry > now && (expiry - now) < 7 * 86400000;

  if (isPro && !expired) {
    panel.classList.remove('inactive');
    const sinceStr  = since  ? new Date(since).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'}) : '';
    const expiryStr = expiry ? new Date(expiry).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'}) : '';
    panel.innerHTML = `
      <div class="pro-status-title"><i data-lucide="award" class="lucide" width="18" height="18"></i> Golex Pro — Active</div>
      <div class="pro-status-desc">Your Pro membership is active. Enjoy priority placement, featured ads, and your gold badge across the app.</div>
      ${sinceStr  ? `<div class="pro-status-expiry" style="color:var(--muted)">Member since: ${sinceStr}</div>` : ''}
      ${expiryStr ? `<div class="pro-status-expiry" style="color:${nearExp?'#EF4444':'var(--muted)'}">
        ${nearExp ? 'Expires soon: ' : 'Valid until: '}${expiryStr}</div>` : ''}
      ${nearExp   ? `<button class="pro-upgrade-btn pro-renew-btn" id="pro-renew-btn" type="button"><i data-lucide="refresh-cw" class="lucide" width="16" height="16"></i> Renew for ₹99</button>` : ''}
    `;
    document.getElementById('pro-renew-btn')?.addEventListener('click', openProModal);
  } else {
    panel.classList.add('inactive');
    panel.innerHTML = `
      <div style="color:var(--muted);font-size:11px;font-family:var(--font-mono);font-weight:800;letter-spacing:1.2px;text-transform:uppercase;margin-bottom:4px;">
        ${expired ? 'Golex Pro — Expired' : 'Golex Pro'}
      </div>
      <div class="pro-status-desc">${expired
        ? 'Your Pro membership has expired. Renew for ₹99 to restore your badge, boosted listing, and featured ads.'
        : 'Upgrade to Pro for ₹99/month — gold badge, HD video calls, studio audio, 2× uploads, and more.'
      }</div>
      <button class="pro-upgrade-btn" id="pro-upgrade-btn-profile" type="button">
        ${expired ? '<i data-lucide="refresh-cw" class="lucide" width="16" height="16"></i> Renew Pro — ₹99' : '<i data-lucide="zap" class="lucide" width="16" height="16"></i> Upgrade to Pro — ₹99/mo'}
      </button>
    `;
    document.getElementById('pro-upgrade-btn-profile')?.addEventListener('click', openProModal);
  }
  /* Sync Pro-only fields visibility */
  const tagField = document.getElementById('modal-tagline-field');
  const viewPan  = document.getElementById('pro-views-panel');
  const bioEl    = document.getElementById('modal-bio-input');
  const bioHint  = document.getElementById('bio-pro-hint');
  if (isPro && !expired) {
    if (tagField) tagField.style.display = 'block';
    if (viewPan)  { viewPan.style.display = 'block'; loadProViewCount(); }
    if (bioEl)    bioEl.maxLength = 500;
    if (bioHint)  bioHint.textContent = '500 chars (Pro)';
  } else {
    if (tagField) tagField.style.display = 'none';
    if (viewPan)  viewPan.style.display  = 'none';
    if (bioEl)    bioEl.maxLength = 200;
    if (bioHint)  bioHint.textContent = '';
  }
}

/* ─── Profile view count for Pro analytics panel ────────────────── */
async function loadProViewCount() {
  const el = document.getElementById('pro-views-count');
  if (!el || !state.currentUser) return;
  try {
    const snap = await get(ref(db, `profileViews/${state.currentUser.uid}`));
    el.textContent = snap.exists() ? Object.keys(snap.val() || {}).length : 0;
  } catch(e) { el.textContent = '—'; }
}

/* ─── Wire up modal buttons ──────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('pro-modal-close')?.addEventListener('click', closeProModal);
  document.getElementById('pro-pay-btn')?.addEventListener('click', launchRazorpay);
  document.getElementById('pro-upgrade-modal')?.addEventListener('click', e => {
    if (e.target.id === 'pro-upgrade-modal') closeProModal();
  });
});
/* fallback for late-running scripts */
setTimeout(() => {
  document.getElementById('pro-modal-close')?.addEventListener('click', closeProModal);
  document.getElementById('pro-pay-btn')?.addEventListener('click', launchRazorpay);
  document.getElementById('pro-upgrade-modal')?.addEventListener('click', e => {
    if (e.target.id === 'pro-upgrade-modal') closeProModal();
  });
}, 200);
/* ══════════════════════════════════════════════════════════════════ */

// ── Export to window ──
Object.assign(window, { GOLEX_PRO, GoProMedia, openProModal, closeProModal });
