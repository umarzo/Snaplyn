const { state, $, $$, escHtml, linkify, timeAgo, formatTime, formatDate,
  badgeHTML, generateAvatarUrl, debounce, getExpiryInfo, formatRemainingTime,
  getExpiryClass, isAttachmentType, compressImage, fileToBase64,
  auth, db, ref, get, set, onValue, onChildAdded, push, serverTimestamp,
  onDisconnect, update, off, remove, limitToLast,
  CONFIG, EPHEMERAL_CONFIG, PREDEFINED_SKILLS, cleanupTimestamps,
  Toast, ScreenManager, cacheUser, getUserCached, openUserProfileSheet } = window;

/* ═══════════════════════════════════════════════════
   SKILL GUILDS SYSTEM — v2 (Ephemeral + Full Features)
   ═══════════════════════════════════════════════════ */

const GUILD_MAP = {
  'Gamer':        { icon: 'gamepad-2', name: 'Gamers Guild' },
  'Editor':       { icon: 'clapperboard', name: 'Editors Guild' },
  'Designer':     { icon: 'palette', name: 'Designers Guild' },
  'Coder':        { icon: 'monitor', name: 'Coders Guild' },
  'Writer':       { icon: 'pencil', name: 'Writers Guild' },
  'Artist':       { icon: 'paintbrush', name: 'Artists Guild' },
  'Musician':     { icon: 'music', name: 'Musicians Guild' },
  'Marketer':     { icon: 'megaphone', name: 'Marketers Guild' },
  'Animator':     { icon: 'film', name: 'Animators Guild' },
  'Photographer': { icon: 'camera', name: 'Photographers Guild' },
  'Streamer':     { icon: 'tv', name: 'Streamers Guild' },
  'Explorer':     { icon: 'search', name: 'Explorers Guild' },
};

const GUILD_TTL = {
  text:  24 * 60 * 60 * 1000,
  voice: 12 * 60 * 60 * 1000,
  image:  6 * 60 * 60 * 1000,
  file:   3 * 60 * 60 * 1000,
};

const guildState = {
  unsubMessages:    null,
  unsubMemberCount: null,
  unsubTyping:      null,
  currentGuildId:   null,
  renderedMsgIds:   new Set(),
  replyToMsgId:     null,
  replyToText:      '',
  typingTimeout:    null,
  expiryTimers:     new Map(),
};
// Batched seenBy queue — collected per render cycle, flushed once with a single update()
const _guildSeenQueue = new Set();
let _guildSeenFlushTimer = null;
function _flushGuildSeen(guildId) {
  if (_guildSeenQueue.size === 0 || !state.currentUser) return;
  const uid = state.currentUser.uid;
  const msgsRef = ref(db, 'guilds/' + guildId + '/messages');
  const updates = {};
  _guildSeenQueue.forEach(function(mid) {
    // Use relative path under the messages node
    updates[mid + '/seenBy/' + uid] = true;
  });
  _guildSeenQueue.clear();
  update(msgsRef, updates).catch(function(){});
}

function getGuildId(skill) {
  return 'guild_' + (skill || 'Explorer').toLowerCase().replace(/[^a-z0-9]/g, '_');
}

function getGuildTTL(type) {
  return GUILD_TTL[type] || GUILD_TTL.text;
}

function isGuildMsgExpired(msg) {
  if (!msg.expiresAt) return false;
  return Date.now() >= msg.expiresAt;
}

function getGuildExpiryInfo(msg) {
  const expiresAt = msg.expiresAt || ((msg.createdAt || msg.timestamp || Date.now()) + getGuildTTL(msg.type || 'text'));
  const remaining = expiresAt - Date.now();
  const ttl = getGuildTTL(msg.type || 'text');
  const pct = Math.max(0, remaining / ttl);
  return { remaining: Math.max(0, remaining), expired: remaining <= 0, pct };
}

function formatGuildExpiry(ms) {
  if (ms <= 0) return 'expired';
  const m = Math.floor(ms / 60000);
  if (m < 1) return '< 1m';
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h';
  return Math.floor(h / 24) + 'd';
}

function formatGuildTime(ts) {
  if (!ts) return '';
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString())
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatGuildDate(ts) {
  if (!ts) return '';
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric',
    year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
}

function initGuildHeader() {
  const skill = state.skill || 'Explorer';
  const guild = GUILD_MAP[skill] || { icon: 'search', name: skill + ' Guild' };
  $('guild-icon').innerHTML = '<i data-lucide="' + guild.icon + '" class="lucide" width="32" height="32"></i>';
  $('guild-name').textContent = guild.name;
  $('guild-sub').textContent = 'Global · ' + skill + ' Community · Ephemeral';
  $('guild-empty-icon').innerHTML = '<i data-lucide="' + guild.icon + '" class="lucide" width="48" height="48"></i>';
  lucide.createIcons({ nodes: [$('guild-icon'), $('guild-empty-icon')] });
}

