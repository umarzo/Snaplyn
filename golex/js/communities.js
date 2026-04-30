const { state, $, $$, escHtml, badgeHTML, generateAvatarUrl, timeAgo, debounce,
  compressImage,
  db, ref, get, set, onValue, onChildAdded, push, serverTimestamp,
  update, off, remove, query, orderByChild, equalTo,
  CONFIG, Toast, ScreenManager, ConfirmModal, ReportModal,
  openUserProfileSheet, cacheUser, getUserCached } = window;


// ══════════════════════════════════════════
//  COMMUNITIES SCREEN
// ══════════════════════════════════════════
const _commState = {
  listener: null,
  handlersBound: false,
  activeNiche: 'all',
  activeTab: 'discover',
  searchQuery: '',
  allCommunities: {}
};

function loadCommunitiesScreen() {
  if (_commState.listener) {
    _commState.listener();
    _commState.listener = null;
  }
  if (!_commState.handlersBound) {
    document.querySelectorAll('#communities-filter-row .filter-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        document.querySelectorAll('#communities-filter-row .filter-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        _commState.activeNiche = pill.dataset.niche;
        renderCommunitiesList();
      });
    });
    document.getElementById('comm-tab-discover').addEventListener('click', () => {
      document.getElementById('comm-tab-discover').classList.add('active');
      document.getElementById('comm-tab-joined').classList.remove('active');
      _commState.activeTab = 'discover';
      renderCommunitiesList();
    });
    document.getElementById('comm-tab-joined').addEventListener('click', () => {
      document.getElementById('comm-tab-joined').classList.add('active');
      document.getElementById('comm-tab-discover').classList.remove('active');
      _commState.activeTab = 'joined';
      renderCommunitiesList();
    });
    const debouncedCommunitySearch = debounce((value) => {
      _commState.searchQuery = value;
      renderCommunitiesList();
    }, 120);
    document.getElementById('communities-search').addEventListener('input', (e) => {
      debouncedCommunitySearch(e.target.value.trim().toLowerCase());
    });
    document.getElementById('community-create-btn').addEventListener('click', () => {
      ScreenManager.show('community-create-screen');
    });
    _commState.handlersBound = true;
  }
  _commState.listener = onValue(ref(db, 'communities'), snap => {
    ['skel-comm-1','skel-comm-2','skel-comm-3','skel-comm-4'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
    _commState.allCommunities = snap.exists() ? snap.val() : {};
    renderCommunitiesList();
  });
}

function renderCommunitiesList() {
  const list = document.getElementById('communities-list');
  if (!list) return;
  list.querySelectorAll('.community-card, #communities-empty-msg').forEach(c => c.remove());
  const fragment = document.createDocumentFragment();
  let communities = Object.values(_commState.allCommunities);
  if (_commState.activeNiche !== 'all') {
    communities = communities.filter(c => (c.niche||'').toLowerCase() === _commState.activeNiche);
  }
  if (_commState.activeTab === 'joined') {
    communities = communities.filter(c => state.currentUser && c.members && c.members[state.currentUser.uid]);
  }
  if (_commState.searchQuery) {
    communities = communities.filter(c =>
      (c.name||'').toLowerCase().includes(_commState.searchQuery) ||
      (c.description||'').toLowerCase().includes(_commState.searchQuery)
    );
  }
  if (communities.length === 0) {
    const empty = document.createElement('div');
    empty.id = 'communities-empty-msg';
    empty.style.cssText = 'text-align:center;padding:40px 16px;color:var(--muted);font-size:13px;';
    empty.innerHTML = `<div style="margin-bottom:8px;"><i data-lucide="globe" class="lucide" width="32" height="32"></i></div>
      <div style="font-weight:700;color:var(--text-secondary);">No communities found</div>
      <div style="font-size:12px;margin-top:4px;">Try a different filter or create one!</div>`;
    fragment.appendChild(empty);
    list.appendChild(fragment);
    return;
  }
  const uid = state.currentUser ? state.currentUser.uid : null;
  communities.forEach(community => {
    const isJoined = uid && community.members && community.members[uid];
    const card = document.createElement('div');
    card.className = 'community-card' + (community.creatorIsPro ? ' is-pro-creator' : '');
    card.dataset.cid = community.communityId;
    card.innerHTML = `
      ${community.creatorIsPro ? '<div class="comm-pro-pin" title="Pro Community"><i data-lucide="star" class="lucide" width="12" height="12"></i></div>' : ''}
      <div class="community-card-icon">${renderLucideIcon(community.icon||'globe', 20)}</div>
      <div class="community-card-body">
        <div class="community-card-name">${escHtml(community.name||'Unnamed')}</div>
        <span class="community-niche-badge">${escHtml(community.niche||'general')}</span>
        <div class="community-card-desc">${escHtml(community.description||'')}</div>
        <div class="community-card-meta">${(community.memberCount||0).toLocaleString()} members · ${(community.postCount||0).toLocaleString()} posts</div>
      </div>
      <button class="community-join-btn${isJoined?' joined':''}" data-cid="${escHtml(community.communityId)}">
        ${isJoined ? 'Joined' : 'Join'}
      </button>`;
    card.addEventListener('click', (e) => {
      if (e.target.closest('.community-join-btn')) return;
      openCommunityFeed(community.communityId);
    });
    card.querySelector('.community-join-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!state.currentUser) return;
      const btn = e.currentTarget;
      const cid = community.communityId;
      const alreadyJoined = btn.classList.contains('joined');
      try {
        await update(ref(db), {
          [`communities/${cid}/members/${uid}`]: alreadyJoined ? null : true,
          [`users/${uid}/joinedCommunities/${cid}`]: alreadyJoined ? null : true,
          [`communities/${cid}/memberCount`]: increment(alreadyJoined ? -1 : 1)
        });
        btn.textContent = alreadyJoined ? 'Join' : 'Joined';
        btn.classList.toggle('joined', !alreadyJoined);
      } catch(err) { Toast.error('Action failed. Try again.'); }
    });
    fragment.appendChild(card);
  });
  list.appendChild(fragment);
}

// ══════════════════════════════════════════
//  COMMUNITY FEED SCREEN
// ══════════════════════════════════════════
const _commFeedState = {
  communityId: null, communityData: null,
  postsListener: null, communityListener: null, outsideClickListener: null,
  controlsBound: false,
  activeType: 'all', activeSort: 'hot',
  activeSubTab: 'posts', allPosts: {}
};

function cleanupCommunityFeedListeners() {
  if (_commFeedState.postsListener) {
    _commFeedState.postsListener();
    _commFeedState.postsListener = null;
  }
  if (_commFeedState.communityListener) {
    _commFeedState.communityListener();
    _commFeedState.communityListener = null;
  }
}

function openCommunityFeed(communityId) {
  _commFeedState.communityId = communityId;
  _commFeedState.activeType = 'all';
  _commFeedState.activeSort = 'hot';
  _commFeedState.activeSubTab = 'posts';
  ScreenManager.show('community-feed-screen');
  loadCommunityFeedScreen(communityId);
}

