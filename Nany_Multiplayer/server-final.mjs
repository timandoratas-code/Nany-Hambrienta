import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT || 10000);
const WORLD_W = 12000;
const WORLD_H = 12000;
const TICK_MS = 50;
const MAX_PLAYERS = 8;
const MAX_STEP = 11;
const FISH_COUNT = 240;

const rooms = new Map();
const normalizeRoom = value => String(value || 'ABISMO01').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 16) || 'ABISMO01';
const normalizeMode = value => ['teams', 'ffa', 'coop'].includes(value) ? value : 'teams';
const safeName = value => String(value || 'Nany').trim().slice(0, 18) || 'Nany';
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const send = (ws, msg) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };
const dist = (a,b) => Math.hypot(a.x-b.x,a.y-b.y);

function seedRand(seed){
  let s=(seed>>>0)||1;
  return ()=>{ s^=s<<13;s>>>=0; s^=s>>>17;s>>>=0; s^=s<<5;s>>>=0; return (s>>>0)/4294967296; };
}

function fishTypeForIndex(i){
  const types=[
    {key:'plankton',size:3,power:1,color:'#8fffb0',speed:.30,points:5,role:'prey'},
    {key:'minnow',size:7,power:2,color:'#bfe6ff',speed:.90,points:10,role:'prey'},
    {key:'green',size:9,power:3,color:'#39ff6a',speed:1.60,points:20,role:'prey'},
    {key:'piranha',size:12,power:4,color:'#ff8a3d',speed:1.70,points:35,role:'predator'},
    {key:'stick',size:15,power:5,color:'#e0c66a',speed:.70,points:50,role:'predator'},
    {key:'rival',size:19,power:6,color:'#a084ff',speed:1.10,points:75,role:'predator'},
    {key:'shark',size:28,power:8,color:'#6d8796',speed:1.40,points:150,role:'predator'}
  ];
  if(i<120)return types[0]; if(i<175)return types[1]; if(i<205)return types[2]; if(i<225)return types[3]; if(i<236)return types[4]; if(i<239)return types[5]; return types[6];
}

function buildFishWorld(room){
  const r=seedRand(room.seed); const fish=new Map();
  for(let i=0;i<FISH_COUNT;i++){
    const t=fishTypeForIndex(i); const a=r()*Math.PI*2; const speed=t.speed*(.78+r()*.34);
    fish.set(`fish-${i}`,{id:`fish-${i}`,type:t.key,role:t.role,power:t.power,size:t.size*(.86+r()*.28),points:t.points,color:t.color,speed,
      x:100+r()*(WORLD_W-200),y:100+r()*(WORLD_H-200),vx:Math.cos(a)*speed*.5,vy:Math.sin(a)*speed*.5,angle:a,heading:a,turnTimer:.8+r()*1.8});
  }
  room.fish=fish;
}

function newRoom(code,mode){
  const room={code,mode,createdAt:Date.now(),seed:Math.floor(Math.random()*0xffffffff)>>>0||1,epoch:Date.now(),players:new Map(),anchor:{x:WORLD_W/2,y:WORLD_H/2},fish:new Map()};
  buildFishWorld(room); rooms.set(code,room); return room;
}

function chooseTeam(room,requested){
  if(room.mode!=='teams')return null; const a=[...room.players.values()].filter(p=>p.team==='A').length; const b=[...room.players.values()].filter(p=>p.team==='B').length;
  if((requested==='A'||requested==='B')&&Math.abs(a-b)<=1)return requested; return a<=b?'A':'B';
}
function spawnFor(room){
  const ps=[...room.players.values()]; if(!ps.length)return {x:room.anchor.x,y:room.anchor.y}; const p=ps[0],a=Math.random()*Math.PI*2,r=90+Math.random()*100;
  return {x:clamp(p.x+Math.cos(a)*r,100,WORLD_W-100),y:clamp(p.y+Math.sin(a)*r,100,WORLD_H-100)};
}
function publicPlayer(p){return {id:p.id,name:p.name,x:+p.x.toFixed(2),y:+p.y.toFixed(2),vx:+p.vx.toFixed(2),vy:+p.vy.toFixed(2),angle:+p.angle.toFixed(3),score:Math.floor(p.score),growthScore:Math.floor(p.growthScore),level:p.level,radius:+p.radius.toFixed(2),power:p.power,alive:p.alive,sprinting:p.sprinting,team:p.team,teamName:p.team==='A'?'Azul':p.team==='B'?'Rojo':null};}
function publicFish(f){return {id:f.id,type:f.type,role:f.role,power:f.power,size:+f.size.toFixed(2),points:f.points,color:f.color,x:+f.x.toFixed(2),y:+f.y.toFixed(2),vx:+f.vx.toFixed(2),vy:+f.vy.toFixed(2),angle:+f.angle.toFixed(3)};}
function snapshot(room,viewer){return {type:'snapshot',room:room.code,mode:room.mode,population:room.players.size,worldSeed:room.seed,worldEpoch:room.epoch,worldStage:0,players:[...room.players.values()].map(publicPlayer),you:viewer?publicPlayer(viewer):null,player:viewer?publicPlayer(viewer):null,entities:[...room.fish.values()].map(publicFish)};}
function welcome(room,p){return {type:'welcome',id:p.id,room:room.code,mode:room.mode,team:p.team,teamName:p.team==='A'?'Azul':p.team==='B'?'Rojo':null,worldSeed:room.seed,worldEpoch:room.epoch,worldStage:0,boss:null,players:[...room.players.values()].map(publicPlayer),player:publicPlayer(p)};}
function broadcast(room){for(const p of room.players.values())send(p.ws,snapshot(room,p));}

