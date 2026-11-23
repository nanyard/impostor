import {
  DELIBERATION_MS,
  MIN_PLAYERS,
  finalizeRound,
  formatTime,
  getImpostorCount,
  pickWord,
  selectImpostors,
  selectTarget,
  validateWordData,
} from './game.js';

const STORAGE_KEY = 'impostor.game.v1';
const ALLOWED_PHASES = new Set(['setup', 'pass', 'reveal', 'deliberation', 'vote', 'result']);

let wordData = null;
let state = null;
let revealPlayerId = null;
let selectedVoteId = null;
let categoryDraft = new Set();
let confirmAction = null;
let timerInterval = null;
let toastTimeout = null;
let wakeLock = null;
let lastFocusedElement = null;
let storageWarningShown = false;
const els = {};

const ELEMENT_IDS = [
  'roundBadge',
  'newGameBtn',
  'screen-loading',
  'screen-error',
  'errorMessage',
  'retryBtn',
  'screen-setup',
  'playerCount',
  'addPlayerForm',
  'playerNameInput',
  'playerList',
  'playerHint',
  'categorySummary',
  'openCategoriesBtn',
  'startGameBtn',
  'screen-pass',
  'passRound',
  'passProgress',
  'passPercent',
  'passProgressBar',
  'passList',
  'readyBlock',
  'startDiscussionBtn',
  'screen-reveal',
  'revealRound',
  'revealPlayerName',
  'roleCard',
  'hideRoleBtn',
  'screen-deliberation',
  'deliberationRound',
  'timerRing',
  'timerText',
  'deliberationCategory',
  'voteNowBtn',
  'screen-vote',
  'voteRound',
  'voteGrid',
  'voteSelection',
  'confirmVoteBtn',
  'skipRoundBtn',
  'screen-result',
  'resultRound',
  'resultHero',
  'resultDetails',
  'scoreboardRound',
  'scoreboardList',
  'nextRoundBtn',
  'categoryModal',
  'closeCategoriesBtn',
  'categoryList',
  'categoryError',
  'selectAllCategoriesBtn',
  'clearAllCategoriesBtn',
  'saveCategoriesBtn',
  'confirmModal',
  'confirmTitle',
  'confirmMessage',
  'confirmCancelBtn',
  'confirmOkBtn',
  'toast',
];

init();

async function init() {
  cacheElements();
  bindEvents();
  showScreen('loading');

  try {
    wordData = validateWordData(await loadWordData());
    const saved = readSavedState();
    state = saved ? normalizeState(saved) : createInitialState();
    sanitizeState();
    saveState();
    render();
  } catch (error) {
    renderError(error);
  }
}

function cacheElements() {
  for (const id of ELEMENT_IDS) {
    els[id] = document.getElementById(id);
  }
}

function bindEvents() {
  els.addPlayerForm?.addEventListener('submit', handleAddPlayer);
  els.playerList?.addEventListener('click', handleRemovePlayer);
  els.startGameBtn?.addEventListener('click', startGame);

  els.openCategoriesBtn?.addEventListener('click', openCategories);
  els.closeCategoriesBtn?.addEventListener('click', closeCategories);
  els.selectAllCategoriesBtn?.addEventListener('click', selectAllCategories);
  els.clearAllCategoriesBtn?.addEventListener('click', clearAllCategories);
  els.saveCategoriesBtn?.addEventListener('click', saveCategories);
  els.categoryList?.addEventListener('change', handleCategoryChange);

  els.passList?.addEventListener('click', handlePassSelect);
  els.startDiscussionBtn?.addEventListener('click', startDeliberation);
  els.hideRoleBtn?.addEventListener('click', hideRole);
  els.voteNowBtn?.addEventListener('click', confirmVoteNow);
  els.voteGrid?.addEventListener('click', handleVoteSelect);
  els.confirmVoteBtn?.addEventListener('click', confirmVote);
  els.skipRoundBtn?.addEventListener('click', confirmSkipRound);
  els.nextRoundBtn?.addEventListener('click', nextRound);
  els.newGameBtn?.addEventListener('click', confirmNewGame);
  els.retryBtn?.addEventListener('click', () => window.location.reload());

  els.confirmCancelBtn?.addEventListener('click', cancelConfirm);
  els.confirmOkBtn?.addEventListener('click', runConfirmAction);
  document
    .querySelector('[data-close-confirm]')
    ?.addEventListener('click', cancelConfirm);
  document
    .querySelector('[data-close-categories]')
    ?.addEventListener('click', closeCategories);

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (els.confirmModal && !els.confirmModal.hidden) {
      cancelConfirm();
    } else if (els.categoryModal && !els.categoryModal.hidden) {
      closeCategories();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state?.phase === 'deliberation') {
      tickTimer();
      requestWakeLock();
    }
  });
}

