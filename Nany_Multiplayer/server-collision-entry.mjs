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
  if(start<0||end<0||end<=start){
    throw new Error(`Collision entry: no se pudo localizar ${label}`);
  }
  return source.slice(0,start)+replacement+'\n'+source.slice(end);
}

/* -------------------------------------------------------------------------
   AUTORIDAD ÚNICA DE COLISIONES
   -------------------------------------------------------------------------
   Generamos una copia del runtime base y sustituimos directamente solamente
   tryConsume() y combat(). No hay wrappers de colisión encadenados.
   ------------------------------------------------------------------------- */
const directTryConsume=`function __frontEatContact(p,f){
  const pr=radius(p.growthScore);
  const fr=Math.max(2.5,(Number(f?.size)||0)*1.05);
  const a=Number(p.angle)||0,ca=Math.cos(a),sa=Math.sin(a);
  const dx=f.x-p.x,dy=f.y-p.y;
  const forward=dx*ca+dy*sa;
  const lateral=Math.abs(-dx*sa+dy*ca);
  // Cabeza + mitad delantera del cuerpo. Generosa para que el contacto visual
  // responda, pero la cola queda fuera de la zona que puede comer.
  return forward>=(-pr*.20-fr*.30) &&
         forward<=(pr*1.35+fr) &&
         lateral<=(pr*.95+fr);
}
function __visibleBodyContact(p,f){
  const pr=radius(p.growthScore)*1.05;
  const fr=Math.max(2.5,(Number(f?.size)||0)*1.05);
  return dist(p,f)<=pr+fr;
}
function tryConsume(w,p,id){
  const f=w.fish.get(String(id||''));
  if(!f||!p.connected||!p.alive)return false;
  if(!canPlayerEat(p,f)||!__frontEatContact(p,f))return false;
  const ok=removeFish(w,p,f);
  if(ok){maybeStartBoss(w);broadcast(w);}
  return ok;
}`;

runtimeSource=replaceSection(
  runtimeSource,
  'function tryConsume(w,p,id){',
  'function bossTarget(b){',
  directTryConsume,
  'tryConsume'
);

