import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const PORT = Number(process.env.PORT || 10000);
const W = 12000, H = 12000;
const TICK_HZ = 30;
const SNAP_HZ = 20;
const MAX_PLAYERS = 32;
const FISH_N = 260;
const FISH_RESPAWN_MS = 1800;
const CHASE_MS = 1000;
const COOLDOWN_MS = 5000;
const HIT_CD = 900;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const send = (ws, msg) => {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
};
const safeName = v => String(v || 'Nany').trim().slice(0, 18) || 'Nany';
const rng = seed => {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17; s >>>= 0;
    s ^= s << 5; s >>>= 0;
    return (s >>> 0) / 4294967296;
  };
};

const TYPES = [
  { key:'plankton', role:'prey', power:1, points:5, color:'#8fffb0', size:3, speed:.30 },
  { key:'minnow', role:'prey', power:2, points:10, color:'#bfe6ff', size:7, speed:.90 },
  { key:'green', role:'prey', power:3, points:20, color:'#39ff6a', size:9, speed:1.60 },
  { key:'piranha', role:'predator', power:4, points:35, color:'#ff8a3d', size:12, speed:1.70 },
  { key:'stick', role:'predator', power:5, points:50, color:'#e0c66a', size:15, speed:.70 },
  { key:'rival', role:'predator', power:6, points:75, color:'#a084ff', size:19, speed:1.10 },
  { key:'shark', role:'predator', power:8, points:150, color:'#6d8796', size:28, speed:1.40 },
  { key:'monster', role:'predator', power:10, points:300, color:'#8d2638', size:40, speed:1.10 }
];
const typeForIndex = i => i < 120 ? TYPES[0]
  : i < 170 ? TYPES[1]
  : i < 200 ? TYPES[2]
  : i < 225 ? TYPES[3]
  : i < 245 ? TYPES[4]
  : i < 258 ? TYPES[5]
  : i === 258 ? TYPES[6]
  : TYPES[7];

const playerPower = score => score < 100 ? 1
  : score < 250 ? 2
  : score < 500 ? 3
  : score < 900 ? 4
  : score < 1500 ? 5
  : score < 2500 ? 6
  : score < 4000 ? 7
  : score < 6000 ? 8
  : score < 9000 ? 9
  : 10;

function modeToWorld(v) {
  if (v === 'ffa' || v === 'pvp') return { code:'PVP', mode:'ffa' };
  if (v === 'coop' || v === 'pve') return { code:'PVE', mode:'coop' };
  return { code:'EQUIPO', mode:'teams' };
}

function spawnFish(world, index, seedRand = Math.random) {
  const t = typeForIndex(index);
  const a = seedRand() * Math.PI * 2;
  const speed = t.speed * (.82 + seedRand() * .30);
  world.fish.set(`fish-${index}-${world.nextFishSerial++}`, {
    id: `fish-${index}-${world.nextFishSerial}`,
    type:t.key,
    role:t.role,
    power:t.power,
    points:t.points,
    color:t.color,
    size:t.size * (.88 + seedRand() * .24),
    speed,
    x:100 + seedRand() * (W - 200),
    y:100 + seedRand() * (H - 200),
    vx:Math.cos(a) * speed * .55,
    vy:Math.sin(a) * speed * .55,
    angle:a,
    heading:a,
    turn:.8 + seedRand() * 1.7,
    phase:seedRand() * Math.PI * 2,
    chaseId:null,
    chaseUntil:0,
    cooldownUntil:0,
    hitUntil:0,
    respawnAt:0
  });
}

function buildFish(world) {
  const r = rng(world.seed);
  world.fish = new Map();
  world.nextFishSerial = 0;
  for (let i = 0; i < FISH_N; i++) spawnFish(world, i, r);
}

function makeWorld(code, mode) {
  const world = {
    code,
    mode,
    seed:(Math.floor(Math.random() * 0xffffffff) >>> 0) || 1,
    epoch:Date.now(),
    tick:0,
    players:new Map(),
    fish:new Map(),
    anchor:{x:W/2,y:H/2},
    nextFishSerial:0
  };
  buildFish(world);
  return world;
}

const worlds = new Map([
  ['PVP', makeWorld('PVP', 'ffa')],
  ['PVE', makeWorld('PVE', 'coop')],
  ['EQUIPO', makeWorld('EQUIPO', 'teams')]
]);

function chooseTeam(world, wanted) {
  if (world.mode !== 'teams') return null;
  const a = [...world.players.values()].filter(p => p.team === 'A').length;
  const b = [...world.players.values()].filter(p => p.team === 'B').length;
  if ((wanted === 'A' || wanted === 'B') && Math.abs(a - b) <= 1) return wanted;
  return a <= b ? 'A' : 'B';
}

