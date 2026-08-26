(()=>{
  'use strict';

  const mobile = (navigator.maxTouchPoints||0)>0 || matchMedia('(pointer:coarse)').matches;
  if(!mobile) return;

  const originalZoom = window.getViewZoom;
  if(typeof originalZoom==='function'){
    window.getViewZoom = function mobileViewZoom(){
      const current = Number(originalZoom())||1;
      const portrait = window.innerHeight >= window.innerWidth;
      // En vertical se abre todavía más el mundo porque el ancho útil es menor.
      const mobileCap = portrait ? 0.60 : 0.72;
      return Math.min(current,mobileCap);
    };
  }

  const originalSpeed = window.playerSpeed;
  if(typeof originalSpeed==='function'){
    window.playerSpeed = function mobilePlayerSpeed(){
      // Compensa la menor precisión del joystick táctil sin alterar PC.
      return originalSpeed()*1.22;
    };
  }

  // Evita que un gesto corto del joystick se pierda por el desplazamiento del navegador.
  const canvas=document.getElementById('gameCanvas');
  if(canvas) canvas.style.touchAction='none';

  window.__NANY_MOBILE_BALANCE__={
    enabled:true,
    portraitZoom:0.60,
    landscapeZoom:0.72,
    playerSpeedMultiplier:1.22
  };
})();
