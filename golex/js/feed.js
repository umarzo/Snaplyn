const { state, $, $$, escHtml, linkify, timeAgo, formatTime, badgeHTML,
  generateAvatarUrl, debounce, compressImage, fileToBase64, audioToBase64,
  downloadBase64, formatFileSize, formatRecDuration, fileIcon,
  auth, db, ref, get, set, onValue, onChildAdded, push, serverTimestamp,
  update, off, remove, limitToLast, query, orderByChild, equalTo,
  CONFIG, EPHEMERAL_CONFIG, PREDEFINED_SKILLS, cleanupTimestamps,
  Toast, ScreenManager, StoriesSystem, FollowSystem, ConfirmModal,
  ReportModal, openUserProfileSheet, cacheUser, getUserCached,
  IDB, loadSavedPosts, GOLEX_PRO } = window;

// IndexedDB is like a tiny database stored on the user's device.
// We use it to save posts locally so they load instantly and work offline.

const IDB = {
  db: null,
  async open() {
    if (this.db) return this.db;
    return new Promise((res, rej) => {
      const req = indexedDB.open('golex_saves', 1);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('saved_posts')) {
          db.createObjectStore('saved_posts', { keyPath: 'postId' });
        }
      };
      req.onsuccess = e => { this.db = e.target.result; res(this.db); };
      req.onerror = () => rej(req.error);
    });
  },
  async save(post) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction('saved_posts', 'readwrite');
      tx.objectStore('saved_posts').put(post);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  },
  async getAll() {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction('saved_posts', 'readonly');
      const req = tx.objectStore('saved_posts').getAll();
      req.onsuccess = () => res(req.result || []);
      req.onerror = () => rej(req.error);
    });
  },
  async delete(postId) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction('saved_posts', 'readwrite');
      tx.objectStore('saved_posts').delete(postId);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  },
  async exists(postId) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction('saved_posts', 'readonly');
      const req = tx.objectStore('saved_posts').get(postId);
      req.onsuccess = () => res(!!req.result);
      req.onerror = () => rej(req.error);
    });
  },
  // NEW: Wipe ALL locally saved posts — call this on logout and account deletion
  async clearAll() {
    try {
      const db = await this.open();
      return new Promise((res, rej) => {
        const tx = db.transaction('saved_posts', 'readwrite');
        tx.objectStore('saved_posts').clear();
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
    } catch (e) {
      // If IDB isn't available, silently continue
      return Promise.resolve();
    }
  }
};

/* ═══════════════════════════════════════════════════
   PLATFORM: CREATE POST
   ═══════════════════════════════════════════════════ */

// The list of possible placeholder ideas shown in the Create textarea
const CREATE_PLACEHOLDERS = [
  "Share a trick you learned today...",
  "Ask for feedback on your work...",
  "Post a skill tip for others...",
  "What are you building right now?",
  "Offer help in your area of expertise...",
  "Share a resource that helped you...",
];

// Show a different placeholder every 3 seconds
let _placeholderIdx = 0;
function rotatePlaceholder() {
  const ta = document.getElementById('create-textarea');
  if (!ta || document.activeElement === ta) return;
  ta.placeholder = CREATE_PLACEHOLDERS[_placeholderIdx % CREATE_PLACEHOLDERS.length];
  _placeholderIdx++;
}
setInterval(rotatePlaceholder, 3000);
rotatePlaceholder();

// Character counter
document.getElementById('create-textarea').addEventListener('input', function() {
  const len = this.value.length;
  const cc = document.getElementById('create-char-count');
  cc.textContent = `${len} / 500`;
  cc.className = 'create-char-count' + (len > 450 ? ' danger' : len > 350 ? ' warn' : '');
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 200) + 'px';
});

/* ═══════════════════════════════════════════════════
   ADVANCED CREATE SYSTEM — MODULAR CONTENT BUILDER
   ═══════════════════════════════════════════════════ */

// State for the advanced create system
const _createState = {
  mode: 'post',           // 'post' | 'story'
  contentType: 'text',    // active content type key
  imageData: null,        // primary image dataUrl
  imageData2: null,       // secondary image (audio+image combo)
  audioData: null,        // primary audio { dataUrl, name, duration }
  audioData2: null,       // secondary audio (audio+image combo)
  fileData: null,         // file { name, dataUrl, size, mimeType }
  linkUrl: '',            // link embed URL
  mediaRecorder: null,    // active MediaRecorder
  recInterval: null,      // recording interval
  recSeconds: 0,
  mediaRecorder2: null,
  recInterval2: null,
  recSeconds2: 0,
};

// Content type panels map
const CONTENT_TYPE_PANELS = {
  'text':        ['create-panel-text'],
  'text+image':  ['create-panel-text', 'create-panel-image'],
  'text+audio':  ['create-panel-text', 'create-panel-audio'],
  'text+file':   ['create-panel-text', 'create-panel-file'],
  'link':        ['create-panel-link'],
  'audio+image': ['create-panel-audio-image'],
};

function _showContentTypePanels(ctype) {
  const allPanels = ['create-panel-text','create-panel-image','create-panel-audio','create-panel-file','create-panel-link','create-panel-audio-image'];
  allPanels.forEach(pid => {
    const el = document.getElementById(pid);
    if (el) el.style.display = 'none';
  });
  const panels = CONTENT_TYPE_PANELS[ctype] || ['create-panel-text'];
  panels.forEach(pid => {
    const el = document.getElementById(pid);
    if (el) el.style.display = '';
  });
}

// Content type grid wiring
document.querySelectorAll('.content-type-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.content-type-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    _createState.contentType = btn.dataset.ctype;
    _showContentTypePanels(_createState.contentType);
    // Show/hide post fields based on type
    const postFields = document.getElementById('create-post-fields');
    if (postFields) postFields.style.display = (_createState.mode === 'story') ? 'none' : '';
  });
});

// ── Post vs Story toggle ──
let _createMode = 'post';
document.querySelectorAll('[data-create-type]').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('[data-create-type]').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    _createMode = tab.dataset.createType;
    _createState.mode = _createMode;
    const postFields = document.getElementById('create-post-fields');
    const createBtn = document.getElementById('create-post-btn');
    const previewBtn = document.getElementById('create-preview-btn');
    const contentBuilder = document.getElementById('create-content-builder');
    if (_createMode === 'story') {
      if (postFields) postFields.style.display = 'none';
      if (createBtn) createBtn.innerHTML = '<i data-lucide="sparkles" class="lucide" width="16" height="16"></i> Share as Story — 24h';
      if (previewBtn) previewBtn.style.display = 'none';
      // Simplify to text+image only for stories
      if (contentBuilder) contentBuilder.style.display = 'none';
      const ta = document.getElementById('create-textarea');
      if (ta) { ta.placeholder = "What's your story? (max 200 chars)"; ta.maxLength = 200; }
      const cc = document.getElementById('create-char-count');
      if (cc) cc.textContent = '0 / 200';
      // Show text panel directly
      document.getElementById('create-panel-text').style.display = '';
      // Show story image upload section
      const storyImgSection = document.getElementById('create-story-img-section');
      if (storyImgSection) storyImgSection.style.display = '';
    } else {
      if (postFields) postFields.style.display = '';
      if (createBtn) createBtn.innerHTML = '<i data-lucide="flame" class="lucide" width="16" height="16"></i> Post Now — Live for 24h';
      if (previewBtn) previewBtn.style.display = '';
      if (contentBuilder) contentBuilder.style.display = '';
      const ta = document.getElementById('create-textarea');
      if (ta) { ta.placeholder = 'Share a trick you learned today...'; ta.maxLength = 500; }
      const cc = document.getElementById('create-char-count');
      if (cc) cc.textContent = '0 / 500';
      _showContentTypePanels(_createState.contentType);
      // Hide story-specific image section
      const storyImgSection = document.getElementById('create-story-img-section');
      if (storyImgSection) storyImgSection.style.display = 'none';
    }
  });
});

// ── Image upload wiring (primary) ──
let _createImageData = null;
function _wireImageArea(areaId, inputId, previewId, clearId, stateKey) {
  const area = document.getElementById(areaId);
  const input = document.getElementById(inputId);
  const preview = document.getElementById(previewId);
  const clearBtn = document.getElementById(clearId);
  if (!area || !input) return;
  area.addEventListener('click', () => input.click());
  area.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') input.click(); });
  input.addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    Toast.info('Compressing image...');
    try {
      const result = await compressImage(f);
      _createState[stateKey] = result.dataUrl;
      if (stateKey === 'imageData') _createImageData = result.dataUrl;
      if (preview) { preview.src = result.dataUrl; preview.classList.add('visible'); }
      if (clearBtn) clearBtn.classList.add('visible');
      area.classList.add('has-image');
      Toast.success('Image ready ✓');
    } catch { Toast.error('Could not load image'); }
    e.target.value = '';
  });
  if (clearBtn) {
    clearBtn.addEventListener('click', e => {
      e.stopPropagation();
      _createState[stateKey] = null;
      if (stateKey === 'imageData') _createImageData = null;
      if (preview) preview.classList.remove('visible');
      clearBtn.classList.remove('visible');
      area.classList.remove('has-image');
    });
  }
}
_wireImageArea('create-image-area', 'create-file-input', 'create-img-preview', 'create-img-clear', 'imageData');
_wireImageArea('create-image-area-2', 'create-file-input-2', 'create-img-preview-2', 'create-img-clear-2', 'imageData2');

