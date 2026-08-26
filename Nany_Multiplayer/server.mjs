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
const bridge='<script src="/multiplayer-client.js?v=11"></script>';
const DEV_CODE='7339';
const WORLD_W=12000,WORLD_H=12000;

const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));

function originalPlayerRadius(score){
  const x=Math.max(0,Number(score)||0);
  if(x<200) return 11+x*0.010;
  if(x<500) return 13+(x-200)*0.020;
  if(x<1000) return 19+(x-500)*0.025;
  if(x<2500) return 31.5+(x-1000)*0.018;
  if(x<4500) return 58.5+(x-2500)*0.014;
  if(x<7000) return 86.5+(x-4500)*0.011;
  if(x<10000) return 114+(x-7000)*0.009;
  return 141+Math.min(35,(x-10000)*0.006);
}
function anchorPlayer(w,preferred=null){
  if(preferred?.connected) return preferred;
  const list=[...w.players.values()].filter(p=>p.connected&&p.alive);
  return list.sort((a,b)=>(b.score||0)-(a.score||0))[0]||[...w.players.values()].find(p=>p.connected)||null;
}
function configureBossLikeOriginal(w,preferred=null){
  const b=w.boss;
  if(!b||b.__originalConfigured||(b.bossType!=='shrimp'&&b.bossType!=='lava')) return;
  const p=anchorPlayer(w,preferred);
  if(!p) return;
  const a=Math.random()*Math.PI*2,r=520;
  b.x=clamp(p.x+Math.cos(a)*r,300,WORLD_W-300);
  b.y=clamp(p.y+Math.sin(a)*r,300,WORLD_H-300);
  b.size=Math.max(92,originalPlayerRadius(p.growthScore)*(b.bossType==='shrimp'?2.15:2.35));
  b.speed=b.bossType==='shrimp'?1.72:1.68;
  b.vx=Math.cos(a)*0.7;b.vy=Math.sin(a)*0.7;
  b.angle=a;b.heading=a;
  b.chasing=false;b.chaseId=null;b.chaseUntil=0;b.cooldownUntil=0;
  b.__chaseStartedAt=0;b.__originalConfigured=true;
  if(b.bossType==='shrimp') b.vulnerableUntil=Infinity;
}
function stopShrimpChase(w,b,now,target){
  const away=target?Math.atan2(b.y-target.y,b.x-target.x):(b.angle||0)+Math.PI;
  b.chasing=false;b.chaseId=null;b.chaseUntil=0;b.__chaseStartedAt=0;
  b.cooldownUntil=now+3800;
  b.heading=away+(Math.random()-.5)*0.35;
  b.vx=Math.cos(b.heading)*b.speed*0.62;
  b.vy=Math.sin(b.heading)*b.speed*0.62;
}
function enforceOriginalShrimp(w,now){
  const b=w.boss;
  if(!b||b.bossType!=='shrimp') return;
  let target=b.chaseId?w.players.get(b.chaseId):null;
  if(target&&(!target.connected||!target.alive)) target=null;

  if(b.chasing){
    if(!b.__chaseStartedAt) b.__chaseStartedAt=now;
    b.chaseUntil=Math.min(b.chaseUntil||Infinity,b.__chaseStartedAt+1000);
    if(!target||now>=b.__chaseStartedAt+1000||now>=b.chaseUntil){
      stopShrimpChase(w,b,now,target);
      return;
    }
    const a=Math.atan2(target.y-b.y,target.x-b.x);
    b.angle=a;b.heading=a;
    b.vx=Math.cos(a)*b.speed;b.vy=Math.sin(a)*b.speed;
    return;
  }

  b.__chaseStartedAt=0;
  if((b.cooldownUntil||0)<=now){
    let best=null,bd=Infinity;
    for(const p of w.players.values()){
      if(!p.connected||!p.alive||p.invulnerableUntil>now) continue;
      const d=Math.hypot(p.x-b.x,p.y-b.y);
      if(d<=225&&d<bd){best=p;bd=d;}
    }
    if(best){
      b.chasing=true;b.chaseId=best.id;b.__chaseStartedAt=now;b.chaseUntil=now+1000;
      const a=Math.atan2(best.y-b.y,best.x-b.x);
      b.angle=a;b.heading=a;b.vx=Math.cos(a)*b.speed;b.vy=Math.sin(a)*b.speed;
      return;
    }
  }

  const max=b.speed*0.62,sp=Math.hypot(b.vx,b.vy);
  if(sp>max&&sp>0){b.vx=b.vx/sp*max;b.vy=b.vy/sp*max;}
}

