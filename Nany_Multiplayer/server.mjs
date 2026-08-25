import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'node:crypto';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const WORLD_W = 12000;
const WORLD_H = 12000;
const MAX_PLAYERS_PER_ROOM = 8;
const MAX_MESSAGE_BYTES = 16 * 1024;
const TICK_MS = 50;
const STATE_RATE_MS = 40;
const MAX_CLIENT_SPEED = 8.5;
const PVP_REACH_FACTOR = 1.08;
const PVP_POWER_MARGIN = 1.06;

const rooms = new Map();
const clients = new Map();

const LEVEL_THRESHOLDS = [0, 1000, 3000, 6000, 10000, 15000];

function safeRoom(value) {
  const room = String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 16);
  return room || 'ABISMO01';
}
function safeMode(value) {
  const mode = String(value ?? 'ffa').trim().toLowerCase();
  return ['teams','ffa','coop'].includes(mode) ? mode : 'ffa';
}
function safeName(value) {
  const name = String(value ?? 'Nany').trim().slice(0, 18);
  return name || 'Nany';
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function computeLevel(score) {
  let level = 1;
  for (let i = 0; i < LEVEL_THRESHOLDS.length; i++) {
    if (score >= LEVEL_THRESHOLDS[i]) level = i + 1;
  }
  return level;
}
function playerPower(score) {
  const s = Math.max(0, score);
  if (s < 100) return 1;
  if (s < 250) return 2;
  if (s < 500) return 3;
  if (s < 900) return 4;
  if (s < 1500) return 5;
  if (s < 2500) return 6;
  if (s < 4000) return 7;
  if (s < 6000) return 8;
  if (s < 9000) return 9;
  return 10;
}
function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    x: p.x,
    y: p.y,
    angle: p.angle,
    score: p.score,
    growthScore: p.growthScore,
    level: p.level,
    radius: p.radius,
    alive: p.alive,
    power: p.power,
    sprinting: p.sprinting,
    deaths: p.deaths,
    team: p.team || null,
    teamName: p.teamName || null
  };
}
function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}
function broadcastRoom(room, payload, exceptId = null) {
  for (const p of room.values()) {
    if (p.id === exceptId) continue;
    send(p.ws, payload);
  }
}
function getRoom(name) {
  let room = rooms.get(name);
  if (!room) {
    room = new Map();
    room.roomId = name;
    room.createdAt = Date.now();
    room.round = 1;
    room.mode = room.mode || 'ffa';
    rooms.set(name, room);
  }
  return room;
}

const http = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/health') {
      const payload = JSON.stringify({ok:true,service:'nany-hambrienta-multiplayer',rooms:rooms.size,players:clients.size});
      res.writeHead(200, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
      res.end(payload);
      return;
    }
    // Serve the game shell directly. This avoids path-resolution edge cases
    // when the service is deployed with a custom Render root directory.
    if (pathname === '/' || pathname === '/index.html') {
      const data = await readFile(join(__dirname, 'index.html'));
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(data);
      return;
    }
    if (pathname === '/favicon.ico') {
      res.writeHead(204, {'Cache-Control':'no-store'});
      res.end();
      return;
    }
    const filePath = join(__dirname, pathname.replace(/^\/+/, ''));
    const rel = relative(__dirname, filePath);
    if (rel.startsWith('..') || rel.includes('\0')) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    const data = await readFile(filePath);
    const ext = extname(filePath);
    const type = ext === '.html' ? 'text/html; charset=utf-8'
      : ext === '.js' || ext === '.mjs' ? 'text/javascript; charset=utf-8'
      : ext === '.css' ? 'text/css; charset=utf-8'
      : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
  } catch (err) {
    if (err?.code === 'ENOENT') { res.writeHead(404); res.end('Not found'); return; }
    console.error(err);
    res.writeHead(500); res.end('Server error');
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

http.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname !== '/ws') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

