const { state, $, $$, escHtml, badgeHTML, generateAvatarUrl, timeAgo, debounce,
  compressProfilePicture, getProfilePicUrl, canChangePfp, updatePfpUI,
  auth, db, ref, get, set, update, serverTimestamp,
  CONFIG, PREDEFINED_SKILLS, Toast, ScreenManager,
  ExpertiseModule, SocialIntegrationsModule,
  normalizeSocialIntegrations, getEmptySocialIntegrations } = window;

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

// ── Export to window ──
Object.assign(window, {
  checkProfileBanner, openProfileModal, triggerPfpChange
});
