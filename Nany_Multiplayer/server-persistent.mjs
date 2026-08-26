import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const PORT = Number(process.env.PORT || 10000);
const STATE_FILE = path.join(ROOT, 'runtime-world.json');
const W = 12000, H = 12000;
const TICK_HZ = 30, SNAP_HZ = 20;
const MAX_PLAYERS = 8, FISH_N = 260, MAX_STEP = 11;
const CHASE_MS = 1000, COOLDOWN_MS = 5000, HIT_CD = 900;
const rooms = new Map();
let dirty = false;

const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const send=(ws,msg)=>{if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify(msg));};
const roomCode=v=>String(v||'ABISMO01').trim().toUpperCase().replace(/[^A-Z0-9_-]/g,'').slice(0,16)||'ABISMO01';
const gameMode=v=>['teams','ffa','coop'].includes(v)?v:'teams';
const safeName=v=>String(v||'Nany').trim().slice(0,18)||'Nany';
const rng=seed=>{let s=(seed>>>0)||1;return()=>{s^=s<<13;s>>>=0;s^=s>>>17;s>>>=0;s^=s<<5;s>>>=0;return(s>>>0)/4294967296;};};
const playerPower=s=>s<100?1:s<250?2:s<500?3:s<900?4:s<1500?5:s<2500?6:s<4000?7:s<6000?8:s<9000?9:10;
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
const typeForIndex=i=>i<120?TYPES[0]:i<170?TYPES[1]:i<200?TYPES[2]:i<225?TYPES[3]:i<245?TYPES[4]:i<258?TYPES[5]:i===258?TYPES[6]:TYPES[7];

function buildFish(room){
  const r=rng(room.seed);
  room.fish=[];
  for(let i=0;i<FISH_N;i++){
    const t=typeForIndex(i), a=r()*Math.PI*2, speed=t.speed*(.82+r()*.30);
    room.fish.push({id:`fish-${i}`,type:t.key,role:t.role,power:t.power,points:t.points,color:t.color,size:t.size*(.88+r()*.24),speed,x:100+r()*(W-200),y:100+r()*(H-200),vx:Math.cos(a)*speed*.55,vy:Math.sin(a)*speed*.55,angle:a,heading:a,turn:.8+r()*1.7,phase:r()*Math.PI*2,chaseId:null,chaseUntil:0,cooldownUntil:0,hitUntil:0});
  }
}

function makeRoom(code,mode){
  const room={code,mode,seed:(Math.floor(Math.random()*0xffffffff)>>>0)||1,epoch:Date.now(),tick:0,players:new Map(),fish:[],anchor:{x:W/2,y:H/2}};
  buildFish(room);rooms.set(code,room);dirty=true;return room;
}

function chooseTeam(room,want){
  if(room.mode!=='teams')return null;
  const a=[...room.players.values()].filter(p=>p.team==='A').length;
  const b=[...room.players.values()].filter(p=>p.team==='B').length;
  if((want==='A'||want==='B')&&Math.abs(a-b)<=1)return want;
  return a<=b?'A':'B';
}

function spawnFor(room){
  const ps=[...room.players.values()];
  if(!ps.length)return {...room.anchor};
  const a=Math.random()*Math.PI*2,d=90+Math.random()*100,p=ps[0];
  return {x:clamp(p.x+Math.cos(a)*d,100,W-100),y:clamp(p.y+Math.sin(a)*d,100,H-100)};
}

function pubPlayer(p){return{id:p.id,name:p.name,x:+p.x.toFixed(2),y:+p.y.toFixed(2),vx:+p.vx.toFixed(2),vy:+p.vy.toFixed(2),angle:+p.angle.toFixed(3),score:Math.floor(p.score),growthScore:Math.floor(p.score),radius:+p.radius.toFixed(2),power:playerPower(p.score),level:p.level,lives:p.lives,alive:p.alive,sprinting:p.sprinting,team:p.team,teamName:p.team==='A'?'Azul':p.team==='B'?'Rojo':null,invulnerableUntil:p.invulnerableUntil};}
function pubFish(f){return{id:f.id,type:f.type,role:f.role,power:f.power,points:f.points,size:+f.size.toFixed(2),color:f.color,x:+f.x.toFixed(2),y:+f.y.toFixed(2),vx:+f.vx.toFixed(3),vy:+f.vy.toFixed(3),angle:+f.angle.toFixed(3)};}
function snapshot(room){return{type:'snapshot',room:room.code,mode:room.mode,population:room.players.size,worldSeed:room.seed,worldEpoch:room.epoch,worldTick:room.tick,serverTime:Date.now(),players:[...room.players.values()].map(pubPlayer),entities:room.fish.map(pubFish)};}
function welcome(room,p){return{type:'welcome',id:p.id,room:room.code,mode:room.mode,team:p.team,teamName:p.team==='A'?'Azul':p.team==='B'?'Rojo':null,worldSeed:room.seed,worldEpoch:room.epoch,worldTick:room.tick,serverTime:Date.now(),players:[...room.players.values()].map(pubPlayer),you:pubPlayer(p),player:pubPlayer(p),entities:room.fish.map(pubFish)};}
function broadcast(room){const base=snapshot(room);for(const p of room.players.values())send(p.ws,{...base,you:pubPlayer(p),player:pubPlayer(p)});}

