const { state, $, $$, escHtml, db, ref, get, set, remove, push, serverTimestamp,
  CONFIG, Toast, ScreenManager, openUserProfileSheet } = window;

/* ══════════════════════════════════════════
   FEATURE 2 — PERMANENT PORTFOLIO LAYER
   ══════════════════════════════════════════ */

let _portfolioEditingCardId = null;
let _portfolioModalTags     = [];
let _portfolioTargetUid     = null;

function openPortfolioModal(cardData) {
  _portfolioModalTags     = cardData ? (cardData.tags || []) : [];
  _portfolioEditingCardId = cardData ? (cardData.cardId || null) : null;

  document.getElementById('portfolio-modal-title').textContent = cardData ? 'Edit Work' : 'Add Work';
  document.getElementById('portfolio-title-input').value  = cardData ? (cardData.title || '') : '';
  document.getElementById('portfolio-desc-input').value   = cardData ? (cardData.desc  || '') : '';
  document.getElementById('portfolio-media-input').value  = cardData ? (cardData.media || '') : '';
  document.getElementById('portfolio-modal-error').style.display = 'none';
  _renderPortfolioModalTags();
  document.getElementById('portfolio-modal-overlay').style.display = 'block';
}

function closePortfolioModal() {
  document.getElementById('portfolio-modal-overlay').style.display = 'none';
  _portfolioEditingCardId = null;
  _portfolioModalTags     = [];
}

function _renderPortfolioModalTags() {
  const wrap = document.getElementById('portfolio-modal-tags-display');
  if (!wrap) return;
  wrap.innerHTML = _portfolioModalTags.map((t, i) =>
    `<span style="font-size:11px;font-family:var(--font-mono);background:rgba(35, 87, 232, 0.12);color:var(--accent-light);border-radius:var(--radius-pill);padding:3px 8px;display:flex;align-items:center;gap:4px;">
      ${escHtml(t)}
      <button type="button" onclick="_removePortfolioTag(${i})"
        style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:12px;line-height:1;padding:0;"><i data-lucide="x" class="lucide" width="12" height="12"></i></button>
    </span>`
  ).join('');
}

window._removePortfolioTag = function(i) {
  _portfolioModalTags.splice(i, 1);
  _renderPortfolioModalTags();
};

document.getElementById('portfolio-tag-add-btn')?.addEventListener('click', () => {
  const inp = document.getElementById('portfolio-tag-input');
  const val = inp.value.trim();
  if (!val || _portfolioModalTags.length >= 4) return;
  if (_portfolioModalTags.includes(val)) { inp.value = ''; return; }
  _portfolioModalTags.push(val);
  inp.value = '';
  _renderPortfolioModalTags();
});

document.getElementById('portfolio-tag-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); document.getElementById('portfolio-tag-add-btn').click(); }
});

document.getElementById('portfolio-modal-close')?.addEventListener('click', closePortfolioModal);
document.getElementById('portfolio-modal-overlay')?.addEventListener('click', (e) => {
  if (e.target === document.getElementById('portfolio-modal-overlay')) closePortfolioModal();
});

document.getElementById('portfolio-save-btn')?.addEventListener('click', async () => {
  const title = document.getElementById('portfolio-title-input').value.trim();
  const desc  = document.getElementById('portfolio-desc-input').value.trim();
  const media = document.getElementById('portfolio-media-input').value.trim();
  const errEl = document.getElementById('portfolio-modal-error');

  if (!title) { errEl.textContent = 'Title is required.'; errEl.style.display = 'block'; return; }
  if (!state.currentUser) { errEl.textContent = 'Not logged in.'; errEl.style.display = 'block'; return; }
  errEl.style.display = 'none';

  const saveBtn = document.getElementById('portfolio-save-btn');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  try {
    const uid    = state.currentUser.uid;
    const cardId = _portfolioEditingCardId || push(ref(db, `users/${uid}/portfolio`)).key;
    const cardData = {
      cardId,
      title,
      desc,
      media,
      tags: _portfolioModalTags,
      updatedAt: Date.now(),
    };
    if (!_portfolioEditingCardId) cardData.createdAt = Date.now();

    await set(ref(db, `users/${uid}/portfolio/${cardId}`), cardData);
    closePortfolioModal();
    // Reload portfolio in the sheet
    if (_portfolioTargetUid === uid) _loadPortfolio(uid, true);
  } catch(e) {
    DEBUG && console.error('[Portfolio] Save error:', e);
    errEl.textContent = 'Save failed. Try again.';
    errEl.style.display = 'block';
  } finally {
    saveBtn.disabled = false;
    saveBtn.innerHTML = '<i data-lucide="save" class="lucide" width="16" height="16"></i> Save';
  }
});

