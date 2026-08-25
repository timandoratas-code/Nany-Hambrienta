# Nany hambrienta — Multijugador

Proyecto web del juego con salas online y tres modos multijugador.

## Modos

### 👥 Equipos
- Dos equipos: **Azul** y **Rojo**.
- Los jugadores del mismo equipo **no pueden comerse entre sí**.
- Al entrar a la sala puedes elegir Azul o Rojo.
- Ideal para jugar con tu novia en el mismo equipo.

### ⚔️ Free For All
- Todos contra todos.
- Cualquier jugador suficientemente grande puede comerse a otro.

### 🤝 Cooperativo
- Los jugadores no pueden comerse entre sí.
- Todos sobreviven juntos frente al océano.

## Cómo jugar con tu novia

1. Los dos abren la misma URL pública del juego.
2. Tú entras a **Multijugador**.
3. Elige **EQUIPOS**.
4. Escribe un código, por ejemplo `NANY2026`.
5. Elige **Azul** y entra.
6. Tu novia abre la misma URL, escribe `NANY2026`, elige **Azul** y entra.
7. Aparecerán en la misma sala.

El primer jugador configura el modo de la sala. Los demás deben elegir el mismo modo.

## Ejecutar localmente

Requiere Node.js 20+.

```bash
npm install
npm start
```

Abre `http://localhost:8080`.

Para probar dos jugadores en una misma PC, abre dos ventanas del navegador y usa el mismo código de sala.

## Subirlo a internet con Render

Este proyecto necesita un **Web Service**, no un Static Site, porque usa Node.js y WebSockets. Render soporta WebSockets en Web Services. También puede desplegarse gratis, aunque los servicios gratuitos se duermen después de 15 minutos sin actividad. citeturn774911search0turn774911search2turn774911search3

### 1. Sube el proyecto a GitHub

Crea un repositorio, por ejemplo `nany-hambrienta-multiplayer`, y sube:

```text
index.html
server.mjs
package.json
Dockerfile
render.yaml
.gitignore
README.md
```

### 2. Crea el servidor en Render

En Render: **New → Web Service** y conecta el repositorio de GitHub. Render permite conectar GitHub y redeploy automático con cada push. citeturn774911search6turn774911search3

Usa:

```text
Language: Node
Build Command: npm install
Start Command: npm start
Health Check Path: /health
```

Esos comandos son compatibles con el flujo de despliegue de Node de Render. citeturn774911search1turn774911search4

### 3. Espera al deploy

Render te dará una URL parecida a:

```text
https://nany-hambrienta-multiplayer.onrender.com
```

Abre esa URL y el juego ya estará público.

### 4. WebSockets

En producción el navegador detecta HTTPS y usa automáticamente `wss://.../ws`. Render indica que los WebSockets públicos deben usar `wss` cuando el sitio está servido por HTTPS. citeturn774911search2

### 5. Jugar

Tú y tu novia abren la URL pública, entran a **Multijugador**, seleccionan **Equipos**, ponen el mismo código y escogen el mismo equipo.

## Health check

```text
GET /health
```

Ejemplo:

```json
{"ok":true,"service":"nany-hambrienta-multiplayer","rooms":1,"players":2}
```

## Importante

El servidor ya es autoritativo para:
- salas;
- límite de jugadores;
- validación básica de movimiento;
- identidad y equipo;
- PvP entre jugadores;
- reglas de Equipos/FFA/Cooperativo.

La fauna NPC, gemas y algunos eventos del océano siguen ejecutándose localmente para conservar el motor original del juego. La siguiente etapa, si quieres hacer un multijugador competitivo a gran escala, sería mover NPC, gemas y jefes al servidor para que toda la partida sea determinista.
