(()=>{
  'use strict';
  const CurrentWS=window.WebSocket;
  if(!CurrentWS||window.__NANY_DEATH_FLOW__)return;
  window.__NANY_DEATH_FLOW__=true;
  const BUF='__NANY_LIVE_BUF__';
  let selfId=null,deathToken=0,runCoins=0,lastPayoutKey='';
  const getGame=()=>{try{return window.eval('typeof game!=="undefined"?game:null')}catch{return null}};
  const getSave=()=>{try{return window.eval('typeof Save!=="undefined"?Save:null')}catch{return null}};
  const getFn=name=>{try{return window.eval(`typeof ${name}==="function"?${name}:null`)}catch{return null}};
  const maxLives=()=>Math.max(1,Math.min(4,1+Math.floor(Number(getSave()?.extraLives)||0)));
  const authoritativeAlive=()=>{
    const b=window[BUF]||[],m=b.length?b[b.length-1]?.m:null,me=m?.you||m?.player;
    return !me||me.alive!==false;
  };
  const coinValue=e=>{
    if(!e||e.gemFish)return 0;
    const pts=Math.max(0,Number(e.points)||0);
    if(pts<=8)return 1;
    if(pts<=35)return 2;
    if(pts<=75)return 3;
    if(pts<=150)return 4;
    return 5;
  };
  function cashOutRunCoins(m){
    const key=String(m?.serverTime||'')+':'+String(m?.victimId||m?.victim?.id||selfId||'');
    if(!runCoins||key===lastPayoutKey)return;
    lastPayoutKey=key;
    const amount=runCoins;runCoins=0;
    const s=getSave(),g=getGame();
    if(!s)return;
    if(g)g.coins=Math.max(0,Math.floor(Number(g.coins)||0))+amount;
    const x=Number(m?.victim?.x)||g?.player?.x||0,y=Number(m?.victim?.y)||g?.player?.y||0;
    if(s.devMode){
      getFn('spawnFloater')?.(x,y-48,`PRUEBA +${amount} MONEDA${amount===1?'':'S'}`,'#ffd23f');
      try{window.eval('typeof AudioSys!=="undefined"?AudioSys:null')?.coin?.()}catch{}
      return;
    }
    s.coins=Math.max(0,Math.floor(Number(s.coins)||0))+amount;
    getFn('queueSave')?.();
    getFn('updateHUD')?.();
    getFn('spawnFloater')?.(x,y-48,`+${amount} MONEDA${amount===1?'':'S'}`,'#ffd23f');
    try{window.eval('typeof AudioSys!=="undefined"?AudioSys:null')?.coin?.()}catch{}
  }

  // El pez base recibe solo un pequeño aumento. Turbo, mejoras, mascotas y
  // penalización por tamaño siguen calculándose exactamente igual.
  const speedPatch=setInterval(()=>{
    if(window.__NANY_BASE_SPEED_POLISHED__)return clearInterval(speedPatch);
    const original=getFn('playerSpeed');
    if(!original)return;
    window.__NANY_BASE_SPEED_POLISHED__=original;
    window.__NANY_PLAYER_SPEED_POLISHED__=function(){return window.__NANY_BASE_SPEED_POLISHED__()*1.08;};
    try{window.eval('playerSpeed=window.__NANY_PLAYER_SPEED_POLISHED__')}catch{}
    clearInterval(speedPatch);
  },60);

  function DeathFlowWS(url,protocols){
    const ws=protocols===undefined?new CurrentWS(url):new CurrentWS(url,protocols);
    const originalSend=ws.send.bind(ws);
    ws.send=data=>{
      let out=data;
      try{
        const m=JSON.parse(data);
        if(m?.type==='join')out=JSON.stringify({...m,maxLives:maxLives()});
      }catch{}
      return originalSend(out);
    };
    ws.addEventListener('message',ev=>{
      let m;try{m=JSON.parse(ev.data)}catch{return}
      if(m.type==='welcome'){
        selfId=String(m.id||m.you?.id||m.player?.id||'')||null;
        runCoins=0;lastPayoutKey='';deathToken++;
        return;
      }
      if(m.type==='entity_removed'&&String(m.by||'')===String(selfId||'')){
        runCoins+=coinValue(m.entity);
      }
      if(m.type==='player_death'){
        const victimId=String(m.victimId||m.victim?.id||'');
        if(selfId&&victimId===selfId)cashOutRunCoins(m);
        if(selfId&&victimId&&victimId!==selfId){
          // Una muerte ajena nunca puede dejar a este cliente en estado de muerte.
          // Solo limpiamos el falso positivo si el estado autoritativo dice que seguimos vivos.
          const g=getGame();
          if(authoritativeAlive()&&g?.player?._takingDamage){
            g.player._takingDamage=false;
            g.deathAnim=null;
          }
          return;
        }
      }
      if(m.type==='respawn'&&String(m.player?.id||'')===String(selfId||'')){
        runCoins=0;deathToken++;
        return;
      }
      if(m.type==='world_reset')runCoins=0;
      if(m.type==='player_dead'&&String(m.id||'')===String(selfId||'')&&m.finalDeath!==false){
        const token=++deathToken;
        setTimeout(()=>{
          if(token!==deathToken)return;
          const g=getGame();
          if(g?.player){g.player._takingDamage=false;g.deathAnim=null;}
          getFn('showStartMenu')?.();
        },900);
      }
    });
    return ws;
  }
  for(const k of ['CONNECTING','OPEN','CLOSING','CLOSED'])DeathFlowWS[k]=CurrentWS[k];
  DeathFlowWS.prototype=CurrentWS.prototype;
  window.WebSocket=DeathFlowWS;
})();
