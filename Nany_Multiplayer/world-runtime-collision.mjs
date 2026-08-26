import * as Core from './world-runtime.mjs';

const {
  TICK_HZ,SNAP_HZ,MAX_PLAYERS,FISH_N,GEM_FISH_CAP,GEM_SPAWN_INTERVAL_MS,HEARTBEAT_MS,RESUME_MS,
  worlds,worldForMode,randomSpawn,stageLevel,teamFor,pubPlayer,snapshot,broadcast,sendAll,send,
  updateFish,updateBoss,applyInput,tryBossHit,devSetMass,devSetStage,safeName,makeId,makeDeviceId
}=Core;

// La silueta visible del pez llega aproximadamente a 1.05 * size.
// Las reglas 0.78 / 0.88 siguen decidiendo QUIÉN puede comer a quién.
// Para comer presas usamos una zona frontal de mordida alineada con p.angle;
// para depredadores mantenemos contacto de cuerpo completo.
const CONTACT_SCALE=1.05;
const MOUTH_OFFSET_SCALE=0.80;
const MOUTH_REACH_SCALE=0.28;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);

function radius(score){
  const x=Math.max(0,Number(score)||0);
  if(x<200)return 11+x*0.010;
  if(x<500)return 13+(x-200)*0.020;
  if(x<1000)return 19+(x-500)*0.025;
  if(x<2500)return 31.5+(x-1000)*0.018;
  if(x<4500)return 58.5+(x-2500)*0.014;
  if(x<7000)return 86.5+(x-4500)*0.011;
  if(x<10000)return 114+(x-7000)*0.009;
  return 141+Math.min(35,(x-10000)*0.006);
}

const rulePlayerHB=p=>radius(p?.growthScore)*0.78;
const ruleFishHB=f=>Math.max(2.5,(Number(f?.size)||0)*0.88);
const contactPlayerHB=p=>radius(p?.growthScore)*CONTACT_SCALE;
const contactFishHB=f=>Math.max(2.5,(Number(f?.size)||0)*CONTACT_SCALE);
const isPredator=f=>f?.role==='predator'||f?.role==='hunter';
const canPlayerEat=(p,f)=>!!f?.gemFish||(!f?.immortal&&f?.role==='prey'&&ruleFishHB(f)<rulePlayerHB(p)*0.96);
const canFishEat=(p,f)=>isPredator(f)&&ruleFishHB(f)>=rulePlayerHB(p)*1.04;

function mouthContact(p,f){
  if(!p||!f)return false;
  const pr=radius(p.growthScore);
  const a=Number(p.angle)||0;
  const mx=p.x+Math.cos(a)*pr*MOUTH_OFFSET_SCALE;
  const my=p.y+Math.sin(a)*pr*MOUTH_OFFSET_SCALE;
  const biteReach=Math.max(3,pr*MOUTH_REACH_SCALE);
  return Math.hypot(f.x-mx,f.y-my)<=biteReach+contactFishHB(f);
}

function moveEntityToRuleContact(e,p,reach){
  const ox=e.x,oy=e.y;
  const dx=ox-p.x,dy=oy-p.y,d=Math.hypot(dx,dy);
  if(!Number.isFinite(d)||d<=reach||d<0.0001)return null;
  const target=Math.max(0,reach-0.05);
  e.x=p.x+dx/d*target;
  e.y=p.y+dy/d*target;
  return {x:ox,y:oy};
}

// El servidor valida la misma mordida frontal que el cliente. Si la boca
// visible toca una presa pero los antiguos círculos internos aún no se cruzan,
// proyectamos temporalmente la presa al alcance antiguo solo para reutilizar
// las reglas originales de puntuación/respawn de Core.tryConsume.
function tryConsume(w,p,id){
  const f=w?.fish?.get?.(String(id||''));
  if(!f||!p?.connected||!p?.alive)return Core.tryConsume(w,p,id);
  if(!canPlayerEat(p,f))return Core.tryConsume(w,p,id);
  if(!mouthContact(p,f))return false;

  const oldReach=rulePlayerHB(p)+ruleFishHB(f);
  const d=dist(p,f);
  if(d<=oldReach)return Core.tryConsume(w,p,id);

  const old=moveEntityToRuleContact(f,p,oldReach);
  const ok=Core.tryConsume(w,p,id);
  if(!ok&&old&&w.fish.get(f.id)===f){f.x=old.x;f.y=old.y;}
  return ok;
}

