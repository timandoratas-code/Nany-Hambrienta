import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const SERVER_SRC=path.join(ROOT,'server.mjs');
const RUNTIME_SRC=path.join(ROOT,'world-runtime.mjs');
const CLIENT_SRC=path.join(ROOT,'multiplayer-client.js');
const GENERATED_SERVER=path.join(ROOT,'.server-collision-runtime.mjs');
const GENERATED_RUNTIME=path.join(ROOT,'.world-runtime-collision-direct.mjs');
const GENERATED_CLIENT=path.join(ROOT,'.multiplayer-client-collision.js');

let serverSource=await fs.readFile(SERVER_SRC,'utf8');
let runtimeSource=await fs.readFile(RUNTIME_SRC,'utf8');
let clientSource=await fs.readFile(CLIENT_SRC,'utf8');

function replaceSection(source,startMarker,endMarker,replacement,label){
  const start=source.indexOf(startMarker);
  const end=source.indexOf(endMarker,start+startMarker.length);
  if(start<0||end<0||end<=start)throw new Error(`Collision entry: no se pudo localizar ${label}`);
  return source.slice(0,start)+replacement+'\n'+source.slice(end);
}

/* -------------------------------------------------------------------------
   MULTIPLAYER: EL CONTACTO VISUAL DEL CLIENTE ES LA AUTORIDAD GEOMÉTRICA
   -------------------------------------------------------------------------
   Offline ya funciona bien. El cliente usa exactamente playerHitbox/fishHitbox
   del juego y reporta el instante en que esas dos hitboxes se tocaron.

   El servidor NO vuelve a decidir la geometría con otra posición temporal.
   Solo valida:
   - que el pez exista;
   - que el tamaño permita comer / ser comido;
   - que las posiciones reportadas estén cerca de su estado reciente;
   - que en el frame reportado hubiera contacto según la regla offline.
   ------------------------------------------------------------------------- */
const directTryConsume=`function __validClientContact(p,f,c,reach){
  if(!c)return false;
  const px=Number(c.px),py=Number(c.py),fx=Number(c.fx),fy=Number(c.fy);
  if(![px,py,fx,fy].every(Number.isFinite))return false;

  const playerTolerance=Math.max(300,radius(p.growthScore)*4.0);
  const fishTolerance=Math.max(260,(Number(f?.size)||0)*5.5);
  if(Math.hypot(px-p.x,py-p.y)>playerTolerance)return false;
  if(Math.hypot(fx-f.x,fy-f.y)>fishTolerance)return false;

  // Misma geometría que offline. +2 px solo cubre redondeo de snapshots.
  return Math.hypot(px-fx,py-fy)<=reach+2;
}
function tryConsume(w,p,id,contact=null){
  const f=w.fish.get(String(id||''));
  if(!f||!p.connected||!p.alive)return false;
  if(!canPlayerEat(p,f))return false;
  const reach=playerHB(p.growthScore)+fishHB(f);

  // Contacto del jugador: manda el frame visual y ese frame debe ser válido.
  // Sin contact conservamos una ruta legacy solo para acciones auxiliares/pet.
  if(contact){
    if(!__validClientContact(p,f,contact,reach))return false;
  }else if(dist(p,f)>reach){
    return false;
  }

  const ok=removeFish(w,p,f);
  if(ok){maybeStartBoss(w);broadcast(w);}
  return ok;
}
function tryPredatorContact(w,p,id,contact=null){
  if(!p?.connected||!p?.alive||Number(p.invulnerableUntil||0)>Date.now())return false;
  const key=String(id||'');
  const f=w.fish.get(key)||(w.lavaHazard&&String(w.lavaHazard.id)===key?w.lavaHazard:null);
  if(!f||!canFishEatPlayer(p,f)||!contact)return false;
  const reach=playerHB(p.growthScore)+fishHB(f);
  if(!__validClientContact(p,f,contact,reach))return false;
  return killPlayer(w,p,'fish',null,f);
}`;

runtimeSource=replaceSection(runtimeSource,'function tryConsume(w,p,id){','function bossTarget(b){',directTryConsume,'tryConsume');

