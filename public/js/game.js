// ── Constants ──────────────────────────────────────────────────────────────────
const TILE = { EMPTY: 0, WALL: 1, BLOCK: 2, BOMB: 3, FIRE: 4 };
const CELL = 48; // px per cell
const COLS = 15;
const ROWS = 13;

const COLORS = {
  bg:    '#0a0a0f',
  wall:  '#1a1a2e',
  wallShine: '#22223a',
  block: '#3a2a1a',
  blockShine: '#5a3e28',
  empty: '#111122',
  bomb:  '#111122',
  fire:  '#ff6b00',
  fire2: '#ffcc00',
  p0:    '#ff3c3c',
  p0dark:'#aa1a1a',
  p1:    '#3c8bff',
  p1dark:'#1a55aa',
};

// ── State ──────────────────────────────────────────────────────────────────────
let socket, myIndex, myId;
let state = null;
let canvas, ctx;
let animFrame;
let bombFlash = 0; // for bomb animation

// Keyboard state
const keys = {};
let lastSentMove = 0;
const MOVE_INTERVAL = 110; // ms between auto-repeat sends

// ── DOM ────────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

function show(id) { $(id).classList.remove('hidden'); }
function hide(id) { $(id).classList.add('hidden'); }

// ── Lobby ──────────────────────────────────────────────────────────────────────
$('randomRoomBtn').addEventListener('click', () => {
  $('roomInput').value = 'room-' + Math.random().toString(36).slice(2, 7);
});

$('joinBtn').addEventListener('click', joinRoom);
$('nameInput').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });
$('roomInput').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });

function joinRoom() {
  const name = $('nameInput').value.trim();
  const roomId = $('roomInput').value.trim();
  if (!name) { $('lobbyError').textContent = '請輸入名字'; return; }
  if (!roomId) { $('lobbyError').textContent = '請輸入房間 ID'; return; }
  $('lobbyError').textContent = '';
  initSocket(name, roomId);
}

// ── Socket ─────────────────────────────────────────────────────────────────────
function initSocket(name, roomId) {
  socket = io();

  socket.on('connect', () => {
    socket.emit('join', { roomId, name });
    hide('lobby');
    show('waiting');
    $('waitingRoom').textContent = roomId;
  });

  socket.on('joined', ({ playerIndex, playerId }) => {
    myIndex = playerIndex;
    myId = playerId;
  });

  socket.on('start', () => {
    hide('waiting');
    show('game');
    hide('overlay');
    initCanvas();
    startInputLoop();
    $('myControls').textContent = myIndex === 0
      ? '🔴 你：WASD 移動 | Space 放炸彈'
      : '🔵 你：↑↓←→ 移動 | Enter 放炸彈';
  });

  socket.on('state', (s) => {
    state = s;
    if (s.over) showGameOver(s);
    updateHud(s);
  });

  socket.on('error', (msg) => {
    hide('waiting');
    show('lobby');
    $('lobbyError').textContent = msg;
    socket.disconnect();
  });

  socket.on('playerLeft', () => {
    show('disconnected');
  });

  socket.on('disconnect', () => {
    if (!$('disconnected').classList.contains('hidden')) return;
    show('disconnected');
  });
}

// ── Canvas ─────────────────────────────────────────────────────────────────────
function initCanvas() {
  canvas = $('gameCanvas');
  const size = Math.min(Math.floor((window.innerHeight - 140) / ROWS), Math.floor((window.innerWidth - 20) / COLS));
  const cellSize = Math.max(32, Math.min(48, size));
  canvas.width  = COLS * cellSize;
  canvas.height = ROWS * cellSize;
  canvas._cell = cellSize;
  ctx = canvas.getContext('2d');
  renderLoop();
}

function renderLoop() {
  animFrame = requestAnimationFrame(renderLoop);
  bombFlash = (bombFlash + 1) % 60;
  if (state) draw(state);
}

