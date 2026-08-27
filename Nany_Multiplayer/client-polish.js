(()=>{
  'use strict';
  const getGame=()=>{try{return window.eval('typeof game!=="undefined"?game:null')}catch{return null}};

  // Se restauran los controles touch originales del index.html.
  // Este archivo ya NO modifica startSprint(), pointerdown, pointerup,
  // pointercancel, lostpointercapture, activePointerId ni sprintPointerId.

  // Lobby music: empieza tras la primera interacción por políticas de autoplay.
  const installLobbyMusic=()=>{
    if(window.__NANY_LOBBY_MUSIC__)return;
    window.__NANY_LOBBY_MUSIC__=true;
    const audio=new Audio('/lobby-music.mp3?v=1');
    audio.loop=true;audio.preload='auto';audio.volume=0.22;
    let wanted=true,fadeTimer=null;
    const isLobby=()=>{
      const g=getGame();
      const ids=['startScreen','shopScreen','multiplayerScreen','gameOverScreen','devScreen'];
      return !g?.running || ids.some(id=>{const el=document.getElementById(id);return el&&!el.classList.contains('hidden');});
    };
    const fadeTo=(target,duration=450)=>{
      clearInterval(fadeTimer);const start=audio.volume,t0=performance.now();
      fadeTimer=setInterval(()=>{const t=Math.min(1,(performance.now()-t0)/duration);audio.volume=start+(target-start)*t;if(t>=1){clearInterval(fadeTimer);if(target<=0.001)audio.pause();}},30);
    };
    const sync=()=>{
      if(!wanted)return;
      if(isLobby()){
        if(audio.paused){audio.volume=0;audio.play().then(()=>fadeTo(0.22,500)).catch(()=>{});}else fadeTo(0.22,250);
      }else if(!audio.paused)fadeTo(0,350);
    };
    const unlock=()=>{sync();document.removeEventListener('pointerdown',unlock,true);document.removeEventListener('keydown',unlock,true);};
    document.addEventListener('pointerdown',unlock,true);document.addEventListener('keydown',unlock,true);
    const obs=new MutationObserver(sync);['startScreen','shopScreen','multiplayerScreen','gameOverScreen','devScreen'].forEach(id=>{const el=document.getElementById(id);if(el)obs.observe(el,{attributes:true,attributeFilter:['class']});});
    const oldMute=document.getElementById('muteBtn');if(oldMute)oldMute.addEventListener('click',()=>{setTimeout(()=>{const muted=oldMute.textContent.includes('🔇');wanted=!muted;if(muted){audio.pause();audio.volume=0.22;}else sync();},0);});
    setInterval(sync,700);
  };

  const timer=setInterval(()=>{
    installLobbyMusic();
    if(window.__NANY_LOBBY_MUSIC__)clearInterval(timer);
  },80);
})();
