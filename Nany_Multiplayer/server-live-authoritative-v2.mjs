import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const PORT = Number(process.env.PORT || 10000);
const W = 12000, H = 12000;
const TICK_HZ = 30, SNAP_HZ = 20;
const MAX_PLAYERS = 8, FISH_N = 260;
const HEARTBEAT_MS = 15000, RESUME_MS = 10 * 60 * 1000, RESPAWN_MS = 1500;

const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const send=(ws,m)=>{ if(ws?.readyState===WebSocket.OPEN) ws.send(JSON.stringify(m)); };
const sendAll=(w,m)=>{ for(const p of w.players.values()) if(p.connected) send(p.ws,m); };
const safeName=v=>String(v||'Nany').trim().slice(0,18)||'Nany';
const worldForMode=v=>v==='ffa'||v==='pvp'?['PVP','ffa']:v==='coop'||v==='pve'?['PVE','coop']:['EQUIPO','teams'];
const power=s=>s<100?1:s<250?2:s<500?3:s<900?4:s<1500?5:s<2500?6:s<4000?7:s<6000?8:s<9000?9:10;
const radius=s=>clamp(11+Math.sqrt(Math.max(0,s))*0.62,11,320);
const playerHB=s=>radius(s)*0.78;
const fishHB=f=>Math.max(2.5,f.size*0.88);
const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const makeId=p=>`${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const TYPES=[
  {key:'plankton',role:'prey',power:1,points:5,color:'#8fffb0',size:3,speed:.30},
  {key:'minnow',role:'prey',power:2,points:10,color:'#bfe6ff',size:7,speed:.90},
  {key:'green',role:'prey',power:3,points:20,color:'#39ff6a',size:9,speed:1.60},
  {key:'piranha',role:'predator',power:4,points:35,color:'#ff8a3d',size:12,speed:1.70},
  {key:'stick',role:'predator',power:5,points:50,color:'#e0c66a',size:15,speed:.70},
  {key:'rival',role:'predator',power:6,points:75,color:'#a084ff',size:19,speed:1.10},
  {key:'shark',role:'predator',power:8,points:150,color:'#6d8796',size:28,speed:1.40},
  {key:'monster',role:'predator',power:10,points:300,color:'#8d2638',size:40,speed:1.10}
];
const typeAt=i=>i<120?TYPES[0]:i<170?TYPES[1]:i<200?TYPES[2]:i<225?TYPES[3]:i<245?TYPES[4]:i<258?TYPES[5]:i===258?TYPES[6]:TYPES[7];

function rng(seed){let s=(seed>>>0)||1;return()=>{s^=s<<13;s>>>=0;s^=s>>>17;s>>>=0;return((s^=s<<5)>>>0)/4294967296;};}
function makeFish(w,index,r=Math.random){
  const t=typeAt(index),a=r()*Math.PI*2,s=t.speed*(.82+r()*.30),id=`${w.code}-fish-${index}-${w.nextFish++}`;
  return {id,index,type:t.key,role:t.role,power:t.power,points:t.points,color:t.color,size:t.size*(.88+r()*.24),speed:s,
    x:160+r()*(W-320),y:160+r()*(H-320),vx:Math.cos(a)*s*.55,vy:Math.sin(a)*s*.55,angle:a,heading:a,
    turn:.8+r()*1.7,chaseId:null,chaseUntil:0,cooldownUntil:0};
}
function makeWorld(code,mode){
  const w={code,mode,seed:(Math.random()*0xffffffff)>>>0,epoch:Date.now(),stage:0,tick:0,nextFish:1,players:new Map(),fish:new Map(),respawns:[]};
  const r=rng(w.seed);for(let i=0;i<FISH_N;i++){const f=makeFish(w,i,r);w.fish.set(f.id,f);}return w;
}
const worlds=new Map([['PVP',makeWorld('PVP','ffa')],['PVE',makeWorld('PVE','coop')],['EQUIPO',makeWorld('EQUIPO','teams')]]);

function teamFor(w,want){
  if(w.mode!=='teams')return null;
  const a=[...w.players.values()].filter(p=>p.connected&&p.team==='A').length,b=[...w.players.values()].filter(p=>p.connected&&p.team==='B').length;
  if((want==='A'||want==='B')&&Math.abs(a-b)<=1)return want;return a<=b?'A':'B';
}
function randomSpawn(){
  const margin=500;
  return{x:margin+Math.random()*(W-margin*2),y:margin+Math.random()*(H-margin*2)};
}
function stageLevel(stage){return stage<2?1:stage<4?2:3;}
function pubPlayer(p){
  return{id:p.id,name:p.name,deviceId:p.deviceId,x:+p.x.toFixed(2),y:+p.y.toFixed(2),vx:+p.vx.toFixed(2),vy:+p.vy.toFixed(2),angle:+p.angle.toFixed(3),
    score:Math.floor(p.score),growthScore:Math.floor(p.growthScore),radius:+radius(p.growthScore).toFixed(2),power:power(p.growthScore),level:p.level,lives:p.lives,
    alive:p.alive,sprinting:p.sprinting,team:p.team||null,teamName:p.team==='A'?'Azul':p.team==='B'?'Rojo':null};
}
function pubFish(f){return{id:f.id,sharedId:f.id,type:f.type,role:f.role,power:f.power,points:f.points,size:+f.size.toFixed(2),color:f.color,x:+f.x.toFixed(2),y:+f.y.toFixed(2),vx:+f.vx.toFixed(4),vy:+f.vy.toFixed(4),angle:+f.angle.toFixed(4)};}
function snapshot(w){
  return{type:'snapshot',room:w.code,mode:w.mode,population:[...w.players.values()].filter(p=>p.connected).length,serverTick:w.tick,serverTime:Date.now(),
    worldSeed:w.seed,worldEpoch:w.epoch,worldStage:w.stage,boss:null,removed:[],players:[...w.players.values()].filter(p=>p.connected).map(pubPlayer),entities:[...w.fish.values()].map(pubFish)};
}
function broadcast(w){const base=snapshot(w);for(const p of w.players.values())if(p.connected)send(p.ws,{...base,you:pubPlayer(p),player:pubPlayer(p)});}
function broadcastStage(w){sendAll(w,{type:'world_stage',stage:w.stage,serverTime:Date.now(),worldSeed:w.seed,worldEpoch:w.epoch});broadcast(w);}
function maybeAdvanceStage(w){
  if(w.stage===0){
    const maxScore=Math.max(0,...[...w.players.values()].map(p=>p.score||0));
    if(maxScore>=1000){w.stage=1;broadcastStage(w);}
  }else if(w.stage===2){
    const maxScore=Math.max(0,...[...w.players.values()].map(p=>p.score||0));
    if(maxScore>=3000){w.stage=3;broadcastStage(w);}
  }
}
function canPlayerEat(p,f){return f.role==='prey' && fishHB(f)<playerHB(p.growthScore)*0.96;}
function canFishEatPlayer(p,f){return f.role==='predator' && fishHB(f)>=playerHB(p.growthScore)*1.04;}

function updateFish(w,dt){
  if(w.stage===1||w.stage===3)return;
  const now=Date.now(),players=[...w.players.values()].filter(p=>p.connected&&p.alive);
  for(let i=w.respawns.length-1;i>=0;i--){
    const rr=w.respawns[i];if(now<rr.at)continue;
    const f=makeFish(w,rr.index);w.fish.set(f.id,f);w.respawns.splice(i,1);
  }
  for(const f of w.fish.values()){
    let target=f.chaseId&&f.chaseUntil>now?w.players.get(f.chaseId):null;
    if(target&&(!target.connected||!target.alive||f.role!=='predator'))target=null;
    if(f.role==='predator'&&!target&&f.cooldownUntil<=now){
      let best=null,bd=Infinity;
      for(const p of players){
        const dd=dist(f,p);
        if(canFishEatPlayer(p,f)&&dd<340&&dd<bd){best=p;bd=dd;}
      }
      if(best){target=best;f.chaseId=best.id;f.chaseUntil=now+1000;}
    }
    if(f.chaseId&&f.chaseUntil<=now){f.chaseId=null;f.cooldownUntil=now+5000;target=null;}
    if(target){
      const a=Math.atan2(target.y-f.y,target.x-f.x),k=.24;
      f.vx+=Math.cos(a)*f.speed*k;f.vy+=Math.sin(a)*f.speed*k;
    }else if(f.turn<=0){
      f.turn=.8+Math.random()*1.8;f.heading+=(Math.random()-.5)*1.1;
      f.vx+=Math.cos(f.heading)*f.speed*.16;f.vy+=Math.sin(f.heading)*f.speed*.16;
    }else f.turn-=dt;
    const sp=Math.hypot(f.vx,f.vy)||.0001;
    if(sp>f.speed){f.vx=f.vx/sp*f.speed;f.vy=f.vy/sp*f.speed;}
    f.x=clamp(f.x+f.vx*dt*60,80,W-80);f.y=clamp(f.y+f.vy*dt*60,80,H-80);
    if(f.x<=80||f.x>=W-80){f.vx*=-1;f.heading=Math.PI-f.heading;}
    if(f.y<=80||f.y>=H-80){f.vy*=-1;f.heading=-f.heading;}
    f.angle=Math.atan2(f.vy,f.vx);
  }
}

function killPlayer(w,p,reason,eater=null,killerFish=null){
  if(!p.alive)return;
  p.alive=false;p.vx=0;p.vy=0;
  const victim=pubPlayer(p),eaterPub=eater?pubPlayer(eater):null,killerFishPub=killerFish?pubFish(killerFish):null;
  sendAll(w,{type:'player_death',victimId:p.id,victim,reason,eaterId:eater?.id||null,eater:eaterPub,killerFish:killerFishPub,serverTime:Date.now()});
  if(eater)sendAll(w,{type:'player_eaten',victimId:p.id,victim,eaterId:eater.id,eater:eaterPub,reason,serverTime:Date.now()});
  send(p.ws,{type:'player_dead',id:p.id,reason});broadcast(w);
  setTimeout(()=>{
    const q=w.players.get(p.id);if(!q)return;const pos=randomSpawn();
    q.x=pos.x;q.y=pos.y;q.lastX=pos.x;q.lastY=pos.y;q.vx=0;q.vy=0;
    q.score=Math.max(0,Math.floor(q.score*.5));q.growthScore=Math.max(0,Math.floor(q.growthScore*.5));
    q.alive=true;q.lives=Math.max(1,q.lives);q.invulnerableUntil=Date.now()+1500;q.lastInputAt=Date.now();
    send(q.ws,{type:'respawn',player:pubPlayer(q)});broadcast(w);
  },1000);
}
function removeFish(w,p,f){
  if(!w.fish.has(f.id))return false;
  const eaten=pubFish(f);w.fish.delete(f.id);p.score+=f.points;p.growthScore+=f.points;
  w.respawns.push({index:f.index,at:Date.now()+RESPAWN_MS});
  sendAll(w,{type:'entity_removed',entityId:f.id,entity:eaten,by:p.id,eater:pubPlayer(p),serverTick:w.tick,serverTime:Date.now()});
  return true;
}
function tryConsume(w,p,id){
  const f=w.fish.get(String(id||''));if(!f||!p.connected||!p.alive)return false;
  const reach=playerHB(p.growthScore)+fishHB(f)+72;
  if(dist(p,f)>reach||!canPlayerEat(p,f))return false;
  const ok=removeFish(w,p,f);if(ok){maybeAdvanceStage(w);broadcast(w);}return ok;
}
function combat(w){
  if(w.stage===1||w.stage===3)return;
  const now=Date.now();
  for(const p of w.players.values()){
    if(!p.connected||!p.alive||p.invulnerableUntil>now)continue;
    const ph=playerHB(p.growthScore);
    for(const f of [...w.fish.values()]){
      const fh=fishHB(f),dd=dist(p,f);if(dd>ph+fh)continue;
      if(canPlayerEat(p,f)){removeFish(w,p,f);continue;}
      if(canFishEatPlayer(p,f)){
        p.lives=Math.max(0,p.lives-1);p.score=Math.max(0,Math.floor(p.score*.5));p.growthScore=Math.max(0,Math.floor(p.growthScore*.5));p.invulnerableUntil=now+2500;
        if(p.lives<=0)killPlayer(w,p,'fish',null,f);
        break;
      }
    }
  }
  const ps=[...w.players.values()].filter(p=>p.connected&&p.alive);
  for(let i=0;i<ps.length;i++)for(let j=i+1;j<ps.length;j++){
    const a=ps[i],b=ps[j];
    if(w.mode==='coop'||(w.mode==='teams'&&a.team===b.team))continue;
    const dd=dist(a,b),ar=radius(a.growthScore),br=radius(b.growthScore);if(dd>ar*.82+br*.82)continue;
    if(a.score>=b.score+1&&ar>br){a.score+=Math.max(10,Math.floor(b.score*.25));a.growthScore+=Math.max(10,Math.floor(b.growthScore*.25));killPlayer(w,b,'player',a);}
    else if(b.score>=a.score+1&&br>ar){b.score+=Math.max(10,Math.floor(a.score*.25));b.growthScore+=Math.max(10,Math.floor(a.growthScore*.25));killPlayer(w,a,'player',b);}
  }
  maybeAdvanceStage(w);
}

function applyInput(p,m){
  const x=Number(m.x),y=Number(m.y),now=Date.now();if(!Number.isFinite(x)||!Number.isFinite(y)||!p.alive)return;
  const dt=Math.max(.016,Math.min(.35,(now-p.lastInputAt)/1000)),dx=x-p.x,dy=y-p.y,dd=Math.hypot(dx,dy);
  const maxPerSecond=p.sprinting?3200:1800,allowed=Math.max(120,maxPerSecond*dt),ratio=dd>allowed&&dd>0?allowed/dd:1;
  const nx=clamp(p.x+dx*ratio,0,W),ny=clamp(p.y+dy*ratio,0,H);
  p.vx=(nx-p.x)/Math.max(dt,0.001)/60;p.vy=(ny-p.y)/Math.max(dt,0.001)/60;
  p.x=nx;p.y=ny;p.lastX=x;p.lastY=y;p.angle=Number.isFinite(Number(m.angle))?Number(m.angle):Math.atan2(p.vy,p.vx);p.sprinting=!!m.sprinting;p.lastInputAt=now;
}
function makeDeviceId(){return`nany-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;}

