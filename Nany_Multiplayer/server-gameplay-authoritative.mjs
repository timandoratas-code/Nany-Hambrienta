import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT || 10000);
const WORLD_W = 12000;
const WORLD_H = 12000;
const TICK_HZ = 30;
const SNAPSHOT_HZ = 20;
const TICK_MS = 1000 / TICK_HZ;
const SNAPSHOT_MS = 1000 / SNAPSHOT_HZ;
const MAX_PLAYERS = 8;
const MAX_STEP = 11;
const FISH_COUNT = 260;
const CHASE_MS = 1000;
const CHASE_COOLDOWN_MS = 5000;
const HIT_COOLDOWN_MS = 900;

const rooms = new Map();

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const send = (ws, msg) => {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
};
const normalizeRoom = v => String(v || 'ABISMO01').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 16) || 'ABISMO01';
const normalizeMode = v => ['teams', 'ffa', 'coop'].includes(v) ? v : 'teams';
const safeName = v => String(v || 'Nany').trim().slice(0, 18) || 'Nany';

function seeded(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17; s >>>= 0;
    s ^= s << 5; s >>>= 0;
    return (s >>> 0) / 4294967296;
  };
}

const FISH_TYPES = [
  { key: 'plankton', role: 'prey', power: 1, points: 5, color: '#8fffb0', size: 3, speed: .30 },
  { key: 'minnow', role: 'prey', power: 2, points: 10, color: '#bfe6ff', size: 7, speed: .90 },
  { key: 'green', role: 'prey', power: 3, points: 20, color: '#39ff6a', size: 9, speed: 1.60 },
  { key: 'piranha', role: 'predator', power: 4, points: 35, color: '#ff8a3d', size: 12, speed: 1.70 },
  { key: 'stick', role: 'predator', power: 5, points: 50, color: '#e0c66a', size: 15, speed: .70 },
  { key: 'rival', role: 'predator', power: 6, points: 75, color: '#a084ff', size: 19, speed: 1.10 },
  { key: 'shark', role: 'predator', power: 8, points: 150, color: '#6d8796', size: 28, speed: 1.40 },
  { key: 'monster', role: 'predator', power: 10, points: 300, color: '#8d2638', size: 40, speed: 1.10 }
];

function typeForIndex(i) {
  if (i < 120) return FISH_TYPES[0];
  if (i < 170) return FISH_TYPES[1];
  if (i < 200) return FISH_TYPES[2];
  if (i < 225) return FISH_TYPES[3];
  if (i < 245) return FISH_TYPES[4];
  if (i < 258) return FISH_TYPES[5];
  if (i === 258) return FISH_TYPES[6];
  return FISH_TYPES[7];
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

function buildFish(room) {
  const r = seeded(room.seed);
  room.fish = new Map();
  for (let i = 0; i < FISH_COUNT; i++) {
    const t = typeForIndex(i);
    const angle = r() * Math.PI * 2;
    const speed = t.speed * (.82 + r() * .30);
    room.fish.set(`fish-${i}`, {
      id: `fish-${i}`,
      type: t.key,
      role: t.role,
      power: t.power,
      points: t.points,
      color: t.color,
      size: t.size * (.88 + r() * .24),
      speed,
      x: 100 + r() * (WORLD_W - 200),
      y: 100 + r() * (WORLD_H - 200),
      vx: Math.cos(angle) * speed * .55,
      vy: Math.sin(angle) * speed * .55,
      angle,
      heading: angle,
      turnTimer: .8 + r() * 1.7,
      phase: r() * Math.PI * 2,
      chaseUntil: 0,
      cooldownUntil: 0,
      hitUntil: 0
    });
  }
}

function createRoom(code, mode) {
  const room = {
    code,
    mode,
    seed: (Math.floor(Math.random() * 0xffffffff) >>> 0) || 1,
    epoch: Date.now(),
    players: new Map(),
    watchers: new Set(),
    fish: new Map(),
    anchor: { x: WORLD_W / 2, y: WORLD_H / 2 }
  };
  buildFish(room);
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
  if (!players.length) return { ...room.anchor };
  const ref = players[0];
  const a = Math.random() * Math.PI * 2;
  const radius = 90 + Math.random() * 100;
  return {
    x: clamp(ref.x + Math.cos(a) * radius, 100, WORLD_W - 100),
    y: clamp(ref.y + Math.sin(a) * radius, 100, WORLD_H - 100)
  };
}

function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    x: +p.x.toFixed(2),
    y: +p.y.toFixed(2),
    vx: +p.vx.toFixed(2),
    vy: +p.vy.toFixed(2),
    angle: +p.angle.toFixed(3),
    score: Math.floor(p.score),
    growthScore: Math.floor(p.growthScore),
    level: p.level,
    radius: +p.radius.toFixed(2),
    power: playerPower(p.score),
    alive: p.alive,
    lives: p.lives,
    sprinting: p.sprinting,
    team: p.team,
    teamName: p.team === 'A' ? 'Azul' : p.team === 'B' ? 'Rojo' : null,
    invulnerableUntil: p.invulnerableUntil
  };
}

