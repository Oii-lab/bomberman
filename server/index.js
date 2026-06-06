const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static(path.join(__dirname, '../public')));

// ─── Constants ────────────────────────────────────────────────────────────────
const COLS = 15, ROWS = 13;
const TILE = { EMPTY: 0, WALL: 1, BLOCK: 2, BOMB: 3, FIRE: 4 };
const BOMB_TIMER = 3000;
const FIRE_DURATION = 700;
const MOVE_COOLDOWN = 105;
const SPAWNS = [{ x:1,y:1 }, { x:COLS-2,y:ROWS-2 }];

// Item types
const ITEM = { BOMB_UP:1, RANGE_UP:2, SPEED_UP:3, PIERCE:4, REMOTE:5 };
const ITEM_CHANCE = 0.35; // chance block drops item

// Map themes
const THEMES = ['dungeon','forest','space','lava'];

// ─── Map generation ───────────────────────────────────────────────────────────
function generateMap(theme) {
  const map = [];
  for (let y = 0; y < ROWS; y++) {
    map[y] = [];
    for (let x = 0; x < COLS; x++) {
      if (y===0||y===ROWS-1||x===0||x===COLS-1) map[y][x] = TILE.WALL;
      else if (y%2===0 && x%2===0) map[y][x] = TILE.WALL;
      else map[y][x] = TILE.EMPTY;
    }
  }
  // lava theme: extra random walls inside
  if (theme === 'lava') {
    for (let y=1;y<ROWS-1;y++) for (let x=1;x<COLS-1;x++) {
      if (map[y][x]===TILE.EMPTY && Math.random()<0.05) map[y][x]=TILE.WALL;
    }
  }
  const spawnSafe = new Set();
  SPAWNS.forEach(s => {
    for (let dy=-1;dy<=1;dy++) for (let dx=-1;dx<=1;dx++)
      spawnSafe.add(`${s.x+dx},${s.y+dy}`);
  });
  for (let y=1;y<ROWS-1;y++) for (let x=1;x<COLS-1;x++) {
    if (map[y][x]===TILE.EMPTY && !spawnSafe.has(`${x},${y}`) && Math.random()<0.42)
      map[y][x] = TILE.BLOCK;
  }
  return map;
}

// ─── Rooms ────────────────────────────────────────────────────────────────────
const rooms = {};

function createRoom(roomId) {
  const theme = THEMES[Math.floor(Math.random()*THEMES.length)];
  return {
    id: roomId, theme,
    map: generateMap(theme),
    players: {},
    bombs: [],
    fires: [],
    items: [],       // { x, y, type }
    started: false, over: false, winner: null,
    timers: [],
  };
}

function broadcastRoom(room) {
  io.to(room.id).emit('state', {
    map: room.map, players: room.players,
    bombs: room.bombs, fires: room.fires, items: room.items,
    started: room.started, over: room.over, winner: room.winner,
    theme: room.theme,
  });
}

// ─── Items ────────────────────────────────────────────────────────────────────
function spawnItem(room, x, y) {
  if (Math.random() > ITEM_CHANCE) return;
  const types = [ITEM.BOMB_UP, ITEM.RANGE_UP, ITEM.SPEED_UP, ITEM.PIERCE, ITEM.REMOTE];
  // weight: common items more likely
  const weights = [30, 30, 25, 8, 7];
  const total = weights.reduce((a,b)=>a+b,0);
  let r = Math.random()*total;
  let type = types[0];
  for (let i=0;i<types.length;i++) { r-=weights[i]; if (r<=0){type=types[i];break;} }
  room.items.push({ x, y, type });
}

function pickupItems(room, player) {
  for (let i = room.items.length-1; i>=0; i--) {
    const item = room.items[i];
    if (item.x===player.x && item.y===player.y) {
      applyItem(player, item.type);
      room.items.splice(i, 1);
    }
  }
}

