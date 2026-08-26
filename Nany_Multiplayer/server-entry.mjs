import http from 'node:http';

// The authoritative server already exists in server-single-ws.mjs and owns
// the room/fish simulation. We only patch the HTML response BEFORE the game
// scripts run, so the client's real Multiplayer WebSocket is observed from
// its first message. This avoids a second WebSocket and avoids local fish.
const originalCreateServer = http.createServer;

http.createServer = function patchedCreateServer(handler) {
  return originalCreateServer.call(http, (req, res) => {
    const originalEnd = res.end;
    res.end = function patchedEnd(chunk, ...args) {
      try {
        if (typeof chunk === 'string' && chunk.includes('<!DOCTYPE html>')) {
          const bridge = `<script>(()=>{\n  const NativeWebSocket=window.WebSocket;\n  const STATE='__NANY_SERVER_STATE__';\n  function WrappedWebSocket(url,protocols){\n    const ws=protocols===undefined?new NativeWebSocket(url):new NativeWebSocket(url,protocols);\n    ws.addEventListener('message',ev=>{\n      try{const m=JSON.parse(ev.data);if(m&&(m.type==='welcome'||m.type==='snapshot'))window[STATE]=m;}catch(_){}\n    });\n    return ws;\n  }\n  WrappedWebSocket.prototype=NativeWebSocket.prototype;\n  for(const k of ['CONNECTING','OPEN','CLOSING','CLOSED'])WrappedWebSocket[k]=NativeWebSocket[k];\n  window.WebSocket=WrappedWebSocket;\n  window.__SERVER_AUTHORITATIVE_FISH__=true;\n  window.__SERVER_SYNC_FISH__=function(){\n    try{\n      const g=window.eval('typeof game!=="undefined"?game:null'),s=window[STATE];\n      if(!g||!g.running||!s||!Array.isArray(s.entities))return;\n      const byId=new Map((g.entities||[]).filter(e=>e.serverId).map(e=>[e.serverId,e]));\n      g.entities=s.entities.map(f=>({serverId:f.id,type:f.type,power:f.power,points:f.points,size:f.size,color:f.color,behavior:f.role==='predator'?'aggro':'flee',hazard:null,speed:Math.max(.1,Math.hypot(f.vx,f.vy)),x:f.x,y:f.y,vx:f.vx,vy:f.vy,wobble:byId.get(f.id)?.wobble||0,life:byId.get(f.id)?.life||0}));\n      const me=s.you||s.player;\n      if(me){g.score=me.score;g.lives=me.lives;g.player.x=me.x;g.player.y=me.y;g.player.vx=me.vx;g.player.vy=me.vy;g.player.angle=me.angle;}\n    }catch(_){}\n  };\n})();</script>`;
          chunk = chunk.replace('</head>', bridge + '</head>');
        }
      } catch (_) {}
      return originalEnd.call(this, chunk, ...args);
    };
    return handler(req, res);
  });
};

await import('./server-single-ws.mjs');