function removeClient(client) {
  clients.delete(client.id);
  if (!client.joined || !client.room) return;
  const room = rooms.get(client.room);
  if (!room) return;
  room.delete(client.id);
  broadcastRoom(room, { type: 'player_left', id: client.id, room: client.room });
  if (room.size === 0) rooms.delete(client.room);
}

function serverAcceptState(client, msg, now) {
  if (now - client.lastStateAt < STATE_RATE_MS) return;
  client.lastStateAt = now;

  const nx = Number(msg.x);
  const ny = Number(msg.y);
  const na = Number(msg.angle);
  const ns = Number(msg.score);
  const ng = Number(msg.growthScore);
  const nr = Number(msg.radius);

  if (Number.isFinite(nx) && Number.isFinite(ny)) {
    const d = Math.hypot(nx - client.x, ny - client.y);
    const elapsed = Math.max(0.04, (now - client.lastAcceptedAt) / 1000);
    const maxStep = MAX_CLIENT_SPEED * elapsed + 24;
    if (d <= maxStep) {
      client.x = clamp(nx, 0, WORLD_W);
      client.y = clamp(ny, 0, WORLD_H);
    } else {
      // Snap toward the submitted position instead of accepting a teleport.
      const t = clamp(maxStep / d, 0, 1);
      client.x += (nx - client.x) * t;
      client.y += (ny - client.y) * t;
    }
  }
  if (Number.isFinite(na)) client.angle = na;
  if (Number.isFinite(ns)) client.score = Math.max(client.score, clamp(Math.floor(ns), 0, 1_000_000));
  if (Number.isFinite(ng)) client.growthScore = Math.max(client.growthScore, clamp(Math.floor(ng), 0, 1_000_000));
  if (Number.isFinite(nr)) client.radius = clamp(nr, 4, 320);
  client.power = playerPower(client.growthScore);
  client.level = computeLevel(client.growthScore);
  client.alive = msg.alive !== false;
  client.sprinting = msg.sprinting === true;
  client.lastAcceptedAt = now;
}

function assignTeam(room, requested) {
  if (room.mode !== 'teams') return null;
  if (requested === 'A' || requested === 'B') return requested;
  const a = [...room.values()].filter(p => p.team === 'A').length;
  const b = [...room.values()].filter(p => p.team === 'B').length;
  return a <= b ? 'A' : 'B';
}
function teamName(team) { return team === 'A' ? 'Azul' : team === 'B' ? 'Rojo' : null; }
function canPvp(room, a, b) {
  if (room.mode === 'coop') return false;
  if (room.mode === 'teams' && a.team && b.team && a.team === b.team) return false;
  return true;
}

function handlePvP(room) {
  const players = [...room.values()].filter(p => p.alive);
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const a = players[i], b = players[j];
      if (!canPvp(room, a, b)) continue;
      const reach = Math.max(22, (a.radius + b.radius) * 0.84);
      if (dist(a, b) > reach) continue;

      let eater = null, victim = null;
      if (a.power >= b.power * PVP_POWER_MARGIN && a.radius >= b.radius * PVP_REACH_FACTOR) { eater = a; victim = b; }
      else if (b.power >= a.power * PVP_POWER_MARGIN && b.radius >= a.radius * PVP_REACH_FACTOR) { eater = b; victim = a; }
      if (!eater || !victim || victim._pvpCooldown > Date.now()) continue;

      const now = Date.now();
      victim._pvpCooldown = now + 2500;
      victim.alive = false;
      victim.deaths += 1;
      eater.score = Math.min(1_000_000, eater.score + Math.max(20, Math.floor(victim.score * 0.12)));
      eater.growthScore = Math.min(1_000_000, eater.growthScore + Math.max(20, Math.floor(victim.growthScore * 0.12)));
      eater.power = playerPower(eater.growthScore);
      eater.level = computeLevel(eater.growthScore);

      const event = {
        type: 'player_eaten',
        victimId: victim.id,
        eaterId: eater.id,
        eater: publicPlayer(eater),
        victimScore: victim.score,
        victimDeaths: victim.deaths
      };
      broadcastRoom(room, event);

      setTimeout(() => {
        if (!clients.has(victim.id)) return;
        victim.alive = true;
        victim.score = Math.max(0, Math.floor(victim.score * 0.35));
        victim.growthScore = victim.score;
        victim.level = computeLevel(victim.growthScore);
        victim.power = playerPower(victim.growthScore);
        // Respawn totalmente aleatorio en el primer mapa: puede aparecer
        // en cualquier zona del océano, incluyendo arriba/abajo/izquierda/derecha
        // y las cuatro esquinas. Solo dejamos un margen para que no nazca fuera.
        victim.x = clamp(Math.random() * WORLD_W, 200, WORLD_W - 200);
        victim.y = clamp(Math.random() * WORLD_H, 200, WORLD_H - 200);
        send(victim.ws, { type: 'respawn', player: publicPlayer(victim), room: victim.room });
      }, 1800);
    }
  }
}