// Wire story image upload in create screen
(function() {
  const area = document.getElementById('create-story-image-area');
  const input = document.getElementById('create-story-file-input');
  const preview = document.getElementById('create-story-img-preview');
  const clearBtn = document.getElementById('create-story-img-clear');
  if (!area || !input) return;
  area.addEventListener('click', () => input.click());
  area.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') input.click(); });
  input.addEventListener('change', function() {
    const file = this.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(ev) {
      _createState.storyImageData = ev.target.result;
      if (preview) { preview.src = ev.target.result; preview.style.display = ''; }
      if (clearBtn) clearBtn.style.display = '';
      area.querySelector('span:first-child').style.display = 'none';
      area.querySelectorAll('span')[1].style.display = 'none';
    };
    reader.readAsDataURL(file);
  });
  if (clearBtn) {
    clearBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      _createState.storyImageData = null;
      input.value = '';
      if (preview) { preview.src = ''; preview.style.display = 'none'; }
      clearBtn.style.display = 'none';
      area.querySelectorAll('span').forEach(s => s.style.display = '');
    });
  }
})();

// ── Audio recording helper ──
function _readAsDataURL(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob);
  });
}

function _wireAudioRecorder(recordBtnId, recordIconId, recordLabelId, timerDivId, timerSpanId,
                             uploadLabelId, uploadInputId, previewWrapId,
                             mediaRecorderKey, recIntervalKey, recSecondsKey, audioDataKey) {
  const recordBtn = document.getElementById(recordBtnId);
  const uploadInput = document.getElementById(uploadInputId);
  const previewWrap = document.getElementById(previewWrapId);
  let chunks = [];

  function _updateRecordBtn(recording) {
    const icon = document.getElementById(recordIconId);
    const label = document.getElementById(recordLabelId);
    if (icon) icon.innerHTML = recording ? '<i data-lucide="square" class="lucide" width="16" height="16"></i>' : '<i data-lucide="mic" class="lucide" width="16" height="16"></i>';
    if (label) label.textContent = recording ? 'Stop Recording' : 'Hold to Record';
    if (recordBtn) recordBtn.classList.toggle('recording', recording);
  }

  function _startTimer() {
    _createState[recSecondsKey] = 0;
    const timerDiv = document.getElementById(timerDivId);
    if (timerDiv) timerDiv.style.display = 'flex';
    _createState[recIntervalKey] = setInterval(() => {
      _createState[recSecondsKey]++;
      const m = Math.floor(_createState[recSecondsKey] / 60);
      const s = _createState[recSecondsKey] % 60;
      const span = document.getElementById(timerSpanId);
      if (span) span.textContent = `${m}:${s.toString().padStart(2,'0')}`;
      if (_createState[recSecondsKey] >= 120) _stopRecording(); // max 2min
    }, 1000);
  }

  function _stopRecording() {
    if (_createState[mediaRecorderKey] && _createState[mediaRecorderKey].state === 'recording') {
      _createState[mediaRecorderKey].stop();
    }
    clearInterval(_createState[recIntervalKey]);
    const timerDiv = document.getElementById(timerDivId);
    if (timerDiv) timerDiv.style.display = 'none';
    _updateRecordBtn(false);
  }

  if (recordBtn) {
    recordBtn.addEventListener('click', async () => {
      if (_createState[mediaRecorderKey] && _createState[mediaRecorderKey].state === 'recording') {
        _stopRecording();
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        chunks = [];
        _createState[mediaRecorderKey] = new MediaRecorder(stream);
        _createState[mediaRecorderKey].ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
        _createState[mediaRecorderKey].onstop = async () => {
          stream.getTracks().forEach(t => t.stop());
          if (!chunks.length) return;
          const blob = new Blob(chunks, { type: 'audio/webm' });
          const dataUrl = await _readAsDataURL(blob);
          _createState[audioDataKey] = { dataUrl, name: 'recording.webm', duration: _createState[recSecondsKey] };
          _renderAudioPreview(previewWrap, dataUrl, () => { _createState[audioDataKey] = null; });
          Toast.success('Recording saved ✓');
        };
        _createState[mediaRecorderKey].start();
        _startTimer();
        _updateRecordBtn(true);
      } catch {
        Toast.error('Microphone access denied');
      }
    });
  }

  if (uploadInput) {
    uploadInput.addEventListener('change', async e => {
      const f = e.target.files[0]; if (!f) return;
      // ── PRO MEDIA: Pro gets 16MB audio in rooms ──
      if (f.size > (ProMedia.isPro() ? 16 : 8) * 1024 * 1024) { Toast.error(`Audio too large (max ${ProMedia.isPro() ? '16MB' : '8MB'})`); return; }
      const dataUrl = await _readAsDataURL(f);
      _createState[audioDataKey] = { dataUrl, name: f.name, duration: 0 };
      _renderAudioPreview(previewWrap, dataUrl, () => { _createState[audioDataKey] = null; });
      Toast.success('Audio uploaded ✓');
      e.target.value = '';
    });
  }
}

function _renderAudioPreview(wrap, dataUrl, onClear) {
  if (!wrap) return;
  wrap.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'create-audio-preview';
  div.innerHTML = `<audio controls preload="metadata" style="width:100%;height:36px;">${''}</audio>`;
  const audio = div.querySelector('audio');
  audio.src = dataUrl;
  const clearBtn = document.createElement('button');
  clearBtn.className = 'create-audio-clear'; clearBtn.type = 'button'; clearBtn.innerHTML = '<i data-lucide="x" class="lucide" width="12" height="12"></i> Remove';
  clearBtn.addEventListener('click', () => { wrap.innerHTML = ''; if (onClear) onClear(); });
  div.appendChild(clearBtn);
  wrap.appendChild(div);
}

_wireAudioRecorder(
  'create-record-btn','create-record-icon','create-record-label',
  'create-rec-timer','create-rec-seconds',
  null,'create-audio-input','create-audio-preview-wrap',
  'mediaRecorder','recInterval','recSeconds','audioData'
);
_wireAudioRecorder(
  'create-record-btn-2','create-record-icon-2','create-record-label-2',
  'create-rec-timer-2','create-rec-seconds-2',
  null,'create-audio-input-2','create-audio-preview-wrap-2',
  'mediaRecorder2','recInterval2','recSeconds2','audioData2'
);

// ── File upload ──
const _docInput = document.getElementById('create-doc-input');
if (_docInput) {
  _docInput.addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    // ── PRO MEDIA: Pro gets 20MB file in rooms ──
    if (f.size > (ProMedia.isPro() ? 20 : 10) * 1024 * 1024) { Toast.error(`File too large (max ${ProMedia.isPro() ? '20MB' : '10MB'})`); return; }
    const dataUrl = await _readAsDataURL(f);
    _createState.fileData = { name: f.name, dataUrl, size: f.size, mimeType: f.type };
    const wrap = document.getElementById('create-file-preview-wrap');
    if (wrap) {
      wrap.innerHTML = '';
      const chip = document.createElement('div'); chip.className = 'create-file-chip';
      chip.innerHTML = `
        <span class="create-file-chip-icon">${fileIcon(f.name)}</span>
        <span class="create-file-chip-name">${escHtml(f.name)}</span>
        <span class="create-file-chip-size">${(f.size/1024).toFixed(1)}KB</span>
        <button class="create-file-chip-remove" type="button" title="Remove"><i data-lucide="x" class="lucide" width="12" height="12"></i></button>`;
      chip.querySelector('.create-file-chip-remove').addEventListener('click', () => {
        _createState.fileData = null; wrap.innerHTML = '';
      });
      wrap.appendChild(chip);
    }
    Toast.success('File ready ✓');
    e.target.value = '';
  });
}

// ── Link input: live validation ──
const _linkInput = document.getElementById('create-link-url');
if (_linkInput) {
  _linkInput.addEventListener('input', debounce(function() {
    _createState.linkUrl = this.value.trim();
    const preview = document.getElementById('create-link-preview');
    if (!preview) return;
    if (_createState.linkUrl && _isValidUrl(_createState.linkUrl)) {
      let domain = '';
      try { domain = new URL(_createState.linkUrl).hostname; } catch {}
      preview.style.display = '';
      preview.innerHTML = `<div class="link-preview-inner">
        <div class="link-preview-title"><i data-lucide="link" class="lucide" width="12" height="12"></i> ${escHtml(domain)}</div>
        <div class="link-preview-url">${escHtml(_createState.linkUrl)}</div>
      </div>`;
    } else {
      preview.style.display = 'none';
    }
  }, 400));
}

function _isValidUrl(u) {
  try { const url = new URL(u); return url.protocol === 'https:' || url.protocol === 'http:'; } catch { return false; }
}

