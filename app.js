// ═══════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════
let W = 32, H = 32, ZOOM = 8;
let currentTool = 'pencil';
let fgColor = '#000000', bgColor = '#ffffff';
let brushSize = 1, brushOpacity = 1.0;
let isDrawing = false;
let lastPx = -1, lastPy = -1;
let showGrid = true;

// Layers: [{name, canvas, ctx, visible}]
// layers[0] = bottom, layers[length-1] = top
let layers = [];
let activeLayerIdx = 0;

// Undo/redo
let undoStack = [], redoStack = [];
const MAX_UNDO = 50;

// Selection
let sel = null;     // {x, y, w, h}
let selCanvas = null; // clipboard canvas

// Line/rect/ellipse drag
let shapeStart = null;

// Move tool
let moveStart = null, moveOrig = null;

// Palette
let palette = [];
let selectedPaletteIdx = -1;

// Active color picker target ('fg' | 'bg')
let pickerTarget = 'fg';

// Layer drag-and-drop
let dragSrcIdx = null;

// Reference image position (offset from canvas-wrap top-left, in screen px)
let refOffsetX = 0, refOffsetY = 0;

// DOM references
const mainCanvas   = document.getElementById('main-canvas');
const overlayCanvas = document.getElementById('overlay-canvas');
const mainCtx      = mainCanvas.getContext('2d');
const overlayCtx   = overlayCanvas.getContext('2d');

// ═══════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════
function init() {
  createNewCanvasData(32, 32, 'transparent');
  loadPreset('garden_project');
  updateZoom();
  renderAll();
}

function createNewCanvasData(w, h, bg) {
  W = w; H = h;
  layers = [];
  addLayerData('Layer 1');
  if (bg !== 'transparent') {
    const l = layers[0];
    l.ctx.fillStyle = bg;
    l.ctx.fillRect(0, 0, W, H);
  }
  activeLayerIdx = 0;
  undoStack = []; redoStack = [];
  sel = null; selCanvas = null;
  mainCanvas.width = W; mainCanvas.height = H;
  overlayCanvas.width = W; overlayCanvas.height = H;
  clearRef();
  document.getElementById('size-display').textContent = `${W} × ${H}`;
  renderLayersList();
  renderAll();
}

// ═══════════════════════════════════════════════════
//  LAYERS
// ═══════════════════════════════════════════════════
function addLayerData(name) {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  layers.push({ name: name || `Layer ${layers.length + 1}`, canvas: c, ctx, visible: true });
  activeLayerIdx = layers.length - 1;
}

function addLayer() {
  saveUndo();
  addLayerData();
  renderLayersList();
  renderAll();
}

function duplicateLayer() {
  saveUndo();
  const src = layers[activeLayerIdx];
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.drawImage(src.canvas, 0, 0);
  layers.splice(activeLayerIdx + 1, 0, { name: src.name + ' copy', canvas: c, ctx, visible: true });
  activeLayerIdx++;
  renderLayersList();
  renderAll();
}

function deleteLayer() {
  if (layers.length <= 1) return;
  saveUndo();
  layers.splice(activeLayerIdx, 1);
  if (activeLayerIdx >= layers.length) activeLayerIdx = layers.length - 1;
  renderLayersList();
  renderAll();
}

function mergeDown() {
  // "down" = lower index = lower in visual stack
  if (activeLayerIdx <= 0) return;
  saveUndo();
  const above = layers[activeLayerIdx];
  const below = layers[activeLayerIdx - 1];
  below.ctx.drawImage(above.canvas, 0, 0);
  layers.splice(activeLayerIdx, 1);
  activeLayerIdx = Math.max(0, activeLayerIdx - 1);
  renderLayersList();
  renderAll();
}

function renderLayersList() {
  const el = document.getElementById('layers-list');
  el.innerHTML = '';
  // Show top layer first in UI (reverse visual order)
  [...layers].reverse().forEach((l, ri) => {
    const i = layers.length - 1 - ri;
    const div = document.createElement('div');
    div.className = 'layer-item' + (i === activeLayerIdx ? ' active' : '');
    div.draggable = true;
    div.onclick = () => { activeLayerIdx = i; renderLayersList(); };

    // ── Drag-and-drop reorder ──
    div.addEventListener('dragstart', e => {
      dragSrcIdx = i;
      e.dataTransfer.effectAllowed = 'move';
      // Defer so the dragging style applies after the drag image is captured
      requestAnimationFrame(() => div.classList.add('dragging'));
    });
    div.addEventListener('dragend', () => {
      dragSrcIdx = null;
      document.querySelectorAll('.layer-item').forEach(d => {
        d.classList.remove('dragging', 'drag-over');
      });
    });
    div.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      document.querySelectorAll('.layer-item').forEach(d => d.classList.remove('drag-over'));
      if (dragSrcIdx !== i) div.classList.add('drag-over');
    });
    div.addEventListener('dragleave', () => div.classList.remove('drag-over'));
    div.addEventListener('drop', e => {
      e.preventDefault();
      div.classList.remove('drag-over');
      if (dragSrcIdx === null || dragSrcIdx === i) return;
      saveUndo();
      const activeLayer = layers[activeLayerIdx]; // track by reference
      const [moved] = layers.splice(dragSrcIdx, 1);
      layers.splice(i, 0, moved);
      activeLayerIdx = layers.indexOf(activeLayer);
      renderLayersList(); renderAll();
    });

    const thumb = document.createElement('div');
    thumb.className = 'layer-thumb';
    const tc = document.createElement('canvas');
    tc.width = W; tc.height = H;
    tc.getContext('2d').drawImage(l.canvas, 0, 0);
    tc.style.cssText = 'width:100%;height:100%;image-rendering:pixelated;display:block;';
    thumb.appendChild(tc);

    const name = document.createElement('span');
    name.className = 'layer-name';
    name.textContent = l.name;
    name.ondblclick = (e) => {
      e.stopPropagation();
      const newN = prompt('Layer name:', l.name);
      if (newN) { l.name = newN; renderLayersList(); }
    };

    const vis = document.createElement('button');
    vis.className = 'layer-vis';
    vis.textContent = l.visible ? '👁' : '🚫';
    vis.onclick = (e) => {
      e.stopPropagation();
      l.visible = !l.visible;
      renderLayersList(); renderAll();
    };

    div.appendChild(thumb); div.appendChild(name); div.appendChild(vis);
    el.appendChild(div);
  });
}