function originalBossTarget(b){
  const a=b.angle||Math.atan2(b.vy||0,b.vx||0)||0;
  if(b.bossType==='shrimp') return {x:b.x-Math.cos(a)*b.size*1.12,y:b.y-Math.sin(a)*b.size*1.12,r:b.size*0.34};
  return {x:b.x-Math.cos(a)*b.size*0.92,y:b.y-Math.sin(a)*b.size*0.92,r:b.size*0.30};
}
function tryOriginalBossHit(w,p,bossId){
  const b=w.boss;
  if(!b||b.id!==String(bossId||'')||!p.connected||!p.alive||w.bossCleared) return false;
  if(b.bossType!=='shrimp'&&b.bossType!=='lava') return tryBossHit(w,p,bossId);
  configureBossLikeOriginal(w,p);
  const now=Date.now();
  const vulnerable=b.bossType==='shrimp'||now<(b.vulnerableUntil||0);
  if(!vulnerable) return false;
  const t=originalBossTarget(b);
  const playerHB=originalPlayerRadius(p.growthScore)*0.78;
  // El index original usa playerHitbox + radio de cola. En red damos 28 px
  // de gracia para compensar interpolación/snapshot sin cambiar la zona visual.
  if(Math.hypot(p.x-t.x,p.y-t.y)>playerHB+t.r+28) return false;
  if(p.lastBossHitAt&&now-p.lastBossHitAt<850) return false;

  p.lastBossHitAt=now;
  b.hits=Math.min(5,(b.hits||0)+1);
  sendAll(w,{type:'boss_state',boss:snapshot(w).boss,by:p.id,serverTime:now});
  if(b.hits>=5){
    const type=b.bossType;
    w.bossCleared=true;
    w.boss=null;
    sendAll(w,{type:'boss_cleared',stage:w.stage,bossType:type,serverTime:now});
    broadcast(w);
  }
  return true;
}

function resetWorldAfterDeath(w){
  w.__resetScheduled=false;
  for(const p of w.players.values()){
    p.score=0;p.growthScore=0;p.level=1;p.lastBossHitAt=0;
  }
  // devSetStage(0) limpia boss/lava, reconstruye el cardumen y emite world_stage.
  devSetStage(w,0);
  sendAll(w,{type:'world_reset',stage:0,reason:'death',serverTime:Date.now()});
  broadcast(w);
}
function scheduleWorldResetOnDeath(w){
  if(w.__resetScheduled) return;
  if(![...w.players.values()].some(p=>p.connected&&!p.alive)) return;
  w.__resetScheduled=true;
  // El runtime manda respawn a los 1200 ms. Reiniciamos justo antes:
  // así nunca reaparece con "la mitad" de los puntos y el boss ya fue despawneado.
  setTimeout(()=>resetWorldAfterDeath(w),1150);
}