// ── Goal pill selection ──
let _createSelectedGoal = '';
document.getElementById('create-goals-grid').querySelectorAll('.create-goal-pill').forEach(pill => {
  pill.addEventListener('click', () => {
    document.getElementById('create-goals-grid').querySelectorAll('.create-goal-pill').forEach(p => p.classList.remove('selected'));
    pill.classList.add('selected');
    _createSelectedGoal = pill.dataset.goal;
  });
});

// ── Preview button ──
const _previewBtn = document.getElementById('create-preview-btn');
const _previewArea = document.getElementById('create-preview-area');
const _previewCard = document.getElementById('create-preview-card');
if (_previewBtn) {
  _previewBtn.addEventListener('click', () => {
    if (_previewArea.style.display === 'none' || !_previewArea.style.display) {
      _renderCreatePreview();
      _previewArea.style.display = '';
      _previewBtn.innerHTML = '<i data-lucide="x" class="lucide" width="16" height="16"></i> Close Preview';
    } else {
      _previewArea.style.display = 'none';
      _previewBtn.innerHTML = '<i data-lucide="eye" class="lucide" width="16" height="16"></i> Preview Post';
    }
  });
}

function _renderCreatePreview() {
  if (!_previewCard) return;
  const content = _buildPostContent();
  const now = Date.now();
  const fakePost = {
    userId: state.currentUser?.uid || '',
    username: state.username || 'You',
    skill: state.skill || '',
    pfpUrl: state.pfpUrl || '',
    content: content.text || '(no text)',
    imageUrl: content.imageUrl || '',
    audioData: content.audioData || null,
    fileData: content.fileData || null,
    linkUrl: content.linkUrl || '',
    linkCaption: content.linkCaption || '',
    contentType: _createState.contentType,
    tags: _createTags.slice(),
    goal: _createSelectedGoal,
    likesCount: 0,
    commentsCount: 0,
    createdAt: now,
    expiresAt: now + 24 * 60 * 60 * 1000,
  };
  _previewCard.innerHTML = '';
  const card = createPostCard(fakePost, 'preview-fake-id');
  if (card) {
    _previewCard.innerHTML = card.outerHTML || '';
    lucide.createIcons({ nodes: [_previewCard] });
    _previewCard.querySelector('.post-card')?.style?.setProperty('pointer-events','none');
  }
}

// ── Build post content object ──
function _buildPostContent() {
  const ctype = _createState.contentType;
  const text = (document.getElementById('create-textarea')?.value || '').trim();
  const imgCaption = (document.getElementById('create-img-caption')?.value || '').trim();
  const audioCaption = (document.getElementById('create-audio-caption')?.value || '').trim();
  const fileCaption = (document.getElementById('create-file-caption')?.value || '').trim();
  const aiCaption = (document.getElementById('create-ai-caption')?.value || '').trim();
  const linkCaption = (document.getElementById('create-link-caption')?.value || '').trim();

  const out = { contentType: ctype, text: '', imageUrl: '', audioData: null, fileData: null, linkUrl: '', linkCaption: '' };

  if (ctype === 'text') {
    out.text = text;
  } else if (ctype === 'text+image') {
    out.text = imgCaption || text;
    out.imageUrl = _createState.imageData || '';
  } else if (ctype === 'text+audio') {
    out.text = audioCaption || text;
    out.audioData = _createState.audioData;
  } else if (ctype === 'text+file') {
    out.text = fileCaption || text;
    out.fileData = _createState.fileData;
  } else if (ctype === 'link') {
    out.text = linkCaption || text;
    out.linkUrl = _createState.linkUrl;
    out.linkCaption = linkCaption;
  } else if (ctype === 'audio+image') {
    out.text = aiCaption || text;
    out.audioData = _createState.audioData2;
    out.imageUrl = _createState.imageData2 || '';
  }
  return out;
}

// Create tag manager
const _createTags = [];
const createTagManager = new TagManager('create-tag-input', 'create-tag-add', 'create-tags-wrap', _createTags);

// ── Post rate limit ──
const _postRateLimit = { count: 0, windowStart: 0, MAX: 5, WINDOW_MS: 60 * 60 * 1000 };
function checkPostRateLimit() {
  const now = Date.now();
  if (now - _postRateLimit.windowStart > _postRateLimit.WINDOW_MS) {
    _postRateLimit.count = 0; _postRateLimit.windowStart = now;
  }
  if (_postRateLimit.count >= _postRateLimit.MAX) {
    const waitMins = Math.ceil((_postRateLimit.WINDOW_MS - (now - _postRateLimit.windowStart)) / 60000);
    Toast.error(`Slow down — max 5 posts/hour. Try again in ${waitMins}m`);
    return false;
  }
  _postRateLimit.count++;
  return true;
}

