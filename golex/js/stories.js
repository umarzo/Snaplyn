const { state, $, $$, escHtml, timeAgo, generateAvatarUrl, debounce,
  compressImage, fileToBase64,
  auth, db, ref, get, set, onValue, push, serverTimestamp, update, off, remove,
  CONFIG, Toast, ScreenManager, openUserProfileSheet } = window;

/* ═══════════════════════════════════════════════════
   STORIES / STATUS SYSTEM
   ═══════════════════════════════════════════════════ */
const StoriesSystem = {
  _unsubStories: null,
  _seenStories: new Set(),   // story IDs seen this session
  _currentUserStories: [],   // [{uid, stories:[...]}]
  _currentStoryUserIdx: 0,
  _currentStoryIdx: 0,
  _storyTimer: null,
  STORY_DURATION: 5000,

  init() {
    // Load seen story IDs from sessionStorage
    try {
      const saved = sessionStorage.getItem('golex_seen_stories');
      if (saved) this._seenStories = new Set(JSON.parse(saved));
    } catch {}

    this._listenStories();
    this._wireCreateBtn();
    this._wireViewer();
    this._wireCreateModal();
  },

  stop() {
    if (this._unsubStories) { this._unsubStories(); this._unsubStories = null; }
    this._clearStoryTimer();
  },

  _listenStories() {
    if (this._unsubStories) { this._unsubStories(); this._unsubStories = null; }
    const storiesRef = ref(db, 'stories');
    this._unsubStories = onValue(storiesRef, snap => {
      const now = Date.now();
      const allStories = {};
      if (snap.exists()) {
        snap.forEach(userSnap => {
          const uid = userSnap.key;
          const userStories = [];
          userSnap.forEach(storySnap => {
            const s = storySnap.val();
            if (s && s.expiresAt > now) {
              userStories.push({ id: storySnap.key, uid, ...s });
            }
          });
          if (userStories.length > 0) allStories[uid] = userStories;
        });
      }
      this._render(allStories);
    });
  },

  _render(allStories) {
    const scroll = document.getElementById('stories-scroll');
    if (!scroll) return;

    // Keep the add button
    const addBtn = document.getElementById('add-story-btn');
    // Remove old bubbles
    scroll.querySelectorAll('.story-bubble-wrap:not(#add-story-btn)').forEach(el => el.remove());

    // Re-insert add button first
    scroll.insertBefore(addBtn, scroll.firstChild);

    // Check if current user has a story
    const myUid = state.currentUser?.uid;
    if (myUid && allStories[myUid]) {
      const myStories = allStories[myUid];
      const allSeen = myStories.every(s => this._seenStories.has(s.id));
      const wrap = this._buildBubble(myUid, myStories, allSeen, true);
      scroll.insertBefore(wrap, addBtn.nextSibling);
    }

    // Followed users first, then others
    const followedUids = FollowSystem.getFollowedUids();
    const otherUids = [];
    const followedStoryUids = [];

    Object.keys(allStories).forEach(uid => {
      if (uid === myUid) return;
      if (followedUids.has(uid)) followedStoryUids.push(uid);
      else otherUids.push(uid);
    });

    [...followedStoryUids, ...otherUids].forEach(uid => {
      const stories = allStories[uid];
      const allSeen = stories.every(s => this._seenStories.has(s.id));
      const wrap = this._buildBubble(uid, stories, allSeen, false);
      scroll.appendChild(wrap);
    });

    // Build ordered list for viewer
    this._currentUserStories = [];
    if (myUid && allStories[myUid]) this._currentUserStories.push({ uid: myUid, stories: allStories[myUid] });
    followedStoryUids.forEach(uid => this._currentUserStories.push({ uid, stories: allStories[uid] }));
    otherUids.forEach(uid => this._currentUserStories.push({ uid, stories: allStories[uid] }));
  },

  _buildBubble(uid, stories, allSeen, isMe) {
    const wrap = document.createElement('div');
    wrap.className = 'story-bubble-wrap';
    wrap.dataset.uid = uid;

    const bubble = document.createElement('div');
    bubble.className = 'story-bubble' + (allSeen ? ' seen' : '');

    const inner = document.createElement('div');
    inner.className = 'story-bubble-inner';

    const userData = getUserCached(uid);
    if (userData && userData.pfpUrl) {
      inner.innerHTML = `<img src="${escHtml(userData.pfpUrl)}" alt="">`;
    } else if (isMe && state.pfpUrl) {
      inner.innerHTML = `<img src="${escHtml(state.pfpUrl)}" alt="">`;
    } else {
      inner.textContent = initials(userData?.username || (isMe ? state.username : uid));
    }
    bubble.appendChild(inner);
    wrap.appendChild(bubble);

    const label = document.createElement('div');
    label.className = 'story-label' + (allSeen ? '' : ' unseen');
    label.textContent = isMe ? 'You' : (userData?.username || uid.slice(0,8));
    wrap.appendChild(label);

    wrap.addEventListener('click', () => this._openViewer(uid));
    return wrap;
  },

  _wireCreateBtn() {
    const btn = document.getElementById('add-story-btn');
    if (btn) btn.addEventListener('click', () => this._openCreateModal());
  },

  _openCreateModal() {
    document.getElementById('story-create-modal').classList.add('active');
    document.getElementById('story-text-input').value = '';
    document.getElementById('story-char-count').textContent = '0';
    document.getElementById('story-image-preview').classList.remove('visible');
    document.getElementById('story-image-preview').src = '';
    _storyImageData = null;
    // Switch to text mode
    document.getElementById('story-tab-text').click();
  },

  _wireCreateModal() {
    document.getElementById('story-create-close').addEventListener('click', () => {
      document.getElementById('story-create-modal').classList.remove('active');
    });
    document.getElementById('story-create-modal').addEventListener('click', (e) => {
      if (e.target === document.getElementById('story-create-modal')) {
        document.getElementById('story-create-modal').classList.remove('active');
      }
    });

    // Type tabs
    document.querySelectorAll('.story-type-tab[data-type]').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.story-type-tab[data-type]').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const type = tab.dataset.type;
        document.getElementById('story-text-wrap').style.display = type === 'text' ? '' : 'none';
        document.getElementById('story-image-wrap').style.display = type === 'image' ? '' : 'none';
      });
    });

    // Text counter
    document.getElementById('story-text-input').addEventListener('input', function() {
      document.getElementById('story-char-count').textContent = this.value.length;
    });

    // Image pick
    document.getElementById('story-image-input').addEventListener('change', async function() {
      const file = this.files && this.files[0];
      if (!file) return;
      try {
        const result = await compressImage(file);
        _storyImageData = result.dataUrl;
        const preview = document.getElementById('story-image-preview');
        preview.src = _storyImageData;
        preview.classList.add('visible');
      } catch(e) { Toast.error('Could not process image'); }
    });

    document.getElementById('story-post-btn').addEventListener('click', () => this._submitStory());
  },

  _wireViewer() {
    document.getElementById('sv-close').addEventListener('click', () => this._closeViewer());
    document.getElementById('sv-tap-prev').addEventListener('click', () => this._prevStory());
    document.getElementById('sv-tap-next').addEventListener('click', () => this._nextStory());
    document.getElementById('story-viewer').addEventListener('click', (e) => {
      if (e.target === document.getElementById('story-viewer')) this._closeViewer();
    });
  },

  _openViewer(uid) {
    const idx = this._currentUserStories.findIndex(u => u.uid === uid);
    if (idx === -1) return;
    this._currentStoryUserIdx = idx;
    this._currentStoryIdx = 0;
    this._showCurrentStory();
    document.getElementById('story-viewer').classList.add('active');
  },

  openViewerForUser(uid) { this._openViewer(uid); },

  _showCurrentStory() {
    const group = this._currentUserStories[this._currentStoryUserIdx];
    if (!group) { this._closeViewer(); return; }
    const story = group.stories[this._currentStoryIdx];
    if (!story) { this._closeViewer(); return; }

    // Mark as seen
    this._seenStories.add(story.id);
    try { sessionStorage.setItem('golex_seen_stories', JSON.stringify([...this._seenStories])); } catch {}

    // Progress bars
    const barsEl = document.getElementById('story-progress-bars');
    barsEl.innerHTML = '';
    group.stories.forEach((s, i) => {
      const bar = document.createElement('div');
      bar.className = 'story-progress-bar';
      const fill = document.createElement('div');
      fill.className = 'story-progress-fill' + (i < this._currentStoryIdx ? ' done' : '');
      if (i === this._currentStoryIdx) {
        // Will add 'active' after a tick so CSS animation fires
        setTimeout(() => { fill.classList.add('active'); fill.style.setProperty('--story-duration', `${this.STORY_DURATION}ms`); }, 50);
      }
      bar.appendChild(fill);
      barsEl.appendChild(bar);
    });

    // User info
    const userData = getUserCached(story.uid) || {};
    const avatarEl = document.getElementById('sv-avatar');
    const pfp = story.pfpUrl || userData.pfpUrl;
    if (pfp) { avatarEl.innerHTML = `<img src="${escHtml(pfp)}" alt="">`; } else { avatarEl.innerHTML = ''; avatarEl.textContent = initials(userData.username || story.uid); }
    document.getElementById('sv-name').textContent = '@' + (userData.username || story.username || story.uid.slice(0,8));
    // Make avatar + name clickable → open profile (only for other users)
    const _svOpenProfile = () => {
      if (!story.uid || story.uid === state.currentUser?.uid) return;
      this._closeViewer();
      openUserProfileSheet(story.uid, userData.username || story.username || '', userData.skill||'Explorer', userData.level||'Beginner', userData.points||0, pfp||'', userData.bio||'', userData.expertise||null, userData.socialIntegrations||null);
    };
    avatarEl.style.cursor = story.uid !== state.currentUser?.uid ? 'pointer' : 'default';
    avatarEl.onclick = _svOpenProfile;
    const svNameEl = document.getElementById('sv-name');
    svNameEl.style.cursor = story.uid !== state.currentUser?.uid ? 'pointer' : 'default';
    svNameEl.onclick = _svOpenProfile;
    document.getElementById('sv-time').textContent = timeAgo(story.createdAt);

    // Content
    const contentEl = document.getElementById('sv-content');
    if (story.type === 'image' && story.imageUrl) {
      contentEl.innerHTML = `<img class="story-image-display" src="${escHtml(story.imageUrl)}" alt="Story">`;
    } else {
      contentEl.innerHTML = `<div class="story-text-display">${escHtml(story.text || '')}</div>`;
    }

    // Follow button (only for other users)
    const followBtn = document.getElementById('sv-follow-btn');
    if (story.uid !== state.currentUser?.uid) {
      const isF = FollowSystem.isFollowing(story.uid);
      followBtn.textContent = isF ? '✓ Following' : '+ Follow';
      followBtn.className = 'story-follow-btn-viewer' + (isF ? ' following' : '');
      followBtn.dataset.followUid = story.uid;
      followBtn.style.display = '';
      followBtn.onclick = () => FollowSystem.toggle(story.uid, userData.username, userData.skill, followBtn);
    } else {
      followBtn.style.display = 'none';
    }

    // Auto-advance timer
    this._clearStoryTimer();
    this._storyTimer = setTimeout(() => this._nextStory(), this.STORY_DURATION);
  },

  _prevStory() {
    this._clearStoryTimer();
    if (this._currentStoryIdx > 0) {
      this._currentStoryIdx--;
    } else if (this._currentStoryUserIdx > 0) {
      this._currentStoryUserIdx--;
      this._currentStoryIdx = this._currentUserStories[this._currentStoryUserIdx].stories.length - 1;
    }
    this._showCurrentStory();
  },

  _nextStory() {
    this._clearStoryTimer();
    const group = this._currentUserStories[this._currentStoryUserIdx];
    if (this._currentStoryIdx < (group?.stories.length || 1) - 1) {
      this._currentStoryIdx++;
      this._showCurrentStory();
    } else if (this._currentStoryUserIdx < this._currentUserStories.length - 1) {
      this._currentStoryUserIdx++;
      this._currentStoryIdx = 0;
      this._showCurrentStory();
    } else {
      this._closeViewer();
    }
  },

  _closeViewer() {
    document.getElementById('story-viewer').classList.remove('active');
    this._clearStoryTimer();
    // Refresh bubbles to reflect seen state
    if (this._currentUserStories.length) this._listenStories();
  },

  _clearStoryTimer() {
    if (this._storyTimer) { clearTimeout(this._storyTimer); this._storyTimer = null; }
  },

  async _submitStory() {
    if (!state.currentUser) return;
    const activeTab = document.querySelector('.story-type-tab[data-type].active');
    const type = activeTab ? activeTab.dataset.type : 'text';

    const btn = document.getElementById('story-post-btn');
    btn.disabled = true;
    btn.textContent = 'Sharing...';

    try {
      const now = Date.now();
      const storyData = {
        uid: state.currentUser.uid,
        username: state.username,
        pfpUrl: state.pfpUrl || '',
        type,
        createdAt: now,
        expiresAt: now + 24 * 60 * 60 * 1000
      };

      if (type === 'text') {
        const text = document.getElementById('story-text-input').value.trim();
        if (!text) { Toast.error('Write something first'); return; }
        storyData.text = text;
      } else {
        if (!_storyImageData) { Toast.error('Pick an image first'); return; }
        storyData.imageUrl = _storyImageData;
      }

      await push(ref(db, `stories/${state.currentUser.uid}`), storyData);
      document.getElementById('story-create-modal').classList.remove('active');
      Toast.success('Story shared for 24h', 3000);
    } catch(e) {
      Toast.error('Could not share story — try again');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i data-lucide="flame" class="lucide" width="16" height="16"></i> Share Story — Live for 24h';
    }
  }
};

let _storyImageData = null; // global for story image


// ── Export to window ──
Object.assign(window, { StoriesSystem });
