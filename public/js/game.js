// ── Constants ──────────────────────────────────────────────────────────────────
const TILE = { EMPTY:0, WALL:1, BLOCK:2, BOMB:3, FIRE:4 };
const ITEM = { BOMB_UP:1, RANGE_UP:2, SPEED_UP:3, PIERCE:4, REMOTE:5 };
const ITEM_INFO = {
  1: { emoji:'💣', label:'炸彈+1', color:'#ffcc00' },
  2: { emoji:'🔥', label:'射程+1', color:'#ff6b00' },
  3: { emoji:'⚡', label:'加速',   color:'#39ff7e' },
  4: { emoji:'👻', label:'穿牆彈', color:'#cc88ff' },
  5: { emoji:'📡', label:'遙控彈', color:'#3cf' },
};
const COLS=15, ROWS=13;

// Theme palettes
const THEMES = {
  dungeon: { bg:'#111122', wall:'#1a1a2e', wallShine:'#22223a', block:'#3a2a1a', blockShine:'#5a3e28', empty:'#0d0d1a', name:'地牢' },
  forest:  { bg:'#0a1a0a', wall:'#1a2e1a', wallShine:'#2a3e2a', block:'#2a3a1a', blockShine:'#3a5020', empty:'#0d1a0d', name:'森林' },
  space:   { bg:'#050510', wall:'#0a0a25', wallShine:'#1a1a40', block:'#1a1a35', blockShine:'#2a2a55', empty:'#080815', name:'宇宙' },
  lava:    { bg:'#1a0800', wall:'#2e1000', wallShine:'#3e1800', block:'#3a1a0a', blockShine:'#5a2a10', empty:'#150600', name:'熔岩' },
};

let socket, myIndex, myId;
let state = null;
let canvas, ctx;
let bombFlash = 0;
const keys = {};

const $ = id => document.getElementById(id);
function show(id){$(id).classList.remove('hidden');}
function hide(id){$(id).classList.add('hidden');}

// ── Lobby ──────────────────────────────────────────────────────────────────────
$('randomRoomBtn').addEventListener('click',()=>{
  $('roomInput').value='room-'+Math.random().toString(36).slice(2,7);
});
$('joinBtn').addEventListener('click', joinRoom);
$('nameInput').addEventListener('keydown',e=>{if(e.key==='Enter')joinRoom();});
$('roomInput').addEventListener('keydown',e=>{if(e.key==='Enter')joinRoom();});

function joinRoom(){
  const name=$('nameInput').value.trim();
  const roomId=$('roomInput').value.trim();
  if(!name){$('lobbyError').textContent='請輸入名字';return;}
  if(!roomId){$('lobbyError').textContent='請輸入房間 ID';return;}
  $('lobbyError').textContent='';
  initSocket(name,roomId);
}

// ── Socket ─────────────────────────────────────────────────────────────────────
function initSocket(name,roomId){
  socket=io();
  socket.on('connect',()=>{
    socket.emit('join',{roomId,name});
    hide('lobby'); show('waiting');
    $('waitingRoom').textContent=roomId;
  });
  socket.on('joined',({playerIndex,playerId})=>{myIndex=playerIndex;myId=playerId;});
  socket.on('start',()=>{
    hide('waiting'); show('game'); hide('overlay');
    initCanvas(); startInputLoop();
    $('myControls').textContent = myIndex===0
      ? '🔴 WASD 移動 | Space 炸彈'
      : '🔵 ↑↓←→ 移動 | Enter 炸彈';
  });
  socket.on('state',s=>{
    state=s;
    if(s.over) showGameOver(s);
    updateHud(s);
  });
  socket.on('error',msg=>{hide('waiting');show('lobby');$('lobbyError').textContent=msg;socket.disconnect();});
  socket.on('playerLeft',()=>show('disconnected'));
  socket.on('disconnect',()=>{if(!$('disconnected').classList.contains('hidden'))return;show('disconnected');});
}

