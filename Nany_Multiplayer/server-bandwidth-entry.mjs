import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const RUNTIME=path.join(ROOT,'world-runtime.mjs');
const SERVER=path.join(ROOT,'server.mjs');

let runtime=await fs.readFile(RUNTIME,'utf8');

// 20 snapshots/s era demasiado caro para snapshots grandes. El cliente ya
// interpola/extrapola movimiento, así que 8 Hz conserva suavidad y reduce mucho tráfico.
if(!runtime.includes('const TICK_HZ=30, SNAP_HZ=20;')){
  throw new Error('Bandwidth entry: no se encontró SNAP_HZ=20');
}
runtime=runtime.replace('const TICK_HZ=30, SNAP_HZ=20;','const TICK_HZ=30, SNAP_HZ=8;');

const oldSnapshot=`function snapshot(w){const entities=[...w.fish.values()].map(pubFish);if(w.lavaHazard)entities.push(pubFish(w.lavaHazard));return{type:'snapshot',room:w.code,mode:w.mode,population:[...w.players.values()].filter(p=>p.connected).length,serverTick:w.tick,serverTime:Date.now(),worldSeed:w.seed,worldEpoch:w.epoch,worldStage:w.stage,bossCleared:w.bossCleared,boss:pubBoss(w.boss),gemFishActive:activeGemCount(w),gemFishCap:GEM_FISH_CAP,nextGemAt:w.nextGemAt,players:[...w.players.values()].filter(p=>p.connected).map(pubPlayer),entities};}
function broadcast(w){const base=snapshot(w);for(const p of w.players.values())if(p.connected)send(p.ws,{...base,you:pubPlayer(p),player:pubPlayer(p)});}`;

const newSnapshot=`const SNAPSHOT_VIEW_RADIUS=2400;
function snapshot(w,viewer=null){
  let fish=[...w.fish.values()];
  if(viewer&&Number.isFinite(viewer.x)&&Number.isFinite(viewer.y)){
    const r2=SNAPSHOT_VIEW_RADIUS*SNAPSHOT_VIEW_RADIUS;
    fish=fish.filter(f=>{const dx=f.x-viewer.x,dy=f.y-viewer.y;return dx*dx+dy*dy<=r2;});
  }
  const entities=fish.map(pubFish);
  if(w.lavaHazard){
    const h=w.lavaHazard;
    if(!viewer||Math.hypot(h.x-viewer.x,h.y-viewer.y)<=SNAPSHOT_VIEW_RADIUS)entities.push(pubFish(h));
  }
  return{type:'snapshot',room:w.code,mode:w.mode,population:[...w.players.values()].filter(p=>p.connected).length,serverTick:w.tick,serverTime:Date.now(),worldSeed:w.seed,worldEpoch:w.epoch,worldStage:w.stage,bossCleared:w.bossCleared,boss:pubBoss(w.boss),gemFishActive:activeGemCount(w),gemFishCap:GEM_FISH_CAP,nextGemAt:w.nextGemAt,players:[...w.players.values()].filter(p=>p.connected).map(pubPlayer),entities};
}
function broadcast(w){
  for(const p of w.players.values())if(p.connected){
    const base=snapshot(w,p);
    send(p.ws,{...base,you:pubPlayer(p),player:pubPlayer(p)});
  }
}`;

if(!runtime.includes(oldSnapshot)){
  throw new Error('Bandwidth entry: no se encontró snapshot/broadcast esperado');
}
runtime=runtime.replace(oldSnapshot,newSnapshot);
await fs.writeFile(RUNTIME,runtime,'utf8');

let server=await fs.readFile(SERVER,'utf8');
const oldWss="const wss=new WebSocketServer({server,path:'/ws'});";
const newWss="const wss=new WebSocketServer({server,path:'/ws',perMessageDeflate:{threshold:1024,clientNoContextTakeover:false,serverNoContextTakeover:false}});";
if(!server.includes(oldWss))throw new Error('Bandwidth entry: no se encontró WebSocketServer esperado');
server=server.replace(oldWss,newWss);
await fs.writeFile(SERVER,server,'utf8');

console.log('NANY BANDWIDTH PATCH OK: 8Hz + 2400u interest radius + websocket compression');
await import(pathToFileURL(path.join(ROOT,'server-gameplay-entry.mjs')).href+`?bandwidth=${Date.now()}`);
