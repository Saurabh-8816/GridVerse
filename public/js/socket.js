/**
 * Gridverse — WebSocket Client
 *
 * Handles connection, reconnection, and message routing.
 * Implements exponential backoff for reconnection.
 */

// eslint-disable-next-line no-unused-vars
class GridSocket {
  constructor() {
    this.ws = null;
    this.handlers = {};
    this.reconnectAttempts = 0;
    this.maxReconnectDelay = 10000;
    this.connected = false;
    this._pendingName = null;
  }

  /**
   * Connect to the WebSocket server.
   * Uses the current page's host to build the URL.
   */
  connect() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${location.host}`;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      this._emit("connected");

      // If we have a pending join, send it
      if (this._pendingName) {
        this.join(this._pendingName);
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this._emit(msg.type, msg);
      } catch (err) {
        console.error("Failed to parse message:", err);
      }
    };

    this.ws.onclose = () => {
      this.connected = false;
      this._emit("disconnected");
      this._scheduleReconnect();
    };

    this.ws.onerror = (err) => {
      console.error("WebSocket error:", err);
    };
  }

  /**
   * Register an event handler.
   * @param {string} event - Event name (matches msg.type or 'connected'/'disconnected')
   * @param {Function} handler - Callback function
   */
  on(event, handler) {
    if (!this.handlers[event]) this.handlers[event] = [];
    this.handlers[event].push(handler);
  }

  _emit(event, data) {
    const handlers = this.handlers[event];
    if (handlers) {
      handlers.forEach((fn) => fn(data));
    }
  }

  /** Send a message to the server */
  _send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /** Join the game with a username */
  join(name) {
    this._pendingName = name;
    this._send({ type: "join", name });
  }

  /** Request to capture a hex cell */
  capture(col, row) {
    this._send({ type: "capture", col, row });
  }

  /** Send ping for latency measurement */
  ping() {
    this._send({ type: "ping" });
  }

  /** Request a full grid reset */
  reset() {
    this._send({ type: "reset" });
  }

  /** Undo the last capture */
  undo() {
    this._send({ type: "undo" });
  }

  /** Erase (release) one of the player's own hex cells */
  erase(col, row) {
    this._send({ type: "erase", col, row });
  }

  /** Exponential backoff reconnection */
  _scheduleReconnect() {
    const delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), this.maxReconnectDelay);
    this.reconnectAttempts++;

    console.log(`Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts})...`);

    setTimeout(() => {
      if (!this.connected) {
        this.connect();
      }
    }, delay);
  }
}