async function loadWordData() {
  const response = await fetch('./data/words.json', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Could not load data/words.json (HTTP ${response.status}).`);
  }
  return response.json();
}

function createInitialState() {
  return {
    version: 1,
    phase: 'setup',
    players: [],
    settings: { categoryIds: allCategoryIds() },
    roundNumber: 1,
    playedRounds: 0,
    usedWords: [],
    hintUsage: {},
    currentRound: null,
    history: [],
  };
}

function readSavedState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (!saved || saved.version !== 1) return null;
    return saved;
  } catch {
    return null;
  }
}

function normalizeState(saved) {
  const base = createInitialState();
  const normalized = {
    ...base,
    ...saved,
    settings: { ...base.settings, ...(saved.settings ?? {}) },
    players: Array.isArray(saved.players) ? saved.players.map(normalizePlayer) : [],
    usedWords: Array.isArray(saved.usedWords) ? saved.usedWords.filter((key) => typeof key === 'string') : [],
    hintUsage:
      saved.hintUsage && typeof saved.hintUsage === 'object' ? { ...saved.hintUsage } : {},
    history: Array.isArray(saved.history) ? saved.history : [],
  };

  if (!ALLOWED_PHASES.has(normalized.phase)) normalized.phase = 'setup';
  if (!Number.isFinite(normalized.roundNumber) || normalized.roundNumber < 1) {
    normalized.roundNumber = 1;
  }
  if (!Number.isFinite(normalized.playedRounds) || normalized.playedRounds < 0) {
    normalized.playedRounds = 0;
  }

  if (normalized.phase !== 'setup') {
    if (normalized.players.length < MIN_PLAYERS || !normalized.currentRound) {
      normalized.phase = 'setup';
      normalized.currentRound = null;
      return normalized;
    }

    if (normalized.phase === 'reveal') normalized.phase = 'pass';
    if (!Array.isArray(normalized.currentRound.seenIds)) normalized.currentRound.seenIds = [];
    if (!Array.isArray(normalized.currentRound.impostorIds)) normalized.currentRound.impostorIds = [];
    if (typeof normalized.currentRound.timerEndsAt !== 'number') {
      normalized.currentRound.timerEndsAt = null;
    }

    if (normalized.phase === 'deliberation') {
      if (!normalized.currentRound.timerEndsAt) {
        normalized.currentRound.timerEndsAt = Date.now() + DELIBERATION_MS;
      } else if (normalized.currentRound.timerEndsAt <= Date.now()) {
        normalized.phase = 'vote';
      }
    }

    if (normalized.phase === 'vote' && !normalized.currentRound) {
      normalized.phase = 'pass';
    }
    if (normalized.phase === 'result' && !normalized.currentRound.result) {
      normalized.phase = 'vote';
    }
  } else {
    normalized.currentRound = null;
  }

  return normalized;
}

function normalizePlayer(player) {
  return {
    id: typeof player?.id === 'string' && player.id ? player.id : uid(),
    name: typeof player?.name === 'string' ? player.name.slice(0, 20) : 'Player',
    score: Number.isFinite(player?.score) ? player.score : 0,
    streak: Number.isFinite(player?.streak) ? player.streak : 0,
    cooldown: Number.isFinite(player?.cooldown) ? player.cooldown : 0,
    lastImpostorRound:
      Number.isFinite(player?.lastImpostorRound) ? player.lastImpostorRound : null,
  };
}

function sanitizeState() {
  const validIds = new Set(allCategoryIds());
  const ids = Array.isArray(state.settings.categoryIds)
    ? state.settings.categoryIds.filter((id) => validIds.has(id))
    : [];
  state.settings.categoryIds = ids.length ? ids : allCategoryIds();
}

function saveState() {
  if (!state) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    if (!storageWarningShown) {
      storageWarningShown = true;
      showToast('Progress could not be saved on this device.', 'error');
    }
  }
}

function allCategoryIds() {
  return wordData ? wordData.categories.map((category) => category.id) : [];
}

function selectedCategories() {
  if (!wordData) return [];
  return wordData.categories.filter((category) =>
    state.settings.categoryIds.includes(category.id),
  );
}

function selectedWordCount() {
  return selectedCategories().reduce((total, category) => total + category.words.length, 0);
}

function getPlayer(playerId) {
  return state?.players.find((player) => player.id === playerId) ?? null;
}

function canStart() {
  return state.players.length >= MIN_PLAYERS && selectedWordCount() > 0;
}

function uid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `p-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function initials(name) {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : parts[0]?.[0] ?? '?').toUpperCase();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return map[character];
  });
}