function loadCommunityFeedScreen(communityId) {
  cleanupCommunityFeedListeners();
  if (_commFeedState.outsideClickListener) {
    document.removeEventListener('click', _commFeedState.outsideClickListener);
    _commFeedState.outsideClickListener = null;
  }
  const uid = state.currentUser ? state.currentUser.uid : null;
  const backBtn = document.getElementById('comm-feed-back');
  backBtn.onclick = () => {
    cleanupCommunityFeedListeners();
    if (_commFeedState.outsideClickListener) {
      document.removeEventListener('click', _commFeedState.outsideClickListener);
      _commFeedState.outsideClickListener = null;
    }
    ScreenManager.show('communities-screen');
  };
  _commFeedState.communityListener = onValue(ref(db, `communities/${communityId}`), snap => {
    if (!snap.exists()) return;
    const c = snap.val();
    _commFeedState.communityData = c;
    const _cfi = document.getElementById('comm-feed-icon'); if(_cfi){ _cfi.innerHTML = renderLucideIcon(c.icon || 'globe', 22); lucideCreate(); }
    document.getElementById('comm-feed-name').textContent = c.name || 'Community';
    document.getElementById('comm-feed-member-badge').textContent = `${(c.memberCount||0).toLocaleString()} members`;
    const joinBtn = document.getElementById('comm-feed-join-btn');
    const isJoined = uid && c.members && c.members[uid];
    joinBtn.textContent = isJoined ? 'Joined' : 'Join';
    joinBtn.className = 'comm-feed-join-btn' + (isJoined ? ' joined' : '');
    document.getElementById('comm-about-desc').textContent = c.description || '';
    const rulesList = document.getElementById('comm-rules-list');
    rulesList.innerHTML = '';
    if (Array.isArray(c.rules)) {
      c.rules.forEach((rule, i) => {
        const li = document.createElement('li');
        li.textContent = `${i+1}. ${rule}`;
        rulesList.appendChild(li);
      });
    }
    document.getElementById('comm-about-meta').innerHTML =
      `<i data-lucide="user" class="lucide" width="16" height="16"></i> Created by <strong>${escHtml(c.creatorUsername||'')}</strong> · ${timeAgo(c.createdAt)} · ${(c.memberCount||0)} members · ${(c.postCount||0)} posts`;
    // Refresh delete button visibility whenever community data updates
    const delBtn = document.getElementById('comm-feed-delete-btn');
    if (delBtn) delBtn.style.display = (uid && c.creatorId === uid) ? '' : 'none';
  });
  document.getElementById('comm-feed-join-btn').onclick = async () => {
    if (!uid) return;
    const c = _commFeedState.communityData;
    const isJoined = c && c.members && c.members[uid];
    try {
      await update(ref(db), {
        [`communities/${communityId}/members/${uid}`]: isJoined ? null : true,
        [`users/${uid}/joinedCommunities/${communityId}`]: isJoined ? null : true,
        [`communities/${communityId}/memberCount`]: increment(isJoined ? -1 : 1)
      });
    } catch(e) { Toast.error('Failed. Try again.'); }
  };
  const moreBtn = document.getElementById('comm-feed-more-btn');
  const moreDropdown = document.getElementById('comm-feed-more-dropdown');
  moreBtn.onclick = (e) => { e.stopPropagation(); moreDropdown.classList.toggle('open'); };
  _commFeedState.outsideClickListener = (e) => {
    if (moreDropdown.contains(e.target) || moreBtn.contains(e.target)) return;
    moreDropdown.classList.remove('open');
  };
  document.addEventListener('click', _commFeedState.outsideClickListener);
  document.getElementById('comm-feed-share-btn').onclick = () => { moreDropdown.classList.remove('open'); Toast.info('Share link copied!'); };
  document.getElementById('comm-feed-report-btn').onclick = () => {
    moreDropdown.classList.remove('open');
    push(ref(db, 'hq/reports'), { type: 'community', communityId, reportedBy: uid, ts: Date.now(), status: 'pending' });
    Toast.info('Community reported. Thank you.');
  };

  // ── Delete Community (creator only) ──
  const deleteCommBtn = document.getElementById('comm-feed-delete-btn');
  const isCreator = _commFeedState.communityData && _commFeedState.communityData.creatorId === uid;
  deleteCommBtn.style.display = isCreator ? '' : 'none';
  deleteCommBtn.onclick = async () => {
    moreDropdown.classList.remove('open');
    const communityName = _commFeedState.communityData ? _commFeedState.communityData.name : 'this community';
    const confirmed = await ConfirmModal.show({
      icon: 'trash-2',
      title: `Delete "${communityName}"?`,
      sub: 'This will permanently delete the community and all its posts. This cannot be undone.',
      confirmText: 'Delete',
      cancelText: 'Cancel',
      danger: true
    });
    if (!confirmed) return;
    try {
      // Build multi-path delete: community node + all members' joinedCommunities entries
      const membersSnap = await get(ref(db, `communities/${communityId}/members`)).catch(() => null);
      const updates = { [`communities/${communityId}`]: null };
      if (membersSnap && membersSnap.exists()) {
        Object.keys(membersSnap.val()).forEach(memberId => {
          updates[`users/${memberId}/joinedCommunities/${communityId}`] = null;
        });
      }
      await update(ref(db), updates);
      Toast.info('Community deleted.');
      cleanupCommunityFeedListeners();
      if (_commFeedState.outsideClickListener) {
        document.removeEventListener('click', _commFeedState.outsideClickListener);
        _commFeedState.outsideClickListener = null;
      }
      ScreenManager.show('communities-screen');
      loadCommunitiesScreen();
    } catch(e) {
      Toast.error('Delete failed. Try again.');
      DEBUG && console.error('[DeleteCommunity]', e);
    }
  };
  document.getElementById('comm-tab-posts').onclick = () => {
    document.getElementById('comm-tab-posts').classList.add('active');
    document.getElementById('comm-tab-about').classList.remove('active');
    document.getElementById('comm-about-panel').classList.remove('active');
    document.getElementById('comm-posts-controls').style.display = '';
    document.getElementById('community-posts-feed').style.display = '';
    document.getElementById('comm-feed-fab').style.display = 'flex';
    _commFeedState.activeSubTab = 'posts';
  };
  document.getElementById('comm-tab-about').onclick = () => {
    document.getElementById('comm-tab-about').classList.add('active');
    document.getElementById('comm-tab-posts').classList.remove('active');
    document.getElementById('comm-about-panel').classList.add('active');
    document.getElementById('comm-posts-controls').style.display = 'none';
    document.getElementById('community-posts-feed').style.display = 'none';
    document.getElementById('comm-feed-fab').style.display = 'none';
    _commFeedState.activeSubTab = 'about';
  };
  if (!_commFeedState.controlsBound) {
    document.querySelectorAll('#comm-type-filters .filter-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        document.querySelectorAll('#comm-type-filters .filter-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        _commFeedState.activeType = pill.dataset.type;
        renderCommunityPosts();
      });
    });
    document.querySelectorAll('.comm-sort-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.comm-sort-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _commFeedState.activeSort = btn.dataset.sort;
        renderCommunityPosts();
      });
    });
    _commFeedState.controlsBound = true;
  }
  document.getElementById('comm-feed-fab').onclick = () => { openCommunityPostCreator(communityId); };
  document.querySelectorAll('.comm-skel-1,.comm-skel-2,.comm-skel-3').forEach(s => s.style.display = 'flex');
  _commFeedState.postsListener = onValue(ref(db, `communities/${communityId}/posts`), snap => {
    document.querySelectorAll('.comm-skel-1,.comm-skel-2,.comm-skel-3').forEach(s => s.style.display = 'none');
    _commFeedState.allPosts = snap.exists() ? snap.val() : {};
    renderCommunityPosts();
  });
}

