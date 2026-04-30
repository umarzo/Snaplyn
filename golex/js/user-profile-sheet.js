const { state, $, $$, escHtml, badgeHTML, generateAvatarUrl, timeAgo, debounce,
  compressImage, db, ref, get, set, update, push, serverTimestamp, off, onValue,
  CONFIG, Toast, ScreenManager, StoriesSystem, openChat,
  ReportModal, BlockSystem, ConfirmModal, cacheUser, getUserCached } = window;

   FOLLOW / CONNECTION SYSTEM
   ═══════════════════════════════════════════════════ */
const FollowSystem = {
  // Local cache of who current user follows (uid → true)
  _following: new Map(),
  _unsubFollowing: null,

  // Start listening to current user's following list
  init(myUid) {
    if (this._unsubFollowing) { this._unsubFollowing(); this._unsubFollowing = null; }
    const followRef = ref(db, `follows/${myUid}`);
    this._unsubFollowing = onValue(followRef, snap => {
      this._following.clear();
      if (snap.exists()) {
        Object.keys(snap.val()).forEach(uid => this._following.set(uid, true));
      }
      // Update all follow buttons on screen
      this._syncAllButtons();
      // Update profile modal follow stats
      this._updateProfileStats(myUid);
    });
  },

  stop() {
    if (this._unsubFollowing) { this._unsubFollowing(); this._unsubFollowing = null; }
    this._following.clear();
  },

  isFollowing(uid) {
    return this._following.has(uid);
  },

  async follow(targetUid, targetUsername, targetSkill) {
    if (!state.currentUser) return;
    const myUid = state.currentUser.uid;
    if (targetUid === myUid) return;
    try {
      await set(ref(db, `follows/${myUid}/${targetUid}`), true);
      await set(ref(db, `followers/${targetUid}/${myUid}`), true);
      // Notify target
      await NotifSystem.push(targetUid, 'follow',
        `@${state.username || 'Someone'} started following you!`);
      // Award points to follower
      update(ref(db, `users/${myUid}`), { points: increment(2) }).catch(() => {});
      Toast.success(`Following @${targetUsername || targetUid}`);
    } catch(e) { Toast.error('Could not follow — try again'); }
  },

  async unfollow(targetUid, targetUsername) {
    if (!state.currentUser) return;
    const myUid = state.currentUser.uid;
    try {
      await remove(ref(db, `follows/${myUid}/${targetUid}`));
      await remove(ref(db, `followers/${targetUid}/${myUid}`));
      Toast.info(`Unfollowed @${targetUsername || targetUid}`);
    } catch(e) { Toast.error('Could not unfollow — try again'); }
  },

  async toggle(targetUid, targetUsername, targetSkill, btn) {
    if (!state.currentUser || targetUid === state.currentUser.uid) return;
    if (btn) { btn.disabled = true; }
    if (this.isFollowing(targetUid)) {
      await this.unfollow(targetUid, targetUsername);
    } else {
      await this.follow(targetUid, targetUsername, targetSkill);
    }
    if (btn) { btn.disabled = false; }
  },

  // Get follower count for a user
  async getFollowerCount(uid) {
    try {
      const snap = await get(ref(db, `followers/${uid}`));
      return snap.exists() ? Object.keys(snap.val()).length : 0;
    } catch { return 0; }
  },

  // Get following count for a user
  async getFollowingCount(uid) {
    try {
      const snap = await get(ref(db, `follows/${uid}`));
      return snap.exists() ? Object.keys(snap.val()).length : 0;
    } catch { return 0; }
  },

  // Check if two users mutually follow each other
  async isMutual(uid1, uid2) {
    try {
      const [f1, f2] = await Promise.all([
        get(ref(db, `follows/${uid1}/${uid2}`)),
        get(ref(db, `follows/${uid2}/${uid1}`))
      ]);
      return f1.exists() && f2.exists();
    } catch { return false; }
  },

  _syncAllButtons() {
    document.querySelectorAll('[data-follow-uid]').forEach(btn => {
      const uid = btn.dataset.followUid;
      this._updateBtn(btn, uid);
    });
  },

  _updateBtn(btn, uid) {
    const isF = this.isFollowing(uid);
    if (btn.classList.contains('post-follow-btn')) {
      btn.textContent = isF ? '✓ Following' : '+ Follow';
      btn.classList.toggle('following', isF);
    } else if (btn.classList.contains('follow-btn')) {
      btn.textContent = isF ? '✓ Following' : '+ Follow';
      btn.classList.toggle('following', isF);
    }
  },

  async _updateProfileStats(myUid) {
    const [followers, following] = await Promise.all([
      this.getFollowerCount(myUid),
      this.getFollowingCount(myUid)
    ]);
    const sfEl = document.getElementById('stat-followers');
    const sgEl = document.getElementById('stat-following');
    if (sfEl) sfEl.textContent = followers;
    if (sgEl) sgEl.textContent = following;
  },

  // Get set of followed UIDs
  getFollowedUids() {
    return new Set(this._following.keys());
  }
};

