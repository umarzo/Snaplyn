const { state, $, $$, escHtml, badgeHTML, generateAvatarUrl, debounce, timeAgo,
  db, ref, get, set, onValue, off, update, serverTimestamp,
  CONFIG, PREDEFINED_SKILLS, cacheUser, getUserCached,
  Toast, ScreenManager, openChat, openUserProfileSheet } = window;

/* ═══════════════════════════════════════════════════
   PROFILE MODAL
   ═══════════════════════════════════════════════════ */
function checkProfileBanner() {
  const b = $('profile-completion-banner');
  b.style.display = (state.skill.toLowerCase() === 'explorer' || !state.bio) ? 'flex' : 'none';
}

$('profile-completion-banner').addEventListener('click', openProfileModal);
$('profile-icon-btn').addEventListener('click', openProfileModal);
$('modal-close-btn').addEventListener('click', () => $('profile-modal').classList.remove('open'));

function openProfileModal() {
  $('modal-username-input').value = state.username;
  state.modalSelectedSkill = state.skill;
  $('modal-skill-input').value = state.skill;
  setSkillGridSelection('modal-skill-grid', state.skill);
  $('modal-level-input').value = state.level;
  $('modal-bio-input').value = state.bio;
  /* ── Pro: populate fields ── */
  const _mTagInput = document.getElementById('modal-tagline-input');
  const _mTagField = document.getElementById('modal-tagline-field');
  const _mBioHint  = document.getElementById('bio-pro-hint');
  const _mBioInput = $('modal-bio-input');
  if (state.isPro) {
    if (_mTagField) _mTagField.style.display = 'block';
    if (_mTagInput) _mTagInput.value = state.tagline || '';
    if (_mBioInput) _mBioInput.maxLength = 500;
    if (_mBioHint)  _mBioHint.textContent = '500 chars (Pro)';
  } else {
    if (_mTagField) _mTagField.style.display = 'none';
    if (_mBioInput) _mBioInput.maxLength = 200;
    if (_mBioHint)  _mBioHint.textContent = '';
  }
  renderProStatusUI();
  $('modal-username-error').style.display = 'none';
  $('stat-points').textContent = state.points;
  $('stat-level').textContent = state.level.slice(0, 3).toUpperCase();
  $('stat-chats').textContent = state.chattedWith.size;
  state.modalTags.length = 0; state.modalTags.push(...state.tags); modalTagManager.render();
  new PillManager('modal-goals-grid', state.goals, 'goal').rebind();
  new PillManager('modal-avail-grid', state.availability, 'avail').rebind();
  const ph = getProfilePicUrl({ pfpUrl: state.pfpUrl }, state.currentUser.uid);
  $('modal-avatar').src = ph;
  updatePfpUI();
  // Render expertise display and set Add/Edit label
  if (typeof ExpertiseModule !== 'undefined' && ExpertiseModule.renderInPanel) {
    try { ExpertiseModule.renderInPanel('modal-expertise-display', state.expertise || null); } catch(e) {}
  }
  if (typeof SocialIntegrationsModule !== 'undefined' && SocialIntegrationsModule.renderInPanel) {
    try { SocialIntegrationsModule.renderInPanel('modal-social-display', state.socialIntegrations || null); } catch(e) {}
  }
  const editLabel = $('modal-edit-expertise-label');
  if (editLabel) {
    if (state.expertise && state.expertise.type) {
      // Check if still in cooldown to show lock icon
      const _cdMs = 24 * 60 * 60 * 1000;
      const _lastUpdated = state.expertise.updatedAt || 0;
      const _elapsed = Date.now() - _lastUpdated;
      if (_lastUpdated && _elapsed < _cdMs) {
        const _hLeft = Math.ceil((_cdMs - _elapsed) / (60 * 60 * 1000));
        editLabel.textContent = `Locked (${_hLeft}h)`;
      } else {
        editLabel.textContent = 'Edit Expertise';
      }
    } else {
      editLabel.textContent = 'Add Expertise';
    }
  }
  $('profile-modal').classList.add('open');
}

/* ═══════════════════════════════════════════════════
   PROFILE PICTURE CHANGE
   ═══════════════════════════════════════════════════ */
$('modal-avatar').addEventListener('click', () => triggerPfpChange());
$('pfp-change-label').addEventListener('click', () => triggerPfpChange());