function renderCommunityPosts() {
  const feed = document.getElementById('community-posts-feed');
  if (!feed) return;
  feed.querySelectorAll('.comm-post-card, #comm-posts-empty-msg').forEach(c => c.remove());
  const fragment = document.createDocumentFragment();
  let posts = Object.values(_commFeedState.allPosts);
  if (_commFeedState.activeType !== 'all') {
    posts = posts.filter(p => (p.type||'').toLowerCase() === _commFeedState.activeType);
  }
  switch(_commFeedState.activeSort) {
    case 'hot':    posts.sort((a,b) => (b.netScore||0)*0.7+(b.repliesCount||0)*0.3 - ((a.netScore||0)*0.7+(a.repliesCount||0)*0.3)); break;
    case 'new':    posts.sort((a,b) => (b.createdAt||0)-(a.createdAt||0)); break;
    case 'top':    posts.sort((a,b) => (b.netScore||0)-(a.netScore||0)); break;
    case 'rising': posts.sort((a,b) => { const age=h=>Math.max(1,(Date.now()-h)/3600000); return ((b.netScore||0)/age(b.createdAt||Date.now()))-((a.netScore||0)/age(a.createdAt||Date.now())); }); break;
  }
  if (posts.length === 0) {
    const empty = document.createElement('div');
    empty.id = 'comm-posts-empty-msg';
    empty.style.cssText = 'text-align:center;padding:40px 16px;color:var(--muted);font-size:13px;';
    empty.innerHTML = `<div style="margin-bottom:8px;"><i data-lucide="inbox" class="lucide" width="32" height="32"></i></div><div>No posts yet. Be the first!</div>`;
    fragment.appendChild(empty);
    feed.appendChild(fragment);
    lucideCreate();
    return;
  }
  const uid = state.currentUser ? state.currentUser.uid : null;
  posts.forEach(post => { fragment.appendChild(createCommPostCard(post, uid, _commFeedState.communityId)); });
  feed.appendChild(fragment);
}

function createCommPostCard(post, uid, communityId) {
  const card = document.createElement('div');
  card.className = 'comm-post-card';
  const typeClass = `type-${(post.type||'discussion').toLowerCase()}`;
  const userVote = uid && post.userVotes ? post.userVotes[uid] : null;
  const initials = (post.authorUsername||'?').substring(0,2).toUpperCase();
  let avatarHTML = `<div class="comm-post-avatar">${escHtml(initials)}</div>`;
  if (post.authorPfp) avatarHTML = `<div class="comm-post-avatar"><img src="${escHtml(post.authorPfp)}" alt=""></div>`;
  card.innerHTML = `
    ${(post.type==='question' && post.isBestAnswered) ? '<div class="comm-post-answered-badge"><i data-lucide="check-circle" class="lucide" width="16" height="16"></i> Answered</div>' : ''}
    <div class="comm-post-header">
      ${avatarHTML}
      <div class="comm-post-meta">
        <div class="comm-post-username">${escHtml(post.authorUsername||'Anonymous')} <span style="color:var(--muted);font-weight:400;">· ${timeAgo(post.createdAt)}</span></div>
      </div>
      <span class="comm-post-type-badge ${typeClass}">${getTypeLabel(post.type)}</span>
    </div>
    <div class="comm-post-title" data-open-post="1">${escHtml(post.title||'')}</div>
    <div class="comm-post-body" data-open-post="1">${escHtml(post.body||'')}</div>
    ${post.imageUrl ? `<img class="comm-post-img" src="${escHtml(post.imageUrl)}" alt="Post image">` : ''}
    <div class="comm-voting-row">
      <button class="comm-vote-btn${userVote==='up'?' up-active':''}" data-vote="up">▲</button>
      <span class="comm-vote-score">${(post.netScore||0)}</span>
      <button class="comm-vote-btn${userVote==='down'?' down-active':''}" data-vote="down">▼</button>
    </div>
    <div class="comm-post-actions">
      <button class="comm-post-action-btn" data-open-post="1"><i data-lucide="message-circle" class="lucide" width="16" height="16"></i> ${(post.repliesCount||0)} Replies</button>
      <button class="comm-post-action-btn" data-share-post="1"><i data-lucide="link" class="lucide" width="16" height="16"></i> Share</button>
      <button class="comm-post-action-btn" data-save-post="1"><i data-lucide="bookmark" class="lucide" width="16" height="16"></i> Save</button>
    </div>`;
  card.querySelectorAll('[data-open-post]').forEach(el => {
    el.addEventListener('click', () => openCommunityPost(communityId, post.postId));
  });
  card.querySelectorAll('.comm-vote-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!uid) return;
      const direction = btn.dataset.vote;
      const postRef = `communities/${communityId}/posts/${post.postId}`;
      const currentVote = post.userVotes ? post.userVotes[uid] : null;
      const updates = {};
      if (currentVote === direction) {
        updates[`${postRef}/userVotes/${uid}`] = null;
        updates[`${postRef}/upvotes`] = increment(direction==='up'?-1:0);
        updates[`${postRef}/downvotes`] = increment(direction==='down'?-1:0);
        updates[`${postRef}/netScore`] = increment(direction==='up'?-1:1);
      } else {
        if (currentVote) {
          updates[`${postRef}/upvotes`] = increment(direction==='up'?1:-1);
          updates[`${postRef}/downvotes`] = increment(direction==='down'?1:-1);
          updates[`${postRef}/netScore`] = increment(direction==='up'?2:-2);
        } else {
          updates[`${postRef}/upvotes`] = increment(direction==='up'?1:0);
          updates[`${postRef}/downvotes`] = increment(direction==='down'?1:0);
          updates[`${postRef}/netScore`] = increment(direction==='up'?1:-1);
        }
        updates[`${postRef}/userVotes/${uid}`] = direction;
      }
      await update(ref(db), updates).catch(e => DEBUG && console.warn('[Vote]',e));
    });
  });
  card.querySelector('[data-save-post]').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!uid) return;
    const btn = e.currentTarget;
    const alreadySaved = btn.classList.contains('saved');
    if (alreadySaved) {
      await remove(ref(db, `users/${uid}/savedCommunityPosts/${post.postId}`)).catch(()=>{});
      btn.classList.remove('saved'); btn.innerHTML = '<i data-lucide="bookmark" class="lucide" width="16" height="16"></i> Save';
    } else {
      await set(ref(db, `users/${uid}/savedCommunityPosts/${post.postId}`), { postId: post.postId, communityId, communityName: _commFeedState.communityData?.name||'', postTitle: post.title||'', savedAt: Date.now() }).catch(()=>{});
      btn.classList.add('saved'); btn.innerHTML = '<i data-lucide="bookmark" class="lucide" width="16" height="16"></i> Saved'; Toast.info('Post saved!');
    }
  });
  card.querySelector('[data-share-post]').addEventListener('click', (e) => { e.stopPropagation(); openCommShareModal(post, communityId); });
  return card;
}

