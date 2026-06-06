// ── 常數 ───────────────────────────────────────────────────────────────────────
const TILE = { EMPTY:0, WALL:1, BLOCK:2, FIRE:3 };
const ITEM_INFO = {
  1: { emoji:'💣', label:'炸彈+1', color:'#ffcc00' },
  2: { emoji:'🔥', label:'射程+1', color:'#ff6b00' },
  3: { emoji:'⚡', label:'加速',   color:'#39ff7e' },
  4: { emoji:'👻', label:'穿牆彈', color:'#cc88ff' },
  5: { emoji:'📡', label:'遙控彈', color:'#3cf'    },
};
const COLS = 15, ROWS = 13;

const THEME_STYLE = {
  dungeon: { bg:'#0d0d1a', wall:'#1a1a2e', wallHL:'#25254a', block:'#3a2a1a', blockHL:'#5a3e28', empty:'#111128', name:'地牢' },
  forest:  { bg:'#0a1508', wall:'#162510', wallHL:'#1e3316', block:'#263a10', blockHL:'#3a5a18', empty:'#0d1a0a', name:'森林' },
  space:   { bg:'#04040f', wall:'#0a0a22', wallHL:'#14143a', block:'#14143a', blockHL:'#22225a', empty:'#080818', name:'宇宙' },
  lava:    { bg:'#180600', wall:'#2e0e00', wallHL:'#3e1600', block:'#3a1a08', blockHL:'#5a2a10', empty:'#130400', name:'熔岩' },
};

// ── 狀態 ───────────────────────────────────────────────────────────────────────
let socket, myIndex, myId;
let gameState = null;
let canvas, ctx, cellSize;
let tick = 0;
const keys = {};

const $ = id => document.getElementById(id);
const show = id => $(id).classList.remove('hidden');
const hide = id => $(id).classList.add('hidden');

// ── 大廳 ───────────────────────────────────────────────────────────────────────
$('randomRoomBtn').addEventListener('click', () => {
  $('roomInput').value = 'room-' + Math.random().toString(36).slice(2, 7);
});
$('joinBtn').addEventListener('click', joinRoom);
['nameInput','roomInput'].forEach(id =>
  $(id).addEventListener('keydown', e => { if (e.key==='Enter') joinRoom(); })
);

function joinRoom() {
  const name   = $('nameInput').value.trim();
  const roomId = $('roomInput').value.trim();
  if (!name)   { showLobbyError('請輸入名字'); return; }
  if (!roomId) { showLobbyError('請輸入房間 ID'); return; }
  showLobbyError('');
  initSocket(name, roomId);
}
function showLobbyError(msg) { $('lobbyError').textContent = msg; }

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
    myId    = playerId;
  });

  socket.on('gameStart', () => {
    hide('waiting');
    show('game');
    hide('overlay');
    hide('disconnected');
    initCanvas();
    startInput();
    $('myControls').textContent = myIndex === 0
      ? '🔴 WASD 移動  |  Space 炸彈'
      : '🔵 ↑↓←→ 移動  |  Enter 炸彈';
  });

  socket.on('state', s => {
    gameState = s;
    updateHud(s);
    if (s.over) showOverlay(s);
  });

  socket.on('joinError', msg => {
    hide('waiting');
    show('lobby');
    showLobbyError(msg);
    socket.disconnect();
  });

  socket.on('playerLeft', () => show('disconnected'));

  socket.on('disconnect', () => {
    if (!$('disconnected').classList.contains('hidden')) return;
    show('disconnected');
  });
}

// ── Canvas ─────────────────────────────────────────────────────────────────────
function initCanvas() {
  canvas = $('gameCanvas');
  ctx    = canvas.getContext('2d');

  const maxW = window.innerWidth  - 20;
  const maxH = window.innerHeight - 160;
  cellSize   = Math.max(28, Math.min(48, Math.floor(Math.min(maxW/COLS, maxH/ROWS))));

  canvas.width  = COLS * cellSize;
  canvas.height = ROWS * cellSize;

  requestAnimationFrame(loop);
}

function loop() {
  requestAnimationFrame(loop);
  tick = (tick + 1) % 120;
  if (gameState) render(gameState);
}

