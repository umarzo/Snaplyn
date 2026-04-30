const { state, $, $$, escHtml, badgeHTML, generateAvatarUrl, debounce, timeAgo,
  db, ref, get, set, onValue, update, serverTimestamp, off, query, orderByChild,
  limitToLast, onChildAdded, push,
  CONFIG, Toast, ScreenManager, openUserProfileSheet, cacheUser, getUserCached } = window;

/* ═══════════════════════════════════════════════════
   GAMIFICATION ENGINE v1.0
   - Level-up celebrations with confetti
   - Daily streak tracking
   - Milestone achievement badges
   - Points leaderboard in Explore
   - Floating +pts animation on send
   ═══════════════════════════════════════════════════ */

// ── Level thresholds ──
const LEVEL_THRESHOLDS = [
  { pts: 500, level: 'Professional', icon: 'gem', color: '#f59e0b' },
  { pts: 200, level: 'Advanced',     icon: 'flame', color: '#D4924A' },
  { pts: 50,  level: 'Intermediate', icon: 'zap', color: '#059669' },
  { pts: 0,   level: 'Beginner',     icon: 'sprout', color: '#6E6560' },
];

function getLevelForPoints(pts) {
  return LEVEL_THRESHOLDS.find(t => pts >= t.pts) || LEVEL_THRESHOLDS[LEVEL_THRESHOLDS.length - 1];
}

// ── Confetti engine ──
const ConfettiEngine = (() => {
  const canvas = document.getElementById('confetti-canvas');
  const ctx = canvas.getContext('2d');
  let particles = [], animFrame = null;
  const COLORS = ['#2563EB','#4F46E5','#059669','#10b981','#3B82F6','#6366F1','#0ea5e9'];

  function resize() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
  window.addEventListener('resize', rafThrottle(resize)); resize();

  function spawn(n) {
    for (let i = 0; i < n; i++) {
      particles.push({
        x: Math.random() * canvas.width,
        y: -10,
        r: Math.random() * 6 + 3,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        vx: (Math.random() - 0.5) * 4,
        vy: Math.random() * 3 + 2,
        spin: Math.random() * 0.2 - 0.1,
        angle: Math.random() * Math.PI * 2,
        life: 1,
        decay: Math.random() * 0.008 + 0.004
      });
    }
  }

  function tick() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particles = particles.filter(p => p.life > 0);
    particles.forEach(p => {
      p.x += p.vx; p.y += p.vy; p.angle += p.spin; p.life -= p.decay; p.vy += 0.05;
      ctx.save();
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.r, -p.r / 2, p.r * 2, p.r);
      ctx.restore();
    });
    if (particles.length > 0) animFrame = requestAnimationFrame(tick);
    else { ctx.clearRect(0, 0, canvas.width, canvas.height); animFrame = null; }
  }

  return {
    burst(n = 120) {
      spawn(n);
      if (!animFrame) tick();
    },
    stop() {
      particles = [];
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
    }
  };
})();

// ── Level-up celebration ──
let _lastCelebratedLevel = null;

function celebrateLevelUp(levelInfo) {
  if (_lastCelebratedLevel === levelInfo.level) return;
  _lastCelebratedLevel = levelInfo.level;
  const overlay = document.getElementById('levelup-overlay');
  document.getElementById('levelup-emoji').textContent = levelInfo.emoji;
  document.getElementById('levelup-title').textContent = `You leveled up to ${levelInfo.level}!`;
  document.getElementById('levelup-sub').textContent = `Keep connecting and sharing skills!`;
  overlay.classList.add('show');
  ConfettiEngine.burst(150);
  // Auto-dismiss after 6s
  const autoDismiss = setTimeout(() => { overlay.classList.remove('show'); ConfettiEngine.stop(); }, 6000);
  document.getElementById('levelup-close').onclick = () => {
    clearTimeout(autoDismiss); overlay.classList.remove('show'); ConfettiEngine.stop();
  };
}

function checkLevelUp(newPoints, oldPoints) {
  const newLevel = getLevelForPoints(newPoints);
  const oldLevel = getLevelForPoints(oldPoints || 0);
  if (newLevel.level !== oldLevel.level && newLevel.pts > 0) {
    celebrateLevelUp(newLevel);
  }
}