function showScreen(name) {
  for (const screen of document.querySelectorAll('.screen')) {
    const active = screen.id === `screen-${name}`;
    screen.hidden = !active;
    screen.classList.toggle('active', active);
  }
  window.scrollTo(0, 0);
}

function updateHeader() {
  const inGame = Boolean(
    state && !['setup', 'loading', 'error'].includes(state.phase),
  );
  if (els.roundBadge) {
    els.roundBadge.hidden = !inGame;
    if (inGame) els.roundBadge.textContent = `Round ${state.roundNumber}`;
  }
  if (els.newGameBtn) els.newGameBtn.hidden = !inGame;
}

function render() {
  if (!state) return;
  stopTimerInterval();
  if (state.phase !== 'deliberation') releaseWakeLock();
  updateHeader();

  switch (state.phase) {
    case 'setup':
      renderSetup();
      break;
    case 'pass':
      renderPass();
      break;
    case 'reveal':
      renderReveal();
      break;
    case 'deliberation':
      renderDeliberation();
      break;
    case 'vote':
      renderVote();
      break;
    case 'result':
      renderResult();
      break;
    default:
      renderSetup();
  }
}

function renderError(error) {
  stopTimerInterval();
  releaseWakeLock();
  if (els.errorMessage) {
    els.errorMessage.textContent = error?.message || 'An unknown error occurred.';
  }
  if (els.roundBadge) els.roundBadge.hidden = true;
  if (els.newGameBtn) els.newGameBtn.hidden = true;
  showScreen('error');
}

function showToast(message, type = '') {
  if (!els.toast) return;
  window.clearTimeout(toastTimeout);
  els.toast.textContent = message;
  els.toast.className = `toast show${type === 'error' ? ' error' : ''}`;
  toastTimeout = window.setTimeout(() => {
    els.toast.className = 'toast';
  }, 2800);
}

function openModal(modal) {
  if (!modal) return;
  lastFocusedElement = document.activeElement;
  modal.hidden = false;
  updateBodyLock();
  const focusTarget = modal.querySelector('button:not([disabled]), input:not([disabled])');
  window.requestAnimationFrame(() => focusTarget?.focus());
}

function closeModal(modal) {
  if (!modal) return;
  modal.hidden = true;
  updateBodyLock();
  if (lastFocusedElement && typeof lastFocusedElement.focus === 'function') {
    lastFocusedElement.focus();
  }
  lastFocusedElement = null;
}

function updateBodyLock() {
  const anyOpen = document.querySelector('.modal:not([hidden])');
  document.body.classList.toggle('modal-open', Boolean(anyOpen));
}

function showConfirm({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, onConfirm }) {
  els.confirmTitle.textContent = title;
  els.confirmMessage.textContent = message;
  els.confirmOkBtn.textContent = confirmLabel;
  els.confirmCancelBtn.textContent = cancelLabel;
  els.confirmOkBtn.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
  confirmAction = onConfirm;
  openModal(els.confirmModal);
  window.requestAnimationFrame(() => els.confirmCancelBtn.focus());
}

function cancelConfirm() {
  confirmAction = null;
  closeModal(els.confirmModal);
}

function runConfirmAction() {
  const action = confirmAction;
  confirmAction = null;
  closeModal(els.confirmModal);
  if (action) {
    try {
      action();
    } catch (error) {
      showToast(error?.message || 'Something went wrong.', 'error');
    }
  }
}

