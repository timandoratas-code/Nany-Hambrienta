(()=>{
  'use strict';

  /* Música del menú. Los navegadores móviles bloquean autoplay con sonido,
     así que se intenta al cargar y se desbloquea con el primer toque/clic. */
  const music=new Audio('/detroit-beat.mp3?v=1');
  music.loop=true;
  music.preload='auto';
  music.volume=0.28;
  let userUnlocked=false;
  let manuallyMuted=false;

  const getGame=()=>{try{return window.eval('typeof game!=="undefined"?game:null')}catch{return null}};
  const getFn=name=>{try{return window.eval(`typeof ${name}==="function"?${name}:null`)}catch{return null}};
  const menuVisible=()=>{
    const start=document.getElementById('startScreen');
    const shop=document.getElementById('shopScreen');
    const multi=document.getElementById('multiplayerScreen');
    const over=document.getElementById('gameOverScreen');
    return [start,shop,multi,over].some(el=>el&&!el.classList.contains('hidden')) || !getGame()?.running;
  };
  const syncMusic=()=>{
    const shouldPlay=menuVisible()&&!manuallyMuted;
    if(shouldPlay&&userUnlocked){
      const promise=music.play();
      if(promise?.catch)promise.catch(()=>{});
    }else if(!shouldPlay&&!music.paused){
      music.pause();
    }
  };
  const unlock=()=>{
    userUnlocked=true;
    syncMusic();
  };
  addEventListener('pointerdown',unlock,{passive:true});
  addEventListener('keydown',unlock,{passive:true});
  addEventListener('touchstart',unlock,{passive:true});
  setInterval(syncMusic,250);

  const installMuteSync=()=>{
    const btn=document.getElementById('muteBtn');
    if(!btn||btn.__nanyMusicBound)return;
    btn.__nanyMusicBound=true;
    btn.addEventListener('click',()=>{
      manuallyMuted=!manuallyMuted;
      music.muted=manuallyMuted;
      syncMusic();
    });
  };
  const muteTimer=setInterval(()=>{
    installMuteSync();
    if(document.getElementById('muteBtn'))clearInterval(muteTimer);
  },100);

  /* Escucha el evento autoritativo del golpe al jefe y reproduce exactamente
     el feedback que tenía el index original: partículas, sacudida, sonido y 1/5. */
  const PreviousWS=window.WebSocket;
  function HitFxWebSocket(url,protocols){
    const ws=protocols===undefined?new PreviousWS(url):new PreviousWS(url,protocols);
    ws.addEventListener('message',event=>{
      let msg;try{msg=JSON.parse(event.data)}catch{return}
      if(msg?.type!=='boss_hit_fx')return;
      const g=getGame();
      const x=Number(msg.x)||0,y=Number(msg.y)||0;
      const hits=Math.max(0,Math.floor(Number(msg.hits)||0));
      const maxHits=Math.max(1,Math.floor(Number(msg.maxHits)||5));
      const color=msg.color||(msg.bossType==='shrimp'?'#ff9a62':'#ffcf4d');
      if(g)g.camShake=Math.max(Number(g.camShake)||0,5);
      getFn('spawnParticles')?.(x,y,color,16);
      getFn('spawnFloater')?.(x,y,`${hits}/${maxHits}`,'#ffd23f');
      try{window.eval('typeof AudioSys!=="undefined"?AudioSys:null')?.eat?.(Number(msg.size)||90)}catch{}
    });
    return ws;
  }
  for(const key of ['CONNECTING','OPEN','CLOSING','CLOSED'])HitFxWebSocket[key]=PreviousWS[key];
  HitFxWebSocket.prototype=PreviousWS.prototype;
  window.WebSocket=HitFxWebSocket;
})();