function triggerPfpChange() {
  const { allowed, daysLeft } = canChangePfp();
  if (!allowed) {
    Toast.info(`Profile photo locked for ${daysLeft} more day${daysLeft > 1 ? 's' : ''}`);
    return;
  }
  $('pfp-file-input').value = '';
  $('pfp-file-input').click();
}

$('pfp-file-input').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  if (!f.type.startsWith('image/')) { Toast.error('Select an image file'); return; }
  if (f.size > 5 * 1024 * 1024) { Toast.error('Image too large (max 5MB)'); return; }
  Toast.info('Compressing photo...');
  try {
    const dataUrl = await compressProfilePicture(f);
    const now = Date.now();
    await update(ref(db, `users/${state.currentUser.uid}`), { pfpUrl: dataUrl, pfpChangedAt: now });
    state.pfpUrl = dataUrl;
    state.pfpChangedAt = now;
    $('modal-avatar').src = dataUrl;
    $('profile-icon-btn').src = dataUrl;
    updatePfpUI();
    Toast.success(`Photo updated! Locked for ${CONFIG.PFP_COOLDOWN_DAYS} days`, 4000);
  } catch (err) { Toast.error(err.message || 'Failed to update photo'); }
});

/* ═══════════════════════════════════════════════════
   SAVE PROFILE CHANGES
   ═══════════════════════════════════════════════════ */
$('modal-save-btn').addEventListener('click', async () => {
  const raw = $('modal-username-input').value.trim().toLowerCase();
  const nn = raw.replace(/[^a-z0-9_]/g, '');
  const nsk = state.modalSelectedSkill || state.skill || 'Explorer';
  const nlv = $('modal-level-input').value;
  const nbio = $('modal-bio-input').value.trim();
  if (nn.length < CONFIG.MIN_USERNAME_LENGTH) { Toast.error('Username too short'); return; }

  const btn = $('modal-save-btn'); btn.textContent = 'Saving...'; btn.disabled = true;
  try {
    if (nn !== state.username) {
      const snap = await get(ref(db, 'usernames/' + nn));
      if (snap.exists()) { $('modal-username-error').style.display = 'block'; btn.textContent = 'Save Changes'; btn.disabled = false; return; }
      $('modal-username-error').style.display = 'none';
      await set(ref(db, 'usernames/' + nn), state.currentUser.uid);
      await remove(ref(db, 'usernames/' + state.username));
      state.username = nn;
    }
    const _saveTagline = state.isPro
      ? ((document.getElementById('modal-tagline-input')?.value || '').trim().slice(0, 80))
      : (state.tagline || '');
    await update(ref(db, 'users/' + state.currentUser.uid), {
      username: state.username, skill: nsk, level: nlv, bio: nbio,
      tags: state.modalTags.slice(), goals: state.goals.slice(), availability: state.availability.slice(),
      expertise: state.expertise || null,
      tagline: _saveTagline
    });
    state.tagline = _saveTagline;
const oldSkill = state.skill;
    Object.assign(state, { skill: nsk, level: nlv, bio: nbio, tags: state.modalTags.slice() });
    checkProfileBanner(); sortUserList();

    // If skill changed, reset the guild so it reloads with new skill on next visit
    if (oldSkill !== nsk) {
      cleanupGuildListeners();
      guildState.currentGuildId = null;
    }

    Toast.success('Profile updated!');
    setTimeout(() => $('profile-modal').classList.remove('open'), 500);
  } catch (e) { Toast.error('Save failed'); }
  finally { btn.textContent = 'Save Changes'; btn.disabled = false; }
});

/* ═══════════════════════════════════════════════════
   DIRECTORY: SCORING, SORTING, RECOMMENDATIONS
   ═══════════════════════════════════════════════════ */
/* ─── Matchmaking Score ───
   Factors (highest → lowest weight):
   1. Compatible goals (+35)  e.g. "want to learn" ↔ skill sharer
   2. Shared skill tags (+20 each, max ~100)
   3. Complementary levels (+15)  e.g. Beginner ↔ Advanced
   4. Online presence (+20)
   5. Reputation (+2/pt, capped 100)
   6. Same skill as viewer (+40)
   7. Explorer penalty (-80)
   ─── */
const GOAL_COMPLEMENTS = {
  'want to learn':       ['want to teach', 'open to share', 'want collaboration'],
  'looking for clients': ['open to hire', 'want collaboration'],
  'want collaboration':  ['want collaboration', 'looking for clients', 'want to learn'],
  'open to hire':        ['looking for clients']
};
const LEVEL_ORDER = { beginner: 0, intermediate: 1, advanced: 2, professional: 3 };