// ── Daily streak tracking ──
async function checkAndUpdateStreak(uid) {
  try {
    const snap = await get(ref(db, `users/${uid}/lastActiveDate`));
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const lastDate = snap.val();
    let streakSnap = await get(ref(db, `users/${uid}/streak`));
    let streak = streakSnap.val() || 0;

    if (lastDate === today) {
      // Already active today — just show current streak
    } else if (lastDate) {
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      if (lastDate === yesterday) {
        streak += 1; // Consecutive day!
      } else {
        streak = 1; // Broken streak, reset
      }
      await update(ref(db, `users/${uid}`), { streak, lastActiveDate: today });
    } else {
      streak = 1;
      await update(ref(db, `users/${uid}`), { streak, lastActiveDate: today });
    }

    renderStreakBadge(streak);
  } catch(e) { /* non-critical */ }
}

function renderStreakBadge(streak) {
  const badge = document.getElementById('streak-badge');
  const count = document.getElementById('streak-count');
  if (!badge || !count) return;
  if (streak >= 2) {
    count.textContent = streak;
    badge.classList.add('visible');
  } else {
    badge.classList.remove('visible');
  }
}

// ── Milestone badge definitions ──
const MILESTONE_BADGES = [
  { id: 'messages_50',    label: '50 Messages',    check: (s) => (s.msgsSent || 0) >= 50 },
  { id: 'posts_5',        label: '5 Posts',         check: (s) => (s.postsCreated || 0) >= 5 },
  { id: 'endorsements_10',label: '⭐ 10 Endorsed',     check: (s) => (s.endorsementsReceived || 0) >= 10 },
];

async function checkAndAwardBadges(uid) {
  try {
    const [userSnap, endorseSnap, postsSnap] = await Promise.all([
      get(ref(db, `users/${uid}`)),
      get(ref(db, `endorsements/${uid}`)),
      get(query(ref(db, 'posts'), orderByChild('userId'), equalTo(uid)))
    ]);
    const userData = userSnap.val() || {};
    const endorseCount = endorseSnap.exists() ? Object.keys(endorseSnap.val()).length : 0;
    const postsCount = postsSnap.exists() ? Object.keys(postsSnap.val()).length : 0;
    const existingBadges = userData.badges || [];

    const stats = {
      msgsSent: userData.msgsSent || 0,
      postsCreated: postsCount,
      endorsementsReceived: endorseCount,
    };

    const newBadges = [];
    for (const m of MILESTONE_BADGES) {
      if (!existingBadges.includes(m.id) && m.check(stats)) {
        newBadges.push(m.id);
        Toast.success(`Achievement unlocked: ${m.label}`);
      }
    }
    if (newBadges.length > 0) {
      await update(ref(db, `users/${uid}`), { badges: [...existingBadges, ...newBadges] });
    }
    renderAchievementBadges([...existingBadges, ...newBadges]);
  } catch(e) { /* non-critical */ }
}

function renderAchievementBadges(badgeIds) {
  const wrap = document.getElementById('achievement-badges-wrap');
  if (!wrap) return;
  const allBadgeDefs = Object.fromEntries(MILESTONE_BADGES.map(b => [b.id, b.label]));
  wrap.innerHTML = badgeIds.map(id => {
    const label = allBadgeDefs[id] || id;
    return `<span class="achievement-badge">${label}</span>`;
  }).join('');
}

// ── Floating +pts animation ──
function showPtsFloat() {
  const sendBtn = document.getElementById('send-btn');
  if (!sendBtn) return;
  const rect = sendBtn.getBoundingClientRect();
  const el = document.createElement('div');
  el.className = 'pts-float';
  el.textContent = '+1 pt';
  el.style.left = rect.left + rect.width / 2 - 20 + 'px';
  el.style.top = rect.top - 10 + 'px';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1500);
}

// ── Track messages sent count ──
async function incrementMsgsSent(uid) {
  try {
    await update(ref(db, `users/${uid}`), { msgsSent: increment(1) });
  } catch(e) {}
}

// ── Leaderboard ──
let _lbUnsubscribe = null;