async function _loadPortfolio(uid, isOwnProfile) {
  const listEl  = document.getElementById('ups-portfolio-list');
  const emptyEl = document.getElementById('ups-portfolio-empty');
  const addWrap = document.getElementById('ups-add-work-wrap');
  if (!listEl) return;

  listEl.innerHTML = '<div style="font-size:12px;color:var(--muted);padding:8px 4px;">Loading…</div>';
  if (emptyEl) emptyEl.style.display = 'none';
  if (addWrap) addWrap.style.display = isOwnProfile ? 'block' : 'none';

  try {
    const snap = await get(ref(db, `users/${uid}/portfolio`));
    listEl.innerHTML = '';

    if (!snap.exists()) {
      if (emptyEl) emptyEl.style.display = 'block';
      return;
    }

    const cards = [];
    snap.forEach(c => cards.push(c.val()));
    cards.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    cards.forEach(card => {
      const el = document.createElement('div');
      el.className = 'portfolio-card';
      const tagsHtml = (card.tags || []).map(t => `<span class="portfolio-card-tag">${escHtml(t)}</span>`).join('');
      const linkHtml = card.media
        ? `<a class="portfolio-card-link" href="${escHtml(card.media)}" target="_blank" rel="noopener noreferrer"><i data-lucide="link" class="lucide" width="12" height="12"></i> ${escHtml(card.media.length > 40 ? card.media.slice(0,40)+'…' : card.media)}</a>`
        : '';
      const actionsHtml = isOwnProfile
        ? `<div class="portfolio-card-actions">
            <button class="portfolio-card-edit-btn" data-cardid="${escHtml(card.cardId)}"><i data-lucide="pencil" class="lucide" width="16" height="16"></i></button>
            <button class="portfolio-card-del-btn"  data-cardid="${escHtml(card.cardId)}"><i data-lucide="trash-2" class="lucide" width="16" height="16"></i></button>
           </div>`
        : '';
      el.innerHTML = `
        ${actionsHtml}
        <div class="portfolio-card-title">${escHtml(card.title)}</div>
        ${card.desc ? `<div class="portfolio-card-desc">${escHtml(card.desc)}</div>` : ''}
        ${linkHtml}
        ${tagsHtml ? `<div class="portfolio-card-tags">${tagsHtml}</div>` : ''}
      `;
      if (isOwnProfile) {
        el.querySelector('.portfolio-card-edit-btn')?.addEventListener('click', () => openPortfolioModal(card));
        el.querySelector('.portfolio-card-del-btn')?.addEventListener('click', async () => {
          if (!confirm('Delete this portfolio entry?')) return;
          await remove(ref(db, `users/${uid}/portfolio/${card.cardId}`));
          _loadPortfolio(uid, true);
        });
      }
      listEl.appendChild(el);
    });

    if (cards.length === 0 && emptyEl) emptyEl.style.display = 'block';

  } catch(e) {
    DEBUG && console.error('[Portfolio] Load error:', e);
    listEl.innerHTML = '<div style="font-size:12px;color:var(--muted);padding:8px 4px;">Could not load portfolio.</div>';
  }
}

// Wire up "Add Work" button
document.getElementById('ups-add-work-btn')?.addEventListener('click', () => {
  openPortfolioModal(null);
});

// Wire up profile tab switching (Posts ↔ Work)
document.getElementById('ups-tab-bar')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.ups-tab-btn');
  if (!btn) return;
  const tab = btn.dataset.upstab;
  document.querySelectorAll('.ups-tab-btn').forEach(b => {
    b.classList.remove('active');
    b.style.borderBottomColor = 'transparent';
    b.style.color = 'var(--muted)';
  });
  btn.classList.add('active');
  btn.style.borderBottomColor = 'var(--accent)';
  btn.style.color = 'var(--text)';

  const postsSection = document.querySelector('.ups-posts-section');
  const workPanel    = document.getElementById('ups-work-panel');

  if (tab === 'work') {
    if (postsSection) postsSection.style.display = 'none';
    if (workPanel)    workPanel.style.display = 'block';
    if (_portfolioTargetUid) {
      const isOwn = state.currentUser && _portfolioTargetUid === state.currentUser.uid;
      _loadPortfolio(_portfolioTargetUid, isOwn);
    }
  } else {
    if (postsSection) postsSection.style.display = '';
    if (workPanel)    workPanel.style.display = 'none';
  }
});

function closeUserProfileSheet() {
  document.getElementById('user-profile-sheet').classList.remove('active');
  _upsCurrentUid = null;
  _portfolioTargetUid = null;
}

document.getElementById('ups-close').addEventListener('click', closeUserProfileSheet);
document.getElementById('user-profile-sheet').addEventListener('click', (e) => {
  if (e.target === document.getElementById('user-profile-sheet')) closeUserProfileSheet();
});


// ── Export to window ──
Object.assign(window, { openPortfolioModal, closePortfolioModal });