// ── 渲染 ───────────────────────────────────────────────────────────────────────
function render(s) {
  const C = cellSize;
  const T = THEME_STYLE[s.theme] || THEME_STYLE.dungeon;

  // 背景
  ctx.fillStyle = T.bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // 宇宙主題星星
  if (s.theme === 'space') {
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    for (let i = 0; i < 50; i++) {
      ctx.fillRect((i*137+11) % canvas.width, (i*79+23) % canvas.height, 1, 1);
    }
  }
  // 熔岩主題閃爍光
  if (s.theme === 'lava') {
    const a = 0.03 + 0.02 * Math.sin(tick / 120 * Math.PI * 2);
    ctx.fillStyle = `rgba(255,60,0,${a})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  // 地圖格
  for (let y = 0; y < ROWS; y++)
    for (let x = 0; x < COLS; x++)
      drawTile(x, y, s.map[y][x], C, T);

  // 火焰
  s.fires.forEach(f => drawFire(f.x, f.y, C));

  // 道具
  s.items.forEach(item => drawItem(item.x, item.y, item.type, C));

  // 炸彈
  s.bombs.forEach(b => drawBomb(b, C));

  // 玩家（先畫死的，活的畫在上層）
  const players = Object.values(s.players);
  players.filter(p => !p.alive).forEach(p => drawPlayer(p, C, true));
  players.filter(p =>  p.alive).forEach(p => drawPlayer(p, C, false));
}

function drawTile(x, y, tile, C, T) {
  const px = x*C, py = y*C;
  switch (tile) {
    case TILE.EMPTY:
      ctx.fillStyle = T.empty;
      ctx.fillRect(px, py, C, C);
      ctx.strokeStyle = 'rgba(255,255,255,0.03)';
      ctx.lineWidth = 1;
      ctx.strokeRect(px+.5, py+.5, C-1, C-1);
      break;
    case TILE.WALL:
      ctx.fillStyle = T.wall;
      ctx.fillRect(px, py, C, C);
      ctx.fillStyle = T.wallHL;
      ctx.fillRect(px+2, py+2, C-4, 3);
      ctx.fillRect(px+2, py+2, 3, C-4);
      break;
    case TILE.BLOCK:
      ctx.fillStyle = T.block;
      ctx.fillRect(px, py, C, C);
      ctx.fillStyle = T.blockHL;
      ctx.fillRect(px+3, py+3, C-6, 3);
      ctx.fillRect(px+3, py+3, 3, C-6);
      ctx.strokeStyle = 'rgba(255,200,100,0.1)';
      ctx.lineWidth = 1;
      ctx.strokeRect(px+5, py+5, C-10, C-10);
      break;
    case TILE.FIRE:
      drawFire(x, y, C);
      break;
  }
}

function drawFire(x, y, C) {
  const px = x*C, py = y*C;
  const t  = tick / 120;
  const g  = ctx.createRadialGradient(px+C/2, py+C/2, 1, px+C/2, py+C/2, C/2);
  g.addColorStop(0, `rgba(255,255,${Math.floor(t*255)},0.95)`);
  g.addColorStop(1, `rgba(255,${Math.floor(60+t*120)},0,0.8)`);
  ctx.fillStyle = g;
  ctx.fillRect(px, py, C, C);
}

function drawItem(x, y, type, C) {
  const info = ITEM_INFO[type];
  if (!info) return;
  const px  = x*C, py = y*C;
  const bob = Math.sin(tick / 60 * Math.PI) * 2;
  const cx  = px + C/2, cy = py + C/2 + bob;

  ctx.save();
  ctx.shadowColor = info.color;
  ctx.shadowBlur  = 10;

  // 背景圓
  ctx.fillStyle = info.color + '30';
  ctx.beginPath();
  ctx.arc(cx, cy, C/2 - 5, 0, Math.PI*2);
  ctx.fill();

  ctx.strokeStyle = info.color;
  ctx.lineWidth   = 1.5;
  ctx.stroke();

  // emoji
  ctx.shadowBlur      = 0;
  ctx.font            = `${Math.floor(C * 0.44)}px serif`;
  ctx.textAlign       = 'center';
  ctx.textBaseline    = 'middle';
  ctx.fillStyle       = '#fff';
  ctx.fillText(info.emoji, cx, cy);
  ctx.restore();
}

function drawBomb(bomb, C) {
  const px = bomb.x * C, py = bomb.y * C;
  const cx = px + C/2, cy = py + C/2;
  const pulse = 0.85 + 0.15 * Math.sin(tick / 30 * Math.PI);
  const r = (C/2 - 5) * pulse;

  const glowColor = bomb.remote ? '#33ccff' : '#ff3c3c';

  ctx.save();
  ctx.shadowColor = glowColor;
  ctx.shadowBlur  = 10 * pulse;

  // 彈身
  ctx.fillStyle   = bomb.remote ? '#00111e' : '#1a1a1a';
  ctx.strokeStyle = glowColor;
  ctx.lineWidth   = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI*2);
  ctx.fill();
  ctx.stroke();

  // 穿牆彈：X 記號
  if (bomb.pierce) {
    ctx.strokeStyle = '#cc88ff';
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx - r*.5, cy - r*.5); ctx.lineTo(cx + r*.5, cy + r*.5);
    ctx.moveTo(cx + r*.5, cy - r*.5); ctx.lineTo(cx - r*.5, cy + r*.5);
    ctx.stroke();
  }

  // 導火線
  ctx.strokeStyle = '#ffcc00';
  ctx.lineWidth   = 2;
  ctx.beginPath();
  ctx.moveTo(cx + r*.4, cy - r*.6);
  ctx.quadraticCurveTo(cx + r*.9, cy - r*1.1, cx + r*.6, cy - r*1.5);
  ctx.stroke();

  // 火花
  if (tick % 12 < 6) {
    ctx.fillStyle = '#ffcc00';
    ctx.shadowColor = '#ffcc00';
    ctx.shadowBlur  = 6;
    ctx.beginPath();
    ctx.arc(cx + r*.6, cy - r*1.5, 2.5, 0, Math.PI*2);
    ctx.fill();
  }
  ctx.restore();
}

// 相容所有瀏覽器的圓角矩形
function fillRoundRect(x, y, w, h, r) {
  r = Math.min(r, w/2, h/2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);      ctx.arcTo(x+w, y,   x+w, y+r,   r);
  ctx.lineTo(x + w, y + h - r);  ctx.arcTo(x+w, y+h, x+w-r, y+h, r);
  ctx.lineTo(x + r, y + h);      ctx.arcTo(x, y+h,   x, y+h-r,   r);
  ctx.lineTo(x, y + r);          ctx.arcTo(x, y,     x+r, y,      r);
  ctx.closePath();
  ctx.fill();
}

function drawPlayer(p, C, isDead) {
  const px    = p.x * C, py = p.y * C;
  const color = p.index === 0 ? '#ff3c3c' : '#3c8bff';
  const dark  = p.index === 0 ? '#991a1a' : '#1a4eaa';
  const isMe  = p.id === myId;
  const cx    = px + C/2, cy = py + C/2;

  ctx.save();
  if (isDead) ctx.globalAlpha = 0.35;
  if (isMe && !isDead) { ctx.shadowColor = color; ctx.shadowBlur = 12; }

  // 身體
  ctx.fillStyle = dark;
  fillRoundRect(px + 6, py + Math.floor(C*0.52), C - 12, Math.floor(C*0.38), 4);
  ctx.fillStyle = color;
  fillRoundRect(px + 8, py + Math.floor(C*0.54), C - 16, Math.floor(C*0.32), 3);

  // 頭
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx, py + Math.floor(C*0.38), C/2 - 7, 0, Math.PI*2);
  ctx.fill();

  // 眼白
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(cx - 4, py + Math.floor(C*0.34), 3, 0, Math.PI*2);
  ctx.arc(cx + 4, py + Math.floor(C*0.34), 3, 0, Math.PI*2);
  ctx.fill();

  // 瞳孔
  ctx.fillStyle = isDead ? '#888' : '#111';
  ctx.beginPath();
  ctx.arc(cx - 3.5, py + Math.floor(C*0.34), 1.5, 0, Math.PI*2);
  ctx.arc(cx + 4.5, py + Math.floor(C*0.34), 1.5, 0, Math.PI*2);
  ctx.fill();

  // 死亡 X
  if (isDead) {
    ctx.globalAlpha = 0.8;
    ctx.strokeStyle = '#ff3c3c';
    ctx.lineWidth   = 2.5;
    ctx.beginPath();
    ctx.moveTo(cx-9, cy-9); ctx.lineTo(cx+9, cy+9);
    ctx.moveTo(cx+9, cy-9); ctx.lineTo(cx-9, cy+9);
    ctx.stroke();
  }

  // YOU 標籤
  if (isMe && !isDead) {
    ctx.shadowBlur      = 0;
    ctx.globalAlpha     = 1;
    ctx.fillStyle       = color;
    ctx.font            = `bold ${Math.max(8, Math.floor(C*0.17))}px sans-serif`;
    ctx.textAlign       = 'center';
    ctx.textBaseline    = 'bottom';
    ctx.fillText('YOU', cx, py + C - 1);
  }

  ctx.restore();
}

// ── HUD ────────────────────────────────────────────────────────────────────────
function updateHud(s) {
  const T = THEME_STYLE[s.theme] || THEME_STYLE.dungeon;
  $('themeLabel').textContent = '🗺️ ' + T.name;

  Object.values(s.players).forEach(p => {
    const nameEl  = $(`hud${p.index}name`);
    const statEl  = $(`hud${p.index}stats`);
    const hpEl    = $(`hud${p.index}status`);
    if (!nameEl) return;

    nameEl.textContent = p.name;
    hpEl.textContent   = p.alive ? '❤️' : '💀';

    if (statEl) {
      const parts = [
        `💣×${p.maxBombs  ?? 1}`,
        `🔥×${p.bombRange ?? 2}`,
      ];
      if ((p.speed ?? 120) < 110) parts.push('⚡');
      if (p.pierce) parts.push('👻');
      if (p.remote) parts.push('📡');
      statEl.textContent = parts.join(' ');
    }
  });
}

// ── 結算 ───────────────────────────────────────────────────────────────────────
function showOverlay(s) {
  const me     = Object.values(s.players).find(p => p.id === myId);
  const isDraw = s.winner === 'Draw';
  const iWin   = !isDraw && me && me.name === s.winner;

  $('overlayIcon').textContent  = isDraw ? '🤝' : iWin ? '🏆' : '💀';
  $('overlayTitle').textContent = isDraw ? 'DRAW!' : iWin ? 'YOU WIN!' : 'YOU LOSE!';
  $('overlayMsg').textContent   = isDraw ? '勢均力敵！' : `${s.winner} 獲勝！`;
  $('gameStatus').textContent   = '結束';
  show('overlay');
}

$('restartBtn').addEventListener('click', () => {
  socket.emit('restart');
  hide('overlay');
  $('gameStatus').textContent = '進行中';
});

// ── 鍵盤輸入 ───────────────────────────────────────────────────────────────────
function startInput() {
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup',   e => { keys[e.code] = false; });
  setInterval(sendMove, 90);
}

function onKeyDown(e) {
  keys[e.code] = true;

  // 炸彈（keydown 觸發，不重複）
  if (!e.repeat) {
    if (myIndex === 0 && e.code === 'Space') { e.preventDefault(); socket.emit('bomb'); }
    if (myIndex === 1 && e.code === 'Enter') { e.preventDefault(); socket.emit('bomb'); }
  }

  // 防止頁面捲動
  if (['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code))
    e.preventDefault();
}

function sendMove() {
  if (!socket || !gameState || gameState.over) return;
  let dir = null;
  if (myIndex === 0) {
    if      (keys['KeyW']) dir = 'up';
    else if (keys['KeyS']) dir = 'down';
    else if (keys['KeyA']) dir = 'left';
    else if (keys['KeyD']) dir = 'right';
  } else {
    if      (keys['ArrowUp'])    dir = 'up';
    else if (keys['ArrowDown'])  dir = 'down';
    else if (keys['ArrowLeft'])  dir = 'left';
    else if (keys['ArrowRight']) dir = 'right';
  }
  if (dir) socket.emit('move', dir);
}
