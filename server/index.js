const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, '../public')));

// ─── Game Constants ───────────────────────────────────────────────────────────
const COLS = 15;
const ROWS = 13;
const TILE = {
  EMPTY: 0,
  WALL: 1,      // indestructible
  BLOCK: 2,     // destructible
  BOMB: 3,
  FIRE: 4,
};
const BOMB_TIMER = 3000;  // ms
const FIRE_DURATION = 800; // ms
const BOMB_RANGE = 2;
const MOVE_COOLDOWN = 120; // ms

// ─── Spawn positions ──────────────────────────────────────────────────────────
const SPAWNS = [
  { x: 1, y: 1 },
  { x: COLS - 2, y: ROWS - 2 },
];

// ─── Map generation ───────────────────────────────────────────────────────────
function generateMap() {
  const map = [];
  for (let y = 0; y < ROWS; y++) {
    map[y] = [];
    for (let x = 0; x < COLS; x++) {
      if (y === 0 || y === ROWS - 1 || x === 0 || x === COLS - 1) {
        map[y][x] = TILE.WALL;
      } else if (y % 2 === 0 && x % 2 === 0) {
        map[y][x] = TILE.WALL;
      } else {
        map[y][x] = TILE.EMPTY;
      }
    }
  }
  // Random destructible blocks (avoid spawn zones)
  const spawnSafe = new Set();
  SPAWNS.forEach(s => {
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        spawnSafe.add(`${s.x + dx},${s.y + dy}`);
  });
  for (let y = 1; y < ROWS - 1; y++) {
    for (let x = 1; x < COLS - 1; x++) {
      if (map[y][x] === TILE.EMPTY && !spawnSafe.has(`${x},${y}`) && Math.random() < 0.45) {
        map[y][x] = TILE.BLOCK;
      }
    }
  }
  return map;
}

// ─── Rooms ────────────────────────────────────────────────────────────────────
const rooms = {}; // roomId -> room

function createRoom(roomId) {
  const map = generateMap();
  return {
    id: roomId,
    map,
    players: {},      // socketId -> player
    bombs: [],
    fires: [],
    started: false,
    over: false,
    winner: null,
    timers: [],
  };
}

function roomPlayerCount(room) {
  return Object.keys(room.players).length;
}

function broadcastRoom(room) {
  io.to(room.id).emit('state', getState(room));
}

function getState(room) {
  return {
    map: room.map,
    players: room.players,
    bombs: room.bombs,
    fires: room.fires,
    started: room.started,
    over: room.over,
    winner: room.winner,
  };
}

// ─── Bomb & Fire ──────────────────────────────────────────────────────────────
function placeBomb(room, player) {
  if (player.bombsPlaced >= player.maxBombs) return;
  const bx = player.x;
  const by = player.y;

  // Check no bomb already here
  if (room.bombs.find(b => b.x === bx && b.y === by)) return;

  player.bombsPlaced++;
  const bomb = { x: bx, y: by, owner: player.id, range: BOMB_RANGE };
  room.bombs.push(bomb);
  room.map[by][bx] = TILE.BOMB;
  broadcastRoom(room);

  const t = setTimeout(() => {
    explodeBomb(room, bomb, player);
  }, BOMB_TIMER);
  room.timers.push(t);
}

function explodeBomb(room, bomb, player) {
  const idx = room.bombs.indexOf(bomb);
  if (idx === -1) return; // already exploded (chain)
  room.bombs.splice(idx, 1);
  if (room.map[bomb.y][bomb.x] === TILE.BOMB) room.map[bomb.y][bomb.x] = TILE.EMPTY;
  if (player) player.bombsPlaced = Math.max(0, player.bombsPlaced - 1);

  const cells = getExplosionCells(room, bomb);
  cells.forEach(({ x, y }) => {
    room.map[y][x] = TILE.FIRE;
    room.fires.push({ x, y });
    // Chain bombs
    const chainBomb = room.bombs.find(b => b.x === x && b.y === y);
    if (chainBomb) {
      const chainOwner = Object.values(room.players).find(p => p.id === chainBomb.owner);
      explodeBomb(room, chainBomb, chainOwner);
    }
  });

  // Kill players in fire
  Object.values(room.players).forEach(p => {
    if (!p.alive) return;
    if (cells.find(c => c.x === p.x && c.y === p.y)) {
      p.alive = false;
    }
  });

  checkWin(room);
  broadcastRoom(room);

  // Clear fire
  const ft = setTimeout(() => {
    cells.forEach(({ x, y }) => {
      if (room.map[y][x] === TILE.FIRE) room.map[y][x] = TILE.EMPTY;
      const fi = room.fires.findIndex(f => f.x === x && f.y === y);
      if (fi !== -1) room.fires.splice(fi, 1);
    });
    broadcastRoom(room);
  }, FIRE_DURATION);
  room.timers.push(ft);
}