function cleanupGuildListeners() {
  if (guildState.unsubMessages)    { guildState.unsubMessages();    guildState.unsubMessages = null; }
  if (guildState.unsubMemberCount) { guildState.unsubMemberCount(); guildState.unsubMemberCount = null; }
  if (guildState.unsubTyping)      { guildState.unsubTyping();      guildState.unsubTyping = null; }
  guildState.expiryTimers.forEach(t => clearTimeout(t));
  guildState.expiryTimers.clear();
  guildState.currentGuildId = null;
  guildState.renderedMsgIds = new Set();
  cancelGuildReply();
}

function setGuildReply(mid, text) {
  guildState.replyToMsgId = mid;
  guildState.replyToText  = text;
  const bar  = $('guild-reply-preview');
  const span = $('guild-reply-text');
  if (bar)  bar.classList.add('active');
  if (span) span.textContent = text.slice(0, 80) + (text.length > 80 ? '…' : '');
  $('guild-message-input') && $('guild-message-input').focus();
}

function cancelGuildReply() {
  guildState.replyToMsgId = null;
  guildState.replyToText  = '';
  const bar = $('guild-reply-preview');
  if (bar) bar.classList.remove('active');
}

document.getElementById('guild-reply-cancel') &&
  document.getElementById('guild-reply-cancel').addEventListener('click', cancelGuildReply);

function scrollToGuildMessage(mid) {
  const el = document.getElementById('gm-' + mid);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('highlight-flash');
  setTimeout(() => el.classList.remove('highlight-flash'), 1300);
}

