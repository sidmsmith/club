import { getPool, cors, ensureClubTables } from "./db.js";
import { ablyPublish, LOBBY_CHANNEL } from "./ably.js";
import {
  LOBBY_AVAILABLE_SECONDS,
  abandonStaleLobbyRooms,
  retireLobbyUsername,
} from "./club-lobby-util.js";

const availableInterval = `${LOBBY_AVAILABLE_SECONDS} seconds`;

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const client = await getPool().connect();
  try {
    await ensureClubTables(client);
    await abandonStaleLobbyRooms(client);

    if (req.method === "POST") {
      const { username, previous_username, leave } = req.body || {};
      if (!username) return res.status(400).json({ error: "username required" });
      const u = username.toLowerCase();
      const prev = previous_username ? String(previous_username).toLowerCase() : null;

      if (leave) {
        await retireLobbyUsername(client, u);
        await ablyPublish(LOBBY_CHANNEL, "lobby-update", { username: u, left: true });
        return res.status(200).json({ ok: true });
      }

      if (prev && prev !== u) {
        await retireLobbyUsername(client, prev);
      }

      await client.query(
        `INSERT INTO club_lobby (username, last_seen) VALUES ($1, NOW())
         ON CONFLICT (username) DO UPDATE SET last_seen = NOW()`,
        [u]
      );

      await ablyPublish(LOBBY_CHANNEL, "lobby-update", { username: u, previous_username: prev });
      return res.status(200).json({ ok: true });
    }

    if (req.method === "GET") {
      const { rows } = await client.query(
        `
        SELECT
          u.username,
          CASE
            WHEN busy.username IS NOT NULL THEN 'playing'
            WHEN l.last_seen > NOW() - $1::INTERVAL THEN 'available'
            ELSE 'offline'
          END AS status
        FROM (
          SELECT username FROM club_lobby
        ) u
        LEFT JOIN club_lobby l ON l.username = u.username
        LEFT JOIN (
          SELECT DISTINCT fp.username
          FROM club_room_players fp
          JOIN club_rooms fr ON fr.id = fp.room_id
          WHERE fr.status IN ('lobby', 'active')
            AND fp.status NOT IN ('left', 'declined')
        ) busy ON busy.username = u.username
        ORDER BY
          CASE
            WHEN busy.username IS NULL AND l.last_seen > NOW() - $1::INTERVAL THEN 0
            WHEN busy.username IS NOT NULL THEN 1
            ELSE 2
          END,
          u.username ASC
        `,
        [availableInterval]
      );
      return res.status(200).json({ players: rows });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } finally {
    client.release();
  }
}