function loadLeaderboard() {
  const list = document.getElementById('leaderboard-list');
  if (!list) return;
  // Show skeleton leaderboard rows
  list.innerHTML = [1,2,3,4,5,6,7].map((_, i) => `
    <div class="skel-lb-row">
      <div class="skel skel-pill" style="width:28px;height:20px;"></div>
      <div class="skel skel-circle" style="width:30px;height:30px;"></div>
      <div class="skel-lb-info">
        <div class="skel skeleton-line lg" style="width:${80 + (i%3)*20}px;margin:0;"></div>
        <div class="skel skeleton-line xs" style="width:${60 + (i%4)*15}px;margin-top:4px;"></div>
      </div>
      <div class="skel skel-pill" style="width:44px;height:18px;"></div>
    </div>`).join('');

  if (_lbUnsubscribe) { _lbUnsubscribe(); _lbUnsubscribe = null; }

  const lbQuery = query(ref(db, 'users'), orderByChild('points'), limitToLast(10));
  _lbUnsubscribe = onValue(lbQuery, snap => {
    if (!snap.exists()) { list.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:8px 0">No data yet</div>'; return; }
    const users = [];
    snap.forEach(child => {
      const d = child.val();
      if (d.username) users.push({ uid: child.key, ...d });
    });
    users.sort((a, b) => (b.points || 0) - (a.points || 0));
    list.innerHTML = '';
    users.forEach((u, i) => {
      const rank = i + 1;
      const rankClass = rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : '';
      const isMe = state.currentUser && u.uid === state.currentUser.uid;
      const av = u.pfpUrl
        ? `<img src="${escHtml(u.pfpUrl)}" alt="${escHtml(u.username)}">`
        : escHtml((u.username || '?').slice(0, 2).toUpperCase());
      const row = document.createElement('div');
      row.className = 'lb-row';
      row.innerHTML = `
        <div class="lb-rank ${rankClass}">#${rank}</div>
        <div class="lb-avatar-sm">${av}</div>
        <div class="lb-info">
          <div class="lb-name">@${escHtml(u.username)}${isMe ? '<span class="lb-you-chip">YOU</span>' : ''}</div>
          <div class="lb-skill">${escHtml(u.skill || 'Explorer')} · ${escHtml(u.level || 'Beginner')}</div>
        </div>
        <div class="lb-pts">⭐ ${u.points || 0}</div>`;
      if (!isMe) {
        row.style.cursor = 'pointer';
        row.addEventListener('click', () => openChat(u.uid, u.username, u.skill || 'Explorer', u.level || 'Beginner', u.points || 0));
      }
      list.appendChild(row);
    });
  }, error => {
    // Firebase denied the leaderboard query — check that the users node has
    // ".read": "auth != null" in deployed rules and the user is signed in.
    console.error('[Golex] Leaderboard load failed:', error.code, error.message);
    if (list) list.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:8px 0">Could not load leaderboard.</div>';
  });
}

// ── Explore tabs wiring ──
document.querySelectorAll('.explore-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.explore-tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    const feed = document.getElementById('posts-feed');
    const lbPanel = document.getElementById('leaderboard-panel');
    const peoplePanel = document.getElementById('people-panel');
    const searchBar = document.getElementById('explore-search');
    const filters = document.getElementById('explore-filters');
    const mainTitle = document.getElementById('explore-main-title');

    // Reset all
    if (feed) feed.style.display = 'none';
    if (lbPanel) lbPanel.classList.remove('active');
    if (peoplePanel) peoplePanel.style.display = 'none';
    if (filters) filters.style.display = 'none';

    if (tab === 'leaderboard') {
      if (searchBar) searchBar.style.display = 'none';
      lbPanel.classList.add('active');
      if (mainTitle) mainTitle.innerHTML = '<i data-lucide="trophy" class="lucide" width="16" height="16"></i> Top Users';
      loadLeaderboard();
    } else if (tab === 'people') {
      if (searchBar) {
        searchBar.style.display = '';
        searchBar.placeholder = 'Search by name, skill, expertise...';
      }
      if (peoplePanel) peoplePanel.style.display = 'flex';
      if (mainTitle) mainTitle.innerHTML = '<i data-lucide="users" class="lucide" width="16" height="16"></i> Discover People';
      PeopleSearch.load('');
      loadCollabMatches();
      if (_lbUnsubscribe) { _lbUnsubscribe(); _lbUnsubscribe = null; }
    } else {
      if (feed) feed.style.display = '';
      if (searchBar) {
        searchBar.style.display = '';
        searchBar.placeholder = 'Search posts, tags, people...';
      }
      // filters row is now the dropdown — keep hidden
      // if (filters) filters.style.display = '';
      if (mainTitle) mainTitle.innerHTML = '<i data-lucide="globe" class="lucide" width="16" height="16"></i> Feed';
      if (_lbUnsubscribe) { _lbUnsubscribe(); _lbUnsubscribe = null; }
    }
  });
});

/* ═══════════════════════════════════════════════════
   PEOPLE SEARCH & DISCOVERY SYSTEM
   ═══════════════════════════════════════════════════ */