function updateLayerThumbs() { renderLayersList(); }

// ═══════════════════════════════════════════════════
//  RENDER
// ═══════════════════════════════════════════════════
function renderAll() {
  mainCtx.clearRect(0, 0, W, H);
  // Draw bottom to top: index 0 first, index length-1 last (appears on top)
  for (let i = 0; i < layers.length; i++) {
    const l = layers[i];
    if (!l.visible) continue;
    mainCtx.globalAlpha = (l.opacity !== undefined) ? l.opacity : 1;
    mainCtx.drawImage(l.canvas, 0, 0);
  }
  mainCtx.globalAlpha = 1;
  drawOverlay();
}

function drawOverlay() {
  overlayCtx.clearRect(0, 0, W, H);
  if (showGrid && ZOOM >= 4) {
    overlayCtx.save();
    overlayCtx.scale(1 / ZOOM, 1 / ZOOM);
    overlayCtx.strokeStyle = 'rgba(255,255,255,0.07)';
    overlayCtx.lineWidth = 0.5;
    for (let x = 0; x <= W; x++) {
      overlayCtx.beginPath();
      overlayCtx.moveTo(x * ZOOM, 0);
      overlayCtx.lineTo(x * ZOOM, H * ZOOM);
      overlayCtx.stroke();
    }
    for (let y = 0; y <= H; y++) {
      overlayCtx.beginPath();
      overlayCtx.moveTo(0, y * ZOOM);
      overlayCtx.lineTo(W * ZOOM, y * ZOOM);
      overlayCtx.stroke();
    }
    overlayCtx.restore();
  }
  // Draw selection marquee
  if (sel) {
    overlayCtx.save();
    overlayCtx.setLineDash([2, 2]);
    overlayCtx.strokeStyle = '#e8ff47';
    overlayCtx.lineWidth = 1 / ZOOM;
    overlayCtx.strokeRect(sel.x + 0.5 / ZOOM, sel.y + 0.5 / ZOOM, sel.w, sel.h);
    overlayCtx.restore();
  }
}

// ═══════════════════════════════════════════════════
//  ZOOM & PAN
// ═══════════════════════════════════════════════════
function updateZoom() {
  const pw = W * ZOOM, ph = H * ZOOM;
  mainCanvas.style.width = pw + 'px';
  mainCanvas.style.height = ph + 'px';
  overlayCanvas.style.width = pw + 'px';
  overlayCanvas.style.height = ph + 'px';
  // Checkerboard square = 1 pixel = ZOOM screen px (min 2px for visibility)
  const sq = Math.max(ZOOM, 2);
  const checker = document.getElementById('checker-bg');
  checker.style.width = pw + 'px';
  checker.style.height = ph + 'px';
  checker.style.backgroundSize = `${sq * 2}px ${sq * 2}px`;
  document.getElementById('zoom-label').textContent = ZOOM + '×';
  updateBrushCursor(-999, -999);
  repositionRef();
}

function zoomIn()  { ZOOM = Math.min(ZOOM >= 1 ? ZOOM + (ZOOM >= 8 ? 4 : 1) : ZOOM * 2, 64); updateZoom(); drawOverlay(); }
function zoomOut() { ZOOM = Math.max(ZOOM > 8 ? ZOOM - 4 : ZOOM > 1 ? ZOOM - 1 : ZOOM, 1);  updateZoom(); drawOverlay(); }
function zoomFit() {
  const area = document.getElementById('canvas-area');
  const zx = Math.floor((area.clientWidth - 40) / W);
  const zy = Math.floor((area.clientHeight - 40) / H);
  ZOOM = Math.max(1, Math.min(zx, zy));
  updateZoom(); drawOverlay();
}

// Wheel zoom
document.getElementById('canvas-area').addEventListener('wheel', e => {
  e.preventDefault();
  if (e.deltaY < 0) zoomIn(); else zoomOut();
}, { passive: false });

// ═══════════════════════════════════════════════════
//  CANVAS MOUSE EVENTS
// ═══════════════════════════════════════════════════
function getPixelPos(e) {
  const rect = mainCanvas.getBoundingClientRect();
  const x = Math.floor((e.clientX - rect.left) / ZOOM);
  const y = Math.floor((e.clientY - rect.top) / ZOOM);
  return { x, y };
}

