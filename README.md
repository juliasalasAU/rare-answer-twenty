# Rare Answer Twenty

A Pointless-style quiz for a room of players. The host creates a room and gets a QR code; players scan it with their phone camera, type a name and play on their own phones. No accounts for anyone. Runs on Cloudflare Workers (free plan is enough).

## Deploy (about 5 minutes, once)

You need a free Cloudflare account (cloudflare.com) and Node.js 18 or newer on your computer (nodejs.org).

Open a terminal in this folder and run:

```
npm install
npx wrangler login      # opens a browser window; approve the access
npx wrangler deploy
```

The last command prints your game's address, something like
`https://rare-answer-twenty.<your-subdomain>.workers.dev`. That is the link you open to host.

The first deploy may ask you to confirm the Durable Object migration; answer yes.

To update the game later (new categories, text changes), edit `public/index.html` and run `npx wrangler deploy` again.

## Hosting a game

1. Open your workers.dev address on your phone and tap **Create a room**.
2. Show the QR code to the others. They scan it, type their name and tap **Join**. You can join as a player too.
3. Tap **Start the game**. Each round, everyone types one answer and locks it in. Nobody's answer is visible until you tap **Reveal the scores**.
4. **Next round**, and after twenty rounds the final standings appear. Lowest total wins.

Rooms live for 12 hours. If a player's phone locks or they reload the page, they come straight back into the game.

## Changing the questions

Everything is in `public/index.html`. Each entry in `ROUNDS` has a title, a note, and a list of accepted answers as `["Display name", score, "alias", "alias"]`. The score is how many people out of 100 you estimate would give that answer; 0 means a rare answer (worth minus 5). Aliases are other spellings that should count, such as `"holland"` for the Netherlands. Matching ignores case, accents and punctuation, and a leading "the".

## Files

- `public/index.html` — the whole game (page, rules, questions, scoring).
- `public/qrcode.js` — QR encoder (qrcode-generator by Kazuhiko Arase, MIT).
- `src/index.js` — the Worker: creates rooms and runs each room as a Durable Object over WebSockets.
- `wrangler.toml` — Cloudflare configuration.