const PeopleSearch = (() => {
  let _allUsers = [];
  let _currentSkillFilter = '';
  let _searchQuery = '';
  let _loaded = false;

  // Load all users into memory (uses existing directory data + Firebase query)
  async function load(query) {
    _searchQuery = (query || '').toLowerCase().trim();
    const listEl = document.getElementById('people-list');
    const loadingEl = document.getElementById('people-loading');
    const emptyEl = document.getElementById('people-empty-state');
    if (!listEl) return;

    if (!_loaded) {
      if (loadingEl) loadingEl.style.display = 'flex';
      // Use already-loaded directory users
      const userItems = document.querySelectorAll('.user-item');
      _allUsers = [];
      userItems.forEach(item => {
        const uid = item.id.replace('u-', '');
        if (uid === state.currentUser?.uid) return;
        _allUsers.push({
          uid,
          username: item.dataset.username || '',
          skill: item.dataset.skill || '',
          level: item.dataset.level || 'Beginner',
          points: parseInt(item.dataset.points) || 0,
          status: item.dataset.status || 'offline',
          tags: (item.dataset.tags || '').split(',').filter(Boolean),
          goals: (item.dataset.goals || '').split(',').filter(Boolean),
        });
      });
      // Also enrich from user cache
      _allUsers = _allUsers.map(u => {
        const cached = getUserCached(u.uid);
        if (cached) {
          return {
            ...u,
            bio: cached.bio || '',
            pfpUrl: cached.pfpUrl || null,
            tags: cached.tags || u.tags,
            goals: cached.goals || u.goals,
            availability: cached.availability || [],
            expertise: cached.expertise || null,
          };
        }
        return u;
      });
      // Only mark as loaded if directory actually populated users.
      // If directory failed (e.g. Firebase rules denied the query), _loaded stays
      // false so this retries automatically the next time the People tab is opened.
      _loaded = _allUsers.length > 0;
      if (loadingEl) loadingEl.style.display = 'none';
    }

    _render();
  }

  function _filterUsers() {
    let results = _allUsers;

    // Skill filter
    if (_currentSkillFilter) {
      results = results.filter(u =>
        (u.skill || '').toLowerCase() === _currentSkillFilter.toLowerCase()
      );
    }

    // Text search
    if (_searchQuery) {
      const q = _searchQuery;
      results = results.filter(u => {
        const username = (u.username || '').toLowerCase();
        const skill = (u.skill || '').toLowerCase();
        const bio = (u.bio || '').toLowerCase();
        const tags = (u.tags || []).map(t => t.toLowerCase());
        const level = (u.level || '').toLowerCase();
        return (
          username.includes(q) ||
          skill.includes(q) ||
          bio.includes(q) ||
          tags.some(t => t.includes(q)) ||
          level.includes(q)
        );
      });
    }

    // Sort: online first, then by points
    results.sort((a, b) => {
      if (a.status === 'online' && b.status !== 'online') return -1;
      if (b.status === 'online' && a.status !== 'online') return 1;
      return (b.points || 0) - (a.points || 0);
    });

    return results;
  }

  function _render() {
    const listEl = document.getElementById('people-list');
    const emptyEl = document.getElementById('people-empty-state');
    if (!listEl) return;

    const results = _filterUsers();
    listEl.innerHTML = '';

    if (results.length === 0) {
      if (emptyEl) emptyEl.style.display = 'flex';
      return;
    }
    if (emptyEl) emptyEl.style.display = 'none';

    // Group: online vs offline if no search/filter
    const hasFilter = _searchQuery || _currentSkillFilter;
    if (!hasFilter) {
      const onlineUsers = results.filter(u => u.status === 'online');
      const offlineUsers = results.filter(u => u.status !== 'online');
      if (onlineUsers.length > 0) {
        const lbl = document.createElement('div');
        lbl.className = 'people-section-label';
        lbl.textContent = `Online Now (${onlineUsers.length})`;
        listEl.appendChild(lbl);
        onlineUsers.forEach(u => listEl.appendChild(_buildCard(u)));
      }
      if (offlineUsers.length > 0) {
        const lbl = document.createElement('div');
        lbl.className = 'people-section-label';
        lbl.textContent = `Members (${offlineUsers.length})`;
        listEl.appendChild(lbl);
        offlineUsers.forEach(u => listEl.appendChild(_buildCard(u)));
      }
    } else {
      const lbl = document.createElement('div');
      lbl.className = 'people-section-label';
      lbl.textContent = `${results.length} result${results.length !== 1 ? 's' : ''}`;
      listEl.appendChild(lbl);
      results.forEach(u => listEl.appendChild(_buildCard(u)));
    }
  }

  function _buildCard(u) {
    const card = document.createElement('div');
    card.className = 'people-card';
    card.dataset.uid = u.uid;

    const isOnline = u.status === 'online';
    const initial = (u.username || '?').slice(0, 2).toUpperCase();
    const avatarContent = u.pfpUrl
      ? `<img src="${escHtml(u.pfpUrl)}" alt="" loading="lazy">`
      : escHtml(initial);

    const tagsHtml = (u.tags || []).slice(0, 3).map(t =>
      `<span class="people-card-tag">${escHtml(t)}</span>`
    ).join('');

    const levelColors = {
      beginner: 'rgba(16,185,129,0.08)',
      intermediate: 'rgba(5, 150, 105, 0.08)',
      advanced: 'rgba(35, 87, 232, 0.08)',
      professional: 'rgba(245,158,11,0.08)',
    };
    const levelColor = levelColors[(u.level || '').toLowerCase()] || 'rgba(255,255,255,0.04)';

    card.innerHTML = `
      <div class="people-card-avatar${isOnline ? ' online' : ''}">${avatarContent}</div>
      <div class="people-card-body">
        <div class="people-card-name">@${escHtml(u.username)}</div>
        <div class="people-card-skill">
          <span class="people-card-skill-badge">${escHtml(u.skill || 'Explorer')}</span>
          ${isOnline ? '<span style="font-size:9px;color:var(--success);font-family:var(--font-mono);">● Online</span>' : ''}
        </div>
        ${tagsHtml ? `<div class="people-card-tags">${tagsHtml}</div>` : ''}
      </div>
      <div class="people-card-right">
        <span class="people-card-level" style="background:${levelColor}">${escHtml(u.level || 'Beginner')}</span>
        <span class="people-card-pts">⭐ ${u.points}</span>
      </div>
    `;

    card.addEventListener('click', () => {
      // Open user profile sheet
      const item = document.getElementById('u-' + u.uid);
      if (item) {
        openUserProfileSheet(u.uid, item.dataset);
      } else {
        // Fetch from cache
        const cached = getUserCached(u.uid);
        if (cached) openUserProfileSheet(u.uid, {
          username: cached.username || u.username,
          skill: cached.skill || u.skill,
          level: cached.level || u.level,
          points: cached.points || u.points,
          status: u.status,
          bio: cached.bio || u.bio,
          tags: (cached.tags || u.tags || []).join(','),
          goals: (cached.goals || u.goals || []).join(','),
        });
      }
    });

    return card;
  }

  function setSkillFilter(skill) {
    _currentSkillFilter = skill;
    _render();
  }

  function search(query) {
    _searchQuery = (query || '').toLowerCase().trim();
    _render();
  }

  function invalidate() { _loaded = false; _allUsers = []; }

  return { load, search, setSkillFilter, invalidate };
})();

