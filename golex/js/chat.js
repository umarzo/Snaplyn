const { state, $, $$, escHtml, linkify, timeAgo, formatTime, formatDate,
  formatFileSize, formatRecDuration, fileIcon, badgeHTML, generateAvatarUrl,
  generateChatId, debounce, seenTimeAgo, getExpiryInfo, formatRemainingTime,
  getExpiryClass, isAttachmentType, isAttachmentExpired,
  compressImage, fileToBase64, audioToBase64, downloadBase64, cleanupMessages,
  auth, db, ref, get, set, onValue, onChildAdded, push, serverTimestamp,
  onDisconnect, update, off, remove, limitToLast, endBefore,
  CONFIG, EPHEMERAL_CONFIG, cleanupTimestamps,
  Toast, ScreenManager, initScrollButton, cacheUser, getUserCached,
  openUserProfileSheet, buildVaultContent, GoProMedia, GOLEX_PRO } = window;

/* ═══════════════════════════════════════════════════
   CHAT: CLEANUP LISTENERS & MARK SEEN
   ═══════════════════════════════════════════════════ */
function cleanupChatListeners() {
  if (state.unsubMessages) { state.unsubMessages(); state.unsubMessages = null; }
  if (state.unsubTyping) { state.unsubTyping(); state.unsubTyping = null; }
  if (state.unsubPartnerData) { state.unsubPartnerData(); state.unsubPartnerData = null; }
  if (state.unsubPinned) { state.unsubPinned(); state.unsubPinned = null; }
  if (state.chatId && state.currentUser) set(ref(db, `chats/${state.chatId}/typing/${state.currentUser.uid}`), false).catch(() => {});
  stopRecordingCleanup();
  closeUserInfoPanel();
}

async function markAllMessagesSeen(chatId, myUid) {
  try {
    const snap = await get(ref(db, `chats/${chatId}/messages`));
    if (!snap.exists()) return;
    const msgs = snap.val();
    const updates = {};
    const now = Date.now();
    Object.entries(msgs).forEach(([mid, m]) => {
      if (m.sender !== myUid && m.status !== 'seen') {
        updates[`${mid}/status`] = 'seen';
        updates[`${mid}/seenAt`] = now;
      }
    });
    if (Object.keys(updates).length > 0) {
      await update(ref(db, `chats/${chatId}/messages`), updates);
    }
  } catch (e) { DEBUG && console.warn('[MarkSeen]', e); }
}

/* ═══════════════════════════════════════════════════
   CHAT: OPEN CHAT
   ═══════════════════════════════════════════════════ */
function openChat(pUid, pUser, pSkill, pLevel, pPoints) {
  cleanupChatListeners();
  state.isSending = false; state.isUploading = false;
  state.chatPartnerId = pUid; state.chatPartnerUsername = pUser;
  state.chatId = generateChatId(state.currentUser.uid, pUid);
  state.renderedMsgIds = new Set();
  state.lastVisibleSentStatusMid = null;
  state.currentPinnedMid = null;

  /* ── Seed participants node (security: access is validated
        against this node in Firebase rules, not the fragile
        chatId.contains() string check) ── */
  const myUid = state.currentUser.uid;
  set(ref(db, `chats/${state.chatId}/participants/${myUid}`), true).catch(() => {});

  const badge = $(`ub-${pUid}`);
  if (badge) { badge.style.display = 'none'; badge.textContent = ''; }
  state.unreadCounts.set(pUid, 0);
  markAllMessagesSeen(state.chatId, state.currentUser.uid);

  $('chat-partner-name').innerHTML = `@${escHtml(pUser)} ${badgeHTML(pSkill, pLevel, pPoints)}`;

  const partnerData = getUserCached(pUid);
  const partnerAvEl = $('chat-partner-avatar');
  if (partnerData && partnerData.pfpUrl) {
    partnerAvEl.innerHTML = `<img src="${escHtml(partnerData.pfpUrl)}" alt="${escHtml(pUser)}">`;
  } else {
    partnerAvEl.innerHTML = ''; partnerAvEl.textContent = initials(pUser);
  }

  $('msgs-wrap').innerHTML = `
    <div class="skel-msgs-wrap" id="chat-skel-msgs">
      <div class="skel-msg-row">
        <div class="skel skel-circle" style="width:28px;height:28px;flex-shrink:0;"></div>
        <div class="skel skel-msg-bubble medium"></div>
      </div>
      <div class="skel-msg-row right">
        <div class="skel skel-msg-bubble short"></div>
      </div>
      <div class="skel-msg-row">
        <div class="skel skel-circle" style="width:28px;height:28px;flex-shrink:0;"></div>
        <div class="skel skel-msg-bubble long"></div>
      </div>
      <div class="skel-msg-row right">
        <div class="skel skel-msg-bubble medium"></div>
      </div>
      <div class="skel-msg-row">
        <div class="skel skel-circle" style="width:28px;height:28px;flex-shrink:0;"></div>
        <div class="skel skel-msg-bubble short"></div>
      </div>
    </div>`;
  $('starters').style.display = 'none';
  $('typing-dots').style.display = 'none';
  $('typing-label').style.display = 'none';
  $('message-input').value = '';
  $('pin-bar').style.display = 'none';
  $('chat-search-bar').style.display = 'none';
  $('send-btn').disabled = true;
  const cs = $('cleanup-status'); if (cs) cs.classList.remove('visible');
  cancelReply(); cancelEdit(); cancelPendingFile(); closeAttachMenu(); closeUserInfoPanel(); updateSendBtn();
  ScreenManager.show('chat-screen');
const ces = document.getElementById('chat-empty-state'); if (ces) ces.classList.remove('visible');
  performLazyCleanup(state.chatId).catch(() => {});

  const pinnedRef = ref(db, `chats/${state.chatId}/pinned`);
  state.unsubPinned = onValue(pinnedRef, async snap => {
    if (snap.exists()) {
      const pinData = snap.val();
      state.currentPinnedMid = pinData.mid;
      try {
        const msgSnap = await get(ref(db, `chats/${state.chatId}/messages/${pinData.mid}`));
        if (msgSnap.exists()) {
          showPinBar(pinData);
        } else {
          await remove(pinnedRef);
          $('pin-bar').style.display = 'none';
          state.currentPinnedMid = null;
        }
      } catch (e) {
        showPinBar(pinData);
      }
    } else {
      $('pin-bar').style.display = 'none';
      state.currentPinnedMid = null;
    }
  });

  state.unsubPartnerData = onValue(ref(db, `users/${pUid}`), snap => {
    const d = snap.val(); if (!d) return;

    const online = isUserTrulyOnline(d);
    if (online) {
      $('chat-status-pip').className = 'status-pip online';
      $('chat-partner-status').textContent = '● Active now';
      $('chat-partner-status').className = 'chat-partner-status online';
    } else {
      $('chat-status-pip').className = 'status-pip';
      $('chat-partner-status').textContent = 'Last seen ' + timeAgo(d.lastSeen);
      $('chat-partner-status').className = 'chat-partner-status offline';
    }

    const avEl = $('chat-partner-avatar');
    if (d.pfpUrl) {
      const existingImg = avEl.querySelector('img');
      if (!existingImg || existingImg.src !== d.pfpUrl) {
        avEl.innerHTML = `<img src="${escHtml(d.pfpUrl)}" alt="${escHtml(d.username)}">`;
      }
    } else {
      if (avEl.querySelector('img')) { avEl.innerHTML = ''; avEl.textContent = initials(d.username); }
    }

    const infoAvEl = $('info-panel-avatar');
    if (d.pfpUrl) {
      const existingImg = infoAvEl.querySelector('img');
      if (!existingImg || existingImg.src !== d.pfpUrl) {
        infoAvEl.innerHTML = `<img src="${escHtml(d.pfpUrl)}" alt="${escHtml(d.username)}">`;
      }
    } else {
      if (infoAvEl.querySelector('img')) { infoAvEl.innerHTML = ''; }
      infoAvEl.textContent = initials(d.username);
    }

    $('info-panel-username').textContent = '@' + (d.username || '');
    $('info-panel-rep').textContent = d.points || 0;
    $('info-panel-level').textContent = d.level || 'Beginner';
    $('info-panel-skill').textContent = d.skill || 'Explorer';
    $('info-panel-bio').textContent = d.bio || 'No bio provided';

    // Render expertise display safely — isolated, no side effects
    if (typeof ExpertiseModule !== 'undefined' && ExpertiseModule.renderInPanel) {
      try { ExpertiseModule.renderInPanel('info-panel-expertise-display', d.expertise || null); } catch(e) {}
    }
    if (typeof SocialIntegrationsModule !== 'undefined' && SocialIntegrationsModule.renderInPanel) {
      try { SocialIntegrationsModule.renderInPanel('info-panel-social-display', d.socialIntegrations || null); } catch(e) {}
    }

    // Load endorsement count + button state for this partner
    loadEndorsements(pUid, d.skill || 'Explorer');
  });

  onValue(ref(db, `chats/${state.chatId}/messages`), snap => {
    $('info-panel-chats').textContent = snap.exists() ? Object.keys(snap.val()).length : '0';
  });


  const msgsRef = ref(db, `chats/${state.chatId}/messages`);
  // Fix #2: limitToLast(50) — pagination prevents loading entire chat history
  const msgsQuery = query(msgsRef, orderByKey(), limitToLast(50));
  state.dmEarliestKey = null;
  state.dmAllLoaded = false;
  let initialLoad = true;

  function renderDMBatch(msgs, wrap, prepend) {
    const entries = Object.entries(msgs).sort((a, b) => (a[1].timestamp || 0) - (b[1].timestamp || 0));
    const seenUpdates = {};
    const now = Date.now();
    let prevDate = '';
    const anchorNode = prepend ? wrap.querySelector('.date-sep, .msg') : null;

    /* ── Batch new nodes into a fragment — single reflow instead of N ── */
    const frag = document.createDocumentFragment();
    entries.forEach(([mid, m]) => {
      const ds = formatDate(m.timestamp), isMe = m.sender === state.currentUser.uid;
      if (!state.renderedMsgIds.has(mid)) {
        if (ds && ds !== prevDate) {
          const sid = `sep-${ds.replace(/\s+/g, '-')}`;
          if (!document.getElementById(sid)) {
            const sep = document.createElement('div'); sep.className = 'date-sep'; sep.textContent = ds; sep.id = sid;
            frag.appendChild(sep);
          }
        }
        const msgEl = buildMessageElement(mid, m, isMe);
        frag.appendChild(msgEl);
        state.renderedMsgIds.add(mid);
      } else {
        updateExistingMessage(mid, m, isMe);
      }
      if (ds) prevDate = ds;
      if (!isMe && m.status !== 'seen') {
        seenUpdates[`${mid}/status`] = 'seen';
        seenUpdates[`${mid}/seenAt`] = now;
      }
    });
    /* One DOM write — avoids layout thrash per message */
    if (prepend && anchorNode) wrap.insertBefore(frag, anchorNode);
    else wrap.appendChild(frag);
    return { entries, seenUpdates };
  }

  function syncLatestSentStatus(entries) {
    let latestSentMessageId = null;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i][1]?.sender === state.currentUser.uid) { latestSentMessageId = entries[i][0]; break; }
    }
    if (state.lastVisibleSentStatusMid && state.lastVisibleSentStatusMid !== latestSentMessageId) {
      const prev = document.getElementById(`msg-${state.lastVisibleSentStatusMid}`)?.querySelector('.status-text');
      if (prev) prev.style.display = 'none';
    }
    if (latestSentMessageId) {
      const curr = document.getElementById(`msg-${latestSentMessageId}`)?.querySelector('.status-text');
      if (curr) curr.style.display = 'inline';
    }
    state.lastVisibleSentStatusMid = latestSentMessageId;
  }

  function ensureLoadEarlierBtn(wrap) {
    if (document.getElementById('dm-load-earlier-btn') || state.dmAllLoaded) return;
    const btn = document.createElement('button');
    btn.id = 'dm-load-earlier-btn';
    btn.className = 'dm-load-earlier-btn';
    btn.textContent = '⬆ Load earlier messages';
    btn.addEventListener('click', async () => {
      if (!state.dmEarliestKey || state.dmAllLoaded) return;
      btn.textContent = 'Loading...'; btn.disabled = true;
      try {
        const olderSnap = await get(query(msgsRef, orderByKey(), limitToLast(50), endBefore(state.dmEarliestKey)));
        if (!olderSnap.exists()) { state.dmAllLoaded = true; btn.remove(); return; }
        const oldMsgs = olderSnap.val();
        const oldKeys = Object.keys(oldMsgs).sort();
        state.dmEarliestKey = oldKeys[0];
        const prevH = wrap.scrollHeight;
        renderDMBatch(oldMsgs, wrap, true);
        requestAnimationFrame(() => { requestAnimationFrame(() => { wrap.scrollTop = wrap.scrollHeight - prevH; }); });
        if (oldKeys.length < 50) { state.dmAllLoaded = true; btn.remove(); }
        else { btn.textContent = '⬆ Load earlier messages'; btn.disabled = false; }
      } catch(e) { btn.textContent = '⬆ Load earlier messages'; btn.disabled = false; }
    });
    wrap.insertBefore(btn, wrap.firstChild);
  }

  state.unsubMessages = onValue(msgsQuery, snap => {
    const msgs = snap.val(); const wrap = $('msgs-wrap'); if (!wrap) return;
    // Remove skeleton on first data arrive
    const skelMsgs = document.getElementById('chat-skel-msgs');
    if (skelMsgs) skelMsgs.remove();
    const wasAtBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < CONFIG.SCROLL_THRESHOLD;
    if (!msgs) { wrap.innerHTML = ''; state.renderedMsgIds = new Set(); state.lastVisibleSentStatusMid = null; $('starters').style.display = 'flex'; initialLoad = false; return; }
    $('starters').style.display = 'none';

    // Track earliest key for pagination
    const keys = Object.keys(msgs).sort();
    if (!state.dmEarliestKey || keys[0] < state.dmEarliestKey) state.dmEarliestKey = keys[0];

    // Remove deleted messages
    const currentIds = new Set(keys);
    for (const mid of state.renderedMsgIds) {
      if (!currentIds.has(mid)) { const e = document.getElementById(`msg-${mid}`); if (e) e.remove(); state.renderedMsgIds.delete(mid); }
    }

    const { entries, seenUpdates } = renderDMBatch(msgs, wrap, false);

    if (initialLoad || wasAtBottom) requestAnimationFrame(() => { requestAnimationFrame(() => { wrap.scrollTop = wrap.scrollHeight; }); });
    if (initialLoad && entries.length >= 50) ensureLoadEarlierBtn(wrap);
    initialLoad = false;

    syncLatestSentStatus(entries);

    if (Object.keys(seenUpdates).length > 0) {
      update(msgsRef, seenUpdates).then(() => {
        const b = $(`ub-${state.chatPartnerId}`);
        if (b) { b.style.display = 'none'; b.textContent = ''; }
        state.unreadCounts.set(state.chatPartnerId, 0);
      }).catch(() => {});
    }
  });

  state.unsubTyping = onValue(ref(db, `chats/${state.chatId}/typing/${pUid}`), snap => {
    const ty = snap.val() === true;
    $('typing-dots').style.display = ty ? 'inline-flex' : 'none';
    $('typing-label').style.display = ty ? 'inline' : 'none';
    if (ty) {
      $('typing-label').textContent = `@${pUser} typing...`;
      const w = $('msgs-wrap');
      if (w && w.scrollHeight - w.scrollTop - w.clientHeight < CONFIG.SCROLL_THRESHOLD)
        requestAnimationFrame(() => { requestAnimationFrame(() => { w.scrollTop = w.scrollHeight; }); });
    }
  });