function scoreUserItem(el) {
  let s = 0;
  const sk = (el.dataset.skill || '').toLowerCase();
  const pts = parseInt(el.dataset.points) || 0;
  const theirLevel = (el.dataset.level || 'beginner').toLowerCase();
  const myLevel = (state.level || 'beginner').toLowerCase();

  // Skill match / penalty
  if (sk === 'explorer') s -= 80;
  else if (state.skill && sk === state.skill.toLowerCase()) s += 40;

  // Shared tags
  const ut = (el.dataset.tags || '').toLowerCase().split(',').filter(Boolean);
  const mt = state.tags.map(t => t.toLowerCase());
  s += Math.min(ut.filter(t => mt.includes(t)).length * 20, 100);

  // Complementary levels (beginner benefits from finding advanced, and vice versa)
  const theirLvNum = LEVEL_ORDER[theirLevel] || 0;
  const myLvNum = LEVEL_ORDER[myLevel] || 0;
  if (Math.abs(theirLvNum - myLvNum) >= 2) s += 15; // Large gap = good mentor match
  else if (theirLvNum === myLvNum) s += 5;            // Peers can collaborate

  // Goal compatibility
  const theirGoals = (el.dataset.goals || '').toLowerCase().split(',').filter(Boolean);
  const myGoals = state.goals.map(g => g.toLowerCase());
  myGoals.forEach(myGoal => {
    const complements = GOAL_COMPLEMENTS[myGoal] || [];
    if (theirGoals.some(tg => complements.includes(tg) || tg === myGoal)) s += 35;
  });

  // Online presence
  if (el.dataset.status === 'online') s += 20;

  // Reputation
  s += Math.min(pts * 2, 100);

  return s;
}

/* ── Debounced sortUserList — prevents multiple rapid sorts in one frame ── */
const _debouncedSort = debounce(_doSortUserList, 80);
function sortUserList() { _debouncedSort(); }

function _doSortUserList() {
  const l = $('users-list'); if (!l) return;
  const allItems = [...l.querySelectorAll('.user-item')];
  /* ── Pro: separate Pro users, boost them to top ── */
  const proItems    = allItems.filter(i => i.dataset.isPro === '1');
  const freeItems   = allItems.filter(i => i.dataset.isPro !== '1');
  /* Pro: sort by last activity (most active Pro user first) */
  proItems.sort((a, b) => (parseInt(b.dataset.timestamp)||0) - (parseInt(a.dataset.timestamp)||0));
  /* Free: chatted vs fresh, as before */
  const items   = freeItems;
  const chatted = items.filter(i => state.chattedWith.has(i.id.replace('u-', ''))).sort((a, b) => {
    const d = (parseInt(b.dataset.timestamp) || 0) - (parseInt(a.dataset.timestamp) || 0);
    return d !== 0 ? d : scoreUserItem(b) - scoreUserItem(a);
  });
  const fresh = items.filter(i => !state.chattedWith.has(i.id.replace('u-', ''))).sort((a, b) => scoreUserItem(b) - scoreUserItem(a));
  l.querySelectorAll('.section-sep, .pro-dir-sep').forEach(s => s.remove());

  /* ── Batch DOM moves in one pass to minimise reflows ── */
  const frag = document.createDocumentFragment();
  /* Insert Pro section first */
  if (proItems.length > 0) {
    const proSep = document.createElement('div');
    proSep.className = 'pro-dir-sep';
    proSep.textContent = '⭐ Pro Members';
    frag.appendChild(proSep);
    proItems.forEach(i => frag.appendChild(i));
  }
  chatted.forEach(i => frag.appendChild(i));
  if (chatted.length > 0 && fresh.length > 0) {
    const sep = document.createElement('div'); sep.className = 'section-sep'; sep.textContent = 'Discover'; frag.appendChild(sep);
  }
  fresh.forEach(i => {
    // Add or update match score badge for undiscovered users
    const score = scoreUserItem(i);
    let badge = i.querySelector('.match-score-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'match-score-badge';
      const unreadBadge = i.querySelector('.unread-badge');
      if (unreadBadge) i.insertBefore(badge, unreadBadge);
      else i.appendChild(badge);
    }
    if (score >= 60) {
      badge.className = 'match-score-badge high';
      badge.innerHTML = '<i data-lucide="zap" class="lucide" width="12" height="12"></i> Match';
      badge.title = `High match score: ${score}`;
    } else if (score >= 25) {
      badge.className = 'match-score-badge med';
      badge.textContent = 'Compatible';
      badge.title = `Match score: ${score}`;
    } else {
      badge.className = 'match-score-badge low';
      badge.textContent = '';
    }
    frag.appendChild(i);
  });
  l.appendChild(frag); /* single DOM mutation — no intermediate reflows */
  buildRecommendations([...chatted, ...fresh]);
  updateOnlineCount();
}