mainCanvas.addEventListener('mousedown', e => {
  if (e.button === 2) {
    // Right-click on pencil = erase; everywhere else = context menu
    if (currentTool === 'pencil') {
      const pos = getPixelPos(e);
      isDrawing = true;
      handleToolStart(pos.x, pos.y, e);
    } else {
      openCtxMenu(e);
    }
    return;
  }
  const pos = getPixelPos(e);
  isDrawing = true;
  handleToolStart(pos.x, pos.y, e);
});
mainCanvas.addEventListener('mousemove', e => {
  const pos = getPixelPos(e);
  updateStatus(pos.x, pos.y);
  if (isDrawing) handleToolMove(pos.x, pos.y, e);
  else handleToolHover(pos.x, pos.y);
  if (['pencil', 'eraser'].includes(currentTool)) updateBrushCursor(pos.x, pos.y);
});
mainCanvas.addEventListener('mouseup', e => {
  if (!isDrawing) return;
  const pos = getPixelPos(e);
  handleToolEnd(pos.x, pos.y, e);
  isDrawing = false;
  lastPx = -1; lastPy = -1;
});
mainCanvas.addEventListener('mouseleave', e => {
  hideBrushCursor();
  if (isDrawing) {
    const pos = getPixelPos(e);
    handleToolEnd(pos.x, pos.y, e);
    isDrawing = false;
  }
});
mainCanvas.addEventListener('contextmenu', e => e.preventDefault());

// ═══════════════════════════════════════════════════
//  TOOL LOGIC
// ═══════════════════════════════════════════════════
function setTool(t) {
  currentTool = t;
  document.querySelectorAll('.tool-btn[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  document.getElementById('status-tool').textContent = t;
  mainCanvas.style.cursor = t === 'move' ? 'move' : 'crosshair';
}

function handleToolStart(x, y, e) {
  const layer = layers[activeLayerIdx];
  if (!layer) return;

  if (currentTool === 'eyedropper') { pickColor(x, y); return; }

  if (currentTool === 'fill') {
    saveUndo();
    const fillColor = e.shiftKey ? bgColor : fgColor;
    floodFill(layer.ctx, x, y, hexToRGBA(fillColor));
    renderAll(); updateLayerThumbs(); return;
  }
  if (currentTool === 'select') {
    sel = { x, y, w: 0, h: 0 };
    shapeStart = { x, y };
    return;
  }
  if (currentTool === 'move') {
    if (sel) {
      moveStart = { x, y };
      moveOrig = captureSelection();
    }
    return;
  }
  if (['line', 'rect', 'ellipse'].includes(currentTool)) {
    shapeStart = { x, y };
    saveUndo();
    return;
  }
  // pencil / eraser
  saveUndo();
  drawPixel(layer.ctx, x, y, e);
  lastPx = x; lastPy = y;
  renderAll(); updateLayerThumbs();
}

function handleToolMove(x, y, e) {
  const layer = layers[activeLayerIdx];
  if (!layer) return;

  if (currentTool === 'select' && shapeStart) {
    sel = normalizeRect(shapeStart.x, shapeStart.y, x, y);
    drawOverlay(); return;
  }
  if (currentTool === 'eyedropper') { pickColor(x, y); return; }
  if (['line', 'rect', 'ellipse'].includes(currentTool) && shapeStart) {
    overlayCtx.clearRect(0, 0, W, H);
    drawShapePreview(overlayCtx, shapeStart.x, shapeStart.y, x, y, fgColor);
    return;
  }
  if (currentTool === 'pencil' || currentTool === 'eraser') {
    if (lastPx >= 0) {
      drawLine(layer.ctx, lastPx, lastPy, x, y, e);
    } else {
      drawPixel(layer.ctx, x, y, e);
    }
    lastPx = x; lastPy = y;
    renderAll(); updateLayerThumbs();
  }
}

function handleToolEnd(x, y) {
  const layer = layers[activeLayerIdx];
  if (!layer) return;

  if (currentTool === 'select' && shapeStart) {
    sel = normalizeRect(shapeStart.x, shapeStart.y, x, y);
    if (sel.w === 0 && sel.h === 0) sel = null;
    shapeStart = null;
    drawOverlay(); return;
  }
  if (['line', 'rect', 'ellipse'].includes(currentTool) && shapeStart) {
    drawShape(layer.ctx, shapeStart.x, shapeStart.y, x, y, fgColor);
    shapeStart = null;
    overlayCtx.clearRect(0, 0, W, H);
    drawOverlay();
    renderAll(); updateLayerThumbs();
  }
}

function handleToolHover(x, y) {
  if (['pencil', 'eraser'].includes(currentTool)) updateBrushCursor(x, y);
  else hideBrushCursor();
}

function updateBrushCursor(x, y) {
  const cur = document.getElementById('brush-cursor');
  if (!inBounds(x, y)) { cur.style.display = 'none'; return; }
  const half = Math.floor(brushSize / 2);
  const size = brushSize * ZOOM;
  cur.style.display = 'block';
  cur.style.left   = ((x - half) * ZOOM) + 'px';
  cur.style.top    = ((y - half) * ZOOM) + 'px';
  cur.style.width  = size + 'px';
  cur.style.height = size + 'px';
}

function hideBrushCursor() {
  document.getElementById('brush-cursor').style.display = 'none';
}

function inBounds(x, y) { return x >= 0 && x < W && y >= 0 && y < H; }

function drawPixel(ctx, x, y, e) {
  if (!inBounds(x, y)) return;
  const s = brushSize;
  const ox = x - Math.floor(s / 2);
  const oy = y - Math.floor(s / 2);
  const isRightClick = e && (e.button === 2 || (e.buttons & 2));
  if (currentTool === 'eraser' || isRightClick) {
    ctx.clearRect(ox, oy, s, s);
  } else {
    ctx.globalAlpha = brushOpacity;
    ctx.fillStyle = fgColor;
    ctx.fillRect(ox, oy, s, s);
    ctx.globalAlpha = 1;
  }
}

function drawLine(ctx, x0, y0, x1, y1, e) {
  // Bresenham line algorithm
  let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  let sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  while (true) {
    drawPixel(ctx, x0, y0, e);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx)  { err += dx; y0 += sy; }
  }
}

