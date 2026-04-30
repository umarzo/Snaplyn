const { state, $, $$, escHtml, badgeHTML, generateAvatarUrl, timeAgo, formatTime,
  formatDate, debounce, compressImage, fileToBase64, downloadBase64, formatFileSize,
  auth, db, ref, get, set, onValue, onChildAdded, onChildChanged, push,
  serverTimestamp, onDisconnect, update, off, remove, runTransaction,
  CONFIG, PREDEFINED_SKILLS, Toast, ScreenManager, ConfirmModal, ReportModal,
  openUserProfileSheet, cacheUser, getUserCached, GoProMedia, GOLEX_PRO } = window;

/* ═══════════════════════════════════════════════════
   VOICE CALL ENGINE
   ═══════════════════════════════════════════════════ */

// ICE Servers: STUN is tried first (free, peer-to-peer).
// TURN is used as fallback only when STUN fails (e.g. behind strict firewalls).
// ─── TURN credential cache (avoids repeated requests + reduces key exposure) ───
const _turnCache = { servers: null, fetchedAt: 0, TTL: 3600 * 1000 }; // 1h TTL

async function getIceServers() {
  const stunServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ];

  if (_turnCache.servers && (Date.now() - _turnCache.fetchedAt) < _turnCache.TTL) {
    return [...stunServers, ..._turnCache.servers];
  }

  try {
    if (!state.currentUser) return stunServers;
    const idToken = await state.currentUser.getIdToken();
    const response = await fetch('https://golex.metered.live/api/v1/turn/credentials?apiKey=4dbd900de8251676677d9c66d704994b63b1', {
      headers: { 'X-Firebase-Token': idToken }
    });
    if (!response.ok) throw new Error('TURN fetch failed');
    const turnServers = await response.json();
    _turnCache.servers = turnServers;
    _turnCache.fetchedAt = Date.now();
    state._turnServers = turnServers;
    return [...stunServers, ...turnServers];
  } catch (err) {
    DEBUG && console.warn('[ICE] Using STUN-only (no TURN):', err.message);
    state._turnServers = null;
    return stunServers;
  }
}


// ─── Show the call overlay UI ───
function showCallOverlay(partnerName, partnerAvatarEl) {
  const overlay = document.getElementById('call-overlay');
  const nameEl = document.getElementById('call-name');
  const avatarEl = document.getElementById('call-avatar');
  const statusEl = document.getElementById('call-status');
  const timerEl = document.getElementById('call-timer');

  if (nameEl) nameEl.textContent = partnerName || 'Unknown';
  if (statusEl) { statusEl.textContent = 'Calling...'; statusEl.style.display = 'block'; }
  if (timerEl) timerEl.style.display = 'none';

  if (avatarEl) {
    const chatAvatar = document.getElementById('chat-partner-avatar');
    if (chatAvatar) {
      const img = chatAvatar.querySelector('img');
      if (img) {
        avatarEl.innerHTML = `<img src="${img.src}" alt="">`;
      } else {
        avatarEl.textContent = chatAvatar.textContent;
      }
    }
  }

  if (overlay) overlay.classList.add('active');
}

// ─── Hide the call overlay UI ───
function hideCallOverlay() {
  const overlay = document.getElementById('call-overlay');
  if (overlay) overlay.classList.remove('active');
  stopCallTimer();
}

// ─── Show incoming call banner ───
function showIncomingBanner(callerName) {
  const banner = document.getElementById('incoming-call-banner');
  const nameEl = document.getElementById('incoming-caller-name');
  if (nameEl) nameEl.textContent = '@' + callerName;
  if (banner) banner.classList.add('active');
}

// ─── Hide incoming call banner ───
function hideIncomingBanner() {
  const banner = document.getElementById('incoming-call-banner');
  if (banner) banner.classList.remove('active');
}

// ─── Start the call timer ───
function startCallTimer() {
  // ── PRO MEDIA: Apply audio bitrate encoding as soon as call connects ──
  if (state.peerConnection) {
    ProMedia.applyAllEncodings(state.peerConnection, false).catch(() => {});
  }
  // ── PRO MEDIA: Show quality badge ──
  const _hasVideo = !!(state.localVideoStream && state.localVideoStream.getVideoTracks().length);
  ProMedia.showCallQualityBadge(_hasVideo);
  state.callSeconds = 0;
  const timerEl = document.getElementById('call-timer');
  const statusEl = document.getElementById('call-status');
  if (statusEl) statusEl.style.display = 'none';
  if (timerEl) timerEl.style.display = 'block';

  state.callTimerInterval = setInterval(() => {
    state.callSeconds++;
    const m = Math.floor(state.callSeconds / 60).toString().padStart(2, '0');
    const s = (state.callSeconds % 60).toString().padStart(2, '0');
    if (timerEl) timerEl.textContent = `${m}:${s}`;
  }, 1000);
}

// ─── Stop the call timer ───
function stopCallTimer() {
  clearInterval(state.callTimerInterval);
  state.callTimerInterval = null;
  state.callSeconds = 0;
}

// ─── Stop microphone and close peer connection ───
function cleanupCall() {
  const endedCallId = state.callId;
  // Stop microphone
  if (state.localStream) {
    state.localStream.getTracks().forEach(t => t.stop());
    state.localStream = null;
  }
  // Stop camera if video was active
  if (state.localVideoStream) {
    state.localVideoStream.getTracks().forEach(t => t.stop());
    state.localVideoStream = null;
  }
  // Clean up video signaling listener
  if (state._unsubVideoRequest) {
    state._unsubVideoRequest();
    state._unsubVideoRequest = null;
  }

  // Reset video state and UI
  state.videoMode = false;
  state._callConnected = false;
  state._videoSenderExists = false;
  state._videoSender = null;
  state._currentFacingMode = null;
  state._videoEnabling = false;
  state._lastProcessedVideoRequestTs = null;

  const videoArea = document.getElementById('call-video-area');
  if (videoArea) videoArea.classList.remove('active');
  const callOverlay = document.getElementById('call-overlay');
  if (callOverlay) callOverlay.classList.remove('video-active');
  const remoteVideo = document.getElementById('remote-video');
  if (remoteVideo) { remoteVideo.pause(); remoteVideo.srcObject = null; }
  const selfVideo = document.getElementById('self-video');
  if (selfVideo) { selfVideo.pause(); selfVideo.srcObject = null; }
  const popup = document.getElementById('video-switch-popup');
  if (popup) popup.classList.remove('active');
  const cameraBtn = document.getElementById('call-camera-btn');
  if (cameraBtn) cameraBtn.classList.remove('visible');
  const switchBtn = document.getElementById('call-video-switch-btn');
  if (switchBtn) switchBtn.innerHTML = '<i data-lucide="video" class="lucide" width="16" height="16"></i> Switch to Video';

  // Close WebRTC connection
  if (state.peerConnection) {
    if (state.peerConnection._failedRecoveryTimer) {
      clearTimeout(state.peerConnection._failedRecoveryTimer);
      state.peerConnection._failedRecoveryTimer = null;
    }
    if (state.peerConnection._iceRecoveryTimer) {
      clearTimeout(state.peerConnection._iceRecoveryTimer);
      state.peerConnection._iceRecoveryTimer = null;
    }
    state.peerConnection.close();
    state.peerConnection = null;
  }

  // Silence remote audio
  const audio = document.getElementById('remote-audio');
  if (audio) { audio.srcObject = null; }

  // Clean up all Firebase listeners
  if (state._unsubRenegotiate)          { state._unsubRenegotiate();          state._unsubRenegotiate = null; }
  if (state._unsubRenegotiationAnswer)  { state._unsubRenegotiationAnswer();  state._unsubRenegotiationAnswer = null; }
  if (state._unsubReceiverAnswer)       { state._unsubReceiverAnswer();       state._unsubReceiverAnswer = null; }
  if (state._unsubReceiverRenegotiate)  { state._unsubReceiverRenegotiate();  state._unsubReceiverRenegotiate = null; }
  if (state._unsubIceCaller)            { state._unsubIceCaller();            state._unsubIceCaller = null; }
  if (state._unsubIceReceiver)          { state._unsubIceReceiver();          state._unsubIceReceiver = null; }

  // Reset ICE candidate tracking sets
  state._addedCallerCandidates = new Set();
  state._addedReceiverCandidates = new Set();

  hideCallOverlay();
  hideIncomingBanner();
  state.callId = null;
  state.incomingCallRef = null;
  state.activeSketchCallId = null;
  state.activeSketchCallType = null;
  SketchBoardSystem.handleCallEnded(endedCallId);

  // Restart incoming call listener so next call can be received
  setTimeout(() => listenForIncomingCalls(), 4000);
}

// ─── Listen for video switch requests ───
function listenForVideoRequests(callId) {
  if (state._unsubVideoRequest) {
    state._unsubVideoRequest();
    state._unsubVideoRequest = null;
  }

  const videoReqRef = ref(db, `calls/${callId}/videoRequest`);
  const unsubFn = onValue(videoReqRef, async (snap) => {
    if (!snap.exists()) return;
    const req = snap.val();
    const myUid = state.currentUser?.uid;
    if (!myUid) return;

    // ── Recipient: show accept/deny popup ──
    if (req.from !== myUid && req.status === 'pending') {
      const popup    = document.getElementById('video-switch-popup');
      const title    = document.getElementById('video-popup-title');
      const sub      = document.getElementById('video-popup-sub');
      const icon     = document.getElementById('video-popup-icon');
      const acceptBtn = document.getElementById('video-popup-accept');
      const denyBtn   = document.getElementById('video-popup-deny');

      const isVideoReq = req.type === 'requestVideo';
      if (icon)  icon.innerHTML  = isVideoReq ? '<i data-lucide="video" class="lucide" width="20" height="20"></i>' : '<i data-lucide="mic" class="lucide" width="20" height="20"></i>';
      if (title) title.textContent = isVideoReq ? 'Switch to video call?' : 'Switch back to voice call?';
      if (sub)   sub.textContent   = isVideoReq ? 'The other person wants to enable camera' : 'The other person wants to turn off camera';

      if (acceptBtn) {
        const newAccept = acceptBtn.cloneNode(true);
        acceptBtn.parentNode.replaceChild(newAccept, acceptBtn);
        newAccept.addEventListener('click', async () => {
          popup?.classList.remove('active');
          await update(ref(db, `calls/${callId}/videoRequest`), { status: 'accepted' }).catch(() => {});
          if (isVideoReq) {
            // FIX: Acceptor delays 500ms so the requester's renegotiation starts first.
            // This prevents simultaneous offer collision (both addTrack → both onnegotiationneeded).
            setTimeout(() => enableVideo(callId, false), 500);
          } else {
            await disableVideo(callId);
          }
        });
      }

      if (denyBtn) {
        const newDeny = denyBtn.cloneNode(true);
        denyBtn.parentNode.replaceChild(newDeny, denyBtn);
        newDeny.addEventListener('click', async () => {
          popup?.classList.remove('active');
          await update(ref(db, `calls/${callId}/videoRequest`), { status: 'denied' }).catch(() => {});
        });
      }

      if (popup) popup.classList.add('active');
    }

    // ── Requester: handle the response ──
    if (req.from === myUid) {
      const switchBtn = document.getElementById('call-video-switch-btn');
      if (req.status === 'accepted') {
        if (req.at && state._lastProcessedVideoRequestTs === req.at) {
          if (switchBtn) switchBtn.disabled = false;
          return;
        }
        if (req.at) state._lastProcessedVideoRequestTs = req.at;
        document.getElementById('video-switch-popup')?.classList.remove('active');
        if (req.type === 'requestVideo') {
          // FIX: Requester enables video immediately (goes first in negotiation).
          await enableVideo(callId, true);
        } else {
          await disableVideo(callId);
        }
        if (switchBtn) switchBtn.disabled = false;
      } else if (req.status === 'denied') {
        document.getElementById('video-switch-popup')?.classList.remove('active');
        Toast.info('Request declined');
        if (switchBtn) switchBtn.disabled = false;
      }
    }
  });

  state._unsubVideoRequest = unsubFn;
}

// ─── Send a video switch request ───
async function requestVideoSwitch() {
  const callId = state.callId;
  if (!callId || !state.peerConnection) return;

  const switchBtn = document.getElementById('call-video-switch-btn');
  if (switchBtn) switchBtn.disabled = true;

  const type = state.videoMode ? 'requestVoice' : 'requestVideo';

  await update(ref(db, `calls/${callId}/videoRequest`), {
    from: state.currentUser.uid,
    type,
    status: 'pending',
    at: Date.now()
  }).catch(() => {
    Toast.error('Could not send request');
    if (switchBtn) switchBtn.disabled = false;
  });
}

function _ensureVideoSender(pc) {
  if (!pc) return null;
  if (state._videoSender && pc.getSenders().includes(state._videoSender)) {
    return state._videoSender;
  }
  const existingTransceiver = pc.getTransceivers().find(t => {
    if (!t || !t.sender || !t.receiver) return false;
    return t.sender.track?.kind === 'video' || t.receiver.track?.kind === 'video';
  });
  if (existingTransceiver && existingTransceiver.sender) {
    state._videoSender = existingTransceiver.sender;
    state._videoSenderExists = true;
    return state._videoSender;
  }
  try {
    const transceiver = pc.addTransceiver('video', { direction: 'sendrecv' });
    state._videoSender = transceiver.sender;
    state._videoSenderExists = true;
    log('[WebRTC] Created persistent video transceiver');
    return state._videoSender;
  } catch (err) {
    DEBUG && console.warn('[WebRTC] Could not create video transceiver:', err);
    return null;
  }
}

function _queueRenegotiation(reason, maxAttempts = 4) {
  const pc = state.peerConnection;
  if (!pc) return;
  // Retry with a short incremental backoff until renegotiation is safe:
  // signaling must be stable, remote description must exist, and we must not
  // already be generating an offer. This prevents offer glare/state errors.
  let attempt = 0;
  const run = () => {
    if (!state.peerConnection || state.peerConnection !== pc) return;
    const canNegotiate =
      pc.signalingState === 'stable' &&
      !!pc.currentRemoteDescription &&
      !pc._makingOffer;
    if (canNegotiate) {
      log(`[WebRTC/Neg] Triggering renegotiation (${reason})`);
      pc.dispatchEvent(new Event('negotiationneeded'));
      return;
    }
    attempt += 1;
    if (attempt < maxAttempts) {
      setTimeout(run, 300 * attempt);
    } else {
      DEBUG && console.warn(`[WebRTC/Neg] Timed out waiting to renegotiate (${reason})`);
    }
  };
  run();
}

// ─── Enable camera and add video track ───
// isRequester = true when this peer initiated the video request (goes first in renegotiation)
// isRequester = false when this peer is the acceptor (slight delay applied upstream)
async function enableVideo(callId, isRequester) {
  // Guard: prevent double-enabling
  if (state._videoEnabling) return;
  state._videoEnabling = true;

  try {
    // ── PRO MEDIA: Pro gets 720p, free gets 480p ──
    const videoStream = await navigator.mediaDevices.getUserMedia(ProMedia.getDMVideoConstraints());

    state.localVideoStream = videoStream;
    state._currentFacingMode = 'user';
    const videoTrack = videoStream.getVideoTracks()[0];

    if (state.peerConnection && videoTrack) {
      const pc = state.peerConnection;
      if (state.localStream && !state.localStream.getVideoTracks().length) {
        state.localStream.addTrack(videoTrack);
      }

      const preferredSender = _ensureVideoSender(pc);
      if (preferredSender) {
        await preferredSender.replaceTrack(videoTrack);
        state._videoSender = preferredSender;
        log('[Video] Attached camera track to persistent video sender');
        _queueRenegotiation('video-enable');
      } else {
        // Fallback for environments that do not support addTransceiver as expected
        log('[Video] Fallback addTrack for video');
        const newSender = pc.addTrack(videoTrack, state.localStream || videoStream);
        state._videoSender = newSender;
        state._videoSenderExists = true;
        _queueRenegotiation('video-enable-fallback');
      }
    }

    // Show self preview
    const selfVideo = document.getElementById('self-video');
    if (selfVideo) {
      selfVideo.srcObject = videoStream;
      selfVideo.play().catch(() => {});
    }

    // Show video area
    // ── PRO MEDIA: Apply video bitrate after enabling camera ──
    setTimeout(() => {
      if (state.peerConnection) ProMedia.applyVideoEncoding(state.peerConnection, false).catch(() => {});
      ProMedia.showCallQualityBadge(true);
    }, 500);
    const videoArea = document.getElementById('call-video-area');
    if (videoArea) videoArea.classList.add('active');
    const callOverlay = document.getElementById('call-overlay');
    if (callOverlay) callOverlay.classList.add('video-active');

    state.videoMode = true;

    const switchBtn = document.getElementById('call-video-switch-btn');
    if (switchBtn) {
      switchBtn.innerHTML = '<i data-lucide="mic" class="lucide" width="16" height="16"></i> Switch to Voice';
      switchBtn.disabled = false;
    }

    const cameraBtn = document.getElementById('call-camera-btn');
    if (cameraBtn) cameraBtn.classList.add('visible');

    Toast.success('Video enabled');
  } catch (err) {
    DEBUG && console.error('[Video] Camera error:', err);
    if (err.name === 'NotAllowedError') {
      Toast.error('Camera permission denied');
    } else {
      Toast.error('Could not start camera');
    }
    if (callId) {
      await update(ref(db, `calls/${callId}/videoRequest`), { status: 'denied' }).catch(() => {});
    }
    const switchBtn = document.getElementById('call-video-switch-btn');
    if (switchBtn) switchBtn.disabled = false;
  } finally {
    state._videoEnabling = false;
  }
}

// ─── Disable camera, stop video tracks ───
async function disableVideo(callId) {
  // Mute the video sender and renegotiate to keep both peers in sync.
  if (state.peerConnection) {
    const sender = _ensureVideoSender(state.peerConnection);
    if (sender) {
      await sender.replaceTrack(null).catch(e => DEBUG && console.error(e));
    } else {
      const senders = state.peerConnection.getSenders();
      for (const s of senders) {
        if (s.track && s.track.kind === 'video') {
          await s.replaceTrack(null).catch(e => DEBUG && console.error(e));
        }
      }
    }
    _queueRenegotiation('video-disable');
  }

  // Stop local camera tracks
  if (state.localVideoStream) {
    state.localVideoStream.getTracks().forEach(t => t.stop());
    state.localVideoStream = null;
  }
  if (state.localStream) {
    state.localStream.getVideoTracks().forEach(t => state.localStream.removeTrack(t));
  }

  // Hide video area UI
  const videoArea = document.getElementById('call-video-area');
  if (videoArea) videoArea.classList.remove('active');
  const callOverlay = document.getElementById('call-overlay');
  if (callOverlay) callOverlay.classList.remove('video-active');

  // FIX: Only clear self-video (own camera preview).
  // Do NOT clear remoteVideo — the remote peer may still have their camera on.
  const selfVideo = document.getElementById('self-video');
  if (selfVideo) selfVideo.srcObject = null;

  state.videoMode = false;

  const switchBtn = document.getElementById('call-video-switch-btn');
  if (switchBtn) {
    switchBtn.innerHTML = '<i data-lucide="video" class="lucide" width="16" height="16"></i> Switch to Video';
    switchBtn.disabled = false;
  }

  const cameraBtn = document.getElementById('call-camera-btn');
  if (cameraBtn) cameraBtn.classList.remove('visible');

  Toast.info('Switched to voice');
}

// ─── Flip between front and back camera ───
async function switchCamera() {
  if (!state.localVideoStream) return;

  const currentTrack = state.localVideoStream.getVideoTracks()[0];
  if (!currentTrack) return;

  const currentFacing = state._currentFacingMode || 'user';
  const nextFacing = currentFacing === 'user' ? 'environment' : 'user';

  try {
    currentTrack.stop();

    // ── PRO MEDIA: Match resolution tier on camera flip ──
    const newStream = await navigator.mediaDevices.getUserMedia(ProMedia.getDMVideoFlipConstraints(nextFacing));

    const newTrack = newStream.getVideoTracks()[0];

    if (state.peerConnection) {
      const sender = state.peerConnection.getSenders().find(s => s.track?.kind === 'video');
      if (sender) await sender.replaceTrack(newTrack);
    }

    state.localVideoStream = newStream;
    state._currentFacingMode = nextFacing;

    const selfVideo = document.getElementById('self-video');
    if (selfVideo) {
      selfVideo.srcObject = newStream;
      selfVideo.play().catch(() => {});
    }
  } catch (err) {
    DEBUG && console.error('[Camera] Flip error:', err);
    try {
      // ── PRO MEDIA: Fallback flip — same resolution tier ──
      const fallbackStream = await navigator.mediaDevices.getUserMedia(ProMedia.getDMVideoFlipFallbackConstraints(nextFacing));
      const fallbackTrack = fallbackStream.getVideoTracks()[0];
      if (state.peerConnection) {
        const sender = state.peerConnection.getSenders().find(s => s.track?.kind === 'video');
        if (sender) await sender.replaceTrack(fallbackTrack);
      }
      state.localVideoStream = fallbackStream;
      state._currentFacingMode = nextFacing;
      const selfVideo = document.getElementById('self-video');
      if (selfVideo) { selfVideo.srcObject = fallbackStream; selfVideo.play().catch(() => {}); }
    } catch (err2) {
      DEBUG && console.error('[Camera] Fallback flip also failed:', err2);
      Toast.error('Could not flip camera');
    }
  }
}

// ─── Create a new WebRTC PeerConnection ───
function createPeerConnection(callId, isCaller, iceServers) {
  const pc = new RTCPeerConnection({ iceServers });

  // One persistent remote stream for the entire call — prevents stale srcObject bugs
  const remoteStream = new MediaStream();

  // ── ICE candidate relay ──
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      const candidatePath = isCaller ? 'callerCandidates' : 'receiverCandidates';
      push(ref(db, `calls/${callId}/${candidatePath}`), event.candidate.toJSON())
        .catch(err => DEBUG && console.error('[ICE] Failed to save candidate', err));
    }
  };

  // ── Remote track handling ──
  pc.ontrack = (event) => {
    const track = event.track;
    if (!track) return;

    log(`[WebRTC] ontrack: kind=${track.kind}, readyState=${track.readyState}, id=${track.id}, streams=${event.streams?.length}`);

    // Always add the incoming track to our persistent remoteStream
    remoteStream.getTracks().filter(t => t.kind === track.kind).forEach(t => {
      remoteStream.removeTrack(t);
    });
    remoteStream.addTrack(track);

    // Prefer the browser-provided stream (event.streams[0]) which is already fully
    // wired to the connection. Fall back to our manually-built remoteStream only if
    // the browser didn't send one (some older implementations).
    const streamToUse = (event.streams && event.streams[0]) ? event.streams[0] : remoteStream;

    const audio = document.getElementById('remote-audio');
    const remoteVideo = document.getElementById('remote-video');

    if (track.kind === 'audio') {
      if (audio) {
        audio.srcObject = streamToUse;
        audio.play().catch(err => DEBUG && console.warn('[Audio] Autoplay blocked:', err));
      }
      if (!state._callConnected) {
        state._callConnected = true;
        const statusEl = document.getElementById('call-status');
        if (statusEl) statusEl.textContent = 'Connected';
        startCallTimer();
      }
    }

    if (track.kind === 'video') {
      const showVideoUI = () => {
        log('[Video] Remote video track live — showing UI');
        const videoArea = document.getElementById('call-video-area');
        if (videoArea) videoArea.classList.add('active');
        const callOverlay = document.getElementById('call-overlay');
        if (callOverlay) callOverlay.classList.add('video-active');

        if (remoteVideo) {
          // Always reassign srcObject when a new video track arrives — do NOT gate on
          // srcObject !== streamToUse, because the stream object may be the same
          // reference but contain a stale/ended track from a previous negotiation.
          remoteVideo.srcObject = streamToUse;
          remoteVideo.muted = false; // Remote video must NOT be muted — audio is on remote-audio
          remoteVideo.play().catch(err => {
            DEBUG && console.warn('[Video] Remote play blocked:', err);
            // Last-resort: user-gesture-free play on some mobile browsers needs a tiny delay
            setTimeout(() => remoteVideo.play().catch(() => {}), 300);
          });
        }
      };

      // Fire immediately if track is already live (renegotiation case)
      if (track.readyState === 'live') {
        showVideoUI();
      }

      // Primary trigger: track starts flowing after ICE completes
      track.onunmute = () => {
        log('[Video] Remote track unmuted');
        showVideoUI();
      };

      // Failsafe: some browsers never fire onunmute — poll for live state
      let _videoRetries = 0;
      const _videoRetryTimer = setInterval(() => {
        _videoRetries++;
        if (track.readyState === 'live') {
          clearInterval(_videoRetryTimer);
          showVideoUI();
        } else if (_videoRetries >= 20) {
          // Give up after 10 seconds
          clearInterval(_videoRetryTimer);
        }
      }, 500);

      // Also try at 1s, 3s, 6s as belt-and-suspenders for broken mobile browsers
      [1000, 3000, 6000].forEach(delay => {
        setTimeout(() => {
          if (!remoteVideo) return;
          if (track.readyState === 'live' && (!remoteVideo.srcObject || remoteVideo.paused)) {
            remoteVideo.srcObject = streamToUse;
            remoteVideo.muted = false;
            remoteVideo.play().catch(() => {});
          }
        }, delay);
      });
    }
  };

  // ── Perfect Negotiation (RFC 8829) ──
  // FIX: Use setLocalDescription() with no args (implicit offer) — this atomically
  // creates+applies the offer. The old code called createOffer(), THEN checked
  // signalingState, causing a race where the offer was created but never applied.
  pc._makingOffer = false;
  pc._ignoreOffer = false;

  pc.onnegotiationneeded = async () => {
    // Guard: skip if remote description not set yet (initial connection not established)
    if (!pc.currentRemoteDescription) {
      log('[WebRTC/Neg] Skipping onnegotiationneeded — no remote desc yet');
      return;
    }
    // Guard: skip if another renegotiation is already in progress on this peer
    if (pc._makingOffer) {
      log('[WebRTC/Neg] Skipping onnegotiationneeded — already making offer');
      return;
    }
    try {
      pc._makingOffer = true;
      log('[WebRTC/Neg] onnegotiationneeded — creating offer');

      // FIX: setLocalDescription() with no args is atomic — creates offer and sets it
      // in one operation. No race condition between createOffer and setLocalDescription.
      await pc.setLocalDescription();

      const desc = pc.localDescription;
      if (!desc || !desc.sdp) {
        DEBUG && console.warn('[WebRTC/Neg] No local description after setLocalDescription');
        return;
      }

      // Write to the correct Firebase path based on role
      if (isCaller) {
        log('[WebRTC/Neg] Caller posting renegotiation offer → callerRenego');
        await update(ref(db, `calls/${callId}`), {
          callerRenego: { offer: { type: desc.type, sdp: desc.sdp }, nonce: Date.now() }
        });
      } else {
        log('[WebRTC/Neg] Receiver posting renegotiation offer → receiverRenego');
        await update(ref(db, `calls/${callId}`), {
          receiverRenego: { offer: { type: desc.type, sdp: desc.sdp }, nonce: Date.now() }
        });
      }
    } catch (err) {
      if (err.name !== 'InvalidStateError') {
        DEBUG && console.error('[WebRTC/Neg] onnegotiationneeded failed:', err);
      } else {
        DEBUG && console.warn('[WebRTC/Neg] InvalidStateError (ignored — state mismatch):', err.message);
      }
    } finally {
      pc._makingOffer = false;
    }
  };

  // ── Connection state monitoring ──
  pc.onconnectionstatechange = () => {
    log('[WebRTC] Connection state:', pc.connectionState);
    if (pc.connectionState === 'failed') {
      DEBUG && console.warn('[WebRTC] Connection failed — attempting recovery');
      if (pc._failedRecoveryTimer) clearTimeout(pc._failedRecoveryTimer);
      if (isCaller && pc.signalingState === 'stable') {
        try {
          pc.restartIce();
          _queueRenegotiation('connection-failed-recovery');
        } catch (err) {
          DEBUG && console.warn('[WebRTC] ICE restart after failed state failed:', err);
        }
      }
      pc._failedRecoveryTimer = setTimeout(() => {
        if (state.peerConnection === pc && pc.connectionState === 'failed') {
          // Give ICE restart one short recovery window before forcing call teardown.
          Toast.error('Call disconnected');
          endCall();
        }
      }, 8000);
    }
    if (pc.connectionState === 'connected') {
      if (pc._failedRecoveryTimer) {
        clearTimeout(pc._failedRecoveryTimer);
        pc._failedRecoveryTimer = null;
      }
    }
  };

  pc.onsignalingstatechange = () => {
    log('[WebRTC] Signaling state:', pc.signalingState);
  };

  pc.onicegatheringstatechange = () => {
    log('[ICE] Gathering state:', pc.iceGatheringState);
  };

  // ── ICE state monitoring with smart restart ──
  pc.oniceconnectionstatechange = () => {
    const iceState = pc.iceConnectionState;
    log('[ICE] State:', iceState);

    if (iceState === 'failed') {
      DEBUG && console.warn('[ICE] Failed — attempting restart...');
      // Only caller restarts ICE to avoid both sides restarting simultaneously
      if (isCaller && pc.signalingState === 'stable') {
        pc.restartIce();
        pc._makingOffer = false;
        pc.dispatchEvent(new Event('negotiationneeded'));
      }
    }

    if (iceState === 'disconnected') {
      DEBUG && console.warn('[ICE] Disconnected — waiting for self-recovery...');
      if (pc._iceRecoveryTimer) clearTimeout(pc._iceRecoveryTimer);
      pc._iceRecoveryTimer = setTimeout(() => {
        if (pc && pc.iceConnectionState === 'disconnected') {
          DEBUG && console.warn('[ICE] Still disconnected after 6s — restarting ICE');
          if (isCaller && pc.signalingState === 'stable') {
            pc.restartIce();
            pc._makingOffer = false;
            pc.dispatchEvent(new Event('negotiationneeded'));
          }
        }
      }, 6000);
    }

    if (iceState === 'connected' || iceState === 'completed') {
      if (pc._iceRecoveryTimer) {
        clearTimeout(pc._iceRecoveryTimer);
        pc._iceRecoveryTimer = null;
      }
    }
  };

  return pc;
}