// ── Canvas ─────────────────────────────────────────────────────────────────────
function initCanvas(){
  canvas=$('gameCanvas'); ctx=canvas.getContext('2d');
  const size=Math.min(Math.floor((window.innerHeight-150)/ROWS),Math.floor((window.innerWidth-20)/COLS));
  canvas._cell=Math.max(32,Math.min(48,size));
  canvas.width=COLS*canvas._cell;
  canvas.height=ROWS*canvas._cell;
  requestAnimationFrame(renderLoop);
}

function renderLoop(){
  requestAnimationFrame(renderLoop);
  bombFlash=(bombFlash+1)%60;
  if(state) draw(state);
}

function getTheme(){ return THEMES[state?.theme]||THEMES.dungeon; }

function draw(s){
  const C=canvas._cell, T=getTheme();
  ctx.fillStyle=T.bg; ctx.fillRect(0,0,canvas.width,canvas.height);

  // stars for space theme
  if(s.theme==='space'){
    ctx.fillStyle='rgba(255,255,255,0.4)';
    for(let i=0;i<40;i++){
      const sx=((i*137+13)%canvas.width), sy=((i*97+7)%canvas.height);
      ctx.fillRect(sx,sy,1,1);
    }
  }
  // lava glow
  if(s.theme==='lava'){
    const lavaAlpha=0.04+0.02*Math.sin(bombFlash/60*Math.PI*2);
    ctx.fillStyle=`rgba(255,80,0,${lavaAlpha})`;
    ctx.fillRect(0,0,canvas.width,canvas.height);
  }

  for(let y=0;y<ROWS;y++) for(let x=0;x<COLS;x++) drawCell(x,y,s.map[y][x],C,T);
  s.items.forEach(item=>drawItem(item.x,item.y,item.type,C));
  s.bombs.forEach(b=>drawBomb(b,C));
  Object.values(s.players).forEach(p=>{if(p.alive)drawPlayer(p,C);});
  Object.values(s.players).forEach(p=>{if(!p.alive)drawGhost(p,C);});
}

function drawCell(x,y,tile,C,T){
  const px=x*C,py=y*C;
  switch(tile){
    case TILE.EMPTY: case TILE.BOMB:
      ctx.fillStyle=T.empty; ctx.fillRect(px,py,C,C);
      ctx.strokeStyle='rgba(255,255,255,.025)'; ctx.strokeRect(px+.5,py+.5,C-1,C-1);
      break;
    case TILE.WALL:
      ctx.fillStyle=T.wall; ctx.fillRect(px,py,C,C);
      ctx.fillStyle=T.wallShine;
      ctx.fillRect(px+2,py+2,C-4,3); ctx.fillRect(px+2,py+2,3,C-4);
      break;
    case TILE.BLOCK:
      ctx.fillStyle=T.block; ctx.fillRect(px,py,C,C);
      ctx.fillStyle=T.blockShine;
      ctx.fillRect(px+3,py+3,C-6,3); ctx.fillRect(px+3,py+3,3,C-6);
      ctx.strokeStyle='rgba(255,200,100,.12)'; ctx.lineWidth=1;
      ctx.strokeRect(px+4,py+4,C-8,C-8);
      break;
    case TILE.FIRE:
      drawFire(px,py,C); break;
  }
}

function drawFire(px,py,C){
  const t=bombFlash/60;
  const g=ctx.createRadialGradient(px+C/2,py+C/2,2,px+C/2,py+C/2,C/2);
  g.addColorStop(0,`rgba(255,255,${Math.floor(t*200)},.95)`);
  g.addColorStop(1,`rgba(255,${Math.floor(80+t*100)},0,.85)`);
  ctx.fillStyle=g; ctx.fillRect(px,py,C,C);
}

