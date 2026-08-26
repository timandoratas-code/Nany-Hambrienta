import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const PORT = Number(process.env.PORT || 10000);
const W = 12000, H = 12000;
const TICK_HZ = 30, SNAP_HZ = 20;
const MAX_PLAYERS = 8;
const RESUME_MS = 10 * 60 * 1000;
const HEARTBEAT_MS = 15000;
const FISH_N = 260;
const RESPAWN_MS = 1500;

const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));
const send = (ws,m)=>{ if(ws?.readyState===WebSocket.OPEN) ws.send(JSON.stringify(m)); };
const safeName = v=>String(v||'Nany').trim().slice(0,18)||'Nany';
const worldForMode = v => v==='ffa'||v==='pvp' ? ['PVP','ffa'] : v==='coop'||v==='pve' ? ['PVE','coop'] : ['EQUIPO','teams'];
const playerPower = s => s<100?1:s<250?2:s<500?3:s<900?4:s<1500?5:s<2500?6:s<4000?7:s<6000?8:s<9000?9:10;
const playerRadius = s => clamp(11 + Math.sqrt(Math.max(0,s))*0.62, 11, 320);
const distance = (a,b)=>Math.hypot(a.x-b.x,a.y-b.y);

const TYPES = [
  {key:'plankton',role:'prey',power:1,points:5,color:'#8fffb0',size:3,speed:.30},
  {key:'minnow',role:'prey',power:2,points:10,color:'#bfe6ff',size:7,speed:.90},
  {key:'green',role:'prey',power:3,points:20,color:'#39ff6a',size:9,speed:1.60},
  {key:'piranha',role:'predator',power:4,points:35,color:'#ff8a3d',size:12,speed:1.70},
  {key:'stick',role:'predator',power:5,points:50,color:'#e0c66a',size:15,speed:.70},
  {key:'rival',role:'predator',power:6,points:75,color:'#a084ff',size:19,speed:1.10},
  {key:'shark',role:'predator',power:8,points:150,color:'#6d8796',size:28,speed:1.40},
  {key:'monster',role:'predator',power:10,points:300,color:'#8d2638',size:40,speed:1.10}
];
function typeAt(i){return i<120?TYPES[0]:i<170?TYPES[1]:i<200?TYPES[2]:i<225?TYPES[3]:i<245?TYPES[4]:i<258?TYPES[5]:i===258?TYPES[6]:TYPES[7];}
function rng(seed){let s=(seed>>>0)||1;return()=>{s^=s<<13;s>>>=0;s^=s>>>17;s>>>=0;s^=s<<5;s>>>=0;return(s>>>0)/4294967296;};}
function fish(w,index,r=Math.random){const t=typeAt(index),a=r()*Math.PI*2,s=t.speed*(.82+r()*.30),id=`${w.code}-fish-${index}-${w.serial++}`;return {id,index,type:t.key,role:t.role,power:t.power,points:t.points,color:t.color,size:t.size*(.88+r()*.24),speed:s,x:100+r()*(W-200),y:100+r()*(H-200),vx:Math.cos(a)*s*.55,vy:Math.sin(a)*s*.55,angle:a,heading:a,turn:.8+r()*1.7,phase:r()*Math.PI*2,chaseId:null,chaseUntil:0,cooldownUntil:0};}
function makeWorld(code,mode){const w={code,mode,seed:(Math.random()*0xffffffff)>>>0,epoch:Date.now(),tick:0,players:new Map(),fish:new Map(),respawns:[],serial:0};const r=rng(w.seed);for(let i=0;i<FISH_N;i++){const f=fish(w,i,r);w.fish.set(f.id,f);}return w;}
const worlds = new Map([['PVP',makeWorld('PVP','ffa')],['PVE',makeWorld('PVE','coop')],['EQUIPO',makeWorld('EQUIPO','teams')]]);

