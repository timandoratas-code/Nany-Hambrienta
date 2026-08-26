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
   No importamos world-runtime-collision.mjs ni encadenamos wrappers. Generamos
   una copia del runtime base y sustituimos solamente tryConsume() y combat().
   De esta forma servidor, puntuación, respawn y muerte usan una única regla.
   ------------------------------------------------------------------------- */
const directTryConsume=`function __frontEatContact(p,f){
  const pr=radius(p.growthScore);
  const fr=Math.max(2.5,(Number(f?.size)||0)*1.05);
  const a=Number(p.angle)||0,ca=Math.cos(a),sa=Math.sin(a);
  const dx=f.x-p.x,dy=f.y-p.y;
  const forward=dx*ca+dy*sa;
  const lateral=Math.abs(-dx*sa+dy*ca);
  // Cabeza + mitad delantera del cuerpo. Es deliberadamente generosa para
  // que el contacto visual responda, pero la cola queda fuera.
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
    // que el cliente alcance a mandar consume justo en el frame de contacto.
    for(const f of [...w.fish.values()]){
      if(!w.fish.has(f.id))continue;
      if(canPlayerEat(p,f)&&__frontEatContact(p,f)){
        removeFish(w,p,f);
        continue;
      }

      // DEPREDADORES: si son suficientemente grandes y el cuerpo visible toca
      // al jugador, comen. No exigimos un flag de persecución desincronizable.
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

  // PvP entre jugadores: contacto corporal visible, manteniendo las mismas
  // reglas de masa/tamaño para decidir quién puede comer a quién.
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

/* Servidor: importa directamente el runtime generado y sirve el cliente
   generado. También exponemos una firma nueva en /health para comprobar que
   el despliegue realmente arrancó esta versión. */
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

/* Cliente: usa la misma zona frontal generosa. El servidor NO depende de este
   envío para resolver la colisión; esto solo hace la respuesta visual inmediata. */
const oldCollision="const fh=fhFn?.(e)||Math.max(2.5,e.size*.88),edible=e.gemFish||(e.ecologyRole==='prey'&&fh<ph*.96);if(edible&&dd<=ph+fh){";
const newCollision="const fh=fhFn?.(e)||Math.max(2.5,e.size*.88),pr=window.eval('playerRadius(growthScore())'),pa=Number(p.angle)||0,ca=Math.cos(pa),sa=Math.sin(pa),rdx=e.x-p.x,rdy=e.y-p.y,forward=rdx*ca+rdy*sa,lateral=Math.abs(-rdx*sa+rdy*ca),contactFh=Math.max(2.5,(Number(e.size)||0)*1.05),edible=e.gemFish||(e.ecologyRole==='prey'&&fh<ph*.96);if(edible&&forward>=(-pr*.20-contactFh*.30)&&forward<=(pr*1.35+contactFh)&&lateral<=(pr*.95+contactFh)){";
if(!clientSource.includes(oldCollision)){
  throw new Error('Collision entry: no se encontró la colisión multiplayer esperada');
}
clientSource=clientSource.replace(oldCollision,newCollision);

await fs.writeFile(GENERATED_CLIENT,clientSource,'utf8');
await fs.writeFile(GENERATED_SERVER,serverSource,'utf8');

await import(pathToFileURL(GENERATED_SERVER).href+`?collision=${Date.now()}`);