function buildGuildMessage(mid, msg, grouped) {
  const isMe      = msg.senderId === state.currentUser.uid;
  const isDeleted = msg.deleted === true;
  const { remaining, pct } = getGuildExpiryInfo(msg);
  const expiryClass = pct <= 0.10 ? 'crit' : pct <= 0.25 ? 'warn' : 'safe';

  const avatarContent = msg.avatarUrl
    ? '<img src="' + escHtml(msg.avatarUrl) + '" alt="' + escHtml(msg.username) + '" loading="lazy">'
    : escHtml((msg.username || 'U').slice(0, 2).toUpperCase());

  const div = document.createElement('div');
  div.className = 'guild-msg' + (isMe ? ' mine' : '') + (grouped ? ' grouped' : '');
  div.id = 'gm-' + mid;
  div.dataset.senderid = msg.senderId || '';
  div.dataset.mid = mid;

  const replyHtml = (msg.replyToText && msg.replyToMsgId)
    ? '<div class="guild-msg-reply-ctx" data-jumpto="' + escHtml(msg.replyToMsgId) + '">↩ ' + escHtml((msg.replyToText || '').slice(0, 70)) + '</div>'
    : '';

// Build text/media content bubble
  var textHtml;
  if (isDeleted) {
    textHtml = '<div class="guild-msg-deleted"><i data-lucide="trash-2" class="lucide" width="12" height="12"></i> Message deleted</div>';
  } else if (msg.type === 'vault') {
    // vault bubble rendered imperatively — placeholder div, filled after innerHTML set
    textHtml = '<div class="guild-vault-bubble-slot" data-mid="' + escHtml(mid) + '"></div>';
  } else if (msg.type === 'community-post-share') {
    textHtml = '<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-md);padding:12px;max-width:260px;cursor:pointer;" data-comm-share-post="' + escHtml(msg.postId||'') + '" data-comm-share-comm="' + escHtml(msg.communityId||'') + '">' +
      '<div style="font-size:10px;font-family:var(--font-mono);color:var(--muted);margin-bottom:6px;"><i data-lucide="pin" class="lucide" width="10" height="10"></i> Shared from ' + escHtml(msg.communityName||'Community') + '</div>' +
      '<div style="font-size:13px;font-weight:700;color:var(--text);margin-bottom:8px;">' + escHtml(msg.postTitle||'Community Post') + '</div>' +
      '<button style="background:var(--accent);color:#fff;border:none;border-radius:var(--radius-xs);font-size:11px;padding:5px 10px;cursor:pointer;font-family:var(--font-display);">View Post →</button>' +
      '</div>';
  } else if (msg.type === 'image' && msg.dataUrl) {
    textHtml = '<div class="msg-img-wrap" style="max-width:220px;cursor:pointer">' +
      '<img class="msg-img" src="' + escHtml(msg.dataUrl) + '" loading="lazy" style="border-radius:12px;width:100%;max-height:220px;object-fit:cover;display:block">' +
      '<div class="msg-img-overlay"><span><i data-lucide="zoom-in" class="lucide" width="16" height="16"></i></span></div></div>';
  } else if (msg.type === 'file' && msg.dataUrl) {
    textHtml = '<div class="msg-file-bubble">' +
      '<span class="msg-file-icon">' + fileIcon(msg.fileName || '') + '</span>' +
      '<div class="msg-file-info">' +
        '<div class="msg-file-name">' + escHtml(msg.fileName || 'File') + '</div>' +
        '<div class="msg-file-meta"><span>' + formatFileSize(msg.fileSize || 0) + '</span>' +
        '&nbsp;<span class="msg-file-dl" style="cursor:pointer;color:var(--accent2)" data-dl="' + escHtml(msg.dataUrl) + '" data-fn="' + escHtml(msg.fileName || 'file') + '">⬇ Download</span></div>' +
      '</div></div>';
  } else if (msg.type === 'audio' && msg.dataUrl) {
    textHtml = '<div class="msg-audio">' +
      '<button class="audio-play-btn" data-src="' + escHtml(msg.dataUrl) + '">▶</button>' +
      '<div class="audio-info">' +
        '<div class="audio-wave">' +
          [8,14,20,16,24,18,12,22,10,20,16,8].map(function(h) {
            return '<div class="audio-wave-bar" style="height:' + h + 'px;background:var(--accent);opacity:0.6"></div>';
          }).join('') +
        '</div>' +
        '<div class="audio-duration">Voice note</div>' +
      '</div></div>';
  } else {
    textHtml = '<div class="guild-msg-text">' + escHtml(msg.text || '') + '</div>';
  }

const expiryHtml = (isDeleted || expiryClass === 'safe') ? ''
    : '<div class="guild-expiry-badge ' + expiryClass + '"><i data-lucide="hourglass" class="lucide" width="12" height="12"></i> ' + formatGuildExpiry(remaining) + '</div>';
  const GUILD_REACTIONS_LIST = ['👍','❤️','😂','🔥','😮','👏'];
  const reactionPickerHtml =
    '<div class="guild-reaction-picker" id="grp-' + escHtml(mid) + '">' +
      GUILD_REACTIONS_LIST.map(function(em) {
        return '<button class="guild-reaction-opt" data-react="' + em + '" data-mid="' + escHtml(mid) + '">' + em + '</button>';
      }).join('') +
    '</div>';

  const actionHtml = isDeleted ? '' :
    '<div class="guild-msg-actions" style="position:relative">' +
      reactionPickerHtml +
      '<button class="guild-msg-action-btn" data-action="react" data-mid="' + escHtml(mid) + '" title="React"><i data-lucide="smile" class="lucide" width="16" height="16"></i></button>' +
      '<button class="guild-msg-action-btn" data-action="reply" data-mid="' + escHtml(mid) + '" title="Reply">↩</button>' +
      '<button class="guild-msg-action-btn" data-action="dm" data-uid="' + escHtml(msg.senderId) + '" data-uname="' + escHtml(msg.username) + '" title="DM"><i data-lucide="message-circle" class="lucide" width="16" height="16"></i></button>' +
      (isMe ? '<button class="guild-msg-action-btn danger" data-action="delete" data-mid="' + escHtml(mid) + '" title="Delete"><i data-lucide="trash-2" class="lucide" width="16" height="16"></i></button>' : '') +
    '</div>';

div.innerHTML =
    '<div class="guild-msg-avatar" data-uid="' + escHtml(msg.senderId) + '" data-uname="' + escHtml(msg.username) + '" title="DM @' + escHtml(msg.username) + '">' + avatarContent + '</div>' +
    '<div class="guild-msg-body">' +
      '<div class="guild-msg-top">' +
        '<span class="guild-msg-username">@' + escHtml(msg.username || 'anonymous') + '</span>' +
        '<span class="guild-msg-time">' + formatGuildTime(msg.timestamp || msg.createdAt) + '</span>' +
      '</div>' +
      replyHtml +
      textHtml +
      expiryHtml +
      (isMe && !isDeleted ? '<div class="guild-msg-sent-meta"><span class="guild-sent-check">✓✓</span></div>' : '') +
      '<div class="guild-msg-reactions" id="greact-' + escHtml(mid) + '"></div>' +
    '</div>' +
    actionHtml;

  // If vault message — replace placeholder slot with real DOM node
  if (msg.type === 'vault' && !isDeleted) {
    var vaultSlot = div.querySelector('.guild-vault-bubble-slot[data-mid="' + mid + '"]');
    if (vaultSlot) {
      var vaultNode = VaultSystem.buildVaultContent(mid, msg, isMe);
      vaultSlot.parentNode.replaceChild(vaultNode, vaultSlot);
    }
  }

  div.addEventListener('click', function(e) {
    // Reaction emoji clicked inside picker
    const reactOpt = e.target.closest('.guild-reaction-opt[data-react]');
    if (reactOpt) {
      e.stopPropagation();
      var emoji   = reactOpt.dataset.react;
      var rmid    = reactOpt.dataset.mid;
      var gid     = getGuildId(state.skill || 'Explorer');
      var myUid   = state.currentUser.uid;
      var rPath   = 'guilds/' + gid + '/messages/' + rmid + '/reactions/' + myUid;
      get(ref(db, rPath)).then(function(snap) {
        if (snap.exists() && snap.val() === emoji) {
          remove(ref(db, rPath)).catch(function(){});
        } else {
          set(ref(db, rPath), emoji).catch(function(){});
        }
      }).catch(function(){});
      var picker = document.getElementById('grp-' + rmid);
      if (picker) picker.classList.remove('open');
      return;
    }

    // Action button clicked
    const btn = e.target.closest('[data-action]');
    if (btn) {
      e.stopPropagation();
      const action = btn.dataset.action;
      if (action === 'react') {
        // Close all other pickers first
        document.querySelectorAll('.guild-reaction-picker.open').forEach(function(p) {
          if (p.id !== 'grp-' + btn.dataset.mid) p.classList.remove('open');
        });
        var picker = document.getElementById('grp-' + btn.dataset.mid);
        if (picker) {
          picker.classList.toggle('open');
          // Boundary detection — run after display so we can measure
          if (picker.classList.contains('open')) {
            requestAnimationFrame(function() {
              var rect = picker.getBoundingClientRect();
              var vw = window.innerWidth;
              var vh = window.innerHeight;
              // Reset flip classes first
              picker.classList.remove('flip-left', 'flip-right', 'flip-up');
              // Too far right → flip left
              if (rect.right > vw - 8) picker.classList.add('flip-left');
              // Too far left → flip right
              else if (rect.left < 8) picker.classList.add('flip-right');
              // Too high (goes above screen) → flip downward
              if (rect.top < 8) picker.classList.add('flip-up');
            });
          }
        }
        return;
      }
      if (action === 'reply')  setGuildReply(btn.dataset.mid, msg.text || '');
      if (action === 'delete') deleteGuildMessage(btn.dataset.mid);
      if (action === 'dm')     openGuildDM(btn.dataset.uid, btn.dataset.uname);
      return;
    }

    // Audio play button
    const playBtn = e.target.closest('.audio-play-btn[data-src]');
    if (playBtn) {
      var audio = new Audio(playBtn.dataset.src);
      audio.play().catch(function(){});
      playBtn.innerHTML = '<i data-lucide="pause" class="lucide" width="16" height="16"></i>';
      audio.onended = function() { playBtn.textContent = '▶'; };
      return;
    }

    // File download
    const dlBtn = e.target.closest('[data-dl]');
    if (dlBtn) {
      downloadBase64(dlBtn.dataset.dl, dlBtn.dataset.fn);
      return;
    }

    // Image lightbox
    const imgEl = e.target.closest('.msg-img');
    if (imgEl) {
      const lb = document.getElementById('lightbox');
      if (lb) { document.getElementById('lightbox-img').src = imgEl.src; lb.classList.add('active'); }
      return;
    }

    // Avatar / username → open full profile sheet
    const av = e.target.closest('.guild-msg-avatar[data-uid]');
    const uspan = e.target.closest('.guild-msg-username');
    if ((av || uspan) && msg.senderId !== state.currentUser?.uid) {
      const tUid = av ? av.dataset.uid : msg.senderId;
      const tName = av ? av.dataset.uname : (msg.username || '');
      const cached = state.usersCache?.get(tUid) || {};
      openUserProfileSheet(tUid, tName, cached.skill||'Explorer', cached.level||'Beginner', cached.points||0, cached.pfpUrl||'', cached.bio||'', cached.expertise||null, cached.socialIntegrations||null);
      return;
    }

    // Reply jump
    const ctx = e.target.closest('.guild-msg-reply-ctx[data-jumpto]');
    if (ctx) scrollToGuildMessage(ctx.dataset.jumpto);
  });
  return div;
}

