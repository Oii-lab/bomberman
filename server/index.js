const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static(path.join(__dirname, '../public')));

// ─── 常數 ──────────────────────────────────────────────────────────────────────
const COLS = 15;
const ROWS = 13;
const TILE  = { EMPTY:0, WALL:1, BLOCK:2, FIRE:3 };
const ITEM  = { BOMB_UP:1, RANGE_UP:2, SPEED_UP:3, PIERCE:4, REMOTE:5 };
const THEMES = ['dungeon','forest','space','lava'];

const BOMB_FUSE     = 3000;  // 炸彈引爆時間 ms
const FIRE_DURATION = 700;   // 火焰持續 ms
const BASE_SPEED    = 120;   // 移動 cooldown ms（越小越快）
const MIN_SPEED     = 65;
const SPEED_STEP    = 18;
const ITEM_DROP     = 0.38;  // 磚塊掉道具機率

const SPAWNS = [
  { x:1,       y:1       },
  { x:COLS-2,  y:ROWS-2  },
];

// ─── 地圖生成 ──────────────────────────────────────────────────────────────────
function generateMap(theme) {
  const map = Array.from({ length: ROWS }, (_, y) =>
    Array.from({ length: COLS }, (_, x) => {
      if (y===0 || y===ROWS-1 || x===0 || x===COLS-1) return TILE.WALL;
      if (y%2===0 && x%2===0) return TILE.WALL;
      return TILE.EMPTY;
    })
  );

  // lava 主題：多一些隨機牆壁
  if (theme === 'lava') {
    for (let y=1; y<ROWS-1; y++)
      for (let x=1; x<COLS-1; x++)
        if (map[y][x]===TILE.EMPTY && Math.random()<0.04) map[y][x]=TILE.WALL;
  }

  // 出生點保護範圍
  const safe = new Set();
  SPAWNS.forEach(s => {
    for (let dy=-1; dy<=1; dy++)
      for (let dx=-1; dx<=1; dx++)
        safe.add(`${s.x+dx},${s.y+dy}`);
  });

  // 填入可破壞磚塊
  for (let y=1; y<ROWS-1; y++)
    for (let x=1; x<COLS-1; x++)
      if (map[y][x]===TILE.EMPTY && !safe.has(`${x},${y}`) && Math.random()<0.42)
        map[y][x] = TILE.BLOCK;

  return map;
}

// ─── 房間管理 ──────────────────────────────────────────────────────────────────
const rooms = {};

function createRoom(roomId) {
  const theme = THEMES[Math.floor(Math.random() * THEMES.length)];
  return {
    id: roomId,
    theme,
    map: generateMap(theme),
    players: {},   // socketId -> player
    bombs: [],     // { id, x, y, ownerId, range, pierce, remote, timerId }
    fires: [],     // { x, y }
    items: [],     // { x, y, type }
    started: false,
    over: false,
    winner: null,
    timers: [],
  };
}

function broadcast(room) {
  io.to(room.id).emit('state', {
    map:     room.map,
    players: room.players,
    bombs:   room.bombs.map(b => ({ id:b.id, x:b.x, y:b.y, pierce:b.pierce, remote:b.remote, ownerId:b.ownerId })),
    fires:   room.fires,
    items:   room.items,
    started: room.started,
    over:    room.over,
    winner:  room.winner,
    theme:   room.theme,
  });
}

// ─── 道具 ──────────────────────────────────────────────────────────────────────
function tryDropItem(room, x, y) {
  if (Math.random() > ITEM_DROP) return;
  // 加權隨機
  const pool = [
    { type:ITEM.BOMB_UP,  w:28 },
    { type:ITEM.RANGE_UP, w:28 },
    { type:ITEM.SPEED_UP, w:24 },
    { type:ITEM.PIERCE,   w:10 },
    { type:ITEM.REMOTE,   w:10 },
  ];
  const total = pool.reduce((s,i) => s+i.w, 0);
  let r = Math.random() * total;
  const chosen = pool.find(i => { r -= i.w; return r <= 0; }) || pool[0];
  room.items.push({ x, y, type: chosen.type });
}

function collectItems(room, player) {
  for (let i = room.items.length - 1; i >= 0; i--) {
    const item = room.items[i];
    if (item.x !== player.x || item.y !== player.y) continue;
    room.items.splice(i, 1);
    switch (item.type) {
      case ITEM.BOMB_UP:  player.maxBombs  = Math.min(player.maxBombs + 1, 5); break;
      case ITEM.RANGE_UP: player.bombRange = Math.min(player.bombRange + 1, 7); break;
      case ITEM.SPEED_UP: player.speed     = Math.max(player.speed - SPEED_STEP, MIN_SPEED); break;
      case ITEM.PIERCE:   player.pierce    = true; break;
      case ITEM.REMOTE:   player.remote    = true; break;
    }
  }
}