/* ─── User Profile Sheet (tap avatar on post to view profile) ─── */
let _upsCurrentUid = null;
/* ═══════════════════════════════════════════════════
   FULL USER PROFILE SHEET — UPGRADED v2
   ═══════════════════════════════════════════════════ */

// Cache for story lookup
let _upsHasStory = false;

function openUserProfileSheet(uid, username, skill, level, points, pfpUrl, bio, expertiseData, socialData) {
  if (username && typeof username === 'object') {
    const src = username;
    username = src.username || src.user || '';
    skill = src.skill || 'Explorer';
    level = src.level || 'Beginner';
    points = Number(src.points || 0);
    pfpUrl = src.pfpUrl || '';
    bio = src.bio || '';
    expertiseData = src.expertise || null;
    socialData = src.socialIntegrations || null;
  }
  if (uid === state.currentUser?.uid) { document.getElementById('profile-icon-btn').click(); return; }
  _upsCurrentUid = uid;
  _portfolioTargetUid = uid;

  // Reset tabs to Posts on open
  document.querySelectorAll('.ups-tab-btn').forEach(b => {
    b.classList.remove('active');
    b.style.borderBottomColor = 'transparent';
    b.style.color = 'var(--muted)';
  });
  const postsTab = document.getElementById('ups-tab-posts');
  if (postsTab) { postsTab.classList.add('active'); postsTab.style.borderBottomColor = 'var(--accent)'; postsTab.style.color = 'var(--text)'; }
  const postsSection = document.querySelector('.ups-posts-section');
  const workPanel    = document.getElementById('ups-work-panel');
  if (postsSection) postsSection.style.display = '';
  if (workPanel)    workPanel.style.display = 'none';

  // ── Avatar ──
  const avatarInner = document.getElementById('ups-avatar');
  if (pfpUrl) {
    avatarInner.innerHTML = `<img src="${escHtml(pfpUrl)}" alt="${escHtml(username)}">`;
  } else {
    avatarInner.innerHTML = '';
    avatarInner.textContent = initials(username);
  }

  // ── Identity ──
  document.getElementById('ups-name').textContent = '@' + (username || uid);
  document.getElementById('ups-handle').textContent = skill || 'Explorer';

  // ── Skill pill ──
  const pillWrap = document.getElementById('ups-skill-pill-wrap');
  pillWrap.innerHTML = `<div class="ups-skill-pill"><i data-lucide="wrench" class="lucide" width="12" height="12"></i> ${escHtml(skill || 'Explorer')} · ${escHtml(level || 'Beginner')}</div>`;

  // ── Bio ──
  const bioEl = document.getElementById('ups-bio');
  bioEl.textContent = bio || '';
  bioEl.style.display = bio ? 'block' : 'none';
  // ── Pro: reset + load from Firebase ──
  const _upsProRow = document.getElementById('ups-pro-row');
  const _upsTgl    = document.getElementById('ups-tagline');
  const _upsAvOuter = document.getElementById('ups-avatar-outer');
  if (_upsProRow) _upsProRow.innerHTML = '';
  if (_upsTgl)    { _upsTgl.textContent = ''; _upsTgl.style.display = 'none'; }
  if (_upsAvOuter) _upsAvOuter.classList.remove('is-pro-user');
  get(ref(db, `users/${uid}`)).then(snap => {
    if (!snap.exists()) return;
    const _d = snap.val();
    if (_d.isPro && _upsProRow) {
      const _since = _d.proSince ? new Date(_d.proSince).toLocaleDateString('en-IN',{month:'short',year:'numeric'}) : '';
      _upsProRow.innerHTML = `<div class="ups-pro-row"><span class="pro-badge"><i data-lucide="award" class="lucide" width="12" height="12"></i> Pro</span>${_since ? `<span class="ups-pro-since">since ${_since}</span>` : ''}</div>`;
      if (_upsAvOuter) _upsAvOuter.classList.add('is-pro-user');
    }
    if (_d.tagline && _upsTgl) {
      _upsTgl.textContent = '“' + _d.tagline + '”';
      _upsTgl.style.display = 'block';
    }
  }).catch(() => {});
  // ── Track profile view (Pro analytics) ──
  if (state.currentUser && uid !== state.currentUser.uid) {
    set(ref(db, `profileViews/${uid}/${state.currentUser.uid}`), Date.now()).catch(() => {});
  }

  // ── Stats ──
  document.getElementById('ups-rep-val').textContent = points || 0;
  document.getElementById('ups-level-val').textContent = level || 'Beginner';
  document.getElementById('ups-endorse-count-val').textContent = '…';
  document.getElementById('ups-msgs-val').textContent = '…';

  // ── Follow stats ──
  document.getElementById('ups-followers-count').textContent = '…';
  document.getElementById('ups-following-count').textContent = '…';
  const mutualBadge = document.getElementById('ups-mutual-badge');
  mutualBadge.classList.remove('show');

  Promise.all([
    FollowSystem.getFollowerCount(uid),
    FollowSystem.getFollowingCount(uid),
    FollowSystem.isMutual(state.currentUser?.uid, uid)
  ]).then(([followers, following, mutual]) => {
    document.getElementById('ups-followers-count').textContent = followers;
    document.getElementById('ups-following-count').textContent = following;
    if (mutual) mutualBadge.classList.add('show');
  }).catch(() => {});

  // ── Endorsement count ──
  get(ref(db, `endorsements/${uid}`)).then(snap => {
    const count = snap.exists() ? Object.keys(snap.val()).length : 0;
    document.getElementById('ups-endorse-count-val').textContent = count;
  }).catch(() => {});

  // ── Message count (from DM node) ──
  if (state.currentUser) {
    const chatId = [state.currentUser.uid, uid].sort().join('_');
    get(ref(db, `chats/${chatId}/messages`)).then(snap => {
      document.getElementById('ups-msgs-val').textContent = snap.exists() ? Object.keys(snap.val()).length : 0;
    }).catch(() => { document.getElementById('ups-msgs-val').textContent = '—'; });
  }

  // ── Story ring ──
  _upsHasStory = false;
  const avatarOuter = document.getElementById('ups-avatar-outer');
  avatarOuter.className = 'ups-avatar-outer no-story';
  avatarOuter.onclick = null;
  try {
    if (typeof StoriesSystem !== 'undefined' && StoriesSystem._currentUserStories) {
      const userStory = StoriesSystem._currentUserStories.find(s => s.uid === uid);
      if (userStory && userStory.stories && userStory.stories.length > 0) {
        _upsHasStory = true;
        avatarOuter.className = 'ups-avatar-outer';
        avatarOuter.title = 'View story';
        avatarOuter.onclick = () => {
          closeUserProfileSheet();
          StoriesSystem.openViewerForUser(uid);
        };
      }
    }
  } catch(e) {}

  // ── Follow button ──
  const followBtn = document.getElementById('ups-follow-btn');
  const isF = FollowSystem.isFollowing(uid);
  followBtn.textContent = isF ? '✓ Following' : '+ Follow';
  followBtn.className = 'ups-follow-action-btn' + (isF ? ' following' : '');
  followBtn.onclick = () => {
    FollowSystem.toggle(uid, username, skill, followBtn);
    // Update class after toggle
    setTimeout(() => {
      const nowF = FollowSystem.isFollowing(uid);
      followBtn.textContent = nowF ? '✓ Following' : '+ Follow';
      followBtn.className = 'ups-follow-action-btn' + (nowF ? ' following' : '');
    }, 600);
  };

  // ── Message button ──
  document.getElementById('ups-msg-btn').onclick = () => {
    closeUserProfileSheet();
    openChat(uid, username, skill, level, points);
  };

  // ── Endorse button ──
  _upsSetupEndorseBtn(uid, skill);

  // ── Copy link ──
  document.getElementById('ups-copy-link-btn').onclick = () => {
    const link = `${window.location.origin}${window.location.pathname}?uid=${uid}`;
    navigator.clipboard.writeText(link).then(() => Toast.success('Profile link copied!')).catch(() => {
      const ta = document.createElement('textarea'); ta.value = link;
      ta.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(ta);
      ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
      Toast.success('Profile link copied!');
    });
  };

  // ── Report button ──
  document.getElementById('ups-report-btn').onclick = () => {
    openReportModal({ targetUid: uid, targetUsername: username, targetType: 'user', contentPreview: '' });
  };

  // ── Block button ──
  const blockBtn = document.getElementById('ups-block-btn');
  const blockLabel = document.getElementById('ups-block-label');
  BlockSystem.isBlocked(uid).then(blocked => {
    blockLabel.textContent = blocked ? 'Unblock' : 'Block';
  });
  blockBtn.onclick = async () => {
    const alreadyBlocked = await BlockSystem.isBlocked(uid);
    if (alreadyBlocked) {
      const ok = await ConfirmModal.show({ icon: 'lock-open', title: `Unblock @${username}?`, sub: 'You will be able to message each other again.', confirmText: 'Unblock', cancelText: 'Cancel', danger: false });
      if (!ok) return;
      await BlockSystem.unblock(uid); blockLabel.textContent = 'Block'; Toast.info('User unblocked');
    } else {
      const ok = await ConfirmModal.show({ icon: 'ban', title: `Block @${username}?`, sub: "You won't be able to message each other.", confirmText: 'Block', cancelText: 'Cancel', danger: true });
      if (!ok) return;
      await BlockSystem.block(uid); blockLabel.textContent = 'Unblock'; Toast.info('User blocked');
      closeUserProfileSheet();
    }
    lucideCreate();

  };

  // ── Expertise ──
  const expertiseWrap = document.getElementById('ups-expertise-wrap');
  if (expertiseWrap) {
    if (typeof ExpertiseModule !== 'undefined' && expertiseData) {
      expertiseWrap.innerHTML = '<div class="ups-section-label">Skills & Expertise</div>' + ExpertiseModule.buildDisplayHTML(expertiseData);
    } else {
      expertiseWrap.innerHTML = '';
    }
  }
  if (typeof SocialIntegrationsModule !== 'undefined' && SocialIntegrationsModule.renderInPanel) {
    try {
      SocialIntegrationsModule.renderInPanel('ups-social-wrap', socialData || null);
    } catch (_) {}
    get(ref(db, `users/${uid}/socialIntegrations`)).then(snap => {
      try { SocialIntegrationsModule.renderInPanel('ups-social-wrap', snap.exists() ? snap.val() : null); } catch (_) {}
    }).catch(() => {});
  }

  // ── Posts (last 24h) ──
  _upsLoadUserPosts(uid, username, pfpUrl);

  // ── Open ──
  document.getElementById('user-profile-sheet').classList.add('active');
  if (typeof lucide !== 'undefined') lucideCreate();
}

