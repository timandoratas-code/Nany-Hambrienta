import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(root, 'server-stable.mjs');
const runtimePath = path.join(root, '.server-stable-runtime.mjs');

let source = await fs.readFile(sourcePath, 'utf8');

const duplicateJoinNeedle = "if(m.type==='join'){const s=modeToWorld(m.mode);";
const duplicateJoinReplacement = "if(m.type==='join'){if(p){send(ws,welcome(w,p));return}const s=modeToWorld(m.mode);";
if (source.includes(duplicateJoinNeedle)) {
  source = source.replace(duplicateJoinNeedle, duplicateJoinReplacement);
}

const connectedResumeNeedle = "if(old&&old.disconnectedAt&&Date.now()-old.disconnectedAt<RESUME_MS&&!old.connected){p=old;p.ws=ws;p.connected=true;p.disconnectedAt=0;send(ws,welcome(w,p));broadcast(w);return}";
const connectedResumeReplacement = "if(old&&old.connected&&old.ws&&old.ws!==ws){try{old.ws.close(4001,'replaced-by-resume')}catch{}p=old;p.ws=ws;p.connected=true;p.disconnectedAt=0;send(ws,welcome(w,p));broadcast(w);return}if(old&&old.disconnectedAt&&Date.now()-old.disconnectedAt<RESUME_MS&&!old.connected){p=old;p.ws=ws;p.connected=true;p.disconnectedAt=0;send(ws,welcome(w,p));broadcast(w);return}";
if (source.includes(connectedResumeNeedle)) {
  source = source.replace(connectedResumeNeedle, connectedResumeReplacement);
}

await fs.writeFile(runtimePath, source, 'utf8');
await import('./.server-stable-runtime.mjs');
