import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const RUNTIME=path.join(ROOT,'world-runtime.mjs');
const DEATH_FLOW=path.join(ROOT,'death-flow.js');

function replaceSection(source,startMarker,endMarker,replacement,label){
  const start=source.indexOf(startMarker);
  const end=source.indexOf(endMarker,start+startMarker.length);
  if(start<0||end<0||end<=start)throw new Error(`Gameplay entry: no se pudo localizar ${label}`);
  return source.slice(0,start)+replacement+'\n'+source.slice(end);
}

/* -------------------------------------------------------------------------
   VIDAS EXTRA = CONTINUIDAD, NO RESPAWN
   ------------------------------------------------------------------------- */
let runtimeSource=await fs.readFile(RUNTIME,'utf8');

const continuousLives=`function killPlayer(w,p,reason,eater=null,killerFish=null){
  if(!p.alive)return false;
  const now=Date.now();
  const remaining=Math.max(0,(Number(p.lives)||1)-1);
  const finalDeath=remaining<=0;
  const eaterPub=eater?pubPlayer(eater):null;
  const killerFishPub=killerFish?(killerFish.boss?pubBoss(killerFish):pubFish(killerFish)):null;

  p.lives=remaining;
  p.lastDeathReason=reason;
  p.lastDeathBossType=killerFish?.boss?killerFish.bossType:null;
  p.lastDeathAt=now;

  if(!finalDeath){
    p.alive=true;
    p.invulnerableUntil=now+1500;
    p.lastInputAt=now;
    const victim=pubPlayer(p);
    send(p.ws,{type:'life_lost',id:p.id,victim,reason,finalDeath:false,lives:remaining,maxLives:p.maxLives||1,killerFish:killerFishPub,eater:eaterPub,worldStage:w.stage,bossCleared:w.bossCleared,boss:pubBoss(w.boss),serverTime:now});
    broadcast(w);
    return true;
  }

  p.alive=false;
  p.vx=0;
  p.vy=0;
  const victim=pubPlayer(p);
  sendAllExcept(w,p.id,{type:'remote_player_death',victimId:p.id,victim,reason,eaterId:eater?.id||null,eater:eaterPub,killerFish:killerFishPub,finalDeath:true,lives:0,maxLives:p.maxLives||1,worldStage:w.stage,bossCleared:w.bossCleared,boss:pubBoss(w.boss),serverTime:now});
  send(p.ws,{type:'player_dead',id:p.id,victim,reason,finalDeath:true,lives:0,maxLives:p.maxLives||1,killerFish:killerFishPub,eater:eaterPub,worldStage:w.stage,bossCleared:w.bossCleared,boss:pubBoss(w.boss),serverTime:now});
  broadcast(w);
  return true;
}`;

runtimeSource=replaceSection(
  runtimeSource,
  'function killPlayer(w,p,reason,eater=null,killerFish=null){',
  'function removeFish(w,p,f){',
  continuousLives,
  'killPlayer'
);

/* -------------------------------------------------------------------------
   CURVA DE CRECIMIENTO MÁS RÁPIDA Y DIVERTIDA
   -------------------------------------------------------------------------
   Score/leaderboard conserva los puntos originales. Solo growthScore recibe:
   - x2.00 mientras eres pequeño (<1000)
   - x1.75 en crecimiento medio (<3000)
   - x1.50 después
   Esto acelera la cadena alimenticia al principio sin volver trivial el late game.
   ------------------------------------------------------------------------- */
const oldGrowth='p.score+=f.points;p.growthScore+=f.points;';
const newGrowth="p.score+=f.points;{const gm=p.growthScore<1000?2.00:p.growthScore<3000?1.75:1.50;p.growthScore+=Math.max(1,Math.round(f.points*gm));}";
if(!runtimeSource.includes(oldGrowth))throw new Error('Gameplay entry: no se encontró crecimiento base de removeFish');
runtimeSource=runtimeSource.replace(oldGrowth,newGrowth);

await fs.writeFile(RUNTIME,runtimeSource,'utf8');

/* -------------------------------------------------------------------------
   CLIENTE: VIDA -1 SIN ANIMACIÓN DE MUERTE
   ------------------------------------------------------------------------- */
let deathSource=await fs.readFile(DEATH_FLOW,'utf8');
const oldFinalHandler="if(m.type==='player_dead'&&String(m.id||'')===String(selfId||'')){const rewards=settleRewards(m);lastDeathRewards=rewards;animateOwnDeath(m);return;}";
const newLifeHandlers=`if(m.type==='life_lost'&&String(m.id||'')===String(selfId||'')){
        const g=getGame(),left=Math.max(0,Number(m.lives)||0);
        if(g){
          g.lives=left;
          if(g.player)g.player._takingDamage=false;
          g.deathAnim=null;
          g.camShake=Math.max(Number(g.camShake)||0,5);
          try{g.invulnUntil=Math.max(Number(g.invulnUntil)||0,(Number(g.time)||0)+1.5);}catch{}
          getFn('updateHUD')?.();
          getFn('spawnFloater')?.(g.player?.x||0,(g.player?.y||0)-42,\`VIDA -1 · QUEDAN \${left}\`,'#ffd23f');
          try{window.eval('typeof AudioSys!=="undefined"?AudioSys:null')?.hurt?.()}catch{}
        }
        return;
      }
      if(m.type==='player_dead'&&String(m.id||'')===String(selfId||'')){const rewards=settleRewards(m);lastDeathRewards=rewards;animateOwnDeath(m);return;}`;
if(!deathSource.includes(oldFinalHandler))throw new Error('Gameplay entry: no se encontró handler player_dead en death-flow.js');
deathSource=deathSource.replace(oldFinalHandler,newLifeHandlers);
await fs.writeFile(DEATH_FLOW,deathSource,'utf8');

console.log('NANY GAMEPLAY PATCH OK: continuous extra lives + fast growth curve 2x/1.75x/1.5x');

await import(pathToFileURL(path.join(ROOT,'server-density-entry.mjs')).href+`?gameplay=${Date.now()}`);
