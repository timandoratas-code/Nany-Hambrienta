import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'node:crypto';

const __dirname=fileURLToPath(new URL('.',import.meta.url));
const PORT=Number(process.env.PORT||10000), HOST=process.env.HOST||'0.0.0.0';
const WORLD_W=12000, WORLD_H=12000, MAX_PLAYERS=8, INTEREST_RADIUS=3000;
const TICK_MS=50, SNAPSHOT_MS=120, MAX_BYTES=64*1024;
const rooms=new Map(), clients=new Map();

const TYPES=[
 ['plankton','small',4,4,.95,0],['minnow_small','small',8,8,1.20,1],['green_small','small',11,13,1.55,2],
 ['piranha_small','small',14,21,1.90,3],['stick_small','small',17,29,1.45,4],['rival_small','small',21,40,1.75,5],
 ['ray_small','small',30,70,2.05,7],['monster_small','small',43,115,1.80,9],
 ['minnow_big','big',8,12,1.15,1],['green_big','big',11,19,1.48,2],['piranha_big','big',14,30,1.82,3],
 ['stick_big','big',17,40,1.40,4],['rival_big','big',21,55,1.68,5],['ray_big','big',30,90,1.98,7],['monster_big','big',43,145,1.72,9]
];
const LEVEL_TYPES={0:{count:230,preds:68,maxTier:5},1:{count:230,preds:76,maxTier:7},2:{count:240,preds:82,maxTier:9}};
const rand=(a,b)=>a+Math.random()*(b-a);const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const safeRoom=v=>String(v||'ABISMO01').trim().toUpperCase().replace(/[^A-Z0-9_-]/g,'').slice(0,16)||'ABISMO01';
const safeMode=v=>['teams','ffa','coop'].includes(String(v||'teams'))?String(v||'teams'):'teams';
const safeName=v=>String(v||'Nany').trim().slice(0,18)||'Nany';
function seedRand(seed){let a=seed>>>0;return()=>{a=(a+0x6D2B79F5)|0;let t=Math.imul(a^a>>>15,1|a);t^=t+Math.imul(t^t>>>7,61|t);return((t^t>>>14)>>>0)/4294967296;};}
function fishFromKey(key){return TYPES.find(t=>t[0]===key)||TYPES[1];}
const RENDER_META={
  plankton:{color:'#8fffb0',renderKey:'plankton',behavior:'drift'},
  minnow_small:{color:'#bfe6ff',renderKey:'minnow',behavior:'drift'},minnow_big:{color:'#bfe6ff',renderKey:'minnow',behavior:'aggro'},
  green_small:{color:'#39ff6a',renderKey:'green',behavior:'drift'},green_big:{color:'#39ff6a',renderKey:'green',behavior:'aggro'},
  piranha_small:{color:'#ff8a3d',renderKey:'piranha',behavior:'aggro'},piranha_big:{color:'#ff8a3d',renderKey:'piranha',behavior:'aggro'},
  stick_small:{color:'#e0c66a',renderKey:'stick',behavior:'drift'},stick_big:{color:'#e0c66a',renderKey:'stick',behavior:'aggro'},
  rival_small:{color:'#a084ff',renderKey:'rival',behavior:'aggro'},rival_big:{color:'#a084ff',renderKey:'rival',behavior:'aggro'},
  ray_small:{color:'#6d8796',renderKey:'ray',behavior:'aggro'},ray_big:{color:'#6d8796',renderKey:'ray',behavior:'aggro'},
  monster_small:{color:'#8d2638',renderKey:'monster',behavior:'aggro'},monster_big:{color:'#8d2638',renderKey:'monster',behavior:'aggro'},
  poison:{color:'#c23bff',renderKey:'poison',behavior:'drift',hazard:'poison'},lava:{color:'#ff3b3b',renderKey:'lava',behavior:'hunt',hazard:'lava'}
};
function teamName(t){return t==='A'?'Azul':t==='B'?'Rojo':null;}
function assignTeam(room,requested){if(room.mode!=='teams')return null;if(requested==='A'||requested==='B'){const a=[...room.players.values()].filter(p=>p.team==='A').length,b=[...room.players.values()].filter(p=>p.team==='B').length;if((requested==='A'&&a<=b+1)||(requested==='B'&&b<=a+1))return requested;}const a=[...room.players.values()].filter(p=>p.team==='A').length,b=[...room.players.values()].filter(p=>p.team==='B').length;return a<=b?'A':'B';}
function radiusFromGrowth(g){return clamp(11+Math.sqrt(Math.max(0,g))*0.62,11,320);}
function publicPlayer(p){return {id:p.id,name:p.name,x:p.x,y:p.y,angle:p.angle,score:p.score,growthScore:p.growthScore,level:p.level,radius:p.radius,alive:p.alive,power:p.power,sprinting:p.sprinting,deaths:p.deaths,team:p.team||null,teamName:p.teamName||null};}
function send(ws,msg){if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(msg));}
function broadcast(room,msg,except=null){for(const p of room.players.values())if(p.id!==except)send(p.ws,msg);}
function playerList(room){return [...room.players.values()].map(publicPlayer);}
function randomSpawn(){return {x:450+Math.random()*(WORLD_W-900),y:450+Math.random()*(WORLD_H-900)};}
function newEntity(room,typeKey,forcedX=null,forcedY=null){
  const [key,variant,baseSize,points,speed,power]=fishFromKey(typeKey); const a=Math.random()*Math.PI*2;
  const x=forcedX??rand(120,WORLD_W-120), y=forcedY??rand(120,WORLD_H-120); const size=baseSize*rand(1.15,2.0);
  const id=`e-${room.nextEntityId++}`;
  return {id,type:key,variant,size:+size.toFixed(2),baseSize:baseSize,points,power,speed:+speed.toFixed(3),x,y,vx:Math.cos(a)*speed*.55,vy:Math.sin(a)*speed*.55,angle:a,wobble:Math.random()*Math.PI*2,finPhase:Math.random()*Math.PI*2,life:0,boss:false,bossType:null,bossHits:0,vulnerableTail:false,chasing:false};
}
function populate(room,level){room.entities.clear();const cfg=LEVEL_TYPES[level];const r=seedRand(room.seed+level*1013904223);const eligible=TYPES.filter(t=>t[5]<=cfg.maxTier);const prey=eligible.filter(t=>t[1]==='small');const pred=eligible.filter(t=>t[1]==='big');for(let i=0;i<cfg.count;i++){const pool=i<cfg.preds?pred:prey;const t=pool[Math.floor(r()*pool.length)];room.entities.set(`e-${room.nextEntityId++}`,newEntity(room,t[0]));}for(let i=0;i<3;i++)room.entities.set(`e-${room.nextEntityId++}`,newEntity(room,'plankton'));room.stage=level===0?0:level===1?2:4;room.boss=null;room.removed.clear();}
function spawnBoss(room,type){room.entities.clear();room.boss=null;const e={id:`boss-${room.nextEntityId++}`,type:'boss',variant:'boss',size:type==='shrimp'?180:205,baseSize:type==='shrimp'?180:205,points:0,power:99,speed:type==='shrimp'?1.72:1.68,x:clamp(rand(1200,WORLD_W-1200),1200,WORLD_W-1200),y:clamp(rand(1200,WORLD_H-1200),1200,WORLD_H-1200),vx:0,vy:0,angle:Math.random()*Math.PI*2,wobble:0,finPhase:0,life:0,boss:true,bossType:type,bossHits:0,vulnerableTail:type==='shrimp',chasing:false,attackTimer:0,hitCooldown:0,dashTimer:0};room.entities.set(e.id,e);room.boss=e;room.removed.clear();}
function setStage(room,stage){room.stage=stage;if(stage===1)spawnBoss(room,'shrimp');else if(stage===3)spawnBoss(room,'lava');else if(stage===0)populate(room,0);else if(stage===2)populate(room,1);else if(stage>=4)populate(room,2);broadcast(room,{type:'world_stage',stage});}
function maxScore(room){return Math.max(0,...[...room.players.values()].map(p=>p.score));}
function evaluateStage(room){const max=maxScore(room);if(room.stage===0&&max>=1000)setStage(room,1);else if(room.stage===2&&max>=3000)setStage(room,3);}
function stageAdvanceAfterBoss(room){if(room.stage===1)setStage(room,2);else if(room.stage===3)setStage(room,4);}
function entityVisibleTo(p,e){return e && Math.hypot(e.x-p.x,e.y-p.y)<=INTEREST_RADIUS;}
function snapshotFor(room,p,now){
  const entities=[];for(const e of room.entities.values())if(entityVisibleTo(p,e)){const meta=RENDER_META[e.type]||{};entities.push({id:e.id,type:e.type,variant:e.variant,size:e.size,baseSize:e.baseSize,points:e.points,power:e.power,speed:e.speed,x:+e.x.toFixed(2),y:+e.y.toFixed(2),vx:+e.vx.toFixed(2),vy:+e.vy.toFixed(2),angle:+e.angle.toFixed(3),wobble:e.wobble,finPhase:e.finPhase,color:e.boss?null:(meta.color||'#4dfff0'),renderKey:e.boss?'boss':(meta.renderKey||e.type),behavior:meta.behavior||'drift',hazard:meta.hazard||null,boss:!!e.boss,bossType:e.bossType,bossHits:e.bossHits||0,vulnerableTail:!!e.vulnerableTail,chasing:!!e.chasing});}
  return {type:'world',serverTime:now,room:room.roomId,mode:room.mode,population:room.players.size,stage:room.stage,players:playerList(room),you:publicPlayer(p),entities};
}
function removeEntity(room,id){if(room.entities.delete(id)){room.removed.add(id);broadcast(room,{type:'entity_removed',entityId:id});return true;}return false;}
function handleCollisions(room){
  for(const p of room.players.values()){
    if(!p.alive)continue;
    for(const e of room.entities.values()){
      if(Math.hypot(e.x-p.x,e.y-p.y)>260)continue;
      if(e.boss)continue;
      const d=Math.hypot(e.x-p.x,e.y-p.y);const pR=p.radius;const eR=e.size*.62;
      if(e.variant==='small' && d<pR+eR){p.score+=Math.max(1,e.points);p.growthScore+=Math.max(1,e.points);p.radius=radiusFromGrowth(p.growthScore);removeEntity(room,e.id);send(p.ws,{type:'score',score:p.score,growthScore:p.growthScore,radius:p.radius});break;}
      if(e.variant==='big' && d<pR+eR && e.size>pR*1.02){
        p.alive=false;p.deaths++;send(p.ws,{type:'player_dead',id:p.id,reason:'fish'});const sp=randomSpawn();setTimeout(()=>{if(!p.joined||!room.players.has(p.id))return;p.x=sp.x;p.y=sp.y;p.alive=true;p.invulnUntil=Date.now()+1200;send(p.ws,{type:'respawn',player:publicPlayer(p)});},1200);break;
      }
    }
  }
}
function updateBoss(room,dt){const e=room.boss;if(!e)return;for(const p of room.players.values()){if(!p.alive)continue;const d=Math.hypot(p.x-e.x,p.y-e.y);if(!e.chasing&&d<260){e.chasing=true;e.attackTimer=0;}if(e.chasing){e.attackTimer+=dt;const a=Math.atan2(p.y-e.y,p.x-e.x);e.angle=a;e.vx=Math.cos(a)*e.speed;e.vy=Math.sin(a)*e.speed;if(d<p.radius+e.size*.62){p.alive=false;p.deaths++;send(p.ws,{type:'player_dead',id:p.id,reason:'boss'});const sp=randomSpawn();setTimeout(()=>{if(!p.joined||!room.players.has(p.id))return;p.x=sp.x;p.y=sp.y;p.alive=true;send(p.ws,{type:'respawn',player:publicPlayer(p)});},1200);}if(e.attackTimer>=1){e.chasing=false;e.attackTimer=0;}}
  }
  e.x=clamp(e.x+e.vx*dt*60,200,WORLD_W-200);e.y=clamp(e.y+e.vy*dt*60,200,WORLD_H-200);e.wobble+=dt*2;e.finPhase+=dt*5;
  if(e.bossType==='lava'){e.dashTimer+=dt;e.vulnerableTail=e.dashTimer>2.0;if(e.dashTimer>3.2)e.dashTimer=0;}
}
const http=createServer(async(req,res)=>{try{const u=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`);const path=decodeURIComponent(u.pathname);if(path==='/health'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({ok:true,rooms:rooms.size,players:clients.size}));return;}if(path==='/'||path==='/index.html'){const data=await readFile(join(__dirname,'index.html'));res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(data);return;}if(path==='/favicon.ico'){res.writeHead(204);res.end();return;}const fp=join(__dirname,path.replace(/^\/+/,''));const rel=relative(__dirname,fp);if(rel.startsWith('..')||rel.includes('\\0')){res.writeHead(403);res.end('Forbidden');return;}const data=await readFile(fp);const ext=extname(fp);const type=ext==='.html'?'text/html; charset=utf-8':ext==='.js'||ext==='.mjs'?'text/javascript; charset=utf-8':ext==='.css'?'text/css; charset=utf-8':'application/octet-stream';res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});res.end(data);}catch(e){res.writeHead(e?.code==='ENOENT'?404:500);res.end(e?.code==='ENOENT'?'Not found':'Server error');}});
const wss=new WebSocketServer({noServer:true,maxPayload:MAX_BYTES});
http.on('upgrade',(req,sock,head)=>{const u=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`);if(u.pathname!=='/ws'){sock.destroy();return;}wss.handleUpgrade(req,sock,head,ws=>wss.emit('connection',ws,req));});
function roomFor(name){let room=rooms.get(name);if(!room){room={roomId:name,mode:'teams',seed:crypto.randomBytes(4).readUInt32BE(0)||1,players:new Map(),entities:new Map(),nextEntityId:1,stage:0,removed:new Set(),createdAt:Date.now()};populate(room,0);rooms.set(name,room);}return room;}
function removeClient(c){clients.delete(c.id);if(!c.joined)return;const room=rooms.get(c.room);if(!room)return;room.players.delete(c.id);broadcast(room,{type:'player_left',id:c.id});if(room.players.size===0)rooms.delete(c.room);}
wss.on('connection',ws=>{const id=crypto.randomUUID();const c={id,ws,room:null,joined:false,name:'Nany',x:WORLD_W/2,y:WORLD_H/2,angle:0,score:0,growthScore:0,level:1,power:1,radius:11,alive:true,sprinting:false,deaths:0,team:null,teamName:null,lastInput:Date.now()};clients.set(id,c);ws.on('message',(data,binary)=>{if(binary||data.byteLength>MAX_BYTES)return;let m;try{m=JSON.parse(data.toString())}catch{return;}if(!m||typeof m.type!=='string')return;if(m.type==='join'){if(c.joined)return;const name=safeRoom(m.room),mode=safeMode(m.mode);const room=roomFor(name);if(room.players.size===0)room.mode=mode;if(room.mode!==mode){send(ws,{type:'error',message:`La sala ya es ${room.mode}.`});return;}if(room.players.size>=MAX_PLAYERS){send(ws,{type:'error',message:'Sala llena.'});return;}c.room=name;c.name=safeName(m.name);c.team=assignTeam(room,m.team);c.teamName=teamName(c.team);const sp=randomSpawn();c.x=sp.x;c.y=sp.y;c.joined=true;room.players.set(c.id,c);send(ws,{type:'welcome',id:c.id,room:name,mode:room.mode,team:c.team,teamName:c.teamName,stage:room.stage,population:room.players.size,player:publicPlayer(c),players:playerList(room).filter(p=>p.id!==c.id),...snapshotFor(room,c,Date.now())});broadcast(room,{type:'player_joined',player:publicPlayer(c)},c.id);return;}if(!c.joined)return;const room=rooms.get(c.room);if(!room)return;if(m.type==='state'){const nx=Number(m.x),ny=Number(m.y);if(Number.isFinite(nx)&&Number.isFinite(ny)){c.x=clamp(nx,0,WORLD_W);c.y=clamp(ny,0,WORLD_H);}if(Number.isFinite(Number(m.angle)))c.angle=Number(m.angle);if(Number.isFinite(Number(m.score)))c.score=Math.max(0,Math.min(1e6,Math.floor(Number(m.score))));if(Number.isFinite(Number(m.growthScore)))c.growthScore=Math.max(0,Math.min(1e6,Math.floor(Number(m.growthScore))));c.radius=radiusFromGrowth(c.growthScore);c.alive=m.alive!==false;c.sprinting=m.sprinting===true;c.level=Math.max(1,Number(m.level)||1);c.power=Math.max(1,Math.min(10,Math.floor(1+Math.sqrt(c.growthScore)/15)));return;}if(m.type==='consume'){const e=room.entities.get(String(m.entityId));if(!e||e.boss)return;if(Math.hypot(e.x-c.x,e.y-c.y)>180)return;if(e.variant!=='small')return;removeEntity(room,e.id);c.score+=Math.max(1,e.points);c.growthScore+=Math.max(1,e.points);c.radius=radiusFromGrowth(c.growthScore);send(c.ws,{type:'score',score:c.score,growthScore:c.growthScore,radius:c.radius});evaluateStage(room);return;}if(m.type==='boss_hit'){const b=room.boss;if(!b)return;const d=Math.hypot(b.x-c.x,b.y-c.y);if(d>420)return;if(b.bossType==='lava'&&!b.vulnerableTail)return;b.bossHits++;broadcast(room,{type:'boss_state',id:b.id,hits:b.bossHits,vulnerable:b.vulnerableTail,chasing:b.chasing});if(b.bossHits>=5){stageAdvanceAfterBoss(room);}return;}if(m.type==='leave'){try{ws.close()}catch{}}});ws.on('close',()=>removeClient(c));});
setInterval(()=>{const now=Date.now(),dt=TICK_MS/1000;for(const room of rooms.values()){
  // Move world entities server-side.
  if(room.boss)updateBoss(room,dt); else {
    for(const e of room.entities.values()){
      if(e.boss)continue;e.x+=e.vx*dt*60;e.y+=e.vy*dt*60;e.life+=dt;e.wobble+=dt*2;e.finPhase+=dt*5;
      if(e.x<80||e.x>WORLD_W-80){e.vx*=-1;e.x=clamp(e.x,80,WORLD_W-80);}if(e.y<80||e.y>WORLD_H-80){e.vy*=-1;e.y=clamp(e.y,80,WORLD_H-80);}e.angle=Math.atan2(e.vy,e.vx);
    }
    const target=(LEVEL_TYPES[room.stage===2?1:room.stage>=4?2:0]?.count||230);if(room.entities.size<target){const lvl=room.stage===2?1:room.stage>=4?2:0;const cfg=LEVEL_TYPES[lvl];const pool=TYPES.filter(t=>t[1]==='small'||t[5]<=cfg.maxTier);const t=pool[Math.floor(Math.random()*pool.length)];room.entities.set(`e-${room.nextEntityId++}`,newEntity(room,t[0]));}
  }
  handleCollisions(room);evaluateStage(room);
  for(const p of room.players.values()) send(p.ws,snapshotFor(room,p,now));
}},TICK_MS);
http.listen(PORT,HOST,()=>console.log(`Nany Agar-style authoritative server listening on ${HOST}:${PORT}`));
