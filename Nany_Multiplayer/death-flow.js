(()=>{
  'use strict';
  const CurrentWS=window.WebSocket;
  if(!CurrentWS||window.__NANY_DEATH_FLOW__)return;
  window.__NANY_DEATH_FLOW__=true;
  const BUF='__NANY_LIVE_BUF__';
  let selfId=null,deathToken=0,runCoins=0,runGems=0,lastPayoutKey='';
  let pendingRespawn=null,lastDeathRewards={coins:0,gems:0};

  const getGame=()=>{try{return window.eval('typeof game!=="undefined"?game:null')}catch{return null}};
  const getSave=()=>{try{return window.eval('typeof Save!=="undefined"?Save:null')}catch{return null}};
  const getFn=name=>{try{return window.eval(`typeof ${name}==="function"?${name}:null`)}catch{return null}};
  const getMultiplayer=()=>{try{return window.eval('typeof Multiplayer!=="undefined"?Multiplayer:null')}catch{return null}};
  const maxLives=()=>Math.max(1,Math.min(4,1+Math.floor(Number(getSave()?.extraLives)||0)));
  const authoritativeAlive=()=>{const b=window[BUF]||[],m=b.length?b[b.length-1]?.m:null,me=m?.you||m?.player;return !me||me.alive!==false;};
  const coinValue=e=>{if(!e||e.gemFish)return 0;const pts=Math.max(0,Number(e.points)||0);if(pts<=8)return 1;if(pts<=35)return 2;if(pts<=75)return 3;if(pts<=150)return 4;return 5;};

  function settleRewards(m){
    const key=String(m?.serverTime||'')+':'+String(m?.id||m?.victim?.id||selfId||'');
    if(key===lastPayoutKey)return lastDeathRewards;
    lastPayoutKey=key;
    const rewards={coins:Math.max(0,runCoins|0),gems:Math.max(0,runGems|0)};
    runCoins=0;runGems=0;lastDeathRewards=rewards;
    const s=getSave(),g=getGame();
    if(!s)return rewards;
    if(g)g.coins=Math.max(0,Math.floor(Number(g.coins)||0))+rewards.coins;
    if(rewards.coins>0){
      const x=Number(m?.victim?.x)||g?.player?.x||0,y=Number(m?.victim?.y)||g?.player?.y||0;
      if(s.devMode)getFn('spawnFloater')?.(x,y-48,`PRUEBA +${rewards.coins} MONEDA${rewards.coins===1?'':'S'}`,'#ffd23f');
      else{s.coins=Math.max(0,Math.floor(Number(s.coins)||0))+rewards.coins;getFn('queueSave')?.();getFn('updateHUD')?.();}
      try{window.eval('typeof AudioSys!=="undefined"?AudioSys:null')?.coin?.()}catch{}
    }
    return rewards;
  }

  function ensureRewardBox(){
    const screen=document.getElementById('multiplayerScreen');
    if(!screen)return null;
    let box=document.getElementById('mpLastRewards');
    if(!box){
      box=document.createElement('div');box.id='mpLastRewards';
      box.style.cssText='margin:12px auto 18px;max-width:520px;padding:12px 16px;border-radius:14px;background:rgba(6,24,35,.88);border:1px solid rgba(77,255,240,.35);color:#eaffff;text-align:center;font-weight:800;letter-spacing:.2px;box-shadow:0 10px 30px rgba(0,0,0,.22)';
      const first=screen.firstElementChild;if(first)first.insertAdjacentElement('afterend',box);else screen.appendChild(box);
    }
    return box;
  }
  function showRewards(rewards){
    const box=ensureRewardBox();if(!box)return;
    const c=Math.max(0,Number(rewards?.coins)||0),g=Math.max(0,Number(rewards?.gems)||0);
    box.textContent=`Partida anterior · +${c} moneda${c===1?'':'s'} · +${g} gema${g===1?'':'s'}`;
    box.style.display='block';
  }
  function openMultiplayerLobby(rewards){
    const g=getGame();if(g){g.running=false;g.paused=false;g.deathAnim=null;if(g.player)g.player._takingDamage=false;}
    const mp=getMultiplayer();try{mp?.disconnect?.()}catch{}
    document.getElementById('startScreen')?.classList.add('hidden');
    document.getElementById('shopScreen')?.classList.add('hidden');
    document.getElementById('gameOverScreen')?.classList.add('hidden');
    const ms=document.getElementById('multiplayerScreen');if(ms)ms.classList.remove('hidden');
    try{mp?.open?.()}catch{}
    showRewards(rewards||lastDeathRewards);
  }
  function applyRespawn(m){
    const p=m?.player||m,g=getGame();if(!p||!g?.player)return;
    g.player.x=Number(p.x)||g.player.x;g.player.y=Number(p.y)||g.player.y;
    g.player.vx=0;g.player.vy=0;g.score=Number(p.score)||0;g.growthScore=Number(p.growthScore)||0;g.lives=Math.max(0,Number(p.lives)||0);
    getFn('updateCamera')?.();getFn('updateHUD')?.();
  }
  function showRemoteDeath(m){
    const v=m?.victim;if(!v)return;
    const victimId=String(m.victimId||v.id||'');
    if(selfId&&victimId===selfId)return;
    const x=Number(v.x)||0,y=Number(v.y)||0;
    getFn('spawnParticles')?.(x,y,'#ff6a4d',18);
    const name=String(v.name||'Jugador').trim().slice(0,18)||'Jugador';
    getFn('spawnFloater')?.(x,y-30,`${name} fue comido`,'#ff7d6b');
  }

  const speedPatch=setInterval(()=>{
    if(window.__NANY_BASE_SPEED_POLISHED__)return clearInterval(speedPatch);
    const original=getFn('playerSpeed');if(!original)return;
    window.__NANY_BASE_SPEED_POLISHED__=original;
    window.__NANY_PLAYER_SPEED_POLISHED__=function(){return window.__NANY_BASE_SPEED_POLISHED__()*1.08;};
    try{window.eval('playerSpeed=window.__NANY_PLAYER_SPEED_POLISHED__')}catch{}
    clearInterval(speedPatch);
  },60);

  function animateOwnDeath(m){
    const token=++deathToken,g=getGame(),fn=getFn('showDeathBite');
    if(!g?.player)return;
    g.player._takingDamage=true;g.player.vx=0;g.player.vy=0;g.camShake=Math.max(Number(g.camShake)||0,10);
    try{window.eval('typeof AudioSys!=="undefined"?AudioSys:null')?.hurt?.()}catch{}
    const finalDeath=m.finalDeath!==false;
    fn?.(finalDeath,()=>{
      if(token!==deathToken)return;
      if(finalDeath){openMultiplayerLobby(lastDeathRewards);return;}
      if(pendingRespawn){applyRespawn(pendingRespawn);pendingRespawn=null;}
      if(g.player)g.player._takingDamage=false;g.deathAnim=null;getFn('updateHUD')?.();
    });
    if(!fn)setTimeout(()=>{if(token!==deathToken)return;if(finalDeath)openMultiplayerLobby(lastDeathRewards);else{if(pendingRespawn){applyRespawn(pendingRespawn);pendingRespawn=null;}if(g.player)g.player._takingDamage=false;g.deathAnim=null;}},2050);
  }

  function DeathFlowWS(url,protocols){
    const ws=protocols===undefined?new CurrentWS(url):new CurrentWS(url,protocols);
    const originalSend=ws.send.bind(ws);
    ws.send=data=>{let out=data;try{const m=JSON.parse(data);if(m?.type==='join')out=JSON.stringify({...m,maxLives:maxLives()});}catch{}return originalSend(out);};
    ws.addEventListener('message',ev=>{
      let m;try{m=JSON.parse(ev.data)}catch{return}
      if(m.type==='welcome'){selfId=String(m.id||m.you?.id||m.player?.id||'')||null;runCoins=0;runGems=0;lastPayoutKey='';pendingRespawn=null;deathToken++;return;}
      if(m.type==='entity_removed'&&String(m.by||'')===String(selfId||''))runCoins+=coinValue(m.entity);
      if(m.type==='gem_reward')runGems+=Math.max(1,Math.floor(Number(m.amount)||1));
      if(m.type==='remote_player_death'){showRemoteDeath(m);return;}
      if(m.type==='player_death'){
        const victimId=String(m.victimId||m.victim?.id||'');
        if(selfId&&victimId&&victimId!==selfId){const g=getGame();if(authoritativeAlive()&&g?.player?._takingDamage){g.player._takingDamage=false;g.deathAnim=null;}}
        return;
      }
      if(m.type==='player_dead'&&String(m.id||'')===String(selfId||'')){settleRewards(m);animateOwnDeath(m);return;}
      if(m.type==='respawn'&&String(m.id||m.player?.id||'')===String(selfId||'')){pendingRespawn=m;applyRespawn(m);return;}
      if(m.type==='world_reset'){runCoins=0;runGems=0;}
    });
    return ws;
  }
  for(const k of ['CONNECTING','OPEN','CLOSING','CLOSED'])DeathFlowWS[k]=CurrentWS[k];
  DeathFlowWS.prototype=CurrentWS.prototype;
  window.WebSocket=DeathFlowWS;
})();
