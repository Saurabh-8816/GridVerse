/**
 * Gridverse — Game State Manager
 *
 * Handles all game logic server-side (authoritative server pattern):
 * - Grid state management with hex coordinates
 * - Player registration with unique color assignment
 * - Capture logic with cooldown & cell-lock conflict resolution
 * - Leaderboard computation
 */

class Game {
  constructor(cols = 40, rows = 25) {
    this.cols = cols;
    this.rows = rows;
    this.grid = new Map(); // "col,row" -> { owner, color, capturedAt }
    this.players = new Map(); // id -> { name, color, ws, score, lastCapture, online }
    this.cooldownMs = 400; // ms between captures per user
    this.lockMs = 2000; // ms a cell is locked after capture
    this.nextPlayerId = 1;
    this.colorIndex = 0;
    this.adminId = null; // first player to join; inherits to next if they leave

    // Initialize empty grid
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        this.grid.set(`${c},${r}`, { owner: null, color: null, capturedAt: 0 });
      }
    }
  }

  /**
   * Generate visually distinct colors using golden angle distribution.
   * This ensures any number of players get well-separated hues.
   */
  generateColor() {
    const hue = (this.colorIndex * 137.508) % 360;
    this.colorIndex++;
    // Fixed saturation/lightness for vibrancy on dark backgrounds
    return `hsl(${Math.round(hue)}, 72%, 58%)`;
  }

  addPlayer(name, ws) {
    const id = `p${this.nextPlayerId++}`;
    const color = this.generateColor();
    this.players.set(id, {
      name: (name || `Player ${this.nextPlayerId - 1}`).slice(0, 20),
      color,
      ws,
      score: 0,
      lastCapture: 0,
      online: true,
      joinedAt: Date.now(),
      captureHistory: null,
    });
    // First player to ever join becomes admin
    if (!this.adminId) this.adminId = id;
    return id;
  }

  isAdmin(playerId) {
    return this.adminId === playerId;
  }

  /** When admin leaves, promote the next online player */
  promoteNextAdmin() {
    for (const [id, p] of this.players) {
      if (p.online) {
        this.adminId = id;
        return id;
      }
    }
    this.adminId = null; // nobody online
    return null;
  }

  removePlayer(id) {
    const player = this.players.get(id);
    if (player) {
      player.online = false;
      player.ws = null;
      // If the admin left, promote someone else
      if (this.adminId === id) {
        this.promoteNextAdmin();
      }
    }
  }

  /**
   * Core capture logic with conflict resolution:
   * 1. Validate coordinates
   * 2. Check per-user cooldown (prevents spam)
   * 3. Check cell lock (prevents frustrating back-and-forth wars)
   * 4. Server is authoritative — first valid request wins
   */
  capture(playerId, col, row) {
    const player = this.players.get(playerId);
    if (!player) return { success: false, reason: "not_found" };

    if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) {
      return { success: false, reason: "out_of_bounds" };
    }

    const now = Date.now();

    // Cooldown check
    const elapsed = now - player.lastCapture;
    if (elapsed < this.cooldownMs) {
      return { success: false, reason: "cooldown", remaining: this.cooldownMs - elapsed };
    }

    const key = `${col},${row}`;
    const cell = this.grid.get(key);

    // Cell lock check — can't recapture another player's cell too quickly
    if (cell.owner && cell.owner !== playerId && now - cell.capturedAt < this.lockMs) {
      return { success: false, reason: "locked", remaining: this.lockMs - (now - cell.capturedAt) };
    }

    // Already own this cell
    if (cell.owner === playerId) {
      return { success: false, reason: "already_owned" };
    }

    // --- Execute capture ---
    const previousOwner = cell.owner;
    cell.owner = playerId;
    cell.color = player.color;
    cell.capturedAt = now;

    // Update scores
    player.score++;
    player.lastCapture = now;

    if (previousOwner) {
      const prev = this.players.get(previousOwner);
      if (prev) prev.score = Math.max(0, prev.score - 1);
    }

    // Store one-level undo history
    player.captureHistory = {
      col,
      row,
      previousOwner,
      previousOwnerColor: previousOwner ? (this.players.get(previousOwner)?.color ?? null) : null,
      timestamp: now,
    };

    return { success: true, color: player.color, timestamp: now, previousOwner };
  }

  /**
   * Undo the player's last capture (within a 10-second window).
   * Restores the cell to its previous owner and adjusts scores.
   */
  undo(playerId) {
    const player = this.players.get(playerId);
    if (!player) return { success: false, reason: "not_found" };

    const history = player.captureHistory;
    if (!history) return { success: false, reason: "nothing_to_undo" };

    // Allow undo only within 10 seconds
    const undoWindowMs = 10000;
    if (Date.now() - history.timestamp > undoWindowMs) {
      player.captureHistory = null;
      return { success: false, reason: "undo_expired" };
    }

    const key = `${history.col},${history.row}`;
    const cell = this.grid.get(key);

    // Can only undo if we still own the cell
    if (!cell || cell.owner !== playerId) {
      player.captureHistory = null;
      return { success: false, reason: "cell_changed" };
    }

    // Restore previous state
    cell.owner = history.previousOwner;
    cell.color = history.previousOwnerColor;
    cell.capturedAt = 0;

    // Restore scores
    player.score = Math.max(0, player.score - 1);
    if (history.previousOwner) {
      const prev = this.players.get(history.previousOwner);
      if (prev) prev.score++;
    }

    player.captureHistory = null;

    return {
      success: true,
      col: history.col,
      row: history.row,
      previousOwner: history.previousOwner,
      previousOwnerColor: history.previousOwnerColor,
    };
  }

  /**
   * Erase (release) one of the player's own captured cells.
   * Returns the cell to unclaimed state.
   */
  erase(playerId, col, row) {
    const player = this.players.get(playerId);
    if (!player) return { success: false, reason: "not_found" };

    if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) {
      return { success: false, reason: "out_of_bounds" };
    }

    const key = `${col},${row}`;
    const cell = this.grid.get(key);

    if (!cell || cell.owner !== playerId) {
      return { success: false, reason: "not_owned" };
    }

    // Release the cell
    cell.owner = null;
    cell.color = null;
    cell.capturedAt = 0;

    player.score = Math.max(0, player.score - 1);

    // Clear undo history if it pointed to this cell
    if (
      player.captureHistory &&
      player.captureHistory.col === col &&
      player.captureHistory.row === row
    ) {
      player.captureHistory = null;
    }

    return { success: true, col, row };
  }

  /**
   * Reset the entire grid — clears all owned cells and resets all scores.
   * Called when any player clicks the reset button.
   */
  resetGrid() {
    for (const cell of this.grid.values()) {
      cell.owner = null;
      cell.color = null;
      cell.capturedAt = 0;
    }
    for (const player of this.players.values()) {
      player.score = 0;
      player.lastCapture = 0;
    }
  }

  /** Serialize only owned cells (sparse) for initial state sync */
  getGridState() {
    const state = {};
    for (const [key, cell] of this.grid) {
      if (cell.owner) {
        state[key] = { o: cell.owner, c: cell.color };
      }
    }
    return state;
  }

  getPlayersPublic() {
    const result = {};
    for (const [id, p] of this.players) {
      result[id] = { name: p.name, color: p.color, score: p.score, online: p.online };
    }
    return result;
  }

  getLeaderboard() {
    return Array.from(this.players.entries())
      .map(([id, p]) => ({ id, name: p.name, color: p.color, score: p.score, online: p.online }))
      .filter((p) => p.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
  }

  getOnlineCount() {
    let count = 0;
    for (const p of this.players.values()) {
      if (p.online) count++;
    }
    return count;
  }
}

module.exports = Game;