function buildRecommendations(sorted) {
  const w = $('recs-wrap'), lst = $('recs-list');
  if (!w || !lst) return; lst.innerHTML = '';
  const top = sorted.filter(i => scoreUserItem(i) > 0 && !state.chattedWith.has(i.id.replace('u-', ''))).slice(0, 6);
  if (top.length > 0) {
    w.style.display = 'block';
    top.forEach(item => {
      const uid = item.id.replace('u-', '');
      const score = scoreUserItem(item);
      const isOnline = item.dataset.status === 'online';
      const scoreLabel = score >= 80 ? 'Top match' : score >= 50 ? 'Good match' : 'Compatible';
      const card = document.createElement('div'); card.className = 'rec-card';
      card.innerHTML = `<div class="rec-name">@${escHtml(item.dataset.username)}</div><div class="rec-skill">${escHtml(item.dataset.skill)}</div><div style="font-size:9px;margin-top:4px;font-family:var(--font-mono);opacity:0.7;color:var(--accent-light)">${scoreLabel}${isOnline ? ' · ●' : ''}</div>`;
      card.title = `Match score: ${score} — ${item.dataset.level || 'Beginner'}`;
      card.addEventListener('click', () => triggerChat(uid, item.dataset));
      lst.appendChild(card);
    });
  } else w.style.display = 'none';
}

function updateOnlineCount() {
  const all = $$('.user-item');
  $('online-count').textContent = `${[...all].filter(i => i.dataset.status === 'online').length} online · ${all.length} members`;
  // Invalidate people search cache on directory refresh so it picks up new data
  if (typeof PeopleSearch !== 'undefined') PeopleSearch.invalidate();
}

function cleanupDirectoryListeners() {
  if (state.unsubDirectory) { state.unsubDirectory(); state.unsubDirectory = null; }
  state.directoryListeners.forEach(l => l.forEach(u => { try { u(); } catch (e) {} }));
  state.directoryListeners.clear();
}

/* ═══════════════════════════════════════════════════
   DIRECTORY: LOAD
   ═══════════════════════════════════════════════════ */