/* -------------------------------------------------------------------------
   COMBAT DEL SERVIDOR
   -------------------------------------------------------------------------
   Peces normales y lava NO resuelven contacto aquí. Eso era el segundo juez
   que chocaba con lo que el usuario veía. NPC-vs-player llega exclusivamente
   por consume/predator_contact desde la hitbox offline del cliente.

   Bosses y PvP siguen siendo autoritativos del servidor porque tienen reglas
   propias distintas a una presa/depredador normal.
   ------------------------------------------------------------------------- */
const directCombat=`function combat(w){
  const now=Date.now();

  for(const p of w.players.values()){
    if(!p.connected||!p.alive||p.invulnerableUntil>now||now-(p.lastInputAt||0)>450)continue;
    const ph=playerHB(p.growthScore);
    const b=w.boss;
    if(b&&b.chasing&&b.chaseId===p.id&&b.chaseUntil>now&&dist(p,b)<=ph+b.size*.72){
      killPlayer(w,p,'boss',null,b);
    }
  }

  const ps=[...w.players.values()].filter(p=>p.connected&&p.alive&&now-(p.lastInputAt||0)<=450);
  for(let i=0;i<ps.length;i++)for(let j=i+1;j<ps.length;j++){
    const a=ps[i],b=ps[j],at=normalizeTeam(a.team),bt=normalizeTeam(b.team);
    if(w.mode==='coop'||(w.mode==='teams'&&at&&bt&&at===bt))continue;
    const ar=playerHB(a.growthScore),br=playerHB(b.growthScore),dd=dist(a,b);
    if(dd>ar+br)continue;
    if(a.growthScore>b.growthScore*1.04&&ar>br*1.02){
      a.score+=Math.max(10,Math.floor(b.score*.25));
      a.growthScore+=Math.max(10,Math.floor(b.growthScore*.25));
      killPlayer(w,b,'player',a);
    }else if(b.growthScore>a.growthScore*1.04&&br>ar*1.02){
      b.score+=Math.max(10,Math.floor(a.score*.25));
      b.growthScore+=Math.max(10,Math.floor(a.growthScore*.25));
      killPlayer(w,a,'player',b);
    }
  }
  maybeStartBoss(w);
}`;
runtimeSource=replaceSection(runtimeSource,'function combat(w){','function applyInput(w,p,m){',directCombat,'combat');

const runtimeExport='combat,applyInput,tryConsume,tryBossHit';
if(!runtimeSource.includes(runtimeExport))throw new Error('Collision entry: no se encontró export runtime esperado');
runtimeSource=runtimeSource.replace(runtimeExport,'combat,applyInput,tryConsume,tryPredatorContact,tryBossHit');
await fs.writeFile(GENERATED_RUNTIME,runtimeSource,'utf8');

/* -------------------------------------------------------------------------
   SELF TESTS
   ------------------------------------------------------------------------- */