function renderSetup() {
  const playerTotal = state.players.length;
  const categories = selectedCategories();
  const wordCount = selectedWordCount();

  els.playerCount.textContent = String(playerTotal);
  els.playerList.innerHTML = playerTotal
    ? state.players
        .map(
          (player) => `
            <li class="player-chip">
              <span class="avatar" aria-hidden="true">${escapeHtml(initials(player.name))}</span>
              <span class="player-name">${escapeHtml(player.name)}</span>
              <button class="chip-remove" type="button" data-player-id="${escapeHtml(player.id)}" aria-label="Remove ${escapeHtml(player.name)}">×</button>
            </li>`,
        )
        .join('')
    : '<li class="empty-list">No players yet. Add at least four names.</li>';

  if (playerTotal < MIN_PLAYERS) {
    const remaining = MIN_PLAYERS - playerTotal;
    els.playerHint.textContent = `Add ${remaining} more player${remaining === 1 ? '' : 's'} to begin.`;
    els.playerHint.className = 'hint';
  } else if (wordCount === 0) {
    els.playerHint.textContent = 'Select at least one category with words.';
    els.playerHint.className = 'hint error-text';
  } else {
    els.playerHint.textContent = `${playerTotal} players ready. ${getImpostorCount(playerTotal)} impostor${getImpostorCount(playerTotal) === 1 ? '' : 's'} this game.`;
    els.playerHint.className = 'hint';
  }

  els.categorySummary.textContent = categories.length
    ? `${categories.length} of ${wordData.categories.length} categories • ${wordCount} words`
    : 'No categories selected';

  els.startGameBtn.disabled = !canStart();
  showScreen('setup');
}

function handleAddPlayer(event) {
  event.preventDefault();
  if (state.phase !== 'setup') return;

  const name = els.playerNameInput.value.trim().slice(0, 20);
  if (!name) {
    showToast('Enter a player name first.');
    els.playerNameInput.focus();
    return;
  }

  const duplicate = state.players.some(
    (player) => player.name.toLowerCase() === name.toLowerCase(),
  );
  if (duplicate) {
    showToast('That name is already in the game.');
    els.playerNameInput.select();
    return;
  }

  state.players.push({
    id: uid(),
    name,
    score: 0,
    streak: 0,
    cooldown: 0,
    lastImpostorRound: null,
  });
  els.playerNameInput.value = '';
  saveState();
  renderSetup();
  els.playerNameInput.focus();
}

function handleRemovePlayer(event) {
  const button = event.target.closest('.chip-remove');
  if (!button || state.phase !== 'setup') return;
  state.players = state.players.filter((player) => player.id !== button.dataset.playerId);
  saveState();
  renderSetup();
}

function startGame() {
  if (!canStart()) {
    showToast('Add at least four players and choose a category.', 'error');
    return;
  }

  for (const player of state.players) {
    player.score = 0;
    player.streak = 0;
    player.cooldown = 0;
    player.lastImpostorRound = null;
  }

  state.roundNumber = 1;
  state.playedRounds = 0;
  state.usedWords = [];
  state.hintUsage = {};
  state.history = [];
  state.currentRound = null;
  revealPlayerId = null;
  selectedVoteId = null;

  if (!beginRound()) {
    state.phase = 'setup';
    saveState();
    render();
    return;
  }

  saveState();
  render();
}

function beginRound() {
  try {
    const count = getImpostorCount(state.players.length);
    const { ids, forcedIds } = selectImpostors(state.players, count);

    for (const id of forcedIds) {
      const player = getPlayer(id);
      if (player) {
        player.streak = 0;
        player.cooldown = 0;
      }
    }

    const targetId = selectTarget(state.players, ids);
    if (!targetId) throw new Error('Could not choose an impostor target.');

    const word = pickWord(
      wordData,
      state.settings.categoryIds,
      state.usedWords,
      state.hintUsage,
    );

    if (word.reset) state.usedWords = [];
    state.usedWords.push(word.key);
    state.hintUsage[word.key] = word.nextHintUsage;

    state.currentRound = {
      number: state.roundNumber,
      categoryId: word.categoryId,
      categoryName: word.categoryName,
      word: word.word,
      hints: word.hints,
      hint: word.hint,
      hintIndex: word.hintIndex,
      impostorIds: ids,
      targetId,
      seenIds: [],
      timerEndsAt: null,
      result: null,
      votedOutId: null,
    };
    state.phase = 'pass';
    revealPlayerId = null;
    selectedVoteId = null;
    return true;
  } catch (error) {
    showToast(error?.message || 'Could not start the round.', 'error');
    return false;
  }
}

function openCategories() {
  if (!wordData || state.phase !== 'setup') return;
  categoryDraft = new Set(state.settings.categoryIds);
  renderCategoryList();
  els.categoryError.hidden = true;
  openModal(els.categoryModal);
}

function closeCategories() {
  closeModal(els.categoryModal);
}