function applyInput(p,m){
  const x=Number(m.x),y=Number(m.y);
  if(!Number.isFinite(x)||!Number.isFinite(y))return;
  const dx=x-p.lastX,dy=y-p.lastY,d=Math.hypot(dx,dy);
  p.lastX=x;p.lastY=y;
  if(d>.05){const step=Math.min(d,MAX_STEP);p.tx=clamp(p.x+dx/d*step,0,W);p.ty=clamp(p.y+dy/d*step,0,H);}
  if(Number.isFinite(Number(m.radius)))p.radius=clamp(Number(m.radius),8,320);
  p.sprinting=!!m.sprinting;p.lastInputAt=Date.now();
}

function movePlayers(room){
  for(const p of room.players.values()){
    if(!p.alive)continue;
    const dx=p.tx-p.x,dy=p.ty-p.y,d=Math.hypot(dx,dy);
    if(d>.01){const step=Math.min(d,MAX_STEP*1.35);p.vx=dx/d*step;p.vy=dy/d*step;p.x=clamp(p.x+p.vx,0,W);p.y=clamp(p.y+p.vy,0,H);p.angle=Math.atan2(p.vy,p.vx);}else{p.vx*=.75;p.vy*=.75;}
    if(Date.now()-p.lastInputAt>350){p.tx=p.x;p.ty=p.y;}
  }
}

function updateFish(room,dt){
  const now=Date.now(),players=[...room.players.values()].filter(p=>p.alive);
  for(const f of room.fish){
    let target=f.chaseId&&f.chaseUntil>now?room.players.get(f.chaseId):null;
    if(!target&&f.cooldownUntil<=now){
      let best=null,bd=Infinity;
      for(const p of players){
        const d=Math.hypot(p.x-f.x,p.y-f.y),pp=playerPower(p.score);
        const can=f.role==='predator'?(f.power>pp&&f.size>p.radius*1.02&&d<=320&&p.invulnerableUntil<=now):(pp>f.power&&p.radius>f.size*.98&&d<=170);
        if(can&&d<bd){bd=d;best=p;}
      }
      if(best){target=best;f.chaseId=best.id;f.chaseUntil=now+CHASE_MS;}
    }
    if(f.chaseId&&f.chaseUntil<=now){f.chaseId=null;f.cooldownUntil=now+COOLDOWN_MS;target=null;}
    if(target&&f.chaseUntil>now){const a=Math.atan2(target.y-f.y,target.x-f.x),k=f.role==='predator'?.24:.18;f.vx+=Math.cos(a)*f.speed*k;f.vy+=Math.sin(a)*f.speed*k;}
    else{if(f.turn<=0){f.turn=.8+((Math.sin(f.phase+now*.0013)+1)*.5)*1.4;f.heading+=Math.sin(f.phase+now*.0009)*.55;f.vx+=Math.cos(f.heading)*f.speed*.16;f.vy+=Math.sin(f.heading)*f.speed*.16;}f.turn-=dt;}
    const sp=Math.hypot(f.vx,f.vy)||.0001;if(sp>f.speed){f.vx=f.vx/sp*f.speed;f.vy=f.vy/sp*f.speed;}
    f.x=clamp(f.x+f.vx*dt*60,30,W-30);f.y=clamp(f.y+f.vy*dt*60,30,H-30);
    if(f.x<=30||f.x>=W-30){f.vx*=-1;f.heading=Math.PI-f.heading;}
    if(f.y<=30||f.y>=H-30){f.vy*=-1;f.heading=-f.heading;}
    f.angle=Math.atan2(f.vy,f.vx);
  }
}

