const { state, $, $$, escHtml, badgeHTML, generateAvatarUrl, timeAgo, debounce,
  db, ref, get, set, update, push, serverTimestamp, off, onValue, remove,
  deleteUser, reauthenticateWithPopup, GoogleAuthProvider, auth,
  CONFIG, Toast, ScreenManager, IDB, openUserProfileSheet,
  cleanupAllListeners, cacheUser, getUserCached } = window;

/* ═══════════════════════════════════════════════════
   SKILL ENDORSEMENTS
   Path: endorsements/$targetUid/$endorserUid = { skill, timestamp }
   One endorsement per pair per skill. Reloaded when info panel opens.
   ═══════════════════════════════════════════════════ */
async function loadEndorsements(targetUid, targetSkill) {
  const btn = document.getElementById('endorse-btn');
  const countEl = document.getElementById('info-endorse-count');
  if (!btn || !countEl || !state.currentUser) return;

  if (targetUid === state.currentUser.uid) {
    btn.style.display = 'none'; // Can't endorse yourself
    countEl.textContent = '—';
    return;
  }
  btn.style.display = 'flex';
  btn.disabled = true;
  btn.innerHTML = '<i data-lucide="loader" class="lucide" width="16" height="16"></i> Loading...';
  lucideCreate();


  try {
    const snap = await get(ref(db, `endorsements/${targetUid}`));
    const endorsements = snap.val() || {};
    const count = Object.keys(endorsements).length;
    countEl.textContent = count;

    const alreadyEndorsed = !!endorsements[state.currentUser.uid];
    btn.disabled = false;
    if (alreadyEndorsed) {
      btn.className = 'endorse-btn endorsed';
      btn.innerHTML = '<i data-lucide="check-circle" class="lucide" width="16" height="16"></i> Endorsed ✓';
    } else {
      btn.className = 'endorse-btn';
      btn.innerHTML = '<i data-lucide="award" class="lucide" width="16" height="16"></i> Endorse their skill';
    }
    lucideCreate();


    // Wire up click — replace to clear old listeners
    const newBtn = btn.cloneNode(true);
    btn.replaceWith(newBtn);
    newBtn.addEventListener('click', () => handleEndorse(targetUid, targetSkill, alreadyEndorsed, newBtn, countEl));
  } catch (e) {
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="award" class="lucide" width="16" height="16"></i> Endorse skill';
    lucideCreate();

  }
}

async function handleEndorse(targetUid, targetSkill, isEndorsed, btn, countEl) {
  if (!state.currentUser || targetUid === state.currentUser.uid) return;
  btn.disabled = true;

  const endorseRef = ref(db, `endorsements/${targetUid}/${state.currentUser.uid}`);
  const pointsRef = ref(db, `users/${targetUid}/points`);

  try {
    if (isEndorsed) {
      // Remove endorsement
      await remove(endorseRef);
      await update(ref(db, `users/${targetUid}`), { points: increment(-5) });
      const cur = parseInt(countEl.textContent) || 1;
      countEl.textContent = Math.max(0, cur - 1);
      btn.className = 'endorse-btn';
      btn.innerHTML = '<i data-lucide="award" class="lucide" width="16" height="16"></i> Endorse their skill';
      btn.disabled = false;
      btn.addEventListener('click', () => handleEndorse(targetUid, targetSkill, false, btn, countEl));
      Toast.info('Endorsement removed');
    } else {
      // Add endorsement
      await set(endorseRef, { skill: targetSkill, timestamp: Date.now(), endorserUsername: state.username });
      // Award 5 points to the endorsed user
      await update(ref(db, `users/${targetUid}`), { points: increment(5) });
      const cur = parseInt(countEl.textContent) || 0;
      countEl.textContent = cur + 1;
      btn.className = 'endorse-btn endorsed';
      btn.innerHTML = '<i data-lucide="check-circle" class="lucide" width="16" height="16"></i> Endorsed ✓';
      btn.disabled = false;
      btn.addEventListener('click', () => handleEndorse(targetUid, targetSkill, true, btn, countEl));
      Toast.success('Skill endorsed! +5 rep to them ⭐');
// Push notification to the endorsed user
      NotifSystem.push(targetUid, 'endorse', `@${state.username || 'Someone'} endorsed your ${targetSkill} skill! +5 rep ⭐`);
    }
    lucideCreate();

  } catch (e) {
    btn.disabled = false;
    Toast.error('Could not update endorsement');
  }
}

/* ═══════════════════════════════════════════════════
   REPORT USER / POST MODAL
   ═══════════════════════════════════════════════════ */
const ReportModal = {
  _context: null,  // { targetUid, targetUsername, targetType, targetPostId, contentPreview }

  open(ctx) {
    if (!state.currentUser) { Toast.error('You must be logged in to report.'); return; }
    this._context = ctx;

    // Update modal label to say "User" or "Post"
    const labelEl = document.getElementById('report-modal-target-label');
    if (labelEl) labelEl.textContent = ctx.targetType === 'post' ? 'Post' : 'User';

    // Reset state
    document.querySelectorAll('.report-reason-btn').forEach(b => b.classList.remove('selected'));
    const detailWrap = document.getElementById('report-detail-wrap');
    const detailInput = document.getElementById('report-detail-input');
    const submitBtn = document.getElementById('report-modal-submit');
    if (detailWrap) detailWrap.classList.remove('visible');
    if (detailInput) detailInput.value = '';
    if (submitBtn) submitBtn.disabled = true;

    document.getElementById('report-modal-overlay').classList.add('active');
  },

  close() {
    document.getElementById('report-modal-overlay').classList.remove('active');
    this._context = null;
  },

  async submit() {
    if (!this._context || !state.currentUser) return;
    const selectedBtn = document.querySelector('.report-reason-btn.selected');
    if (!selectedBtn) { Toast.error('Please select a reason.'); return; }

    const reason = selectedBtn.dataset.reason;
    const details = (document.getElementById('report-detail-input')?.value || '').trim();
    const submitBtn = document.getElementById('report-modal-submit');
    const origText = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting…';

    try {
     const reportData = {
        reason,
        details: details || '',
        reporterUid: state.currentUser.uid,
        reporterUsername: state.username || '',
        targetType: this._context.targetType || 'user',
        targetUid: this._context.targetUid || '',
        targetUsername: this._context.targetUsername || '',
        contentPreview: this._context.contentPreview || '',
        status: 'pending',
        ts: Date.now()
      };
      if (this._context.targetPostId) {
        reportData.targetPostId = this._context.targetPostId;
      }
      // Chat message reports
      if (this._context.targetType === 'chat_message') {
        reportData.chatId = this._context.chatId || '';
        reportData.messageId = this._context.messageId || '';
        reportData.messageContentPreview = this._context.messageContentPreview || '';
      }

      await push(ref(db, 'hq/reports'), reportData);
      Toast.success('Report submitted. Thank you!');
      this.close();
    } catch (e) {
      Toast.error('Failed to submit report: ' + (e.message || 'Unknown error'));
      submitBtn.disabled = false;
      submitBtn.textContent = origText;
    }
  }
};

// Wire up report modal reason buttons
document.querySelectorAll('.report-reason-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.report-reason-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    const detailWrap = document.getElementById('report-detail-wrap');
    const submitBtn = document.getElementById('report-modal-submit');
    if (detailWrap) detailWrap.classList.add('visible');
    if (submitBtn) submitBtn.disabled = false;
  });
});

document.getElementById('report-modal-cancel')?.addEventListener('click', () => ReportModal.close());
document.getElementById('report-modal-submit')?.addEventListener('click', () => ReportModal.submit());
document.getElementById('report-modal-overlay')?.addEventListener('click', (e) => {
  if (e.target === document.getElementById('report-modal-overlay')) ReportModal.close();
});

// Helper exposed globally for easy calling from user-info-panel button
function openReportModal(ctx) { ReportModal.open(ctx); }

// Wire up "Report User" button in user-info-panel
// report-user-btn now handled by IQP panel (iqp-report)
document.getElementById('report-user-btn')?.addEventListener('click', () => {
  if (!state.chatPartnerId || !state.chatPartnerUsername) return;
  openReportModal({ targetUid: state.chatPartnerId, targetUsername: state.chatPartnerUsername, targetType: 'user', contentPreview: '' });
});
/* ═══════════════════════════════════════════════════
   SYSTEM NOTIFICATIONS INBOX
   ═══════════════════════════════════════════════════ */
