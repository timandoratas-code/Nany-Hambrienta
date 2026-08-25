import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT || 10000);
const INTERNAL_PORT = PORT + 1;

// Keep the already-working authoritative simulation intact. Run it on an
// internal port and proxy its websocket through this public server while
// augmenting the served index page with teammate navigation UI.
process.env.PORT = String(INTERNAL_PORT);
process.env.HOST = '127.0.0.1';
await import('./server-clean3.mjs');
await new Promise(r => setTimeout(r, 100));
process.env.PORT = String(PORT);

const WW = 12000;
const HH = 12000;

const NAV_SCRIPT = `
<script>
(() => {
  'use strict';
  const WW = ${WW}, HH = ${HH};
  let navSocket = null;
  let navRoom = null;
  let world = null;
  let mapCanvas = null;
  let arrows = new Map();
  let lastRender = 0;

  const resolve = name => {
    try {
      return window.eval('typeof ' + name + ' !== "undefined" ? ' + name + ' : undefined');
    } catch (_) { return undefined; }
  };

  const mpOnline = () => {
    const M = resolve('Multiplayer');
    try { return !!(M && M.isConnected && M.isConnected()); } catch (_) { return false; }
  };

  const currentRoom = () => {
    const M = resolve('Multiplayer');
    try { return M && typeof M.room === 'function' ? M.room() : null; } catch (_) { return null; }
  };

  function ensureUi() {
    if (!mapCanvas) {
      mapCanvas = document.createElement('canvas');
      mapCanvas.id = 'nanyTeammateMiniMap';
      mapCanvas.width = 220;
      mapCanvas.height = 220;
      Object.assign(mapCanvas.style, {
        position: 'fixed',
        right: '18px',
        bottom: '18px',
        width: '220px',
        height: '220px',
        zIndex: '10000',
        display: 'none',
        borderRadius: '14px',
        border: '1px solid rgba(77,255,240,.30)',
        background: 'rgba(2,11,20,.82)',
        boxShadow: '0 8px 28px rgba(0,0,0,.42)',
        pointerEvents: 'none'
      });
      document.body.appendChild(mapCanvas);
    }

    if (!document.getElementById('nanyNavTitle')) {
      const title = document.createElement('div');
      title.id = 'nanyNavTitle';
      title.textContent = 'COMPAÑEROS';
      Object.assign(title.style, {
        position:'fixed', right:'28px', bottom:'226px', zIndex:'10001',
        display:'none', color:'#4dfff0', font:'700 10px Space Mono, monospace',
        letterSpacing:'.10em', textShadow:'0 2px 6px rgba(0,0,0,.8)', pointerEvents:'none'
      });
      document.body.appendChild(title);
    }

    if (!document.getElementById('nanyArrowLayer')) {
      const layer = document.createElement('div');
      layer.id = 'nanyArrowLayer';
      Object.assign(layer.style, {position:'fixed', inset:'0', zIndex:'9998', pointerEvents:'none', display:'none'});
      document.body.appendChild(layer);
    }
  }

  function makeArrow(id) {
    const layer = document.getElementById('nanyArrowLayer');
    if (!layer) return null;
    const el = document.createElement('div');
    el.dataset.playerId = id;
    el.innerHTML = '<span style="display:block;font-size:20px;line-height:20px">▲</span><span class="nanyArrowName"></span>';
    Object.assign(el.style, {
      position:'absolute', width:'90px', height:'40px',
      transformOrigin:'50% 50%', textAlign:'center', display:'none',
      font:'700 10px Space Mono, monospace', color:'#8fefff',
      textShadow:'0 2px 7px #000',
    });
    layer.appendChild(el);
    return el;
  }

  function clearArrows() {
    for (const el of arrows.values()) el.remove();
    arrows.clear();
  }

  function drawArrows() {
    const layer = document.getElementById('nanyArrowLayer');
    const canvas = resolve('canvas');
    if (!layer || !canvas || !world?.you || !mpOnline()) return;
    layer.style.display = 'block';

    const me = world.you;
    const teammates = (world.players || []).filter(p => p.alive && p.id !== me.id && (!me.team || p.team === me.team));
    const seen = new Set();
    const margin = 46;
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    const halfW = Math.max(90, cx - margin);
    const halfH = Math.max(90, cy - margin);

    for (const p of teammates) {
      seen.add(p.id);
      const dx = p.x - me.x;
      const dy = p.y - me.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 180) {
        const old = arrows.get(p.id);
        if (old) old.style.display = 'none';
        continue;
      }

      let el = arrows.get(p.id);
      if (!el) {
        el = makeArrow(p.id);
        if (!el) continue;
        arrows.set(p.id, el);
      }

      const theta = Math.atan2(dy, dx);
      const denom = Math.max(Math.abs(dx) / halfW, Math.abs(dy) / halfH, 1e-6);
      const px = cx + (dx / denom);
      const py = cy + (dy / denom);
      const deg = theta * 180 / Math.PI + 90;
      el.style.left = (px - 45) + 'px';
      el.style.top = (py - 20) + 'px';
      el.style.transform = 'rotate(' + deg + 'deg)';
      el.style.display = 'block';
      const color = p.team === me.team ? '#4dfff0' : '#ff5a5a';
      el.style.color = color;
      const label = el.querySelector('.nanyArrowName');
      if (label) {
        label.textContent = p.name || 'Jugador';
        label.style.transform = 'rotate(' + (-deg) + 'deg)';
        label.style.display = 'block';
      }
    }

    for (const [id, el] of arrows) {
      if (!seen.has(id)) {
        el.remove();
        arrows.delete(id);
      }
    }
  }

  function drawMinimap() {
    if (!mapCanvas || !world?.you || !mpOnline()) return;
    const title = document.getElementById('nanyNavTitle');
    mapCanvas.style.display = 'block';
    if (title) title.style.display = 'block';

    const c = mapCanvas.getContext('2d');
    const W = mapCanvas.width, H = mapCanvas.height;
    c.clearRect(0,0,W,H);
    c.fillStyle = 'rgba(2,11,20,.92)';
    c.fillRect(0,0,W,H);

    c.strokeStyle = 'rgba(77,255,240,.28)';
    c.lineWidth = 2;
    c.strokeRect(2,2,W-4,H-4);

    c.strokeStyle = 'rgba(77,255,240,.08)';
    c.lineWidth = 1;
    for (let i=1;i<4;i++) {
      const x = i*W/4, y = i*H/4;
      c.beginPath(); c.moveTo(x,0); c.lineTo(x,H); c.stroke();
      c.beginPath(); c.moveTo(0,y); c.lineTo(W,y); c.stroke();
    }

    const me = world.you;
    const players = world.players || [];
    for (const p of players) {
      if (!p.alive) continue;
      const x = Math.max(8, Math.min(W-8, p.x / WW * W));
      const y = Math.max(8, Math.min(H-8, p.y / HH * H));
      const mine = p.id === me.id;
      const teammate = !!me.team && p.team === me.team;
      const color = mine ? '#ffffff' : (teammate ? '#4dfff0' : '#ff5a5a');
      const r = mine ? 6 : 5;
      c.fillStyle = color;
      c.beginPath(); c.arc(x,y,r,0,Math.PI*2); c.fill();
      if (!mine) {
        c.strokeStyle = color;
        c.lineWidth = 1;
        c.beginPath(); c.arc(x,y,r+4,0,Math.PI*2); c.stroke();
        c.fillStyle = '#dff7f5';
        c.font = '700 8px Space Mono, monospace';
        c.textAlign = 'center';
        c.fillText(p.name || 'Jugador', x, y - 9);
      }
    }

    c.fillStyle = '#dff7f5';
    c.font = '700 9px Space Mono, monospace';
    c.textAlign = 'left';
    c.fillText('TÚ', 8, H-8);
  }

  function connectSpectator() {
    const r = currentRoom();
    if (!mpOnline() || !r || r === navRoom) return;
    navRoom = r;
    try { navSocket?.close(); } catch (_) {}
    navSocket = new WebSocket((location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/ws');
    navSocket.onopen = () => navSocket.send(JSON.stringify({type:'spectator', room:r}));
    navSocket.onmessage = ev => {
      try {
        const m = JSON.parse(ev.data);
        if (m.type === 'snapshot') world = m;
      } catch (_) {}
    };
  }

  function tick(ts) {
    ensureUi();
    if (mpOnline()) {
      connectSpectator();
      if (ts - lastRender > 45) {
        drawMinimap();
        drawArrows();
        lastRender = ts;
      }
    } else {
      navRoom = null;
      world = null;
      clearArrows();
      const layer = document.getElementById('nanyArrowLayer');
      const title = document.getElementById('nanyNavTitle');
      if (layer) layer.style.display = 'none';
      if (title) title.style.display = 'none';
      if (mapCanvas) mapCanvas.style.display = 'none';
      try { navSocket?.close(); } catch (_) {}
      navSocket = null;
    }
    requestAnimationFrame(tick);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => requestAnimationFrame(tick), {once:true});
  } else {
    requestAnimationFrame(tick);
  }
})();
</script>`;

const http = createServer(async (req, res) => {
  try {
    const u = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
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
    res.writeHead(404);
    res.end('Not found');
  } catch (err) {
    res.writeHead(500);
    res.end('Server error');
  }
});

const wss = new WebSocketServer({server:http, path:'/ws'});

wss.on('connection', (client) => {
  const upstream = new WebSocket(`ws://127.0.0.1:${INTERNAL_PORT}/ws`);
  let open = false;

  const sendQueued = msg => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(msg);
  };

  upstream.on('open', () => {
    open = true;
  });
  upstream.on('message', data => {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  });
  upstream.on('close', () => {
    if (client.readyState === WebSocket.OPEN) client.close();
  });
  upstream.on('error', () => {
    if (client.readyState === WebSocket.OPEN) client.close();
  });

  client.on('message', data => sendQueued(data.toString()));
  client.on('close', () => { try { upstream.close(); } catch (_) {} });
  client.on('error', () => { try { upstream.close(); } catch (_) {} });
});

http.listen(PORT, '0.0.0.0', () => {
  console.log(`NANY NAVIGATION SERVER ${PORT} -> authoritative ${INTERNAL_PORT}`);
});