function teamFor(w,want){if(w.mode!=='teams')return null;const a=[...w.players.values()].filter(p=>p.connected&&p.team==='A').length,b=[...w.players.values()].filter(p=>p.connected&&p.team==='B').length;if((want==='A'||want==='B')&&Math.abs(a-b)<=1)return want;return a<=b?'A':'B';}
function spawn(w){const active=[...w.players.values()].filter(p=>p.connected&&p.alive);if(!active.length)return{x:W/2,y:H/2};const p=active[Math.floor(Math.random()*active.length)],a=Math.random()*Math.PI*2,d=100+Math.random()*120;return{x:clamp(p.x+Math.cos(a)*d,100,W-100),y:clamp(p.y+Math.sin(a)*d,100,H-100)};}
function publicPlayer(p){return {id:p.id,name:p.name,deviceId:p.deviceId,x:+p.x.toFixed(2),y:+p.y.toFixed(2),vx:+p.vx.toFixed(2),vy:+p.vy.toFixed(2),angle:+p.angle.toFixed(3),score:Math.floor(p.score),radius:+p.radius.toFixed(2),power:playerPower(p.score),level:p.level,lives:p.lives,alive:p.alive,sprinting:p.sprinting,team:p.team||null,teamName:p.team==='A'?'Azul':p.team==='B'?'Rojo':null};}
function publicFish(f){return {id:f.id,type:f.type,role:f.role,power:f.power,points:f.points,size:+f.size.toFixed(2),color:f.color,x:+f.x.toFixed(2),y:+f.y.toFixed(2),vx:+f.vx.toFixed(4),vy:+f.vy.toFixed(4),angle:+f.angle.toFixed(4)};}
function snapshot(w){return {type:'snapshot',room:w.code,mode:w.mode,population:[...w.players.values()].filter(p=>p.connected).length,serverTick:w.tick,serverTime:Date.now(),worldSeed:w.seed,worldEpoch:w.epoch,players:[...w.players.values()].filter(p=>p.connected||Date.now()-p.disconnectedAt<RESUME_MS).map(publicPlayer),entities:[...w.fish.values()].map(publicFish)};}
function sendSnapshot(w){const s=snapshot(w);for(const p of w.players.values())if(p.connected)send(p.ws,{...s,you:publicPlayer(p),player:publicPlayer(p)});}

function updateFish(w,dt){const now=Date.now();const players=[...w.players.values()].filter(p=>p.connected&&p.alive);for(let i=w.respawns.length-1;i>=0;i--){const r=w.respawns[i];if(now<r.at)continue;const f=fish(w,r.index);w.fish.set(f.id,f);w.respawns.splice(i,1);}
for(const f of w.fish.values()){
  let target = f.chaseId && f.chaseUntil>now ? w.players.get(f.chaseId) : null;
  if(!target && f.cooldownUntil<=now){let best=null,bd=Infinity;for(const p of players){const d=distance(f,p),pp=playerPower(p.score),pr=playerRadius(p.score);const can=f.role==='predator'?f.power>pp&&f.size>pr*1.02&&d<340:pp>f.power&&pr>f.size*.98&&d<180;if(can&&d<bd){best=p;bd=d;}}if(best){target=best;f.chaseId=best.id;f.chaseUntil=now+1000;}}
  if(f.chaseId&&f.chaseUntil<=now){f.chaseId=null;f.cooldownUntil=now+5000;target=null;}
  if(target){const a=Math.atan2(target.y-f.y,target.x-f.x),k=f.role==='predator'?.24:.18;f.vx+=Math.cos(a)*f.speed*k;f.vy+=Math.sin(a)*f.speed*k;}
  else if(f.turn<=0){f.turn=.8+Math.random()*1.8;f.heading+=(Math.random()-.5)*1.1;f.vx+=Math.cos(f.heading)*f.speed*.16;f.vy+=Math.sin(f.heading)*f.speed*.16;}
  else f.turn-=dt;
  const sp=Math.hypot(f.vx,f.vy)||.0001;if(sp>f.speed){f.vx=f.vx/sp*f.speed;f.vy=f.vy/sp*f.speed;}
  f.x=clamp(f.x+f.vx*dt*60,30,W-30);f.y=clamp(f.y+f.vy*dt*60,30,H-30);
  if(f.x<=30||f.x>=W-30){f.vx*=-1;f.heading=Math.PI-f.heading;}
  if(f.y<=30||f.y>=H-30){f.vy*=-1;f.heading=-f.heading;}
  f.angle=Math.atan2(f.vy,f.vx);
}}