// ── Reset create form ──
function _resetCreateForm() {
  const ta = document.getElementById('create-textarea');
  if (ta) { ta.value = ''; ta.style.height = 'auto'; }
  const cc = document.getElementById('create-char-count');
  if (cc) cc.textContent = '0 / 500';
  // Reset images
  ['create-img-preview','create-img-preview-2'].forEach(id => {
    const el = document.getElementById(id); if (el) el.classList.remove('visible');
  });
  ['create-img-clear','create-img-clear-2'].forEach(id => {
    const el = document.getElementById(id); if (el) el.classList.remove('visible');
  });
  ['create-image-area','create-image-area-2'].forEach(id => {
    const el = document.getElementById(id); if (el) el.classList.remove('has-image');
  });
  // Reset audio previews
  ['create-audio-preview-wrap','create-audio-preview-wrap-2'].forEach(id => {
    const el = document.getElementById(id); if (el) el.innerHTML = '';
  });
  // Reset file preview
  const fw = document.getElementById('create-file-preview-wrap'); if (fw) fw.innerHTML = '';
  // Reset link
  const li = document.getElementById('create-link-url'); if (li) li.value = '';
  const lp = document.getElementById('create-link-preview'); if (lp) lp.style.display = 'none';
  // Reset captions
  ['create-img-caption','create-audio-caption','create-file-caption','create-link-caption','create-ai-caption'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  // Reset state
  Object.assign(_createState, {
    imageData: null, imageData2: null,
    audioData: null, audioData2: null,
    fileData: null, linkUrl: '', storyImageData: null,
  });
  _createImageData = null;
  // Reset tags + goals
  _createTags.length = 0;
  createTagManager.render();
  _createSelectedGoal = '';
  document.getElementById('create-goals-grid').querySelectorAll('.create-goal-pill').forEach(p => p.classList.remove('selected'));
  // Reset preview
  if (_previewArea) _previewArea.style.display = 'none';
  if (_previewBtn) _previewBtn.innerHTML = '<i data-lucide="eye" class="lucide" width="16" height="16"></i> Preview Post';
  // Reset content type to text
  document.querySelectorAll('.content-type-btn').forEach(b => b.classList.remove('active'));
  const textBtn = document.querySelector('.content-type-btn[data-ctype="text"]');
  if (textBtn) textBtn.classList.add('active');
  _createState.contentType = 'text';
  _showContentTypePanels('text');
}

// ── SUBMIT POST ──
document.getElementById('create-post-btn').addEventListener('click', async () => {
  if (!state.currentUser) { Toast.error('Please log in'); return; }
  if (state.isMuted) { Toast.error('You are muted and cannot create posts.'); return; }
  if (state.featureFlags && state.featureFlags['create_posts_enabled'] === false) { Toast.error('Posting is currently disabled.'); return; }

  const btn = document.getElementById('create-post-btn');

  // ── STORY MODE ──
  if (_createMode === 'story') {
    const content = (document.getElementById('create-textarea')?.value || '').trim();
    if (!content) { Toast.error('Please write something first!'); return; }
    if (content.length > 200) { Toast.error('Stories max 200 characters'); return; }
    btn.disabled = true; btn.textContent = 'Sharing...';
    try {
      const now = Date.now();
      await push(ref(db, `stories/${state.currentUser.uid}`), {
        uid: state.currentUser.uid,
        username: state.username,
        pfpUrl: state.pfpUrl || '',
        type: (_createState.storyImageData || _createState.imageData) ? 'image' : 'text',
        text: content,
        imageUrl: _createState.storyImageData || _createState.imageData || '',
        createdAt: now,
        expiresAt: now + 24 * 60 * 60 * 1000,
      });
      _resetCreateForm();
      Toast.success('Story shared for 24h', 3000);
      navTo('explore-screen', 'nav-explore');
    } catch { Toast.error('Failed to share story — try again'); }
    finally { btn.disabled = false; btn.innerHTML = '<i data-lucide="sparkles" class="lucide" width="16" height="16"></i> Share as Story — 24h'; }
    return;
  }

  // ── POST MODE ──
  const content = _buildPostContent();
  const primaryText = content.text;
  const fallbackText = (document.getElementById('create-textarea')?.value || '').trim();

  // Validate: must have some content
  const hasText = !!(content.text && content.text.length > 0);
  const hasImage = !!content.imageUrl;
  const hasAudio = !!(content.audioData && content.audioData.dataUrl);
  const hasFile = !!(content.fileData && content.fileData.dataUrl);
  const hasLink = !!(_createState.linkUrl && _isValidUrl(_createState.linkUrl));

  if (!hasText && !hasImage && !hasAudio && !hasFile && !hasLink) {
    Toast.error('Please add some content first'); return;
  }
  if (_createTags.length === 0) { Toast.info('Add at least one skill tag'); return; }
  if (!checkPostRateLimit()) return;

  // Additional content-type specific validation
  if (_createState.contentType === 'link' && !hasLink) {
    Toast.error('Please enter a valid URL'); return;
  }
  if (_createState.contentType === 'text+audio' && !hasAudio) {
    Toast.error('Please record or upload audio'); return;
  }
  if (_createState.contentType === 'text+file' && !hasFile) {
    Toast.error('Please attach a file'); return;
  }

  const textForDb = content.text || fallbackText || '';
  if (textForDb.length > 500) {
    Toast.error('Post too long — max 500 characters'); return;
  }

  btn.disabled = true;
  btn.textContent = 'Posting...';

  try {
    const now = Date.now();
    const postData = {
      userId: state.currentUser.uid,
      username: state.username,
      skill: state.skill,
      pfpUrl: state.pfpUrl || '',
      content: textForDb,
      contentType: content.contentType,
      imageUrl: content.imageUrl || '',
      tags: _createTags.slice(),
      goal: _createSelectedGoal,
      likesCount: 0,
      commentsCount: 0,
      createdAt: now,
      expiresAt: now + 24 * 60 * 60 * 1000,
    };
    // Attach audio/file/link only if present (avoid storing nulls)
    if (hasAudio) postData.audioData = content.audioData;
    if (hasFile) postData.fileData = content.fileData;
    if (hasLink) { postData.linkUrl = _createState.linkUrl; postData.linkCaption = content.linkCaption || ''; }

    await push(ref(db, 'posts'), postData);
    _resetCreateForm();
    Toast.success('Your post is live for 24h', 3500);
    navTo('explore-screen', 'nav-explore');
  } catch(err) {
    Toast.error('Failed to post — try again');
    DEBUG && console.error('[Create Post]', err);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="flame" class="lucide" width="16" height="16"></i> Post Now — Live for 24h';
  }
});

/* ═══════════════════════════════════════════════════
   PLATFORM: EXPLORE FEED (ENHANCED)
   ═══════════════════════════════════════════════════ */

let _currentFilter = 'all';
let _exploreUnsubscribe = null;
let _feedSortMode = 'smart'; // 'smart' | 'newest' | 'trending' | 'following'

// Filter pills on the explore screen (hidden, kept for compat)
document.getElementById('explore-filters').addEventListener('click', (e) => {
  const pill = e.target.closest('.filter-pill');
  if (!pill) return;
  document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
  pill.classList.add('active');
  _currentFilter = pill.dataset.filter;
  if (_currentFilter === 'following') {
    const sel = document.getElementById('feed-sort-select');
    if (sel) { sel.value = 'following'; _feedSortMode = 'following'; }
  }
  _applyExploreSearch();
});

// ── Explore filter dropdown (new single-row UI) ──
(function() {
  const dropBtn = document.getElementById('explore-filter-dropdown-btn');
  const dropMenu = document.getElementById('explore-filter-dropdown-menu');
  const filterLabel = document.getElementById('explore-filter-label');

  function closeDropdown() {
    if (dropMenu) dropMenu.classList.remove('open');
    if (dropBtn) dropBtn.classList.remove('open');
  }

  if (dropBtn && dropMenu) {
    dropBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      const isOpen = dropMenu.classList.contains('open');
      closeDropdown();
      if (!isOpen) { dropMenu.classList.add('open'); dropBtn.classList.add('open'); }
    });

    dropMenu.querySelectorAll('.explore-filter-option').forEach(opt => {
      opt.addEventListener('click', function() {
        // Update active state
        dropMenu.querySelectorAll('.explore-filter-option').forEach(o => o.classList.remove('active'));
        this.classList.add('active');
        // Update label
        const label = this.textContent.trim().replace(/^[^a-zA-Z]+/, '').trim();
        if (filterLabel) filterLabel.textContent = label || 'All';
        // Sync hidden filter pills
        const filter = this.dataset.filter;
        document.querySelectorAll('#explore-filters .filter-pill').forEach(p => {
          p.classList.toggle('active', p.dataset.filter === filter);
        });
        // Trigger filter logic
        _currentFilter = filter;
        if (_currentFilter === 'following') {
          const sel = document.getElementById('feed-sort-select');
          if (sel) { sel.value = 'following'; _feedSortMode = 'following'; }
        }
        _applyExploreSearch();
        closeDropdown();
      });
    });

    // Close on outside click
    document.addEventListener('click', closeDropdown);
  }
})();

// Feed sort select
const _feedSortSelect = document.getElementById('feed-sort-select');
if (_feedSortSelect) {
  _feedSortSelect.addEventListener('change', function() {
    _feedSortMode = this.value;
    if (_feedSortMode === 'following') {
      _currentFilter = 'following';
      document.querySelectorAll('.filter-pill').forEach(p => p.classList.toggle('active', p.dataset.filter === 'following'));
    }
    renderFeedWithFilter();
  });
}

/* ══════════════════════════════════════════
   FEATURE 1 — SKILL-MATCHED COLLABS ENGINE
   ══════════════════════════════════════════ */

// Skills that are considered complementary for collab matching
const COLLAB_COMPLEMENT_MAP = {
  Designer:      ['Coder', 'Marketer', 'Writer', 'Animator'],
  Coder:         ['Designer', 'Marketer', 'Writer', 'Artist'],
  Marketer:      ['Designer', 'Coder', 'Writer', 'Photographer'],
  Writer:        ['Designer', 'Coder', 'Marketer', 'Musician'],
  Artist:        ['Coder', 'Animator', 'Musician', 'Marketer'],
  Musician:      ['Artist', 'Animator', 'Writer', 'Streamer'],
  Animator:      ['Designer', 'Musician', 'Coder', 'Artist'],
  Photographer:  ['Designer', 'Writer', 'Marketer', 'Editor'],
  Editor:        ['Photographer', 'Musician', 'Streamer', 'Animator'],
  Streamer:      ['Editor', 'Musician', 'Marketer', 'Gamer'],
  Gamer:         ['Streamer', 'Coder', 'Animator', 'Artist'],
  Explorer:      ['Coder', 'Designer', 'Writer', 'Marketer'],
};

// Goals that mean "open to collaborate"
const COLLAB_GOALS = ['want collaboration', 'looking for clients', 'open to hire'];

async function loadCollabMatches() {
  if (!state.currentUser) return;
  const section = document.getElementById('collab-matches-section');
  const listEl  = document.getElementById('collab-matches-list');
  const emptyEl = document.getElementById('collab-matches-empty');
  if (!section || !listEl) return;

  const myUid   = state.currentUser.uid;
  const mySkill = state.skill || '';
  const myGoals = state.goals || [];

  if (!mySkill) { section.style.display = 'none'; return; }

  section.style.display = 'block';
  listEl.innerHTML = [0,1,2].map(() => `
    <div class="skel-collab-card">
      <div class="skel skel-circle" style="width:36px;height:36px;"></div>
      <div class="skel-collab-info">
        <div class="skel skeleton-line lg" style="width:90px;margin:0;"></div>
        <div class="skel skeleton-line xs" style="width:120px;margin-top:5px;"></div>
      </div>
      <div class="skel skel-pill" style="width:64px;height:28px;flex-shrink:0;"></div>
    </div>`).join('');

  try {
    // Load blocked list first
    const blockedSnap = await get(ref(db, `users/${myUid}/blocked`));
    const blockedMap  = blockedSnap.val() || {};

    // SECURITY FIX: Instead of fetching the entire users tree, run
    // targeted queries for each complementary skill (+ own skill).
    // This works with the per-$uid read rule and avoids a full table scan.
    const complementary = COLLAB_COMPLEMENT_MAP[mySkill] || [];
    const skillsToQuery = [...new Set([...complementary, mySkill])].slice(0, 6);

    let skillSnaps;
    if (skillsToQuery.length === 0) {
      // Fallback: grab a sample of active users sorted by points
      skillSnaps = [await get(query(ref(db, 'users'), orderByChild('points'), limitToLast(60)))];
    } else {
      skillSnaps = await Promise.all(
        skillsToQuery.map(skill =>
          get(query(ref(db, 'users'), orderByChild('skill'), equalTo(skill), limitToFirst(40)))
        )
      );
    }

    // Deduplicate across skill query results
    const seen = new Set([myUid]);
    const mergedUsers = {};
    skillSnaps.forEach(snap => {
      snap.forEach(child => {
        if (!seen.has(child.key)) {
          seen.add(child.key);
          mergedUsers[child.key] = child.val();
        }
      });
    });

    if (Object.keys(mergedUsers).length === 0) { listEl.innerHTML = ''; emptyEl.style.display = 'block'; return; }

    const matches = [];

    Object.entries(mergedUsers).forEach(([uid, data]) => {
      if (!data || !data.username) return;
      if (blockedMap[uid]) return;

      const theirGoals = data.goals || [];
      const theyWantCollab = theirGoals.some(g => COLLAB_GOALS.includes(g));
      if (!theyWantCollab) return;

      const theirSkill = data.skill || '';
      const skillMatch = complementary.includes(theirSkill) || theirSkill === mySkill;
      if (!skillMatch) return;

      matches.push({ uid, ...data });
    });

    if (matches.length === 0) {
      listEl.innerHTML = '';
      emptyEl.style.display = 'block';
      return;
    }

    emptyEl.style.display = 'none';
    listEl.innerHTML = '';

    matches.slice(0, 10).forEach(u => {
      const avatarUrl  = u.pfpUrl || `https://api.dicebear.com/7.x/avataaars/svg?seed=${u.uid}`;
      const sharedGoal = (u.goals || []).find(g => COLLAB_GOALS.includes(g)) || 'Collaborate';
      const card = document.createElement('div');
      card.className = 'collab-match-card';
      card.innerHTML = `
        <div class="collab-match-avatar">
          <img src="${escHtml(avatarUrl)}" alt="${escHtml(u.username)}" onerror="this.style.display='none';this.parentElement.textContent='${escHtml(initials(u.username))}'">
        </div>
        <div class="collab-match-info">
          <div class="collab-match-name">@${escHtml(u.username)}</div>
          <div class="collab-match-meta">
            ${escHtml(u.skill || 'Explorer')} · ${escHtml(u.level || 'Beginner')}
            <span class="collab-match-goal-tag">${escHtml(sharedGoal)}</span>
          </div>
        </div>
        <button class="collab-match-msg-btn" data-uid="${escHtml(u.uid)}">Message</button>
      `;
      card.querySelector('.collab-match-msg-btn').addEventListener('click', () => {
        triggerChat(u.uid, u);
      });
      card.querySelector('.collab-match-info').addEventListener('click', () => {
        openUserProfileSheet(u.uid, u);
      });
      listEl.appendChild(card);
    });

  } catch (e) {
    DEBUG && console.error('[CollabMatch] Error:', e);
    listEl.innerHTML = '<div style="font-size:12px;color:var(--muted);padding:4px;">Could not load matches.</div>';
  }
}

