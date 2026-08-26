import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const SERVER_SRC=path.join(ROOT,'server.mjs');
const CLIENT_SRC=path.join(ROOT,'multiplayer-client.js');
const GENERATED_SERVER=path.join(ROOT,'.server-collision-runtime.mjs');
const GENERATED_CLIENT=path.join(ROOT,'.multiplayer-client-collision.js');

let serverSource=await fs.readFile(SERVER_SRC,'utf8');
let clientSource=await fs.readFile(CLIENT_SRC,'utf8');

const runtimeImport="} from './world-runtime.mjs';";
if(!serverSource.includes(runtimeImport)){
  throw new Error('Collision entry: no se encontró el import de world-runtime.mjs');
}
serverSource=serverSource.replace(runtimeImport,"} from './world-runtime-collision.mjs';");

const clientFileLine="const CLIENT_FILE=path.join(ROOT,'multiplayer-client.js');";
if(!serverSource.includes(clientFileLine)){
  throw new Error('Collision entry: no se encontró CLIENT_FILE en server.mjs');
}
serverSource=serverSource.replace(clientFileLine,"const CLIENT_FILE=path.join(ROOT,'.multiplayer-client-collision.js');");

// La regla de tamaño (0.78/0.88) sigue decidiendo QUIÉN puede comer a quién.
// El contacto para comer ya no usa un círculo centrado en todo el jugador:
// se coloca una zona de mordida delante de la cabeza según p.angle. Así la
// cabeza come al tocar y la cola deja de funcionar como una boca invisible.
const oldCollision="const fh=fhFn?.(e)||Math.max(2.5,e.size*.88),edible=e.gemFish||(e.ecologyRole==='prey'&&fh<ph*.96);if(edible&&dd<=ph+fh){";
const newCollision="const fh=fhFn?.(e)||Math.max(2.5,e.size*.88),pr=window.eval('playerRadius(growthScore())'),pa=Number(p.angle)||0,mouthX=p.x+Math.cos(pa)*pr*.80,mouthY=p.y+Math.sin(pa)*pr*.80,biteReach=Math.max(3,pr*.28),contactFh=Math.max(2.5,(Number(e.size)||0)*1.05),biteD=Math.hypot(e.x-mouthX,e.y-mouthY),edible=e.gemFish||(e.ecologyRole==='prey'&&fh<ph*.96);if(edible&&biteD<=biteReach+contactFh){";
if(!clientSource.includes(oldCollision)){
  throw new Error('Collision entry: no se encontró la colisión multiplayer esperada');
}
clientSource=clientSource.replace(oldCollision,newCollision);

await fs.writeFile(GENERATED_CLIENT,clientSource,'utf8');
await fs.writeFile(GENERATED_SERVER,serverSource,'utf8');

await import(pathToFileURL(GENERATED_SERVER).href+`?collision=${Date.now()}`);
