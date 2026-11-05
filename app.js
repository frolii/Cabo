/**
 * CABO SALON-PUNKTEBUCH — Vintage-Buchseiten & Kartenbraun Edition (Deutsch)
 *
 * 100 % kompatibel mit:
 * - GitHub Pages (Unterordner wie /cabo-scorekeeper/)
 * - Netlify / Vercel (Root /)
 * - Lokalem Öffnen per Doppelklick
 *
 * Aktive Cabo-Regeln:
 * 1. Cabo-Ruf: Niedrigste (oder geteilt niedrigste) Kartensumme = 0 Punkte.
 *    Sonst: Eigene Kartensumme + 5 Strafpunkte.
 * 2. 12-13er-Regel (Kamikaze): Hält ein Spieler 12-12-13-13, erhält er 0 Punkte
 *    und alle anderen bekommen +50 Punkte (Standard 100) bzw. +25 Punkte (Speed 50).
 * 3. Exakte Punktlandung: Trifft ein Spieler exakt das Limit (100 bzw. 50),
 *    wird sein Punktestand einmalig pro Partie auf die Hälfte (50 bzw. 25) halbiert.
 */

(function () {
  'use strict';

  const STATE_KEY = 'cabo_vintage_state_v3';
  const STATS_KEY = 'cabo_vintage_stats_v3';
  const ROMAN_NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];

  function createDefaultState() {
    return {
      phase: 'setup', // 'setup' | 'playing'
      threshold: 100, // 100 | 50
      dealerOffset: 0,
      matchRecordedInStats: false,
      players: [
        { id: 'p1', name: 'Spieler 1' },
        { id: 'p2', name: 'Spieler 2' },
        { id: 'p3', name: 'Spieler 3' }
      ],
      rounds: []
    };
  }

  function createDefaultStats() {
    return {
      players: {}, // { [normalizedKey]: { displayName, wins, gamesPlayed } }
      recentMatches: []
    };
  }

  let state = createDefaultState();
  let stats = createDefaultStats();

  // Aktuelle Runden-Eingabe direkt auf dem Hauptblatt
  let currentDraft = {
    caboCallerId: 'p1',
    kamikazeHolderId: null,
    rawScores: {}
  };

  // =========================================================================
  // DATEN LADEN & SPEICHERN (localStorage)
  // =========================================================================

  function loadData() {
    try {
      const rawState = localStorage.getItem(STATE_KEY);
      if (rawState) {
        const parsed = JSON.parse(rawState);
        if (parsed && Array.isArray(parsed.players) && parsed.players.length >= 2) {
          state = Object.assign(createDefaultState(), parsed);
        }
      }
    } catch (e) {
      console.warn('Spielstand konnte nicht geladen werden:', e);
    }

    try {
      const rawStats = localStorage.getItem(STATS_KEY);
      if (rawStats) {
        const parsedStats = JSON.parse(rawStats);
        if (parsedStats && typeof parsedStats.players === 'object') {
          stats = Object.assign(createDefaultStats(), parsedStats);
        }
      }
    } catch (e) {
      console.warn('Statistik konnte nicht geladen werden:', e);
    }

    resetCurrentDraft();
  }

  function saveState() {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify(state));
    } catch (e) {
      console.warn('Spielstand konnte nicht gespeichert werden:', e);
    }
  }

  function saveStats() {
    try {
      localStorage.setItem(STATS_KEY, JSON.stringify(stats));
    } catch (e) {
      console.warn('Statistik konnte nicht gespeichert werden:', e);
    }
  }

  function resetCurrentDraft() {
    const firstId = state.players[0] ? state.players[0].id : null;
    currentDraft = {
      caboCallerId: firstId,
      kamikazeHolderId: null,
      rawScores: {}
    };
    state.players.forEach((p) => {
      currentDraft.rawScores[p.id] = 0;
    });
  }

  // =========================================================================
  // CABO RECHEN- & KAMIKAZE-ENGINE
  // =========================================================================

  function evaluateRound(roundInput, players, threshold) {
    const kamikazePenaltyForOthers = Number(threshold) === 50 ? 25 : 50;
    const playerIds = players.map((p) => p.id);
    const caboCallerId = roundInput.caboCallerId;
    const kamikazeHolderId = roundInput.kamikazeHolderId;
    const rawScores = roundInput.rawScores || {};

    const results = {};

    // 1. Prüfen, ob jemand 12-12-13-13 (Kamikaze) hält
    if (kamikazeHolderId && playerIds.includes(kamikazeHolderId)) {
      playerIds.forEach((pid) => {
        const raw = toInt(rawScores[pid], 0);
        if (pid === kamikazeHolderId) {
          results[pid] = {
            raw,
            delta: 0,
            status: 'kamikaze_winner',
            label: '12-13er · 0 Pkt.'
          };
        } else {
          results[pid] = {
            raw,
            delta: kamikazePenaltyForOthers,
            status: 'kamikaze_victim',
            label: `+${kamikazePenaltyForOthers} (Kamikaze)`
          };
        }
      });

      return {
        results,
        caboSucceeded: null,
        isKamikazeRound: true,
        minRaw: 0
      };
    }

    // 2. Normale Runde: Niedrigste Kartensumme bestimmen
    let minRaw = Infinity;
    playerIds.forEach((pid) => {
      const r = toInt(rawScores[pid], 0);
      if (r < minRaw) minRaw = r;
    });
    if (!isFinite(minRaw)) minRaw = 0;

    let caboSucceeded = false;
    if (caboCallerId && playerIds.includes(caboCallerId)) {
      const callerRaw = toInt(rawScores[caboCallerId], 0);
      caboSucceeded = callerRaw <= minRaw;
    }

    playerIds.forEach((pid) => {
      const raw = toInt(rawScores[pid], 0);
      if (pid === caboCallerId) {
        if (caboSucceeded) {
          results[pid] = {
            raw,
            delta: 0,
            status: 'cabo_success',
            label: 'Cabo ✓ · 0 Pkt.'
          };
        } else {
          const penaltyPts = raw + 5;
          results[pid] = {
            raw,
            delta: penaltyPts,
            status: 'cabo_fail',
            label: `Cabo ✗ · +${penaltyPts} (${raw}+5)`
          };
        }
      } else {
        results[pid] = {
          raw,
          delta: raw,
          status: 'normal',
          label: `+${raw} Pkt.`
        };
      }
    });

    return {
      results,
      caboSucceeded,
      isKamikazeRound: false,
      minRaw
    };
  }

  function computeGameSummary(currentState) {
    const players = currentState.players;
    const threshold = Number(currentState.threshold) || 100;
    const halfThreshold = Math.floor(threshold / 2); // 50 bzw. 25
    const warnLimit = threshold === 100 ? 80 : 38;

    const totals = {};
    const exactResetUsed = {};
    players.forEach((p) => {
      totals[p.id] = 0;
      exactResetUsed[p.id] = false;
    });

    const historyRows = currentState.rounds.map((rnd, idx) => {
      const evalRes = evaluateRound(rnd, players, threshold);
      const perPlayer = {};

      players.forEach((p) => {
        const pid = p.id;
        const rInfo = evalRes.results[pid];
        let newTotal = totals[pid] + rInfo.delta;
        let hitExactReset = false;

        // Einmalige Punktlandung (100 -> 50 bzw. 50 -> 25)
        if (!exactResetUsed[pid] && newTotal === threshold && rInfo.delta > 0) {
          newTotal = halfThreshold;
          exactResetUsed[pid] = true;
          hitExactReset = true;
        }

        totals[pid] = newTotal;
        perPlayer[pid] = {
          delta: rInfo.delta,
          status: rInfo.status,
          totalAfter: newTotal,
          hitExactReset
        };
      });

      return {
        roundNumber: idx + 1,
        perPlayer
      };
    });

    let minTotal = Infinity;
    let isGameOver = false;

    players.forEach((p) => {
      const t = totals[p.id];
      if (t < minTotal) minTotal = t;
      if (t >= threshold) isGameOver = true;
    });
    if (!isFinite(minTotal)) minTotal = 0;

    const standings = [...players]
      .map((p) => ({
        ...p,
        total: totals[p.id],
        isLeader: currentState.rounds.length > 0 && totals[p.id] === minTotal,
        isNearLimit: totals[p.id] >= warnLimit && totals[p.id] < threshold,
        isOverLimit: totals[p.id] >= threshold,
        exactResetUsed: exactResetUsed[p.id],
        progressPct: Math.min(100, Math.max(0, Math.round((totals[p.id] / threshold) * 100)))
      }))
      .sort((a, b) => a.total - b.total);

    const winners = standings.filter((p) => p.total === minTotal);
    const dealerIndex =
      (currentState.rounds.length + (currentState.dealerOffset || 0)) % Math.max(1, players.length);

    return {
      threshold,
      halfThreshold,
      totals,
      exactResetUsed,
      historyRows,
      standings,
      winners,
      minTotal,
      isGameOver,
      dealer: players[dealerIndex] || players[0]
    };
  }

  // =========================================================================
  // EWIGE SIEGES-CHRONIK (STATISTIK)
  // =========================================================================

  function recordMatchInStatistics(summary) {
    if (state.matchRecordedInStats || !summary.isGameOver) return;

    const winnerIds = new Set(summary.winners.map((w) => w.id));

    state.players.forEach((p) => {
      const cleanName = p.name.trim();
      const key = cleanName.toLowerCase();
      if (!stats.players[key]) {
        stats.players[key] = {
          displayName: cleanName,
          wins: 0,
          gamesPlayed: 0
        };
      }
      stats.players[key].displayName = cleanName;
      stats.players[key].gamesPlayed += 1;
      if (winnerIds.has(p.id)) {
        stats.players[key].wins += 1;
      }
    });

    const now = new Date();
    const dateStr = now.toLocaleDateString('de-DE', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });

    stats.recentMatches.unshift({
      id: 'm_' + Date.now(),
      dateStr,
      winnerNames: summary.winners.map((w) => w.name).join(' & '),
      winningScore: summary.minTotal,
      mode: summary.threshold === 50 ? 'Schnellrunde (50)' : 'Klassisch (100)',
      roundsCount: state.rounds.length
    });

    if (stats.recentMatches.length > 15) {
      stats.recentMatches.pop();
    }

    state.matchRecordedInStats = true;
    saveState();
    saveStats();
  }

  function revertLastMatchFromStatistics(previousWinners, playersList) {
    if (!state.matchRecordedInStats) return;

    const winnerIds = new Set(previousWinners.map((w) => w.id));
    playersList.forEach((p) => {
      const key = p.name.trim().toLowerCase();
      const entry = stats.players[key];
      if (entry) {
        entry.gamesPlayed = Math.max(0, entry.gamesPlayed - 1);
        if (winnerIds.has(p.id)) {
          entry.wins = Math.max(0, entry.wins - 1);
        }
        if (entry.gamesPlayed === 0 && entry.wins === 0) {
          delete stats.players[key];
        }
      }
    });

    stats.recentMatches.shift();
    state.matchRecordedInStats = false;
    saveStats();
  }

  // =========================================================================
  // DOM-ELEMENTE & RENDERING
  // =========================================================================

  const dom = {
    setupView: document.getElementById('setupView'),
    gameView: document.getElementById('gameView'),
    headerSubtitle: document.getElementById('headerSubtitle'),
    brandHomeBtn: document.getElementById('brandHomeBtn'),
    btnUndoRound: document.getElementById('btnUndoRound'),
    btnOpenMenu: document.getElementById('btnOpenMenu'),

    // Setup
    playerCountPill: document.getElementById('playerCountPill'),
    setupPlayersList: document.getElementById('setupPlayersList'),
    newPlayerInput: document.getElementById('newPlayerInput'),
    btnAddPlayer: document.getElementById('btnAddPlayer'),
    modeStandardBtn: document.getElementById('modeStandardBtn'),
    modeSpeedBtn: document.getElementById('modeSpeedBtn'),
    btnStartGame: document.getElementById('btnStartGame'),

    // Game View
    roundCounterBadge: document.getElementById('roundCounterBadge'),
    limitCounterBadge: document.getElementById('limitCounterBadge'),
    dealerNameDisplay: document.getElementById('dealerNameDisplay'),
    btnRotateDealer: document.getElementById('btnRotateDealer'),

    gameOverCard: document.getElementById('gameOverCard'),
    winnerTitleText: document.getElementById('winnerTitleText'),
    winnerSubText: document.getElementById('winnerSubText'),
    winnerStandingsList: document.getElementById('winnerStandingsList'),
    btnPlayAgainSame: document.getElementById('btnPlayAgainSame'),
    btnUndoLastFromWinner: document.getElementById('btnUndoLastFromWinner'),
    btnBackToSetupFromWinner: document.getElementById('btnBackToSetupFromWinner'),

    activeRoundInputContainer: document.getElementById('activeRoundInputContainer'),
    ledgerScriptTitle: document.getElementById('ledgerScriptTitle'),
    liveRoundFeedback: document.getElementById('liveRoundFeedback'),
    playerCardsList: document.getElementById('playerCardsList'),
    btnCommitRound: document.getElementById('btnCommitRound'),
    btnCommitRoundText: document.getElementById('btnCommitRoundText'),

    historyAccordion: document.getElementById('historyAccordion'),
    historyCountText: document.getElementById('historyCountText'),
    historyThead: document.getElementById('historyThead'),
    historyTbody: document.getElementById('historyTbody'),

    // Menu & Stats Modal
    menuModal: document.getElementById('menuModal'),
    btnCloseMenu: document.getElementById('btnCloseMenu'),
    menuMode100Btn: document.getElementById('menuMode100Btn'),
    menuMode50Btn: document.getElementById('menuMode50Btn'),
    inGameActionsSection: document.getElementById('inGameActionsSection'),
    btnMenuRestartSame: document.getElementById('btnMenuRestartSame'),
    btnMenuChangePlayers: document.getElementById('btnMenuChangePlayers'),
    btnClearStats: document.getElementById('btnClearStats'),
    leaderboardContainer: document.getElementById('leaderboardContainer'),
    recentMatchesSection: document.getElementById('recentMatchesSection'),
    recentMatchesList: document.getElementById('recentMatchesList'),

    toastContainer: document.getElementById('toastContainer')
  };

  function renderApp() {
    if (state.phase === 'setup') {
      dom.setupView.hidden = false;
      dom.gameView.hidden = true;
      dom.btnUndoRound.hidden = true;
      dom.headerSubtitle.textContent = 'Kamikaze-Regel aktiv';
      renderSetup();
    } else {
      dom.setupView.hidden = true;
      dom.gameView.hidden = false;
      dom.btnUndoRound.hidden = state.rounds.length === 0;
      const modeName = Number(state.threshold) === 50 ? 'Schnellrunde (50)' : 'Klassisch (100)';
      dom.headerSubtitle.textContent = `${modeName} · Kamikaze aktiv`;
      renderGame();
    }
  }

  // =========================================================================
  // SETUP-ANSICHT
  // =========================================================================

  function renderSetup() {
    dom.playerCountPill.textContent = `${state.players.length} Spieler`;
    dom.setupPlayersList.innerHTML = '';

    state.players.forEach((player, idx) => {
      const row = document.createElement('div');
      row.className = 'setup-player-row';

      const roman = document.createElement('span');
      roman.className = 'player-roman-badge';
      roman.textContent = ROMAN_NUMERALS[idx] || String(idx + 1);

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'setup-name-input';
      input.value = player.name;
      input.placeholder = `Spieler ${idx + 1}`;
      input.maxLength = 18;
      input.addEventListener('input', (e) => {
        player.name = e.target.value;
        saveState();
      });
      input.addEventListener('blur', () => {
        if (!player.name.trim()) {
          player.name = `Spieler ${idx + 1}`;
          input.value = player.name;
          saveState();
        }
      });

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'btn-remove-player';
      removeBtn.disabled = state.players.length <= 2;
      removeBtn.title = 'Spieler entfernen';
      removeBtn.textContent = '✕';
      removeBtn.addEventListener('click', () => {
        if (state.players.length <= 2) return;
        state.players.splice(idx, 1);
        saveState();
        renderSetup();
      });

      row.appendChild(roman);
      row.appendChild(input);
      row.appendChild(removeBtn);
      dom.setupPlayersList.appendChild(row);
    });

    const isSpeed = Number(state.threshold) === 50;
    dom.modeStandardBtn.classList.toggle('active', !isSpeed);
    dom.modeSpeedBtn.classList.toggle('active', isSpeed);
  }

  function addPlayerFromSetup() {
    if (state.players.length >= 8) {
      showToast('Maximal 8 Spieler am Tisch möglich');
      return;
    }
    const raw = dom.newPlayerInput.value.trim();
    const nextNum = state.players.length + 1;
    state.players.push({
      id: 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
      name: raw || `Spieler ${nextNum}`
    });
    dom.newPlayerInput.value = '';
    saveState();
    renderSetup();
  }

  // =========================================================================
  // HAUPTSCREEN: PUNKTEBLATT AUF DER BUCHSEITE
  // =========================================================================

  function renderGame() {
    const summary = computeGameSummary(state);

    if (
      !currentDraft.caboCallerId ||
      !state.players.some((p) => p.id === currentDraft.caboCallerId)
    ) {
      currentDraft.caboCallerId = state.players[0].id;
    }

    const nextRoundNum = state.rounds.length + 1;
    dom.roundCounterBadge.textContent = summary.isGameOver
      ? `Beendet (${state.rounds.length} Runden)`
      : `Runde ${nextRoundNum}`;
    dom.limitCounterBadge.textContent = `Ziel: ${summary.threshold} Pkt.`;
    dom.dealerNameDisplay.textContent = summary.dealer ? summary.dealer.name : 'Spieler 1';

    if (summary.isGameOver) {
      recordMatchInStatistics(summary);
      dom.gameOverCard.hidden = false;
      dom.activeRoundInputContainer.hidden = true;

      const winnerNames = summary.winners.map((w) => w.name).join(' & ');
      dom.winnerTitleText.textContent =
        summary.winners.length > 1
          ? `Gleichstand! ${winnerNames}`
          : `${winnerNames} gewinnt!`;
      dom.winnerSubText.textContent = `Niedrigster Gesamtwert mit ${summary.minTotal} Punkten`;

      dom.winnerStandingsList.innerHTML = '';
      summary.standings.forEach((p, idx) => {
        const isFirst = p.total === summary.minTotal;
        const row = document.createElement('div');
        row.className = `winner-rank-row ${isFirst ? 'first-place' : ''}`;
        const placeLabel = isFirst ? '♛' : `${idx + 1}.`;
        row.innerHTML = `
          <span>${placeLabel} ${escapeHtml(p.name)}</span>
          <span>${p.total} Pkt.</span>
        `;
        dom.winnerStandingsList.appendChild(row);
      });
    } else {
      dom.gameOverCard.hidden = true;
      dom.activeRoundInputContainer.hidden = false;
      dom.ledgerScriptTitle.textContent = `Punkteblatt · Runde ${nextRoundNum}`;
      dom.btnCommitRoundText.textContent = `Runde ${nextRoundNum} eintragen`;
      renderLedgerPlayerRows(summary);
    }

    renderHistoryAccordion(summary);
  }

  function renderLedgerPlayerRows(summary) {
    dom.playerCardsList.innerHTML = '';
    const liveEval = evaluateRound(currentDraft, state.players, summary.threshold);

    state.players.forEach((player) => {
      const pid = player.id;
      const standing = summary.standings.find((s) => s.id === pid) || {
        total: 0,
        isLeader: false,
        isNearLimit: false,
        exactResetUsed: false,
        progressPct: 0
      };

      const isCaller = currentDraft.caboCallerId === pid;
      const isKamikaze = currentDraft.kamikazeHolderId === pid;
      const rawVal = toInt(currentDraft.rawScores[pid], 0);
      const pEval = liveEval.results[pid];

      const row = document.createElement('div');
      row.className = [
        'ledger-player-row',
        isCaller ? 'is-caller-row' : '',
        isKamikaze ? 'is-kamikaze-row' : ''
      ]
        .filter(Boolean)
        .join(' ');

      let badgesHtml = '';
      if (standing.isLeader) {
        badgesHtml += `<span class="lrow-mini-badge badge-lead">Führt</span>`;
      }
      if (standing.isNearLimit) {
        badgesHtml += `<span class="lrow-mini-badge badge-near">Nahe ${summary.threshold}</span>`;
      }

      let previewClass = '';
      if (pEval.status === 'cabo_success') previewClass = 'prev-zero';
      else if (pEval.status === 'cabo_fail') previewClass = 'prev-penalty';
      else if (pEval.status === 'kamikaze_winner' || pEval.status === 'kamikaze_victim') {
        previewClass = 'prev-kamikaze';
      }

      const projectedTotal = standing.total + pEval.delta;
      const willHitExactReset =
        !standing.exactResetUsed &&
        projectedTotal === summary.threshold &&
        pEval.delta > 0;

      const previewText = willHitExactReset
        ? `Exakt ${summary.threshold} → ${summary.halfThreshold} Pkt.!`
        : pEval.label;

      let barColor = 'var(--border-gold-line)';
      if (standing.isNearLimit) barColor = 'var(--accent-crimson)';
      else if (standing.isLeader) barColor = 'var(--accent-forest)';

      row.innerHTML = `
        <div class="lrow-top">
          <div class="lrow-headline">
            <div class="lrow-name-wrap">
              <span class="lrow-player-name">${escapeHtml(player.name)}</span>
              ${badgesHtml}
            </div>
            <div class="lrow-scores-right">
              <span class="lrow-round-preview ${previewClass}" data-preview-pill="${pid}">${previewText}</span>
              <span class="lrow-total-score">${standing.total} <small>Pkt.</small></span>
            </div>
          </div>
          <div class="lrow-progress-track">
            <div class="lrow-progress-fill" style="width:${standing.progressPct}%; background:${barColor}"></div>
          </div>
        </div>

        <div class="lrow-controls">
          <div class="stepper-cluster">
            <button type="button" class="ink-step-btn" data-step="-1" aria-label="1 Punkt weniger">−1</button>
            <input
              type="number"
              inputmode="numeric"
              min="0"
              max="99"
              class="ink-score-input"
              value="${rawVal}"
              aria-label="Kartenpunkte für ${escapeHtml(player.name)}"
            />
            <button type="button" class="ink-step-btn" data-step="1" aria-label="1 Punkt mehr">+1</button>
            <button type="button" class="ink-step-btn" data-step="5" aria-label="5 Punkte mehr">+5</button>
          </div>

          <div class="script-toggles-group">
            <button type="button" class="btn-script-seal seal-cabo ${isCaller ? 'active' : ''}" title="Hat dieser Spieler Cabo gerufen?">
              <span>Cabo</span>
            </button>
            <button type="button" class="btn-script-seal seal-kamikaze ${isKamikaze ? 'active' : ''}" title="12-12-13-13 (Kamikaze) auf der Hand">
              <span>12-13er</span>
            </button>
          </div>
        </div>
      `;

      // Zahlenfeld & Stepper
      const inputEl = row.querySelector('.ink-score-input');
      inputEl.addEventListener('focus', () => inputEl.select());
      inputEl.addEventListener('input', (e) => {
        currentDraft.rawScores[pid] = Math.max(0, Math.min(120, toInt(e.target.value, 0)));
        updateLivePreviewsOnly(summary);
      });

      row.querySelectorAll('.ink-step-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const step = Number(btn.dataset.step);
          const nextVal = Math.max(0, Math.min(120, toInt(currentDraft.rawScores[pid], 0) + step));
          currentDraft.rawScores[pid] = nextVal;
          inputEl.value = nextVal;
          updateLivePreviewsOnly(summary);
        });
      });

      // Geschwungener "Cabo"-Button
      row.querySelector('.seal-cabo').addEventListener('click', () => {
        currentDraft.caboCallerId = pid;
        renderLedgerPlayerRows(summary);
      });

      // Geschwungener "12-13er"-Button
      row.querySelector('.seal-kamikaze').addEventListener('click', () => {
        if (currentDraft.kamikazeHolderId === pid) {
          currentDraft.kamikazeHolderId = null;
        } else {
          currentDraft.kamikazeHolderId = pid;
          currentDraft.rawScores[pid] = 50;
        }
        renderLedgerPlayerRows(summary);
      });

      dom.playerCardsList.appendChild(row);
    });

    updateFeedbackBanner(liveEval, summary);
  }

  function updateLivePreviewsOnly(summary) {
    const liveEval = evaluateRound(currentDraft, state.players, summary.threshold);

    state.players.forEach((player) => {
      const pid = player.id;
      const standing = summary.standings.find((s) => s.id === pid) || {
        total: 0,
        exactResetUsed: false
      };
      const pEval = liveEval.results[pid];
      const pill = dom.playerCardsList.querySelector(`[data-preview-pill="${pid}"]`);
      if (!pill) return;

      pill.className = 'lrow-round-preview';
      if (pEval.status === 'cabo_success') pill.classList.add('prev-zero');
      else if (pEval.status === 'cabo_fail') pill.classList.add('prev-penalty');
      else if (pEval.status === 'kamikaze_winner' || pEval.status === 'kamikaze_victim') {
        pill.classList.add('prev-kamikaze');
      }

      const projectedTotal = standing.total + pEval.delta;
      const willHitExactReset =
        !standing.exactResetUsed &&
        projectedTotal === summary.threshold &&
        pEval.delta > 0;

      pill.textContent = willHitExactReset
        ? `Exakt ${summary.threshold} → ${summary.halfThreshold} Pkt.!`
        : pEval.label;
    });

    updateFeedbackBanner(liveEval, summary);
  }

  function updateFeedbackBanner(liveEval, summary) {
    if (liveEval.isKamikazeRound) {
      const holder = state.players.find((p) => p.id === currentDraft.kamikazeHolderId);
      const bonus = summary.threshold === 50 ? 25 : 50;
      dom.liveRoundFeedback.className = 'ink-feedback-banner feedback-kamikaze';
      dom.liveRoundFeedback.innerHTML = `<strong>12-13er Kamikaze!</strong> ${escapeHtml(
        holder ? holder.name : ''
      )} erhält <strong>0 Punkte</strong> – alle anderen bekommen <strong>+${bonus} Punkte</strong>.`;
      return;
    }

    const caller = state.players.find((p) => p.id === currentDraft.caboCallerId);
    if (!caller) return;

    const callerRaw = toInt(currentDraft.rawScores[caller.id], 0);
    if (liveEval.caboSucceeded) {
      dom.liveRoundFeedback.className = 'ink-feedback-banner feedback-good';
      dom.liveRoundFeedback.innerHTML = `<strong>${escapeHtml(
        caller.name
      )}s</strong> Cabo-Ruf erfolgreich (niedrigste Summe: ${callerRaw}) → <strong>0 Punkte</strong>.`;
    } else {
      const penaltyTotal = callerRaw + 5;
      dom.liveRoundFeedback.className = 'ink-feedback-banner feedback-warn';
      dom.liveRoundFeedback.innerHTML = `<strong>${escapeHtml(
        caller.name
      )}s</strong> Cabo-Ruf fehlgeschlagen (niedrigste: ${liveEval.minRaw}) → <strong>+${penaltyTotal} Punkte</strong> (${callerRaw} + 5 Strafe).`;
    }
  }

  function commitCurrentRound() {
    state.rounds.push({
      id: 'r_' + Date.now(),
      caboCallerId: currentDraft.caboCallerId,
      kamikazeHolderId: currentDraft.kamikazeHolderId,
      rawScores: Object.assign({}, currentDraft.rawScores)
    });

    const postSummary = computeGameSummary(state);
    const lastRoundRow = postSummary.historyRows[postSummary.historyRows.length - 1];
    const resetPlayers = state.players.filter(
      (p) => lastRoundRow && lastRoundRow.perPlayer[p.id] && lastRoundRow.perPlayer[p.id].hitExactReset
    );

    if (resetPlayers.length > 0) {
      const names = resetPlayers.map((p) => p.name).join(', ');
      showToast(`Punktlandung! ${names} halbiert auf ${postSummary.halfThreshold} Punkte!`);
    } else {
      showToast(`Runde ${state.rounds.length} ins Punktebuch eingetragen`);
    }

    resetCurrentDraft();
    const nextCallerIdx = state.rounds.length % state.players.length;
    currentDraft.caboCallerId = state.players[nextCallerIdx].id;

    saveState();
    renderApp();
  }

  function undoLastRound() {
    if (state.rounds.length === 0) return;

    const currentSummary = computeGameSummary(state);
    if (currentSummary.isGameOver && state.matchRecordedInStats) {
      revertLastMatchFromStatistics(currentSummary.winners, state.players);
    }

    const removed = state.rounds.pop();
    if (removed) {
      currentDraft = {
        caboCallerId: removed.caboCallerId || state.players[0].id,
        kamikazeHolderId: removed.kamikazeHolderId || null,
        rawScores: Object.assign({}, removed.rawScores)
      };
    }

    saveState();
    renderApp();
    showToast('Letzte Runde zurückgenommen');
  }

  function renderHistoryAccordion(summary) {
    const count = summary.historyRows.length;
    dom.historyAccordion.hidden = count === 0;
    if (count === 0) return;

    dom.historyCountText.textContent = String(count);

    let theadHtml = `<tr><th>Runde</th>`;
    state.players.forEach((p) => {
      theadHtml += `<th>${escapeHtml(p.name)}</th>`;
    });
    theadHtml += `</tr>`;
    dom.historyThead.innerHTML = theadHtml;

    let tbodyHtml = '';
    summary.historyRows.forEach((row) => {
      tbodyHtml += `<tr><td><strong>#${row.roundNumber}</strong></td>`;
      state.players.forEach((p) => {
        const cell = row.perPlayer[p.id];
        const deltaStr = cell.delta > 0 ? `+${cell.delta}` : String(cell.delta);
        const resetNote = cell.hitExactReset ? ` ♛→${cell.totalAfter}` : '';
        tbodyHtml += `<td>${deltaStr} <small style="color:var(--ink-muted)">(${cell.totalAfter}${resetNote})</small></td>`;
      });
      tbodyHtml += `</tr>`;
    });
    dom.historyTbody.innerHTML = tbodyHtml;
  }

  // =========================================================================
  // MENÜ & EWIGE BESTENLISTE (STATISTIK)
  // =========================================================================

  function openMenuModal() {
    updateMenuModeButtons();
    renderStatisticsModalContent();
    dom.menuModal.hidden = false;
  }

  function closeMenuModal() {
    dom.menuModal.hidden = true;
  }

  function updateMenuModeButtons() {
    const is50 = Number(state.threshold) === 50;
    dom.menuMode100Btn.classList.toggle('active', !is50);
    dom.menuMode50Btn.classList.toggle('active', is50);
  }

  function renderStatisticsModalContent() {
    const entries = Object.values(stats.players).sort((a, b) => {
      if (b.wins !== a.wins) return b.wins - a.wins;
      return b.gamesPlayed - a.gamesPlayed;
    });

    dom.leaderboardContainer.innerHTML = '';
    if (entries.length === 0) {
      dom.leaderboardContainer.innerHTML = `
        <div class="empty-chronicle">
          Noch keine beendete Partie verzeichnet. Sobald ein Spieler das Punktelimit erreicht, werden die Siege hier festgehalten.
        </div>
      `;
    } else {
      entries.forEach((item, idx) => {
        const rankStr = ROMAN_NUMERALS[idx] ? `${ROMAN_NUMERALS[idx]}.` : `${idx + 1}.`;
        const winRate =
          item.gamesPlayed > 0 ? Math.round((item.wins / item.gamesPlayed) * 100) : 0;

        const row = document.createElement('div');
        row.className = 'chronicle-row';
        row.innerHTML = `
          <div class="chronicle-left">
            <span class="chronicle-rank">${rankStr}</span>
            <div>
              <div class="chronicle-name">${escapeHtml(item.displayName)}</div>
              <div class="chronicle-sub">${item.gamesPlayed} ${
          item.gamesPlayed === 1 ? 'Partie' : 'Partien'
        } · ${winRate}% Siegquote</div>
            </div>
          </div>
          <span class="chronicle-wins-pill">${item.wins} ${item.wins === 1 ? 'Sieg' : 'Siege'}</span>
        `;
        dom.leaderboardContainer.appendChild(row);
      });
    }

    dom.recentMatchesList.innerHTML = '';
    if (!stats.recentMatches || stats.recentMatches.length === 0) {
      dom.recentMatchesSection.hidden = true;
    } else {
      dom.recentMatchesSection.hidden = false;
      stats.recentMatches.slice(0, 6).forEach((m) => {
        const div = document.createElement('div');
        div.className = 'chronicle-row';
        div.innerHTML = `
          <div>
            <div class="chronicle-name">♛ ${escapeHtml(m.winnerNames)} (${m.winningScore} Pkt.)</div>
            <div class="chronicle-sub">${escapeHtml(m.mode)} · ${m.roundsCount} Runden</div>
          </div>
          <span class="chronicle-sub">${escapeHtml(m.dateStr)}</span>
        `;
        dom.recentMatchesList.appendChild(div);
      });
    }
  }

  // =========================================================================
  // EVENTS & STEUERUNG
  // =========================================================================

  function restartWithSamePlayers() {
    state.rounds = [];
    state.matchRecordedInStats = false;
    state.dealerOffset = ((state.dealerOffset || 0) + 1) % state.players.length;
    resetCurrentDraft();
    saveState();
    closeMenuModal();
    renderApp();
    showToast('Neue Partie aufgeschlagen');
  }

  function switchToSetupScreen() {
    state.phase = 'setup';
    state.rounds = [];
    state.matchRecordedInStats = false;
    resetCurrentDraft();
    saveState();
    closeMenuModal();
    renderApp();
  }

  function bindEvents() {
    dom.btnAddPlayer.addEventListener('click', addPlayerFromSetup);
    dom.newPlayerInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addPlayerFromSetup();
      }
    });

    dom.modeStandardBtn.addEventListener('click', () => {
      state.threshold = 100;
      saveState();
      renderSetup();
    });

    dom.modeSpeedBtn.addEventListener('click', () => {
      state.threshold = 50;
      saveState();
      renderSetup();
    });

    dom.btnStartGame.addEventListener('click', () => {
      state.players.forEach((p, idx) => {
        p.name = p.name.trim() || `Spieler ${idx + 1}`;
      });
      state.phase = 'playing';
      state.rounds = [];
      state.matchRecordedInStats = false;
      resetCurrentDraft();
      saveState();
      renderApp();
    });

    dom.brandHomeBtn.addEventListener('click', () => {
      openMenuModal();
    });

    dom.btnRotateDealer.addEventListener('click', () => {
      state.dealerOffset = ((state.dealerOffset || 0) + 1) % state.players.length;
      saveState();
      renderGame();
    });

    dom.btnCommitRound.addEventListener('click', commitCurrentRound);
    dom.btnUndoRound.addEventListener('click', undoLastRound);
    dom.btnUndoLastFromWinner.addEventListener('click', undoLastRound);

    dom.btnPlayAgainSame.addEventListener('click', restartWithSamePlayers);
    dom.btnBackToSetupFromWinner.addEventListener('click', switchToSetupScreen);

    // Menü & Statistik Modal
    dom.btnOpenMenu.addEventListener('click', openMenuModal);
    dom.btnCloseMenu.addEventListener('click', closeMenuModal);
    dom.menuModal.addEventListener('click', (e) => {
      if (e.target === dom.menuModal) closeMenuModal();
    });

    dom.menuMode100Btn.addEventListener('click', () => {
      state.threshold = 100;
      saveState();
      updateMenuModeButtons();
      renderApp();
      showToast('Punktelimit auf 100 gesetzt');
    });

    dom.menuMode50Btn.addEventListener('click', () => {
      state.threshold = 50;
      saveState();
      updateMenuModeButtons();
      renderApp();
      showToast('Punktelimit auf 50 (Schnellrunde) gesetzt');
    });

    dom.btnMenuRestartSame.addEventListener('click', restartWithSamePlayers);
    dom.btnMenuChangePlayers.addEventListener('click', switchToSetupScreen);

    dom.btnClearStats.addEventListener('click', () => {
      stats = createDefaultStats();
      saveStats();
      renderStatisticsModalContent();
      showToast('Sieges-Chronik geleert');
    });
  }

  function toInt(val, fallback = 0) {
    const n = parseInt(val, 10);
    return Number.isNaN(n) ? fallback : n;
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function showToast(msg) {
    const t = document.createElement('div');
    t.className = 'toast-msg';
    t.textContent = msg;
    dom.toastContainer.appendChild(t);
    setTimeout(() => {
      t.style.opacity = '0';
      t.style.transition = 'opacity 0.2s ease';
      setTimeout(() => t.remove(), 220);
    }, 2200);
  }

  function registerServiceWorker() {
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {});
      });
    }
  }

  loadData();
  bindEvents();
  renderApp();
  registerServiceWorker();
})();