function loadDirectory() {
  cleanupDirectoryListeners();
  // limitToLast(50): prevents downloading the entire users tree on every change (cost + perf fix)
  const directoryQuery = query(ref(db, 'users'), orderByChild('points'), limitToLast(50));
  let _dirFirstLoad = true;
  state.unsubDirectory = onValue(directoryQuery, snap => {
    // Remove skeleton user cards on first real data load
    if (_dirFirstLoad) {
      _dirFirstLoad = false;
      ['skel-user-1','skel-user-2','skel-user-3','skel-user-4','skel-user-5','skel-user-6'].forEach(id => {
        const el = document.getElementById(id); if (el) el.remove();
      });
      // Also remove skeleton rec pills
      ['skel-rec-1','skel-rec-2','skel-rec-3'].forEach(id => {
        const el = document.getElementById(id); if (el) el.remove();
      });
    }
    const d = snap.val(); if (!d) return;
    const l = $('users-list'); if (!l) return;
    const existing = new Set(Object.keys(d).filter(uid => uid !== state.currentUser.uid));
    l.querySelectorAll('.user-item').forEach(el => {
      const uid = el.id.replace('u-', '');
      if (!existing.has(uid)) {
        el.remove();
        const ls = state.directoryListeners.get(uid);
        if (ls) { ls.forEach(u => { try { u(); } catch (e) {} }); state.directoryListeners.delete(uid); }
      }
    });
    for (const [uid, val] of Object.entries(d)) {
      if (uid === state.currentUser.uid) {
        state.points = val.points || 0;
        if (val.pfpUrl && val.pfpUrl !== state.pfpUrl) {
          state.pfpUrl = val.pfpUrl;
          $('profile-icon-btn').src = val.pfpUrl;
        }
        if (val.pfpChangedAt) state.pfpChangedAt = val.pfpChangedAt;
        continue;
      }

      cacheUser(uid, val); // TTL-based cache; use getUserCached(uid) to read

      const sk = val.skill || 'Explorer', lv = val.level || 'Beginner', pts = val.points || 0, tags = (val.tags || []).join(',');
      const effectiveStatus = isUserTrulyOnline(val) ? 'online' : 'offline';

     let el = document.getElementById('u-' + uid);
if (!el) {
  // Blocked user check – hide if blocked
  if (state.currentUser) {
    get(ref(db, `users/${state.currentUser.uid}/blocked/${uid}`)).then(snap => {
      if (snap.exists() && snap.val() === true) {
        const existingCard = document.getElementById('u-' + uid);
        if (existingCard) existingCard.style.display = 'none';
      }
    }).catch(() => {});
  }

  el = document.createElement('div');
  el.className = 'user-item' + (val.isPro ? ' is-pro' : '');
  el.id = 'u-' + uid;
  el.dataset.timestamp = '0';
  el.dataset.isPro = val.isPro ? '1' : '0';
  el.setAttribute('role', 'listitem');
  const avatarContent = val.pfpUrl
    ? `<img src="${escHtml(val.pfpUrl)}" alt="${escHtml(val.username)}" loading="lazy">`
    : initials(val.username);
  const _proBadgeHtml = val.isPro ? ' <span class="pro-badge" title="Golex Pro Member"><i data-lucide="award" class="lucide" width="12" height="12"></i></span>' : '';
  el.innerHTML = `<div class="user-avatar-wrap"><div class="user-avatar" id="av-${uid}">${avatarContent}</div><div class="status-pip" id="pip-${uid}"></div></div><div class="user-body"><div class="user-top"><span class="user-name" id="un-${uid}">@${escHtml(val.username)}${_proBadgeHtml}</span><span id="bd-${uid}">${badgeHTML(sk, lv, pts)}</span></div><div class="user-preview" id="pv-${uid}">No messages yet</div></div><div class="unread-badge" id="ub-${uid}"></div>`;
  el.addEventListener('click', () => triggerChat(uid, el.dataset));
  l.appendChild(el);
  setupUserChatListeners(uid);
} else {
        const avEl = $(`av-${uid}`);
        if (avEl) {
          if (val.pfpUrl) {
            const existingImg = avEl.querySelector('img');
            if (!existingImg || existingImg.src !== val.pfpUrl) {
              avEl.innerHTML = `<img src="${escHtml(val.pfpUrl)}" alt="${escHtml(val.username)}" loading="lazy">`;
            }
          } else {
            if (avEl.querySelector('img')) { avEl.innerHTML = ''; avEl.textContent = initials(val.username); }
          }
        }
      }
      el.dataset.username = val.username || ''; el.dataset.skill = sk;
      el.dataset.isPro = val.isPro ? '1' : '0';
      el.classList.toggle('is-pro', val.isPro === true);
      el.dataset.level = lv; el.dataset.status = effectiveStatus;
      el.dataset.points = String(pts); el.dataset.tags = tags;
      el.dataset.goals = (val.goals || []).join(',');
      const pip = $(`pip-${uid}`); if (pip) pip.className = 'status-pip' + (effectiveStatus === 'online' ? ' online' : '');
      const un = $(`un-${uid}`); if (un && un.textContent !== '@' + (val.username || '')) un.textContent = '@' + (val.username || '');
      const bd = $(`bd-${uid}`); if (bd) { const nb = badgeHTML(sk, lv, pts); if (bd.innerHTML !== nb) bd.innerHTML = nb; }
    }
    applyFilters(); sortUserList();
  }, error => {
    // Firebase denied the directory query — check that the users node has
    // ".read": "auth != null" in deployed rules and the user is signed in.
    console.error('[Golex] Directory load failed:', error.code, error.message);
    ['skel-user-1','skel-user-2','skel-user-3','skel-user-4','skel-user-5','skel-user-6',
     'skel-rec-1','skel-rec-2','skel-rec-3'].forEach(id => {
      const el = document.getElementById(id); if (el) el.remove();
    });
    // Invalidate PeopleSearch so it retries when the tab is opened
    if (typeof PeopleSearch !== 'undefined') PeopleSearch.invalidate();
  });
}