const NotifSystem = {
  _unsub: null,
  _prevKeys: new Set(),

  init(uid) {
    if (this._unsub) { this._unsub(); this._unsub = null; }
    this._prevKeys = new Set();
    // Show skeleton immediately
    const list = document.getElementById('notif-list');
    if (list) {
      list.innerHTML = [0,1,2,3].map(i => `
        <div class="skel-notif-item">
          <div class="skel skel-circle" style="width:36px;height:36px;flex-shrink:0;"></div>
          <div class="skel-notif-body">
            <div class="skel skeleton-line xs" style="width:${60+(i%3)*20}px;margin-bottom:5px;"></div>
            <div class="skel skeleton-line lg" style="width:${120+(i%4)*25}px;margin-bottom:4px;"></div>
            <div class="skel skeleton-line sm" style="width:${80+(i%2)*30}px;margin-bottom:4px;"></div>
            <div class="skel skeleton-line xs" style="width:50px;"></div>
          </div>
        </div>`).join('');
    }
    const nRef = ref(db, `users/${uid}/notifications`);
    this._unsub = onValue(nRef, snap => {
      const data = snap.val() || {};
      this._render(data, uid);
      this._updateBadge(data);
    });
  },

  stop() {
    if (this._unsub) { this._unsub(); this._unsub = null; }
  },

  _render(data, uid) {
    const list = document.getElementById('notif-list');
    if (!list) return;

    const entries = Object.entries(data).sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
    if (entries.length === 0) {
      list.innerHTML = `
        <div class="notif-panel-empty">
          <div class="notif-panel-empty-icon"><i data-lucide="bell" class="lucide" width="48" height="48"></i></div>
          <div class="notif-panel-empty-title">All caught up!</div>
          <div class="notif-panel-empty-sub">Endorsements, messages and activity will appear here</div>
        </div>`;
      return;
    }

    // Check for newly arrived notifications and show banner
    entries.forEach(([key, notif]) => {
      if (!this._prevKeys.has(key) && this._prevKeys.size > 0 && !notif.read) {
        this._showBanner(notif);
      }
      this._prevKeys.add(key);
    });

    // Type metadata
    const typeConfig = {
      endorse: { icon: 'star', label: 'Endorsement', cssType: 'endorse' },
      message: { icon: 'message-circle', label: 'Message', cssType: 'message' },
      like:    { icon: 'heart', label: 'Like', cssType: 'like' },
      comment: { icon: 'message-circle', label: 'Comment', cssType: 'comment' },
      system:  { icon: 'megaphone', label: 'System', cssType: 'system' },
      follow:  { icon: 'user-plus', label: 'New Follower', cssType: 'endorse' },
      comm_reply:      { icon: 'message-circle', label: 'Community Reply', cssType: 'comment' },
      comm_upvote:     { icon: 'arrow-up', label: 'Community Upvote', cssType: 'like' },
      comm_best_answer:{ icon: 'check-circle', label: 'Best Answer', cssType: 'endorse' },
      comm_new_post:   { icon: 'globe', label: 'New Community Post', cssType: 'system' },
    };

    // Separate today vs earlier
    const now = Date.now();
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const todayTs = todayStart.getTime();
    const todayEntries = entries.filter(([,n]) => (n.ts||0) >= todayTs);
    const earlierEntries = entries.filter(([,n]) => (n.ts||0) < todayTs);

    const renderCard = ([key, n]) => {
      const cfg = typeConfig[n.type] || { icon: 'bell', label: 'Notification', cssType: 'default' };
      const title = n.title || (n.type === 'endorse' ? 'New Endorsement' : n.type === 'message' ? 'New Message' : n.type === 'like' ? 'Someone liked your post' : n.type === 'comment' ? 'New Comment' : n.type === 'follow' ? 'New Follower' : n.type === 'comm_reply' ? (n.fromUsername||'Someone') + ' replied in ' + (n.communityName||'a community') : n.type === 'comm_upvote' ? (n.fromUsername||'Someone') + ' upvoted your community post' : n.type === 'comm_best_answer' ? 'Your reply was marked Best Answer' : n.type === 'comm_new_post' ? (n.authorUsername||'Someone') + ' posted in ' + (n.communityName||'a community') : 'Notification');
      const body = n.body || n.text || '';
      return `
        <div class="notif-item ${n.read ? '' : 'unread'}" data-key="${escHtml(key)}">
          <div class="notif-icon type-${cfg.cssType}"><i data-lucide="${cfg.icon || 'bell'}" class="lucide" width="18" height="18"></i></div>
          <div class="notif-body">
            <div class="notif-type-label type-${cfg.cssType}">${cfg.label}</div>
            <div class="notif-title">${escHtml(title)}</div>
            ${body ? `<div class="notif-body-text">${escHtml(body)}</div>` : ''}
            <div class="notif-time">${timeAgo(n.ts)}</div>
          </div>
          ${!n.read ? '<div class="notif-unread-dot"></div>' : ''}
        </div>`;
    };

    let html = '';
    if (todayEntries.length > 0) {
      html += `<div class="notif-section-label">Today</div>`;
      html += todayEntries.map(renderCard).join('');
    }
    if (earlierEntries.length > 0) {
      html += `<div class="notif-section-label">Earlier</div>`;
      html += earlierEntries.map(renderCard).join('');
    }
    list.innerHTML = html;
    // Re-run Lucide so icons inside the notification cards render
    if (typeof lucide !== 'undefined') lucide.createIcons({ nodes: [list] });

    // Click → open detail sheet + mark read
    list.querySelectorAll('.notif-item').forEach(item => {
      item.addEventListener('click', () => {
        const key = item.dataset.key;
        const entry = entries.find(([k]) => k === key);
        if (entry) openNotifDetail(entry[1], key, uid);
        // Mark read
        if (item.classList.contains('unread')) {
          update(ref(db, `users/${uid}/notifications/${key}`), { read: true }).catch(() => {});
          item.classList.remove('unread');
          const dot = item.querySelector('.notif-unread-dot');
          if (dot) dot.remove();
        }
      });
    });
  },

  _updateBadge(data) {
    const unread = Object.values(data).filter(n => !n.read).length;
    const badge = document.getElementById('notif-nav-badge');
    const bellBtn = document.getElementById('chrome-bell-btn');
    const countEl = document.getElementById('notif-panel-count');
    if (badge) {
      if (unread > 0) {
        badge.textContent = unread > 9 ? '9+' : unread;
        badge.classList.add('visible');
      } else {
        badge.classList.remove('visible');
      }
    }
    if (bellBtn) {
      if (unread > 0) bellBtn.classList.add('has-unread');
      else bellBtn.classList.remove('has-unread');
    }
    if (countEl) {
      countEl.textContent = unread > 0 ? `${unread} unread` : 'all read';
      countEl.style.color = unread > 0 ? 'var(--accent-light)' : 'var(--muted)';
      countEl.style.borderColor = unread > 0 ? 'rgba(35, 87, 232, 0.3)' : 'var(--border)';
    }
  },

  _bannerTimer: null,
  _showBanner(notif) {
    const banner = document.getElementById('notif-toast-banner');
    const iconEl = document.getElementById('notif-banner-icon');
    const textEl = document.getElementById('notif-banner-text');
    if (!banner || !iconEl || !textEl) return;
    const icons = { endorse: 'star', message: 'message-circle', system: 'megaphone', like: 'heart', comment: 'message-circle', follow: 'user' };
const iconName = icons[notif.type] || 'bell';
iconEl.innerHTML = `<i data-lucide="${iconName}" class="lucide" width="16" height="16"></i>`;
lucide.createIcons({ nodes: [iconEl] });
    textEl.textContent = notif.title
      ? (notif.body ? `${notif.title} — ${notif.body}` : notif.title)
      : (notif.text || 'New notification');
    banner.classList.add('show');
    clearTimeout(this._bannerTimer);
    this._bannerTimer = setTimeout(() => banner.classList.remove('show'), 5000);
  },

  async markAllRead(uid) {
    try {
      const snap = await get(ref(db, `users/${uid}/notifications`));
      if (!snap.exists()) { return; }
      const promises = [];
      snap.forEach(child => {
        if (!child.val().read) {
          promises.push(
            update(ref(db, `users/${uid}/notifications/${child.key}`), { read: true }).catch(() => {})
          );
        }
      });
      if (promises.length > 0) await Promise.all(promises);
      Toast.success('All notifications marked as read');
    } catch (e) { Toast.error('Could not mark all read'); }
  },

  // Call this from anywhere to push a notification to a user
  async push(targetUid, type, text) {
    try {
      const notifRef = ref(db, `users/${targetUid}/notifications`);
      await push(notifRef, {
        type, text, ts: Date.now(), read: false
      });
      // Cap notifications at 100 — delete oldest if over limit
      const notifSnap = await get(notifRef).catch(() => null);
      if (notifSnap && notifSnap.exists()) {
        const entries = Object.entries(notifSnap.val())
          .sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0)); // oldest first
        if (entries.length > 100) {
          const toDelete = entries.slice(0, entries.length - 100);
          const cleanupUpdates = {};
          toDelete.forEach(([key]) => { cleanupUpdates[key] = null; });
          await update(notifRef, cleanupUpdates).catch(() => {});
        }
      }
    } catch (e) { /* silent */ }
  }
};

/* ═══════════════════════════════════════════════════
   BLOCK USER
   ═══════════════════════════════════════════════════ */
const BlockSystem = {
  // Check if current user has blocked targetUid
  async isBlocked(targetUid) {
    if (!state.currentUser) return false;
    const snap = await get(ref(db, `users/${state.currentUser.uid}/blocked/${targetUid}`)).catch(() => null);
    return snap && snap.exists() && snap.val() === true;
  },

  // Check if targetUid has blocked current user
  async isBlockedBy(targetUid) {
    if (!state.currentUser) return false;
    const snap = await get(ref(db, `users/${targetUid}/blocked/${state.currentUser.uid}`)).catch(() => null);
    return snap && snap.exists() && snap.val() === true;
  },

  async block(targetUid) {
    if (!state.currentUser) return;
    await set(ref(db, `users/${state.currentUser.uid}/blocked/${targetUid}`), true);
  },

  async unblock(targetUid) {
    if (!state.currentUser) return;
    await remove(ref(db, `users/${state.currentUser.uid}/blocked/${targetUid}`));
  },

  // Call this when opening a chat to enforce block state
  async enforceChatBlock(partnerUid) {
    const inputArea = document.querySelector('.chat-input-area');
    const blockedBar = document.getElementById('blocked-chat-bar');
    const msgInput = document.getElementById('message-input');
    const sendBtn = document.getElementById('send-btn');
    const attachBtn = document.getElementById('attach-btn');
    const voiceBtn = document.getElementById('voice-btn');

    const iBlockedThem = await this.isBlocked(partnerUid);
    const theyBlockedMe = await this.isBlockedBy(partnerUid);
    const blocked = iBlockedThem || theyBlockedMe;

    if (inputArea) inputArea.style.display = blocked ? 'none' : '';
    if (blockedBar) blockedBar.style.display = blocked ? 'flex' : 'none';
    if (blocked) {
      blockedBar.textContent = iBlockedThem
        ? 'You have blocked this user. Unblock them in User Info to message them.'
        : 'This user has blocked you.';
    }
  }
};

// Wire up block button in user info panel
document.getElementById('block-user-btn')?.addEventListener('click', async () => {
  if (!state.chatPartnerId) return;
  const label = document.getElementById('block-user-btn-label');
  const alreadyBlocked = await BlockSystem.isBlocked(state.chatPartnerId);

  if (alreadyBlocked) {
    const ok = await ConfirmModal.show({
      icon: 'lock-open', title: `Unblock @${state.chatPartnerUsername}?`,
      sub: 'You will be able to send and receive messages again.',
      confirmText: 'Unblock', cancelText: 'Cancel', danger: false
    });
    if (!ok) return;
    await BlockSystem.unblock(state.chatPartnerId);
    label.textContent = 'Block User';
    Toast.info('User unblocked');
    BlockSystem.enforceChatBlock(state.chatPartnerId);
    // Restore the user card in directory
    const unblockedCard = document.getElementById('u-' + state.chatPartnerId);
    if (unblockedCard) unblockedCard.style.display = '';
  } else {
    const ok = await ConfirmModal.show({
      icon: 'ban', title: `Block @${state.chatPartnerUsername}?`,
      sub: 'You won\'t be able to message each other. You can unblock them later.',
      confirmText: 'Block', cancelText: 'Cancel', danger: true
    });
    if (!ok) return;
   await BlockSystem.block(state.chatPartnerId);
    label.textContent = 'Unblock User';
    Toast.info('User blocked');
    BlockSystem.enforceChatBlock(state.chatPartnerId);
    // Hide the user card in directory immediately
    const blockedCard = document.getElementById('u-' + state.chatPartnerId);
    if (blockedCard) blockedCard.style.display = 'none';
  }

  lucideCreate();

});

// Wire up "Mark all read" button
document.getElementById('notif-mark-all-btn')?.addEventListener('click', () => {
  if (state.currentUser) NotifSystem.markAllRead(state.currentUser.uid);
});

// Wire up banner close button
document.getElementById('notif-banner-close')?.addEventListener('click', () => {
  document.getElementById('notif-toast-banner')?.classList.remove('show');
});
/* ═══════════════════════════════════════════════════
   SHAREABLE PROFILE LINKS
   ═══════════════════════════════════════════════════ */