function openGuildDM(uid, username) {
  if (!uid || uid === state.currentUser.uid) return;
  const cached  = state.usersCache.get(uid);
  const skill   = cached && cached.skill  ? cached.skill  : 'Explorer';
  const level   = cached && cached.level  ? cached.level  : 'Beginner';
  const points  = cached && cached.points ? cached.points : 0;
  $$('.nav-btn').forEach(function(b) { b.classList.remove('active'); });
  var nc = document.getElementById('nav-chat');
  if (nc) nc.classList.add('active');
  openChat(uid, username, skill, level, points);
}

async function deleteGuildMessage(mid) {
  if (!mid || !state.currentUser) return;
  const guildId = getGuildId(state.skill || 'Explorer');
  try {
    // Check if anyone else has seen this message
    const msgSnap = await get(ref(db, 'guilds/' + guildId + '/messages/' + mid));
    if (!msgSnap.exists()) return;
    const msgData = msgSnap.val();
    const seenBy = msgData.seenBy || {};
    const seenByOthers = Object.keys(seenBy).some(function(uid) {
      return uid !== state.currentUser.uid;
    });
    if (seenByOthers) {
      // At least one other person saw it — show "Message deleted" tombstone
      await update(ref(db, 'guilds/' + guildId + '/messages/' + mid), { deleted: true, text: '' });
    } else {
      // Nobody else saw it — silently remove from database
      await remove(ref(db, 'guilds/' + guildId + '/messages/' + mid));
      const el = document.getElementById('gm-' + mid);
      if (el) {
        el.style.transition = 'opacity 0.25s, transform 0.25s';
        el.style.opacity = '0';
        el.style.transform = 'translateX(10px)';
        setTimeout(function() { el.remove(); }, 280);
      }
      guildState.renderedMsgIds.delete(mid);
    }
  } catch (err) {
    Toast.error('Could not delete message');
  }
}