function killPlayer(w,p,reason){if(!p.alive)return;p.alive=false;send(p.ws,{type:'player_dead',id:p.id,reason});setTimeout(()=>{const current=w.players.get(p.id);if(!current)return;const pos=spawn(w);current.x=pos.x;current.y=pos.y;current.tx=current.x;current.ty=current.y;current.vx=0;current.vy=0;current.score=Math.floor(current.score*.5);current.radius=playerRadius(current.score);current.alive=true;current.lives=Math.max(1,current.lives);current.invulnerableUntil=Date.now()+1500;send(current.ws,{type:'respawn',player:publicPlayer(current)});sendSnapshot(w);},1000);}
function combat(w){const now=Date.now();for(const p of w.players.values()){
 if(!p.connected||!p.alive||p.invulnerableUntil>now)continue;
 const pp=playerPower(p.score),pr=playerRadius(p.score);
 for(const f of [...w.fish.values()]){const d=distance(p,f);if(d>pr*.86+f.size*.86)continue;if(f.power<pp&&f.size<pr){p.score+=f.points;w.fish.delete(f.id);w.respawns.push({index:f.index,at:now+RESPAWN_MS});continue;}if(f.power>pp&&f.size>pr*1.02){p.lives=Math.max(0,p.lives-1);p.score=Math.floor(p.score*.5);p.invulnerableUntil=now+2500;if(p.lives<=0)killPlayer(w,p,'fish');break;}}
}
const ps=[...w.players.values()].filter(p=>p.connected&&p.alive);for(let i=0;i<ps.length;i++)for(let j=i+1;j<ps.length;j++){const a=ps[i],b=ps[j];if(w.mode==='coop'||(w.mode==='teams'&&a.team===b.team))continue;const d=distance(a,b);const ar=playerRadius(a.score),br=playerRadius(b.score);if(d>ar*.82+br*.82)continue;if(a.score>=b.score+1&&ar>br){a.score+=Math.max(10,Math.floor(b.score*.25));a.radius=playerRadius(a.score);killPlayer(w,b,'player');}else if(b.score>=a.score+1&&br>ar){b.score+=Math.max(10,Math.floor(a.score*.25));b.radius=playerRadius(b.score);killPlayer(w,a,'player');}}
}
function movePlayers(w){for(const p of w.players.values()){if(!p.connected||!p.alive)continue;const dx=p.tx-p.x,dy=p.ty-p.y,d=Math.hypot(dx,dy);if(d>.01){const s=Math.min(d,14);p.vx=dx/d*s;p.vy=dy/d*s;p.x=clamp(p.x+p.vx,0,W);p.y=clamp(p.y+p.vy,0,H);p.angle=Math.atan2(p.vy,p.vx);}else{p.vx*=.75;p.vy*=.75;}if(Date.now()-p.lastInputAt>350){p.tx=p.x;p.ty=p.y;}}}
function applyInput(p,m){const x=Number(m.x),y=Number(m.y);if(!Number.isFinite(x)||!Number.isFinite(y))return;const dx=x-p.lastX,dy=y-p.lastY,d=Math.hypot(dx,dy);p.lastX=x;p.lastY=y;if(d>.05){const s=Math.min(d,12);p.tx=clamp(p.x+dx/d*s,0,W);p.ty=clamp(p.y+dy/d*s,0,H);}p.sprinting=!!m.sprinting;p.lastInputAt=Date.now();}