const bridge=`<script>(()=>{const Native=window.WebSocket,BUF='__NANY_LIVE_BUF__',DEVICE='__NANY_DEVICE__',PENDING=new Set(),FX=[],DEAD=new Map();
const device=()=>{let d=localStorage.getItem(DEVICE);if(!d){d=(${makeDeviceId.toString()})();localStorage.setItem(DEVICE,d)}return d};window.__NANY_DEVICE_ID__=device();
const addFx=fx=>{FX.push({...fx,start:performance.now()});while(FX.length>40)FX.shift()};
function localDeath(reason){try{const g=window.eval('typeof game!==\"undefined\"?game:null'),fn=window.eval('typeof showDeathBite===\"function\"?showDeathBite:null');if(!g?.player||g.player._takingDamage)return;g.player._takingDamage=true;if(fn)fn(true,()=>{});g.camShake=10;const audio=window.eval('typeof AudioSys!==\"undefined\"?AudioSys:null');audio?.hurt?.();const floater=window.eval('typeof spawnFloater===\"function\"?spawnFloater:null');floater?.(g.player.x,g.player.y-28,reason==='player'?'¡TE COMIÓ OTRO JUGADOR!':'¡TE COMIÓ UN PEZ!','#ff7d6b')}catch{}}
function onServerEvent(m){
  if(m.type==='entity_removed'){if(m.entityId)PENDING.add(String(m.entityId));if(m.eater&&m.entity)addFx({kind:'eatFish',x:m.eater.x,y:m.eater.y,tx:m.entity.x,ty:m.entity.y,duration:480})}
  if(m.type==='player_eaten'&&m.eater&&m.victim)addFx({kind:'eatPlayer',x:m.eater.x,y:m.eater.y,tx:m.victim.x,ty:m.victim.y,size:m.eater.radius||18,duration:650});
  if(m.type==='player_death'&&m.victim){const key=String(m.victimId||m.victim.id),now=performance.now();if(!DEAD.has(key)||now-DEAD.get(key)>500){DEAD.set(key,now);addFx({kind:'death',x:m.victim.x,y:m.victim.y,size:m.victim.radius||18,reason:m.reason,kx:m.killerFish?.x??m.eater?.x,ky:m.killerFish?.y??m.eater?.y,duration:950})}try{const latest=(window[BUF]||[]).at(-1)?.m,myId=latest?.you?.id||latest?.player?.id;if(myId&&String(myId)===key&&m.reason!=='player')localDeath(m.reason)}catch{}}
}
function WrappedWS(url,protocols){
  let real=null,stopped=false,retry=0,join=null,lastState=null,api;const ev={open:new Set(),message:new Set(),close:new Set(),error:new Set()};
  const emit=(t,e)=>{for(const f of ev[t]||[])try{f.call(api,e)}catch{}const h=api['on'+t];if(typeof h==='function')try{h.call(api,e)}catch{}};
  api={};Object.setPrototypeOf(api,Native.prototype);Object.defineProperty(api,'readyState',{get:()=>stopped?3:(real?.readyState??0)});Object.defineProperty(api,'url',{value:url});api.addEventListener=(t,f)=>ev[t]?.add(f);api.removeEventListener=(t,f)=>ev[t]?.delete(f);
  api.send=data=>{let out=data;try{const m=JSON.parse(data);if(m.type==='join'){join={...m,deviceId:device(),resumeId:localStorage.getItem('__NANY_RESUME_ID__')||null};localStorage.setItem('__NANY_JOIN__',JSON.stringify(join));out=JSON.stringify(join)}if(m.type==='state')lastState=m;if(m.type==='consume'&&m.entityId)PENDING.add(String(m.entityId))}catch{}if(real?.readyState===1)real.send(out)};
  api.close=()=>{stopped=true;try{real?.close()}catch{}emit('close',new Event('close'))};
  function connect(){if(stopped)return;real=protocols===undefined?new Native(url):new Native(url,protocols);real.addEventListener('open',()=>{retry=0;let j=join;try{j=j||JSON.parse(localStorage.getItem('__NANY_JOIN__')||'null')}catch{}if(j)real.send(JSON.stringify(j));if(lastState)real.send(JSON.stringify(lastState));emit('open',new Event('open'))});real.addEventListener('message',e=>{try{const m=JSON.parse(e.data);onServerEvent(m);if(m.type==='welcome')localStorage.setItem('__NANY_RESUME_ID__',m.resumeId||m.id||'');if(m.type==='consume_rejected'&&m.entityId)PENDING.delete(String(m.entityId));if(m.type==='snapshot'||m.type==='welcome'){const b=window[BUF]||(window[BUF]=[]);b.push({recv:performance.now(),tick:Number(m.serverTick)||0,m});while(b.length>24)b.shift();const ids=new Set((m.entities||[]).map(f=>String(f.id)));for(const id of [...PENDING])if(!ids.has(id))PENDING.delete(id);const stage=Number(m.worldStage)||0;if(stage!==1&&stage!==3)window.__SERVER_SYNC_FISH__?.()}}catch{}emit('message',e)});real.addEventListener('close',e=>{if(stopped){emit('close',e);return}setTimeout(connect,Math.min(4000,250*Math.pow(1.45,retry++)))});real.addEventListener('error',e=>{if(stopped)emit('error',e)})}
  connect();return api;
}
for(const k of ['CONNECTING','OPEN','CLOSING','CLOSED'])WrappedWS[k]=Native[k];WrappedWS.prototype=Native.prototype;window.WebSocket=WrappedWS;window.__SERVER_AUTHORITATIVE_FISH__=true;
window.__SERVER_SYNC_FISH__=function(){try{const g=window.eval('typeof game!==\"undefined\"?game:null'),b=window[BUF]||[];if(!g||!b.length)return;const B0=b[b.length-1],stage=Number(B0.m?.worldStage)||0;if(stage===1||stage===3)return;const renderAt=performance.now()-80;let B=B0,A=B;for(let i=b.length-1;i>=0;i--){if(b[i].recv<=renderAt){A=b[i];break}}const bm=B.m,am=A.m,span=Math.max(1,B.recv-A.recv),alpha=A===B?1:Math.max(0,Math.min(1,(renderAt-A.recv)/span));const old=new Map((am.entities||[]).map(f=>[f.id,f])),out=[];for(const fb of bm.entities||[]){if(PENDING.has(String(fb.id)))continue;const fa=old.get(fb.id)||fb,sp=Math.max(.1,Math.hypot(Number(fb.vx)||0,Number(fb.vy)||0));out.push({sharedId:fb.id,serverId:fb.id,type:fb.type,family:fb.type,variant:fb.role==='predator'?'big':'small',renderKey:fb.type,power:fb.power,tier:fb.power||0,ecologyRole:fb.role,size:fb.size,baseSize:fb.size,points:fb.points,color:fb.color,behavior:fb.role==='predator'?'aggro':'drift',hazard:null,speed:sp,x:fa.x+(fb.x-fa.x)*alpha,y:fa.y+(fb.y-fa.y)*alpha,vx:fb.vx,vy:fb.vy,angle:fb.angle,wobble:(Number(fb.angle)||0)+performance.now()/700,finPhase:performance.now()/180,life:0,coin:false,_chasing:false,_chaseTime:0,_attackCooldown:0})}g.entities=out;const me=bm.you||bm.player||am.you||am.player;if(me){g.score=Number(me.score)||0;g.growthScore=Number(me.growthScore)||0;g.lives=Number(me.lives)||0}}catch{}};
function drawFx(){try{const ctx=window.eval('typeof ctx!==\"undefined\"?ctx:null');if(!ctx)return;const now=performance.now();for(let i=FX.length-1;i>=0;i--){const f=FX[i],t=(now-f.start)/(f.duration||800);if(t>=1){FX.splice(i,1);continue}const fade=1-t;if(f.kind==='death'){const s=Math.max(12,Number(f.size)||18);ctx.save();ctx.translate(f.x,f.y);ctx.globalAlpha=fade;for(let k=0;k<4;k++){const a=(k/4)*Math.PI*2+0.5,rr=s*(.25+t*1.65);ctx.save();ctx.translate(Math.cos(a)*rr,Math.sin(a)*rr);ctx.rotate(a+t*3);ctx.fillStyle=k%2?'#ff6a4d':'#dff7f5';ctx.beginPath();ctx.ellipse(0,0,s*.48,s*.20,0,0,Math.PI*2);ctx.fill();ctx.restore()}ctx.strokeStyle='rgba(255,70,70,'+(fade*.8)+')';ctx.lineWidth=Math.max(2,s*.08);ctx.beginPath();ctx.arc(0,0,s*(.6+t*1.5),0,Math.PI*2);ctx.stroke();ctx.restore()}else if(f.kind==='eatPlayer'||f.kind==='eatFish'){const dx=(f.tx??f.x)-f.x,dy=(f.ty??f.y)-f.y,a=Math.atan2(dy,dx),s=Math.max(12,Number(f.size)||16);ctx.save();ctx.translate(f.x,f.y);ctx.rotate(a);ctx.globalAlpha=fade;const close=Math.sin(Math.min(1,t)*Math.PI);ctx.strokeStyle=f.kind==='eatPlayer'?'#ff6a4d':'#ffd23f';ctx.lineWidth=Math.max(2,s*.12);ctx.beginPath();ctx.arc(s*.25,0,s*(.65+.12*close),-.78,-.12);ctx.stroke();ctx.beginPath();ctx.arc(s*.25,0,s*(.65+.12*close),.12,.78);ctx.stroke();ctx.fillStyle='rgba(255,255,255,'+(fade*.8)+')';ctx.beginPath();ctx.arc(s*(.7+.45*close),0,Math.max(2,s*.12),0,Math.PI*2);ctx.fill();ctx.restore()}}}catch{}};
const patch=setInterval(()=>{try{const sw=window.eval('typeof SharedWorld!==\"undefined\"?SharedWorld:null');if(sw&&!sw.__serverPatched){const original=sw.update.bind(sw);sw.__serverOriginalUpdate=original;sw.update=function(dt){const b=window[BUF]||[],m=b.length?b[b.length-1].m:null,stage=Number(m?.worldStage)||0;if(stage===1||stage===3)return original(dt);return window.__SERVER_SYNC_FISH__()};sw.__serverPatched=true}if(!window.__NANY_COLLISION_PATCHED__){const hc=window.eval('typeof handleCollisions===\"function\"?handleCollisions:null'),mp=window.eval('typeof Multiplayer!==\"undefined\"?Multiplayer:null');if(hc&&mp){window.__NANY_ORIGINAL_COLLISIONS__=hc;window.__NANY_MP_COLLISIONS__=function(){try{if(!mp.isConnected())return window.__NANY_ORIGINAL_COLLISIONS__();const b=window[BUF]||[],stage=Number(b.at(-1)?.m?.worldStage)||0;if(stage===1||stage===3)return window.__NANY_ORIGINAL_COLLISIONS__();const g=window.eval('typeof game!==\"undefined\"?game:null');if(!g?.player)return;const p=g.player,ph=window.eval('playerHitbox()');for(const e of g.entities||[]){if(!e?.sharedId||PENDING.has(String(e.sharedId)))continue;const fh=window.eval('fishHitbox')(e),dd=Math.hypot(e.x-p.x,e.y-p.y);if(dd>ph+fh)continue;if(e.ecologyRole==='prey'&&fh<ph*.96){PENDING.add(String(e.sharedId));try{mp.consumeEntity(e.sharedId,e.points||1)}catch{}}}}catch{}};window.eval('handleCollisions=window.__NANY_MP_COLLISIONS__');window.__NANY_COLLISION_PATCHED__=true}}if(!window.__NANY_DRAW_PATCHED__){const mp=window.eval('typeof Multiplayer!==\"undefined\"?Multiplayer:null');if(mp?.drawRemotePlayers){const originalDraw=mp.drawRemotePlayers.bind(mp);mp.drawRemotePlayers=function(){originalDraw();drawFx()};window.__NANY_DRAW_PATCHED__=true}}if(sw?.__serverPatched&&window.__NANY_COLLISION_PATCHED__&&window.__NANY_DRAW_PATCHED__)clearInterval(patch)}catch{}},50);
})();</script>`;

