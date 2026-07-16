# Club

Multiplayer drawing / scoring party game — lobby invites, server-authoritative rounds, Neon Postgres, Ably realtime.

Built as a sibling to [Flip 7](https://github.com/sidmsmith/flip): same Neon project (`club_*` tables) and Ably pattern.

## Branches

| Branch | Purpose |
|--------|---------|
| `main` | Production (Vercel) |
| `dev` | Kept in sync with `main` for now; use later for collaborator work |

For now, push the same updates to **both** `main` and `dev`. When a collaborator joins, revisit using `dev` as the integration branch.

## Environment variables (Vercel)

| Variable | Description |
|----------|-------------|
| `NEON_DATABASE_URL` | Same Neon project as Wordle / Flip |
| `ABLY_API_KEY` | Same Ably REST key as Flip / Wordle |

## Local development

Work in the **`club/`** folder (this repo), not the parent `Web/` folder.

1. Copy `.env.example` to `.env.local` and set `NEON_DATABASE_URL` (and optionally `ABLY_API_KEY`).
2. Run commands from `club/`:

```bash
cd club
npm install
npm test                 # engine unit tests (no DB)
npm run test:lobby       # lobby/invite scenario sims (reads .env.local)
npx vercel dev
```

`test:lobby` mocks Ably and exercises real Neon: invite, accept, decline, re-invite, start-with-pending-cancel, presence Host/Ready/Available, and busy-player invite blocking. Run it after lobby changes instead of full manual regression.

Open `http://localhost:3000/club`.

## Deploy

1. Import [sidmsmith/club](https://github.com/sidmsmith/club) in Vercel.
2. Set `NEON_DATABASE_URL` and `ABLY_API_KEY`.
3. Production branch: `main`. Optional preview branch: `dev`.
4. Production URL: [https://clubgame.vercel.app/](https://clubgame.vercel.app/) (`API_ORIGIN` in `club.html`).

## Gameflow

1. Host invites 1-5 players (2-6 total) from the lobby.
2. Each round: draw on the pad, then Submit (can resubmit until everyone has submitted).
3. Names in the header are red until submitted, green after.
4. When all have submitted, everyone sees all pads; the host marks correct/incorrect.
5. Host Submit awards +1 for correct answers and starts the next round (pads clear for everyone).
6. Host can End Game anytime; Restart starts a new game in the same room (no lobby).
7. Leave removes only that player; others continue.

## Lobby / invites

- Players only appear as **available** while they have **Game Lobby** open (heartbeat).
- Closing the lobby removes you from availability immediately.
- Anyone already in a lobby room or active game is not inviteable.
- Invites are stored on the server; opening Game Lobby reloads any pending invites (so a missed Ably toast still works).