// ──────────────────────────────────────────────────────────────────────────
// RENEGOTIATION CHANNEL DESIGN (FIXED)
//
// All renegotiation uses dedicated Firebase keys — no reuse, no ambiguity:
//
//   callerRenego        ← caller writes their offer here
//   callerRenegoAnswer  ← receiver writes their answer here (caller reads this)
//   receiverRenego      ← receiver writes their offer here
//   receiverRenegoAnswer← caller writes their answer here (receiver reads this)
//
// This is strictly unidirectional — no shared keys, no feedback loops.
// ──────────────────────────────────────────────────────────────────────────

// ─── CALLER: Wire renegotiation listeners ───
function _wireCaller_RenegotiationListeners(callId) {
  const pc = state.peerConnection;
  if (!pc) return;

  // FIX: Caller listens for receiver's answer to caller's renegotiation offer
  // (receiver writes to callerRenegoAnswer)
  state._unsubRenegotiationAnswer = onValue(ref(db, `calls/${callId}/callerRenegoAnswer`), async (snap) => {
    if (!snap.exists()) return;
    const pc = state.peerConnection;
    if (!pc) return;

    const answerData = snap.val();
    if (!answerData || !answerData.type || !answerData.sdp) return;
    if (answerData.nonce && pc._lastCallerRenegoAnswerNonce === answerData.nonce) return;

    // Only apply if we're waiting for an answer to our offer
    if (pc.signalingState !== 'have-local-offer') {
      log('[WebRTC/Neg] callerRenegoAnswer arrived but signalingState is', pc.signalingState, '— skipping');
      return;
    }

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(answerData));
      if (answerData.nonce) pc._lastCallerRenegoAnswerNonce = answerData.nonce;
      pc._makingOffer = false;
      log('[WebRTC/Neg] Caller applied renegotiation answer from receiver ✓');
    } catch (err) {
      if (err.name !== 'InvalidStateError') {
        DEBUG && console.error('[WebRTC/Neg] Caller failed applying renegotiation answer:', err);
      }
      pc._makingOffer = false;
    }
  });

  // FIX: Caller listens for receiver's renegotiation offer (receiver adds video)
  // (receiver writes to receiverRenego, caller answers to receiverRenegoAnswer)
  state._unsubReceiverRenegotiate = onValue(ref(db, `calls/${callId}/receiverRenego`), async (snap) => {
    if (!snap.exists()) return;
    const pc = state.peerConnection;
    if (!pc) return;

    const reneg = snap.val();
    if (!reneg || !reneg.offer || !reneg.offer.type || !reneg.offer.sdp) return;
    if (reneg.nonce && pc._lastReceiverRenegoOfferNonce === reneg.nonce) return;
    if (reneg.nonce) pc._lastReceiverRenegoOfferNonce = reneg.nonce;

    log('[WebRTC/Neg] Caller received receiver renegotiation offer (nonce:', reneg.nonce, ')');

    try {
      const offerDesc = new RTCSessionDescription(reneg.offer);

      // Perfect negotiation: caller is polite — rolls back own offer if needed
      const collision = pc._makingOffer || pc.signalingState !== 'stable';
      if (collision) {
        if (pc.signalingState === 'have-local-offer') {
          log('[WebRTC/Neg] Caller rolling back own offer (polite peer)');
          try { await pc.setLocalDescription({ type: 'rollback' }); } catch (e) {}
        } else {
          DEBUG && console.warn('[WebRTC/Neg] Caller cannot handle receiver offer in state:', pc.signalingState);
          return;
        }
      }

      await pc.setRemoteDescription(offerDesc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      // FIX: Write answer to receiverRenegoAnswer (receiver listens here)
      await update(ref(db, `calls/${callId}`), {
        receiverRenegoAnswer: { type: answer.type, sdp: answer.sdp, nonce: Date.now() }
      });
      log('[WebRTC/Neg] Caller answered receiver renegotiation → receiverRenegoAnswer ✓');
    } catch (err) {
      if (err.name !== 'InvalidStateError') {
        DEBUG && console.error('[WebRTC/Neg] Caller handling receiver renegotiation failed:', err);
      }
    }
  });
}