function chooseContactPlayer(players,f){
  let best=null,bestRatio=Infinity;
  for(const p of players){
    if(!p?.connected||!p?.alive)continue;
    const now=Date.now();
    if(Number(p.invulnerableUntil||0)>now||now-Number(p.lastInputAt||0)>450)continue;
    if(!canFishEat(p,f))continue;

    const oldReach=rulePlayerHB(p)+ruleFishHB(f);
    const visualReach=contactPlayerHB(p)+contactFishHB(f);
    const d=dist(p,f);
    if(d<=oldReach||d>visualReach)continue;
    const ratio=d/Math.max(1,visualReach);
    if(ratio<bestRatio){bestRatio=ratio;best={p,oldReach};}
  }
  return best;
}

// 1) Resolvemos comer presas únicamente desde la boca.
// 2) Ocultamos temporalmente las presas restantes para impedir que el combat
//    original las coma con el viejo círculo centrado (incluida la cola).
// 3) Conservamos el puente de contacto corporal para depredadores y lava.
function combat(w){
  if(!w?.players)return Core.combat(w);
  const players=[...w.players.values()];
  const now=Date.now();

  for(const p of players){
    if(!p?.connected||!p?.alive)continue;
    if(Number(p.invulnerableUntil||0)>now||now-Number(p.lastInputAt||0)>450)continue;
    for(const f of [...(w.fish?.values?.()||[])]){
      if(!w.fish?.has?.(f.id))continue;
      if(canPlayerEat(p,f)&&mouthContact(p,f))tryConsume(w,p,f.id);
    }
  }

  const saved=[];
  for(const f of w.fish?.values?.()||[]){
    if(f?.gemFish||f?.role==='prey'){
      saved.push({kind:'prey',e:f,x:f.x,y:f.y});
      f.x=-1000000;
      f.y=-1000000;
      continue;
    }

    const hit=chooseContactPlayer(players,f);
    if(!hit)continue;
    const old=moveEntityToRuleContact(f,hit.p,hit.oldReach);
    if(old)saved.push({kind:'fish',e:f,x:old.x,y:old.y});
  }

  const h=w.lavaHazard;
  if(h){
    let best=null,bestRatio=Infinity;
    for(const p of players){
      if(!p?.connected||!p?.alive)continue;
      const tickNow=Date.now();
      if(Number(p.invulnerableUntil||0)>tickNow||tickNow-Number(p.lastInputAt||0)>450)continue;
      const oldReach=rulePlayerHB(p)+ruleFishHB(h);
      const visualReach=contactPlayerHB(p)+contactFishHB(h);
      const d=dist(p,h);
      if(d<=oldReach||d>visualReach)continue;
      const ratio=d/Math.max(1,visualReach);
      if(ratio<bestRatio){bestRatio=ratio;best={p,oldReach};}
    }
    if(best){
      const old=moveEntityToRuleContact(h,best.p,best.oldReach);
      if(old)saved.push({kind:'lava',e:h,x:old.x,y:old.y});
    }
  }

  try{
    return Core.combat(w);
  }finally{
    for(const s of saved){
      if(s.kind==='prey'||s.kind==='fish'){
        if(w.fish?.get?.(s.e.id)===s.e){s.e.x=s.x;s.e.y=s.y;}
      }else if(s.kind==='lava'&&w.lavaHazard===s.e){
        s.e.x=s.x;s.e.y=s.y;
      }
    }
  }
}

export {
  TICK_HZ,SNAP_HZ,MAX_PLAYERS,FISH_N,GEM_FISH_CAP,GEM_SPAWN_INTERVAL_MS,HEARTBEAT_MS,RESUME_MS,
  worlds,worldForMode,randomSpawn,stageLevel,teamFor,pubPlayer,snapshot,broadcast,sendAll,send,
  updateFish,updateBoss,combat,applyInput,tryConsume,tryBossHit,devSetMass,devSetStage,safeName,makeId,makeDeviceId
};