document.getElementById('copy-own-profile-link-btn')?.addEventListener('click', () => {
  if (!state.currentUser) return;
  const link = `${window.location.origin}${window.location.pathname}?uid=${state.currentUser.uid}`;
  navigator.clipboard.writeText(link).then(() => {
    Toast.success('Your profile link copied!');
  }).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = link;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    Toast.success('Your profile link copied!');
  });
});
document.getElementById('copy-profile-link-btn')?.addEventListener('click', () => {
  const uid = state.chatPartnerId;
  if (!uid) return;
  const link = `${window.location.origin}${window.location.pathname}?uid=${uid}`;
  navigator.clipboard.writeText(link).then(() => {
    Toast.success('Profile link copied!');
  }).catch(() => {
    // Fallback for browsers that block clipboard
    const ta = document.createElement('textarea');
    ta.value = link;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    Toast.success('Profile link copied!');
  });
});

// ── On page load: if ?uid= param is present, auto-open that user's info panel ──
function checkProfileLinkOnLoad() {
  const params = new URLSearchParams(window.location.search);
  const targetUid = params.get('uid');
  if (!targetUid || !state.currentUser) return;

  // Fetch the user data and open their chat / info panel
  get(ref(db, `users/${targetUid}`)).then(snap => {
    if (!snap.exists()) { Toast.error('User not found'); return; }
    const data = snap.val();
    // Open chat screen with this user (which populates the info panel)
    // Open full profile sheet directly
    openUserProfileSheet(
      targetUid,
      data.username || 'Unknown',
      data.skill || 'Explorer',
      data.level || 'Beginner',
      data.points || 0,
      data.pfpUrl || '',
      data.bio || '',
      data.expertise || null,
      data.socialIntegrations || null
    );

    // Clean the URL so refreshing doesn't reopen it
    window.history.replaceState({}, document.title, window.location.pathname);
  }).catch(() => Toast.error('Could not load profile'));
}
// ── Notification Panel open/close + Swipe-to-close ──
(function() {
  const panel   = document.getElementById('notif-panel');
  const overlay = document.getElementById('notif-panel-overlay');
  const bellBtn = document.getElementById('chrome-bell-btn');

  function openNotifPanel() {
    panel.classList.add('open');
    overlay.classList.add('open');
    bellBtn.classList.add('active');
    // Remove any leftover inline transform from swipe gesture
    panel.style.transform = '';
    panel.style.transition = '';
    lucideCreate();
    if (state.currentUser) {
      setTimeout(() => NotifSystem.markAllRead(state.currentUser.uid), 600);
    }
  }

  function closeNotifPanel() {
    panel.classList.remove('open');
    overlay.classList.remove('open');
    bellBtn.classList.remove('active');
    // Reset any inline transform/opacity from swipe
    panel.style.transform = '';
    panel.style.opacity   = '';
    panel.style.transition = '';
  }

  // ── Bell button toggle ──
  bellBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (panel.classList.contains('open')) closeNotifPanel();
    else openNotifPanel();
  });

  // ── Close button (X) ──
  document.getElementById('notif-panel-close').addEventListener('click', closeNotifPanel);

  // ── Clicking the dark backdrop closes panel ──
  overlay.addEventListener('click', closeNotifPanel);

  // ── ESC key closes panel ──
  // (already handled in global keydown, but keep here as backup)
  document.addEventListener('keydown', function escClose(e) {
    if (e.key === 'Escape' && panel.classList.contains('open')) closeNotifPanel();
  });

  // ────────────────────────────────────────────
  // SWIPE-TO-CLOSE  (touch devices)
  // Swipe RIGHT → panel slides out → closes
  // ────────────────────────────────────────────
  let touchStartX   = 0;
  let touchStartY   = 0;
  let touchCurrentX = 0;
  let isDragging    = false;
  let isHorizontal  = null; // determined after first 10px of movement

  const SWIPE_THRESHOLD    = 80;  // px to trigger close
  const SWIPE_VELOCITY_MIN = 0.4; // px/ms — fast flick also closes
  let touchStartTime = 0;

  panel.addEventListener('touchstart', (e) => {
    if (!panel.classList.contains('open')) return;
    touchStartX   = e.touches[0].clientX;
    touchStartY   = e.touches[0].clientY;
    touchCurrentX = touchStartX;
    touchStartTime = Date.now();
    isDragging    = false;
    isHorizontal  = null;
    // Disable CSS transition while dragging for instant follow
    panel.style.transition = 'none';
    overlay.style.transition = 'none';
  }, { passive: true });

  panel.addEventListener('touchmove', (e) => {
    if (!panel.classList.contains('open')) return;
    const dx = e.touches[0].clientX - touchStartX;
    const dy = e.touches[0].clientY - touchStartY;

    // After first 10px, decide if this is a horizontal or vertical swipe
    if (isHorizontal === null && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
      isHorizontal = Math.abs(dx) > Math.abs(dy);
    }

    // Only intercept horizontal rightward swipes
    if (!isHorizontal || dx < 0) return;

    isDragging    = true;
    touchCurrentX = e.touches[0].clientX;

    // Move panel with the finger, capped so it never goes left of resting position
    const offset = Math.max(0, dx);
    panel.style.transform = `translateX(${offset}px)`;

    // Fade the overlay proportionally — fully opaque at 0px, transparent at full panel width
    const panelWidth = panel.offsetWidth || 380;
    const progress   = Math.min(offset / panelWidth, 1);
    overlay.style.opacity = String(1 - progress);
  }, { passive: true });

  panel.addEventListener('touchend', (e) => {
    if (!panel.classList.contains('open') || !isDragging) {
      // Restore transition if we didn't drag
      panel.style.transition = '';
      overlay.style.transition = '';
      return;
    }

    const dx       = touchCurrentX - touchStartX;
    const elapsed  = Date.now() - touchStartTime;
    const velocity = dx / elapsed; // px/ms

    // Restore smooth transition before animating to final position
    panel.style.transition = 'transform 0.28s cubic-bezier(0.22,1,0.36,1), opacity 0.28s ease';
    overlay.style.transition = 'opacity 0.28s ease';

    if (dx > SWIPE_THRESHOLD || velocity > SWIPE_VELOCITY_MIN) {
      // ── Swipe far enough or fast enough → close ──
      const panelWidth = panel.offsetWidth || 380;
      panel.style.transform = `translateX(${panelWidth}px)`;
      overlay.style.opacity = '0';
      setTimeout(() => {
        closeNotifPanel();
      }, 280);
    } else {
      // ── Not far enough → snap back open ──
      panel.style.transform = 'translateX(0)';
      overlay.style.opacity = '1';
      setTimeout(() => {
        panel.style.transition = '';
        overlay.style.transition = '';
        overlay.style.opacity = '';
      }, 300);
    }

    isDragging   = false;
    isHorizontal = null;
  }, { passive: true });

  // Safety: if touch is cancelled (e.g. phone call), snap back
  panel.addEventListener('touchcancel', () => {
    if (!isDragging) return;
    panel.style.transition = 'transform 0.28s cubic-bezier(0.22,1,0.36,1)';
    panel.style.transform  = panel.classList.contains('open') ? 'translateX(0)' : '';
    overlay.style.transition = '';
    overlay.style.opacity    = '';
    isDragging   = false;
    isHorizontal = null;
  }, { passive: true });

  window._openNotifPanel  = openNotifPanel;
  window._closeNotifPanel = closeNotifPanel;
})();

// ── Desktop chrome bell button — delegates to the same notif panel ──
(function() {
  const desktopBell = document.getElementById('desktop-chrome-bell-btn');
  if (!desktopBell) return;
  desktopBell.addEventListener('click', function(e) {
    e.stopPropagation();
    // Delegate to the main bell button click (in nav)
    const mainBell = document.getElementById('chrome-bell-btn');
    if (mainBell) mainBell.click();
  });
  // Sync badge with main bell badge
  const mainBadge = document.getElementById('notif-nav-badge');
  const desktopBadge = document.getElementById('desktop-chrome-bell-badge');
  if (mainBadge && desktopBadge) {
    const observer = new MutationObserver(() => {
      desktopBadge.className = mainBadge.className;
    });
    observer.observe(mainBadge, { attributes: true, attributeFilter: ['class'] });
  }
})();


/* ════════════════════════════════════════════════════════════
   NOTIFICATION DETAIL SHEET — open / close / populate
   ════════════════════════════════════════════════════════════ */
