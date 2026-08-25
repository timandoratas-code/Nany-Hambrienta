import { createServer, request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT || 10000);
const INTERNAL_PORT = PORT + 1;

// Reuse the currently working authoritative/navigation server untouched.
process.env.PORT = String(INTERNAL_PORT);
process.env.HOST = '127.0.0.1';
await import('./server-clean4.mjs');
process.env.PORT = String(PORT);

function makeWelcome(msg) {
  const you = msg?.you || msg?.player || null;
  return {
    type: 'welcome',
    id: you?.id || null,
    room: msg?.room || 'ABISMO01',
    mode: msg?.mode || 'teams',
    team: you?.team || null,
    teamName: you?.teamName || null,
    worldSeed: Number(msg?.worldSeed) || 1,
    worldEpoch: Number(msg?.worldEpoch) || Date.now(),
    worldStage: Number(msg?.worldStage) || 0,
    boss: Array.isArray(msg?.entities) ? (msg.entities.find(e => e?.boss) || null) : null,
    players: Array.isArray(msg?.players) ? msg.players : [],
    player: you
  };
}

const server = createServer((req, res) => {
  const opts = {
    hostname: '127.0.0.1',
    port: INTERNAL_PORT,
    path: req.url,
    method: req.method,
    headers: req.headers
  };
  const upstream = httpRequest(opts, upstreamRes => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end('Bad gateway');
  });
  req.pipe(upstream);
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', client => {
  const upstream = new WebSocket(`ws://127.0.0.1:${INTERNAL_PORT}/ws`);
  const pending = [];
  let sentWelcome = false;
  let upstreamReady = false;

  const sendUpstream = text => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
    else pending.push(text);
  };

  upstream.on('open', () => {
    upstreamReady = true;
    while (pending.length && upstream.readyState === WebSocket.OPEN) {
      upstream.send(pending.shift());
    }
  });

  upstream.on('message', data => {
    if (client.readyState !== WebSocket.OPEN) return;

    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      client.send(data);
      return;
    }

    // The existing authoritative server starts with a snapshot, while the
    // existing client intentionally marks the connection as live only after
    // receiving `welcome`. Bridge that protocol difference once per socket.
    if (!sentWelcome && msg?.type === 'snapshot') {
      sentWelcome = true;
      client.send(JSON.stringify(makeWelcome(msg)));
    }

    client.send(JSON.stringify(msg));
  });

  upstream.on('close', () => {
    if (client.readyState === WebSocket.OPEN) client.close();
  });

  upstream.on('error', () => {
    if (client.readyState === WebSocket.OPEN) client.close();
  });

  client.on('message', data => sendUpstream(data.toString()));
  client.on('close', () => {
    try { upstream.close(); } catch {}
  });
  client.on('error', () => {
    try { upstream.close(); } catch {}
  });

  void upstreamReady;
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`NANY ROOM-SYNC SERVER ${PORT} -> navigation ${INTERNAL_PORT}`);
});