function applyItem(player, type) {
  switch(type) {
    case ITEM.BOMB_UP:   player.maxBombs = Math.min(player.maxBombs+1, 5); break;
    case ITEM.RANGE_UP:  player.bombRange = Math.min(player.bombRange+1, 7); break;
    case ITEM.SPEED_UP:  player.speed = Math.max(player.speed-15, 60); break;
    case ITEM.PIERCE:    player.pierce = true; break;
    case ITEM.REMOTE:    player.remote = true; break;
  }
}

// ─── Bomb ─────────────────────────────────────────────────────────────────────
function placeBomb(room, player) {
  if (player.bombsPlaced >= player.maxBombs) return;
  if (room.bombs.find(b=>b.x===player.x&&b.y===player.y)) return;

  player.bombsPlaced++;
  const bomb = {
    x: player.x, y: player.y, owner: player.id,
    range: player.bombRange,
    pierce: player.pierce,
    remote: player.remote,
    id: Date.now() + Math.random(),
  };
  room.bombs.push(bomb);
  room.map[bomb.y][bomb.x] = TILE.BOMB;

  if (!bomb.remote) {
    const t = setTimeout(() => explodeBomb(room, bomb), BOMB_TIMER);
    bomb._timer = t;
    room.timers.push(t);
  }
  broadcastRoom(room);
}

function detonateRemote(room, player) {
  const myBombs = room.bombs.filter(b=>b.owner===player.id && b.remote);
  if (myBombs.length===0) return;
  // detonate oldest
  explodeBomb(room, myBombs[0]);
}

function explodeBomb(room, bomb) {
  const idx = room.bombs.indexOf(bomb);
  if (idx===-1) return;
  if (bomb._timer) { clearTimeout(bomb._timer); }
  room.bombs.splice(idx, 1);
  if (room.map[bomb.y]?.[bomb.x] === TILE.BOMB) room.map[bomb.y][bomb.x] = TILE.EMPTY;

  const owner = Object.values(room.players).find(p=>p.id===bomb.owner);
  if (owner) owner.bombsPlaced = Math.max(0, owner.bombsPlaced-1);

  const cells = getExplosionCells(room, bomb);
  cells.forEach(({x,y}) => {
    room.map[y][x] = TILE.FIRE;
    // remove items under fire
    const ii = room.items.findIndex(it=>it.x===x&&it.y===y);
    if (ii!==-1) room.items.splice(ii,1);
    room.fires.push({x,y});
    // chain
    const chain = room.bombs.find(b=>b.x===x&&b.y===y);
    if (chain) explodeBomb(room, chain);
  });

  // kill players
  Object.values(room.players).forEach(p => {
    if (!p.alive) return;
    if (cells.find(c=>c.x===p.x&&c.y===p.y)) p.alive = false;
  });

  checkWin(room);
  broadcastRoom(room);

  const ft = setTimeout(() => {
    cells.forEach(({x,y}) => {
      if (room.map[y]?.[x]===TILE.FIRE) room.map[y][x]=TILE.EMPTY;
      const fi = room.fires.findIndex(f=>f.x===x&&f.y===y);
      if (fi!==-1) room.fires.splice(fi,1);
    });
    broadcastRoom(room);
  }, FIRE_DURATION);
  room.timers.push(ft);
}

function getExplosionCells(room, bomb) {
  const cells = [{x:bomb.x,y:bomb.y}];
  const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
  dirs.forEach(([dx,dy]) => {
    for (let i=1;i<=bomb.range;i++) {
      const nx=bomb.x+dx*i, ny=bomb.y+dy*i;
      if (nx<0||ny<0||nx>=COLS||ny>=ROWS) break;
      const tile = room.map[ny][nx];
      if (tile===TILE.WALL) break;
      if (tile===TILE.BLOCK || tile===TILE.BOMB) {
        cells.push({x:nx,y:ny});
        if (tile===TILE.BLOCK) {
          room.map[ny][nx]=TILE.EMPTY;
          spawnItem(room, nx, ny);
        }
        if (!bomb.pierce) break;
        // pierce continues but doesn't push duplicate
      } else {
        cells.push({x:nx,y:ny});
      }
    }
  });
  return cells;
}

