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
  if(start<0||end<0||end<=start) throw new Error(`Collision entry: no se pudo localizar ${label}`);
  return source.slice(0,start)+replacement+'\n'+source.slice(end);
}

/* -------------------------------------------------------------------------
   MULTIPLAYER = MISMAS COLISIONES QUE OFFLINE
   -------------------------------------------------------------------------
   Offline ya se siente correcto. Por eso aquí NO inventamos otra hitbox.
   Conservamos exactamente playerHB=78%, fishHB=88% y contacto por distancia
   entre centros, igual que handleCollisions() del index.
   ------------------------------------------------------------------------- */
const directTryConsume=`function tryConsume(w,p,id){
  const f=w.fish.get(String(id||''));
  if(!f||!p.connected||!p.alive)return false;
  const reach=playerHB(p.growthScore)+fishHB(f);
  if(dist(p,f)>reach||!canPlayerEat(p,f))return false;
  const ok=removeFish(w,p,f);
  if(ok){maybeStartBoss(w);broadcast(w);}
  return ok;
}`;

runtimeSource=replaceSection(runtimeSource,'function tryConsume(w,p,id){','function bossTarget(b){',directTryConsume,'tryConsume');

const directCombat=`function combat(w){
  const now=Date.now();
  for(const p of w.players.values()){
    if(!p.connected||!p.alive||p.invulnerableUntil>now||now-(p.lastInputAt||0)>450)continue;
    const ph=playerHB(p.growthScore);

    for(const f of [...w.fish.values()]){
      if(!w.fish.has(f.id))continue;
      const fh=fishHB(f),dd=dist(p,f);
      if(dd>ph+fh)continue;

      // Igual que offline: si es presa y cabe en tu hitbox, la comes.
      if(canPlayerEat(p,f)){
        removeFish(w,p,f);
        continue;
      }

      // Igual que offline: si el pez puede comerte y físicamente toca,
      // te come. No depende de chaseStartedAt/chaseUntil.
      if(canFishEatPlayer(p,f)){
        killPlayer(w,p,'fish',null,f);
        break;
      }
    }

    if(!p.alive)continue;

    const h=w.lavaHazard;
    if(h&&dist(p,h)<=ph+fishHB(h)){
      killPlayer(w,p,'fish',null,h);
      continue;
    }

    const b=w.boss;
    if(b&&b.chasing&&b.chaseId===p.id&&b.chaseUntil>now&&dist(p,b)<=ph+b.size*.72){
      killPlayer(w,p,'boss',null,b);
      continue;
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
await fs.writeFile(GENERATED_RUNTIME,runtimeSource,'utf8');

/* Smoke test: las dos direcciones básicas deben funcionar con las reglas offline. */
const TestRuntime=await import(pathToFileURL(GENERATED_RUNTIME).href+`?selftest=${Date.now()}`);
function makeTestPlayer(){return{id:'t',resumeId:'r',deviceId:'d',ws:null,connected:true,disconnectedAt:0,name:'TEST',team:null,mode:'coop',x:100,y:100,lastX:100,lastY:100,vx:0,vy:0,angle:0,score:0,growthScore:0,level:1,maxLives:1,lives:1,alive:true,sprinting:false,pet:'none',lastInputAt:Date.now(),lastBossHitAt:0,lastDeathReason:null,lastDeathBossType:null,lastDeathAt:0,invulnerableUntil:0};}
function makeTestWorld(p){return{code:'T',mode:'coop',seed:1,epoch:Date.now(),stage:0,bossCleared:false,tick:1,nextFish:2,nextGem:1,nextGemAt:Date.now()+60000,players:new Map([[p.id,p]]),fish:new Map(),respawns:[],boss:null,lavaHazard:null};}
function fish({id,role='prey',size=4,x=111,type='plankton',points=4}){return{id,index:0,type,role,points,color:'#fff',size,speed:1,baseSpeed:1,x,y:100,vx:0,vy:0,angle:0,heading:0,turn:1,chaseId:null,chaseUntil:0,chaseStartedAt:0,cooldownUntil:0,light:false,hazard:null,immortal:false,gemFish:false,renderKey:type};}
{
  const p=makeTestPlayer(),w=makeTestWorld(p),f=fish({id:'prey'});w.fish.set(f.id,f);
  if(!TestRuntime.tryConsume(w,p,f.id)||w.fish.has(f.id))throw new Error('Collision self-test FAILED: eat');
}
{
  const p=makeTestPlayer(),w=makeTestWorld(p),f=fish({id:'pred',role:'predator',size:18,x:112,type:'piranha',points:35});w.fish.set(f.id,f);
  TestRuntime.combat(w);if(p.alive)throw new Error('Collision self-test FAILED: predator');
}
console.log('NANY COLLISION SELF-TEST OK: offline-equivalent');

/* Servidor generado */
const runtimeImport="} from './world-runtime.mjs';";
if(!serverSource.includes(runtimeImport))throw new Error('Collision entry: no se encontró import runtime');
serverSource=serverSource.replace(runtimeImport,"} from './.world-runtime-collision-direct.mjs';");
const clientFileLine="const CLIENT_FILE=path.join(ROOT,'multiplayer-client.js');";
if(!serverSource.includes(clientFileLine))throw new Error('Collision entry: no se encontró CLIENT_FILE');
serverSource=serverSource.replace(clientFileLine,"const CLIENT_FILE=path.join(ROOT,'.multiplayer-client-collision.js');");
serverSource=serverSource.replace("server:'live-authoritative-v14-death-flow'","server:'live-authoritative-v16-offline-collisions'");

/* -------------------------------------------------------------------------
   CORRECCIÓN DEL DESFASE VISUAL DE MULTIPLAYER
   -------------------------------------------------------------------------
   El cliente estaba dibujando todos los peces 110 ms en el pasado. Esa línea
   hacía que el pez visible y el pez que el servidor colisionaba fueran dos
   posiciones distintas. Quitamos ese buffer artificial y extrapolamos solo el
   pequeño tiempo transcurrido desde el último snapshot (máx. 80 ms).
   ------------------------------------------------------------------------- */
const oldSample="samplePair(buf,performance.now()-110)";
if(!clientSource.includes(oldSample))throw new Error('Collision entry: no se encontró el buffer visual de 110 ms');
clientSource=clientSource.replace(oldSample,"samplePair(buf,performance.now())");

const oldXY="x:mix(fa.x,fb.x,alpha),y:mix(fa.y,fb.y,alpha),vx:mix(Number(fa.vx)||0,Number(fb.vx)||0,alpha),vy:mix(Number(fa.vy)||0,Number(fb.vy)||0,alpha)";
const newXY="x:mix(fa.x,fb.x,alpha)+(Number(fb.vx)||0)*Math.min(80,Math.max(0,performance.now()-B.recv))*.06,y:mix(fa.y,fb.y,alpha)+(Number(fb.vy)||0)*Math.min(80,Math.max(0,performance.now()-B.recv))*.06,vx:mix(Number(fa.vx)||0,Number(fb.vx)||0,alpha),vy:mix(Number(fa.vy)||0,Number(fb.vy)||0,alpha)";
if(!clientSource.includes(oldXY))throw new Error('Collision entry: no se encontró interpolación XY esperada');
clientSource=clientSource.replace(oldXY,newXY);

// NO reemplazamos la condición dd<=ph+fh del cliente: esa ya es la misma que offline.
clientSource="window.__NANY_COLLISION_BUILD__='v16-offline-equivalent';\n"+clientSource;
try{new Function(clientSource);}catch(err){throw new Error(`Collision entry: cliente inválido: ${err.message}`);}

await fs.writeFile(GENERATED_CLIENT,clientSource,'utf8');
await fs.writeFile(GENERATED_SERVER,serverSource,'utf8');
await import(pathToFileURL(GENERATED_SERVER).href+`?collision=${Date.now()}`);