function applyClientState(p,m){
  const x=Number(m.x),y=Number(m.y); if(!Number.isFinite(x)||!Number.isFinite(y))return;
  const dx=x-p.lastReportX,dy=y-p.lastReportY,d=Math.hypot(dx,dy); p.lastReportX=x;p.lastReportY=y;
  if(d>.05){const cap=Math.min(d,MAX_STEP),nx=dx/d,ny=dy/d;p.targetX=clamp(p.x+nx*cap,0,WORLD_W);p.targetY=clamp(p.y+ny*cap,0,WORLD_H);}
  p.targetScore=Number.isFinite(Number(m.score))?Math.max(0,Number(m.score)):p.targetScore;
  p.targetGrowth=Number.isFinite(Number(m.growthScore))?Math.max(0,Number(m.growthScore)):p.targetGrowth;
  p.level=Number.isFinite(Number(m.level))?Math.max(1,Math.floor(Number(m.level))):p.level;
  p.radius=Number.isFinite(Number(m.radius))?clamp(Number(m.radius),8,320):p.radius;
  p.power=Number.isFinite(Number(m.power))?clamp(Number(m.power),1,12):p.power;
  p.sprinting=!!m.sprinting; p.lastInputAt=Date.now();
}

function updateFish(room,dt){
  const players=[...room.players.values()].filter(p=>p.alive);
  for(const f of room.fish.values()){
    let target=null,nearest=Infinity;
    for(const p of players){
      const d=dist(f,p);
      if(f.role==='predator' && p.power>=f.power)continue;
      if(f.role==='prey' && p.power<=f.power)continue;
      const range=f.role==='predator'?260:150;
      if(d<range&&d<nearest){nearest=d;target=p;}
    }
    if(target){
      const a=Math.atan2(target.y-f.y,target.x-f.x),turn=f.role==='predator'?.12:.14;
      f.vx+=Math.cos(a)*f.speed*turn; f.vy+=Math.sin(a)*f.speed*turn;
    }else if(f.turnTimer<=0){
      f.turnTimer=.8+Math.random()*1.8; f.heading+=(Math.random()-.5)*1.4; f.vx+=Math.cos(f.heading)*f.speed*.18; f.vy+=Math.sin(f.heading)*f.speed*.18;
    }
    f.turnTimer-=dt;
    const sp=Math.hypot(f.vx,f.vy)||.0001; if(sp>f.speed){f.vx=f.vx/sp*f.speed;f.vy=f.vy/sp*f.speed;}
    f.x=clamp(f.x+f.vx*dt*60,30,WORLD_W-30); f.y=clamp(f.y+f.vy*dt*60,30,WORLD_H-30);
    if(f.x<=30||f.x>=WORLD_W-30){f.vx*=-1;f.heading=Math.PI-f.heading;}
    if(f.y<=30||f.y>=WORLD_H-30){f.vy*=-1;f.heading=-f.heading;}
    f.angle=Math.atan2(f.vy,f.vx);
  }
}
function tickRoom(room,dt){
  for(const p of room.players.values()){
    const dx=p.targetX-p.x,dy=p.targetY-p.y,d=Math.hypot(dx,dy);
    if(d>.01){const step=Math.min(d,MAX_STEP*1.35);p.vx=dx/d*step;p.vy=dy/d*step;p.x=clamp(p.x+p.vx,0,WORLD_W);p.y=clamp(p.y+p.vy,0,WORLD_H);p.angle=Math.atan2(p.vy,p.vx);}else{p.vx*=.75;p.vy*=.75;}
    if(Date.now()-p.lastInputAt>350){p.targetX=p.x;p.targetY=p.y;}
    p.score=p.targetScore;p.growthScore=p.targetGrowth;
  }
  updateFish(room,dt);
}