function getTypeLabel(type) {
  const map = { question:'<i data-lucide="circle-help" class="lucide" width="12" height="12"></i> Question', discussion:'<i data-lucide="message-circle" class="lucide" width="12" height="12"></i> Discussion', fun:'<i data-lucide="smile" class="lucide" width="12" height="12"></i> Fun', debate:'<i data-lucide="zap" class="lucide" width="12" height="12"></i> Debate', story:'<i data-lucide="book-open" class="lucide" width="12" height="12"></i> Story', announcement:'<i data-lucide="megaphone" class="lucide" width="12" height="12"></i> Announcement' };
  return map[(type||'discussion').toLowerCase()] || '<i data-lucide="message-circle" class="lucide" width="12" height="12"></i> Discussion';
}

// ══════════════════════════════════════════
//  COMMUNITY POST DETAIL SCREEN
// ══════════════════════════════════════════
const _commPostState = {
  communityId: null, postId: null, postData: null,
  repliesListener: null, postListener: null,
  replySort: 'top', parentReplyId: null, allReplies: {}
};

function openCommunityPost(communityId, postId) {
  _commPostState.communityId = communityId;
  _commPostState.postId = postId;
  _commPostState.parentReplyId = null;
  _commPostState.replySort = 'top';
  ScreenManager.show('community-post-screen');
  loadCommunityPostScreen(communityId, postId);
}

function loadCommunityPostScreen(communityId, postId) {
  if (_commPostState.repliesListener) { off(ref(db, `communities/${communityId}/posts/${postId}/replies`)); _commPostState.repliesListener = null; }
  if (_commPostState.postListener) { off(ref(db, `communities/${communityId}/posts/${postId}`)); _commPostState.postListener = null; }
  const uid = state.currentUser ? state.currentUser.uid : null;
  document.getElementById('comm-post-back').onclick = () => {
    off(ref(db, `communities/${communityId}/posts/${postId}/replies`));
    off(ref(db, `communities/${communityId}/posts/${postId}`));
    _commPostState.repliesListener = null; _commPostState.postListener = null;
    ScreenManager.show('community-feed-screen');
  };
  document.getElementById('comm-post-share').onclick = () => { if (_commPostState.postData) openCommShareModal(_commPostState.postData, communityId); };
  const avatarEl = document.getElementById('comm-reply-avatar');
  if (uid) {
    const initials = (state.username||'?').substring(0,2).toUpperCase();
    avatarEl.innerHTML = state.pfpUrl ? `<img src="${escHtml(state.pfpUrl)}" alt="You">` : initials;
  }
  const textarea = document.getElementById('comm-reply-input');
  textarea.addEventListener('input', () => { textarea.style.height='auto'; textarea.style.height=Math.min(textarea.scrollHeight,120)+'px'; });
  document.querySelectorAll('.comm-replies-sort-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.comm-replies-sort-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active'); _commPostState.replySort = btn.dataset.rsort; renderReplies();
    });
  });
  _commPostState.postListener = onValue(ref(db, `communities/${communityId}/posts/${postId}`), snap => {
    if (!snap.exists()) return;
    const post = snap.val(); _commPostState.postData = post;
    renderPostFullBlock(post, uid, communityId);
  });
  _commPostState.repliesListener = onValue(ref(db, `communities/${communityId}/posts/${postId}/replies`), snap => {
    _commPostState.allReplies = snap.exists() ? snap.val() : {};
    renderReplies();
  });
  document.getElementById('comm-reply-send').onclick = async () => {
    const text = textarea.value.trim();
    if (!text || !uid) return;
    const replyRef = push(ref(db, `communities/${communityId}/posts/${postId}/replies`));
    const replyId = replyRef.key;
    try {
      await set(replyRef, { replyId, body: text, imageUrl: null, parentReplyId: _commPostState.parentReplyId, authorId: uid, authorUsername: state.username||'Anonymous', authorPfp: state.pfpUrl||null, upvotes:0, downvotes:0, netScore:0, likesCount:0, isBestAnswer:false, createdAt:Date.now(), userVotes:{}, userLikes:{} });
      await update(ref(db), { [`communities/${communityId}/posts/${postId}/repliesCount`]: increment(1) });
      const post = _commPostState.postData;
      if (post && post.authorId && post.authorId !== uid) {
        push(ref(db, `notifications/${post.authorId}`), { type:'comm_reply', postId, communityId, communityName:post.communityName||'', fromUsername:state.username||'Someone', preview:text.substring(0,60), createdAt:Date.now(), read:false });
      }
      textarea.value=''; textarea.style.height='auto'; _commPostState.parentReplyId=null;
      const composer = document.getElementById('comm-reply-composer');
      const replyHint = composer.querySelector('.reply-hint');
      if (replyHint) replyHint.remove();
    } catch(e) { Toast.error('Failed to post reply.'); }
  };
}