function combat(room){
  const now=Date.now();
  for(const p of room.players.values()){
    if(!p.alive||p.invulnerableUntil>now)continue;
    const pp=playerPower(p.score);
    for(const f of room.fish){
      if(f.hitUntil>now)continue;
      const d=Math.hypot(p.x-f.x,p.y-f.y);if(d>p.radius*.86+f.size*.86)continue;
      if(f.power<pp&&f.size<p.radius*.98){
        p.score+=f.points;f.hitUntil=now+HIT_CD;f.chaseId=null;f.chaseUntil=0;f.cooldownUntil=now+3000;
        const n=(Number(f.id.replace('fish-',''))+1)*997;f.x=100+Math.abs(Math.sin(n))*(W-200);f.y=100+Math.abs(Math.cos(n))*(H-200);
        dirty=true;
      }else if(f.power>pp&&f.size>p.radius*1.02){
        p.lives=Math.max(0,p.lives-1);p.score=Math.max(0,Math.floor(p.score*.5));p.invulnerableUntil=now+2500;f.chaseId=null;f.cooldownUntil=now+COOLDOWN_MS;
        p.x=clamp(room.anchor.x+(Math.random()-.5)*220,100,W-100);p.y=clamp(room.anchor.y+(Math.random()-.5)*220,100,H-100);if(p.lives<=0)p.alive=false;dirty=true;
      }
    }
  }
}

function tickRoom(room,dt){movePlayers(room);updateFish(room,dt);combat(room);room.tick++;dirty=true;}

async function saveWorld(){
  if(!dirty)return;
  const payload={version:1,savedAt:Date.now(),rooms:[...rooms.values()].map(r=>({code:r.code,mode:r.mode,seed:r.seed,epoch:r.epoch,tick:r.tick,anchor:r.anchor,fish:r.fish}))};
  try{await fs.writeFile(STATE_FILE,JSON.stringify(payload), 'utf8');dirty=false;}catch(err){console.error('WORLD SAVE ERROR',err);}
}

async function loadWorld(){
  try{
    const raw=await fs.readFile(STATE_FILE,'utf8');const data=JSON.parse(raw);
    for(const saved of data.rooms||[]){
      if(!saved.code||!Array.isArray(saved.fish)||saved.fish.length!==FISH_N)continue;
      rooms.set(saved.code,{code:saved.code,mode:gameMode(saved.mode),seed:saved.seed,epoch:saved.epoch||Date.now(),tick:saved.tick||0,players:new Map(),fish:saved.fish,anchor:saved.anchor||{x:W/2,y:H/2}});
    }
    console.log(`Loaded ${rooms.size} persistent room(s)`);
  }catch(err){if(err.code!=='ENOENT')console.error('WORLD LOAD ERROR',err);}
}

const server=http.createServer(async(req,res)=>{
  try{
    const u=new URL(req.url||'/','http://localhost');
    if(u.pathname==='/health'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});return res.end(JSON.stringify({ok:true,rooms:rooms.size,players:[...rooms.values()].reduce((n,r)=>n+r.players.size,0),fishPerRoom:FISH_N,tickHz:TICK_HZ,snapshotHz:SNAP_HZ}));}
    if(u.pathname==='/'||u.pathname==='/index.html'){const html=await fs.readFile(path.join(ROOT,'index.html'),'utf8');res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});return res.end(html);}
    res.writeHead(404);res.end('Not found');
  }catch(err){console.error('HTTP ERROR',err);res.writeHead(500);res.end('Server error');}
});

const wss=new WebSocketServer({server,path:'/ws'});
wss.on('connection',ws=>{
  const id=Math.random().toString(36).slice(2)+Date.now().toString(36);let p=null,room=null;
  ws.on('message',raw=>{
    let m;try{m=JSON.parse(raw.toString());}catch{return;}
    if(m.type==='join'){
      const code=roomCode(m.room);room=rooms.get(code)||makeRoom(code,gameMode(m.mode));
      if(room.players.size>=MAX_PLAYERS)return send(ws,{type:'error',message:'Sala llena'});
      const team=chooseTeam(room,m.team),pos=spawnFor(room);
      p={id,ws,name:safeName(m.name),team,x:pos.x,y:pos.y,tx:pos.x,ty:pos.y,lastX:pos.x,lastY:pos.y,vx:0,vy:0,angle:0,score:0,radius:11,level:1,lives:1,alive:true,sprinting:false,lastInputAt:Date.now(),invulnerableUntil:Date.now()+1200};
      room.players.set(id,p);send(ws,welcome(room,p));broadcast(room);return;
    }
    if(m.type==='state'&&p&&room){applyInput(p,m);return;}
    if(m.type==='leave')ws.close();
  });
  ws.on('close',()=>{if(!p||!room)return;room.players.delete(p.id);dirty=true;/* room intentionally remains alive */});
});

await loadWorld();
setInterval(()=>{for(const room of rooms.values())tickRoom(room,1/TICK_HZ);},1000/TICK_HZ);
setInterval(()=>{for(const room of rooms.values())if(room.players.size)broadcast(room);},1000/SNAP_HZ);
setInterval(saveWorld,2000);
setInterval(()=>{if(dirty)void saveWorld();},10000);

server.listen(PORT,'0.0.0.0',()=>console.log(`NANY AUTHORITATIVE PERSISTENT WORLD ${PORT}`));
