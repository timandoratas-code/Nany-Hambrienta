import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(root, 'server-stable.mjs');
const runtimePath = path.join(root, '.server-stable-runtime.mjs');

let source = await fs.readFile(sourcePath, 'utf8');

const helper = `\nconst parseNanyCookie=(req,name)=>{const m=String(req.headers.cookie||'').match(new RegExp('(?:^|;\\\\s*)'+name+'=([^;]+)'));return m?decodeURIComponent(m[1]):null};\nconst ensureNanyCookie=(req,res)=>{const old=parseNanyCookie(req,'nanyClient');if(old)return old;const id='nany-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2)+'-'+Math.random().toString(36).slice(2);res.setHeader('Set-Cookie',\\`nanyClient=\\${encodeURIComponent(id)}; Path=/; Max-Age=31536000; SameSite=Lax\\`);return id};\n`;
if (!source.includes('const parseNanyCookie=')) {
  const marker = "const safeName=v=>String(v||'Nany').trim().slice(0,18)||'Nany';";
  source = source.replace(marker, marker + helper);
}

const pvpNeedle = "function combat(w){";
if (!source.includes('function pvpCombat(w)')) {
  const pvpBlock = `function pvpCombat(w){if(w.mode!=='ffa')return;const now=Date.now(),ps=[...w.players.values()].filter(p=>p.connected&&p.ws?.readyState===1&&p.alive&&p.invulnerableUntil<=now);for(let i=0;i<ps.length;i++){for(let j=i+1;j<ps.length;j++){const a=ps[i],b=ps[j],d=Math.hypot(a.x-b.x,a.y-b.y);if(d>(a.radius+b.radius)*0.82)continue;const ap=power(a.score),bp=power(b.score);let winner=null,loser=null;if(ap>bp&&a.radius>b.radius*1.01){winner=a;loser=b}else if(bp>ap&&b.radius>a.radius*1.01){winner=b;loser=a}else continue;winner.score=Math.max(0,Math.floor(winner.score)+Math.max(25,Math.floor(loser.score*0.5)));loser.score=0;loser.lives=0;loser.alive=false;loser.vx=0;loser.vy=0;loser.tx=loser.x;loser.ty=loser.y;loser.invulnerableUntil=now+3000;}}}\n`;
  source = source.replace(pvpNeedle, pvpBlock + pvpNeedle);
}

const tickNeedle = "w.tick++;movePlayers(w);updateFish(w,dt);combat(w)";
const tickReplacement = "w.tick++;movePlayers(w);updateFish(w,dt);combat(w);pvpCombat(w)";
if (source.includes(tickNeedle)) source = source.replace(tickNeedle, tickReplacement);

const pageNeedle = "if(u.pathname==='/'||u.pathname==='/index.html'){const html=await fs.readFile(path.join(ROOT,'index.html'),'utf8');res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});return res.end(html.replace('</head>',bridge+'</head>'));}";
const pageReplacement = "if(u.pathname==='/'||u.pathname==='/index.html'){ensureNanyCookie(req,res);const html=await fs.readFile(path.join(ROOT,'index.html'),'utf8');res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});return res.end(html.replace('</head>',bridge+'</head>'));}";
if (source.includes(pageNeedle)) source = source.replace(pageNeedle, pageReplacement);

// The authoritative snapshot is the only source of live fish state.
// Do not require a non-existent game.running flag.
source = source.replace("if(!g||!g.running||!b.length)return;", "if(!g||!b.length)return;");
// Never resurrect a fish that is absent from the newest server snapshot.
source = source.replace("const ids=new Set([...m0.keys(),...m1.keys()]),out=[];", "const ids=new Set(m1.keys()),out=[];");
source = source.replace("for(const id of ids){const a0=m0.get(id)||m1.get(id),a1=m1.get(id)||a0;", "for(const id of ids){const a0=m0.get(id),a1=m1.get(id);if(!a1)continue;");
// A dead player sees no server fish until the server sends a live state again.
source = source.replace("g.entities=out;const me=A.you||A.player;if(me){g.score=me.score;", "g.entities=out;const me=Z.you||A.you||Z.player||A.player;if(me&&!me.alive){g.entities=[];return;}if(me){g.score=me.score;");

const joinStart = source.indexOf("if(m.type==='join'){", source.indexOf("wss.on('connection'"));
const stateStart = source.indexOf("if(m.type==='state'&&player)", joinStart);
if (joinStart >= 0 && stateStart > joinStart) {
  const joinBlock = `if(m.type==='join'){if(player){const ww=worlds.get(player.worldCode);if(ww){send(ws,welcome(ww,player));}return}const [code,mode]=modeToWorld(m.mode),w=worlds.get(code);const clientKey=parseNanyCookie(req,'nanyClient')||String(m.clientKey||'');const resumeId=clientKey||String(m.resumeId||'');let p=resumeId?[...w.players.values()].find(x=>x.resumeId===resumeId||x.clientKey===resumeId):null;if(p&&p.connected&&p.ws&&p.ws!==ws){try{p.ws.close(4001,'replaced-by-device-session')}catch{}}if(!p){const active=[...w.players.values()].filter(x=>x.connected&&x.ws?.readyState===1).length;if(active>=MAX_PLAYERS)return send(ws,{type:'error',message:'Servidor lleno'});const pos=spawn(w);p={id:Math.random().toString(36).slice(2)+Date.now().toString(36),resumeId:resumeId||('nany-'+Math.random().toString(36).slice(2)),clientKey:clientKey||null,ws:null,worldCode:code,connected:false,disconnectedAt:0,name:safeName(m.name),team:teamFor(w,m.team),x:pos.x,y:pos.y,tx:pos.x,ty:pos.y,lastX:pos.x,lastY:pos.y,vx:0,vy:0,angle:0,score:0,radius:11,level:1,lives:1,alive:true,sprinting:false,lastInputAt:Date.now(),invulnerableUntil:Date.now()+1200};w.players.set(p.id,p)}p.ws=ws;p.connected=true;p.disconnectedAt=0;p.worldCode=code;p.name=safeName(m.name||p.name);if(!p.team)p.team=teamFor(w,m.team);player=p;send(ws,welcome(w,p));broadcast(w);return}`;
  source = source.slice(0, joinStart) + joinBlock + source.slice(stateStart);
}

const closeStart = source.indexOf("ws.on('close',()=>{", stateStart);
const closeEnd = source.indexOf("});\nconst hb=", closeStart);
if (closeStart >= 0 && closeEnd > closeStart) {
  const closeBlock = "ws.on('close',()=>{if(!player||player.ws!==ws)return;const ww=worlds.get(player.worldCode);player.connected=false;player.ws=null;player.disconnectedAt=Date.now();if(ww)broadcast(ww)})";
  source = source.slice(0, closeStart) + closeBlock + source.slice(closeEnd + 3);
}

await fs.writeFile(runtimePath, source, 'utf8');
await import('./.server-stable-runtime.mjs');
