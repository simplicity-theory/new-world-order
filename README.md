# Conquer

A real-time strategy game played on procedurally generated maps. You start with one
town, raise armies, and take the towns around you from rivals who play by the same
rules: fog of war, sieges, roads and rail, sea crossings, truces.

Every game gets its own freshly generated world of terrain, rivers, towns and roads.
The world generator began as the whole project; it now exists to serve the game.

## Run

    npm install
    npm start          # http://localhost:5173

Needs a recent Node that runs TypeScript files directly. `npm run dev` restarts the
server when a file changes. Games in play are saved when the server is stopped.

| Address     | What it is                                                  |
| ----------- | ----------------------------------------------------------- |
| `/`         | The game                                                    |
| `/explorer` | The map explorer: generate and browse worlds without a game |

Settings, all optional environment variables:

- `PORT`: port to listen on (default 5173)
- `DATA_DIR`: where worlds and saved games are kept (default `data/`)
- `WORKERS`: threads used for map generation

## Test

    npm test               # game rules and territory
    npm run test:browser   # plays the game in headless Chrome

The browser suite starts its own server with a throwaway data folder. Set `CHROME`
if Chrome is not at `/usr/bin/google-chrome`.

## Layout

- `server/game/`: the game: simulation, rules, rival AI, territory
- `server/gen/`: the world generator: terrain, rivers, towns, roads
- `server/`: HTTP server, map tiles, saved worlds
- `public/game/`: the game's page
- `public/`: the map explorer
- `test/browser/`: browser tests