let _allPosts = []; // stores all fetched posts

function loadExploreFeed() {
  // Show skeleton loading boxes
  ['skel1','skel2','skel3'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'block'; });

  // Unsubscribe from old listener if exists
  if (_exploreUnsubscribe) { _exploreUnsubscribe(); _exploreUnsubscribe = null; }

  const postsRef = ref(db, 'posts');
  _exploreUnsubscribe = onValue(postsRef, (snap) => {
    // Hide skeletons
    ['skel1','skel2','skel3'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });

    const now = Date.now();
    _allPosts = [];

    if (snap.exists()) {
      const data = snap.val();
      for (const [postId, post] of Object.entries(data)) {
        // Skip expired posts AND stories (stories are separate)
        if (post.expiresAt && post.expiresAt < now) continue;
        if (post.isStory) continue; // stories shown in stories bar only
        _allPosts.push({ postId, ...post });
      }
    }
    renderFeedWithFilter();
  });
}

// ── Explore search logic ──
let _exploreSearchQuery = '';

const _exploreSearchInput = document.getElementById('explore-search');
if (_exploreSearchInput) {
  _exploreSearchInput.addEventListener('input', debounce(function() {
    _exploreSearchQuery = this.value.toLowerCase().trim();
    _applyExploreSearch();
  }, 250));
}

function _applyExploreSearch() {
  // Check which tab is active
  const activeTab = document.querySelector('.explore-tab.active');
  const tab = activeTab ? activeTab.dataset.tab : 'posts';
  if (tab === 'people') {
    PeopleSearch.search(_exploreSearchQuery);
  } else {
    renderFeedWithFilter();
  }
}

/* ── Smart feed scoring ── */
function _scorePost(post, followedUids, mySkill, myTags) {
  let score = 0;
  const now = Date.now();
  const ageMs = now - (post.createdAt || 0);
  const ageHours = ageMs / (1000 * 60 * 60);

  // Recency score (decays over 24h)
  score += Math.max(0, 1 - ageHours / 24) * 40;

  // Followed user bonus
  if (followedUids.has(post.userId)) score += 50;

  // Engagement score (likes + comments, log-scaled)
  const engagement = (post.likesCount || 0) + (post.commentsCount || 0) * 1.5;
  score += Math.min(30, Math.log1p(engagement) * 8);

  // Skill / tag relevance
  const postTags = (post.tags || []).map(t => t.toLowerCase());
  if (mySkill && postTags.some(t => t.includes(mySkill.toLowerCase()))) score += 15;
  if (myTags && myTags.length) {
    const myTagsLow = myTags.map(t => t.toLowerCase());
    const overlap = postTags.filter(t => myTagsLow.some(mt => t.includes(mt) || mt.includes(t)));
    score += overlap.length * 8;
  }

  // Same skill bonus
  if (post.skill === mySkill) score += 10;

  return score;
}

function renderFeedWithFilter() {
  const feed = document.getElementById('posts-feed');
  if (!feed) return;
  // Remove all post cards and skel-post-cards but keep original skeletons (skel1/2/3) and section labels
  feed.querySelectorAll('.post-card, .empty-state, .feed-section-label').forEach(c => c.remove());
  const fragment = document.createDocumentFragment();

  let posts = _allPosts.slice();
  const followedUids = FollowSystem.getFollowedUids();
  const mySkill = state.skill || '';
  const myTags = state.tags || [];

  // Search filter
  if (_exploreSearchQuery) {
    posts = posts.filter(p => {
      const inContent = (p.content || '').toLowerCase().includes(_exploreSearchQuery);
      const inTags = (p.tags || []).some(t => t.toLowerCase().includes(_exploreSearchQuery));
      const inUsername = (p.username || '').toLowerCase().includes(_exploreSearchQuery);
      return inContent || inTags || inUsername;
    });
  }

  // Filter pill
  if (_currentFilter === 'following') {
    posts = posts.filter(p => followedUids.has(p.userId));
  } else if (_currentFilter !== 'all' && _currentFilter !== 'trending') {
    posts = posts.filter(p => p.goal === _currentFilter);
  }

  // Sort
  const sortMode = _feedSortMode;
  if (sortMode === 'trending') {
    posts.sort((a, b) => ((b.likesCount || 0) + (b.commentsCount || 0)) - ((a.likesCount || 0) + (a.commentsCount || 0)));
  } else if (sortMode === 'newest') {
    posts.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  } else if (sortMode === 'following') {
    posts = posts.filter(p => followedUids.has(p.userId));
    posts.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  } else {
    // Smart sort: score each post
    posts = posts.map(p => ({ ...p, _score: _scorePost(p, followedUids, mySkill, myTags) }));
    posts.sort((a, b) => b._score - a._score);
  }

  if (posts.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const msg = _currentFilter === 'following'
      ? 'Follow people to see their posts here'
      : 'No posts found — try a different filter';
    empty.innerHTML = `<div class="empty-icon"><i data-lucide="sprout" class="lucide" width="48" height="48"></i></div><div class="empty-text">Nothing here yet</div><div class="empty-sub">${msg}</div>`;
    fragment.appendChild(empty);
    feed.appendChild(fragment);
    lucideCreate();
    return;
  }

  // Render with section labels for smart feed
  if (sortMode === 'smart' && !_exploreSearchQuery && _currentFilter === 'all') {
    const followed = posts.filter(p => followedUids.has(p.userId));
    const others = posts.filter(p => !followedUids.has(p.userId));

    if (followed.length > 0) {
      const lbl = document.createElement('div');
      lbl.className = 'feed-section-label';
      lbl.innerHTML = '<i data-lucide="users" class="lucide" width="16" height="16"></i> From people you follow';
      fragment.appendChild(lbl);
      followed.forEach(post => fragment.appendChild(createPostCard(post)));
    }

    if (others.length > 0) {
      const lbl = document.createElement('div');
      lbl.className = 'feed-section-label';
      lbl.innerHTML = followed.length > 0 ? '<i data-lucide="sparkles" class="lucide" width="16" height="16"></i> Discover' : '<i data-lucide="sparkles" class="lucide" width="16" height="16"></i> All Posts';
      fragment.appendChild(lbl);
      others.forEach(post => fragment.appendChild(createPostCard(post)));
    }
  } else {
    posts.forEach(post => {
      const card = createPostCard(post);
      fragment.appendChild(card);
    });
  }

  feed.appendChild(fragment);
  lucideCreate();
  setupImageLazyLoad();
}

