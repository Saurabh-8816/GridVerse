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
    this.grid = new Map();          // "col,row" -> { owner, color, capturedAt }
    this.players = new Map();       // id -> { name, color, ws, score, lastCapture, online }
    this.cooldownMs = 400;          // ms between captures per user
    this.lockMs = 2000;             // ms a cell is locked after capture
    this.nextPlayerId = 1;
    this.colorIndex = 0;
    this.adminId = null;            // first player to join; inherits to next if they leave

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
      joinedAt: Date.now()
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
    if (!player) return { success: false, reason: 'not_found' };

    if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) {
      return { success: false, reason: 'out_of_bounds' };
    }

    const now = Date.now();

    // Cooldown check
    const elapsed = now - player.lastCapture;
    if (elapsed < this.cooldownMs) {
      return { success: false, reason: 'cooldown', remaining: this.cooldownMs - elapsed };
    }

    const key = `${col},${row}`;
    const cell = this.grid.get(key);

    // Cell lock check — can't recapture another player's cell too quickly
    if (cell.owner && cell.owner !== playerId && now - cell.capturedAt < this.lockMs) {
      return { success: false, reason: 'locked', remaining: this.lockMs - (now - cell.capturedAt) };
    }

    // Already own this cell
    if (cell.owner === playerId) {
      return { success: false, reason: 'already_owned' };
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

    return { success: true, color: player.color, timestamp: now, previousOwner };
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
      .filter(p => p.score > 0)
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