(function() {
  const sheet   = document.getElementById('notif-detail-sheet');
  const overlay = document.getElementById('notif-detail-overlay');
  const closeBtn = document.getElementById('notif-detail-close');

  function closeNotifDetail() {
    sheet.classList.remove('open');
    overlay.classList.remove('open');
  }

  closeBtn.addEventListener('click', closeNotifDetail);
  overlay.addEventListener('click', closeNotifDetail);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && sheet.classList.contains('open')) closeNotifDetail();
  });

  window.openNotifDetail = function(notif, key, uid) {
    const typeConfig = {
      endorse:          { icon: 'star',          label: 'Endorsement',         cssType: 'endorse' },
      message:          { icon: 'message-circle', label: 'Message',             cssType: 'message' },
      like:             { icon: 'heart',          label: 'Like',                cssType: 'like'    },
      comment:          { icon: 'message-circle', label: 'Comment',             cssType: 'comment' },
      system:           { icon: 'megaphone',      label: 'System',              cssType: 'system'  },
      follow:           { icon: 'user-plus',      label: 'New Follower',        cssType: 'endorse' },
      comm_reply:       { icon: 'message-circle', label: 'Community Reply',     cssType: 'comment' },
      comm_upvote:      { icon: 'arrow-up',       label: 'Community Upvote',    cssType: 'like'    },
      comm_best_answer: { icon: 'check-circle',   label: 'Best Answer',         cssType: 'endorse' },
      comm_new_post:    { icon: 'globe',          label: 'New Community Post',  cssType: 'system'  },
    };

    const cfg = typeConfig[notif.type] || { icon: 'bell', label: 'Notification', cssType: 'default' };

    // Determine "from" details
    const fromUid      = notif.fromUid      || notif.fromUserId || null;
    const fromHandle   = notif.fromUsername || notif.fromHandle  || notif.authorUsername || null;
    const fromDisplay  = notif.fromDisplayName || notif.fromName || fromHandle || 'Someone';
    const fromAvatar   = notif.fromPhotoURL  || notif.fromAvatar || null;
    const fromInitial  = (fromDisplay || '?')[0].toUpperCase();

    // Title / body
    const title = notif.title || cfg.label;
    const body  = notif.body  || notif.text || '';

    // Time
    const ts = notif.ts ? new Date(notif.ts).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    }) : '';

    // Build "from" row only if there's a user
    const fromRow = (fromHandle || fromUid) ? `
      <div class="notif-detail-from">
        <div class="notif-detail-from-avatar">
          ${fromAvatar ? `<img src="${escHtml(fromAvatar)}" alt="${escHtml(fromDisplay)}" onerror="this.style.display='none'">` : escHtml(fromInitial)}
        </div>
        <div class="notif-detail-from-info">
          <div class="notif-detail-from-label">${notif.type === 'follow' ? 'Followed you' : notif.type === 'endorse' ? 'Endorsed you' : notif.type === 'like' ? 'Liked your post' : notif.type === 'comment' ? 'Commented' : 'From'}</div>
          <div class="notif-detail-from-name">${escHtml(fromDisplay)}</div>
          ${fromHandle ? `<div class="notif-detail-from-handle">@${escHtml(fromHandle)}</div>` : ''}
        </div>
      </div>` : '';

    // Build action button
    let actionBtn = '';
    if (notif.type === 'follow' && fromUid) {
      actionBtn = `<button class="notif-detail-action-btn" id="nds-view-profile">
        <i data-lucide="user" class="lucide" width="15" height="15"></i> View Profile
      </button>`;
    } else if (notif.type === 'message' && fromUid) {
      actionBtn = `<button class="notif-detail-action-btn" id="nds-view-profile">
        <i data-lucide="message-circle" class="lucide" width="15" height="15"></i> Open Message
      </button>`;
    } else if ((notif.type === 'like' || notif.type === 'comment') && notif.postId) {
      actionBtn = `<button class="notif-detail-action-btn" id="nds-view-post">
        <i data-lucide="file-text" class="lucide" width="15" height="15"></i> View Post
      </button>`;
    } else if (notif.type === 'endorse' && fromUid) {
      actionBtn = `<button class="notif-detail-action-btn" id="nds-view-profile">
        <i data-lucide="user" class="lucide" width="15" height="15"></i> View Their Profile
      </button>`;
    } else if ((notif.type === 'comm_reply' || notif.type === 'comm_upvote' || notif.type === 'comm_new_post') && notif.communityId) {
      actionBtn = `<button class="notif-detail-action-btn" id="nds-view-community">
        <i data-lucide="users" class="lucide" width="15" height="15"></i> Open Community
      </button>`;
    }

    document.getElementById('notif-detail-body').innerHTML = `
      <div class="notif-detail-icon-row">
        <div class="notif-detail-big-icon type-${cfg.cssType}">
          <i data-lucide="${cfg.icon}" class="lucide" width="26" height="26"></i>
        </div>
        <div class="notif-detail-type-meta">
          <div class="notif-detail-type-badge type-${cfg.cssType}">${escHtml(cfg.label)}</div>
          <div class="notif-detail-ts">${escHtml(ts)}</div>
        </div>
      </div>
      ${fromRow}
      <div class="notif-detail-message-box">
        <div class="notif-detail-message-label">Details</div>
        <div class="notif-detail-message-title">${escHtml(title)}</div>
        ${body ? `<div class="notif-detail-message-body">${escHtml(body)}</div>` : ''}
      </div>
      ${actionBtn}
      <button class="notif-detail-action-btn secondary" id="nds-close-btn">
        <i data-lucide="x" class="lucide" width="16" height="16"></i> Close
      </button>
    `;

    if (typeof lucide !== 'undefined') lucide.createIcons({ nodes: [document.getElementById('notif-detail-body')] });

    // Wire action buttons
    const vpBtn = document.getElementById('nds-view-profile');
    if (vpBtn && fromUid) {
      vpBtn.addEventListener('click', () => {
        closeNotifDetail();
        if (window._openNotifPanel) window._closeNotifPanel?.();
        setTimeout(() => {
          if (typeof openUserProfileSheet === 'function') openUserProfileSheet(fromUid);
        }, 200);
      });
    }
    const closeAct = document.getElementById('nds-close-btn');
    if (closeAct) closeAct.addEventListener('click', closeNotifDetail);

    sheet.classList.add('open');
    overlay.classList.add('open');
  };
})();
// ── SAVED PANEL ──
function openSavedPanel(){const p=document.getElementById('saved-panel'),o=document.getElementById('saved-panel-overlay');if(!p||!o)return;p.classList.add('open');o.classList.add('open');loadSavedPanelPosts();lucideCreate();}
function closeSavedPanel(){const p=document.getElementById('saved-panel'),o=document.getElementById('saved-panel-overlay');if(p)p.classList.remove('open');if(o)o.classList.remove('open');}
document.getElementById('saved-panel-btn').addEventListener('click',openSavedPanel);
document.getElementById('saved-panel-close').addEventListener('click',closeSavedPanel);
document.getElementById('saved-panel-overlay').addEventListener('click',closeSavedPanel);
async function loadSavedPanelPosts(){
  const body=document.getElementById('saved-panel-body'),empty=document.getElementById('saved-panel-empty');
  if(!body||!state.currentUser)return;
  body.querySelectorAll('.post-card,.skel-saved-post').forEach(c=>c.remove());
  if(empty)empty.style.display='none';
  try{
    const saved=await IDB.getAll();
    let communityPosts=[];
    try{const cpSnap=await get(ref(db,`users/${state.currentUser.uid}/savedCommunityPosts`));if(cpSnap.exists())communityPosts=Object.values(cpSnap.val()).sort((a,b)=>(b.savedAt||0)-(a.savedAt||0));}catch(e){}
    if(saved.length===0&&communityPosts.length===0){if(empty)empty.style.display='block';return;}
    saved.sort((a,b)=>(b.savedAt||0)-(a.savedAt||0));
    saved.forEach(post=>{
      const card=createPostCard(post);
      const badge=document.createElement('div');badge.className='saved-badge';badge.innerHTML='<i data-lucide="bookmark" class="lucide" width="12" height="12"></i> Saved';
      card.style.position='relative';card.insertBefore(badge,card.firstChild);
      const saveBtn=card.querySelector('.save-btn');if(saveBtn)saveBtn.remove();
      const unsaveBtn=document.createElement('button');unsaveBtn.className='post-action-btn';
      unsaveBtn.innerHTML='<span class="btn-icon"><i data-lucide="trash-2" class="lucide" width="16" height="16"></i></span> Remove';
      unsaveBtn.addEventListener('click',async()=>{await IDB.delete(post.postId).catch(()=>{});await remove(ref(db,`savedPosts/${state.currentUser.uid}/${post.postId}`)).catch(()=>{});card.remove();Toast.info('Removed from saved');if(!body.querySelector('.post-card'))if(empty)empty.style.display='block';});
      const actions=card.querySelector('.post-actions');if(actions)actions.appendChild(unsaveBtn);
      body.appendChild(card);
      lucide.createIcons({ nodes: [card] });
    });
    communityPosts.forEach(cp=>{
      const card=document.createElement('div');card.className='post-card';card.style.cssText='cursor:pointer;';
      card.innerHTML=`<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;"><span style="font-size:11px;background:rgba(35, 87, 232, 0.12);color:var(--accent-light);border-radius:var(--radius-pill);padding:2px 8px;font-family:var(--font-mono);"><i data-lucide="pin" class="lucide" width="10" height="10"></i> Community Post</span><span style="font-size:11px;color:var(--muted);">${escHtml(cp.communityName||'')}</span></div><div style="font-size:14px;font-weight:700;color:var(--text);margin-bottom:4px;">${escHtml(cp.postTitle||'(Untitled)')}</div><div style="display:flex;gap:8px;margin-top:8px;"><button class="post-action-btn" data-cp-unsave="${escHtml(cp.postId)}"><span class="btn-icon"><i data-lucide="trash-2" class="lucide" width="16" height="16"></i></span> Unsave</button><button class="post-action-btn" data-cp-open="${escHtml(cp.postId)}" data-cp-community="${escHtml(cp.communityId)}"><span class="btn-icon"><i data-lucide="eye" class="lucide" width="16" height="16"></i></span> View</button></div>`;
      card.querySelector('[data-cp-unsave]').addEventListener('click',async(e)=>{e.stopPropagation();await remove(ref(db,`users/${state.currentUser.uid}/savedCommunityPosts/${cp.postId}`)).catch(()=>{});card.remove();Toast.info('Removed from saved');if(!body.querySelector('.post-card'))if(empty)empty.style.display='block';});
      card.querySelector('[data-cp-open]').addEventListener('click',async(e)=>{e.stopPropagation();closeSavedPanel();openCommunityPost(cp.communityId,cp.postId);});
      body.appendChild(card);
      lucide.createIcons({ nodes: [card] });
    });
  }catch(e){DEBUG && console.warn('[Saved Panel]',e);}
}

/* ═══════════════════════════════════════════════════
   FEEDBACK MODAL
   ═══════════════════════════════════════════════════ */
const FeedbackModal = {
  _rating: 0,
  _ratingLabels: ['', 'Really bad', 'Not great', 'It\'s okay', 'Pretty good', 'Love it!'],

  open() {
    if (!state.currentUser) { Toast.error('You must be logged in to send feedback.'); return; }
    this._rating = 0;
    // Reset stars
    document.querySelectorAll('.feedback-star').forEach(s => s.classList.remove('lit'));
    const msgInput = document.getElementById('feedback-message-input');
    const submitBtn = document.getElementById('feedback-modal-submit');
    const label = document.getElementById('feedback-rating-label');
    if (msgInput) msgInput.value = '';
    if (submitBtn) submitBtn.disabled = true;
    if (label) label.textContent = 'Tap a star to rate';
    document.getElementById('feedback-modal-overlay').classList.add('active');
  },

  close() {
    document.getElementById('feedback-modal-overlay').classList.remove('active');
  },

  setRating(val) {
    this._rating = val;
    document.querySelectorAll('.feedback-star').forEach(s => {
      s.classList.toggle('lit', parseInt(s.dataset.val) <= val);
    });
    const label = document.getElementById('feedback-rating-label');
    if (label) label.textContent = this._ratingLabels[val] || '';
    const submitBtn = document.getElementById('feedback-modal-submit');
    if (submitBtn) submitBtn.disabled = false;
  },

  async submit() {
    if (!state.currentUser) return;
    if (!this._rating) { Toast.error('Please select a star rating.'); return; }

    const message = (document.getElementById('feedback-message-input')?.value || '').trim();
    const submitBtn = document.getElementById('feedback-modal-submit');
    const origText = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending…';

    try {
      await push(ref(db, 'hq/feedback'), {
        rating: this._rating,
        message: message || '',
        username: state.username || '',
        uid: state.currentUser.uid,
        ts: Date.now()
      });
      Toast.success('Feedback sent! Thank you');
      this.close();
    } catch (e) {
      Toast.error('Failed to send feedback: ' + (e.message || 'Unknown error'));
      submitBtn.disabled = false;
      submitBtn.textContent = origText;
    }
  }
};

// Wire up feedback stars
document.querySelectorAll('.feedback-star').forEach(star => {
  star.addEventListener('click', () => FeedbackModal.setRating(parseInt(star.dataset.val)));
  // Hover preview
  star.addEventListener('mouseenter', () => {
    const val = parseInt(star.dataset.val);
    document.querySelectorAll('.feedback-star').forEach(s => {
      s.style.filter = parseInt(s.dataset.val) <= val ? 'grayscale(0) opacity(1)' : 'grayscale(1) opacity(0.3)';
    });
  });
  star.addEventListener('mouseleave', () => {
    document.querySelectorAll('.feedback-star').forEach(s => {
      s.style.filter = '';  // CSS class handles it
    });
  });
});

document.getElementById('feedback-modal-cancel')?.addEventListener('click', () => FeedbackModal.close());
document.getElementById('feedback-modal-submit')?.addEventListener('click', () => FeedbackModal.submit());
document.getElementById('feedback-modal-overlay')?.addEventListener('click', (e) => {
  if (e.target === document.getElementById('feedback-modal-overlay')) FeedbackModal.close();
});
/* ═══════════════════════════════════════════════════
   ACCOUNT DELETION
   ═══════════════════════════════════════════════════ */
