(()=>{
  'use strict';
  const CurrentWS=window.WebSocket;
  if(!CurrentWS||window.__NANY_DEATH_FLOW__)return;
  window.__NANY_DEATH_FLOW__=true;
  const BUF='__NANY_LIVE_BUF__';
  let selfId=null,deathToken=0;
  const getGame=()=>{try{return window.eval('typeof game!=="undefined"?game:null')}catch{return null}};
  const getSave=()=>{try{return window.eval('typeof Save!=="undefined"?Save:null')}catch{return null}};
  const getFn=name=>{try{return window.eval(`typeof ${name}==="function"?${name}:null`)}catch{return null}};
  const maxLives=()=>Math.max(1,Math.min(4,1+Math.floor(Number(getSave()?.extraLives)||0)));
  const authoritativeAlive=()=>{
    const b=window[BUF]||[],m=b.length?b[b.length-1]?.m:null,me=m?.you||m?.player;
    return !me||me.alive!==false;
  };

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
        deathToken++;
        return;
      }
      if(m.type==='player_death'){
        const victimId=String(m.victimId||m.victim?.id||'');
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
        deathToken++;
        return;
      }
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