async function _upsSetupEndorseBtn(uid, skill) {
  const btn = document.getElementById('ups-endorse-btn');
  if (!btn || !state.currentUser || uid === state.currentUser.uid) {
    if (btn) btn.style.display = 'none';
    return;
  }
  btn.style.display = 'flex';
  btn.disabled = true;
  btn.innerHTML = '<i data-lucide="loader" class="lucide" width="16" height="16"></i> Loading…';
  lucideCreate();

  try {
    const snap = await get(ref(db, `endorsements/${uid}`));
    const endorsements = snap.val() || {};
    const alreadyEndorsed = !!endorsements[state.currentUser.uid];
    btn.disabled = false;
    if (alreadyEndorsed) {
      btn.className = 'ups-endorse-btn endorsed';
      btn.innerHTML = '<i data-lucide="check-circle" class="lucide" width="16" height="16"></i> Endorsed ✓';
    } else {
      btn.className = 'ups-endorse-btn';
      btn.innerHTML = '<i data-lucide="award" class="lucide" width="16" height="16"></i> Endorse';
    }
    lucideCreate();

    const newBtn = btn.cloneNode(true);
    btn.replaceWith(newBtn);
    const countEl = document.getElementById('ups-endorse-count-val');
    newBtn.addEventListener('click', () => handleEndorse(uid, skill, alreadyEndorsed, newBtn, countEl));
  } catch(e) {
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="award" class="lucide" width="16" height="16"></i> Endorse';
    lucideCreate();

  }
}