// ─── 炸彈 ──────────────────────────────────────────────────────────────────────
let _bombId = 0;

function placeBomb(room, player) {
  if (!player.alive || room.over) return;

  const activeBombs = room.bombs.filter(b => b.ownerId === player.id);
  if (activeBombs.length >= player.maxBombs) return;

  // 同格已有炸彈
  if (room.bombs.some(b => b.x === player.x && b.y === player.y)) return;

  const bomb = {
    id:      ++_bombId,
    x:       player.x,
    y:       player.y,
    ownerId: player.id,
    range:   player.bombRange,
    pierce:  player.pierce,
    remote:  player.remote,
    timerId: null,
  };
  room.bombs.push(bomb);

  // 遙控炸彈不自動爆炸
  if (!bomb.remote) {
    bomb.timerId = setTimeout(() => triggerBomb(room, bomb.id), BOMB_FUSE);
    room.timers.push(bomb.timerId);
  }

  broadcast(room);
}

function detonateRemoteBombs(room, player) {
  // 引爆該玩家最舊的遙控炸彈
  const remoteBombs = room.bombs.filter(b => b.ownerId === player.id && b.remote);
  if (remoteBombs.length === 0) return false;
  triggerBomb(room, remoteBombs[0].id);
  return true;
}

function triggerBomb(room, bombId) {
  const bomb = room.bombs.find(b => b.id === bombId);
  if (!bomb) return; // 已被連鎖引爆

  // 清除計時器
  if (bomb.timerId) {
    clearTimeout(bomb.timerId);
    const ti = room.timers.indexOf(bomb.timerId);
    if (ti !== -1) room.timers.splice(ti, 1);
  }

  // 從炸彈列表移除
  const bi = room.bombs.indexOf(bomb);
  if (bi !== -1) room.bombs.splice(bi, 1);

  // 計算爆炸格
  const cells = calcExplosion(room, bomb);

  // 處理每格
  cells.forEach(({ x, y }) => {
    // 移除該格道具
    const ii = room.items.findIndex(it => it.x===x && it.y===y);
    if (ii !== -1) room.items.splice(ii, 1);

    // 標記火焰
    room.fires.push({ x, y });

    // 連鎖引爆
    const chainBomb = room.bombs.find(b => b.x===x && b.y===y);
    if (chainBomb) triggerBomb(room, chainBomb.id);
  });

  // 判定玩家死亡（在火焰格）
  Object.values(room.players).forEach(p => {
    if (!p.alive) return;
    if (cells.some(c => c.x===p.x && c.y===p.y)) {
      p.alive = false;
    }
  });

  checkWin(room);
  broadcast(room);

  // 火焰消退
  const ft = setTimeout(() => {
    cells.forEach(({ x, y }) => {
      const fi = room.fires.findIndex(f => f.x===x && f.y===y);
      if (fi !== -1) room.fires.splice(fi, 1);
    });
    broadcast(room);
  }, FIRE_DURATION);
  room.timers.push(ft);
}

function calcExplosion(room, bomb) {
  const cells = [{ x: bomb.x, y: bomb.y }];
  const dirs  = [[1,0],[-1,0],[0,1],[0,-1]];

  dirs.forEach(([dx, dy]) => {
    for (let i = 1; i <= bomb.range; i++) {
      const nx = bomb.x + dx*i;
      const ny = bomb.y + dy*i;
      if (nx<0 || ny<0 || nx>=COLS || ny>=ROWS) break;

      const tile = room.map[ny][nx];

      if (tile === TILE.WALL) break; // 永久牆壁：停止

      if (tile === TILE.BLOCK) {
        cells.push({ x:nx, y:ny });
        room.map[ny][nx] = TILE.EMPTY;
        tryDropItem(room, nx, ny);
        if (!bomb.pierce) break; // 非穿牆：停止；穿牆：繼續
        continue;
      }

      // EMPTY or FIRE
      cells.push({ x:nx, y:ny });
    }
  });

  return cells;
}

// ─── 勝負判定 ──────────────────────────────────────────────────────────────────
function checkWin(room) {
  if (room.over) return;
  const alive = Object.values(room.players).filter(p => p.alive);
  if (alive.length > 1) return;
  room.over   = true;
  room.winner = alive.length === 1 ? alive[0].name : 'Draw';
  room.timers.forEach(t => clearTimeout(t));
  room.timers = [];
}

