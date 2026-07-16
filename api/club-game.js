import { getPool, cors, ensureClubTables } from "./db.js";
import { ablyPublish, LOBBY_CHANNEL, roomChannel } from "./ably.js";
import {
  createInitialState,
  applyAction,
  publicState,
} from "../lib/club-engine.js";
import { MIN_PLAYERS } from "../lib/club-constants.js";

async function loadRoom(client, roomId) {
  const { rows: [room] } = await client.query(
    `SELECT * FROM club_rooms WHERE id = $1`,
    [roomId]
  );
  if (!room) return null;

  const { rows: players } = await client.query(
    `SELECT username, role, status, seat_index, total_score
     FROM club_room_players WHERE room_id = $1 ORDER BY seat_index ASC, username ASC`,
    [roomId]
  );
  return { room, players };
}

async function saveGameState(client, roomId, gameState) {
  await client.query(
    `UPDATE club_rooms SET game_state = $2 WHERE id = $1`,
    [roomId, JSON.stringify(gameState)]
  );

  for (const p of gameState.players) {
    await client.query(
      `UPDATE club_room_players SET total_score = $3 WHERE room_id = $1 AND username = $2`,
      [roomId, p.username, p.score]
    );
  }
}

function parseState(raw) {
  if (!raw) return null;
  if (typeof raw === "string") return JSON.parse(raw);
  return structuredClone(raw);
}

