import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const RUNTIME=path.join(ROOT,'world-runtime.mjs');
const DEATH_FLOW=path.join(ROOT,'death-flow.js');
const SERVER=path.join(ROOT,'server.mjs');
const LOBBY_B64=path.join(ROOT,'lobby-music.b64');
const LOBBY_MP3=path.join(ROOT,'lobby-music.mp3');

function replaceSection(source,startMarker,endMarker,replacement,label){
  const start=source.indexOf(startMarker);
  const end=source.indexOf(endMarker,start+startMarker.length);
  if(start<0||end<0||end<=start)throw new Error(`Gameplay entry: no se pudo localizar ${label}`);
  return source.slice(0,start)+replacement+'\n'+source.slice(end);
}

// Materializa el MP3 desde un asset base64 de texto para que GitHub pueda
// conservarlo aun cuando el conector no permita subir binarios directamente.
try{
  const b64=(await fs.readFile(LOBBY_B64,'utf8')).trim();
  await fs.writeFile(LOBBY_MP3,Buffer.from(b64,'base64'));
}catch(err){
  console.warn('Lobby music asset no disponible:',err?.message||err);
}

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

const oldGrowth='p.score+=f.points;p.growthScore+=f.points;';
const newGrowth="p.score+=f.points;{const gm=p.growthScore<1000?2.00:p.growthScore<3000?1.75:1.50;p.growthScore+=Math.max(1,Math.round(f.points*gm));}";
if(!runtimeSource.includes(oldGrowth))throw new Error('Gameplay entry: no se encontró crecimiento base de removeFish');
runtimeSource=runtimeSource.replace(oldGrowth,newGrowth);

// Presas más alcanzables en multiplayer. Solo se ralentiza alimento normal;
// depredadores, bosses y lava conservan su velocidad y dificultad.
const preySpeedReplacements=[
  ["plankton:{key:'plankton',role:'prey',points:4,color:'#8fffb0',size:4,speed:2.10}","plankton:{key:'plankton',role:'prey',points:4,color:'#8fffb0',size:4,speed:1.72}"],
  ["minnow:{key:'minnow',role:'prey',points:8,color:'#bfe6ff',size:8,speed:2.55}","minnow:{key:'minnow',role:'prey',points:8,color:'#bfe6ff',size:8,speed:2.08}"],
  ["green:{key:'green',role:'prey',points:16,color:'#39ff6a',size:10,speed:2.95}","green:{key:'green',role:'prey',points:16,color:'#39ff6a',size:10,speed:2.48}"],
  ["silver:{key:'silver',role:'prey',points:24,color:'#d9f2ff',size:13,speed:3.20}","silver:{key:'silver',role:'prey',points:24,color:'#d9f2ff',size:13,speed:2.72}"]
];
for(const [from,to] of preySpeedReplacements){
  if(runtimeSource.includes(from))runtimeSource=runtimeSource.replace(from,to);
}

await fs.writeFile(RUNTIME,runtimeSource,'utf8');

let deathSource=await fs.readFile(DEATH_FLOW,'utf8');
const oldFinalHandler="if(m.type==='player_dead'&&String(m.id||'')===String(selfId||'')){const rewards=settleRewards(m);lastDeathRewards=rewards;animateOwnDeath(m);return;}";
const newLifeHandlers=`if(m.type==='life_lost'&&String(m.id||'')===String(selfId||'')){
        const g=getGame(),left=Math.max(0,Number(m.lives)||0);
        if(g){
          g.lives=left;
          if(g.player){
            g.player._takingDamage=false;
            g.player.invuln=Math.max(Number(g.player.invuln)||0,1.5);
            g.player.hurtFlash=Math.max(Number(g.player.hurtFlash)||0,.18);
          }
          g.deathAnim=null;
          g.camShake=Math.max(Number(g.camShake)||0,5);
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

// Inyecta el parche de controles/música en la página servida y expone el MP3.
let serverSource=await fs.readFile(SERVER,'utf8');
if(!serverSource.includes("const DEATH_FLOW_FILE=path.join(ROOT,'death-flow.js');"))throw new Error('Gameplay entry: server.mjs inesperado');
serverSource=serverSource.replace(
  "const DEATH_FLOW_FILE=path.join(ROOT,'death-flow.js');",
  "const DEATH_FLOW_FILE=path.join(ROOT,'death-flow.js');\nconst CLIENT_POLISH_FILE=path.join(ROOT,'client-polish.js');\nconst LOBBY_MUSIC_FILE=path.join(ROOT,'lobby-music.mp3');"
);
serverSource=serverSource.replace(
  "const deathBridge='<script src=\"/death-flow.js?v=14\"></script>';",
  "const deathBridge='<script src=\"/death-flow.js?v=14\"></script>';\nconst polishBridge='<script src=\"/client-polish.js?v=1\"></script>';"
);
const routeNeedle="if(u.pathname==='/death-flow.js'){\n      const js=await fs.readFile(DEATH_FLOW_FILE,'utf8');\n      res.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8','Cache-Control':'no-store'});\n      return res.end(js);\n    }";
if(!serverSource.includes(routeNeedle))throw new Error('Gameplay entry: no se encontró ruta death-flow');
serverSource=serverSource.replace(routeNeedle,routeNeedle+`\n    if(u.pathname==='/client-polish.js'){\n      const js=await fs.readFile(CLIENT_POLISH_FILE,'utf8');\n      res.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8','Cache-Control':'no-store'});\n      return res.end(js);\n    }\n    if(u.pathname==='/lobby-music.mp3'){\n      const audio=await fs.readFile(LOBBY_MUSIC_FILE);\n      res.writeHead(200,{'Content-Type':'audio/mpeg','Cache-Control':'public, max-age=3600','Accept-Ranges':'bytes'});\n      return res.end(audio);\n    }`);
serverSource=serverSource.replace(
  "return res.end(withMobile.replace('</body>',deathBridge+'</body>'));",
  "const withDeath=withMobile.replace('</body>',deathBridge+'</body>');\n      return res.end(withDeath.replace('</body>',polishBridge+'</body>'));"
);
await fs.writeFile(SERVER,serverSource,'utf8');

console.log('NANY GAMEPLAY PATCH OK: lives + fast growth + easier prey + joystick recovery + sprint gating + lobby music');

await import(pathToFileURL(path.join(ROOT,'server-density-entry.mjs')).href+`?gameplay=${Date.now()}`);
