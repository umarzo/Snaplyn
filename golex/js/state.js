// ── Golex App State ── pulled from firebase-init.js globals ──
const { CONFIG, EPHEMERAL_CONFIG, PREDEFINED_SKILLS } = window;

const state = {
  currentUser: null, username: '', skill: 'Explorer', level: 'Beginner',
  points: 0, bio: '', tags: [], goals: [], availability: [], expertise: null,
  socialIntegrations: null,
  pfpUrl: '', pfpChangedAt: null,
  /* ── Golex Pro ── */
  isPro: false, proSince: null, proExpiry: null, tagline: '',
  chatId: null, chatPartnerId: null, chatPartnerUsername: '',
  isSending: false, isUploading: false,
  replyToMsgId: null, replyToText: '', editingMsgId: null,
  typingTimeout: null, pendingFile: null,
  mediaRecorder: null, audioChunks: [], isRecording: false,
  recTimerInterval: null, recSeconds: 0,
  unsubMessages: null, unsubTyping: null, unsubPartnerData: null, unsubDirectory: null,
  unsubPinned: null,
  setupTags: [], modalTags: [],
  chattedWith: new Set(), unreadCounts: new Map(),
  directoryListeners: new Map(), renderedMsgIds: new Set(),
  reactionPickerTarget: null, golexExpanded: false,
  setupSelectedSkill: '', modalSelectedSkill: '',
  heartbeatInterval: null,
  usersCache: new Map(), // stores { data, cachedAt } — use getUserCached() to access with TTL check
  currentPinnedMid: null,
  scrollBottomBtn: null,
  lastVisibleSentStatusMid: null,
// ─── Voice Call State ───
callId: null,
peerConnection: null,
localStream: null,
callTimerInterval: null,
callSeconds: 0,
incomingCallRef: null,
unsubIncomingCall: null,
_ringTimeout: null,
_unsubIceCaller: null,    // cleanup ref for caller's ICE listener
_unsubIceReceiver: null,  // cleanup ref for receiver's ICE listener
// ─── Video Call State (new) ───
  videoMode: false,           // true when video is currently active
  localVideoStream: null,     // holds the camera stream separately
  _unsubVideoRequest: null,    // Firebase listener for video switch signaling
_unsubRenegotiationAnswer: null,
  _unsubRenegotiate: null,
  _unsubReceiverRenegotiate: null,
_unsubReceiverAnswer: null,
  _callConnected: false,
  _videoSenderExists: false,
  _lastProcessedVideoRequestTs: null,
  activeSketchCallId: null,
  activeSketchCallType: null
};

function getEmptySocialIntegrations() {
  return {
    github: {
      connected: false,
      username: '',
      profile: null,
      repos: [],
      contributions30d: 0,
      lastFetchedAt: null,
      lastError: ''
    },
    dribbble: {
      connected: false,
      username: '',
      profile: null,
      shots: [],
      projects: [],
      lastFetchedAt: null,
      lastError: ''
    }
  };
}

const MAX_SOCIAL_ITEMS = 8;

function normalizeSocialIntegrations(raw) {
  const base = getEmptySocialIntegrations();
  if (!raw || typeof raw !== 'object') return base;
  const gh = raw.github || {};
  const dr = raw.dribbble || {};
  base.github = {
    ...base.github,
    ...gh,
    repos: Array.isArray(gh.repos) ? gh.repos.slice(0, MAX_SOCIAL_ITEMS) : [],
    connected: !!(gh.connected || gh.username || gh.profile)
  };
  base.dribbble = {
    ...base.dribbble,
    ...dr,
    shots: Array.isArray(dr.shots) ? dr.shots.slice(0, MAX_SOCIAL_ITEMS) : [],
    projects: Array.isArray(dr.projects) ? dr.projects.slice(0, MAX_SOCIAL_ITEMS) : [],
    connected: !!(dr.connected || dr.username || dr.profile)
  };
  return base;
}
state.socialIntegrations = getEmptySocialIntegrations();


// ─── TTL user-cache helpers ───
const USER_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const USER_CACHE_MAX = 500;
function cacheUser(uid, data) {
  if (state.usersCache.size >= USER_CACHE_MAX) {
    // Evict the oldest entry
    const firstKey = state.usersCache.keys().next().value;
    state.usersCache.delete(firstKey);
  }
  state.usersCache.set(uid, { data, cachedAt: Date.now() });
}
function getUserCached(uid) {
  const entry = state.usersCache.get(uid);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > USER_CACHE_TTL) {
    state.usersCache.delete(uid);
    return null;
  }
  return entry.data;
}
const fbApp = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(fbApp);
const db = getDatabase(fbApp);


// ── Export to window ──
Object.assign(window, {
  state, getEmptySocialIntegrations, normalizeSocialIntegrations,
  MAX_SOCIAL_ITEMS, USER_CACHE_TTL: 5*60*1000, USER_CACHE_MAX: 500,
  cacheUser, getUserCached
});