function scheduleGuildExpiry(mid, msg, guildId) {
  if (guildState.expiryTimers.has(mid)) {
    clearTimeout(guildState.expiryTimers.get(mid));
    guildState.expiryTimers.delete(mid);
  }
  const { remaining, expired } = getGuildExpiryInfo(msg);
  if (expired) {
    remove(ref(db, 'guilds/' + guildId + '/messages/' + mid)).catch(function(){});
    const el = document.getElementById('gm-' + mid);
    if (el) el.remove();
    guildState.renderedMsgIds.delete(mid);
    return;
  }
  const handle = setTimeout(async function() {
    try { await remove(ref(db, 'guilds/' + guildId + '/messages/' + mid)); } catch(e) {}
    const el = document.getElementById('gm-' + mid);
    if (el) {
      el.style.transition = 'opacity 0.4s, transform 0.4s';
      el.style.opacity = '0';
      el.style.transform = 'translateX(-10px)';
      setTimeout(function() { el.remove(); }, 420);
    }
    guildState.renderedMsgIds.delete(mid);
    guildState.expiryTimers.delete(mid);
  }, remaining);
  guildState.expiryTimers.set(mid, handle);
}

async function purgeExpiredGuildMessages(guildId) {
  try {
    const snap = await get(ref(db, 'guilds/' + guildId + '/messages'));
    if (!snap.exists()) return;
    const msgs = snap.val();
    const now  = Date.now();
    const updates = {};
    Object.entries(msgs).forEach(function([mid, msg]) {
      if (msg.expiresAt && now >= msg.expiresAt) updates[mid] = null;
    });
    if (Object.keys(updates).length > 0)
      await update(ref(db, 'guilds/' + guildId + '/messages'), updates);
  } catch(e) {}
}