function draw(s) {
  const C = canvas._cell;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Map
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      drawCell(x, y, s.map[y][x], C, s.fires);
    }
  }

  // Bombs
  s.bombs.forEach(b => drawBomb(b.x, b.y, C));

  // Players
  Object.values(s.players).forEach(p => {
    if (p.alive) drawPlayer(p, C);
  });

  // Dead players (ghost)
  Object.values(s.players).forEach(p => {
    if (!p.alive) drawGhost(p, C);
  });
}

function drawCell(x, y, tile, C, fires) {
  const px = x * C, py = y * C;
  switch (tile) {
    case TILE.EMPTY:
    case TILE.BOMB:
      ctx.fillStyle = COLORS.empty;
      ctx.fillRect(px, py, C, C);
      // subtle grid
      ctx.strokeStyle = 'rgba(255,255,255,.03)';
      ctx.strokeRect(px + .5, py + .5, C - 1, C - 1);
      break;
    case TILE.WALL:
      ctx.fillStyle = COLORS.wall;
      ctx.fillRect(px, py, C, C);
      ctx.fillStyle = COLORS.wallShine;
      ctx.fillRect(px + 2, py + 2, C - 4, 3);
      ctx.fillRect(px + 2, py + 2, 3, C - 4);
      break;
    case TILE.BLOCK:
      ctx.fillStyle = COLORS.block;
      ctx.fillRect(px, py, C, C);
      ctx.fillStyle = COLORS.blockShine;
      ctx.fillRect(px + 3, py + 3, C - 6, 3);
      ctx.fillRect(px + 3, py + 3, 3, C - 6);
      // crate lines
      ctx.strokeStyle = 'rgba(255,200,100,.15)';
      ctx.lineWidth = 1;
      ctx.strokeRect(px + 4, py + 4, C - 8, C - 8);
      break;
    case TILE.FIRE:
      drawFire(px, py, C);
      break;
  }
}

function drawFire(px, py, C) {
  const t = bombFlash / 60;
  const inner = `rgba(255,255,${Math.floor(t*200)},0.95)`;
  const outer = `rgba(255,${Math.floor(80 + t*100)},0,.85)`;
  const g = ctx.createRadialGradient(px + C/2, py + C/2, 2, px + C/2, py + C/2, C/2);
  g.addColorStop(0, inner);
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(px, py, C, C);
}

