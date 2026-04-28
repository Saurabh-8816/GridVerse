/**
 * Gridverse — Main Application
 *
 * Orchestrates the renderer, WebSocket client, and UI.
 * Handles game flow: join → play → real-time updates.
 */

(function () {
  'use strict';

  // ─── State ────────────────────────────────────────────────
  let playerId = null;
  let playerColor = null;
  let playerName = '';
  let gameConfig = null;
  let cooldownEnd = 0;
  let leaderboardData = [];
  let isAdmin = false;   // true only for the admin (first joiner)

  // ─── Initialize Systems ───────────────────────────────────
  const canvas = document.getElementById('grid-canvas');
  const minimapCanvas = document.getElementById('minimap-canvas');
  const renderer = new HexRenderer(canvas, minimapCanvas);
  const socket = new GridSocket();

  // ─── DOM References ───────────────────────────────────────
  const joinOverlay = document.getElementById('join-overlay');
  const gameContainer = document.getElementById('game-container');
  const usernameInput = document.getElementById('username-input');
  const joinBtn = document.getElementById('join-btn');
  const onlinePreview = document.getElementById('online-preview');

  const statusIndicator = document.getElementById('status-indicator');
  const statusText = statusIndicator.querySelector('.status-text');
  const onlineCount = document.getElementById('online-count');
  const playerColorDot = document.getElementById('player-color-dot');
  const playerNameDisplay = document.getElementById('player-name-display');
  const myScoreEl = document.getElementById('my-score');
  const myRankEl = document.getElementById('my-rank');
  const cooldownBar = document.getElementById('cooldown-bar');
  const cooldownLabel = document.getElementById('cooldown-label');
  const leaderboardList = document.getElementById('leaderboard-list');
  const zoomLevelEl = document.getElementById('zoom-level');

  // ─── Join Flow ────────────────────────────────────────────

  function handleJoin() {
    const name = usernameInput.value.trim();
    if (!name) {
      usernameInput.focus();
      usernameInput.style.borderColor = 'var(--accent-rose)';
      setTimeout(() => { usernameInput.style.borderColor = ''; }, 1000);
      return;
    }
    playerName = name;
    joinBtn.disabled = true;
    joinBtn.querySelector('span').textContent = 'Connecting...';
    socket.join(name);
  }

  joinBtn.addEventListener('click', handleJoin);
  usernameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleJoin();
  });

  // Focus username input on load
  setTimeout(() => usernameInput.focus(), 500);

  // ─── Connect WebSocket ────────────────────────────────────
  socket.connect();

  socket.on('connected', () => {
    onlinePreview.textContent = 'Server connected — enter your name';
    statusText.textContent = 'Connected';
    statusIndicator.classList.remove('disconnected');
  });

  socket.on('disconnected', () => {
    onlinePreview.textContent = 'Reconnecting...';
    statusText.textContent = 'Reconnecting...';
    statusIndicator.classList.add('disconnected');
  });

  // ─── Game Events ──────────────────────────────────────────

  socket.on('welcome', (msg) => {
    playerId = msg.playerId;
    playerColor = msg.color;
    gameConfig = msg.config;
    isAdmin = msg.isAdmin;

    // Initialize renderer
    renderer.init(gameConfig.cols, gameConfig.rows);
    renderer.loadGrid(msg.grid);

    // Update UI
    playerColorDot.style.background = playerColor;
    playerNameDisplay.textContent = playerName;
    onlineCount.textContent = msg.online || 1;

    // Show/hide reset button based on admin status
    setAdminUI(isAdmin);

    // Update leaderboard
    updateLeaderboard(msg.leaderboard);

    // Transition to game
    joinOverlay.classList.add('hidden');
    gameContainer.classList.remove('hidden');

    // Trigger resize for canvas
    window.dispatchEvent(new Event('resize'));

    showToast(`Welcome to Gridverse, ${playerName}!${isAdmin ? ' 👑 You are the admin.' : ''}`);
  });

  socket.on('captured', (msg) => {
    renderer.setCell(msg.col, msg.row, msg.playerId, msg.color);
    renderer.addCaptureAnimation(msg.col, msg.row, msg.color);

    // Update own score display
    if (msg.playerId === playerId) {
      updateMyStats();
    }
  });

  socket.on('capture_failed', (msg) => {
    switch (msg.reason) {
      case 'cooldown':
        // Silently ignore, cooldown bar shows this
        break;
      case 'locked':
        showToast('⏳ This tile is locked — try another!', true);
        break;
      case 'already_owned':
        // Silently ignore
        break;
      default:
        showToast(`❌ ${msg.reason}`, true);
    }
  });

  socket.on('leaderboard', (msg) => {
    updateLeaderboard(msg.data);
  });

  socket.on('player_joined', (msg) => {
    onlineCount.textContent = msg.online;
    showToast(`${msg.name} joined the grid`);
  });

  socket.on('player_left', (msg) => {
    onlineCount.textContent = msg.online;
    // If the admin left and this client is the new admin, update UI
    if (msg.newAdminId && msg.newAdminId === playerId) {
      isAdmin = true;
      setAdminUI(true);
      showToast('👑 You are now the admin!');
    }
  });

  socket.on('reset_denied', (msg) => {
    showToast(`🚫 ${msg.reason}`, true);
  });

  socket.on('grid_reset', (msg) => {
    // Clear all cells in the renderer
    renderer.gridData.clear();

    // Reset own score display
    myScoreEl.textContent = '0';
    myRankEl.textContent = '—';

    // Update leaderboard (will be empty)
    updateLeaderboard(msg.leaderboard || []);

    showToast(`🔄 Grid reset by ${msg.byName}`);
  });

  // ─── Hex Click Handler ───────────────────────────────────

  renderer.onHexClick = (col, row) => {
    if (!playerId) return;

    const now = Date.now();
    if (now < cooldownEnd) return;

    // Optimistic: set cooldown immediately
    cooldownEnd = now + (gameConfig?.cooldownMs || 400);

    // Send capture request
    socket.capture(col, row);
  };

  // ─── UI Updates ───────────────────────────────────────────

  function updateMyStats() {
    // Count my tiles
    let count = 0;
    for (const [, cell] of renderer.gridData) {
      if (cell.owner === playerId) count++;
    }
    myScoreEl.textContent = count;

    // Find my rank
    const rank = leaderboardData.findIndex(p => p.id === playerId);
    myRankEl.textContent = rank >= 0 ? `#${rank + 1}` : '—';
  }

  function updateLeaderboard(data) {
    leaderboardData = data;
    leaderboardList.innerHTML = '';

    data.forEach((player, i) => {
      const li = document.createElement('li');
      if (player.id === playerId) li.classList.add('me');
      if (!player.online) li.classList.add('lb-offline');

      let rankClass = '';
      if (i === 0) rankClass = 'gold';
      else if (i === 1) rankClass = 'silver';
      else if (i === 2) rankClass = 'bronze';

      li.innerHTML = `
        <span class="lb-rank ${rankClass}">${i + 1}</span>
        <span class="lb-color" style="background:${player.color}"></span>
        <span class="lb-name">${escapeHtml(player.name)}</span>
        <span class="lb-score">${player.score}</span>
      `;
      leaderboardList.appendChild(li);
    });

    updateMyStats();
  }

  // ─── Cooldown Bar Animation ───────────────────────────────

  function updateCooldownBar() {
    requestAnimationFrame(updateCooldownBar);

    if (!gameConfig) return;

    const now = Date.now();
    const remaining = Math.max(0, cooldownEnd - now);
    const progress = 1 - (remaining / gameConfig.cooldownMs);

    cooldownBar.style.width = `${Math.min(100, progress * 100)}%`;

    if (remaining > 0) {
      cooldownLabel.textContent = `${Math.ceil(remaining)}ms`;
      cooldownBar.style.background = 'linear-gradient(90deg, var(--accent-rose), var(--accent-amber))';
    } else {
      cooldownLabel.textContent = 'Ready';
      cooldownBar.style.background = 'var(--gradient-brand)';
    }

    // Update zoom display
    zoomLevelEl.textContent = `${renderer.getZoomPercent()}%`;
  }
  updateCooldownBar();

  // ─── Zoom Controls ───────────────────────────────────────

  document.getElementById('zoom-in-btn').addEventListener('click', () => renderer.zoomIn());
  document.getElementById('zoom-out-btn').addEventListener('click', () => renderer.zoomOut());
  document.getElementById('zoom-reset-btn').addEventListener('click', () => renderer.resetView());

  // ─── Reset Grid ───────────────────────────────────────────

  let resetPending = false;

  document.getElementById('reset-grid-btn').addEventListener('click', () => {
    if (!playerId) return;

    if (!resetPending) {
      // First click: show a warning toast — click again to confirm
      resetPending = true;
      showResetConfirm();
      setTimeout(() => { resetPending = false; }, 4000);
    } else {
      // Second click within 4s: actually reset
      resetPending = false;
      socket.reset();
    }
  });

  function showResetConfirm() {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast toast-confirm';
    toast.innerHTML = `⚠️ Click <strong>Reset Grid</strong> again to confirm — clears all tiles!`;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  // ─── Toast Notifications ──────────────────────────────────

  function showToast(message, isError = false) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast${isError ? ' error' : ''}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3200);
  }

  // ─── Utility ──────────────────────────────────────────────

  /** Show/hide the Reset Grid button and update its label based on admin status */
  function setAdminUI(admin) {
    const btn = document.getElementById('reset-grid-btn');
    if (admin) {
      btn.classList.remove('hidden');
      btn.innerHTML = '👑 Reset Grid';
    } else {
      btn.classList.add('hidden');
    }
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ─── Keyboard Shortcuts ───────────────────────────────────

  document.addEventListener('keydown', (e) => {
    if (document.activeElement === usernameInput) return;
    switch (e.key) {
      case '+':
      case '=':
        renderer.zoomIn();
        break;
      case '-':
        renderer.zoomOut();
        break;
      case '0':
        renderer.resetView();
        break;
    }
  });

})();