function loadGuildMessages(guildId) {
  const wrap    = document.getElementById('guild-msgs-wrap');
  const loading = document.getElementById('guild-loading');
  const empty   = document.getElementById('guild-empty');
  const skelEl  = document.getElementById('guild-skel-msgs');

  if (loading) loading.style.display = 'none';
  if (skelEl)  skelEl.style.display  = 'flex'; // show skeleton
  if (empty)   empty.style.display   = 'none';

  Array.from(wrap.children).forEach(function(el) {
    if (el.id !== 'guild-loading' && el.id !== 'guild-empty' && el.id !== 'guild-skel-msgs') el.remove();
  });

  purgeExpiredGuildMessages(guildId);

  const msgsRef = ref(db, 'guilds/' + guildId + '/messages');
  let initialLoad = true;
  let prevDate = '';

  guildState.unsubMessages = onValue(msgsRef, function(snap) {
    if (loading) loading.style.display = 'none';
    // Remove skeleton on first data
    const skelEl = document.getElementById('guild-skel-msgs');
    if (skelEl) skelEl.style.display = 'none';
    const msgs = snap.val();

    if (!msgs || Object.keys(msgs).length === 0) {
      if (empty) empty.style.display = 'flex';
      initialLoad = false;
      return;
    }
    if (empty) empty.style.display = 'none';

    const now = Date.now();
    const entries = Object.entries(msgs)
      .filter(function([, msg]) { return !msg.expiresAt || now < msg.expiresAt; })
      .sort(function(a, b) {
        return ((a[1].timestamp || a[1].createdAt || 0) - (b[1].timestamp || b[1].createdAt || 0));
      });

    const currentIds = new Set(entries.map(function([mid]) { return mid; }));
    for (const mid of guildState.renderedMsgIds) {
      if (!currentIds.has(mid)) {
        const el = document.getElementById('gm-' + mid);
        if (el) el.remove();
        guildState.renderedMsgIds.delete(mid);
        if (guildState.expiryTimers.has(mid)) {
          clearTimeout(guildState.expiryTimers.get(mid));
          guildState.expiryTimers.delete(mid);
        }
      }
    }

    const visible = entries.slice(-100);

    visible.forEach(function([mid, msg], idx) {
      const ts = msg.timestamp || msg.createdAt || 0;
      const ds = formatGuildDate(ts);

      if (!guildState.renderedMsgIds.has(mid)) {
        if (ds && ds !== prevDate) {
          const sepId = 'gmsep-' + ds.replace(/\s+/g, '-');
          if (!document.getElementById(sepId)) {
            const sep = document.createElement('div');
            sep.className = 'guild-date-sep';
            sep.id = sepId;
            sep.textContent = ds;
            wrap.appendChild(sep);
          }
          prevDate = ds;
        }

        const prevMsg = idx > 0 ? visible[idx - 1][1] : null;
        const sameGroup = prevMsg
          && prevMsg.senderId === msg.senderId
          && (ts - (prevMsg.timestamp || prevMsg.createdAt || 0)) < 3 * 60 * 1000;

        const el = buildGuildMessage(mid, msg, sameGroup);
        wrap.appendChild(el);
        guildState.renderedMsgIds.add(mid);
        scheduleGuildExpiry(mid, msg, guildId);
        // Track which guild messages need seenBy — batched below, not one write per msg
        if (msg.senderId !== state.currentUser.uid) {
          _guildSeenQueue.add(mid);
        }
} else {
        const existing = document.getElementById('gm-' + mid);
        if (existing && msg.deleted) {
          const textEl = existing.querySelector('.guild-msg-text, .msg-img-wrap, .msg-file-bubble, .msg-audio, .msg-vault-bubble');
          if (textEl && !existing.querySelector('.guild-msg-deleted')) {
            textEl.outerHTML = '<div class="guild-msg-deleted"><i data-lucide="trash-2" class="lucide" width="12" height="12"></i> Message deleted</div>';
          }
          const actions = existing.querySelector('.guild-msg-actions');
          if (actions) actions.remove();
          const sentMeta = existing.querySelector('.guild-msg-sent-meta');
          if (sentMeta) sentMeta.remove();
        }
        // Always update reactions live for all users
        if (existing) {
          var reactWrap = document.getElementById('greact-' + mid);
          if (reactWrap) {
            if (msg.reactions && typeof msg.reactions === 'object') {
              var counts = {};
              Object.entries(msg.reactions).forEach(function([uid, emoji]) {
                if (!counts[emoji]) counts[emoji] = { count: 0, mine: false };
                counts[emoji].count++;
                if (uid === state.currentUser.uid) counts[emoji].mine = true;
              });
              reactWrap.innerHTML = Object.entries(counts).map(function([emoji, data]) {
                return '<span class="guild-reaction-chip' + (data.mine ? ' mine' : '') + '">' +
                  emoji + ' <span class="rc-count">' + data.count + '</span></span>';
              }).join('');
            } else {
              reactWrap.innerHTML = '';
            }
          }
        }
      }
    });

    const nearBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 120;
    if (initialLoad || nearBottom) {
      requestAnimationFrame(function() { requestAnimationFrame(function() { wrap.scrollTop = wrap.scrollHeight; }); });
    }
    initialLoad = false;

    lucideCreate();


    // Flush batched seenBy writes — single update() instead of one per message
    if (_guildSeenQueue.size > 0) {
      clearTimeout(_guildSeenFlushTimer);
      _guildSeenFlushTimer = setTimeout(function() { _flushGuildSeen(guildId); }, 800);
    }
  });
}

function setupGuildTyping(guildId) {
  guildState.unsubTyping = onValue(ref(db, 'guilds/' + guildId + '/typing'), function(snap) {
    const typing = snap.val() || {};
    const others = Object.entries(typing).filter(function([uid, v]) {
      return uid !== state.currentUser.uid && v.active === true && (Date.now() - (v.at || 0)) < 4000;
    });

    const dots  = document.getElementById('guild-typing-dots');
    const label = document.getElementById('guild-typing-label');
    if (!dots || !label) return;

    if (others.length > 0) {
      const names = others.map(function([, v]) { return '@' + (v.username || 'someone'); });
      const txt = names.length === 1 ? (names[0] + ' is typing…')
                : names.length === 2 ? (names[0] + ' & ' + names[1] + ' are typing…')
                : (names.length + ' people are typing…');
      dots.style.display  = 'inline-flex';
      label.style.display = 'inline';
      label.textContent   = txt;
      const wrap = document.getElementById('guild-msgs-wrap');
      if (wrap && wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 120) {
        requestAnimationFrame(function() { requestAnimationFrame(function() { wrap.scrollTop = wrap.scrollHeight; }); });
      }
    } else {
      dots.style.display  = 'none';
      label.style.display = 'none';
      label.textContent   = '';
    }
  });
}