function spawnPlayer(world) {
  const ps = [...world.players.values()];
  if (!ps.length) return {...world.anchor};
  const ref = ps[0];
  const a = Math.random() * Math.PI * 2;
  const d = 90 + Math.random() * 100;
  return {
    x:clamp(ref.x + Math.cos(a) * d, 100, W - 100),
    y:clamp(ref.y + Math.sin(a) * d, 100, H - 100)
  };
}

function pubPlayer(p) {
  return {
    id:p.id,
    name:p.name,
    x:+p.x.toFixed(2),
    y:+p.y.toFixed(2),
    vx:+p.vx.toFixed(2),
    vy:+p.vy.toFixed(2),
    angle:+p.angle.toFixed(3),
    score:Math.floor(p.score),
    growthScore:Math.floor(p.score),
    radius:+p.radius.toFixed(2),
    power:playerPower(p.score),
    level:p.level,
    lives:p.lives,
    alive:p.alive,
    sprinting:p.sprinting,
    team:p.team,
    teamName:p.team === 'A' ? 'Azul' : p.team === 'B' ? 'Rojo' : null,
    invulnerableUntil:p.invulnerableUntil
  };
}

function pubFish(f) {
  return {
    id:f.id,
    type:f.type,
    role:f.role,
    power:f.power,
    points:f.points,
    size:+f.size.toFixed(2),
    color:f.color,
    x:+f.x.toFixed(2),
    y:+f.y.toFixed(2),
    vx:+f.vx.toFixed(4),
    vy:+f.vy.toFixed(4),
    angle:+f.angle.toFixed(4)
  };
}

function snapshot(world) {
  return {
    type:'snapshot',
    room:world.code,
    mode:world.mode,
    population:world.players.size,
    worldSeed:world.seed,
    worldEpoch:world.epoch,
    serverTick:world.tick,
    serverTime:Date.now(),
    players:[...world.players.values()].map(pubPlayer),
    entities:[...world.fish.values()].map(pubFish)
  };
}

function welcome(world, p) {
  return {
    ...snapshot(world),
    type:'welcome',
    id:p.id,
    you:pubPlayer(p),
    player:pubPlayer(p),
    team:p.team,
    teamName:p.team === 'A' ? 'Azul' : p.team === 'B' ? 'Rojo' : null,
    boss:null
  };
}

function broadcast(world) {
  const base = snapshot(world);
  for (const p of world.players.values()) {
    send(p.ws, {...base, you:pubPlayer(p), player:pubPlayer(p)});
  }
}