function makeDeviceId(){return 'nany-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2)+'-'+Math.random().toString(36).slice(2);}
const bridge = `<script>(()=>{const Native=window.WebSocket;const BUF='__NANY_LIVE_BUF__';const DEVICE='__NANY_DEVICE__';const getDevice=()=>{let d=localStorage.getItem(DEVICE);if(!d){d=(${makeDeviceId.toString()})();localStorage.setItem(DEVICE,d)}return d};window.__NANY_DEVICE_ID__=getDevice();function WrappedWS(url,protocols){let real=null,stopped=false,retry=0,join=null,lastState=null,api;const ev={open:new Set(),message:new Set(),close:new Set(),error:new Set()};const emit=(t,e)=>{for(const f of ev[t])try{f.call(api,e)}catch{};const h=api['on'+t];if(typeof h==='function')try{h.call(api,e)}catch{}};api={};Object.setPrototypeOf(api,Native.prototype);Object.defineProperty(api,'readyState',{get:()=>stopped?3:(real?.readyState??0)});Object.defineProperty(api,'url',{value:url});api.addEventListener=(t,f)=>{if(ev[t])ev[t].add(f)};api.removeEventListener=(t,f)=>{ev[t]?.delete(f)};api.send=data=>{try{const m=JSON.parse(data);if(m.type==='join'){join={...m,deviceId:getDevice()};localStorage.setItem('__NANY_JOIN__',JSON.stringify(join));}if(m.type==='state')lastState=m;}catch{}if(real?.readyState===1)real.send(data)};api.close=()=>{stopped=true;try{real?.close()}catch{};emit('close',new Event('close'))};function connect(){if(stopped)return;real=protocols===undefined?new Native(url):new Native(url,protocols);real.addEventListener('open',()=>{retry=0;let j=join;try{j=j||JSON.parse(localStorage.getItem('__NANY_JOIN__')||'null')}catch{};if(j)real.send(JSON.stringify(j));if(lastState)real.send(JSON.stringify(lastState));emit('open',new Event('open'))});real.addEventListener('message',e=>{try{const m=JSON.parse(e.data);if(m.type==='welcome')localStorage.setItem('__NANY_RESUME_ID__',m.resumeId||m.id||'');if(m.type==='snapshot'||m.type==='welcome'){const b=window[BUF]||(window[BUF]=[]);b.push({t:Number(m.serverTime)||Date.now(),m});while(b.length>30)b.shift();}}catch{}emit('message',e)});real.addEventListener('close',e=>{emit('close',e);if(!stopped)setTimeout(connect,Math.min(5000,250*Math.pow(1.5,retry++)))});real.addEventListener('error',e=>emit('error',e));}connect();return api;}for(const k of ['CONNECTING','OPEN','CLOSING','CLOSED'])WrappedWS[k]=Native[k];WrappedWS.prototype=Native.prototype;window.WebSocket=WrappedWS;window.__SERVER_AUTHORITATIVE_FISH__=true;window.__SERVER_SYNC_FISH__=function(){try{const g=window.eval('typeof game!=="undefined"?game:null'),b=window[BUF]||[];if(!g||!b.length)return;const target=Date.now()-75;let z=b[b.length-1],a=z;for(let i=b.length-1;i>=0;i--){if(b[i].t<=target){a=b[i];break;}}const A=a.m,Z=z.m;const ma=new Map((A.entities||[]).map(f=>[f.id,f])),mz=new Map((Z.entities||[]).map(f=>[f.id,f]));const out=[];for(const [id,fz] of mz){const fa=ma.get(id)||fz;const t=a===z?1:.5;out.push({serverId:id,type:fz.type,power:fz.power,points:fz.points,size:fz.size,color:fz.color,behavior:fz.role==='predator'?'aggro':'flee',speed:Math.max(.1,Math.hypot(fz.vx,fz.vy)),x:fa.x+(fz.x-fa.x)*t,y:fa.y+(fz.y-fa.y)*t,vx:fz.vx,vy:fz.vy,wobble:fz.angle||0,life:0});}g.entities=out;const me=Z.you||Z.player||A.you||A.player;if(me){g.score=me.score;g.lives=me.lives;g.player.x=me.x;g.player.y=me.y;g.player.vx=me.vx;g.player.vy=me.vy;g.player.angle=me.angle;}}catch{}};})();</script>`;

const server=http.createServer(async(req,res)=>{try{const u=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`);if(u.pathname==='/health'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});return res.end(JSON.stringify({ok:true,worlds:['PVP','PVE','EQUIPO'],fishPerWorld:FISH_N,tickHz:TICK_HZ,snapshotHz:SNAP_HZ,players:Object.fromEntries([...worlds].map(([k,w])=>[k,[...w.players.values()].filter(p=>p.connected).length]))}));}if(u.pathname==='/'||u.pathname==='/index.html'){const html=await fs.readFile(path.join(ROOT,'index.html'),'utf8');res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});return res.end(html.replace('</head>',bridge+'</head>'));}res.writeHead(404);res.end('Not found');}catch(e){res.writeHead(500);res.end('Server error')}});
const wss=new WebSocketServer({server,path:'/ws'});
wss.on('connection',ws=>{let player=null;let joined=false;ws.isAlive=true;ws.on('pong',()=>ws.isAlive=true);ws.on('message',raw=>{let m;try{m=JSON.parse(raw.toString())}catch{return}if(m.type==='join'){if(joined)return;joined=true;const [code,mode]=worldForMode(m.mode),w=worlds.get(code),deviceId=String(m.deviceId||'');let p=deviceId?[...w.players.values()].find(x=>x.deviceId===deviceId):null;if(p&&p.connected&&p.ws!==ws){try{p.ws.close(4001,'replaced')}catch{}}if(!p){if([...w.players.values()].filter(x=>x.connected).length>=MAX_PLAYERS)return send(ws,{type:'error',message:'Servidor lleno'});const pos=spawn(w);p={id:deviceId||makeDeviceId(),resumeId:makeDeviceId(),deviceId:deviceId||makeDeviceId(),ws:null,connected:false,disconnectedAt:0,name:safeName(m.name),team:teamFor(w,m.team),x:pos.x,y:pos.y,tx:pos.x,ty:pos.y,lastX:pos.x,lastY:pos.y,vx:0,vy:0,angle:0,score:0,radius:11,level:1,lives:1,alive:true,sprinting:false,lastInputAt:Date.now(),invulnerableUntil:Date.now()+1200};w.players.set(p.id,p)}p.ws=ws;p.connected=true;p.disconnectedAt=0;p.name=safeName(m.name||p.name);p.team=p.team||teamFor(w,m.team);p.mode=mode;player=p;send(ws,{...snapshot(w),type:'welcome',resumeId:p.resumeId,id:p.id,you:publicPlayer(p),player:publicPlayer(p)});sendSnapshot(w);return}if(m.type==='state'&&player)applyInput(player,m)});ws.on('close',()=>{if(!player||player.ws!==ws)return;player.connected=false;player.ws=null;player.disconnectedAt=Date.now();sendSnapshot(worlds.get(player.mode==='ffa'?'PVP':player.mode==='coop'?'PVE':'EQUIPO'))});});
const hb=setInterval(()=>{for(const ws of wss.clients){if(ws.isAlive===false){ws.terminate();continue}ws.isAlive=false;try{ws.ping()}catch{}}for(const w of worlds.values())for(const [id,p] of w.players){if(!p.connected&&p.disconnectedAt&&Date.now()-p.disconnectedAt>RESUME_MS)w.players.delete(id)}},HEARTBEAT_MS);hb.unref?.();
let last=Date.now(),snapDue=Date.now();setInterval(()=>{const now=Date.now(),dt=Math.min(.05,(now-last)/1000);last=now;for(const w of worlds.values()){w.tick++;movePlayers(w);updateFish(w,dt);combat(w);}if(now>=snapDue){snapDue=now+1000/SNAP_HZ;for(const w of worlds.values())sendSnapshot(w)}},1000/TICK_HZ);
server.listen(PORT,'0.0.0.0',()=>console.log(`NANY LIVE SYNC ${PORT}`));