function checkWin(room) {
  if (room.over) return;
  const alive = Object.values(room.players).filter(p=>p.alive);
  if (alive.length<=1) {
    room.over = true;
    room.winner = alive.length===1 ? alive[0].name : 'Draw';
    room.timers.forEach(t=>clearTimeout(t));
    room.timers=[];
  }
}

// ─── Movement ─────────────────────────────────────────────────────────────────
function movePlayer(room, player, dir) {
  if (!player.alive||room.over) return;
  const now = Date.now();
  if (now-player.lastMove < player.speed) return;
  player.lastMove = now;

  const dx={left:-1,right:1,up:0,down:0}[dir]??0;
  const dy={left:0,right:0,up:-1,down:1}[dir]??0;
  const nx=player.x+dx, ny=player.y+dy;
  if (nx<0||ny<0||nx>=COLS||ny>=ROWS) return;
  const tile = room.map[ny][nx];
  // FIX: allow walking through fire (don't block, just damage)
  if (tile===TILE.WALL||tile===TILE.BLOCK||tile===TILE.BOMB) return;

  player.x=nx; player.y=ny;

  if (tile===TILE.FIRE) { player.alive=false; checkWin(room); }
  else pickupItems(room, player);

  broadcastRoom(room);
}

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  socket.on('join', ({roomId, name}) => {
    if (!roomId||!name) return;
    if (!rooms[roomId]) rooms[roomId]=createRoom(roomId);
    const room = rooms[roomId];
    if (room.over) { socket.emit('error','遊戲已結束，請換個房間 ID'); return; }
    if (Object.keys(room.players).length>=2) { socket.emit('error','房間已滿'); return; }

    const idx = Object.keys(room.players).length;
    const spawn = SPAWNS[idx];
    room.players[socket.id] = {
      id: socket.id, name: name.slice(0,12),
      x: spawn.x, y: spawn.y,
      alive: true, index: idx,
      bombsPlaced: 0, maxBombs: 1,
      bombRange: 2,
      speed: MOVE_COOLDOWN,
      pierce: false, remote: false,
      lastMove: 0,
    };
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.emit('joined', { playerIndex: idx, playerId: socket.id });
    if (Object.keys(room.players).length===2) { room.started=true; io.to(roomId).emit('start'); }
    broadcastRoom(room);
  });

  socket.on('move', dir => {
    const room = rooms[socket.data.roomId]; if (!room) return;
    const player = room.players[socket.id]; if (!player) return;
    movePlayer(room, player, dir);
  });

  socket.on('bomb', () => {
    const room = rooms[socket.data.roomId]; if (!room||!room.started||room.over) return;
    const player = room.players[socket.id]; if (!player||!player.alive) return;
    if (player.remote && room.bombs.find(b=>b.owner===socket.id&&b.remote)) {
      detonateRemote(room, player);
    } else {
      placeBomb(room, player);
    }
  });

  socket.on('restart', () => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId]; if (!room||!room.over) return;
    const newRoom = createRoom(roomId);
    Object.values(room.players).forEach((p,i) => {
      const spawn=SPAWNS[i];
      newRoom.players[p.id]={
        id:p.id, name:p.name,
        x:spawn.x, y:spawn.y,
        alive:true, index:i,
        bombsPlaced:0, maxBombs:1, bombRange:2,
        speed:MOVE_COOLDOWN,
        pierce:false, remote:false, lastMove:0,
      };
    });
    newRoom.started=true;
    rooms[roomId]=newRoom;
    io.to(roomId).emit('start');
    broadcastRoom(newRoom);
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId||!rooms[roomId]) return;
    const room = rooms[roomId];
    const player = room.players[socket.id];
    if (player) { io.to(roomId).emit('playerLeft',{name:player.name}); delete room.players[socket.id]; }
    if (Object.keys(room.players).length===0) { room.timers.forEach(t=>clearTimeout(t)); delete rooms[roomId]; }
  });
});

const PORT = process.env.PORT||3000;
server.listen(PORT, ()=>console.log(`💣 Bomberman on http://localhost:${PORT}`));