// Wire skill filter pills
document.querySelectorAll('.people-skill-pill').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.people-skill-pill').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    PeopleSearch.setSkillFilter(btn.dataset.skill || '');
  });
});

const _origOnAuthStateChanged_gami = (() => {
  // Patch: after state is loaded, run gamification init
  const origLoadDir = loadDirectory;
  window._gamiInit = async function(uid, points) {
    await checkAndUpdateStreak(uid);
    await checkAndAwardBadges(uid);
    // Render existing badges from state
    try {
      const snap = await get(ref(db, `users/${uid}/badges`));
      if (snap.exists()) renderAchievementBadges(snap.val() || []);
      const streakSnap = await get(ref(db, `users/${uid}/streak`));
      renderStreakBadge(streakSnap.val() || 0);
    } catch(e) {}
  };
})();

// ── Patch sendTextMessage to show floating pts + track msgs ──
const _origSendText = sendTextMessage;
window.sendTextMessage = async function(text) {
  const oldPts = state.points || 0;
  await _origSendText.call(this, text);
  showPtsFloat();
  if (state.currentUser) {
    incrementMsgsSent(state.currentUser.uid);
    // Check for level up after points increment (points+1)
    const newPts = oldPts + 1;
    checkLevelUp(newPts, oldPts);
  }
};

// ── Patch profile modal open to refresh gamification UI ──
const _origOpenProfileModal = openProfileModal;
window.openProfileModal = function() {
  _origOpenProfileModal.call(this);
  if (state.currentUser) {
    get(ref(db, `users/${state.currentUser.uid}`)).then(snap => {
      const d = snap.val() || {};
      renderStreakBadge(d.streak || 0);
      renderAchievementBadges(d.badges || []);
    }).catch(() => {});
  }
};

// ── Load level-up state on directory update ──
// Hook into the points watcher inside loadDirectory — observe stat-points DOM mutations
const _ptsMutationObs = new MutationObserver(() => {
  const displayed = parseInt(document.getElementById('stat-points')?.textContent || '0');
  if (!isNaN(displayed) && state.currentUser) {
    const levelInfo = getLevelForPoints(displayed);
    // Only celebrate if current displayed level is higher than last celebrated
    if (_lastCelebratedLevel === null) {
      _lastCelebratedLevel = getLevelForPoints(0).level; // init without celebration on page load
    }
  }
});
const statPtsEl = document.getElementById('stat-points');
if (statPtsEl) _ptsMutationObs.observe(statPtsEl, { childList: true, characterData: true, subtree: true });

