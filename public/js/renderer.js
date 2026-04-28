/**
 * Gridverse — Hex Grid Renderer
 *
 * Canvas-based hex grid with:
 * - Pointy-top hexagons using offset (odd-r) coordinates
 * - Smooth zoom & pan with mouse/touch
 * - Capture ripple animations
 * - Hover highlighting
 * - Minimap rendering
 * - Territory glow effects
 */

// eslint-disable-next-line no-unused-vars
class HexRenderer {
  constructor(canvas, minimapCanvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.minimapCanvas = minimapCanvas;
    this.minimapCtx = minimapCanvas.getContext('2d');

    // Grid config (set by init())
    this.cols = 0;
    this.rows = 0;
    this.hexSize = 22; // radius

    // Camera
    this.camera = { x: 0, y: 0, zoom: 1 };
    this.targetCamera = { x: 0, y: 0, zoom: 1 };
    this.minZoom = 0.3;
    this.maxZoom = 3;

    // Interaction state
    this.hoveredHex = null;
    this.isDragging = false;
    this.dragStart = { x: 0, y: 0 };
    this.dragCameraStart = { x: 0, y: 0 };

    // Grid data: Map("col,row" -> { owner, color })
    this.gridData = new Map();

    // Animations
    this.animations = [];
    this.particleSystems = [];

    // Precomputed
    this.hexWidth = 0;
    this.hexHeight = 0;
    this.gridPixelWidth = 0;
    this.gridPixelHeight = 0;

    // Callbacks
    this.onHexClick = null;

    // Bind methods
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onMouseDown = this._onMouseDown.bind(this);
    this._onMouseUp = this._onMouseUp.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._onResize = this._onResize.bind(this);
    this._onMinimapClick = this._onMinimapClick.bind(this);

    this._setupEvents();
    this._resize();

    // Start render loop
    this._frameId = requestAnimationFrame(() => this._render());
  }

  init(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.hexWidth = Math.sqrt(3) * this.hexSize;
    this.hexHeight = 2 * this.hexSize;
    this.gridPixelWidth = this.hexWidth * (cols + 0.5);
    this.gridPixelHeight = this.hexHeight * 0.75 * (rows - 1) + this.hexHeight;

    // Center camera on grid
    this.camera.x = this.gridPixelWidth / 2 - this.canvas.clientWidth / 2;
    this.camera.y = this.gridPixelHeight / 2 - this.canvas.clientHeight / 2;
    this.targetCamera.x = this.camera.x;
    this.targetCamera.y = this.camera.y;
  }

  // ─── Coordinate Conversion ──────────────────────────────

  /** Hex grid (col, row) → pixel center (pointy-top, odd-r offset) */
  hexToPixel(col, row) {
    const x = this.hexSize * Math.sqrt(3) * (col + 0.5 * (row & 1));
    const y = this.hexSize * 1.5 * row;
    // Add padding
    return { x: x + this.hexWidth, y: y + this.hexHeight };
  }

  /** Screen pixel → hex grid (col, row) */
  screenToHex(sx, sy) {
    // Convert screen coords to world coords
    const wx = (sx / this.camera.zoom) + this.camera.x;
    const wy = (sy / this.camera.zoom) + this.camera.y;

    // Remove padding
    const px = wx - this.hexWidth;
    const py = wy - this.hexHeight;

    // Approximate hex from pixel (pointy-top, odd-r offset)
    // Convert to axial first
    const q = (Math.sqrt(3) / 3 * px - 1 / 3 * py) / this.hexSize;
    const r = (2 / 3 * py) / this.hexSize;

    // Round axial to nearest hex
    const hex = this._axialRound(q, r);

    // Convert axial back to offset (odd-r)
    const col = hex.q + Math.floor((hex.r - (hex.r & 1)) / 2);
    const row = hex.r;

    if (col >= 0 && col < this.cols && row >= 0 && row < this.rows) {
      return { col, row };
    }
    return null;
  }

  _axialRound(q, r) {
    const s = -q - r;
    let rq = Math.round(q);
    let rr = Math.round(r);
    const rs = Math.round(s);
    const qDiff = Math.abs(rq - q);
    const rDiff = Math.abs(rr - r);
    const sDiff = Math.abs(rs - s);
    if (qDiff > rDiff && qDiff > sDiff) {
      rq = -rr - rs;
    } else if (rDiff > sDiff) {
      rr = -rq - rs;
    }
    return { q: rq, r: rr };
  }

  // ─── Grid Data ──────────────────────────────────────────

  setCell(col, row, owner, color) {
    this.gridData.set(`${col},${row}`, { owner, color });
  }

