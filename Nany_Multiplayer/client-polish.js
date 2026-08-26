(()=>{
  'use strict';
  const getGame=()=>{try{return window.eval('typeof game!=="undefined"?game:null')}catch{return null}};
  const getFn=name=>{try{return window.eval(`typeof ${name}==="function"?${name}:null`)}catch{return null}};
  const mobile=(navigator.maxTouchPoints||0)>0 || (window.matchMedia&&matchMedia('(pointer:coarse)').matches);

  // Sprint solo cuando el pez ya se está moviendo.
  const patchSprint=()=>{
    try{
      const original=getFn('startSprint');
      if(!original||window.__NANY_SPRINT_GATED__)return;
      window.__NANY_SPRINT_GATED__=true;
      window.__NANY_START_SPRINT__=function(){
        const g=getGame(),p=g?.player;
        const moving=!!p && (Math.hypot(Number(p.vx)||0,Number(p.vy)||0)>0.18 || (()=>{try{return window.eval('keyboardActive() || (input.active && input.tx!=null)')}catch{return false}})());
        if(!moving){try{g.sprintRequested=false;g.sprintActive=false;}catch{}return false;}
        return original();
      };
      window.eval('startSprint=window.__NANY_START_SPRINT__');
    }catch{}
  };

  // Recuperación automática del joystick en móvil si iOS/Android pierde el pointer.
  const patchJoystick=()=>{
    if(!mobile||window.__NANY_JOYSTICK_RECOVERY__)return;
    const canvas=document.getElementById('gameCanvas');
    if(!canvas)return;
    window.__NANY_JOYSTICK_RECOVERY__=true;
    const reset=()=>{
      try{window.eval('if(typeof endTouch==="function")endTouch(); else { activePointerId=null; joyOrigin=null; input.active=false; }')}catch{}
      try{window.eval('game.sprintPointerId=null; stopSprint();')}catch{}
    };
    canvas.addEventListener('lostpointercapture',reset,{passive:true});
    canvas.addEventListener('pointercancel',reset,{passive:true});
    window.addEventListener('blur',reset,{passive:true});
    document.addEventListener('visibilitychange',()=>{if(document.hidden)reset();},{passive:true});
    window.addEventListener('orientationchange',()=>setTimeout(reset,30),{passive:true});
    canvas.addEventListener('pointerdown',e=>{
      if(e.pointerType==='mouse')return;
      try{
        const stuck=window.eval('activePointerId!==null && (!joyOrigin || document.getElementById("joystick")?.style.display==="none")');
        if(stuck)reset();
      }catch{}
    },true);
  };

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

  const timer=setInterval(()=>{patchSprint();patchJoystick();installLobbyMusic();if(window.__NANY_SPRINT_GATED__&&(!mobile||window.__NANY_JOYSTICK_RECOVERY__)&&window.__NANY_LOBBY_MUSIC__)clearInterval(timer);},80);
})();
