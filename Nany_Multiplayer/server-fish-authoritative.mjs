import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT || 10000);
const WORLD_W = 12000;
const WORLD_H = 12000;
const TICK_MS = 50;
const MAX_PLAYERS = 8;
const MAX_STEP = 11;
const FISH_COUNT = 260;

const rooms = new Map();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const normalizeRoom = v => String(v || 'ABISMO01').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 16) || 'ABISMO01';
const normalizeMode = v => ['teams', 'ffa', 'coop'].includes(v) ? v : 'teams';
const safeName = v => String(v || 'Nany').trim().slice(0, 18) || 'Nany';
const send = (ws, msg) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };

function seedRand(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17; s >>>= 0;
    s ^= s << 5; s >>>= 0;
    return (s >>> 0) / 4294967296;
  };
}

const FISH_TYPES = [
  { key:'plankton', power:1, points:5,  color:'#8fffb0', speed:.30, role:'prey',      size:3 },
  { key:'minnow',   power:2, points:10, color:'#bfe6ff', speed:.90, role:'prey',      size:7 },
  { key:'green',    power:3, points:20, color:'#39ff6a', speed:1.60, role:'prey',      size:9 },
  { key:'piranha',  power:4, points:35, color:'#ff8a3d', speed:1.70, role:'predator', size:12 },
  { key:'stick',    power:5, points:50, color:'#e0c66a', speed:.70, role:'predator', size:15 },
  { key:'rival',    power:6, points:75, color:'#a084ff', speed:1.10, role:'predator', size:19 },
  { key:'shark',    power:8, points:150,color:'#6d8796', speed:1.40, role:'predator', size:28 }
];

function typeForIndex(i) {
  if (i < 120) return FISH_TYPES[0];
  if (i < 170) return FISH_TYPES[1];
  if (i < 200) return FISH_TYPES[2];
  if (i < 225) return FISH_TYPES[3];
  if (i < 245) return FISH_TYPES[4];
  if (i < 258) return FISH_TYPES[5];
  return FISH_TYPES[6];
}

function playerPower(score) {
  if (score < 100) return 1;
  if (score < 250) return 2;
  if (score < 500) return 3;
  if (score < 900) return 4;
  if (score < 1500) return 5;
  if (score < 2500) return 6;
  if (score < 4000) return 7;
  if (score < 6000) return 8;
  if (score < 9000) return 9;
  return 10;
}

function buildFishWorld(room) {
  const r = seedRand(room.seed);
  room.fish = new Map();
  for (let i = 0; i < FISH_COUNT; i++) {
    const t = typeForIndex(i);
    const a = r() * Math.PI * 2;
    const speed = t.speed * (0.82 + r() * 0.30);
    room.fish.set(`fish-${i}`, {
      id:`fish-${i}`,
      type:t.key,
      role:t.role,
      power:t.power,
      points:t.points,
      color:t.color,
      size:t.size * (0.88 + r() * 0.24),
      speed,
      x:100 + r() * (WORLD_W - 200),
      y:100 + r() * (WORLD_H - 200),
      vx:Math.cos(a) * speed * 0.5,
      vy:Math.sin(a) * speed * 0.5,
      angle:a,
      heading:a,
      turnTimer:0.6 + r() * 1.8,
      seed:r(),
      chase:0
    });
  }
}

function newRoom(code, mode) {
  const room = {
    code,
    mode,
    seed:(Math.floor(Math.random() * 0xffffffff) >>> 0) || 1,
    epoch:Date.now(),
    players:new Map(),
    spectators:new Set(),
    anchor:{x:WORLD_W/2, y:WORLD_H/2},
    fish:new Map()
  };
  buildFishWorld(room);
  rooms.set(code, room);
  return room;
}

function chooseTeam(room, requested) {
  if (room.mode !== 'teams') return null;
  const a = [...room.players.values()].filter(p => p.team === 'A').length;
  const b = [...room.players.values()].filter(p => p.team === 'B').length;
  if ((requested === 'A' || requested === 'B') && Math.abs(a - b) <= 1) return requested;
  return a <= b ? 'A' : 'B';
}

function spawnFor(room) {
  const players = [...room.players.values()];
  if (!players.length) return {...room.anchor};
  const p = players[0];
  const a = Math.random() * Math.PI * 2;
  const r = 90 + Math.random() * 100;
  return {
    x:clamp(p.x + Math.cos(a) * r, 100, WORLD_W - 100),
    y:clamp(p.y + Math.sin(a) * r, 100, WORLD_H - 100)
  };
}