// Enforce block state on chat input
  BlockSystem.enforceChatBlock(pUid);
  setTimeout(() => $('message-input').focus(), 300);
}

/* ═══════════════════════════════════════════════════
   CHAT INFO ICON → QUICK-ACTIONS PANEL
   ═══════════════════════════════════════════════════ */
$('chat-info-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleInfoQuickPanel();
});
// Voice Call button
document.getElementById('voice-call-btn')?.addEventListener('click', () => {
  startCall();
});

// End Call button (inside overlay)
document.getElementById('call-end-btn')?.addEventListener('click', () => {
  endCall();
});

// Keep old info panel close wired but it's now hidden; close quick panel on ESC
$('info-panel-close').addEventListener('click', closeUserInfoPanel);

function toggleInfoQuickPanel() {
  const panel = document.getElementById('info-quick-panel');
  if (!panel) return;
  const isOpen = panel.classList.contains('open');
  if (isOpen) { panel.classList.remove('open'); return; }
  // Update block label
  if (state.chatPartnerId) {
    BlockSystem.isBlocked(state.chatPartnerId).then(blocked => {
      const lbl = document.getElementById('iqp-block-label');
      if (lbl) lbl.textContent = blocked ? 'Unblock User' : 'Block User';
    });
  }
  panel.classList.add('open');
}

function closeInfoQuickPanel() {
  const panel = document.getElementById('info-quick-panel');
  if (panel) panel.classList.remove('open');
}

// Wire quick panel buttons
document.getElementById('iqp-endorse')?.addEventListener('click', () => {
  closeInfoQuickPanel();
  if (!state.chatPartnerId) return;
  const ud = state.usersCache?.get(state.chatPartnerId);
  const skill = ud?.skill || state.chatPartnerSkill || 'Explorer';
  loadEndorsements(state.chatPartnerId, skill);
  // Open full profile to show endorse
  _openChatPartnerFullProfile();
});

document.getElementById('iqp-copy-link')?.addEventListener('click', () => {
  closeInfoQuickPanel();
  const uid = state.chatPartnerId;
  if (!uid) return;
  const link = `${window.location.origin}${window.location.pathname}?uid=${uid}`;
  navigator.clipboard.writeText(link).then(() => Toast.success('Profile link copied!')).catch(() => {
    const ta = document.createElement('textarea'); ta.value = link;
    ta.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(ta);
    ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
    Toast.success('Profile link copied!');
  });
});

document.getElementById('iqp-report')?.addEventListener('click', () => {
  closeInfoQuickPanel();
  if (!state.chatPartnerId || !state.chatPartnerUsername) return;
  openReportModal({ targetUid: state.chatPartnerId, targetUsername: state.chatPartnerUsername, targetType: 'user', contentPreview: '' });
});

document.getElementById('iqp-block')?.addEventListener('click', async () => {
  closeInfoQuickPanel();
  const uid = state.chatPartnerId;
  if (!uid) return;
  const lbl = document.getElementById('iqp-block-label');
  const alreadyBlocked = await BlockSystem.isBlocked(uid);
  if (alreadyBlocked) {
    const ok = await ConfirmModal.show({ icon: 'lock-open', title: `Unblock @${state.chatPartnerUsername}?`, sub: 'You will be able to message each other again.', confirmText: 'Unblock', cancelText: 'Cancel', danger: false });
    if (!ok) return;
    await BlockSystem.unblock(uid); if (lbl) lbl.textContent = 'Block User'; Toast.info('User unblocked');
    BlockSystem.enforceChatBlock(uid);
    const card = document.getElementById('u-' + uid); if (card) card.style.display = '';
  } else {
    const ok = await ConfirmModal.show({ icon: 'ban', title: `Block @${state.chatPartnerUsername}?`, sub: "You won't be able to message each other.", confirmText: 'Block', cancelText: 'Cancel', danger: true });
    if (!ok) return;
    await BlockSystem.block(uid); if (lbl) lbl.textContent = 'Unblock User'; Toast.info('User blocked');
    BlockSystem.enforceChatBlock(uid);
    const card = document.getElementById('u-' + uid); if (card) card.style.display = 'none';
  }
  lucideCreate();

});

// Close quick panel when clicking elsewhere
document.addEventListener('click', (e) => {
  const panel = document.getElementById('info-quick-panel');
  const btn = document.getElementById('chat-info-btn');
  if (panel && !panel.contains(e.target) && e.target !== btn && !btn?.contains(e.target)) {
    panel.classList.remove('open');
  }
});

// Helper: open chat partner's full profile sheet
function _openChatPartnerFullProfile() {
  if (!state.chatPartnerId) return;
  const uid = state.chatPartnerId;
  const username = state.chatPartnerUsername || '';
  const cached = state.usersCache?.get(uid) || {};
  openUserProfileSheet(
    uid, username,
    cached.skill || state.chatPartnerSkill || 'Explorer',
    cached.level || 'Beginner',
    cached.points || 0,
    cached.pfpUrl || '',
    cached.bio || '',
    cached.expertise || null,
    cached.socialIntegrations || null
  );
}

// Wire chat partner avatar + name → full profile
document.getElementById('chat-partner-avatar')?.addEventListener('click', _openChatPartnerFullProfile);
document.getElementById('chat-partner-name')?.addEventListener('click', _openChatPartnerFullProfile);
document.querySelector('.user-avatar-wrap')?.addEventListener('click', _openChatPartnerFullProfile);