function renderPostFullBlock(post, uid, communityId) {
  const block = document.getElementById('comm-post-full-block');
  if (!block) return;
  const userVote = uid && post.userVotes ? post.userVotes[uid] : null;
  const isLiked = uid && post.userLikes ? post.userLikes[uid] : false;
  const typeClass = `type-${(post.type||'discussion').toLowerCase()}`;
  const initials = (post.authorUsername||'?').substring(0,2).toUpperCase();
  let avatarHTML = `<div class="comm-post-avatar">${escHtml(initials)}</div>`;
  if (post.authorPfp) avatarHTML = `<div class="comm-post-avatar"><img src="${escHtml(post.authorPfp)}" alt=""></div>`;
  block.innerHTML = `
    <div class="comm-post-header">${avatarHTML}
      <div class="comm-post-meta"><div class="comm-post-username">${escHtml(post.authorUsername||'Anonymous')} <span style="color:var(--muted);font-weight:400;">· ${timeAgo(post.createdAt)}</span></div></div>
      <span class="comm-post-type-badge ${typeClass}">${getTypeLabel(post.type)}</span>
    </div>
    <div class="comm-post-full-title">${escHtml(post.title||'')}</div>
    <div class="comm-post-full-body">${escHtml(post.body||'')}</div>
    ${post.imageUrl ? `<img class="comm-post-full-img" src="${escHtml(post.imageUrl)}" alt="Post image">` : ''}
    <div class="comm-post-full-voting">
      <button class="comm-post-full-vote-btn${userVote==='up'?' up-active':''}" id="cpfv-up">▲</button>
      <span class="comm-post-full-score" id="cpfv-score">${(post.netScore||0)}</span>
      <button class="comm-post-full-vote-btn${userVote==='down'?' down-active':''}" id="cpfv-down">▼</button>
    </div>
    <div class="comm-post-secondary-actions">
      <button class="comm-post-action-btn${isLiked?' saved':''}" id="cpf-like"><i data-lucide="heart" class="lucide" width="16" height="16"></i> ${(post.likesCount||0)}</button>
      <button class="comm-post-action-btn" id="cpf-save"><i data-lucide="bookmark" class="lucide" width="16" height="16"></i> Save</button>
      <button class="comm-post-action-btn" id="cpf-share"><i data-lucide="link" class="lucide" width="16" height="16"></i> Share</button>
    </div>`;
  const postPath = `communities/${communityId}/posts/${post.postId}`;
  block.querySelectorAll('.comm-post-full-vote-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!uid) return;
      const direction = btn.id==='cpfv-up'?'up':'down';
      const currentVote = post.userVotes ? post.userVotes[uid] : null;
      const updates = {};
      if (currentVote===direction) {
        updates[`${postPath}/userVotes/${uid}`]=null;
        updates[`${postPath}/netScore`]=increment(direction==='up'?-1:1);
        updates[`${postPath}/${direction==='up'?'upvotes':'downvotes'}`]=increment(-1);
      } else {
        if (currentVote) { updates[`${postPath}/netScore`]=increment(direction==='up'?2:-2); updates[`${postPath}/upvotes`]=increment(direction==='up'?1:-1); updates[`${postPath}/downvotes`]=increment(direction==='down'?1:-1); }
        else { updates[`${postPath}/netScore`]=increment(direction==='up'?1:-1); updates[`${postPath}/${direction==='up'?'upvotes':'downvotes'}`]=increment(1); }
        updates[`${postPath}/userVotes/${uid}`]=direction;
      }
      await update(ref(db), updates).catch(()=>{});
    });
  });
  document.getElementById('cpf-like').addEventListener('click', async () => {
    if (!uid) return;
    const currentlyLiked = post.userLikes && post.userLikes[uid];
    await update(ref(db), { [`${postPath}/userLikes/${uid}`]:currentlyLiked?null:true, [`${postPath}/likesCount`]:increment(currentlyLiked?-1:1) }).catch(()=>{});
  });
  document.getElementById('cpf-save').addEventListener('click', async () => {
    if (!uid) return;
    const savedPath = `users/${uid}/savedCommunityPosts/${post.postId}`;
    const savedSnap = await get(ref(db, savedPath)).catch(()=>null);
    if (savedSnap && savedSnap.exists()) { await remove(ref(db, savedPath)).catch(()=>{}); Toast.info('Removed from saved'); }
    else { await set(ref(db, savedPath), { postId:post.postId, communityId, communityName:post.communityName||'', postTitle:post.title||'', savedAt:Date.now() }).catch(()=>{}); Toast.info('Post saved!'); }
  });
  document.getElementById('cpf-share').addEventListener('click', () => openCommShareModal(post, communityId));
  const hint = document.getElementById('comm-best-answer-hint');
  if (post.type==='question' && uid===post.authorId && !post.isBestAnswered) hint.style.display='block';
  else hint.style.display='none';
}

function renderReplies() {
  const list = document.getElementById('comm-replies-list');
  if (!list) return;
  list.innerHTML = '';
  let replies = Object.values(_commPostState.allReplies);
  const uid = state.currentUser ? state.currentUser.uid : null;
  const post = _commPostState.postData;
  switch(_commPostState.replySort) {
    case 'top': replies.sort((a,b)=>(b.netScore||0)-(a.netScore||0)); break;
    case 'new': replies.sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)); break;
    case 'controversial': replies.sort((a,b)=>((b.upvotes||0)+(b.downvotes||0))-((a.upvotes||0)+(a.downvotes||0))); break;
  }
  const topLevel = replies.filter(r => !r.parentReplyId);
  const nested = replies.filter(r => r.parentReplyId);
  topLevel.forEach(reply => {
    list.appendChild(buildReplyCard(reply, uid, post, false));
    const children = nested.filter(r => r.parentReplyId === reply.replyId);
    children.slice(0,2).forEach(child => list.appendChild(buildReplyCard(child, uid, post, true)));
    if (children.length > 2) {
      const showMore = document.createElement('button');
      showMore.className = 'comm-reply-small-btn';
      showMore.style.cssText = 'margin-left:20px;padding:4px 0 8px;display:block;';
      showMore.textContent = `View ${children.length-2} more ${children.length-2===1?'reply':'replies'}`;
      showMore.addEventListener('click', () => { children.slice(2).forEach(child => { showMore.before(buildReplyCard(child, uid, post, true)); }); showMore.remove(); });
      list.appendChild(showMore);
    }
  });
  if (replies.length === 0) {
    list.innerHTML = `<div style="text-align:center;padding:24px 16px;color:var(--muted);font-size:13px;">No replies yet. Be the first!</div>`;
  }
}