// ─── RECEIVER: Wire renegotiation listeners ───
function _wireReceiver_RenegotiationListeners(callId) {
  const pc = state.peerConnection;
  if (!pc) return;

  // FIX: Receiver listens for caller's renegotiation offer
  // (caller writes to callerRenego, receiver answers to callerRenegoAnswer)
  state._unsubRenegotiate = onValue(ref(db, `calls/${callId}/callerRenego`), async (snap) => {
    if (!snap.exists()) return;
    const pc = state.peerConnection;
    if (!pc) return;

    const reneg = snap.val();
    if (!reneg || !reneg.offer || !reneg.offer.type || !reneg.offer.sdp) return;
    if (reneg.nonce && pc._lastCallerRenegoOfferNonce === reneg.nonce) return;
    if (reneg.nonce) pc._lastCallerRenegoOfferNonce = reneg.nonce;

    log('[WebRTC/Neg] Receiver received caller renegotiation offer (nonce:', reneg.nonce, ')');

    try {
      // Guard: prevent our own onnegotiationneeded from firing during this
      pc._makingOffer = true;

      const offer = new RTCSessionDescription(reneg.offer);

      // If receiver was also making an offer, roll it back (impolite peer behavior)
      if (pc.signalingState === 'have-local-offer') {
        log('[WebRTC/Neg] Receiver rolling back own offer to accept caller offer');
        try { await pc.setLocalDescription({ type: 'rollback' }); } catch (e) {}
      }

      await pc.setRemoteDescription(offer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      // FIX: Write answer to callerRenegoAnswer (caller listens here, NOT 'answer' or 'receiverAnswer')
      await update(ref(db, `calls/${callId}`), {
        callerRenegoAnswer: { type: answer.type, sdp: answer.sdp, nonce: Date.now() }
      });
      log('[WebRTC/Neg] Receiver answered caller renegotiation → callerRenegoAnswer ✓');
    } catch (err) {
      DEBUG && console.error('[WebRTC/Neg] Receiver handling caller renegotiation failed:', err);
    } finally {
      if (state.peerConnection) state.peerConnection._makingOffer = false;
    }
  });

  // FIX: Receiver listens for caller's answer to receiver's own renegotiation
  // (caller writes to receiverRenegoAnswer, receiver reads it here)
  state._unsubReceiverAnswer = onValue(ref(db, `calls/${callId}/receiverRenegoAnswer`), async (snap) => {
    if (!snap.exists()) return;
    if (!state.peerConnection) return;

    const answerData = snap.val();
    if (!answerData || !answerData.type || !answerData.sdp) return;
    if (answerData.nonce && state.peerConnection._lastReceiverRenegoAnswerNonce === answerData.nonce) return;

    if (state.peerConnection.signalingState !== 'have-local-offer') {
      log('[WebRTC/Neg] receiverRenegoAnswer arrived but signalingState is', state.peerConnection.signalingState, '— skipping');
      return;
    }

    try {
      const remoteDesc = new RTCSessionDescription(answerData);
      await state.peerConnection.setRemoteDescription(remoteDesc);
      if (answerData.nonce) state.peerConnection._lastReceiverRenegoAnswerNonce = answerData.nonce;
      log('[WebRTC/Neg] Receiver applied renegotiation answer from caller ✓');
    } catch (err) {
      DEBUG && console.error('[WebRTC/Neg] Receiver failed to apply renegotiation answer:', err);
    } finally {
      if (state.peerConnection) state.peerConnection._makingOffer = false;
    }
  });
}

// ─── Shared ICE candidate queue ───
function _addIceCandidateWithRetry(candidate, maxAttempts) {
  const tryAdd = async (attempts) => {
    if (!state.peerConnection) return;
    const pc = state.peerConnection;
    if (pc.remoteDescription && pc.signalingState !== 'closed') {
      try {
        await pc.addIceCandidate(candidate);
      } catch (err) {
        if (err.name === 'InvalidStateError' && attempts < maxAttempts) {
          setTimeout(() => tryAdd(attempts + 1), 300);
        } else {
          DEBUG && console.warn('[ICE] Could not add candidate after retries:', err.message);
        }
      }
    } else if (attempts < maxAttempts) {
      setTimeout(() => tryAdd(attempts + 1), 300);
    } else {
      DEBUG && console.warn('[ICE] Gave up waiting for remote description to add candidate');
    }
  };
  tryAdd(0);
}

// ─── CALLER: Start a call ───
async function startCall() {
  if (!state.currentUser || !state.chatPartnerId) {
    Toast.error('Open a chat first');
    return;
  }
  if (state.peerConnection) {
    Toast.info('Already in a call');
    return;
  }

  const callId = state.chatId + '_' + Date.now();
  state.callId = callId;

  try {
    // ── PRO MEDIA: Use enhanced audio constraints for Pro users ──
    state.localStream = await navigator.mediaDevices.getUserMedia(ProMedia.getAudioConstraints());
  } catch (err) {
    Toast.error('Microphone access denied. Please allow microphone in browser settings.');
    DEBUG && console.error('[Call] Mic error:', err);
    return;
  }

  showCallOverlay(state.chatPartnerUsername);

  // Wire call control buttons
  const endBtn = document.getElementById('call-end-btn');
  if (endBtn) {
    const newEndBtn = endBtn.cloneNode(true);
    endBtn.parentNode.replaceChild(newEndBtn, endBtn);
    newEndBtn.addEventListener('click', () => endCall());
  }
  const switchBtn = document.getElementById('call-video-switch-btn');
  if (switchBtn) {
    const newSwitch = switchBtn.cloneNode(true);
    switchBtn.parentNode.replaceChild(newSwitch, switchBtn);
    newSwitch.addEventListener('click', () => requestVideoSwitch());
    newSwitch.innerHTML = '<i data-lucide="video" class="lucide" width="16" height="16"></i> Switch to Video';
    newSwitch.disabled = false;
  }
  const cameraBtn = document.getElementById('call-camera-btn');
  if (cameraBtn) {
    const newCamera = cameraBtn.cloneNode(true);
    cameraBtn.parentNode.replaceChild(newCamera, cameraBtn);
    newCamera.addEventListener('click', () => switchCamera());
  }

  const iceServers = await getIceServers();
  state.peerConnection = createPeerConnection(callId, true, iceServers);
  _ensureVideoSender(state.peerConnection);

  // Start listening for video switch requests (after connection established)
  setTimeout(() => listenForVideoRequests(callId), 2000);

  // Add microphone audio
  state.localStream.getTracks().forEach(track => {
    state.peerConnection.addTrack(track, state.localStream);
  });

  // Create initial offer
  const offer = await state.peerConnection.createOffer();
  await state.peerConnection.setLocalDescription(offer);

  // Save call to Firebase
  await set(ref(db, `calls/${callId}`), {
    callerId: state.currentUser.uid,
    callerName: state.username,
    receiverId: state.chatPartnerId,
    status: 'calling',
    createdAt: Date.now(),
    offer: { type: offer.type, sdp: offer.sdp }
  });

  // Auto-cancel after 30 seconds if no answer
  state._ringTimeout = setTimeout(async () => {
    if (state.peerConnection && !state.peerConnection.currentRemoteDescription) {
      Toast.info('No answer — call cancelled');
      endCall();
    }
  }, 30000);

  // Listen for the initial answer
  const callRef = ref(db, `calls/${callId}`);
  const unsubAnswer = onValue(callRef, async (snap) => {
    const data = snap.val();
    if (!data) return;

    if (data.status === 'accepted' && data.answer && state.peerConnection) {
      const statusEl = document.getElementById('call-status');
      if (statusEl) statusEl.textContent = 'Connecting audio...';

      if (!state.peerConnection.currentRemoteDescription) {
        const remoteDesc = new RTCSessionDescription(data.answer);
        await state.peerConnection.setRemoteDescription(remoteDesc).catch(e => DEBUG && console.error(e));
        unsubAnswer();
        // Wire renegotiation listeners AFTER initial connection established
        _wireCaller_RenegotiationListeners(callId);
      }
    }

    if (data.status === 'rejected') {
      Toast.info('Call was declined');
      endCall();
      unsubAnswer();
    }

    if (data.status === 'ended') {
      Toast.info('Call ended');
      endCall();
      unsubAnswer();
    }
  });

  // Listen for ICE candidates from the receiver
  state._addedCallerCandidates = new Set();
  const receiverCandidatesRef = ref(db, `calls/${callId}/receiverCandidates`);
  state._unsubIceCaller = onChildAdded(receiverCandidatesRef, async (childSnap) => {
    const key = childSnap.key;
    if (state._addedCallerCandidates.has(key)) return;
    state._addedCallerCandidates.add(key);
    const candidate = new RTCIceCandidate(childSnap.val());
    _addIceCandidateWithRetry(candidate, 30);
  });
}

// ─── RECEIVER: Accept the incoming call ───
async function acceptCall(callData, callId) {
  hideIncomingBanner();
  state.callId = callId;
  state.incomingCallRef = null;

  try {
    // ── PRO MEDIA: Use enhanced audio constraints for Pro users ──
    state.localStream = await navigator.mediaDevices.getUserMedia(ProMedia.getAudioConstraints());
  } catch (err) {
    Toast.error('Microphone access denied');
    await set(ref(db, `calls/${callId}/status`), 'rejected').catch(() => {});
    return;
  }

  showCallOverlay(callData.callerName || 'Someone');
  const statusEl = document.getElementById('call-status');
  if (statusEl) statusEl.textContent = 'Connecting...';

  // Wire call control buttons
  const endBtn = document.getElementById('call-end-btn');
  if (endBtn) {
    const newEndBtn = endBtn.cloneNode(true);
    endBtn.parentNode.replaceChild(newEndBtn, endBtn);
    newEndBtn.addEventListener('click', () => endCall());
  }
  const switchBtn = document.getElementById('call-video-switch-btn');
  if (switchBtn) {
    const newSwitch = switchBtn.cloneNode(true);
    switchBtn.parentNode.replaceChild(newSwitch, switchBtn);
    newSwitch.addEventListener('click', () => requestVideoSwitch());
    newSwitch.innerHTML = '<i data-lucide="video" class="lucide" width="16" height="16"></i> Switch to Video';
    newSwitch.disabled = false;
  }
  const cameraBtn = document.getElementById('call-camera-btn');
  if (cameraBtn) {
    const newCamera = cameraBtn.cloneNode(true);
    cameraBtn.parentNode.replaceChild(newCamera, cameraBtn);
    newCamera.addEventListener('click', () => switchCamera());
  }

  const iceServers = await getIceServers();
  state.peerConnection = createPeerConnection(callId, false, iceServers);
  _ensureVideoSender(state.peerConnection);

  // Start listening for video switch requests
  setTimeout(() => listenForVideoRequests(callId), 1000);

  // Add microphone
  state.localStream.getTracks().forEach(track => {
    state.peerConnection.addTrack(track, state.localStream);
  });

  // Set caller's offer as remote description
  const offer = new RTCSessionDescription(callData.offer);
  await state.peerConnection.setRemoteDescription(offer).catch(e => DEBUG && console.error(e));

  // Create answer
  const answer = await state.peerConnection.createAnswer();
  await state.peerConnection.setLocalDescription(answer);

  // Send answer to caller
  await update(ref(db, `calls/${callId}`), {
    status: 'accepted',
    answer: { type: answer.type, sdp: answer.sdp }
  });

  // Wire renegotiation listeners immediately (receiver is already connected)
  _wireReceiver_RenegotiationListeners(callId);

  // Listen for ICE candidates from the caller
  state._addedReceiverCandidates = new Set();
  const callerCandidatesRef = ref(db, `calls/${callId}/callerCandidates`);
  state._unsubIceReceiver = onChildAdded(callerCandidatesRef, async (childSnap) => {
    const key = childSnap.key;
    if (state._addedReceiverCandidates.has(key)) return;
    state._addedReceiverCandidates.add(key);
    const candidate = new RTCIceCandidate(childSnap.val());
    _addIceCandidateWithRetry(candidate, 30);
  });

  // Watch for call end or cancellation
  const unsubStatus = onValue(ref(db, `calls/${callId}/status`), (snap) => {
    const status = snap.val();
    if (status === 'ended') {
      Toast.info('Call ended');
      unsubStatus();
      endCall();
    }
    if (status === null || !snap.exists()) {
      Toast.info('Caller hung up');
      unsubStatus();
      endCall();
    }
  });
}

// ─── End a call (both sides can call this) ───
async function endCall() {
  if (state._ringTimeout) {
    clearTimeout(state._ringTimeout);
    state._ringTimeout = null;
  }

  const callId = state.callId;
  cleanupCall();

  if (callId) {
    await update(ref(db, `calls/${callId}`), { status: 'ended' }).catch(() => {});
    setTimeout(() => {
      remove(ref(db, `calls/${callId}`)).catch(() => {});
    }, 3000);
  }
}

// ─── Listen for incoming calls ───
function listenForIncomingCalls() {
  if (!state.currentUser) return;

  if (state.unsubIncomingCall) {
    state.unsubIncomingCall();
    state.unsubIncomingCall = null;
  }

  const myCallsRef = ref(db, 'calls');

  const unsubFn = onChildAdded(myCallsRef, (childSnap) => {
    const data = childSnap.val();
    const callId = childSnap.key;

    if (!data) return;

    // Ignore stale calls (> 35 seconds old)
    if (data.createdAt && (Date.now() - data.createdAt) > 35000) return;

    if (
      data.receiverId === state.currentUser.uid &&
      data.status === 'calling' &&
      !state.peerConnection
    ) {
      if (state.incomingCallRef && state.incomingCallRef.callId === callId) return;

      state.incomingCallRef = { data, callId };
      showIncomingBanner(data.callerName || 'Someone');

      const acceptBtn = document.getElementById('accept-call-btn');
      const rejectBtn = document.getElementById('reject-call-btn');

      if (acceptBtn) {
        const newAccept = acceptBtn.cloneNode(true);
        acceptBtn.parentNode.replaceChild(newAccept, acceptBtn);
        newAccept.addEventListener('click', () => acceptCall(data, callId));
      }

      if (rejectBtn) {
        const newReject = rejectBtn.cloneNode(true);
        rejectBtn.parentNode.replaceChild(newReject, rejectBtn);
        newReject.addEventListener('click', async () => {
          hideIncomingBanner();
          state.incomingCallRef = null;
          await update(ref(db, `calls/${callId}`), { status: 'rejected' }).catch(() => {});
          setTimeout(() => remove(ref(db, `calls/${callId}`)).catch(() => {}), 2000);
        });
      }
    }
  });

  state.unsubIncomingCall = unsubFn;
}

const ProjectVoiceCallSystem = {
  currentProjectId: null,
  currentProjectData: null,
  currentMembers: {},
  currentCallData: null,
  inCall: false,
  localStream: null,
  isMuted: false,
  peers: new Map(),
  _signalQueues: new Map(),
  _unsubCall: null,
  _unsubSignals: null,
  _onDisconnectParticipant: null,
  _onDisconnectSignals: null,
  _activeCallRef: null,
  _lastRingToastAt: null,

  /* ─── Project Video Call State ─── */
  videoEnabled: false,
  localVideoStream: null,
  _currentFacingMode: 'user',
  _unsubVideoMode: null,
  _videoConsentShown: false,
  _videoGridTiles: new Map(),   // uid → tile element
  _videoModeData: null,         // latest snapshot of calls/.../videoMode

  init() {
    $('proj-ws-voice-call-btn')?.addEventListener('click', () => this.handlePrimaryAction());
    $('proj-call-mute-btn')?.addEventListener('click', () => this.toggleMute());
    $('proj-call-leave-btn')?.addEventListener('click', () => this.leaveCall());

    // ── Project Video Call Buttons ──
    $('proj-call-video-switch-btn')?.addEventListener('click', () => this.requestVideoSwitch());
    $('proj-call-video-reopen-btn')?.addEventListener('click', () => this._showVideoOverlayIfVideo());
    $('pvc-accept')?.addEventListener('click', () => this.respondToVideoSwitch(true));
    $('pvc-deny')?.addEventListener('click', () => this.respondToVideoSwitch(false));

    // ── Video Overlay Controls ──
    $('pvg-mute-btn')?.addEventListener('click', () => this.toggleMute());
    $('pvg-video-btn')?.addEventListener('click', () => this._toggleProjectVideo());
    $('pvg-flip-btn')?.addEventListener('click', () => this._flipProjectCamera());
    $('pvg-sketch-btn')?.addEventListener('click', () => {
      SketchBoardSystem.openForCall(this.currentProjectId, 'project', `${this.currentProjectData?.name || 'Project'} Sketch`);
    });
    $('pvg-minimise-btn')?.addEventListener('click', () => this._minimiseVideoOverlay());
    $('pvg-leave-btn')?.addEventListener('click', () => this.leaveCall());
  },

  setProject(pid, info) {
    this.detachProject();
    this.currentProjectId = pid;
    this.currentProjectData = info || null;
    this.currentMembers = {};
    this._watchCallNode();
    this._refreshActionButton();
  },

  updateMembers(members, info) {
    this.currentMembers = members || {};
    if (info) this.currentProjectData = info;
    this._refreshActionButton();
    this._renderParticipants();
  },

  detachProject() {
    if (this._unsubCall) { this._unsubCall(); this._unsubCall = null; }
    if (this._unsubSignals) { this._unsubSignals(); this._unsubSignals = null; }
    if (this._unsubVideoMode) { this._unsubVideoMode(); this._unsubVideoMode = null; }
    this.currentCallData = null;
    this._refreshActionButton();
    if (this.inCall) this._cleanupCall(true);
    this.currentProjectId = null;
    this.currentProjectData = null;
    this.currentMembers = {};
  },

  _watchCallNode() {
    if (!this.currentProjectId) return;
    this._unsubCall = onValue(ref(db, `calls/${this.currentProjectId}`), (snap) => {
      const data = snap.exists() ? snap.val() : null;
      this.currentCallData = (data && data.type === 'project') ? data : null;
      this._activeCallRef = this.currentCallData ? ref(db, `calls/${this.currentProjectId}`) : null;
      this._refreshActionButton();

      if (!this.currentCallData) {
        if (this.inCall) this._cleanupCall(false);
        return;
      }

      const participants = this.currentCallData.participants || {};
      const me = state.currentUser?.uid;
      if (!me) return;

      if (!participants[this.currentCallData.ownerId] && this.currentCallData.status !== 'ended') {
        this._endCallNode('Owner left');
        return;
      }

      if (!this.inCall && this.currentCallData.status === 'ringing' && !participants[me]) {
        if (this._lastRingToastAt !== this.currentCallData.createdAt) {
          this._lastRingToastAt = this.currentCallData.createdAt;
          Toast.info(`Incoming project call in "${this.currentProjectData?.name || 'project'}"`);
        }
      }

      if (this.currentCallData.status === 'ended') {
        this.currentCallData = null;
        this._activeCallRef = null;
        if (this.inCall) this._cleanupCall(false);
        this._refreshActionButton();
        remove(ref(db, `calls/${this.currentProjectId}`)).catch(() => {});
        return;
      }

      if (this.inCall && !participants[me]) {
        this._cleanupCall(false);
        return;
      }

      if (this.inCall) {
        this._ensurePeerMesh(participants);
        this._reconcileStatus();
      }
      this._renderParticipants();
    });

    // ── Watch videoMode node for video-call signaling ──
    this._watchVideoMode();
  },

  _watchVideoMode() {
    if (!this.currentProjectId) return;
    if (this._unsubVideoMode) { this._unsubVideoMode(); this._unsubVideoMode = null; }
    this._unsubVideoMode = onValue(ref(db, `calls/${this.currentProjectId}/videoMode`), (snap) => {
      const vm = snap.exists() ? snap.val() : null;
      this._videoModeData = vm;
      this._handleVideoModeUpdate(vm);
    });
  },

  _handleVideoModeUpdate(vm) {
    if (!this.inCall || !state.currentUser) return;
    const me = state.currentUser.uid;

    if (!vm || !vm.requestedBy) {
      // Video mode cleared — make sure consent popup is hidden
      this._hideVideoConsentPopup();
      return;
    }

    // Show "Switch to Video" in the call card only for the owner who hasn't yet requested
    const isOwner = this.currentProjectData?.ownerId === me;
    const videoSwitchBtn = $('proj-call-video-switch-btn');
    if (videoSwitchBtn) videoSwitchBtn.style.display = (isOwner && !vm.requestedBy) ? 'block' : 'none';

    // If I'm the requester, I've already started my own video — nothing else to do here
    if (vm.requestedBy === me) return;

    // Non-owner: check if I've already responded
    const myResponse = vm.responses?.[me];
    if (myResponse) return; // already responded, don't show popup again

    // Show consent popup if not already visible
    if (!this._videoConsentShown) {
      this._videoConsentShown = true;
      const requesterName = this.currentMembers?.[vm.requestedBy]?.username ||
        this.currentCallData?.participants?.[vm.requestedBy]?.username || 'The host';
      this._showVideoConsentPopup(requesterName);
    }
  },

  _watchSignals() {
    if (!this.currentProjectId || !state.currentUser) return;
    if (this._unsubSignals) { this._unsubSignals(); this._unsubSignals = null; }
    const mySignalRef = ref(db, `calls/${this.currentProjectId}/signals/${state.currentUser.uid}`);
    this._unsubSignals = onChildAdded(mySignalRef, (snap) => {
      const sig = snap.val() || {};
      if (!sig || sig.to !== state.currentUser.uid || sig.from === state.currentUser.uid) {
        remove(snap.ref).catch(() => {});
        return;
      }
      // FIX BUG 3: Discard signals that predate this call session.
      // onChildAdded replays all existing children on attach — stale signals
      // from a previous crashed/disconnected call would corrupt the new handshake.
      if (sig.createdAt && this.currentCallData?.createdAt && sig.createdAt < this.currentCallData.createdAt) {
        remove(snap.ref).catch(() => {});
        return;
      }
      // Serialize signal processing per remote peer to prevent race conditions.
      // onChildAdded fires all callbacks near-simultaneously but does NOT await them,
      // so without this queue an ICE candidate can be processed before setRemoteDescription.
      const remoteUid = sig.from;
      const prev = this._signalQueues.get(remoteUid) || Promise.resolve();
      const next = prev.then(async () => {
        try {
          await this._handleSignal(sig);
        } catch (e) {
          DEBUG && console.warn('[ProjectCall] Signal handling error:', e?.message || e);
        } finally {
          remove(snap.ref).catch(() => {});
        }
      });
      this._signalQueues.set(remoteUid, next);
    });
  },

  async handlePrimaryAction() {
    if (!this.currentProjectId || !state.currentUser) return;
    if (state.peerConnection || state.callId) {
      Toast.info('Finish your direct call first');
      return;
    }

    if (this.inCall) {
      await this.leaveCall();
      return;
    }

    const call = this.currentCallData;
    const isOwner = this.currentProjectData?.ownerId === state.currentUser.uid;
    const memberCount = Object.keys(this.currentMembers || {}).length;

    if (!call) {
      if (!isOwner || memberCount < 2) {
        Toast.info('Only owners can start calls with at least 2 members');
        return;
      }
      await this._startCall();
      return;
    }

    await this._joinCall();
  },

  async _startCall() {
    if (!this.currentProjectId || !state.currentUser || !this.currentProjectData) return;
    const uid = state.currentUser.uid;
    const now = Date.now();
    const participant = {
      uid,
      username: state.username || 'Unknown',
      muted: false,
      joinedAt: now
    };

    const existingSnap = await get(ref(db, `calls/${this.currentProjectId}`)).catch(() => null);
    if (existingSnap?.exists() && existingSnap.val()?.type !== 'project') {
      Toast.error('Call path busy. Try again shortly.');
      return;
    }

    await set(ref(db, `calls/${this.currentProjectId}`), {
      type: 'project',
      projectId: this.currentProjectId,
      ownerId: uid,
      status: 'ringing',
      createdAt: now,
      participantsCount: 1,
      participants: { [uid]: participant },
      signals: {}
    });
    await this._joinCall();
  },

  async _joinCall() {
    if (!this.currentProjectId || !state.currentUser) return;
    const uid = state.currentUser.uid;
    if (!this.currentMembers || !this.currentMembers[uid]) {
      Toast.error('Only project members can join');
      return;
    }

    const tx = await runTransaction(ref(db, `calls/${this.currentProjectId}`), (call) => {
      if (!call || call.type !== 'project' || call.status === 'ended') return call;
      if (!call.participants || typeof call.participants !== 'object') call.participants = {};
      if (call.participants[uid]) return call;
      if (Object.keys(call.participants).length >= 4) return;
      call.participants[uid] = {
        uid,
        username: state.username || 'Unknown',
        muted: false,
        joinedAt: Date.now()
      };
      const count = Object.keys(call.participants).length;
      call.participantsCount = count;
      call.status = count >= 2 ? 'active' : 'ringing';
      return call;
    }, { applyLocally: false });

    if (!tx.committed || !tx.snapshot.exists()) {
      Toast.error('Unable to join call');
      return;
    }
    const joinedCall = tx.snapshot.val();
    if (!joinedCall.participants || !joinedCall.participants[uid]) {
      Toast.info('Call is full (max 4)');
      return;
    }

    try {
      await this._ensureLocalStream();
    } catch (e) {
      await this.leaveCall();
      Toast.error('Microphone permission is required');
      return;
    }

this.inCall = true;
    this.isMuted = false;
    this._watchSignals();
    this._setDisconnectGuards();
    // FIX BUG 1: Explicitly establish peer mesh after joining.
    // _watchCallNode may have fired while _ensureLocalStream() was awaiting
    // (mic prompt), at which point this.inCall was still false and _ensurePeerMesh
    // was skipped. Without this explicit call the lower-UID user (the designated
    // offerer) never creates a peer connection and no audio is transmitted.
    this._ensurePeerMesh(joinedCall.participants || {});
    this._showOverlay();
    this._refreshActionButton();
  },

  async leaveCall() {
    if (!this.currentProjectId || !state.currentUser) {
      this._cleanupCall(false);
      return;
    }
    const uid = state.currentUser.uid;
    const callRef = ref(db, `calls/${this.currentProjectId}`);
    await runTransaction(callRef, (call) => {
      if (!call || call.type !== 'project') return call;
      const participants = call.participants || {};
      if (!participants[uid]) return call;
      delete participants[uid];
      const count = Object.keys(participants).length;
      if (uid === call.ownerId) {
        return null;
      }
      if (count === 0) return null;
      call.participants = participants;
      call.participantsCount = count;
      call.status = count >= 2 ? 'active' : 'ringing';
      return call;
    }, { applyLocally: false }).catch(() => {});

    const others = Object.keys(this.currentCallData?.participants || {}).filter(pid => pid !== uid);
    await Promise.all(others.map(oid => this._sendSignal(oid, 'leave', {}))).catch(() => {});
    this._cleanupCall(false);
  },

  async toggleMute() {
    if (!this.localStream || !state.currentUser || !this.currentProjectId) return;
    this.isMuted = !this.isMuted;
    this.localStream.getAudioTracks().forEach(t => { t.enabled = !this.isMuted; });
    $('proj-call-mute-btn').textContent = this.isMuted ? 'Unmute' : 'Mute';
    // Sync video overlay mute button
    this._syncVideoOverlayMute();
    await update(ref(db, `calls/${this.currentProjectId}/participants/${state.currentUser.uid}`), {
      muted: this.isMuted
    }).catch(() => {});
  },

  async _ensureLocalStream() {
    if (this.localStream) return;
    // ── PRO MEDIA: Enhanced audio constraints for Pro users ──
    this.localStream = await navigator.mediaDevices.getUserMedia(ProMedia.getAudioConstraints());
  },

  _showOverlay() {
    const overlay = $('proj-call-overlay');
    if (overlay) overlay.classList.add('active');
    const title = $('proj-call-title');
    if (title) title.textContent = `${this.currentProjectData?.name || 'Project'} Voice Call`;
    const muteBtn = $('proj-call-mute-btn');
    if (muteBtn) muteBtn.textContent = this.isMuted ? 'Unmute' : 'Mute';

    // Show "Switch to Video" only to the call owner
    const isOwner = this.currentProjectData?.ownerId === state.currentUser?.uid;
    const videoSwitchBtn = $('proj-call-video-switch-btn');
    if (videoSwitchBtn) {
      // Only show if video mode not already requested
      const videoRequested = !!(this._videoModeData?.requestedBy);
      videoSwitchBtn.style.display = (isOwner && !videoRequested) ? 'block' : 'none';
    }
    const videoReopenBtn = $('proj-call-video-reopen-btn');
    if (videoReopenBtn) videoReopenBtn.style.display = 'none';

    this._renderParticipants();
  },

  _hideOverlay() {
    const overlay = $('proj-call-overlay');
    if (overlay) overlay.classList.remove('active');
  },

  _renderParticipants() {
    const list = $('proj-call-member-list');
    const status = $('proj-call-status');
    if (!list) return;
    const participants = this.currentCallData?.participants || {};
    const entries = Object.entries(participants);
    const count = entries.length;
    if (status) {
      const callStatus = this.currentCallData?.status || 'ringing';
      const videoOn = !!(this._videoModeData?.requestedBy);
      status.textContent = `${callStatus === 'active' ? 'In call' : 'Ringing'} · ${count}/4${videoOn ? ' · Video' : ''}`;
    }
    list.innerHTML = '';
    if (entries.length === 0) {
      list.innerHTML = '<div class="proj-call-member-row"><span>No participants</span></div>';
      return;
    }
    entries.sort((a, b) => (a[1]?.joinedAt || 0) - (b[1]?.joinedAt || 0));
    entries.forEach(([uid, p]) => {
      const row = document.createElement('div');
      row.className = 'proj-call-member-row';
      const name = p?.username || this.currentMembers?.[uid]?.username || 'Member';
      const roleTag = uid === this.currentCallData?.ownerId ? ' ★' : '';
      const videoResponse = this._videoModeData?.responses?.[uid];
      const videoTag = videoResponse === 'accepted' ? ' <span class="proj-call-member-video"><i data-lucide="video" class="lucide" width="10" height="10"></i></span>' : 
                       videoResponse === 'denied' ? ' <span style="font-size:9px;color:var(--muted)"><i data-lucide="mic" class="lucide" width="10" height="10"></i></span>' : '';
      row.innerHTML = `
        <span>@${escHtml(name)}${roleTag}${videoTag}</span>
        <span class="proj-call-member-muted">${p?.muted ? '<i data-lucide="mic-off" class="lucide" width="10" height="10"></i> Muted' : '<i data-lucide="mic" class="lucide" width="10" height="10"></i> Live'}</span>
      `;
      list.appendChild(row);
    });

    // Also update video grid if video is active
    if (this.videoEnabled) {
      this._renderVideoGrid();
    }
  },

  _refreshActionButton() {
    const btn = $('proj-ws-voice-call-btn');
    const btnLabel = $('proj-ws-voice-call-btn-label');
    const bar = $('proj-call-bar');
    const barStatus = $('proj-call-bar-status');
    if (!btn || !btnLabel || !bar || !barStatus || !state.currentUser) return;

    const callsEnabled = !state.featureFlags || state.featureFlags.calls_enabled !== false;
    if (!callsEnabled || !this.currentProjectId || !this.currentProjectData) {
      btn.style.display = 'none';
      bar.style.display = 'none';
      return;
    }

    const uid = state.currentUser.uid;
    const isOwner = this.currentProjectData.ownerId === uid;
    const isMember = !!(this.currentMembers && this.currentMembers[uid]);
    const memberCount = Object.keys(this.currentMembers || {}).length;
    const rawCall = this.currentCallData;
    const call = (rawCall && rawCall.status !== 'ended') ? rawCall : null;
    const participants = call?.participants || {};
    const inParticipants = !!participants[uid];
    const pCount = Object.keys(participants).length;

    // ── Video switch button visibility ──
    const videoSwitchBtn = $('proj-call-video-switch-btn');
    const videoReopenBtn = $('proj-call-video-reopen-btn');
    if (videoSwitchBtn && this.inCall) {
      const videoRequested = !!(this._videoModeData?.requestedBy);
      videoSwitchBtn.style.display = (isOwner && !videoRequested && !this.videoEnabled) ? 'block' : 'none';
    } else if (videoSwitchBtn) {
      videoSwitchBtn.style.display = 'none';
    }
    if (videoReopenBtn && this.inCall) {
      videoReopenBtn.style.display = this.videoEnabled ? 'block' : 'none';
    } else if (videoReopenBtn) {
      videoReopenBtn.style.display = 'none';
    }

    if (call) {
      bar.style.display = 'flex';
      barStatus.textContent = `${call.status === 'active' ? 'Active call' : 'Ringing'} · ${pCount}/4 participants`;
      btn.style.display = isMember ? 'inline-flex' : 'none';
      if (!isMember) return;
      if (inParticipants || this.inCall) {
        btnLabel.textContent = 'Leave Voice Call';
        btn.disabled = false;
      } else if (pCount >= 4) {
        btnLabel.textContent = 'Call Full (4/4)';
        btn.disabled = true;
      } else {
        btnLabel.textContent = 'Join Voice Call';
        btn.disabled = false;
      }
      return;
    }

    bar.style.display = 'none';
    if (isOwner && memberCount >= 2) {
      btn.style.display = 'inline-flex';
      btnLabel.textContent = 'Start Voice Call';
      btn.disabled = false;
    } else {
      btn.style.display = 'none';
      btn.disabled = false;
    }
  },

  async _ensurePeerMesh(participants) {
    if (!this.inCall || !state.currentUser) return;
    const myUid = state.currentUser.uid;
    const remoteIds = Object.keys(participants || {}).filter(uid => uid !== myUid);
    const existingIds = [...this.peers.keys()];

    for (const rid of existingIds) {
      if (!remoteIds.includes(rid)) this._closePeer(rid);
    }

    // Only create peers for connections WE are responsible for offering.
    // Using lexicographic UID comparison ensures exactly one side initiates per pair.
    // The non-offerer (myUid > rid) creates its peer lazily inside _handleSignal
    // when the offer arrives, avoiding the race where the peer placeholder exists
    // but the RTCPeerConnection is not yet ready (waiting on getIceServers).
    for (const rid of remoteIds) {
      if (!this.peers.has(rid) && myUid < rid) {
        await this._createPeer(rid, true);
      }
    }
  },

  async _createPeer(remoteUid, shouldOffer) {
    if (!this.localStream || this.peers.has(remoteUid) || !state.currentUser) return;
    // Set placeholder BEFORE any await so concurrent _handleSignal calls see it immediately
    // and don't race to create a second RTCPeerConnection for the same remote peer.
    const peerState = { pc: null, pendingCandidates: [], _videoSender: null };
    this.peers.set(remoteUid, peerState);
    try {
      const iceServers = await getIceServers();
      const pc = new RTCPeerConnection({ iceServers });
      peerState.pc = pc;

      // Add all local tracks (audio + video if enabled)
      this.localStream.getTracks().forEach(track => pc.addTrack(track, this.localStream));

      // If video is already enabled when peer connects, add video track too
      if (this.videoEnabled && this.localVideoStream) {
        const videoTrack = this.localVideoStream.getVideoTracks()[0];
        if (videoTrack) {
          const existingVideoSender = pc.getSenders().find(s => s.track?.kind === 'video');
          if (!existingVideoSender) {
            const sender = pc.addTrack(videoTrack, this.localVideoStream);
            peerState._videoSender = sender;
          }
        }
      }

      pc.onicecandidate = (event) => {
        if (event.candidate) this._sendSignal(remoteUid, 'ice', event.candidate.toJSON());
      };

      pc.ontrack = (event) => {
        const track = event.track;
        if (!track) return;
        // Prefer browser-provided stream (already wired to the connection).
        // Fall back to a new MediaStream only if the browser omitted it.
        const stream = (event.streams && event.streams[0]) ? event.streams[0] : new MediaStream([track]);

        log(`[ProjectCall] ontrack: kind=${track.kind}, readyState=${track.readyState}, streams=${event.streams?.length}`);

        if (track.kind === 'audio') {
          this._attachRemoteAudio(remoteUid, stream);
        } else if (track.kind === 'video') {
          // FIX: Always attempt to attach immediately — don't gate on readyState.
          // On many browsers (especially mobile Safari/Chrome) the track fires
          // 'ontrack' while still muted/not-yet-live. Calling _attachRemoteVideo
          // unconditionally sets srcObject early so when the track goes live the
          // video element is already wired and plays without delay.
          this._attachRemoteVideo(remoteUid, stream);

          // Re-attach on unmute (most reliable cross-browser trigger for the
          // moment the remote video actually starts producing frames)
          track.onunmute = () => {
            log(`[ProjectCall] Video track unmuted for ${remoteUid}`);
            this._attachRemoteVideo(remoteUid, stream);
          };
          // Belt-and-suspenders: retry polling for 30s (mobile connections can be slow)
          let _retries = 0;
          const _poll = setInterval(() => {
            _retries++;
            if (track.readyState === 'live') {
              clearInterval(_poll);
              this._attachRemoteVideo(remoteUid, stream);
            } else if (_retries >= 60) {
              clearInterval(_poll);
            }
          }, 500);
        }
      };

      pc.onconnectionstatechange = () => {
        const st = pc.connectionState;
        if (st === 'failed' || st === 'closed') this._closePeer(remoteUid);
        if (st === 'disconnected') {
          setTimeout(() => {
            if (pc.connectionState === 'disconnected') this._closePeer(remoteUid);
          }, 5000);
        }
      };

      if (shouldOffer) {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await this._sendSignal(remoteUid, 'offer', { type: offer.type, sdp: offer.sdp });
      }
    } catch (e) {
      DEBUG && console.warn('[ProjectCall] _createPeer error:', e?.message || e);
      // Remove placeholder on error so _ensurePeerMesh can retry.
      if (this.peers.get(remoteUid) === peerState) this.peers.delete(remoteUid);
    }
  },

  async _handleSignal(sig) {
    const remoteUid = sig.from;
    if (!remoteUid || !this.inCall || !state.currentUser) return;

    if (sig.type === 'leave') {
      this._closePeer(remoteUid);
      return;
    }

    if (!this.peers.has(remoteUid)) {
      await this._createPeer(remoteUid, false);
    }

    const peerState = this.peers.get(remoteUid);

    // If the placeholder exists but pc is not yet ready (getIceServers in flight),
    // poll briefly. This is rare because signals are serialized per remote UID,
    // meaning _createPeer normally completes before subsequent signals are processed.
    if (peerState && !peerState.pc) {
      await new Promise(resolve => {
        const t = setInterval(() => {
          if (!peerState || peerState.pc || !this.peers.has(remoteUid)) {
            clearInterval(t); resolve();
          }
        }, 30);
      });
    }

    const pc = peerState?.pc;
    if (!pc || pc.signalingState === 'closed') return;

    if (sig.type === 'offer' && sig.payload?.sdp) {
      // FIX: Handle offer glare — both sides may renegotiate simultaneously when
      // they each enable their camera. If we have a pending local offer and receive
      // a remote offer, one side must roll back. We use UID comparison as the
      // tiebreaker: the lexicographically-larger UID rolls back and accepts the
      // remote offer; the smaller UID ignores the remote offer and keeps its own.
      if (pc.signalingState === 'have-local-offer') {
        const myUid = state.currentUser?.uid || '';
        if (myUid > remoteUid) {
          // We lose: roll back our offer and accept the remote offer
          try { await pc.setLocalDescription({ type: 'rollback' }); } catch (_) {}
        } else {
          // We win: keep our offer, discard the remote offer
          log('[ProjectCall] Glare: keeping our offer over', remoteUid);
          return;
        }
      }
      await pc.setRemoteDescription(new RTCSessionDescription(sig.payload));
      // Flush ICE candidates that arrived before the remote description was ready.
      await this._flushPendingCandidates(remoteUid);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await this._sendSignal(remoteUid, 'answer', { type: answer.type, sdp: answer.sdp });
      return;
    }

    if (sig.type === 'answer' && sig.payload?.sdp) {
      // FIX: Use signalingState check instead of !currentRemoteDescription.
      // After the initial connection, currentRemoteDescription is already set,
      // so the old guard silently dropped ALL renegotiation answers — meaning
      // the video SDP exchange never completed and remote video never appeared.
      // The correct check is: are we actually waiting for an answer right now?
      if (pc.signalingState === 'have-local-offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(sig.payload));
        // Flush ICE candidates that arrived before the answer was set.
        await this._flushPendingCandidates(remoteUid);
      }
      return;
    }

    if (sig.type === 'ice' && sig.payload) {
      if (pc.remoteDescription && pc.signalingState !== 'closed') {
        await pc.addIceCandidate(new RTCIceCandidate(sig.payload)).catch(() => {});
      } else {
        // Buffer the candidate — it will be flushed by _flushPendingCandidates
        // after the offer or answer sets the remote description.
        if (peerState) peerState.pendingCandidates.push(sig.payload);
      }
    }
  },

  async _flushPendingCandidates(remoteUid) {
    const peerState = this.peers.get(remoteUid);
    if (!peerState?.pc) return;
    const { pc, pendingCandidates } = peerState;
    while (pendingCandidates.length > 0) {
      const candidate = pendingCandidates.shift();
      if (pc.signalingState !== 'closed') {
        await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
      }
    }
  },

  _attachRemoteAudio(uid, stream) {
    if (!stream) return;
    const host = $('proj-call-audio-host');
    if (!host) return;
    let audio = host.querySelector(`audio[data-uid="${uid}"]`);
    if (!audio) {
      audio = document.createElement('audio');
      audio.autoplay = true;
      audio.playsInline = true;
      audio.dataset.uid = uid;
      host.appendChild(audio);
    }
    audio.srcObject = stream;
    // FIX BUG 2: Browsers may block autoplay of unmuted media even with
    // autoplay=true when srcObject is assigned asynchronously after ICE.
    // Explicitly calling play() ensures audio starts reliably.
    audio.play().catch(e => DEBUG && console.warn('[ProjectCall] Audio autoplay blocked:', e));
  },

  _closePeer(uid) {
    const peerState = this.peers.get(uid);
    if (!peerState) return;
    try { peerState.pc?.close(); } catch (_) {}
    this.peers.delete(uid);
    this._signalQueues.delete(uid); // cancel pending signal chain for this peer
    const host = $('proj-call-audio-host');
    const audio = host?.querySelector(`audio[data-uid="${uid}"]`);
    if (audio) audio.remove();
    // Remove video tile for this peer
    this._removeVideoTile(uid);
  },

  async _sendSignal(toUid, type, payload) {
    if (!this.currentProjectId || !state.currentUser || !toUid) return;
    await push(ref(db, `calls/${this.currentProjectId}/signals/${toUid}`), {
      from: state.currentUser.uid,
      to: toUid,
      type,
      payload: payload || null,
      createdAt: Date.now()
    });
  },

  _setDisconnectGuards() {
    if (!this.currentProjectId || !state.currentUser) return;
    this._onDisconnectParticipant = onDisconnect(ref(db, `calls/${this.currentProjectId}/participants/${state.currentUser.uid}`));
    this._onDisconnectSignals = onDisconnect(ref(db, `calls/${this.currentProjectId}/signals/${state.currentUser.uid}`));
    this._onDisconnectParticipant.remove().catch(() => {});
    this._onDisconnectSignals.remove().catch(() => {});
  },

  _clearDisconnectGuards() {
    if (this._onDisconnectParticipant) {
      this._onDisconnectParticipant.cancel().catch(() => {});
      this._onDisconnectParticipant = null;
    }
    if (this._onDisconnectSignals) {
      this._onDisconnectSignals.cancel().catch(() => {});
      this._onDisconnectSignals = null;
    }
  },

  _reconcileStatus() {
    const call = this.currentCallData;
    if (!call || call.type !== 'project' || call.status === 'ended') return;
    const participants = call.participants || {};
    const count = Object.keys(participants).length;
    const shouldStatus = count >= 2 ? 'active' : 'ringing';
    if (count > 4) {
      this._endCallNode('Call overflow');
      return;
    }
    if ((call.participantsCount || 0) !== count || call.status !== shouldStatus) {
      update(ref(db, `calls/${this.currentProjectId}`), {
        participantsCount: count,
        status: shouldStatus
      }).catch(() => {});
    }
  },

  _endCallNode(reason) {
    if (!this.currentProjectId) return;
    update(ref(db, `calls/${this.currentProjectId}`), {
      status: 'ended',
      endedAt: Date.now(),
      endedReason: reason || 'ended'
    }).catch(() => {});
    setTimeout(() => remove(ref(db, `calls/${this.currentProjectId}`)).catch(() => {}), 2500);
  },

  _cleanupCall(removeParticipant) {
    const endedCallId = this.currentProjectId;
    if (removeParticipant) this._removeSelfFromCallNode();
    this.peers.forEach((_, uid) => this._closePeer(uid));
    this.peers.clear();
    this._signalQueues.clear(); // clear all pending signal chains

    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }

    // ── Video cleanup ──
    this._cleanupVideo();

    const host = $('proj-call-audio-host');
    if (host) host.innerHTML = '';
    this.isMuted = false;
    this.inCall = false;
    this._clearDisconnectGuards();
    if (this._unsubSignals) { this._unsubSignals(); this._unsubSignals = null; }
    if (this._unsubVideoMode) { this._unsubVideoMode(); this._unsubVideoMode = null; }
    this._videoModeData = null;
    this._videoConsentShown = false;
    this._hideOverlay();
    this._hideVideoOverlay();
    this._hideVideoConsentPopup();
    this._refreshActionButton();
    SketchBoardSystem.handleCallEnded(endedCallId);
  },

  _removeSelfFromCallNode() {
    if (!this.currentProjectId || !state.currentUser) return;
    const uid = state.currentUser.uid;
    runTransaction(ref(db, `calls/${this.currentProjectId}`), (call) => {
      if (!call || call.type !== 'project') return call;
      if (!call.participants || !call.participants[uid]) return call;
      delete call.participants[uid];
      const count = Object.keys(call.participants).length;
      if (uid === call.ownerId || count === 0) return null;
      call.participantsCount = count;
      call.status = count >= 2 ? 'active' : 'ringing';
      return call;
    }, { applyLocally: false }).catch(() => {});
  },

  /* ═══════════════════════════════════════════════════════════════
     PROJECT VIDEO CALL — All video-related methods
     ═══════════════════════════════════════════════════════════════ */

  // ── Admin requests video switch ──
  async requestVideoSwitch() {
    if (!this.inCall || !this.currentProjectId || !state.currentUser) return;
    const isOwner = this.currentProjectData?.ownerId === state.currentUser.uid;
    if (!isOwner) { Toast.info('Only the call owner can switch to video'); return; }
    if (this.videoEnabled) { this._showVideoOverlay(); return; }

    const me = state.currentUser.uid;

    // Write the videoMode request to Firebase
    await set(ref(db, `calls/${this.currentProjectId}/videoMode`), {
      requestedBy: me,
      requestedAt: Date.now(),
      responses: { [me]: 'accepted' }
    }).catch(e => { Toast.error('Could not initiate video switch'); return; });

    // Owner enables video immediately
    await this._enableProjectVideo();

    // Update Switch to Video button
    const btn = $('proj-call-video-switch-btn');
    if (btn) btn.style.display = 'none';
    const reopenBtn = $('proj-call-video-reopen-btn');
    if (reopenBtn) reopenBtn.style.display = 'block';
  },

  // ── Non-owner responds to video switch ──
  async respondToVideoSwitch(accepted) {
    if (!this.currentProjectId || !state.currentUser) return;
    const me = state.currentUser.uid;

    // Record response in Firebase
    await update(ref(db, `calls/${this.currentProjectId}/videoMode/responses`), {
      [me]: accepted ? 'accepted' : 'denied'
    }).catch(() => {});

    this._hideVideoConsentPopup();
    this._videoConsentShown = false;

    if (accepted) {
      await this._enableProjectVideo();
      // Update participants so others know this user has video
      await update(ref(db, `calls/${this.currentProjectId}/participants/${me}`), {
        video: true
      }).catch(() => {});
    } else {
      Toast.info('Staying on voice call');
    }
  },

  // ── Enable camera and add video to all peer connections ──
  async _enableProjectVideo() {
    if (this.videoEnabled) {
      this._showVideoOverlay();
      return;
    }
    try {
      // ── PRO MEDIA: Pro gets 1080p, free stays at 720p ──
      const stream = await navigator.mediaDevices.getUserMedia(ProMedia.getProjVideoConstraints());
      this.localVideoStream = stream;
      this._currentFacingMode = 'user';
      this.videoEnabled = true;

      // Build video overlay
      this._buildVideoGrid();
      this._showVideoOverlay();

      // Attach self tile video
      const selfTile = this._videoGridTiles.get('self');
      if (selfTile) {
        const vid = selfTile.querySelector('video');
        if (vid) { vid.srcObject = stream; vid.play().catch(() => {}); }
        selfTile.classList.add('has-video');
      }

      // Add video track to every existing peer connection & renegotiate
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        const me = state.currentUser?.uid;
        for (const [remoteUid, peerState] of this.peers) {
          if (!peerState.pc || peerState.pc.signalingState === 'closed') continue;
          let videoSender = peerState.pc.getSenders().find(s => s.track?.kind === 'video');
          if (videoSender) {
            await videoSender.replaceTrack(videoTrack).catch(() => {});
          } else {
            const sender = peerState.pc.addTrack(videoTrack, stream);
            peerState._videoSender = sender;
          }
          // ── PRO MEDIA: Apply video bitrate after adding video track ──
          setTimeout(() => {
            ProMedia.applyVideoEncoding(peerState.pc, true).catch(() => {});
            ProMedia.showProjCallQualityBadge(true);
          }, 600);
          // FIX: Always renegotiate regardless of UID direction. The old guard
          // (me < remoteUid) meant if I'm the larger UID I never sent a renegotiation
          // offer when I enabled my camera — so the remote peer never saw my video.
          // Offer-glare is handled in _handleSignal via UID-based rollback.
          await this._renegotiatePeer(remoteUid, peerState.pc);
        }
      }

      Toast.success('Video enabled');
    } catch (err) {
      this.videoEnabled = false;
      this.localVideoStream = null;
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        Toast.error('Camera permission denied');
      } else {
        Toast.error('Could not start camera: ' + (err.message || err.name));
      }
      // Record denial in Firebase so others know
      if (this.currentProjectId && state.currentUser) {
        update(ref(db, `calls/${this.currentProjectId}/videoMode/responses`), {
          [state.currentUser.uid]: 'denied'
        }).catch(() => {});
      }
    }
  },

  // ── Stop camera, remove video tracks ──
  async _disableProjectVideo() {
    if (!this.videoEnabled) return;
    this.videoEnabled = false;

    // Stop local camera tracks
    if (this.localVideoStream) {
      this.localVideoStream.getTracks().forEach(t => t.stop());
      this.localVideoStream = null;
    }

    // Null out video sender in all peer connections + renegotiate
    const me = state.currentUser?.uid;
    for (const [remoteUid, peerState] of this.peers) {
      if (!peerState.pc || peerState.pc.signalingState === 'closed') continue;
      const videoSender = peerState._videoSender ||
        peerState.pc.getSenders().find(s => s.track?.kind === 'video');
      if (videoSender) {
        await videoSender.replaceTrack(null).catch(() => {});
      }
      // FIX: Always renegotiate on disable regardless of UID direction
      await this._renegotiatePeer(remoteUid, peerState.pc);
    }

    // Update self tile to audio-only
    const selfTile = this._videoGridTiles.get('self');
    if (selfTile) {
      const vid = selfTile.querySelector('video');
      if (vid) { vid.srcObject = null; }
      selfTile.classList.remove('has-video');
    }

    Toast.info('Camera off — still on call');
  },

  // ── Toggle video on/off ──
  async _toggleProjectVideo() {
    const btn = $('pvg-video-btn');
    if (this.videoEnabled) {
      await this._disableProjectVideo();
      if (btn) { btn.classList.remove('active'); btn.querySelector('.pvg-ctrl-icon').innerHTML = '<i data-lucide="video" class="lucide" width="20" height="20"></i>'; btn.querySelector('.pvg-ctrl-label').textContent = 'Video'; }
    } else {
      await this._enableProjectVideo();
      if (btn) { btn.classList.add('active'); btn.querySelector('.pvg-ctrl-icon').innerHTML = '<i data-lucide="ban" class="lucide" width="20" height="20"></i>'; btn.querySelector('.pvg-ctrl-label').textContent = 'Stop'; }
    }
  },

  // ── Flip between front/rear camera ──
  async _flipProjectCamera() {
    if (!this.localVideoStream) return;
    const currentTrack = this.localVideoStream.getVideoTracks()[0];
    if (!currentTrack) return;
    const nextFacing = this._currentFacingMode === 'user' ? 'environment' : 'user';
    try {
      currentTrack.stop();
      // ── PRO MEDIA: Pro 1080p on project camera flip ──
      const _pvcF = ProMedia.getProjVideoConstraints();
      const newStream = await navigator.mediaDevices.getUserMedia({ video: { ..._pvcF.video, facingMode: { exact: nextFacing } }, audio: false });
      const newTrack = newStream.getVideoTracks()[0];
      // Replace in all peer connections
      for (const [, peerState] of this.peers) {
        if (!peerState.pc || peerState.pc.signalingState === 'closed') continue;
        const sender = peerState.pc.getSenders().find(s => s.track?.kind === 'video');
        if (sender) await sender.replaceTrack(newTrack).catch(() => {});
      }
      this.localVideoStream = newStream;
      this._currentFacingMode = nextFacing;
      const selfTile = this._videoGridTiles.get('self');
      const vid = selfTile?.querySelector('video');
      if (vid) { vid.srcObject = newStream; vid.play().catch(() => {}); }
      Toast.success(`Switched to ${nextFacing === 'user' ? 'front' : 'rear'} camera`);
    } catch (err) {
      Toast.error('Could not flip camera');
    }
  },

  // ── Renegotiate a single peer connection (send new offer) ──
  async _renegotiatePeer(remoteUid, pc) {
    if (!pc || pc.signalingState === 'closed') return;
    // Wait for stable signaling state
    let attempts = 0;
    while (pc.signalingState !== 'stable' && attempts < 20) {
      await new Promise(r => setTimeout(r, 100));
      attempts++;
    }
    if (pc.signalingState === 'closed') return;
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this._sendSignal(remoteUid, 'offer', { type: offer.type, sdp: offer.sdp });
    } catch (e) {
      DEBUG && console.warn('[ProjectVideo] Renegotiation failed for', remoteUid, e?.message || e);
    }
  },

  // ── Attach remote video stream to a tile ──
  _attachRemoteVideo(uid, stream) {
    if (!stream) return;
    // Ensure tile exists (might be in audio-only mode until now)
    if (!this._videoGridTiles.has(uid)) {
      this._buildVideoGrid();
    }
    const tile = this._videoGridTiles.get(uid);
    if (!tile) return;
    const vid = tile.querySelector('video');
    if (vid) {
      // Always reassign — even if srcObject appears the same, the underlying
      // tracks may have changed after renegotiation.
      vid.srcObject = stream;
      vid.muted = false; // Remote video must NOT be muted
      vid.play().catch(e => {
        DEBUG && console.warn('[ProjectVideo] Remote video autoplay blocked:', e);
        // Retry after brief delay for browsers that need a moment
        setTimeout(() => vid.play().catch(() => {}), 500);
      });
    }
    tile.classList.add('has-video');
    tile.classList.add('is-remote');
  },

  // ── Remove a tile for a peer who left ──
  _removeVideoTile(uid) {
    const tile = this._videoGridTiles.get(uid);
    if (tile) { tile.remove(); this._videoGridTiles.delete(uid); }
    this._updateGridClass();
  },

  // ── Build the full video grid DOM from current participants ──
  _buildVideoGrid() {
    const grid = $('pvg-grid');
    if (!grid) return;
    const participants = this.currentCallData?.participants || {};
    const myUid = state.currentUser?.uid;

    // Create self tile if not exists
    if (!this._videoGridTiles.has('self')) {
      const tile = this._makeTile('self', state.username || 'You', true);
      this._videoGridTiles.set('self', tile);
      grid.appendChild(tile);
    }

    // Create remote tiles
    Object.entries(participants).forEach(([uid, p]) => {
      if (uid === myUid) return;
      if (!this._videoGridTiles.has(uid)) {
        const name = p?.username || this.currentMembers?.[uid]?.username || 'Member';
        const tile = this._makeTile(uid, name, false);
        this._videoGridTiles.set(uid, tile);
        grid.appendChild(tile);
      }
    });

    this._updateGridClass();
  },

  // ── Re-render existing tiles (name/mute updates) ──
  _renderVideoGrid() {
    const participants = this.currentCallData?.participants || {};
    const myUid = state.currentUser?.uid;

    // Update self tile name
    const selfTile = this._videoGridTiles.get('self');
    if (selfTile) {
      const nameEl = selfTile.querySelector('.pvt-name');
      if (nameEl) nameEl.textContent = `@${state.username || 'You'}`;
      const muteEl = selfTile.querySelector('.pvt-mute-icon');
      if (muteEl) muteEl.innerHTML = this.isMuted ? '<i data-lucide="mic-off" class="lucide" width="12" height="12"></i>' : '';
      selfTile.classList.toggle('muted', this.isMuted);
    }

    // Update or create remote tiles
    Object.entries(participants).forEach(([uid, p]) => {
      if (uid === myUid) return;
      if (!this._videoGridTiles.has(uid)) {
        const grid = $('pvg-grid');
        if (!grid) return;
        const name = p?.username || this.currentMembers?.[uid]?.username || 'Member';
        const tile = this._makeTile(uid, name, false);
        this._videoGridTiles.set(uid, tile);
        grid.appendChild(tile);
        this._updateGridClass();
      } else {
        const tile = this._videoGridTiles.get(uid);
        const nameEl = tile?.querySelector('.pvt-name');
        if (nameEl) nameEl.textContent = `@${p?.username || 'Member'}`;
        const muteEl = tile?.querySelector('.pvt-mute-icon');
        if (muteEl) muteEl.innerHTML = p?.muted ? '<i data-lucide="mic-off" class="lucide" width="12" height="12"></i>' : '';
        tile?.classList.toggle('muted', !!p?.muted);
      }
    });

    // Remove tiles for participants who left
    for (const [uid] of [...this._videoGridTiles.entries()]) {
      if (uid === 'self') continue;
      if (!participants[uid]) this._removeVideoTile(uid);
    }

    // Update topbar info
    const pvgTitle = $('pvg-title');
    if (pvgTitle) pvgTitle.textContent = `${this.currentProjectData?.name || 'Project'} Video`;
    const pvgCount = $('pvg-count');
    if (pvgCount) pvgCount.textContent = `${Object.keys(participants).length}/4`;
    const pvgStatus = $('pvg-status');
    if (pvgStatus) pvgStatus.textContent = this.currentCallData?.status === 'active' ? 'Active' : 'Ringing';
  },

  // ── Create a single video tile element ──
  _makeTile(uid, displayName, isSelf) {
    const tile = document.createElement('div');
    tile.className = 'pvt-tile' + (isSelf ? '' : ' is-remote');
    tile.dataset.uid = uid;
    const initial = (displayName || '?')[0].toUpperCase();
    tile.innerHTML = `
      <video autoplay playsinline ${isSelf ? 'muted' : ''}></video>
      <div class="pvt-avatar-wrap">
        <div class="pvt-avatar">${initial}</div>
        <div class="pvt-voice-wave">
          <div class="bar"></div><div class="bar"></div><div class="bar"></div>
          <div class="bar"></div><div class="bar"></div>
        </div>
      </div>
      <div class="pvt-namebar">
        <span class="pvt-status-dot"></span>
        <span class="pvt-name">@${escHtml(displayName)}</span>
        ${isSelf ? '<span class="pvt-you-badge">YOU</span>' : ''}
        <span class="pvt-mute-icon"></span>
      </div>
    `;
    return tile;
  },

  // ── Update the CSS grid column class based on tile count ──
  _updateGridClass() {
    const grid = $('pvg-grid');
    if (!grid) return;
    const count = this._videoGridTiles.size; // includes 'self'
    grid.className = `pvg-grid count-${Math.max(1, Math.min(count, 4))}`;
  },

  // ── Show video overlay ──
  _showVideoOverlay() {
    const overlay = $('proj-video-overlay');
    if (overlay) overlay.classList.add('active');
    // Sync mute button
    const muteBtn = $('pvg-mute-btn');
    if (muteBtn) {
      muteBtn.querySelector('.pvg-ctrl-icon').innerHTML = this.isMuted ? '<i data-lucide="mic-off" class="lucide" width="20" height="20"></i>' : '<i data-lucide="mic" class="lucide" width="20" height="20"></i>';
      muteBtn.querySelector('.pvg-ctrl-label').textContent = this.isMuted ? 'Unmute' : 'Mute';
    }
    // Sync video button
    const vidBtn = $('pvg-video-btn');
    if (vidBtn) {
      vidBtn.querySelector('.pvg-ctrl-icon').innerHTML = this.videoEnabled ? '<i data-lucide="ban" class="lucide" width="20" height="20"></i>' : '<i data-lucide="video" class="lucide" width="20" height="20"></i>';
      vidBtn.querySelector('.pvg-ctrl-label').textContent = this.videoEnabled ? 'Stop' : 'Video';
    }
    // Sync flip button — hide on desktop where facingMode isn't relevant
    this._renderVideoGrid();
    // Hide voice call overlay while video overlay is shown
    this._hideOverlay();
  },

  // ── Minimise video overlay (go back to voice card) ──
  _minimiseVideoOverlay() {
    this._hideVideoOverlay();
    this._showOverlay();
    // Show "View Video" reopen button
    const reopenBtn = $('proj-call-video-reopen-btn');
    if (reopenBtn) reopenBtn.style.display = 'block';
    const switchBtn = $('proj-call-video-switch-btn');
    if (switchBtn) switchBtn.style.display = 'none';
  },

  // ── Show video overlay if video is active ──
  _showVideoOverlayIfVideo() {
    if (this.videoEnabled) {
      this._showVideoOverlay();
    }
  },

  // ── Hide video overlay ──
  _hideVideoOverlay() {
    const overlay = $('proj-video-overlay');
    if (overlay) overlay.classList.remove('active');
  },

  // ── Show consent popup ──
  _showVideoConsentPopup(requesterName) {
    const popup = $('proj-video-consent');
    if (!popup) return;
    const titleEl = $('pvc-title');
    const subEl = $('pvc-sub');
    if (titleEl) titleEl.textContent = 'Switch to Video Call?';
    if (subEl) subEl.textContent = `@${requesterName} (host) wants to switch everyone to video. Do you agree?`;
    popup.classList.add('active');
  },

  // ── Hide consent popup ──
  _hideVideoConsentPopup() {
    const popup = $('proj-video-consent');
    if (popup) popup.classList.remove('active');
  },

  // ── Also sync mute state to video overlay buttons ──
  _syncVideoOverlayMute() {
    const muteBtn = $('pvg-mute-btn');
    if (!muteBtn) return;
    muteBtn.querySelector('.pvg-ctrl-icon').innerHTML = this.isMuted ? '<i data-lucide="mic-off" class="lucide" width="20" height="20"></i>' : '<i data-lucide="mic" class="lucide" width="20" height="20"></i>';
    muteBtn.querySelector('.pvg-ctrl-label').textContent = this.isMuted ? 'Unmute' : 'Mute';
  },

  // ── Clean up all video state ──
  _cleanupVideo() {
    if (this.localVideoStream) {
      this.localVideoStream.getTracks().forEach(t => t.stop());
      this.localVideoStream = null;
    }
    this.videoEnabled = false;
    this._currentFacingMode = 'user';
    this._videoConsentShown = false;
    this._videoModeData = null;

    // Clear all video tiles
    const grid = $('pvg-grid');
    if (grid) grid.innerHTML = '';
    this._videoGridTiles.clear();

    // Reset video switch button
    const switchBtn = $('proj-call-video-switch-btn');
    if (switchBtn) switchBtn.style.display = 'none';
    const reopenBtn = $('proj-call-video-reopen-btn');
    if (reopenBtn) reopenBtn.style.display = 'none';
  }
};