function toggleUserInfoPanel() {
  // Legacy: now just opens quick panel
  toggleInfoQuickPanel();
}

function closeUserInfoPanel() {
  closeInfoQuickPanel();
  const panel = $('user-info-panel');
  if (!panel || !panel.classList.contains('open')) return;
  panel.classList.add('closing');
  setTimeout(() => { panel.classList.remove('open', 'closing'); }, 250);
}

/* ═══════════════════════════════════════════════════
   MESSAGE BUILDING (identical to original with fixes)
   ═══════════════════════════════════════════════════ */
function buildMessageElement(mid, m, isMe) {
  const w = document.createElement('div'); w.className = `msg ${isMe ? 'sent' : 'received'}`; w.id = `msg-${mid}`;
  if (m.replyTo) {
    const ctx = document.createElement('div'); ctx.className = 'msg-reply-ctx';
    ctx.textContent = `↩ ${(m.replyToText || '').slice(0, 60)}`;
    ctx.addEventListener('click', () => scrollToMessage(m.replyTo)); w.appendChild(ctx);
  }
  const b = document.createElement('div'); b.className = 'msg-bubble' + (m.edited ? ' edited' : '');
  if (isAttachmentType(m.type) && isAttachmentExpired(m)) { b.style.padding = '4px'; b.appendChild(buildExpiredPlaceholder(m)); }
  else if (m.type === 'vault') { b.style.padding = '4px'; b.appendChild(buildVaultContent(mid, m, isMe)); }
  else if (m.type === 'image' && (m.dataUrl || m.url)) { b.style.padding = '4px'; b.appendChild(buildImageContent(m)); }
  else if (m.type === 'file' && (m.dataUrl || m.url)) { b.style.padding = '4px'; b.appendChild(buildFileContent(m)); }
  else if (m.type === 'audio' && (m.dataUrl || m.url)) { b.style.padding = '4px'; b.appendChild(buildAudioContent(m.dataUrl || m.url, m.duration, isMe)); }
  else { b.innerHTML = linkify(m.text || ''); }

  if (!(isAttachmentType(m.type) && isAttachmentExpired(m))) {
    b.appendChild(buildMessageActions(mid, m, isMe));
  } else if (isMe) {
    const a = document.createElement('div'); a.className = 'msg-actions';
    a.appendChild(createActionBtn('<i data-lucide="trash-2" class="lucide" width="16" height="16"></i>', () => deleteMessage(mid))); b.appendChild(a);
  }
  b.appendChild(buildMessageMeta(m, isMe)); // <-- We moved it inside the bubble (b)
  w.appendChild(b);
  if (m.reactions && Object.keys(m.reactions).length > 0) w.appendChild(buildReactionRow(mid, m.reactions));
  return w;
}


function buildExpiredPlaceholder(m) {
  const ph = document.createElement('div'); ph.className = 'msg-expired-placeholder';
  const labels = { image: 'Image Expired', file: 'File Expired', audio: 'Voice Note Expired' };
  const subs = { image: 'Images expire after 24h', file: 'Files expire after 48h', audio: 'Voice notes expire after 12h' };
  ph.innerHTML = `<span class="expired-icon"><i data-lucide="hourglass" class="lucide" width="16" height="16"></i></span><div class="expired-text"><div class="expired-label">${labels[m.type] || 'Attachment Expired'}</div><div class="expired-sub">${subs[m.type] || 'This attachment has expired'}</div></div>`;
  return ph;
}

function buildImageContent(m) {
  const src = m.dataUrl || m.url;
  const iw = document.createElement('div'); iw.className = 'msg-img-wrap';
  const img = document.createElement('img'); img.className = 'msg-img'; img.alt = 'Shared image'; img.loading = 'lazy'; img.src = src;
  const ov = document.createElement('div'); ov.className = 'msg-img-overlay'; ov.innerHTML = '<span><i data-lucide="zoom-in" class="lucide" width="16" height="16"></i></span>';
  iw.appendChild(img); iw.appendChild(ov);
  iw.addEventListener('click', e => { e.stopPropagation(); openLightbox(src, m.fileName || 'image.jpg'); });
  return iw;
}

function buildFileContent(m) {
  const src = m.dataUrl || m.url;
  const fb = document.createElement('div'); fb.className = 'msg-file-bubble';
  fb.innerHTML = `<span class="msg-file-icon">${fileIcon(m.fileName)}</span><div class="msg-file-info"><div class="msg-file-name">${escHtml(m.fileName || 'File')}</div><div class="msg-file-meta"><span>${escHtml(m.fileSize || '')}</span><span class="msg-file-dl">⬇ Download</span></div></div>`;
  fb.querySelector('.msg-file-dl').addEventListener('click', e => { e.stopPropagation(); downloadBase64(src, m.fileName || 'file'); });
  return fb;
}

function buildAudioContent(url, dur, isMe) {
  const c = document.createElement('div'); c.className = 'msg-audio';
  const pb = document.createElement('button'); pb.className = 'audio-play-btn'; pb.innerHTML = '▶';
  const info = document.createElement('div'); info.className = 'audio-info';
  const wave = document.createElement('div'); wave.className = 'audio-wave';
  const N = 20, bars = [];
  for (let i = 0; i < N; i++) {
    const b = document.createElement('div'); b.className = 'audio-wave-bar';
    b.style.height = (6 + Math.random() * 16) + 'px';
    b.style.background = isMe ? 'rgba(255,255,255,0.35)' : 'rgba(35, 87, 232, 0.45)';
    wave.appendChild(b); bars.push(b);
  }
  const du = document.createElement('div'); du.className = 'audio-duration'; du.textContent = dur || 'Voice note';
  info.appendChild(wave); info.appendChild(du); c.appendChild(pb); c.appendChild(info);
  const au = new Audio(); au.preload = 'metadata';
  let playing = false, pi = null, loaded = false;
  const upd = () => {
    if (!au.duration || isNaN(au.duration)) return;
    const pct = au.currentTime / au.duration, lit = Math.floor(pct * N);
    bars.forEach((b, i) => { b.style.background = i < lit ? (isMe ? 'rgba(255,255,255,0.9)' : 'rgba(35, 87, 232, 1)') : (isMe ? 'rgba(255,255,255,0.25)' : 'rgba(35, 87, 232, 0.3)'); });
    const rem = au.duration - au.currentTime;
    du.textContent = `${Math.floor(rem / 60)}:${Math.floor(rem % 60).toString().padStart(2, '0')}`;
  };
  const stop = () => { playing = false; pb.className = 'audio-play-btn'; pb.innerHTML = '▶'; clearInterval(pi); };
  pb.addEventListener('click', e => {
    e.stopPropagation();
    if (!loaded) { au.src = url; loaded = true; }
    if (!playing) {
      $$('.audio-play-btn.playing').forEach(b => { if (b !== pb) b.click(); });
      au.play().then(() => { playing = true; pb.className = 'audio-play-btn playing'; pb.innerHTML = '<i data-lucide="pause" class="lucide" width="16" height="16"></i>'; pi = setInterval(upd, 150); }).catch(() => Toast.error('Cannot play audio'));
    } else { au.pause(); stop(); }
  });
  au.addEventListener('ended', () => { stop(); bars.forEach(b => { b.style.background = isMe ? 'rgba(255,255,255,0.25)' : 'rgba(35, 87, 232, 0.3)'; }); du.textContent = dur || 'Voice note'; });
  au.addEventListener('error', () => { stop(); du.textContent = 'Error'; });
  return c;
}

function buildMessageActions(mid, m, isMe) {
  const a = document.createElement('div'); a.className = 'msg-actions';
  const rb = createActionBtn('<i data-lucide="smile" class="lucide" width="16" height="16"></i>', () => openReactionPicker(mid, rb));
  a.appendChild(rb);
  a.appendChild(createActionBtn('↩', () => {
    state.replyToMsgId = mid; state.replyToText = m.text || 'Attachment';
    $('reply-preview').style.display = 'flex'; $('reply-preview-text').textContent = state.replyToText;
    $('message-input').focus();
  }));
  if (isMe) {
    if (!m.type || m.type === 'text') a.appendChild(createActionBtn('<i data-lucide="pencil" class="lucide" width="16" height="16"></i>', () => {
      state.editingMsgId = mid; $('message-input').value = m.text || '';
      $('edit-bar').style.display = 'flex'; updateSendBtn(); $('message-input').focus();
    }));
    a.appendChild(createActionBtn('<i data-lucide="pin" class="lucide" width="16" height="16"></i>', () => pinMessage(mid, m)));
    a.appendChild(createActionBtn('<i data-lucide="trash-2" class="lucide" width="16" height="16"></i>', () => deleteMessage(mid)));
  } else {
    // Report button — only on received messages
    a.appendChild(createActionBtn('<i data-lucide="flag" class="lucide" width="16" height="16"></i>', () => {
      openReportModal({
        targetUid: state.chatPartnerId || '',
        targetUsername: state.chatPartnerUsername || '',
        targetType: 'chat_message',
        chatId: state.chatId || '',
        messageId: mid,
        messageContentPreview: (m.text || '').slice(0, 120),
        contentPreview: (m.text || '').slice(0, 120)
      });
    }));
    a.appendChild(createActionBtn('<i data-lucide="pin" class="lucide" width="16" height="16"></i>', () => pinMessage(mid, m)));
  }
  // Render Lucide icons inside the newly created action buttons
  requestAnimationFrame(() => { if (typeof lucideCreate === 'function') lucideCreate(); });
  return a;
}

function createActionBtn(e, h) {
  const b = document.createElement('button'); b.className = 'msg-action-btn'; b.innerHTML = e;
  b.addEventListener('click', ev => { ev.stopPropagation(); h(); }); return b;
}

