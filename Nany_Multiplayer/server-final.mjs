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
const SNAPSHOT_MS = 50;
const MAX_PLAYERS = 8;
const MAX_STEP = 11;

const rooms = new Map();

const normalizeRoom = value => String(value || 'ABISMO01').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 16) || 'ABISMO01';
const normalizeMode = value => ['teams', 'ffa', 'coop'].includes(value) ? value : 'teams';
const safeName = value => String(value || 'Nany').trim().slice(0, 18) || 'Nany';
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const send = (ws, msg) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };

function newRoom(code, requestedMode) {
  const room = {
    code,
    mode: requestedMode,
    createdAt: Date.now(),
    seed: Math.floor(Math.random() * 0xffffffff) >>> 0 || 1,
    epoch: Date.now(),
    players: new Map(),
    anchor: { x: WORLD_W / 2 + (Math.random() - 0.5) * 1800, y: WORLD_H / 2 + (Math.random() - 0.5) * 1800 }
  };
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
  const existing = [...room.players.values()];
  if (!existing.length) return { x: room.anchor.x, y: room.anchor.y };
  const ref = existing[0];
  const angle = Math.random() * Math.PI * 2;
  const radius = 90 + Math.random() * 100;
  return {
    x: clamp(ref.x + Math.cos(angle) * radius, 100, WORLD_W - 100),
    y: clamp(ref.y + Math.sin(angle) * radius, 100, WORLD_H - 100)
  };
}

function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    x: Number(p.x.toFixed(2)),
    y: Number(p.y.toFixed(2)),
    vx: Number(p.vx.toFixed(2)),
    vy: Number(p.vy.toFixed(2)),
    angle: Number(p.angle.toFixed(3)),
    score: Math.floor(p.score),
    growthScore: Math.floor(p.growthScore),
    level: p.level,
    radius: Number(p.radius.toFixed(2)),
    power: p.power,
    alive: p.alive,
    sprinting: p.sprinting,
    team: p.team,
    teamName: p.team === 'A' ? 'Azul' : p.team === 'B' ? 'Rojo' : null
  };
}

function snapshot(room, viewer) {
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
    entities: []
  };
}

function welcome(room, player) {
  return {
    type: 'welcome',
    id: player.id,
    room: room.code,
    mode: room.mode,
    team: player.team,
    teamName: player.team === 'A' ? 'Azul' : player.team === 'B' ? 'Rojo' : null,
    worldSeed: room.seed,
    worldEpoch: room.epoch,
    worldStage: 0,
    boss: null,
    players: [...room.players.values()].map(publicPlayer),
    player: publicPlayer(player)
  };
}

function broadcast(room) {
  for (const p of room.players.values()) send(p.ws, snapshot(room, p));
  for (const p of room.players.values()) {
    if (p.spectators) for (const s of p.spectators) send(s, snapshot(room, p));
  }
}

function applyClientState(player, message) {
  const x = Number(message.x);
  const y = Number(message.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;

  const dx = x - player.lastReportX;
  const dy = y - player.lastReportY;
  const distance = Math.hypot(dx, dy);
  player.lastReportX = x;
  player.lastReportY = y;

  if (distance > 0.05) {
    const capped = Math.min(distance, MAX_STEP);
    const nx = dx / distance;
    const ny = dy / distance;
    player.targetX = clamp(player.x + nx * capped, 0, WORLD_W);
    player.targetY = clamp(player.y + ny * capped, 0, WORLD_H);
  }

  player.targetScore = Number.isFinite(Number(message.score)) ? Math.max(0, Number(message.score)) : player.targetScore;
  player.targetGrowth = Number.isFinite(Number(message.growthScore)) ? Math.max(0, Number(message.growthScore)) : player.targetGrowth;
  player.level = Number.isFinite(Number(message.level)) ? Math.max(1, Math.floor(Number(message.level))) : player.level;
  player.radius = Number.isFinite(Number(message.radius)) ? clamp(Number(message.radius), 8, 320) : player.radius;
  player.sprinting = !!message.sprinting;
  player.lastInputAt = Date.now();
}

function tickRoom(room) {
  for (const p of room.players.values()) {
    const dx = p.targetX - p.x;
    const dy = p.targetY - p.y;
    const distance = Math.hypot(dx, dy);
    if (distance > 0.01) {
      const step = Math.min(distance, MAX_STEP * 1.35);
      p.vx = dx / distance * step;
      p.vy = dy / distance * step;
      p.x = clamp(p.x + p.vx, 0, WORLD_W);
      p.y = clamp(p.y + p.vy, 0, WORLD_H);
      p.angle = Math.atan2(p.vy, p.vx);
    } else {
      p.vx *= 0.75;
      p.vy *= 0.75;
    }
    if (Date.now() - p.lastInputAt > 350) {
      p.targetX = p.x;
      p.targetY = p.y;
    }
    // The server is authoritative for the stats we accept from the client for now;
    // future eating transactions can replace these with server-only updates.
    p.score = p.targetScore;
    p.growthScore = p.targetGrowth;
  }
}

const server = createServer(async (req, res) => {
  try {
    const u = new URL(req.url || '/', 'http://localhost');
    if (u.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok: true, rooms: rooms.size, players: [...rooms.values()].reduce((n, r) => n + r.players.size, 0) }));
    }
    if (u.pathname === '/' || u.pathname === '/index.html') {
      let html = await readFile(join(ROOT, 'index.html'), 'utf8');
      html = injectNavigation(html);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    res.writeHead(404);
    res.end('Not found');
  } catch (error) {
    res.writeHead(500);
    res.end('Server error');
  }
});