function publicFish(f) {
  return {
    id: f.id,
    type: f.type,
    role: f.role,
    power: f.power,
    points: f.points,
    size: +f.size.toFixed(2),
    color: f.color,
    x: +f.x.toFixed(2),
    y: +f.y.toFixed(2),
    vx: +f.vx.toFixed(3),
    vy: +f.vy.toFixed(3),
    angle: +f.angle.toFixed(3)
  };
}

function snapshot(room, viewer = null) {
  return {
    type: 'snapshot',
    room: room.code,
    mode: room.mode,
    population: room.players.size,
    worldSeed: room.seed,
    worldEpoch: room.epoch,
    worldStage: 0,
    players: [...room.players.values()].map(publicPlayer),
    you: viewer ? publicPlayer(viewer) : null,
    player: viewer ? publicPlayer(viewer) : null,
    entities: [...room.fish.values()].map(publicFish)
  };
}

function welcome(room, p) {
  return {
    type: 'welcome',
    id: p.id,
    room: room.code,
    mode: room.mode,
    team: p.team,
    teamName: p.team === 'A' ? 'Azul' : p.team === 'B' ? 'Rojo' : null,
    worldSeed: room.seed,
    worldEpoch: room.epoch,
    worldStage: 0,
    boss: null,
    players: [...room.players.values()].map(publicPlayer),
    player: publicPlayer(p)
  };
}

function broadcast(room) {
  for (const p of room.players.values()) send(p.ws, snapshot(room, p));
  for (const ws of room.watchers) send(ws, snapshot(room, null));
}