function renderCategoryList() {
  els.categoryList.innerHTML = wordData.categories
    .map((category) => {
      const checked = categoryDraft.has(category.id);
      return `
        <label class="category-row${checked ? ' selected' : ''}" data-category-id="${escapeHtml(category.id)}">
          <input type="checkbox" value="${escapeHtml(category.id)}" ${checked ? 'checked' : ''} />
          <span class="category-check" aria-hidden="true"></span>
          <span class="category-info">
            <span class="category-name">${escapeHtml(category.name)}</span>
            <span class="category-word-count">${category.words.length} words</span>
          </span>
        </label>`;
    })
    .join('');
}

function handleCategoryChange(event) {
  const input = event.target.closest('input[type="checkbox"]');
  if (!input) return;
  const categoryId = input.value;
  if (input.checked) {
    categoryDraft.add(categoryId);
  } else {
    categoryDraft.delete(categoryId);
  }
  input.closest('.category-row')?.classList.toggle('selected', input.checked);
  els.categoryError.hidden = true;
}

function selectAllCategories() {
  categoryDraft = new Set(allCategoryIds());
  renderCategoryList();
  els.categoryError.hidden = true;
}

function clearAllCategories() {
  categoryDraft = new Set();
  renderCategoryList();
}

function saveCategories() {
  if (!categoryDraft.size) {
    els.categoryError.hidden = false;
    return;
  }
  state.settings.categoryIds = [...categoryDraft];
  saveState();
  closeCategories();
  renderSetup();
  showToast('Categories saved.');
}

function renderPass() {
  const round = state.currentRound;
  if (!round) {
    state.phase = 'setup';
    saveState();
    render();
    return;
  }

  const seen = new Set(round.seenIds);
  const seenCount = state.players.filter((player) => seen.has(player.id)).length;
  const percent = state.players.length ? Math.round((seenCount / state.players.length) * 100) : 0;
  const allSeen = seenCount === state.players.length;

  els.passRound.textContent = `ROUND ${state.roundNumber}`;
  els.passProgress.textContent = `${seenCount} of ${state.players.length} players have seen their role`;
  els.passPercent.textContent = `${percent}%`;
  els.passProgressBar.style.width = `${percent}%`;

  els.passList.innerHTML = state.players
    .map((player) => {
      const hasSeen = seen.has(player.id);
      return `
        <button class="pass-row${hasSeen ? ' seen' : ''}" type="button" data-player-id="${escapeHtml(player.id)}" ${hasSeen ? 'disabled' : ''}>
          <span class="avatar" aria-hidden="true">${escapeHtml(initials(player.name))}</span>
          <span class="pass-row-main">
            <span class="pass-row-name">${escapeHtml(player.name)}</span>
            <span class="pass-row-status">${hasSeen ? 'Role already seen' : 'Tap to reveal privately'}</span>
          </span>
          <span class="pass-row-action">${hasSeen ? '✓ Seen' : 'Reveal →'}</span>
        </button>`;
    })
    .join('');

  els.readyBlock.hidden = !allSeen;
  showScreen('pass');
}

function handlePassSelect(event) {
  const button = event.target.closest('.pass-row');
  if (!button || button.disabled || state.phase !== 'pass') return;
  const player = getPlayer(button.dataset.playerId);
  if (!player) return;
  revealPlayerId = player.id;
  state.phase = 'reveal';
  saveState();
  render();
}

function renderReveal() {
  const round = state.currentRound;
  const player = getPlayer(revealPlayerId);
  if (!round || !player) {
    revealPlayerId = null;
    state.phase = 'pass';
    saveState();
    render();
    return;
  }

  const isImpostor = round.impostorIds.includes(player.id);
  const target = getPlayer(round.targetId);
  const partnerId = isImpostor
    ? round.impostorIds.find((id) => id !== player.id)
    : null;
  const partner = partnerId ? getPlayer(partnerId) : null;

  els.revealRound.textContent = `ROUND ${state.roundNumber} • ${player.name.toUpperCase()}`;
  els.revealPlayerName.textContent = player.name;
  els.roleCard.className = `role-card ${isImpostor ? 'impostor' : 'innocent'}`;

  if (isImpostor) {
    els.roleCard.innerHTML = `
      <div class="role-card-top">
        <span class="role-badge">IMPOSTOR</span>
        <span class="role-icon" aria-hidden="true">🎭</span>
      </div>
      <p class="role-kicker">Your secret mission</p>
      <h2 class="role-title">Blend in.</h2>
      <p class="role-sub">Get your target voted out without getting caught.</p>
      <div class="info-grid">
        <div class="info-item">
          <span>Category</span>
          <strong>${escapeHtml(round.categoryName)}</strong>
        </div>
        <div class="info-item">
          <span>Shared target</span>
          <strong>${escapeHtml(target?.name ?? 'Unknown')}</strong>
        </div>
      </div>
      <div class="hint-box">
        <span>Hint</span>
        <strong>${escapeHtml(round.hint)}</strong>
      </div>
      ${
        partner
          ? `<div class="partner-note">Fellow impostor: <strong>${escapeHtml(partner.name)}</strong></div>`
          : ''
      }`;
  } else {
    els.roleCard.innerHTML = `
      <div class="role-card-top">
        <span class="role-badge">INNOCENT</span>
        <span class="role-icon" aria-hidden="true">🕵️</span>
      </div>
      <p class="role-kicker">Your secret word</p>
      <h2 class="role-title secret-word">${escapeHtml(round.word)}</h2>
      <div class="category-pill">${escapeHtml(round.categoryName)}</div>
      <p class="role-sub spaced">Give clues that prove you know the word — without making it too easy for the impostor.</p>`;
  }

  showScreen('reveal');
}