function drawBomb(bomb,C){
  const px=bomb.x*C, py=bomb.y*C;
  const pulse=.85+.15*Math.sin(bombFlash/60*Math.PI*2);
  const r=(C/2-4)*pulse, cx=px+C/2, cy=py+C/2;
  ctx.save();
  // remote bomb glows blue
  const glowColor = bomb.remote ? '#3cf' : '#ff3c3c';
  const bodyColor = bomb.remote ? '#001a2e' : '#222';
  ctx.shadowColor=glowColor; ctx.shadowBlur=12*pulse;
  ctx.fillStyle=bodyColor;
  ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.fill();
  ctx.strokeStyle=glowColor; ctx.lineWidth=2; ctx.stroke();
  // pierce bomb: X mark
  if(bomb.pierce){
    ctx.strokeStyle='#cc88ff'; ctx.lineWidth=1.5;
    ctx.beginPath();
    ctx.moveTo(cx-r*.5,cy-r*.5); ctx.lineTo(cx+r*.5,cy+r*.5);
    ctx.moveTo(cx+r*.5,cy-r*.5); ctx.lineTo(cx-r*.5,cy+r*.5);
    ctx.stroke();
  }
  ctx.strokeStyle='#ffcc00'; ctx.lineWidth=2;
  ctx.beginPath();
  ctx.moveTo(cx+r*.5,cy-r*.7);
  ctx.quadraticCurveTo(cx+r*.9,cy-r*1.2,cx+r*.6,cy-r*1.5);
  ctx.stroke();
  if(bombFlash%10<5){
    ctx.fillStyle='#ffcc00';
    ctx.beginPath(); ctx.arc(cx+r*.6,cy-r*1.5,3,0,Math.PI*2); ctx.fill();
  }
  ctx.restore();
}

function drawItem(x,y,type,C){
  const px=x*C, py=y*C;
  const info=ITEM_INFO[type]; if(!info) return;
  const bob=Math.sin(bombFlash/60*Math.PI*2)*2;
  ctx.save();
  // glow
  ctx.shadowColor=info.color; ctx.shadowBlur=10;
  ctx.fillStyle=info.color+'33';
  ctx.beginPath(); ctx.arc(px+C/2,py+C/2+bob,C/2-6,0,Math.PI*2); ctx.fill();
  ctx.strokeStyle=info.color; ctx.lineWidth=1.5; ctx.stroke();
  // emoji
  ctx.shadowBlur=0;
  ctx.font=`${Math.floor(C*.42)}px serif`;
  ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText(info.emoji, px+C/2, py+C/2+bob);
  ctx.restore();
}

function fillRoundRect(x,y,w,h,r){
  ctx.beginPath();
  ctx.moveTo(x+r,y);
  ctx.lineTo(x+w-r,y); ctx.arcTo(x+w,y,x+w,y+r,r);
  ctx.lineTo(x+w,y+h-r); ctx.arcTo(x+w,y+h,x+w-r,y+h,r);
  ctx.lineTo(x+r,y+h); ctx.arcTo(x,y+h,x,y+h-r,r);
  ctx.lineTo(x,y+r); ctx.arcTo(x,y,x+r,y,r);
  ctx.closePath(); ctx.fill();
}

function drawPlayer(p,C){
  const px=p.x*C, py=p.y*C;
  const color=p.index===0?'#ff3c3c':'#3c8bff';
  const dark=p.index===0?'#aa1a1a':'#1a55aa';
  const isMe=p.id===myId;
  const cx=px+C/2, cy=py+C/2;
  ctx.save();
  if(isMe){ctx.shadowColor=color;ctx.shadowBlur=14;}
  ctx.fillStyle=dark;
  fillRoundRect(px+6,py+C/2-2,C-12,C/2-4,4);
  ctx.fillStyle=color;
  fillRoundRect(px+7,py+C/2-1,C-14,C/2-6,3);
  ctx.fillStyle=color;
  ctx.beginPath(); ctx.arc(cx,py+C/2-4,C/2-8,0,Math.PI*2); ctx.fill();
  ctx.fillStyle='#fff';
  ctx.beginPath(); ctx.arc(cx-4,py+C/2-6,3,0,Math.PI*2); ctx.arc(cx+4,py+C/2-6,3,0,Math.PI*2); ctx.fill();
  ctx.fillStyle='#222';
  ctx.beginPath(); ctx.arc(cx-3.5,py+C/2-6,1.5,0,Math.PI*2); ctx.arc(cx+4.5,py+C/2-6,1.5,0,Math.PI*2); ctx.fill();
  // status icons
  if(isMe){
    ctx.shadowBlur=0; ctx.fillStyle=color;
    ctx.font=`bold ${Math.max(9,C*.18)}px Nunito,sans-serif`;
    ctx.textAlign='center'; ctx.fillText('YOU',cx,py+C-2);
  }
  ctx.restore();
}