document.getElementById('delete-account-btn')?.addEventListener('click', async () => {
  if (!state.currentUser) return;

  // ── STEP 1: First warning confirmation ──
  const step1 = await ConfirmModal.show({
    icon: 'triangle-alert',
    title: 'Delete your account?',
    sub: 'This will permanently delete ALL your data: profile, posts, messages, endorsements, saved posts, room memberships, and more. This CANNOT be undone.',
    confirmText: 'Continue',
    cancelText: 'Cancel',
    danger: true
  });
  if (!step1) return;

  // ── STEP 2: Type DELETE to confirm ──
  const step2 = await new Promise(resolve => {
    const overlay   = document.getElementById('confirm-modal-overlay');
    const iconEl    = document.getElementById('confirm-modal-icon');
    const titleEl   = document.getElementById('confirm-modal-title');
    const subEl     = document.getElementById('confirm-modal-sub');
    const confirmBtn = document.getElementById('confirm-modal-confirm');
    const cancelBtn  = document.getElementById('confirm-modal-cancel');

    iconEl.innerHTML = '<i data-lucide="trash-2" class="lucide" width="24" height="24"></i>';
    titleEl.textContent = 'Type DELETE to confirm';
    subEl.innerHTML     = '<div id="delete-confirm-input-wrap"><label>Type DELETE in caps to confirm permanent deletion</label><input id="delete-confirm-input" placeholder="DELETE" maxlength="6" autocomplete="off"></div>';

    const newConfirm = confirmBtn.cloneNode(true);
    const newCancel  = cancelBtn.cloneNode(true);
    confirmBtn.replaceWith(newConfirm);
    cancelBtn.replaceWith(newCancel);
    newConfirm.textContent = 'Delete Account';
    newCancel.textContent  = 'Cancel';

    overlay.classList.add('active');

    const onCancel  = () => { overlay.classList.remove('active'); resolve(false); };
    const onConfirm = () => {
      const val = (document.getElementById('delete-confirm-input')?.value || '').trim();
      if (val !== 'DELETE') { Toast.error('You must type DELETE exactly (all caps)'); return; }
      overlay.classList.remove('active');
      resolve(true);
    };
    newConfirm.addEventListener('click', onConfirm);
    newCancel.addEventListener('click', onCancel);
    overlay.addEventListener('click', e => { if (e.target === overlay) onCancel(); }, { once: true });
  });
  if (!step2) return;

  // Close the profile modal
  const modal = document.getElementById('profile-modal');
  if (modal) modal.classList.remove('open');

  Toast.info('Re-authenticating for security... please wait');

  // ── STEP 3: Re-authenticate (required by Firebase before deleteUser) ──
  // Supports both email/password users and Google users
  try {
    const providerId = state.currentUser.providerData[0]?.providerId;
    if (providerId === 'password') {
      // Email/password user: prompt for password to confirm identity
      const pwConfirm = window.prompt('To confirm account deletion, please enter your password:');
      if (!pwConfirm) { Toast.info('Account deletion cancelled.'); return; }
      const emailCred = EmailAuthProvider.credential(state.currentUser.email, pwConfirm);
      await reauthenticateWithCredential(state.currentUser, emailCred);
    } else {
      // Google user: re-authenticate via Google popup
      await reauthenticateWithPopup(state.currentUser, new GoogleAuthProvider());
    }
  } catch (reAuthErr) {
    if (reAuthErr.code === 'auth/popup-closed-by-user' || reAuthErr.code === 'auth/cancelled-popup-request') {
      Toast.info('Account deletion cancelled.');
    } else if (reAuthErr.code === 'auth/wrong-password' || reAuthErr.code === 'auth/invalid-credential') {
      Toast.error('Incorrect password. Account deletion cancelled.');
    } else {
      Toast.error('Re-authentication failed. Please try again. (' + (reAuthErr.code || reAuthErr.message) + ')');
    }
    return;
  }

  Toast.info('Deleting your account... please wait. Do not close the app.');

  const uid      = state.currentUser.uid;
  const username = state.username;
  // Keep a reference to the Firebase user object BEFORE we wipe state
  const firebaseUser = state.currentUser;

  try {
    // ── STEP 4: Stop all listeners FIRST before we start deleting ──
    // This prevents listeners from firing errors as their data disappears
    cleanupAllListeners();

    const deletes = [];

    // ── 1. Remove username reservation ──
    if (username) {
      deletes.push(remove(ref(db, `usernames/${username}`)).catch(() => {}));
    }

    // ── 2. Remove all posts owned by this user (and their likes/comments nodes) ──
    const postsSnap = await get(ref(db, 'posts')).catch(() => null);
    if (postsSnap && postsSnap.exists()) {
      postsSnap.forEach(child => {
        const p = child.val();
        if (p.userId === uid) {
          deletes.push(remove(ref(db, `posts/${child.key}`)).catch(() => {}));
          deletes.push(remove(ref(db, `postLikes/${child.key}`)).catch(() => {}));
          deletes.push(remove(ref(db, `postComments/${child.key}`)).catch(() => {}));
        }
      });
    }

    // ── 3. Remove this user's likes on OTHER people's posts
    //       AND decrement the likesCount on those posts ──
    // FIX: get(ref(db,'postLikes')) previously threw PERMISSION_DENIED because
    // the rules have .read only at postLikes/$postId, not at root. The rules
    // now add a root .read to postLikes (safe: postIds are already enumerable
    // from the root-readable posts/ tree). We also add a per-postId fallback
    // path using postsSnap (already fetched above) so this works even if
    // the rules update hasn't propagated yet.
    let allLikesSnap = await get(ref(db, 'postLikes')).catch(() => null);
    if (!allLikesSnap || !allLikesSnap.exists()) {
      // Fallback: iterate all posts we already fetched and check per-postId
      if (postsSnap && postsSnap.exists()) {
        const likeChecks = [];
        postsSnap.forEach(postChild => {
          if (postChild.val()?.userId !== uid) {
            likeChecks.push(
              get(ref(db, `postLikes/${postChild.key}`)).catch(() => null).then(s => {
                if (s?.exists() && s.val()[uid]) {
                  deletes.push(remove(ref(db, `postLikes/${postChild.key}/${uid}`)).catch(() => {}));
                  deletes.push(
                    get(ref(db, `posts/${postChild.key}/likesCount`)).then(cSnap => {
                      const current = cSnap.val() || 0;
                      if (current > 0) return update(ref(db, `posts/${postChild.key}`), { likesCount: current - 1 });
                    }).catch(() => {})
                  );
                }
              })
            );
          }
        });
        await Promise.all(likeChecks).catch(() => {});
      }
    } else {
      allLikesSnap.forEach(postChild => {
        if (postChild.val() && postChild.val()[uid]) {
          deletes.push(remove(ref(db, `postLikes/${postChild.key}/${uid}`)).catch(() => {}));
          deletes.push(
            get(ref(db, `posts/${postChild.key}/likesCount`)).then(cSnap => {
              const current = cSnap.val() || 0;
              if (current > 0) {
                return update(ref(db, `posts/${postChild.key}`), { likesCount: current - 1 });
              }
            }).catch(() => {})
          );
        }
      });
    }

    // ── 4. Remove this user's comments on OTHER people's posts
    //       AND decrement commentsCount on those posts ──
    // FIX: Same root-read issue as postLikes above. Rules now grant root .read.
    // Per-postId fallback also added using postsSnap for resilience.
    let allCommentsSnap = await get(ref(db, 'postComments')).catch(() => null);
    if (!allCommentsSnap || !allCommentsSnap.exists()) {
      // Fallback: iterate all posts and check per-postId
      if (postsSnap && postsSnap.exists()) {
        const commentChecks = [];
        postsSnap.forEach(postChild => {
          if (postChild.val()?.userId !== uid) {
            commentChecks.push(
              get(ref(db, `postComments/${postChild.key}`)).catch(() => null).then(s => {
                if (!s?.exists()) return;
                let userCommentCount = 0;
                s.forEach(commentChild => {
                  if (commentChild.val().userId === uid) {
                    userCommentCount++;
                    deletes.push(remove(ref(db, `postComments/${postChild.key}/${commentChild.key}`)).catch(() => {}));
                  }
                });
                if (userCommentCount > 0) {
                  deletes.push(
                    get(ref(db, `posts/${postChild.key}/commentsCount`)).then(cSnap => {
                      const current = cSnap.val() || 0;
                      return update(ref(db, `posts/${postChild.key}`), { commentsCount: Math.max(0, current - userCommentCount) });
                    }).catch(() => {})
                  );
                }
              })
            );
          }
        });
        await Promise.all(commentChecks).catch(() => {});
      }
    } else {
      allCommentsSnap.forEach(postChild => {
        let userCommentCount = 0;
        postChild.forEach(commentChild => {
          if (commentChild.val().userId === uid) {
            userCommentCount++;
            deletes.push(remove(ref(db, `postComments/${postChild.key}/${commentChild.key}`)).catch(() => {}));
          }
        });
        if (userCommentCount > 0) {
          deletes.push(
            get(ref(db, `posts/${postChild.key}/commentsCount`)).then(cSnap => {
              const current = cSnap.val() || 0;
              const newCount = Math.max(0, current - userCommentCount);
              return update(ref(db, `posts/${postChild.key}`), { commentsCount: newCount });
            }).catch(() => {})
          );
        }
      });
    }

    // ── 5. Remove saved posts ──
    deletes.push(remove(ref(db, `savedPosts/${uid}`)).catch(() => {}));

    // ── 6. Remove endorsements received BY this user ──
    deletes.push(remove(ref(db, `endorsements/${uid}`)).catch(() => {}));

    // ── 7. Remove endorsements this user GAVE to others ──
    // FIX: get(ref(db,'endorsements')) threw PERMISSION_DENIED — rules have
    // .read only at endorsements/$targetUid, not at root. Rules now add root
    // .read (safe: target UIDs are already enumerable via the root-readable
    // users/ tree). Fallback: if root read still fails, iterate known follows+
    // followers to cover the people most likely to have been endorsed.
    let allEndorseSnap = await get(ref(db, 'endorsements')).catch(() => null);
    if (!allEndorseSnap || !allEndorseSnap.exists()) {
      // Fallback: check endorsements for users this person followed/followed-by
      const [myFollowsSnap2, myFollowersSnap2] = await Promise.all([
        get(ref(db, `follows/${uid}`)).catch(() => null),
        get(ref(db, `followers/${uid}`)).catch(() => null),
      ]);
      const knownUids = new Set();
      if (myFollowsSnap2?.exists()) myFollowsSnap2.forEach(c => knownUids.add(c.key));
      if (myFollowersSnap2?.exists()) myFollowersSnap2.forEach(c => knownUids.add(c.key));
      for (const targetId of knownUids) {
        deletes.push(remove(ref(db, `endorsements/${targetId}/${uid}`)).catch(() => {}));
      }
    } else {
      allEndorseSnap.forEach(targetChild => {
        if (targetChild.val() && targetChild.val()[uid]) {
          deletes.push(remove(ref(db, `endorsements/${targetChild.key}/${uid}`)).catch(() => {}));
        }
      });
    }

    // ── 8. Remove HQ ban/mute flags ──
    deletes.push(remove(ref(db, `hq/bans/${uid}`)).catch(() => {}));
    deletes.push(remove(ref(db, `hq/mutes/${uid}`)).catch(() => {}));

    // ── 9. Remove DM chat conversations ──
    // FIX: get(ref(db,'chats')) always threw PERMISSION_DENIED — chats/ has no
    // root .read rule (intentionally, for privacy: messages are private).
    // We MUST NOT add root .read to chats. Instead we reconstruct every
    // possible chatId from the user's follows + followers lists.
    // chatId format: uid1 < uid2 ? `${uid1}_${uid2}` : `${uid2}_${uid1}`
    // Every person this user has ever DM'd is either someone they follow
    // or someone who follows them (the app only opens DMs between connected users).
    const [myFollowsSnap, myFollowersSnap] = await Promise.all([
      get(ref(db, `follows/${uid}`)).catch(() => null),
      get(ref(db, `followers/${uid}`)).catch(() => null),
    ]);
    const chatPartners = new Set();
    if (myFollowsSnap?.exists()) myFollowsSnap.forEach(c => chatPartners.add(c.key));
    if (myFollowersSnap?.exists()) myFollowersSnap.forEach(c => chatPartners.add(c.key));
    for (const partnerId of chatPartners) {
      const chatId = uid < partnerId ? `${uid}_${partnerId}` : `${partnerId}_${uid}`;
      deletes.push(remove(ref(db, `chats/${chatId}`)).catch(() => {}));
    }

    // ── 10. Remove room memberships and clean up owned rooms ──
    const roomsSnap = await get(ref(db, 'rooms')).catch(() => null);
    if (roomsSnap && roomsSnap.exists()) {
      roomsSnap.forEach(roomChild => {
        const room = roomChild.val();
        if (!room) return;
        const roomId = roomChild.key;

        if (room.ownerId === uid) {
          // User owned this room — delete the ENTIRE room (messages, members, everything)
          deletes.push(remove(ref(db, `rooms/${roomId}`)).catch(() => {}));
        } else if (room.members && room.members[uid]) {
          // User was a member — remove their membership entry
          deletes.push(remove(ref(db, `rooms/${roomId}/members/${uid}`)).catch(() => {}));
          // Also remove any kicked entry for this user
          deletes.push(remove(ref(db, `rooms/${roomId}/kicked/${uid}`)).catch(() => {}));
          // Remove their typing indicator
          deletes.push(remove(ref(db, `rooms/${roomId}/typing/${uid}`)).catch(() => {}));
        }
      });
    }

    // ── 11. Remove guild data: seenBy and reactions in messages ──
    // Also remove typing indicators in guilds
    const guildsSnap = await get(ref(db, 'guilds')).catch(() => null);
    if (guildsSnap && guildsSnap.exists()) {
      guildsSnap.forEach(guildChild => {
        const guildId = guildChild.key;
        const guild   = guildChild.val();
        if (!guild) return;

        // Remove typing indicator
        deletes.push(remove(ref(db, `guilds/${guildId}/typing/${uid}`)).catch(() => {}));

        // Clean seenBy and reactions from messages
        if (guild.messages) {
          Object.entries(guild.messages).forEach(([msgId, msg]) => {
            if (msg && msg.seenBy && msg.seenBy[uid]) {
              deletes.push(remove(ref(db, `guilds/${guildId}/messages/${msgId}/seenBy/${uid}`)).catch(() => {}));
            }
            if (msg && msg.reactions && msg.reactions[uid]) {
              deletes.push(remove(ref(db, `guilds/${guildId}/messages/${msgId}/reactions/${uid}`)).catch(() => {}));
            }
          });
        }
      });
    }

    // ── 12. Remove call signaling data ──
    const callsSnap = await get(ref(db, 'calls')).catch(() => null);
    if (callsSnap && callsSnap.exists()) {
      callsSnap.forEach(callChild => {
        const call   = callChild.val();
        const callId = callChild.key;
        const isDirectCall = !!(call && (call.callerId === uid || call.receiverId === uid));
        const isProjectCallParticipant = !!(call && call.type === 'project' && call.participants && call.participants[uid]);
        if (isDirectCall || isProjectCallParticipant) {
          deletes.push(remove(ref(db, `calls/${callId}`)).catch(() => {}));
        }
      });
    }

    // ── 13. Remove notifications sub-node ──
    deletes.push(remove(ref(db, `users/${uid}/notifications`)).catch(() => {}));

    // ── 14. Remove block list ──
    deletes.push(remove(ref(db, `users/${uid}/blocked`)).catch(() => {}));

    // ── 15. Execute all DB deletes in parallel ──
    await Promise.all(deletes);

    // ── 16. Delete the user record itself (MUST be last DB step) ──
    await remove(ref(db, `users/${uid}`)).catch(() => {});

    // ── 17. Clear IndexedDB (local saved posts on this device) ──
    await IDB.clearAll().catch(() => {});

    // ── 18. Delete Firebase Auth account (THE MOST IMPORTANT STEP)
    //        This prevents the user from signing back in with the same Google account
    //        and getting re-onboarded as a new user ──
    await deleteUser(firebaseUser);

    Toast.success('Account permanently deleted. Goodbye!');

  } catch (err) {
    // If deleteUser fails with requires-recent-login, the re-auth popup should have handled it.
    // If the error is something else, show it.
    if (err.code === 'auth/requires-recent-login') {
      Toast.error('Session expired during deletion. Please log in again and retry deletion immediately.');
      await signOut(auth).catch(() => {});
    } else {
      Toast.error('Deletion error: ' + (err.message || err.code || 'Unknown error') + '. Some data may not have been removed.');
    }
  }
});
// Wire up "Send Feedback" button inside profile modal
document.getElementById('feedback-btn')?.addEventListener('click', () => {
  $('profile-modal').classList.remove('open'); // close profile first
  setTimeout(() => FeedbackModal.open(), 200);
});

