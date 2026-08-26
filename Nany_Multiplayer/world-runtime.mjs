const WORLD_W = 12000, WORLD_H = 12000;
const TICK_HZ = 30, SNAP_HZ = 20;
const MAX_PLAYERS = 8, FISH_N = 260, GEM_FISH_N = Math.round(FISH_N * 0.05);
const HEARTBEAT_MS = 15000, RESUME_MS = 10 * 60 * 1000;
const FISH_RESPAWN_MS = 1600;
const BOSS_HITS = 5;
const PET_KEYS = new Set(['none','turtle','crab','puffer','dolphin','ray']);

const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));
const send = (ws,msg)=>{ if(ws?.readyState===1) ws.send(JSON.stringify(msg)); };
const sendAll = (w,msg)=>{ for(const p of w.players.values()) if(p.connected) send(p.ws,msg); };
const dist = (a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const safeName = v=>String(v||'Nany').trim().slice(0,18)||'Nany';
const makeId = prefix=>`${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const worldForMode = v=>v==='ffa'||v==='pvp'?['PVP','ffa']:v==='coop'||v==='pve'?['PVE','coop']:['EQUIPO','teams'];
const radius = growth=>clamp(11+Math.sqrt(Math.max(0,growth))*0.62,11,320);
const playerHB = growth=>radius(growth)*0.78;
const fishHB = f=>Math.max(2.5,f.size*0.88);
const stageLevel = stage=>stage<=1?1:stage<=3?2:stage<=5?3:4;
const isBossStage = stage=>stage===1||stage===3||stage===5;

const FISH = {
  gem:{key:'gemFish',role:'prey',points:4,color:'#57ff63',size:9,speed:4.35,gemFish:true},
  plankton:{key:'plankton',role:'prey',points:4,color:'#8fffb0',size:4,speed:2.10},
  minnow:{key:'minnow',role:'prey',points:8,color:'#bfe6ff',size:8,speed:2.55},
  green:{key:'green',role:'prey',points:16,color:'#39ff6a',size:10,speed:2.95},
  silver:{key:'silver',role:'prey',points:24,color:'#d9f2ff',size:13,speed:3.20},
  piranha:{key:'piranha',role:'predator',points:35,color:'#ff8a3d',size:14,speed:4.15},
  stick:{key:'stick',role:'predator',points:50,color:'#e0c66a',size:17,speed:3.70},
  rival:{key:'rival',role:'predator',points:75,color:'#a084ff',size:21,speed:4.30},
  lantern:{key:'lantern',role:'predator',points:105,color:'#6ccfff',size:24,speed:4.25,light:true,minLevel:2},
  shark:{key:'shark',role:'predator',points:150,color:'#6d8796',size:31,speed:4.85},
  monster:{key:'monster',role:'predator',points:300,color:'#8d2638',size:44,speed:4.40}
};

// 247 peces normales + 13 pez gema = 260. Los depredadores nunca desaparecen.
const LEVEL_POOLS = {
  1:[['plankton',84],['minnow',50],['green',28],['piranha',31],['stick',23],['rival',18],['shark',9],['monster',4]],
  2:[['plankton',65],['minnow',48],['green',29],['silver',10],['piranha',27],['stick',19],['rival',17],['lantern',17],['shark',9],['monster',6]],
  3:[['plankton',56],['minnow',42],['green',31],['silver',14],['piranha',25],['stick',19],['rival',19],['lantern',22],['shark',11],['monster',8]],
  4:[['plankton',48],['minnow',39],['green',29],['silver',17],['piranha',25],['stick',19],['rival',19],['lantern',26],['shark',15],['monster',10]]
};

function weightedType(level,index){
  const pool=LEVEL_POOLS[level]||LEVEL_POOLS[4];
  let n=index;
  for(const [key,count] of pool){if(n<count)return FISH[key];n-=count;}
  return FISH.monster;
}
function rng(seed){let s=(seed>>>0)||1;return()=>{s^=s<<13;s>>>=0;s^=s>>>17;s>>>=0;return((s^=s<<5)>>>0)/4294967296;};}
function randomSpawn(margin=500){return{x:margin+Math.random()*(WORLD_W-margin*2),y:margin+Math.random()*(WORLD_H-margin*2)};}
function safeFishPos(w,r=Math.random){
  for(let tries=0;tries<12;tries++){
    const pos={x:220+r()*(WORLD_W-440),y:220+r()*(WORLD_H-440)};
    let okay=true;
    for(const p of w.players.values())if(p.connected&&p.alive&&Math.hypot(pos.x-p.x,pos.y-p.y)<360){okay=false;break;}
    if(okay)return pos;
  }
  return{x:220+r()*(WORLD_W-440),y:220+r()*(WORLD_H-440)};
}
function makeFish(w,index,r=Math.random){
  const level=stageLevel(w.stage),isGem=index<GEM_FISH_N,t=isGem?FISH.gem:weightedType(level,index-GEM_FISH_N),a=r()*Math.PI*2;
  const predScale=t.role==='predator'?(1.05+r()*0.72)*(1+(level-1)*0.27):(0.88+r()*0.24)*(1+(level-1)*0.04);
  const size=t.size*predScale;
  const speed=t.speed*(0.92+r()*0.18)*(1+(level-1)*0.045),pos=safeFishPos(w,r);
  return{id:`${w.code}-fish-${index}-${w.nextFish++}`,index,type:t.key,role:t.role,points:t.points,color:t.color,size,speed,x:pos.x,y:pos.y,
    vx:Math.cos(a)*speed*.88,vy:Math.sin(a)*speed*.88,angle:a,heading:a,turn:.35+r()*.85,chaseId:null,chaseUntil:0,cooldownUntil:0,
    light:!!t.light,hazard:null,immortal:false,gemFish:!!t.gemFish};
}
function makeLavaHazard(w){
  const pos=safeFishPos(w),a=Math.random()*Math.PI*2,speed=4.65;
  return{id:`${w.code}-lava-hazard`,index:-1,type:'lava',role:'predator',points:0,color:'#7a0f16',size:48,speed,x:pos.x,y:pos.y,
    vx:Math.cos(a)*speed*.8,vy:Math.sin(a)*speed*.8,angle:a,heading:a,turn:.55,chaseId:null,chaseUntil:0,cooldownUntil:0,
    hazard:'lava',immortal:true,light:false,gemFish:false};
}
function makeBoss(w,type){
  const r=rng((w.seed^((w.stage+1)*0x9E3779B1))>>>0),a=r()*Math.PI*2,sizes={shrimp:105,lava:118,jelly:128},speeds={shrimp:3.70,lava:4.35,jelly:3.80};
  return{id:`${w.code}-boss-${w.stage}`,type:'boss',bossType:type,x:1000+r()*(WORLD_W-2000),y:1000+r()*(WORLD_H-2000),
    vx:Math.cos(a)*speeds[type]*.75,vy:Math.sin(a)*speeds[type]*.75,angle:a,heading:a,size:sizes[type],speed:speeds[type],hits:0,
    chasing:false,chaseId:null,chaseUntil:0,cooldownUntil:0,vulnerableUntil:type==='shrimp'?Infinity:0,turn:.55+r()*.8,boss:true};
}
function makeWorld(code,mode){const w={code,mode,seed:(Math.random()*0xffffffff)>>>0,epoch:Date.now(),stage:0,bossCleared:false,tick:0,nextFish:1,players:new Map(),fish:new Map(),respawns:[],boss:null,lavaHazard:null};populateWorld(w);return w;}
const worlds=new Map([['PVP',makeWorld('PVP','ffa')],['PVE',makeWorld('PVE','coop')],['EQUIPO',makeWorld('EQUIPO','teams')]]);

function populateWorld(w){
  w.fish.clear();w.respawns=[];w.nextFish=1;
  if(isBossStage(w.stage))return;
  const r=rng((w.seed^((w.stage+1)*0x85EBCA6B))>>>0);
  for(let i=0;i<FISH_N;i++){const f=makeFish(w,i,r);w.fish.set(f.id,f);}
}
function startBoss(w,type){w.bossCleared=false;w.fish.clear();w.respawns=[];w.boss=makeBoss(w,type);if(w.stage===1&&!w.lavaHazard)w.lavaHazard=makeLavaHazard(w);}
function teamFor(w,want){if(w.mode!=='teams')return null;const a=[...w.players.values()].filter(p=>p.connected&&p.team==='A').length,b=[...w.players.values()].filter(p=>p.connected&&p.team==='B').length;if((want==='A'||want==='B')&&Math.abs(a-b)<=1)return want;return a<=b?'A':'B';}
function pubPlayer(p){return{id:p.id,name:p.name,deviceId:p.deviceId,x:+p.x.toFixed(2),y:+p.y.toFixed(2),vx:+p.vx.toFixed(2),vy:+p.vy.toFixed(2),angle:+p.angle.toFixed(3),score:Math.floor(p.score),growthScore:Math.floor(p.growthScore),radius:+radius(p.growthScore).toFixed(2),level:p.level,lives:p.lives,alive:p.alive,sprinting:p.sprinting,pet:p.pet||'none',team:p.team||null,teamName:p.team==='A'?'Azul':p.team==='B'?'Rojo':null};}
function pubFish(f){return{id:f.id,sharedId:f.id,type:f.type,role:f.role,points:f.points,size:+f.size.toFixed(2),color:f.color,x:+f.x.toFixed(2),y:+f.y.toFixed(2),vx:+f.vx.toFixed(3),vy:+f.vy.toFixed(3),angle:+f.angle.toFixed(3),hazard:f.hazard||null,immortal:!!f.immortal,light:!!f.light,gemFish:!!f.gemFish,renderKey:f.type};}
function pubBoss(b){if(!b)return null;return{id:b.id,type:'boss',boss:true,bossType:b.bossType,x:+b.x.toFixed(2),y:+b.y.toFixed(2),vx:+b.vx.toFixed(3),vy:+b.vy.toFixed(3),angle:+b.angle.toFixed(3),size:b.size,hits:b.hits,chasing:!!b.chasing,vulnerableTail:b.bossType==='shrimp'||Date.now()<b.vulnerableUntil};}
function snapshot(w){const entities=[...w.fish.values()].map(pubFish);if(w.lavaHazard)entities.push(pubFish(w.lavaHazard));return{type:'snapshot',room:w.code,mode:w.mode,population:[...w.players.values()].filter(p=>p.connected).length,serverTick:w.tick,serverTime:Date.now(),worldSeed:w.seed,worldEpoch:w.epoch,worldStage:w.stage,bossCleared:w.bossCleared,boss:pubBoss(w.boss),players:[...w.players.values()].filter(p=>p.connected).map(pubPlayer),entities};}
function broadcast(w){const base=snapshot(w);for(const p of w.players.values())if(p.connected)send(p.ws,{...base,you:pubPlayer(p),player:pubPlayer(p)});}
function broadcastStage(w){sendAll(w,{type:'world_stage',stage:w.stage,bossCleared:w.bossCleared,serverTime:Date.now(),worldSeed:w.seed,worldEpoch:w.epoch,boss:pubBoss(w.boss)});broadcast(w);}
function maybeStartBoss(w){if(w.boss||w.bossCleared)return;const maxScore=Math.max(0,...[...w.players.values()].map(p=>p.score||0));if(w.stage===0&&maxScore>=1000){w.stage=1;startBoss(w,'shrimp');broadcastStage(w);}else if(w.stage===2&&maxScore>=3000){w.stage=3;startBoss(w,'lava');broadcastStage(w);}else if(w.stage===4&&maxScore>=6000){w.stage=5;startBoss(w,'jelly');broadcastStage(w);}}
function canPlayerEat(p,f){return !!f.gemFish||(!f.immortal&&f.role==='prey'&&fishHB(f)<playerHB(p.growthScore)*0.96);}
function canFishEatPlayer(p,f){return f.role==='predator'&&fishHB(f)>=playerHB(p.growthScore)*1.04;}

function updateOneFish(w,f,dt,players){
  const now=Date.now();
  let target=f.chaseId&&f.chaseUntil>now?w.players.get(f.chaseId):null;
  if(target&&(!target.connected||!target.alive||f.role!=='predator'))target=null;
  if(f.role==='predator'&&!target&&f.cooldownUntil<=now){
    let best=null,bd=Infinity;
    const detect=f.hazard==='lava'?150:clamp(92+f.size*.72,105,175);
    for(const p of players){const dd=dist(f,p);if(canFishEatPlayer(p,f)&&dd<detect&&dd<bd){best=p;bd=dd;}}
    if(best){target=best;f.chaseId=best.id;f.chaseUntil=now+1000;}
  }
  if(f.chaseId&&f.chaseUntil<=now){f.chaseId=null;f.cooldownUntil=now+(f.hazard==='lava'?6000:4200);target=null;}
  if(target){const a=Math.atan2(target.y-f.y,target.x-f.x);f.heading=a;f.vx+=(Math.cos(a)*f.speed-f.vx)*.34;f.vy+=(Math.sin(a)*f.speed-f.vy)*.34;}
  else if(f.turn<=0){f.turn=.35+Math.random()*.95;f.heading+=(Math.random()-.5)*1.15;}else f.turn-=dt;
  if(!target){f.vx+=(Math.cos(f.heading)*f.speed*.92-f.vx)*.10;f.vy+=(Math.sin(f.heading)*f.speed*.92-f.vy)*.10;}
  const sp=Math.hypot(f.vx,f.vy)||.001;if(sp>f.speed){f.vx=f.vx/sp*f.speed;f.vy=f.vy/sp*f.speed;}
  f.x+=f.vx*dt*60;f.y+=f.vy*dt*60;
  const m=f.hazard==='lava'?120:80;
  if(f.x<m){f.x=m;f.vx=Math.abs(f.vx);f.heading=Math.atan2(f.vy,f.vx);}if(f.x>WORLD_W-m){f.x=WORLD_W-m;f.vx=-Math.abs(f.vx);f.heading=Math.atan2(f.vy,f.vx);}if(f.y<m){f.y=m;f.vy=Math.abs(f.vy);f.heading=Math.atan2(f.vy,f.vx);}if(f.y>WORLD_H-m){f.y=WORLD_H-m;f.vy=-Math.abs(f.vy);f.heading=Math.atan2(f.vy,f.vx);}f.angle=Math.atan2(f.vy,f.vx);
}
function updateFish(w,dt){const players=[...w.players.values()].filter(p=>p.connected&&p.alive),now=Date.now();for(let i=w.respawns.length-1;i>=0;i--){const rr=w.respawns[i];if(now<rr.at)continue;const f=makeFish(w,rr.index);w.fish.set(f.id,f);w.respawns.splice(i,1);}for(const f of w.fish.values())updateOneFish(w,f,dt,players);if(w.lavaHazard)updateOneFish(w,w.lavaHazard,dt,players);}
function updateBoss(w,dt){
  const b=w.boss;if(!b)return;const now=Date.now(),players=[...w.players.values()].filter(p=>p.connected&&p.alive);
  let target=b.chaseId&&b.chaseUntil>now?w.players.get(b.chaseId):null;if(target&&(!target.connected||!target.alive))target=null;
  const detect=b.bossType==='shrimp'?175:b.bossType==='lava'?195:215;
  if(!target&&b.cooldownUntil<=now){let best=null,bd=Infinity;for(const p of players){const dd=dist(b,p);if(dd<detect&&dd<bd){best=p;bd=dd;}}if(best){target=best;b.chaseId=best.id;b.chaseUntil=now+1000;b.chasing=true;if(b.bossType==='lava')b.vulnerableUntil=0;}}
  if(b.chaseId&&b.chaseUntil<=now){b.chaseId=null;b.chasing=false;b.cooldownUntil=now+(b.bossType==='shrimp'?3800:b.bossType==='lava'?3400:3600);if(b.bossType!=='shrimp')b.vulnerableUntil=now+1100;target=null;}
  if(target){const a=Math.atan2(target.y-b.y,target.x-b.x),mul=b.bossType==='lava'?1.18:b.bossType==='jelly'?1.10:1.08;b.heading=a;b.vx+=(Math.cos(a)*b.speed*mul-b.vx)*.28;b.vy+=(Math.sin(a)*b.speed*mul-b.vy)*.28;}
  else if(b.turn<=0){b.turn=.55+Math.random()*1.0;b.heading+=(Math.random()-.5)*(b.bossType==='jelly'?.65:1.0);}else b.turn-=dt;
  if(!target){const drift=b.bossType==='jelly'?.72:.82;b.vx+=(Math.cos(b.heading)*b.speed*drift-b.vx)*.08;b.vy+=(Math.sin(b.heading)*b.speed*drift-b.vy)*.08;}
  b.x+=b.vx*dt*60;b.y+=b.vy*dt*60;const m=260;if(b.x<m){b.x=m;b.vx=Math.abs(b.vx);}if(b.x>WORLD_W-m){b.x=WORLD_W-m;b.vx=-Math.abs(b.vx);}if(b.y<m){b.y=m;b.vy=Math.abs(b.vy);}if(b.y>WORLD_H-m){b.y=WORLD_H-m;b.vy=-Math.abs(b.vy);}b.angle=Math.atan2(b.vy,b.vx);
}

function petGuard(w,p,reason){
  if(reason!=='fish'&&reason!=='boss')return false;
  const pet=p.pet||'none',now=Date.now();
  const cooldown=pet==='puffer'?30000:pet==='ray'?18000:0;
  if(!cooldown||now<(p.petGuardReadyAt||0))return false;
  p.petGuardReadyAt=now+cooldown;p.lives=Math.max(1,p.lives);p.invulnerableUntil=now+1800;
  sendAll(w,{type:'pet_guard',playerId:p.id,pet,readyAt:p.petGuardReadyAt,serverTime:now});
  broadcast(w);return true;
}
function killPlayer(w,p,reason,eater=null,killerFish=null){
  if(!p.alive)return false;if(petGuard(w,p,reason))return false;
  p.alive=false;p.lives=0;p.vx=0;p.vy=0;
  const victim=pubPlayer(p),eaterPub=eater?pubPlayer(eater):null,killerFishPub=killerFish?(killerFish.boss?pubBoss(killerFish):pubFish(killerFish)):null;
  sendAll(w,{type:'player_death',victimId:p.id,victim,reason,eaterId:eater?.id||null,eater:eaterPub,killerFish:killerFishPub,serverTime:Date.now()});
  if(eater)sendAll(w,{type:'player_eaten',victimId:p.id,victim,eaterId:eater.id,eater:eaterPub,reason,serverTime:Date.now()});
  send(p.ws,{type:'player_dead',id:p.id,reason});broadcast(w);
  setTimeout(()=>{const q=w.players.get(p.id);if(!q)return;const pos=randomSpawn();q.x=pos.x;q.y=pos.y;q.lastX=pos.x;q.lastY=pos.y;q.vx=0;q.vy=0;q.score=Math.max(0,Math.floor(q.score*.5));q.growthScore=Math.max(0,Math.floor(q.growthScore*.5));q.alive=true;q.lives=1;q.invulnerableUntil=Date.now()+1800;q.lastInputAt=Date.now();send(q.ws,{type:'respawn',player:pubPlayer(q)});broadcast(w);},1200);
  return true;
}
function removeFish(w,p,f){
  if(!w.fish.has(f.id)||f.immortal)return false;
  const eaten=pubFish(f);w.fish.delete(f.id);
  p.score+=f.points;p.growthScore+=f.points;
  w.respawns.push({index:f.index,at:Date.now()+FISH_RESPAWN_MS});
  sendAll(w,{type:'entity_removed',entityId:f.id,entity:eaten,by:p.id,eater:pubPlayer(p),serverTick:w.tick,serverTime:Date.now()});
  if(f.gemFish){const amount=p.pet==='ray'?2:1;send(p.ws,{type:'gem_reward',amount,entityId:f.id,serverTime:Date.now()});}
  return true;
}
function tryConsume(w,p,id){
  const f=w.fish.get(String(id||''));if(!f||!p.connected||!p.alive)return false;
  const bonus=p.pet==='crab'?58:p.pet==='ray'?36:0;
  const reach=playerHB(p.growthScore)+fishHB(f)+70+bonus;
  if(dist(p,f)>reach||!canPlayerEat(p,f))return false;
  const ok=removeFish(w,p,f);if(ok){maybeStartBoss(w);broadcast(w);}return ok;
}
function bossTarget(b){const a=b.angle||0;if(b.bossType==='shrimp')return{x:b.x-Math.cos(a)*b.size*1.12,y:b.y-Math.sin(a)*b.size*1.12,r:b.size*.36};if(b.bossType==='lava')return{x:b.x-Math.cos(a)*b.size*.92,y:b.y-Math.sin(a)*b.size*.92,r:b.size*.32};return{x:b.x,y:b.y-b.size*.18,r:b.size*.40};}
function tryBossHit(w,p,bossId){const b=w.boss;if(!b||b.id!==String(bossId||'')||!p.alive||w.bossCleared)return false;const target=bossTarget(b),dd=Math.hypot(p.x-target.x,p.y-target.y),vulnerable=b.bossType==='shrimp'||Date.now()<b.vulnerableUntil||!b.chasing;if(!vulnerable||dd>playerHB(p.growthScore)+target.r+35)return false;const now=Date.now();if(p.lastBossHitAt&&now-p.lastBossHitAt<700)return false;p.lastBossHitAt=now;b.hits=Math.min(BOSS_HITS,b.hits+1);sendAll(w,{type:'boss_state',boss:pubBoss(b),by:p.id,serverTime:now});if(b.hits>=BOSS_HITS){w.bossCleared=true;const type=b.bossType;w.boss=null;sendAll(w,{type:'boss_cleared',stage:w.stage,bossType:type,serverTime:now});broadcast(w);}return true;}
function combat(w){
  const now=Date.now();
  for(const p of w.players.values()){
    if(!p.connected||!p.alive||p.invulnerableUntil>now)continue;
    const ph=playerHB(p.growthScore);
    for(const f of w.fish.values()){
      const fh=fishHB(f),dd=dist(p,f);if(dd>ph+fh)continue;
      if(canPlayerEat(p,f)){removeFish(w,p,f);continue;}
      if(canFishEatPlayer(p,f)&&f.chaseId===p.id&&f.chaseUntil>now){killPlayer(w,p,'fish',null,f);break;}
    }
    if(!p.alive)continue;
    const h=w.lavaHazard;if(h&&dist(p,h)<=ph+fishHB(h)&&h.chaseId===p.id&&h.chaseUntil>now){killPlayer(w,p,'fish',null,h);continue;}
    const b=w.boss;if(b&&b.chasing&&b.chaseId===p.id&&dist(p,b)<=ph+b.size*.65){killPlayer(w,p,'boss',null,b);continue;}
  }
  const ps=[...w.players.values()].filter(p=>p.connected&&p.alive);
  for(let i=0;i<ps.length;i++)for(let j=i+1;j<ps.length;j++){
    const a=ps[i],b=ps[j];if(w.mode==='coop'||(w.mode==='teams'&&a.team===b.team))continue;
    const ar=radius(a.growthScore),br=radius(b.growthScore),dd=dist(a,b);if(dd>ar*.82+br*.82)continue;
    if(a.growthScore>b.growthScore*1.04&&ar>br*1.02){a.score+=Math.max(10,Math.floor(b.score*.25));a.growthScore+=Math.max(10,Math.floor(b.growthScore*.25));killPlayer(w,b,'player',a);}
    else if(b.growthScore>a.growthScore*1.04&&br>ar*1.02){b.score+=Math.max(10,Math.floor(a.score*.25));b.growthScore+=Math.max(10,Math.floor(a.growthScore*.25));killPlayer(w,a,'player',b);}
  }
  maybeStartBoss(w);
}
function applyInput(w,p,m){
  const x=Number(m.x),y=Number(m.y),now=Date.now();if(!Number.isFinite(x)||!Number.isFinite(y)||!p.alive)return;
  if(PET_KEYS.has(String(m.pet||'')))p.pet=String(m.pet);
  const dt=Math.max(.016,Math.min(.35,(now-p.lastInputAt)/1000)),dx=x-p.x,dy=y-p.y,dd=Math.hypot(dx,dy),maxPerSecond=p.sprinting?3400:2100,allowed=Math.max(140,maxPerSecond*dt),ratio=dd>allowed&&dd>0?allowed/dd:1,nx=clamp(p.x+dx*ratio,0,WORLD_W),ny=clamp(p.y+dy*ratio,-100,WORLD_H+120);
  p.vx=(nx-p.x)/Math.max(dt,.001)/60;p.vy=(ny-p.y)/Math.max(dt,.001)/60;p.x=nx;p.y=ny;p.lastX=x;p.lastY=y;p.angle=Number.isFinite(Number(m.angle))?Number(m.angle):Math.atan2(p.vy,p.vx);p.sprinting=!!m.sprinting;p.lastInputAt=now;
  const reportedLevel=clamp(Math.floor(Number(m.level)||p.level),1,4);
  if(w.stage===1&&w.bossCleared&&reportedLevel>=2){w.stage=2;w.bossCleared=false;w.boss=null;w.lavaHazard=null;for(const q of w.players.values()){q.level=2;q.growthScore=0;}populateWorld(w);broadcastStage(w);}
  else if(w.stage===3&&w.bossCleared&&reportedLevel>=3){w.stage=4;w.bossCleared=false;w.boss=null;for(const q of w.players.values())q.level=3;populateWorld(w);broadcastStage(w);}
  else if(w.stage===5&&w.bossCleared&&reportedLevel>=4){w.stage=6;w.bossCleared=false;w.boss=null;for(const q of w.players.values())q.level=4;populateWorld(w);broadcastStage(w);}
}
function devSetMass(w,p,value){const v=clamp(Math.floor(Number(value)||0),0,100000);p.score=v;p.growthScore=v;p.lives=Math.max(1,p.lives);p.alive=true;p.invulnerableUntil=Date.now()+1200;maybeStartBoss(w);broadcast(w);return v;}
function devSetStage(w,stage){
  const s=clamp(Math.floor(Number(stage)||0),0,6);w.stage=s;w.bossCleared=false;w.boss=null;w.lavaHazard=null;
  for(const p of w.players.values()){p.level=stageLevel(s);p.alive=true;p.lives=Math.max(1,p.lives);p.invulnerableUntil=Date.now()+1500;}
  if(s===1)startBoss(w,'shrimp');else if(s===3)startBoss(w,'lava');else if(s===5)startBoss(w,'jelly');else populateWorld(w);
  broadcastStage(w);return s;
}
function makeDeviceId(){return`nany-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;}

export {WORLD_W,WORLD_H,TICK_HZ,SNAP_HZ,MAX_PLAYERS,FISH_N,GEM_FISH_N,HEARTBEAT_MS,RESUME_MS,worlds,worldForMode,randomSpawn,stageLevel,teamFor,pubPlayer,snapshot,broadcast,sendAll,send,updateFish,updateBoss,combat,applyInput,tryConsume,tryBossHit,devSetMass,devSetStage,safeName,makeId,makeDeviceId};