function buildReplyCard(reply, uid, post, isNested) {
  const card = document.createElement('div');
  card.className = 'comm-reply-card'+(isNested?' nested':'')+(reply.isBestAnswer?' best-answer':'');
  const userVote = uid && reply.userVotes ? reply.userVotes[uid] : null;
  const initials = (reply.authorUsername||'?').substring(0,2).toUpperCase();
  let avatarHTML = `<div class="comm-post-avatar" style="width:24px;height:24px;font-size:10px;">${escHtml(initials)}</div>`;
  if (reply.authorPfp) avatarHTML = `<div class="comm-post-avatar" style="width:24px;height:24px;"><img src="${escHtml(reply.authorPfp)}" alt=""></div>`;
  card.innerHTML = `
    ${reply.isBestAnswer ? '<div class="comm-best-answer-banner"><i data-lucide="check-circle" class="lucide" width="16" height="16"></i> Best Answer</div>' : ''}
    <div class="comm-reply-header">${avatarHTML}
      <div class="comm-post-meta">
        <span class="comm-post-username" style="font-size:12px;">${escHtml(reply.authorUsername||'Anonymous')}</span>
        <span class="comm-post-time"> · ${timeAgo(reply.createdAt)}</span>
      </div>
    </div>
    <div class="comm-reply-body">${escHtml(reply.body||'')}</div>
    ${reply.imageUrl ? `<img class="comm-reply-img" src="${escHtml(reply.imageUrl)}" alt="">` : ''}
    <div class="comm-reply-actions-row">
      <button class="comm-reply-vote-btn${userVote==='up'?' up-active':''}" data-rv="up">▲ ${(reply.upvotes||0)}</button>
      <button class="comm-reply-vote-btn${userVote==='down'?' down-active':''}" data-rv="down">▼</button>
      <button class="comm-reply-small-btn" data-reply-to="${escHtml(reply.replyId)}">↩ Reply</button>
      ${(post && post.type==='question' && uid===post.authorId && !reply.isBestAnswer && !post.isBestAnswered) ?
        `<button class="comm-best-answer-mark-btn" data-mark-best="${escHtml(reply.replyId)}"><i data-lucide="check-circle" class="lucide" width="16" height="16"></i> Mark as Best Answer</button>` : ''}
    </div>`;
  card.querySelectorAll('[data-rv]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!uid) return;
      const dir = btn.dataset.rv;
      const currentVote = reply.userVotes ? reply.userVotes[uid] : null;
      const rPath = `communities/${_commPostState.communityId}/posts/${_commPostState.postId}/replies/${reply.replyId}`;
      const updates = {};
      if (currentVote===dir) { updates[`${rPath}/userVotes/${uid}`]=null; updates[`${rPath}/netScore`]=increment(dir==='up'?-1:1); updates[`${rPath}/${dir==='up'?'upvotes':'downvotes'}`]=increment(-1); }
      else { if (currentVote) { updates[`${rPath}/netScore`]=increment(dir==='up'?2:-2); updates[`${rPath}/upvotes`]=increment(dir==='up'?1:-1); updates[`${rPath}/downvotes`]=increment(dir==='down'?1:-1); } else { updates[`${rPath}/netScore`]=increment(dir==='up'?1:-1); updates[`${rPath}/${dir==='up'?'upvotes':'downvotes'}`]=increment(1); } updates[`${rPath}/userVotes/${uid}`]=dir; }
      await update(ref(db), updates).catch(()=>{});
    });
  });
  const replyToBtn = card.querySelector('[data-reply-to]');
  if (replyToBtn) {
    replyToBtn.addEventListener('click', () => {
      _commPostState.parentReplyId = reply.replyId;
      const textarea = document.getElementById('comm-reply-input');
      textarea.value = `@${reply.authorUsername} `; textarea.focus();
      const composer = document.getElementById('comm-reply-composer');
      let hint = composer.querySelector('.reply-hint');
      if (!hint) { hint=document.createElement('div'); hint.className='reply-hint'; hint.style.cssText='font-size:10px;color:var(--muted);padding:2px 8px;'; composer.insertBefore(hint, textarea); }
      hint.textContent = `Replying to @${reply.authorUsername}`;
    });
  }
  const markBtn = card.querySelector('[data-mark-best]');
  if (markBtn) {
    markBtn.addEventListener('click', async () => {
      if (!uid || !post) return;
      const rId = reply.replyId;
      await update(ref(db), { [`communities/${_commPostState.communityId}/posts/${_commPostState.postId}/replies/${rId}/isBestAnswer`]:true, [`communities/${_commPostState.communityId}/posts/${_commPostState.postId}/isBestAnswered`]:true }).catch(()=>{});
      if (reply.authorId && reply.authorId !== uid) {
        push(ref(db, `notifications/${reply.authorId}`), { type:'comm_best_answer', postId:_commPostState.postId, replyId:rId, communityId:_commPostState.communityId, communityName:post.communityName||'', createdAt:Date.now(), read:false });
      }
      Toast.info('<i data-lucide="check-circle" class="lucide" width="16" height="16"></i> Marked as Best Answer!');
    });
  }
  return card;
}

// ══════════════════════════════════════════
//  COMMUNITY POST CREATOR
// ══════════════════════════════════════════
let _ccSelectedType = '';
let _ccTags = [];
let _ccImageFile = null;
let _ccPrefilledCommunityId = null;

function openCommunityPostCreator(communityId) {
  _ccPrefilledCommunityId = communityId || null;
  ScreenManager.show('create-screen');
  document.getElementById('create-mode-community').click();
}

document.getElementById('create-mode-golex').addEventListener('click', () => {
  document.getElementById('create-mode-golex').classList.add('active');
  document.getElementById('create-mode-community').classList.remove('active');
  document.getElementById('create-community-form').style.display = 'none';
  document.getElementById('create-golex-content').style.display = '';
});
document.getElementById('create-mode-community').addEventListener('click', () => {
  document.getElementById('create-mode-community').classList.add('active');
  document.getElementById('create-mode-golex').classList.remove('active');
  document.getElementById('create-community-form').style.display = 'flex';
  document.getElementById('create-golex-content').style.display = 'none';
  populateCCCommunityDropdown();
});

async function populateCCCommunityDropdown() {
  if (!state.currentUser) return;
  const sel = document.getElementById('cc-community-select');
  sel.innerHTML = '<option value="">Select a community...</option>';
  try {
    const snap = await get(ref(db, `users/${state.currentUser.uid}/joinedCommunities`));
    if (!snap.exists()) return;
    const communityIds = Object.keys(snap.val());
    for (const cid of communityIds) {
      const cSnap = await get(ref(db, `communities/${cid}`));
      if (cSnap.exists()) {
        const c = cSnap.val(); const opt = document.createElement('option');
        opt.value=cid; opt.textContent=`${c.icon||'globe'} ${c.name||cid}`; sel.appendChild(opt);
      }
    }
    if (_ccPrefilledCommunityId) sel.value = _ccPrefilledCommunityId;
  } catch(e) {}
}