function buildMessageMeta(m, isMe) {
  const meta = document.createElement('div'); meta.className = 'msg-meta';
  const t = formatTime(m.timestamp);
  if (isMe) {
    if (m.status === 'seen') {
      meta.innerHTML = `<span>${t}</span><span class="msg-seen">✓✓ <span class="status-text">${escHtml(seenTimeAgo(m.seenAt))}</span></span>`;
    } else if (m.status === 'delivered') {
      meta.innerHTML = `<span>${t}</span><span class="msg-seen">✓✓ <span class="status-text">Delivered</span></span>`;
    } else {
      meta.innerHTML = `<span>${t}</span><span class="msg-seen">✓ <span class="status-text">Sent</span></span>`;
    }
  } else {
    meta.innerHTML = `<span>${t}</span>`;
  }


  const type = m.type || 'text';
  if (isAttachmentType(type) && !isAttachmentExpired(m) && m.timestamp) {
    const exp = getExpiryInfo(m);
    if (!exp.expired) {
      const badge = document.createElement('span');
      badge.className = `msg-expiry-badge ${getExpiryClass(exp.pctRemaining)}`;
      badge.title = `This ${type} expires in ${formatRemainingTime(exp.remainingMs)}`;
      badge.innerHTML = `<i data-lucide="hourglass" class="lucide" width="10" height="10"></i> ${formatRemainingTime(exp.remainingMs)}`;
      meta.appendChild(badge);
    }
  }
  return meta;
}

function updateExistingMessage(mid, m, isMe) {
  const el = document.getElementById(`msg-${mid}`); if (!el) return;
  if (isAttachmentType(m.type) && isAttachmentExpired(m) && !el.querySelector('.msg-expired-placeholder')) {
    el.replaceWith(buildMessageElement(mid, m, isMe)); return;
  }
  const bubble = el.querySelector('.msg-bubble');
  if (bubble && m.edited) {
    bubble.classList.add('edited');
    if ((!m.type || m.type === 'text') && m.text) {
      const act = bubble.querySelector('.msg-actions');
      if (act) { bubble.innerHTML = linkify(m.text); bubble.appendChild(act); }
    }
  }
  const er = el.querySelector('.msg-reactions');
  if (m.reactions && Object.keys(m.reactions).length > 0) {
    const nr = buildReactionRow(mid, m.reactions);
    if (er) er.replaceWith(nr); else el.appendChild(nr);
  } else if (er) er.remove();
  const om = el.querySelector('.msg-meta');
  if (om) om.replaceWith(buildMessageMeta(m, isMe));
}

function scrollToMessage(mid) {
  const t = document.getElementById(`msg-${mid}`);
  if (t) { t.scrollIntoView({ behavior: 'smooth', block: 'center' }); t.classList.add('msg-highlight'); setTimeout(() => t.classList.remove('msg-highlight'), 2000); }
}

/* ═══════════════════════════════════════════════════
   REACTIONS (unchanged)
   ═══════════════════════════════════════════════════ */
function buildReactionRow(mid, reactions) {
  const row = document.createElement('div'); row.className = 'msg-reactions';
  const counts = {}, mine = new Set();
  Object.entries(reactions).forEach(([uid, emoji]) => { counts[emoji] = (counts[emoji] || 0) + 1; if (uid === state.currentUser.uid) mine.add(emoji); });
  Object.entries(counts).forEach(([emoji, count]) => {
    const chip = document.createElement('div'); chip.className = 'reaction-chip' + (mine.has(emoji) ? ' mine' : '');
    chip.innerHTML = `${emoji}<span class="rc-count">${count}</span>`;
    chip.addEventListener('click', () => toggleReaction(mid, emoji)); row.appendChild(chip);
  });
  return row;
}

function openReactionPicker(mid, anchor) {
  state.reactionPickerTarget = mid;
  const p = $('reaction-picker');
  const rect = anchor.getBoundingClientRect(), appRect = $('app').getBoundingClientRect();
  p.style.top = Math.max(8, rect.top - appRect.top - 52) + 'px';
  p.style.left = Math.max(4, Math.min(appRect.width - 220, rect.left - appRect.left - 40)) + 'px';
  p.classList.add('open');
}

$('reaction-picker').querySelectorAll('span').forEach(s => {
  s.addEventListener('click', () => {
    if (state.reactionPickerTarget) toggleReaction(state.reactionPickerTarget, s.dataset.emoji || s.textContent.trim());
    $('reaction-picker').classList.remove('open'); state.reactionPickerTarget = null;
  });
});

async function toggleReaction(mid, emoji) {
  if (!state.chatId || !state.currentUser) return;
  const rRef = ref(db, `chats/${state.chatId}/messages/${mid}/reactions/${state.currentUser.uid}`);
  try { const snap = await get(rRef); if (snap.exists() && snap.val() === emoji) await remove(rRef); else await set(rRef, emoji); }
  catch (e) { Toast.error('Reaction failed'); }
}

/* ═══════════════════════════════════════════════════
   MESSAGE ACTIONS: DELETE, PIN, UNPIN, REPLY, EDIT
   ═══════════════════════════════════════════════════ */
async function deleteMessage(mid) {
  if (!state.chatId) return;
  const confirmed = await ConfirmModal.show({
    icon: 'trash-2', title: 'Delete message?',
    sub: 'This message will be removed for both you and the other person.',
    confirmText: 'Delete', cancelText: 'Cancel', danger: true
  });
  if (!confirmed) return;
  try {
    await remove(ref(db, `chats/${state.chatId}/messages/${mid}`));
    if (state.currentPinnedMid === mid) {
      await remove(ref(db, `chats/${state.chatId}/pinned`));
      $('pin-bar').style.display = 'none';
      state.currentPinnedMid = null;
    }
    Toast.info('Deleted');
  } catch (e) { Toast.error('Delete failed'); }
}

async function pinMessage(mid, m) {
  if (!state.chatId) return;
  try {
    await set(ref(db, `chats/${state.chatId}/pinned`), { mid, text: m.text || 'Attachment', by: state.currentUser.uid });
    Toast.info('Pinned');
  } catch (e) { Toast.error('Pin failed'); }
}

async function unpinMessage() {
  if (!state.chatId) return;
  try {
    await remove(ref(db, `chats/${state.chatId}/pinned`));
    $('pin-bar').style.display = 'none';
    state.currentPinnedMid = null;
    Toast.info('Unpinned');
  } catch (e) { Toast.error('Unpin failed'); }
}

function showPinBar(p) {
  $('pin-bar').style.display = 'flex';
  $('pin-bar-text').textContent = p.text;
  state.currentPinnedMid = p.mid;
}

$('pin-bar').addEventListener('click', (e) => {
  if (e.target.id === 'unpin-btn' || e.target.closest('#unpin-btn')) return;
  if (state.currentPinnedMid) scrollToMessage(state.currentPinnedMid);
});

$('unpin-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  unpinMessage();
});

function cancelReply() { state.replyToMsgId = null; state.replyToText = ''; $('reply-preview').style.display = 'none'; }
function cancelEdit() { state.editingMsgId = null; $('edit-bar').style.display = 'none'; $('message-input').value = ''; updateSendBtn(); }
$('reply-cancel').addEventListener('click', cancelReply);
$('edit-cancel').addEventListener('click', cancelEdit);

function updateSendBtn() {
  $('send-btn').disabled = !($('message-input').value.trim().length > 0 || state.pendingFile || state.editingMsgId);
}
$('message-input').addEventListener('input', updateSendBtn);

$('message-input').addEventListener('input', () => {
  if (!state.chatId || !state.currentUser) return;
  set(ref(db, `chats/${state.chatId}/typing/${state.currentUser.uid}`), true).catch(() => {});
  clearTimeout(state.typingTimeout);
  state.typingTimeout = setTimeout(() => set(ref(db, `chats/${state.chatId}/typing/${state.currentUser.uid}`), false).catch(() => {}), CONFIG.TYPING_TIMEOUT);
});

/* ═══════════════════════════════════════════════════
   SEND MESSAGES (unchanged)
   ═══════════════════════════════════════════════════ */
async function sendTextMessage(text) {
  if (state.isSending) return;
  text = (text || '').trim(); if (!text && !state.editingMsgId) return;
  if (!state.chatId || !state.currentUser) return;
  if (state.isMuted) { Toast.error('You are muted and cannot send messages.'); return; }
  state.isSending = true; $('send-btn').disabled = true;
  clearTimeout(state.typingTimeout);
  set(ref(db, `chats/${state.chatId}/typing/${state.currentUser.uid}`), false).catch(() => {});

  // ── Optimistic UI: clear input immediately, restore on failure ──
  const input = $('message-input');
  const savedText = input.value;
  input.value = '';
  updateSendBtn();

  try {
    if (state.editingMsgId) {
      await update(ref(db, `chats/${state.chatId}/messages/${state.editingMsgId}`), { text, edited: true });
      cancelEdit(); Toast.success('Message edited');
    } else {
      const msgData = { sender: state.currentUser.uid, text, status: 'sent', timestamp: serverTimestamp(), type: 'text' };
      if (state.replyToMsgId) { msgData.replyTo = state.replyToMsgId; msgData.replyToText = state.replyToText; cancelReply(); }
      await push(ref(db, `chats/${state.chatId}/messages`), msgData);
      // Fire-and-forget: lastMessage and points are non-critical
      set(ref(db, `chats/${state.chatId}/lastMessage`), { text, timestamp: serverTimestamp() }).catch(() => {});
      update(ref(db, `users/${state.currentUser.uid}`), { points: increment(1) }).catch(() => {});
    }
  } catch (e) {
    // Restore input text on failure so user doesn't lose their message
    input.value = savedText;
    Toast.error('Send failed — message restored');
  }
  finally { state.isSending = false; updateSendBtn(); input.focus(); }
}

async function sendFileMessage(file, type) {
  if (!state.chatId || !state.currentUser) { Toast.error('No active chat'); return; }
  if (state.isSending || state.isUploading) { Toast.info('Already sending...'); return; }
  state.isUploading = true; const cid = state.chatId;
  const tid = 'proc-' + Date.now(); const wrap = $('msgs-wrap');
  const tmp = document.createElement('div'); tmp.className = 'msg sent'; tmp.id = `msg-${tid}`;
  tmp.innerHTML = `<div class="msg-bubble" style="padding:12px 14px"><div style="display:flex;align-items:center;gap:10px"><div class="upload-spinner"></div><div><div style="font-size:12px;font-family:var(--font-mono)">${escHtml(file.name)}</div><div style="font-size:11px;opacity:0.6;margin-top:2px" id="proc-status-${tid}">${type === 'image' ? 'Compressing...' : 'Encoding...'}</div></div></div></div>`;
  wrap.appendChild(tmp); requestAnimationFrame(() => { requestAnimationFrame(() => { wrap.scrollTop = wrap.scrollHeight; }); });
  try {
    let dataUrl, disp, sizeInfo;
    if (type === 'image') {
      const st = document.getElementById(`proc-status-${tid}`); if (st) st.textContent = 'Compressing image...';
      const r = await compressImage(file);
      if (st) st.textContent = `Compressed to ${r.sizeKB}KB — Sending...`;
      dataUrl = r.dataUrl; disp = 'Image'; sizeInfo = `${r.sizeKB}KB · ${r.width}×${r.height}`;
    } else {
      const st = document.getElementById(`proc-status-${tid}`); if (st) st.textContent = 'Encoding file...';
      dataUrl = await fileToBase64(file); disp = file.name; sizeInfo = formatFileSize(file.size);
    }
    const existing = document.getElementById(`msg-${tid}`); if (existing) existing.remove();
    const msgData = { sender: state.currentUser.uid, type, dataUrl, text: disp, fileName: file.name, fileSize: sizeInfo, status: 'sent', timestamp: serverTimestamp() };
    if (state.replyToMsgId) { msgData.replyTo = state.replyToMsgId; msgData.replyToText = state.replyToText; cancelReply(); }
    await push(ref(db, `chats/${cid}/messages`), msgData);
    await set(ref(db, `chats/${cid}/lastMessage`), { text: disp, timestamp: serverTimestamp() });
    update(ref(db, `users/${state.currentUser.uid}`), { points: increment(1) }).catch(() => {});
    Toast.success(type === 'image' ? 'Image sent' : 'File sent');
  } catch (e) {
    const existing = document.getElementById(`msg-${tid}`); if (existing) existing.remove();
    Toast.error(e.message || 'Send failed');
  } finally { state.isUploading = false; }
}

