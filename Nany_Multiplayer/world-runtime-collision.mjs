import * as Core from './world-runtime.mjs';

const {
  TICK_HZ,SNAP_HZ,MAX_PLAYERS,FISH_N,GEM_FISH_CAP,GEM_SPAWN_INTERVAL_MS,HEARTBEAT_MS,RESUME_MS,
  worlds,worldForMode,randomSpawn,stageLevel,teamFor,pubPlayer,snapshot,broadcast,sendAll,send,
  updateFish,updateBoss,applyInput,tryBossHit,devSetMass,devSetStage,safeName,makeId,makeDeviceId
}=Core;

// Una sola regla decide las colisiones de peces en multiplayer:
// - el tamaño interno 0.78/0.88 sigue decidiendo QUIÉN puede comer a quién;
// - las presas se comen únicamente desde la mitad frontal del jugador;
// - los depredadores matan al tocar físicamente el cuerpo visible del jugador.
const CONTACT_SCALE=1.05;
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
  const fh=contactFishHB(f);
  const a=Number(p.angle)||0;
  const ca=Math.cos(a),sa=Math.sin(a);
  const dx=f.x-p.x,dy=f.y-p.y;
  const forward=dx*ca+dy*sa;
  const lateral=Math.abs(-dx*sa+dy*ca);

  // Zona frontal amplia: empieza prácticamente en el centro del cuerpo y
  // llega hasta la nariz visible. La cola queda completamente fuera.
  return forward>=(-pr*0.05-fh*0.25) &&
         forward<=(pr*1.20+fh) &&
         lateral<=(pr*0.78+fh);
}

function visibleBodyContact(p,f){
  return dist(p,f)<=contactPlayerHB(p)+contactFishHB(f);
}

function moveIntoCoreReach(e,p,reach){
  const ox=e.x,oy=e.y;
  const dx=ox-p.x,dy=oy-p.y,d=Math.hypot(dx,dy);
  if(!Number.isFinite(d)||d<0.0001||d<=reach)return {x:ox,y:oy,moved:false};
  const target=Math.max(0,reach-0.05);
  e.x=p.x+dx/d*target;
  e.y=p.y+dy/d*target;
  return {x:ox,y:oy,moved:true};
}

function tryConsume(w,p,id){
  const f=w?.fish?.get?.(String(id||''));
  if(!f||!p?.connected||!p?.alive)return false;
  if(!canPlayerEat(p,f)||!mouthContact(p,f))return false;

  const oldReach=rulePlayerHB(p)+ruleFishHB(f);
  const old=moveIntoCoreReach(f,p,oldReach);
  const ok=Core.tryConsume(w,p,id);
  if(!ok&&old.moved&&w.fish?.get?.(f.id)===f){f.x=old.x;f.y=old.y;}
  return ok;
}

function eligiblePlayers(players,now){
  return players.filter(p=>p?.connected&&p?.alive&&Number(p.invulnerableUntil||0)<=now&&now-Number(p.lastInputAt||0)<=450);
}

function nearestPredatorVictim(players,f){
  let best=null,bestD=Infinity;
  for(const p of players){
    if(!canFishEat(p,f)||!visibleBodyContact(p,f))continue;
    const d=dist(p,f);
    if(d<bestD){bestD=d;best=p;}
  }
  return best;
}

function armPredatorContact(saved,f,p,now,kind='fish'){
  const oldReach=rulePlayerHB(p)+ruleFishHB(f);
  const old=moveIntoCoreReach(f,p,oldReach);
  saved.push({
    kind,e:f,x:old.x,y:old.y,
    role:f.role,chaseId:f.chaseId,chaseUntil:f.chaseUntil,
    chaseStartedAt:f.chaseStartedAt,cooldownUntil:f.cooldownUntil
  });
  f.role='hunter';
  f.chaseId=p.id;
  f.chaseStartedAt=now-1000;
  f.chaseUntil=now+300;
  f.cooldownUntil=0;
}

function combat(w){
  if(!w?.players)return Core.combat(w);
  const now=Date.now();
  const allPlayers=[...w.players.values()];
  const players=eligiblePlayers(allPlayers,now);

  // Comer presas: el servidor no espera al mensaje del cliente; valida la
  // zona frontal cada tick para que tocar con la cabeza responda de inmediato.
  for(const p of players){
    for(const f of [...(w.fish?.values?.()||[])]){
      if(!w.fish?.has?.(f.id))continue;
      if(canPlayerEat(p,f)&&mouthContact(p,f))tryConsume(w,p,f.id);
    }
  }

  const saved=[];

  // Ocultamos las presas restantes SOLO durante Core.combat para impedir que
  // el círculo antiguo centrado permita comer con la cola.
  for(const f of w.fish?.values?.()||[]){
    if(f?.gemFish||f?.role==='prey'){
      saved.push({kind:'prey',e:f,x:f.x,y:f.y});
      f.x=-1000000;
      f.y=-1000000;
      continue;
    }

    // Un depredador que realmente toca al jugador queda armado para este tick.
    // Así el contacto físico siempre puede matar y no depende de un estado de
    // persecución que pudiera haberse desincronizado.
    const victim=nearestPredatorVictim(players,f);
    if(victim)armPredatorContact(saved,f,victim,now,'fish');
  }

  const h=w.lavaHazard;
  if(h){
    const victim=nearestPredatorVictim(players,h);
    if(victim)armPredatorContact(saved,h,victim,now,'lava');
  }

  try{
    return Core.combat(w);
  }finally{
    for(const s of saved){
      if(s.kind==='prey'){
        if(w.fish?.get?.(s.e.id)===s.e){s.e.x=s.x;s.e.y=s.y;}
        continue;
      }

      const stillThere=s.kind==='lava' ? w.lavaHazard===s.e : w.fish?.get?.(s.e.id)===s.e;
      if(!stillThere)continue;
      s.e.x=s.x;s.e.y=s.y;
      s.e.role=s.role;
      s.e.chaseId=s.chaseId;
      s.e.chaseUntil=s.chaseUntil;
      s.e.chaseStartedAt=s.chaseStartedAt;
      s.e.cooldownUntil=s.cooldownUntil;
    }
  }
}

export {
  TICK_HZ,SNAP_HZ,MAX_PLAYERS,FISH_N,GEM_FISH_CAP,GEM_SPAWN_INTERVAL_MS,HEARTBEAT_MS,RESUME_MS,
  worlds,worldForMode,randomSpawn,stageLevel,teamFor,pubPlayer,snapshot,broadcast,sendAll,send,
  updateFish,updateBoss,combat,applyInput,tryConsume,tryBossHit,devSetMass,devSetStage,safeName,makeId,makeDeviceId
};