function hideRole() {
  const round = state.currentRound;
  if (!round || !revealPlayerId) return;
  if (!round.seenIds.includes(revealPlayerId)) {
    round.seenIds.push(revealPlayerId);
  }
  revealPlayerId = null;
  state.phase = 'pass';
  saveState();
  render();
}

function startDeliberation() {
  const round = state.currentRound;
  if (!round) return;
  if (round.seenIds.length < state.players.length) {
    showToast('Every player needs to see their role first.', 'error');
    return;
  }
  round.timerEndsAt = Date.now() + DELIBERATION_MS;
  state.phase = 'deliberation';
  saveState();
  render();
}

function renderDeliberation() {
  const round = state.currentRound;
  if (!round) {
    state.phase = 'pass';
    saveState();
    render();
    return;
  }

  if (!round.timerEndsAt) {
    round.timerEndsAt = Date.now() + DELIBERATION_MS;
    saveState();
  }

  const remaining = round.timerEndsAt - Date.now();
  if (remaining <= 0) {
    moveToVote(true);
    return;
  }

  els.deliberationRound.textContent = `ROUND ${state.roundNumber} • DELIBERATION`;
  els.deliberationCategory.textContent = round.categoryName;
  updateTimerUI(remaining);
  showScreen('deliberation');
  startTimerInterval();
  requestWakeLock();
}

function startTimerInterval() {
  stopTimerInterval();
  timerInterval = window.setInterval(tickTimer, 250);
}

function stopTimerInterval() {
  if (timerInterval) {
    window.clearInterval(timerInterval);
    timerInterval = null;
  }
}

function tickTimer() {
  if (!state || state.phase !== 'deliberation' || !state.currentRound) return;
  const remaining = Math.max(0, state.currentRound.timerEndsAt - Date.now());
  updateTimerUI(remaining);
  if (remaining <= 0) moveToVote(true);
}

function updateTimerUI(remaining) {
  if (!els.timerRing || !els.timerText) return;
  const clamped = Math.max(0, remaining);
  const display = formatTime(clamped);
  const progress = Math.max(0, Math.min(1, clamped / DELIBERATION_MS));
  els.timerText.textContent = display;
  els.timerRing.style.setProperty('--progress', String(progress));
  els.timerRing.classList.toggle('is-low', clamped <= 30_000);
  els.timerRing.classList.toggle('is-critical', clamped <= 10_000);
  els.timerRing.setAttribute('aria-label', `${display} remaining`);
}

function moveToVote(auto) {
  stopTimerInterval();
  releaseWakeLock();
  state.phase = 'vote';
  selectedVoteId = null;
  saveState();
  render();
  if (auto) showToast("Time's up — cast your vote.");
}

function confirmVoteNow() {
  showConfirm({
    title: 'Vote now?',
    message: 'End the discussion early and move straight to voting.',
    confirmLabel: 'Vote now',
    onConfirm: () => moveToVote(false),
  });
}

