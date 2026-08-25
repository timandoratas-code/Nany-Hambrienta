import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'node:crypto';

const __dirname=fileURLToPath(new URL('.',import.meta.url));
const PORT=Number(process.env.PORT||10000);
const HOST=process.env.HOST||'0.0.0.0';
const WORLD_W=12000, WORLD_H=12000;
const MAX_PLAYERS=8;
const TICK_MS=50;
const SNAPSHOT_MS=100;
const MAX_BYTES=64*1024;
const MAX_SPEED=3.2;
const ACCEL=0.28;

const rooms=new Map();
const clients=new Map();

const TYPES=[
 ['plankton','small',4,4,.95,0],['minnow_small','small',8,8,1.20,1],['green_small','small',11,13,1.55,2],
 ['piranha_small','small',14,21,1.90,3],['stick_small','small',17,29,1.45,4],['rival_small','small',21,40,1.75,5],
 ['ray_small','small',30,70,2.05,7],['monster_small','small',43,115,1.80,9],
 ['minnow_big','big',8,12,1.15,1],['green_big','big',11,19,1.48,2],['piranha_big','big',14,30,1.82,3],
 ['stick_big','big',17,40,1.40,4],['rival_big','big',21,55,1.68,5],['ray_big','big',30,90,1.98,7],['monster_big','big',43,145,1.72,9]
];

const LEVEL_TYPES={0:{count:260,predators:75,maxTier:5},1:{count:230,predators:82,maxTier:7},2:{count:250,predators:90,maxTier:9}};
const rand=(a,b)=>a+Math.random()*(b-a);
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const safeRoom=v=>String(v||'ABISMO01').trim().toUpperCase().replace(/[^A-Z0-9_-]/g,'').slice(0,16)||'ABISMO01';
const safeMode=v=>['teams','ffa','coop'].includes(String(v||'teams'))?String(v||'teams'):'teams';
const safeName=v=>String(v||'Nany').trim().slice(0,18)||'Nany';
const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);

