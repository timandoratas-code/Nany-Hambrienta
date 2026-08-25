import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT || 10000);
const W = 12000, H = 12000;
const TICK = 1000/30, SNAP = 1000/20;
const MAX_PLAYERS = 8;
const MAX_STEP=11, FISH_N=260, CHASE=1000, COOLDOWN=5000, HIT_CD=900;
const rooms = new Map();
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const send=(ws,m)=>{if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify(m));};
const roomCode=v=>String(v||'ABISMO01').trim().toUpperCase().replace(/[^A-Z0-9_-]/g,'').slice(0,16)||'ABISMO01';
const mode=v=>['teams','ffa','coop'].includes(v)?v:'teams';
const name=v=>String(v||'Nany').trim().slice(0,18)||'Nany';
function rng(seed){let s=seed>>>0||1;return()=>{s^=s<<13;s>>>=0;s^=s>>>17;s>>>=0;s^=s<<5;s>>>=0;return(s>>>0)/4294967296;};}
const TYPES=[
 {key:'plankton',role:'prey',power:1,points:5,color:'#8fffb0',size:3,speed:.30},
 {key:'minnow',role:'prey',power:2,points:10,color:'#bfe6ff',size:7,speed:.90},
 {key:'green',role:'prey',power:3,points:20,color:'#39ff6a',size:9,speed:1.6},
 {key:'piranha',role:'predator',power:4,points:35,color:'#ff8a3d',size:12,speed:1.7},
 {key:'stick',role:'predator',power:5,points:50,color:'#e0c66a',size:15,speed:.7},
 {key:'rival',role:'predator',power:6,points:75,color:'#a084ff',size:19,speed:1.1},
 {key:'shark',role:'predator',power:8,points:150,color:'#6d8796',size:28,speed:1.4},
 {key:'monster',role:'predator',power:10,points:300,color:'#8d2638',size:40,speed:1.1}
];
function typeAt(i){return i<120?TYPES[0]:i<170?TYPES[1]:i<200?TYPES[2]:i<225?TYPES[3]:i<245?TYPES[4]:i<258?TYPES[5]:i===258?TYPES[6]:TYPES[7];}
function power(score){return score<100?1:score<250?2:score<500?3:score<900?4:score<1500?5:score<2500?6:score<4000?7:score<6000?8:score<9000?9:10;}
function makeFish(room){const r=rng(room.seed);room.fish=new Map();for(let i=0;i<FISH_N;i++){const t=typeAt(i),a=r()*Math.PI*2,s=t.speed*(.82+r()*.3);room.fish.set('fish-'+i,{id:'fish-'+i,type:t.key,role:t.role,power:t.power,points:t.points,color:t.color,size:t.size*(.88+r()*.24),speed:s,x:100+r()*(W-200),y:100+r()*(H-200),vx:Math.cos(a)*s*.55,vy:Math.sin(a)*s*.55,angle:a,heading:a,turn:1+r()*1.6,phase:r()*10,chaseId:null,chaseUntil:0,cooldownUntil:0,hitUntil:0});}}
function makeRoom(code,m){const r={code,mode:m,seed:(Math.random()*0xffffffff)>>>0||1,epoch:Date.now(),players:new Map(),watchers:new Set(),fish:new Map(),anchor:{x:W/2,y:H/2}};makeFish(r);rooms.set(code,r);return r;}
function team(r,want){if(r.mode!=='teams')return null;const a=[...r.players.values()].filter(p=>p.team==='A').length,b=[...r.players.values()].filter(p=>p.team==='B').length;if((want==='A'||want==='B')&&Math.abs(a-b)<=1)return want;return a<=b?'A':'B';}
function spawn(r){const a=[...r.players.values()];if(!a.length)return{...r.anchor};const p=a[0],ang=Math.random()*Math.PI*2,d=90+Math.random()*100;return{x:clamp(p.x+Math.cos(ang)*d,100,W-100),y:clamp(p.y+Math.sin(ang)*d,100,H-100)};}
function pubP(p){return{id:p.id,name:p.name,x:+p.x.toFixed(2),y:+p.y.toFixed(2),vx:+p.vx.toFixed(2),vy:+p.vy.toFixed(2),angle:+p.angle.toFixed(3),score:Math.floor(p.score),growthScore:Math.floor(p.score),radius:+p.radius.toFixed(2),power:power(p.score),level:p.level,lives:p.lives,alive:p.alive,team:p.team,teamName:p.team==='A'?'Azul':p.team==='B'?'Rojo':null,sprinting:p.sprinting};}
function pubF(f){return{id:f.id,type:f.type,role:f.role,power:f.power,points:f.points,size:+f.size.toFixed(2),color:f.color,x:+f.x.toFixed(2),y:+f.y.toFixed(2),vx:+f.vx.toFixed(3),vy:+f.vy.toFixed(3),angle:+f.angle.toFixed(3)};}
function snap(r){return{type:'snapshot',room:r.code,mode:r.mode,population:r.players.size,worldSeed:r.seed,worldEpoch:r.epoch,worldStage:0,players:[...r.players.values()].map(pubP),entities:[...r.fish.values()].map(pubF)};}
function broadcast(r){const s=snap(r);for(const p of r.players.values())send(p.ws,{...s,you:pubP(p),player:pubP(p)});for(const ws of r.watchers)send(ws,s);}
function state(p,m){const x=+m.x,y=+m.y;if(!Number.isFinite(x)||!Number.isFinite(y))return;const dx=x-p.lastX,dy=y-p.lastY,d=Math.hypot(dx,dy);p.lastX=x;p.lastY=y;if(d>.05){const step=Math.min(d,MAX_STEP);p.tx=clamp(p.x+dx/d*step,0,W);p.ty=clamp(p.y+dy/d*step,0,H);}if(Number.isFinite(+m.radius))p.radius=clamp(+m.radius,8,320);p.sprinting=!!m.sprinting;p.last=Date.now();}
function movePlayers(r){for(const p of r.players.values()){if(!p.alive)continue;const dx=p.tx-p.x,dy=p.ty-p.y,d=Math.hypot(dx,dy);if(d>.01){const step=Math.min(d,MAX_STEP*1.35);p.vx=dx/d*step;p.vy=dy/d*step;p.x=clamp(p.x+p.vx,0,W);p.y=clamp(p.y+p.vy,0,H);p.angle=Math.atan2(p.vy,p.vx);}else{p.vx*=.75;p.vy*=.75;}if(Date.now()-p.last>350){p.tx=p.x;p.ty=p.y;}}}
function canTarget(f,p,d,now){if(!p.alive)return false;const pp=power(p.score);if(f.role==='predator')return f.power>pp&&f.size>p.radius*1.02&&d<320&&now>=p.invuln;return pp>f.power&&p.radius>f.size*.98&&d<170;}
function updateFish(r,dt){const now=Date.now(),ps=[...r.players.values()].filter(p=>p.alive);for(const f of r.fish.values()){
 let t=f.chaseId?r.players.get(f.chaseId):null;
 if(!t||f.chaseUntil<=now||!canTarget(f,t,Math.hypot(t.x-f.x,t.y-f.y),now)){t=null;f.chaseId=null;if(f.chaseUntil<=now)f.cooldownUntil=now+COOLDOWN;}
 if(!t&&now>=f.cooldownUntil){let best=null,bd=Infinity;for(const p of ps){const d=Math.hypot(p.x-f.x,p.y-f.y);if(canTarget(f,p,d,now)&&d<bd){bd=d;best=p;}}if(best){t=best;f.chaseId=best.id;f.chaseUntil=now+CHASE;}}
 if(t&&f.chaseUntil>now){const a=Math.atan2(t.y-f.y,t.x-f.x),k=f.role==='predator'?.25:.18;f.vx+=Math.cos(a)*f.speed*k;f.vy+=Math.sin(a)*f.speed*k;}
 else{if(f.turn<=0){f.turn=.8+((Math.sin(f.phase+now*.0013)+1)*.5)*1.4;f.heading+=Math.sin(f.phase+now*.0009)*.55;f.vx+=Math.cos(f.heading)*f.speed*.16;f.vy+=Math.sin(f.heading)*f.speed*.16;}f.turn-=dt;}
 const sp=Math.hypot(f.vx,f.vy)||.0001;if(sp>f.speed){f.vx=f.vx/sp*f.speed;f.vy=f.vy/sp*f.speed;}f.x=clamp(f.x+f.vx*dt*60,30,W-30);f.y=clamp(f.y+f.vy*dt*60,30,H-30);if(f.x<=30||f.x>=W-30){f.vx*=-1;f.heading=Math.PI-f.heading;}if(f.y<=30||f.y>=H-30){f.vy*=-1;f.heading=-f.heading;}f.angle=Math.atan2(f.vy,f.vx);
 }}