const TestRuntime=await import(pathToFileURL(GENERATED_RUNTIME).href+`?selftest=${Date.now()}`);
function makeTestPlayer(){return{id:'t',resumeId:'r',deviceId:'d',ws:null,connected:true,disconnectedAt:0,name:'TEST',team:null,mode:'coop',x:100,y:100,lastX:100,lastY:100,vx:0,vy:0,angle:0,score:0,growthScore:0,level:1,maxLives:1,lives:1,alive:true,sprinting:false,pet:'none',lastInputAt:Date.now(),lastBossHitAt:0,lastDeathReason:null,lastDeathBossType:null,lastDeathAt:0,invulnerableUntil:0};}
function makeTestWorld(p){return{code:'T',mode:'coop',seed:1,epoch:Date.now(),stage:0,bossCleared:false,tick:1,nextFish:2,nextGem:1,nextGemAt:Date.now()+60000,players:new Map([[p.id,p]]),fish:new Map(),respawns:[],boss:null,lavaHazard:null};}
function fish({id,role='prey',size=4,x=111,type='plankton',points=4}){return{id,index:0,type,role,points,color:'#fff',size,speed:1,baseSpeed:1,x,y:100,vx:0,vy:0,angle:0,heading:0,turn:1,chaseId:null,chaseUntil:0,chaseStartedAt:0,cooldownUntil:0,light:false,hazard:null,immortal:false,gemFish:false,renderKey:type};}
{
  const p=makeTestPlayer(),w=makeTestWorld(p),f=fish({id:'prey'});w.fish.set(f.id,f);
  const c={px:100,py:100,fx:111,fy:100};
  if(!TestRuntime.tryConsume(w,p,f.id,c)||w.fish.has(f.id))throw new Error('Collision self-test FAILED: visual eat');
}
{
  const p=makeTestPlayer(),w=makeTestWorld(p),f=fish({id:'lag-prey',x:190});w.fish.set(f.id,f);
  const c={px:100,py:100,fx:111,fy:100};
  if(!TestRuntime.tryConsume(w,p,f.id,c)||w.fish.has(f.id))throw new Error('Collision self-test FAILED: lag compensated eat');
}
{
  // Un solapamiento que solo existe en el estado del servidor NO debe matar.
  const p=makeTestPlayer(),w=makeTestWorld(p),f=fish({id:'server-only-pred',role:'predator',size:18,x:100,type:'piranha',points:35});w.fish.set(f.id,f);
  TestRuntime.combat(w);
  if(!p.alive)throw new Error('Collision self-test FAILED: server acted as second fish-collision judge');
}
{
  // El mismo depredador sí mata cuando el cliente reporta contacto visual.
  const p=makeTestPlayer(),w=makeTestWorld(p),f=fish({id:'pred',role:'predator',size:18,x:190,type:'piranha',points:35});w.fish.set(f.id,f);
  const c={px:100,py:100,fx:112,fy:100};
  if(!TestRuntime.tryPredatorContact(w,p,f.id,c)||p.alive)throw new Error('Collision self-test FAILED: visual predator contact');
}
console.log('NANY COLLISION SELF-TEST OK: visual contact is the only normal-fish collision judge');

/* -------------------------------------------------------------------------
   SERVIDOR GENERADO
   ------------------------------------------------------------------------- */
const runtimeImport="} from './world-runtime.mjs';";
if(!serverSource.includes(runtimeImport))throw new Error('Collision entry: no se encontró import runtime');
serverSource=serverSource.replace(runtimeImport,"} from './.world-runtime-collision-direct.mjs';");

const importFns='combat,applyInput,tryConsume,tryBossHit';
if(!serverSource.includes(importFns))throw new Error('Collision entry: no se encontró lista de imports runtime');
serverSource=serverSource.replace(importFns,'combat,applyInput,tryConsume,tryPredatorContact,tryBossHit');

const clientFileLine="const CLIENT_FILE=path.join(ROOT,'multiplayer-client.js');";
if(!serverSource.includes(clientFileLine))throw new Error('Collision entry: no se encontró CLIENT_FILE');
serverSource=serverSource.replace(clientFileLine,"const CLIENT_FILE=path.join(ROOT,'.multiplayer-client-collision.js');");
serverSource=serverSource.replace("server:'live-authoritative-v14-death-flow'","server:'live-authoritative-v18-visual-contact'");

const consumeHandler="else if(m.type==='consume'){\n      if(!tryConsume(world,player,m.entityId))send(ws,{type:'consume_rejected',entityId:String(m.entityId||''),serverTick:world.tick});\n    }\n    else if(m.type==='boss_hit'){";
const newConsumeHandler="else if(m.type==='consume'){\n      if(!tryConsume(world,player,m.entityId,m.contact||null))send(ws,{type:'consume_rejected',entityId:String(m.entityId||''),serverTick:world.tick});\n    }\n    else if(m.type==='predator_contact'){\n      if(!tryPredatorContact(world,player,m.entityId,m.contact||null))send(ws,{type:'predator_contact_rejected',entityId:String(m.entityId||''),serverTick:world.tick});\n    }\n    else if(m.type==='boss_hit'){";
if(!serverSource.includes(consumeHandler))throw new Error('Collision entry: no se encontró handler consume');
serverSource=serverSource.replace(consumeHandler,newConsumeHandler);