const SketchBoardSystem = {
  callId: null,
  callType: null,
  canvas: null,
  ctx: null,
  overlay: null,
  colorInput: null,
  sizeInput: null,
  currentTool: 'pen',
  isDrawing: false,
  currentStroke: null,
  _strokes: new Map(),
  _liveRemote: new Map(),
  _unsubs: [],
  _liveSyncTs: 0,
  _liveSyncTimer: null,

  /* ── Zoom / Pan state ── */
  viewTransform: { scale: 1, panX: 0, panY: 0 },
  _isPinching: false,
  _pinchStart: null,
  _zoomListenersAttached: false,

  init() {
    this.overlay = $('sketch-board-overlay');
    this.canvas = $('sketch-board-canvas');
    this.colorInput = $('sketch-color');
    this.sizeInput = $('sketch-size');
    if (!this.overlay || !this.canvas) return;

    this.ctx = this.canvas.getContext('2d');
    $('call-sketch-btn')?.addEventListener('click', () => this.openForCall(state.callId, 'direct', `Direct Call Sketch · ${state.chatPartnerUsername || ''}`));
    $('proj-call-sketch-btn')?.addEventListener('click', () => this.openForCall(ProjectVoiceCallSystem.currentProjectId, 'project', `${ProjectVoiceCallSystem.currentProjectData?.name || 'Project'} Sketch`));
    $('sketch-close-btn')?.addEventListener('click', () => this.close());
    $('sketch-clear-btn')?.addEventListener('click', () => this.clearBoard());
    $('sketch-tool-pen')?.addEventListener('click', () => this.setTool('pen'));
    $('sketch-tool-marker')?.addEventListener('click', () => this.setTool('marker'));
    $('sketch-tool-eraser')?.addEventListener('click', () => this.setTool('eraser'));

    this.canvas.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    this.canvas.addEventListener('pointermove', (e) => this._onPointerMove(e));
    this.canvas.addEventListener('pointerup',   (e) => this._onPointerUp(e));
    this.canvas.addEventListener('pointercancel',(e) => this._onPointerUp(e));
    this.canvas.addEventListener('pointerleave', (e) => this._onPointerUp(e));
    window.addEventListener('resize', () => this._resizeCanvas());
    this._resizeCanvas();
    this._syncToolUi();
    this._attachZoomListeners();
  },

  /* ══════════════════════════════════════════
     ZOOM / PAN — helpers
  ══════════════════════════════════════════ */
  _updateZoomLabel() {
    const el = $('sketch-zoom-label');
    if (el) el.textContent = Math.round(this.viewTransform.scale * 100) + '%';
  },

  _clampTransform() {
    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    const { scale } = this.viewTransform;
    const minVis = 0.15;
    const logW = rect.width, logH = rect.height;
    this.viewTransform.panX = Math.min(logW * (1 - minVis),
      Math.max(-(logW * scale - logW * minVis), this.viewTransform.panX));
    this.viewTransform.panY = Math.min(logH * (1 - minVis),
      Math.max(-(logH * scale - logH * minVis), this.viewTransform.panY));
  },

  _zoomAroundPoint(newScale, cssPxX, cssPxY) {
    const { scale, panX, panY } = this.viewTransform;
    const logX = (cssPxX - panX) / scale;
    const logY = (cssPxY - panY) / scale;
    const clamped = Math.max(0.25, Math.min(8, newScale));
    this.viewTransform.scale = clamped;
    this.viewTransform.panX  = cssPxX - logX * clamped;
    this.viewTransform.panY  = cssPxY - logY * clamped;
    this._clampTransform();
    this._updateZoomLabel();
  },

  _zoomBy(factor) {
    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    this._zoomAroundPoint(
      this.viewTransform.scale * factor,
      rect.width / 2, rect.height / 2
    );
    this._redrawAll();
  },

  _resetZoom() {
    this.viewTransform = { scale: 1, panX: 0, panY: 0 };
    this._updateZoomLabel();
    this._redrawAll();
  },

  /* ══════════════════════════════════════════
     ZOOM / PAN — touch & wheel listeners
  ══════════════════════════════════════════ */
  _attachZoomListeners() {
    if (!this.canvas || this._zoomListenersAttached) return;
    this._zoomListenersAttached = true;

    /* Pinch-to-zoom + 2-finger pan */
    this.canvas.addEventListener('touchstart',  (e) => this._onTouchStart(e),  { passive: false });
    this.canvas.addEventListener('touchmove',   (e) => this._onTouchMove(e),   { passive: false });
    this.canvas.addEventListener('touchend',    (e) => this._onTouchEnd(e),    { passive: false });
    this.canvas.addEventListener('touchcancel', (e) => this._onTouchEnd(e),    { passive: false });

    /* Mouse-wheel zoom (desktop) */
    this.canvas.addEventListener('wheel', (e) => {
      if (!this.callId) return;
      e.preventDefault();
      const rect   = this.canvas.getBoundingClientRect();
      const factor = e.deltaY < 0 ? 1.08 : 0.93;
      this._zoomAroundPoint(
        this.viewTransform.scale * factor,
        e.clientX - rect.left,
        e.clientY - rect.top
      );
      this._redrawAll();
    }, { passive: false });

    /* Zoom toolbar buttons */
    $('sketch-zoom-in-btn')   ?.addEventListener('click', () => this._zoomBy(1.3));
    $('sketch-zoom-out-btn')  ?.addEventListener('click', () => this._zoomBy(1 / 1.3));
    $('sketch-zoom-reset-btn')?.addEventListener('click', () => this._resetZoom());
  },

  _getTouchDist(t1, t2) {
    const dx = t1.clientX - t2.clientX, dy = t1.clientY - t2.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  },

  _onTouchStart(e) {
    if (e.touches.length !== 2) return;
    e.preventDefault();
    this._isPinching = true;
    /* Cancel any active pointer-based drawing */
    this.isDrawing = false;
    this.currentStroke = null;
    const t1 = e.touches[0], t2 = e.touches[1];
    const rect = this.canvas.getBoundingClientRect();
    const midX = (t1.clientX + t2.clientX) / 2 - rect.left;
    const midY = (t1.clientY + t2.clientY) / 2 - rect.top;
    this._pinchStart = {
      dist:  this._getTouchDist(t1, t2),
      scale: this.viewTransform.scale,
      panX:  this.viewTransform.panX,
      panY:  this.viewTransform.panY,
      /* Logical point under the initial pinch midpoint */
      logX:  (midX - this.viewTransform.panX) / this.viewTransform.scale,
      logY:  (midY - this.viewTransform.panY) / this.viewTransform.scale,
    };
    this.canvas.classList.add('sketch-panning', 'sketch-grabbing');
  },

  _onTouchMove(e) {
    if (!this._isPinching || !this._pinchStart || e.touches.length < 2) return;
    e.preventDefault();
    const t1 = e.touches[0], t2 = e.touches[1];
    const rect    = this.canvas.getBoundingClientRect();
    const newDist = this._getTouchDist(t1, t2);
    const midX    = (t1.clientX + t2.clientX) / 2 - rect.left;
    const midY    = (t1.clientY + t2.clientY) / 2 - rect.top;

    /*
      Combined zoom + pan:
      Keep _pinchStart.logX/logY fixed under the current finger midpoint.
      Midpoint translation (finger drift) is included automatically because
      midX/midY change as the fingers move.
    */
    const rawScale = this._pinchStart.scale * (newDist / this._pinchStart.dist);
    const newScale = Math.max(0.25, Math.min(8, rawScale));
    this.viewTransform.scale = newScale;
    this.viewTransform.panX  = midX - this._pinchStart.logX * newScale;
    this.viewTransform.panY  = midY - this._pinchStart.logY * newScale;
    this._clampTransform();
    this._updateZoomLabel();
    this._redrawAll();
  },

  _onTouchEnd(e) {
    if (e.touches.length < 2) {
      this._isPinching = false;
      this._pinchStart = null;
      this.canvas?.classList.remove('sketch-panning', 'sketch-grabbing');
    }
  },

  /* ══════════════════════════════════════════
     EXISTING API (preserved + zoom-aware)
  ══════════════════════════════════════════ */
  async openForCall(callId, callType, title) {
    if (!state.currentUser || !callId) {
      Toast.info('Join a call to use Sketch Board');
      return;
    }
    if (this.callId !== callId) this._detachRealtime();
    this.callId = callId;
    this.callType = callType || 'direct';
    state.activeSketchCallId = callId;
    state.activeSketchCallType = this.callType;
    const titleEl = $('sketch-board-title');
    if (titleEl) titleEl.textContent = title || 'Sketch Board';
    this.overlay?.classList.add('active');
    /* Reset zoom to 100% every time the board opens */
    this.viewTransform = { scale: 1, panX: 0, panY: 0 };
    this._updateZoomLabel();
    this._resizeCanvas();
    this._attachRealtime();
  },

  close() {
    this._detachRealtime();
    this.overlay?.classList.remove('active');
  },

  async handleCallEnded(callId) {
    if (!callId || this.callId !== callId) return;
    this._detachRealtime();
    this.overlay?.classList.remove('active');
    this._clearCanvasState();
    this.callId = null;
    this.callType = null;
    if (state.activeSketchCallId === callId) {
      state.activeSketchCallId = null;
      state.activeSketchCallType = null;
    }
  },

  setTool(tool) {
    this.currentTool = tool;
    this._syncToolUi();
  },

  _syncToolUi() {
    ['pen', 'marker', 'eraser'].forEach(t => {
      $(`sketch-tool-${t}`)?.classList.toggle('active', t === this.currentTool);
    });
  },

  _resizeCanvas() {
    if (!this.canvas || !this.ctx) return;
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const width  = Math.floor(rect.width  * dpr);
    const height = Math.floor(rect.height * dpr);
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.canvas.width  = width;
    this.canvas.height = height;
    this._redrawAll();
  },

  _clearCanvasState() {
    this._strokes.clear();
    this._liveRemote.clear();
    this.currentStroke = null;
    if (this.ctx && this.canvas) {
      this.ctx.save();
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.ctx.restore();
    }
  },

  _attachRealtime() {
    if (!this.callId || !state.currentUser) return;
    this._detachRealtime();
    const uid = state.currentUser.uid;
    this._clearCanvasState();
    const strokesRef = ref(db, `sketchBoards/${this.callId}/strokes`);
    const liveRef    = ref(db, `sketchBoards/${this.callId}/live`);
    this._unsubs.push(onChildAdded(strokesRef, (snap) => {
      const data = snap.val(); if (!data) return;
      this._strokes.set(snap.key, data); this._redrawAll();
    }));
    this._unsubs.push(onChildChanged(strokesRef, (snap) => {
      const data = snap.val(); if (!data) return;
      this._strokes.set(snap.key, data); this._redrawAll();
    }));
    this._unsubs.push(onChildRemoved(strokesRef, (snap) => {
      this._strokes.delete(snap.key); this._redrawAll();
    }));
    this._unsubs.push(onValue(liveRef, (snap) => {
      const raw = snap.val() || {};
      this._liveRemote.clear();
      Object.keys(raw).forEach(k => {
        if (k !== uid && raw[k] && Array.isArray(raw[k].points)) this._liveRemote.set(k, raw[k]);
      });
      this._redrawAll();
    }));
  },

  _detachRealtime() {
    this._unsubs.forEach(fn => { try { fn(); } catch (_) {} });
    this._unsubs = [];
    this._stopLocalDrawing(true);
    this._clearCanvasState();
  },

  /* Convert screen pointer coords → logical canvas coords (zoom-aware) */
  _toCanvasPoint(e) {
    const rect = this.canvas?.getBoundingClientRect();
    if (!rect) return null;
    const { scale, panX, panY } = this.viewTransform;
    const cssX = Math.max(0, Math.min(rect.width,  e.clientX - rect.left));
    const cssY = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
    return {
      x: +((cssX - panX) / scale).toFixed(2),
      y: +((cssY - panY) / scale).toFixed(2)
    };
  },

  _onPointerDown(e) {
    if (this._isPinching) return;          /* ignore while pinching */
    if (!this.callId || !state.currentUser || !this.canvas) return;
    const p = this._toCanvasPoint(e);
    if (!p) return;
    this.isDrawing = true;
    this.canvas.setPointerCapture?.(e.pointerId);
    this.currentStroke = {
      userId:    state.currentUser.uid,
      tool:      this.currentTool,
      color:     this.colorInput?.value || '#2563eb',
      width:     Number(this.sizeInput?.value || 4),
      points:    [p],
      timestamp: Date.now()
    };
    this._redrawAll();
    this._queueLiveSync(true);
  },

  _onPointerMove(e) {
    if (this._isPinching || !this.isDrawing || !this.currentStroke) return;
    const p = this._toCanvasPoint(e);
    if (!p) return;
    const pts = this.currentStroke.points;
    const last = pts[pts.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.2 && Math.abs(last.y - p.y) < 0.2) return;
    pts.push(p);
    /* Full redraw ensures zoom/pan transform is always correctly applied */
    this._redrawAll();
    this._queueLiveSync(false);
  },

  _onPointerUp() {
    this._stopLocalDrawing(true);
  },

  _queueLiveSync(force) {
    if (!this.callId || !state.currentUser || !this.currentStroke) return;
    const now = Date.now();
    if (!force && (now - this._liveSyncTs) < 120) {
      if (!this._liveSyncTimer) {
        this._liveSyncTimer = setTimeout(() => {
          this._liveSyncTimer = null;
          this._queueLiveSync(true);
        }, 120);
      }
      return;
    }
    this._liveSyncTs = now;
    const sample = this.currentStroke.points.slice(-48);
    set(ref(db, `sketchBoards/${this.callId}/live/${state.currentUser.uid}`), {
      userId:    state.currentUser.uid,
      tool:      this.currentStroke.tool,
      color:     this.currentStroke.color,
      width:     this.currentStroke.width,
      points:    sample,
      updatedAt: now
    }).catch(() => {});
  },

  _compressPoints(points) {
    if (!Array.isArray(points) || points.length <= 220) return points || [];
    const step = Math.ceil(points.length / 220);
    const compact = [];
    for (let i = 0; i < points.length; i += step) compact.push(points[i]);
    const last = points[points.length - 1];
    if (!compact.length || compact[compact.length - 1] !== last) compact.push(last);
    return compact;
  },

  _stopLocalDrawing(commit) {
    if (!this.isDrawing || !this.currentStroke || !state.currentUser || !this.callId) {
      this.isDrawing = false; this.currentStroke = null; return;
    }
    this.isDrawing = false;
    const stroke = this.currentStroke;
    this.currentStroke = null;
    if (this._liveSyncTimer) { clearTimeout(this._liveSyncTimer); this._liveSyncTimer = null; }
    remove(ref(db, `sketchBoards/${this.callId}/live/${state.currentUser.uid}`)).catch(() => {});
    if (!commit || !stroke.points?.length) return;
    const finalStroke = { ...stroke, points: this._compressPoints(stroke.points), timestamp: Date.now() };
    push(ref(db, `sketchBoards/${this.callId}/strokes`), finalStroke).catch(() => {});
  },

  _drawStroke(stroke, _unused) {
    if (!this.ctx || !stroke || !Array.isArray(stroke.points) || stroke.points.length === 0) return;
    const pts = stroke.points;
    const { color, width, tool } = stroke;
    const isEraser = tool === 'eraser';
    this.ctx.save();
    this.ctx.lineCap  = 'round';
    this.ctx.lineJoin = 'round';
    this.ctx.globalCompositeOperation = isEraser ? 'destination-out' : 'source-over';
    this.ctx.strokeStyle = isEraser ? 'rgba(0,0,0,1)' : (color || '#2563eb');
    this.ctx.globalAlpha = tool === 'marker' ? 0.45 : 1;
    this.ctx.lineWidth   = Math.max(1, Number(width || 4));
    this.ctx.beginPath();
    this.ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) this.ctx.lineTo(pts[i].x, pts[i].y);
    if (pts.length === 1) this.ctx.lineTo(pts[0].x + 0.1, pts[0].y + 0.1);
    this.ctx.stroke();
    this.ctx.restore();
  },

  /* Full redraw with zoom + pan transform applied */
  _redrawAll() {
    if (!this.ctx || !this.canvas) return;
    const { scale, panX, panY } = this.viewTransform;
    const dpr = Math.max(1, window.devicePixelRatio || 1);

    /* 1. Clear in raw pixel space (bypass any existing transform) */
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.restore();

    /* 2. Apply zoom + pan on top of DPR scaling, then draw all strokes */
    this.ctx.save();
    this.ctx.setTransform(
      scale * dpr, 0,
      0, scale * dpr,
      panX * dpr, panY * dpr
    );
    const all = [...this._strokes.values()].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    all.forEach(st => this._drawStroke(st));
    this._liveRemote.forEach(st => this._drawStroke(st));
    if (this.currentStroke) this._drawStroke(this.currentStroke);
    this.ctx.restore();
  },

  async clearBoard() {
    if (!this.callId || !state.currentUser) return;
    const ts = Date.now();
    await Promise.all([
      set(ref(db, `sketchBoards/${this.callId}/meta`), {
        clearedAt: ts, clearedBy: state.currentUser.uid
      }).catch(() => {}),
      remove(ref(db, `sketchBoards/${this.callId}/strokes`)).catch(() => {}),
      remove(ref(db, `sketchBoards/${this.callId}/live`)).catch(() => {})
    ]);
    this._strokes.clear();
    this._liveRemote.clear();
    this._redrawAll();
  }
};