async function sendVoiceMessage(blob, mime, dur) {
  if (!state.chatId || !state.currentUser) return;
  if (state.isSending || state.isUploading) { Toast.info('Already sending...'); return; }
  state.isUploading = true; const cid = state.chatId;
  const tid = 'voice-' + Date.now(); const wrap = $('msgs-wrap');
  const tmp = document.createElement('div'); tmp.className = 'msg sent'; tmp.id = `msg-${tid}`;
  tmp.innerHTML = `<div class="msg-bubble" style="padding:12px 14px"><div style="display:flex;align-items:center;gap:10px"><div class="upload-spinner"></div><div><div style="font-size:12px;font-family:var(--font-mono)"><i data-lucide="mic" class="lucide" width="12" height="12"></i> Voice note</div><div style="font-size:11px;opacity:0.6;margin-top:2px">Processing...</div></div></div></div>`;
  wrap.appendChild(tmp); requestAnimationFrame(() => { requestAnimationFrame(() => { wrap.scrollTop = wrap.scrollHeight; }); });
  try {
    const dataUrl = await audioToBase64(blob);
    const existing = document.getElementById(`msg-${tid}`); if (existing) existing.remove();
    const msgData = { sender: state.currentUser.uid, type: 'audio', dataUrl, text: 'Voice note', duration: dur, status: 'sent', timestamp: serverTimestamp() };
    if (state.replyToMsgId) { msgData.replyTo = state.replyToMsgId; msgData.replyToText = state.replyToText; cancelReply(); }
    await push(ref(db, `chats/${cid}/messages`), msgData);
    await set(ref(db, `chats/${cid}/lastMessage`), { text: 'Voice note', timestamp: serverTimestamp() });
    update(ref(db, `users/${state.currentUser.uid}`), { points: increment(1) }).catch(() => {});
    Toast.success('Voice sent');
  } catch (e) {
    const existing = document.getElementById(`msg-${tid}`); if (existing) existing.remove();
    Toast.error(e.message || 'Voice send failed');
  } finally { state.isUploading = false; }
}

function handleSend() {
  if (state.pendingFile) { const { file, type } = state.pendingFile; cancelPendingFile(); sendFileMessage(file, type); }
  else sendTextMessage($('message-input').value);
}

$('send-btn').addEventListener('click', handleSend);
$('message-input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } });

/* ═══════════════════════════════════════════════════
   CONVERSATION STARTERS (unchanged)
   ═══════════════════════════════════════════════════ */
$('s-help').addEventListener('click', () => { $('message-input').value = "Hey! Can you help me with "; updateSendBtn(); $('message-input').focus(); const i = $('message-input'); i.selectionStart = i.selectionEnd = i.value.length; });
$('s-discuss').addEventListener('click', () => { $('message-input').value = "I wanted to discuss "; updateSendBtn(); $('message-input').focus(); const i = $('message-input'); i.selectionStart = i.selectionEnd = i.value.length; });
$('s-collab').addEventListener('click', () => { $('message-input').value = "I have a collaboration idea: "; updateSendBtn(); $('message-input').focus(); const i = $('message-input'); i.selectionStart = i.selectionEnd = i.value.length; });

/* ═══════════════════════════════════════════════════
   BACK BUTTON
   ═══════════════════════════════════════════════════ */
$('back-btn').addEventListener('click', () => {
  cleanupChatListeners();
  state.chatId = null;
  state.chatPartnerId = null;
const ces = document.getElementById('chat-empty-state'); if (ces) ces.classList.add('visible');
  navTo('user-list-screen', 'nav-chat');
});

/* ═══════════════════════════════════════════════════
   ATTACH MENU & FILE HANDLERS
   ═══════════════════════════════════════════════════ */
function closeAttachMenu() { $('attach-menu').classList.remove('open'); }
$('attach-btn').addEventListener('click', e => { e.stopPropagation(); $('attach-menu').classList.toggle('open'); });
$('attach-image').addEventListener('click', () => { closeAttachMenu(); $('file-img-input').value = ''; $('file-img-input').click(); });
$('attach-file').addEventListener('click', () => { closeAttachMenu(); $('file-doc-input').value = ''; $('file-doc-input').click(); });
$('attach-secure').addEventListener('click', () => { closeAttachMenu(); VaultSystem.openEncryptModal({ type: 'dm' }); });

// ── Room secure file button ──
(function() {
  var roomSecureBtn = document.getElementById('room-secure-btn');
  if (roomSecureBtn) {
    roomSecureBtn.addEventListener('click', function() {
      var roomId = RoomSystem && RoomSystem.currentRoomId;
      if (!roomId) { Toast.error('Open a room first'); return; }
      VaultSystem.openEncryptModal({ type: 'room', roomId: roomId });
    });
  }
})();

// ── Guild secure file button ──
(function() {
  var guildSecureBtn = document.getElementById('guild-secure-btn');
  if (guildSecureBtn) {
    guildSecureBtn.addEventListener('click', function() {
      var guildId = guildState && guildState.currentGuildId;
      if (!guildId) { Toast.error('Open a guild first'); return; }
      VaultSystem.openEncryptModal({ type: 'guild', guildId: guildId });
    });
  }
})();

$('file-img-input').addEventListener('change', e => {
  const f = e.target.files[0]; if (!f) return;
  if (f.size > 10 * 1024 * 1024) { Toast.error('Image too large (max 10MB)'); return; }
  if (!f.type.startsWith('image/')) { Toast.error('Select an image'); return; }
  state.pendingFile = { file: f, type: 'image' };
  const r = new FileReader();
  r.onload = ev => {
    $('preview-thumb').src = ev.target.result;
    $('preview-name').textContent = f.name;
    $('preview-size').textContent = `${formatFileSize(f.size)} → will be compressed`;
    $('img-preview-bar').classList.add('active'); updateSendBtn();
  };
  r.onerror = () => { Toast.error('Read failed'); state.pendingFile = null; };
  r.readAsDataURL(f);
});

$('file-doc-input').addEventListener('change', e => {
  const f = e.target.files[0]; if (!f) return;
  // ── PRO MEDIA: Pro gets 2× file size limit ──
  const _maxFileB = ProMedia.getMaxFileBytes();
  if (f.size > _maxFileB) { Toast.error(`File too large (max ${ProMedia.getMaxFileMB()}${ProMedia.isPro() ? ' · Pro limit' : ' · Upgrade to Pro for 1MB'})`); return; }
  state.pendingFile = { file: f, type: 'file' };
  $('preview-thumb').src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  $('preview-name').textContent = f.name; $('preview-size').textContent = formatFileSize(f.size);
  $('img-preview-bar').classList.add('active'); updateSendBtn();
});

$('preview-send').addEventListener('click', () => {
  if (!state.pendingFile || !state.chatId) return;
  const { file, type } = state.pendingFile; cancelPendingFile(); sendFileMessage(file, type);
});
$('preview-cancel').addEventListener('click', cancelPendingFile);

function cancelPendingFile() { state.pendingFile = null; $('img-preview-bar').classList.remove('active'); $('preview-thumb').src = ''; updateSendBtn(); }

/* ═══════════════════════════════════════════════════
   VOICE RECORDING
   ═══════════════════════════════════════════════════ */
$('voice-btn').addEventListener('click', toggleRecording);

async function toggleRecording() {
  if (!state.chatId) { Toast.error('Open a chat first'); return; }
  if (!state.isRecording) await startRecording(); else stopRecording();
}

async function startRecording() {
  try {
    // ── PRO MEDIA: Pro gets enhanced audio capture for voice notes ──
    const _recConstraints = ProMedia.isPro()
      ? { audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48000, channelCount: 1 } }
      : { audio: { echoCancellation: true, noiseSuppression: true } };
    const s = await navigator.mediaDevices.getUserMedia(_recConstraints);
    const mimeTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg', 'audio/mp4'];
    let mt = '';
    for (const t of mimeTypes) { if (MediaRecorder.isTypeSupported(t)) { mt = t; break; } }
    state.mediaRecorder = new MediaRecorder(s, mt ? { mimeType: mt } : {});
    state.audioChunks = [];
    state.mediaRecorder.ondataavailable = e => { if (e.data && e.data.size > 0) state.audioChunks.push(e.data); };
    state.mediaRecorder.onstop = async () => {
      s.getTracks().forEach(t => t.stop());
      if (state.audioChunks.length > 0 && state.chatId) {
        const blob = new Blob(state.audioChunks, { type: state.mediaRecorder.mimeType || mt || 'audio/webm' });
        if (blob.size > 0) await sendVoiceMessage(blob, state.mediaRecorder.mimeType || mt || 'audio/webm', formatRecDuration(state.recSeconds));
        else Toast.info('Recording too short');
      }
      state.audioChunks = [];
    };
    state.mediaRecorder.onerror = () => { stopRecording(); Toast.error('Recording error'); };
    state.mediaRecorder.start(250);
state.isRecording = true; $('voice-btn').classList.add('recording'); $('voice-btn').innerHTML = '<i data-lucide="square" class="lucide" width="17" height="17" style="fill:currentColor"></i>'; lucideCreate();
    state.recSeconds = 0; $('rec-timer').textContent = '0:00'; $('recording-bar').classList.add('active');
    state.recTimerInterval = setInterval(() => {
      state.recSeconds++; $('rec-timer').textContent = formatRecDuration(state.recSeconds);
      // ── PRO MEDIA: Pro gets 120s voice recording, free gets 60s ──
      const _maxSec = ProMedia.getMaxAudioSec();
      if (state.recSeconds >= _maxSec) { Toast.info(`Max ${_maxSec}s reached${ProMedia.isPro() ? '' : ' · Pro gets 120s'}`); stopRecording(); }
    }, 1000);
  } catch (e) {
    if (e.name === 'NotAllowedError') Toast.error('Microphone permission denied');
    else if (e.name === 'NotFoundError') Toast.error('No microphone found');
    else Toast.error('Microphone error');
  }
}