function drawGhost(p,C){
  ctx.save(); ctx.globalAlpha=.3; drawPlayer(p,C); ctx.restore();
  const cx=p.x*C+C/2, cy=p.y*C+C/2;
  ctx.save(); ctx.strokeStyle='#ff3c3c'; ctx.lineWidth=3; ctx.globalAlpha=.7;
  ctx.beginPath();
  ctx.moveTo(cx-10,cy-10);ctx.lineTo(cx+10,cy+10);
  ctx.moveTo(cx+10,cy-10);ctx.lineTo(cx-10,cy+10);
  ctx.stroke(); ctx.restore();
}

// ── HUD ────────────────────────────────────────────────────────────────────────
function updateHud(s){
  const T=THEMES[s.theme]||THEMES.dungeon;
  $('themeLabel').textContent='🗺️ '+T.name;
  Object.values(s.players).forEach(p=>{
    $(`hud${p.index}name`).textContent=p.name;
    $(`hud${p.index}status`).textContent=p.alive?'❤️':'💀';
    const statsEl=$(`hud${p.index}stats`);
    if(statsEl){
      let icons='';
      icons+=`💣×${p.maxBombs??1} `;
      icons+=`🔥×${p.bombRange??2} `;
      if(p.speed<105) icons+='⚡ ';
      if(p.pierce) icons+='👻 ';
      if(p.remote) icons+='📡 ';
      statsEl.textContent=icons.trim();
    }
  });
}

// ── Game Over ──────────────────────────────────────────────────────────────────
function showGameOver(s){
  const isMe=s.winner&&Object.values(s.players).find(p=>p.name===s.winner&&p.id===myId);
  const isDraw=s.winner==='Draw';
  $('overlayIcon').textContent=isDraw?'🤝':isMe?'🏆':'💀';
  $('overlayTitle').textContent=isDraw?'DRAW!':isMe?'YOU WIN!':'YOU LOSE!';
  $('overlayMsg').textContent=isDraw?'勢均力敵！':`${s.winner} 獲勝！`;
  $('gameStatus').textContent='結束';
  show('overlay');
}
$('restartBtn').addEventListener('click',()=>{socket.emit('restart');hide('overlay');$('gameStatus').textContent='進行中';});

// ── Input ──────────────────────────────────────────────────────────────────────
function startInputLoop(){
  document.addEventListener('keydown',onKeyDown);
  document.addEventListener('keyup',e=>{keys[e.code]=false;});
  setInterval(sendMovement,100);
}

function onKeyDown(e){
  keys[e.code]=true;
  if(myIndex===0&&e.code==='Space'){e.preventDefault();socket.emit('bomb');}
  if(myIndex===1&&e.code==='Enter'){e.preventDefault();socket.emit('bomb');}
  if(['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code)) e.preventDefault();
}

function sendMovement(){
  if(!socket||!state||state.over) return;
  let dir=null;
  if(myIndex===0){
    if(keys['KeyW'])dir='up'; else if(keys['KeyS'])dir='down';
    else if(keys['KeyA'])dir='left'; else if(keys['KeyD'])dir='right';
  } else {
    if(keys['ArrowUp'])dir='up'; else if(keys['ArrowDown'])dir='down';
    else if(keys['ArrowLeft'])dir='left'; else if(keys['ArrowRight'])dir='right';
  }
  if(dir) socket.emit('move',dir);
}