function combat(r){const now=Date.now();for(const p of r.players.values()){if(!p.alive||p.invuln>now)continue;const pp=power(p.score);for(const f of r.fish.values()){if(f.hitUntil>now)continue;const d=Math.hypot(p.x-f.x,p.y-f.y);if(d>p.radius*.86+f.size*.86)continue;if(f.power<pp&&f.size<p.radius*.98){p.score+=f.points;f.hitUntil=now+HIT_CD;f.x=100+((parseInt(f.id.slice(5))+37)*(113)%(W-200));f.y=100+((parseInt(f.id.slice(5))+91)*(149)%(H-200));f.chaseId=null;f.chaseUntil=0;f.cooldownUntil=now+3000;continue;}if(f.power>pp&&f.size>p.radius*1.02){p.lives=Math.max(0,p.lives-1);p.score=Math.max(0,Math.floor(p.score*.5));p.invuln=now+2500;const a=Math.random()*Math.PI*2;p.x=clamp(r.anchor.x+Math.cos(a)*180,100,W-100);p.y=clamp(r.anchor.y+Math.sin(a)*180,100,H-100);f.chaseId=null;f.chaseUntil=0;f.cooldownUntil=now+COOLDOWN;if(p.lives<=0)p.alive=false;}}}}
function tick(r,dt){movePlayers(r);updateFish(r,dt);combat(r);}
function inject(html){const js=`<script>(()=>{let s=null,room=null,latest=null;const M=()=>{try{return window.eval('typeof Multiplayer!=="undefined"?Multiplayer:undefined')}catch(_){return null}},on=()=>{const m=M();return!!(m&&m.isConnected&&m.isConnected())},rc=()=>{const m=M();return m&&typeof m.room==='function'?m.room():null},own=()=>{try{return window.eval('typeof Save!=="undefined"?Save.fishName:""')}catch(_){return''}};function patch(){try{window.eval("updateSpawns=function(){};updateEntity=function(){};handleCollisions=function(){};window.__SERVER_AUTHORITATIVE_FISH__=true")}catch(_){}}function conn(){const c=rc();if(!on()){room=null;latest=null;try{s?.close()}catch(_){}s=null;return}patch();if(!c||c===room)return;room=c;try{s?.close()}catch(_){}s=new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host+'/ws');s.onopen=()=>s.send(JSON.stringify({type:'spectator',room:c}));s.onmessage=e=>{try{const m=JSON.parse(e.data);if(m.type==='snapshot')latest=m}catch(_){}}}function me(){return latest?.players?.find(p=>p.name===own())||null}function sync(){if(!on()||!latest)return;try{const g=window.eval('typeof game!=="undefined"?game:null');if(!g||!g.running)return;const p=me();if(p){g.score=p.score;g.lives=p.lives;g.player.x=p.x;g.player.y=p.y;g.player.vx=p.vx;g.player.vy=p.vy;g.player.angle=p.angle}g.entities=(latest.entities||[]).map(f=>({serverId:f.id,type:f.type,power:f.power,points:f.points,size:f.size,color:f.color,behavior:f.role==='predator'?'aggro':'flee',hazard:null,speed:Math.max(.1,Math.hypot(f.vx,f.vy)),x:f.x,y:f.y,vx:f.vx,vy:f.vy,wobble:f.angle||0,life:0}))}catch(_){}}function nav(){if(!on()||!latest)return;const mini=document.getElementById('minimap');if(mini){const c=mini.getContext('2d'),sx=mini.width/${W},sy=mini.height/${H};for(const p of latest.players||[]){if(!p.alive||p.name===own())continue;c.fillStyle='#fff';c.beginPath();c.arc(p.x*sx,p.y*sy,4,0,Math.PI*2);c.fill()}}}function loop(){conn();sync();nav();requestAnimationFrame(loop)}requestAnimationFrame(loop)})();</script>`;return html.replace('</body>',js+'</body>')}
const server=http.createServer(async(req,res)=>{try{const u=new URL(req.url||'/','http://localhost');if(u.pathname==='/health'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});return res.end(JSON.stringify({ok:true,rooms:rooms.size,players:[...rooms.values()].reduce((n,r)=>n+r.players.size,0),fishPerRoom:FISH_N}))}if(u.pathname==='/'||u.pathname==='/index.html'){const html=inject(await fs.readFile(path.join(ROOT,'index.html'),'utf8'));res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});return res.end(html)}res.writeHead(404);res.end('Not found')}catch(_){res.writeHead(500);res.end('Server error')}});
const wss=new WebSocketServer({server,path:'/ws'});
wss.on('connection',ws=>{const id=Math.random().toString(36).slice(2)+Date.now().toString(36);let p=null,r=null,watch=false;ws.on('message',raw=>{let m;try{m=JSON.parse(raw.toString())}catch{return}if(m.type==='spectator'){const code=roomCode(m.room);r=rooms.get(code);if(!r)return send(ws,{type:'snapshot',room:code,mode:'teams',population:0,players:[],entities:[]});watch=true;r.watchers.add(ws);return send(ws,{...snap(r),you:null,player:null})}if(m.type==='join'){const code=roomCode(m.room);r=rooms.get(code)||makeRoom(code,mode(m.mode));if(r.players.size>=MAX_PLAYERS)return send(ws,{type:'error',message:'Sala llena'});const pos=spawn(r);p={id,ws,name:name(m.name),team:team(r,m.team),x:pos.x,y:pos.y,tx:pos.x,ty:pos.y,lastX:pos.x,lastY:pos.y,vx:0,vy:0,angle:0,score:0,radius:11,level:1,lives:1,alive:true,sprinting:false,last:Date.now(),invuln:Date.now()+1200};r.players.set(id,p);send(ws,{...welcome(r,p)});broadcast(r);return}if(m.type==='state'&&p&&r)state(p,m);if(m.type==='leave')ws.close()});ws.on('close',()=>{if(watch&&r)r.watchers.delete(ws);if(!p||!r)return;r.players.delete(p.id);if(!r.players.size&&!r.watchers.size)rooms.delete(r.code);else broadcast(r)})});
let last=Date.now(),lastSnap=Date.now();setInterval(()=>{const now=Date.now(),dt=Math.min(.05,(now-last)/1000);last=now;for(const r of rooms.values())tick(r,dt);if(now-lastSnap>=SNAP){lastSnap=now;for(const r of rooms.values())broadcast(r);}},TICK);
server.listen(PORT,'0.0.0.0',()=>console.log('NANY GAMEPLAY V2 '+PORT));
