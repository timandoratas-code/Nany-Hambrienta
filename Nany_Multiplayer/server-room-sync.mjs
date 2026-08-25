import { createServer, request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT || 10000);
const INTERNAL_PORT = PORT + 1;

// Keep the authoritative server and its ORIGINAL minimap/world bridge.
// Do not use server-clean4 here: that layer adds a second minimap and arrows.
process.env.PORT = String(INTERNAL_PORT);
process.env.HOST = '127.0.0.1';
await import('./server-clean3.mjs');
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

function transformHtml(html) {
  // Remove team colors from the ORIGINAL minimap: remote players are white.
  html = html.replace(
    "p.id===world.you.id?'#4dfff0':(p.team===world.you.team?'#5ea7ff':'#ff5a5a')",
    "p.id===world.you.id?'#4dfff0':'#ffffff'"
  );

  // The world view must use the same authoritative center as the minimap.
  // Never let a stale local camera offset remote players.
  html = html.replace(
    "const z=typeof zf==='function'?zf():1;const cx=cam?.x??(world.you.x-c.width/(2*z)),cy=cam?.y??(world.you.y-c.height/(2*z));",
    "const z=typeof zf==='function'?zf():1;const cx=world.you.x-c.width/(2*z),cy=world.you.y-c.height/(2*z);"
  );

  return html;
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
    const isHtml = String(upstreamRes.headers['content-type'] || '').includes('text/html');

    if (!isHtml) {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
      return;
    }

    const chunks = [];
    upstreamRes.on('data', chunk => chunks.push(Buffer.from(chunk)));
    upstreamRes.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const transformed = transformHtml(body);
      const headers = {...upstreamRes.headers};
      delete headers['content-length'];
      headers['content-length'] = Buffer.byteLength(transformed, 'utf8');
      res.writeHead(upstreamRes.statusCode || 200, headers);
      res.end(transformed);
    });
  });

  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end('Bad gateway');
  });

  req.pipe(upstream);
});

const wss = new WebSocketServer({server, path: '/ws'});

wss.on('connection', client => {
  const upstream = new WebSocket(`ws://127.0.0.1:${INTERNAL_PORT}/ws`);
  const pending = [];
  let sentWelcome = false;

  const sendUpstream = text => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
    else pending.push(text);
  };

  upstream.on('open', () => {
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

    // Bridge the existing authoritative snapshot protocol to the client's
    // expected welcome handshake exactly once per socket.
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
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`NANY ROOM-SYNC SERVER ${PORT} -> authoritative ${INTERNAL_PORT}`);
});