/** Ably has a ~64KB message limit — never broadcast pad images. Clients refetch via GET. */
function slimNotify(roomId, gameState, extra = {}) {
  const active = (gameState?.players || []).filter((p) => p.status === "active");
  return {
    room_id: roomId,
    phase: gameState?.phase || null,
    round: gameState?.round || null,
    host: gameState?.host || null,
    winners: gameState?.winners || [],
    lastEvent: gameState?.lastEvent || null,
    submittedUsernames: Object.keys(gameState?.submissions || {}),
    timerStartedAt: gameState?.timerStartedAt || null,
    scores: Object.fromEntries(active.map((p) => [p.username, p.score])),
    sync: true,
    ...extra,
  };
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const client = await getPool().connect();
  try {
    await ensureClubTables(client);

    if (req.method === "GET") {
      const { room_id, username } = req.query;
      if (!room_id) return res.status(400).json({ error: "room_id required" });

      const data = await loadRoom(client, room_id);
      if (!data) return res.status(404).json({ error: "room not found" });

      const { room, players } = data;
      let view = null;
      if (room.game_state) {
        view = publicState(parseState(room.game_state), username || null);
      }

      return res.status(200).json({
        room: {
          id: room.id,
          status: room.status,
          host_username: room.host_username,
          game_mode: "club",
        },
        players,
        state: view,
      });
    }

    if (req.method === "PATCH") {
      const body = req.body || {};
      const { action, room_id, username } = body;
      if (!action || !room_id || !username) {
        return res.status(400).json({ error: "action, room_id, and username required" });
      }

      const user = username.toLowerCase();
      const data = await loadRoom(client, room_id);
      if (!data) return res.status(404).json({ error: "room not found" });

      const { room, players } = data;

      if (action === "start") {
        if (room.host_username !== user) {
          return res.status(403).json({ error: "Only host can start" });
        }
        if (room.status !== "lobby") {
          return res.status(400).json({ error: "Game already started" });
        }

        const accepted = players.filter(
          (p) => p.status === "accepted" || p.role === "host"
        );
        if (accepted.length < MIN_PLAYERS) {
          return res.status(400).json({
            error: `Need at least ${MIN_PLAYERS} players to start`,
          });
        }

        const pendingInvitees = players.filter((p) => p.status === "invited");

        const usernames = accepted
          .sort((a, b) => (a.seat_index ?? 0) - (b.seat_index ?? 0))
          .map((p) => p.username);

        const gameState = createInitialState(usernames, { host: room.host_username });

        await client.query(
          `UPDATE club_rooms SET status='active', game_state=$2, started_at=NOW() WHERE id=$1`,
          [room_id, JSON.stringify(gameState)]
        );
        await client.query(
          `UPDATE club_room_players SET status='playing'
           WHERE room_id=$1 AND (status='accepted' OR role='host')`,
          [room_id]
        );
        // Withdraw unanswered invites so they don't linger after the game starts.
        if (pendingInvitees.length) {
          await client.query(
            `UPDATE club_room_players SET status='left'
             WHERE room_id=$1 AND status='invited'`,
            [room_id]
          );
          await ablyPublish(LOBBY_CHANNEL, "invite-cancelled", {
            room_id,
            reason: "game_started",
            invitees: pendingInvitees.map((p) => p.username),
          });
        }

        const notify = slimNotify(room_id, gameState);
        await ablyPublish(roomChannel(room_id), "game-start", notify);
        await ablyPublish(roomChannel(room_id), "state-update", notify);

        return res.status(200).json({
          room_id,
          state: publicState(gameState),
          cancelled_invites: pendingInvitees.map((p) => p.username),
        });
      }

      if (!room.game_state) {
        return res.status(400).json({ error: "Game not started" });
      }
      if (room.status !== "active" && action !== "restart" && action !== "set_scores") {
        return res.status(400).json({ error: "Game not active" });
      }

      let gameState = parseState(room.game_state);

      try {
        if (action === "submit_answer") {
          gameState = applyAction(gameState, "submit_answer", user, {
            imageDataUrl: body.imageDataUrl,
          });
        } else if (action === "start_timer") {
          gameState = applyAction(gameState, "start_timer", user);
        } else if (action === "set_judgment") {
          gameState = applyAction(gameState, "set_judgment", user, {
            targetUsername: body.target_username,
            value: body.value === undefined ? null : body.value,
          });
        } else if (action === "submit_judgments") {
          gameState = applyAction(gameState, "submit_judgments", user);
        } else if (action === "end_game") {
          gameState = applyAction(gameState, "end_game", user);
        } else if (action === "set_scores") {
          gameState = applyAction(gameState, "set_scores", user, {
            scores: body.scores || {},
          });
        } else if (action === "restart") {
          if (room.status !== "active" && room.status !== "complete") {
            return res.status(400).json({ error: "Cannot restart this room" });
          }
          gameState = applyAction(gameState, "restart", user);
          await client.query(
            `UPDATE club_rooms SET status='active', ended_at=NULL WHERE id=$1`,
            [room_id]
          );
          await client.query(
            `UPDATE club_room_players SET status='playing', total_score=0
             WHERE room_id=$1 AND username = ANY($2::text[])`,
            [room_id, gameState.players.map((p) => p.username)]
          );
          await saveGameState(client, room_id, gameState);
          const notify = slimNotify(room_id, gameState);
          await ablyPublish(roomChannel(room_id), "state-update", notify);
          await ablyPublish(roomChannel(room_id), "game-restart", notify);
          return res.status(200).json({
            room_id,
            state: publicState(gameState, user),
          });
        } else if (action === "leave") {
          gameState = applyAction(gameState, "leave", user);
          await client.query(
            `UPDATE club_room_players SET status='left' WHERE room_id=$1 AND username=$2`,
            [room_id, user]
          );
          if (gameState.host !== room.host_username) {
            await client.query(
              `UPDATE club_rooms SET host_username=$2 WHERE id=$1`,
              [room_id, gameState.host]
            );
          }
        } else {
          return res.status(400).json({ error: `Unknown action: ${action}` });
        }
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }

      await saveGameState(client, room_id, gameState);

      if (gameState.phase === "game_over") {
        await client.query(
          `UPDATE club_rooms SET status='complete', ended_at=NOW() WHERE id=$1`,
          [room_id]
        );
      }

      const payload = {
        room_id,
        state: publicState(gameState, user),
      };
      // Lightweight Ably ping only — images stay in Postgres / HTTP GET.
      const notify = slimNotify(room_id, gameState);
      await ablyPublish(roomChannel(room_id), "state-update", notify);

      if (action === "leave") {
        await ablyPublish(LOBBY_CHANNEL, "lobby-update", { username: user });
      }

      if (gameState.phase === "game_over") {
        await ablyPublish(roomChannel(room_id), "game-over", notify);
      }

      return res.status(200).json(payload);
    }

    return res.status(405).json({ error: "Method not allowed" });
  } finally {
    client.release();
  }
}