function applyInput(p, m) {
  const x = Number(m.x), y = Number(m.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const dx = x - p.lastX, dy = y - p.lastY, d = Math.hypot(dx, dy);
  p.lastX = x; p.lastY = y;
  if (d > .05) {
    const step = Math.min(d, 11);
    p.tx = clamp(p.x + dx / d * step, 0, W);
    p.ty = clamp(p.y + dy / d * step, 0, H);
  }
  if (Number.isFinite(Number(m.radius))) p.radius = clamp(Number(m.radius), 8, 320);
  p.sprinting = !!m.sprinting;
  p.lastInputAt = Date.now();
}

function movePlayers(world) {
  for (const p of world.players.values()) {
    if (!p.alive) continue;
    const dx = p.tx - p.x, dy = p.ty - p.y, d = Math.hypot(dx, dy);
    if (d > .01) {
      const step = Math.min(d, 14);
      p.vx = dx / d * step;
      p.vy = dy / d * step;
      p.x = clamp(p.x + p.vx, 0, W);
      p.y = clamp(p.y + p.vy, 0, H);
      p.angle = Math.atan2(p.vy, p.vx);
    } else {
      p.vx *= .75;
      p.vy *= .75;
    }
    if (Date.now() - p.lastInputAt > 350) {
      p.tx = p.x;
      p.ty = p.y;
    }
  }
}

function respawnFish(world, f) {
  const id = f.id;
  world.fish.delete(id);
  const index = Number((id.match(/fish-(\d+)-/) || [0,0])[1]);
  const a = Math.random() * Math.PI * 2;
  const t = typeForIndex(index);
  const speed = t.speed * (.82 + Math.random() * .30);
  const serial = world.nextFishSerial++;
  world.fish.set(`fish-${index}-${serial}`, {
    id:`fish-${index}-${serial}`,
    type:t.key,
    role:t.role,
    power:t.power,
    points:t.points,
    color:t.color,
    size:t.size * (.88 + Math.random() * .24),
    speed,
    x:100 + Math.random() * (W - 200),
    y:100 + Math.random() * (H - 200),
    vx:Math.cos(a) * speed * .55,
    vy:Math.sin(a) * speed * .55,
    angle:a,
    heading:a,
    turn:.8 + Math.random() * 1.7,
    phase:Math.random() * Math.PI * 2,
    chaseId:null,
    chaseUntil:0,
    cooldownUntil:Date.now() + 400,
    hitUntil:0,
    respawnAt:0
  });
}

function updateFish(world, dt) {
  const now = Date.now();
  const players = [...world.players.values()].filter(p => p.alive);
  for (const f of [...world.fish.values()]) {
    if (f.respawnAt) {
      if (f.respawnAt <= now) respawnFish(world, f);
      continue;
    }
    let target = f.chaseId && f.chaseUntil > now ? world.players.get(f.chaseId) : null;
    if (!target && f.cooldownUntil <= now) {
      let best = null, bestDist = Infinity;
      for (const p of players) {
        const d = Math.hypot(p.x - f.x, p.y - f.y);
        const pp = playerPower(p.score);
        const can = f.role === 'predator'
          ? f.power > pp && f.size > p.radius * 1.02 && d <= 320 && p.invulnerableUntil <= now
          : pp > f.power && p.radius > f.size * .98 && d <= 170;
        if (can && d < bestDist) { best = p; bestDist = d; }
      }
      if (best) { target = best; f.chaseId = best.id; f.chaseUntil = now + CHASE_MS; }
    }
    if (f.chaseId && f.chaseUntil <= now) {
      f.chaseId = null;
      f.cooldownUntil = now + COOLDOWN_MS;
      target = null;
    }
    if (target && f.chaseUntil > now) {
      const a = Math.atan2(target.y - f.y, target.x - f.x);
      const k = f.role === 'predator' ? .24 : .18;
      f.vx += Math.cos(a) * f.speed * k;
      f.vy += Math.sin(a) * f.speed * k;
    } else {
      if (f.turn <= 0) {
        f.turn = .8 + ((Math.sin(f.phase + now * .0013) + 1) * .5) * 1.4;
        f.heading += Math.sin(f.phase + now * .0009) * .55;
        f.vx += Math.cos(f.heading) * f.speed * .16;
        f.vy += Math.sin(f.heading) * f.speed * .16;
      }
      f.turn -= dt;
    }
    const sp = Math.hypot(f.vx, f.vy) || .0001;
    if (sp > f.speed) { f.vx = f.vx / sp * f.speed; f.vy = f.vy / sp * f.speed; }
    f.x = clamp(f.x + f.vx * dt * 60, 30, W - 30);
    f.y = clamp(f.y + f.vy * dt * 60, 30, H - 30);
    if (f.x <= 30 || f.x >= W - 30) { f.vx *= -1; f.heading = Math.PI - f.heading; }
    if (f.y <= 30 || f.y >= H - 30) { f.vy *= -1; f.heading = -f.heading; }
    f.angle = Math.atan2(f.vy, f.vx);
  }
}

function combat(world) {
  const now = Date.now();
  for (const p of world.players.values()) {
    if (!p.alive || p.invulnerableUntil > now) continue;
    const pp = playerPower(p.score);
    for (const f of [...world.fish.values()]) {
      if (f.hitUntil > now || f.respawnAt) continue;
      const d = Math.hypot(p.x - f.x, p.y - f.y);
      if (d > p.radius * .86 + f.size * .86) continue;
      if (f.power < pp && f.size < p.radius * .98) {
        p.score += f.points;
        f.hitUntil = now + HIT_CD;
        f.chaseId = null;
        f.chaseUntil = 0;
        f.cooldownUntil = now + 3000;
        f.respawnAt = now + FISH_RESPAWN_MS;
      } else if (f.power > pp && f.size > p.radius * 1.02) {
        p.lives = Math.max(0, p.lives - 1);
        p.score = Math.max(0, Math.floor(p.score * .5));
        p.invulnerableUntil = now + 2500;
        f.chaseId = null;
        f.cooldownUntil = now + COOLDOWN_MS;
        p.x = clamp(world.anchor.x + (Math.random() - .5) * 220, 100, W - 100);
        p.y = clamp(world.anchor.y + (Math.random() - .5) * 220, 100, H - 100);
        if (p.lives <= 0) p.alive = false;
      }
    }
  }
}

function inject(html) {
  const bridge = `<script>(()=>{
const NativeWebSocket=window.WebSocket;
const BUFFER='__NANY_SERVER_BUFFER__';
const CLOCK='__NANY_SERVER_CLOCK__';
function WrappedWebSocket(url,protocols){
 const ws=protocols===undefined?new NativeWebSocket(url):new NativeWebSocket(url,protocols);
 ws.addEventListener('message',ev=>{try{const m=JSON.parse(ev.data);if(!m||(m.type!=='welcome'&&m.type!=='snapshot'))return;const b=window[BUFFER]||(window[BUFFER]=[]);b.push({t:Number(m.serverTime)||Date.now(),tick:Number(m.serverTick)||0,m});while(b.length>30)b.shift();const recv=Date.now();const offset=recv-(Number(m.serverTime)||recv);const c=window[CLOCK]||(window[CLOCK]={offset});c.offset=c.offset*.95+offset*.05;}catch(_){}});
 return ws;
}
WrappedWebSocket.prototype=NativeWebSocket.prototype;
for(const k of ['CONNECTING','OPEN','CLOSING','CLOSED'])WrappedWebSocket[k]=NativeWebSocket[k];
window.WebSocket=WrappedWebSocket;
window.__SERVER_AUTHORITATIVE_FISH__=true;
window.__SERVER_SYNC_FISH__=function(){try{
 const g=window.eval('typeof game!=="undefined"?game:null');const b=window[BUFFER]||[];if(!g||!g.running||b.length<1)return;
 const c=window[CLOCK]||{offset:0};const target=Date.now()-c.offset-100;
 let a=b[0],z=b[b.length-1];for(let i=0;i<b.length;i++){if(b[i].t<=target)a=b[i];if(b[i].t>=target){z=b[i];break;}}
 const alpha=(z!==a&&z.t>a.t)?Math.max(0,Math.min(1,(target-a.t)/(z.t-a.t))):1;const A=a.m,Z=z.m;
 const ma=new Map((A.entities||[]).map(f=>[f.id,f])),mz=new Map((Z.entities||[]).map(f=>[f.id,f]));const ids=new Set([...ma.keys(),...mz.keys()]);
 const out=[];for(const id of ids){const f0=ma.get(id)||mz.get(id),f1=mz.get(id)||f0;out.push({serverId:id,type:f1.type,power:f1.power,points:f1.points,size:f1.size,color:f1.color,behavior:f1.role==='predator'?'aggro':'flee',hazard:null,speed:Math.max(.1,Math.hypot(f1.vx,f1.vy)),x:f0.x+(f1.x-f0.x)*alpha,y:f0.y+(f1.y-f0.y)*alpha,vx:f1.vx,vy:f1.vy,wobble:f1.angle||0,life:0});}
 g.entities=out;const me=A.you||A.player;if(me){g.score=me.score;g.lives=me.lives;g.player.x=me.x;g.player.y=me.y;g.player.vx=me.vx;g.player.vy=me.vy;g.player.angle=me.angle;}
}catch(_){}};
})();</script>`;
  return html.replace('</head>', bridge + '</head>');
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url || '/', 'http://localhost');
    if (u.pathname === '/health') {
      const players = {};
      for (const [k, w] of worlds) players[k] = w.players.size;
      res.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-store'});
      return res.end(JSON.stringify({ok:true, worlds:['PVP','PVE','EQUIPO'], players, fishPerWorld:FISH_N, tickHz:TICK_HZ, snapHz:SNAP_HZ}));
    }
    if (u.pathname === '/' || u.pathname === '/index.html') {
      const html = inject(await fs.readFile(path.join(ROOT, 'index.html'), 'utf8'));
      res.writeHead(200, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
      return res.end(html);
    }
    res.writeHead(404); res.end('Not found');
  } catch {
    res.writeHead(500); res.end('Server error');
  }
});

