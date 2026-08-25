import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT || 10000);
const INTERNAL_PORT = PORT + 1;
const WW = 12000;
const HH = 12000;

// The authoritative simulation remains server-clean3. This wrapper only:
// 1) exposes the original index.html,
// 2) bridges snapshot -> welcome for the existing client,
// 3) adds teammate navigation to the ORIGINAL radar canvas (no second map).
process.env.PORT = String(INTERNAL_PORT);
process.env.HOST = '127.0.0.1';
await import('./server-clean3.mjs');
process.env.PORT = String(PORT);

function makeWelcome(msg) {
  const you = msg?.you || msg?.player || null;
  return {
    type: 'welcome',
    id: you?.id || null,
    room: String(msg?.room || 'ABISMO01').toUpperCase(),
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

const NAV_SCRIPT = `
<script>
(() => {
  'use strict';
  const WW = ${WW}, HH = ${HH};
  let navSocket = null;
  let navRoom = null;
  let world = null;
  let raf = 0;

  const radar = () => document.getElementById('radar');
  const online = () => {
    try {
      const M = window.eval('typeof Multiplayer !== "undefined" ? Multiplayer : undefined');
      return !!(M && M.isConnected && M.isConnected());
    } catch (_) { return false; }
  };
  const currentRoom = () => {
    try {
      const M = window.eval('typeof Multiplayer !== "undefined" ? Multiplayer : undefined');
      return M && typeof M.room === 'function' ? M.room() : null;
    } catch (_) { return null; }
  };

  function cleanupOldOverlays() {
    ['authoritativeMiniMap','nanyTeammateMiniMap','nanyNavTitle','nanyArrowLayer'].forEach(id => document.getElementById(id)?.remove());
  }

  function connectSpectator() {
    const room = currentRoom();
    if (!online() || !room || room === navRoom) return;
    navRoom = room;
    try { navSocket?.close(); } catch (_) {}
    navSocket = new WebSocket((location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/ws');
    navSocket.onopen = () => navSocket.send(JSON.stringify({type:'spectator', room}));
    navSocket.onmessage = ev => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'snapshot') world = msg;
      } catch (_) {}
    };
  }

  function drawOriginalRadar() {
    const cv = radar();
    if (!cv || !world?.you || !online()) return;
    const rc = cv.getContext('2d');
    const w = cv.width || 110, h = cv.height || 110;
    rc.clearRect(0, 0, w, h);
    cv.style.display = 'block';

    rc.save();
    rc.translate(w / 2, h / 2);
    rc.strokeStyle = 'rgba(120,200,255,.4)';
    rc.lineWidth = 1;
    rc.beginPath(); rc.arc(0, 0, Math.min(w,h) * .45, 0, Math.PI * 2); rc.stroke();

    // Local player.
    rc.fillStyle = '#4dfff0';
    rc.beginPath(); rc.arc(0, 0, 4, 0, Math.PI * 2); rc.fill();

    // Teammates are WHITE, as requested.
    for (const p of world.players || []) {
      if (!p.alive || p.id === world.you.id) continue;
      const dx = p.x - world.you.x;
      const dy = p.y - world.you.y;
      const scale = 45 / 1200;
      const x = Math.max(-45, Math.min(45, dx * scale));
      const y = Math.max(-45, Math.min(45, dy * scale));
      rc.fillStyle = '#ffffff';
      rc.beginPath(); rc.arc(x, y, 4, 0, Math.PI * 2); rc.fill();
    }
    rc.restore();
  }

  function ensureArrowLayer() {
    let layer = document.getElementById('nanyTeammateArrows');
    if (layer) return layer;
    layer = document.createElement('div');
    layer.id = 'nanyTeammateArrows';
    Object.assign(layer.style, {
      position:'fixed', inset:'0', zIndex:'9998', pointerEvents:'none'
    });
    document.body.appendChild(layer);
    return layer;
  }

  function drawArrows() {
    const layer = ensureArrowLayer();
    if (!world?.you || !online()) { layer.innerHTML=''; return; }
    layer.innerHTML='';
    const me = world.you;
    const teammates = (world.players || []).filter(p => p.alive && p.id !== me.id && (!me.team || p.team === me.team));
    const cx = innerWidth / 2, cy = innerHeight / 2;
    const halfW = Math.max(100, cx - 42), halfH = Math.max(100, cy - 42);

    for (const p of teammates) {
      const dx = p.x - me.x, dy = p.y - me.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 260) continue;
      const denom = Math.max(Math.abs(dx) / halfW, Math.abs(dy) / halfH, 1e-6);
      const x = cx + dx / denom;
      const y = cy + dy / denom;
      const angle = Math.atan2(dy, dx) * 180 / Math.PI + 90;
      const el = document.createElement('div');
      Object.assign(el.style, {
        position:'absolute', left:(x-24)+'px', top:(y-18)+'px',
        width:'48px', height:'36px', textAlign:'center', color:'#fff',
        font:'700 20px/20px Space Mono, monospace',
        textShadow:'0 2px 7px #000', transform:`rotate(${angle}deg)`
      });
      el.innerHTML = '<div>▲</div><div style="font-size:9px;line-height:12px;transform:rotate(-' + angle + 'deg)">'+
        String(p.name || 'Compañero').replace(/[&<>\"']/g, '') + '</div>';
      layer.appendChild(el);
    }
  }

  function frame() {
    cleanupOldOverlays();
    if (online()) {
      connectSpectator();
      drawOriginalRadar();
      drawArrows();
    } else {
      navRoom = null;
      world = null;
      try { navSocket?.close(); } catch (_) {}
      navSocket = null;
      const layer = document.getElementById('nanyTeammateArrows');
      if (layer) layer.innerHTML = '';
    }
    raf = requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => frame(), {once:true});
  } else {
    frame();
  }
})();
</script>`;

const server = createServer(async (req, res) => {
  try {
    const u = new URL(req.url || '/', 'http://localhost');
    if (u.pathname === '/health') {
      res.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-store'});
      return res.end(JSON.stringify({ok:true}));
    }
    if (u.pathname === '/' || u.pathname === '/index.html') {
      let html = await readFile(join(ROOT, 'index.html'), 'utf8');
      html = html.replace('</body>', NAV_SCRIPT + '</body>');
      res.writeHead(200, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
      return res.end(html);
    }
    // Keep compatibility with the legacy entrypoint if it is requested.
    if (u.pathname === '/legacy') {
      let html = await readFile(join(ROOT, 'index.html'), 'utf8');
      html = html.replace('</body>', NAV_SCRIPT + '</body>');
      res.writeHead(200, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
      return res.end(html);
    }
    res.writeHead(404);
    res.end('Not found');
  } catch (err) {
    res.writeHead(500);
    res.end('Server error');
  }
});

const wss = new WebSocketServer({server, path:'/ws'});

wss.on('connection', client => {
  const upstream = new WebSocket(`ws://127.0.0.1:${INTERNAL_PORT}/ws`);
  const pending = [];
  let sentWelcome = false;

  const sendUpstream = text => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
    else pending.push(text);
  };

  upstream.on('open', () => {
    while (pending.length && upstream.readyState === WebSocket.OPEN) upstream.send(pending.shift());
  });

  upstream.on('message', data => {
    if (client.readyState !== WebSocket.OPEN) return;
    let msg;
    try { msg = JSON.parse(data.toString()); }
    catch { client.send(data); return; }
    if (!sentWelcome && msg?.type === 'snapshot') {
      sentWelcome = true;
      client.send(JSON.stringify(makeWelcome(msg)));
    }
    client.send(JSON.stringify(msg));
  });

  upstream.on('close', () => { if (client.readyState === WebSocket.OPEN) client.close(); });
  upstream.on('error', () => { if (client.readyState === WebSocket.OPEN) client.close(); });
  client.on('message', data => sendUpstream(data.toString()));
  client.on('close', () => { try { upstream.close(); } catch {} });
  client.on('error', () => { try { upstream.close(); } catch {} });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`NANY ROOM-SYNC SERVER ${PORT} -> authoritative ${INTERNAL_PORT}`);
});
