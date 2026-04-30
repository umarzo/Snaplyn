const { state, $, $$, escHtml, badgeHTML, generateAvatarUrl, timeAgo, debounce,
  compressImage, fileToBase64,
  db, ref, get, set, onValue, onChildAdded, push, serverTimestamp,
  onDisconnect, update, off, remove, limitToLast,
  CONFIG, Toast, ScreenManager, ConfirmModal,
  openUserProfileSheet, cacheUser, getUserCached } = window;

/* ═══════════════════════════════════════════════════════════
   ROOMS SYSTEM
   ═══════════════════════════════════════════════════════════ */
const RoomSystem = {
  // ── State ──
  currentRoomId: null,
  currentRoomData: null,
  unsubRoomMessages: null,
  unsubRoomTyping: null,
  unsubRoomKick: null,
  roomTypingTimeout: null,
  _pendingInviteRoomId: null,
  roomTags: [],
  _renderedRoomMsgIds: new Set(),
  _lastRoomMsgDate: null,

  /* ─────────────────────────────────────────────
     INITIALIZE — Wire up all event listeners
  ───────────────────────────────────────────── */
  init() {
    // Nav button
    const navRoomsBtn = $('nav-rooms');
    if (navRoomsBtn) {
      navRoomsBtn.addEventListener('click', () => {
        ScreenManager.show('rooms-screen');
        this.loadPublicRooms();
        this.loadMyRooms();
      });
    }

    // Create a Room button (from Rooms screen)
    const createBtn = $('rooms-create-btn');
    if (createBtn) {
      createBtn.addEventListener('click', () => {
        this.openCreateScreen();
      });
    }

    // Back from Room Creation
    const createBack = $('room-create-back');
    if (createBack) {
      createBack.addEventListener('click', () => {
        ScreenManager.show('rooms-screen');
        this.loadPublicRooms();
        this.loadMyRooms();
      });
    }

    // Back from Room Chat
    const chatBack = $('room-chat-back');
    if (chatBack) {
      chatBack.addEventListener('click', () => {
        this.leaveRoomChat();
        ScreenManager.show('rooms-screen');
        this.loadPublicRooms();
        this.loadMyRooms();
      });
    }

    // Room Type selector cards
    const typePublic = $('room-type-public');
    const typePrivate = $('room-type-private');
    if (typePublic && typePrivate) {
      typePublic.addEventListener('click', () => {
        typePublic.classList.add('selected');
        typePrivate.classList.remove('selected');
        $('room-type-value').value = 'public';
      });
      typePrivate.addEventListener('click', () => {
        typePrivate.classList.add('selected');
        typePublic.classList.remove('selected');
        $('room-type-value').value = 'private';
      });
    }

    // Entry Type selector cards
    const entrySingle = $('room-entry-single');
    const entryMulti = $('room-entry-multi');
    if (entrySingle && entryMulti) {
      entrySingle.addEventListener('click', () => {
        entrySingle.classList.add('selected');
        entryMulti.classList.remove('selected');
        $('room-entry-value').value = 'single';
      });
      entryMulti.addEventListener('click', () => {
        entryMulti.classList.add('selected');
        entrySingle.classList.remove('selected');
        $('room-entry-value').value = 'multi';
      });
    }

    // Tag manager for Room creation
    const roomTagInput = $('room-tag-input');
    const roomTagAdd = $('room-tag-add');
    if (roomTagInput && roomTagAdd) {
      roomTagAdd.addEventListener('click', () => this.addRoomTag());
      roomTagInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this.addRoomTag(); }
      });
    }

    // Submit room creation
    const submitBtn = $('room-create-submit-btn');
    if (submitBtn) {
      submitBtn.addEventListener('click', () => this.createRoom());
    }

    // Room image button
    const roomImgBtn = $('room-img-btn');
    const roomImageInput = $('room-image-input');
    if (roomImgBtn && roomImageInput) {
      roomImgBtn.addEventListener('click', () => roomImageInput.click());
      roomImageInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        roomImageInput.value = '';
        if (!file.type.startsWith('image/')) { Toast.error('Please select an image'); return; }
        Toast.info('Compressing image...');
        try {
          const result = await compressImage(file);
          await push(ref(db, `rooms/${this.currentRoomId}/messages`), {
            senderId: state.currentUser.uid,
            senderUsername: state.username || 'Unknown',
            senderPfp: state.pfpUrl || null,
            type: 'image',
            dataUrl: result.dataUrl,
            timestamp: serverTimestamp(),
          });
        } catch (err) { Toast.error(err.message || 'Could not send image'); }
      });
    }

    // Room voice recording
    const roomVoiceBtn = $('room-voice-btn');
    const roomRecBar = $('room-recording-bar');
    const roomRecTimer = $('room-rec-timer');
    const roomRecCancel = $('room-rec-cancel');
    const roomRecSend = $('room-rec-send');
    let roomMediaRecorder = null;
    let roomAudioChunks = [];
    let roomRecInterval = null;
    let roomRecSeconds = 0;
    let _roomRecCancelled = false;

    const stopRoomRecording = () => {
      if (roomMediaRecorder && roomMediaRecorder.state !== 'inactive') roomMediaRecorder.stop();
      clearInterval(roomRecInterval);
      if (roomRecBar) roomRecBar.style.display = 'none';
      roomRecSeconds = 0;
      if (roomRecTimer) roomRecTimer.textContent = '0:00';
    };

    if (roomVoiceBtn) {
      roomVoiceBtn.addEventListener('click', async () => {
        if (roomMediaRecorder && roomMediaRecorder.state === 'recording') return;
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          roomMediaRecorder = new MediaRecorder(stream);
          roomAudioChunks = [];
          _roomRecCancelled = false;
          roomMediaRecorder.ondataavailable = e => { if (e.data.size > 0) roomAudioChunks.push(e.data); };
          roomMediaRecorder.onstop = async () => {
            stream.getTracks().forEach(t => t.stop());
            if (_roomRecCancelled || roomAudioChunks.length === 0) {
              roomAudioChunks = [];
              return;
            }
            const blob = new Blob(roomAudioChunks, { type: 'audio/webm' });
            try {
              const dataUrl = await audioToBase64(blob);
              await push(ref(db, `rooms/${this.currentRoomId}/messages`), {
                senderId: state.currentUser.uid,
                senderUsername: state.username || 'Unknown',
                senderPfp: state.pfpUrl || null,
                type: 'audio',
                dataUrl,
                timestamp: serverTimestamp(),
              });
            } catch (err) { Toast.error(err.message || 'Could not send voice note'); }
          };
          roomMediaRecorder.start();
          if (roomRecBar) roomRecBar.style.display = 'flex';
          roomRecSeconds = 0;
          roomRecInterval = setInterval(() => {
            roomRecSeconds++;
            const m = Math.floor(roomRecSeconds / 60);
            const s = roomRecSeconds % 60;
            if (roomRecTimer) roomRecTimer.textContent = `${m}:${s.toString().padStart(2,'0')}`;
            if (roomRecSeconds >= 60) { Toast.info('Max 60s reached'); stopRoomRecording(); }
          }, 1000);
        } catch (err) { Toast.error('Microphone access denied'); }
      });
    }
    if (roomRecCancel) roomRecCancel.addEventListener('click', () => { _roomRecCancelled = true; roomAudioChunks = []; stopRoomRecording(); });
    if (roomRecSend) roomRecSend.addEventListener('click', stopRoomRecording);

    // Room message input (auto-grow + enable send)
    const roomMsgInput = $('room-message-input');
    const roomSendBtn = $('room-send-btn');
    if (roomMsgInput) {
      roomMsgInput.addEventListener('input', () => {
        // Auto-grow
        roomMsgInput.style.height = 'auto';
        roomMsgInput.style.height = Math.min(roomMsgInput.scrollHeight, 120) + 'px';
        // Enable/disable send
        if (roomSendBtn) {
          roomSendBtn.disabled = !roomMsgInput.value.trim();
        }
        // Typing indicator
        this.sendRoomTyping();
      });
      roomMsgInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          this.sendRoomMessage();
        }
      });
    }
    if (roomSendBtn) {
      roomSendBtn.addEventListener('click', () => this.sendRoomMessage());
    }

    // Admin panel open/close
    const adminBtn = $('room-admin-btn');
    const adminPanel = $('room-admin-panel');
    const adminOverlay = $('room-admin-panel-overlay');
    const adminClose = $('room-admin-panel-close');

    if (adminBtn) {
      adminBtn.addEventListener('click', () => {
        adminPanel.classList.add('open');
        adminOverlay.classList.add('open');
        this.loadAdminPanel();
      });
    }
    if (adminClose) {
      adminClose.addEventListener('click', () => this.closeAdminPanel());
    }
    if (adminOverlay) {
      adminOverlay.addEventListener('click', () => this.closeAdminPanel());
    }

    // Copy invite link
    const copyInviteBtn = $('room-copy-invite-btn');
    if (copyInviteBtn) {
      copyInviteBtn.addEventListener('click', () => {
        const link = $('room-invite-link-text')?.textContent;
        if (link && link !== '—') {
          navigator.clipboard.writeText(link).then(() => Toast.success('Invite link copied!'))
            .catch(() => Toast.info('Could not copy'));
        }
      });
    }

    // Delete room (admin only)
    const deleteBtn = $('room-delete-btn');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', () => this.deleteRoom());
    }

    // Check if URL has ?room= param (invite link)
    this.checkRoomInviteLink();
  },

  /* ─────────────────────────────────────────────
     OPEN CREATE SCREEN
  ───────────────────────────────────────────── */
  openCreateScreen() {
    // Reset form
    const nameInput = $('room-name-input');
    const descInput = $('room-desc-input');
    const maxInput = $('room-max-input');
    const tagsWrap = $('room-tags-wrap');
    const tagInput = $('room-tag-input');

    if (nameInput) nameInput.value = '';
    if (descInput) descInput.value = '';
    if (maxInput) maxInput.value = '';
    if (tagsWrap) tagsWrap.innerHTML = '';
    if (tagInput) tagInput.value = '';
    this.roomTags = [];

    // Reset type cards to defaults
    $('room-type-public')?.classList.add('selected');
    $('room-type-private')?.classList.remove('selected');
    $('room-type-value') && ($('room-type-value').value = 'public');
    $('room-entry-single')?.classList.add('selected');
    $('room-entry-multi')?.classList.remove('selected');
    $('room-entry-value') && ($('room-entry-value').value = 'single');

    const errEl = $('room-name-error');
    if (errEl) errEl.style.display = 'none';

    ScreenManager.show('room-create-screen');
  },

  /* ─────────────────────────────────────────────
     TAG MANAGER (Room creation)
  ───────────────────────────────────────────── */
  addRoomTag() {
    const input = $('room-tag-input');
    if (!input) return;
    const raw = input.value.trim();
    const v = raw.replace(/[^a-zA-Z0-9 \-_.+#]/g, '').trim().slice(0, 20);
    if (!v) return;
    if (this.roomTags.map(t => t.toLowerCase()).includes(v.toLowerCase())) {
      Toast.info('Tag already added'); return;
    }
    if (this.roomTags.length >= 8) { Toast.info('Max 8 tags'); return; }
    this.roomTags.push(v);
    input.value = '';
    this._renderRoomTags();
  },

  _renderRoomTags() {
    const wrap = $('room-tags-wrap');
    if (!wrap) return;
    wrap.innerHTML = '';
    this.roomTags.forEach((t, i) => {
      const el = document.createElement('div');
      el.className = 'skill-tag';
      el.innerHTML = `${escHtml(t)}<span class="tag-remove"><i data-lucide="x" class="lucide" width="10" height="10"></i></span>`;
      el.querySelector('.tag-remove').addEventListener('click', () => {
        this.roomTags.splice(i, 1);
        this._renderRoomTags();
      });
      wrap.appendChild(el);
    });
  },

  /* ─────────────────────────────────────────────
     CREATE A ROOM (Firebase write)
  ───────────────────────────────────────────── */
  async createRoom() {
    if (!state.currentUser) { Toast.error('Not logged in'); return; }

    const nameInput = $('room-name-input');
    const descInput = $('room-desc-input');
    const typeVal = $('room-type-value')?.value || 'public';
    const entryVal = $('room-entry-value')?.value || 'single';
    const maxInput = $('room-max-input');
    const nameErr = $('room-name-error');

    const name = nameInput?.value.trim();
    if (!name) {
      if (nameErr) nameErr.style.display = 'block';
      nameInput?.focus();
      return;
    }
    if (nameErr) nameErr.style.display = 'none';

    const desc = descInput?.value.trim() || '';
    const maxMembers = maxInput?.value ? parseInt(maxInput.value, 10) : null;

    const submitBtn = $('room-create-submit-btn');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<i data-lucide="loader" class="lucide" width="16" height="16"></i> Creating...'; }

    try {
      const roomRef = ref(db, 'rooms');
      const newRoomRef = await push(roomRef, {
        name,
        purpose: desc,
        type: typeVal,
        entryType: entryVal,
        tags: this.roomTags.length ? this.roomTags : null,
        maxMembers: maxMembers || null,
        ownerId: state.currentUser.uid,
        ownerUsername: state.username || 'Unknown',
        members: { [state.currentUser.uid]: { role: 'owner', joinedAt: Date.now() } },
        createdAt: serverTimestamp(),
        memberCount: 1,
      });

      Toast.success('Room created!');
      // Navigate into room immediately
      const newRoomId = newRoomRef.key;
      await this.openRoom(newRoomId);
    } catch (e) {
      DEBUG && console.error('[Rooms] Create failed:', e);
      Toast.error('Could not create room. Try again.');
    } finally {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<i data-lucide="home" class="lucide" width="16" height="16"></i> Create My Room'; }
    }
  },

  /* ─────────────────────────────────────────────
     LOAD PUBLIC ROOMS
  ───────────────────────────────────────────── */
  async loadPublicRooms() {
    const listEl = $('public-rooms-list');
    if (!listEl) return;

    // Skeleton is already rendered in HTML (rooms-skel-wrap); no need to inject a spinner

    try {
      const snap = await get(ref(db, 'rooms'));
      // Always clear skeleton + any stale content first
      listEl.innerHTML = '';
      if (!snap.exists()) {
        listEl.innerHTML = `<div class="rooms-empty">
          <div class="rooms-empty-icon"><i data-lucide="home" class="lucide" width="48" height="48"></i></div>
          <div class="rooms-empty-text">No public rooms yet</div>
          <div class="rooms-empty-sub">Be the first to create one!</div>
        </div>`;
        return;
      }

      const rooms = [];
      snap.forEach(child => {
        const d = child.val();
        if (d.type === 'public') {
          rooms.push({ id: child.key, ...d });
        }
      });

      if (rooms.length === 0) {
        listEl.innerHTML = `<div class="rooms-empty">
          <div class="rooms-empty-icon"><i data-lucide="home" class="lucide" width="48" height="48"></i></div>
          <div class="rooms-empty-text">No public rooms yet</div>
          <div class="rooms-empty-sub">Be the first to create one!</div>
        </div>`;
        return;
      }

      rooms.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      listEl.innerHTML = rooms.map(r => this._renderRoomCard(r)).join('');
      listEl.querySelectorAll('.room-card').forEach(card => {
        card.addEventListener('click', () => {
          const rid = card.dataset.roomId;
          if (rid) this.openRoom(rid);
        });
      });
    } catch (e) {
      DEBUG && console.error('[Rooms] Load public rooms failed:', e);
      listEl.innerHTML = `<div class="rooms-empty">
        <div class="rooms-empty-icon"><i data-lucide="triangle-alert" class="lucide" width="48" height="48"></i></div>
        <div class="rooms-empty-text">Could not load rooms</div>
      </div>`;
    }
  },

  /* ─────────────────────────────────────────────
     LOAD MY ROOMS (rooms where I am a member)
  ───────────────────────────────────────────── */
  async loadMyRooms() {
    if (!state.currentUser) return;
    const section = $('my-rooms-section');
    const listEl = $('my-rooms-list');
    if (!section || !listEl) return;

    try {
      const snap = await get(ref(db, 'rooms'));
      if (!snap.exists()) { section.style.display = 'none'; return; }

      const myRooms = [];
      snap.forEach(child => {
        const d = child.val();
        if (d.members && d.members[state.currentUser.uid]) {
          myRooms.push({ id: child.key, ...d });
        }
      });

      if (myRooms.length === 0) {
        section.style.display = 'none';
        return;
      }

      section.style.display = 'block';
      myRooms.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      listEl.innerHTML = myRooms.map(r => this._renderRoomCard(r, true)).join('');
      listEl.querySelectorAll('.room-card').forEach(card => {
        card.addEventListener('click', () => {
          const rid = card.dataset.roomId;
          if (rid) this.openRoom(rid);
        });
      });
    } catch (e) {
      DEBUG && console.error('[Rooms] Load my rooms failed:', e);
      section.style.display = 'none';
    }
  },

  /* ─────────────────────────────────────────────
     RENDER A ROOM CARD
  ───────────────────────────────────────────── */
  _renderRoomCard(room, showMyBadge = false) {
    const memberCount = room.members ? Object.keys(room.members).length : 1;
    const icon = room.entryType === 'multi' ? 'globe' : 'home';
    const isMyRoom = state.currentUser && room.ownerId === state.currentUser.uid;
    const myBadge = (showMyBadge && isMyRoom)
      ? `<span class="rooms-my-badge">owner</span>` : '';
    const memberBadge = (showMyBadge && state.currentUser && !isMyRoom)
      ? `<span class="rooms-my-badge">member</span>` : '';

    return `<div class="room-card" data-room-id="${escHtml(room.id)}">
      <div class="room-card-icon">${escHtml(icon)}</div>
      <div class="room-card-body">
        <div class="room-card-name">${escHtml(room.name)}${myBadge}${memberBadge}</div>
        <div class="room-card-desc">${escHtml(room.purpose || 'No description')}</div>
        <div class="room-card-meta">
          <span class="room-type-pill ${escHtml(room.type || 'public')}">${room.type === 'private' ? '<i data-lucide="lock" class="lucide" width="10" height="10"></i> Private' : '<i data-lucide="globe" class="lucide" width="10" height="10"></i> Public'}</span>
          <span class="room-entry-pill">${room.entryType === 'multi' ? '<i data-lucide="globe" class="lucide" width="10" height="10"></i> Multi Skill' : '<i data-lucide="target" class="lucide" width="10" height="10"></i> Single Skill'}</span>
        </div>
      </div>
      <div class="room-member-count">
        <div class="room-member-dot"></div>
        <span>${memberCount}</span>
      </div>
    </div>`;
  },

  /* ─────────────────────────────────────────────
     OPEN A ROOM (join + load chat)
  ───────────────────────────────────────────── */
  async openRoom(roomId) {
    if (!state.currentUser || !roomId) return;

    this.leaveRoomChat();
    this.currentRoomId = roomId;

    ScreenManager.show('room-chat-screen');

    // Show skeleton (already in HTML); clear any real messages from previous session
    const msgsWrap = $('room-msgs-wrap');
    if (msgsWrap) {
      // Remove old real messages but keep skeleton and loading div
      Array.from(msgsWrap.children).forEach(el => {
        if (el.id !== 'room-chat-skel' && el.id !== 'room-chat-loading') el.remove();
      });
      const skel = $('room-chat-skel');
      if (skel) skel.style.display = 'flex';
    }
    this._renderedRoomMsgIds = new Set();
    this._lastRoomMsgDate = null;

    try {
      const snap = await get(ref(db, `rooms/${roomId}`));
      if (!snap.exists()) {
        Toast.error('Room not found');
        ScreenManager.show('rooms-screen');
        return;
      }
      this.currentRoomData = { id: roomId, ...snap.val() };
      const room = this.currentRoomData;

      if (room.type === 'private') {
        const isMember = room.members && room.members[state.currentUser.uid];
        // Allow entry if they arrived via an invite link (_pendingInviteRoomId is set)
        if (!isMember && this._pendingInviteRoomId !== roomId) {
          Toast.error('This is a private room. You need an invite link to join.');
          ScreenManager.show('rooms-screen');
          return;
        }
      }
      // Clear invite flag now that we've consumed it
      this._pendingInviteRoomId = null;

      if (!room.members || !room.members[state.currentUser.uid]) {
        await this.joinRoom(roomId);
      }

      const icon = room.entryType === 'multi' ? 'globe' : 'home';
      const chatIcon = $('room-chat-icon');
      const chatName = $('room-chat-name');
      const chatSub = $('room-chat-sub');
      if (chatIcon) chatIcon.textContent = icon;
      if (chatName) chatName.textContent = room.name || 'Room';
      if (chatSub) {
        const mc = room.members ? Object.keys(room.members).length : 1;
        chatSub.textContent = `${mc} member${mc !== 1 ? 's' : ''} · ${room.type === 'private' ? 'Private' : 'Public'}`;
      }

      const adminBtn = $('room-admin-btn');
      if (adminBtn) {
        adminBtn.style.display = (room.ownerId === state.currentUser.uid) ? 'flex' : 'none';
      }

      this.listenRoomMessages(roomId);
      this.listenRoomTyping(roomId);

    } catch (e) {
      DEBUG && console.error('[Rooms] Open room failed:', e);
      Toast.error('Could not open room');
      ScreenManager.show('rooms-screen');
    }
  },

  /* ─────────────────────────────────────────────
     JOIN A ROOM (write member entry)
  ───────────────────────────────────────────── */
  async joinRoom(roomId) {
    if (!state.currentUser) return;
    try {
      await update(ref(db, `rooms/${roomId}/members/${state.currentUser.uid}`), {
        role: 'member',
        joinedAt: Date.now(),
        username: state.username || 'Unknown',
      });
    await push(ref(db, `rooms/${roomId}/messages`), {
        type: 'system',
        text: `${state.username || 'Someone'} joined the room`,
        timestamp: serverTimestamp(),
      });
    } catch (e) {
      DEBUG && console.error('[Rooms] Join failed:', e);
    }
  },

  /* ─────────────────────────────────────────────
     LISTEN FOR ROOM MESSAGES (real-time)
  ───────────────────────────────────────────── */
  listenRoomMessages(roomId) {
    if (this.unsubRoomMessages) {
      this.unsubRoomMessages();
      this.unsubRoomMessages = null;
    }
    if (this.unsubRoomKick) {
      this.unsubRoomKick();
      this.unsubRoomKick = null;
    }

    // Listen for being kicked — if our uid appears under /kicked, boot us out immediately
    if (state.currentUser) {
      const kickedRef = ref(db, `rooms/${roomId}/kicked/${state.currentUser.uid}`);
      this.unsubRoomKick = onValue(kickedRef, (snap) => {
        if (snap.exists()) {
          if (this.unsubRoomKick) { this.unsubRoomKick(); this.unsubRoomKick = null; }
          Toast.error('You have been removed from this room.');
          this.leaveRoomChat();
          ScreenManager.show('rooms-screen');
          this.loadPublicRooms();
          this.loadMyRooms();
        }
      });
    }

    const msgsRef = ref(db, `rooms/${roomId}/messages`);
   this.unsubRoomMessages = onChildAdded(msgsRef, (snap) => {
      if (!snap.exists()) return;
      const msg = snap.val();
      const msgId = snap.key;
      if (this._renderedRoomMsgIds.has(msgId)) return;
      this._renderedRoomMsgIds.add(msgId);
      // Hide skeleton on first real message
      const skel = $('room-chat-skel');
      if (skel) skel.style.display = 'none';
      const loading = $('room-chat-loading');
      if (loading) loading.remove();
      this._appendRoomMessage(msgId, msg);
    });

    // If room has no messages yet, hide skeleton after short delay
    setTimeout(() => {
      const skel = $('room-chat-skel');
      if (skel) skel.style.display = 'none';
      const loading = $('room-chat-loading');
      if (loading) loading.remove();
    }, 3000);
  },

  /* ─────────────────────────────────────────────
     RENDER + APPEND A SINGLE ROOM MESSAGE
  ───────────────────────────────────────────── */
  _appendRoomMessage(msgId, msg) {
    const wrap = $('room-msgs-wrap');
    if (!wrap) return;

    const msgDate = msg.timestamp ? formatDate(msg.timestamp) : null;
    if (msgDate && msgDate !== this._lastRoomMsgDate) {
      const divider = document.createElement('div');
      divider.className = 'room-date-divider';
      divider.textContent = msgDate;
      wrap.appendChild(divider);
      this._lastRoomMsgDate = msgDate;
    }

    if (msg.type === 'system') {
      const sysEl = document.createElement('div');
      sysEl.className = 'room-msg-system';
      sysEl.textContent = msg.text || '';
      wrap.appendChild(sysEl);
      wrap.scrollTop = wrap.scrollHeight;
      return;
    }

    const isSelf = state.currentUser && msg.senderId === state.currentUser.uid;
    const row = document.createElement('div');
    row.className = `room-msg-row${isSelf ? ' self' : ''}`;
    row.dataset.msgId = msgId;

    const avatarEl = document.createElement('div');
    avatarEl.className = 'room-msg-avatar';
    if (msg.senderPfp) {
      avatarEl.innerHTML = `<img src="${escHtml(msg.senderPfp)}" alt="${escHtml(msg.senderUsername || '')}" loading="lazy">`;
    } else {
      avatarEl.textContent = (msg.senderUsername || '??').slice(0, 2).toUpperCase();
    }

    const contentEl = document.createElement('div');
    contentEl.className = 'room-msg-content';

    if (!isSelf) {
      const nameEl = document.createElement('div');
      nameEl.className = 'room-msg-sender-name';
      nameEl.textContent = msg.senderUsername || 'Unknown';
      nameEl.style.cursor = 'pointer';
      nameEl.addEventListener('click', () => {
        if (!msg.senderId || msg.senderId === state.currentUser?.uid) return;
        const cached = state.usersCache?.get(msg.senderId) || {};
        openUserProfileSheet(msg.senderId, msg.senderUsername || 'Unknown', cached.skill||'Explorer', cached.level||'Beginner', cached.points||0, cached.pfpUrl||'', cached.bio||'', cached.expertise||null, cached.socialIntegrations||null);
      });
      contentEl.appendChild(nameEl);
    }

    const bubbleEl = document.createElement('div');
    bubbleEl.className = 'room-msg-bubble';
    if (msg.type === 'vault') {
      bubbleEl.style.cssText += ';padding:4px;background:transparent;border:none;box-shadow:none;';
      bubbleEl.appendChild(VaultSystem.buildVaultContent(msgId, msg, isSelf));
    } else if (msg.type === 'image' && msg.dataUrl) {
      bubbleEl.innerHTML = `<img src="${escHtml(msg.dataUrl)}" alt="Image" style="max-width:220px;max-height:200px;border-radius:8px;display:block;cursor:pointer;" loading="lazy">`;
      bubbleEl.querySelector('img').addEventListener('click', () => {
        const w = window.open();
        w.document.write(`<body style="margin:0;background:#000;display:flex;align-items:center;justify-content:center;min-height:100vh;"><img src="${msg.dataUrl}" style="max-width:100%;max-height:100vh;object-fit:contain;"></body>`);
      });
    } else if (msg.type === 'audio' && msg.dataUrl) {
      bubbleEl.innerHTML = `<audio controls src="${escHtml(msg.dataUrl)}" style="max-width:220px;height:36px;display:block;"></audio>`;
    } else {
      bubbleEl.innerHTML = linkify(msg.text || '');
    }

    const timeEl = document.createElement('div');
    timeEl.className = 'room-msg-time';
    timeEl.textContent = msg.timestamp ? formatTime(msg.timestamp) : '';

    contentEl.appendChild(bubbleEl);
    contentEl.appendChild(timeEl);

    if (isSelf) {
      row.appendChild(contentEl);
      row.appendChild(avatarEl);
    } else {
      row.appendChild(avatarEl);
      row.appendChild(contentEl);
    }

    wrap.appendChild(row);
    wrap.scrollTop = wrap.scrollHeight;
  },

  /* ─────────────────────────────────────────────
     SEND A ROOM MESSAGE
  ───────────────────────────────────────────── */
  async sendRoomMessage() {
    if (!state.currentUser || !this.currentRoomId) return;
    const input = $('room-message-input');
    const sendBtn = $('room-send-btn');
    if (!input) return;

    const text = input.value.trim();
    if (!text) return;

    if (sendBtn) sendBtn.disabled = true;
    input.value = '';
    input.style.height = 'auto';

    try {
      await push(ref(db, `rooms/${this.currentRoomId}/messages`), {
        senderId: state.currentUser.uid,
        senderUsername: state.username || 'Unknown',
        senderPfp: state.pfpUrl || null,
        text,
        timestamp: serverTimestamp(),
      });
      this.clearRoomTyping();
    } catch (e) {
      DEBUG && console.error('[Rooms] Send message failed:', e);
      Toast.error('Could not send message');
    } finally {
      if (sendBtn) sendBtn.disabled = false;
      input.focus();
    }
  },

  /* ─────────────────────────────────────────────
     TYPING INDICATORS
  ───────────────────────────────────────────── */
  sendRoomTyping() {
    if (!state.currentUser || !this.currentRoomId) return;
    const uid = state.currentUser.uid;
    const roomTypingRef = ref(db, `rooms/${this.currentRoomId}/typing/${uid}`);
    set(roomTypingRef, state.username || 'Someone');
    // Auto-remove typing indicator if user disconnects (closes tab/loses connection)
    onDisconnect(roomTypingRef).remove().catch(() => {});
    clearTimeout(this.roomTypingTimeout);
    this.roomTypingTimeout = setTimeout(() => this.clearRoomTyping(), 2000);
  },

  clearRoomTyping() {
    if (!state.currentUser || !this.currentRoomId) return;
    remove(ref(db, `rooms/${this.currentRoomId}/typing/${state.currentUser.uid}`)).catch(() => {});
  },

  listenRoomTyping(roomId) {
    if (this.unsubRoomTyping) { this.unsubRoomTyping(); this.unsubRoomTyping = null; }
    const typingRef = ref(db, `rooms/${roomId}/typing`);
    this.unsubRoomTyping = onValue(typingRef, (snap) => {
      const bar = $('room-typing-bar');
      if (!bar) return;
      if (!snap.exists()) { bar.textContent = ''; return; }
      const typingUsers = [];
      snap.forEach(child => {
        if (child.key !== state.currentUser?.uid) {
          typingUsers.push(child.val());
        }
      });
      if (typingUsers.length === 0) { bar.textContent = ''; return; }
      const names = typingUsers.slice(0, 2).join(', ');
      bar.textContent = `${names} ${typingUsers.length === 1 ? 'is' : 'are'} typing...`;
    });
  },

  /* ─────────────────────────────────────────────
     LEAVE / CLEANUP ROOM CHAT
  ───────────────────────────────────────────── */
  leaveRoomChat() {
    this.clearRoomTyping();
    if (this.unsubRoomMessages) { this.unsubRoomMessages(); this.unsubRoomMessages = null; }
    if (this.unsubRoomTyping) { this.unsubRoomTyping(); this.unsubRoomTyping = null; }
    if (this.unsubRoomKick) { this.unsubRoomKick(); this.unsubRoomKick = null; }
    clearTimeout(this.roomTypingTimeout);
    this.currentRoomId = null;
    this.currentRoomData = null;
    this._renderedRoomMsgIds = new Set();
    this._lastRoomMsgDate = null;
  },

  /* ─────────────────────────────────────────────
     ADMIN PANEL — load members & invite link
  ───────────────────────────────────────────── */
  async loadAdminPanel() {
    if (!this.currentRoomId) return;
    const room = this.currentRoomData;

    const inviteLinkEl = $('room-invite-link-text');
    if (inviteLinkEl) {
      const link = `${window.location.origin}${window.location.pathname}?room=${this.currentRoomId}`;
      inviteLinkEl.textContent = link;
    }

    const membersListEl = $('room-members-list');
    if (!membersListEl) return;
    membersListEl.innerHTML = '<div style="color:var(--muted);font-size:12px;text-align:center;padding:12px;">Loading...</div>';

    try {
      const snap = await get(ref(db, `rooms/${this.currentRoomId}/members`));
      if (!snap.exists()) { membersListEl.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:8px;">No members</div>'; return; }

      const memberEntries = [];
      snap.forEach(child => {
        memberEntries.push({ uid: child.key, ...child.val() });
      });

      const enriched = await Promise.all(memberEntries.map(async (m) => {
        let username = m.username || 'Unknown';
        let pfpUrl = null;
        try {
          const cached = getUserCached(m.uid);
          if (cached) {
            username = cached.username || username;
            pfpUrl = cached.pfpUrl || null;
          } else {
            const userSnap = await get(ref(db, `users/${m.uid}`));
            if (userSnap.exists()) {
              const ud = userSnap.val();
              username = ud.username || username;
              pfpUrl = ud.pfpUrl || null;
              cacheUser(m.uid, ud);
            }
          }
        } catch (e) {}
        return { ...m, username, pfpUrl };
      }));

      membersListEl.innerHTML = '';
      enriched.forEach(member => {
        const isOwner = room?.ownerId === member.uid;
        const isSelf = state.currentUser?.uid === member.uid;
        const row = document.createElement('div');
        row.className = 'room-member-row';
        const avatarHtml = member.pfpUrl
          ? `<img src="${escHtml(member.pfpUrl)}" alt="" loading="lazy">`
          : escHtml((member.username || '??').slice(0, 2).toUpperCase());

        row.innerHTML = `
          <div class="room-member-av">${avatarHtml}</div>
          <div class="room-member-name">@${escHtml(member.username)}</div>
          <div class="room-member-role">${isOwner ? '<i data-lucide="crown" class="lucide" width="12" height="12"></i> Owner' : member.role || 'member'}</div>
          ${(!isOwner && !isSelf) ? `<button class="room-member-kick-btn" data-uid="${escHtml(member.uid)}">Kick</button>` : ''}
        `;

        const kickBtn = row.querySelector('.room-member-kick-btn');
        if (kickBtn) {
          kickBtn.addEventListener('click', async () => {
            const targetUid = kickBtn.dataset.uid;
            if (!targetUid) return;
            const ok = await ConfirmModal.show({
              icon: 'ban',
              title: `Remove @${escHtml(member.username)}?`,
              sub: 'They will be removed from this room.',
              confirmText: 'Remove',
              cancelText: 'Cancel',
              danger: true,
            });
            if (!ok) return;
            await this.kickMember(targetUid);
          });
        }
        membersListEl.appendChild(row);
      });
    } catch (e) {
      DEBUG && console.error('[Rooms] Load admin panel failed:', e);
      membersListEl.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:8px;">Could not load members</div>';
    }
  },

  closeAdminPanel() {
    $('room-admin-panel')?.classList.remove('open');
    $('room-admin-panel-overlay')?.classList.remove('open');
  },

  /* ─────────────────────────────────────────────
     KICK A MEMBER
  ───────────────────────────────────────────── */
  async kickMember(targetUid) {
    if (!this.currentRoomId || !state.currentUser) return;
    if (this.currentRoomData?.ownerId !== state.currentUser.uid) {
      Toast.error('Only the owner can remove members'); return;
    }
    try {
      await remove(ref(db, `rooms/${this.currentRoomId}/members/${targetUid}`));
      // Write a kicked flag — the kicked user's client detects this in real-time and gets booted
      await set(ref(db, `rooms/${this.currentRoomId}/kicked/${targetUid}`), Date.now());
      await push(ref(db, `rooms/${this.currentRoomId}/messages`), {
        type: 'system',
        text: 'A member was removed from the room.',
        timestamp: serverTimestamp(),
      });
      Toast.success('Member removed');
      this.loadAdminPanel();
    } catch (e) {
      Toast.error('Could not remove member');
    }
  },

  /* ─────────────────────────────────────────────
     DELETE ROOM (owner only)
  ───────────────────────────────────────────── */
  async deleteRoom() {
    if (!this.currentRoomId || !state.currentUser) return;
    if (this.currentRoomData?.ownerId !== state.currentUser.uid) {
      Toast.error('Only the owner can delete this room'); return;
    }
    const ok = await ConfirmModal.show({
      icon: 'trash-2',
      title: 'Delete this Room?',
      sub: 'All messages will be permanently deleted. This cannot be undone.',
      confirmText: 'Delete Forever',
      cancelText: 'Cancel',
      danger: true,
    });
    if (!ok) return;
    try {
      await remove(ref(db, `rooms/${this.currentRoomId}`));
      Toast.success('Room deleted');
      this.closeAdminPanel();
      this.leaveRoomChat();
      ScreenManager.show('rooms-screen');
      this.loadPublicRooms();
      this.loadMyRooms();
    } catch (e) {
      Toast.error('Could not delete room');
    }
  },

  /* ─────────────────────────────────────────────
     INVITE LINK HANDLER (on page load)
  ───────────────────────────────────────────── */
  checkRoomInviteLink() {
    // Called after auth is confirmed. See initRoomLinkCheck() below.
  },
};

/* ─── Called after login to check ?room= param ─── */
function initRoomLinkCheck() {
  const params = new URLSearchParams(window.location.search);
  const roomId = params.get('room');
  if (!roomId || !state.currentUser) return;
  window.history.replaceState({}, document.title, window.location.pathname);
  // Mark that this open came from an invite link so private rooms allow entry
  RoomSystem._pendingInviteRoomId = roomId;
  setTimeout(() => {
    RoomSystem.openRoom(roomId);
  }, 800);
}

// Initialize the RoomSystem
RoomSystem.init();

log('%c[Golex v1.2] Production Ready', 'color:#D4924A;font-weight:bold;font-size:14px');
log('%c v1.2: Report User, Report Post, Send Feedback — all wired to HQ Firebase paths', 'color:#10b981');


// ── Export to window ──
Object.assign(window, { RoomSystem });