async function requestWakeLock() {
  if (wakeLock || !('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch {
    wakeLock = null;
  }
}

async function releaseWakeLock() {
  if (!wakeLock) return;
  const lock = wakeLock;
  wakeLock = null;
  try {
    await lock.release();
  } catch {
    // The browser may already have released it.
  }
}

function renderVote() {
  const round = state.currentRound;
  if (!round) {
    state.phase = 'pass';
    saveState();
    render();
    return;
  }

  if (selectedVoteId && !getPlayer(selectedVoteId)) selectedVoteId = null;
  els.voteRound.textContent = `ROUND ${state.roundNumber} • VOTE`;
  els.voteGrid.innerHTML = state.players
    .map((player) => {
      const selected = selectedVoteId === player.id;
      return `
        <button class="vote-card${selected ? ' selected' : ''}" type="button" data-vote-id="${escapeHtml(player.id)}" aria-pressed="${selected}">
          <span class="vote-avatar" aria-hidden="true">${escapeHtml(initials(player.name))}</span>
          <span class="vote-name">${escapeHtml(player.name)}</span>
          <span class="vote-check" aria-hidden="true">✓</span>
        </button>`;
    })
    .join('');

  const selectedPlayer = selectedVoteId ? getPlayer(selectedVoteId) : null;
  els.voteSelection.textContent = selectedPlayer
    ? `Selected: ${selectedPlayer.name}`
    : 'No player selected yet.';
  els.confirmVoteBtn.disabled = !selectedPlayer;
  showScreen('vote');
}

function handleVoteSelect(event) {
  const button = event.target.closest('.vote-card');
  if (!button || state.phase !== 'vote') return;
  selectedVoteId = button.dataset.voteId;
  const selectedPlayer = getPlayer(selectedVoteId);
  if (!selectedPlayer) return;

  for (const card of els.voteGrid.querySelectorAll('.vote-card')) {
    const isSelected = card.dataset.voteId === selectedVoteId;
    card.classList.toggle('selected', isSelected);
    card.setAttribute('aria-pressed', String(isSelected));
  }
  els.voteSelection.textContent = `Selected: ${selectedPlayer.name}`;
  els.confirmVoteBtn.disabled = false;
}

function confirmVote() {
  const player = getPlayer(selectedVoteId);
  if (!player) {
    showToast('Select a player first.', 'error');
    return;
  }

  showConfirm({
    title: `Vote out ${player.name}?`,
    message: 'Confirm the group’s decision. The result will reveal the roles for this round.',
    confirmLabel: 'Vote out',
    danger: true,
    onConfirm: () => resolveVote(player.id),
  });
}

function resolveVote(playerId) {
  const round = state.currentRound;
  if (!round) return;
  const outcome = finalizeRound(state.players, round, { votedOutId: playerId });
  if (outcome.skipped || !outcome.result) return;

  round.result = outcome.result;
  round.votedOutId = playerId;
  state.playedRounds += 1;
  state.history.push({
    round: state.roundNumber,
    skipped: false,
    votedOutId: playerId,
    caught: outcome.result.caught,
    targetHit: outcome.result.targetHit,
  });
  state.phase = 'result';
  saveState();
  render();
}

function confirmSkipRound() {
  showConfirm({
    title: 'Skip this round?',
    message: 'No points will be awarded and impostor streaks and cooldowns will not change.',
    confirmLabel: 'Skip round',
    danger: true,
    onConfirm: skipRound,
  });
}

function skipRound() {
  const round = state.currentRound;
  if (!round) return;
  finalizeRound(state.players, round, { skipped: true });
  round.result = { skipped: true };
  round.votedOutId = null;
  state.history.push({ round: state.roundNumber, skipped: true });
  state.phase = 'result';
  saveState();
  render();
}

function nextRound() {
  if (state.phase !== 'result') return;
  state.roundNumber += 1;
  state.currentRound = null;
  revealPlayerId = null;
  selectedVoteId = null;
  if (!beginRound()) {
    state.roundNumber -= 1;
    state.phase = 'setup';
    saveState();
    render();
    return;
  }
  saveState();
  render();
}

function confirmNewGame() {
  showConfirm({
    title: 'Start a new game?',
    message: 'Scores and round progress will be cleared. Player names and category settings will be kept.',
    confirmLabel: 'New game',
    danger: true,
    onConfirm: resetToSetup,
  });
}

function resetToSetup() {
  stopTimerInterval();
  releaseWakeLock();
  const players = state.players.map((player) => ({
    ...player,
    score: 0,
    streak: 0,
    cooldown: 0,
    lastImpostorRound: null,
  }));
  const settings = { ...state.settings };
  state = { ...createInitialState(), players, settings };
  revealPlayerId = null;
  selectedVoteId = null;
  saveState();
  render();
}

function renderResult() {
  const round = state.currentRound;
  const result = round?.result;
  if (!round || !result) {
    state.phase = 'vote';
    saveState();
    render();
    return;
  }

  els.resultRound.textContent = `ROUND ${state.roundNumber} • ${result.skipped ? 'SKIPPED' : 'RESULT'}`;
  els.scoreboardRound.textContent = `After round ${state.roundNumber}`;
  els.nextRoundBtn.textContent = 'Next round';

  const sortedPlayers = [...state.players].sort(
    (a, b) => b.score - a.score || a.name.localeCompare(b.name),
  );
  els.scoreboardList.innerHTML = sortedPlayers
    .map(
      (player, index) => `
        <li class="score-row">
          <span class="score-rank">${index + 1}</span>
          <span class="score-name">${escapeHtml(player.name)}</span>
          <span class="score-value">${player.score}</span>
        </li>`,
    )
    .join('');

  if (result.skipped) {
    els.resultHero.innerHTML = `
      <div class="result-hero skipped">
        <span class="result-icon" aria-hidden="true">⏭️</span>
        <p class="eyebrow">ROUND SKIPPED</p>
        <h2>No vote this round</h2>
        <p>No points were awarded. Impostor streaks and cooldowns are unchanged.</p>
      </div>`;
    els.resultDetails.innerHTML = '';
    showScreen('result');
    return;
  }

  const voted = getPlayer(result.votedOutId);
  const target = getPlayer(result.targetId);
  const impostors = state.players.filter((player) =>
    result.impostorIds.includes(player.id),
  );
  const caught = result.caught;
  const targetHit = result.targetHit;
  const heroClass = caught ? 'caught' : 'innocent';
  const icon = caught ? '🎭' : targetHit ? '🎯' : '🕵️';
  const eyebrow = caught
    ? 'IMPOSTOR CAUGHT'
    : targetHit
      ? 'TARGET ELIMINATED'
      : 'INNOCENT ELIMINATED';
  const headline = caught
    ? `${voted?.name ?? 'The impostor'} was ${impostors.length > 1 ? 'an' : 'the'} impostor.`
    : targetHit
      ? `${voted?.name ?? 'The target'} was the target.`
      : `${voted?.name ?? 'The player'} was innocent.`;
  const summary = caught
    ? 'Every innocent player scores 5 points.'
    : targetHit
      ? impostors.length > 1
        ? 'Both impostors score 30 points each.'
        : 'The impostor scores 30 points.'
      : impostors.length > 1
        ? 'Each impostor scores 15 points.'
        : 'The impostor scores 15 points.';

  els.resultHero.innerHTML = `
    <div class="result-hero ${heroClass}">
      <span class="result-icon" aria-hidden="true">${icon}</span>
      <p class="eyebrow">${eyebrow}</p>
      <h2>${escapeHtml(headline)}</h2>
      <p>${summary}</p>
      <span class="result-role ${caught ? 'impostor' : 'innocent'}">${caught ? 'IMPOSTOR' : 'INNOCENT'}</span>
    </div>`;

  const impostorNames = impostors.map((player) => player.name).join(', ');
  const pointsRows = state.players
    .map((player) => {
      const points = result.points?.[player.id] ?? 0;
      const reason = result.reasons?.[player.id] ?? 'No points this round';
      return `
        <div class="points-row">
          <span class="points-name">${escapeHtml(player.name)}</span>
          <span class="points-reason">${escapeHtml(reason)}</span>
          <span class="points-value ${points > 0 ? 'positive' : 'zero'}">${points > 0 ? '+' : ''}${points}</span>
        </div>`;
    })
    .join('');

  els.resultDetails.innerHTML = `
    <div class="card">
      <div class="detail-grid">
        <div class="detail-item">
          <span>Secret word</span>
          <strong>${escapeHtml(result.word)}</strong>
        </div>
        <div class="detail-item">
          <span>Category</span>
          <strong>${escapeHtml(result.categoryName)}</strong>
        </div>
        <div class="detail-item">
          <span>Target</span>
          <strong>${escapeHtml(target?.name ?? 'Unknown')}</strong>
          ${targetHit ? '<em class="badge">Eliminated</em>' : ''}
        </div>
        <div class="detail-item">
          <span>${impostors.length > 1 ? 'Impostors' : 'Impostor'}</span>
          <strong>${escapeHtml(impostorNames)}</strong>
        </div>
      </div>
      <div class="points-list">
        <h3>Points this round</h3>
        ${pointsRows}
      </div>
    </div>`;

  showScreen('result');
}

