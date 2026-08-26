(()=>{
  const Native=window.WebSocket,BUF='__NANY_LIVE_BUF__',DEVICE='__NANY_DEVICE__';
  const PENDING=new Set(),REMOTE_DEATHS=[];
  let socketRef=null,bossHitAt=0;
  const clampN=(v,a,b)=>Math.max(a,Math.min(b,v));
  const mix=(a,b,t)=>a+(b-a)*t;
  const device=()=>{let d=localStorage.getItem(DEVICE);if(!d){d=`nany-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;localStorage.setItem(DEVICE,d)}return d};
  window.__NANY_DEVICE_ID__=device();
  const getGame=()=>{try{return window.eval('typeof game!=="undefined"?game:null')}catch{return null}};
  const getSave=()=>{try{return window.eval('typeof Save!=="undefined"?Save:null')}catch{return null}};
  const getFn=name=>{try{return window.eval(`typeof ${name}==="function"?${name}:null`)}catch{return null}};
  const latest=()=>{const b=window[BUF]||[];return b.length?b[b.length-1].m:null};
  const myId=()=>latest()?.you?.id||latest()?.player?.id||null;
  const currentPet=()=>{const s=getSave();return s?.ownedPets?.[s.pet]?s.pet:'none'};
  const sendDirect=obj=>{if(socketRef?.readyState===1)try{socketRef.send(JSON.stringify(obj))}catch{}};

  function localDeath(){
    try{const g=getGame(),fn=getFn('showDeathBite');if(!g?.player||g.player._takingDamage)return;g.player._takingDamage=true;fn?.(true,()=>{});g.camShake=10;window.eval('typeof AudioSys!=="undefined"?AudioSys:null')?.hurt?.()}catch{}
  }
  function burst(x,y,color,n=10){try{getFn('spawnParticles')?.(Number(x)||0,Number(y)||0,color||'#dff7f5',n)}catch{}}
  function remoteDeath(victim){
    if(!victim)return;REMOTE_DEATHS.push({x:victim.x,y:victim.y,size:victim.radius||18,start:performance.now(),color:'#4dfff0'});while(REMOTE_DEATHS.length>30)REMOTE_DEATHS.shift();
  }
  function syncStage(m){
    const g=getGame();if(!g||!m)return;const stage=Number(m.worldStage??m.stage)||0;
    if(stage===0){g.level=0;g.mapId=1;g.bossActive=false;g.bossType=null;}
    else if(stage===1){g.level=0;g.mapId=1;g.bossActive=!!m.boss;g.bossType=m.boss?'shrimp':null;}
    else if(stage===2){g.level=1;g.mapId=2;g.bossActive=false;g.bossType=null;}
    else if(stage===3){g.level=1;g.mapId=2;g.bossActive=!!m.boss;g.bossType=m.boss?'lava':null;}
    else if(stage===4){g.level=2;g.mapId=3;g.bossActive=false;g.bossType=null;if(!g.bossDefeated)g.bossDefeated={};}
    else if(stage===5){g.level=2;g.mapId=3;g.bossActive=!!m.boss;g.bossType=m.boss?'jelly':null;if(!g.bossDefeated)g.bossDefeated={};}
    else {g.level=3;g.mapId=4;g.bossActive=false;g.bossType=null;if(!g.bossDefeated)g.bossDefeated={};}
  }
  function onServerEvent(m){
    if(m.type==='entity_removed'){
      if(m.entityId)PENDING.add(String(m.entityId));
      if(m.entity){burst(m.entity.x,m.entity.y,m.entity.color||'#dff7f5',m.entity.gemFish?15:10);if(m.by===myId())window.eval('typeof AudioSys!=="undefined"?AudioSys:null')?.eat?.(m.entity.size||8);}
    }
    if(m.type==='player_eaten'&&m.victim){burst(m.victim.x,m.victim.y,'#ff6a4d',16);}
    if(m.type==='player_death'&&m.victim){remoteDeath(m.victim);if(String(m.victimId||m.victim.id)===String(myId()||''))localDeath();}
    if(m.type==='pet_guard'){
      const p=(latest()?.players||[]).find(x=>x.id===m.playerId);if(p){burst(p.x,p.y,m.pet==='ray'?'#a084ff':'#ffd23f',18);if(m.playerId===myId())getFn('spawnFloater')?.(p.x,p.y-34,'¡TU MASCOTA TE PROTEGIÓ!','#57ff63');}
    }
    if(m.type==='gem_reward'){
      const s=getSave(),g=getGame(),amount=Math.max(1,Math.floor(Number(m.amount)||1));if(s){s.gems=(s.gems||0)+amount;getFn('queueSave')?.();if(g?.player)getFn('spawnFloater')?.(g.player.x,g.player.y-38,`+${amount} GEMA${amount>1?'S':''}`,'#57ff63');window.eval('typeof AudioSys!=="undefined"?AudioSys:null')?.coin?.();}
    }
    if(m.type==='boss_cleared'){
      const g=getGame();if(g){g.bossActive=false;g.bossType=null;g.entities=(g.entities||[]).filter(e=>!e.boss);if(!g.bossDefeated)g.bossDefeated={};if(m.stage===1)g.bossDefeated[0]=true;else if(m.stage===3)g.bossDefeated[1]=true;else if(m.stage===5)g.bossDefeated[2]=true;getFn('spawnFloater')?.(g.player?.x||0,(g.player?.y||0)-70,'¡JEFE DERROTADO! NADA HACIA ABAJO','#57ff63');}
    }
    if(m.type==='dev_ack'){
      const el=document.getElementById('devMassStatus')||document.getElementById('devStatus');if(el){el.textContent=m.message|| (m.ok?'✓ Listo':'Error');el.style.color=m.ok?'var(--bio-cyan)':'var(--danger)';}
    }
    if(m.type==='world_stage')setTimeout(()=>syncStage(m),0);
  }

  function WrappedWS(url,protocols){
    let real=null,stopped=false,retry=0,join=null,lastState=null,api;const ev={open:new Set(),message:new Set(),close:new Set(),error:new Set()};
    const emit=(t,e)=>{for(const f of ev[t]||[])try{f.call(api,e)}catch{}const h=api['on'+t];if(typeof h==='function')try{h.call(api,e)}catch{}};
    api={};Object.setPrototypeOf(api,Native.prototype);Object.defineProperty(api,'readyState',{get:()=>stopped?3:(real?.readyState??0)});Object.defineProperty(api,'url',{value:url});api.addEventListener=(t,f)=>ev[t]?.add(f);api.removeEventListener=(t,f)=>ev[t]?.delete(f);
    api.send=data=>{let out=data;try{const m=JSON.parse(data);if(m.type==='join'){join={...m,deviceId:device(),resumeId:localStorage.getItem('__NANY_RESUME_ID__')||null};localStorage.setItem('__NANY_JOIN__',JSON.stringify(join));out=JSON.stringify(join)}else if(m.type==='state'){lastState={...m,pet:currentPet()};out=JSON.stringify(lastState)}else if(m.type==='consume'&&m.entityId)PENDING.add(String(m.entityId))}catch{}if(real?.readyState===1)real.send(out)};
    api.close=()=>{stopped=true;try{real?.close()}catch{}emit('close',new Event('close'))};
    function connect(){if(stopped)return;real=protocols===undefined?new Native(url):new Native(url,protocols);socketRef=real;
      real.addEventListener('open',()=>{retry=0;let j=join;try{j=j||JSON.parse(localStorage.getItem('__NANY_JOIN__')||'null')}catch{}if(j)real.send(JSON.stringify(j));if(lastState)real.send(JSON.stringify(lastState));if(getSave()?.devMode)real.send(JSON.stringify({type:'dev_command',action:'auth',code:'7339'}));emit('open',new Event('open'))});
      real.addEventListener('message',e=>{let m=null;try{m=JSON.parse(e.data);onServerEvent(m);if(m.type==='welcome')localStorage.setItem('__NANY_RESUME_ID__',m.resumeId||m.id||'');if(m.type==='consume_rejected'&&m.entityId)PENDING.delete(String(m.entityId));if(m.type==='snapshot'||m.type==='welcome'){const b=window[BUF]||(window[BUF]=[]);b.push({recv:performance.now(),tick:Number(m.serverTick)||0,m});while(b.length>30)b.shift();const ids=new Set((m.entities||[]).map(f=>String(f.id)));for(const id of [...PENDING])if(!ids.has(id))PENDING.delete(id);syncStage(m);window.__SERVER_SYNC_FISH__?.();}}catch{}emit('message',e);if(m)setTimeout(()=>{syncStage(m);if(m.type==='snapshot'||m.type==='welcome'||m.type==='world_stage')window.__SERVER_SYNC_FISH__?.()},0)});
      real.addEventListener('close',e=>{if(stopped){emit('close',e);return}setTimeout(connect,Math.min(4000,250*Math.pow(1.45,retry++)))});real.addEventListener('error',e=>{if(stopped)emit('error',e)});
    }
    connect();return api;
  }
  for(const k of ['CONNECTING','OPEN','CLOSING','CLOSED'])WrappedWS[k]=Native[k];WrappedWS.prototype=Native.prototype;window.WebSocket=WrappedWS;window.__SERVER_AUTHORITATIVE_FISH__=true;

  window.__SERVER_SYNC_FISH__=function(){
    try{
      const g=getGame(),b=window[BUF]||[];if(!g||!b.length)return;
      const renderAt=performance.now()-45;let B=b[b.length-1],A=B;for(let i=b.length-1;i>=0;i--){if(b[i].recv<=renderAt){A=b[i];break}}
      const bm=B.m,am=A.m,span=Math.max(1,B.recv-A.recv),alpha=A===B?1:clampN((renderAt-A.recv)/span,0,1),old=new Map((am.entities||[]).map(f=>[f.id,f])),out=[];
      const stage=Number(bm.worldStage)||0,level=stage<=1?1:stage<=3?2:stage<=5?3:4;
      for(const fb of bm.entities||[]){
        if(PENDING.has(String(fb.id)))continue;if(fb.type==='lantern'&&level<2)continue;
        const fa=old.get(fb.id)||fb,sp=Math.max(.1,Math.hypot(Number(fb.vx)||0,Number(fb.vy)||0));
        out.push({sharedId:fb.id,serverId:fb.id,type:fb.type,family:fb.type,variant:fb.role==='predator'?'big':'small',renderKey:fb.renderKey||fb.type,role:fb.role,ecologyRole:fb.role,size:fb.size,baseSize:fb.size,points:fb.points,color:fb.color,behavior:fb.role==='predator'?'aggro':'drift',hazard:fb.hazard||null,immortal:!!fb.immortal,light:!!fb.light,gemFish:!!fb.gemFish,speed:sp,x:mix(fa.x,fb.x,alpha),y:mix(fa.y,fb.y,alpha),vx:fb.vx,vy:fb.vy,angle:fb.angle,wobble:performance.now()/650+(fb.angle||0),finPhase:performance.now()/145,life:0,coin:false,_chasing:false,_chaseTime:0,_attackCooldown:0});
      }
      if(bm.boss){const bb=bm.boss,ba=am.boss&&am.boss.id===bb.id?am.boss:bb;out.push({sharedId:bb.id,serverId:bb.id,type:'boss',boss:true,bossType:bb.bossType,x:mix(ba.x,bb.x,alpha),y:mix(ba.y,bb.y,alpha),vx:bb.vx,vy:bb.vy,angle:bb.angle,size:bb.size,baseSize:bb.size,color:bb.bossType==='shrimp'?'#ff7b35':bb.bossType==='lava'?'#7a0f16':'#8fdcff',speed:Math.hypot(bb.vx,bb.vy),life:0,_chasing:!!bb.chasing,_vulnerableTail:!!bb.vulnerableTail,bossHits:bb.hits||0,hazard:null,ecologyRole:'predator'});g.bossHits=bb.hits||0;}
      g.entities=out;const me=bm.you||bm.player||am.you||am.player;if(me){g.score=Number(me.score)||0;g.growthScore=Number(me.growthScore)||0;g.lives=Number(me.lives)||0;}
    }catch{}
  };

  function drawRemoteDeaths(){
    try{const ctx=window.eval('typeof ctx!=="undefined"?ctx:null'),cam=window.eval('typeof camera!=="undefined"?camera:null'),zoom=getFn('getViewZoom')?.()||1,W=window.eval('typeof W!=="undefined"?W:innerWidth'),H=window.eval('typeof H!=="undefined"?H:innerHeight');if(!ctx||!cam)return;ctx.save();ctx.translate(W/2,H/2);ctx.scale(zoom,zoom);ctx.translate(-(cam.x+W/(2*zoom)),-(cam.y+H/(2*zoom)));const now=performance.now();for(let i=REMOTE_DEATHS.length-1;i>=0;i--){const f=REMOTE_DEATHS[i],t=(now-f.start)/950;if(t>=1){REMOTE_DEATHS.splice(i,1);continue}const s=Math.max(12,f.size),fade=1-t;ctx.save();ctx.translate(f.x,f.y);ctx.globalAlpha=fade;for(let k=0;k<5;k++){const a=k/5*Math.PI*2+t*2.5,rr=s*(.15+t*1.7);ctx.fillStyle=k===0?'#ff6a4d':k===1?'#dff7f5':'#4dfff0';ctx.beginPath();ctx.ellipse(Math.cos(a)*rr,Math.sin(a)*rr,s*(k<2?.42:.25),s*(k<2?.18:.12),a,0,Math.PI*2);ctx.fill()}ctx.restore()}ctx.restore()}catch{}
  }
  function drawGuide(target,label,color){
    try{const g=getGame(),ctx=window.eval('typeof ctx!=="undefined"?ctx:null'),cam=window.eval('typeof camera!=="undefined"?camera:null'),zoom=getFn('getViewZoom')?.()||1,W=window.eval('typeof W!=="undefined"?W:innerWidth'),H=window.eval('typeof H!=="undefined"?H:innerHeight');if(!g?.player||!ctx||!cam||!target)return;const tx=(target.x-cam.x)*zoom,ty=(target.y-cam.y)*zoom;if(tx>35&&tx<W-35&&ty>35&&ty<H-35)return;const cx=clampN((g.player.x-cam.x)*zoom,0,W),cy=clampN((g.player.y-cam.y)*zoom,0,H),dx=tx-cx,dy=ty-cy,d=Math.hypot(dx,dy)||1,ux=dx/d,uy=dy/d,margin=48;let scale=1e9;if(Math.abs(ux)>.001)scale=Math.min(scale,ux>0?(W-margin-cx)/ux:(margin-cx)/ux);if(Math.abs(uy)>.001)scale=Math.min(scale,uy>0?(H-margin-cy)/uy:(margin-cy)/uy);const x=cx+ux*Math.max(0,scale),y=cy+uy*Math.max(0,scale),a=Math.atan2(uy,ux);ctx.save();ctx.translate(x,y);ctx.rotate(a);ctx.fillStyle=color;ctx.shadowColor=color;ctx.shadowBlur=10;ctx.beginPath();ctx.moveTo(16,0);ctx.lineTo(-10,-8);ctx.lineTo(-6,0);ctx.lineTo(-10,8);ctx.closePath();ctx.fill();ctx.rotate(-a);ctx.font='700 9px Space Mono, monospace';ctx.textAlign='center';ctx.fillStyle='#fff';ctx.fillText(label,0,20);ctx.restore()}catch{}
  }
  function drawPetGuidance(){
    const pet=currentPet(),m=latest();if(!m||(pet!=='turtle'&&pet!=='ray'))return;
    const me=m.you||m.player;if(!me)return;const entities=m.entities||[];
    let gem=null,gd=Infinity,pred=null,pd=Infinity;
    for(const e of entities){const dd=Math.hypot(e.x-me.x,e.y-me.y);if(e.gemFish&&dd<gd){gd=dd;gem=e}if(pet==='ray'&&e.role==='predator'&&!e.hazard&&dd<pd){pd=dd;pred=e}}
    if(gem)drawGuide(gem,'GEMA','#57ff63');if(pet==='ray'&&pred)drawGuide(pred,'PELIGRO','#ff6a4d');
  }

  function installPetDescriptions(){
    try{window.eval(`PETS.turtle.description='Radar de gemas: cuando existe un Pez Gema, una flecha te guía hasta él.';PETS.crab.description='Pinzas recolectoras: aumenta mucho tu alcance para atrapar presas y gemas.';PETS.puffer.description='Escudo globo: bloquea una muerte por depredador cada 30 segundos.';PETS.dolphin.description='Corriente rápida: +20% velocidad de nado y mejor movilidad para escapar o cazar.';PETS.ray.description='Visión abisal: marca gemas y peligros, da 2 gemas por Pez Gema y bloquea una muerte cada 18 s.';`);getFn('renderPetShop')?.()}catch{}
  }
  function mpPetUpdate(dt){
    try{const g=getGame(),s=getSave(),pet=g?.petEntity,p=g?.player;if(!pet||!p||!s)return;const W=window.eval('typeof W!=="undefined"?W:innerWidth'),H=window.eval('typeof H!=="undefined"?H:innerHeight'),cam=window.eval('typeof camera!=="undefined"?camera:null');const size=Math.max(8,window.eval('playerRadius(growthScore())'));pet.size=mix(pet.size||size,size,.08);pet.hitbox=pet.size*.72;const visibleR=Math.max(70,Math.min(W,H)*.22);pet.orbitR=mix(pet.orbitR||visibleR,visibleR,.035);pet.orbitAngle=(pet.orbitAngle||0)+dt*(.48+(pet.seed||0)*.18);let tx=p.x+Math.cos(pet.orbitAngle)*pet.orbitR,ty=p.y+Math.sin(pet.orbitAngle)*pet.orbitR*.78;if(cam){const margin=Math.max(28,pet.size*1.5);tx=clampN(tx,cam.x+margin,cam.x+W-margin);ty=clampN(ty,cam.y+margin,cam.y+H-margin)}const dx=tx-pet.x,dy=ty-pet.y,d=Math.hypot(dx,dy)||1,swim=Math.max(1.8,window.eval('playerSpeed()')*1.03);pet.vx=mix(pet.vx||0,dx/d*swim,.08);pet.vy=mix(pet.vy||0,dy/d*swim,.08);pet.x+=pet.vx;pet.y+=pet.vy;pet.x=clampN(pet.x,30,11970);pet.y=clampN(pet.y,30,11970);if(Math.hypot(pet.vx,pet.vy)>.05)pet.angle=Math.atan2(pet.vy,pet.vx)}catch{}
  }

  function devSend(action,extra={}){sendDirect({type:'dev_command',action,code:'7339',...extra})}
  function installDevTools(){
    try{
      const save=getSave();
      if(!window.__NANY_DEV_FN_PATCHED__&&getFn('activateDev')){
        const orig=getFn('activateDev');window.__NANY_DEV_ACTIVATE__=function(){orig();setTimeout(()=>{if(getSave()?.devMode)devSend('auth')},0)};window.eval('activateDev=window.__NANY_DEV_ACTIVATE__');
        const mass=getFn('devSetMass');if(mass){window.__NANY_DEV_MASS__=function(){const s=getSave();if(!s?.devMode)return mass();const input=document.getElementById('devMassInput'),v=Math.floor(Number(input?.value));if(!Number.isFinite(v)||v<0){const st=document.getElementById('devMassStatus');if(st)st.textContent='Escribe una masa válida.';return}devSend('mass',{value:v})};window.eval('devSetMass=window.__NANY_DEV_MASS__')}
        window.__NANY_DEV_FN_PATCHED__=true;
      }
      const host=document.querySelector('#devScreen .dev-modal')||document.getElementById('devScreen');if(!host||document.getElementById('nanyServerDevTools'))return;
      const box=document.createElement('div');box.id='nanyServerDevTools';box.style.cssText='margin-top:12px;padding:10px;border:1px solid rgba(77,255,240,.18);border-radius:10px;display:flex;flex-wrap:wrap;gap:7px;';
      const title=document.createElement('div');title.textContent='PRUEBAS DE SERVIDOR';title.style.cssText='width:100%;font:700 10px Space Mono;color:#7fa8ac;letter-spacing:.08em';box.appendChild(title);
      const actions=[['Nivel 1',0],['Jefe Camarón',1],['Nivel 2',2],['Jefe Lava',3],['Nivel 3',4],['Stage 5 · Medusa',5],['Nivel 4',6]];
      for(const [label,stage] of actions){const b=document.createElement('button');b.type='button';b.className='dev-btn';b.textContent=label;b.onclick=()=>{if(!getSave()?.devMode)return;devSend('stage',{stage})};box.appendChild(b)}
      const exit=document.createElement('button');exit.type='button';exit.className='dev-btn';exit.textContent='Salir modo desarrollador';exit.onclick=()=>{const s=getSave();devSend('exit');if(s){if(s.devBackup){s.coins=s.devBackup.coins;s.gems=s.devBackup.gems}s.devMode=false;getFn('saveGame')?.();getFn('updateHUD')?.();getFn('updateShopCoins')?.()}};box.appendChild(exit);host.appendChild(box);
      if(save?.devMode)devSend('auth');
    }catch{}
  }

  const patch=setInterval(()=>{
    try{
      const sw=window.eval('typeof SharedWorld!=="undefined"?SharedWorld:null'),mp=window.eval('typeof Multiplayer!=="undefined"?Multiplayer:null');
      if(sw&&!sw.__serverPatched){sw.__serverPatched=true;sw.update=function(){window.__SERVER_SYNC_FISH__?.()};}
      if(!window.__NANY_COLLISION_PATCHED__&&mp&&getFn('handleCollisions')){
        window.__NANY_ORIGINAL_COLLISIONS__=getFn('handleCollisions');window.__NANY_MP_COLLISIONS__=function(){try{if(!mp.isConnected())return window.__NANY_ORIGINAL_COLLISIONS__();const g=getGame();if(!g?.player)return;const p=g.player,ph=window.eval('playerHitbox()'),pet=currentPet(),bonus=pet==='crab'?58:pet==='ray'?36:0,fhFn=getFn('fishHitbox');for(const e of g.entities||[]){const dd=Math.hypot(e.x-p.x,e.y-p.y);if(e.boss){const a=e.angle||Math.atan2(e.vy||0,e.vx||0)||0;let tx=e.x,ty=e.y,tr=e.size*.40;if(e.bossType==='shrimp'){tx=e.x-Math.cos(a)*e.size*1.12;ty=e.y-Math.sin(a)*e.size*1.12;tr=e.size*.36}else if(e.bossType==='lava'){tx=e.x-Math.cos(a)*e.size*.92;ty=e.y-Math.sin(a)*e.size*.92;tr=e.size*.32}const td=Math.hypot(tx-p.x,ty-p.y),vulnerable=e.bossType==='shrimp'||e._vulnerableTail||!e._chasing;if(vulnerable&&td<ph+tr+28&&performance.now()-bossHitAt>760){bossHitAt=performance.now();sendDirect({type:'boss_hit',bossId:e.serverId||e.sharedId})}continue}if(!e.sharedId||PENDING.has(String(e.sharedId))||e.immortal||e.hazard)continue;const fh=fhFn?.(e)||Math.max(2.5,e.size*.88),edible=e.gemFish||(e.ecologyRole==='prey'&&fh<ph*.96);if(edible&&dd<=ph+fh+bonus){PENDING.add(String(e.sharedId));mp.consumeEntity(e.sharedId,e.points||1)}}}catch{}};window.eval('handleCollisions=window.__NANY_MP_COLLISIONS__');window.__NANY_COLLISION_PATCHED__=true;
      }
      if(!window.__NANY_PET_UPDATE_PATCHED__&&mp&&getFn('updatePet')){window.__NANY_ORIGINAL_UPDATE_PET__=getFn('updatePet');window.__NANY_UPDATE_PET__=function(dt){if(!mp.isConnected())return window.__NANY_ORIGINAL_UPDATE_PET__(dt);return mpPetUpdate(dt)};window.eval('updatePet=window.__NANY_UPDATE_PET__');window.__NANY_PET_UPDATE_PATCHED__=true;}
      if(!window.__NANY_MINIMAP_PATCHED__&&getFn('renderMinimap')){window.__NANY_ORIGINAL_MINIMAP__=getFn('renderMinimap');window.__NANY_MINIMAP__=function(){window.__NANY_ORIGINAL_MINIMAP__();try{const m=latest(),mini=window.eval('typeof minimap!=="undefined"?minimap:null'),mc=window.eval('typeof miniCtx!=="undefined"?miniCtx:null');if(!m||!mini||!mc)return;const sx=mini.width/12000,sy=mini.height/12000,my=m.you?.id||m.player?.id;mc.save();for(const p of m.players||[]){if(!p||p.id===my||p.alive===false)continue;mc.globalAlpha=1;mc.fillStyle='#ffffff';mc.shadowColor='#ffffff';mc.shadowBlur=5;mc.beginPath();mc.arc(p.x*sx,p.y*sy,2.8,0,Math.PI*2);mc.fill()}mc.restore()}catch{}};window.eval('renderMinimap=window.__NANY_MINIMAP__');window.__NANY_MINIMAP_PATCHED__=true;}
      if(!window.__NANY_BG_PATCHED__&&getFn('drawBackground')){window.__NANY_ORIGINAL_BG__=getFn('drawBackground');window.__NANY_BG__=function(){window.__NANY_ORIGINAL_BG__();try{const g=getGame(),ctx=window.eval('typeof ctx!=="undefined"?ctx:null'),W=window.eval('typeof W!=="undefined"?W:innerWidth'),H=window.eval('typeof H!=="undefined"?H:innerHeight');if(!g||!ctx)return;const level=Math.max(0,Number(g.level)||0),dark=[0,.08,.17,.26][Math.min(3,level)]||.26;ctx.save();if(dark>0){ctx.fillStyle=`rgba(0,4,12,${dark})`;ctx.fillRect(0,0,W,H)}const t=g.time||performance.now()/1000;ctx.globalCompositeOperation='screen';ctx.globalAlpha=level===0?.12:.08;for(let i=0;i<7;i++){const x=((i*257+t*18*(i%2?1:-1))%(W+300))-150,y=((i*113+t*9)%(H+160))-80,r=40+(i%3)*24;const grd=ctx.createRadialGradient(x,y,0,x,y,r);grd.addColorStop(0,level>=2?'rgba(80,130,180,.16)':'rgba(77,255,240,.18)');grd.addColorStop(1,'rgba(0,0,0,0)');ctx.fillStyle=grd;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill()}ctx.globalAlpha=.18;for(let i=0;i<18;i++){const x=(i*173+t*(8+i%4))%(W+40)-20,y=(i*97+Math.sin(t*.5+i)*42+H)%H;ctx.fillStyle=i%3?'#4dfff0':'#a084ff';ctx.beginPath();ctx.arc(x,y,1+(i%2),0,Math.PI*2);ctx.fill()}ctx.restore()}catch{}};window.eval('drawBackground=window.__NANY_BG__');window.__NANY_BG_PATCHED__=true;}
      if(!window.__NANY_FISH_GLOW_PATCHED__&&getFn('drawFishBody')){window.__NANY_ORIGINAL_FISH_BODY__=getFn('drawFishBody');window.__NANY_FISH_BODY__=function(e,o){window.__NANY_ORIGINAL_FISH_BODY__(e,o);if((e?.type==='lantern'||e?.renderKey==='lantern')&&e.light){try{const ctx=window.eval('typeof ctx!=="undefined"?ctx:null');if(!ctx)return;const a=e.angle||Math.atan2(e.vy,e.vx)||0,s=e.size||20,lx=e.x+Math.cos(a)*s*1.05,ly=e.y+Math.sin(a)*s*1.05;ctx.save();ctx.globalCompositeOperation='screen';const g=ctx.createRadialGradient(lx,ly,1,lx,ly,s*2.2);g.addColorStop(0,'rgba(190,245,255,.95)');g.addColorStop(.2,'rgba(80,210,255,.55)');g.addColorStop(1,'rgba(80,210,255,0)');ctx.fillStyle=g;ctx.beginPath();ctx.arc(lx,ly,s*2.2,0,Math.PI*2);ctx.fill();ctx.fillStyle='#efffff';ctx.shadowColor='#72dfff';ctx.shadowBlur=14;ctx.beginPath();ctx.arc(lx,ly,Math.max(2.5,s*.12),0,Math.PI*2);ctx.fill();ctx.restore()}catch{}}};window.eval('drawFishBody=window.__NANY_FISH_BODY__');window.__NANY_FISH_GLOW_PATCHED__=true;}
      if(!window.__NANY_BOSS_PATCHED__&&getFn('drawBoss')){window.__NANY_ORIGINAL_BOSS__=getFn('drawBoss');window.__NANY_BOSS__=function(e){if(e?.bossType!=='jelly')return window.__NANY_ORIGINAL_BOSS__(e);try{const ctx=window.eval('typeof ctx!=="undefined"?ctx:null');if(!ctx)return;const s=e.size||120,t=(getGame()?.time||0);ctx.save();ctx.translate(e.x,e.y);ctx.globalCompositeOperation='screen';ctx.shadowColor='#7ddcff';ctx.shadowBlur=24;const grd=ctx.createRadialGradient(0,-s*.18,s*.08,0,0,s*.95);grd.addColorStop(0,'rgba(220,250,255,.9)');grd.addColorStop(.45,'rgba(110,180,255,.58)');grd.addColorStop(1,'rgba(70,70,180,.15)');ctx.fillStyle=grd;ctx.beginPath();ctx.ellipse(0,-s*.12,s*.72,s*.50,0,Math.PI,Math.PI*2);ctx.lineTo(s*.72,0);ctx.quadraticCurveTo(0,s*.30,-s*.72,0);ctx.closePath();ctx.fill();ctx.lineWidth=6;ctx.lineCap='round';for(let i=-3;i<=3;i++){ctx.strokeStyle=i%2?'rgba(170,110,255,.72)':'rgba(110,220,255,.72)';ctx.beginPath();ctx.moveTo(i*s*.16,s*.08);for(let y=0;y<4;y++){const yy=s*.22+y*s*.22,xx=i*s*.16+Math.sin(t*2+y+i)*s*.08;ctx.quadraticCurveTo(xx+s*.06,yy-s*.08,xx,yy)}ctx.stroke()}ctx.fillStyle='#fff';ctx.font=`700 ${Math.max(14,s*.16)}px Space Mono`;ctx.textAlign='center';ctx.fillText(`JEFE MEDUSA · ${e.bossHits||0}/5`,0,-s*.72);ctx.restore()}catch{}};window.eval('drawBoss=window.__NANY_BOSS__');window.__NANY_BOSS_PATCHED__=true;}
      if(!window.__NANY_RENDER_PATCHED__&&getFn('render')){window.__NANY_ORIGINAL_RENDER__=getFn('render');window.__NANY_RENDER__=function(){window.__NANY_ORIGINAL_RENDER__();drawRemoteDeaths();drawPetGuidance()};window.eval('render=window.__NANY_RENDER__');window.__NANY_RENDER_PATCHED__=true;}
      if(!window.__NANY_L4_PATCHED__&&getFn('updatePlayer')){window.__NANY_ORIGINAL_UPDATE_PLAYER__=getFn('updatePlayer');window.__NANY_UPDATE_PLAYER__=function(dt){window.__NANY_ORIGINAL_UPDATE_PLAYER__(dt);try{const g=getGame(),p=g?.player;if(!g||!p||!mp?.isConnected?.())return;if(g.level===2&&g.bossDefeated?.[2]&&p.y>=12000-window.eval('playerRadius(growthScore())')-2&&p.vy>0){g.__l4Down=(g.__l4Down||0)+dt;if(g.__l4Down>.18){g.level=3;g.mapId=4;g.bossActive=false;g.bossType=null;p.y=window.eval('playerRadius(growthScore())')+28;p.vx=0;p.vy=0;g.__l4Down=0;getFn('spawnFloater')?.(p.x,p.y+60,'NIVEL 4 — ZONA HADAL','#a084ff')}}else g.__l4Down=0}catch{}};window.eval('updatePlayer=window.__NANY_UPDATE_PLAYER__');window.__NANY_L4_PATCHED__=true;}
      installPetDescriptions();installDevTools();
      if(sw?.__serverPatched&&window.__NANY_COLLISION_PATCHED__&&window.__NANY_PET_UPDATE_PATCHED__&&window.__NANY_MINIMAP_PATCHED__&&window.__NANY_BG_PATCHED__&&window.__NANY_FISH_GLOW_PATCHED__&&window.__NANY_BOSS_PATCHED__&&window.__NANY_RENDER_PATCHED__&&window.__NANY_L4_PATCHED__&&window.__NANY_DEV_FN_PATCHED__&&document.getElementById('nanyServerDevTools'))clearInterval(patch);
    }catch{}
  },60);
})();