function stopRecording() {
  if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') try { state.mediaRecorder.stop(); } catch (e) {}
  state.isRecording = false; $('voice-btn').classList.remove('recording'); $('voice-btn').innerHTML = '<i data-lucide="mic" class="lucide" width="17" height="17"></i>'; lucideCreate();
  clearInterval(state.recTimerInterval); $('recording-bar').classList.remove('active');
}

function stopRecordingCleanup() {
  if (state.isRecording) {
    if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
      state.mediaRecorder.ondataavailable = null;
      state.mediaRecorder.onstop = () => { try { state.mediaRecorder.stream?.getTracks().forEach(t => t.stop()); } catch (e) {} };
      try { state.mediaRecorder.stop(); } catch (e) {}
    }
    state.audioChunks = []; state.isRecording = false;
    $('voice-btn').classList.remove('recording'); $('voice-btn').innerHTML = '<i data-lucide="mic" class="lucide" width="17" height="17"></i>'; lucideCreate();
    clearInterval(state.recTimerInterval); $('recording-bar').classList.remove('active');
  }
}

$('rec-cancel-btn').addEventListener('click', () => {
  if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
    state.mediaRecorder.ondataavailable = null;
    state.mediaRecorder.onstop = () => { try { state.mediaRecorder.stream?.getTracks().forEach(t => t.stop()); } catch (e) {} };
    try { state.mediaRecorder.stop(); } catch (e) {}
  }
  state.audioChunks = []; state.isRecording = false;
  $('voice-btn').classList.remove('recording'); $('voice-btn').innerHTML = '<i data-lucide="mic" class="lucide" width="17" height="17"></i>'; lucideCreate();
  clearInterval(state.recTimerInterval); $('recording-bar').classList.remove('active');
  Toast.info('Cancelled');
});

/* ═══════════════════════════════════════════════════
   DRAG & DROP
   ═══════════════════════════════════════════════════ */