const server=http.createServer(async(req,res)=>{
  try{
    const u=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`);
    if(u.pathname==='/health'){
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
      return res.end(JSON.stringify({ok:true,server:'live-authoritative-v6',worlds:['PVP','PVE','EQUIPO'],fishPerWorld:FISH_N,tickHz:TICK_HZ,snapshotHz:SNAP_HZ,
        stages:Object.fromEntries([...worlds].map(([k,w])=>[k,w.stage])),players:Object.fromEntries([...worlds].map(([k,w])=>[k,[...w.players.values()].filter(p=>p.connected).length]))}));
    }
    if(u.pathname==='/'||u.pathname==='/index.html'){
      const html=await fs.readFile(path.join(ROOT,'index.html'),'utf8');res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});return res.end(html.replace('</head>',bridge+'</head>'));
    }
    res.writeHead(404);res.end('Not found');
  }catch(e){console.error(e);res.writeHead(500);res.end('Server error');}
});

const wss=new WebSocketServer({server,path:'/ws'});
wss.on('connection',ws=>{
  let player=null,world=null,joined=false;ws.isAlive=true;ws.on('pong',()=>ws.isAlive=true);
  ws.on('message',raw=>{
    let m;try{m=JSON.parse(raw.toString())}catch{return}
    if(m.type==='join'){
      if(joined)return;joined=true;const [code,mode]=worldForMode(m.mode);world=worlds.get(code);const deviceId=String(m.deviceId||''),resumeId=String(m.resumeId||'');
      let p=[...world.players.values()].find(x=>(deviceId&&x.deviceId===deviceId)||(resumeId&&x.resumeId===resumeId));
      if(p&&p.connected&&p.ws!==ws){try{p.ws.close(4001,'replaced-by-device-session')}catch{}}
      if(!p){
        if([...world.players.values()].filter(x=>x.connected).length>=MAX_PLAYERS){send(ws,{type:'error',message:'Servidor lleno'});return;}
        const pos=randomSpawn();p={id:deviceId||makeId('player'),resumeId:resumeId||makeId('resume'),deviceId:deviceId||makeDeviceId(),ws:null,connected:false,disconnectedAt:0,
          name:safeName(m.name),team:teamFor(world,m.team),x:pos.x,y:pos.y,lastX:pos.x,lastY:pos.y,vx:0,vy:0,angle:0,score:0,growthScore:0,level:1,lives:1,alive:true,
          sprinting:false,lastInputAt:Date.now(),invulnerableUntil:Date.now()+1200};world.players.set(p.id,p);
      }
      p.ws=ws;p.connected=true;p.disconnectedAt=0;p.name=safeName(m.name||p.name);p.team=p.team||teamFor(world,m.team);p.mode=mode;p.level=stageLevel(world.stage);p.lastInputAt=Date.now();player=p;
      send(ws,{...snapshot(world),type:'welcome',resumeId:p.resumeId,id:p.id,team:p.team,teamName:p.team==='A'?'Azul':p.team==='B'?'Rojo':null,you:pubPlayer(p),player:pubPlayer(p)});
      sendAll(world,{type:'player_joined',player:pubPlayer(p)});broadcast(world);return;
    }
    if(!player||!world)return;
    if(m.type==='state')applyInput(player,m);
    else if(m.type==='consume'){if(!tryConsume(world,player,m.entityId))send(ws,{type:'consume_rejected',entityId:String(m.entityId||''),serverTick:world.tick});}
    else if(m.type==='boss_defeated'){
      if(world.stage===1){world.stage=2;for(const p of world.players.values()){p.growthScore=0;p.level=2;}}
      else if(world.stage===3){world.stage=4;for(const p of world.players.values())p.level=3;}
      broadcastStage(world);
    }else if(m.type==='leave')ws.close(1000,'leave');
  });
  ws.on('close',()=>{if(!player||!world||player.ws!==ws)return;player.connected=false;player.ws=null;player.disconnectedAt=Date.now();sendAll(world,{type:'player_left',id:player.id});broadcast(world);});
});

const hb=setInterval(()=>{
  for(const ws of wss.clients){if(ws.isAlive===false){ws.terminate();continue}ws.isAlive=false;try{ws.ping()}catch{}}
  for(const w of worlds.values())for(const [id,p] of w.players){if(!p.connected&&p.disconnectedAt&&Date.now()-p.disconnectedAt>RESUME_MS)w.players.delete(id);}
},HEARTBEAT_MS);hb.unref?.();

let last=Date.now(),nextSnap=Date.now();
setInterval(()=>{
  const now=Date.now(),dt=Math.min(.05,(now-last)/1000);last=now;
  for(const w of worlds.values()){w.tick++;updateFish(w,dt);combat(w);}
  if(now>=nextSnap){nextSnap=now+1000/SNAP_HZ;for(const w of worlds.values())broadcast(w);}
},1000/TICK_HZ);

server.listen(PORT,'0.0.0.0',()=>console.log(`NANY LIVE AUTHORITATIVE V6 ${PORT}`));