// Build a single post card element
function createPostCard(post, overrideId) {
  const now = Date.now();
  const remaining = (post.expiresAt || 0) - now;
  const hours = Math.floor(remaining / (1000 * 60 * 60));
  const mins = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
  let expiryText, expiryClass;
  if (hours < 1) { expiryText = `<i data-lucide="hourglass" class="lucide" width="12" height="12"></i> ${mins}m left`; expiryClass = 'critical'; }
  else if (hours < 4) { expiryText = `<i data-lucide="hourglass" class="lucide" width="12" height="12"></i> ${hours}h left`; expiryClass = 'warning'; }
  else { expiryText = `<i data-lucide="hourglass" class="lucide" width="12" height="12"></i> ${hours}h left`; expiryClass = ''; }

  const postId = overrideId || post.postId;
  const isOwn = state.currentUser && post.userId === state.currentUser.uid;
  const isFollowed = !isOwn && FollowSystem.isFollowing(post.userId);

  const avatarContent = post.pfpUrl
    ? `<img src="${escHtml(post.pfpUrl)}" alt="${escHtml(post.username)}" loading="lazy">`
    : `<span>${(post.username || '??').slice(0,2).toUpperCase()}</span>`;

  const tagsHtml = (post.tags || []).map(t => `<span class="post-tag">#${escHtml(t)}</span>`).join('');
  const goalHtml = post.goal ? `<span class="post-goal-badge">${post.goal}</span>` : '';
  const followedBadge = isFollowed ? `<span class="post-priority-badge followed"><i data-lucide="check" class="lucide" width="12" height="12"></i> Following</span>` : '';

  // Content type badge
  const ctype = post.contentType || (post.imageUrl ? 'text+image' : 'text');
  let ctypeBadge = '';
  if (ctype === 'text+image') ctypeBadge = '<span class="post-content-type-badge type-image"><i data-lucide="image" class="lucide" width="12" height="12"></i> Image</span>';
  else if (ctype === 'text+audio' || ctype === 'audio+image') ctypeBadge = '<span class="post-content-type-badge type-audio"><i data-lucide="music" class="lucide" width="12" height="12"></i> Audio</span>';
  else if (ctype === 'text+file') ctypeBadge = '<span class="post-content-type-badge type-file"><i data-lucide="file" class="lucide" width="12" height="12"></i> File</span>';
  else if (ctype === 'link') ctypeBadge = '<span class="post-content-type-badge type-link"><i data-lucide="link" class="lucide" width="12" height="12"></i> Link</span>';

  // Rich media HTML
  let richMediaHtml = '';
  // Image
  if (post.imageUrl) {
    richMediaHtml += `<img class="post-image" src="${escHtml(post.imageUrl)}" alt="Post image" loading="lazy">`;
  }
  // Audio player
  if (post.audioData && post.audioData.dataUrl) {
    const waveH = [8,14,20,16,24,18,12,22,10,20,16,8,18,14,20];
    const waveBars = waveH.map(h => `<div class="post-audio-wave-bar" style="height:${h}px"></div>`).join('');
    richMediaHtml += `
      <div class="post-audio-player" data-audio-src="${escHtml(post.audioData.dataUrl)}">
        <button class="post-audio-play-btn" type="button">▶</button>
        <div class="post-audio-wave">${waveBars}</div>
        <span class="post-audio-duration">${post.audioData.name ? escHtml(post.audioData.name.split('.')[0]) : 'Audio'}</span>
      </div>`;
  }
  // File embed
  if (post.fileData && post.fileData.dataUrl) {
    richMediaHtml += `
      <div class="post-file-embed" data-dl="${escHtml(post.fileData.dataUrl)}" data-fn="${escHtml(post.fileData.name || 'file')}">
        <div class="post-file-embed-icon">${fileIcon(post.fileData.name || '')}</div>
        <div class="post-file-embed-info">
          <div class="post-file-embed-name">${escHtml(post.fileData.name || 'File')}</div>
          <div class="post-file-embed-meta">${post.fileData.mimeType || 'File'} · ${post.fileData.size ? ((post.fileData.size/1024).toFixed(1) + 'KB') : ''}</div>
        </div>
        <span class="post-file-embed-dl">⬇ Download</span>
      </div>`;
  }
  // Link embed
  if (post.linkUrl) {
    let domain = '';
    try { domain = new URL(post.linkUrl).hostname; } catch {}
    richMediaHtml += `
      <div class="post-link-embed" data-href="${escHtml(post.linkUrl)}">
        <div class="post-link-embed-inner">
          <div class="post-link-embed-title"><i data-lucide="link" class="lucide" width="12" height="12"></i> ${escHtml(domain || post.linkUrl)}</div>
          <div class="post-link-embed-url">${escHtml(post.linkUrl)}</div>
          ${post.linkCaption ? `<div style="font-size:12px;color:var(--text-secondary);margin-top:4px;">${escHtml(post.linkCaption)}</div>` : ''}
        </div>
      </div>`;
  }

  const card = document.createElement('div');
  card.className = 'post-card';
  card.dataset.postId = postId;

  card.innerHTML = `
    <div class="post-header">
      <div class="post-avatar" style="cursor:pointer;" data-uid="${escHtml(post.userId)}">${avatarContent}</div>
      <div class="post-meta">
        <div class="post-username">@${escHtml(post.username || 'Unknown')} <span class="post-skill-tag">${escHtml(post.skill || 'Explorer')}</span>${ctypeBadge}${goalHtml}${followedBadge}</div>
      </div>
      <div class="post-expiry ${expiryClass}">${expiryText}</div>
    </div>
    <div class="post-content">${escHtml(post.content || '')}${post.edited ? '<span class="post-edited-badge">(edited)</span>' : ''}</div>
    ${richMediaHtml}
    <div class="post-tags">${tagsHtml}</div>
   <div class="post-actions">
      <button class="post-action-btn like-btn" data-post-id="${postId}">
        <span class="btn-icon"><i data-lucide="heart" class="lucide" width="15" height="15"></i></span>
        <span class="like-count">${post.likesCount || 0}</span>
      </button>
      <button class="post-action-btn comment-btn" data-post-id="${postId}">
        <span class="btn-icon"><i data-lucide="message-circle" class="lucide" width="15" height="15"></i></span>
        <span class="comment-count">${post.commentsCount || 0}</span>
      </button>
      <button class="post-action-btn save-btn" data-post-id="${postId}">
        <span class="btn-icon"><i data-lucide="bookmark" class="lucide" width="15" height="15"></i></span>
      </button>
      ${!isOwn ? `<button class="post-follow-btn${isFollowed ? ' following' : ''}" data-follow-uid="${escHtml(post.userId)}" data-username="${escHtml(post.username || '')}" data-skill="${escHtml(post.skill || 'Explorer')}">${isFollowed ? '✓ Following' : '+ Follow'}</button>` : ''}
      ${!isOwn ? `<button class="post-action-btn connect-btn" data-uid="${post.userId}" data-username="${escHtml(post.username || '')}" data-skill="${escHtml(post.skill || 'Explorer')}">
        <span class="btn-icon"><i data-lucide="message-circle" class="lucide" width="15" height="15"></i></span>
      </button>` : ''}
      ${!isOwn ? `<button class="post-action-btn report-post-btn" data-post-id="${postId}" data-uid="${post.userId}" data-username="${escHtml(post.username || '')}" data-content="${escHtml((post.content||'').slice(0,120))}">
        <span class="btn-icon"><i data-lucide="flag" class="lucide" width="15" height="15"></i></span>
      </button>` : ''}
      ${isOwn ? `
    <button class="post-action-btn edit-post-btn" data-post-id="${postId}">
      <span class="btn-icon"><i data-lucide="pencil" class="lucide" width="15" height="15"></i></span> Edit
    </button>
    <button class="post-action-btn delete-btn" id="del-${postId}">
      <span class="btn-icon"><i data-lucide="trash-2" class="lucide" width="15" height="15"></i></span> Delete
    </button>` : ''}
    </div>
    <div class="post-comments-panel" id="comments-${postId}"></div>
  `;

  // ── Wire audio play buttons ──
  card.querySelectorAll('.post-audio-player').forEach(player => {
    const playBtn = player.querySelector('.post-audio-play-btn');
    const src = player.dataset.audioSrc;
    if (!playBtn || !src) return;
    let audio = null;
    playBtn.addEventListener('click', () => {
      if (!audio) { audio = new Audio(src); }
      if (audio.paused) {
        // Pause any other playing audio
        document.querySelectorAll('.post-audio-play-btn.playing').forEach(b => {
          if (b !== playBtn) { b.textContent = '▶'; b.classList.remove('playing'); }
        });
        audio.play().catch(()=>{});
        playBtn.innerHTML = '<i data-lucide="pause" class="lucide" width="16" height="16"></i>';
        playBtn.classList.add('playing');
        audio.onended = () => { playBtn.textContent = '▶'; playBtn.classList.remove('playing'); };
      } else {
        audio.pause();
        playBtn.textContent = '▶';
        playBtn.classList.remove('playing');
      }
    });
  });

  // ── Wire file download ──
  card.querySelectorAll('.post-file-embed').forEach(embed => {
    embed.addEventListener('click', () => {
      const dlUrl = embed.dataset.dl;
      const fn = embed.dataset.fn;
      if (!dlUrl) return;
      const a = document.createElement('a'); a.href = dlUrl; a.download = fn || 'file';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
    });
  });

  // ── Wire link embeds ──
  card.querySelectorAll('.post-link-embed').forEach(embed => {
    embed.addEventListener('click', () => {
      const href = embed.dataset.href;
      if (href) window.open(href, '_blank', 'noopener,noreferrer');
    });
  });

  // Avatar + username click → open user profile sheet
  const _openPostUserProfile = () => {
    const uid = post.userId;
    const cached = getUserCached(uid);
    openUserProfileSheet(
      uid, post.username, post.skill || 'Explorer',
      cached?.level || 'Beginner', cached?.points || 0,
      post.pfpUrl || cached?.pfpUrl || '', cached?.bio || '', cached?.expertise || null, cached?.socialIntegrations || null
    );
  };
  const avatarEl = card.querySelector('.post-avatar[data-uid]');
  if (avatarEl) avatarEl.addEventListener('click', _openPostUserProfile);
  const usernameEl = card.querySelector('.post-username');
  if (usernameEl && post.userId !== state.currentUser?.uid) {
    usernameEl.style.cursor = 'pointer';
    usernameEl.addEventListener('click', _openPostUserProfile);
  }

  // Follow button on post
  const followBtn = card.querySelector('.post-follow-btn');
  if (followBtn) {
    followBtn.addEventListener('click', () => {
      FollowSystem.toggle(post.userId, post.username, post.skill, followBtn);
    });
  }

  // Wire up interactions
  card.querySelector('.like-btn').addEventListener('click', (e) => handleLike(e, post));

  // Edit button — only for owner
  const editPostBtn = card.querySelector('.edit-post-btn');
  if (editPostBtn) {
    editPostBtn.addEventListener('click', () => openPostEditModal(post, card));
  }
  card.querySelector('.comment-btn').addEventListener('click', () => handleCommentToggle(post));
  card.querySelector('.save-btn').addEventListener('click', () => handleSave(post, card));

  // Delete button — only shown to post owner
  const deleteBtn = card.querySelector('.delete-btn');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => handleDeletePost(post, card));
  }

  const connectBtn = card.querySelector('.connect-btn');
  if (connectBtn) {
    connectBtn.addEventListener('click', () => {
      const uid = connectBtn.dataset.uid;
      const uname = connectBtn.dataset.username;
      const uskill = connectBtn.dataset.skill;
      openChat(uid, uname, uskill, 'Beginner', 0);
    });
  }

  const reportPostBtn = card.querySelector('.report-post-btn');
  if (reportPostBtn) {
    reportPostBtn.addEventListener('click', () => {
      openReportModal({
        targetUid: reportPostBtn.dataset.uid,
        targetUsername: reportPostBtn.dataset.username,
        targetType: 'post',
        targetPostId: reportPostBtn.dataset.postId,
        contentPreview: reportPostBtn.dataset.content
      });
    });
  }

  // Double-tap to like
  let lastTap = 0;
  card.addEventListener('touchend', (e) => {
    const now2 = Date.now();
    if (now2 - lastTap < 300) { handleLike(e, post); }
    lastTap = now2;
  });

  // Check if already saved and update icon
  IDB.exists(post.postId).then(saved => {
    if (saved) {
      const btn = card.querySelector('.save-btn');
    if (btn) { btn.classList.add('saved-btn'); btn.querySelector('.btn-icon').innerHTML = '<i data-lucide="bookmark" class="lucide" width="15" height="15" style="fill:var(--accent-light);stroke:var(--accent-light)"></i>'; lucideCreate(); }
    }
  }).catch(() => {});

  // Check if already liked
  if (state.currentUser) {
    get(ref(db, `postLikes/${post.postId}/${state.currentUser.uid}`)).then(snap => {
      if (snap.exists()) {
        const btn = card.querySelector('.like-btn');
        if (btn) btn.classList.add('liked');
        const icon = btn?.querySelector('.btn-icon');
        if (icon) { icon.innerHTML = '<i data-lucide="heart" class="lucide" width="15" height="15" style="fill:#ef4444;stroke:#ef4444"></i>'; lucideCreate(); }
      }
    }).catch(() => {});
  }

  return card;
}

