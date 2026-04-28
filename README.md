# 🌐 Gridverse — Real-Time Hex Territory Conquest

A real-time multiplayer territory game where players compete to capture hexagonal tiles on a shared grid. Built with vanilla JavaScript, Canvas API, and WebSockets.

![Node.js](https://img.shields.io/badge/Node.js-18+-green?style=flat-square)
![WebSocket](https://img.shields.io/badge/Protocol-WebSocket-blue?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-purple?style=flat-square)

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| **Hex Grid** | 1000 hexagonal tiles (40×25) rendered with Canvas API — not DOM elements |
| **Real-time Sync** | WebSocket broadcasts every capture to all connected clients instantly |
| **Conflict Resolution** | Server-authoritative model with cooldown (400ms) + cell lock (2s) |
| **Unique Colors** | Golden-angle color distribution ensures every player gets a distinct hue |
| **Zoom & Pan** | Smooth camera with scroll-to-zoom, click-drag pan, and camera interpolation |
| **Minimap** | Overview of the full grid with viewport indicator |
| **Leaderboard** | Live-updating top 10 with rank medals |
| **Animations** | Capture ripples, hex flash effects, and particle bursts |
| **Auto-reconnect** | Exponential backoff reconnection on disconnect |
| **Responsive** | Works on desktop and mobile with touch support |

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     BROWSER CLIENT                       │
│                                                          │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │ socket.js│  │ renderer.js  │  │     app.js        │  │
│  │          │←→│ Canvas Hex   │←→│ Orchestrator      │  │
│  │ WebSocket│  │ Grid Render  │  │ UI + Game Flow    │  │
│  │ + Reconn │  │ + Animations │  │ + State Mgmt      │  │
│  └────┬─────┘  └──────────────┘  └───────────────────┘  │
│       │                                                  │
└───────┼──────────────────────────────────────────────────┘
        │ WebSocket (JSON messages)
        │
┌───────┼──────────────────────────────────────────────────┐
│       │              NODE.JS SERVER                       │
│  ┌────┴─────┐   ┌──────────────┐                         │
│  │ index.js │   │   game.js    │                         │
│  │          │──→│              │                         │
│  │ Express  │   │ Game State   │                         │
│  │ + WS Hub │   │ + Rules      │                         │
│  │ + Bcast  │   │ + Scoring    │                         │
│  └──────────┘   └──────────────┘                         │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### Why These Choices?

| Decision | Rationale |
|----------|-----------|
| **Hex grid** instead of square | More visually interesting, demonstrates geometric thinking, natural territory boundaries |
| **Canvas rendering** | DOM-based grids don't scale — 1000 div elements with event listeners would lag. Canvas draws 1000+ hexes at 60fps |
| **Pointy-top hexagons** | Better visual density and more natural map appearance vs flat-top |
| **Server-authoritative** | Prevents cheating. Clients send "intents", server validates and broadcasts "facts" |
| **JSON over WebSocket** | Simple, debuggable. For production, would switch to binary (MessagePack/Protobuf) |
| **In-memory state** | For a demo, fast and simple. Production would use Redis for shared state across instances |
| **Golden-angle colors** | `hue = index × 137.508°` guarantees maximally-separated colors regardless of player count |
| **Express + ws** | Minimal dependency surface. No framework lock-in. Easy to understand for reviewers |

---

## 🎮 Game Rules

1. **Click any unclaimed hex** to capture it — it turns your color
2. **Capture enemy hexes** to steal territory (their score drops, yours rises)
3. **Cooldown**: 400ms between captures (prevents spam clicking)
4. **Cell Lock**: A captured hex is immune to re-capture for 2 seconds (prevents frustrating back-and-forth)
5. **Persistence**: Your tiles stay even if you disconnect

---

## 🔧 Running Locally

```bash
# Install dependencies
npm install

# Start the server
npm start

# Or with auto-reload during development
npm run dev
```

Open `http://localhost:3000` in your browser. Open multiple tabs to simulate multiple players.

---

## 📁 Project Structure

```
gridverse/
├── server/
│   ├── index.js          # Express + WebSocket server, message routing
│   └── game.js           # Game state, rules, conflict resolution
├── public/
│   ├── index.html         # Semantic HTML5 with join modal + game UI
│   ├── css/
│   │   └── style.css      # Design system (dark theme, glassmorphism)
│   └── js/
│       ├── renderer.js    # Canvas hex grid, camera, animations
│       ├── socket.js      # WebSocket client with auto-reconnect
│       └── app.js         # Main orchestrator
├── package.json
├── .gitignore
└── README.md
```

---

## 🔌 WebSocket Protocol

### Client → Server

| Message | Fields | Purpose |
|---------|--------|---------|
| `join` | `name` | Register as a player |
| `capture` | `col, row` | Request to capture a hex |
| `ping` | — | Latency measurement |

### Server → Client

| Message | Fields | Purpose |
|---------|--------|---------|
| `welcome` | `playerId, color, grid, config, ...` | Full initial state sync |
| `captured` | `col, row, playerId, color` | Broadcast: a hex was captured |
| `capture_failed` | `reason, remaining` | Your capture was rejected |
| `leaderboard` | `data[]` | Updated top 10 |
| `player_joined` | `name, color, online` | New player notification |
| `player_left` | `playerId, online` | Player disconnect |
| `pong` | `t` | Response to ping |

---

## 🧠 Real-Time & Conflict Resolution

### The Problem
When two players click the same hex at ~the same time, who wins?

### The Solution: Authoritative Server

```
Player A clicks hex (5,3)  ──→  Server receives A's request first
Player B clicks hex (5,3)  ──→  Server receives B's request second

Server: validates A → success → broadcasts "A captured (5,3)"
Server: validates B → FAIL (cell locked for 2s) → sends "capture_failed" to B only
```

**Key design decisions:**
- **Server is the single source of truth** — no client-side state mutations without server confirmation
- **Optimistic cooldown on client** — the cooldown bar starts immediately (feels responsive), but the server independently validates
- **Cell locking** — prevents "capture wars" where two players rapidly trade a hex back and forth

---

## 🎨 Design Philosophy

- **Dark theme** with ambient gradient glows (not just "black background")
- **Glassmorphism** panels with backdrop-filter blur
- **Space Grotesk** for headings + **JetBrains Mono** for data — premium typography
- **Micro-animations**: ripple on capture, particle burst, hex flash, smooth camera interpolation
- **Minimal chrome**: the grid IS the interface. UI panels float as overlays, not fixed sidebar layouts

---

## 🚀 Production Considerations

If scaling beyond a single server:

| Concern | Solution |
|---------|----------|
| **State persistence** | Redis or PostgreSQL for grid state |
| **Horizontal scaling** | Redis Pub/Sub for cross-instance WebSocket broadcasts |
| **Rate limiting** | Token bucket per IP/user at the WebSocket layer |
| **Authentication** | JWT tokens validated on WebSocket upgrade |
| **Grid size scaling** | Spatial partitioning (quadtree) + viewport-based updates |
| **Bandwidth** | Binary protocol (MessagePack), delta updates instead of full state |

---

## 📜 License

MIT — use freely.