/* ═══════════════════════════════════════════════════
   CONFIRM MODAL — replaces browser confirm() everywhere
   ═══════════════════════════════════════════════════ */
const ConfirmModal = {
  _resolve: null,
  show({ icon = 'triangle-alert', title = 'Are you sure?', sub = '', confirmText = 'Confirm', cancelText = 'Cancel', danger = true } = {}) {
    return new Promise((resolve) => {
      this._resolve = resolve;
      const overlay = document.getElementById('confirm-modal-overlay');
      const _iconEl = document.getElementById('confirm-modal-icon');
      _iconEl.innerHTML = `<i data-lucide="${icon}" class="lucide" width="32" height="32"></i>`;
      if (typeof lucide !== 'undefined') lucide.createIcons({ nodes: [_iconEl] });
      document.getElementById('confirm-modal-title').textContent = title;
      document.getElementById('confirm-modal-sub').textContent = sub;
      const confirmBtn = document.getElementById('confirm-modal-confirm');
      const cancelBtn = document.getElementById('confirm-modal-cancel');
      confirmBtn.textContent = confirmText;
      cancelBtn.textContent = cancelText;
      confirmBtn.className = 'confirm-modal-confirm' + (danger ? '' : ' primary-action');
      overlay.classList.add('active');

      const onConfirm = () => { this._close(); resolve(true); };
      const onCancel = () => { this._close(); resolve(false); };
      const onKey = (e) => { if (e.key === 'Escape') { this._close(); resolve(false); } };

      // Clone buttons to clear old listeners
      const newConfirm = confirmBtn.cloneNode(true);
      const newCancel = cancelBtn.cloneNode(true);
      confirmBtn.replaceWith(newConfirm);
      cancelBtn.replaceWith(newCancel);
      newConfirm.textContent = confirmText;
      newCancel.textContent = cancelText;
      newConfirm.className = 'confirm-modal-confirm' + (danger ? '' : ' primary-action');
      newConfirm.addEventListener('click', onConfirm);
      newCancel.addEventListener('click', onCancel);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) onCancel(); }, { once: true });
      document.addEventListener('keydown', onKey, { once: true });
    });
  },
  _close() {
    const overlay = document.getElementById('confirm-modal-overlay');
    if (overlay) overlay.classList.remove('active');
  }
};

/* ══════════════════════════════════════════════
   GOLEX INTRO ANIMATION SCRIPT
   ══════════════════════════════════════════════ */
