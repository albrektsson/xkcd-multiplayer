# xkcd: Multiplayer Edition

Read [xkcd](https://xkcd.com/) with friends. Everyone in a room sees the same comic, and
**anyone** can press Prev / Random / Next. You're all stick figures pointing at the comic,
and you can draw on it.

- Shared navigation (buttons, arrow keys, `R` for random, or type `#327` in chat)
- Live pointers, chat speech bubbles, shared scribbles (kept per comic for the session)
- Title text stays hidden until someone "hovers" for the whole room
- `RELEASE RAPTOR`, `sudo make me a sandwich`, etc.

## Run locally

No build step. Serve the folder with anything:

    python3 -m http.server 8000

Open http://localhost:8000, create a room, open the invite link in a second tab.
`?solo` skips the menu and starts an offline room with bots.

## Hosting

It's plain static files (`index.html`, `style.css`, `app.js`).

- **GitHub Pages**: push, enable Pages on the branch root. Done.
- **Vercel**: import the repo, no framework, no build command. `vercel.json` adds a
  same-origin rewrite to xkcd's JSON API so no third-party proxy is needed there.

## How it works

- **Multiplayer** is peer-to-peer WebRTC via [PeerJS](https://peerjs.com/) and its free public
  signalling server. Whoever creates the room is the host and the source of truth; if they
  close the tab the room ends. Max 8 people. Very strict corporate NATs may fail to connect
  (there is no TURN relay).
- **Comic data**: xkcd.com sends no CORS headers, so the host fetches metadata from, in order,
  `./xkcd/…` (the Vercel rewrite), `xkcd.vercel.app`, then `api.allorigins.win`, and
  broadcasts it. Images are hotlinked from `imgs.xkcd.com`. If the third-party mirrors ever
  die on GitHub Pages, edit `SOURCES` at the top of `app.js`.

## Credits

All comics are by Randall Munroe, licensed CC BY-NC 2.5. This is an unofficial,
non-commercial fan project and is not affiliated with xkcd.