function applyState(p, m) {
  const x = Number(m.x);
  const y = Number(m.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const dx = x - p.lastX;
  const dy = y - p.lastY;
  const distance = Math.hypot(dx, dy);
  p.lastX = x;
  p.lastY = y;
  if (distance > .05) {
    const step = Math.min(distance, MAX_STEP);
    p.targetX = clamp(p.x + dx / distance * step, 0, WORLD_W);
    p.targetY = clamp(p.y + dy / distance * step, 0, WORLD_H);
  }
  p.radius = Number.isFinite(Number(m.radius)) ? clamp(Number(m.radius), 8, 320) : p.radius;
  p.sprinting = !!m.sprinting;
  p.lastInputAt = Date.now();
}

function movePlayers(room) {
  for (const p of room.players.values()) {
    if (!p.alive) continue;
    const dx = p.targetX - p.x;
    const dy = p.targetY - p.y;
    const distance = Math.hypot(dx, dy);
    if (distance > .01) {
      const step = Math.min(distance, MAX_STEP * 1.35);
      p.vx = dx / distance * step;
      p.vy = dy / distance * step;
      p.x = clamp(p.x + p.vx, 0, WORLD_W);
      p.y = clamp(p.y + p.vy, 0, WORLD_H);
      p.angle = Math.atan2(p.vy, p.vx);
    } else {
      p.vx *= .75;
      p.vy *= .75;
    }
    if (Date.now() - p.lastInputAt > 350) {
      p.targetX = p.x;
      p.targetY = p.y;
    }
  }
}

function canFishSeePlayer(f, p, now) {
  if (!p.alive || p.invulnerableUntil > now) return false;
  const pp = playerPower(p.score);
  if (f.role === 'predator') {
    if (f.power <= pp || f.size <= p.radius) return false;
    return Math.hypot(p.x - f.x, p.y - f.y) <= 320;
  }
  if (pp <= f.power || p.radius <= f.size) return false;
  return Math.hypot(p.x - f.x, p.y - f.y) <= 170;
}

function updateFish(room, dt) {
  const now = Date.now();
  const players = [...room.players.values()].filter(p => p.alive);

  for (const f of room.fish.values()) {
    let target = null;
    let nearest = Infinity;

    if (f.chaseUntil <= now && f.cooldownUntil <= now) {
      for (const p of players) {
        if (!canFishSeePlayer(f, p, now)) continue;
        const d = Math.hypot(p.x - f.x, p.y - f.y);
        if (d < nearest) {
          nearest = d;
          target = p;
        }
      }
      if (target) f.chaseUntil = now + CHASE_MS;
    }

    const activeChase = f.chaseUntil > now;
    if (activeChase && target) {
      const a = Math.atan2(target.y - f.y, target.x - f.x);
      const strength = f.role === 'predator' ? .20 : .18;
      f.vx += Math.cos(a) * f.speed * strength;
      f.vy += Math.sin(a) * f.speed * strength;
    } else {
      if (f.turnTimer <= 0) {
        f.turnTimer = .8 + ((Math.sin(f.phase + now * .0013) + 1) * .5) * 1.4;
        f.heading += Math.sin(f.phase + now * .0009) * .55;
        f.vx += Math.cos(f.heading) * f.speed * .16;
        f.vy += Math.sin(f.heading) * f.speed * .16;
      }
      f.turnTimer -= dt;
    }

    if (f.chaseUntil <= now && f.cooldownUntil <= now) {
      f.chaseUntil = 0;
    }

    const sp = Math.hypot(f.vx, f.vy) || .0001;
    if (sp > f.speed) {
      f.vx = f.vx / sp * f.speed;
      f.vy = f.vy / sp * f.speed;
    }
    f.x = clamp(f.x + f.vx * dt * 60, 30, WORLD_W - 30);
    f.y = clamp(f.y + f.vy * dt * 60, 30, WORLD_H - 30);

    if (f.x <= 30 || f.x >= WORLD_W - 30) {
      f.vx *= -1;
      f.heading = Math.PI - f.heading;
    }
    if (f.y <= 30 || f.y >= WORLD_H - 30) {
      f.vy *= -1;
      f.heading = -f.heading;
    }
    f.angle = Math.atan2(f.vy, f.vx);
  }
}

function resolveFishCollisions(room) {
  const now = Date.now();
  for (const p of room.players.values()) {
    if (!p.alive || p.invulnerableUntil > now) continue;
    const pp = playerPower(p.score);
    for (const f of room.fish.values()) {
      if (f.hitUntil > now) continue;
      const collisionRadius = p.radius * .86 + f.size * .86;
      const distance = Math.hypot(p.x - f.x, p.y - f.y);
      if (distance > collisionRadius) continue;

      if (f.power < pp && f.size < p.radius * .98) {
        p.score += f.points;
        p.growthScore = p.score;
        f.hitUntil = now + HIT_COOLDOWN_MS;
        // Reposition the eaten fish instead of removing it so the population remains stable
        f.x = 80 + ((f.x + 997) % (WORLD_W - 160));
        f.y = 80 + ((f.y + 1499) % (WORLD_H - 160));
        f.vx *= .4;
        f.vy *= .4;
        f.chaseUntil = 0;
        f.cooldownUntil = now + 500;
        send(p.ws, { type: 'fish_eaten', playerId: p.id, fishId: f.id, points: f.points, score: p.score });
        continue;
      }

      if (f.power > pp && f.size > p.radius * 1.02) {
        p.lives = Math.max(0, p.lives - 1);
        p.invulnerableUntil = now + 2500;
        p.score = Math.max(0, Math.floor(p.score * .5));
        p.growthScore = p.score;
        f.hitUntil = now + HIT_COOLDOWN_MS;
        p.x = clamp(room.anchor.x + (Math.random() - .5) * 220, 100, WORLD_W - 100);
        p.y = clamp(room.anchor.y + (Math.random() - .5) * 220, 100, WORLD_H - 100);
        f.chaseUntil = 0;
        f.cooldownUntil = now + CHASE_COOLDOWN_MS;
        send(p.ws, { type: 'fish_hit', playerId: p.id, fishId: f.id, lives: p.lives, score: p.score });
        if (p.lives <= 0) {
          p.alive = false;
          send(p.ws, { type: 'player_dead', playerId: p.id });
        }
      }
    }
  }
}

function tickRoom(room, dt) {
  movePlayers(room);
  updateFish(room, dt);
  resolveFishCollisions(room);
}

function injectBridge(html) {
  const bridge = `<script>\n(()=>{\nlet s=null,room=null,latest=null;\nconst M=()=>{try{return window.eval('typeof Multiplayer!=="undefined"?Multiplayer:undefined')}catch(_){return null}};\nconst online=()=>{const m=M();return !!(m&&m.isConnected&&m.isConnected())};\nconst rc=()=>{const m=M();return m&&typeof m.room==='function'?m.room():null};\nfunction patch(){try{window.eval("updateSpawns=function(){};updateEntity=function(){};handleCollisions=function(){};window.__SERVER_AUTHORITATIVE_FISH__=true;")}catch(_){}}\nfunction conn(){const code=rc();if(!online()){room=null;latest=null;try{s?.close()}catch(_){}s=null;return}patch();if(!code||code===room)return;room=code;try{s?.close()}catch(_){}s=new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host+'/ws');s.onopen=()=>s.send(JSON.stringify({type:'spectator',room:code}));s.onmessage=e=>{try{const m=JSON.parse(e.data);if(m.type==='snapshot')latest=m}catch(_){}}}\nfunction sync(){if(!online()||!latest)return;try{const g=window.eval('typeof game!=="undefined"?game:null');if(!g||!g.running)return;if(latest.you){g.score=Number(latest.you.score)||0;g.lives=Number.isFinite(latest.you.lives)?latest.you.lives:g.lives;g.player.x=latest.you.x;g.player.y=latest.you.y;g.player.vx=latest.you.vx;g.player.vy=latest.you.vy;g.player.angle=latest.you.angle;}if(Array.isArray(latest.entities)){g.entities=latest.entities.map(f=>({serverId:f.id,type:f.type,power:f.power,points:f.points,size:f.size,color:f.color,behavior:f.role==='predator'?'aggro':'flee',hazard:null,speed:Math.max(.1,Math.hypot(f.vx,f.vy)),x:f.x,y:f.y,vx:f.vx,vy:f.vy,wobble:f.angle||0,life:0}));}}catch(_){}\n}\nfunction nav(){if(!online()||!latest)return;const mini=document.getElementById('minimap');if(mini&&latest.you){const c=mini.getContext('2d'),sx=mini.width/${WORLD_W},sy=mini.height/${WORLD_H};for(const p of latest.players||[]){if(!p.alive||p.id===latest.you.id)continue;c.fillStyle='#fff';c.beginPath();c.arc(p.x*sx,p.y*sy,4,0,Math.PI*2);c.fill();}}}\nfunction loop(){conn();sync();nav();requestAnimationFrame(loop)}\nrequestAnimationFrame(loop)})();\n</script>`;
  return html.replace('</body>', bridge + '</body>');
}

const server = createServer(async (req, res) => {
  try {
    const u = new URL(req.url || '/', 'http://localhost');
    if (u.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok: true, rooms: rooms.size, players: [...rooms.values()].reduce((n, r) => n + r.players.size, 0), fishPerRoom: FISH_COUNT }));
    }
    if (u.pathname === '/' || u.pathname === '/index.html') {
      const html = injectBridge(await readFile(join(ROOT, 'index.html'), 'utf8'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    res.writeHead(404);
    res.end('Not found');
  } catch (err) {
    res.writeHead(500);
    res.end('Server error');
  }
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', ws => {
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  let player = null;
  let room = null;
  let watching = false;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'spectator') {
      const code = normalizeRoom(msg.room);
      const r = rooms.get(code);
      if (!r) return send(ws, { type: 'snapshot', room: code, mode: 'teams', population: 0, players: [], you: null, entities: [] });
      watching = true;
      room = r;
      r.watchers.add(ws);
      return send(ws, snapshot(r, null));
    }

    if (msg.type === 'join') {
      const code = normalizeRoom(msg.room);
      room = rooms.get(code) || createRoom(code, normalizeMode(msg.mode));
      if (room.players.size >= MAX_PLAYERS) return send(ws, { type: 'error', message: 'Sala llena' });
      const team = chooseTeam(room, msg.team);
      const pos = spawnFor(room);
      player = {
        id, ws, name: safeName(msg.name), room: code, team,
        x: pos.x, y: pos.y, targetX: pos.x, targetY: pos.y,
        lastX: pos.x, lastY: pos.y,
        vx: 0, vy: 0, angle: 0,
        score: 0, growthScore: 0, level: 1,
        radius: 11, lives: 1, alive: true, sprinting: false,
        lastInputAt: Date.now(), invulnerableUntil: Date.now() + 1200
      };
      room.players.set(id, player);
      send(ws, welcome(room, player));
      broadcast(room);
      return;
    }

    if (msg.type === 'state' && player && room) {
      applyState(player, msg);
      return;
    }

    if (msg.type === 'leave') ws.close();
  });

  ws.on('close', () => {
    if (watching && room) room.watchers.delete(ws);
    if (!player || !room) return;
    room.players.delete(player.id);
    if (!room.players.size && !room.watchers.size) rooms.delete(room.code);
    else broadcast(room);
  });
});

let last = Date.now();
let lastSnapshot = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(.05, (now - last) / 1000);
  last = now;
  for (const room of rooms.values()) tickRoom(room, dt);
  if (now - lastSnapshot >= SNAPSHOT_MS) {
    lastSnapshot = now;
    for (const room of rooms.values()) broadcast(room);
  }
}, TICK_MS);

server.listen(PORT, '0.0.0.0', () => console.log(`NANY GAMEPLAY AUTHORITATIVE ${PORT}`));