function publicPlayer(p) {
  return {
    id:p.id, name:p.name,
    x:+p.x.toFixed(2), y:+p.y.toFixed(2),
    vx:+p.vx.toFixed(2), vy:+p.vy.toFixed(2), angle:+p.angle.toFixed(3),
    score:Math.floor(p.score), growthScore:Math.floor(p.growthScore),
    level:p.level, radius:+p.radius.toFixed(2), power:playerPower(p.score),
    alive:p.alive, sprinting:p.sprinting, team:p.team,
    teamName:p.team === 'A' ? 'Azul' : p.team === 'B' ? 'Rojo' : null
  };
}

function publicFish(f) {
  return {
    id:f.id, type:f.type, role:f.role, power:f.power, points:f.points,
    size:+f.size.toFixed(2), color:f.color,
    x:+f.x.toFixed(2), y:+f.y.toFixed(2),
    vx:+f.vx.toFixed(3), vy:+f.vy.toFixed(3), angle:+f.angle.toFixed(3)
  };
}

function snapshot(room, viewer = null) {
  return {
    type:'snapshot', room:room.code, mode:room.mode,
    population:room.players.size, worldSeed:room.seed, worldEpoch:room.epoch,
    worldStage:0,
    players:[...room.players.values()].map(publicPlayer),
    you:viewer ? publicPlayer(viewer) : null,
    player:viewer ? publicPlayer(viewer) : null,
    entities:[...room.fish.values()].map(publicFish)
  };
}

function welcome(room, p) {
  return {
    type:'welcome', id:p.id, room:room.code, mode:room.mode,
    team:p.team, teamName:p.team === 'A' ? 'Azul' : p.team === 'B' ? 'Rojo' : null,
    worldSeed:room.seed, worldEpoch:room.epoch, worldStage:0, boss:null,
    players:[...room.players.values()].map(publicPlayer),
    player:publicPlayer(p)
  };
}

function broadcast(room) {
  for (const p of room.players.values()) send(p.ws, snapshot(room, p));
  for (const ws of room.spectators) send(ws, snapshot(room, null));
}

