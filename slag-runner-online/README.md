# Slag Runner online

A shooter-platformer with campaign, endless, tower defence and online co-op for up to 4 players.
The server has no dependencies. It needs only Node 18 or newer.

## Play on your own computer
    node server.js
Open http://localhost:3000. Friends on the same Wi-Fi can open http://YOUR-COMPUTER-IP:3000.

## Put it on the internet (free, about 5 minutes)
Co-op needs a host that supports WebSockets and runs a Node server. Static hosts such as
GitHub Pages or Netlify will not work for co-op. These do:

### Render (easiest)
1. Create a free GitHub account and a new repository. Upload every file from this folder.
2. On render.com choose New, then Web Service, and pick the repository.
   (`render.yaml` fills in the settings. Otherwise: Runtime Node, Build command empty, Start command `node server.js`.)
3. Pick the Free plan and deploy. You get a link like https://slag-runner.onrender.com.
4. Send that link to your friends.

Free Render services go to sleep when nobody visits. The first load after a break takes about
30 seconds. Open the link once before your friends arrive.

### Railway, Fly.io, or any VPS
Run `node server.js` and set the `PORT` environment variable if the host asks for it.
A `Dockerfile` is included for hosts that use Docker.

## How to play together
1. One person opens the site, taps ONLINE, picks a name and chooses Host a room.
2. They send the room code to friends. Friends open the same site, tap ONLINE, type the code and press Join.
3. The host picks campaign, endless or tower defence.

## Files
- `server.js` serves the game and relays co-op messages. Rooms hold up to 4 players.
- `public/index.html` is the whole game in one file, with the connection code included.
- `room-shim.js` is the same connection code on its own, for reference.

Rooms live only in server memory. Nothing is saved, and no accounts are needed.