function rng(init){let a=(init>>>0)||1;return()=>{a=(a+0x6D2B79F5)|0;let t=Math.imul(a^a>>>15,1|a);t^=t+Math.imul(t^t>>>7,61|t);return((t^t>>>14)>>>0)/4294967296;};}
function makeSharedId(seed,stage,i){return `shared-${seed.toString(36)}-${stage}-${i}`;}
function fishFromKey(key){return TYPES.find(t=>t[0]===key)||TYPES[1];}
function radiusFromGrowth(g){return clamp(11+Math.sqrt(Math.max(0,g))*0.62,11,320);}
function publicPlayer(p){return{id:p.id,name:p.name,x:+p.x.toFixed(2),y:+p.y.toFixed(2),vx:+p.vx.toFixed(3),vy:+p.vy.toFixed(3),angle:+p.angle.toFixed(3),score:p.score,growthScore:p.growthScore,level:p.level,radius:+p.radius.toFixed(2),alive:p.alive,power:p.power,sprinting:p.sprinting,deaths:p.deaths,team:p.team||null,teamName:p.teamName||null};}
function send(ws,msg){if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(msg));}
function broadcast(room,msg,except=null){for(const p of room.players.values())if(p.id!==except)send(p.ws,msg);}
function playerList(room){return[...room.players.values()].map(publicPlayer);}
function randomSpawn(){return{x:450+Math.random()*(WORLD_W-900),y:450+Math.random()*(WORLD_H-900)};}
function assignTeam(room,requested){if(room.mode!=='teams')return null;const a=[...room.players.values()].filter(p=>p.team==='A').length,b=[...room.players.values()].filter(p=>p.team==='B').length;if((requested==='A'||requested==='B')&&Math.abs(a-b)<=1)return requested;return a<=b?'A':'B';}
function teamName(team){return team==='A'?'Azul':team==='B'?'Rojo':null;}
function buildEntities(room,stage){
 room.entities.clear();room.removed.clear();room.nextEntity=0;room.bossId=null;
 if(stage===1||stage===3){const r=rng((room.seed^Math.imul(stage+1,0x9E3779B1))>>>0);const bossType=stage===1?'shrimp':'lava';const a=r()*Math.PI*2;const x=clamp(900+r()*(WORLD_W-1800),900,WORLD_W-900);const y=clamp(900+r()*(WORLD_H-1800),900,WORLD_H-900);const id=makeSharedId(room.seed,stage,0);room.entities.set(id,{id,type:'boss',variant:'boss',size:bossType==='shrimp'?180:205,baseSize:bossType==='shrimp'?180:205,points:0,power:99,x,y,vx:Math.cos(a)*0.7,vy:Math.sin(a)*0.7,angle:a,boss:true,bossType,bossHits:0,vulnerableTail:bossType==='shrimp',life:0});room.bossId=id;return;}
 const level=stage===2?1:stage>=4?2:0;const cfg=LEVEL_TYPES[level];const r=rng((room.seed^Math.imul(stage+1,0x9E3779B1))>>>0);const eligible=TYPES.filter(t=>t[5]<=cfg.maxTier);const prey=eligible.filter(t=>t[1]==='small');const pred=eligible.filter(t=>t[1]==='big');
 for(let i=0;i<cfg.count;i++){const t=(i<cfg.predators?pred:prey)[Math.floor(r()*(i<cfg.predators?pred:prey).length)];const[key,variant,baseSize,points,speed,power]=fishFromKey(t[0]);const a=r()*Math.PI*2;const x=120+r()*(WORLD_W-240),y=120+r()*(WORLD_H-240);const mul=variant==='big'?(1.05+r()*0.7):(0.45+r()*0.4);const size=Math.max(3,11*mul);const id=makeSharedId(room.seed,stage,i);room.entities.set(id,{id,type:key,variant,size,baseSize,points,power,speed,x,y,vx:Math.cos(a)*speed*.55,vy:Math.sin(a)*speed*.55,angle:a,phase:r()*Math.PI*2,freq:0.22+r()*0.26,baseAngle:a,life:0,boss:false});}
 for(let i=0;i<3;i++){const id=makeSharedId(room.seed,stage,1000+i);const a=r()*Math.PI*2;room.entities.set(id,{id,type:'gemFish',variant:'gem',size:10+r()*24,baseSize:20,points:0,power:0,speed:1.15+r()*.55,x:180+r()*(WORLD_W-360),y:180+r()*(WORLD_H-360),vx:Math.cos(a)*.3,vy:Math.sin(a)*.3,angle:a,phase:r()*Math.PI*2,freq:.18+r()*.12,baseAngle:a,life:0,boss:false});}
}
function newRoom(code,mode){const room={roomId:code,mode,seed:crypto.randomBytes(4).readUInt32BE(0)||1,epochMs:Date.now(),stage:0,players:new Map(),entities:new Map(),removed:new Set(),nextEntity:0,bossId:null};buildEntities(room,0);return room;}
function snapshot(room,p,now,type='snapshot'){return{type,serverTime:now,room:room.roomId,mode:room.mode,population:room.players.size,worldSeed:room.seed,worldEpoch:room.epochMs,worldStage:room.stage,removed:[...room.removed],players:playerList(room),player:publicPlayer(p),you:publicPlayer(p)};}
function removeEntity(room,id){if(!room.entities.has(id))return false;room.entities.delete(id);room.removed.add(id);broadcast(room,{type:'entity_removed',entityId:id});return true;}
function setStage(room,stage){if(stage===room.stage)return;room.stage=stage;buildEntities(room,stage);broadcast(room,{type:'world_stage',stage});}
function maybeAdvanceStage(room){const maxScore=Math.max(0,...[...room.players.values()].map(p=>p.score));if(room.stage===0&&maxScore>=2000)setStage(room,1);else if(room.stage===2&&maxScore>=5000)setStage(room,3);}
function updatePlayerFromClientReport(p,msg){const rx=Number(msg.x),ry=Number(msg.y);if(!Number.isFinite(rx)||!Number.isFinite(ry))return;const dx=rx-p.lastReportedX,dy=ry-p.lastReportedY,jump=Math.hypot(dx,dy);p.lastReportedX=rx;p.lastReportedY=ry;if(jump>0.01&&jump<120){const target=Math.min(MAX_SPEED,jump*(1000/TICK_MS));const len=Math.hypot(dx,dy)||1;p.inputX=dx/len;p.inputY=dy/len;p.targetSpeed=target;}else{p.targetSpeed=0;}if(Number.isFinite(Number(msg.angle)))p.angle=Number(msg.angle);p.sprinting=msg.sprinting===true;p.lastInput=Date.now();}
function movePlayer(p,dt){if(!p.alive)return;const targetVx=p.inputX*p.targetSpeed,targetVy=p.inputY*p.targetSpeed;p.vx+=(targetVx-p.vx)*ACCEL;p.vy+=(targetVy-p.vy)*ACCEL;if(Date.now()-p.lastInput>220){p.vx*=0.72;p.vy*=0.72;p.targetSpeed=0;}p.x=clamp(p.x+p.vx*dt*60,p.radius,WORLD_W-p.radius);p.y=clamp(p.y+p.vy*dt*60,p.radius,WORLD_H-p.radius);if(Math.abs(p.vx)+Math.abs(p.vy)>0.05)p.angle=Math.atan2(p.vy,p.vx);}
function updateEntity(e,room,dt){if(e.boss)return;const t=(Date.now()-room.epochMs)/1000;const turn=Math.sin(t*(e.freq||0.25)+(e.phase||0))*0.52+Math.sin(t*(e.freq||0.25)*0.47+(e.phase||0)*1.7)*0.18;e.angle=(e.baseAngle||0)+turn;const sp=e.speed||1;e.vx+=(Math.cos(e.angle)*sp*.55-e.vx)*0.08;e.vy+=(Math.sin(e.angle)*sp*.55-e.vy)*0.08;e.x+=e.vx*dt*60;e.y+=e.vy*dt*60;const margin=100;if(e.x<margin){e.x=margin;e.baseAngle=Math.abs(e.baseAngle||0);}if(e.x>WORLD_W-margin){e.x=WORLD_W-margin;e.baseAngle=Math.PI-(e.baseAngle||0);}if(e.y<margin){e.y=margin;e.baseAngle=-(e.baseAngle||0);}if(e.y>WORLD_H-margin){e.y=WORLD_H-margin;e.baseAngle=-(e.baseAngle||0)+Math.PI;}e.life=t;}
function dieAndRespawn(room,p,reason){if(!p.alive)return;p.alive=false;p.deaths++;send(p.ws,{type:'player_dead',id:p.id,reason});setTimeout(()=>{if(!room.players.has(p.id))return;const sp=randomSpawn();p.x=sp.x;p.y=sp.y;p.vx=0;p.vy=0;p.inputX=0;p.inputY=0;p.targetSpeed=0;p.alive=true;p.invulnUntil=Date.now()+1200;send(p.ws,{type:'respawn',player:publicPlayer(p)});broadcast(room,{type:'player_respawned',player:publicPlayer(p)},p.id);},1200);}
function handleFishCollisions(room){const now=Date.now();for(const p of room.players.values()){if(!p.alive)continue;for(const e of room.entities.values()){if(e.boss)continue;if(Math.abs(e.x-p.x)>260||Math.abs(e.y-p.y)>260)continue;const d=dist(p,e),er=(e.size||10)*0.62;if(e.variant==='small'&&d<p.radius+er){removeEntity(room,e.id);const gain=Math.max(1,e.points||1);p.score+=gain;p.growthScore+=gain;p.radius=radiusFromGrowth(p.growthScore);send(p.ws,{type:'score',score:p.score,growthScore:p.growthScore,radius:p.radius});break;}if(e.variant==='big'&&d<p.radius+er&&e.size>p.radius*1.02&&now>p.invulnUntil){dieAndRespawn(room,p,'fish');break;}}}}
function handlePlayerCollisions(room){const list=[...room.players.values()].filter(p=>p.alive);for(let i=0;i<list.length;i++)for(let j=i+1;j<list.length;j++){const a=list[i],b=list[j];if(room.mode==='coop')continue;if(room.mode==='teams'&&a.team&&a.team===b.team)continue;if(dist(a,b)>a.radius*.8+b.radius*.8)continue;const aCan=a.score>=b.score+1&&a.radius>b.radius*1.02,bCan=b.score>=a.score+1&&b.radius>a.radius*1.02;if(aCan&&!bCan){const reward=Math.max(10,Math.floor(b.score*.25));a.score+=reward;a.growthScore=a.score;a.radius=radiusFromGrowth(a.growthScore);send(a.ws,{type:'player_kill',victimId:b.id,reward,score:a.score,growthScore:a.growthScore,radius:a.radius});send(b.ws,{type:'player_eaten',victimId:b.id,eaterId:a.id,eaterName:a.name,eaterScore:a.score});dieAndRespawn(room,b,'player');}else if(bCan&&!aCan){const reward=Math.max(10,Math.floor(a.score*.25));b.score+=reward;b.growthScore=b.score;b.radius=radiusFromGrowth(b.growthScore);send(b.ws,{type:'player_kill',victimId:a.id,reward,score:b.score,growthScore:b.growthScore,radius:b.radius});send(a.ws,{type:'player_eaten',victimId:a.id,eaterId:b.id,eaterName:b.name,eaterScore:b.score});dieAndRespawn(room,a,'player');}}}
function handleConsume(room,p,id){if(!p.alive)return;const e=room.entities.get(String(id));if(!e||e.boss||e.variant!=='small')return;if(dist(p,e)>p.radius+e.size*.62+25)return;removeEntity(room,e.id);const gain=Math.max(1,e.points||1);p.score+=gain;p.growthScore+=gain;p.radius=radiusFromGrowth(p.growthScore);send(p.ws,{type:'score',score:p.score,growthScore:p.growthScore,radius:p.radius});maybeAdvanceStage(room);}
const http=createServer(async(req,res)=>{try{const u=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`),path=decodeURIComponent(u.pathname);if(path==='/health'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({ok:true,rooms:rooms.size,players:clients.size}));return;}if(path==='/'||path==='/index.html'){const data=await readFile(join(__dirname,'index.html'));res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(data);return;}if(path==='/favicon.ico'){res.writeHead(204);res.end();return;}const fp=join(__dirname,path.replace(/^\/+/,'')),rel=relative(__dirname,fp);if(rel.startsWith('..')){res.writeHead(403);res.end('Forbidden');return;}const data=await readFile(fp),ext=extname(fp),type=ext==='.html'?'text/html; charset=utf-8':ext==='.js'||ext==='.mjs'?'text/javascript; charset=utf-8':ext==='.css'?'text/css; charset=utf-8':'application/octet-stream';res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});res.end(data);}catch(e){res.writeHead(e?.code==='ENOENT'?404:500);res.end(e?.code==='ENOENT'?'Not found':'Server error');}});
const wss=new WebSocketServer({noServer:true,maxPayload:MAX_BYTES});
http.on('upgrade',(req,socket,head)=>{const u=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`);if(u.pathname!=='/ws'){socket.destroy();return;}wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));});
function roomFor(name,mode){let room=rooms.get(name);if(!room){room=newRoom(name,mode);rooms.set(name,room);}return room;}
function removeClient(c){clients.delete(c.id);if(!c.joined)return;const room=rooms.get(c.room);if(!room)return;room.players.delete(c.id);broadcast(room,{type:'player_left',id:c.id});if(room.players.size===0)rooms.delete(c.room);}
wss.on('connection',ws=>{const id=crypto.randomUUID();const c={id,ws,room:null,joined:false,name:'Nany',x:WORLD_W/2,y:WORLD_H/2,vx:0,vy:0,inputX:0,inputY:0,targetSpeed:0,lastReportedX:WORLD_W/2,lastReportedY:WORLD_H/2,angle:0,score:0,growthScore:0,level:1,power:1,radius:11,alive:true,sprinting:false,deaths:0,team:null,teamName:null,lastInput:Date.now(),invulnUntil:0};clients.set(id,c);ws.on('message',(data,binary)=>{if(binary||data.byteLength>MAX_BYTES)return;let m;try{m=JSON.parse(data.toString());}catch{return;}if(!m||typeof m.type!=='string')return;if(m.type==='join'){if(c.joined)return;const roomName=safeRoom(m.room),mode=safeMode(m.mode),room=roomFor(roomName,mode);if(room.players.size>=MAX_PLAYERS){send(ws,{type:'error',message:'Sala llena.'});return;}if(room.players.size===0)room.mode=mode;if(room.mode!==mode){send(ws,{type:'error',message:`La sala ya es ${room.mode}.`});return;}c.room=roomName;c.name=safeName(m.name);c.team=assignTeam(room,m.team);c.teamName=teamName(c.team);const sp=randomSpawn();c.x=sp.x;c.y=sp.y;c.lastReportedX=c.x;c.lastReportedY=c.y;c.joined=true;room.players.set(c.id,c);send(ws,{...snapshot(room,c,Date.now(),'welcome'),id:c.id,team:c.team,teamName:c.teamName});broadcast(room,{type:'player_joined',player:publicPlayer(c)},c.id);return;}if(!c.joined)return;const room=rooms.get(c.room);if(!room)return;if(m.type==='state'){updatePlayerFromClientReport(c,m);return;}if(m.type==='consume'){handleConsume(room,c,m.entityId);return;}if(m.type==='boss_hit'){const boss=room.bossId?room.entities.get(room.bossId):null;if(!boss)return;if(dist(c,boss)>420)return;boss.bossHits++;broadcast(room,{type:'boss_state',boss:{id:boss.id,hits:boss.bossHits,vulnerableTail:boss.vulnerableTail,chasing:!!boss.chasing}});if(boss.bossHits>=5){if(room.stage===1)setStage(room,2);else if(room.stage===3)setStage(room,4);}return;}if(m.type==='boss_defeated'){if(room.stage===1)setStage(room,2);else if(room.stage===3)setStage(room,4);return;}if(m.type==='leave'){try{ws.close();}catch{}}});ws.on('close',()=>removeClient(c));});
let lastSnapshot=0;
setInterval(()=>{const now=Date.now(),dt=TICK_MS/1000;for(const room of rooms.values()){for(const p of room.players.values())movePlayer(p,dt);for(const e of room.entities.values())updateEntity(e,room,dt);handleFishCollisions(room);handlePlayerCollisions(room);maybeAdvanceStage(room);if(now-lastSnapshot>=SNAPSHOT_MS)for(const p of room.players.values())send(p.ws,snapshot(room,p,now,'snapshot'));}if(now-lastSnapshot>=SNAPSHOT_MS)lastSnapshot=now;},TICK_MS);
http.listen(PORT,HOST,()=>console.log(`Nany authoritative multiplayer server on ${HOST}:${PORT}`));