const wss = new WebSocketServer({server, path:'/ws'});
wss.on('connection', ws => {
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  let p = null, world = null;
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === 'join') {
      const selected = modeToWorld(m.mode);
      world = worlds.get(selected.code);
      if (world.players.size >= MAX_PLAYERS) return send(ws, {type:'error', message:'Servidor lleno'});
      const team = chooseTeam(world, m.team);
      const pos = spawnPlayer(world);
      p = {id, ws, name:safeName(m.name), team, x:pos.x,y:pos.y,tx:pos.x,ty:pos.y,lastX:pos.x,lastY:pos.y,vx:0,vy:0,angle:0,score:0,radius:11,level:1,lives:1,alive:true,sprinting:false,lastInputAt:Date.now(),invulnerableUntil:Date.now()+1200};
      world.players.set(id, p);
      send(ws, welcome(world, p));
      broadcast(world);
      return;
    }
    if (m.type === 'state' && p && world) { applyInput(p, m); return; }
    if (m.type === 'leave') ws.close();
  });
  ws.on('close', () => {
    if (!p || !world) return;
    world.players.delete(p.id);
    broadcast(world);
  });
});

let last = Date.now();
let nextSnap = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  for (const world of worlds.values()) {
    world.tick++;
    movePlayers(world);
    updateFish(world, dt);
    combat(world);
  }
  if (now >= nextSnap) {
    nextSnap = now + 1000 / SNAP_HZ;
    for (const world of worlds.values()) broadcast(world);
  }
}, 1000 / TICK_HZ);

server.listen(PORT, '0.0.0.0', () => console.log(`NANY LIVE WORLDS listening on ${PORT}`));