const directCombat=`function combat(w){
  const now=Date.now();
  for(const p of w.players.values()){
    if(!p.connected||!p.alive||p.invulnerableUntil>now||now-(p.lastInputAt||0)>450)continue;

    // PRESAS: el servidor comprueba la zona frontal cada tick. No depende de
    // recibir un mensaje consume justo en el frame de contacto.
    for(const f of [...w.fish.values()]){
      if(!w.fish.has(f.id))continue;
      if(canPlayerEat(p,f)&&__frontEatContact(p,f)){
        removeFish(w,p,f);
        continue;
      }

      // DEPREDADORES: si son suficientemente grandes y su cuerpo visible toca
      // al jugador, comen. No dependen de un flag de persecución para colisionar.
      if(canFishEatPlayer(p,f)&&__visibleBodyContact(p,f)){
        killPlayer(w,p,'fish',null,f);
        break;
      }
    }

    if(!p.alive)continue;

    const h=w.lavaHazard;
    if(h&&__visibleBodyContact(p,h)){
      killPlayer(w,p,'fish',null,h);
      continue;
    }

    // Los jefes conservan su patrón especial de ataque.
    const b=w.boss;
    if(b&&b.chasing&&b.chaseId===p.id&&b.chaseUntil>now&&
       dist(p,b)<=radius(p.growthScore)*1.05+b.size*.78){
      killPlayer(w,p,'boss',null,b);
      continue;
    }
  }

  // PvP entre jugadores mantiene las reglas de masa y usa contacto visible.
  const ps=[...w.players.values()].filter(p=>p.connected&&p.alive&&now-(p.lastInputAt||0)<=450);
  for(let i=0;i<ps.length;i++)for(let j=i+1;j<ps.length;j++){
    const a=ps[i],b=ps[j],at=normalizeTeam(a.team),bt=normalizeTeam(b.team);
    if(w.mode==='coop'||(w.mode==='teams'&&at&&bt&&at===bt))continue;
    const ar=playerHB(a.growthScore),br=playerHB(b.growthScore);
    const contactA=radius(a.growthScore)*1.05,contactB=radius(b.growthScore)*1.05;
    if(dist(a,b)>contactA+contactB)continue;
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

runtimeSource=replaceSection(
  runtimeSource,
  'function combat(w){',
  'function applyInput(w,p,m){',
  directCombat,
  'combat'
);

await fs.writeFile(GENERATED_RUNTIME,runtimeSource,'utf8');

/* -------------------------------------------------------------------------
   SMOKE TEST REAL DEL RUNTIME GENERADO
   -------------------------------------------------------------------------
   El despliegue no continúa si la misma función autoritativa que usará la
   partida no puede (1) comer una presa frontal o (2) matar por contacto con
   un depredador más grande.
   ------------------------------------------------------------------------- */
const TestRuntime=await import(pathToFileURL(GENERATED_RUNTIME).href+`?selftest=${Date.now()}`);

function makeTestPlayer(){
  return {
    id:'collision-test-player',resumeId:'collision-test-resume',deviceId:'collision-test-device',
    ws:null,connected:true,disconnectedAt:0,name:'TEST',team:null,mode:'coop',
    x:100,y:100,lastX:100,lastY:100,vx:0,vy:0,angle:0,
    score:0,growthScore:0,level:1,maxLives:1,lives:1,alive:true,sprinting:false,pet:'none',
    lastInputAt:Date.now(),lastBossHitAt:0,lastDeathReason:null,lastDeathBossType:null,lastDeathAt:0,
    invulnerableUntil:0
  };
}
function makeTestWorld(p){
  return {
    code:'COLLISION_TEST',mode:'coop',seed:1,epoch:Date.now(),stage:0,bossCleared:false,tick:1,
    nextFish:2,nextGem:1,nextGemAt:Date.now()+60000,
    players:new Map([[p.id,p]]),fish:new Map(),respawns:[],boss:null,lavaHazard:null
  };
}
function makeTestFish({id,type='plankton',role='prey',size=4,x=111,points=4}){
  return {
    id,index:0,type,role,points,color:'#ffffff',size,speed:1,baseSpeed:1,x,y:100,vx:0,vy:0,
    angle:0,heading:0,turn:1,chaseId:null,chaseUntil:0,chaseStartedAt:0,cooldownUntil:0,
    light:false,hazard:null,immortal:false,gemFish:false,renderKey:type
  };
}

{
  const p=makeTestPlayer(),w=makeTestWorld(p),prey=makeTestFish({id:'prey-test'});
  w.fish.set(prey.id,prey);
  const ate=TestRuntime.tryConsume(w,p,prey.id);
  if(!ate||w.fish.has(prey.id)||p.growthScore<=0){
    throw new Error('Collision self-test FAILED: el jugador no pudo comer una presa frontal');
  }
}
{
  const p=makeTestPlayer(),w=makeTestWorld(p),pred=makeTestFish({id:'predator-test',type:'piranha',role:'predator',size:18,x:112,points:35});
  w.fish.set(pred.id,pred);
  TestRuntime.combat(w);
  if(p.alive){
    throw new Error('Collision self-test FAILED: un depredador grande no pudo comer al jugador');
  }
}
console.log('NANY COLLISION SELF-TEST OK: eat + predator death');

/* Servidor: importa el runtime generado y sirve el cliente generado. */
const runtimeImport="} from './world-runtime.mjs';";
if(!serverSource.includes(runtimeImport)){
  throw new Error('Collision entry: no se encontró el import de world-runtime.mjs');
}
serverSource=serverSource.replace(runtimeImport,"} from './.world-runtime-collision-direct.mjs';");

const clientFileLine="const CLIENT_FILE=path.join(ROOT,'multiplayer-client.js');";
if(!serverSource.includes(clientFileLine)){
  throw new Error('Collision entry: no se encontró CLIENT_FILE en server.mjs');
}
serverSource=serverSource.replace(clientFileLine,"const CLIENT_FILE=path.join(ROOT,'.multiplayer-client-collision.js');");
serverSource=serverSource.replace("server:'live-authoritative-v14-death-flow'","server:'live-authoritative-v15-collision-direct'");

/* Cliente: la misma zona frontal. El servidor no depende de este mensaje para
   resolver la colisión; sirve para que la respuesta visual sea inmediata. */
const oldCollision="const fh=fhFn?.(e)||Math.max(2.5,e.size*.88),edible=e.gemFish||(e.ecologyRole==='prey'&&fh<ph*.96);if(edible&&dd<=ph+fh){";
const newCollision="const fh=fhFn?.(e)||Math.max(2.5,e.size*.88),pr=window.eval('playerRadius(growthScore())'),pa=Number(p.angle)||0,ca=Math.cos(pa),sa=Math.sin(pa),rdx=e.x-p.x,rdy=e.y-p.y,forward=rdx*ca+rdy*sa,lateral=Math.abs(-rdx*sa+rdy*ca),contactFh=Math.max(2.5,(Number(e.size)||0)*1.05),edible=e.gemFish||(e.ecologyRole==='prey'&&fh<ph*.96);if(edible&&forward>=(-pr*.20-contactFh*.30)&&forward<=(pr*1.35+contactFh)&&lateral<=(pr*.95+contactFh)){";
if(!clientSource.includes(oldCollision)){
  throw new Error('Collision entry: no se encontró la colisión multiplayer esperada');
}
clientSource=clientSource.replace(oldCollision,newCollision);
clientSource="window.__NANY_COLLISION_BUILD__='v15-direct';\n"+clientSource;

// Parseamos el cliente generado antes de servirlo para detectar sintaxis rota.
try{ new Function(clientSource); }
catch(err){ throw new Error(`Collision entry: cliente generado inválido: ${err.message}`); }

await fs.writeFile(GENERATED_CLIENT,clientSource,'utf8');
await fs.writeFile(GENERATED_SERVER,serverSource,'utf8');

await import(pathToFileURL(GENERATED_SERVER).href+`?collision=${Date.now()}`);