// Images now use native loading="lazy" — this function is kept as a no-op
function setupImageLazyLoad() {
  // Native loading="lazy" on <img> tags handles this now
}
/* ═══════════════════════════════════════════════════
   POST EDITING
   ═══════════════════════════════════════════════════ */
let _editingPostId = null;
let _editingCardEl = null;

function openPostEditModal(post, cardEl) {
  if (!state.currentUser || post.userId !== state.currentUser.uid) return;
  _editingPostId = post.postId;
  _editingCardEl = cardEl;

  const overlay = document.getElementById('post-edit-modal-overlay');
  const textarea = document.getElementById('post-edit-textarea');
  const charCount = document.getElementById('post-edit-char-count');

  if (!overlay || !textarea) return;
  textarea.value = post.content || '';
  charCount.textContent = `${textarea.value.length} / 500`;
  overlay.style.display = 'flex';
  textarea.focus();
}

function closePostEditModal() {
  const overlay = document.getElementById('post-edit-modal-overlay');
  if (overlay) overlay.style.display = 'none';
  _editingPostId = null;
  _editingCardEl = null;
}

async function savePostEdit() {
  if (!_editingPostId || !state.currentUser) return;
  const textarea = document.getElementById('post-edit-textarea');
  const newContent = (textarea?.value || '').trim();

  if (!newContent) { Toast.error('Post cannot be empty'); return; }
  if (newContent.length > 500) { Toast.error('Post too long — max 500 characters'); return; }

  const saveBtn = document.getElementById('post-edit-save');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving...'; }

  try {
    await update(ref(db, `posts/${_editingPostId}`), {
      content: newContent,
      edited: true,
      editedAt: Date.now()
    });
// Update the card in the DOM immediately
    if (_editingCardEl) {
      const contentEl = _editingCardEl.querySelector('.post-content');
      if (contentEl) {
        contentEl.innerHTML = escHtml(newContent) + '<span class="post-edited-badge">(edited)</span>';
      }
    }

    // Also update the in-memory _allPosts array so re-renders show the edit
    const postIdx = _allPosts.findIndex(p => p.postId === _editingPostId);
    if (postIdx !== -1) {
      _allPosts[postIdx].content = newContent;
      _allPosts[postIdx].edited = true;
      _allPosts[postIdx].editedAt = Date.now();
    }

    Toast.success('Post updated');
    closePostEditModal();
  } catch (e) {
    Toast.error('Could not save edit: ' + (e.message || 'Unknown error'));
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Changes'; }
  }
}

// Wire up post edit modal buttons
document.getElementById('post-edit-save')?.addEventListener('click', savePostEdit);
document.getElementById('post-edit-cancel')?.addEventListener('click', closePostEditModal);
document.getElementById('post-edit-close')?.addEventListener('click', closePostEditModal);
document.getElementById('post-edit-modal-overlay')?.addEventListener('click', (e) => {
  if (e.target === document.getElementById('post-edit-modal-overlay')) closePostEditModal();
});
document.getElementById('post-edit-textarea')?.addEventListener('input', function() {
  const cc = document.getElementById('post-edit-char-count');
  if (cc) cc.textContent = `${this.value.length} / 500`;
});
// Handle Delete Post (owner only)
async function handleDeletePost(post, cardEl) {
  if (!state.currentUser) return;
  if (post.userId !== state.currentUser.uid) {
    Toast.error('You can only delete your own posts');
    return;
  }

  // Ask the user to confirm before deleting
  const _deleteOk = await ConfirmModal.show({ icon: 'trash-2', title: 'Delete this post?', sub: 'This action cannot be undone.', confirmText: 'Delete', cancelText: 'Cancel', danger: true });
  if (!_deleteOk) return;

  const deleteBtn = cardEl.querySelector('.delete-btn');
  if (deleteBtn) { deleteBtn.disabled = true; deleteBtn.textContent = 'Deleting...'; }

  try {
    // Delete the post from Firebase
    await remove(ref(db, `posts/${post.postId}`));

    // Also clean up likes and comments for this post
    await remove(ref(db, `postLikes/${post.postId}`)).catch(() => {});
    await remove(ref(db, `postComments/${post.postId}`)).catch(() => {});

    // Also remove from saved posts (IndexedDB locally + Firebase)
    await IDB.delete(post.postId).catch(() => {});
    if (state.currentUser) {
      await remove(ref(db, `savedPosts/${state.currentUser.uid}/${post.postId}`)).catch(() => {});
    }

    // Animate the card out then remove it
    cardEl.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
    cardEl.style.opacity = '0';
    cardEl.style.transform = 'scale(0.95)';
    setTimeout(() => {
      cardEl.remove();
      Toast.success('Post deleted');
      // If feed is now empty, show empty state
      const feed = document.getElementById('posts-feed');
      if (feed && !feed.querySelector('.post-card')) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.innerHTML = `<div class="empty-icon"><i data-lucide="sprout" class="lucide" width="48" height="48"></i></div><div class="empty-text">No posts yet</div><div class="empty-sub">Be the first to share a skill!</div>`;
        feed.appendChild(empty);
      }
    }, 300);

  } catch (err) {
    Toast.error('Could not delete post — try again');
if (deleteBtn) { deleteBtn.disabled = false; deleteBtn.innerHTML = '<span class="btn-icon"><i data-lucide="trash-2" class="lucide" width="15" height="15"></i></span> Delete'; lucideCreate(); }
    DEBUG && console.error('[Delete Post]', err);
  }
}
// Handle Like button
async function handleLike(e, post) {
  if (!state.currentUser) { Toast.info('Log in to like posts'); return; }
  const btn = document.querySelector(`.like-btn[data-post-id="${post.postId}"]`);
  if (!btn) return;

  const isLiked = btn.classList.contains('liked');
  const likeRef = ref(db, `postLikes/${post.postId}/${state.currentUser.uid}`);
  const countRef = ref(db, `posts/${post.postId}/likesCount`);

  // Lock button during in-flight operation to prevent spam
  btn.disabled = true;

  if (isLiked) {
    btn.classList.remove('liked');
    btn.querySelector('.btn-icon').innerHTML = '<i data-lucide="heart" class="lucide" width="15" height="15"></i>'; lucideCreate();
    await remove(likeRef).catch(() => {});
    // Use Firebase increment() to avoid race conditions — never stale client value
    await update(ref(db, `posts/${post.postId}`), { likesCount: increment(-1) }).catch(() => {});
    const count = btn.querySelector('.like-count');
    if (count) count.textContent = Math.max(0, parseInt(count.textContent || '0') - 1);
  } else {
    btn.classList.add('liked');
    btn.querySelector('.btn-icon').innerHTML = '<i data-lucide="heart" class="lucide" width="15" height="15" style="fill:#ef4444;stroke:#ef4444"></i>'; lucideCreate();
    await set(likeRef, true).catch(() => {});
    // Use Firebase increment() to avoid race conditions — never stale client value
    await update(ref(db, `posts/${post.postId}`), { likesCount: increment(1) }).catch(() => {});
    const count = btn.querySelector('.like-count');
    if (count) count.textContent = parseInt(count.textContent || '0') + 1;
  }

  btn.disabled = false;
}

