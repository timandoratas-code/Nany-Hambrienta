import http from 'node:http';
import { WebSocket } from 'ws';

// Patch the WebSocket transport before the authoritative server is imported.
// Every server snapshot/welcome gets one shared server timestamp/tick so all
// clients can render the same simulation instant instead of "latest packet wins".
const nativeSend = WebSocket.prototype.send;
WebSocket.prototype.send = function patchedSend(data, ...args) {
  try {
    if (typeof data === 'string') {
      const msg = JSON.parse(data);
      if (msg && (msg.type === 'snapshot' || msg.type === 'welcome')) {
        const now = Date.now();
        msg.serverTime = now;
        msg.serverTick = Math.floor(now / 50); // 20 Hz shared presentation clock
        data = JSON.stringify(msg);
      }
    }
  } catch (_) {}
  return nativeSend.call(this, data, ...args);
};

// The authoritative server owns the room/fish simulation. We only inject the
// synchronization bridge before the page's own scripts execute.
const originalCreateServer = http.createServer;

http.createServer = function patchedCreateServer(handler) {
  return originalCreateServer.call(http, (req, res) => {
    const originalEnd = res.end;
    res.end = function patchedEnd(chunk, ...args) {
      try {
        if (typeof chunk === 'string' && chunk.includes('<!DOCTYPE html>')) {
          const bridge = `<script>(()=>{
  const NativeWebSocket=window.WebSocket;
  const STATE='__NANY_SERVER_STATE__';
  const BUFFER='__NANY_SERVER_BUFFER__';
  const MAX=24;
  const CLOCK='__NANY_SERVER_CLOCK__';
  function WrappedWebSocket(url,protocols){
    const ws=protocols===undefined?new NativeWebSocket(url):new NativeWebSocket(url,protocols);
    ws.addEventListener('message',ev=>{
      try{
        const m=JSON.parse(ev.data);
        if(!m || (m.type!=='welcome' && m.type!=='snapshot')) return;
        window[STATE]=m;
        const b=window[BUFFER]||(window[BUFFER]=[]);
        b.push({tick:Number(m.serverTick)||0,time:Number(m.serverTime)||Date.now(),msg:m,receivedAt:Date.now()});
        while(b.length>MAX) b.shift();
        const delays=b.map(x=>x.receivedAt-x.time).filter(Number.isFinite);
        if(delays.length){
          const min=Math.min(...delays);
          const c=window[CLOCK]||(window[CLOCK]={offset:min});
          c.offset=0.92*c.offset+0.08*min;
        }
      }catch(_){}
    });
    return ws;
  }
  WrappedWebSocket.prototype=NativeWebSocket.prototype;
  for(const k of ['CONNECTING','OPEN','CLOSING','CLOSED'])WrappedWebSocket[k]=NativeWebSocket[k];
  window.WebSocket=WrappedWebSocket;
  window.__SERVER_AUTHORITATIVE_FISH__=true;
  window.__SERVER_SYNC_FISH__=function(){
    try{
      const g=window.eval('typeof game!=="undefined"?game:null');
      const b=window[BUFFER]||[];
      if(!g||!g.running||!b.length)return;
      const clock=window[CLOCK]||{offset:0};
      const targetServerTime=Date.now()-clock.offset-75;

      // Find the two snapshots surrounding the same server presentation time.
      let a=null,z=null;
      for(let i=0;i<b.length;i++){
        const item=b[i];
        if(item.time<=targetServerTime) a=item;
        if(item.time>=targetServerTime){z=item;break;}
      }
      if(!a) a=b[0];
      if(!z) z=b[b.length-1];

      const ta=a.time, tz=z.time;
      const alpha=(z!==a && tz>ta)?Math.max(0,Math.min(1,(targetServerTime-ta)/(tz-ta))):1;
      const A=a.msg, Z=z.msg;
      const mapA=new Map((A.entities||[]).map(f=>[f.id,f]));
      const mapZ=new Map((Z.entities||[]).map(f=>[f.id,f]));
      const ids=new Set([...mapA.keys(),...mapZ.keys()]);
      g.entities=[];
      for(const id of ids){
        const f0=mapA.get(id)||mapZ.get(id);
        const f1=mapZ.get(id)||f0;
        const x=f0.x+(f1.x-f0.x)*alpha;
        const y=f0.y+(f1.y-f0.y)*alpha;
        const vx=f1.vx,vy=f1.vy;
        g.entities.push({serverId:id,type:f1.type,power:f1.power,points:f1.points,size:f1.size,color:f1.color,behavior:f1.role==='predator'?'aggro':'flee',hazard:null,speed:Math.max(.1,Math.hypot(vx,vy)),x,y,vx,vy,wobble:Math.atan2(vy,vx),life:0});
      }

      // Player state is taken from the snapshot targeted at the same server time.
      const P=A.you||A.player;
      if(P){
        g.score=P.score;
        g.lives=P.lives;
        g.player.x=P.x;
        g.player.y=P.y;
        g.player.vx=P.vx;
        g.player.vy=P.vy;
        g.player.angle=P.angle;
      }
    }catch(_){}
  };
})();</script>`;
          chunk = chunk.replace('</head>', bridge + '</head>');
        }
      } catch (_) {}
      return originalEnd.call(this, chunk, ...args);
    };
    return handler(req, res);
  });
};

await import('./server-single-ws.mjs');