function applyClientState(p, m) {
  const x = Number(m.x), y = Number(m.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const dx = x - p.lastReportX, dy = y - p.lastReportY;
  const d = Math.hypot(dx, dy);
  p.lastReportX = x; p.lastReportY = y;
  if (d > 0.05) {
    const step = Math.min(d, MAX_STEP);
    p.targetX = clamp(p.x + dx / d * step, 0, WORLD_W);
    p.targetY = clamp(p.y + dy / d * step, 0, WORLD_H);
  }
  p.score = Number.isFinite(Number(m.score)) ? Math.max(0, Number(m.score)) : p.score;
  p.growthScore = Number.isFinite(Number(m.growthScore)) ? Math.max(0, Number(m.growthScore)) : p.growthScore;
  p.level = Number.isFinite(Number(m.level)) ? Math.max(1, Math.floor(Number(m.level))) : p.level;
  p.radius = Number.isFinite(Number(m.radius)) ? clamp(Number(m.radius), 8, 320) : p.radius;
  p.sprinting = !!m.sprinting;
  p.lastInputAt = Date.now();
}

function updateFish(room, dt) {
  const now = Date.now();
  const players = [...room.players.values()].filter(p => p.alive);

  for (const f of room.fish.values()) {
    let target = null;
    let nearest = Infinity;

    for (const p of players) {
      const dx = p.x - f.x, dy = p.y - f.y;
      const d = Math.hypot(dx, dy);
      const pp = playerPower(p.score);
      if (f.role === 'predator') {
        if (f.power <= pp || f.size <= p.radius) continue;
        if (d < 320 && d < nearest) { nearest = d; target = p; }
      } else {
        if (pp <= f.power || p.radius <= f.size) continue;
        if (d < 170 && d < nearest) { nearest = d; target = p; }
      }
    }

    if (target) {
      const a = Math.atan2(target.y - f.y, target.x - f.x);
      f.chase = now + 1000;
      f.vx += Math.cos(a) * f.speed * (f.role === 'predator' ? 0.12 : 0.14);
      f.vy += Math.sin(a) * f.speed * (f.role === 'predator' ? 0.12 : 0.14);
    } else if (f.turnTimer <= 0) {
      f.turnTimer = 0.8 + ((f.seed * 9973 + now) % 1000) / 1000 * 1.4;
      f.heading += (Math.sin(now * 0.0013 + f.seed * 17.1) * 0.55);
      f.vx += Math.cos(f.heading) * f.speed * 0.16;
      f.vy += Math.sin(f.heading) * f.speed * 0.16;
    }

    f.turnTimer -= dt;
    const sp = Math.hypot(f.vx, f.vy) || 0.0001;
    if (sp > f.speed) {
      f.vx = f.vx / sp * f.speed;
      f.vy = f.vy / sp * f.speed;
    }

    f.x = clamp(f.x + f.vx * dt * 60, 30, WORLD_W - 30);
    f.y = clamp(f.y + f.vy * dt * 60, 30, WORLD_H - 30);

    if (f.x <= 30 || f.x >= WORLD_W - 30) {
      f.vx *= -1; f.heading = Math.PI - f.heading;
    }
    if (f.y <= 30 || f.y >= WORLD_H - 30) {
      f.vy *= -1; f.heading = -f.heading;
    }

    f.angle = Math.atan2(f.vy, f.vx);
  }
}

function tickRoom(room, dt) {
  for (const p of room.players.values()) {
    const dx = p.targetX - p.x, dy = p.targetY - p.y;
    const d = Math.hypot(dx, dy);
    if (d > 0.01) {
      const step = Math.min(d, MAX_STEP * 1.35);
      p.vx = dx / d * step;
      p.vy = dy / d * step;
      p.x = clamp(p.x + p.vx, 0, WORLD_W);
      p.y = clamp(p.y + p.vy, 0, WORLD_H);
      p.angle = Math.atan2(p.vy, p.vx);
    } else {
      p.vx *= 0.75; p.vy *= 0.75;
    }
    if (Date.now() - p.lastInputAt > 350) {
      p.targetX = p.x; p.targetY = p.y;
    }
  }
  updateFish(room, dt);
}

function injectClientBridge(html) {
  const script = `<script>\n(()=>{\n  let socket=null, room=null, latest=null, patched=false;\n  const multiplayer=()=>{try{return window.eval('typeof Multiplayer!=="undefined"?Multiplayer:undefined')}catch(_){return null}};\n  const online=()=>{const m=multiplayer();return !!(m&&m.isConnected&&m.isConnected())};\n  const roomCode=()=>{const m=multiplayer();return m&&typeof m.room==='function'?m.room():null};\n\n  function patchLocalSimulation(){\n    if(patched) return;\n    try{\n      window.eval("updateSpawns=function(){}; updateEntity=function(){}; handleCollisions=function(){}; window.__SERVER_AUTHORITATIVE_FISH__=true;");\n      patched=true;\n    }catch(_){}\n  }\n\n  function connect(){\n    const code=roomCode();\n    if(!online()||!code||code===room) return;\n    room=code;\n    try{socket?.close()}catch(_){}\n    socket=new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host+'/ws');\n    socket.onopen=()=>socket.send(JSON.stringify({type:'spectator',room:code}));\n    socket.onmessage=e=>{try{const m=JSON.parse(e.data);if(m.type==='snapshot') latest=m;}catch(_){}};\n  }\n\n  function syncFish(){\n    if(!online()){room=null;latest=null;try{socket?.close()}catch(_){};socket=null;return;}\n    patchLocalSimulation();\n    if(!latest?.entities) return;\n    try{\n      const g=window.eval('typeof game!=="undefined"?game:null');\n      if(!g||!g.running) return;\n      const previous=new Map((g.entities||[]).map(e=>[e.serverId,e]));\n      g.entities=latest.entities.map(f=>{\n        const old=previous.get(f.id);\n        return {serverId:f.id,type:f.type,power:f.power,points:f.points,size:f.size,color:f.color,behavior:f.role==='predator'?'aggro':'flee',hazard:null,speed:f.speed||1,x:f.x,y:f.y,vx:f.vx,vy:f.vy,wobble:old?.wobble??0,life:old?.life??0};\n      });\n    }catch(_){}\n  }\n\n  function drawTeammates(){\n    if(!online()||!latest||!latest.you) return;\n    const mini=document.getElementById('minimap');\n    if(mini){\n      const c=mini.getContext('2d'),sx=mini.width/${WORLD_W},sy=mini.height/${WORLD_H};\n      for(const p of latest.players||[]){\n        if(!p.alive||p.id===latest.you.id) continue;\n        c.fillStyle='#ffffff'; c.beginPath(); c.arc(p.x*sx,p.y*sy,4,0,Math.PI*2); c.fill();\n      }\n    }\n    let layer=document.getElementById('nanyServerArrows');\n    if(!layer){layer=document.createElement('div');layer.id='nanyServerArrows';Object.assign(layer.style,{position:'fixed',inset:'0',zIndex:'9999',pointerEvents:'none'});document.body.appendChild(layer);}\n    layer.replaceChildren();\n    const me=latest.you,cx=innerWidth/2,cy=innerHeight/2,margin=44;\n    for(const p of latest.players||[]){\n      if(!p.alive||p.id===me.id) continue;\n      if(me.team&&p.team!==me.team) continue;\n      const dx=p.x-me.x,dy=p.y-me.y,d=Math.hypot(dx,dy)||1;\n      if(d<250) continue;\n      const hx=Math.max(100,cx-margin),hy=Math.max(100,cy-margin);\n      const t=Math.min(hx/Math.abs(dx||1),hy/Math.abs(dy||1));\n      const x=cx+dx*t,y=cy+dy*t;\n      const el=document.createElement('div');Object.assign(el.style,{position:'absolute',left:x+'px',top:y+'px',transform:'translate(-50%,-50%)',color:'#fff',textAlign:'center',font:'700 18px monospace',textShadow:'0 2px 5px #000'});\n      el.innerHTML='<div>▲</div><div style="font-size:9px">'+String(p.name||'Compañero').replace(/[&<>"']/g,'')+'</div>';layer.appendChild(el);\n    }\n  }\n\n  function loop(){connect();syncFish();drawTeammates();requestAnimationFrame(loop);}\n  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',()=>requestAnimationFrame(loop),{once:true}); else requestAnimationFrame(loop);\n})();\n</script>`;
  return html.replace('</body>', script + '</body>');
}

const server=createServer(async(req,res)=>{\n  try{\n    const u=new URL(req.url||'/', 'http://localhost');\n    if(u.pathname==='/health'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});return res.end(JSON.stringify({ok:true,rooms:rooms.size,players:[...rooms.values()].reduce((n,r)=>n+r.players.size,0),fishPerRoom:FISH_COUNT}));}\n    if(u.pathname==='/'||u.pathname==='/index.html'){let html=await readFile(join(ROOT,'index.html'),'utf8');html=injectClientBridge(html);res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});return res.end(html);}\n    res.writeHead(404);res.end('Not found');\n  }catch(e){res.writeHead(500);res.end('Server error');}\n});\n\nconst wss=new WebSocketServer({server,path:'/ws'});\nwss.on('connection',ws=>{\n  const id=Math.random().toString(36).slice(2)+Date.now().toString(36);\n  let player=null, room=null, spectatorRoom=null;\n\n  ws.on('message',raw=>{\n    let m; try{m=JSON.parse(raw.toString())}catch{return;}\n\n    if(m.type==='spectator'){\n      const code=normalizeRoom(m.room);\n      spectatorRoom=rooms.get(code)||null;\n      if(!spectatorRoom) return send(ws,{type:'snapshot',room:code,mode:'teams',population:0,players:[],you:null,entities:[]});\n      spectatorRoom.spectators.add(ws);\n      return send(ws,snapshot(spectatorRoom,null));\n    }\n\n    if(m.type==='join'){\n      const code=normalizeRoom(m.room);\n      room=rooms.get(code)||newRoom(code,normalizeMode(m.mode));\n      if(room.players.size>=MAX_PLAYERS) return send(ws,{type:'error',message:'Sala llena'});\n      const team=chooseTeam(room,m.team),pos=spawnFor(room);\n      player={id,ws,name:safeName(m.name),team,x:pos.x,y:pos.y,targetX:pos.x,targetY:pos.y,lastReportX:pos.x,lastReportY:pos.y,vx:0,vy:0,angle:0,score:0,growthScore:0,level:1,radius:11,power:1,alive:true,sprinting:false,lastInputAt:Date.now()};\n      room.players.set(id,player);send(ws,welcome(room,player));broadcast(room);return;\n    }\n\n    if(m.type==='state'&&player&&room){applyClientState(player,m);return;}\n    if(m.type==='leave') ws.close();\n  });\n\n  ws.on('close',()=>{\n    if(spectatorRoom) spectatorRoom.spectators.delete(ws);\n    if(!player||!room) return;\n    room.players.delete(player.id);\n    if(!room.players.size&&!room.spectators.size) rooms.delete(room.code);\n    else broadcast(room);\n  });\n});\n\nlet last=Date.now();\nsetInterval(()=>{const now=Date.now(),dt=Math.min(.05,(now-last)/1000);last=now;for(const r of rooms.values())tickRoom(r,dt);for(const r of rooms.values())broadcast(r);},TICK_MS);\n\nserver.listen(PORT,'0.0.0.0',()=>console.log('NANY FISH-AUTHORITATIVE '+PORT+' fish='+FISH_COUNT));\n