document.querySelectorAll('.cc-type-pill').forEach(pill => {
  pill.addEventListener('click', () => {
    document.querySelectorAll('.cc-type-pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active'); _ccSelectedType = pill.dataset.cctype;
  });
});
document.getElementById('cc-title-input').addEventListener('input', (e) => { document.getElementById('cc-title-count').textContent = e.target.value.length; });
document.getElementById('cc-body-input').addEventListener('input', (e) => { document.getElementById('cc-body-count').textContent = e.target.value.length; });
document.getElementById('cc-image-area').addEventListener('click', () => { document.getElementById('cc-file-input').click(); });
document.getElementById('cc-file-input').addEventListener('change', (e) => {
  const file = e.target.files[0]; if (!file) return; _ccImageFile = file;
  const reader = new FileReader();
  reader.onload = ev => { const preview = document.getElementById('cc-img-preview'); preview.src=ev.target.result; preview.style.display='block'; document.getElementById('cc-img-clear').style.display='flex'; };
  reader.readAsDataURL(file);
});
document.getElementById('cc-img-clear').addEventListener('click', (e) => {
  e.stopPropagation(); _ccImageFile=null;
  document.getElementById('cc-img-preview').src=''; document.getElementById('cc-img-preview').style.display='none';
  document.getElementById('cc-img-clear').style.display='none'; document.getElementById('cc-file-input').value='';
});
document.getElementById('cc-tag-add').addEventListener('click', () => {
  const input = document.getElementById('cc-tag-input'); const val = input.value.trim();
  if (!val || _ccTags.includes(val) || _ccTags.length >= 5) return;
  _ccTags.push(val); renderCCTags(); input.value='';
});
function renderCCTags() {
  const wrap = document.getElementById('cc-tags-wrap'); wrap.innerHTML='';
  _ccTags.forEach((tag, i) => {
    const el = document.createElement('div'); el.className='tag-chip';
    el.innerHTML=`#${escHtml(tag)} <button class="tag-remove-btn" data-ci="${i}"><i data-lucide="x" class="lucide" width="10" height="10"></i></button>`;
    el.querySelector('.tag-remove-btn').addEventListener('click', () => { _ccTags.splice(i,1); renderCCTags(); });
    wrap.appendChild(el);
  });
}
document.getElementById('cc-post-btn').addEventListener('click', async () => {
  const communityId = document.getElementById('cc-community-select').value;
  const title = document.getElementById('cc-title-input').value.trim();
  const body = document.getElementById('cc-body-input').value.trim();
  const errorEl = document.getElementById('cc-error');
  errorEl.style.display='none';
  if (!communityId) { errorEl.textContent='Please select a community.'; errorEl.style.display='block'; return; }
  if (!_ccSelectedType) { errorEl.textContent='Please select a post type.'; errorEl.style.display='block'; return; }
  if (!title || title.length < 3) { errorEl.textContent='Title must be at least 3 characters.'; errorEl.style.display='block'; return; }
  const btn = document.getElementById('cc-post-btn'); btn.disabled=true; btn.innerHTML='<i data-lucide="loader" class="lucide" width="16" height="16"></i> Posting...';
  try {
    const uid = state.currentUser.uid;
    // ── Compress image if one was selected ──
    let imageUrl = null;
    if (_ccImageFile) {
      try {
        btn.innerHTML = '<i data-lucide="image" class="lucide" width="16" height="16"></i> Processing image...';
        const result = await compressImage(_ccImageFile);
        imageUrl = result.dataUrl;
      } catch(imgErr) {
        DEBUG && console.warn('[CC Post] Image compression failed, posting without image:', imgErr);
        imageUrl = null;
      }
    }
    const cSnap = await get(ref(db, `communities/${communityId}`));
    const communityData = cSnap.exists() ? cSnap.val() : {};
    const postRef = push(ref(db, `communities/${communityId}/posts`));
    const postId = postRef.key;
    await set(postRef, { postId, communityId, communityName:communityData.name||'', title, body:body||'', type:_ccSelectedType, imageUrl:imageUrl, authorId:uid, authorUsername:state.username||'Anonymous', authorPfp:state.pfpUrl||null, upvotes:0, downvotes:0, netScore:0, likesCount:0, repliesCount:0, isBestAnswered:false, tags:_ccTags, createdAt:Date.now(), userVotes:{}, userLikes:{} });
    await update(ref(db), { [`communities/${communityId}/postCount`]: increment(1) });
    const membersSnap = await get(ref(db, `communities/${communityId}/members`)).catch(()=>null);
    if (membersSnap && membersSnap.exists()) {
      const members = Object.keys(membersSnap.val()).filter(m=>m!==uid);
      const notifBatch = {};
      members.forEach(memberId => { const notifId=push(ref(db,`notifications/${memberId}`)).key; notifBatch[`notifications/${memberId}/${notifId}`]={ type:'comm_new_post', postId, communityId, communityName:communityData.name||'', postTitle:title, authorUsername:state.username||'Anonymous', createdAt:Date.now(), read:false }; });
      if (Object.keys(notifBatch).length>0) await update(ref(db), notifBatch).catch(()=>{});
    }
    document.getElementById('cc-title-input').value=''; document.getElementById('cc-body-input').value='';
    document.getElementById('cc-title-count').textContent='0'; document.getElementById('cc-body-count').textContent='0';
    _ccTags=[]; _ccSelectedType=''; _ccImageFile=null;
    document.getElementById('cc-img-preview').src='';
    document.getElementById('cc-img-preview').style.display='none';
    document.getElementById('cc-img-clear').style.display='none';
    document.getElementById('cc-file-input').value='';
    document.querySelectorAll('.cc-type-pill').forEach(p=>p.classList.remove('active')); renderCCTags();
    Toast.info('Posted!'); openCommunityFeed(communityId);
  } catch(e) { errorEl.textContent='Post failed. Try again.'; errorEl.style.display='block'; DEBUG && console.error('[CC Post]',e); }
  finally { btn.disabled=false; btn.innerHTML='<i data-lucide="rocket" class="lucide" width="16" height="16"></i> Post to Community'; }
});

// ══════════════════════════════════════════
//  COMMUNITY CREATION SCREEN
// ══════════════════════════════════════════
const COMM_ICONS = ['gamepad-2','monitor','palette','music','pencil','paintbrush','clapperboard','microscope','zap','smile','book-open','trophy','globe','flame','lightbulb','camera','drama','rocket','brain','dice-6'];
// Render a Lucide icon name as an inline <i> element string
function renderLucideIcon(name, size) {
  var sz = size || 20;
  return '<i data-lucide="' + (name||'globe') + '" class="lucide" width="' + sz + '" height="' + sz + '"></i>';
}
let _commCreateIcon = '';
let _commCreateNiche = '';
let _commCreatePrivacy = 'public';
let _commCreateRules = [''];
let _nameCheckTimeout = null;

(function() {
  const picker = document.getElementById('comm-icon-picker');
  COMM_ICONS.forEach(icon => {
    const btn = document.createElement('button'); btn.className='comm-icon-opt'; btn.type='button';
    btn.innerHTML = '<i data-lucide="' + icon + '" class="lucide" width="22" height="22"></i>';
    btn.title = icon;
    btn.addEventListener('click', () => { document.querySelectorAll('.comm-icon-opt').forEach(b=>b.classList.remove('selected')); btn.classList.add('selected'); _commCreateIcon=icon; });
    picker.appendChild(btn);
  });
  lucide.createIcons({ nodes: [picker] });
})();