function drawShape(ctx, x0, y0, x1, y1, color) {
  ctx.globalAlpha = brushOpacity;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = brushSize;
  if (currentTool === 'line') {
    ctx.beginPath(); ctx.moveTo(x0 + .5, y0 + .5); ctx.lineTo(x1 + .5, y1 + .5); ctx.stroke();
  } else if (currentTool === 'rect') {
    const r = normalizeRect(x0, y0, x1, y1);
    ctx.strokeRect(r.x + .5, r.y + .5, r.w, r.h);
  } else if (currentTool === 'ellipse') {
    const r = normalizeRect(x0, y0, x1, y1);
    ctx.beginPath();
    ctx.ellipse(r.x + r.w / 2 + .5, r.y + r.h / 2 + .5, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawShapePreview(ctx, x0, y0, x1, y1, color) {
  ctx.globalAlpha = 0.7;
  ctx.strokeStyle = color;
  ctx.lineWidth = brushSize / ZOOM;
  if (currentTool === 'line') {
    ctx.beginPath(); ctx.moveTo(x0 + .5, y0 + .5); ctx.lineTo(x1 + .5, y1 + .5); ctx.stroke();
  } else if (currentTool === 'rect') {
    const r = normalizeRect(x0, y0, x1, y1);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
  } else if (currentTool === 'ellipse') {
    const r = normalizeRect(x0, y0, x1, y1);
    ctx.beginPath();
    ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, Math.max(1, r.w / 2), Math.max(1, r.h / 2), 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  drawOverlay();
}

function normalizeRect(x0, y0, x1, y1) {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}

// ═══════════════════════════════════════════════════
//  FLOOD FILL
// ═══════════════════════════════════════════════════
function floodFill(ctx, sx, sy, fillColor) {
  const id = ctx.getImageData(0, 0, W, H);
  const d = id.data;
  const idx = (y, x) => (y * W + x) * 4;
  const target = d.slice(idx(sy, sx), idx(sy, sx) + 4);
  if (colorsMatch(target, fillColor)) return;
  const stack = [[sx, sy]];
  const visited = new Uint8Array(W * H);
  while (stack.length) {
    const [x, y] = stack.pop();
    if (x < 0 || x >= W || y < 0 || y >= H || visited[y * W + x]) continue;
    const i = idx(y, x);
    if (!colorsMatch(d.slice(i, i + 4), target)) continue;
    visited[y * W + x] = 1;
    d[i] = fillColor[0]; d[i + 1] = fillColor[1]; d[i + 2] = fillColor[2]; d[i + 3] = fillColor[3];
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  ctx.putImageData(id, 0, 0);
}

function colorsMatch(a, b, tol = 2) {
  return Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol &&
         Math.abs(a[2] - b[2]) <= tol && Math.abs(a[3] - b[3]) <= tol;
}

function hexToRGBA(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
    255
  ];
}

// ═══════════════════════════════════════════════════
//  EYEDROPPER
// ═══════════════════════════════════════════════════
function pickColor(x, y) {
  if (!inBounds(x, y)) return;
  const data = mainCtx.getImageData(x, y, 1, 1).data;
  if (data[3] === 0) return;
  fgColor = '#' + [data[0], data[1], data[2]].map(v => v.toString(16).padStart(2, '0')).join('');
  updateColorUI();
}

// ═══════════════════════════════════════════════════
//  COLOR UI
// ═══════════════════════════════════════════════════
function updateColorUI() {
  document.getElementById('fg-swatch').style.background = fgColor;
  document.getElementById('bg-swatch').style.background = bgColor;
  const active = pickerTarget === 'fg' ? fgColor : bgColor;
  document.getElementById('hex-input').value = active.replace('#', '');
  document.getElementById('color-picker-native').value = active;
  document.getElementById('status-color').textContent = fgColor;
}

function openColorPicker(target) {
  pickerTarget = target;
  const active = target === 'fg' ? fgColor : bgColor;
  document.getElementById('hex-input').value = active.replace('#', '');
  document.getElementById('color-picker-native').value = active;
  document.getElementById('hex-input').focus();
}

function setColorFromHex(h) {
  h = h.replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return;
  const color = '#' + h.toUpperCase();
  if (pickerTarget === 'fg') fgColor = color; else bgColor = color;
  updateColorUI();
}

function liveHexPreview(h) {
  if (/^[0-9a-fA-F]{6}$/.test(h)) setColorFromHex(h);
}

function setFromNativePicker(v) {
  if (pickerTarget === 'fg') fgColor = v; else bgColor = v;
  document.getElementById('hex-input').value = v.replace('#', '');
  updateColorUI();
}

function swapColors() { [fgColor, bgColor] = [bgColor, fgColor]; updateColorUI(); }

// ═══════════════════════════════════════════════════
//  PALETTE
// ═══════════════════════════════════════════════════
function renderPalette() {
  const grid = document.getElementById('palette-grid');
  grid.innerHTML = '';
  palette.forEach((c, i) => {
    const cell = document.createElement('div');
    cell.className = 'pal-cell' + (i === selectedPaletteIdx ? ' selected' : '');
    cell.style.background = c;
    cell.title = c;
    cell.onclick = () => {
      selectedPaletteIdx = i;
      fgColor = c;
      pickerTarget = 'fg';
      updateColorUI();
      renderPalette();
    };
    cell.ondblclick = () => {
      const newC = prompt('Edit color (hex):', c);
      if (newC && /^#?[0-9a-fA-F]{6}$/.test(newC)) {
        palette[i] = newC.startsWith('#') ? newC : '#' + newC;
        renderPalette();
      }
    };
    grid.appendChild(cell);
  });
}

function addColorToPalette() {
  if (!palette.includes(fgColor)) {
    palette.push(fgColor);
    renderPalette();
  }
}

function removeSelectedPaletteColor() {
  if (selectedPaletteIdx >= 0) {
    palette.splice(selectedPaletteIdx, 1);
    selectedPaletteIdx = -1;
    renderPalette();
  }
}

function clearPalette() { palette = []; selectedPaletteIdx = -1; renderPalette(); }

const PRESETS = {
  garden_project: ['#eaf8f6','#d0f0ec','#30c8b0','#1a9e8a','#e8e0f8','#58e890','#e840a0','#f0d030','#3828a8','#080818'],
  gameboy:        ['#0f380f','#306230','#8bac0f','#9bbc0f'],
  nes:            ['#000000','#fcfcfc','#f8f8f8','#bcbcbc','#7c7c7c','#a4e4fc','#3cbcfc','#0078f8',
                   '#0000fc','#b8b8f8','#6888fc','#0058f8','#0044fc','#f8b8f8','#c848c8','#8800a8'],
  pico8:          ['#000000','#1d2b53','#7e2553','#008751','#ab5236','#5f574f','#c2c3c7','#fff1e8',
                   '#ff004d','#ffa300','#ffec27','#00e436','#29adff','#83769c','#ff77a8','#ffccaa'],
  endesga32:      ['#be4a2f','#d77643','#ead4aa','#e4a672','#b86f50','#733e39','#3e2731',
                   '#a22633','#e43b44','#f77622','#feae34','#fee761','#63c74d','#3e8948',
                   '#265c42','#193c3e','#124e89','#0099db','#2ce8f5','#ffffff','#c0cbdc',
                   '#8b9bb4','#5a6988','#3a4466','#262b44','#181425','#ff0044','#68386c',
                   '#b55088','#f6757a','#e8b796','#c28569'],
  apollo:         ['#172038','#253a5e','#3c5e8b','#4f8fba','#73bed3','#a4dddb','#19332d','#25562e',
                   '#468232','#75a743','#a8ca58','#d0da91','#4d2b32','#7a4841','#ad7757','#c09473',
                   '#d7b594','#e7d5b3','#341c27','#602c2c','#884b2b','#be772b','#de9e41','#e8c170',
                   '#241527','#411d31','#752438','#a53030','#cf573c','#da863e','#1e1d39','#402751',
                   '#7a367b','#a23e8c','#c65197','#df84a5','#090a14','#10141f','#151d28','#202e37',
                   '#394a50','#577277']
};

function loadPreset(name) {
  if (!PRESETS[name]) return;
  palette = [...PRESETS[name]];
  selectedPaletteIdx = -1;
  renderPalette();
}

function openPaletteImport() {
  document.getElementById('palette-import-text').value = '';
  openModal('modal-palette-import');
}

function importPaletteFromText() {
  const raw = document.getElementById('palette-import-text').value;
  const matches = raw.match(/#?[0-9a-fA-F]{6}/g) || [];
  const colors = matches.map(m => m.startsWith('#') ? m.toUpperCase() : '#' + m.toUpperCase());
  if (colors.length === 0) { alert('No valid hex codes found.'); return; }
  palette = [...new Set(colors)];
  selectedPaletteIdx = -1;
  renderPalette();
  closeModal('modal-palette-import');
}

// ═══════════════════════════════════════════════════
//  UNDO / REDO
// ═══════════════════════════════════════════════════

// Creates a deep snapshot of the current layer state.
function snapshotLayers() {
  return {
    layers: layers.map(l => {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      c.getContext('2d').drawImage(l.canvas, 0, 0);
      return { name: l.name, canvas: c, visible: l.visible };
    }),
    activeLayerIdx
  };
}

function saveUndo() {
  undoStack.push(snapshotLayers());
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack = [];
}

function restoreSnap(snap) {
  layers = snap.layers.map(s => {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(s.canvas, 0, 0);
    return { name: s.name, canvas: c, ctx, visible: s.visible };
  });
  activeLayerIdx = snap.activeLayerIdx;
}

function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshotLayers());
  restoreSnap(undoStack.pop());
  renderLayersList(); renderAll(); updateLayerThumbs();
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshotLayers());
  restoreSnap(redoStack.pop());
  renderLayersList(); renderAll(); updateLayerThumbs();
}

// ═══════════════════════════════════════════════════
//  TRANSFORMS
// ═══════════════════════════════════════════════════
function flipH() {
  saveUndo();
  const layer = layers[activeLayerIdx];
  const tmp = document.createElement('canvas');
  tmp.width = W; tmp.height = H;
  const tc = tmp.getContext('2d');
  tc.translate(W, 0); tc.scale(-1, 1);
  tc.drawImage(layer.canvas, 0, 0);
  layer.ctx.clearRect(0, 0, W, H);
  layer.ctx.drawImage(tmp, 0, 0);
  renderAll(); updateLayerThumbs();
}

function flipV() {
  saveUndo();
  const layer = layers[activeLayerIdx];
  const tmp = document.createElement('canvas');
  tmp.width = W; tmp.height = H;
  const tc = tmp.getContext('2d');
  tc.translate(0, H); tc.scale(1, -1);
  tc.drawImage(layer.canvas, 0, 0);
  layer.ctx.clearRect(0, 0, W, H);
  layer.ctx.drawImage(tmp, 0, 0);
  renderAll(); updateLayerThumbs();
}

function rotate90() {
  saveUndo();
  const layer = layers[activeLayerIdx];
  const tmp = document.createElement('canvas');
  tmp.width = H; tmp.height = W;
  const tc = tmp.getContext('2d');
  tc.translate(H, 0); tc.rotate(Math.PI / 2);
  tc.drawImage(layer.canvas, 0, 0);
  // NOTE: only works correctly for square canvases (W === H)
  layer.ctx.clearRect(0, 0, W, H);
  layer.ctx.drawImage(tmp, 0, 0, W, H);
  renderAll(); updateLayerThumbs();
}

// ═══════════════════════════════════════════════════
//  SELECTION
// ═══════════════════════════════════════════════════
function captureSelection() {
  if (!sel) return null;
  const c = document.createElement('canvas');
  c.width = sel.w || 1; c.height = sel.h || 1;
  c.getContext('2d').drawImage(layers[activeLayerIdx].canvas, sel.x, sel.y, sel.w, sel.h, 0, 0, sel.w, sel.h);
  return c;
}

function ctxCopy() {
  if (!sel) return;
  selCanvas = captureSelection();
}

function ctxCut() {
  if (!sel) return;
  saveUndo();
  selCanvas = captureSelection();
  layers[activeLayerIdx].ctx.clearRect(sel.x, sel.y, sel.w, sel.h);
  renderAll(); updateLayerThumbs();
}

function ctxPaste() {
  if (!selCanvas) return;
  saveUndo();
  const x = sel ? sel.x : 0, y = sel ? sel.y : 0;
  layers[activeLayerIdx].ctx.drawImage(selCanvas, x, y);
  renderAll(); updateLayerThumbs();
}

function ctxFill() {
  if (!sel) return;
  saveUndo();
  layers[activeLayerIdx].ctx.fillStyle = fgColor;
  layers[activeLayerIdx].ctx.fillRect(sel.x, sel.y, sel.w, sel.h);
  renderAll(); updateLayerThumbs();
}

function ctxClear() {
  if (!sel) return;
  saveUndo();
  layers[activeLayerIdx].ctx.clearRect(sel.x, sel.y, sel.w, sel.h);
  renderAll(); updateLayerThumbs();
}

function selectAll() { sel = { x: 0, y: 0, w: W, h: H }; drawOverlay(); }
function deselect()  { sel = null; drawOverlay(); }

// ═══════════════════════════════════════════════════
//  STATUS BAR
// ═══════════════════════════════════════════════════
function updateStatus(x, y) {
  if (!inBounds(x, y)) return;
  const data = mainCtx.getImageData(x, y, 1, 1).data;
  const hex = data[3] > 0
    ? '#' + [data[0], data[1], data[2]].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase()
    : 'transparent';
  document.getElementById('status-pos').textContent = `${x}, ${y}`;
  document.getElementById('status-color').textContent = hex;
}

// ═══════════════════════════════════════════════════
//  CONTEXT MENU
// ═══════════════════════════════════════════════════
function openCtxMenu(e) {
  e.preventDefault();
  const m = document.getElementById('ctx-menu');
  m.style.left = e.clientX + 'px';
  m.style.top  = e.clientY + 'px';
  m.classList.add('open');
}
document.addEventListener('click', () => document.getElementById('ctx-menu').classList.remove('open'));

// ═══════════════════════════════════════════════════
//  REFERENCE IMAGE — floating, draggable, resizable
// ═══════════════════════════════════════════════════
(function () {
  let dragMode = null; // 'move' | 'resize'
  let ox = 0, oy = 0, startW = 0, startH = 0, startX = 0, startY = 0;

  // app.js runs at end of <body>, so the DOM is already ready — no DOMContentLoaded needed.
  const panel        = document.getElementById('ref-float');
  const bar          = document.getElementById('ref-float-bar');
  const resizeHandle = document.getElementById('ref-resize');
  const wrap         = document.getElementById('ref-img-wrap');

  bar.addEventListener('mousedown', e => {
    if (e.target.tagName === 'BUTTON') return;
    dragMode = 'move';
    const r = panel.getBoundingClientRect();
    ox = e.clientX - r.left;
    oy = e.clientY - r.top;
    e.preventDefault();
  });

  resizeHandle.addEventListener('mousedown', e => {
    dragMode = 'resize';
    const r = wrap.getBoundingClientRect();
    startW = r.width;
    startH = r.height;
    startX = e.clientX;
    startY = e.clientY;
    e.preventDefault();
    e.stopPropagation();
  });

  document.addEventListener('mousemove', e => {
    if (!dragMode) return;
    const area       = document.getElementById('canvas-area').getBoundingClientRect();
    const canvasRect = document.getElementById('canvas-wrap').getBoundingClientRect();
    if (dragMode === 'move') {
      const newLeft = e.clientX - area.left - ox;
      const newTop  = e.clientY - area.top  - oy;
      panel.style.left = newLeft + 'px';
      panel.style.top  = newTop  + 'px';
      // Store offset from canvas-wrap so repositionRef can restore it on zoom change
      refOffsetX = newLeft - (canvasRect.left - area.left);
      refOffsetY = newTop  - (canvasRect.top  - area.top);
    } else if (dragMode === 'resize') {
      wrap.style.width  = Math.max(80, startW + (e.clientX - startX)) + 'px';
      wrap.style.height = Math.max(60, startH + (e.clientY - startY)) + 'px';
    }
  });

  document.addEventListener('mouseup', () => { dragMode = null; });
})();

function triggerImportRef() { document.getElementById('import-ref-input').click(); }

function repositionRef() {
  const floatEl = document.getElementById('ref-float');
  if (!floatEl || floatEl.style.display === 'none') return;
  const area       = document.getElementById('canvas-area').getBoundingClientRect();
  const canvasRect = document.getElementById('canvas-wrap').getBoundingClientRect();
  floatEl.style.left = (canvasRect.left - area.left + refOffsetX) + 'px';
  floatEl.style.top  = (canvasRect.top  - area.top  + refOffsetY) + 'px';
}

function importRef(e) {
  const file = e.target.files[0]; if (!file) return;
  e.target.value = '';

  const reader = new FileReader();
  reader.onload = (ev) => {
    const dataURL = ev.target.result;
    // Use a temporary Image to measure natural dimensions before touching the DOM.
    const probe = new Image();
    probe.onload = () => {
      const floatEl = document.getElementById('ref-float');
      const imgEl   = document.getElementById('ref-img-float');
      const nameEl  = document.getElementById('ref-float-name');
      const wrap    = document.getElementById('ref-img-wrap');
      const area    = document.getElementById('canvas-area');

      const aspect = probe.naturalWidth / probe.naturalHeight;
      const dispH  = Math.min(H * ZOOM, area.clientHeight - 32);
      const dispW  = Math.round(dispH * aspect);

      // Set explicit pixel dimensions so no CSS percentage resolution is needed.
      wrap.style.width  = dispW + 'px';
      wrap.style.height = dispH + 'px';
      imgEl.style.width  = dispW + 'px';
      imgEl.style.height = dispH + 'px';
      imgEl.style.opacity = document.getElementById('ref-opacity').value / 100;
      imgEl.src = dataURL;

      nameEl.textContent = file.name;
      refOffsetX = 0;
      refOffsetY = 0;
      floatEl.style.display = 'block';
      repositionRef();
    };
    probe.src = dataURL;
  };
  reader.readAsDataURL(file);
}

function setRefOpacity(v) {
  document.getElementById('ref-opacity-val').textContent = Math.round(v * 100) + '%';
  const imgEl = document.getElementById('ref-img-float');
  if (imgEl) imgEl.style.opacity = v;
}

function clearRef() {
  const floatEl = document.getElementById('ref-float');
  floatEl.style.display = 'none';
  document.getElementById('ref-img-float').src = '';
}

// ═══════════════════════════════════════════════════
//  IMPORT
// ═══════════════════════════════════════════════════
function triggerImportPNG() { document.getElementById('import-png-input').click(); }
function triggerImportSVG() { document.getElementById('import-svg-input').click(); }

function importImage(e, mode) {
  const file = e.target.files[0]; if (!file) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    if (mode === 'pixel') {
      const nw = Math.min(img.naturalWidth, 512), nh = Math.min(img.naturalHeight, 512);
      createNewCanvasData(nw, nh, 'transparent');
      layers[0].ctx.drawImage(img, 0, 0, nw, nh);
    }
    renderAll(); updateLayerThumbs();
    ZOOM = Math.max(1, Math.floor(Math.min(400 / W, 400 / H)));
    updateZoom();
    e.target.value = '';
  };
  img.src = url;
}

function importSVG(e) {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    const blob = new Blob([ev.target.result], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const nw = Math.min(img.naturalWidth || W, 512);
      const nh = Math.min(img.naturalHeight || H, 512);
      createNewCanvasData(nw, nh, 'transparent');
      layers[0].ctx.drawImage(img, 0, 0, nw, nh);
      renderAll(); updateLayerThumbs();
      URL.revokeObjectURL(url);
    };
    img.src = url;
  };
  reader.readAsText(file);
  e.target.value = '';
}

