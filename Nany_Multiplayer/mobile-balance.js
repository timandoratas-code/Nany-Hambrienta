(()=>{
  'use strict';

  /* Multiplayer render polish for all devices. */
  const BUF='__NANY_LIVE_BUF__';
  const RENDER_DELAY_MS=70;
  const MAX_EXTRAP_MS=75;
  const NET_PENDING=new Set();
  const ENTITY_CACHE=new Map();
  const SNAP_MAPS=new WeakMap();
  const KILL_FX=[];
  let smoothFrame=0;

  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const mix=(a,b,t)=>a+(b-a)*t;
  const mixAngle=(a,b,t)=>{a=Number(a)||0;b=Number(b)||0;let d=(b-a)%(Math.PI*2);if(d>Math.PI)d-=Math.PI*2;if(d<-Math.PI)d+=Math.PI*2;return a+d*t;};
  const getGame=()=>{try{return window.eval('typeof game!=="undefined"?game:null')}catch{return null}};
  const getFn=name=>{try{return window.eval(`typeof ${name}==="function"?${name}:null`)}catch{return null}};

  function mapFor(snapshot){
    if(!snapshot)return new Map();
    let m=SNAP_MAPS.get(snapshot);
    if(!m){m=new Map((snapshot.entities||[]).map(e=>[String(e.id),e]));SNAP_MAPS.set(snapshot,m);}
    return m;
  }
  function sample(buf,renderAt){
    if(buf.length<=1){const x=buf[0];return[x,x,1,0];}
    if(renderAt<=buf[0].recv)return[buf[0],buf[0],1,0];
    for(let i=1;i<buf.length;i++){
      if(buf[i].recv>=renderAt){
        const A=buf[i-1],B=buf[i],span=Math.max(1,B.recv-A.recv);
        return[A,B,clamp((renderAt-A.recv)/span,0,1),0];
      }
    }
    const B=buf[buf.length-1];
    return[B,B,1,clamp(renderAt-B.recv,0,MAX_EXTRAP_MS)];
  }
  function extrap(v,ms){return (Number(v)||0)*(ms/1000)*60;}

  function updateFishObject(e,fa,fb,alpha,extraMs){
    const x=mix(Number(fa.x)||0,Number(fb.x)||0,alpha)+extrap(fb.vx,extraMs);
    const y=mix(Number(fa.y)||0,Number(fb.y)||0,alpha)+extrap(fb.vy,extraMs);
    const vx=mix(Number(fa.vx)||0,Number(fb.vx)||0,alpha),vy=mix(Number(fa.vy)||0,Number(fb.vy)||0,alpha);
    e.sharedId=fb.id;e.serverId=fb.id;e.type=fb.type;e.family=fb.type;
    e.variant=fb.role==='predator'?'big':'small';e.renderKey=fb.renderKey||fb.type;
    e.role=fb.role;e.ecologyRole=fb.role;e.size=fb.size;e.baseSize=fb.size;e.points=fb.points;e.color=fb.color;
    e.behavior=fb.role==='predator'?'aggro':'drift';e.hazard=fb.hazard||null;e.immortal=!!fb.immortal;e.light=!!fb.light;e.gemFish=!!fb.gemFish;
    e.x=x;e.y=y;e.vx=vx;e.vy=vy;e.angle=mixAngle(fa.angle,fb.angle,alpha);e.speed=Math.max(.1,Math.hypot(vx,vy));
    e.wobble=performance.now()/650+(e.angle||0);e.finPhase=performance.now()/145;e.life=0;e.coin=false;
    e._chasing=!!fb.chasing;e._chaseTime=Math.max(0,Number(fb.chaseRemainingMs)||0)/1000;e._attackCooldown=0;e.__seen=smoothFrame;
  }

  function installSmoothSync(){
    if(window.__NANY_SMOOTH_SYNC_INSTALLED__||typeof window.__SERVER_SYNC_FISH__!=='function')return false;
    window.__NANY_SMOOTH_SYNC_INSTALLED__=true;
    window.__SERVER_SYNC_FISH__=function smoothServerFish(){
      try{
        const g=getGame(),buf=window[BUF]||[];
        if(!g||!buf.length)return;
        smoothFrame++;
        const [A,B,alpha,extraMs]=sample(buf,performance.now()-RENDER_DELAY_MS),am=A.m,bm=B.m;
        const old=mapFor(am),stage=Number(bm.worldStage)||0,level=stage<=1?1:stage<=3?2:stage<=5?3:4;
        const out=g.entities||(g.entities=[]);out.length=0;
        for(const fb of bm.entities||[]){
          const id=String(fb.id);
          if(NET_PENDING.has(id))continue;
          if(fb.type==='lantern'&&level<2)continue;
          const fa=old.get(id)||fb;
          let e=ENTITY_CACHE.get(id);
          if(!e){e={};ENTITY_CACHE.set(id,e);}
          updateFishObject(e,fa,fb,alpha,extraMs);
          out.push(e);
        }
        if(bm.boss){
          const bb=bm.boss,ba=am.boss&&am.boss.id===bb.id?am.boss:bb,id=String(bb.id);
          let e=ENTITY_CACHE.get(id);if(!e){e={};ENTITY_CACHE.set(id,e);}
          const x=mix(Number(ba.x)||0,Number(bb.x)||0,alpha)+extrap(bb.vx,extraMs),y=mix(Number(ba.y)||0,Number(bb.y)||0,alpha)+extrap(bb.vy,extraMs);
          const vx=mix(Number(ba.vx)||0,Number(bb.vx)||0,alpha),vy=mix(Number(ba.vy)||0,Number(bb.vy)||0,alpha);
          e.sharedId=bb.id;e.serverId=bb.id;e.type='boss';e.boss=true;e.bossType=bb.bossType;e.x=x;e.y=y;e.vx=vx;e.vy=vy;
          e.angle=mixAngle(ba.angle,bb.angle,alpha);e.size=bb.size;e.baseSize=bb.size;e.color=bb.bossType==='shrimp'?'#ff7b35':bb.bossType==='lava'?'#7a0f16':'#8fdcff';
          e.speed=Math.hypot(vx,vy);e.life=0;e._chasing=!!bb.chasing;e._chaseTime=Math.max(0,Number(bb.chaseRemainingMs)||0)/1000;e._vulnerableTail=!!bb.vulnerableTail;e.bossHits=bb.hits||0;e.hazard=null;e.ecologyRole='predator';e.__seen=smoothFrame;
          out.push(e);g.bossHits=bb.hits||0;
        }
        const me=bm.you||bm.player||am.you||am.player;
        if(me){g.score=Number(me.score)||0;g.growthScore=Number(me.growthScore)||0;g.lives=Number(me.lives)||0;}
        if((smoothFrame%180)===0)for(const [id,e] of ENTITY_CACHE)if((e.__seen||0)<smoothFrame-120)ENTITY_CACHE.delete(id);
      }catch{}
    };
    return true;
  }

  const CurrentWS=window.WebSocket;
  if(CurrentWS&&!window.__NANY_DEATH_CAUSE_SOCKET__){
    function ObservedWS(url,protocols){
      const ws=protocols===undefined?new CurrentWS(url):new CurrentWS(url,protocols);
      const nativeSend=ws.send.bind(ws);
      ws.send=data=>{
        try{const m=JSON.parse(data);if(m.type==='consume'&&m.entityId)NET_PENDING.add(String(m.entityId));}catch{}
        return nativeSend(data);
      };
      ws.addEventListener('message',ev=>{
        let m;try{m=JSON.parse(ev.data)}catch{return}
        if(m.type==='consume_rejected'&&m.entityId)NET_PENDING.delete(String(m.entityId));
        if(m.type==='entity_removed'&&m.entityId)NET_PENDING.add(String(m.entityId));
        if(m.type==='snapshot'||m.type==='welcome'){
          const ids=new Set((m.entities||[]).map(e=>String(e.id)));
          for(const id of [...NET_PENDING])if(!ids.has(id))NET_PENDING.delete(id);
        }
        if(m.type==='player_death'&&m.victim&&m.killerFish){
          const k=m.killerFish,v=m.victim;
          KILL_FX.push({victim:{x:Number(v.x)||0,y:Number(v.y)||0,size:Number(v.radius)||18},killer:{...k},start:performance.now()});
          while(KILL_FX.length>12)KILL_FX.shift();
        }
      });
      return ws;
    }
    for(const k of ['CONNECTING','OPEN','CLOSING','CLOSED'])ObservedWS[k]=CurrentWS[k];
    ObservedWS.prototype=CurrentWS.prototype;
    window.WebSocket=ObservedWS;
    window.__NANY_DEATH_CAUSE_SOCKET__=true;
  }

  function drawKillerFx(){
    try{
      if(!KILL_FX.length)return;
      const ctx=window.eval('typeof ctx!=="undefined"?ctx:null'),cam=window.eval('typeof camera!=="undefined"?camera:null'),zoom=getFn('getViewZoom')?.()||1;
      const W=window.eval('typeof W!=="undefined"?W:innerWidth'),H=window.eval('typeof H!=="undefined"?H:innerHeight'),drawFish=getFn('drawFishBody'),drawBoss=getFn('drawBoss');
      if(!ctx||!cam)return;
      const now=performance.now();
      ctx.save();ctx.translate(W/2,H/2);ctx.scale(zoom,zoom);ctx.translate(-(cam.x+W/(2*zoom)),-(cam.y+H/(2*zoom)));
      for(let i=KILL_FX.length-1;i>=0;i--){
        const fx=KILL_FX[i],t=(now-fx.start)/520;
        if(t>=1){KILL_FX.splice(i,1);continue;}
        const k=fx.killer,v=fx.victim,a=Number(k.angle)||Math.atan2(Number(k.vy)||0,Number(k.vx)||1),s=Math.max(10,Number(k.size)||20);

        // Si el pez autoritativo real ya está junto a la víctima, NO dibujamos
        // otro pez encima. El fantasma solo existe como respaldo ante lag fuerte.
        const live=ENTITY_CACHE.get(String(k.id||k.sharedId||''));
        if(live){
          const visibleDist=Math.hypot((Number(live.x)||0)-v.x,(Number(live.y)||0)-v.y);
          if(visibleDist<=Math.max(180,s*3.2)){KILL_FX.splice(i,1);continue;}
        }

        const bite=clamp(t/.30,0,1),retreat=clamp((t-.55)/.45,0,1);
        const sx=Number(k.x)||v.x-Math.cos(a)*s*.9,sy=Number(k.y)||v.y-Math.sin(a)*s*.9;
        const tx=v.x-Math.cos(a)*s*.18,ty=v.y-Math.sin(a)*s*.18;
        const e={...k,x:mix(sx,tx,bite)+Math.cos(a)*s*.35*retreat,y:mix(sy,ty,bite)+Math.sin(a)*s*.35*retreat,angle:a,size:s,baseSize:s,renderKey:k.renderKey||k.type,family:k.type,variant:'big',ecologyRole:'predator',role:'predator',life:0};
        ctx.save();ctx.globalAlpha=clamp(1-retreat*.75,.2,1);
        if(k.boss&&drawBoss)drawBoss(e);else if(drawFish)drawFish(e,1);
        ctx.restore();
      }
      ctx.restore();
    }catch{}
  }

  const installer=setInterval(()=>{
    installSmoothSync();
    if(window.__NANY_RENDER_PATCHED__&&!window.__NANY_KILLFX_RENDER_PATCHED__&&getFn('render')){
      window.__NANY_KILLFX_RENDER_PATCHED__=true;
      const previous=getFn('render');
      window.__NANY_RENDER_WITH_KILLFX__=function(){previous();drawKillerFx();};
      try{window.eval('render=window.__NANY_RENDER_WITH_KILLFX__')}catch{}
    }
    if(window.__NANY_SMOOTH_SYNC_INSTALLED__&&window.__NANY_KILLFX_RENDER_PATCHED__)clearInterval(installer);
  },60);

  const mobile=(navigator.maxTouchPoints||0)>0 || matchMedia('(pointer:coarse)').matches;
  if(!mobile)return;

  const originalZoom=window.getViewZoom;
  if(typeof originalZoom==='function'){
    window.getViewZoom=function mobileViewZoom(){
      const current=Number(originalZoom())||1,portrait=window.innerHeight>=window.innerWidth;
      return Math.min(current,portrait?0.60:0.72);
    };
  }

  const originalSpeed=window.playerSpeed;
  if(typeof originalSpeed==='function')window.playerSpeed=function mobilePlayerSpeed(){return originalSpeed()*1.22;};

  const canvas=document.getElementById('gameCanvas');
  if(canvas)canvas.style.touchAction='none';

  window.__NANY_MOBILE_BALANCE__={enabled:true,portraitZoom:0.60,landscapeZoom:0.72,playerSpeedMultiplier:1.22,smoothSync:true,renderDelayMs:RENDER_DELAY_MS};
})();