function getExplosionCells(room, bomb) {
  const cells = [{ x: bomb.x, y: bomb.y }];
  const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
  dirs.forEach(([dx, dy]) => {
    for (let i = 1; i <= bomb.range; i++) {
      const nx = bomb.x + dx * i;
      const ny = bomb.y + dy * i;
      if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) break;
      const tile = room.map[ny][nx];
      if (tile === TILE.WALL) break;
      if (tile === TILE.BLOCK || tile === TILE.BOMB) {
        cells.push({ x: nx, y: ny });
        if (tile === TILE.BLOCK) room.map[ny][nx] = TILE.EMPTY;
        break;
      }
      cells.push({ x: nx, y: ny });
    }
  });
  return cells;
}

function checkWin(room) {
  if (room.over) return;
  const alive = Object.values(room.players).filter(p => p.alive);
  if (alive.length <= 1) {
    room.over = true;
    room.winner = alive.length === 1 ? alive[0].name : 'Draw';
    // Clear all pending timers
    room.timers.forEach(t => clearTimeout(t));
    room.timers = [];
  }
}

// ─── Movement ─────────────────────────────────────────────────────────────────
function movePlayer(room, player, dir) {
  if (!player.alive || room.over) return;
  const now = Date.now();
  if (now - player.lastMove < MOVE_COOLDOWN) return;
  player.lastMove = now;

  const dx = { left: -1, right: 1, up: 0, down: 0 }[dir] ?? 0;
  const dy = { left: 0, right: 0, up: -1, down: 1 }[dir] ?? 0;
  const nx = player.x + dx;
  const ny = player.y + dy;

  if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) return;
  const tile = room.map[ny][nx];
  if (tile === TILE.WALL || tile === TILE.BLOCK || tile === TILE.BOMB) return;

  player.x = nx;
  player.y = ny;

  // Die if standing in fire
  if (tile === TILE.FIRE) {
    player.alive = false;
    checkWin(room);
  }

  broadcastRoom(room);
}

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('connect', socket.id);

  socket.on('join', ({ roomId, name }) => {
    if (!roomId || !name) return;

    if (!rooms[roomId]) rooms[roomId] = createRoom(roomId);
    const room = rooms[roomId];

    if (room.over) {
      socket.emit('error', 'Game already over. Use a new room.');
      return;
    }
    if (roomPlayerCount(room) >= 2) {
      socket.emit('error', 'Room is full.');
      return;
    }

    const playerIndex = roomPlayerCount(room); // 0 or 1
    const spawn = SPAWNS[playerIndex];
    const player = {
      id: socket.id,
      name: name.slice(0, 12),
      x: spawn.x,
      y: spawn.y,
      alive: true,
      index: playerIndex,
      bombsPlaced: 0,
      maxBombs: 1,
      lastMove: 0,
    };
    room.players[socket.id] = player;
    socket.join(roomId);
    socket.data.roomId = roomId;

    socket.emit('joined', { playerIndex, playerId: socket.id });

    if (roomPlayerCount(room) === 2) {
      room.started = true;
      io.to(roomId).emit('start');
    }

    broadcastRoom(room);
  });

  socket.on('move', (dir) => {
    const room = rooms[socket.data.roomId];
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;
    movePlayer(room, player, dir);
  });

  socket.on('bomb', () => {
    const room = rooms[socket.data.roomId];
    if (!room || !room.started || room.over) return;
    const player = room.players[socket.id];
    if (!player || !player.alive) return;
    placeBomb(room, player);
  });

  socket.on('restart', () => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room) return;
    // Only restart if game over
    if (!room.over) return;
    const newRoom = createRoom(roomId);
    // Re-add players with same names
    Object.values(room.players).forEach((p, i) => {
      const spawn = SPAWNS[i];
      newRoom.players[p.id] = {
        ...p,
        x: spawn.x, y: spawn.y,
        alive: true, bombsPlaced: 0, lastMove: 0,
      };
    });
    newRoom.started = true;
    rooms[roomId] = newRoom;
    io.to(roomId).emit('start');
    broadcastRoom(newRoom);
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    const player = room.players[socket.id];
    if (player) {
      io.to(roomId).emit('playerLeft', { name: player.name });
      delete room.players[socket.id];
    }
    if (roomPlayerCount(room) === 0) {
      room.timers.forEach(t => clearTimeout(t));
      delete rooms[roomId];
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎮 Bomberman running on http://localhost:${PORT}`));
