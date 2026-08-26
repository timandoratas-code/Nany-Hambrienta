import * as Core from './world-runtime.mjs';

const {
  TICK_HZ,SNAP_HZ,MAX_PLAYERS,FISH_N,GEM_FISH_CAP,GEM_SPAWN_INTERVAL_MS,HEARTBEAT_MS,RESUME_MS,
  worlds,worldForMode,randomSpawn,stageLevel,teamFor,pubPlayer,snapshot,broadcast,sendAll,send,
  updateFish,updateBoss,applyInput,tryBossHit,devSetMass,devSetStage,safeName,makeId,makeDeviceId
}=Core;

// The fish artwork reaches roughly 1.05 * size at the front of the body.
// Keep the original 0.78 / 0.88 hitboxes for FOOD/THREAT eligibility, and
// use this larger radius only to decide when two visible bodies have touched.
const CONTACT_SCALE=1.05;
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

function moveEntityToRuleContact(e,p,reach){
  const ox=e.x,oy=e.y;
  const dx=ox-p.x,dy=oy-p.y,d=Math.hypot(dx,dy);
  if(!Number.isFinite(d)||d<=reach||d<0.0001)return null;
  const target=Math.max(0,reach-0.05);
  e.x=p.x+dx/d*target;
  e.y=p.y+dy/d*target;
  return {x:ox,y:oy};
}

// Preserve every original consume rule. We only bridge the narrow visual gap
// between the old inner circle and the actual rendered body.
function tryConsume(w,p,id){
  const f=w?.fish?.get?.(String(id||''));
  if(!f||!p?.connected||!p?.alive)return Core.tryConsume(w,p,id);

  const oldReach=rulePlayerHB(p)+ruleFishHB(f);
  const visualReach=contactPlayerHB(p)+contactFishHB(f);
  const d=dist(p,f);
  if(d<=oldReach||d>visualReach)return Core.tryConsume(w,p,id);

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

    const affectsCollision=canPlayerEat(p,f)||canFishEat(p,f);
    if(!affectsCollision)continue;

    const oldReach=rulePlayerHB(p)+ruleFishHB(f);
    const visualReach=contactPlayerHB(p)+contactFishHB(f);
    const d=dist(p,f);
    if(d<=oldReach||d>visualReach)continue;
    const ratio=d/Math.max(1,visualReach);
    if(ratio<bestRatio){bestRatio=ratio;best={p,oldReach};}
  }
  return best;
}

// Run the original authoritative combat untouched. Before it runs, entities
// that are visibly touching are projected only for the collision calculation;
// surviving entities are immediately restored to their real server positions.
function combat(w){
  if(!w?.players)return Core.combat(w);
  const players=[...w.players.values()];
  const saved=[];

  for(const f of w.fish?.values?.()||[]){
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
      const now=Date.now();
      if(Number(p.invulnerableUntil||0)>now||now-Number(p.lastInputAt||0)>450)continue;
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
      if(s.kind==='fish'){
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
