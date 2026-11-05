/**
 * CABO SCOREKEEPER — Radikal vereinfachte, helle deutsche PWA
 *
 * Aktive Regeln (dauerhaft aktiv):
 * 1. Cabo-Ruf: Niedrigste (oder geteilt niedrigste) Kartensumme = 0 Punkte.
 *    Sonst: Eigene Kartensumme + 5 Strafpunkte.
 * 2. 12-13er-Regel (Kamikaze): Hält ein Spieler 12-12-13-13, erhält er 0 Punkte
 *    und alle anderen Spieler bekommen +50 Punkte (Standard 100) bzw. +25 Punkte (Speed 50).
 * 3. Exakte Punktlandung: Trifft ein Spieler exakt das Limit (100 bzw. 50),
 *    fällt sein Punktestand einmalig pro Spiel zurück auf die Hälfte (50 bzw. 25).
 * 4. Ewige Statistik (Siege & gespielte Partien pro Spielername + letzte Spiele)
 *    verschachtelt im Menü.
 */

(function () {
  'use strict';

  const STATE_KEY = 'cabo_de_state_v2';
  const STATS_KEY = 'cabo_de_stats_v2';

  function createDefaultState() {
    return {
      phase: 'setup', // 'setup' | 'playing'
      threshold: 100, // 100 (Standard) | 50 (Speed)
      dealerOffset: 0,
      matchRecordedInStats: false,
      players: [
        { id: 'p1', name: 'Spieler 1' },
        { id: 'p2', name: 'Spieler 2' },
        { id: 'p3', name: 'Spieler 3' }
      ],
      rounds: []
      // Jede Runde: { id, caboCallerId: string|null, rawScores: { [pid]: number }, kamikazeHolderId: string|null }
    };
  }

  function createDefaultStats() {
    return {
      players: {}, // { [normalizedName]: { displayName, wins, gamesPlayed } }
      recentMatches: [] // [{ id, dateStr, winnerNames, mode, roundsCount }]
    };
  }

  let state = createDefaultState();
  let stats = createDefaultStats();

  // Entwurf für die aktuell laufende Runde direkt auf dem Hauptscreen
  let currentDraft = {
    caboCallerId: 'p1',
    kamikazeHolderId: null,
    rawScores: {}
  };

  // =========================================================================
  // PERSISTENZ (localStorage)
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
      console.warn('Fehler beim Laden des Spielstands:', e);
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
      console.warn('Fehler beim Laden der Statistik:', e);
    }

    resetCurrentDraft();
  }

  function saveState() {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify(state));
    } catch (e) {
      console.warn('Konnte Spielstand nicht speichern:', e);
    }
  }

  function saveStats() {
    try {
      localStorage.setItem(STATS_KEY, JSON.stringify(stats));
    } catch (e) {
      console.warn('Konnte Statistik nicht speichern:', e);
    }
  }

  function resetCurrentDraft() {
    const firstPlayerId = state.players[0] ? state.players[0].id : null;
    currentDraft = {
      caboCallerId: firstPlayerId,
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

  /**
   * Berechnet das Ergebnis einer einzelnen Runde anhand der Eingaben.
   */
  function evaluateRound(roundInput, players, threshold) {
    const kamikazeBonus = Number(threshold) === 50 ? 25 : 50;
    const playerIds = players.map((p) => p.id);
    const caboCallerId = roundInput.caboCallerId;
    const kamikazeHolderId = roundInput.kamikazeHolderId;
    const rawScores = roundInput.rawScores || {};

    const results = {};

    // Fall 1: 12-13er-Regel (Kamikaze) wurde aktiviert
    if (kamikazeHolderId && playerIds.includes(kamikazeHolderId)) {
      playerIds.forEach((pid) => {
        const raw = toInt(rawScores[pid], 0);
        if (pid === kamikazeHolderId) {
          results[pid] = {
            raw,
            delta: 0,
            status: 'kamikaze_winner',
            label: '🦄 12-13er! (0 Pkt.)'
          };
        } else {
          results[pid] = {
            raw,
            delta: kamikazeBonus,
            status: 'kamikaze_victim',
            label: `+${kamikazeBonus} (Kamikaze)`
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

    // Fall 2: Normale Runde mit Cabo-Ruf-Prüfung
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
            label: '📣 Cabo ✓ (0 Pkt.)'
          };
        } else {
          const penaltyPts = raw + 5;
          results[pid] = {
            raw,
            delta: penaltyPts,
            status: 'cabo_fail',
            label: `📣 Cabo ✗ (${raw}+5 = +${penaltyPts})`
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

  /**
   * Berechnet den gesamten Spielverlauf über alle abgeschlossenen Runden
   * inklusive der einmaligen Rückstufung bei exakter Punktlandung (100 -> 50 bzw. 50 -> 25).
   */
  function computeGameSummary(currentState) {
    const players = currentState.players;
    const threshold = Number(currentState.threshold) || 100;
    const halfThreshold = Math.floor(threshold / 2); // 50 oder 25
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

        // Exakte Punktlandung auf 100 (bzw. 50) -> einmalig zurück auf 50 (bzw. 25)
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

    // Prüfen, ob das Limit erreicht oder überschritten wurde
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
        exactResetUsed: exactResetUsed[p.id]
      }))
      .sort((a, b) => a.total - b.total);

    const winners = standings.filter((p) => p.total === minTotal);
    const dealerIndex = (currentState.rounds.length + (currentState.dealerOffset || 0)) % Math.max(1, players.length);

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
  // EWIGE STATISTIK LOGIK
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
      mode: summary.threshold === 50 ? 'Speed (50)' : 'Standard (100)',
      roundsCount: state.rounds.length
    });

    if (stats.recentMatches.length > 15) {
      stats.recentMatches.pop();
    }

    state.matchRecordedInStats = true;
    saveState();
    saveStats();
  }

  /**
   * Falls die letzte Runde (die das Spiel beendet hat) per "Rückgängig" wieder zurückgenommen wird,
   * korrigieren wir auch den Statistikeintrag sauber zurück.
   */
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
  // DOM-ELEMENTE & UI-RENDERING
  // =========================================================================

  const dom = {
    setupView: document.getElementById('setupView'),
    gameView: document.getElementById('gameView'),
    headerSubtitle: document.getElementById('headerSubtitle'),
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
      dom.headerSubtitle.textContent = 'Kamikaze-Modus aktiv';
      renderSetup();
    } else {
      dom.setupView.hidden = true;
      dom.gameView.hidden = false;
      dom.btnUndoRound.hidden = state.rounds.length === 0;
      const modeLabel = Number(state.threshold) === 50 ? 'Speed-Modus (50 Pkt.)' : 'Standard (100 Pkt.)';
      dom.headerSubtitle.textContent = `${modeLabel} • Kamikaze aktiv`;
      renderGame();
    }
  }

  // =========================================================================
  // SETUP-SCREEN
  // =========================================================================

  function renderSetup() {
    dom.playerCountPill.textContent = `${state.players.length} Spieler`;
    dom.setupPlayersList.innerHTML = '';

    state.players.forEach((player, idx) => {
      const row = document.createElement('div');
      row.className = 'setup-player-row';

      const numBadge = document.createElement('span');
      numBadge.className = 'player-num-circle';
      numBadge.textContent = String(idx + 1);

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

      row.appendChild(numBadge);
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
      showToast('Maximal 8 Spieler möglich');
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
  // HAUPTSCREEN (DIREKTE RUNDEN-EINGABE & SPIELSTAND)
  // =========================================================================

  function renderGame() {
    const summary = computeGameSummary(state);

    // Sicherstellen, dass im aktuellen Entwurf ein gültiger Cabo-Rufer gewählt ist
    if (
      !currentDraft.caboCallerId ||
      !state.players.some((p) => p.id === currentDraft.caboCallerId)
    ) {
      currentDraft.caboCallerId = state.players[0].id;
    }

    const nextRoundNum = state.rounds.length + 1;
    dom.roundCounterBadge.textContent = summary.isGameOver
      ? `Spiel beendet (${state.rounds.length} Runden)`
      : `Runde ${nextRoundNum}`;
    dom.limitCounterBadge.textContent = `Limit: ${summary.threshold} Pkt.`;
    dom.dealerNameDisplay.textContent = summary.dealer ? summary.dealer.name : 'Spieler 1';

    // Falls das Spiel vorbei ist: Statistik einmalig verbuchen & Gewinner-Karte zeigen
    if (summary.isGameOver) {
      recordMatchInStatistics(summary);
      dom.gameOverCard.hidden = false;
      dom.activeRoundInputContainer.hidden = true;

      const winnerNames = summary.winners.map((w) => w.name).join(' & ');
      dom.winnerTitleText.textContent =
        summary.winners.length > 1
          ? `Unentschieden! ${winnerNames} gewinnen!`
          : `${winnerNames} gewinnt!`;
      dom.winnerSubText.textContent = `Niedrigster Gesamtstand mit ${summary.minTotal} Punkten`;

      dom.winnerStandingsList.innerHTML = '';
      summary.standings.forEach((p, idx) => {
        const isFirst = p.total === summary.minTotal;
        const row = document.createElement('div');
        row.className = `winner-row ${isFirst ? 'is-first' : ''}`;
        const medal = isFirst ? '🏆' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `${idx + 1}.`;
        row.innerHTML = `
          <span>${medal} ${escapeHtml(p.name)}</span>
          <span>${p.total} Pkt.</span>
        `;
        dom.winnerStandingsList.appendChild(row);
      });
    } else {
      dom.gameOverCard.hidden = true;
      dom.activeRoundInputContainer.hidden = false;
      dom.btnCommitRoundText.textContent = `Runde ${nextRoundNum} abschließen`;
      renderPlayerInputCards(summary);
    }

    renderHistoryAccordion(summary);
  }

  function renderPlayerInputCards(summary) {
    dom.playerCardsList.innerHTML = '';
    const liveEval = evaluateRound(currentDraft, state.players, summary.threshold);

    state.players.forEach((player) => {
      const pid = player.id;
      const standing = summary.standings.find((s) => s.id === pid) || {
        total: 0,
        isLeader: false,
        isNearLimit: false
      };

      const isCaller = currentDraft.caboCallerId === pid;
      const isKamikaze = currentDraft.kamikazeHolderId === pid;
      const rawVal = toInt(currentDraft.rawScores[pid], 0);
      const pEval = liveEval.results[pid];

      const card = document.createElement('div');
      card.className = [
        'player-score-card',
        isCaller ? 'is-cabo-caller' : '',
        isKamikaze ? 'is-kamikaze-holder' : ''
      ]
        .filter(Boolean)
        .join(' ');

      let statusBadges = '';
      if (standing.isLeader) {
        statusBadges += `<span class="pcard-leader-tag">★ Führt</span>`;
      }
      if (standing.isNearLimit) {
        statusBadges += `<span class="pcard-warn-tag">Nahe Limit!</span>`;
      }

      let previewClass = '';
      if (pEval.status === 'cabo_success') previewClass = 'delta-zero';
      else if (pEval.status === 'cabo_fail') previewClass = 'delta-penalty';
      else if (pEval.status === 'kamikaze_winner' || pEval.status === 'kamikaze_victim') {
        previewClass = 'delta-kamikaze';
      }

      // Prüfen, ob der Spieler mit dieser Runde exakt auf 100/50 landet
      const projectedRawTotal = standing.total + pEval.delta;
      const willHitExactReset =
        !standing.exactResetUsed &&
        projectedRawTotal === summary.threshold &&
        pEval.delta > 0;

      const previewText = willHitExactReset
        ? `🎯 Exakt ${summary.threshold} → ${summary.halfThreshold} Pkt.!`
        : pEval.label;

      card.innerHTML = `
        <div class="pcard-header">
          <div class="pcard-identity">
            <span class="pcard-name">${escapeHtml(player.name)}</span>
            ${statusBadges}
          </div>
          <div class="pcard-total-box">
            <span class="pcard-total-preview ${previewClass}" data-preview-pill="${pid}">${previewText}</span>
            <span class="pcard-total-current" title="Aktueller Gesamtstand">${standing.total} <small style="font-size:0.7rem;font-weight:700;color:var(--text-muted)">Pkt.</small></span>
          </div>
        </div>

        <div class="pcard-controls">
          <div class="score-stepper-box">
            <button type="button" class="step-btn" data-step="-1" aria-label="1 Punkt weniger">-1</button>
            <input
              type="number"
              inputmode="numeric"
              min="0"
              max="99"
              class="round-pts-input"
              value="${rawVal}"
              aria-label="Kartenpunkte für ${escapeHtml(player.name)}"
            />
            <button type="button" class="step-btn" data-step="1" aria-label="1 Punkt mehr">+1</button>
            <button type="button" class="step-btn" data-step="5" aria-label="5 Punkte mehr">+5</button>
          </div>

          <div class="modifier-toggles">
            <button type="button" class="btn-cabo-call ${isCaller ? 'active' : ''}" title="Hat dieser Spieler Cabo gerufen?">
              <span>📣 Cabo</span>
            </button>
            <button type="button" class="btn-1213-toggle ${isKamikaze ? 'active' : ''}" title="12-12-13-13 (Kamikaze) auf der Hand">
              <span>🦄 12-13er</span>
            </button>
          </div>
        </div>
      `;

      // Events für Eingabefeld & Stepper
      const inputEl = card.querySelector('.round-pts-input');
      inputEl.addEventListener('focus', () => inputEl.select());
      inputEl.addEventListener('input', (e) => {
        currentDraft.rawScores[pid] = Math.max(0, Math.min(120, toInt(e.target.value, 0)));
        updateLiveRoundPreviewOnly(summary);
      });

      card.querySelectorAll('.step-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const step = Number(btn.dataset.step);
          const nextVal = Math.max(0, Math.min(120, toInt(currentDraft.rawScores[pid], 0) + step));
          currentDraft.rawScores[pid] = nextVal;
          inputEl.value = nextVal;
          updateLiveRoundPreviewOnly(summary);
        });
      });

      // Cabo-Rufer Toggle
      const caboBtn = card.querySelector('.btn-cabo-call');
      caboBtn.addEventListener('click', () => {
        currentDraft.caboCallerId = pid;
        renderPlayerInputCards(summary);
      });

      // 12-13er (Kamikaze) Toggle
      const kamikazeBtn = card.querySelector('.btn-1213-toggle');
      kamikazeBtn.addEventListener('click', () => {
        if (currentDraft.kamikazeHolderId === pid) {
          currentDraft.kamikazeHolderId = null;
        } else {
          currentDraft.kamikazeHolderId = pid;
          currentDraft.rawScores[pid] = 50; // 12+12+13+13
        }
        renderPlayerInputCards(summary);
      });

      dom.playerCardsList.appendChild(card);
    });

    updateFeedbackStrip(liveEval, summary);
  }

  /**
   * Aktualisiert nur die Vorschau-Badges und die Statuszeile während des Tippens,
   * damit der Fokus im Zahlenfeld erhalten bleibt.
   */
  function updateLiveRoundPreviewOnly(summary) {
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

      pill.className = 'pcard-total-preview';
      if (pEval.status === 'cabo_success') pill.classList.add('delta-zero');
      else if (pEval.status === 'cabo_fail') pill.classList.add('delta-penalty');
      else if (pEval.status === 'kamikaze_winner' || pEval.status === 'kamikaze_victim') {
        pill.classList.add('delta-kamikaze');
      }

      const projectedRawTotal = standing.total + pEval.delta;
      const willHitExactReset =
        !standing.exactResetUsed &&
        projectedRawTotal === summary.threshold &&
        pEval.delta > 0;

      pill.textContent = willHitExactReset
        ? `🎯 Exakt ${summary.threshold} → ${summary.halfThreshold} Pkt.!`
        : pEval.label;
    });

    updateFeedbackStrip(liveEval, summary);
  }

  function updateFeedbackStrip(liveEval, summary) {
    if (liveEval.isKamikazeRound) {
      const holder = state.players.find((p) => p.id === currentDraft.kamikazeHolderId);
      const bonus = summary.threshold === 50 ? 25 : 50;
      dom.liveRoundFeedback.className = 'instruction-strip status-kamikaze';
      dom.liveRoundFeedback.innerHTML = `🦄 <strong>Kamikaze (12-12-13-13)!</strong> ${escapeHtml(
        holder ? holder.name : ''
      )} erhält <strong>0 Punkte</strong>, alle anderen bekommen <strong>+${bonus} Punkte</strong>.`;
      return;
    }

    const caller = state.players.find((p) => p.id === currentDraft.caboCallerId);
    if (!caller) return;

    const callerRaw = toInt(currentDraft.rawScores[caller.id], 0);
    if (liveEval.caboSucceeded) {
      dom.liveRoundFeedback.className = 'instruction-strip status-good';
      dom.liveRoundFeedback.innerHTML = `✅ <strong>${escapeHtml(
        caller.name
      )}</strong> hat mit <strong>${callerRaw}</strong> die niedrigste Summe → <strong>0 Punkte</strong>!`;
    } else {
      const penaltyTotal = callerRaw + 5;
      dom.liveRoundFeedback.className = 'instruction-strip status-warn';
      dom.liveRoundFeedback.innerHTML = `⚠️ <strong>${escapeHtml(
        caller.name
      )}s</strong> Cabo-Ruf fehlgeschlagen (niedrigste: ${liveEval.minRaw}) → <strong>+${penaltyTotal} Punkte</strong> (${callerRaw} + 5 Strafe).`;
    }
  }

  function commitCurrentRound() {
    const preSummary = computeGameSummary(state);

    state.rounds.push({
      id: 'r_' + Date.now(),
      caboCallerId: currentDraft.caboCallerId,
      kamikazeHolderId: currentDraft.kamikazeHolderId,
      rawScores: Object.assign({}, currentDraft.rawScores)
    });

    const postSummary = computeGameSummary(state);

    // Prüfen, ob jemand exakt auf 100 bzw. 50 gelandet ist und zurückgestuft wurde
    const lastRoundRow = postSummary.historyRows[postSummary.historyRows.length - 1];
    const resetPlayers = state.players.filter(
      (p) => lastRoundRow && lastRoundRow.perPlayer[p.id] && lastRoundRow.perPlayer[p.id].hitExactReset
    );

    if (resetPlayers.length > 0) {
      const names = resetPlayers.map((p) => p.name).join(', ');
      showToast(`🎯 Punktlandung! ${names} fällt zurück auf ${postSummary.halfThreshold} Punkte!`);
    } else {
      showToast(`Runde ${state.rounds.length} gespeichert`);
    }

    resetCurrentDraft();
    // Standardmäßig den nächsten Spieler als Cabo-Rufer vorselektieren
    const nextCallerIdx = state.rounds.length % state.players.length;
    currentDraft.caboCallerId = state.players[nextCallerIdx].id;

    saveState();
    renderApp();
  }

  function undoLastRound() {
    if (state.rounds.length === 0) return;

    // Falls das Spiel bereits als beendet in der Statistik gezählt wurde, sauber zurücknehmen
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
    showToast('↩️ Letzte Runde zurückgenommen');
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
        const resetBadge = cell.hitExactReset ? ` 🎯→${cell.totalAfter}` : '';
        tbodyHtml += `<td>${deltaStr} <small style="color:var(--text-muted)">(${cell.totalAfter}${resetBadge})</small></td>`;
      });
      tbodyHtml += `</tr>`;
    });
    dom.historyTbody.innerHTML = tbodyHtml;
  }

  // =========================================================================
  // STATISTIK & MENÜ MODAL
  // =========================================================================

  function openMenuModal() {
    dom.inGameActionsSection.hidden = state.phase !== 'playing';
    renderStatisticsModalContent();
    dom.menuModal.hidden = false;
  }

  function closeMenuModal() {
    dom.menuModal.hidden = true;
  }

  function renderStatisticsModalContent() {
    const entries = Object.values(stats.players).sort((a, b) => {
      if (b.wins !== a.wins) return b.wins - a.wins;
      return b.gamesPlayed - a.gamesPlayed;
    });

    dom.leaderboardContainer.innerHTML = '';
    if (entries.length === 0) {
      dom.leaderboardContainer.innerHTML = `
        <div class="empty-stats-msg">
          Noch keine beendeten Spiele gespeichert. Sobald ein Spiel das Punktelimit erreicht, werden die Siege hier gezählt!
        </div>
      `;
    } else {
      entries.forEach((item, idx) => {
        const rankIcon = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `${idx + 1}.`;
        const winRate =
          item.gamesPlayed > 0 ? Math.round((item.wins / item.gamesPlayed) * 100) : 0;

        const row = document.createElement('div');
        row.className = 'leaderboard-row';
        row.innerHTML = `
          <div class="lb-left">
            <span class="lb-rank">${rankIcon}</span>
            <div>
              <div class="lb-name">${escapeHtml(item.displayName)}</div>
              <div class="lb-games">${item.gamesPlayed} ${
          item.gamesPlayed === 1 ? 'Spiel' : 'Spiele'
        } (${winRate}% Siegquote)</div>
            </div>
          </div>
          <span class="lb-wins-badge">${item.wins} ${item.wins === 1 ? 'Sieg' : 'Siege'}</span>
        `;
        dom.leaderboardContainer.appendChild(row);
      });
    }

    // Letzte Partien
    dom.recentMatchesList.innerHTML = '';
    if (!stats.recentMatches || stats.recentMatches.length === 0) {
      dom.recentMatchesSection.hidden = true;
    } else {
      dom.recentMatchesSection.hidden = false;
      stats.recentMatches.slice(0, 6).forEach((m) => {
        const div = document.createElement('div');
        div.className = 'recent-match-item';
        div.innerHTML = `
          <div>
            <strong>🏆 ${escapeHtml(m.winnerNames)}</strong> (${m.winningScore} Pkt.)
            <div style="font-size:0.72rem;color:var(--text-muted)">${escapeHtml(m.mode)} • ${
          m.roundsCount
        } Runden</div>
          </div>
          <span style="font-size:0.74rem;color:var(--text-muted)">${escapeHtml(m.dateStr)}</span>
        `;
        dom.recentMatchesList.appendChild(div);
      });
    }
  }

  // =========================================================================
  // EVENTS & HILFSFUNKTIONEN
  // =========================================================================

  function restartWithSamePlayers() {
    state.rounds = [];
    state.matchRecordedInStats = false;
    state.dealerOffset = ((state.dealerOffset || 0) + 1) % state.players.length;
    resetCurrentDraft();
    saveState();
    closeMenuModal();
    renderApp();
    showToast('🔄 Neues Spiel gestartet');
  }

  function backToSetup() {
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

    dom.btnRotateDealer.addEventListener('click', () => {
      state.dealerOffset = ((state.dealerOffset || 0) + 1) % state.players.length;
      saveState();
      renderGame();
    });

    dom.btnCommitRound.addEventListener('click', commitCurrentRound);
    dom.btnUndoRound.addEventListener('click', undoLastRound);
    dom.btnUndoLastFromWinner.addEventListener('click', undoLastRound);

    dom.btnPlayAgainSame.addEventListener('click', restartWithSamePlayers);
    dom.btnBackToSetupFromWinner.addEventListener('click', backToSetup);

    // Menü & Statistik Modal
    dom.btnOpenMenu.addEventListener('click', openMenuModal);
    dom.btnCloseMenu.addEventListener('click', closeMenuModal);
    dom.menuModal.addEventListener('click', (e) => {
      if (e.target === dom.menuModal) closeMenuModal();
    });

    dom.btnMenuRestartSame.addEventListener('click', restartWithSamePlayers);
    dom.btnMenuChangePlayers.addEventListener('click', backToSetup);

    dom.btnClearStats.addEventListener('click', () => {
      stats = createDefaultStats();
      saveStats();
      renderStatisticsModalContent();
      showToast('Statistik zurückgesetzt');
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
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
      });
    }
  }

  loadData();
  bindEvents();
  renderApp();
  registerServiceWorker();
})();