function injectNavigation(html){
  const script=`<script>(()=>{let s=null,r=null,w=null;const M=()=>{try{return window.eval('typeof Multiplayer!=="undefined"?Multiplayer:undefined')}catch(_){return null}};const on=()=>{const m=M();return !!(m&&m.isConnected&&m.isConnected())};const rc=()=>{const m=M();return m&&typeof m.room==='function'?m.room():null};function c(){const x=rc();if(!on()||!x||x===r)return;r=x;try{s?.close()}catch(_){}s=new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host+'/ws');s.onopen=()=>s.send(JSON.stringify({type:'spectator',room:x}));s.onmessage=e=>{try{const m=JSON.parse(e.data);if(m.type==='snapshot')w=m}catch(_){}}}function sync(){if(!on()||!w?.entities)return;try{const g=window.eval('typeof game!=="undefined"?game:null');if(!g||!g.running)return;g.entities=w.entities.map(f=>({...f,life:0,wobble:f.angle||0,coin:false,gemFish:false,hazard:null,behavior:f.role==='predator'?'aggro':'drift'}));}catch(_){} }function nav(){if(!on()||!w?.you)return;const mini=document.getElementById('minimap');if(mini){const q=mini.getContext('2d'),sx=mini.width/${WORLD_W},sy=mini.height/${WORLD_H};for(const p of w.players||[]){if(!p.alive||p.id===w.you.id)continue;q.fillStyle='#fff';q.beginPath();q.arc(p.x*sx,p.y*sy,4,0,Math.PI*2);q.fill();}}}function loop(){c();sync();nav();requestAnimationFrame(loop)}requestAnimationFrame(loop)})();</script>`;
  return html.replace('</body>',script+'</body>');
}

const server=createServer(async(req,res)=>{try{const u=new URL(req.url||'/','http://localhost');if(u.pathname==='/health'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});return res.end(JSON.stringify({ok:true,rooms:rooms.size,players:[...rooms.values()].reduce((n,x)=>n+x.players.size,0),fishPerRoom:FISH_COUNT}));}if(u.pathname==='/'||u.pathname==='/index.html'){let html=await readFile(join(ROOT,'index.html'),'utf8');html=injectNavigation(html);res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});return res.end(html);}res.writeHead(404);res.end('Not found')}catch(e){res.writeHead(500);res.end('Server error')}});
const wss=new WebSocketServer({server,path:'/ws'});
wss.on('connection',ws=>{const id=Math.random().toString(36).slice(2)+Date.now().toString(36);let player=null,room=null;ws.on('message',raw=>{let m;try{m=JSON.parse(raw.toString())}catch{return;}if(m.type==='spectator'){const code=normalizeRoom(m.room),rr=rooms.get(code);return send(ws,rr?snapshot(rr,rr.players.values().next().value||null):{type:'snapshot',room:code,mode:'teams',population:0,players:[],you:null,entities:[]});}if(m.type==='join'){const code=normalizeRoom(m.room);room=rooms.get(code)||newRoom(code,normalizeMode(m.mode));if(room.players.size>=MAX_PLAYERS)return send(ws,{type:'error',message:'Sala llena'});const team=chooseTeam(room,m.team),pos=spawnFor(room);player={id,ws,name:safeName(m.name),room:code,team,x:pos.x,y:pos.y,targetX:pos.x,targetY:pos.y,lastReportX:pos.x,lastReportY:pos.y,vx:0,vy:0,angle:0,score:0,growthScore:0,targetScore:0,targetGrowth:0,level:1,radius:11,power:1,alive:true,sprinting:false,lastInputAt:Date.now()};room.players.set(id,player);send(ws,welcome(room,player));broadcast(room);return;}if(m.type==='state'&&player&&room){applyClientState(player,m);return;}if(m.type==='leave')ws.close();});ws.on('close',()=>{if(!player||!room)return;room.players.delete(player.id);if(!room.players.size)rooms.delete(room.code);else broadcast(room);});});
let last=Date.now();setInterval(()=>{const now=Date.now(),dt=Math.min(.05,(now-last)/1000);last=now;for(const rr of rooms.values())tickRoom(rr,dt);for(const rr of rooms.values())broadcast(rr);},TICK_MS);
server.listen(PORT,'0.0.0.0',()=>console.log(`NANY FINAL AUTHORITATIVE ${PORT} fish=${FISH_COUNT}`));