// Handle Comment panel toggle
function handleCommentToggle(post) {
  const panel = document.getElementById(`comments-${post.postId}`);
  if (!panel) return;
  const isOpen = panel.classList.contains('open');
  if (isOpen) {
    panel.classList.remove('open');
    return;
  }
  panel.classList.add('open');
  // Load existing comments
  panel.innerHTML = '<div style="font-size:12px;color:var(--muted);padding:4px 0;">Loading comments...</div>';
  loadComments(post.postId, panel);
}

function loadComments(postId, panel) {
  get(ref(db, `postComments/${postId}`)).then(snap => {
    panel.innerHTML = '';
    if (snap.exists()) {
      const comments = Object.values(snap.val());
      comments.sort((a,b) => (a.createdAt||0) - (b.createdAt||0));
      comments.forEach(c => {
        const el = document.createElement('div');
        el.className = 'comment-item';
        el.innerHTML = `<div class="comment-avatar">${(c.username||'??').slice(0,2).toUpperCase()}</div><div class="comment-body"><div class="comment-username">@${escHtml(c.username||'?')}</div><div class="comment-text">${escHtml(c.text||'')}</div></div>`;
        panel.appendChild(el);
      });
    }
    // Comment input row
    const row = document.createElement('div');
    row.className = 'comment-input-row';
    row.innerHTML = `<input class="input comment-input" type="text" placeholder="Add a comment..." maxlength="200"><button class="comment-send-btn" type="button">Send</button>`;
    panel.appendChild(row);
    row.querySelector('.comment-send-btn').addEventListener('click', () => submitComment(postId, row.querySelector('.comment-input'), panel));
    row.querySelector('.comment-input').addEventListener('keydown', e => { if (e.key === 'Enter') submitComment(postId, row.querySelector('.comment-input'), panel); });
  }).catch(() => {
    panel.innerHTML = '<div style="font-size:12px;color:var(--muted)">Could not load comments</div>';
  });
}

async function submitComment(postId, input, panel) {
  if (!state.currentUser) { Toast.info('Log in to comment'); return; }
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  try {
    const commentData = { userId: state.currentUser.uid, username: state.username, text, createdAt: Date.now() };
    await push(ref(db, `postComments/${postId}`), commentData);
    await update(ref(db, `posts/${postId}`), { commentsCount: increment(1) });
    // Reload comments panel
    loadComments(postId, panel);
  } catch(err) {
    Toast.error('Comment failed');
  }
}

// Handle Save to Downloads
async function handleSave(post, cardEl) {
  if (!state.currentUser) { Toast.info('Log in to save posts'); return; }
  const btn = cardEl.querySelector('.save-btn');
  const isSaved = btn?.classList.contains('saved-btn');

  if (isSaved) {
    // Unsave
    await IDB.delete(post.postId).catch(() => {});
    await remove(ref(db, `savedPosts/${state.currentUser.uid}/${post.postId}`)).catch(() => {});
    if (btn) { btn.classList.remove('saved-btn'); btn.querySelector('.btn-icon').innerHTML = '<i data-lucide="save" class="lucide" width="16" height="16"></i>'; }
    Toast.info('Removed from saved');
  } else {
    // Save locally (full post data) and Firebase (just a reference)
    const savePayload = { ...post, postId: post.postId, savedAt: Date.now() };
    await IDB.save(savePayload).catch(() => {});
    await set(ref(db, `savedPosts/${state.currentUser.uid}/${post.postId}`), { savedAt: Date.now() }).catch(() => {});
    if (btn) { btn.classList.add('saved-btn'); btn.querySelector('.btn-icon').innerHTML = '<i data-lucide="bookmark" class="lucide" width="16" height="16"></i>'; }
    Toast.success('Saved! Find it in Downloads');
  }
}
async function loadSavedPosts() {
  const list = document.getElementById('saved-posts-list');
  const empty = document.getElementById('downloads-empty');
  if (!list) return;

  // Show skeleton while loading
  list.querySelectorAll('.post-card, .skel-saved-post').forEach(c => c.remove());
  if (empty) empty.style.display = 'none';
  const skelHTML = [0,1,2].map(() => `
    <div class="skel-saved-post">
      <div class="skel-post-header">
        <div class="skel skel-round" style="width:36px;height:36px;"></div>
        <div class="skel-post-meta">
          <div class="skel skeleton-line lg" style="width:100px;margin:0;"></div>
          <div class="skel skeleton-line xs" style="width:60px;margin-top:5px;"></div>
        </div>
      </div>
      <div class="skel skeleton-line full" style="margin-bottom:6px;"></div>
      <div class="skel skeleton-line medium" style="margin-bottom:6px;"></div>
      <div class="skel skeleton-line tall" style="margin-bottom:10px;border-radius:var(--radius-md);"></div>
    </div>`).join('');
  list.insertAdjacentHTML('afterbegin', skelHTML);

  try {
    const saved = await IDB.getAll();
    // Remove skeletons
    list.querySelectorAll('.skel-saved-post').forEach(c => c.remove());
    if (saved.length === 0) { if (empty) empty.style.display = 'flex'; return; }
    if (empty) empty.style.display = 'none';

    // Sort by savedAt (most recently saved first)
    saved.sort((a,b) => (b.savedAt||0) - (a.savedAt||0));

    saved.forEach(post => {
      const card = createPostCard(post);

      // Add "saved locally" badge
      const badge = document.createElement('div');
      badge.className = 'saved-badge';
      badge.innerHTML = '<i data-lucide="bookmark" class="lucide" width="12" height="12"></i> Saved';
      card.style.position = 'relative';
      card.insertBefore(badge, card.firstChild);

      // Remove save btn from card, add unsave button
      const saveBtn = card.querySelector('.save-btn');
      if (saveBtn) saveBtn.remove();

      const unsaveBtn = document.createElement('button');
      unsaveBtn.className = 'post-action-btn';
      unsaveBtn.innerHTML = `<span class="btn-icon"><i data-lucide="trash-2" class="lucide" width="16" height="16"></i></span> Remove`;
      unsaveBtn.addEventListener('click', async () => {
        await IDB.delete(post.postId).catch(() => {});
        await remove(ref(db, `savedPosts/${state.currentUser.uid}/${post.postId}`)).catch(() => {});
        card.remove();
        Toast.info('Removed from saved');
        // If list is now empty, show empty state
        if (!list.querySelector('.post-card')) { if (empty) empty.style.display = 'flex'; }
      });
      const actions = card.querySelector('.post-actions');
      if (actions) actions.appendChild(unsaveBtn);

      list.appendChild(card);
    });

    lucideCreate();
    // Lazy-load images in saved posts too
    setupImageLazyLoad();

  } catch(err) {
    DEBUG && console.warn('[Downloads]', err);
    Toast.error('Could not load saved posts');
  }
}
// Initialize Lucide icons (renders all data-lucide SVGs)
lucideCreate();



// ── Export to window ──
Object.assign(window, {
  IDB, loadSavedPosts, openPostEditModal, _exploreUnsubscribe, _lbUnsubscribe
});
