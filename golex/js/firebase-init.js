import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { initializeAppCheck, ReCaptchaV3Provider } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app-check.js";
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut, deleteUser, reauthenticateWithPopup, createUserWithEmailAndPassword, signInWithEmailAndPassword, sendPasswordResetEmail, sendEmailVerification, EmailAuthProvider, reauthenticateWithCredential } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { getDatabase, ref, get, set, remove, onValue, onChildAdded, onChildChanged, onChildRemoved, push, serverTimestamp, onDisconnect, update, increment, off, query, orderByChild, orderByKey, equalTo, limitToLast, limitToFirst, endBefore, runTransaction } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";

// ── Debug logging (set to true during development only) ──
const DEBUG = false;

const FIREBASE_CONFIG = { apiKey: "AIzaSyCAqrHPZxtvIlMrF6O3AIeWPRWdG-mkKKI", authDomain: "golex-51625.firebaseapp.com", databaseURL: "https://golex-51625-default-rtdb.firebaseio.com", projectId: "golex-51625", storageBucket: "golex-51625.firebasestorage.app", messagingSenderId: "526349915922", appId: "1:526349915922:web:0e8968d99f9dd423b345cb" };
/* ── Debug logging — set _LOG=true locally to re-enable ── */
const _LOG = false;
const log = (...a) => _LOG && console.log(...a);
const CONFIG = { MAX_IMAGE_KB:400, MAX_FILE_KB:500, MAX_AUDIO_SECONDS:60, MAX_IMAGE_DIMENSION:800, JPEG_QUALITY:0.6, MAX_TAGS:10, MIN_USERNAME_LENGTH:3, MAX_USERNAME_LENGTH:24, TYPING_TIMEOUT:1500, TOAST_DURATION:2800, MESSAGE_LIMIT:200, DEBOUNCE_MS:150, SCROLL_THRESHOLD:100, PFP_COOLDOWN_DAYS:10, PFP_MAX_KB:200, PFP_DIMENSION:256, HEARTBEAT_INTERVAL:30000, PRESENCE_TIMEOUT:90000 };
const EPHEMERAL_CONFIG = { TTL:{ image:24*60*60*1000, file:48*60*60*1000, audio:12*60*60*1000, text:30*24*60*60*1000 }, CLEANUP_COOLDOWN:60*1000, WARNING_THRESHOLD:0.25, CRITICAL_THRESHOLD:0.10 };
const PREDEFINED_SKILLS = ['Gamer','Editor','Designer','Coder','Writer','Artist','Musician','Marketer','Animator','Photographer','Streamer','Explorer'];
const cleanupTimestamps = new Map();


const fbApp = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(fbApp);
const db   = getDatabase(fbApp);

// ── Expose Firebase bindings and config constants to window ──
Object.assign(window, {
  auth, db,
  ref, get, set, remove, onValue, onChildAdded, onChildChanged, onChildRemoved,
  push, serverTimestamp, onDisconnect, update, increment, off, query,
  orderByChild, orderByKey, equalTo, limitToLast, endBefore, runTransaction,
  signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut,
  deleteUser, reauthenticateWithPopup,
  FIREBASE_CONFIG, CONFIG, EPHEMERAL_CONFIG, PREDEFINED_SKILLS, cleanupTimestamps,
  DEBUG, _LOG, log,
  USER_CACHE_TTL: 5 * 60 * 1000,
  USER_CACHE_MAX: 500
});