wss.on('connection', (ws) => {
  const id = crypto.randomUUID();
  const client = {
    id, ws, room: null, joined: false,
    name: 'Nany', x: 6000, y: 6000, angle: 0,
    score: 0, growthScore: 0, level: 1, power: 1, radius: 11,
    alive: true, sprinting: false, deaths: 0, mode: 'ffa', team: null, teamName: null,
    lastStateAt: 0, lastAcceptedAt: Date.now(), _pvpCooldown: 0
  };
  clients.set(id, client);

  ws.on('error', () => {});
  ws.on('message', (data, isBinary) => {
    if (isBinary || data.byteLength > MAX_MESSAGE_BYTES) return;
    let msg;
    try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'join') {
      if (client.joined) return;
      const roomName = safeRoom(msg.room);
      const requestedMode = safeMode(msg.mode);
      const room = getRoom(roomName);
      if (room.size === 0) room.mode = requestedMode;
      if (room.mode !== requestedMode) {
        send(ws, { type: 'error', code: 'MODE_MISMATCH', message: `La sala ya está configurada como ${room.mode}.` });
        return;
      }
      if (room.size >= MAX_PLAYERS_PER_ROOM) {
        send(ws, { type: 'error', code: 'ROOM_FULL', message: 'Sala llena (máximo 8 jugadores).' });
        return;
      }
      client.room = roomName;
      client.name = safeName(msg.name);
      client.mode = room.mode;
      client.team = assignTeam(room, msg.team);
      client.teamName = teamName(client.team);
      client.joined = true;
      room.set(id, client);
      send(ws, {
        type: 'welcome',
        id,
        room: roomName,
        maxPlayers: MAX_PLAYERS_PER_ROOM,
        mode: room.mode,
        team: client.team,
        teamName: client.teamName,
        players: [...room.values()].filter(p => p.id !== id).map(publicPlayer)
      });
      broadcastRoom(room, { type: 'player_joined', player: publicPlayer(client), room: roomName }, id);
      return;
    }

    if (!client.joined || !client.room) return;
    const room = rooms.get(client.room);
    if (!room) return;

    if (msg.type === 'state') {
      serverAcceptState(client, msg, Date.now());
      return;
    }
    if (msg.type === 'leave') {
      try { ws.close(); } catch {}
    }
  });

  ws.on('close', () => removeClient(client));
});

const snapshotTimer = setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    handlePvP(room);
    const players = [...room.values()].map(publicPlayer);
    for (const p of room.values()) {
      send(p.ws, {
        type: 'snapshot',
        serverTime: now,
        room: room.roomId,
        players,
        population: room.size,
        round: room.round,
        mode: room.mode
      });
    }
  }
}, TICK_MS);

function shutdown() {
  clearInterval(snapshotTimer);
  for (const c of clients.values()) {
    try { c.ws.close(1001, 'Servidor cerrando'); } catch {}
  }
  http.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

http.listen(PORT, HOST, () => {
  console.log(`Nany multiplayer server listening on http://${HOST}:${PORT}`);
  console.log(`WebSocket endpoint: ws://HOST:${PORT}/ws`);
});