  getCell(col, row) {
    return this.gridData.get(`${col},${row}`) || null;
  }

  loadGrid(gridState) {
    this.gridData.clear();
    for (const [key, val] of Object.entries(gridState)) {
      this.gridData.set(key, { owner: val.o, color: val.c });
    }
  }

  // ─── Animations ─────────────────────────────────────────

  addCaptureAnimation(col, row, color) {
    const pos = this.hexToPixel(col, row);

    // Ripple ring
    this.animations.push({
      type: 'ripple',
      x: pos.x, y: pos.y,
      color,
      startTime: performance.now(),
      duration: 700,
    });

    // Hex flash
    this.animations.push({
      type: 'flash',
      col, row,
      color,
      startTime: performance.now(),
      duration: 400,
    });

    // Particles
    this._spawnParticles(pos.x, pos.y, color, 8);
  }

  _spawnParticles(x, y, color, count) {
    const particles = [];
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 / count) * i + (Math.random() - 0.5) * 0.5;
      const speed = 40 + Math.random() * 60;
      particles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 1,
        decay: 1.5 + Math.random() * 1,
        size: 2 + Math.random() * 3,
      });
    }
    this.particleSystems.push({ color, particles, startTime: performance.now() });
  }

  // ─── Camera Controls ────────────────────────────────────

  zoomTo(level) {
    this.targetCamera.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, level));
  }

  zoomIn() {
    this.zoomTo(this.targetCamera.zoom * 1.3);
  }

  zoomOut() {
    this.zoomTo(this.targetCamera.zoom / 1.3);
  }

  resetView() {
    this.targetCamera.x = this.gridPixelWidth / 2 - this.canvas.clientWidth / 2;
    this.targetCamera.y = this.gridPixelHeight / 2 - this.canvas.clientHeight / 2;
    this.targetCamera.zoom = 1;
  }

  getZoomPercent() {
    return Math.round(this.camera.zoom * 100);
  }

  // ─── Event Handling ─────────────────────────────────────

  _setupEvents() {
    this.canvas.addEventListener('mousemove', this._onMouseMove);
    this.canvas.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    this.canvas.addEventListener('wheel', this._onWheel, { passive: false });
    window.addEventListener('resize', this._onResize);
    this.minimapCanvas.addEventListener('click', this._onMinimapClick);

    // Touch events
    this.canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const t = e.touches[0];
      this._onMouseDown({ clientX: t.clientX, clientY: t.clientY, button: 0 });
    }, { passive: false });

    this.canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      const t = e.touches[0];
      this._onMouseMove({ clientX: t.clientX, clientY: t.clientY });
    }, { passive: false });

    this.canvas.addEventListener('touchend', (e) => {
      e.preventDefault();
      this._onMouseUp({});
    });
  }

  _onMouseMove(e) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    if (this.isDragging) {
      const dx = e.clientX - this.dragStart.x;
      const dy = e.clientY - this.dragStart.y;
      this.targetCamera.x = this.dragCameraStart.x - dx / this.camera.zoom;
      this.targetCamera.y = this.dragCameraStart.y - dy / this.camera.zoom;
      this.canvas.style.cursor = 'grabbing';
      return;
    }

    this.hoveredHex = this.screenToHex(sx, sy);
    this.canvas.style.cursor = this.hoveredHex ? 'pointer' : 'crosshair';
  }

  _onMouseDown(e) {
    if (e.button === 0) {
      this.isDragging = true;
      this.dragStart = { x: e.clientX, y: e.clientY };
      this.dragCameraStart = { x: this.targetCamera.x, y: this.targetCamera.y };
      this._clickStart = { x: e.clientX, y: e.clientY, time: performance.now() };
    }
  }

  _onMouseUp(e) {
    if (this.isDragging && this._clickStart) {
      const dx = Math.abs((e.clientX || 0) - this._clickStart.x);
      const dy = Math.abs((e.clientY || 0) - this._clickStart.y);
      const dt = performance.now() - this._clickStart.time;

      // Detect click (small movement, short duration)
      if (dx < 6 && dy < 6 && dt < 300) {
        const rect = this.canvas.getBoundingClientRect();
        const sx = this._clickStart.x - rect.left;
        const sy = this._clickStart.y - rect.top;
        const hex = this.screenToHex(sx, sy);
        if (hex && this.onHexClick) {
          this.onHexClick(hex.col, hex.row);
        }
      }
    }
    this.isDragging = false;
    this.canvas.style.cursor = this.hoveredHex ? 'pointer' : 'crosshair';
  }

  _onWheel(e) {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const oldZoom = this.targetCamera.zoom;
    const zoomFactor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const newZoom = Math.max(this.minZoom, Math.min(this.maxZoom, oldZoom * zoomFactor));

    // Zoom toward mouse position
    const worldX = mx / oldZoom + this.camera.x;
    const worldY = my / oldZoom + this.camera.y;

    this.targetCamera.zoom = newZoom;
    this.targetCamera.x = worldX - mx / newZoom;
    this.targetCamera.y = worldY - my / newZoom;
  }

  _onMinimapClick(e) {
    const rect = this.minimapCanvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) / rect.width;
    const my = (e.clientY - rect.top) / rect.height;

    this.targetCamera.x = mx * this.gridPixelWidth - this.canvas.width / (2 * this.camera.zoom);
    this.targetCamera.y = my * this.gridPixelHeight - this.canvas.height / (2 * this.camera.zoom);
  }

  _onResize() {
    this._resize();
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = this.canvas.clientWidth * dpr;
    this.canvas.height = this.canvas.clientHeight * dpr;
    // Reset transform then apply DPR scale (prevents accumulation)
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Minimap
    const mmRect = this.minimapCanvas.getBoundingClientRect();
    this.minimapCanvas.width = mmRect.width * dpr;
    this.minimapCanvas.height = mmRect.height * dpr;
    this.minimapCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ─── Render Loop ────────────────────────────────────────

  _render() {
    this._frameId = requestAnimationFrame(() => this._render());

    // Smooth camera interpolation
    const lerp = 0.15;
    this.camera.x += (this.targetCamera.x - this.camera.x) * lerp;
    this.camera.y += (this.targetCamera.y - this.camera.y) * lerp;
    this.camera.zoom += (this.targetCamera.zoom - this.camera.zoom) * lerp;

    const ctx = this.ctx;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;

    // Clear
    ctx.clearRect(0, 0, w, h);

    // Draw background
    ctx.fillStyle = '#07080d';
    ctx.fillRect(0, 0, w, h);

    // Subtle radial glow in center of viewport
    const grd = ctx.createRadialGradient(w/2, h/2, 0, w/2, h/2, w * 0.6);
    grd.addColorStop(0, 'rgba(167, 139, 250, 0.03)');
    grd.addColorStop(1, 'transparent');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, w, h);

    // Apply camera transform
    ctx.save();
    ctx.scale(this.camera.zoom, this.camera.zoom);
    ctx.translate(-this.camera.x, -this.camera.y);

    // Draw grid
    this._drawGrid(ctx);

    // Draw animations
    this._drawAnimations(ctx);

    // Draw particles
    this._drawParticles(ctx);

    ctx.restore();

    // Draw minimap (every 10 frames for perf)
    if (!this._frameCount) this._frameCount = 0;
    this._frameCount++;
    if (this._frameCount % 10 === 0) {
      this._drawMinimap();
    }
  }

  _drawGrid(ctx) {
    const now = performance.now();

    // Determine visible bounds
    const left = this.camera.x - this.hexWidth;
    const top = this.camera.y - this.hexHeight;
    const right = this.camera.x + this.canvas.clientWidth / this.camera.zoom + this.hexWidth;
    const bottom = this.camera.y + this.canvas.clientHeight / this.camera.zoom + this.hexHeight;

    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const pos = this.hexToPixel(col, row);

        // Frustum culling
        if (pos.x < left || pos.x > right || pos.y < top || pos.y > bottom) continue;

        const cell = this.gridData.get(`${col},${row}`);
        const isHovered = this.hoveredHex && this.hoveredHex.col === col && this.hoveredHex.row === row;

        // Draw hex
        this._drawHex(ctx, pos.x, pos.y, cell, isHovered, now);
      }
    }
  }

  _drawHex(ctx, cx, cy, cell, isHovered, now) {
    const size = this.hexSize;
    const corners = [];

    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 180) * (60 * i - 30);
      corners.push({
        x: cx + size * Math.cos(angle),
        y: cy + size * Math.sin(angle),
      });
    }

    // Build path
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < 6; i++) {
      ctx.lineTo(corners[i].x, corners[i].y);
    }
    ctx.closePath();

    // Fill
    if (cell && cell.color) {
      ctx.fillStyle = cell.color;
      ctx.globalAlpha = 0.7;
      ctx.fill();
      ctx.globalAlpha = 1;

      // Inner glow
      ctx.fillStyle = cell.color;
      ctx.globalAlpha = 0.15;
      ctx.fill();
      ctx.globalAlpha = 1;
    } else {
      // Empty cell — subtle fill
      ctx.fillStyle = 'rgba(255, 255, 255, 0.015)';
      ctx.fill();
    }

    // Hover effect
    if (isHovered) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
      ctx.fill();

      // Hover glow
      ctx.save();
      ctx.shadowColor = 'rgba(167, 139, 250, 0.5)';
      ctx.shadowBlur = 15;
      ctx.strokeStyle = 'rgba(167, 139, 250, 0.6)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    }

    // Border
    ctx.strokeStyle = cell && cell.color
      ? this._adjustAlpha(cell.color, 0.4)
      : 'rgba(255, 255, 255, 0.04)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  _drawAnimations(ctx) {
    const now = performance.now();
    this.animations = this.animations.filter(anim => {
      const t = (now - anim.startTime) / anim.duration;
      if (t >= 1) return false;

      if (anim.type === 'ripple') {
        const radius = this.hexSize * (1 + t * 2.5);
        ctx.beginPath();
        ctx.arc(anim.x, anim.y, radius, 0, Math.PI * 2);
        ctx.strokeStyle = this._adjustAlpha(anim.color, 0.6 * (1 - t));
        ctx.lineWidth = 2 * (1 - t);
        ctx.stroke();
      }

      if (anim.type === 'flash') {
        const pos = this.hexToPixel(anim.col, anim.row);
        const size = this.hexSize;
        const corners = [];
        for (let i = 0; i < 6; i++) {
          const angle = (Math.PI / 180) * (60 * i - 30);
          corners.push({
            x: pos.x + size * Math.cos(angle),
            y: pos.y + size * Math.sin(angle),
          });
        }
        ctx.beginPath();
        ctx.moveTo(corners[0].x, corners[0].y);
        for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
        ctx.closePath();
        ctx.fillStyle = `rgba(255, 255, 255, ${0.4 * (1 - t)})`;
        ctx.fill();
      }

      return true;
    });
  }

  _drawParticles(ctx) {
    const now = performance.now();
    this.particleSystems = this.particleSystems.filter(sys => {
      const dt = (now - sys.startTime) / 1000;
      let alive = false;
      sys.particles.forEach(p => {
        p.life -= p.decay * (1/60);
        if (p.life <= 0) return;
        alive = true;
        p.x += p.vx * (1/60);
        p.y += p.vy * (1/60);
        p.vy += 30 * (1/60); // gravity
        p.vx *= 0.98;
        p.vy *= 0.98;

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
        ctx.fillStyle = this._adjustAlpha(sys.color, p.life * 0.8);
        ctx.fill();
      });
      return alive;
    });
  }

  _drawMinimap() {
    const mmCtx = this.minimapCtx;
    const mmW = this.minimapCanvas.clientWidth;
    const mmH = this.minimapCanvas.clientHeight;

    mmCtx.clearRect(0, 0, mmW, mmH);
    mmCtx.fillStyle = 'rgba(7, 8, 13, 0.9)';
    mmCtx.fillRect(0, 0, mmW, mmH);

    if (!this.cols || !this.rows) return;

    const scaleX = mmW / this.gridPixelWidth;
    const scaleY = mmH / this.gridPixelHeight;
    const scale = Math.min(scaleX, scaleY) * 0.85;
    const offsetX = (mmW - this.gridPixelWidth * scale) / 2;
    const offsetY = (mmH - this.gridPixelHeight * scale) / 2;

    // Draw cells as dots
    for (const [key, cell] of this.gridData) {
      if (!cell.color) continue;
      const [c, r] = key.split(',').map(Number);
      const pos = this.hexToPixel(c, r);

      mmCtx.fillStyle = cell.color;
      mmCtx.globalAlpha = 0.9;
      mmCtx.fillRect(
        offsetX + pos.x * scale - 1,
        offsetY + pos.y * scale - 1,
        3, 3
      );
    }
    mmCtx.globalAlpha = 1;

    // Draw viewport rectangle
    const vx = offsetX + this.camera.x * scale;
    const vy = offsetY + this.camera.y * scale;
    const vw = (this.canvas.clientWidth / this.camera.zoom) * scale;
    const vh = (this.canvas.clientHeight / this.camera.zoom) * scale;

    mmCtx.strokeStyle = 'rgba(167, 139, 250, 0.6)';
    mmCtx.lineWidth = 1;
    mmCtx.strokeRect(vx, vy, vw, vh);
  }

  // ─── Utility ────────────────────────────────────────────

  _adjustAlpha(color, alpha) {
    // Parse hsl(H, S%, L%) and add alpha
    if (color.startsWith('hsl(')) {
      return color.replace('hsl(', 'hsla(').replace(')', `, ${alpha})`);
    }
    // For hex or rgb
    return color;
  }
}