/* -------------------------------------------------------------------------
   CLIENTE: MISMA HITBOX Y MISMO FRAME QUE OFFLINE
   ------------------------------------------------------------------------- */
const oldSample="samplePair(buf,performance.now()-110)";
if(!clientSource.includes(oldSample))throw new Error('Collision entry: no se encontró buffer visual 110 ms');
clientSource=clientSource.replace(oldSample,"samplePair(buf,performance.now())");

const oldXY="x:mix(fa.x,fb.x,alpha),y:mix(fa.y,fb.y,alpha),vx:mix(Number(fa.vx)||0,Number(fb.vx)||0,alpha),vy:mix(Number(fa.vy)||0,Number(fb.vy)||0,alpha)";
const newXY="x:mix(fa.x,fb.x,alpha)+(Number(fb.vx)||0)*Math.min(65,Math.max(0,performance.now()-B.recv))*.06,y:mix(fa.y,fb.y,alpha)+(Number(fb.vy)||0)*Math.min(65,Math.max(0,performance.now()-B.recv))*.06,vx:mix(Number(fa.vx)||0,Number(fb.vx)||0,alpha),vy:mix(Number(fa.vy)||0,Number(fb.vy)||0,alpha)";
if(!clientSource.includes(oldXY))throw new Error('Collision entry: no se encontró interpolación XY');
clientSource=clientSource.replace(oldXY,newXY);

const pendingDecl="const PENDING=new Set(),REMOTE_DEATHS=[],REMOTE_PETS=new Map();";
if(!clientSource.includes(pendingDecl))throw new Error('Collision entry: no se encontró PENDING');
clientSource=clientSource.replace(pendingDecl,"const PENDING=new Set(),CONTACT_SENT=new Map(),REMOTE_DEATHS=[],REMOTE_PETS=new Map();");

const oldCollision="if(!e.sharedId||PENDING.has(String(e.sharedId))||e.immortal||e.hazard)continue;const fh=fhFn?.(e)||Math.max(2.5,e.size*.88),edible=e.gemFish||(e.ecologyRole==='prey'&&fh<ph*.96);if(edible&&dd<=ph+fh){PENDING.add(String(e.sharedId));mp.consumeEntity(e.sharedId,e.points||1);}";
const newCollision="if(!e.sharedId||PENDING.has(String(e.sharedId)))continue;const fh=fhFn?.(e)||Math.max(2.5,e.size*.88);if(dd>ph+fh)continue;if(Number(p.invuln||0)>0)continue;const contact={px:Number(p.x)||0,py:Number(p.y)||0,fx:Number(e.x)||0,fy:Number(e.y)||0,angle:Number(p.angle)||0,clientTime:Date.now()},edible=e.gemFish||(!e.hazard&&e.ecologyRole==='prey'&&fh<ph*.96),predator=!e.gemFish&&(e.ecologyRole==='predator'||e.role==='predator'||e.role==='hunter')&&fh>=ph*1.04;if(e.hazard==='lava'&&!e._chasing)continue;if(edible){PENDING.add(String(e.sharedId));sendDirect({type:'consume',entityId:e.serverId||e.sharedId,points:e.points||1,contact});continue}if(predator){const key=String(e.serverId||e.sharedId),now=performance.now(),last=CONTACT_SENT.get(key)||0;if(now-last>260){CONTACT_SENT.set(key,now);sendDirect({type:'predator_contact',entityId:e.serverId||e.sharedId,contact});}}";
if(!clientSource.includes(oldCollision))throw new Error('Collision entry: no se encontró bloque collision multiplayer');
clientSource=clientSource.replace(oldCollision,newCollision);

clientSource="window.__NANY_COLLISION_BUILD__='v18-visual-contact';\n"+clientSource;
try{new Function(clientSource);}catch(err){throw new Error(`Collision entry: cliente inválido: ${err.message}`);}

await fs.writeFile(GENERATED_CLIENT,clientSource,'utf8');
await fs.writeFile(GENERATED_SERVER,serverSource,'utf8');
await import(pathToFileURL(GENERATED_SERVER).href+`?collision=${Date.now()}`);