function sendGuildTypingSignal(guildId) {
  if (!state.currentUser || !guildId) return;
  update(ref(db, 'guilds/' + guildId + '/typing/' + state.currentUser.uid), {
    active: true, at: Date.now(), username: state.username || 'someone'
  }).catch(function(){});
  clearTimeout(guildState.typingTimeout);
  guildState.typingTimeout = setTimeout(function() {
    update(ref(db, 'guilds/' + guildId + '/typing/' + state.currentUser.uid), {
      active: false, at: Date.now()
    }).catch(function(){});
  }, 3000);
}

function loadGuildMemberCount(skill) {
  // Use orderByChild/equalTo to fetch ONLY users of this skill — avoids downloading entire users tree
  const skillUsersRef = query(ref(db, 'users'), orderByChild('skill'), equalTo(skill));
  guildState.unsubMemberCount = onValue(skillUsersRef, function(snap) {
    const users = snap.val();
    if (!users) { document.getElementById('guild-online-count').textContent = '0 online'; return; }
    let online = 0, total = 0;
    Object.values(users).forEach(function(u) {
      total++;
      if (isUserTrulyOnline(u)) online++;
    });
    document.getElementById('guild-online-count').textContent = online + ' online · ' + total + ' members';
  });
}

function openGuild() {
  const skill   = state.skill || 'Explorer';
  const guildId = getGuildId(skill);
  if (guildState.currentGuildId !== guildId) {
    cleanupGuildListeners();
    guildState.currentGuildId = guildId;
    initGuildHeader();
    loadGuildMessages(guildId);
    loadGuildMemberCount(skill);
    setupGuildTyping(guildId);
  }
  ScreenManager.show('guild-screen');
}

// ── Guild message rate limit: max 20 messages per minute ──
const _guildRateLimit = { count: 0, windowStart: 0, MAX: 20, WINDOW_MS: 60 * 1000 };
function checkGuildRateLimit() {
  const now = Date.now();
  if (now - _guildRateLimit.windowStart > _guildRateLimit.WINDOW_MS) {
    _guildRateLimit.count = 0; _guildRateLimit.windowStart = now;
  }
  if (_guildRateLimit.count >= _guildRateLimit.MAX) {
    Toast.error('Slow down — too many messages. Wait a moment.');
    return false;
  }
  _guildRateLimit.count++;
  return true;
}

async function sendGuildMessage() {
  const input = document.getElementById('guild-message-input');
  const text  = (input && input.value || '').trim();
  if (!text || !state.currentUser) return;
  if (state.isMuted) { Toast.error('You are muted and cannot send messages.'); return; }
  if (!checkGuildRateLimit()) return;

  const skill   = state.skill || 'Explorer';
  const guildId = getGuildId(skill);
  const now     = Date.now();

  const btn = document.getElementById('guild-send-btn');
  if (btn) btn.disabled = true;
  input.value = '';
  input.style.height = 'auto';

  clearTimeout(guildState.typingTimeout);
  update(ref(db, 'guilds/' + guildId + '/typing/' + state.currentUser.uid), {
    active: false, at: Date.now()
  }).catch(function(){});

  const msgData = {
    text:      text,
    senderId:  state.currentUser.uid,
    username:  state.username || 'anonymous',
    skill:     skill,
    avatarUrl: state.pfpUrl || '',
    type:      'text',
    createdAt: now,
    timestamp: now,
    expiresAt: now + GUILD_TTL.text,
  };

  if (guildState.replyToMsgId) {
    msgData.replyToMsgId = guildState.replyToMsgId;
    msgData.replyToText  = guildState.replyToText;
    cancelGuildReply();
  }

  try {
    await push(ref(db, 'guilds/' + guildId + '/messages'), msgData);
  } catch (err) {
    Toast.error('Could not send message');
    input.value = text;
  } finally {
    updateGuildSendBtn();
  }
}

function updateGuildSendBtn() {
  const input = document.getElementById('guild-message-input');
  const btn   = document.getElementById('guild-send-btn');
  if (!input || !btn) return;
  btn.disabled = input.value.trim().length === 0;
}

const guildInput = document.getElementById('guild-message-input');
if (guildInput) {
  guildInput.addEventListener('input', function() {
    guildInput.style.height = 'auto';
    guildInput.style.height = Math.min(guildInput.scrollHeight, 100) + 'px';
    updateGuildSendBtn();
    if (guildState.currentGuildId) sendGuildTypingSignal(guildState.currentGuildId);
  });
  guildInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendGuildMessage(); }
    if (e.key === 'Escape') cancelGuildReply();
  });
}

var guildSendBtn = document.getElementById('guild-send-btn');
if (guildSendBtn) guildSendBtn.addEventListener('click', sendGuildMessage);
// Close reaction pickers when clicking anywhere outside
document.addEventListener('click', function() {
  document.querySelectorAll('.guild-reaction-picker.open').forEach(function(p) {
    p.classList.remove('open');
  });
});