document.getElementById('comm-create-back').addEventListener('click', () => { ScreenManager.show('communities-screen'); });
document.getElementById('comm-create-desc').addEventListener('input', (e) => { document.getElementById('comm-desc-count').textContent=e.target.value.length; });
document.getElementById('comm-create-name').addEventListener('input', (e) => {
  const name=e.target.value.trim(); const statusEl=document.getElementById('comm-name-status');
  if (!name) { statusEl.textContent=''; return; }
  clearTimeout(_nameCheckTimeout); statusEl.innerHTML='<i data-lucide="loader" class="lucide" width="16" height="16"></i> Checking...'; statusEl.className='comm-name-status';
  _nameCheckTimeout = setTimeout(async () => {
    try {
      const snap = await get(query(ref(db,'communities'),orderByChild('name'),equalTo(name)));
      if (snap.exists()) { statusEl.innerHTML='<i data-lucide="x-circle" class="lucide" width="16" height="16"></i> Name already taken'; statusEl.className='comm-name-status taken'; }
      else { statusEl.innerHTML='<i data-lucide="check-circle" class="lucide" width="16" height="16"></i> Available!'; statusEl.className='comm-name-status available'; }
    } catch(e) { statusEl.textContent=''; }
  }, 600);
});
document.querySelectorAll('#comm-create-niche-row .filter-pill').forEach(pill => {
  pill.addEventListener('click', () => { document.querySelectorAll('#comm-create-niche-row .filter-pill').forEach(p=>p.classList.remove('active')); pill.classList.add('active'); _commCreateNiche=pill.dataset.niche; });
});
document.querySelectorAll('.comm-privacy-card').forEach(card => {
  card.addEventListener('click', () => { document.querySelectorAll('.comm-privacy-card').forEach(c=>c.classList.remove('selected')); card.classList.add('selected'); _commCreatePrivacy=card.dataset.privacy; });
});
function renderRulesEditor() {
  const editor=document.getElementById('comm-rules-editor'); editor.innerHTML='';
  _commCreateRules.forEach((rule,i) => {
    const row=document.createElement('div'); row.className='comm-rule-row';
    row.innerHTML=`<input class="input" type="text" value="${escHtml(rule)}" placeholder="Rule ${i+1}..." maxlength="100" data-ri="${i}" style="flex:1;"><button class="comm-rule-remove" data-ri="${i}" type="button"><i data-lucide="x" class="lucide" width="16" height="16"></i></button>`;
    row.querySelector('input').addEventListener('input',e=>{ _commCreateRules[i]=e.target.value; });
    row.querySelector('.comm-rule-remove').addEventListener('click',()=>{ _commCreateRules.splice(i,1); renderRulesEditor(); });
    editor.appendChild(row);
  });
}
renderRulesEditor();
document.getElementById('comm-add-rule-btn').addEventListener('click', () => { if (_commCreateRules.length>=5){Toast.info('Max 5 rules.');return;} _commCreateRules.push(''); renderRulesEditor(); });
document.getElementById('comm-create-submit').addEventListener('click', async () => {
  const name=document.getElementById('comm-create-name').value.trim();
  const desc=document.getElementById('comm-create-desc').value.trim();
  const errorEl=document.getElementById('comm-create-error'); errorEl.style.display='none';
  if (!_commCreateIcon){errorEl.textContent='Please select an icon.';errorEl.style.display='block';return;}
  if (!name){errorEl.textContent='Community name is required.';errorEl.style.display='block';return;}
  if (!_commCreateNiche){errorEl.textContent='Please select a category.';errorEl.style.display='block';return;}
  const nameStatus=document.getElementById('comm-name-status');
  if (nameStatus.classList.contains('taken')){errorEl.textContent='That name is taken.';errorEl.style.display='block';return;}
  const btn=document.getElementById('comm-create-submit'); btn.disabled=true; btn.innerHTML='<i data-lucide="loader" class="lucide" width="16" height="16"></i> Creating...';
  try {
    const uid=state.currentUser.uid;
    const communityRef=push(ref(db,'communities')); const communityId=communityRef.key;
    const rules=_commCreateRules.filter(r=>r.trim()!=='');
    await set(communityRef,{communityId,name,description:desc,icon:_commCreateIcon,niche:_commCreateNiche,privacy:_commCreatePrivacy,creatorId:uid,creatorUsername:state.username||'Anonymous',creatorIsPro:state.isPro===true,memberCount:1,postCount:0,createdAt:Date.now(),rules,members:{[uid]:true}});
    await update(ref(db),{[`users/${uid}/joinedCommunities/${communityId}`]:true});
    Toast.info('Community created!'); openCommunityFeed(communityId);
    document.getElementById('comm-create-name').value=''; document.getElementById('comm-create-desc').value=''; document.getElementById('comm-desc-count').textContent='0';
    document.querySelectorAll('.comm-icon-opt').forEach(b=>b.classList.remove('selected'));
    document.querySelectorAll('#comm-create-niche-row .filter-pill').forEach(p=>p.classList.remove('active'));
    document.querySelectorAll('.comm-privacy-card').forEach(c=>c.classList.remove('selected'));
    document.querySelector('.comm-privacy-card[data-privacy="public"]').classList.add('selected');
    _commCreateIcon=''; _commCreateNiche=''; _commCreatePrivacy='public'; _commCreateRules=[''];
    renderRulesEditor();
  } catch(e) { errorEl.textContent='Failed to create community. Try again.'; errorEl.style.display='block'; DEBUG && console.error('[Comm Create]',e); }
  finally { btn.disabled=false; btn.innerHTML='<i data-lucide="sparkles" class="lucide" width="16" height="16"></i> Create Community'; }
});

// ══════════════════════════════════════════
//  COMMUNITY POST SHARE MODAL
// ══════════════════════════════════════════
let _sharePostData = null;
let _shareCommunityId = null;
let _shareSearchTimeout = null;

function openCommShareModal(post, communityId) {
  _sharePostData=post; _shareCommunityId=communityId;
  document.getElementById('comm-share-search').value='';
  document.getElementById('comm-share-results').innerHTML='<div style="text-align:center;padding:20px;color:var(--muted);font-size:13px;">Type to search users</div>';
  document.getElementById('comm-share-modal-overlay').classList.add('open');
}
document.getElementById('comm-share-modal-close').addEventListener('click', () => { document.getElementById('comm-share-modal-overlay').classList.remove('open'); });
document.getElementById('comm-share-modal-overlay').addEventListener('click', (e) => { if (e.target===e.currentTarget) document.getElementById('comm-share-modal-overlay').classList.remove('open'); });
document.getElementById('comm-share-search').addEventListener('input', (e) => {
  const query=e.target.value.trim().toLowerCase(); clearTimeout(_shareSearchTimeout); if (!query) return;
  _shareSearchTimeout = setTimeout(async () => {
    const results=document.getElementById('comm-share-results');
    results.innerHTML='<div style="text-align:center;padding:12px;color:var(--muted);font-size:12px;">Searching...</div>';
    try {
      const snap=await get(ref(db,'users'));
      if (!snap.exists()){results.innerHTML='<div style="text-align:center;padding:12px;color:var(--muted);">No users found</div>';return;}
      const users=Object.values(snap.val()).filter(u=>u.username&&u.username.toLowerCase().startsWith(query)&&u.uid!==(state.currentUser?.uid)).slice(0,10);
      results.innerHTML='';
      if (users.length===0){results.innerHTML='<div style="text-align:center;padding:12px;color:var(--muted);">No users found</div>';return;}
      users.forEach(u => {
        const row=document.createElement('div'); row.className='comm-share-user-row';
        const initials=(u.username||'?').substring(0,2).toUpperCase();
        row.innerHTML=`<div class="comm-share-user-avatar">${escHtml(initials)}</div><div><div class="comm-share-user-name">@${escHtml(u.username)}</div><div class="comm-share-user-skill">${escHtml(u.skill||'')}</div></div>`;
        row.addEventListener('click', async () => {
          if (!state.currentUser||!_sharePostData) return;
          const uid=state.currentUser.uid; const chatId=[uid,u.uid].sort().join('_');
          await push(ref(db,`chats/${chatId}/messages`),{type:'community-post-share',postId:_sharePostData.postId||'',postTitle:_sharePostData.title||'',communityName:_sharePostData.communityName||'',communityId:_shareCommunityId||'',senderId:uid,senderUsername:state.username||'Anonymous',ts:Date.now()}).catch(()=>{});
          document.getElementById('comm-share-modal-overlay').classList.remove('open');
          Toast.info(`Shared with @${u.username}`);
        });
        results.appendChild(row);
      });
    } catch(e) { results.innerHTML='<div style="text-align:center;color:var(--danger-light);padding:12px;">Search failed</div>'; }
  }, 350);
});




// ── Export to window ──
Object.assign(window, {
  loadCommunitiesScreen, openCommunityFeed, openCommunityPost,
  openCommunityPostCreator, cleanupCommunityFeedListeners, cleanupCommPostListeners,
  _commPostState
});
