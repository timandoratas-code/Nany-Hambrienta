import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const RUNTIME=path.join(ROOT,'world-runtime.mjs');

let src=await fs.readFile(RUNTIME,'utf8');

const oldCount='const MAX_PLAYERS=8, FISH_N=260;';
const newCount='const MAX_PLAYERS=8, FISH_N=340;';
if(!src.includes(oldCount)) throw new Error('Density entry: no se encontró FISH_N=260');
src=src.replace(oldCount,newCount);

const oldPools=`const LEVEL_POOLS={
  1:[['plankton',100],['minnow',60],['green',35],['piranha',24],['stick',16],['rival',12],['shark',9],['monster',4]],
  2:[['plankton',80],['minnow',50],['green',28],['silver',14],['piranha',27],['stick',20],['rival',16],['lantern',10],['shark',11],['monster',4]],
  3:[['plankton',58],['minnow',44],['green',30],['silver',14],['piranha',28],['stick',20],['rival',20],['lantern',24],['shark',12],['monster',10]],
  4:[['plankton',50],['minnow',40],['green',30],['silver',16],['piranha',28],['stick',20],['rival',20],['lantern',28],['shark',16],['monster',12]]
};`;

const newPools=`const LEVEL_POOLS={
  // Más alimento pequeño para acelerar el crecimiento sin regalar puntos:
  // mantenemos los valores de cada pez y aumentamos sobre todo krill/plankton + minnows.
  1:[['plankton',145],['minnow',95],['green',35],['piranha',24],['stick',16],['rival',12],['shark',9],['monster',4]],
  2:[['plankton',120],['minnow',90],['green',28],['silver',14],['piranha',27],['stick',20],['rival',16],['lantern',10],['shark',11],['monster',4]],
  3:[['plankton',100],['minnow',82],['green',30],['silver',14],['piranha',28],['stick',20],['rival',20],['lantern',24],['shark',12],['monster',10]],
  4:[['plankton',92],['minnow',78],['green',30],['silver',16],['piranha',28],['stick',20],['rival',20],['lantern',28],['shark',16],['monster',12]]
};`;

if(!src.includes(oldPools)) throw new Error('Density entry: no se encontraron LEVEL_POOLS esperados');
src=src.replace(oldPools,newPools);

await fs.writeFile(RUNTIME,src,'utf8');
console.log('NANY DENSITY PATCH OK: FISH_N=340, extra plankton/minnows');

await import(pathToFileURL(path.join(ROOT,'server-collision-entry.mjs')).href+`?density=${Date.now()}`);
