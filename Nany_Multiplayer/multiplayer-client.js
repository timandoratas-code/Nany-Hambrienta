(()=>{
  const Native=window.WebSocket,BUF='__NANY_LIVE_BUF__',DEVICE='__NANY_DEVICE__';
  const PENDING=new Set(),FX=[],DEAD=new Map();let socketRef=null,lastStage=-1,bossHitAt=0;
  const device=()=>{let d=localStorage.getItem(DEVICE);if(!d){d=`nany-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;localStorage.setItem(DEVICE,d)}return d};
  window.__NANY_DEVICE_ID__=device();
  const latest=()=>{const b=window[BUF]||[];return b.length?b[b.length-1].m:null};
  const addFx=fx=>{FX.push({...fx,start:performance.now()});while(FX.length>50)FX.shift()};
  const getGame=()=>{try{return window.eval('typeof game!=="undefined"?game:null')}catch{return null}};
  const getFn=name=>{try{return window.eval(`typeof ${name}==="function"?${name}:null`)}catch{return null}};
  function localDeath(reason){
    try{const g=getGame(),fn=getFn('showDeathBite');if(!g?.player||g.player._takingDamage)return;g.player._takingDamage=true;fn?.(true,()=>{});g.camShake=10;const audio=window.eval('typeof AudioSys!=="undefined"?AudioSys:null');audio?.hurt?.();getFn('spawnFloater')?.(g.player.x,g.player.y-28,reason==='player'?'¡TE COMIÓ OTRO JUGADOR!':'¡TE COMIÓ UN DEPREDADOR!','#ff7d6b')}catch{}
  }
  function syncStage(m){
    const g=getGame();if(!g||!m)return;const stage=Number(m.worldStage??m.stage)||0;lastStage=stage;
    if(stage===0){g.level=0;g.mapId=1;g.bossActive=false;g.bossType=null;}
    else if(stage===1){g.level=0;g.mapId=1;g.bossActive=!!m.boss;g.bossType=m.boss?'shrimp':null;}
    else if(stage===2){g.level=1;g.mapId=2;g.bossActive=false;g.bossType=null;}
    else if(stage===3){g.level=1;g.mapId=2;g.bossActive=!!m.boss;g.bossType=m.boss?'lava':null;}
    else if(stage===4){g.level=2;g.mapId=3;g.bossActive=false;g.bossType=null;if(!g.bossDefeated)g.bossDefeated={};}
    else if(stage===5){g.level=2;g.mapId=3;g.bossActive=!!m.boss;g.bossType=m.boss?'jelly':null;if(!g.bossDefeated)g.bossDefeated={};}
    else {g.level=3;g.mapId=4;g.bossActive=false;g.bossType=null;if(!g.bossDefeated)g.bossDefeated={};}
  }
  function onServerEvent(m){
    if(m.type==='entity_removed'){if(m.entityId)PENDING.add(String(m.entityId));if(m.eater&&m.entity)addFx({kind:'eatFish',x:m.eater.x,y:m.eater.y,tx:m.entity.x,ty:m.entity.y,duration:440});}
    if(m.type==='player_eaten'&&m.eater&&m.victim)addFx({kind:'eatPlayer',x:m.eater.x,y:m.eater.y,tx:m.victim.x,ty:m.victim.y,size:m.eater.radius||18,duration:650});
    if(m.type==='player_death'&&m.victim){const key=String(m.victimId||m.victim.id),now=performance.now();if(!DEAD.has(key)||now-DEAD.get(key)>500){DEAD.set(key,now);addFx({kind:'death',x:m.victim.x,y:m.victim.y,size:m.victim.radius||18,duration:950})}const myId=latest()?.you?.id||latest()?.player?.id;if(myId&&String(myId)===key&&m.reason!=='player')localDeath(m.reason);}
    if(m.type==='boss_cleared'){
      const g=getGame();if(g){g.bossActive=false;g.bossType=null;g.entities=(g.entities||[]).filter(e=>!e.boss);if(!g.bossDefeated)g.bossDefeated={};if(m.stage===1)g.bossDefeated[0]=true;else if(m.stage===3)g.bossDefeated[1]=true;else if(m.stage===5)g.bossDefeated[2]=true;getFn('spawnFloater')?.(g.player?.x||0,(g.player?.y||0)-70,'¡JEFE DERROTADO! NADA HACIA ABAJO','#57ff63');}
    }
    if(m.type==='world_stage')setTimeout(()=>syncStage(m),0);
  }
  function WrappedWS(url,protocols){
    let real=null,stopped=false,retry=0,join=null,lastState=null,api;const ev={open:new Set(),message:new Set(),close:new Set(),error:new Set()};
    const emit=(t,e)=>{for(const f of ev[t]||[])try{f.call(api,e)}catch{}const h=api['on'+t];if(typeof h==='function')try{h.call(api,e)}catch{}};
    api={};Object.setPrototypeOf(api,Native.prototype);Object.defineProperty(api,'readyState',{get:()=>stopped?3:(real?.readyState??0)});Object.defineProperty(api,'url',{value:url});api.addEventListener=(t,f)=>ev[t]?.add(f);api.removeEventListener=(t,f)=>ev[t]?.delete(f);
    api.send=data=>{let out=data;try{const m=JSON.parse(data);if(m.type==='join'){join={...m,deviceId:device(),resumeId:localStorage.getItem('__NANY_RESUME_ID__')||null};localStorage.setItem('__NANY_JOIN__',JSON.stringify(join));out=JSON.stringify(join)}if(m.type==='state')lastState=m;if(m.type==='consume'&&m.entityId)PENDING.add(String(m.entityId))}catch{}if(real?.readyState===1)real.send(out)};
    api.close=()=>{stopped=true;try{real?.close()}catch{}emit('close',new Event('close'))};
    function connect(){if(stopped)return;real=protocols===undefined?new Native(url):new Native(url,protocols);socketRef=real;
      real.addEventListener('open',()=>{retry=0;let j=join;try{j=j||JSON.parse(localStorage.getItem('__NANY_JOIN__')||'null')}catch{}if(j)real.send(JSON.stringify(j));if(lastState)real.send(JSON.stringify(lastState));emit('open',new Event('open'))});
      real.addEventListener('message',e=>{let m=null;try{m=JSON.parse(e.data);onServerEvent(m);if(m.type==='welcome')localStorage.setItem('__NANY_RESUME_ID__',m.resumeId||m.id||'');if(m.type==='consume_rejected'&&m.entityId)PENDING.delete(String(m.entityId));if(m.type==='snapshot'||m.type==='welcome'){const b=window[BUF]||(window[BUF]=[]);b.push({recv:performance.now(),tick:Number(m.serverTick)||0,m});while(b.length>28)b.shift();const ids=new Set((m.entities||[]).map(f=>String(f.id)));for(const id of [...PENDING])if(!ids.has(id))PENDING.delete(id);syncStage(m);window.__SERVER_SYNC_FISH__?.();}}catch{}emit('message',e);if(m)setTimeout(()=>{syncStage(m);if(m.type==='snapshot'||m.type==='welcome'||m.type==='world_stage')window.__SERVER_SYNC_FISH__?.()},0)});
      real.addEventListener('close',e=>{if(stopped){emit('close',e);return}setTimeout(connect,Math.min(4000,250*Math.pow(1.45,retry++)))});real.addEventListener('error',e=>{if(stopped)emit('error',e)});
    }
    connect();return api;
  }
  for(const k of ['CONNECTING','OPEN','CLOSING','CLOSED'])WrappedWS[k]=Native[k];WrappedWS.prototype=Native.prototype;window.WebSocket=WrappedWS;window.__SERVER_AUTHORITATIVE_FISH__=true;

  window.__SERVER_SYNC_FISH__=function(){
    try{const g=getGame(),b=window[BUF]||[];if(!g||!b.length)return;const renderAt=performance.now()-75;let B=b[b.length-1],A=B;for(let i=b.length-1;i>=0;i--){if(b[i].recv<=renderAt){A=b[i];break}}const bm=B.m,am=A.m,span=Math.max(1,B.recv-A.recv),alpha=A===B?1:Math.max(0,Math.min(1,(renderAt-A.recv)/span));const old=new Map((am.entities||[]).map(f=>[f.id,f])),out=[];
      for(const fb of bm.entities||[]){if(PENDING.has(String(fb.id)))continue;const fa=old.get(fb.id)||fb,sp=Math.max(.1,Math.hypot(Number(fb.vx)||0,Number(fb.vy)||0));out.push({sharedId:fb.id,serverId:fb.id,type:fb.type,family:fb.type,variant:fb.role==='predator'?'big':'small',renderKey:fb.renderKey||fb.type,role:fb.role,ecologyRole:fb.role,size:fb.size,baseSize:fb.size,points:fb.points,color:fb.color,behavior:fb.role==='predator'?'aggro':'drift',hazard:fb.hazard||null,immortal:!!fb.immortal,light:!!fb.light,speed:sp,x:fa.x+(fb.x-fa.x)*alpha,y:fa.y+(fb.y-fa.y)*alpha,vx:fb.vx,vy:fb.vy,angle:fb.angle,wobble:performance.now()/700+(fb.angle||0),finPhase:performance.now()/170,life:0,coin:false,_chasing:false,_chaseTime:0,_attackCooldown:0});}
      if(bm.boss){const bb=bm.boss,ba=am.boss&&am.boss.id===bb.id?am.boss:bb;out.push({sharedId:bb.id,serverId:bb.id,type:'boss',boss:true,bossType:bb.bossType,x:ba.x+(bb.x-ba.x)*alpha,y:ba.y+(bb.y-ba.y)*alpha,vx:bb.vx,vy:bb.vy,angle:bb.angle,size:bb.size,baseSize:bb.size,color:bb.bossType==='shrimp'?'#ff7b35':bb.bossType==='lava'?'#7a0f16':'#8fdcff',speed:Math.hypot(bb.vx,bb.vy),life:0,_chasing:!!bb.chasing,_vulnerableTail:!!bb.vulnerableTail,bossHits:bb.hits||0,hazard:null,ecologyRole:'predator'});g.bossHits=bb.hits||0;}
      g.entities=out;const me=bm.you||bm.player||am.you||am.player;if(me){g.score=Number(me.score)||0;g.growthScore=Number(me.growthScore)||0;g.lives=Number(me.lives)||0;}
    }catch{}
  };

  function drawFx(){
    try{const ctx=window.eval('typeof ctx!=="undefined"?ctx:null'),cam=window.eval('typeof camera!=="undefined"?camera:null'),zoom=getFn('getViewZoom')?.()||1,W=window.eval('typeof W!=="undefined"?W:innerWidth'),H=window.eval('typeof H!=="undefined"?H:innerHeight');if(!ctx||!cam)return;ctx.save();ctx.translate(W/2,H/2);ctx.scale(zoom,zoom);ctx.translate(-(cam.x+W/(2*zoom)),-(cam.y+H/(2*zoom)));const now=performance.now();for(let i=FX.length-1;i>=0;i--){const f=FX[i],t=(now-f.start)/(f.duration||800);if(t>=1){FX.splice(i,1);continue}const fade=1-t;if(f.kind==='death'){const s=Math.max(12,Number(f.size)||18);ctx.save();ctx.translate(f.x,f.y);ctx.globalAlpha=fade;for(let k=0;k<5;k++){const a=k/5*Math.PI*2+t*2,rr=s*(.2+t*1.9);ctx.fillStyle=k%2?'#ff6a4d':'#dff7f5';ctx.beginPath();ctx.ellipse(Math.cos(a)*rr,Math.sin(a)*rr,s*.42,s*.16,a,0,Math.PI*2);ctx.fill()}ctx.restore();}else{const x=f.x+(f.tx-f.x)*Math.min(1,t*1.5),y=f.y+(f.ty-f.y)*Math.min(1,t*1.5),r=(f.size||18)*(1+Math.sin(t*Math.PI)*.35);ctx.save();ctx.globalAlpha=fade*.8;ctx.strokeStyle=f.kind==='eatPlayer'?'#ff6a4d':'#ffd23f';ctx.lineWidth=4/zoom;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.stroke();ctx.restore();}}ctx.restore();
    }catch{}
  }

  const patch=setInterval(()=>{
    try{
      const sw=window.eval('typeof SharedWorld!=="undefined"?SharedWorld:null'),mp=window.eval('typeof Multiplayer!=="undefined"?Multiplayer:null'),g=getGame();
      if(sw&&!sw.__serverPatched){sw.__serverPatched=true;sw.update=function(){window.__SERVER_SYNC_FISH__?.()};}
      if(!window.__NANY_COLLISION_PATCHED__&&mp&&getFn('handleCollisions')){
        window.__NANY_ORIGINAL_COLLISIONS__=getFn('handleCollisions');
        window.__NANY_MP_COLLISIONS__=function(){
          try{if(!mp.isConnected())return window.__NANY_ORIGINAL_COLLISIONS__();const gg=getGame();if(!gg?.player)return;const p=gg.player,ph=window.eval('playerHitbox()');for(const e of gg.entities||[]){const dd=Math.hypot(e.x-p.x,e.y-p.y);if(e.boss){const a=e.angle||Math.atan2(e.vy||0,e.vx||0)||0;let tx=e.x,ty=e.y,tr=e.size*.40;if(e.bossType==='shrimp'){tx=e.x-Math.cos(a)*e.size*1.12;ty=e.y-Math.sin(a)*e.size*1.12;tr=e.size*.36}else if(e.bossType==='lava'){tx=e.x-Math.cos(a)*e.size*.92;ty=e.y-Math.sin(a)*e.size*.92;tr=e.size*.32}const td=Math.hypot(tx-p.x,ty-p.y),vulnerable=e.bossType==='shrimp'||e._vulnerableTail||!e._chasing;if(vulnerable&&td<ph+tr+28&&performance.now()-bossHitAt>760&&socketRef?.readyState===1){bossHitAt=performance.now();socketRef.send(JSON.stringify({type:'boss_hit',bossId:e.serverId||e.sharedId}))}continue;}if(!e.sharedId||PENDING.has(String(e.sharedId))||e.immortal||e.hazard)continue;const fh=window.eval('fishHitbox')(e);if(dd<=ph+fh&&e.ecologyRole==='prey'&&fh<ph*.96){PENDING.add(String(e.sharedId));mp.consumeEntity(e.sharedId,e.points||1);}}
          }catch{}
        };window.eval('handleCollisions=window.__NANY_MP_COLLISIONS__');window.__NANY_COLLISION_PATCHED__=true;
      }
      if(!window.__NANY_MINIMAP_PATCHED__&&getFn('renderMinimap')){
        window.__NANY_ORIGINAL_MINIMAP__=getFn('renderMinimap');window.__NANY_MINIMAP__=function(){window.__NANY_ORIGINAL_MINIMAP__();try{const m=latest(),gg=getGame(),mini=window.eval('typeof minimap!=="undefined"?minimap:null'),mc=window.eval('typeof miniCtx!=="undefined"?miniCtx:null');if(!m||!gg?.player||!mini||!mc)return;const sx=mini.width/12000,sy=mini.height/12000,my=m.you?.id||m.player?.id;mc.save();for(const p of m.players||[]){if(!p||p.id===my||p.alive===false)continue;mc.globalAlpha=1;mc.fillStyle='#ffffff';mc.shadowColor='#ffffff';mc.shadowBlur=5;mc.beginPath();mc.arc(p.x*sx,p.y*sy,2.8,0,Math.PI*2);mc.fill()}mc.restore()}catch{}};window.eval('renderMinimap=window.__NANY_MINIMAP__');window.__NANY_MINIMAP_PATCHED__=true;
      }
      if(!window.__NANY_BG_PATCHED__&&getFn('drawBackground')){
        window.__NANY_ORIGINAL_BG__=getFn('drawBackground');window.__NANY_BG__=function(){window.__NANY_ORIGINAL_BG__();try{const gg=getGame(),ctx=window.eval('typeof ctx!=="undefined"?ctx:null'),W=window.eval('typeof W!=="undefined"?W:innerWidth'),H=window.eval('typeof H!=="undefined"?H:innerHeight');if(!gg||!ctx)return;const level=Math.max(0,Number(gg.level)||0),dark=[0,.08,.17,.26][Math.min(3,level)]||.26;ctx.save();if(dark>0){ctx.fillStyle=`rgba(0,4,12,${dark})`;ctx.fillRect(0,0,W,H)}const t=gg.time||performance.now()/1000;ctx.globalCompositeOperation='screen';ctx.globalAlpha=level===0?.12:.08;for(let i=0;i<7;i++){const x=((i*257+t*18*(i%2?1:-1))%(W+300))-150,y=((i*113+t*9)%(H+160))-80,r=40+(i%3)*24;const grd=ctx.createRadialGradient(x,y,0,x,y,r);grd.addColorStop(0,level>=2?'rgba(80,130,180,.16)':'rgba(77,255,240,.18)');grd.addColorStop(1,'rgba(0,0,0,0)');ctx.fillStyle=grd;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill()}ctx.globalAlpha=.18;for(let i=0;i<18;i++){const x=(i*173+t*(8+i%4))%(W+40)-20,y=(i*97+Math.sin(t*.5+i)*42+H)%(H);ctx.fillStyle=i%3?'#4dfff0':'#a084ff';ctx.beginPath();ctx.arc(x,y,1+(i%2),0,Math.PI*2);ctx.fill()}ctx.restore()}catch{}};window.eval('drawBackground=window.__NANY_BG__');window.__NANY_BG_PATCHED__=true;
      }
      if(!window.__NANY_FISH_GLOW_PATCHED__&&getFn('drawFishBody')){
        window.__NANY_ORIGINAL_FISH_BODY__=getFn('drawFishBody');window.__NANY_FISH_BODY__=function(e,o){window.__NANY_ORIGINAL_FISH_BODY__(e,o);if((e?.type==='lantern'||e?.renderKey==='lantern')&&e.light){try{const ctx=window.eval('typeof ctx!=="undefined"?ctx:null');if(!ctx)return;const a=e.angle||Math.atan2(e.vy,e.vx)||0,s=e.size||20,lx=e.x+Math.cos(a)*s*1.05,ly=e.y+Math.sin(a)*s*1.05;ctx.save();ctx.globalCompositeOperation='screen';const g=ctx.createRadialGradient(lx,ly,1,lx,ly,s*2.2);g.addColorStop(0,'rgba(190,245,255,.95)');g.addColorStop(.2,'rgba(80,210,255,.55)');g.addColorStop(1,'rgba(80,210,255,0)');ctx.fillStyle=g;ctx.beginPath();ctx.arc(lx,ly,s*2.2,0,Math.PI*2);ctx.fill();ctx.fillStyle='#efffff';ctx.shadowColor='#72dfff';ctx.shadowBlur=14;ctx.beginPath();ctx.arc(lx,ly,Math.max(2.5,s*.12),0,Math.PI*2);ctx.fill();ctx.restore()}catch{}}};window.eval('drawFishBody=window.__NANY_FISH_BODY__');window.__NANY_FISH_GLOW_PATCHED__=true;
      }
      if(!window.__NANY_BOSS_PATCHED__&&getFn('drawBoss')){
        window.__NANY_ORIGINAL_BOSS__=getFn('drawBoss');window.__NANY_BOSS__=function(e){if(e?.bossType!=='jelly')return window.__NANY_ORIGINAL_BOSS__(e);try{const ctx=window.eval('typeof ctx!=="undefined"?ctx:null');if(!ctx)return;const s=e.size||120,t=(getGame()?.time||0);ctx.save();ctx.translate(e.x,e.y);ctx.globalCompositeOperation='screen';ctx.shadowColor='#7ddcff';ctx.shadowBlur=24;const grd=ctx.createRadialGradient(0,-s*.18,s*.08,0,0,s*.95);grd.addColorStop(0,'rgba(220,250,255,.9)');grd.addColorStop(.45,'rgba(110,180,255,.58)');grd.addColorStop(1,'rgba(70,70,180,.15)');ctx.fillStyle=grd;ctx.beginPath();ctx.ellipse(0,-s*.12,s*.72,s*.50,0,Math.PI,Math.PI*2);ctx.lineTo(s*.72,0);ctx.quadraticCurveTo(0,s*.30,-s*.72,0);ctx.closePath();ctx.fill();ctx.lineWidth=6;ctx.lineCap='round';for(let i=-3;i<=3;i++){ctx.strokeStyle=i%2?'rgba(170,110,255,.72)':'rgba(110,220,255,.72)';ctx.beginPath();ctx.moveTo(i*s*.16,s*.08);for(let y=0;y<4;y++){const yy=s*.22+y*s*.22,xx=i*s*.16+Math.sin(t*2+y+i)*s*.08;ctx.quadraticCurveTo(xx+s*.06,yy-s*.08,xx,yy)}ctx.stroke()}ctx.fillStyle='#fff';ctx.font=`700 ${Math.max(14,s*.16)}px Space Mono`;ctx.textAlign='center';ctx.fillText(`JEFE MEDUSA · ${e.bossHits||0}/5`,0,-s*.72);ctx.restore()}catch{}};window.eval('drawBoss=window.__NANY_BOSS__');window.__NANY_BOSS_PATCHED__=true;
      }
      if(!window.__NANY_RENDER_FX_PATCHED__&&getFn('render')){window.__NANY_ORIGINAL_RENDER__=getFn('render');window.__NANY_RENDER__=function(){window.__NANY_ORIGINAL_RENDER__();drawFx()};window.eval('render=window.__NANY_RENDER__');window.__NANY_RENDER_FX_PATCHED__=true;}
      if(!window.__NANY_L4_PATCHED__&&getFn('updatePlayer')){
        window.__NANY_ORIGINAL_UPDATE_PLAYER__=getFn('updatePlayer');window.__NANY_UPDATE_PLAYER__=function(dt){window.__NANY_ORIGINAL_UPDATE_PLAYER__(dt);try{const gg=getGame(),p=gg?.player;if(!gg||!p||!mp?.isConnected?.())return;if(gg.level===2&&gg.bossDefeated?.[2]&&p.y>=12000-window.eval('playerRadius(growthScore())')-2&&p.vy>0){gg.__l4Down=(gg.__l4Down||0)+dt;if(gg.__l4Down>.18){gg.level=3;gg.mapId=4;gg.bossActive=false;gg.bossType=null;p.y=window.eval('playerRadius(growthScore())')+28;p.vx=0;p.vy=0;gg.__l4Down=0;getFn('spawnFloater')?.(p.x,p.y+60,'NIVEL 4 — ZONA HADAL','#a084ff')}}else if(gg)gg.__l4Down=0}catch{}};window.eval('updatePlayer=window.__NANY_UPDATE_PLAYER__');window.__NANY_L4_PATCHED__=true;
      }
      if(sw?.__serverPatched&&window.__NANY_COLLISION_PATCHED__&&window.__NANY_MINIMAP_PATCHED__&&window.__NANY_BG_PATCHED__&&window.__NANY_FISH_GLOW_PATCHED__&&window.__NANY_BOSS_PATCHED__&&window.__NANY_RENDER_FX_PATCHED__&&window.__NANY_L4_PATCHED__)clearInterval(patch);
    }catch{}
  },50);
})();