/* ═══════════════════════════════════════════════════
   PLATFORM: DOWNLOADS SCREEN
   ═══════════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════════════════════════
   PROJECT SYSTEM — Skill-Based Projects & Collaborations
   Golex 3.0 Addition | ProjectSystem object mirrors RoomSystem pattern
   ═══════════════════════════════════════════════════════════════════ */

const ProjectSystem = {

  /* ── State ── */
  currentProjectId: null,
  currentProjectData: null,
  currentMembers: {},        // uid -> member data
  projectTags: [],
  projectRoles: [],          // [{skill, qty}]
  coverDataUrl: null,
  workAdSkills: [],
  workAdsMap: {},
  _workSearchQuery: '',

  // Firebase listeners (cleaned up on leave)
  _unsubMessages: null,
  _unsubTasks: null,
  _unsubMembers: null,
  _unsubRequests: null,
  _unsubWorkAds: null,
  _unsubTyping: null,
  _typingTimeout: null,

  // Render tracking
  _renderedMsgIds: new Set(),
  _lastMsgDate: null,
  _tasks: {},                // taskId -> task object (local mirror)
  _dragTaskId: null,
  _dragFromCol: null,
  _editingTaskId: null,

  // ──────────────────────────────────────────────────────────────────
  //  INIT — Wire up all static event listeners
  // ──────────────────────────────────────────────────────────────────
  init() {

    // Nav button
    const navBtn = $('nav-projects');
    if (navBtn) navBtn.addEventListener('click', () => {
      ScreenManager.show('projects-screen');
      this.loadPublicProjects();
      this.loadMyProjects();
      this.loadSeekingProjects();
      this.loadWorkAds();
    });

    // Tab switching on projects-screen
    $$('.projects-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        $$('.projects-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        ['proj-panel-public','proj-panel-private','proj-panel-work','proj-panel-mine'].forEach(id => {
          const el = $(id); if (el) el.style.display = 'none';
        });
        const panelMap = { public: 'proj-panel-public', private: 'proj-panel-private', work: 'proj-panel-work', mine: 'proj-panel-mine' };
        const panel = $(panelMap[tab]); if (panel) panel.style.display = 'block';
        if (tab === 'work') this.loadWorkAds();
      });
    });

    // Create project button
    const createBtn = $('projects-create-btn');
    if (createBtn) createBtn.addEventListener('click', () => {
      this._openCreateScreen();
    });

    // Back from create screen
    const createBack = $('proj-create-back');
    if (createBack) createBack.addEventListener('click', () => {
      ScreenManager.show('projects-screen');
      this.loadWorkAds();
    });

    // Visibility toggle on create screen
    const visPublic = $('proj-vis-public');
    const visPrivate = $('proj-vis-private');
    if (visPublic && visPrivate) {
      visPublic.addEventListener('click', () => {
        visPublic.classList.add('selected'); visPrivate.classList.remove('selected');
        $('proj-vis-value').value = 'public';
        $('proj-private-options').style.display = 'none';
      });
      visPrivate.addEventListener('click', () => {
        visPrivate.classList.add('selected'); visPublic.classList.remove('selected');
        $('proj-vis-value').value = 'private';
        $('proj-private-options').style.display = 'block';
      });
    }

    // Add role button
    const addRoleBtn = $('proj-add-role-btn');
    if (addRoleBtn) addRoleBtn.addEventListener('click', () => this._addRoleRow());

    // Cover image
    const coverPreview = $('proj-cover-preview');
    const coverInput = $('proj-cover-input');
    if (coverPreview && coverInput) {
      coverPreview.addEventListener('click', () => coverInput.click());
      coverInput.addEventListener('change', async (e) => {
        const file = e.target.files[0]; if (!file) return;
        coverInput.value = '';
        try {
          const result = await compressImage(file);
          this.coverDataUrl = result.dataUrl;
          const img = $('proj-cover-img');
          const placeholder = $('proj-cover-placeholder');
          img.src = result.dataUrl; img.style.display = 'block';
          if (placeholder) placeholder.style.display = 'none';
        } catch(err) { Toast.error(err.message || 'Image error'); }
      });
    }

    // Tag management on create screen
    const projTagInput = $('proj-tag-input');
    const projTagAdd = $('proj-tag-add');
    if (projTagInput && projTagAdd) {
      projTagAdd.addEventListener('click', () => this._addProjectTag());
      projTagInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this._addProjectTag(); }
      });
    }

    // Submit create
    const submitBtn = $('proj-create-submit-btn');
    if (submitBtn) submitBtn.addEventListener('click', () => this._createProject());

    // ── Workspace events ──
    const wsBack = $('proj-ws-back');
    if (wsBack) wsBack.addEventListener('click', () => {
      this._leaveWorkspace();
      ScreenManager.show('projects-screen');
      this.loadPublicProjects();
      this.loadMyProjects();
      this.loadSeekingProjects();
      this.loadWorkAds();
    });

    // Workspace tabs
    $$('.proj-ws-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        $$('.proj-ws-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        $$('.proj-ws-panel').forEach(p => p.classList.remove('active'));
        const panel = $(`proj-ws-panel-${tab}`); if (panel) panel.classList.add('active');
        if (tab === 'members') this._renderMembersPanel();
        if (tab === 'board') { lucideCreate();
}
      });
    });

    // Workspace menu button
    const menuBtn = $('proj-ws-menu-btn');
    if (menuBtn) menuBtn.addEventListener('click', () => this._openMenu());

    // Menu options
    const menuClose = $('proj-menu-close');
    if (menuClose) menuClose.addEventListener('click', () => this._closeModal('proj-menu-overlay'));
    $('proj-menu-overlay')?.addEventListener('click', (e) => { if (e.target === $('proj-menu-overlay')) this._closeModal('proj-menu-overlay'); });

    $('proj-menu-settings')?.addEventListener('click', () => {
      this._closeModal('proj-menu-overlay');
      this._openSettingsModal();
    });
    $('proj-menu-invite')?.addEventListener('click', () => {
      this._closeModal('proj-menu-overlay');
      this._copyInviteLink();
    });
    $('proj-menu-advertise')?.addEventListener('click', () => {
      this._closeModal('proj-menu-overlay');
      this._openWorkAdModal();
    });
    $('proj-menu-leave')?.addEventListener('click', () => {
      this._closeModal('proj-menu-overlay');
      this._leaveProject();
    });
    $('proj-menu-delete')?.addEventListener('click', () => {
      this._closeModal('proj-menu-overlay');
      this._deleteProject();
    });

    // Chat input
    const chatTextarea = $('proj-chat-textarea');
    const chatSendBtn = $('proj-chat-send-btn');
    if (chatTextarea && chatSendBtn) {
      chatTextarea.addEventListener('input', () => {
        chatSendBtn.disabled = !chatTextarea.value.trim();
        chatTextarea.style.height = 'auto';
        chatTextarea.style.height = Math.min(chatTextarea.scrollHeight, 110) + 'px';
        this._sendTypingSignal();
      });
      chatTextarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this._sendMessage(); }
      });
      chatSendBtn.addEventListener('click', () => this._sendMessage());
    }

    // Chat image button
    const chatImgBtn = $('proj-chat-img-btn');
    const chatImgInput = $('proj-chat-img-input');
    if (chatImgBtn && chatImgInput) {
      chatImgBtn.addEventListener('click', () => chatImgInput.click());
      chatImgInput.addEventListener('change', async (e) => {
        const file = e.target.files[0]; if (!file) return;
        chatImgInput.value = '';
        try {
          Toast.info('Sending image...');
          const result = await compressImage(file);
          await this._sendImageMessage(result.dataUrl);
        } catch(err) { Toast.error(err.message || 'Could not send image'); }
      });
    }

    // Task modals
    ['proj-add-task-todo','proj-add-task-doing','proj-add-task-done'].forEach(id => {
      const btn = $(id);
      if (btn) btn.addEventListener('click', () => {
        const col = btn.dataset.col;
        this._openTaskModal(null, col);
      });
    });

    $('proj-task-modal-close')?.addEventListener('click', () => this._closeModal('proj-task-modal-overlay'));
    $('proj-task-modal-overlay')?.addEventListener('click', (e) => { if (e.target === $('proj-task-modal-overlay')) this._closeModal('proj-task-modal-overlay'); });
    $('proj-task-submit-btn')?.addEventListener('click', () => this._submitTask());

    // Request modal
    $('proj-request-modal-close')?.addEventListener('click', () => this._closeModal('proj-request-modal-overlay'));
    $('proj-request-modal-overlay')?.addEventListener('click', (e) => { if (e.target === $('proj-request-modal-overlay')) this._closeModal('proj-request-modal-overlay'); });
    $('proj-request-submit-btn')?.addEventListener('click', () => this._submitRequest());

    // Settings modal
    $('proj-settings-modal-close')?.addEventListener('click', () => this._closeModal('proj-settings-modal-overlay'));
    $('proj-settings-modal-overlay')?.addEventListener('click', (e) => { if (e.target === $('proj-settings-modal-overlay')) this._closeModal('proj-settings-modal-overlay'); });
    $('proj-settings-save-btn')?.addEventListener('click', () => this._saveSettings());

    // Work ad modal
    $('proj-work-ad-modal-close')?.addEventListener('click', () => this._closeModal('proj-work-ad-modal-overlay'));
    $('proj-work-ad-modal-overlay')?.addEventListener('click', (e) => { if (e.target === $('proj-work-ad-modal-overlay')) this._closeModal('proj-work-ad-modal-overlay'); });
    $('proj-work-ad-submit-btn')?.addEventListener('click', () => this._submitWorkAd());
    $('proj-work-comp-type-select')?.addEventListener('change', () => {
      const isPaid = $('proj-work-comp-type-select')?.value === 'Paid';
      const field = $('proj-work-comp-text-input');
      if (field) field.style.display = isPaid ? 'block' : 'none';
    });
    $('proj-work-skill-add-btn')?.addEventListener('click', () => this._addWorkAdSkill());
    $('proj-work-skill-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this._addWorkAdSkill(); }
    });
    $('proj-work-skills-grid')?.addEventListener('click', (e) => {
      const pill = e.target.closest('.skill-select-pill');
      if (!pill) return;
      const skill = (pill.dataset.skill || '').trim();
      if (!skill) return;
      const exists = this.workAdSkills.some(s => s.toLowerCase() === skill.toLowerCase());
      if (exists) {
        this.workAdSkills = this.workAdSkills.filter(s => s.toLowerCase() !== skill.toLowerCase());
      } else {
        if (this.workAdSkills.length >= 5) { Toast.info('Maximum 5 skills'); return; }
        this.workAdSkills.push(skill);
      }
      this._renderWorkAdSkills();
    });

    // Private pitch modal
    $('proj-work-pitch-modal-close')?.addEventListener('click', () => this._closeModal('proj-work-pitch-modal-overlay'));
    $('proj-work-pitch-modal-overlay')?.addEventListener('click', (e) => { if (e.target === $('proj-work-pitch-modal-overlay')) this._closeModal('proj-work-pitch-modal-overlay'); });
    $('proj-work-pitch-submit-btn')?.addEventListener('click', () => this._submitWorkPitch());

    // Work search
    const workSearchInput = $('proj-work-search-input');
    if (workSearchInput) {
      workSearchInput.addEventListener('input', debounce(() => {
        this._workSearchQuery = (workSearchInput.value || '').trim().toLowerCase();
        this.loadWorkAds();
      }, CONFIG.DEBOUNCE_MS));
    }

    // Init drag-and-drop on kanban columns
    this._initDragDrop();

    // Deep link: check for ?project= param on init
    this._checkDeepLink();
  },

  // ──────────────────────────────────────────────────────────────────
  //  DEEP LINK
  // ──────────────────────────────────────────────────────────────────
  _checkDeepLink() {
    try {
      const params = new URLSearchParams(window.location.search);
      const pid = params.get('project');
      if (!pid) return;
      // Will be called after auth — defer
      this._pendingDeepLinkPid = pid;
    } catch(e) {}
  },

  async handleDeepLink() {
    if (!this._pendingDeepLinkPid || !state.currentUser) return;
    const pid = this._pendingDeepLinkPid;
    this._pendingDeepLinkPid = null;
    try {
      const snap = await get(ref(db, `projects/${pid}/info`));
      if (!snap.exists()) { Toast.error('Project not found'); return; }
      const info = snap.val();
      const isMember = await this._isMember(pid);
      if (isMember) {
        this.openWorkspace(pid, info);
      } else if (info.visibility === 'public') {
        await this._joinProject(pid, info);
        this.openWorkspace(pid, info);
      } else {
        // Private — show request flow
        Toast.info(`"${info.name}" is private. Request to join?`);
        this._openRequestModal(pid, info);
      }
    } catch(e) { Toast.error('Could not open project link'); }
  },

  // ──────────────────────────────────────────────────────────────────
  //  LOAD LISTS
  // ──────────────────────────────────────────────────────────────────
  async loadPublicProjects() {
    const skel = $('proj-public-skel');
    const list = $('proj-public-list');
    if (!list) return;
    if (skel) skel.style.display = 'block';
    list.innerHTML = '';

    try {
      // FIX: The Firebase security rules intentionally have NO root-level .read
      // on 'projects/' (to protect messages, tasks & join-requests from non-members).
      // Calling get(ref(db,'projects')) always threw PERMISSION_DENIED → "Could not
      // load projects". We now read the lightweight 'projectIndex/' node instead,
      // which IS root-readable and holds only { visibility, seekingMembers, ownerId,
      // createdAt }. Individual info + members nodes are then fetched per-project
      // (both are allowed for any authenticated user by the rules).
      const indexSnap = await get(ref(db, 'projectIndex'));
      if (skel) skel.style.display = 'none';
      if (!indexSnap.exists()) {
        list.innerHTML = this._emptyState('<i data-lucide="globe" class="lucide" width="32" height="32"></i>','No public projects yet','Be the first to create one!');
        return;
      }
      const uid = state.currentUser?.uid;
      const publicEntries = [];
      indexSnap.forEach(child => {
        if (child.val()?.visibility === 'public') publicEntries.push({ id: child.key, ...child.val() });
      });
      if (publicEntries.length === 0) {
        list.innerHTML = this._emptyState('<i data-lucide="globe" class="lucide" width="32" height="32"></i>','No public projects yet','Be the first to create one!');
        return;
      }
      publicEntries.sort((a,b) => (b.createdAt||0) - (a.createdAt||0));
      for (const entry of publicEntries) {
        const [infoSnap, memberSnap, membersSnap] = await Promise.all([
          get(ref(db, `projects/${entry.id}/info`)).catch(()=>null),
          uid ? get(ref(db, `projects/${entry.id}/members/${uid}`)).catch(()=>null) : Promise.resolve(null),
          get(ref(db, `projects/${entry.id}/members`)).catch(()=>null),
        ]);
        if (!infoSnap?.exists()) continue;
        const info = infoSnap.val();
        const isMember = memberSnap?.exists() || false;
        const memberCount = membersSnap?.exists() ? Object.keys(membersSnap.val()).length : 0;
        list.appendChild(this._buildProjectCard({ id: entry.id, ...info }, isMember, memberCount, false));
      }
      if (!list.hasChildNodes()) {
        list.innerHTML = this._emptyState('<i data-lucide="globe" class="lucide" width="32" height="32"></i>','No public projects yet','Be the first to create one!');
      }
    } catch(e) {
      if (skel) skel.style.display = 'none';
      list.innerHTML = `<div style="text-align:center;padding:32px;color:var(--muted);font-size:12px;">Could not load projects</div>`;
    }
  },

  async loadMyProjects() {
    const skel = $('proj-mine-skel');
    const list = $('proj-mine-list');
    if (!list || !state.currentUser) return;
    const uid = state.currentUser.uid;
    if (skel) skel.style.display = 'block';
    list.innerHTML = '';
    try {
      // FIX: Same root-read issue as loadPublicProjects. Enumerate project IDs from
      // 'projectIndex/', then check projects/$pid/members/$uid individually for each
      // to determine membership — avoids the forbidden root read on 'projects/'.
      const indexSnap = await get(ref(db, 'projectIndex'));
      if (skel) skel.style.display = 'none';
      if (!indexSnap.exists()) {
        list.innerHTML = this._emptyState('<i data-lucide="zap" class="lucide" width="32" height="32"></i>','No projects yet','Create one or join a public project');
        return;
      }
      const allIds = [];
      indexSnap.forEach(child => allIds.push(child.key));
      const mine = [];
      for (const pid of allIds) {
        const memberSnap = await get(ref(db, `projects/${pid}/members/${uid}`)).catch(()=>null);
        if (!memberSnap?.exists()) continue;
        const infoSnap = await get(ref(db, `projects/${pid}/info`)).catch(()=>null);
        if (infoSnap?.exists()) mine.push({ id: pid, ...infoSnap.val() });
      }
      if (mine.length === 0) {
        list.innerHTML = this._emptyState('<i data-lucide="zap" class="lucide" width="32" height="32"></i>','No projects yet','Create one or join a public project');
        return;
      }
      mine.sort((a,b) => (b.createdAt||0) - (a.createdAt||0));
      for (const p of mine) {
        const membersSnap = await get(ref(db, `projects/${p.id}/members`)).catch(()=>null);
        const memberCount = membersSnap?.exists() ? Object.keys(membersSnap.val()).length : 0;
        list.appendChild(this._buildProjectCard(p, true, memberCount, false));
      }
    } catch(e) {
      if (skel) skel.style.display = 'none';
      list.innerHTML = `<div style="text-align:center;padding:32px;color:var(--muted);font-size:12px;">Could not load projects</div>`;
    }
  },

  async loadSeekingProjects() {
    const skel = $('proj-seeking-skel');
    const seekList = $('proj-seeking-list');
    const privateMineList = $('proj-private-mine-list');
    const privateMineSection = $('proj-private-mine-section');
    if (!seekList || !state.currentUser) return;
    const uid = state.currentUser.uid;
    if (skel) skel.style.display = 'block';
    seekList.innerHTML = '';
    if (privateMineList) privateMineList.innerHTML = '';

    try {
      // FIX: Same root-read issue. Use 'projectIndex/' to enumerate private project
      // IDs, then individually fetch info + check membership per project. The index
      // stores seekingMembers so we can filter without reading the full project node.
      const indexSnap = await get(ref(db, 'projectIndex'));
      if (skel) skel.style.display = 'none';
      if (!indexSnap.exists()) {
        seekList.innerHTML = this._emptyState('<i data-lucide="search" class="lucide" width="32" height="32"></i>','No open projects','Private projects seeking members will appear here');
        return;
      }

      const privateEntries = [];
      indexSnap.forEach(child => {
        if (child.val()?.visibility === 'private') privateEntries.push({ id: child.key, ...child.val() });
      });

      const seekingProjects = [];
      const myPrivate = [];

      for (const entry of privateEntries) {
        const [memberSnap, infoSnap] = await Promise.all([
          get(ref(db, `projects/${entry.id}/members/${uid}`)).catch(()=>null),
          get(ref(db, `projects/${entry.id}/info`)).catch(()=>null),
        ]);
        if (!infoSnap?.exists()) continue;
        const info = infoSnap.val();
        const isMember = memberSnap?.exists() || false;
        if (isMember) {
          myPrivate.push({ id: entry.id, ...info });
        } else if (entry.seekingMembers) {
          seekingProjects.push({ id: entry.id, ...info });
        }
      }

      // My private projects section
      if (myPrivate.length > 0 && privateMineSection && privateMineList) {
        privateMineSection.style.display = 'block';
        for (const p of myPrivate) {
          const membersSnap = await get(ref(db, `projects/${p.id}/members`)).catch(()=>null);
          const memberCount = membersSnap?.exists() ? Object.keys(membersSnap.val()).length : 0;
          privateMineList.appendChild(this._buildProjectCard(p, true, memberCount, false));
        }
      }

      // Seeking projects
      if (seekingProjects.length === 0) {
        seekList.innerHTML = this._emptyState('<i data-lucide="search" class="lucide" width="32" height="32"></i>','No projects seeking members','Check back later or create your own');
        return;
      }
      seekingProjects.sort((a,b) => (b.createdAt||0) - (a.createdAt||0));
      for (const p of seekingProjects) {
        const membersSnap = await get(ref(db, `projects/${p.id}/members`)).catch(()=>null);
        const memberCount = membersSnap?.exists() ? Object.keys(membersSnap.val()).length : 0;
        // Check if already requested
        const reqSnap = await get(ref(db, `projects/${p.id}/requests`)).catch(()=>null);
        let alreadyRequested = false;
        if (reqSnap?.exists()) {
          reqSnap.forEach(c => { if (c.val()?.applicantUid === uid && c.val()?.status === 'pending') alreadyRequested = true; });
        }
        seekList.appendChild(this._buildProjectCard(p, false, memberCount, true, alreadyRequested));
      }
    } catch(e) {
      if (skel) skel.style.display = 'none';
      seekList.innerHTML = `<div style="text-align:center;padding:32px;color:var(--muted);font-size:12px;">Could not load</div>`;
    }
  },

  async loadWorkAds() {
    const skel = $('proj-work-skel');
    const list = $('proj-work-list');
    const mySection = $('proj-my-work-ads-section');
    const myList = $('proj-my-work-ads-list');
    if (!list || !state.currentUser) return;
    if (skel) skel.style.display = 'block';
    list.innerHTML = '';
    if (myList) myList.innerHTML = '';
    if (mySection) mySection.style.display = 'none';

    try {
      const snap = await get(ref(db, 'workAds')).catch(() => null);
      if (skel) skel.style.display = 'none';
      if (!snap || !snap.exists()) {
        list.innerHTML = this._emptyState('<i data-lucide="briefcase" class="lucide" width="32" height="32"></i>', 'No work ads yet', 'Create one from your project workspace');
        return;
      }

      const uid = state.currentUser.uid;
      const mine = [];
      const allOpen = [];
      this.workAdsMap = {};
      snap.forEach(child => {
        const ad = child.val() || {};
        const entry = { id: child.key, ...ad };
        this.workAdsMap[child.key] = entry;
        if (ad.ownerId === uid) mine.push(entry);
        if (ad.status === 'open') allOpen.push(entry);
      });

      const queryText = this._workSearchQuery || '';
      const filterFn = (ad) => {
        if (!queryText) return true;
        const hay = [
          ad.projectName || '',
          ad.ownerUsername || '',
          ad.roleTitle || '',
          ad.description || '',
          ...(Array.isArray(ad.skills) ? ad.skills : [])
        ].join(' ').toLowerCase();
        return hay.includes(queryText);
      };

      const mineFiltered = mine.filter(filterFn).sort((a,b) => (b.createdAt || 0) - (a.createdAt || 0));
      const openFiltered = allOpen.filter(filterFn).sort((a,b) => {
        const af = a.ownerIsPro ? 1 : 0, bf = b.ownerIsPro ? 1 : 0;
        if (bf !== af) return bf - af;
        return (b.createdAt || 0) - (a.createdAt || 0);
      });

      if (mySection && myList && mineFiltered.length > 0) {
        mySection.style.display = 'block';
        mineFiltered.forEach(ad => {
          const card = this._buildWorkAdCard(ad, true);
          myList.appendChild(card);
        });
      }

      if (openFiltered.length === 0) {
        list.innerHTML = this._emptyState('<i data-lucide="briefcase" class="lucide" width="32" height="32"></i>', 'No open roles found', queryText ? 'Try a different search query' : 'Check back soon for new opportunities');
        return;
      }

      openFiltered.forEach(ad => {
        const card = this._buildWorkAdCard(ad, false);
        list.appendChild(card);
      });
    } catch (e) {
      if (skel) skel.style.display = 'none';
      list.innerHTML = `<div style="text-align:center;padding:32px;color:var(--muted);font-size:12px;">Could not load work ads</div>`;
    }
  },

  _buildWorkAdCard(ad, isMyAd) {
    const card = document.createElement('div');
    card.className = 'project-card work-ad-card';
    const skills = Array.isArray(ad.skills) ? ad.skills.slice(0, 5) : [];
    const skillsHtml = skills.map(s => `<span class="project-role-pill">${escHtml(s)}</span>`).join('');
    const applicant = ad.applicants && state.currentUser ? ad.applicants[state.currentUser.uid] : null;
    const remaining = Number.isFinite(ad.spotsRemaining) ? ad.spotsRemaining : (parseInt(ad.spotsRemaining, 10) || 0);
    const spotsText = `${Math.max(0, remaining)}/${parseInt(ad.spotsAvailable, 10) || 0}`;
    const compText = ad.compensation || 'Unpaid';
    const commitmentText = ad.commitment || 'Ongoing';
    const visBadge = ad.visibility === 'private' ? '<i data-lucide="lock" class="lucide" width="12" height="12"></i> Private' : '<i data-lucide="globe" class="lucide" width="12" height="12"></i> Public';
    const ownerLabel = ad.ownerUsername ? `@${ad.ownerUsername}` : 'Unknown';
    const applyLabel = ad.visibility === 'private' ? '<i data-lucide="lock" class="lucide" width="12" height="12"></i> Apply' : 'Apply Now';
    const isClosed = ad.status !== 'open' || remaining <= 0;

    let actionHtml = '';
    if (isMyAd) {
      actionHtml = `
        <button class="project-join-btn request" data-action="edit">Edit</button>
        <button class="project-join-btn" data-action="close">Close</button>
        <button class="project-join-btn member" data-action="boost">Boost</button>
      `;
    } else if (applicant) {
      const status = (applicant.status || '').toLowerCase();
      const map = {
        accepted: { text: 'You\'re in!', className: 'member' },
        pending: { text: 'Under Review <i data-lucide="lock" class="lucide" width="12" height="12"></i>', className: 'pending' },
        declined: { text: 'Declined', className: 'declined' }
      };
      const meta = map[status] || { text: `Applied (${status || 'pending'})`, className: 'pending' };
      actionHtml = `<button class="project-join-btn ${meta.className}" disabled>${escHtml(meta.text)}</button>`;
    } else if (isClosed) {
      actionHtml = `<button class="project-join-btn declined" disabled>Closed</button>`;
    } else {
      actionHtml = `<button class="project-join-btn" data-action="apply">${escHtml(applyLabel)}</button>`;
    }

    /* ── Pro: featured work ads ── */
    const _adIsFeatured = ad.ownerIsPro === true;
    if (_adIsFeatured) card.classList.add('is-featured');
    card.innerHTML = `
      ${_adIsFeatured ? '<div class="featured-tag"><i data-lucide="star" class="lucide" width="12" height="12"></i> Featured</div>' : ''}
      <div class="project-card-cover">${this._projectEmoji(ad.projectName || ad.roleTitle || 'Work')}</div>
      <div class="project-card-body">
        <div class="project-card-name">${escHtml(ad.projectName || 'Project')}</div>
        <div class="work-ad-owner">by <button class="work-ad-owner-btn" type="button" data-action="owner">${escHtml(ownerLabel)}</button></div>
        <div class="project-card-desc">${escHtml(ad.roleTitle || 'Role')}</div>
        ${ad.description ? `<div class="project-card-desc">${escHtml(ad.description)}</div>` : ''}
        ${skillsHtml ? `<div class="project-role-pills">${skillsHtml}</div>` : ''}
        <div class="work-ad-meta">
          <span class="project-card-stat">${escHtml(commitmentText)}</span>
          <span class="project-card-stat">${escHtml(compText)}</span>
          <span class="project-card-stat">Spots ${escHtml(spotsText)}</span>
          <span class="project-visibility-badge ${ad.visibility === 'private' ? 'private' : 'public'}">${escHtml(visBadge)}</span>
        </div>
      </div>
      <div class="project-card-actions">${actionHtml}</div>
    `;

    card.querySelector('[data-action="owner"]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const uid = ad.ownerId;
      if (!uid) return;
      const ownerSnap = await get(ref(db, `users/${uid}`)).catch(() => null);
      const owner = ownerSnap?.exists() ? ownerSnap.val() : {};
      openUserProfileSheet(uid, owner.username || ad.ownerUsername || '', owner.skill || 'Explorer', owner.level || 'Beginner', owner.points || 0, owner.pfpUrl || '', owner.bio || '', owner.expertise || null, owner.socialIntegrations || null);
    });

    card.querySelector('[data-action="apply"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (ad.visibility === 'private') this._openWorkPitchModal(ad.id, ad);
      else this._applyToWorkAd(ad.id, '');
    });

    card.querySelector('[data-action="edit"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this._openWorkAdModal(ad);
    });
    card.querySelector('[data-action="close"]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      await this._closeWorkAd(ad.id);
    });
    card.querySelector('[data-action="boost"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      Toast.info('Boost coming soon');
    });

    card.addEventListener('click', () => {
      if (ad.projectId && this.currentProjectId === ad.projectId && this.currentProjectData) {
        ScreenManager.show('project-workspace-screen');
      }
    });

    return card;
  },

  _addWorkAdSkill() {
    const input = $('proj-work-skill-input');
    if (!input) return;
    const raw = input.value.trim();
    const value = raw.replace(/[^a-zA-Z0-9 \-_.+#]/g,'').trim().slice(0, 24);
    if (!value) return;
    if (this.workAdSkills.some(s => s.toLowerCase() === value.toLowerCase())) { input.value = ''; return; }
    if (this.workAdSkills.length >= 5) { Toast.info('Maximum 5 skills'); return; }
    this.workAdSkills.push(value);
    input.value = '';
    this._renderWorkAdSkills();
  },

  _renderWorkAdSkills() {
    const grid = $('proj-work-skills-grid');
    const tags = $('proj-work-skill-tags');
    if (grid) {
      grid.querySelectorAll('.skill-select-pill').forEach(pill => {
        const skill = (pill.dataset.skill || '').trim().toLowerCase();
        const selected = this.workAdSkills.some(s => s.toLowerCase() === skill);
        pill.classList.toggle('selected', selected);
      });
    }
    if (!tags) return;
    const customSkills = this.workAdSkills.filter(s => !PREDEFINED_SKILLS.some(ps => ps.toLowerCase() === s.toLowerCase()));
    tags.innerHTML = customSkills.map(skill => `<div class="skill-tag">${escHtml(skill)}<span class="tag-remove" data-skill="${escHtml(skill)}" style="cursor:pointer;margin-left:5px;"><i data-lucide="x" class="lucide" width="16" height="16"></i></span></div>`).join('');
    tags.querySelectorAll('.tag-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const skill = btn.dataset.skill || '';
        this.workAdSkills = this.workAdSkills.filter(s => s.toLowerCase() !== skill.toLowerCase());
        this._renderWorkAdSkills();
      });
    });
  },

  _openWorkAdModal(existingAd = null) {
    if (existingAd && (!this.currentProjectId || this.currentProjectId !== existingAd.projectId)) {
      this.currentProjectId = existingAd.projectId || this.currentProjectId;
      this.currentProjectData = {
        ...(this.currentProjectData || {}),
        ownerId: existingAd.ownerId,
        name: existingAd.projectName || this.currentProjectData?.name || 'Project'
      };
    }
    if (!this.currentProjectId || !this.currentProjectData || this.currentProjectData.ownerId !== state.currentUser?.uid) {
      Toast.error('Only project owners can advertise work');
      return;
    }
    $('proj-work-edit-ad-id').value = existingAd?.id || '';
    $('proj-work-ad-modal-title').textContent = existingAd ? 'Edit Work Ad' : 'Create Work Ad';
    $('proj-work-role-title-input').value = existingAd?.roleTitle || '';
    $('proj-work-desc-input').value = existingAd?.description || '';
    $('proj-work-commitment-select').value = existingAd?.commitment || 'One-time Gig';
    const compText = (existingAd?.compensation || 'Unpaid');
    let compType = 'Unpaid';
    let compExtra = '';
    if (compText.startsWith('Paid')) {
      compType = 'Paid';
      compExtra = compText.replace(/^Paid\s*[-:]\s*/,'').trim();
    } else if (compText === 'Revenue Share') compType = 'Revenue Share';
    $('proj-work-comp-type-select').value = compType;
    $('proj-work-comp-text-input').style.display = compType === 'Paid' ? 'block' : 'none';
    $('proj-work-comp-text-input').value = compExtra;
    $('proj-work-visibility-select').value = existingAd?.visibility || 'public';
    $('proj-work-spots-input').value = Math.min(10, Math.max(1, parseInt(existingAd?.spotsAvailable, 10) || 1));
    this.workAdSkills = Array.isArray(existingAd?.skills) ? existingAd.skills.slice(0,5) : [];
    this._renderWorkAdSkills();
    $('proj-work-skill-input').value = '';
    $('proj-work-ad-submit-btn').innerHTML = existingAd ? '<i data-lucide="save" class="lucide" width="16" height="16"></i> Save Ad' : '<i data-lucide="megaphone" class="lucide" width="16" height="16"></i> Publish Ad';
    this._openModal('proj-work-ad-modal-overlay');
  },

  async _submitWorkAd() {
    if (!state.currentUser || !this.currentProjectId || !this.currentProjectData) return;
    if (this.currentProjectData.ownerId !== state.currentUser.uid) return;
    const roleTitle = $('proj-work-role-title-input')?.value.trim();
    if (!roleTitle) { Toast.error('Role title is required'); return; }
    const description = ($('proj-work-desc-input')?.value || '').trim().slice(0, 400);
    const commitment = $('proj-work-commitment-select')?.value || 'One-time Gig';
    const compType = $('proj-work-comp-type-select')?.value || 'Unpaid';
    const compText = $('proj-work-comp-text-input')?.value.trim() || '';
    const visibility = $('proj-work-visibility-select')?.value === 'private' ? 'private' : 'public';
    const spotsAvailable = Math.min(10, Math.max(1, parseInt($('proj-work-spots-input')?.value, 10) || 1));
    const skills = this.workAdSkills.slice(0, 5);
    const editId = $('proj-work-edit-ad-id')?.value || '';
    const btn = $('proj-work-ad-submit-btn');
    if (btn) { btn.disabled = true; btn.textContent = editId ? 'Saving...' : 'Publishing...'; }

    try {
      const uid = state.currentUser.uid;
      const compensation = compType === 'Paid' ? `Paid${compText ? ` - ${compText}` : ''}` : compType;
      const now = Date.now();
      const adId = editId || push(ref(db, 'workAds')).key;
      let applicants = {};
      let createdAt = now;
      if (editId) {
        const prevSnap = await get(ref(db, `workAds/${editId}`)).catch(() => null);
        const prev = prevSnap?.exists() ? prevSnap.val() : {};
        applicants = prev.applicants || {};
        createdAt = prev.createdAt || now;
      }
      const acceptedCount = Object.values(applicants).filter(a => (a?.status || '') === 'accepted').length;
      const spotsRemaining = Math.max(0, spotsAvailable - acceptedCount);
      const adData = {
        projectId: this.currentProjectId,
        projectName: this.currentProjectData.name || 'Project',
        ownerId: uid,
        ownerUsername: state.username || 'Unknown',
        ownerIsPro: state.isPro === true,
        roleTitle,
        description,
        skills,
        commitment,
        compensation,
        visibility,
        spotsAvailable,
        spotsRemaining,
        createdAt,
        status: spotsRemaining > 0 ? 'open' : 'closed'
      };
      if (Object.keys(applicants).length > 0) adData.applicants = applicants;
      await set(ref(db, `workAds/${adId}`), adData).catch((e) => { throw e; });
      this._closeModal('proj-work-ad-modal-overlay');
      Toast.success(editId ? 'Work ad updated' : 'Work ad published');
      this.loadWorkAds();
      this._watchProjectWorkApplicants();
    } catch (e) {
      Toast.error(e.message || 'Could not save work ad');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = editId ? '<i data-lucide="save" class="lucide" width="16" height="16"></i> Save Ad' : '<i data-lucide="megaphone" class="lucide" width="16" height="16"></i> Publish Ad';
      }
    }
  },

  _openWorkPitchModal(adId, ad) {
    $('proj-work-pitch-ad-id').value = adId || '';
    $('proj-work-pitch-input').value = '';
    $('proj-work-pitch-role-label').textContent = `Applying for ${ad?.roleTitle || 'role'} in ${ad?.projectName || 'project'}`;
    this._openModal('proj-work-pitch-modal-overlay');
  },

  async _submitWorkPitch() {
    const adId = $('proj-work-pitch-ad-id')?.value || '';
    const pitch = ($('proj-work-pitch-input')?.value || '').trim().slice(0, 200);
    if (!adId) return;
    await this._applyToWorkAd(adId, pitch);
    this._closeModal('proj-work-pitch-modal-overlay');
  },

  async _decrementSpot(adId, ownerId) {
    const tx = await runTransaction(ref(db, `workAds/${adId}/spotsRemaining`), (current) => {
      const val = Number.isFinite(current) ? current : parseInt(current, 10);
      if (!Number.isFinite(val) || val <= 0) return;
      return val - 1;
    }).catch(() => null);
    if (!tx || !tx.committed) throw new Error('No spots remaining');
    const nextVal = tx.snapshot?.val();
    if ((parseInt(nextVal, 10) || 0) <= 0) {
      /* Rules now restrict status writes to the ad owner or admin.
         Only attempt the status update if the current user is the owner.
         The client-side isClosed check (spotsRemaining <= 0) handles the
         display correctly for non-owners even if status stays 'open'. */
      if (ownerId && state.currentUser && ownerId === state.currentUser.uid) {
        await update(ref(db, `workAds/${adId}`), { status: 'closed' }).catch(() => {});
      }
    }
  },

  async _applyToWorkAd(adId, pitch = '') {
    if (!state.currentUser) return;
    const uid = state.currentUser.uid;
    try {
      const adSnap = await get(ref(db, `workAds/${adId}`)).catch(() => null);
      if (!adSnap || !adSnap.exists()) { Toast.error('Ad not found'); return; }
      const ad = adSnap.val() || {};
      if ((ad.status || 'open') !== 'open') { Toast.info('This ad is closed'); return; }
      if ((parseInt(ad.spotsRemaining, 10) || 0) <= 0) { Toast.info('No spots remaining'); return; }
      if ((ad.applicants || {})[uid]) {
        const st = (ad.applicants[uid].status || 'pending');
        Toast.info(`Already applied (${st})`);
        return;
      }

      const appData = {
        uid,
        username: state.username || 'Unknown',
        pfpUrl: state.pfpUrl || null,
        pitch: (pitch || '').slice(0, 200),
        appliedAt: Date.now(),
        status: ad.visibility === 'private' ? 'pending' : 'accepted'
      };

      if (ad.visibility === 'private') {
        await set(ref(db, `workAds/${adId}/applicants/${uid}`), appData).catch((e) => { throw e; });
        if (ad.ownerId && ad.ownerId !== uid) {
          await NotifSystem.push(ad.ownerId, 'work_applicant', `@${state.username || 'Someone'} applied for "${ad.roleTitle || 'role'}"`).catch(() => {});
        }
        Toast.success('Application sent');
      } else {
        await this._decrementSpot(adId, ad.ownerId);
        await set(ref(db, `workAds/${adId}/applicants/${uid}`), appData).catch((e) => { throw e; });
        await set(ref(db, `projects/${ad.projectId}/members/${uid}`), {
          role: ad.roleTitle || 'Member',
          joinedAt: Date.now(),
          username: state.username || 'Unknown',
          pfpUrl: state.pfpUrl || null
        }).catch(() => {});
        if (ad.ownerId && ad.ownerId !== uid) {
          await NotifSystem.push(ad.ownerId, 'work_applicant_accepted', `@${state.username || 'Someone'} joined "${ad.projectName || 'your project'}"`).catch(() => {});
        }
        Toast.success(`You're in!`);
      }
      this.loadWorkAds();
      this._watchProjectWorkApplicants();
    } catch (e) {
      Toast.error(e.message || 'Could not apply');
    }
  },

  async _closeWorkAd(adId) {
    if (!state.currentUser) return;
    const ad = this.workAdsMap[adId];
    if (!ad || ad.ownerId !== state.currentUser.uid) return;
    await update(ref(db, `workAds/${adId}`), { status: 'closed' }).catch(() => {});
    Toast.success('Ad closed');
    this.loadWorkAds();
    this._watchProjectWorkApplicants();
  },

  _watchProjectWorkApplicants() {
    if (this._unsubWorkAds) { this._unsubWorkAds(); this._unsubWorkAds = null; }
    const section = $('proj-work-applicants-section');
    const list = $('proj-work-applicants-list');
    if (!section || !list || !this.currentProjectId || !state.currentUser) return;
    if (this.currentProjectData?.ownerId !== state.currentUser.uid) {
      section.style.display = 'none';
      return;
    }
    this._unsubWorkAds = onValue(ref(db, 'workAds'), (snap) => {
      const pending = [];
      if (snap?.exists()) {
        snap.forEach(child => {
          const ad = child.val() || {};
          if (ad.projectId !== this.currentProjectId) return;
          const applicants = ad.applicants || {};
          Object.entries(applicants).forEach(([uid, app]) => {
            if ((app?.status || '') === 'pending') pending.push({ adId: child.key, ad, uid, app });
          });
        });
      }
      this._renderWorkApplicants(pending);
    });
  },

  _renderWorkApplicants(items) {
    const section = $('proj-work-applicants-section');
    const list = $('proj-work-applicants-list');
    if (!section || !list) return;
    if (!items.length) { section.style.display = 'none'; list.innerHTML = ''; return; }
    section.style.display = 'block';
    list.innerHTML = '';
    items.sort((a,b) => (b.app.appliedAt || 0) - (a.app.appliedAt || 0)).forEach((item) => {
      const row = document.createElement('div');
      row.className = 'proj-request-row';
      const pfp = item.app.pfpUrl || generateAvatarUrl(item.uid || 'x');
      row.innerHTML = `
        <div class="proj-request-avatar"><img src="${escHtml(pfp)}" alt="" onerror="this.style.display='none';this.parentElement.textContent='${escHtml(initials(item.app.username||'?'))}'" loading="lazy"></div>
        <div class="proj-request-body">
          <div class="proj-request-name">@${escHtml(item.app.username || 'Unknown')}</div>
          <div class="proj-request-role-text">Role: ${escHtml(item.ad.roleTitle || 'Member')}</div>
          ${item.app.pitch ? `<div class="proj-request-msg">${escHtml(item.app.pitch)}</div>` : ''}
          <div class="proj-request-btns">
            <button class="proj-request-accept-btn" data-action="accept"><i data-lucide="check" class="lucide" width="16" height="16"></i> Accept</button>
            <button class="proj-request-decline-btn" data-action="decline"><i data-lucide="x" class="lucide" width="16" height="16"></i> Decline</button>
          </div>
          <div style="font-size:9px;color:var(--muted);font-family:var(--font-mono);margin-top:4px;">${timeAgo(item.app.appliedAt)}</div>
        </div>
      `;
      row.querySelector('[data-action="accept"]')?.addEventListener('click', () => this._reviewWorkApplicant(item, true));
      row.querySelector('[data-action="decline"]')?.addEventListener('click', () => this._reviewWorkApplicant(item, false));
      list.appendChild(row);
    });
  },

  async _reviewWorkApplicant(item, accept) {
    if (!state.currentUser || this.currentProjectData?.ownerId !== state.currentUser.uid) return;
    try {
      if (accept) {
        const adSnap = await get(ref(db, `workAds/${item.adId}`)).catch(() => null);
        const ad = adSnap?.exists() ? adSnap.val() : null;
        if (!ad) { Toast.error('Ad not found'); return; }
        if ((parseInt(ad.spotsRemaining, 10) || 0) <= 0) { Toast.info('No spots remaining'); return; }
        await this._decrementSpot(item.adId, ad.ownerId);
        await update(ref(db, `workAds/${item.adId}/applicants/${item.uid}`), {
          status: 'accepted',
          reviewedAt: Date.now()
        }).catch((e) => { throw e; });
        await set(ref(db, `projects/${this.currentProjectId}/members/${item.uid}`), {
          role: ad.roleTitle || 'Member',
          joinedAt: Date.now(),
          username: item.app.username || 'Unknown',
          pfpUrl: item.app.pfpUrl || null
        }).catch(() => {});
        await NotifSystem.push(item.uid, 'work_application_accepted', `You were accepted for "${ad.roleTitle || 'a role'}"`).catch(() => {});
        Toast.success('Applicant accepted');
      } else {
        await update(ref(db, `workAds/${item.adId}/applicants/${item.uid}`), {
          status: 'declined',
          reviewedAt: Date.now()
        }).catch((e) => { throw e; });
        await NotifSystem.push(item.uid, 'work_application_declined', `Your application for "${item.ad.roleTitle || 'a role'}" was declined`).catch(() => {});
        Toast.info('Applicant declined');
      }
      this.loadWorkAds();
    } catch (e) {
      Toast.error(e.message || 'Could not review application');
    }
  },

  // ──────────────────────────────────────────────────────────────────
  //  BUILD PROJECT CARD
  // ──────────────────────────────────────────────────────────────────
  _buildProjectCard(p, isMember, memberCount, isSeekingTab, alreadyRequested) {
    const card = document.createElement('div');
    card.className = 'project-card';

    const coverHTML = p.coverUrl
      ? `<div class="project-card-cover"><img src="${escHtml(p.coverUrl)}" alt=""></div>`
      : `<div class="project-card-cover">${this._projectEmoji(p.name)}</div>`;

    const rolesHTML = (p.rolesNeeded || []).slice(0, 4).map(r =>
      `<span class="project-role-pill">${escHtml(r.skill)}${r.qty>1?' ×'+r.qty:''}</span>`
    ).join('');

    const tagsHTML = (p.tags || []).slice(0, 3).map(t =>
      `<span class="project-card-stat">${escHtml(t)}</span>`
    ).join('');

    let btnLabel, btnClass;
    if (isMember) { btnLabel = 'View'; btnClass = 'project-join-btn member'; }
    else if (isSeekingTab) {
      btnLabel = alreadyRequested ? 'Requested' : 'Request';
      btnClass = 'project-join-btn request';
    } else { btnLabel = 'Join'; btnClass = 'project-join-btn'; }

    card.innerHTML = `
      ${coverHTML}
      <div class="project-card-body">
        <div class="project-card-name">${escHtml(p.name || 'Unnamed Project')}</div>
        ${p.description ? `<div class="project-card-desc">${escHtml(p.description)}</div>` : ''}
        <div class="project-card-meta">
          <span class="project-card-stat"><i data-lucide="users" class="lucide" width="16" height="16"></i> ${memberCount}</span>
          <span class="project-visibility-badge ${p.visibility}">${p.visibility==='public'?'Public':'Private'}</span>
          ${tagsHTML}
        </div>
        ${rolesHTML ? `<div class="project-role-pills">${rolesHTML}</div>` : ''}
      </div>
      <div class="project-card-actions">
        <button class="${btnClass}" data-pid="${escHtml(p.id)}">${btnLabel}</button>
      </div>
    `;

    // Card click — open workspace
    card.addEventListener('click', (e) => {
      if (e.target.closest('.project-join-btn')) return; // handled by button
      if (isMember) this.openWorkspace(p.id, p);
    });

    // Button actions
    const btn = card.querySelector('.project-join-btn');
    if (btn) {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (isMember) {
          this.openWorkspace(p.id, p);
        } else if (isSeekingTab && !alreadyRequested) {
          this._openRequestModal(p.id, p);
        } else if (!isSeekingTab && !isMember) {
          // Public join
          try {
            btn.disabled = true; btn.textContent = 'Joining...';
            await this._joinProject(p.id, p);
            btn.textContent = 'View'; btn.className = 'project-join-btn member';
            isMember = true;
            Toast.success(`Joined "${p.name}"!`);
          } catch(err) { btn.disabled = false; btn.textContent = 'Join'; Toast.error(err.message || 'Could not join'); }
        }
      });
    }
    return card;
  },

  _projectEmoji(name) {
    const n = (name||'').toLowerCase();
    if (n.includes('music') || n.includes('audio')) return '<i data-lucide="music" class="lucide" width="16" height="16"></i>';
    if (n.includes('game') || n.includes('gaming')) return '<i data-lucide="gamepad-2" class="lucide" width="16" height="16"></i>';
    if (n.includes('design') || n.includes('art')) return '<i data-lucide="palette" class="lucide" width="16" height="16"></i>';
    if (n.includes('code') || n.includes('app') || n.includes('web')) return '<i data-lucide="monitor" class="lucide" width="16" height="16"></i>';
    if (n.includes('film') || n.includes('video')) return '<i data-lucide="clapperboard" class="lucide" width="16" height="16"></i>';
    if (n.includes('write') || n.includes('blog') || n.includes('book')) return '<i data-lucide="pencil" class="lucide" width="16" height="16"></i>';
    return '<i data-lucide="folder" class="lucide" width="16" height="16"></i>';
  },

  _emptyState(icon, title, sub) {
    return `<div class="projects-empty"><div class="projects-empty-icon">${icon}</div><div class="projects-empty-title">${escHtml(title)}</div><div class="projects-empty-sub">${escHtml(sub)}</div></div>`;
  },

  // ──────────────────────────────────────────────────────────────────
  //  CREATE SCREEN
  // ──────────────────────────────────────────────────────────────────
  _openCreateScreen() {
    // Reset form
    const nameInput = $('proj-name-input'); if (nameInput) nameInput.value = '';
    const descInput = $('proj-desc-input'); if (descInput) descInput.value = '';
    $('proj-vis-public')?.classList.add('selected');
    $('proj-vis-private')?.classList.remove('selected');
    $('proj-vis-value').value = 'public';
    $('proj-private-options').style.display = 'none';
    $('proj-seek-checkbox').checked = false;
    $('proj-roles-list').innerHTML = '';
    $('proj-cover-img').src = ''; $('proj-cover-img').style.display = 'none';
    $('proj-cover-placeholder').style.display = 'flex';
    $('proj-tags-wrap').innerHTML = '';
    $('proj-name-error').style.display = 'none';
    this.projectTags = [];
    this.projectRoles = [];
    this.coverDataUrl = null;
    // Add one default role row
    this._addRoleRow();
    ScreenManager.show('project-create-screen');
  },

  _addRoleRow() {
    const list = $('proj-roles-list'); if (!list) return;
    const idx = this.projectRoles.length;
    this.projectRoles.push({ skill: PREDEFINED_SKILLS[0], qty: 1 });

    const row = document.createElement('div');
    row.className = 'proj-role-row';
    row.dataset.idx = idx;
    row.innerHTML = `
      <select data-idx="${idx}" class="proj-role-skill-select">
        ${PREDEFINED_SKILLS.map(s => `<option value="${escHtml(s)}" ${s===this.projectRoles[idx].skill?'selected':''}>${escHtml(s)}</option>`).join('')}
      </select>
      <input type="number" data-idx="${idx}" class="proj-role-qty-input" value="1" min="1" max="10" title="Quantity needed">
      <button type="button" class="proj-role-remove-btn" data-idx="${idx}" title="Remove role"><i data-lucide="x" class="lucide" width="12" height="12"></i></button>
    `;
    list.appendChild(row);

    row.querySelector('.proj-role-skill-select').addEventListener('change', (e) => {
      this.projectRoles[e.target.dataset.idx].skill = e.target.value;
    });
    row.querySelector('.proj-role-qty-input').addEventListener('change', (e) => {
      this.projectRoles[e.target.dataset.idx].qty = parseInt(e.target.value) || 1;
    });
    row.querySelector('.proj-role-remove-btn').addEventListener('click', (e) => {
      row.remove();
      this.projectRoles.splice(parseInt(e.target.dataset.idx), 1, null);
    });
  },

  _addProjectTag() {
    const input = $('proj-tag-input'); if (!input) return;
    const raw = input.value.trim();
    const v = raw.replace(/[^a-zA-Z0-9 \-_.+#]/g,'').trim().slice(0,20);
    if (!v) { if (raw) Toast.info('Only letters, numbers and basic symbols'); return; }
    if (this.projectTags.map(t=>t.toLowerCase()).includes(v.toLowerCase())) { Toast.info('Tag exists'); return; }
    if (this.projectTags.length >= CONFIG.MAX_TAGS) { Toast.info(`Max ${CONFIG.MAX_TAGS} tags`); return; }
    this.projectTags.push(v); input.value = '';
    this._renderProjectTags();
  },

  _renderProjectTags() {
    const wrap = $('proj-tags-wrap'); if (!wrap) return;
    wrap.innerHTML = '';
    this.projectTags.forEach((t, i) => {
      const el = document.createElement('div'); el.className = 'skill-tag';
      el.innerHTML = `${escHtml(t)}<span class="tag-remove" style="cursor:pointer;margin-left:5px;"><i data-lucide="x" class="lucide" width="16" height="16"></i></span>`;
      el.querySelector('.tag-remove').addEventListener('click', () => {
        this.projectTags.splice(i,1); this._renderProjectTags();
      });
      wrap.appendChild(el);
    });
  },

  async _createProject() {
    if (!state.currentUser) return;
    const name = $('proj-name-input')?.value.trim();
    if (!name) { $('proj-name-error').style.display = 'block'; return; }
    $('proj-name-error').style.display = 'none';

    const desc = $('proj-desc-input')?.value.trim() || '';
    const visibility = $('proj-vis-value')?.value || 'public';
    const seekingMembers = visibility === 'private' && $('proj-seek-checkbox')?.checked;
    const rolesNeeded = this.projectRoles.filter(r => r && r.skill);

    const btn = $('proj-create-submit-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Creating...'; }

    try {
      const projRef = push(ref(db, 'projects'));
      const pid = projRef.key;
      const uid = state.currentUser.uid;
      const now = Date.now();

      await set(ref(db, `projects/${pid}/info`), {
        name, description: desc, visibility, seekingMembers: seekingMembers || false,
        rolesNeeded: rolesNeeded.length > 0 ? rolesNeeded : [],
        coverUrl: this.coverDataUrl || null,
        tags: this.projectTags.length > 0 ? this.projectTags : [],
        ownerId: uid, createdAt: now
      });

      // Add owner as first member
      await set(ref(db, `projects/${pid}/members/${uid}`), {
        role: 'Owner', joinedAt: now,
        username: state.username || 'Unknown',
        pfpUrl: state.pfpUrl || null
      });

      // FIX: Write lightweight entry to 'projectIndex/' so the discover screen
      // can enumerate projects without a root-level read on 'projects/'. Contains
      // only the fields needed for listing: visibility, seekingMembers, ownerId,
      // createdAt. Must be kept in sync with projects/$pid/info by all write paths.
      await set(ref(db, `projectIndex/${pid}`), {
        visibility,
        seekingMembers: seekingMembers || false,
        ownerId: uid,
        createdAt: now
      });

      Toast.success(`Project "${name}" created!`);
      // Open workspace immediately
      const info = { name, description: desc, visibility, seekingMembers, rolesNeeded, coverUrl: this.coverDataUrl||null, tags: this.projectTags, ownerId: uid, createdAt: now };
      this.openWorkspace(pid, info);
    } catch(err) {
      Toast.error(err.message || 'Could not create project');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="rocket" class="lucide" width="16" height="16"></i> Create Project'; }
    }
  },

  // ──────────────────────────────────────────────────────────────────
  //  JOIN / LEAVE
  // ──────────────────────────────────────────────────────────────────
  async _isMember(pid) {
    if (!state.currentUser) return false;
    const snap = await get(ref(db, `projects/${pid}/members/${state.currentUser.uid}`)).catch(()=>null);
    return snap && snap.exists();
  },

  async _joinProject(pid, info) {
    if (!state.currentUser) throw new Error('Not logged in');
    const uid = state.currentUser.uid;
    await set(ref(db, `projects/${pid}/members/${uid}`), {
      role: 'Member', joinedAt: Date.now(),
      username: state.username || 'Unknown',
      pfpUrl: state.pfpUrl || null
    });
  },

  async _leaveProject() {
    if (!this.currentProjectId || !state.currentUser) return;
    if (this.currentProjectData?.ownerId === state.currentUser.uid) {
      Toast.error('Owners cannot leave. Delete the project instead.'); return;
    }
    if (!confirm('Leave this project?')) return;
    try {
      await remove(ref(db, `projects/${this.currentProjectId}/members/${state.currentUser.uid}`));
      this._leaveWorkspace();
      ScreenManager.show('projects-screen');
      // FIX: Also refresh Seeking tab — user may now reappear as a candidate
      this.loadPublicProjects(); this.loadMyProjects(); this.loadSeekingProjects(); this.loadWorkAds();
      Toast.success('Left the project');
    } catch(e) { Toast.error('Could not leave project'); }
  },

  async _deleteProject() {
    if (!this.currentProjectId || !state.currentUser) return;
    if (this.currentProjectData?.ownerId !== state.currentUser.uid) return;
    if (!confirm(`Delete "${this.currentProjectData?.name}"? This cannot be undone.`)) return;

    const pid = this.currentProjectId;

    // Disable the button to prevent double-clicks while deleting
    const menuBtn = $('proj-menu-delete');
    if (menuBtn) { menuBtn.style.pointerEvents = 'none'; menuBtn.textContent = 'Deleting…'; }

    try {
      // We cannot remove(ref(db, `projects/${pid}`)) directly because the top-level
      // project node has no write rule — only sub-paths do.  Instead we build a
      // multi-path null-update that covers every known sub-path the owner can write.

      // Fetch sub-collections we don't already have in memory
      const [msgsSnap, tasksSnap, reqsSnap, workAdsSnap] = await Promise.all([
        get(ref(db, `projects/${pid}/messages`)).catch(() => null),
        get(ref(db, `projects/${pid}/tasks`)).catch(() => null),
        get(ref(db, `projects/${pid}/requests`)).catch(() => null),
        get(ref(db, 'workAds')).catch(() => null),
      ]);

      const updates = {};

      // Project info  (owner has write permission)
      updates[`projects/${pid}/info`] = null;

      // FIX: Remove the projectIndex entry in the same atomic batch so the
      // discover screen never shows a ghost card for a deleted project.
      updates[`projectIndex/${pid}`] = null;

      // Each member entry  (owner can write any member)
      Object.keys(this.currentMembers || {}).forEach(uid => {
        updates[`projects/${pid}/members/${uid}`] = null;
      });

      // Each message  (member/owner has per-message write permission)
      if (msgsSnap?.exists()) {
        Object.keys(msgsSnap.val()).forEach(mid => {
          updates[`projects/${pid}/messages/${mid}`] = null;
        });
      }

      // Each task  (member/owner has per-task write permission)
      if (tasksSnap?.exists()) {
        Object.keys(tasksSnap.val()).forEach(tid => {
          updates[`projects/${pid}/tasks/${tid}`] = null;
        });
      }

      // Each join-request  (owner has write permission)
      if (reqsSnap?.exists()) {
        Object.keys(reqsSnap.val()).forEach(rid => {
          updates[`projects/${pid}/requests/${rid}`] = null;
        });
      }

      // Typing indicators are per-user and ephemeral — they expire on their own

      // Related work ads created for this project (owner writes only)
      if (workAdsSnap?.exists()) {
        Object.entries(workAdsSnap.val()).forEach(([adId, ad]) => {
          if ((ad?.projectId || '') === pid) updates[`workAds/${adId}`] = null;
        });
      }

      await update(ref(db), updates);

      this._leaveWorkspace();
      ScreenManager.show('projects-screen');
      // FIX: Also refresh Seeking tab — deleted project must vanish from it too
      this.loadPublicProjects(); this.loadMyProjects(); this.loadSeekingProjects(); this.loadWorkAds();
      Toast.success('Project deleted');
    } catch(e) {
      Toast.error('Could not delete project: ' + (e.message || 'Permission denied'));
      if (menuBtn) { menuBtn.style.pointerEvents = ''; menuBtn.innerHTML = '<i data-lucide="trash-2" class="lucide" width="16" height="16"></i> Delete Project'; }
    }
  },

  // ──────────────────────────────────────────────────────────────────
  //  WORKSPACE
  // ──────────────────────────────────────────────────────────────────
  openWorkspace(pid, info) {
    this._leaveWorkspace(); // cleanup any previous
    this.currentProjectId = pid;
    this.currentProjectData = info;
    this.currentMembers = {};
    this._renderedMsgIds = new Set();
    this._lastMsgDate = null;
    this._tasks = {};

    // Update header UI
    const coverMini = $('proj-ws-cover-mini');
    if (coverMini) {
      if (info.coverUrl) coverMini.innerHTML = `<img src="${escHtml(info.coverUrl)}" alt="">`;
      else coverMini.textContent = this._projectEmoji(info.name);
    }
    const wsName = $('proj-ws-name'); if (wsName) wsName.textContent = info.name || 'Project';
    const wsSub = $('proj-ws-sub'); if (wsSub) wsSub.textContent = `${info.visibility === 'private' ? '<i data-lucide="lock" class="lucide" width="12" height="12"></i> Private' : '<i data-lucide="globe" class="lucide" width="12" height="12"></i> Public'} · Created ${timeAgo(info.createdAt||Date.now())}`;

    // Reset tabs to chat
    $$('.proj-ws-tab').forEach(t => t.classList.remove('active'));
    $('proj-ws-tab-chat')?.classList.add('active');
    $$('.proj-ws-panel').forEach(p => p.classList.remove('active'));
    $('proj-ws-panel-chat')?.classList.add('active');

    // Show menu options based on ownership
    const isOwner = info.ownerId === state.currentUser?.uid;
    $('proj-menu-leave').style.display = isOwner ? 'none' : 'flex';
    $('proj-menu-delete').style.display = isOwner ? 'flex' : 'none';
    $('proj-menu-advertise').style.display = isOwner ? 'flex' : 'none';
    $('proj-menu-project-name').textContent = info.name || 'Project';

    // Reset requests badge
    $('proj-ws-requests-badge').style.display = 'none';
    ProjectVoiceCallSystem.setProject(pid, info);

    ScreenManager.show('project-workspace-screen');
    lucideCreate();


    // Attach listeners
    this._attachListeners(pid);
  },

  _attachListeners(pid) {
    // Members listener
    this._unsubMembers = onValue(ref(db, `projects/${pid}/members`), (snap) => {
      this.currentMembers = snap.exists() ? snap.val() : {};
      this._renderAvatarStack();
      this._renderMembersPanel();
      ProjectVoiceCallSystem.updateMembers(this.currentMembers, this.currentProjectData);
    });

    // Messages listener (chat)
    const msgsRef = ref(db, `projects/${pid}/messages`);
    const skel = $('proj-chat-skel');
    const msgsWrap = $('proj-chat-msgs');
    this._unsubMessages = onValue(msgsRef, (snap) => {
      if (skel) skel.style.display = 'none';
      if (msgsWrap) msgsWrap.style.display = 'block';
      const msgs = snap.exists() ? snap.val() : {};
      const sorted = Object.entries(msgs).sort((a,b) => (a[1].timestamp||0) - (b[1].timestamp||0));
      for (const [mid, msg] of sorted) {
        if (!this._renderedMsgIds.has(mid)) {
          const el = this._buildChatMessage(mid, msg);
          if (el && msgsWrap) msgsWrap.appendChild(el);
          this._renderedMsgIds.add(mid);
        }
      }
      // Scroll to bottom
      if (msgsWrap) msgsWrap.scrollTop = msgsWrap.scrollHeight;
    });

    // Tasks listener (kanban)
    this._unsubTasks = onValue(ref(db, `projects/${pid}/tasks`), (snap) => {
      this._tasks = snap.exists() ? snap.val() : {};
      this._renderKanban();
    });

    // Requests listener (owner only)
    if (this.currentProjectData?.ownerId === state.currentUser?.uid) {
      this._unsubRequests = onValue(ref(db, `projects/${pid}/requests`), (snap) => {
        const requests = snap.exists() ? snap.val() : {};
        const pending = Object.entries(requests).filter(([,r]) => r.status === 'pending');
        const badge = $('proj-ws-requests-badge');
        if (badge) {
          if (pending.length > 0) { badge.textContent = pending.length; badge.style.display = 'inline'; }
          else badge.style.display = 'none';
        }
        this._renderRequestsPanel(requests);
      });
    }

    this._watchProjectWorkApplicants();

    // Typing listener
    this._unsubTyping = onValue(ref(db, `projects/${pid}/typing`), (snap) => {
      const typing = snap.exists() ? snap.val() : {};
      const uid = state.currentUser?.uid;
      const others = Object.entries(typing)
        .filter(([tid, data]) => tid !== uid && data.active && (Date.now() - (data.ts||0)) < 4000)
        .map(([,data]) => data.username || 'Someone');
      const bar = $('proj-typing-bar');
      if (bar) bar.textContent = others.length > 0 ? `${others.join(', ')} ${others.length===1?'is':'are'} typing...` : '';
    });
  },

  _leaveWorkspace() {
    const leavingProjectId = this.currentProjectId;
    if (this._unsubMessages) { this._unsubMessages(); this._unsubMessages = null; }
    if (this._unsubTasks) { this._unsubTasks(); this._unsubTasks = null; }
    if (this._unsubMembers) { this._unsubMembers(); this._unsubMembers = null; }
    if (this._unsubRequests) { this._unsubRequests(); this._unsubRequests = null; }
    if (this._unsubWorkAds) { this._unsubWorkAds(); this._unsubWorkAds = null; }
    if (this._unsubTyping) { this._unsubTyping(); this._unsubTyping = null; }
    clearTimeout(this._typingTimeout);
    this.currentProjectId = null;
    this.currentProjectData = null;
    this.currentMembers = {};
    this._renderedMsgIds = new Set();
    this._tasks = {};
    // Clear chat messages
    const msgsWrap = $('proj-chat-msgs'); if (msgsWrap) msgsWrap.innerHTML = '';
    const skel = $('proj-chat-skel'); if (skel) skel.style.display = 'block';
    const msgsWrap2 = $('proj-chat-msgs'); if (msgsWrap2) msgsWrap2.style.display = 'none';
    if (leavingProjectId) ProjectVoiceCallSystem.detachProject();
  },

  // ──────────────────────────────────────────────────────────────────
  //  CHAT
  // ──────────────────────────────────────────────────────────────────
  _buildChatMessage(mid, msg) {
    const uid = state.currentUser?.uid;
    const isSent = msg.senderId === uid;
    const ts = msg.timestamp || 0;

    // Date divider
    const dateStr = formatDate(ts);
    let dateDivider = null;
    if (dateStr !== this._lastMsgDate) {
      this._lastMsgDate = dateStr;
      dateDivider = document.createElement('div');
      dateDivider.className = 'proj-date-divider';
      dateDivider.textContent = dateStr;
    }

    const wrap = document.createElement('div');
    if (dateDivider) wrap.appendChild(dateDivider);

    const row = document.createElement('div');
    row.className = `proj-msg-row${isSent ? ' sent' : ''}`;
    row.id = `proj-msg-${mid}`;

    const pfpUrl = msg.senderPfp || generateAvatarUrl(msg.senderId || 'x');
    const avatarHtml = `<div class="proj-msg-avatar" data-uid="${escHtml(msg.senderId||'')}"><img src="${escHtml(pfpUrl)}" alt="" loading="lazy" onerror="this.style.display='none';this.parentElement.textContent='${escHtml(initials(msg.senderUsername||'?'))}';"></div>`;

    let contentHtml = '';
    if (msg.type === 'image' && (msg.dataUrl || msg.url)) {
      const src = msg.dataUrl || msg.url;
      contentHtml = `<img class="proj-msg-image" src="${escHtml(src)}" alt="image" loading="lazy" onclick="window.open('${escHtml(src)}','_blank')">`;
    } else {
      contentHtml = `<div class="proj-msg-bubble">${linkify(msg.text || '')}</div>`;
    }

    row.innerHTML = `
      ${!isSent ? avatarHtml : ''}
      <div class="proj-msg-content">
        ${!isSent ? `<div class="proj-msg-sender" data-uid="${escHtml(msg.senderId||'')}">${escHtml(msg.senderUsername||'Unknown')}</div>` : ''}
        ${contentHtml}
        <div class="proj-msg-time">${formatTime(ts)}</div>
      </div>
      ${isSent ? avatarHtml : ''}
    `;

    // Click avatar/name to view profile
    row.querySelectorAll('[data-uid]').forEach(el => {
      el.style.cursor = 'pointer';
      el.addEventListener('click', () => {
        const clickUid = el.dataset.uid; if (!clickUid) return;
        const member = this.currentMembers[clickUid];
        const username = member?.username || msg.senderUsername || '';
        openUserProfileSheet(clickUid, username, 'Explorer', 'Beginner', 0, member?.pfpUrl||'', '', null);
      });
    });

    wrap.appendChild(row);
    return wrap;
  },

  async _sendMessage() {
    const textarea = $('proj-chat-textarea'); if (!textarea) return;
    const text = textarea.value.trim(); if (!text || !this.currentProjectId || !state.currentUser) return;
    textarea.value = ''; textarea.style.height = 'auto';
    $('proj-chat-send-btn').disabled = true;
    try {
      await push(ref(db, `projects/${this.currentProjectId}/messages`), {
        senderId: state.currentUser.uid,
        senderUsername: state.username || 'Unknown',
        senderPfp: state.pfpUrl || null,
        type: 'text', text,
        timestamp: serverTimestamp()
      });
    } catch(e) { Toast.error('Message failed'); textarea.value = text; }
  },

  async _sendImageMessage(dataUrl) {
    if (!this.currentProjectId || !state.currentUser) return;
    await push(ref(db, `projects/${this.currentProjectId}/messages`), {
      senderId: state.currentUser.uid,
      senderUsername: state.username || 'Unknown',
      senderPfp: state.pfpUrl || null,
      type: 'image', dataUrl,
      timestamp: serverTimestamp()
    });
  },

  _sendTypingSignal() {
    if (!this.currentProjectId || !state.currentUser) return;
    const uid = state.currentUser.uid;
    set(ref(db, `projects/${this.currentProjectId}/typing/${uid}`), {
      active: true, username: state.username || 'Someone', ts: Date.now()
    }).catch(()=>{});
    clearTimeout(this._typingTimeout);
    this._typingTimeout = setTimeout(() => {
      set(ref(db, `projects/${this.currentProjectId}/typing/${uid}`), { active: false }).catch(()=>{});
    }, CONFIG.TYPING_TIMEOUT);
  },

  // ──────────────────────────────────────────────────────────────────
  //  KANBAN BOARD
  // ──────────────────────────────────────────────────────────────────
  _renderKanban() {
    const cols = { todo: 'proj-tasks-todo', doing: 'proj-tasks-doing', done: 'proj-tasks-done' };
    const counts = { todo: 0, doing: 0, done: 0 };
    Object.values(cols).forEach(id => { const el = $(id); if (el) el.innerHTML = ''; });

    const sortedTasks = Object.entries(this._tasks).sort((a,b) => (a[1].createdAt||0) - (b[1].createdAt||0));
    for (const [tid, task] of sortedTasks) {
      const col = task.column || 'todo';
      if (!counts.hasOwnProperty(col)) continue;
      counts[col]++;
      const container = $(cols[col]); if (!container) continue;
      container.appendChild(this._buildTaskCard(tid, task));
    }

    // Set counts and empty states
    Object.entries(counts).forEach(([col, count]) => {
      const countEl = $(`proj-col-${col}-count`); if (countEl) countEl.textContent = count;
      const container = $(cols[col]);
      if (container && count === 0) {
        const empty = document.createElement('div');
        empty.className = 'proj-task-empty';
        empty.textContent = col === 'todo' ? 'No tasks yet' : col === 'doing' ? 'Nothing in progress' : 'No completed tasks';
        container.appendChild(empty);
      }
    });
  },

  _buildTaskCard(tid, task) {
    const card = document.createElement('div');
    card.className = `proj-task-card${task.column==='done'?' done-glow':''}`;
    card.draggable = true;
    card.dataset.tid = tid;

    const col = task.column || 'todo';
    const canMoveLeft = col !== 'todo';
    const canMoveRight = col !== 'done';
    const colOrder = ['todo','doing','done'];
    const colIdx = colOrder.indexOf(col);

    const assigneeHtml = task.assigneeUid ? `
      <div class="proj-task-assignee">
        <div class="proj-task-assignee-avatar">${escHtml(initials(task.assigneeUsername||'?'))}</div>
        <span class="proj-task-assignee-name">${escHtml(task.assigneeUsername||'Unknown')}</span>
      </div>` : `<span style="font-size:10px;color:var(--muted);font-family:var(--font-mono);">Unassigned</span>`;

    card.innerHTML = `
      <div class="proj-task-title">${escHtml(task.title||'Untitled Task')}</div>
      ${task.description ? `<div class="proj-task-desc">${escHtml(task.description)}</div>` : ''}
      <div class="proj-task-footer">
        ${assigneeHtml}
        <div class="proj-task-move-btns">
          ${canMoveLeft ? `<button class="proj-task-move-btn" data-dir="left" data-tid="${tid}" title="Move left">◀</button>` : ''}
          ${canMoveRight ? `<button class="proj-task-move-btn" data-dir="right" data-tid="${tid}" title="Move right">▶</button>` : ''}
          <button class="proj-task-move-btn" data-action="edit" data-tid="${tid}" title="Edit task" style="font-size:11px;"><i data-lucide="pencil" class="lucide" width="16" height="16"></i></button>
        </div>
      </div>
    `;

    // Move buttons
    card.querySelectorAll('.proj-task-move-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const dir = btn.dataset.dir;
        const action = btn.dataset.action;
        const t = btn.dataset.tid;
        if (action === 'edit') { this._openTaskModal(t, col); return; }
        const newIdx = dir === 'left' ? colIdx - 1 : colIdx + 1;
        if (newIdx >= 0 && newIdx < 3) this._moveTask(t, colOrder[newIdx]);
      });
    });

    // Drag events
    card.addEventListener('dragstart', (e) => {
      this._dragTaskId = tid;
      this._dragFromCol = col;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      this._dragTaskId = null; this._dragFromCol = null;
    });

    return card;
  },

  _initDragDrop() {
    ['proj-tasks-todo','proj-tasks-doing','proj-tasks-done'].forEach(id => {
      const container = $(id); if (!container) return;
      const col = container.dataset.col;
      container.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; container.classList.add('drag-over'); });
      container.addEventListener('dragleave', () => container.classList.remove('drag-over'));
      container.addEventListener('drop', (e) => {
        e.preventDefault(); container.classList.remove('drag-over');
        if (this._dragTaskId && col && col !== this._dragFromCol) {
          this._moveTask(this._dragTaskId, col);
        }
      });
    });
  },

  async _moveTask(tid, newCol) {
    if (!this.currentProjectId) return;
    const task = this._tasks[tid]; if (!task) return;
    const oldCol = task.column || 'todo';
    if (oldCol === newCol) return;

    try {
      const updates = { column: newCol };
      if (newCol === 'done' && oldCol !== 'done') {
        updates.completedAt = Date.now();
        // Award points if assignee
        if (task.assigneeUid) {
          await update(ref(db, `users/${task.assigneeUid}`), { points: increment(5) }).catch(()=>{});
          await NotifSystem.push(task.assigneeUid, 'task_completed', `Task "${task.title}" was completed! +5 pts`);
          this._showPtsFloat('+5 pts');
        }
      } else if (newCol !== 'done' && oldCol === 'done') {
        updates.completedAt = null;
      }
      await update(ref(db, `projects/${this.currentProjectId}/tasks/${tid}`), updates);
    } catch(e) { Toast.error('Could not move task'); }
  },

  _showPtsFloat(text) {
    const board = $('proj-ws-panel-board'); if (!board) return;
    const rect = board.getBoundingClientRect();
    const el = document.createElement('div');
    el.className = 'proj-pts-float';
    el.textContent = text;
    el.style.left = (rect.left + rect.width/2 - 30) + 'px';
    el.style.top = (rect.top + 60) + 'px';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1600);
  },

  // ──────────────────────────────────────────────────────────────────
  //  TASK MODAL
  // ──────────────────────────────────────────────────────────────────
  _openTaskModal(tid, col) {
    const titleInput = $('proj-task-title-input');
    const descInput = $('proj-task-desc-input');
    const colInput = $('proj-task-col-value');
    const editIdInput = $('proj-task-edit-id');
    const titleEl = $('proj-task-modal-title');

    if (tid) {
      // Edit existing
      const task = this._tasks[tid]; if (!task) return;
      if (titleInput) titleInput.value = task.title || '';
      if (descInput) descInput.value = task.description || '';
      if (colInput) colInput.value = task.column || col || 'todo';
      if (editIdInput) editIdInput.value = tid;
      if (titleEl) titleEl.textContent = 'Edit Task';
    } else {
      // New task
      if (titleInput) titleInput.value = '';
      if (descInput) descInput.value = '';
      if (colInput) colInput.value = col || 'todo';
      if (editIdInput) editIdInput.value = '';
      if (titleEl) titleEl.textContent = 'Add Task';
    }

    // Populate assignee select
    const select = $('proj-task-assignee-select');
    if (select) {
      select.innerHTML = '<option value="">— Unassigned —</option>';
      Object.entries(this.currentMembers).forEach(([uid, member]) => {
        const opt = document.createElement('option');
        opt.value = uid;
        opt.textContent = `@${member.username || 'Unknown'} (${member.role || 'Member'})`;
        if (tid && this._tasks[tid]?.assigneeUid === uid) opt.selected = true;
        select.appendChild(opt);
      });
    }

    this._openModal('proj-task-modal-overlay');
  },

  async _submitTask() {
    const title = $('proj-task-title-input')?.value.trim();
    if (!title || !this.currentProjectId || !state.currentUser) {
      Toast.error('Please enter a task title'); return;
    }
    const desc = $('proj-task-desc-input')?.value.trim() || '';
    const col = $('proj-task-col-value')?.value || 'todo';
    const tid = $('proj-task-edit-id')?.value || '';
    const assigneeSelect = $('proj-task-assignee-select');
    const assigneeUid = assigneeSelect?.value || '';
    const assigneeUsername = assigneeUid && this.currentMembers[assigneeUid] ? this.currentMembers[assigneeUid].username : '';

    const btn = $('proj-task-submit-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }

    try {
      if (tid) {
        // Update existing
        await update(ref(db, `projects/${this.currentProjectId}/tasks/${tid}`), {
          title, description: desc, assigneeUid: assigneeUid || null,
          assigneeUsername: assigneeUsername || null
        });
      } else {
        // Create new
        const taskData = {
          title, description: desc, column: col,
          assigneeUid: assigneeUid || null,
          assigneeUsername: assigneeUsername || null,
          createdBy: state.currentUser.uid,
          createdByUsername: state.username || 'Unknown',
          createdAt: Date.now()
        };
        const newTaskRef = await push(ref(db, `projects/${this.currentProjectId}/tasks`), taskData);
        // Notify assignee if set
        if (assigneeUid && assigneeUid !== state.currentUser.uid) {
          await NotifSystem.push(assigneeUid, 'task_assigned', `You were assigned task "${title}" in "${this.currentProjectData?.name||'a project'}"`);
        }
      }
      this._closeModal('proj-task-modal-overlay');
    } catch(e) { Toast.error(e.message || 'Could not save task'); }
    finally { if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="check-circle" class="lucide" width="16" height="16"></i> Save Task'; } }
  },

  // ──────────────────────────────────────────────────────────────────
  //  MEMBERS PANEL
  // ──────────────────────────────────────────────────────────────────
  _renderAvatarStack() {
    const stack = $('proj-ws-avatar-stack'); if (!stack) return;
    const entries = Object.entries(this.currentMembers).slice(0, 4);
    const total = Object.keys(this.currentMembers).length;
    stack.innerHTML = '';
    entries.forEach(([uid, m]) => {
      const el = document.createElement('div');
      el.className = 'proj-ws-avatar';
      const pfp = m.pfpUrl || generateAvatarUrl(uid);
      el.innerHTML = `<img src="${escHtml(pfp)}" alt="" onerror="this.style.display='none';this.parentElement.textContent='${escHtml(initials(m.username||'?'))}'" loading="lazy">`;
      stack.insertBefore(el, stack.firstChild);
    });
    if (total > 4) {
      const more = document.createElement('div');
      more.className = 'proj-ws-more-count';
      more.textContent = `+${total - 4}`;
      stack.insertBefore(more, stack.firstChild);
    }
    const sub = $('proj-ws-sub');
    if (sub) sub.textContent = `${this.currentProjectData?.visibility === 'private' ? '<i data-lucide="lock" class="lucide" width="12" height="12"></i> Private' : '<i data-lucide="globe" class="lucide" width="12" height="12"></i> Public'} · ${total} member${total!==1?'s':''}`;
  },

  _renderMembersPanel() {
    if (!$('proj-ws-panel-members')?.classList.contains('active')) return;
    const list = $('proj-members-list'); if (!list) return;
    list.innerHTML = '';
    const isOwner = this.currentProjectData?.ownerId === state.currentUser?.uid;
    const uid = state.currentUser?.uid;

    Object.entries(this.currentMembers).sort((a,b) => {
      if (a[1].role === 'Owner') return -1;
      if (b[1].role === 'Owner') return 1;
      return (a[1].joinedAt||0) - (b[1].joinedAt||0);
    }).forEach(([mUid, member]) => {
      const row = document.createElement('div');
      row.className = 'proj-member-row';
      const pfp = member.pfpUrl || generateAvatarUrl(mUid);
      const isOwnerMember = member.role === 'Owner';
      row.innerHTML = `
        <div class="proj-member-avatar"><img src="${escHtml(pfp)}" alt="" onerror="this.style.display='none';this.parentElement.textContent='${escHtml(initials(member.username||'?'))}'" loading="lazy"></div>
        <div class="proj-member-info">
          <div class="proj-member-name">@${escHtml(member.username||'Unknown')}</div>
          <span class="proj-member-role${isOwnerMember?' owner':''}">${escHtml(member.role||'Member')}</span>
        </div>
        <div class="proj-member-actions">
          <button class="proj-member-action-btn" data-uid="${escHtml(mUid)}" data-action="dm" title="Send DM" style="font-size:13px;"><i data-lucide="message-circle" class="lucide" width="16" height="16"></i></button>
          ${isOwner && mUid !== uid ? `<button class="proj-member-action-btn danger" data-uid="${escHtml(mUid)}" data-action="kick" title="Remove member"><i data-lucide="x" class="lucide" width="16" height="16"></i></button>` : ''}
        </div>
      `;
      row.addEventListener('click', (e) => {
        if (e.target.closest('.proj-member-action-btn')) return;
        openUserProfileSheet(mUid, member.username||'', 'Explorer', 'Beginner', 0, member.pfpUrl||'', '', null);
      });
      row.querySelectorAll('.proj-member-action-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const targetUid = btn.dataset.uid;
          if (btn.dataset.action === 'dm') {
            const m = this.currentMembers[targetUid];
            openChat(targetUid, m?.username||'Unknown', 'Explorer', 'Beginner', 0);
          } else if (btn.dataset.action === 'kick') {
            if (!confirm(`Remove @${member.username||'this member'} from the project?`)) return;
            try {
              await remove(ref(db, `projects/${this.currentProjectId}/members/${targetUid}`));
              Toast.success('Member removed');
            } catch(err) { Toast.error('Could not remove member'); }
          }
        });
      });
      list.appendChild(row);
    });
  },

  _renderRequestsPanel(requests) {
    const section = $('proj-requests-section');
    const list = $('proj-requests-list');
    if (!section || !list) return;

    const isOwner = this.currentProjectData?.ownerId === state.currentUser?.uid;
    if (!isOwner) { section.style.display = 'none'; return; }

    const pending = Object.entries(requests).filter(([,r]) => r.status === 'pending');
    if (pending.length === 0) { section.style.display = 'none'; return; }
    section.style.display = 'block';
    list.innerHTML = '';

    pending.forEach(([rid, req]) => {
      const row = document.createElement('div');
      row.className = 'proj-request-row';
      const pfp = req.applicantPfp || generateAvatarUrl(req.applicantUid||'x');
      row.innerHTML = `
        <div class="proj-request-avatar"><img src="${escHtml(pfp)}" alt="" onerror="this.style.display='none';this.parentElement.textContent='${escHtml(initials(req.applicantUsername||'?'))}'" loading="lazy"></div>
        <div class="proj-request-body">
          <div class="proj-request-name">@${escHtml(req.applicantUsername||'Unknown')}</div>
          <div class="proj-request-role-text">Applying for: ${escHtml(req.desiredRole||'Member')}</div>
          ${req.message ? `<div class="proj-request-msg">${escHtml(req.message)}</div>` : ''}
          <div class="proj-request-btns">
            <button class="proj-request-accept-btn" data-rid="${escHtml(rid)}"><i data-lucide="check" class="lucide" width="16" height="16"></i> Accept</button>
            <button class="proj-request-decline-btn" data-rid="${escHtml(rid)}"><i data-lucide="x" class="lucide" width="16" height="16"></i> Decline</button>
            <button class="proj-request-dm-btn" data-rid="${escHtml(rid)}" data-uid="${escHtml(req.applicantUid||'')}"><i data-lucide="message-circle" class="lucide" width="16" height="16"></i> DM</button>
          </div>
          <div style="font-size:9px;color:var(--muted);font-family:var(--font-mono);margin-top:4px;">${timeAgo(req.createdAt)}</div>
        </div>
      `;
      row.querySelector('.proj-request-accept-btn').addEventListener('click', () => this._acceptRequest(rid, req));
      row.querySelector('.proj-request-decline-btn').addEventListener('click', () => this._declineRequest(rid, req));
      row.querySelector('.proj-request-dm-btn').addEventListener('click', () => {
        openChat(req.applicantUid, req.applicantUsername||'Unknown', 'Explorer', 'Beginner', 0);
      });
      list.appendChild(row);
    });
  },

  async _acceptRequest(rid, req) {
    if (!this.currentProjectId) return;
    try {
      const uid = req.applicantUid; if (!uid) return;
      // Add to members
      await set(ref(db, `projects/${this.currentProjectId}/members/${uid}`), {
        role: req.desiredRole || 'Member',
        joinedAt: Date.now(),
        username: req.applicantUsername || 'Unknown',
        pfpUrl: req.applicantPfp || null
      });
      // Remove request
      await remove(ref(db, `projects/${this.currentProjectId}/requests/${rid}`));
      // Notify
      await NotifSystem.push(uid, 'project_request_accepted', `Your request to join "${this.currentProjectData?.name||'a project'}" was accepted!`);
      Toast.success(`@${req.applicantUsername||'Member'} accepted!`);
    } catch(e) { Toast.error('Could not accept request'); }
  },

  async _declineRequest(rid, req) {
    if (!this.currentProjectId) return;
    try {
      await remove(ref(db, `projects/${this.currentProjectId}/requests/${rid}`));
      await NotifSystem.push(req.applicantUid, 'project_request_declined', `Your request to join "${this.currentProjectData?.name||'a project'}" was not accepted this time.`).catch(()=>{});
      Toast.info('Request declined');
    } catch(e) { Toast.error('Could not decline request'); }
  },

  // ──────────────────────────────────────────────────────────────────
  //  REQUEST TO JOIN FLOW
  // ──────────────────────────────────────────────────────────────────
  _openRequestModal(pid, info) {
    $('proj-request-project-id').value = pid;
    $('proj-request-project-name').textContent = `Requesting to join: "${info.name||'Project'}"`;
    // Populate role select
    const select = $('proj-request-role-select');
    select.innerHTML = '<option value="">— Select a role —</option>';
    (info.rolesNeeded || []).forEach(r => {
      const opt = document.createElement('option');
      opt.value = r.skill; opt.textContent = r.skill + (r.qty > 1 ? ` (need ${r.qty})` : '');
      select.appendChild(opt);
    });
    $('proj-request-msg-input').value = '';
    this._openModal('proj-request-modal-overlay');
  },

  async _submitRequest() {
    const pid = $('proj-request-project-id')?.value;
    const role = $('proj-request-role-select')?.value;
    const msg = $('proj-request-msg-input')?.value.trim() || '';
    if (!pid || !role || !state.currentUser) { Toast.error('Please select a role'); return; }

    const btn = $('proj-request-submit-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Sending...'; }
    try {
      const uid = state.currentUser.uid;
      await push(ref(db, `projects/${pid}/requests`), {
        applicantUid: uid,
        applicantUsername: state.username || 'Unknown',
        applicantPfp: state.pfpUrl || null,
        desiredRole: role, message: msg,
        status: 'pending', createdAt: Date.now()
      });
      // Notify owner
      const infoSnap = await get(ref(db, `projects/${pid}/info`)).catch(()=>null);
      const ownerId = infoSnap?.exists() ? infoSnap.val().ownerId : null;
      if (ownerId && ownerId !== uid) {
        await NotifSystem.push(ownerId, 'project_request', `@${state.username||'Someone'} requested to join your project "${infoSnap.val().name||''}" as ${role}`);
      }
      this._closeModal('proj-request-modal-overlay');
      Toast.success('Request sent! The owner will review it.');
    } catch(e) { Toast.error(e.message || 'Could not send request'); }
    finally { if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="mail" class="lucide" width="16" height="16"></i> Send Request'; } }
  },

  // ──────────────────────────────────────────────────────────────────
  //  SETTINGS MODAL
  // ──────────────────────────────────────────────────────────────────
  _openSettingsModal() {
    const info = this.currentProjectData; if (!info) return;
    $('proj-settings-name-input').value = info.name || '';
    $('proj-settings-desc-input').value = info.description || '';
    const seekSection = $('proj-settings-seek-section');
    const seekCb = $('proj-settings-seek-checkbox');
    if (info.visibility === 'private') {
      seekSection.style.display = 'block';
      seekCb.checked = !!info.seekingMembers;
    } else { seekSection.style.display = 'none'; }
    this._openModal('proj-settings-modal-overlay');
  },

  async _saveSettings() {
    const name = $('proj-settings-name-input')?.value.trim();
    if (!name || !this.currentProjectId) { Toast.error('Name required'); return; }
    const desc = $('proj-settings-desc-input')?.value.trim() || '';
    const seekingMembers = $('proj-settings-seek-checkbox')?.checked || false;

    const btn = $('proj-settings-save-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
    try {
      const updates = { name, description: desc };
      if (this.currentProjectData?.visibility === 'private') updates.seekingMembers = seekingMembers;
      await update(ref(db, `projects/${this.currentProjectId}/info`), updates);
      // FIX: Sync seekingMembers to projectIndex so the Seeking tab reflects
      // the change immediately. Without this the index stays stale after save.
      if (this.currentProjectData?.visibility === 'private') {
        await update(ref(db, `projectIndex/${this.currentProjectId}`), { seekingMembers }).catch(() => {});
      }
      this.currentProjectData = { ...this.currentProjectData, ...updates };
      $('proj-ws-name').textContent = name;
      this._closeModal('proj-settings-modal-overlay');
      Toast.success('Settings saved');
    } catch(e) { Toast.error(e.message || 'Could not save settings'); }
    finally { if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="save" class="lucide" width="16" height="16"></i> Save Settings'; } }
  },

  // ──────────────────────────────────────────────────────────────────
  //  INVITE LINK
  // ──────────────────────────────────────────────────────────────────
  _copyInviteLink() {
    if (!this.currentProjectId) return;
    const link = `${window.location.origin}${window.location.pathname}?project=${this.currentProjectId}`;
    try {
      navigator.clipboard.writeText(link);
      Toast.success('Invite link copied!');
    } catch(e) {
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = link; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
      Toast.success('Invite link copied!');
    }
  },

  // ──────────────────────────────────────────────────────────────────
  //  WORKSPACE MENU
  // ──────────────────────────────────────────────────────────────────
  _openMenu() { this._openModal('proj-menu-overlay'); },

  // ──────────────────────────────────────────────────────────────────
  //  MODAL HELPERS
  // ──────────────────────────────────────────────────────────────────
  _openModal(id) {
    const overlay = $(id); if (!overlay) return;
    overlay.classList.add('open');
  },
  _closeModal(id) {
    const overlay = $(id); if (!overlay) return;
    overlay.classList.remove('open');
  },

}; // end ProjectSystem

// ── Initialize ProjectSystem after DOM is ready ──
SketchBoardSystem.init();
ProjectVoiceCallSystem.init();
ProjectSystem.init();

// ── Hook into NotifSystem typeConfig for project types ──
(function patchNotifTypes() {
  // We patch the render function to handle project notification types.
  // The existing NotifSystem._render will fall back to the default emoji for unknown types.
  // Since typeConfig is inside a closure, we extend via the data path.
  // The NotifSystem uses typeConfig inside _render; new types will show default mail icon
  // which is fine. The push() already supports arbitrary types.
})();


// ── Export to window ──
Object.assign(window, {
  ProjectVoiceCallSystem, SketchBoardSystem, ProjectSystem
});