// ─── 移動 ──────────────────────────────────────────────────────────────────────
const DIR_DELTA = { up:[0,-1], down:[0,1], left:[-1,0], right:[1,0] };

function movePlayer(room, player, dir) {
  if (!player.alive || room.over) return;

  const now = Date.now();
  if (now - player.lastMove < player.speed) return;

  const delta = DIR_DELTA[dir];
  if (!delta) return;

  const nx = player.x + delta[0];
  const ny = player.y + delta[1];

  // 邊界檢查
  if (nx<0 || ny<0 || nx>=COLS || ny>=ROWS) return;

  const tile = room.map[ny][nx];

  // 不可通行：永久牆、可破壞磚塊
  if (tile === TILE.WALL || tile === TILE.BLOCK) return;

  // 炸彈格：不可通行（玩家不能踩炸彈，但放完炸彈後可以離開）
  if (room.bombs.some(b => b.x===nx && b.y===ny)) return;

  player.lastMove = now;
  player.x = nx;
  player.y = ny;

  // 踩到火焰：死亡
  if (room.fires.some(f => f.x===nx && f.y===ny)) {
    player.alive = false;
    checkWin(room);
  } else {
    // 撿道具
    collectItems(room, player);
  }

  broadcast(room);
}

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', socket => {

  socket.on('join', ({ roomId, name }) => {
    if (!roomId || !name) return;
    roomId = String(roomId).trim().slice(0, 30);
    name   = String(name).trim().slice(0, 12);
    if (!roomId || !name) return;

    if (!rooms[roomId]) rooms[roomId] = createRoom(roomId);
    const room = rooms[roomId];

    if (room.over) {
      socket.emit('joinError', '遊戲已結束，請換個房間 ID'); return;
    }
    if (Object.keys(room.players).length >= 2) {
      socket.emit('joinError', '房間已滿'); return;
    }

    const idx   = Object.keys(room.players).length; // 0 or 1
    const spawn = SPAWNS[idx];

    room.players[socket.id] = {
      id:       socket.id,
      name,
      index:    idx,
      x:        spawn.x,
      y:        spawn.y,
      alive:    true,
      maxBombs: 1,
      bombRange:2,
      speed:    BASE_SPEED,
      pierce:   false,
      remote:   false,
      lastMove: 0,
    };

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.emit('joined', { playerIndex: idx, playerId: socket.id });

    if (Object.keys(room.players).length === 2) {
      room.started = true;
      io.to(roomId).emit('gameStart');
    }

    broadcast(room);
  });

  socket.on('move', dir => {
    const room   = rooms[socket.data.roomId]; if (!room) return;
    const player = room.players[socket.id];   if (!player) return;
    movePlayer(room, player, dir);
  });

  socket.on('bomb', () => {
    const room   = rooms[socket.data.roomId];
    if (!room || !room.started || room.over) return;
    const player = room.players[socket.id];
    if (!player || !player.alive) return;

    // 遙控模式：若已有遙控炸彈則引爆，否則放新的
    if (player.remote) {
      const placed = room.bombs.filter(b => b.ownerId === socket.id && b.remote);
      if (placed.length > 0) {
        detonateRemoteBombs(room, player);
        return;
      }
    }
    placeBomb(room, player);
  });

  socket.on('restart', () => {
    const roomId = socket.data.roomId;
    const room   = rooms[roomId];
    if (!room || !room.over) return;

    const prevPlayers = Object.values(room.players);
    room.timers.forEach(t => clearTimeout(t));

    const newRoom = createRoom(roomId);
    prevPlayers.forEach((p, i) => {
      const spawn = SPAWNS[i];
      newRoom.players[p.id] = {
        id: p.id, name: p.name, index: i,
        x: spawn.x, y: spawn.y,
        alive: true, maxBombs: 1, bombRange: 2,
        speed: BASE_SPEED, pierce: false, remote: false,
        lastMove: 0,
      };
    });
    newRoom.started = true;
    rooms[roomId] = newRoom;

    io.to(roomId).emit('gameStart');
    broadcast(newRoom);
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    if (room.players[socket.id]) {
      const name = room.players[socket.id].name;
      delete room.players[socket.id];
      io.to(roomId).emit('playerLeft', { name });
    }
    if (Object.keys(room.players).length === 0) {
      room.timers.forEach(t => clearTimeout(t));
      delete rooms[roomId];
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`💣 Bomberman running on http://localhost:${PORT}`));
