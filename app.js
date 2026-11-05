/**
 * CABO SCOREKEEPER — 100% Offline-Capable PWA Application Logic
 * Supports Standard (100 pts) & Speed Mode (50 pts), Dealer rotation,
 * Automatic Cabo Call validation (+10 penalty or 0 pts), "12-12-13-13" rule,
 * Kamikaze exact-threshold reset, full round history editing, and Undo stack.
 */

(function () {
  'use strict';

  const STORAGE_KEY = 'cabo_scorekeeper_state_v1';
  const IDB_NAME = 'CaboScorekeeperDB';
  const IDB_STORE = 'stateStore';

  const PLAYER_COLORS = [
    '#A855F7', // Neon Purple
    '#34D399', // Mint Green
    '#38BDF8', // Sky Blue
    '#F59E0B', // Warm Gold
    '#FB7185', // Coral Rose
    '#C084FC', // Soft Lavender
    '#4ADE80', // Asparagus Green
    '#FBBF24'  // Amber
  ];

  // Default initial state
  function createDefaultState() {
    return {
      phase: 'setup', // 'setup' | 'playing'
      threshold: 100, // 100 (Standard) | 50 (Speed Mode)
      penaltyMode: 'sum_plus_10', // 'sum_plus_10' | 'flat_10'
      moonMode: 'others_plus_50', // 'others_plus_50' | 'minus_50'
      exactResetEnabled: true,    // Kamikaze rule: exact 100 -> 50 (or 50 -> 25)
      initialDealerIndex: 0,
      dealerOffset: 0, // Manual dealer nudge offset
      dismissedGameOver: false,
      players: [
        { id: 'p1', name: 'Player 1', color: PLAYER_COLORS[0] },
        { id: 'p2', name: 'Player 2', color: PLAYER_COLORS[1] },
        { id: 'p3', name: 'Player 3', color: PLAYER_COLORS[2] }
      ],
      rounds: []
      // Each round: { id, roundNumber, caboCallerId: string|'none', rawScores: { [pid]: number }, moonFlags: { [pid]: boolean } }
    };
  }

  let state = createDefaultState();
  let undoStack = [];
  const MAX_UNDO = 25;

  // Modal editing state
  let activeRoundDraft = null;
  // { isEditing: boolean, roundIndex: number, caboCallerId: string, rawScores: {}, moonFlags: {} }

  // =========================================================================
  // LOCAL PERSISTENCE (localStorage + IndexedDB Mirror)
  // =========================================================================

  function saveState(pushUndoSnapshot = false) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (err) {
      console.warn('localStorage write failed:', err);
    }
    saveToIndexedDB(state);
    updateUndoButtonUI();
  }

  function pushUndo() {
    const snapshot = JSON.stringify(state);
    if (undoStack.length > 0 && undoStack[undoStack.length - 1] === snapshot) {
      return;
    }
    undoStack.push(snapshot);
    if (undoStack.length > MAX_UNDO) {
      undoStack.shift();
    }
    updateUndoButtonUI();
  }

  function triggerUndo() {
    if (undoStack.length === 0) return;
    const previousSnapshot = undoStack.pop();
    try {
      state = JSON.parse(previousSnapshot);
      saveState();
      renderApp();
      showToast('↩️ Undid last action');
    } catch (e) {
      console.error('Undo parse error:', e);
    }
  }

  function loadStateFromStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.players) && parsed.players.length >= 2) {
          state = Object.assign(createDefaultState(), parsed);
          return true;
        }
      }
    } catch (e) {
      console.warn('Failed to load state from localStorage:', e);
    }
    return false;
  }

  function openIDB() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        return reject(new Error('IndexedDB not supported'));
      }
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function saveToIndexedDB(data) {
    openIDB()
      .then((db) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(JSON.parse(JSON.stringify(data)), 'latest');
      })
      .catch(() => {});
  }

  function loadFromIndexedDBFallback() {
    return openIDB()
      .then((db) => {
        return new Promise((resolve) => {
          const tx = db.transaction(IDB_STORE, 'readonly');
          const req = tx.objectStore(IDB_STORE).get('latest');
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => resolve(null);
        });
      })
      .catch(() => null);
  }

  // =========================================================================
  // PURE CABO SCORING & CUMULATIVE ENGINE
  // =========================================================================

  /**
   * Computes the round deltas and badge metadata for a single round given raw inputs
   * and current rule settings.
   */
  function evaluateSingleRound(roundInput, players, config) {
    const playerIds = players.map((p) => p.id);
    const caboCallerId = roundInput.caboCallerId;
    const rawScores = roundInput.rawScores || {};
    const moonFlags = roundInput.moonFlags || {};

    // Check if anyone triggered "12-12-13-13" (Shooting the Moon)
    const moonHolders = playerIds.filter((pid) => Boolean(moonFlags[pid]));

    const roundResults = {};
    // Each entry: { raw: number, delta: number, status: 'normal'|'cabo_success'|'cabo_fail'|'moon_winner'|'moon_victim', note: string }

    if (moonHolders.length > 0 && config.moonMode === 'others_plus_50') {
      // Official Cabo 12-12-13-13 rule: holder scores 0, all other players get +50
      playerIds.forEach((pid) => {
        const raw = sanitizeNumber(rawScores[pid], 0);
        if (moonFlags[pid]) {
          roundResults[pid] = {
            raw,
            delta: 0,
            status: 'moon_winner',
            note: '12-12-13-13! (0 pts)'
          };
        } else {
          roundResults[pid] = {
            raw,
            delta: 50,
            status: 'moon_victim',
            note: '+50 (Opponent 12-12-13-13)'
          };
        }
      });

      return {
        results: roundResults,
        caboSucceeded: null,
        hasMoonEvent: true,
        minRawScore: 0
      };
    }

    // Find minimum raw score across all players
    let minRaw = Infinity;
    playerIds.forEach((pid) => {
      const r = sanitizeNumber(rawScores[pid], 0);
      if (r < minRaw) minRaw = r;
    });
    if (!isFinite(minRaw)) minRaw = 0;

    let caboSucceeded = null;
    if (caboCallerId && caboCallerId !== 'none' && playerIds.includes(caboCallerId)) {
      const callerRaw = sanitizeNumber(rawScores[caboCallerId], 0);
      caboSucceeded = callerRaw <= minRaw;
    }

    playerIds.forEach((pid) => {
      const raw = sanitizeNumber(rawScores[pid], 0);
      const hasMoonMinus50 = Boolean(moonFlags[pid]) && config.moonMode === 'minus_50';

      if (hasMoonMinus50) {
        roundResults[pid] = {
          raw,
          delta: -50,
          status: 'moon_winner',
          note: '12-12-13-13 (-50 pts)'
        };
        return;
      }

      if (pid === caboCallerId) {
        if (caboSucceeded) {
          roundResults[pid] = {
            raw,
            delta: 0,
            status: 'cabo_success',
            note: 'CABO ✓ (0 pts)'
          };
        } else {
          const penaltyDelta = config.penaltyMode === 'flat_10' ? 10 : raw + 10;
          roundResults[pid] = {
            raw,
            delta: penaltyDelta,
            status: 'cabo_fail',
            note: config.penaltyMode === 'flat_10' ? 'CABO ✗ (+10)' : `CABO ✗ (${raw}+10)`
          };
        }
      } else {
        roundResults[pid] = {
          raw,
          delta: raw,
          status: 'normal',
          note: ''
        };
      }
    });

    return {
      results: roundResults,
      caboSucceeded,
      hasMoonEvent: moonHolders.length > 0,
      minRawScore: minRaw
    };
  }

  /**
   * Computes the entire game timeline across all rounds, including running cumulative totals,
   * Kamikaze exact-threshold resets (100 -> 50 or 50 -> 25 once per player),
   * warning thresholds, and game-over winner determination.
   */
  function computeGameTimeline(currentState) {
    const players = currentState.players;
    const threshold = Number(currentState.threshold) || 100;
    const resetTarget = Math.floor(threshold / 2); // 50 for Standard 100, 25 for Speed 50
    const warnThreshold = threshold === 100 ? 80 : 38;

    const runningTotals = {};
    const kamikazeUsed = {};
    players.forEach((p) => {
      runningTotals[p.id] = 0;
      kamikazeUsed[p.id] = false;
    });

    const computedRounds = currentState.rounds.map((round, idx) => {
      const evalResult = evaluateSingleRound(round, players, {
        penaltyMode: currentState.penaltyMode,
        moonMode: currentState.moonMode
      });

      const cells = {};
      players.forEach((p) => {
        const pid = p.id;
        const rInfo = evalResult.results[pid];
        let newTotal = runningTotals[pid] + rInfo.delta;
        let triggeredKamikaze = false;

        if (
          currentState.exactResetEnabled &&
          !kamikazeUsed[pid] &&
          newTotal === threshold &&
          rInfo.delta > 0
        ) {
          newTotal = resetTarget;
          kamikazeUsed[pid] = true;
          triggeredKamikaze = true;
        }

        runningTotals[pid] = newTotal;

        cells[pid] = {
          raw: rInfo.raw,
          delta: rInfo.delta,
          status: rInfo.status,
          note: rInfo.note,
          runningTotal: newTotal,
          triggeredKamikaze
        };
      });

      return {
        roundIndex: idx,
        roundNumber: idx + 1,
        caboCallerId: round.caboCallerId,
        caboSucceeded: evalResult.caboSucceeded,
        cells
      };
    });

    // Determine standings, leader(s), and whether threshold is reached/exceeded
    let minTotal = Infinity;
    let maxTotal = -Infinity;
    let isGameOver = false;

    players.forEach((p) => {
      const tot = runningTotals[p.id];
      if (tot < minTotal) minTotal = tot;
      if (tot > maxTotal) maxTotal = tot;
      if (tot >= threshold) {
        isGameOver = true;
      }
    });

    if (!isFinite(minTotal)) minTotal = 0;

    // Sort players by total ascending (lowest score wins in Cabo)
    const rankedPlayers = [...players]
      .map((p) => {
        const total = runningTotals[p.id];
        return {
          ...p,
          total,
          isLeader: currentState.rounds.length > 0 && total === minTotal,
          isWarning: total >= warnThreshold && total < threshold,
          isOverLimit: total >= threshold,
          remainingToLimit: Math.max(0, threshold - total),
          progressPct: Math.min(100, Math.max(0, Math.round((total / threshold) * 100)))
        };
      })
      .sort((a, b) => a.total - b.total);

    const winners = rankedPlayers.filter((p) => p.total === minTotal);

    // Current dealer index rotates automatically each round
    const activeDealerIndex =
      (currentState.initialDealerIndex + currentState.rounds.length + (currentState.dealerOffset || 0)) %
      Math.max(1, players.length);

    return {
      computedRounds,
      runningTotals,
      rankedPlayers,
      winners,
      minTotal,
      isGameOver,
      threshold,
      warnThreshold,
      activeDealerIndex,
      activeDealer: players[activeDealerIndex] || players[0]
    };
  }

  // =========================================================================
  // DOM REFERENCES & UI RENDERING
  // =========================================================================

  const dom = {
    setupView: document.getElementById('setupView'),
    gameView: document.getElementById('gameView'),
    stickyBottomBar: document.getElementById('stickyBottomBar'),
    headerSubtitle: document.getElementById('headerSubtitle'),
    btnUndo: document.getElementById('btnUndo'),
    btnRulesModal: document.getElementById('btnRulesModal'),
    btnGameMenu: document.getElementById('btnGameMenu'),
    brandHomeBtn: document.getElementById('brandHomeBtn'),

    // Setup elements
    setupPlayerCountBadge: document.getElementById('setupPlayerCountBadge'),
    setupPlayersList: document.getElementById('setupPlayersList'),
    newPlayerInput: document.getElementById('newPlayerInput'),
    btnAddPlayer: document.getElementById('btnAddPlayer'),
    modeBtn100: document.getElementById('modeBtn100'),
    modeBtn50: document.getElementById('modeBtn50'),
    penaltyRuleSelector: document.getElementById('penaltyRuleSelector'),
    moonRuleSelector: document.getElementById('moonRuleSelector'),
    toggleExactReset: document.getElementById('toggleExactReset'),
    btnStartGame: document.getElementById('btnStartGame'),

    // Game view elements
    currentRoundBadge: document.getElementById('currentRoundBadge'),
    currentLimitBadge: document.getElementById('currentLimitBadge'),
    activeDealerName: document.getElementById('activeDealerName'),
    btnRotateDealerManual: document.getElementById('btnRotateDealerManual'),
    gameOverBanner: document.getElementById('gameOverBanner'),
    winnerHeadline: document.getElementById('winnerHeadline'),
    winnerSubtext: document.getElementById('winnerSubtext'),
    winnerPodiumList: document.getElementById('winnerPodiumList'),
    btnRematchSamePlayers: document.getElementById('btnRematchSamePlayers'),
    btnContinueAnyway: document.getElementById('btnContinueAnyway'),
    standingsCardsRow: document.getElementById('standingsCardsRow'),
    totalRoundsPlayedBadge: document.getElementById('totalRoundsPlayedBadge'),
    scoreMatrixTable: document.getElementById('scoreMatrixTable'),
    matrixThead: document.getElementById('matrixThead'),
    matrixTbody: document.getElementById('matrixTbody'),
    matrixTfoot: document.getElementById('matrixTfoot'),
    matrixEmptyState: document.getElementById('matrixEmptyState'),
    btnOpenRoundEntry: document.getElementById('btnOpenRoundEntry'),
    btnOpenRoundEntryText: document.getElementById('btnOpenRoundEntryText'),

    // Round Entry Modal
    roundEntryModal: document.getElementById('roundEntryModal'),
    roundModalEyebrow: document.getElementById('roundModalEyebrow'),
    roundModalTitle: document.getElementById('roundModalTitle'),
    btnDeleteRound: document.getElementById('btnDeleteRound'),
    btnCloseRoundModal: document.getElementById('btnCloseRoundModal'),
    btnCancelRoundModal: document.getElementById('btnCancelRoundModal'),
    callerSelectionGrid: document.getElementById('callerSelectionGrid'),
    callerStatusHint: document.getElementById('callerStatusHint'),
    roundPlayersEntryList: document.getElementById('roundPlayersEntryList'),
    caboValidationBanner: document.getElementById('caboValidationBanner'),
    btnSaveRound: document.getElementById('btnSaveRound'),
    btnSaveRoundText: document.getElementById('btnSaveRoundText'),

    // Rules Modal
    rulesModal: document.getElementById('rulesModal'),
    btnCloseRulesModal: document.getElementById('btnCloseRulesModal'),

    // Game Menu Modal
    gameMenuModal: document.getElementById('gameMenuModal'),
    btnCloseGameMenu: document.getElementById('btnCloseGameMenu'),
    midGameThresholdToggle: document.getElementById('midGameThresholdToggle'),
    btnMenuRematch: document.getElementById('btnMenuRematch'),
    btnMenuNewSetup: document.getElementById('btnMenuNewSetup'),

    // Toast & Offline Status
    toastContainer: document.getElementById('toastContainer'),
    offlineStatusText: document.getElementById('offlineStatusText')
  };

  function renderApp() {
    updateUndoButtonUI();

    if (state.phase === 'setup') {
      dom.setupView.hidden = false;
      dom.setupView.classList.add('active');
      dom.gameView.hidden = true;
      dom.stickyBottomBar.hidden = true;
      dom.btnGameMenu.hidden = true;
      dom.headerSubtitle.textContent = 'Card Game Scorekeeper';
      renderSetupView();
    } else {
      dom.setupView.hidden = true;
      dom.setupView.classList.remove('active');
      dom.gameView.hidden = false;
      dom.stickyBottomBar.hidden = false;
      dom.btnGameMenu.hidden = false;
      const modeName = state.threshold === 50 ? 'Speed Mode (50 pts)' : 'Standard (100 pts)';
      dom.headerSubtitle.textContent = `${modeName} • ${state.players.length} Players`;
      renderGameView();
    }
  }

  function updateUndoButtonUI() {
    dom.btnUndo.hidden = undoStack.length === 0;
  }

  // =========================================================================
  // SETUP VIEW RENDERING & INTERACTIONS
  // =========================================================================

  function renderSetupView() {
    dom.setupPlayerCountBadge.textContent = `${state.players.length} Player${state.players.length === 1 ? '' : 's'}`;

    // Render player rows
    dom.setupPlayersList.innerHTML = '';
    state.players.forEach((player, idx) => {
      const isStarter = idx === state.initialDealerIndex;
      const row = document.createElement('div');
      row.className = 'player-setup-row';
      row.setAttribute('role', 'listitem');

      const avatar = document.createElement('div');
      avatar.className = 'player-avatar-dot';
      avatar.style.backgroundColor = player.color || PLAYER_COLORS[idx % PLAYER_COLORS.length];
      avatar.textContent = (player.name || `P${idx + 1}`).trim().charAt(0).toUpperCase();

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'player-name-edit-input';
      input.value = player.name;
      input.placeholder = `Player ${idx + 1}`;
      input.maxLength = 18;
      input.setAttribute('aria-label', `Player ${idx + 1} Name`);
      input.addEventListener('input', (e) => {
        player.name = e.target.value;
        avatar.textContent = (player.name || `P${idx + 1}`).trim().charAt(0).toUpperCase();
        saveState();
      });
      input.addEventListener('blur', () => {
        if (!player.name.trim()) {
          player.name = `Player ${idx + 1}`;
          input.value = player.name;
          avatar.textContent = player.name.charAt(0).toUpperCase();
          saveState();
        }
      });

      const dealerBtn = document.createElement('button');
      dealerBtn.type = 'button';
      dealerBtn.className = `btn-dealer-select ${isStarter ? 'is-dealer' : ''}`;
      dealerBtn.innerHTML = isStarter ? '🃏 Dealer R1' : 'Set Dealer';
      dealerBtn.title = 'Select who deals Round 1';
      dealerBtn.addEventListener('click', () => {
        state.initialDealerIndex = idx;
        saveState();
        renderSetupView();
      });

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'btn-remove-player';
      removeBtn.disabled = state.players.length <= 2;
      removeBtn.title = state.players.length <= 2 ? 'Minimum 2 players required' : `Remove ${player.name}`;
      removeBtn.setAttribute('aria-label', `Remove ${player.name}`);
      removeBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      `;
      removeBtn.addEventListener('click', () => {
        if (state.players.length <= 2) return;
        pushUndo();
        state.players.splice(idx, 1);
        if (state.initialDealerIndex >= state.players.length) {
          state.initialDealerIndex = 0;
        }
        saveState();
        renderSetupView();
      });

      row.appendChild(avatar);
      row.appendChild(input);
      row.appendChild(dealerBtn);
      row.appendChild(removeBtn);
      dom.setupPlayersList.appendChild(row);
    });

    // Threshold mode buttons
    const is50 = Number(state.threshold) === 50;
    dom.modeBtn100.classList.toggle('active', !is50);
    dom.modeBtn100.setAttribute('aria-checked', String(!is50));
    dom.modeBtn50.classList.toggle('active', is50);
    dom.modeBtn50.setAttribute('aria-checked', String(is50));

    // Penalty rule buttons
    dom.penaltyRuleSelector.querySelectorAll('.seg-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.penaltyMode === state.penaltyMode);
    });

    // Moon rule buttons
    dom.moonRuleSelector.querySelectorAll('.seg-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.moonMode === state.moonMode);
    });

    // Exact reset checkbox
    dom.toggleExactReset.checked = Boolean(state.exactResetEnabled);
  }

  function addNewPlayerFromInput() {
    if (state.players.length >= 8) {
      showToast('Maximum 8 players supported');
      return;
    }
    const rawName = dom.newPlayerInput.value.trim();
    const nextIdx = state.players.length + 1;
    const name = rawName || `Player ${nextIdx}`;
    const color = PLAYER_COLORS[(nextIdx - 1) % PLAYER_COLORS.length];

    pushUndo();
    state.players.push({
      id: 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      name,
      color
    });
    dom.newPlayerInput.value = '';
    saveState();
    renderSetupView();
  }

  // =========================================================================
  // GAME VIEW RENDERING (STANDINGS, WINNER BANNER, ROUND MATRIX)
  // =========================================================================

  function renderGameView() {
    const timeline = computeGameTimeline(state);

    // Top status bar
    const nextRoundNum = state.rounds.length + 1;
    dom.currentRoundBadge.textContent = timeline.isGameOver ? 'FINAL' : String(nextRoundNum);
    dom.currentLimitBadge.textContent = `${timeline.threshold} pts`;
    dom.activeDealerName.textContent = timeline.activeDealer ? timeline.activeDealer.name : 'Player 1';
    dom.totalRoundsPlayedBadge.textContent = `${state.rounds.length} Round${state.rounds.length === 1 ? '' : 's'}`;

    // Bottom sticky action button text
    if (timeline.isGameOver) {
      dom.btnOpenRoundEntryText.textContent = `Add Extra Round ${nextRoundNum}`;
    } else {
      dom.btnOpenRoundEntryText.textContent = `Enter Round ${nextRoundNum} Scores`;
    }

    // Winner Celebration Banner
    if (timeline.isGameOver && !state.dismissedGameOver) {
      dom.gameOverBanner.hidden = false;
      const winnerNames = timeline.winners.map((w) => w.name).join(' & ');
      dom.winnerHeadline.textContent =
        timeline.winners.length > 1 ? `Tie! ${winnerNames} Win!` : `${winnerNames} Wins!`;
      dom.winnerSubtext.textContent = `Lowest cumulative score with ${timeline.minTotal} points (Threshold: ${timeline.threshold} pts)`;

      dom.winnerPodiumList.innerHTML = '';
      timeline.rankedPlayers.forEach((p, rankIdx) => {
        const row = document.createElement('div');
        row.className = `podium-row ${p.total === timeline.minTotal ? 'rank-1' : ''}`;
        const medal = p.total === timeline.minTotal ? '🏆' : rankIdx === 1 ? '🥈' : rankIdx === 2 ? '🥉' : '•';
        const statusNote = p.isOverLimit ? ' (Busted Limit)' : '';
        row.innerHTML = `
          <div class="podium-left">
            <span>${medal}</span>
            <span>${escapeHtml(p.name)}<small style="color:var(--text-secondary)">${statusNote}</small></span>
          </div>
          <span class="podium-score">${p.total} pts</span>
        `;
        dom.winnerPodiumList.appendChild(row);
      });
    } else {
      dom.gameOverBanner.hidden = true;
    }

    // Render Live Player Standings Cards
    dom.standingsCardsRow.innerHTML = '';
    state.players.forEach((player, idx) => {
      const rankedInfo = timeline.rankedPlayers.find((r) => r.id === player.id) || {
        total: 0,
        isLeader: false,
        isWarning: false,
        isOverLimit: false,
        remainingToLimit: timeline.threshold,
        progressPct: 0
      };
      const isDealer = idx === timeline.activeDealerIndex;

      const card = document.createElement('div');
      card.className = [
        'player-standing-card',
        rankedInfo.isLeader ? 'is-leader' : '',
        rankedInfo.isWarning ? 'is-warning' : '',
        rankedInfo.isOverLimit ? 'is-over-limit' : ''
      ]
        .filter(Boolean)
        .join(' ');

      let badgesHtml = '';
      if (isDealer) {
        badgesHtml += `<span class="mini-badge badge-dealer" title="Current Round Dealer">🃏 Dealer</span>`;
      }
      if (rankedInfo.isOverLimit) {
        badgesHtml += `<span class="mini-badge badge-danger">≥${timeline.threshold}!</span>`;
      } else if (rankedInfo.isWarning) {
        badgesHtml += `<span class="mini-badge badge-danger">Near Limit</span>`;
      } else if (rankedInfo.isLeader) {
        badgesHtml += `<span class="mini-badge badge-leader">★ Leader</span>`;
      }

      let barColor = player.color || '#A855F7';
      if (rankedInfo.isOverLimit) barColor = '#F43F5E';
      else if (rankedInfo.isWarning) barColor = '#F59E0B';
      else if (rankedInfo.isLeader) barColor = '#10B981';

      const remainingText = rankedInfo.isOverLimit
        ? `Over by ${rankedInfo.total - timeline.threshold} pts`
        : `${rankedInfo.remainingToLimit} pts to ${timeline.threshold}`;

      card.innerHTML = `
        <div class="standing-top-row">
          <div class="standing-player-identity">
            <span class="standing-dot" style="background:${player.color}"></span>
            <span class="standing-name">${escapeHtml(player.name)}</span>
          </div>
          <div class="standing-badges">${badgesHtml}</div>
        </div>
        <div class="standing-score-row">
          <span class="standing-total-pts">${rankedInfo.total}</span>
          <span class="standing-pts-remaining">${remainingText}</span>
        </div>
        <div class="threshold-progress-track">
          <div class="threshold-progress-fill" style="width:${rankedInfo.progressPct}%; background:${barColor}"></div>
        </div>
      `;

      dom.standingsCardsRow.appendChild(card);
    });

    // Render Round-by-Round Score Matrix Table
    renderScoreMatrix(timeline);
  }

  function renderScoreMatrix(timeline) {
    const hasRounds = timeline.computedRounds.length > 0;
    dom.matrixEmptyState.hidden = hasRounds;
    dom.scoreMatrixTable.hidden = !hasRounds;

    if (!hasRounds) return;

    // 1. Table Header (Columns = Players)
    let theadHtml = `<tr><th class="col-round-hdr">Rnd</th>`;
    state.players.forEach((p) => {
      theadHtml += `
        <th>
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color};margin-right:5px;"></span>
          ${escapeHtml(p.name)}
        </th>
      `;
    });
    theadHtml += `</tr>`;
    dom.matrixThead.innerHTML = theadHtml;

    // 2. Table Body (Rows = Rounds)
    dom.matrixTbody.innerHTML = '';
    timeline.computedRounds.forEach((cRound) => {
      const tr = document.createElement('tr');
      tr.className = 'matrix-round-row';
      tr.title = `Tap to edit Round ${cRound.roundNumber}`;
      tr.addEventListener('click', () => {
        openRoundEntryModal(cRound.roundIndex);
      });

      let rowHtml = `
        <td class="cell-round-num">
          #${cRound.roundNumber}<span class="round-edit-pencil">✎</span>
        </td>
      `;

      state.players.forEach((p) => {
        const cell = cRound.cells[p.id];
        let deltaClass = '';
        let badgeExtra = '';

        if (cell.triggeredKamikaze) {
          deltaClass = 'delta-kamikaze';
          badgeExtra = `<span class="cell-tag-mini" style="color:var(--accent-gold-bright)">💥 RESET→${cell.runningTotal}</span>`;
        } else if (cell.status === 'cabo_success') {
          deltaClass = 'delta-cabo-success';
          badgeExtra = `<span class="cell-tag-mini" style="color:var(--accent-green-bright)">📣 CABO ✓</span>`;
        } else if (cell.status === 'cabo_fail') {
          deltaClass = 'delta-cabo-fail';
          badgeExtra = `<span class="cell-tag-mini" style="color:var(--accent-danger-bright)">📣 +10 PEN</span>`;
        } else if (cell.status === 'moon_winner' || cell.status === 'moon_victim') {
          deltaClass = 'delta-moon';
          badgeExtra =
            cell.status === 'moon_winner'
              ? `<span class="cell-tag-mini" style="color:var(--accent-purple-bright)">🦄 12-13x2</span>`
              : `<span class="cell-tag-mini" style="color:var(--accent-purple-bright)">+50 MOON</span>`;
        }

        const formattedDelta = cell.delta > 0 ? `+${cell.delta}` : String(cell.delta);

        rowHtml += `
          <td class="matrix-score-cell">
            <div class="cell-inner">
              <span class="cell-round-delta ${deltaClass}">${formattedDelta}</span>
              ${badgeExtra}
              <span class="cell-running-total">∑ ${cell.runningTotal}</span>
            </div>
          </td>
        `;
      });

      tr.innerHTML = rowHtml;
      dom.matrixTbody.appendChild(tr);
    });

    // 3. Table Footer (Running Cumulative Totals)
    let tfootHtml = `<tr><td class="tfoot-label">Total</td>`;
    state.players.forEach((p) => {
      const total = timeline.runningTotals[p.id];
      const isLeader = total === timeline.minTotal;
      const isOver = total >= timeline.threshold;
      let colorStyle = 'color: var(--text-primary);';
      if (isOver) colorStyle = 'color: var(--accent-danger-bright);';
      else if (isLeader) colorStyle = 'color: var(--accent-green-bright);';

      tfootHtml += `<td style="${colorStyle}">${total}</td>`;
    });
    tfootHtml += `</tr>`;
    dom.matrixTfoot.innerHTML = tfootHtml;
  }

  // =========================================================================
  // ROUND SCORE ENTRY & EDIT MODAL
  // =========================================================================

  function openRoundEntryModal(editRoundIndex = null) {
    const isEditing = editRoundIndex !== null && editRoundIndex >= 0 && editRoundIndex < state.rounds.length;
    const roundNumber = isEditing ? editRoundIndex + 1 : state.rounds.length + 1;

    if (isEditing) {
      const existing = state.rounds[editRoundIndex];
      activeRoundDraft = {
        isEditing: true,
        roundIndex: editRoundIndex,
        roundNumber,
        caboCallerId: existing.caboCallerId || state.players[0].id,
        rawScores: Object.assign({}, existing.rawScores),
        moonFlags: Object.assign({}, existing.moonFlags)
      };
    } else {
      const defaultRaw = {};
      const defaultMoon = {};
      state.players.forEach((p) => {
        defaultRaw[p.id] = 0;
        defaultMoon[p.id] = false;
      });
      activeRoundDraft = {
        isEditing: false,
        roundIndex: state.rounds.length,
        roundNumber,
        caboCallerId: state.players[0].id,
        rawScores: defaultRaw,
        moonFlags: defaultMoon
      };
    }

    dom.roundModalEyebrow.textContent = isEditing ? `EDITING HISTORY` : `END OF ROUND`;
    dom.roundModalTitle.textContent = `Round ${roundNumber} Scoring`;
    dom.btnSaveRoundText.textContent = isEditing ? `Update Round ${roundNumber}` : `Save Round ${roundNumber}`;
    dom.btnDeleteRound.hidden = !isEditing;

    renderRoundModalContent();
    dom.roundEntryModal.hidden = false;
  }

  function closeRoundEntryModal() {
    dom.roundEntryModal.hidden = true;
    activeRoundDraft = null;
  }

  function renderRoundModalContent() {
    if (!activeRoundDraft) return;

    // 1. Render Cabo Caller Pills
    dom.callerSelectionGrid.innerHTML = '';
    state.players.forEach((player) => {
      const isSelected = activeRoundDraft.caboCallerId === player.id;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `caller-pill-btn ${isSelected ? 'active' : ''}`;
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', String(isSelected));
      btn.innerHTML = `
        <span style="width:8px;height:8px;border-radius:50%;background:${player.color};flex-shrink:0;"></span>
        <span>${escapeHtml(player.name)}</span>
      `;
      btn.addEventListener('click', () => {
        activeRoundDraft.caboCallerId = player.id;
        renderRoundModalContent();
      });
      dom.callerSelectionGrid.appendChild(btn);
    });

    // Also include "No Caller (Deck Empty)" option
    const noCallerSelected = activeRoundDraft.caboCallerId === 'none';
    const noCallerBtn = document.createElement('button');
    noCallerBtn.type = 'button';
    noCallerBtn.className = `caller-pill-btn ${noCallerSelected ? 'active' : ''}`;
    noCallerBtn.innerHTML = `<span>🃏 Deck Empty</span>`;
    noCallerBtn.title = 'Draw pile ran out before anyone called Cabo';
    noCallerBtn.addEventListener('click', () => {
      activeRoundDraft.caboCallerId = 'none';
      renderRoundModalContent();
    });
    dom.callerSelectionGrid.appendChild(noCallerBtn);

    // 2. Evaluate live preview
    const liveEval = evaluateSingleRound(activeRoundDraft, state.players, {
      penaltyMode: state.penaltyMode,
      moonMode: state.moonMode
    });

    // 3. Render Player Score Cards
    dom.roundPlayersEntryList.innerHTML = '';
    state.players.forEach((player) => {
      const pid = player.id;
      const isCaller = activeRoundDraft.caboCallerId === pid;
      const isMoon = Boolean(activeRoundDraft.moonFlags[pid]);
      const rawVal = sanitizeNumber(activeRoundDraft.rawScores[pid], 0);
      const pEval = liveEval.results[pid];

      const card = document.createElement('div');
      card.className = [
        'player-entry-card',
        isCaller ? 'is-cabo-caller' : '',
        isMoon ? 'is-moon-active' : ''
      ]
        .filter(Boolean)
        .join(' ');

      let calcBadgeClass = '';
      if (pEval.status === 'cabo_success') calcBadgeClass = 'calc-zero';
      else if (pEval.status === 'cabo_fail') calcBadgeClass = 'calc-penalty';
      else if (pEval.status === 'moon_winner' || pEval.status === 'moon_victim') calcBadgeClass = 'calc-moon';

      const deltaSign = pEval.delta > 0 ? `+${pEval.delta}` : String(pEval.delta);
      const calcText = pEval.note ? `${pEval.note} → ${deltaSign}` : `Round: ${deltaSign} pts`;

      card.innerHTML = `
        <div class="entry-card-top">
          <div class="entry-player-info">
            <span class="standing-dot" style="background:${player.color}"></span>
            <span class="entry-player-name">${escapeHtml(player.name)}</span>
            ${isCaller ? `<span class="entry-caller-tag">📣 CABO CALLER</span>` : ''}
          </div>
          <span class="entry-calc-pill ${calcBadgeClass}" data-calc-pill="${pid}">${calcText}</span>
        </div>

        <div class="entry-controls-row">
          <div class="stepper-group">
            <button type="button" class="btn-stepper" data-step="-5" aria-label="Decrease by 5">-5</button>
            <button type="button" class="btn-stepper" data-step="-1" aria-label="Decrease by 1">-1</button>
            <input
              type="number"
              inputmode="numeric"
              min="0"
              max="99"
              class="raw-score-input"
              value="${rawVal}"
              aria-label="Raw card sum for ${escapeHtml(player.name)}"
            />
            <button type="button" class="btn-stepper" data-step="1" aria-label="Increase by 1">+1</button>
            <button type="button" class="btn-stepper" data-step="5" aria-label="Increase by 5">+5</button>
          </div>
        </div>

        <div class="entry-bottom-modifiers">
          <div class="quick-chips-row">
            <button type="button" class="btn-quick-val" data-preset="0">0</button>
            <button type="button" class="btn-quick-val" data-preset="2">2</button>
            <button type="button" class="btn-quick-val" data-preset="5">5</button>
            <button type="button" class="btn-quick-val" data-preset="10">10</button>
            <button type="button" class="btn-quick-val" data-preset="15">15</button>
          </div>
          <button type="button" class="btn-moon-toggle ${isMoon ? 'active' : ''}" title="Player holds 12-12-13-13 at end of round">
            <span>🦄 12-12-13-13</span>
            <span>${isMoon ? 'ON' : 'OFF'}</span>
          </button>
        </div>
      `;

      // Wire up input & stepper events without losing focus
      const numInput = card.querySelector('.raw-score-input');
      numInput.addEventListener('focus', () => numInput.select());
      numInput.addEventListener('input', (e) => {
        const val = sanitizeNumber(e.target.value, 0);
        activeRoundDraft.rawScores[pid] = Math.max(0, Math.min(120, val));
        updateLiveModalEvaluationOnly();
      });

      card.querySelectorAll('.btn-stepper').forEach((stepBtn) => {
        stepBtn.addEventListener('click', () => {
          const step = Number(stepBtn.dataset.step);
          const nextVal = Math.max(0, Math.min(120, sanitizeNumber(activeRoundDraft.rawScores[pid], 0) + step));
          activeRoundDraft.rawScores[pid] = nextVal;
          numInput.value = nextVal;
          updateLiveModalEvaluationOnly();
        });
      });

      card.querySelectorAll('.btn-quick-val').forEach((presetBtn) => {
        presetBtn.addEventListener('click', () => {
          const preset = Number(presetBtn.dataset.preset);
          activeRoundDraft.rawScores[pid] = preset;
          numInput.value = preset;
          updateLiveModalEvaluationOnly();
        });
      });

      const moonBtn = card.querySelector('.btn-moon-toggle');
      moonBtn.addEventListener('click', () => {
        const nextMoon = !activeRoundDraft.moonFlags[pid];
        // Usually only 1 player can hold both 12s and both 13s in a single deck
        if (nextMoon) {
          state.players.forEach((other) => {
            activeRoundDraft.moonFlags[other.id] = false;
          });
          activeRoundDraft.moonFlags[pid] = true;
          activeRoundDraft.rawScores[pid] = 50; // 12+12+13+13 = 50 raw card sum
        } else {
          activeRoundDraft.moonFlags[pid] = false;
        }
        renderRoundModalContent();
      });

      dom.roundPlayersEntryList.appendChild(card);
    });

    updateValidationBannerUI(liveEval);
  }

  /**
   * Lightweight update of calculated pills & validation banner during typing so input focus is preserved.
   */
  function updateLiveModalEvaluationOnly() {
    if (!activeRoundDraft) return;
    const liveEval = evaluateSingleRound(activeRoundDraft, state.players, {
      penaltyMode: state.penaltyMode,
      moonMode: state.moonMode
    });

    state.players.forEach((player) => {
      const pid = player.id;
      const pEval = liveEval.results[pid];
      const pill = dom.roundPlayersEntryList.querySelector(`[data-calc-pill="${pid}"]`);
      if (!pill) return;

      pill.className = 'entry-calc-pill';
      if (pEval.status === 'cabo_success') pill.classList.add('calc-zero');
      else if (pEval.status === 'cabo_fail') pill.classList.add('calc-penalty');
      else if (pEval.status === 'moon_winner' || pEval.status === 'moon_victim') pill.classList.add('calc-moon');

      const deltaSign = pEval.delta > 0 ? `+${pEval.delta}` : String(pEval.delta);
      pill.textContent = pEval.note ? `${pEval.note} → ${deltaSign}` : `Round: ${deltaSign} pts`;
    });

    updateValidationBannerUI(liveEval);
  }

  function updateValidationBannerUI(liveEval) {
    if (!activeRoundDraft) return;
    const caller = state.players.find((p) => p.id === activeRoundDraft.caboCallerId);

    if (liveEval.hasMoonEvent) {
      const moonPlayer = state.players.find((p) => activeRoundDraft.moonFlags[p.id]);
      dom.caboValidationBanner.className = 'cabo-validation-preview preview-moon';
      dom.caboValidationBanner.innerHTML = `
        <span>🦄</span>
        <div>
          <strong>"12-12-13-13" Rule Active for ${escapeHtml(moonPlayer ? moonPlayer.name : 'Player')}!</strong><br/>
          ${
            state.moonMode === 'others_plus_50'
              ? `${escapeHtml(moonPlayer ? moonPlayer.name : 'Player')} scores <strong>0 pts</strong> and all other players receive <strong>+50 pts</strong>.`
              : `${escapeHtml(moonPlayer ? moonPlayer.name : 'Player')} receives a <strong>-50 pts</strong> bonus deduction.`
          }
        </div>
      `;
      dom.callerStatusHint.textContent = '12-12-13-13 Override';
      return;
    }

    if (!caller) {
      dom.caboValidationBanner.className = 'cabo-validation-preview';
      dom.caboValidationBanner.innerHTML = `
        <span>🃏</span>
        <div>
          <strong>Deck Empty (No Cabo Caller):</strong> All players simply score the raw sum of their cards.
        </div>
      `;
      dom.callerStatusHint.textContent = 'No Caller';
      return;
    }

    const callerRaw = sanitizeNumber(activeRoundDraft.rawScores[caller.id], 0);
    if (liveEval.caboSucceeded) {
      dom.caboValidationBanner.className = 'cabo-validation-preview preview-success';
      dom.caboValidationBanner.innerHTML = `
        <span>✅</span>
        <div>
          <strong>${escapeHtml(caller.name)}'s Cabo Call Succeeded!</strong><br/>
          Raw card sum (${callerRaw}) is lowest (or tied lowest). ${escapeHtml(caller.name)} scores <strong>0 points</strong> this round!
        </div>
      `;
      dom.callerStatusHint.textContent = 'Call Succeeded (0 pts)';
    } else {
      const penResult = liveEval.results[caller.id].delta;
      dom.caboValidationBanner.className = 'cabo-validation-preview preview-fail';
      dom.caboValidationBanner.innerHTML = `
        <span>⚠️</span>
        <div>
          <strong>${escapeHtml(caller.name)}'s Cabo Call Failed!</strong><br/>
          Another player had a strictly lower card sum (${liveEval.minRawScore} vs ${callerRaw}). Penalty applied: <strong>+${penResult} points</strong>!
        </div>
      `;
      dom.callerStatusHint.textContent = `Call Failed (+${penResult} pts)`;
    }
  }

  function saveActiveRoundDraft() {
    if (!activeRoundDraft) return;
    pushUndo();

    const roundRecord = {
      id: 'rnd_' + Date.now(),
      roundNumber: activeRoundDraft.roundNumber,
      caboCallerId: activeRoundDraft.caboCallerId,
      rawScores: Object.assign({}, activeRoundDraft.rawScores),
      moonFlags: Object.assign({}, activeRoundDraft.moonFlags)
    };

    if (activeRoundDraft.isEditing) {
      state.rounds[activeRoundDraft.roundIndex] = roundRecord;
      showToast(`Updated Round ${activeRoundDraft.roundNumber}`);
    } else {
      state.rounds.push(roundRecord);
      state.dismissedGameOver = false;
      showToast(`Saved Round ${activeRoundDraft.roundNumber} • Dealer rotated`);
    }

    closeRoundEntryModal();
    saveState();
    renderApp();
  }

  function deleteActiveRound() {
    if (!activeRoundDraft || !activeRoundDraft.isEditing) return;
    const rNum = activeRoundDraft.roundNumber;
    pushUndo();
    state.rounds.splice(activeRoundDraft.roundIndex, 1);
    closeRoundEntryModal();
    saveState();
    renderApp();
    showToast(`Deleted Round ${rNum}`);
  }

  // =========================================================================
  // HELPERS & EVENT LISTENERS
  // =========================================================================

  function sanitizeNumber(val, fallback = 0) {
    const parsed = parseInt(val, 10);
    return Number.isNaN(parsed) ? fallback : parsed;
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'toast-msg';
    toast.textContent = message;
    dom.toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.25s ease';
      setTimeout(() => toast.remove(), 260);
    }, 2400);
  }

  function bindEvents() {
    // Setup Events
    dom.btnAddPlayer.addEventListener('click', addNewPlayerFromInput);
    dom.newPlayerInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addNewPlayerFromInput();
      }
    });

    dom.modeBtn100.addEventListener('click', () => {
      state.threshold = 100;
      saveState();
      renderSetupView();
    });

    dom.modeBtn50.addEventListener('click', () => {
      state.threshold = 50;
      saveState();
      renderSetupView();
    });

    dom.penaltyRuleSelector.querySelectorAll('.seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.penaltyMode = btn.dataset.penaltyMode;
        saveState();
        renderSetupView();
      });
    });

    dom.moonRuleSelector.querySelectorAll('.seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.moonMode = btn.dataset.moonMode;
        saveState();
        renderSetupView();
      });
    });

    dom.toggleExactReset.addEventListener('change', (e) => {
      state.exactResetEnabled = e.target.checked;
      saveState();
    });

    dom.btnStartGame.addEventListener('click', () => {
      // Ensure all player names are non-empty
      state.players.forEach((p, idx) => {
        if (!p.name || !p.name.trim()) {
          p.name = `Player ${idx + 1}`;
        } else {
          p.name = p.name.trim();
        }
      });
      pushUndo();
      state.phase = 'playing';
      state.dismissedGameOver = false;
      saveState();
      renderApp();
    });

    // Header Actions
    dom.btnUndo.addEventListener('click', triggerUndo);

    dom.btnRulesModal.addEventListener('click', () => {
      dom.rulesModal.hidden = false;
    });
    dom.btnCloseRulesModal.addEventListener('click', () => {
      dom.rulesModal.hidden = true;
    });
    dom.rulesModal.addEventListener('click', (e) => {
      if (e.target === dom.rulesModal) dom.rulesModal.hidden = true;
    });

    // Game Menu Modal
    dom.btnGameMenu.addEventListener('click', () => {
      dom.midGameThresholdToggle.querySelectorAll('.seg-btn').forEach((b) => {
        b.classList.toggle('active', Number(b.dataset.midThreshold) === Number(state.threshold));
      });
      dom.gameMenuModal.hidden = false;
    });
    dom.btnCloseGameMenu.addEventListener('click', () => {
      dom.gameMenuModal.hidden = true;
    });
    dom.gameMenuModal.addEventListener('click', (e) => {
      if (e.target === dom.gameMenuModal) dom.gameMenuModal.hidden = true;
    });

    dom.midGameThresholdToggle.querySelectorAll('.seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        pushUndo();
        state.threshold = Number(btn.dataset.midThreshold);
        state.dismissedGameOver = false;
        saveState();
        dom.midGameThresholdToggle.querySelectorAll('.seg-btn').forEach((b) => {
          b.classList.toggle('active', Number(b.dataset.midThreshold) === Number(state.threshold));
        });
        renderApp();
        showToast(`Switched limit to ${state.threshold} pts`);
      });
    });

    dom.btnMenuRematch.addEventListener('click', () => {
      pushUndo();
      state.rounds = [];
      state.dismissedGameOver = false;
      state.initialDealerIndex = (state.initialDealerIndex + 1) % state.players.length;
      state.dealerOffset = 0;
      dom.gameMenuModal.hidden = true;
      saveState();
      renderApp();
      showToast('Scores reset for new match!');
    });

    dom.btnMenuNewSetup.addEventListener('click', () => {
      pushUndo();
      state.phase = 'setup';
      state.rounds = [];
      state.dismissedGameOver = false;
      dom.gameMenuModal.hidden = true;
      saveState();
      renderApp();
    });

    // Game View Interactions
    dom.btnRotateDealerManual.addEventListener('click', () => {
      state.dealerOffset = ((state.dealerOffset || 0) + 1) % state.players.length;
      saveState();
      renderGameView();
      const timeline = computeGameTimeline(state);
      showToast(`🃏 Dealer rotated to ${timeline.activeDealer.name}`);
    });

    dom.btnOpenRoundEntry.addEventListener('click', () => {
      openRoundEntryModal(null);
    });

    dom.btnRematchSamePlayers.addEventListener('click', () => {
      pushUndo();
      state.rounds = [];
      state.dismissedGameOver = false;
      state.initialDealerIndex = (state.initialDealerIndex + 1) % state.players.length;
      state.dealerOffset = 0;
      saveState();
      renderApp();
      showToast('New match started!');
    });

    dom.btnContinueAnyway.addEventListener('click', () => {
      state.dismissedGameOver = true;
      saveState();
      renderGameView();
    });

    // Round Entry Modal Actions
    dom.btnCloseRoundModal.addEventListener('click', closeRoundEntryModal);
    dom.btnCancelRoundModal.addEventListener('click', closeRoundEntryModal);
    dom.roundEntryModal.addEventListener('click', (e) => {
      if (e.target === dom.roundEntryModal) closeRoundEntryModal();
    });
    dom.btnSaveRound.addEventListener('click', saveActiveRoundDraft);
    dom.btnDeleteRound.addEventListener('click', deleteActiveRound);

    // Offline / Online connectivity status listener
    function updateConnectivityBadge() {
      if (navigator.onLine) {
        dom.offlineStatusText.textContent = 'Offline Ready';
      } else {
        dom.offlineStatusText.textContent = 'Offline Mode';
      }
    }
    window.addEventListener('online', updateConnectivityBadge);
    window.addEventListener('offline', updateConnectivityBadge);
    updateConnectivityBadge();
  }

  // =========================================================================
  // SERVICE WORKER REGISTRATION & INITIALIZATION
  // =========================================================================

  function registerPWA() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker
          .register('./sw.js', { scope: './' })
          .catch((err) => {
            console.warn('Service Worker registration skipped or failed:', err);
          });
      });
    }
  }

  async function init() {
    const loadedSync = loadStateFromStorage();
    if (!loadedSync) {
      const idbData = await loadFromIndexedDBFallback();
      if (idbData && Array.isArray(idbData.players)) {
        state = Object.assign(createDefaultState(), idbData);
      }
    }
    bindEvents();
    renderApp();
    registerPWA();
  }

  init();
})();
