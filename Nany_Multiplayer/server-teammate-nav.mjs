import { createServer, request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT || 10000);
const INTERNAL_PORT = PORT + 1;

// Keep the working authoritative simulation. This wrapper only serves the
// existing index and adds teammate navigation without adding another map.
process.env.PORT = String(INTERNAL_PORT);
process.env.HOST = '127.0.0.1';
await import('./server-clean3.mjs');
process.env.PORT = String(PORT);

const NAV_SCRIPT = `
<script>
(() => {
  'use strict';

  let world = null;
  let dotLayer = null;
  let arrowLayer = null;
  let originalAddEventListener = null;

  const safeEval = name => {
    try { return window.eval('typeof ' + name + ' !== "undefined" ? ' + name + ' : undefined'); }
    catch (_) { return undefined; }
  };

  function installMessageTap() {
    if (originalAddEventListener) return;
    originalAddEventListener = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function(type, listener, options) {
      if (type === 'message' && this instanceof WebSocket && listener) {
        const wrapped = typeof listener === 'function'
          ? function(ev) {
              try {
                const msg = JSON.parse(String(ev.data || ''));
                if (msg?.type === 'snapshot' && Array.isArray(msg.players) && msg.you) world = msg;
              } catch (_) {}
              return listener.call(this, ev);
            }
          : {
              handleEvent(ev) {
                try {
                  const msg = JSON.parse(String(ev.data || ''));
                  if (msg?.type === 'snapshot' && Array.isArray(msg.players) && msg.you) world = msg;
                } catch (_) {}
                return listener.handleEvent.call(this, ev);
              }
            };
        return originalAddEventListener.call(this, type, wrapped, options);
      }
      return originalAddEventListener.call(this, type, listener, options);
    };
  }

  function cleanupOldOverlays() {
    // Remove the second-map UI from prior versions, including after hot reloads.
    for (const id of ['nanyTeammateMiniMap','nanyNavTitle','nanyArrowLayer']) {
      document.getElementById(id)?.remove();
    }
  }

  function findExistingMap() {
    const ids = ['radar','minimap','miniMap','map','worldMap','radarCanvas'];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el && (el.tagName === 'CANVAS' || el.getBoundingClientRect().width > 20)) return el;
    }
    const canvases = [...document.querySelectorAll('canvas')];
    return canvases.find(c => {
      const id = (c.id || '').toLowerCase();
      return id.includes('radar') || id.includes('mini') || id.includes('map');
    }) || null;
  }

  function ensureLayers() {
    cleanupOldOverlays();
    if (!dotLayer) {
      dotLayer = document.createElement('div');
      dotLayer.id = 'nanyTeammateDots';
      Object.assign(dotLayer.style, {
        position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '9997', display: 'none'
      });
      document.body.appendChild(dotLayer);
    }
    if (!arrowLayer) {
      arrowLayer = document.createElement('div');
      arrowLayer.id = 'nanyTeammateArrows';
      Object.assign(arrowLayer.style, {
        position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '9998', display: 'none'
      });
      document.body.appendChild(arrowLayer);
    }
  }

  function clearLayer(layer) {
    if (layer) layer.replaceChildren();
  }

  function renderMiniDots(map) {
    if (!dotLayer || !world?.you || !map) return;
    const rect = map.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 20 || getComputedStyle(map).display === 'none') {
      dotLayer.style.display = 'none';
      return;
    }

    clearLayer(dotLayer);
    dotLayer.style.display = 'block';

    const me = world.you;
    const players = Array.isArray(world.players) ? world.players : [];
    for (const p of players) {
      if (!p?.alive) continue;
      const dot = document.createElement('div');
      const x = rect.left + (Number(p.x) / 12000) * rect.width;
      const y = rect.top + (Number(p.y) / 12000) * rect.height;
      const mine = p.id === me.id;
      const teammate = !!me.team && p.team === me.team;
      const color = mine ? '#4dfff0' : (teammate ? '#ffffff' : '#ff6a6a');
      const size = mine ? 8 : 7;
      Object.assign(dot.style, {
        position: 'fixed', left: (x - size/2) + 'px', top: (y - size/2) + 'px',
        width: size + 'px', height: size + 'px', borderRadius: '50%',
        background: color, boxShadow: '0 0 7px ' + color,
        border: '1px solid rgba(255,255,255,.85)'
      });
      dot.title = mine ? 'Tú' : (p.name || 'Compañero');
      dotLayer.appendChild(dot);
    }
  }

  function renderArrows() {
    if (!arrowLayer || !world?.you) return;
    clearLayer(arrowLayer);
    arrowLayer.style.display = 'block';
    const me = world.you;
    const players = Array.isArray(world.players) ? world.players : [];
    const centerX = innerWidth / 2;
    const centerY = innerHeight / 2;
    const edgeX = Math.max(90, centerX - 38);
    const edgeY = Math.max(90, centerY - 38);

    for (const p of players) {
      if (!p?.alive || p.id === me.id) continue;
      if (me.team && p.team && p.team !== me.team) continue;
      const dx = Number(p.x) - Number(me.x);
      const dy = Number(p.y) - Number(me.y);
      const distance = Math.hypot(dx, dy);
      if (distance < 220) continue;

      const ratio = Math.max(Math.abs(dx) / edgeX, Math.abs(dy) / edgeY, 1e-6);
      const x = centerX + dx / ratio;
      const y = centerY + dy / ratio;
      const deg = Math.atan2(dy, dx) * 180 / Math.PI + 90;

      const arrow = document.createElement('div');
      arrow.textContent = '▲';
      Object.assign(arrow.style, {
        position: 'fixed', left: (x - 14) + 'px', top: (y - 14) + 'px',
        width: '28px', height: '28px', textAlign: 'center',
        font: '700 22px/28px Arial,sans-serif', color: '#ffffff',
        textShadow: '0 0 6px rgba(0,0,0,.95)', transform: 'rotate(' + deg + 'deg)'
      });
      arrow.title = p.name || 'Compañero';
      arrowLayer.appendChild(arrow);
    }
  }

  function tick() {
    installMessageTap();
    ensureLayers();
    const map = findExistingMap();
    if (world) {
      renderMiniDots(map);
      renderArrows();
    } else {
      if (dotLayer) dotLayer.style.display = 'none';
      if (arrowLayer) arrowLayer.style.display = 'none';
    }
    requestAnimationFrame(tick);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => requestAnimationFrame(tick), { once: true });
  } else {
    requestAnimationFrame(tick);
  }
})();
</script>`;

const server = createServer((req, res) => {
  const opts = {
    hostname: '127.0.0.1', port: INTERNAL_PORT,
    path: req.url, method: req.method, headers: req.headers
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
  const sendUpstream = data => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data);
    else pending.push(data);
  };
  upstream.on('open', () => {
    while (pending.length && upstream.readyState === WebSocket.OPEN) upstream.send(pending.shift());
  });
  upstream.on('message', data => {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  });
  upstream.on('close', () => { if (client.readyState === WebSocket.OPEN) client.close(); });
  upstream.on('error', () => { if (client.readyState === WebSocket.OPEN) client.close(); });
  client.on('message', data => sendUpstream(data.toString()));
  client.on('close', () => { try { upstream.close(); } catch {} });
  client.on('error', () => { try { upstream.close(); } catch {} });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`NANY TEAM NAV SERVER ${PORT} -> authoritative ${INTERNAL_PORT}`);
});