function drawBomb(x, y, C) {
  const px = x * C, py = y * C;
  const pulse = .85 + .15 * Math.sin(bombFlash / 60 * Math.PI * 2);
  const r = (C / 2 - 4) * pulse;
  const cx = px + C / 2, cy = py + C / 2;
  ctx.save();
  ctx.shadowColor = '#ff3c3c';
  ctx.shadowBlur = 12 * pulse;
  ctx.fillStyle = '#222';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#ff3c3c';
  ctx.lineWidth = 2;
  ctx.stroke();
  // fuse
  ctx.strokeStyle = COLORS.fire2;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx + r * .5, cy - r * .7);
  ctx.quadraticCurveTo(cx + r * .9, cy - r * 1.2, cx + r * .6, cy - r * 1.5);
  ctx.stroke();
  // spark
  if (bombFlash % 10 < 5) {
    ctx.fillStyle = '#ffcc00';
    ctx.beginPath();
    ctx.arc(cx + r * .6, cy - r * 1.5, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawPlayer(p, C) {
  const px = p.x * C, py = p.y * C;
  const color = p.index === 0 ? COLORS.p0 : COLORS.p1;
  const dark  = p.index === 0 ? COLORS.p0dark : COLORS.p1dark;
  const isMe  = p.id === myId;
  const cx = px + C/2, cy = py + C/2;

  ctx.save();
  if (isMe) {
    ctx.shadowColor = color;
    ctx.shadowBlur = 14;
  }

  // body
  ctx.fillStyle = dark;
  ctx.beginPath();
  ctx.roundRect(px + 6, py + C/2 - 2, C - 12, C/2 - 4, 4);
  ctx.fill();

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(px + 7, py + C/2 - 1, C - 14, C/2 - 6, 3);
  ctx.fill();

  // head
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx, py + C/2 - 4, C/2 - 8, 0, Math.PI * 2);
  ctx.fill();

  // eyes
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(cx - 4, py + C/2 - 6, 3, 0, Math.PI * 2);
  ctx.arc(cx + 4, py + C/2 - 6, 3, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#222';
  ctx.beginPath();
  ctx.arc(cx - 3.5, py + C/2 - 6, 1.5, 0, Math.PI * 2);
  ctx.arc(cx + 4.5, py + C/2 - 6, 1.5, 0, Math.PI * 2);
  ctx.fill();

  // name tag
  if (isMe) {
    ctx.fillStyle = color;
    ctx.font = `bold ${Math.max(9, C * .18)}px Nunito, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('YOU', cx, py + C - 2);
  }

  ctx.restore();
}

function drawGhost(p, C) {
  const px = p.x * C, py = p.y * C;
  ctx.save();
  ctx.globalAlpha = .3;
  drawPlayer(p, C);
  ctx.restore();
  // X mark
  const cx = px + C/2, cy = py + C/2;
  ctx.save();
  ctx.strokeStyle = '#ff3c3c';
  ctx.lineWidth = 3;
  ctx.globalAlpha = .7;
  ctx.beginPath();
  ctx.moveTo(cx - 10, cy - 10); ctx.lineTo(cx + 10, cy + 10);
  ctx.moveTo(cx + 10, cy - 10); ctx.lineTo(cx - 10, cy + 10);
  ctx.stroke();
  ctx.restore();
}

// ── HUD ────────────────────────────────────────────────────────────────────────
function updateHud(s) {
  const players = Object.values(s.players);
  players.forEach(p => {
    $(`hud${p.index}name`).textContent = p.name;
    $(`hud${p.index}status`).textContent = p.alive ? '❤️' : '💀';
  });
}

// ── Game Over ──────────────────────────────────────────────────────────────────
function showGameOver(s) {
  const isMe = s.winner && Object.values(s.players).find(p => p.name === s.winner && p.id === myId);
  const isDraw = s.winner === 'Draw';
  $('overlayIcon').textContent = isDraw ? '🤝' : isMe ? '🏆' : '💀';
  $('overlayTitle').textContent = isDraw ? 'DRAW!' : isMe ? 'YOU WIN!' : 'YOU LOSE!';
  $('overlayMsg').textContent = isDraw ? '勢均力敵！' : `${s.winner} 獲勝！`;
  $('gameStatus').textContent = '結束';
  show('overlay');
}

$('restartBtn').addEventListener('click', () => {
  socket.emit('restart');
  hide('overlay');
  $('gameStatus').textContent = '進行中';
});

// ── Input ──────────────────────────────────────────────────────────────────────
function startInputLoop() {
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', e => { keys[e.code] = false; });
  setInterval(sendMovement, MOVE_INTERVAL);
}

function onKeyDown(e) {
  keys[e.code] = true;

  // Bomb on keydown only
  if (myIndex === 0 && e.code === 'Space') {
    e.preventDefault();
    socket.emit('bomb');
  }
  if (myIndex === 1 && e.code === 'Enter') {
    e.preventDefault();
    socket.emit('bomb');
  }

  // Prevent page scroll
  if (['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code)) {
    e.preventDefault();
  }
}

function sendMovement() {
  if (!socket || !state || state.over) return;
  let dir = null;
  if (myIndex === 0) {
    if (keys['KeyW']) dir = 'up';
    else if (keys['KeyS']) dir = 'down';
    else if (keys['KeyA']) dir = 'left';
    else if (keys['KeyD']) dir = 'right';
  } else {
    if (keys['ArrowUp']) dir = 'up';
    else if (keys['ArrowDown']) dir = 'down';
    else if (keys['ArrowLeft']) dir = 'left';
    else if (keys['ArrowRight']) dir = 'right';
  }
  if (dir) socket.emit('move', dir);
}