(function () {
  const $i = id => document.getElementById(id);

  const TYPE_TEXT   = "We can build it together...";
  const TYPE_DELAY  = 2400;
  const TYPE_SPEED  = 52;
  const FOCUS_DELAY = 220;
  const CLICK_DELAY = 400;
  const PLANE_DELAY = 95;
  const END_DELAY   = 1650;

  const overlay  = $i('golex-intro-overlay'); if (!overlay) return;

  /* ── Skip intro on repeat visits ── */
  try {
    if (localStorage.getItem('golex-intro-seen')) {
      overlay.style.display = 'none';
      return;
    }
  } catch(e) {}
  const chatWin  = $i('intro-chat-window');
  const inputEl  = $i('intro-chat-input');
  const typedEl  = $i('intro-typed-text');
  const cursorEl = $i('intro-cursor');
  const sendBtn  = $i('intro-send-btn');
  const canvas   = $i('intro-plane-canvas');
  const revealEl = $i('intro-golex-reveal');

  if (!chatWin || !inputEl || !typedEl || !cursorEl || !sendBtn || !canvas || !revealEl) return;

  const ctx = canvas.getContext('2d');

  function sizeCanvas() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
  sizeCanvas();
  window.addEventListener('resize', rafThrottle(sizeCanvas));

  const easeOutExpo  = t => t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
  const easeOutBack  = (t, s) => { s = s === undefined ? 1.3 : s; const c3 = s + 1; return 1 + c3 * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2); };
  const bez = (p0, p1, p2, p3, t) => { const m = 1 - t; return m*m*m*p0 + 3*m*m*t*p1 + 3*m*t*t*p2 + t*t*t*p3; };

  function typeText(cb) {
    inputEl.classList.add('focused');
    let i = 0;
    const tick = () => {
      if (i < TYPE_TEXT.length) {
        const ch = TYPE_TEXT[i];
        typedEl.textContent = TYPE_TEXT.slice(0, ++i);
        const pause = (ch === '.' || ch === ',' || ch === '!') ? TYPE_SPEED * 4.5 : TYPE_SPEED + (Math.random() * 36 - 18);
        setTimeout(tick, pause);
      } else {
        cursorEl.style.animation = 'none';
        cursorEl.style.opacity   = '1';
        setTimeout(cb, FOCUS_DELAY);
      }
    };
    setTimeout(tick, 0);
  }

  function focusSend(cb) {
    sendBtn.classList.add('send-focus');
    inputEl.style.borderColor = 'rgba(35, 87, 232, 0.65)';
    inputEl.style.boxShadow   = '0 0 0 3px rgba(35, 87, 232, 0.18), 0 0 24px rgba(35, 87, 232, 0.08)';
    setTimeout(cb, CLICK_DELAY);
  }

  function clickSend(cb) {
    sendBtn.classList.remove('send-focus');
    sendBtn.classList.add('send-clicked');
    inputEl.style.transition  = 'opacity 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease';
    inputEl.style.opacity     = '0.38';
    inputEl.style.borderColor = 'rgba(35, 87, 232, 0.1)';
    inputEl.style.boxShadow   = 'none';
    cursorEl.style.opacity    = '0';
    const ripple = document.createElement('span');
    ripple.style.cssText = 'position:absolute;inset:0;border-radius:12px;background:rgba(255,255,255,0.28);transform:scale(0);animation:_ripple 0.5s cubic-bezier(0,0.55,0.45,1) forwards;pointer-events:none';
    if (!document.getElementById('_rk')) {
      const s = document.createElement('style'); s.id = '_rk';
      s.textContent = '@keyframes _ripple{to{transform:scale(2.8);opacity:0;}}';
      document.head.appendChild(s);
    }
    sendBtn.appendChild(ripple);
    const ic = $i('intro-send-icon'); if (ic) ic.classList.add('launching');
    setTimeout(() => chatWin.classList.add('zooming'), 85);
    setTimeout(cb, PLANE_DELAY);
  }

  const PLANE_PATH_MAIN = new Path2D('M 22 2 L 2 9 L 11 13 L 15 22 Z');
  const PLANE_PATH_FOLD = new Path2D('M 22 2 L 11 13');
  const PLANE_PATH_WING = new Path2D('M 11 13 L 15 22');

  function drawPlane(px, py, angle, sc, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(px, py); ctx.rotate(angle); ctx.scale(sc, sc); ctx.translate(-12, -12);
    ctx.save(); ctx.shadowColor = 'rgba(255,255,255,0.5)'; ctx.shadowBlur = 14; ctx.fillStyle = 'rgba(255,255,255,0)'; ctx.fill(PLANE_PATH_MAIN); ctx.restore();
    ctx.fillStyle = '#ffffff'; ctx.fill(PLANE_PATH_MAIN);
    ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke(PLANE_PATH_MAIN);
    ctx.strokeStyle = 'rgba(210,205,240,0.7)'; ctx.lineWidth = 1.3; ctx.stroke(PLANE_PATH_FOLD);
    ctx.strokeStyle = 'rgba(210,205,240,0.5)'; ctx.lineWidth = 0.9; ctx.stroke(PLANE_PATH_WING);
    ctx.restore();
  }

  function flyPlane(cb) {
    canvas.style.opacity = '1';
    const W = canvas.width, H = canvas.height;
    const r  = sendBtn.getBoundingClientRect();
    const ox = r.left + r.width / 2, oy = r.top + r.height / 2;
    const dx = W * 0.50, dy = H * 0.34;
    const cp1x = ox + (dx - ox) * 0.18, cp1y = oy - H * 0.50;
    const cp2x = dx + W * 0.08, cp2y = dy - H * 0.10;
    let t = 0;
    const DUR = 90, trail = [], MAX_TRAIL = 28;
    const PLANE_SCALE_START = 1.05, PLANE_SCALE_END = 0.78;
    let prevAngle = 0, firstFrame = true;

    function frame() {
      ctx.clearRect(0, 0, W, H);
      t = Math.min(t + 1 / DUR, 1);
      const e = easeOutExpo(t);
      const px = bez(ox, cp1x, cp2x, dx, e), py = bez(oy, cp1y, cp2y, dy, e);
      const tAhead = Math.min(t + 0.012, 1), eAhead = easeOutExpo(tAhead);
      const nx = bez(ox, cp1x, cp2x, dx, eAhead), ny = bez(oy, cp1y, cp2y, dy, eAhead);
      const rawAngle = Math.atan2(ny - py, nx - px);
      if (firstFrame) { prevAngle = rawAngle; firstFrame = false; }
      const angleDelta = rawAngle - prevAngle;
      const wrappedDelta = ((angleDelta + Math.PI) % (2 * Math.PI)) - Math.PI;
      prevAngle = prevAngle + wrappedDelta * 0.28;
      trail.push({ x: px, y: py, t });
      if (trail.length > MAX_TRAIL) trail.shift();
      if (trail.length > 2) {
        for (let i = 1; i < trail.length; i++) {
          const ratio = i / trail.length, tailAlpha = Math.pow(ratio, 2.2) * 0.52, w = ratio * 3.2 + 0.3;
          ctx.beginPath(); ctx.moveTo(trail[i-1].x, trail[i-1].y); ctx.lineTo(trail[i].x, trail[i].y);
          ctx.strokeStyle = 'rgba(255,255,255,'+tailAlpha+')'; ctx.lineWidth = w; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke();
        }
        for (let i = Math.floor(trail.length * 0.7); i < trail.length; i++) {
          if (i % 6 === 0) {
            const ratio = i / trail.length, sparkAlpha = ratio * 0.6 * (1 - t * 0.5);
            ctx.save(); ctx.globalAlpha = sparkAlpha; ctx.beginPath(); ctx.arc(trail[i].x, trail[i].y, 0.8 + ratio * 1.0, 0, Math.PI*2); ctx.fillStyle = 'rgba(240,235,255,1)'; ctx.fill(); ctx.restore();
          }
        }
      }
      const scaleT = easeOutBack(e, 0.4), sc = PLANE_SCALE_START + (PLANE_SCALE_END - PLANE_SCALE_START) * Math.min(scaleT, 1);
      const planeAlpha = t > 0.90 ? Math.max(0, (1 - t) / 0.10) : 1.0;
      drawPlane(px, py, prevAngle, sc, planeAlpha);
      if (t < 1) { requestAnimationFrame(frame); } else { burst(ctx, dx, dy, W, H, cb); }
    }
    requestAnimationFrame(frame);
  }

  function burst(ctx, cx, cy, W, H, cb) {
    const N = 32;
    const COLS = [[255,255,255],[235,230,255],[210,190,255],[167,139,250],[139,92,246],[99,102,241],[6,182,212],[255,255,255]];
    const pts = Array.from({ length: N }, function(_, i) {
      const baseA = (Math.PI * 2 * i) / N, a = baseA + (Math.random() - 0.5) * 0.35;
      const spd = 2.8 + Math.random() * 5.6, col = COLS[Math.floor(Math.random() * COLS.length)];
      return { x: cx, y: cy, vx: Math.cos(a)*spd, vy: Math.sin(a)*spd, r: 1.4 + Math.random()*3.0, col: col, life: 1.0, decay: 0.026 + Math.random()*0.016, trail: [] };
    });
    let ringR = 2, ringLife = 1, ring2R = 2, ring2Life = 0.7, ring2Delay = 6, frameN = 0;

    function tick() {
      ctx.clearRect(0, 0, W, H);
      if (ringLife > 0) {
        ringR += 8; ringLife -= 0.060;
        if (ringLife > 0) { ctx.save(); ctx.globalAlpha = ringLife * 0.32; ctx.beginPath(); ctx.arc(cx, cy, ringR, 0, Math.PI*2); ctx.strokeStyle = 'rgba(195,175,255,1)'; ctx.lineWidth = 2.2; ctx.stroke(); ctx.restore(); }
      }
      if (frameN >= ring2Delay && ring2Life > 0) {
        ring2R += 5; ring2Life -= 0.075;
        if (ring2Life > 0) { ctx.save(); ctx.globalAlpha = ring2Life * 0.18; ctx.beginPath(); ctx.arc(cx, cy, ring2R, 0, Math.PI*2); ctx.strokeStyle = 'rgba(5, 150, 105, 1)'; ctx.lineWidth = 1.2; ctx.stroke(); ctx.restore(); }
      }
      let alive = false;
      pts.forEach(function(p) {
        p.trail.push({ x: p.x, y: p.y }); if (p.trail.length > 7) p.trail.shift();
        p.x += p.vx; p.y += p.vy; p.vy += 0.072; p.vx *= 0.982; p.vy *= 0.988; p.life -= p.decay;
        if (p.life > 0) {
          alive = true;
          const r=p.col[0],g=p.col[1],b=p.col[2];
          if (p.trail.length > 1) { ctx.save(); ctx.globalAlpha = p.life * 0.40; ctx.beginPath(); ctx.moveTo(p.trail[0].x, p.trail[0].y); for (let k=1;k<p.trail.length;k++) ctx.lineTo(p.trail[k].x, p.trail[k].y); ctx.strokeStyle='rgba('+r+','+g+','+b+',1)'; ctx.lineWidth=p.r*p.life*0.65; ctx.lineCap='round'; ctx.stroke(); ctx.restore(); }
          ctx.save(); ctx.globalAlpha = p.life*0.16; ctx.beginPath(); ctx.arc(p.x,p.y,p.r*p.life*2.0,0,Math.PI*2); ctx.fillStyle='rgba('+r+','+g+','+b+',1)'; ctx.fill(); ctx.restore();
          ctx.save(); ctx.globalAlpha = p.life*0.94; ctx.beginPath(); ctx.arc(p.x,p.y,p.r*p.life,0,Math.PI*2); ctx.fillStyle='rgba('+r+','+g+','+b+',1)'; ctx.fill(); ctx.restore();
        }
      });
      if (alive && ++frameN < 70) { requestAnimationFrame(tick); } else { ctx.clearRect(0,0,W,H); canvas.style.transition='opacity 0.2s ease'; canvas.style.opacity='0'; if(cb) cb(); }
    }
    requestAnimationFrame(tick);
  }

  function revealGolex(cb) {
    revealEl.style.opacity = '1';
    revealEl.style.pointerEvents = 'all';
    requestAnimationFrame(function() { requestAnimationFrame(function() {
      revealEl.classList.add('revealed');
      setTimeout(cb, END_DELAY);
    }); });
  }

  function dismiss() {
    try { localStorage.setItem('golex-intro-seen', '1'); } catch(e) {}
    overlay.classList.add('intro-done');
    setTimeout(function() { overlay.style.display = 'none'; }, 620);
  }

  setTimeout(function() {
    typeText(function() { focusSend(function() { clickSend(function() { flyPlane(function() { revealGolex(function() { dismiss(); }); }); }); }); });
  }, TYPE_DELAY);

  var safeTimer = setTimeout(dismiss, 13000);
  overlay.addEventListener('transitionend', function() { clearTimeout(safeTimer); }, { once: true });

  var skipped = false;
  overlay.addEventListener('click', function skipHandler() {
    if (skipped) return; skipped = true;
    clearTimeout(safeTimer);
    overlay.removeEventListener('click', skipHandler);
    dismiss();
  });
})();


// ── Export to window ──
Object.assign(window, {
  loadEndorsements, ReportModal, NotifSystem, BlockSystem,
  FeedbackModal, ConfirmModal,
  openNotifPanel, closeNotifPanel,
  checkProfileLinkOnLoad
});

// ── Notification Detail Sheet ──
/* ════════════════════════════════════════════════════════════
   NOTIFICATION DETAIL SHEET — open / close / populate
   ════════════════════════════════════════════════════════════ */