function injectNavigation(html) {
  const script = `
<script>
(() => {
  'use strict';
  let navSocket = null, navRoom = null, world = null;
  const roomOf = () => { try { const M = window.eval('typeof Multiplayer !== "undefined" ? Multiplayer : undefined'); return M && typeof M.room === 'function' ? M.room() : null; } catch (_) { return null; } };
  const online = () => { try { const M = window.eval('typeof Multiplayer !== "undefined" ? Multiplayer : undefined'); return !!(M && M.isConnected && M.isConnected()); } catch (_) { return false; } };
  const clean = () => ['authoritativeMiniMap','nanyTeammateMiniMap','nanyNavTitle','nanyArrowLayer'].forEach(id => document.getElementById(id)?.remove());
  function connect() {
    const room = roomOf();
    if (!online() || !room || room === navRoom) return;
    navRoom = room;
    try { navSocket?.close(); } catch (_) {}
    navSocket = new WebSocket((location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/ws');
    navSocket.onopen = () => navSocket.send(JSON.stringify({ type: 'spectator', room }));
    navSocket.onmessage = e => { try { const m = JSON.parse(e.data); if (m.type === 'snapshot') world = m; } catch (_) {} };
  }
  function draw() {
    clean();
    if (!online() || !world?.you) return;
    const mini = document.getElementById('minimap');
    if (mini) {
      const c = mini.getContext('2d'), w = mini.width, h = mini.height;
      const sx = w / ${WORLD_W}, sy = h / ${WORLD_H};
      for (const p of world.players || []) {
        if (!p.alive || p.id === world.you.id) continue;
        c.fillStyle = '#ffffff';
        c.beginPath(); c.arc(p.x * sx, p.y * sy, 4, 0, Math.PI * 2); c.fill();
      }
    }
    let layer = document.getElementById('nanyTeammateArrows');
    if (!layer) {
      layer = document.createElement('div'); layer.id = 'nanyTeammateArrows';
      Object.assign(layer.style, { position:'fixed', inset:'0', zIndex:'9998', pointerEvents:'none' });
      document.body.appendChild(layer);
    }
    layer.replaceChildren();
    const me = world.you, cx = innerWidth/2, cy = innerHeight/2, margin = 44;
    for (const p of world.players || []) {
      if (!p.alive || p.id === me.id) continue;
      if (me.team && p.team !== me.team) continue;
      const dx = p.x - me.x, dy = p.y - me.y, d = Math.hypot(dx, dy);
      if (d < 240) continue;
      const hx = Math.max(100, cx - margin), hy = Math.max(100, cy - margin);
      const t = Math.min(Math.abs(dx) > 0 ? hx / Math.abs(dx) : Infinity, Math.abs(dy) > 0 ? hy / Math.abs(dy) : Infinity);
      const x = cx + dx * t, y = cy + dy * t;
      const el = document.createElement('div');
      Object.assign(el.style, { position:'absolute', left:x+'px', top:y+'px', color:'#fff', font:'700 18px/18px monospace', textAlign:'center', transform:'translate(-50%,-50%)' });
      el.innerHTML = '<div style="transform:rotate(' + (Math.atan2(dy,dx)+Math.PI/2) + 'rad)">▲</div><div style="font-size:9px;text-shadow:0 2px 5px #000">' + String(p.name || 'Compañero').replace(/[&<>"']/g,'') + '</div>';
      layer.appendChild(el);
    }
  }
  function loop() { if (online()) connect(); else { navRoom = null; world = null; try { navSocket?.close(); } catch (_) {} navSocket = null; document.getElementById('nanyTeammateArrows')?.replaceChildren(); } draw(); requestAnimationFrame(loop); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => requestAnimationFrame(loop), { once:true }); else requestAnimationFrame(loop);
})();
</script>`;
  return html.replace('</body>', script + '</body>');
}

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', ws => {
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  let player = null;
  let room = null;
  let spectator = false;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'spectator') {
      const code = normalizeRoom(msg.room);
      const r = rooms.get(code);
      if (!r) return send(ws, { type: 'snapshot', room: code, mode: 'teams', population: 0, players: [], you: null, entities: [] });
      spectator = true;
      room = r;
      return send(ws, snapshot(r, r.players.values().next().value || null));
    }

    if (msg.type === 'join') {
      const code = normalizeRoom(msg.room);
      room = rooms.get(code) || newRoom(code, normalizeMode(msg.mode));
      if (room.players.size >= MAX_PLAYERS) return send(ws, { type:'error', message:'Sala llena' });

      const team = chooseTeam(room, msg.team);
      const pos = spawnFor(room);
      player = {
        id, ws, name:safeName(msg.name), room:code, team,
        x:pos.x, y:pos.y, targetX:pos.x, targetY:pos.y,
        lastReportX:pos.x, lastReportY:pos.y,
        vx:0, vy:0, angle:0, score:0, growthScore:0, targetScore:0, targetGrowth:0,
        level:1, radius:11, power:1, alive:true, sprinting:false,
        lastInputAt:Date.now(), spectators:new Set()
      };
      room.players.set(id, player);
      send(ws, welcome(room, player));
      broadcast(room);
      return;
    }

    if (msg.type === 'state' && player && room) {
      applyClientState(player, msg);
      return;
    }

    if (msg.type === 'leave') ws.close();
  });

  ws.on('close', () => {
    if (!player || !room) return;
    room.players.delete(player.id);
    if (!room.players.size) rooms.delete(room.code);
    else broadcast(room);
  });
});

let tickAt = Date.now();
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) tickRoom(room);
  if (now - tickAt >= SNAPSHOT_MS) {
    tickAt = now;
    for (const room of rooms.values()) broadcast(room);
  }
}, TICK_MS);

server.listen(PORT, '0.0.0.0', () => console.log(`NANY FINAL AUTHORITATIVE ${PORT}`));
