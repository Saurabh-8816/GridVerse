/**
 * Gridverse — Server Entry Point
 *
 * Architecture:
 * - Express serves static frontend from /public
 * - WebSocket server runs on the same HTTP server (port sharing)
 * - Game instance is the single source of truth (authoritative server)
 * - All mutations go through Game class, then broadcast to clients
 */

const express = require("express");
const { createServer } = require("http");
const { WebSocketServer } = require("ws");
const path = require("path");
const Game = require("./game");

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Serve static frontend
app.use(express.static(path.join(__dirname, "../public")));

// Game config
const GRID_COLS = 70;
const GRID_ROWS = 45;
const game = new Game(GRID_COLS, GRID_ROWS);

console.log(`🎮 Game initialized: ${GRID_COLS}×${GRID_ROWS} = ${GRID_COLS * GRID_ROWS} hexagons`);

// ─── WebSocket Connection Handler ─────────────────────────────────

wss.on("connection", (ws, req) => {
  let playerId = null;
  const ip = req.socket.remoteAddress;

  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw);

      switch (msg.type) {
        // ── Player joins the game ──
        case "join": {
          playerId = game.addPlayer(msg.name, ws);
          const player = game.players.get(playerId);

          // Send full initial state to the new player
          ws.send(
            JSON.stringify({
              type: "welcome",
              playerId,
              color: player.color,
              isAdmin: game.isAdmin(playerId),
              grid: game.getGridState(),
              players: game.getPlayersPublic(),
              leaderboard: game.getLeaderboard(),
              config: {
                cols: game.cols,
                rows: game.rows,
                cooldownMs: game.cooldownMs,
                lockMs: game.lockMs,
              },
              online: game.getOnlineCount(),
            }),
          );

          // Tell everyone else about the new player
          broadcast(
            {
              type: "player_joined",
              playerId,
              name: player.name,
              color: player.color,
              online: game.getOnlineCount(),
            },
            ws,
          );

          console.log(`✅ ${player.name} joined (${playerId}) from ${ip}`);
          break;
        }

        // ── Player captures a cell ──
        case "capture": {
          if (!playerId) return;

          const col = parseInt(msg.col);
          const row = parseInt(msg.row);
          if (isNaN(col) || isNaN(row)) return;

          const result = game.capture(playerId, col, row);

          if (result.success) {
            // Broadcast capture to ALL clients (including sender for confirmation)
            broadcastAll({
              type: "captured",
              col,
              row,
              playerId,
              color: result.color,
              timestamp: result.timestamp,
            });

            // Broadcast updated leaderboard
            broadcastAll({
              type: "leaderboard",
              data: game.getLeaderboard(),
            });
          } else {
            // Only tell the sender about the failure
            ws.send(
              JSON.stringify({
                type: "capture_failed",
                reason: result.reason,
                remaining: result.remaining || 0,
                col,
                row,
              }),
            );
          }
          break;
        }

        case "ping":
          ws.send(JSON.stringify({ type: "pong", t: Date.now() }));
          break;

        // ── Player undoes their last capture ──
        case "undo": {
          if (!playerId) return;

          const result = game.undo(playerId);

          if (result.success) {
            broadcastAll({
              type: "captured",
              col: result.col,
              row: result.row,
              playerId: result.previousOwner || null,
              color: result.previousOwnerColor || null,
              isUndo: true,
            });
            broadcastAll({
              type: "leaderboard",
              data: game.getLeaderboard(),
            });
          } else {
            ws.send(
              JSON.stringify({
                type: "undo_failed",
                reason: result.reason,
              }),
            );
          }
          break;
        }

        // ── Player erases (releases) one of their own cells ──
        case "erase": {
          if (!playerId) return;

          const eraseCol = parseInt(msg.col);
          const eraseRow = parseInt(msg.row);
          if (isNaN(eraseCol) || isNaN(eraseRow)) return;

          const eraseResult = game.erase(playerId, eraseCol, eraseRow);

          if (eraseResult.success) {
            broadcastAll({
              type: "captured",
              col: eraseResult.col,
              row: eraseResult.row,
              playerId: null,
              color: null,
              isErase: true,
            });
            broadcastAll({
              type: "leaderboard",
              data: game.getLeaderboard(),
            });
          } else {
            ws.send(
              JSON.stringify({
                type: "erase_failed",
                reason: eraseResult.reason,
              }),
            );
          }
          break;
        }

        // ── Admin-only: reset the full grid ──
        case "reset": {
          if (!playerId) return;

          // Reject if not admin
          if (!game.isAdmin(playerId)) {
            ws.send(
              JSON.stringify({
                type: "reset_denied",
                reason: "Only the admin (first player who joined) can reset the grid.",
              }),
            );
            return;
          }

          const resetter = game.players.get(playerId);
          game.resetGrid();

          broadcastAll({
            type: "grid_reset",
            byName: resetter?.name || "Admin",
            leaderboard: game.getLeaderboard(),
          });

          console.log(`🔄 Grid reset by admin ${resetter?.name || playerId}`);
          break;
        }
      }
    } catch (err) {
      console.error("Message parse error:", err.message);
    }
  });

  ws.on("close", () => {
    if (playerId) {
      const player = game.players.get(playerId);
      const wasAdmin = game.isAdmin(playerId);
      console.log(`👋 ${player?.name || playerId} disconnected`);
      game.removePlayer(playerId); // may promote new admin

      broadcastAll({
        type: "player_left",
        playerId,
        online: game.getOnlineCount(),
        // If admin left, tell everyone who the new admin is
        newAdminId: wasAdmin ? game.adminId : undefined,
      });
    }
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
  });
});

// ─── Heartbeat (detect dead connections) ───────────────────────────

const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on("close", () => clearInterval(heartbeatInterval));

// ─── Broadcast Helpers ─────────────────────────────────────────────

function broadcast(msg, exclude) {
  const data = JSON.stringify(msg);
  wss.clients.forEach((client) => {
    if (client !== exclude && client.readyState === 1) {
      client.send(data);
    }
  });
}

function broadcastAll(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(data);
    }
  });
}

// ─── Start Server ──────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🌐 ══════════════════════════════════════`);
  console.log(`   Gridverse running on http://localhost:${PORT}`);
  console.log(`   ${GRID_COLS}×${GRID_ROWS} hex grid (${GRID_COLS * GRID_ROWS} cells)`);
  console.log(`   Cooldown: ${game.cooldownMs}ms | Lock: ${game.lockMs}ms`);
  console.log(`🌐 ══════════════════════════════════════\n`);
});