// ═══════════════════════════════════════════════════
//  EXPORT
// ═══════════════════════════════════════════════════

// Returns a merged canvas with all visible layers composited bottom-to-top.
function getMergedCanvas(scale = 1) {
  const c = document.createElement('canvas');
  c.width = W * scale; c.height = H * scale;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.scale(scale, scale);
  // Draw bottom-to-top (same order as renderAll)
  for (let i = 0; i < layers.length; i++) {
    if (layers[i].visible) ctx.drawImage(layers[i].canvas, 0, 0);
  }
  return c;
}

function exportPNG() {
  const c = getMergedCanvas(1);
  const a = document.createElement('a');
  a.download = 'pixel-art.png';
  a.href = c.toDataURL('image/png');
  a.click();
}

function doExportPNGScaled() {
  const scale = parseInt(document.getElementById('export-scale').value) || 4;
  const c = getMergedCanvas(scale);
  const a = document.createElement('a');
  a.download = `pixel-art-${scale}x.png`;
  a.href = c.toDataURL('image/png');
  a.click();
  closeModal('modal-export-scale');
}

function exportSVG() {
  const w = mainCanvas.width;
  const h = mainCanvas.height;

  const flat = document.createElement('canvas');
  flat.width = w; flat.height = h;
  const flatCtx = flat.getContext('2d');
  layers.forEach(l => { if (l.visible) flatCtx.drawImage(l.canvas, 0, 0); });

  const imageData = flatCtx.getImageData(0, 0, w, h).data;

  function toHex(r, g, b) {
    return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
  }

  // Build rects using run-length encoding per row
  const rects = [];
  for (let y = 0; y < h; y++) {
    let x = 0;
    while (x < w) {
      const i = (y * w + x) * 4;
      if (imageData[i + 3] < 255) { x++; continue; } // skip transparent
      const colour = toHex(imageData[i], imageData[i + 1], imageData[i + 2]);
      let run = 1;
      while (x + run < w) {
        const j = (y * w + x + run) * 4;
        if (imageData[j + 3] < 255) break;
        if (toHex(imageData[j], imageData[j + 1], imageData[j + 2]) !== colour) break;
        run++;
      }
      rects.push(`<rect x="${x}" y="${y}" width="${run}" height="1" fill="${colour}"/>`);
      x += run;
    }
  }

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" shape-rendering="crispEdges">
${rects.join('\n')}
</svg>`;

  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'pixel-art.svg';
  a.click();
  URL.revokeObjectURL(url);
}

// ═══════════════════════════════════════════════════
//  SAVE / LOAD PROJECT
// ═══════════════════════════════════════════════════
function saveProject() {
  const data = {
    version: 1, W, H, palette, fgColor, bgColor,
    layers: layers.map(l => ({
      name: l.name, visible: l.visible,
      data: l.canvas.toDataURL('image/png')
    })),
    activeLayerIdx
  };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.download = 'project.pxforge';
  a.href = url;
  a.click();
  URL.revokeObjectURL(url);
}

function triggerLoadProject() { document.getElementById('load-project-input').click(); }

function loadProject(e) {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const data = JSON.parse(ev.target.result);
      W = data.W; H = data.H;
      palette = data.palette || [];
      fgColor = data.fgColor || '#000000';
      bgColor = data.bgColor || '#ffffff';
      mainCanvas.width = W; mainCanvas.height = H;
      overlayCanvas.width = W; overlayCanvas.height = H;
      document.getElementById('size-display').textContent = `${W} × ${H}`;
      layers = [];
      const loadLayer = (i) => {
        if (i >= data.layers.length) {
          activeLayerIdx = data.activeLayerIdx || 0;
          undoStack = []; redoStack = [];
          updateColorUI(); renderLayersList(); renderAll(); renderPalette();
          return;
        }
        const ld = data.layers[i];
        const img = new Image();
        img.onload = () => {
          const c = document.createElement('canvas');
          c.width = W; c.height = H;
          const ctx = c.getContext('2d');
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(img, 0, 0);
          layers.push({ name: ld.name, canvas: c, ctx, visible: ld.visible });
          loadLayer(i + 1);
        };
        img.src = ld.data;
      };
      loadLayer(0);
    } catch (err) { alert('Failed to load project: ' + err.message); }
  };
  reader.readAsText(file);
  e.target.value = '';
}

// ═══════════════════════════════════════════════════
//  MODALS
// ═══════════════════════════════════════════════════
function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
function openNewModal() { openModal('modal-new'); }

function createNewCanvas() {
  const w  = parseInt(document.getElementById('new-w').value)  || 32;
  const h  = parseInt(document.getElementById('new-h').value)  || 32;
  const bg = document.getElementById('new-bg').value;
  createNewCanvasData(w, h, bg);
  zoomFit();
  closeModal('modal-new');
}

// Close modal on backdrop click
document.querySelectorAll('.modal-backdrop').forEach(m => {
  m.addEventListener('click', e => { if (e.target === m) m.classList.remove('open'); });
});

// ═══════════════════════════════════════════════════
//  KEYBOARD SHORTCUTS
// ═══════════════════════════════════════════════════
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.ctrlKey || e.metaKey) {
    if (e.key === 'z') { e.preventDefault(); undo(); }
    if (e.key === 'y' || (e.shiftKey && e.key === 'z')) { e.preventDefault(); redo(); }
    if (e.key === 'a') { e.preventDefault(); selectAll(); }
    if (e.key === 'c') { e.preventDefault(); ctxCopy(); }
    if (e.key === 'x') { e.preventDefault(); ctxCut(); }
    if (e.key === 'v') { e.preventDefault(); ctxPaste(); }
    return;
  }
  switch (e.key.toLowerCase()) {
    case 'p': setTool('pencil');    break;
    case 'e': setTool('eraser');    break;
    case 'f': setTool('fill');      break;
    case 'i': setTool('eyedropper'); break;
    case 'l': setTool('line');      break;
    case 'r': setTool('rect');      break;
    case 'o': setTool('ellipse');   break;
    case 's': setTool('select');    break;
    case 'v': setTool('move');      break;
    case 'g': showGrid = !showGrid; drawOverlay(); break;
    case '+': case '=': zoomIn();  break;
    case '-':           zoomOut(); break;
    case 'escape': deselect(); break;
    case '[':
      brushSize = Math.max(1, brushSize - 1);
      document.getElementById('brush-size').value = brushSize;
      document.getElementById('brush-size-val').textContent = brushSize;
      break;
    case ']':
      brushSize = Math.min(16, brushSize + 1);
      document.getElementById('brush-size').value = brushSize;
      document.getElementById('brush-size-val').textContent = brushSize;
      break;
  }
});

// ═══════════════════════════════════════════════════
//  STARTUP
// ═══════════════════════════════════════════════════
init();
updateColorUI();
