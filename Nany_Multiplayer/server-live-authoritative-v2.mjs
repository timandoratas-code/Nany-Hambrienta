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
    x:100+r()*(W-200),y:100+r()*(H-200),vx:Math.cos(a)*s*.55,vy:Math.sin(a)*s*.55,angle:a,heading:a,
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
function spawn(w){
  const ps=[...w.players.values()].filter(p=>p.connected&&p.alive);if(!ps.length)return{x:W/2,y:H/2};
  const p=ps[Math.floor(Math.random()*ps.length)],a=Math.random()*Math.PI*2,dd=100+Math.random()*120;
  return{x:clamp(p.x+Math.cos(a)*dd,100,W-100),y:clamp(p.y+Math.sin(a)*dd,100,H-100)};
}
function pubPlayer(p){
  return{id:p.id,name:p.name,deviceId:p.deviceId,x:+p.x.toFixed(2),y:+p.y.toFixed(2),vx:+p.vx.toFixed(2),vy:+p.vy.toFixed(2),angle:+p.angle.toFixed(3),
    score:Math.floor(p.score),growthScore:Math.floor(p.score),radius:+radius(p.score).toFixed(2),power:power(p.score),level:p.level,lives:p.lives,
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
  if(w.stage===0){const maxScore=Math.max(0,...[...w.players.values()].map(p=>p.score||0));if(maxScore>=1000){w.stage=1;broadcastStage(w);}}
  else if(w.stage===2){const maxScore=Math.max(0,...[...w.players.values()].map(p=>p.score||0));if(maxScore>=3000){w.stage=3;broadcastStage(w);}}
}

function updateFish(w,dt){
  if(w.stage===1||w.stage===3)return;
  const now=Date.now(),players=[...w.players.values()].filter(p=>p.connected&&p.alive);
  for(let i=w.respawns.length-1;i>=0;i--){const rr=w.respawns[i];if(now<rr.at)continue;const f=makeFish(w,rr.index);w.fish.set(f.id,f);w.respawns.splice(i,1);}
  for(const f of w.fish.values()){
    let target=f.chaseId&&f.chaseUntil>now?w.players.get(f.chaseId):null;if(target&&(!target.connected||!target.alive))target=null;
    if(!target&&f.cooldownUntil<=now){let best=null,bd=Infinity;for(const p of players){const dd=dist(f,p),pp=power(p.score),pr=radius(p.score),can=f.role==='predator'?f.power>pp&&f.size>pr*1.02&&dd<340:pp>f.power&&pr>f.size*.98&&dd<180;if(can&&dd<bd){best=p;bd=dd;}}if(best){target=best;f.chaseId=best.id;f.chaseUntil=now+1000;}}
    if(f.chaseId&&f.chaseUntil<=now){f.chaseId=null;f.cooldownUntil=now+5000;target=null;}
    if(target){const a=Math.atan2(target.y-f.y,target.x-f.x),k=f.role==='predator'?.24:.18;f.vx+=Math.cos(a)*f.speed*k;f.vy+=Math.sin(a)*f.speed*k;}
    else if(f.turn<=0){f.turn=.8+Math.random()*1.8;f.heading+=(Math.random()-.5)*1.1;f.vx+=Math.cos(f.heading)*f.speed*.16;f.vy+=Math.sin(f.heading)*f.speed*.16;}else f.turn-=dt;
    const sp=Math.hypot(f.vx,f.vy)||.0001;if(sp>f.speed){f.vx=f.vx/sp*f.speed;f.vy=f.vy/sp*f.speed;}
    f.x=clamp(f.x+f.vx*dt*60,30,W-30);f.y=clamp(f.y+f.vy*dt*60,30,H-30);
    if(f.x<=30||f.x>=W-30){f.vx*=-1;f.heading=Math.PI-f.heading;}if(f.y<=30||f.y>=H-30){f.vy*=-1;f.heading=-f.heading;}f.angle=Math.atan2(f.vy,f.vx);
  }
}

function killPlayer(w,p,reason,eater=null){
  if(!p.alive)return;p.alive=false;p.vx=0;p.vy=0;
  if(eater)sendAll(w,{type:'player_eaten',victimId:p.id,eaterId:eater.id,reason,serverTime:Date.now()});
  send(p.ws,{type:'player_dead',id:p.id,reason});broadcast(w);
  setTimeout(()=>{const q=w.players.get(p.id);if(!q)return;const pos=spawn(w);q.x=pos.x;q.y=pos.y;q.lastX=pos.x;q.lastY=pos.y;q.vx=0;q.vy=0;q.score=Math.max(0,Math.floor(q.score*.5));q.radius=radius(q.score);q.alive=true;q.lives=Math.max(1,q.lives);q.invulnerableUntil=Date.now()+1500;q.lastInputAt=Date.now();send(q.ws,{type:'respawn',player:pubPlayer(q)});broadcast(w);},1000);
}
function removeFish(w,p,f){
  if(!w.fish.has(f.id))return false;w.fish.delete(f.id);p.score+=f.points;p.radius=radius(p.score);w.respawns.push({index:f.index,at:Date.now()+RESPAWN_MS});
  sendAll(w,{type:'entity_removed',entityId:f.id,by:p.id,serverTick:w.tick,serverTime:Date.now()});return true;
}
function tryConsume(w,p,id){
  const f=w.fish.get(String(id||''));if(!f||!p.connected||!p.alive)return false;const pp=power(p.score),pr=radius(p.score);
  if(dist(p,f)>pr*.95+f.size*.95)return false;if(!(f.power<pp&&f.size<pr))return false;const ok=removeFish(w,p,f);if(ok){maybeAdvanceStage(w);broadcast(w);}return ok;
}
function combat(w){
  if(w.stage===1||w.stage===3)return;const now=Date.now();
  for(const p of w.players.values()){
    if(!p.connected||!p.alive||p.invulnerableUntil>now)continue;const pp=power(p.score),pr=radius(p.score);
    for(const f of [...w.fish.values()]){const dd=dist(p,f);if(dd>pr*.86+f.size*.86)continue;if(f.power<pp&&f.size<pr){removeFish(w,p,f);continue;}if(f.power>pp&&f.size>pr*1.02){p.lives=Math.max(0,p.lives-1);p.score=Math.max(0,Math.floor(p.score*.5));p.radius=radius(p.score);p.invulnerableUntil=now+2500;if(p.lives<=0)killPlayer(w,p,'fish');break;}}
  }
  const ps=[...w.players.values()].filter(p=>p.connected&&p.alive);
  for(let i=0;i<ps.length;i++)for(let j=i+1;j<ps.length;j++){
    const a=ps[i],b=ps[j];if(w.mode==='coop'||(w.mode==='teams'&&a.team===b.team))continue;const dd=dist(a,b),ar=radius(a.score),br=radius(b.score);if(dd>ar*.82+br*.82)continue;
    if(a.score>=b.score+1&&ar>br){a.score+=Math.max(10,Math.floor(b.score*.25));a.radius=radius(a.score);killPlayer(w,b,'player',a);}
    else if(b.score>=a.score+1&&br>ar){b.score+=Math.max(10,Math.floor(a.score*.25));b.radius=radius(b.score);killPlayer(w,a,'player',b);}
  }
  maybeAdvanceStage(w);
}

// Player movement is reported by the owning client at 20 Hz, but the server validates
// maximum displacement before accepting it. We do NOT run a second movement integrator
// here: doing both caused the classic rubber-band/teleport loop on every device.
function applyInput(p,m){
  const x=Number(m.x),y=Number(m.y),now=Date.now();if(!Number.isFinite(x)||!Number.isFinite(y)||!p.alive)return;
  const dt=Math.max(.016,Math.min(.25,(now-p.lastInputAt)/1000));
  const dx=x-p.x,dy=y-p.y,dd=Math.hypot(dx,dy);
  const maxPerSecond=p.sprinting?520:390;
  const allowed=Math.max(28,maxPerSecond*dt*1.8);
  const ratio=dd>allowed&&dd>0?allowed/dd:1;
  const nx=clamp(p.x+dx*ratio,0,W),ny=clamp(p.y+dy*ratio,0,H);
  p.vx=(nx-p.x)/Math.max(dt,0.001)/60;p.vy=(ny-p.y)/Math.max(dt,0.001)/60;
  p.x=nx;p.y=ny;p.lastX=x;p.lastY=y;p.angle=Number.isFinite(Number(m.angle))?Number(m.angle):Math.atan2(p.vy,p.vx);
  p.sprinting=!!m.sprinting;p.lastInputAt=now;
}
function makeDeviceId(){return`nany-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;}

const bridge=`<script>(()=>{const Native=window.WebSocket,BUF='__NANY_LIVE_BUF__',DEVICE='__NANY_DEVICE__';
const device=()=>{let d=localStorage.getItem(DEVICE);if(!d){d=(${makeDeviceId.toString()})();localStorage.setItem(DEVICE,d)}return d};window.__NANY_DEVICE_ID__=device();
function WrappedWS(url,protocols){
  let real=null,stopped=false,retry=0,join=null,lastState=null,api;const ev={open:new Set(),message:new Set(),close:new Set(),error:new Set()};
  const emit=(t,e)=>{for(const f of ev[t]||[])try{f.call(api,e)}catch{}const h=api['on'+t];if(typeof h==='function')try{h.call(api,e)}catch{}};
  api={};Object.setPrototypeOf(api,Native.prototype);Object.defineProperty(api,'readyState',{get:()=>stopped?3:(real?.readyState??0)});Object.defineProperty(api,'url',{value:url});
  api.addEventListener=(t,f)=>ev[t]?.add(f);api.removeEventListener=(t,f)=>ev[t]?.delete(f);
  api.send=data=>{let out=data;try{const m=JSON.parse(data);if(m.type==='join'){join={...m,deviceId:device(),resumeId:localStorage.getItem('__NANY_RESUME_ID__')||null};localStorage.setItem('__NANY_JOIN__',JSON.stringify(join));out=JSON.stringify(join)}if(m.type==='state')lastState=m}catch{}if(real?.readyState===1)real.send(out)};
  api.close=()=>{stopped=true;try{real?.close()}catch{}emit('close',new Event('close'))};
  function connect(){
    if(stopped)return;real=protocols===undefined?new Native(url):new Native(url,protocols);
    real.addEventListener('open',()=>{retry=0;let j=join;try{j=j||JSON.parse(localStorage.getItem('__NANY_JOIN__')||'null')}catch{}if(j)real.send(JSON.stringify(j));if(lastState)real.send(JSON.stringify(lastState));emit('open',new Event('open'))});
    real.addEventListener('message',e=>{try{const m=JSON.parse(e.data);if(m.type==='welcome')localStorage.setItem('__NANY_RESUME_ID__',m.resumeId||m.id||'');if(m.type==='snapshot'||m.type==='welcome'){const b=window[BUF]||(window[BUF]=[]);b.push({recv:performance.now(),tick:Number(m.serverTick)||0,m});while(b.length>24)b.shift();window.__SERVER_SYNC_FISH__?.()}}catch{}emit('message',e)});
    real.addEventListener('close',e=>{if(stopped){emit('close',e);return}setTimeout(connect,Math.min(4000,250*Math.pow(1.45,retry++)))});real.addEventListener('error',e=>{if(stopped)emit('error',e)});
  }
  connect();return api;
}
for(const k of ['CONNECTING','OPEN','CLOSING','CLOSED'])WrappedWS[k]=Native[k];WrappedWS.prototype=Native.prototype;window.WebSocket=WrappedWS;window.__SERVER_AUTHORITATIVE_FISH__=true;
window.__SERVER_SYNC_FISH__=function(){
  try{
    const g=window.eval('typeof game!=="undefined"?game:null'),b=window[BUF]||[];if(!g||!b.length)return;
    const renderAt=performance.now()-80;let B=b[b.length-1],A=B;
    for(let i=b.length-1;i>=0;i--){if(b[i].recv<=renderAt){A=b[i];break}}
    const bm=B.m,am=A.m;const span=Math.max(1,B.recv-A.recv),alpha=A===B?1:Math.max(0,Math.min(1,(renderAt-A.recv)/span));
    const old=new Map((am.entities||[]).map(f=>[f.id,f])),out=[];
    for(const fb of bm.entities||[]){
      const fa=old.get(fb.id)||fb,sp=Math.max(.1,Math.hypot(Number(fb.vx)||0,Number(fb.vy)||0));
      out.push({sharedId:fb.id,serverId:fb.id,type:fb.type,family:fb.type,variant:fb.role==='predator'?'big':'small',renderKey:fb.type,power:fb.power,tier:fb.power||0,
        ecologyRole:fb.role,size:fb.size,baseSize:fb.size,points:fb.points,color:fb.color,behavior:fb.role==='predator'?'aggro':'drift',hazard:null,speed:sp,
        x:fa.x+(fb.x-fa.x)*alpha,y:fa.y+(fb.y-fa.y)*alpha,vx:fb.vx,vy:fb.vy,angle:fb.angle,wobble:(Number(fb.angle)||0)+performance.now()/700,
        finPhase:performance.now()/180,life:0,coin:false,_chasing:false,_chaseTime:0,_attackCooldown:0});
    }
    // The latest server snapshot is the truth. Never keep stale fish and never clear
    // the ocean just because the local player died/reconnected.
    g.entities=out;
    const me=bm.you||bm.player||am.you||am.player;
    if(me){g.score=Number(me.score)||0;g.growthScore=Number(me.growthScore??me.score)||0;g.lives=Number(me.lives)||0;}
  }catch{}
};
const patch=setInterval(()=>{try{const sw=window.eval('typeof SharedWorld!=="undefined"?SharedWorld:null');if(!sw||sw.__serverPatched)return;const original=sw.update.bind(sw);sw.__serverOriginalUpdate=original;sw.update=function(dt){const b=window[BUF]||[],m=b.length?b[b.length-1].m:null,stage=Number(m?.worldStage)||0;if(stage===1||stage===3)return original(dt);return window.__SERVER_SYNC_FISH__()};sw.__serverPatched=true;clearInterval(patch)}catch{}},50);
})();</script>`;

const server=http.createServer(async(req,res)=>{
  try{
    const u=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`);
    if(u.pathname==='/health'){
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
      return res.end(JSON.stringify({ok:true,server:'live-authoritative-v4',worlds:['PVP','PVE','EQUIPO'],fishPerWorld:FISH_N,tickHz:TICK_HZ,snapshotHz:SNAP_HZ,
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
        const pos=spawn(world);p={id:deviceId||makeId('player'),resumeId:resumeId||makeId('resume'),deviceId:deviceId||makeDeviceId(),ws:null,connected:false,disconnectedAt:0,
          name:safeName(m.name),team:teamFor(world,m.team),x:pos.x,y:pos.y,lastX:pos.x,lastY:pos.y,vx:0,vy:0,angle:0,score:0,radius:11,level:1,lives:1,alive:true,
          sprinting:false,lastInputAt:Date.now(),invulnerableUntil:Date.now()+1200};world.players.set(p.id,p);
      }
      p.ws=ws;p.connected=true;p.disconnectedAt=0;p.name=safeName(m.name||p.name);p.team=p.team||teamFor(world,m.team);p.mode=mode;p.lastInputAt=Date.now();player=p;
      send(ws,{...snapshot(world),type:'welcome',resumeId:p.resumeId,id:p.id,team:p.team,teamName:p.team==='A'?'Azul':p.team==='B'?'Rojo':null,you:pubPlayer(p),player:pubPlayer(p)});
      sendAll(world,{type:'player_joined',player:pubPlayer(p)});broadcast(world);return;
    }
    if(!player||!world)return;
    if(m.type==='state')applyInput(player,m);else if(m.type==='consume')tryConsume(world,player,m.entityId);
    else if(m.type==='boss_defeated'){if(world.stage===1)world.stage=2;else if(world.stage===3)world.stage=4;broadcastStage(world);}else if(m.type==='leave')ws.close(1000,'leave');
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

server.listen(PORT,'0.0.0.0',()=>console.log(`NANY LIVE AUTHORITATIVE V4 ${PORT}`));