// ══════════════════════════════════════════
// EXPERTISE EDIT MODAL — FIXED (inside module scope)
// ══════════════════════════════════════════
(function() {
  const EXPERTISE_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

  const _pex = {
    type: null, linkUrl: '', images: [], code: '', audioFile: null, file: null
  };

  function _isValidUrl(u) {
    try { const url = new URL(u); return url.protocol === 'https:' || url.protocol === 'http:'; } catch { return false; }
  }

  function _showTypePanel(type) {
    ['link','image','code','audio','file'].forEach(t => {
      const el = document.getElementById('profile-expertise-input-' + t);
      if (el) el.style.display = (t === type) ? '' : 'none';
    });
  }

  function _reset() {
    _pex.type = null; _pex.linkUrl = ''; _pex.images = []; _pex.code = ''; _pex.audioFile = null; _pex.file = null;
    document.querySelectorAll('#profile-expertise-type-grid .expertise-type-btn').forEach(b => b.classList.remove('active'));
    ['link','image','code','audio','file'].forEach(t => {
      const el = document.getElementById('profile-expertise-input-' + t);
      if (el) el.style.display = 'none';
    });
    const li = document.getElementById('profile-expertise-link-input'); if (li) li.value = '';
    const ci = document.getElementById('profile-expertise-code-input'); if (ci) ci.value = '';
    const cc = document.getElementById('profile-expertise-code-count'); if (cc) cc.textContent = '0';
    const iw = document.getElementById('profile-expertise-image-preview-wrap'); if (iw) iw.innerHTML = '';
    const aw = document.getElementById('profile-expertise-audio-preview-wrap'); if (aw) aw.innerHTML = '';
    const fw = document.getElementById('profile-expertise-file-preview-wrap'); if (fw) fw.innerHTML = '';
    ['profile-expertise-link-error','profile-expertise-image-error','profile-expertise-audio-error','profile-expertise-file-error'].forEach(id => {
      const el = document.getElementById(id); if (el) { el.style.display = 'none'; el.textContent = ''; }
    });
    ['profile-expertise-image-input','profile-expertise-audio-input','profile-expertise-file-input'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = '';
    });
  }

  function _serialize() {
    if (!_pex.type) return null;
    const base = { type: _pex.type };
    if (_pex.type === 'link') {
      if (!_isValidUrl(_pex.linkUrl)) return null;
      base.url = _pex.linkUrl;
    } else if (_pex.type === 'image') {
      if (!_pex.images.length) return null;
      base.images = _pex.images.map(i => ({ name: i.name, dataUrl: i.dataUrl }));
    } else if (_pex.type === 'code') {
      if (!_pex.code.trim()) return null;
      base.code = _pex.code;
    } else if (_pex.type === 'audio') {
      if (!_pex.audioFile) return null;
      base.audio = { name: _pex.audioFile.name, dataUrl: _pex.audioFile.dataUrl };
    } else if (_pex.type === 'file') {
      if (!_pex.file) return null;
      base.file = { name: _pex.file.name, dataUrl: _pex.file.dataUrl, mimeType: _pex.file.mimeType };
    }
    return base;
  }

  // ── Cooldown check ──
  function _checkCooldown() {
    const expertise = state.expertise;
    // If no expertise or no timestamp, user can freely set for the first time
    if (!expertise || !expertise.updatedAt) return { allowed: true };
    const elapsed = Date.now() - expertise.updatedAt;
    if (elapsed >= EXPERTISE_COOLDOWN_MS) return { allowed: true };
    const hoursLeft = Math.ceil((EXPERTISE_COOLDOWN_MS - elapsed) / (60 * 60 * 1000));
    return { allowed: false, hoursLeft };
  }

  function openExpertiseEditModal() {
    // Check cooldown BEFORE opening the modal
    const cooldown = _checkCooldown();
    if (!cooldown.allowed) {
      Toast.error(`You can update your expertise after ${cooldown.hoursLeft} more hour${cooldown.hoursLeft > 1 ? 's' : ''}`);
      return;
    }
    _reset();
    const overlay = document.getElementById('expertise-edit-modal-overlay');
    if (overlay) overlay.classList.add('open');
  }

  function closeExpertiseEditModal() {
    const overlay = document.getElementById('expertise-edit-modal-overlay');
    if (overlay) overlay.classList.remove('open');
    _reset();
  }

  // ── Wire "Edit/Add Expertise" button in profile modal ──
  const _editBtn = document.getElementById('modal-edit-expertise-btn');
  if (_editBtn) {
    _editBtn.addEventListener('click', () => openExpertiseEditModal());
  }

  // ── Close / Cancel buttons ──
  const _closeBtn = document.getElementById('expertise-edit-modal-close');
  if (_closeBtn) _closeBtn.addEventListener('click', closeExpertiseEditModal);

  const _cancelBtn = document.getElementById('expertise-edit-modal-cancel');
  if (_cancelBtn) _cancelBtn.addEventListener('click', closeExpertiseEditModal);

  // ── Close on overlay click ──
  const _overlay = document.getElementById('expertise-edit-modal-overlay');
  if (_overlay) {
    _overlay.addEventListener('click', (e) => {
      if (e.target === _overlay) closeExpertiseEditModal();
    });
  }

  // ── Type selector buttons ──
  const _typeGrid = document.getElementById('profile-expertise-type-grid');
  if (_typeGrid) {
    _typeGrid.addEventListener('click', (e) => {
      const btn = e.target.closest('.expertise-type-btn');
      if (!btn) return;
      document.querySelectorAll('#profile-expertise-type-grid .expertise-type-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _pex.type = btn.dataset.type;
      _showTypePanel(_pex.type);
    });
  }

  // ── Link input ──
  const _linkInput = document.getElementById('profile-expertise-link-input');
  if (_linkInput) {
    _linkInput.addEventListener('input', () => {
      _pex.linkUrl = _linkInput.value.trim();
      const errEl = document.getElementById('profile-expertise-link-error');
      if (errEl) errEl.style.display = (_pex.linkUrl && !_isValidUrl(_pex.linkUrl)) ? 'block' : 'none';
    });
  }

  // ── Image input ──
  const _imageInput = document.getElementById('profile-expertise-image-input');
  if (_imageInput) {
    _imageInput.addEventListener('change', async () => {
      const files = Array.from(_imageInput.files);
      const errEl = document.getElementById('profile-expertise-image-error');
      const previewWrap = document.getElementById('profile-expertise-image-preview-wrap');
      if (!files.length) return;
      const MAX = 3, MAX_SIZE = 5 * 1024 * 1024;
      const valid = files.filter(f => f.type.startsWith('image/') && f.size <= MAX_SIZE).slice(0, MAX);
      if (valid.length < files.length && errEl) { errEl.textContent = 'Some files skipped (max 3, images only, ≤5MB each)'; errEl.style.display = 'block'; }
      _pex.images = [];
      if (previewWrap) previewWrap.innerHTML = '';
      for (const f of valid) {
        const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
        _pex.images.push({ name: f.name, dataUrl });
        if (previewWrap) {
          const wrap = document.createElement('div'); wrap.className = 'expertise-img-thumb-wrap';
          const img = document.createElement('img'); img.className = 'expertise-img-thumb'; img.src = dataUrl;
          const removeBtn = document.createElement('button'); removeBtn.className = 'expertise-img-remove'; removeBtn.innerHTML = '<i data-lucide="x" class="lucide" width="12" height="12"></i>'; removeBtn.type = 'button';
          const capturedUrl = dataUrl;
          removeBtn.addEventListener('click', () => {
            _pex.images = _pex.images.filter(i => i.dataUrl !== capturedUrl);
            wrap.remove();
          });
          wrap.append(img, removeBtn); previewWrap.appendChild(wrap);
        }
      }
    });
  }

  // ── Code input ──
  const _codeInput = document.getElementById('profile-expertise-code-input');
  const _codeCount = document.getElementById('profile-expertise-code-count');
  if (_codeInput) {
    _codeInput.addEventListener('input', () => {
      _pex.code = _codeInput.value;
      if (_codeCount) _codeCount.textContent = _pex.code.length;
    });
  }

  // ── Audio input ──
  const _audioInput = document.getElementById('profile-expertise-audio-input');
  if (_audioInput) {
    _audioInput.addEventListener('change', async () => {
      const f = _audioInput.files[0]; if (!f) return;
      const errEl = document.getElementById('profile-expertise-audio-error');
      const previewWrap = document.getElementById('profile-expertise-audio-preview-wrap');
      // ── PRO MEDIA: Pro gets 16MB audio, free gets 8MB ──
      const _projAudioMax = ProMedia.isPro() ? 16 * 1024 * 1024 : 8 * 1024 * 1024;
      if (f.size > _projAudioMax) {
        if (errEl) { errEl.textContent = `Audio too large (max ${ProMedia.isPro() ? '16MB · Pro' : '8MB'})`; errEl.style.display = 'block'; } return;
      }
      if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
      const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
      _pex.audioFile = { name: f.name, dataUrl };
      if (previewWrap) {
        previewWrap.innerHTML = '';
        const audio = document.createElement('audio'); audio.className = 'expertise-audio-player'; audio.controls = true; audio.preload = 'metadata'; audio.src = dataUrl;
        previewWrap.appendChild(audio);
      }
    });
  }

  // ── File input ──
  const _fileInput = document.getElementById('profile-expertise-file-input');
  if (_fileInput) {
    _fileInput.addEventListener('change', async () => {
      const f = _fileInput.files[0]; if (!f) return;
      const errEl = document.getElementById('profile-expertise-file-error');
      const previewWrap = document.getElementById('profile-expertise-file-preview-wrap');
      // ── PRO MEDIA: Pro gets 20MB file, free gets 10MB ──
      const _projFileMax = ProMedia.isPro() ? 20 * 1024 * 1024 : 10 * 1024 * 1024;
      if (f.size > _projFileMax) {
        if (errEl) { errEl.textContent = `File too large (max ${ProMedia.isPro() ? '20MB · Pro' : '10MB'})`; errEl.style.display = 'block'; } return;
      }
      if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
      const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
      _pex.file = { name: f.name, dataUrl, mimeType: f.type };
      if (previewWrap) {
        previewWrap.innerHTML = '';
        const chip = document.createElement('div'); chip.className = 'expertise-file-chip';
        chip.innerHTML = `<span><i data-lucide="file" class="lucide" width="16" height="16"></i></span><span class="expertise-file-chip-name">${f.name}</span><span style="font-family:var(--font-mono);font-size:10px;color:var(--muted);flex-shrink:0;">${(f.size/1024).toFixed(1)}KB</span>`;
        previewWrap.appendChild(chip);
      }
    });
  }

  // ── SAVE BUTTON — FIXED ──
  const _saveBtn = document.getElementById('expertise-edit-modal-save');
  if (_saveBtn) {
    _saveBtn.addEventListener('click', async () => {
      if (!_pex.type) { Toast.error('Please choose a type first'); return; }
      const data = _serialize();
      if (!data) { Toast.error('Please fill in your expertise details'); return; }

      // Re-check cooldown at save time (safety net)
      const cooldown = _checkCooldown();
      if (!cooldown.allowed) {
        Toast.error(`You can update your expertise after ${cooldown.hoursLeft} more hour${cooldown.hoursLeft > 1 ? 's' : ''}`);
        closeExpertiseEditModal();
        return;
      }

      _saveBtn.textContent = 'Saving...'; _saveBtn.disabled = true;
      try {
        // Add timestamp for cooldown tracking
        data.updatedAt = Date.now();

        // Save to Firebase
        await update(ref(db, 'users/' + state.currentUser.uid), { expertise: data });

        // Update local state
        state.expertise = data;

        // Refresh expertise display inside profile modal
        if (typeof ExpertiseModule !== 'undefined' && ExpertiseModule.renderInPanel) {
          try { ExpertiseModule.renderInPanel('modal-expertise-display', data); } catch(e) {}
        }

        // Update the Edit/Add label
        const editLabel = document.getElementById('modal-edit-expertise-label');
        if (editLabel) editLabel.textContent = 'Edit Expertise';

        Toast.success('Expertise saved!');
        closeExpertiseEditModal();
      } catch(err) {
        DEBUG && console.error('[ExpertiseSave]', err);
        Toast.error('Failed to save expertise. Please try again.');
      } finally {
        _saveBtn.textContent = 'Save Expertise'; _saveBtn.disabled = false;
      }
    });
  }
})();
// ══════════════════════════════════════════
// END EXPERTISE EDIT MODAL
// ══════════════════════════════════════════

// Run gamification init when user is confirmed loaded
// We hook onto the existing loadDirectory call sequence
const _gamiInitObserver = new MutationObserver((mutations) => {
  for (const m of mutations) {
    if (m.type === 'childList' && document.getElementById('users-list')?.children.length > 0) {
      if (state.currentUser && !window._gamiDidInit) {
        window._gamiDidInit = true;
        window._gamiInit(state.currentUser.uid, state.points || 0);
      }
      _gamiInitObserver.disconnect();
      break;
    }
  }
});
const usersList = document.getElementById('users-list');
if (usersList) _gamiInitObserver.observe(usersList, { childList: true });


// ── Export to window ──
Object.assign(window, { getLevelForPoints, checkLevelUp, PeopleSearch });