async function _upsLoadUserPosts(uid, username, pfpUrl) {
  const listEl = document.getElementById('ups-posts-list');
  const loadingEl = document.getElementById('ups-posts-loading');
  if (!listEl) return;
  listEl.innerHTML = [0,1,2].map(() => `
    <div class="skel-ups-post">
      <div class="skel-ups-post-header">
        <div class="skel skel-round" style="width:30px;height:30px;"></div>
        <div class="skel-ups-post-meta">
          <div class="skel skeleton-line" style="width:80px;margin:0;"></div>
          <div class="skel skeleton-line xs" style="width:50px;margin-top:4px;"></div>
        </div>
      </div>
      <div class="skel skeleton-line full" style="margin-bottom:5px;"></div>
      <div class="skel skeleton-line medium" style="margin-bottom:5px;"></div>
      <div class="skel skeleton-line short"></div>
    </div>`).join('');
  lucideCreate();


  try {
    const snap = await get(query(ref(db, 'posts'), orderByChild('userId'), equalTo(uid)));
    const now = Date.now();
    const cutoff = now - 24 * 60 * 60 * 1000;

    if (!snap.exists()) {
      listEl.innerHTML = '<div class="ups-no-posts">No posts in the last 24h</div>';
      return;
    }

    const posts = [];
    snap.forEach(child => {
      const p = child.val();
      if ((p.timestamp || 0) >= cutoff) posts.push({ ...p, postId: child.key });
    });

    posts.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    if (posts.length === 0) {
      listEl.innerHTML = '<div class="ups-no-posts">No posts in the last 24h</div>';
      return;
    }

    listEl.innerHTML = '';
    posts.forEach(p => {
      const ago = typeof timeAgo === 'function' ? timeAgo(p.timestamp) : 'recently';
      const card = document.createElement('div');
      card.className = 'ups-post-card';
      const content = p.content || p.text || '';
      const hasImg = p.imageUrl || p.mediaUrl;
      card.innerHTML = `
        <div class="ups-post-card-content">${escHtml(content)}${hasImg ? ' [img]' : ''}</div>
        <div class="ups-post-card-meta">
          <span>${ago}</span>
          ${p.skill ? `<span class="ups-post-card-tag">${escHtml(p.skill)}</span>` : ''}
          ${p.likes ? `<span><i data-lucide="heart" class="lucide" width="12" height="12"></i> ${Object.keys(p.likes).length}</span>` : ''}
        </div>`;
      listEl.appendChild(card);
    });
    lucideCreate();

  } catch(e) {
    listEl.innerHTML = '<div class="ups-no-posts">Could not load posts</div>';
  }
}


// ── Export to window ──
Object.assign(window, { FollowSystem, openUserProfileSheet });