function setupUserChatListeners(uid) {
  const cid = generateChatId(state.currentUser.uid, uid), ls = [];

  const lm = ref(db, `chats/${cid}/lastMessage`);
  onValue(lm, snap => {
    const v = snap.val();
    if (v) {
      const pv = $(`pv-${uid}`);
      if (pv) pv.textContent = typeof v === 'string' ? v : (v.text || 'Attachment');
      const el = document.getElementById('u-' + uid);
      if (el && v.timestamp) el.dataset.timestamp = String(v.timestamp);
      state.chattedWith.add(uid);
    }
    sortUserList();
  });
  ls.push(() => off(lm));

    const msgs = ref(db, `chats/${cid}/messages`);
  onValue(msgs, snap => {
    const ms = snap.val();
    if (!ms) {
      const b = $(`ub-${uid}`);
      if (b) { b.style.display = 'none'; b.textContent = ''; }
      state.unreadCounts.set(uid, 0);
      return;
    }
    let un = 0;
    let updates = {};
    const now = Date.now();
    
    Object.entries(ms).forEach(([mid, m]) => {
      if (m.sender !== state.currentUser.uid) {
        if (m.status !== 'seen') un++;
        
        // Auto-update to Delivered or Seen in real-time
        if (m.status === 'sent') {
          if (state.chatPartnerId === uid) {
            updates[`${mid}/status`] = 'seen';
            updates[`${mid}/seenAt`] = now;
            un--; // Immediately remove from unread count
          } else {
            updates[`${mid}/status`] = 'delivered';
            updates[`${mid}/deliveredAt`] = now;
          }
        }
      }
    });
    
    // Push the status updates back to Firebase
    if (Object.keys(updates).length > 0) {
      update(msgs, updates).catch(()=>{});
    }

    const b = $(`ub-${uid}`);
    if (b) {
      if (un > 0 && state.chatPartnerId !== uid) {
        b.style.display = 'flex'; b.textContent = un > 99 ? '99+' : un;
      } else {
        b.style.display = 'none'; b.textContent = '';
      }
    }
    state.unreadCounts.set(uid, state.chatPartnerId === uid ? 0 : un);
  });

  ls.push(() => off(msgs));
  state.directoryListeners.set(uid, ls);
}

function triggerChat(uid, ds) {
  openChat(uid, ds.username || '', ds.skill || 'Explorer', ds.level || 'Beginner', ds.points || 0);
}

/* ═══════════════════════════════════════════════════
   DIRECTORY FILTERS
   ═══════════════════════════════════════════════════ */
const applyFilters = debounce(() => {
  const nq = $('search-users-input').value.toLowerCase();
  const sq = $('search-skill-input').value.toLowerCase();
  const oo = $('online-filter-toggle').checked;
  /* ── Read all filter criteria once, then write display in a single pass ── */
  const items = $$('.user-item');
  /* Batch all reads before any writes to avoid forced reflows */
  const visibility = new Array(items.length);
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const un = (it.dataset.username || '').toLowerCase();
    const us = (it.dataset.skill || '').toLowerCase();
    const ut = (it.dataset.tags || '').toLowerCase();
    visibility[i] = (un.includes(nq) && (us.includes(sq) || ut.includes(sq)) && (!oo || it.dataset.status === 'online'));
  }
  /* Write pass — no interleaved reads */
  for (let i = 0; i < items.length; i++) {
    items[i].style.display = visibility[i] ? 'flex' : 'none';
  }
  $$('.section-sep').forEach(sep => {
    let sib = sep.nextElementSibling, any = false;
    while (sib && !sib.classList.contains('section-sep')) { if (sib.style.display !== 'none') { any = true; break; } sib = sib.nextElementSibling; }
    sep.style.display = any ? 'flex' : 'none';
  });
}, CONFIG.DEBOUNCE_MS);

$('search-users-input').addEventListener('input', applyFilters);
$('search-skill-input').addEventListener('input', applyFilters);
$('online-filter-toggle').addEventListener('change', applyFilters);


/* ═══════════════════════════════════════════════════
   MASTER CLEANUP — call this on logout AND account deletion
   Stops ALL Firebase listeners and clears in-memory state
   ═══════════════════════════════════════════════════ */
/* ── Community Post screen: detach both Firebase listeners ── */
function cleanupCommPostListeners() {
  if (_commPostState && _commPostState.communityId && _commPostState.postId) {
    if (_commPostState.repliesListener) {
      off(ref(db, `communities/${_commPostState.communityId}/posts/${_commPostState.postId}/replies`));
      _commPostState.repliesListener = null;
    }
    if (_commPostState.postListener) {
      off(ref(db, `communities/${_commPostState.communityId}/posts/${_commPostState.postId}`));
      _commPostState.postListener = null;
    }
  }
}



// ── Export to window ──
Object.assign(window, {
  checkProfileBanner, openProfileModal,
  cleanupAllListeners, cleanupDirectoryListeners, cleanupCommPostListeners
});