(function() {
  const sheet   = document.getElementById('notif-detail-sheet');
  const overlay = document.getElementById('notif-detail-overlay');
  const closeBtn = document.getElementById('notif-detail-close');

  function closeNotifDetail() {
    sheet.classList.remove('open');
    overlay.classList.remove('open');
  }

  closeBtn.addEventListener('click', closeNotifDetail);
  overlay.addEventListener('click', closeNotifDetail);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && sheet.classList.contains('open')) closeNotifDetail();
  });

  window.openNotifDetail = function(notif, key, uid) {
    const typeConfig = {
      endorse:          { icon: 'star',          label: 'Endorsement',         cssType: 'endorse' },
      message:          { icon: 'message-circle', label: 'Message',             cssType: 'message' },
      like:             { icon: 'heart',          label: 'Like',                cssType: 'like'    },
      comment:          { icon: 'message-circle', label: 'Comment',             cssType: 'comment' },
      system:           { icon: 'megaphone',      label: 'System',              cssType: 'system'  },
      follow:           { icon: 'user-plus',      label: 'New Follower',        cssType: 'endorse' },
      comm_reply:       { icon: 'message-circle', label: 'Community Reply',     cssType: 'comment' },
      comm_upvote:      { icon: 'arrow-up',       label: 'Community Upvote',    cssType: 'like'    },
      comm_best_answer: { icon: 'check-circle',   label: 'Best Answer',         cssType: 'endorse' },
      comm_new_post:    { icon: 'globe',          label: 'New Community Post',  cssType: 'system'  },
    };

    const cfg = typeConfig[notif.type] || { icon: 'bell', label: 'Notification', cssType: 'default' };

    // Determine "from" details
    const fromUid      = notif.fromUid      || notif.fromUserId || null;
    const fromHandle   = notif.fromUsername || notif.fromHandle  || notif.authorUsername || null;
    const fromDisplay  = notif.fromDisplayName || notif.fromName || fromHandle || 'Someone';
    const fromAvatar   = notif.fromPhotoURL  || notif.fromAvatar || null;
    const fromInitial  = (fromDisplay || '?')[0].toUpperCase();

    // Title / body
    const title = notif.title || cfg.label;
    const body  = notif.body  || notif.text || '';

    // Time
    const ts = notif.ts ? new Date(notif.ts).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    }) : '';

    // Build "from" row only if there's a user
    const fromRow = (fromHandle || fromUid) ? `
      <div class="notif-detail-from">
        <div class="notif-detail-from-avatar">
          ${fromAvatar ? `<img src="${escHtml(fromAvatar)}" alt="${escHtml(fromDisplay)}" onerror="this.style.display='none'">` : escHtml(fromInitial)}
        </div>
        <div class="notif-detail-from-info">
          <div class="notif-detail-from-label">${notif.type === 'follow' ? 'Followed you' : notif.type === 'endorse' ? 'Endorsed you' : notif.type === 'like' ? 'Liked your post' : notif.type === 'comment' ? 'Commented' : 'From'}</div>
          <div class="notif-detail-from-name">${escHtml(fromDisplay)}</div>
          ${fromHandle ? `<div class="notif-detail-from-handle">@${escHtml(fromHandle)}</div>` : ''}
        </div>
      </div>` : '';

    // Build action button
    let actionBtn = '';
    if (notif.type === 'follow' && fromUid) {
      actionBtn = `<button class="notif-detail-action-btn" id="nds-view-profile">
        <i data-lucide="user" class="lucide" width="15" height="15"></i> View Profile
      </button>`;
    } else if (notif.type === 'message' && fromUid) {
      actionBtn = `<button class="notif-detail-action-btn" id="nds-view-profile">
        <i data-lucide="message-circle" class="lucide" width="15" height="15"></i> Open Message
      </button>`;
    } else if ((notif.type === 'like' || notif.type === 'comment') && notif.postId) {
      actionBtn = `<button class="notif-detail-action-btn" id="nds-view-post">
        <i data-lucide="file-text" class="lucide" width="15" height="15"></i> View Post
      </button>`;
    } else if (notif.type === 'endorse' && fromUid) {
      actionBtn = `<button class="notif-detail-action-btn" id="nds-view-profile">
        <i data-lucide="user" class="lucide" width="15" height="15"></i> View Their Profile
      </button>`;
    } else if ((notif.type === 'comm_reply' || notif.type === 'comm_upvote' || notif.type === 'comm_new_post') && notif.communityId) {
      actionBtn = `<button class="notif-detail-action-btn" id="nds-view-community">
        <i data-lucide="users" class="lucide" width="15" height="15"></i> Open Community
      </button>`;
    }

    document.getElementById('notif-detail-body').innerHTML = `
      <div class="notif-detail-icon-row">
        <div class="notif-detail-big-icon type-${cfg.cssType}">
          <i data-lucide="${cfg.icon}" class="lucide" width="26" height="26"></i>
        </div>
        <div class="notif-detail-type-meta">
          <div class="notif-detail-type-badge type-${cfg.cssType}">${escHtml(cfg.label)}</div>
          <div class="notif-detail-ts">${escHtml(ts)}</div>
        </div>
      </div>
      ${fromRow}
      <div class="notif-detail-message-box">
        <div class="notif-detail-message-label">Details</div>
        <div class="notif-detail-message-title">${escHtml(title)}</div>
        ${body ? `<div class="notif-detail-message-body">${escHtml(body)}</div>` : ''}
      </div>
      ${actionBtn}
      <button class="notif-detail-action-btn secondary" id="nds-close-btn">
        <i data-lucide="x" class="lucide" width="16" height="16"></i> Close
      </button>
    `;

    if (typeof lucide !== 'undefined') lucide.createIcons({ nodes: [document.getElementById('notif-detail-body')] });

    // Wire action buttons
    const vpBtn = document.getElementById('nds-view-profile');
    if (vpBtn && fromUid) {
      vpBtn.addEventListener('click', () => {
        closeNotifDetail();
        if (window._openNotifPanel) window._closeNotifPanel?.();
        setTimeout(() => {
          if (typeof openUserProfileSheet === 'function') openUserProfileSheet(fromUid);
        }, 200);
      });
    }
    const closeAct = document.getElementById('nds-close-btn');
    if (closeAct) closeAct.addEventListener('click', closeNotifDetail);

    sheet.classList.add('open');
    overlay.classList.add('open');
  };
})();
// ── SAVED PANEL ──
function openSavedPanel(){const p=document.getElementById('saved-panel'),o=document.getElementById('saved-panel-overlay');if(!p||!o)return;p.classList.add('open');o.classList.add('open');loadSavedPanelPosts();lucideCreate();}
function closeSavedPanel(){const p=document.getElementById('saved-panel'),o=document.getElementById('saved-panel-overlay');if(p)p.classList.remove('open');if(o)o.classList.remove('open');}
document.getElementById('saved-panel-btn').addEventListener('click',openSavedPanel);
document.getElementById('saved-panel-close').addEventListener('click',closeSavedPanel);
document.getElementById('saved-panel-overlay').addEventListener('click',closeSavedPanel);
async function loadSavedPanelPosts(){
  const body=document.getElementById('saved-panel-body'),empty=document.getElementById('saved-panel-empty');
  if(!body||!state.currentUser)return;
  body.querySelectorAll('.post-card,.skel-saved-post').forEach(c=>c.remove());
  if(empty)empty.style.display='none';
  try{
    const saved=await IDB.getAll();
    let communityPosts=[];
    try{const cpSnap=await get(ref(db,`users/${state.currentUser.uid}/savedCommunityPosts`));if(cpSnap.exists())communityPosts=Object.values(cpSnap.val()).sort((a,b)=>(b.savedAt||0)-(a.savedAt||0));}catch(e){}
    if(saved.length===0&&communityPosts.length===0){if(empty)empty.style.display='block';return;}
    saved.sort((a,b)=>(b.savedAt||0)-(a.savedAt||0));
    saved.forEach(post=>{
      const card=createPostCard(post);
      const badge=document.createElement('div');badge.className='saved-badge';badge.innerHTML='<i data-lucide="bookmark" class="lucide" width="12" height="12"></i> Saved';
      card.style.position='relative';card.insertBefore(badge,card.firstChild);
      const saveBtn=card.querySelector('.save-btn');if(saveBtn)saveBtn.remove();
      const unsaveBtn=document.createElement('button');unsaveBtn.className='post-action-btn';
      unsaveBtn.innerHTML='<span class="btn-icon"><i data-lucide="trash-2" class="lucide" width="16" height="16"></i></span> Remove';
      unsaveBtn.addEventListener('click',async()=>{await IDB.delete(post.postId).catch(()=>{});await remove(ref(db,`savedPosts/${state.currentUser.uid}/${post.postId}`)).catch(()=>{});card.remove();Toast.info('Removed from saved');if(!body.querySelector('.post-card'))if(empty)empty.style.display='block';});
      const actions=card.querySelector('.post-actions');if(actions)actions.appendChild(unsaveBtn);
      body.appendChild(card);
      lucide.createIcons({ nodes: [card] });
    });
    communityPosts.forEach(cp=>{
      const card=document.createElement('div');card.className='post-card';card.style.cssText='cursor:pointer;';
      card.innerHTML=`<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;"><span style="font-size:11px;background:rgba(35, 87, 232, 0.12);color:var(--accent-light);border-radius:var(--radius-pill);padding:2px 8px;font-family:var(--font-mono);"><i data-lucide="pin" class="lucide" width="10" height="10"></i> Community Post</span><span style="font-size:11px;color:var(--muted);">${escHtml(cp.communityName||'')}</span></div><div style="font-size:14px;font-weight:700;color:var(--text);margin-bottom:4px;">${escHtml(cp.postTitle||'(Untitled)')}</div><div style="display:flex;gap:8px;margin-top:8px;"><button class="post-action-btn" data-cp-unsave="${escHtml(cp.postId)}"><span class="btn-icon"><i data-lucide="trash-2" class="lucide" width="16" height="16"></i></span> Unsave</button><button class="post-action-btn" data-cp-open="${escHtml(cp.postId)}" data-cp-community="${escHtml(cp.communityId)}"><span class="btn-icon"><i data-lucide="eye" class="lucide" width="16" height="16"></i></span> View</button></div>`;
      card.querySelector('[data-cp-unsave]').addEventListener('click',async(e)=>{e.stopPropagation();await remove(ref(db,`users/${state.currentUser.uid}/savedCommunityPosts/${cp.postId}`)).catch(()=>{});card.remove();Toast.info('Removed from saved');if(!body.querySelector('.post-card'))if(empty)empty.style.display='block';});
      card.querySelector('[data-cp-open]').addEventListener('click',async(e)=>{e.stopPropagation();closeSavedPanel();openCommunityPost(cp.communityId,cp.postId);});
      body.appendChild(card);
      lucide.createIcons({ nodes: [card] });
    });
  }catch(e){DEBUG && console.warn('[Saved Panel]',e);}
}


Object.assign(window, { openNotifDetail, closeNotifDetail });
