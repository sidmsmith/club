# Club

Multiplayer drawing / judgment party game — lobby invites, server-authoritative rounds, Neon Postgres, Ably realtime.

Built as a sibling to [Flip 7](https://github.com/sidmsmith/flip): same Neon project (`club_*` tables) and Ably pattern.

## Branches

| Branch | Purpose |
|--------|---------|
| `main` | Production-ready releases |
| `dev` | Collaboration / day-to-day work (Cursor Cloud Agents + PRs) |

Feature work should land on `dev` (or short-lived branches off `dev`). Promote to `main` via PR when ready to ship.

## Environment variables (Vercel)

| Variable | Description |
|----------|-------------|
| `NEON_DATABASE_URL` | Same Neon project as Wordle / Flip |
| `ABLY_API_KEY` | Same Ably REST key as Flip / Wordle |

## Local development

```bash
npm install
npm test
npx vercel dev
```

Open `http://localhost:3000/club`.

## Deploy

1. Import [sidmsmith/club](https://github.com/sidmsmith/club) in Vercel.
2. Set `NEON_DATABASE_URL` and `ABLY_API_KEY`.
3. Production branch: `main`. Optional preview branch: `dev`.
4. Update `API_ORIGIN` in `club.html` to the Vercel URL after first deploy.

## Gameflow

1. Host invites 1–5 players (2–6 total) from the lobby.
2. Each round: draw on the pad → Submit (can resubmit until everyone has submitted).
3. Names in the header are red until submitted, green after.
4. When all have submitted, everyone sees all pads; the host (judge) marks correct/incorrect.
5. Judge Submit awards +1 for correct answers and starts the next round.
6. Judge can End Game anytime; Restart starts a new game in the same room (no lobby).
7. Leave removes only that player; others continue.

## Ably channels

- `club-lobby` — presence, invites
- `club-room-{roomId}` — in-room game events