const server=http.createServer(async(req,res)=>{
  try{
    const u=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`);
    if(u.pathname==='/health'){
      const activeGems=Object.fromEntries([...worlds].map(([k,w])=>[k,[...w.fish.values()].filter(f=>f.gemFish).length]));
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
      return res.end(JSON.stringify({
        ok:true,server:'live-authoritative-v11',worlds:['PVP','PVE','EQUIPO'],
        fishPerWorld:FISH_N,gemFishCap:GEM_FISH_CAP,gemSpawnIntervalMs:GEM_SPAWN_INTERVAL_MS,
        chaseMs:1000,bossModel:'index-original',worldResetOnDeath:true,
        activeGems,tickHz:TICK_HZ,snapshotHz:SNAP_HZ,
        stages:Object.fromEntries([...worlds].map(([k,w])=>[k,w.stage])),
        players:Object.fromEntries([...worlds].map(([k,w])=>[k,[...w.players.values()].filter(p=>p.connected).length]))
      }));
    }
    if(u.pathname==='/multiplayer-client.js'){
      const js=await fs.readFile(CLIENT_FILE,'utf8');
      res.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8','Cache-Control':'no-store'});
      return res.end(js);
    }
    if(u.pathname==='/'||u.pathname==='/index.html'){
      const html=await fs.readFile(path.join(ROOT,'index.html'),'utf8');
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
      return res.end(html.replace('</head>',bridge+'</head>'));
    }
    res.writeHead(404);res.end('Not found');
  }catch(e){console.error(e);res.writeHead(500);res.end('Server error');}
});

const wss=new WebSocketServer({server,path:'/ws'});
wss.on('connection',ws=>{
  let player=null,world=null,joined=false;
  ws.isAlive=true;ws.on('pong',()=>ws.isAlive=true);
  ws.on('message',raw=>{
    let m;try{m=JSON.parse(raw.toString())}catch{return}
    if(m.type==='join'){
      if(joined)return;
      joined=true;
      const [code,mode]=worldForMode(m.mode);
      world=worlds.get(code);
      const deviceId=String(m.deviceId||''),resumeId=String(m.resumeId||'');
      let p=[...world.players.values()].find(x=>(deviceId&&x.deviceId===deviceId)||(resumeId&&x.resumeId===resumeId));
      if(p&&p.connected&&p.ws!==ws){try{p.ws.close(4001,'replaced-by-device-session')}catch{}}
      if(!p){
        if([...world.players.values()].filter(x=>x.connected).length>=MAX_PLAYERS){send(ws,{type:'error',message:'Servidor lleno'});return;}
        const pos=randomSpawn();
        p={
          id:deviceId||makeId('player'),resumeId:resumeId||makeId('resume'),deviceId:deviceId||makeDeviceId(),
          ws:null,connected:false,disconnectedAt:0,name:safeName(m.name),team:teamFor(world,m.team),
          x:pos.x,y:pos.y,lastX:pos.x,lastY:pos.y,vx:0,vy:0,angle:0,score:0,growthScore:0,
          level:stageLevel(world.stage),lives:1,alive:true,sprinting:false,pet:'none',devMode:false,
          lastInputAt:Date.now(),lastBossHitAt:0,invulnerableUntil:Date.now()+1500
        };
        world.players.set(p.id,p);
      }
      p.ws=ws;p.connected=true;p.disconnectedAt=0;p.name=safeName(m.name||p.name);
      p.team=p.team||teamFor(world,m.team);p.mode=mode;p.level=stageLevel(world.stage);
      p.lastInputAt=Date.now();player=p;
      configureBossLikeOriginal(world,p);
      send(ws,{...snapshot(world),type:'welcome',resumeId:p.resumeId,id:p.id,team:p.team,
        teamName:p.team==='A'?'Azul':p.team==='B'?'Rojo':null,you:pubPlayer(p),player:pubPlayer(p)});
      sendAll(world,{type:'player_joined',player:pubPlayer(p)});
      broadcast(world);
      return;
    }
    if(!player||!world)return;
    if(m.type==='state')applyInput(world,player,m);
    else if(m.type==='consume'){
      if(!tryConsume(world,player,m.entityId))send(ws,{type:'consume_rejected',entityId:String(m.entityId||''),serverTick:world.tick});
    }
    else if(m.type==='boss_hit'){
      if(!tryOriginalBossHit(world,player,m.bossId))send(ws,{type:'boss_hit_rejected',bossId:String(m.bossId||''),serverTick:world.tick});
    }
    else if(m.type==='dev_command'){
      if(String(m.code||'')!==DEV_CODE){send(ws,{type:'dev_ack',ok:false,message:'Código inválido'});return;}
      player.devMode=true;
      const action=String(m.action||'auth');
      if(action==='auth')send(ws,{type:'dev_ack',ok:true,action,message:'Modo desarrollador conectado al servidor'});
      else if(action==='mass'){
        const value=devSetMass(world,player,m.value);
        configureBossLikeOriginal(world,player);
        broadcast(world);
        send(ws,{type:'dev_ack',ok:true,action,value,message:`Masa establecida en ${value}`});
      }
      else if(action==='stage'){
        const stage=devSetStage(world,m.stage);
        configureBossLikeOriginal(world,player);
        broadcast(world);
        send(ws,{type:'dev_ack',ok:true,action,stage,message:`Stage ${stage} activado`});
      }
      else if(action==='exit'){
        player.devMode=false;
        send(ws,{type:'dev_ack',ok:true,action,message:'Modo desarrollador desactivado'});
      }
      else send(ws,{type:'dev_ack',ok:false,message:'Comando de desarrollador desconocido'});
    } else if(m.type==='leave')ws.close(1000,'leave');
  });
  ws.on('close',()=>{
    if(!player||!world||player.ws!==ws)return;
    player.connected=false;player.ws=null;player.disconnectedAt=Date.now();
    sendAll(world,{type:'player_left',id:player.id});broadcast(world);
  });
});

const hb=setInterval(()=>{
  for(const ws of wss.clients){
    if(ws.isAlive===false){ws.terminate();continue}
    ws.isAlive=false;try{ws.ping()}catch{}
  }
  for(const w of worlds.values()){
    for(const [id,p] of w.players){
      if(!p.connected&&p.disconnectedAt&&Date.now()-p.disconnectedAt>RESUME_MS)w.players.delete(id);
    }
  }
},HEARTBEAT_MS);
hb.unref?.();

let last=Date.now(),nextSnap=Date.now();
setInterval(()=>{
  const now=Date.now(),dt=Math.min(.05,(now-last)/1000);
  last=now;
  for(const w of worlds.values()){
    w.tick++;
    updateFish(w,dt);
    updateBoss(w,dt);
    combat(w);
    configureBossLikeOriginal(w);
    enforceOriginalShrimp(w,now);
    scheduleWorldResetOnDeath(w);
  }
  if(now>=nextSnap){
    nextSnap=now+1000/SNAP_HZ;
    for(const w of worlds.values())broadcast(w);
  }
},1000/TICK_HZ);

server.listen(PORT,'0.0.0.0',()=>console.log(`NANY LIVE AUTHORITATIVE V11 ${PORT}`));
