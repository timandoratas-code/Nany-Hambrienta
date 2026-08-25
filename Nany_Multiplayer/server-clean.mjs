import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'node:crypto';

const ROOT=fileURLToPath(new URL('.',import.meta.url));
const PORT=Number(process.env.PORT||10000);
const HOST=process.env.HOST||'0.0.0.0';
const WORLD_W=12000,WORLD_H=12000;
const TICK_MS=50,SNAPSHOT_MS=100;
const MAX_PLAYERS=8;
const MAX_SPEED=3.2;
const ACCEL=0.30;

const rooms=new Map();
const clients=new Map();
const TYPES=[
  {k:'plankton',v:'small',size:4,points:4,power:1,speed:.95},
  {k:'minnow',v:'small',size:8,points:8,power:2,speed:1.2},
  {k:'green',v:'small',size:11,points:13,power:3,speed:1.55},
  {k:'piranha',v:'small',size:14,points:21,power:4,speed:1.9},
  {k:'stick',v:'small',size:17,points:29,power:5,speed:1.45},
  {k:'rival',v:'small',size:21,points:40,power:6,speed:1.75},
  {k:'ray',v:'small',size:30,points:70,power:7,speed:2.05},
  {k:'monster',v:'small',size:43,points:115,power:9,speed:1.8},
  {k:'minnow_big',v:'big',size:8,points:12,power:3,speed:1.15},
  {k:'green_big',v:'big',size:11,points:19,power:4,speed:1.48},
  {k:'piranha_big',v:'big',size:14,points:30,power:5,speed:1.82},
  {k:'stick_big',v:'big',size:17,points:40,power:6,speed:1.4},
  {k:'rival_big',v:'big',size:21,points:55,power:7,speed:1.68},
  {k:'ray_big',v:'big',size:30,points:90,power:8,speed:1.98},
  {k:'monster_big',v:'big',size:43,points:145,power:10,speed:1.72}
];
const COLORS={plankton:'#8fffb0',minnow:'#bfe6ff',minnow_big:'#bfe6ff',green:'#39ff6a',green_big:'#39ff6a',piranha:'#ff8a3d',piranha_big:'#ff8a3d',stick:'#e0c66a',stick_big:'#e0c66a',rival:'#a084ff',rival_big:'#a084ff',ray:'#6d8796',ray_big:'#6d8796',monster:'#8d2638',monster_big:'#8d2638'};
const rand=(a,b)=>a+Math.random()*(b-a);
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const safe=(v,d='')=>String(v??d).trim();
const roomCode=v=>safe(v,'ABISMO01').toUpperCase().replace(/[^A-Z0-9_-]/g,'').slice(0,16)||'ABISMO01';
const mode=v=>['teams','ffa','coop'].includes(v)?v:'teams';
const name=v=>safe(v,'Nany').slice(0,18)||'Nany';
const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
function radius(score){return clamp(11+Math.sqrt(Math.max(0,score))*0.62,11,320);}
function power(score){if(score<100)return 1;if(score<250)return 2;if(score<500)return 3;if(score<900)return 4;if(score<1500)return 5;if(score<2500)return 6;if(score<4000)return 7;if(score<6000)return 8;if(score<9000)return 9;return 10;}
function teamName(t){return t==='A'?'Azul':t==='B'?'Rojo':null;}
function publicPlayer(p){return{id:p.id,name:p.name,x:+p.x.toFixed(2),y:+p.y.toFixed(2),vx:+p.vx.toFixed(3),vy:+p.vy.toFixed(3),angle:+p.angle.toFixed(3),score:p.score,growthScore:p.growthScore,level:p.level,radius:+p.radius.toFixed(2),power:p.power,alive:p.alive,sprinting:p.sprinting,team:p.team||null,teamName:p.teamName||null};}
function send(ws,msg){if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(msg));}
function randomSpawn(){return{x:500+Math.random()*(WORLD_W-1000),y:500+Math.random()*(WORLD_H-1000)};}
function teamFor(room,wanted){if(room.mode!=='teams')return null;const a=[...room.players.values()].filter(p=>p.team==='A').length,b=[...room.players.values()].filter(p=>p.team==='B').length;if((wanted==='A'||wanted==='B')&&Math.abs(a-b)<=1)return wanted;return a<=b?'A':'B';}
function fishDef(kind){return TYPES.find(t=>t.k===kind)||TYPES[0];}
function spawnFish(room){const tier=Math.random()<0.28?'big':'small';const pool=TYPES.filter(t=>t.v===tier);const t=pool[Math.floor(Math.random()*pool.length)];const a=rand(0,Math.PI*2);const id=`f-${room.nextId++}`;room.fish.set(id,{id,type:t.k,variant:t.v,size:t.size*rand(.95,1.25),points:t.points,power:t.power,speed:t.speed,x:rand(100,WORLD_W-100),y:rand(100,WORLD_H-100),vx:Math.cos(a)*t.speed*.45,vy:Math.sin(a)*t.speed*.45,angle:a,phase:rand(0,Math.PI*2)});}
function ensureFish(room){while(room.fish.size<230)spawnFish(room);}
function makeRoom(code,m){const room={code,mode:m,seed:crypto.randomBytes(4).readUInt32BE(0)||1,epoch:Date.now(),players:new Map(),fish:new Map(),nextId:1,boss:null,removed:new Set()};ensureFish(room);return room;}
function nearestPlayer(room,e){let best=null,bd=Infinity;for(const p of room.players.values()){if(!p.alive)continue;const d=dist(e,p);if(d<bd){bd=d;best=p;}}return best;}
function updateFish(room,f,dt){const now=(Date.now()-room.epoch)/1000;const target=nearestPlayer(room,f);const pd=target?dist(f,target):Infinity;const r=radius(target?.score||0),danger=target&&f.power>power(target.score)&&f.size>r*.9;let ax=f.angle;
  if(danger&&pd<360) ax=Math.atan2(target.y-f.y,target.x-f.x);
  else if(target&&pd<180&&f.power<power(target.score)) ax=Math.atan2(f.y-target.y,f.x-target.x);
  else ax=f.angle+Math.sin(now*.35+f.phase)*.22;
  const turnSpeed=.08;f.angle=f.angle+(ax-f.angle)*turnSpeed;f.vx+=(Math.cos(f.angle)*f.speed*.55-f.vx)*.10;f.vy+=(Math.sin(f.angle)*f.speed*.55-f.vy)*.10;f.x+=f.vx*dt*60;f.y+=f.vy*dt*60;
  if(f.x<70||f.x>WORLD_W-70){f.vx*=-1;f.x=clamp(f.x,70,WORLD_W-70);}if(f.y<70||f.y>WORLD_H-70){f.vy*=-1;f.y=clamp(f.y,70,WORLD_H-70);}
}
function updateBoss(room,dt){const b=room.boss;if(!b)return;const target=nearestPlayer(room,b);if(target){const a=Math.atan2(target.y-b.y,target.x-b.x);b.angle+=((a-b.angle)*.06);b.vx+=(Math.cos(b.angle)*b.speed-b.vx)*.10;b.vy+=(Math.sin(b.angle)*b.speed-b.vy)*.10;}else{b.vx*=.98;b.vy*=.98;}b.x+=b.vx*dt*60;b.y+=b.vy*dt*60;if(b.x<800||b.x>WORLD_W-800)b.vx*=-1;if(b.y<800||b.y>WORLD_H-800)b.vy*=-1;b.phase+=dt*3;}
function createBoss(room){const a=rand(0,Math.PI*2);room.fish.clear();room.boss={id:`boss-${room.nextId++}`,type:'boss',size:180,speed:1.7,x:WORL D_W/2,y:WORLD_H/2,vx:Math.cos(a),vy:Math.sin(a),angle:a,phase:0,points:0,power:99};}
function snapshot(room,p,kind='snapshot'){const entities=[...room.fish.values()].map(f=>({id:f.id,type:f.type,variant:f.variant,size:+f.size.toFixed(2),points:f.points,power:f.power,speed:f.speed,x:+f.x.toFixed(2),y:+f.y.toFixed(2),vx:+f.vx.toFixed(2),vy:+f.vy.toFixed(2),angle:+f.angle.toFixed(3),color:COLORS[f.type]||'#4dfff0'}));if(room.boss)entities.push({...room.boss,boss:true,color:'#ff6a3d',type:'boss',variant:'boss'});return{type:kind,serverTime:Date.now(),room:room.code,mode:room.mode,population:room.players.size,worldSeed:room.seed,worldEpoch:room.epoch,worldStage:0,removed:[...room.removed],players:[...room.players.values()].map(publicPlayer),player:publicPlayer(p),you:publicPlayer(p),entities};}
function die(room,p,reason){if(!p.alive)return;p.alive=false;send(p.ws,{type:'player_dead',id:p.id,reason});setTimeout(()=>{if(!room.players.has(p.id))return;const s=randomSpawn();Object.assign(p,{x:s.x,y:s.y,vx:0,vy:0,inputX:0,inputY:0,targetSpeed:0,alive:true,score:Math.floor(p.score*.5),growthScore:Math.floor(p.growthScore*.5),radius:radius(Math.floor(p.growthScore*.5)),power:power(Math.floor(p.growthScore*.5))});send(p.ws,{type:'respawn',player:publicPlayer(p)});},1200);}
function movePlayer(p,dt){if(!p.alive)return;const tx=p.inputX*p.targetSpeed,ty=p.inputY*p.targetSpeed;p.vx+=(tx-p.vx)*ACCEL;p.vy+=(ty-p.vy)*ACCEL;if(Date.now()-p.lastInput>250){p.vx*=.72;p.vy*=.72;p.targetSpeed=0;}p.x=clamp(p.x+p.vx*dt*60,p.radius,WORLD_W-p.radius);p.y=clamp(p.y+p.vy*dt*60,p.radius,WORLD_H-p.radius);if(Math.abs(p.vx)+Math.abs(p.vy)>.05)p.angle=Math.atan2(p.vy,p.vx);}
function applyState(p,m){const rx=Number(m.x),ry=Number(m.y);if(!Number.isFinite(rx)||!Number.isFinite(ry))return;const dx=rx-p.reportX,dy=ry-p.reportY,step=Math.hypot(dx,dy);p.reportX=rx;p.reportY=ry;if(step>.15&&step<120){const len=step||1;p.inputX=dx/len;p.inputY=dy/len;p.targetSpeed=Math.min(MAX_SPEED,step*(1000/TICK_MS));}else{p.targetSpeed=0;}p.lastInput=Date.now();p.sprinting=!!m.sprinting;}
function eatCheck(room){const ps=[...room.players.values()].filter(p=>p.alive);for(const p of ps){for(const f of room.fish.values()){const d=dist(p,f);if(d>p.radius+f.size*.65)continue;if(f.variant==='small'&&f.power<p.power&&f.size<p.radius){room.fish.delete(f.id);p.score+=f.points;p.growthScore=p.score;p.radius=radius(p.score);p.power=power(p.score);room.removed.add(f.id);break;}if(f.variant==='big'&&f.power>p.power&&f.size>p.radius&&Date.now()>p.invulnUntil){die(room,p,'fish');break;}}}
  for(let i=0;i<ps.length;i++)for(let j=i+1;j<ps.length;j++){const a=ps[i],b=ps[j];if(room.mode==='coop'||(room.mode==='teams'&&a.team===b.team))continue;if(dist(a,b)>a.radius*.8+b.radius*.8)continue;if(a.score>=b.score+1&&a.radius>b.radius&&a.power>=b.power){a.score+=Math.max(10,Math.floor(b.score*.25));a.growthScore=a.score;a.radius=radius(a.score);a.power=power(a.score);die(room,b,'player');}else if(b.score>=a.score+1&&b.radius>a.radius&&b.power>=a.power){b.score+=Math.max(10,Math.floor(a.score*.25));b.growthScore=b.score;b.radius=radius(b.score);b.power=power(b.score);die(room,a,'player');}}
}
const BRIDGE=`<script>(function(){'use strict';let s=null,lastRoom=null,world=null,mini=null;function q(n){try{return window.eval('typeof '+n+'!=="undefined"?'+n+':undefined')}catch(e){return undefined}}function connected(){const M=q('Multiplayer');return M&&typeof M.isConnected==='function'&&M.isConnected()}function drawMini(){if(!mini||!world)return;const c=mini.getContext('2d'),w=180,h=180;c.clearRect(0,0,w,h);c.fillStyle='rgba(2,11,20,.72)';c.fillRect(0,0,w,h);c.strokeStyle='rgba(77,255,240,.25)';c.strokeRect(1,1,w-2,h-2);const me=world.you;if(!me)return;for(const p of world.players||[]){const x=(p.x/WORLD_W)*w,y=(p.y/WORLD_H)*h;c.fillStyle=p.id===me.id?'#4dfff0':(p.team===me.team?'#5ea7ff':'#ff6a6a');c.beginPath();c.arc(x,y,p.id===me.id?5:4,0,Math.PI*2);c.fill();}c.fillStyle='#7fa8ac';c.font='9px monospace';c.fillText('MAPA',8,12)}function drawWorld(){if(!world||!connected())return;const game=q('game'),drawFish=q('drawFish'),canvas=q('canvas'),ctx=q('ctx');if(!game||!drawFish||!ctx)return;const you=world.you;if(!you)return;const zoom=(typeof q('getViewZoom')==='function'?q('getViewZoom')():1);for(const e of world.entities||[]){const sx=canvas.width*.5+(e.x-you.x)*zoom,sy=canvas.height*.5+(e.y-you.y)*zoom;if(sx<-100||sy<-100||sx>canvas.width+100||sy>canvas.height+100)continue;ctx.save();drawFish(sx,sy,Math.max(3,(e.size||8)*zoom),e.color||'#4fd1ff',e.angle,false);ctx.restore();}for(const p of world.players||[]){if(p.id===you.id||!p.alive)continue;const sx=canvas.width*.5+(p.x-you.x)*zoom,sy=canvas.height*.5+(p.y-you.y)*zoom;if(sx<-120||sy<-120||sx>canvas.width+120||sy>canvas.height+120)continue;ctx.save();drawFish(sx,sy,Math.max(10,(p.radius||18)*zoom),p.team===you.team?'#5ea7ff':'#ff5a5a',p.angle,false);ctx.fillStyle='#fff';ctx.font='700 10px monospace';ctx.textAlign='center';ctx.fillText(p.name||'Jugador',sx,sy-(p.radius||18)*zoom-6);ctx.restore();}if(world.entities){const boss=world.entities.find(e=>e.boss);if(boss){ctx.save();ctx.fillStyle='#ff6a3d';ctx.beginPath();ctx.arc(canvas.width*.5+(boss.x-you.x)*zoom,canvas.height*.5+(boss.y-you.y)*zoom,Math.max(35,boss.size*zoom*.55),0,Math.PI*2);ctx.fill();ctx.restore();}}}
function tick(){if(connected()){const M=q('Multiplayer'),room=M&&typeof M.room==='function'?M.room():null;if(room&&room!==lastRoom){lastRoom=room;if(s)try{s.close()}catch(e){}s=new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host+'/ws');s.onopen=()=>s.send(JSON.stringify({type:'spectator',room}));s.onmessage=e=>{try{const m=JSON.parse(e.data);if(m.type==='snapshot'||m.type==='welcome'){world=m;const g=q('game');if(g&&m.you){g.player.x=m.you.x;g.player.y=m.you.y;g.score=m.you.score;g.growthScore=m.you.growthScore;}}}catch(_){}};}}else{lastRoom=null;world=null;}if(connected()){const g=q('game');if(g&&g.entities)g.entities=[];drawWorld();drawMini();}requestAnimationFrame(tick)}
function init(){mini=document.createElement('canvas');mini.id='authoritativeMiniMap';mini.width=180;mini.height=180;Object.assign(mini.style,{position:'fixed',right:'18px',bottom:'18px',width:'180px',height:'180px',zIndex:'9999',borderRadius:'12px',boxShadow:'0 4px 18px rgba(0,0,0,.35)',display:'none',pointerEvents:'none'});document.body.appendChild(mini);const show=()=>{mini.style.display=connected()?'block':'none'};setInterval(show,300);requestAnimationFrame(tick)};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();})();</script>`;
const http=createServer(async(req,res)=>{try{const u=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`);if(u.pathname==='/health'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:true,rooms:rooms.size,players:clients.size}));}if(u.pathname==='/'||u.pathname==='/index.html'){let html=await readFile(join(ROOT,'index.html'),'utf8');html=html.replace('</body>',BRIDGE+'</body>');res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});return res.end(html);}res.writeHead(404);res.end('Not found');}catch(e){res.writeHead(500);res.end('Server error');}});
const wss=new WebSocketServer({server:http,noServer:false});
wss.on('connection',(ws)=>{const id=crypto.randomUUID();const c={id,ws,joined:false,spectator:false,room:null,name:'Nany',x:6000,y:6000,vx:0,vy:0,inputX:0,inputY:0,targetSpeed:0,reportX:6000,reportY:6000,angle:0,score:0,growthScore:0,power:1,radius:11,alive:true,sprinting:false,team:null,teamName:null,lastInput:Date.now(),invulnUntil:0};clients.set(id,c);ws.on('message',(raw)=>{let m;try{m=JSON.parse(raw.toString())}catch{return;}if(m.type==='spectator'){const code=roomCode(m.room),room=rooms.get(code);if(!room)return send(ws,{type:'error',message:'Sala no encontrada'});c.spectator=true;c.room=code;send(ws,snapshot(room,{...c,id,ws},'welcome'));return;}if(m.type==='join'){if(c.joined)return;const code=roomCode(m.room),rm=rooms.get(code)||(()=>{const r=makeRoom(code,mode(m.mode));rooms.set(code,r);return r;})();if(rm.players.size>=MAX_PLAYERS)return send(ws,{type:'error',message:'Sala llena'});if(rm.players.size&&rm.mode!==mode(m.mode))return send(ws,{type:'error',message:'La sala ya usa otro modo'});rm.mode=mode(m.mode);c.room=code;c.joined=true;c.name=name(m.name);c.team=teamFor(rm,m.team);c.teamName=teamName(c.team);const sp=randomSpawn();Object.assign(c,sp);c.reportX=c.x;c.reportY=c.y;c.lastInput=Date.now();c.score=0;c.growthScore=0;c.radius=radius(0);c.power=1;rm.players.set(id,c);send(ws,snapshot(rm,c,'welcome'));for(const p of rm.players.values())if(p.id!==id)send(p.ws,{type:'player_joined',player:publicPlayer(c)});return;}if(!c.joined)return;const room=rooms.get(c.room);if(!room)return;if(m.type==='state')return applyState(c,m);if(m.type==='consume')return;});ws.on('close',()=>{clients.delete(id);if(c.joined){const room=rooms.get(c.room);if(room){room.players.delete(id);for(const p of room.players.values())send(p.ws,{type:'player_left',id});if(!room.players.size)rooms.delete(c.room);}}});});
let last=Date.now(),snap=Date.now();setInterval(()=>{const now=Date.now(),dt=Math.min(.05,(now-last)/1000);last=now;for(const room of rooms.values()){for(const p of room.players.values())movePlayer(p,dt);for(const f of room.fish.values())updateFish(room,f,dt);if(room.boss)updateBoss(room,dt);eatCheck(room);ensureFish(room);for(const p of room.players.values()){send(p.ws,snapshot(room,p,'snapshot'));}}
},TICK_MS);
http.listen(PORT,HOST,()=>console.log('NANY CLEAN AUTHORITATIVE '+HOST+':'+PORT));
