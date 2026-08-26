import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import {
  TICK_HZ,SNAP_HZ,MAX_PLAYERS,FISH_N,GEM_FISH_CAP,GEM_SPAWN_INTERVAL_MS,HEARTBEAT_MS,RESUME_MS,
  worlds,worldForMode,randomSpawn,stageLevel,teamFor,pubPlayer,snapshot,broadcast,sendAll,send,
  updateFish,updateBoss,combat,applyInput,tryConsume,tryBossHit,devSetMass,devSetStage,safeName,makeId,makeDeviceId
} from './world-runtime.mjs';

const ROOT=path.dirname(new URL(import.meta.url).pathname);
const PORT=Number(process.env.PORT||10000);
const CLIENT_FILE=path.join(ROOT,'multiplayer-client.js');
const bridge='<script src="/multiplayer-client.js?v=10"></script>';
const DEV_CODE='7339';

const server=http.createServer(async(req,res)=>{
  try{
    const u=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`);
    if(u.pathname==='/health'){
      const activeGems=Object.fromEntries([...worlds].map(([k,w])=>[k,[...w.fish.values()].filter(f=>f.gemFish).length]));
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
      return res.end(JSON.stringify({ok:true,server:'live-authoritative-v10',worlds:['PVP','PVE','EQUIPO'],fishPerWorld:FISH_N,gemFishCap:GEM_FISH_CAP,gemSpawnIntervalMs:GEM_SPAWN_INTERVAL_MS,chaseMs:1000,activeGems,tickHz:TICK_HZ,snapshotHz:SNAP_HZ,stages:Object.fromEntries([...worlds].map(([k,w])=>[k,w.stage])),players:Object.fromEntries([...worlds].map(([k,w])=>[k,[...w.players.values()].filter(p=>p.connected).length]))}));
    }
    if(u.pathname==='/multiplayer-client.js'){const js=await fs.readFile(CLIENT_FILE,'utf8');res.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8','Cache-Control':'no-store'});return res.end(js);}
    if(u.pathname==='/'||u.pathname==='/index.html'){const html=await fs.readFile(path.join(ROOT,'index.html'),'utf8');res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});return res.end(html.replace('</head>',bridge+'</head>'));}
    res.writeHead(404);res.end('Not found');
  }catch(e){console.error(e);res.writeHead(500);res.end('Server error');}
});

const wss=new WebSocketServer({server,path:'/ws'});
wss.on('connection',ws=>{
  let player=null,world=null,joined=false;ws.isAlive=true;ws.on('pong',()=>ws.isAlive=true);
  ws.on('message',raw=>{
    let m;try{m=JSON.parse(raw.toString())}catch{return}
    if(m.type==='join'){
      if(joined)return;joined=true;const [code,mode]=worldForMode(m.mode);world=worlds.get(code);const deviceId=String(m.deviceId||''),resumeId=String(m.resumeId||'');let p=[...world.players.values()].find(x=>(deviceId&&x.deviceId===deviceId)||(resumeId&&x.resumeId===resumeId));
      if(p&&p.connected&&p.ws!==ws){try{p.ws.close(4001,'replaced-by-device-session')}catch{}}
      if(!p){if([...world.players.values()].filter(x=>x.connected).length>=MAX_PLAYERS){send(ws,{type:'error',message:'Servidor lleno'});return;}const pos=randomSpawn();p={id:deviceId||makeId('player'),resumeId:resumeId||makeId('resume'),deviceId:deviceId||makeDeviceId(),ws:null,connected:false,disconnectedAt:0,name:safeName(m.name),team:teamFor(world,m.team),x:pos.x,y:pos.y,lastX:pos.x,lastY:pos.y,vx:0,vy:0,angle:0,score:0,growthScore:0,level:stageLevel(world.stage),lives:1,alive:true,sprinting:false,pet:'none',devMode:false,lastInputAt:Date.now(),lastBossHitAt:0,invulnerableUntil:Date.now()+1500};world.players.set(p.id,p);}
      p.ws=ws;p.connected=true;p.disconnectedAt=0;p.name=safeName(m.name||p.name);p.team=p.team||teamFor(world,m.team);p.mode=mode;p.level=stageLevel(world.stage);p.lastInputAt=Date.now();player=p;send(ws,{...snapshot(world),type:'welcome',resumeId:p.resumeId,id:p.id,team:p.team,teamName:p.team==='A'?'Azul':p.team==='B'?'Rojo':null,you:pubPlayer(p),player:pubPlayer(p)});sendAll(world,{type:'player_joined',player:pubPlayer(p)});broadcast(world);return;
    }
    if(!player||!world)return;
    if(m.type==='state')applyInput(world,player,m);
    else if(m.type==='consume'){if(!tryConsume(world,player,m.entityId))send(ws,{type:'consume_rejected',entityId:String(m.entityId||''),serverTick:world.tick});}
    else if(m.type==='boss_hit'){if(!tryBossHit(world,player,m.bossId))send(ws,{type:'boss_hit_rejected',bossId:String(m.bossId||''),serverTick:world.tick});}
    else if(m.type==='dev_command'){
      if(String(m.code||'')!==DEV_CODE){send(ws,{type:'dev_ack',ok:false,message:'Código inválido'});return;}player.devMode=true;const action=String(m.action||'auth');
      if(action==='auth')send(ws,{type:'dev_ack',ok:true,action,message:'Modo desarrollador conectado al servidor'});
      else if(action==='mass'){const value=devSetMass(world,player,m.value);send(ws,{type:'dev_ack',ok:true,action,value,message:`Masa establecida en ${value}`});}
      else if(action==='stage'){const stage=devSetStage(world,m.stage);send(ws,{type:'dev_ack',ok:true,action,stage,message:`Stage ${stage} activado`});}
      else if(action==='exit'){player.devMode=false;send(ws,{type:'dev_ack',ok:true,action,message:'Modo desarrollador desactivado'});}
      else send(ws,{type:'dev_ack',ok:false,message:'Comando de desarrollador desconocido'});
    } else if(m.type==='leave')ws.close(1000,'leave');
  });
  ws.on('close',()=>{if(!player||!world||player.ws!==ws)return;player.connected=false;player.ws=null;player.disconnectedAt=Date.now();sendAll(world,{type:'player_left',id:player.id});broadcast(world);});
});

const hb=setInterval(()=>{for(const ws of wss.clients){if(ws.isAlive===false){ws.terminate();continue}ws.isAlive=false;try{ws.ping()}catch{}}for(const w of worlds.values())for(const [id,p] of w.players){if(!p.connected&&p.disconnectedAt&&Date.now()-p.disconnectedAt>RESUME_MS)w.players.delete(id);}},HEARTBEAT_MS);hb.unref?.();
let last=Date.now(),nextSnap=Date.now();
setInterval(()=>{const now=Date.now(),dt=Math.min(.05,(now-last)/1000);last=now;for(const w of worlds.values()){w.tick++;updateFish(w,dt);updateBoss(w,dt);combat(w);}if(now>=nextSnap){nextSnap=now+1000/SNAP_HZ;for(const w of worlds.values())broadcast(w);}},1000/TICK_HZ);
server.listen(PORT,'0.0.0.0',()=>console.log(`NANY LIVE AUTHORITATIVE V10 ${PORT}`));