let dragCounter = 0;
$('app').addEventListener('dragenter', e => { e.preventDefault(); if (!state.chatId) return; dragCounter++; $('drop-overlay').classList.add('active'); });
$('app').addEventListener('dragleave', e => { e.preventDefault(); dragCounter--; if (dragCounter <= 0) { dragCounter = 0; $('drop-overlay').classList.remove('active'); } });
$('app').addEventListener('dragover', e => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
$('app').addEventListener('drop', e => {
  e.preventDefault(); dragCounter = 0; $('drop-overlay').classList.remove('active');
  if (!state.chatId) { Toast.error('Open a chat first'); return; }
  const fs = e.dataTransfer?.files; if (!fs || fs.length === 0) return;
  const f = fs[0];
  if (f.type.startsWith('image/')) { if (f.size > 10 * 1024 * 1024) { Toast.error('Image too large (max 10MB)'); return; } sendFileMessage(f, 'image'); }
  else { if (f.size > ProMedia.getMaxFileBytes()) { Toast.error(`File too large (max ${ProMedia.getMaxFileMB()})`); return; } sendFileMessage(f, 'file'); } // PRO MEDIA: dynamic limit
});

/* ═══════════════════════════════════════════════════
   CHAT SEARCH
   ═══════════════════════════════════════════════════ */
$('chat-search-btn').addEventListener('click', () => {
  const b = $('chat-search-bar'); const open = b.style.display === 'block';
  b.style.display = open ? 'none' : 'block';
  if (!open) $('chat-search-input').focus();
  else { $('chat-search-input').value = ''; clearChatHighlights(); }
});

$('chat-search-input').addEventListener('input', debounce(e => {
  clearChatHighlights(); const q = e.target.value.toLowerCase().trim(); if (!q) return;
  let fm = null;
  $$('#msgs-wrap .msg').forEach(m => {
    const b = m.querySelector('.msg-bubble');
    if (b && b.textContent.toLowerCase().includes(q)) { m.classList.add('msg-highlight'); if (!fm) fm = m; }
  });
  if (fm) fm.scrollIntoView({ behavior: 'smooth', block: 'center' });
}, 200));

function clearChatHighlights() { $$('#msgs-wrap .msg-highlight').forEach(m => m.classList.remove('msg-highlight')); }

/* ═══════════════════════════════════════════════════
   LIGHTBOX
   ═══════════════════════════════════════════════════ */
function openLightbox(url, name) {
  $('lightbox-img').src = url; $('lightbox').classList.add('open');
  $('lightbox-download').onclick = () => downloadBase64(url, name || 'image.jpg');
}
$('lightbox-close').addEventListener('click', () => $('lightbox').classList.remove('open'));
$('lightbox').addEventListener('click', e => { if (e.target === $('lightbox')) $('lightbox').classList.remove('open'); });

/* ═══════════════════════════════════════════════════
   GLOBAL CLICK / KEYBOARD HANDLERS
   ═══════════════════════════════════════════════════ */
document.addEventListener('click', e => {
  const p = $('reaction-picker'); if (p && !p.contains(e.target)) p.classList.remove('open');
  const am = $('attach-menu'), ab = $('attach-btn');
  if (am && !am.contains(e.target) && !ab.contains(e.target)) closeAttachMenu();
  // Close notif panel if click outside
  const panel = document.getElementById('notif-panel');
  const bellBtn = document.getElementById('chrome-bell-btn');
  if (panel && panel.classList.contains('open') && !panel.contains(e.target) && bellBtn && !bellBtn.contains(e.target)) {
    if(window._closeNotifPanel) window._closeNotifPanel();
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    const notifPanel = document.getElementById('notif-panel');
    if (notifPanel && notifPanel.classList.contains('open')) { if(window._closeNotifPanel) window._closeNotifPanel(); return; }
    if ($('lightbox').classList.contains('open')) { $('lightbox').classList.remove('open'); return; }
    if ($('report-modal-overlay').classList.contains('active')) { ReportModal.close(); return; }
    if ($('feedback-modal-overlay').classList.contains('active')) { FeedbackModal.close(); return; }
    if ($('profile-modal').classList.contains('open')) { $('profile-modal').classList.remove('open'); return; }
    if ($('user-info-panel').classList.contains('open')) { closeUserInfoPanel(); return; }
    if (document.getElementById('info-quick-panel')?.classList.contains('open')) { closeInfoQuickPanel(); return; }
    if (document.getElementById('user-profile-sheet')?.classList.contains('active')) { closeUserProfileSheet(); return; }
    if (state.golexExpanded) { toggleGolexExpand(); return; }
    if ($('reaction-picker').classList.contains('open')) { $('reaction-picker').classList.remove('open'); return; }
    if (state.editingMsgId) { cancelEdit(); return; }
    if (state.replyToMsgId) { cancelReply(); return; }
    if (state.pendingFile) { cancelPendingFile(); return; }
    if ($('chat-search-bar').style.display === 'block') { $('chat-search-bar').style.display = 'none'; $('chat-search-input').value = ''; clearChatHighlights(); return; }
    if ($('attach-menu').classList.contains('open')) { closeAttachMenu(); return; }
  }
});

/* ═══════════════════════════════════════════════════
   INITIAL FALLBACK
   ═══════════════════════════════════════════════════ */
setTimeout(() => {
  if ($('loading-screen').classList.contains('active') && !state.currentUser) ScreenManager.show('login-screen');
}, 3000);

initScrollButton();
/* ══════════════════════════════════════════════════════════════════
   VAULT SYSTEM — Secure Attachments via AES-256-GCM
   ══════════════════════════════════════════════════════════════════ */
const VaultSystem = (() => {

  /* ─── Crypto Primitives (extracted from Snaplyn Vault) ─── */

  function _arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return window.btoa(binary);
  }

  function _base64ToArrayBuffer(base64) {
    const binaryString = window.atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
    return bytes;
  }

  function _readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    });
  }

  async function _getKeyMaterial(password) {
    const enc = new TextEncoder();
    return await window.crypto.subtle.importKey('raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveBits', 'deriveKey']);
  }

  async function _deriveKey(keyMaterial, salt) {
    return await window.crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function _hashString(str) {
    const encoder = new TextEncoder();
    const data = encoder.encode(str.trim().toLowerCase());
    const hashBuffer = await window.crypto.subtle.digest('SHA-256', data);
    return _arrayBufferToBase64(hashBuffer);
  }

  async function _encryptFile(file, password, questions) {
    const questionsWithHashes = [];
    for (const q of questions) {
      const hashedAnswer = await _hashString(q.answer);
      questionsWithHashes.push({ question: q.question, hashedAnswer });
    }
    const salt = window.crypto.getRandomValues(new Uint8Array(16));
    const keyMaterial = await _getKeyMaterial(password);
    const key = await _deriveKey(keyMaterial, salt);
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const fileBuffer = await _readFileAsArrayBuffer(file);
    const encryptedContent = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, fileBuffer);
    return {
      version: 1,
      fileName: file.name,
      fileType: file.type || 'application/octet-stream',
      encryptedData: _arrayBufferToBase64(encryptedContent),
      salt: _arrayBufferToBase64(salt),
      iv: _arrayBufferToBase64(iv),
      questions: questionsWithHashes
    };
  }

  async function _decryptFile(vaultData, password) {
    const keyMaterial = await _getKeyMaterial(password);
    const salt = _base64ToArrayBuffer(vaultData.salt);
    const key = await _deriveKey(keyMaterial, salt);
    const iv = _base64ToArrayBuffer(vaultData.iv);
    const encryptedData = _base64ToArrayBuffer(vaultData.encryptedData);
    const decryptedContent = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encryptedData);
    return new Uint8Array(decryptedContent);
  }

  async function _verifyQuestions(vaultData, answers) {
    if (!vaultData.questions || vaultData.questions.length === 0) return true;
    for (let i = 0; i < vaultData.questions.length; i++) {
      const expected = vaultData.questions[i].hashedAnswer;
      const given = await _hashString(answers[i] || '');
      if (given !== expected) return false;
    }
    return true;
  }

  /* ─── Encrypt Modal State ─── */
  let _encFile = null;
  let _encQuestions = []; // [{question, answer}]
  // Context: which chat is this vault send targeting?
  // { type: 'dm' } | { type: 'room', roomId } | { type: 'guild', guildId }
  let _vaultContext = { type: 'dm' };

  function _formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024, sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function _fileIcon(name) {
    if (!name) return 'file';
    const ext = name.split('.').pop().toLowerCase();
    const map = { pdf: 'file-text', doc: 'file-text', docx: 'file-text', txt: 'file', md: 'file', csv: 'bar-chart-2', xls: 'bar-chart-2', xlsx: 'bar-chart-2', ppt: 'bar-chart-2', pptx: 'bar-chart-2', zip: 'archive', rar: 'archive', '7z': 'archive', jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', svg: 'image', mp3: 'music', wav: 'music', ogg: 'music', mp4: 'film', mov: 'film', avi: 'film' };
    return map[ext] || 'file';
  }

  function _updateEncSendBtn() {
    const pw = document.getElementById('vault-password-input');
    const btn = document.getElementById('vault-send-btn');
    if (!btn) return;
    const allQsFilled = _encQuestions.every(q => q.question.trim() && q.answer.trim());
    btn.disabled = !(_encFile && pw && pw.value.length >= 4 && allQsFilled);
  }

  function _resetEncModal() {
    _encFile = null;
    _encQuestions = [];
    const pw = document.getElementById('vault-password-input');
    if (pw) pw.value = '';
    const chip = document.getElementById('vault-file-chip');
    const zone = document.getElementById('vault-drop-zone-inner');
    if (chip) chip.style.display = 'none';
    if (zone) zone.style.display = '';
    const dropZone = document.getElementById('vault-drop-zone');
    if (dropZone) dropZone.classList.remove('has-file');
    const fi = document.getElementById('vault-file-input');
    if (fi) fi.value = '';
    const ql = document.getElementById('vault-questions-list');
    if (ql) ql.innerHTML = '';
    const err = document.getElementById('vault-decrypt-error');
    if (err) err.style.display = 'none';
    _updateEncSendBtn();
  }

  function _renderQuestionCards() {
    const list = document.getElementById('vault-questions-list');
    if (!list) return;
    list.innerHTML = '';
    _encQuestions.forEach((q, i) => {
      const card = document.createElement('div');
      card.className = 'vault-question-card';
      card.style.marginBottom = '8px';
      card.innerHTML = `
        <div class="vault-question-header">
          <span class="vault-question-label">Question ${i + 1}</span>
          <button class="vault-question-remove" data-idx="${i}" title="Remove question"><i data-lucide="x" class="lucide" width="12" height="12"></i></button>
        </div>
        <input class="input" type="text" placeholder="e.g. What's our project name?" maxlength="120" value="${escHtml(q.question)}" data-qfield="question" data-idx="${i}" autocomplete="off">
        <input class="input" type="text" placeholder="Answer (case-insensitive)" maxlength="120" value="${escHtml(q.answer)}" data-qfield="answer" data-idx="${i}" autocomplete="off" style="margin-top:8px;">
      `;
      // Remove button
      card.querySelector('.vault-question-remove').addEventListener('click', () => {
        _encQuestions.splice(i, 1);
        _renderQuestionCards();
        _updateEncSendBtn();
      });
      // Input listeners
      card.querySelectorAll('input[data-qfield]').forEach(inp => {
        inp.addEventListener('input', e => {
          _encQuestions[parseInt(inp.dataset.idx)][inp.dataset.qfield] = e.target.value;
          _updateEncSendBtn();
        });
      });
      list.appendChild(card);
    });
  }

  /* ─── Open / close encrypt modal ─── */
  function openEncryptModal(ctx) {
    // ctx defaults to DM context
    _vaultContext = ctx || { type: 'dm' };

    // Validate context — make sure there's an active target
    if (_vaultContext.type === 'dm') {
      if (!state.chatId) { Toast.error('Open a chat first'); return; }
    } else if (_vaultContext.type === 'room') {
      if (!_vaultContext.roomId) { Toast.error('Open a room first'); return; }
    } else if (_vaultContext.type === 'guild') {
      if (!_vaultContext.guildId) { Toast.error('Open a guild first'); return; }
    }

    _resetEncModal();
    const overlay = document.getElementById('vault-modal-overlay');
    if (overlay) {
      overlay.classList.add('active');
      lucideCreate();

    }
  }

  function _closeEncryptModal() {
    const overlay = document.getElementById('vault-modal-overlay');
    if (overlay) overlay.classList.remove('active');
    _resetEncModal();
  }

  /* ─── Send encrypted file ─── */
  async function _sendVaultMessage() {
    if (!_encFile || !state.currentUser) return;

    // Validate we still have a live target
    if (_vaultContext.type === 'dm' && !state.chatId) { Toast.error('Open a chat first'); return; }
    if (_vaultContext.type === 'room' && !_vaultContext.roomId) { Toast.error('No active room'); return; }
    if (_vaultContext.type === 'guild' && !_vaultContext.guildId) { Toast.error('No active guild'); return; }

    const pw = document.getElementById('vault-password-input');
    if (!pw || pw.value.length < 4) { Toast.error('Password must be at least 4 characters'); return; }

    const btn = document.getElementById('vault-send-btn');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<div class="upload-spinner" style="width:16px;height:16px;border-width:2px;"></div> Encrypting…';
    }

    try {
      const questions = _encQuestions.filter(q => q.question.trim() && q.answer.trim());
      const vaultData = await _encryptFile(_encFile, pw.value, questions);

      const baseMsgData = {
        type: 'vault',
        vaultData: JSON.stringify(vaultData),
        fileName: _encFile.name,
        fileSize: _formatFileSize(_encFile.size),
        text: 'Secure File',
        timestamp: serverTimestamp()
      };

      if (_vaultContext.type === 'dm') {
        // ── DM path ──
        const msgData = {
          ...baseMsgData,
          sender: state.currentUser.uid,
          status: 'sent'
        };
        if (state.replyToMsgId) {
          msgData.replyTo = state.replyToMsgId;
          msgData.replyToText = state.replyToText;
          cancelReply();
        }
        await push(ref(db, `chats/${state.chatId}/messages`), msgData);
        await set(ref(db, `chats/${state.chatId}/lastMessage`), { text: 'Secure File', timestamp: serverTimestamp() });
        update(ref(db, `users/${state.currentUser.uid}`), { points: increment(2) }).catch(() => {});

      } else if (_vaultContext.type === 'room') {
        // ── Room path ──
        const msgData = {
          ...baseMsgData,
          senderId: state.currentUser.uid,
          senderUsername: state.username || 'Unknown',
          senderPfp: state.pfpUrl || null
        };
        await push(ref(db, `rooms/${_vaultContext.roomId}/messages`), msgData);

      } else if (_vaultContext.type === 'guild') {
        // ── Guild path ──
        const now = Date.now();
        const VAULT_TTL = 48 * 60 * 60 * 1000; // 48h for vault files
        const msgData = {
          ...baseMsgData,
          senderId: state.currentUser.uid,
          username: state.username || 'anonymous',
          skill: state.skill || 'Explorer',
          avatarUrl: state.pfpUrl || '',
          createdAt: now,
          expiresAt: now + VAULT_TTL
        };
        if (guildState && guildState.replyToMsgId) {
          msgData.replyToMsgId = guildState.replyToMsgId;
          msgData.replyToText  = guildState.replyToText;
          cancelGuildReply();
        }
        await push(ref(db, `guilds/${_vaultContext.guildId}/messages`), msgData);
      }

      _closeEncryptModal();
      Toast.success('Secure file sent');
    } catch (e) {
      DEBUG && console.error('[Vault Encrypt]', e);
      Toast.error('Encryption failed — please try again');
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i data-lucide="send" class="lucide" width="15" height="15"></i> Encrypt & Send';
        lucideCreate();

      }
    }
  }

  /* ─── Build vault chat bubble ─── */
  function buildVaultContent(mid, m, isMe) {
    const bubble = document.createElement('div');
    bubble.className = 'msg-vault-bubble';
    bubble.id = `vault-bubble-${mid}`;

    const lockEl = document.createElement('div');
    lockEl.className = 'vault-bubble-lock';
    lockEl.innerHTML = '<i data-lucide="lock" class="lucide" width="16" height="16"></i>';

    const info = document.createElement('div');
    info.className = 'vault-bubble-info';

    const nameEl = document.createElement('div');
    nameEl.className = 'vault-bubble-filename';
    nameEl.textContent = m.fileName || 'Encrypted File';

    const labelEl = document.createElement('div');
    labelEl.className = 'vault-bubble-label';

    if (isMe) {
      // Sender sees a "sent" state — no unlock needed
      labelEl.innerHTML = '<i data-lucide="lock" class="lucide" width="12" height="12"></i> Secure · AES-256';
      bubble.style.cursor = 'default';
      bubble.title = 'You sent this encrypted file. Share your password with the recipient privately.';
    } else {
      // Receiver gets "Tap to unlock" prompt
      labelEl.innerHTML = '<i data-lucide="key" class="lucide" width="12" height="12"></i> Tap to unlock';
      bubble.title = 'Click to unlock and download this secure file';
      bubble.addEventListener('click', () => {
        openDecryptModal(mid, m);
      });
    }

    info.appendChild(nameEl);
    if (m.fileSize) {
      const sizeEl = document.createElement('div');
      sizeEl.style.cssText = 'font-size:9px;color:var(--muted);font-family:var(--font-mono);margin-top:2px;';
      sizeEl.textContent = m.fileSize;
      info.appendChild(sizeEl);
    }
    info.appendChild(labelEl);

    bubble.appendChild(lockEl);
    bubble.appendChild(info);
    return bubble;
  }

  /* ─── Decrypt modal ─── */
  let _currentDecryptMsgId = null;
  let _currentDecryptMsg = null;

  function openDecryptModal(mid, m) {
    _currentDecryptMsgId = mid;
    _currentDecryptMsg = m;

    const overlay = document.getElementById('vault-decrypt-overlay');
    const pwInput = document.getElementById('vault-decrypt-password');
    const qContainer = document.getElementById('vault-decrypt-questions');
    const errEl = document.getElementById('vault-decrypt-error');
    const subEl = document.getElementById('vault-decrypt-filename-sub');
    const hintEl = document.getElementById('vault-decrypt-hint');

    if (subEl) subEl.textContent = m.fileName || 'encrypted file';
    if (errEl) errEl.style.display = 'none';
    if (pwInput) pwInput.value = '';
    if (qContainer) qContainer.innerHTML = '';

    // Render verification questions if any
    try {
      const vd = JSON.parse(m.vaultData || '{}');
      if (vd.questions && vd.questions.length > 0) {
        if (hintEl) hintEl.textContent = `This file has ${vd.questions.length} verification question(s). Answer them along with the password to unlock.`;
        vd.questions.forEach((q, idx) => {
          const field = document.createElement('div');
          field.className = 'vault-field';
          field.style.marginTop = '14px';
          field.innerHTML = `
            <div class="vault-field-label"><i data-lucide="help-circle" class="lucide" width="16" height="16"></i> ${escHtml(q.question)}</div>
            <input class="input" type="text" id="vault-decrypt-answer-${idx}" placeholder="Your answer…" autocomplete="off" maxlength="120">
          `;
          qContainer.appendChild(field);
        });
        lucideCreate();

      } else {
        if (hintEl) hintEl.textContent = 'Ask the sender for the password, then enter it below to unlock and download the file.';
      }
    } catch (e) {}

    if (overlay) {
      overlay.classList.add('active');
      setTimeout(() => { if (pwInput) pwInput.focus(); }, 200);
    }
  }

  function _closeDecryptModal() {
    const overlay = document.getElementById('vault-decrypt-overlay');
    if (overlay) overlay.classList.remove('active');
    _currentDecryptMsgId = null;
    _currentDecryptMsg = null;
  }

  async function _attemptDecrypt() {
    if (!_currentDecryptMsg) return;
    const pwInput = document.getElementById('vault-decrypt-password');
    const errEl = document.getElementById('vault-decrypt-error');
    const errTextEl = document.getElementById('vault-decrypt-error-text');
    const btn = document.getElementById('vault-decrypt-btn');

    if (!pwInput || !pwInput.value.trim()) {
      if (errEl) { errEl.style.display = 'flex'; if (errTextEl) errTextEl.textContent = 'Please enter the password.'; }
      return;
    }

    if (btn) { btn.disabled = true; btn.innerHTML = '<div class="upload-spinner" style="width:16px;height:16px;border-width:2px;"></div> Decrypting…'; }
    if (errEl) errEl.style.display = 'none';

    try {
      const vaultData = JSON.parse(_currentDecryptMsg.vaultData || '{}');

      // Check verification questions if any
      if (vaultData.questions && vaultData.questions.length > 0) {
        const answers = vaultData.questions.map((_, idx) => {
          const inp = document.getElementById(`vault-decrypt-answer-${idx}`);
          return inp ? inp.value : '';
        });
        const questionsOk = await _verifyQuestions(vaultData, answers);
        if (!questionsOk) {
          if (errEl) { errEl.style.display = 'flex'; }
          if (errTextEl) errTextEl.textContent = 'One or more verification answers are incorrect.';
          if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="unlock" class="lucide" width="15" height="15"></i> Decrypt & Download'; lucideCreate();
}
          return;
        }
      }

      const decryptedBytes = await _decryptFile(vaultData, pwInput.value);

      // Download the file
      const blob = new Blob([decryptedBytes], { type: vaultData.fileType || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = vaultData.fileName || _currentDecryptMsg.fileName || 'decrypted_file';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);

      // Mark bubble as unlocked visually
      const mid = _currentDecryptMsgId;
      setTimeout(() => {
        const bubble = document.getElementById(`vault-bubble-${mid}`);
        if (bubble) {
          bubble.classList.add('decrypted');
          const lockEl = bubble.querySelector('.vault-bubble-lock');
          if (lockEl) lockEl.innerHTML = '<i data-lucide="lock-open" class="lucide" width="16" height="16"></i>';
          const labelEl = bubble.querySelector('.vault-bubble-label');
          if (labelEl) { labelEl.innerHTML = '<i data-lucide="check" class="lucide" width="12" height="12"></i> Downloaded'; labelEl.classList.add('unlocked'); }
          bubble.style.cursor = 'default';
          bubble.onclick = null;
        }
      }, 100);

      _closeDecryptModal();
      Toast.success('File decrypted & downloaded');
    } catch (e) {
      DEBUG && console.error('[Vault Decrypt]', e);
      if (errEl) { errEl.style.display = 'flex'; }
      if (errTextEl) errTextEl.textContent = 'Wrong password or the file is corrupted.';
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i data-lucide="unlock" class="lucide" width="15" height="15"></i> Decrypt & Download';
        lucideCreate();

      }
    }
  }

  /* ─── Wire up all Vault UI events ─── */
  function _init() {
    /* --- ENCRYPT MODAL EVENTS --- */

    // File picker
    const fileInput = document.getElementById('vault-file-input');
    if (fileInput) {
      fileInput.addEventListener('change', e => {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        const MAX = 5 * 1024 * 1024;
        if (f.size > MAX) { Toast.error('File too large — max 5MB for secure files'); fileInput.value = ''; return; }
        _encFile = f;
        const chip = document.getElementById('vault-file-chip');
        const zone = document.getElementById('vault-drop-zone-inner');
        const dropZone = document.getElementById('vault-drop-zone');
        const iconEl = document.getElementById('vault-file-chip-icon');
        const nameEl = document.getElementById('vault-file-chip-name');
        const sizeEl = document.getElementById('vault-file-chip-size');
        if (chip) chip.style.display = 'flex';
        if (zone) zone.style.display = 'none';
        if (dropZone) dropZone.classList.add('has-file');
        if (iconEl) iconEl.textContent = _fileIcon(f.name);
        if (nameEl) nameEl.textContent = f.name;
        if (sizeEl) sizeEl.textContent = _formatFileSize(f.size);
        _updateEncSendBtn();
      });
    }

    // Clear file
    const clearBtn = document.getElementById('vault-file-chip-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        _encFile = null;
        const fi = document.getElementById('vault-file-input');
        if (fi) fi.value = '';
        const chip = document.getElementById('vault-file-chip');
        const zone = document.getElementById('vault-drop-zone-inner');
        const dropZone = document.getElementById('vault-drop-zone');
        if (chip) chip.style.display = 'none';
        if (zone) zone.style.display = '';
        if (dropZone) dropZone.classList.remove('has-file');
        _updateEncSendBtn();
      });
    }

    // Password input
    const pwInput = document.getElementById('vault-password-input');
    if (pwInput) pwInput.addEventListener('input', _updateEncSendBtn);

    // Password visibility toggle
    const pwToggle = document.getElementById('vault-pw-toggle');
    if (pwToggle && pwInput) {
      pwToggle.addEventListener('click', () => {
        const isText = pwInput.type === 'text';
        pwInput.type = isText ? 'password' : 'text';
        pwToggle.innerHTML = isText
          ? '<i data-lucide="eye" class="lucide" width="15" height="15"></i>'
          : '<i data-lucide="eye-off" class="lucide" width="15" height="15"></i>';
        lucideCreate();

      });
    }

    // Add question button
    const addQBtn = document.getElementById('vault-add-question-btn');
    if (addQBtn) {
      addQBtn.addEventListener('click', () => {
        if (_encQuestions.length >= 3) { Toast.info('Max 3 verification questions'); return; }
        _encQuestions.push({ question: '', answer: '' });
        _renderQuestionCards();
        _updateEncSendBtn();
      });
    }

    // Send button
    const sendBtn = document.getElementById('vault-send-btn');
    if (sendBtn) sendBtn.addEventListener('click', _sendVaultMessage);

    // Close button
    const closeBtn = document.getElementById('vault-modal-close-btn');
    if (closeBtn) closeBtn.addEventListener('click', _closeEncryptModal);

    // Close on overlay click
    const overlay = document.getElementById('vault-modal-overlay');
    if (overlay) overlay.addEventListener('click', e => { if (e.target === overlay) _closeEncryptModal(); });

    /* --- DECRYPT MODAL EVENTS --- */

    // Decrypt button
    const decryptBtn = document.getElementById('vault-decrypt-btn');
    if (decryptBtn) decryptBtn.addEventListener('click', _attemptDecrypt);

    // Decrypt password — submit on Enter
    const decryptPw = document.getElementById('vault-decrypt-password');
    if (decryptPw) decryptPw.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); _attemptDecrypt(); } });

    // Decrypt close button
    const decryptClose = document.getElementById('vault-decrypt-close-btn');
    if (decryptClose) decryptClose.addEventListener('click', _closeDecryptModal);

    // Decrypt overlay click to close
    const decryptOverlay = document.getElementById('vault-decrypt-overlay');
    if (decryptOverlay) decryptOverlay.addEventListener('click', e => { if (e.target === decryptOverlay) _closeDecryptModal(); });

    // Decrypt password visibility toggle
    const decryptPwToggle = document.getElementById('vault-decrypt-pw-toggle');
    if (decryptPwToggle && decryptPw) {
      decryptPwToggle.addEventListener('click', () => {
        const isText = decryptPw.type === 'text';
        decryptPw.type = isText ? 'password' : 'text';
        decryptPwToggle.innerHTML = isText
          ? '<i data-lucide="eye" class="lucide" width="15" height="15"></i>'
          : '<i data-lucide="eye-off" class="lucide" width="15" height="15"></i>';
        lucideCreate();

      });
    }

    // Close modals on Escape
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        const encOv = document.getElementById('vault-modal-overlay');
        const decOv = document.getElementById('vault-decrypt-overlay');
        if (encOv && encOv.classList.contains('active')) { _closeEncryptModal(); return; }
        if (decOv && decOv.classList.contains('active')) { _closeDecryptModal(); return; }
      }
    });
  }

  // Expose public API
  return { openEncryptModal, buildVaultContent, openDecryptModal, init: _init };
})();

// Initialise vault after DOM is ready — use requestIdleCallback if available for lower startup cost
(window.requestIdleCallback || setTimeout)(() => {
  VaultSystem.init();
  lucideCreate();
}, typeof window.requestIdleCallback === 'function' ? { timeout: 1000 } : 0);

/* ─── Wire buildVaultContent to global scope for buildMessageElement ─── */
function buildVaultContent(mid, m, isMe) {
  return VaultSystem.buildVaultContent(mid, m, isMe);
}
/* ══════════════════════════════════════════════════════════════════
   END VAULT SYSTEM
   ══════════════════════════════════════════════════════════════════ */


// ── Export to window ──
Object.assign(window, {
  cleanupChatListeners, openChat,
  buildMessageElement, openLightbox, VaultSystem, buildVaultContent
});