// ── Guild Image Send ──
var guildImgBtn   = document.getElementById('guild-img-btn');
var guildImgInput = document.getElementById('guild-image-input');
if (guildImgBtn && guildImgInput) {
  guildImgBtn.addEventListener('click', function() { guildImgInput.click(); });
  guildImgInput.addEventListener('change', async function() {
    var f = guildImgInput.files[0];
    if (!f) return;
    guildImgInput.value = '';
    try {
      var result = await compressImage(f);
      var guildId = getGuildId(state.skill || 'Explorer');
      var now = Date.now();
      await push(ref(db, 'guilds/' + guildId + '/messages'), {
        type: 'image', dataUrl: result.dataUrl,
        senderId: state.currentUser.uid, username: state.username || 'anonymous',
        skill: state.skill || 'Explorer', avatarUrl: state.pfpUrl || '',
        text: '', createdAt: now, timestamp: now, expiresAt: now + GUILD_TTL.image
      });
    } catch(err) { Toast.error('Could not send image: ' + (err.message || '')); }
  });
}

// ── Guild File Send ──
var guildFileBtn   = document.getElementById('guild-file-btn');
var guildFileInput = document.getElementById('guild-file-input');
if (guildFileBtn && guildFileInput) {
  guildFileBtn.addEventListener('click', function() { guildFileInput.click(); });
  guildFileInput.addEventListener('change', async function() {
    var f = guildFileInput.files[0];
    if (!f) return;
    guildFileInput.value = '';
    try {
      var dataUrl = await fileToBase64(f);
      var guildId = getGuildId(state.skill || 'Explorer');
      var now = Date.now();
      await push(ref(db, 'guilds/' + guildId + '/messages'), {
        type: 'file', dataUrl: dataUrl, fileName: f.name, fileSize: f.size,
        senderId: state.currentUser.uid, username: state.username || 'anonymous',
        skill: state.skill || 'Explorer', avatarUrl: state.pfpUrl || '',
        text: '', createdAt: now, timestamp: now, expiresAt: now + GUILD_TTL.file
      });
    } catch(err) { Toast.error('Could not send file: ' + (err.message || '')); }
  });
}

// ── Guild Voice Message ──
var guildVoiceBtn = document.getElementById('guild-voice-btn');
var guildMediaRecorder = null;
var guildAudioChunks = [];
var guildIsRecording = false;
if (guildVoiceBtn) {
  guildVoiceBtn.addEventListener('click', async function() {
    if (!guildIsRecording) {
      try {
        var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        guildAudioChunks = [];
        guildMediaRecorder = new MediaRecorder(stream);
        guildMediaRecorder.ondataavailable = function(e) {
          if (e.data && e.data.size > 0) guildAudioChunks.push(e.data);
        };
        guildMediaRecorder.onstop = async function() {
          var blob = new Blob(guildAudioChunks, { type: 'audio/webm' });
          stream.getTracks().forEach(function(t) { t.stop(); });
          guildVoiceBtn.classList.remove('guild-voice-btn-recording');
          guildVoiceBtn.innerHTML = '<i data-lucide="mic" class="lucide" width="17" height="17"></i>';
          lucideCreate();

          try {
            var dataUrl = await audioToBase64(blob);
            var guildId = getGuildId(state.skill || 'Explorer');
            var now = Date.now();
            await push(ref(db, 'guilds/' + guildId + '/messages'), {
              type: 'audio', dataUrl: dataUrl, duration: 0,
              senderId: state.currentUser.uid, username: state.username || 'anonymous',
              skill: state.skill || 'Explorer', avatarUrl: state.pfpUrl || '',
              text: '', createdAt: now, timestamp: now, expiresAt: now + GUILD_TTL.voice
            });
          } catch(err) { Toast.error('Could not send voice message'); }
        };
        guildMediaRecorder.start();
        guildIsRecording = true;
        guildVoiceBtn.classList.add('guild-voice-btn-recording');
        guildVoiceBtn.innerHTML = '<i data-lucide="square" class="lucide" width="16" height="16"></i>';
        Toast.info('Recording... tap again to stop');
      } catch(err) {
        Toast.error('Microphone access denied');
      }
    } else {
      if (guildMediaRecorder && guildMediaRecorder.state !== 'inactive') {
        guildMediaRecorder.stop();
      }
      guildIsRecording = false;
    }
  });
}

var navGuild = document.getElementById('nav-guild');
if (navGuild) {
  navGuild.addEventListener('click', function() {
    document.querySelectorAll('.nav-btn').forEach(function(b) { b.classList.remove('active'); });
    navGuild.classList.add('active');
    openGuild();
  });
}



// ── Export to window ──
Object.assign(window, { cleanupGuildListeners });
