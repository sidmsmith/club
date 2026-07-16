import { ablyPublish, LOBBY_CHANNEL } from "./ably.js";

export const LOBBY_AVAILABLE_SECONDS = 15;
export const STALE_LOBBY_MINUTES = 30;

export async function abandonStaleLobbyRooms(client) {
  const { rows } = await client.query(
    `UPDATE club_rooms
     SET status = 'abandoned', ended_at = NOW()
     WHERE status = 'lobby'
       AND created_at < NOW() - ($1 || ' minutes')::INTERVAL
     RETURNING id`,
    [String(STALE_LOBBY_MINUTES)]
  );
  for (const row of rows) {
    await ablyPublish(LOBBY_CHANNEL, "room-abandoned", {
      room_id: row.id,
      abandoned_by: "stale",
    });
  }
  return rows.length;
}

export async function retireLobbyUsername(client, username) {
  if (!username) return;
  await client.query(`DELETE FROM club_lobby WHERE username = $1`, [username.toLowerCase()]);
}

export async function isLobbyAvailable(client, username) {
  const u = username.toLowerCase();
  const { rows } = await client.query(
    `
    SELECT
      CASE
        WHEN mp.username IS NOT NULL THEN false
        WHEN l.last_seen > NOW() - ($2 || ' seconds')::INTERVAL THEN true
        ELSE false
      END AS available
    FROM (SELECT $1::text AS username) u
    LEFT JOIN club_lobby l ON l.username = u.username
    LEFT JOIN (
      SELECT DISTINCT fp.username
      FROM club_room_players fp
      JOIN club_rooms fr ON fr.id = fp.room_id
      WHERE fr.status = 'active' AND fp.status = 'playing'
    ) mp ON mp.username = u.username
    `,
    [u, String(LOBBY_AVAILABLE_SECONDS)]
  );
  return !!rows[0]?.available;
}

export async function assertInviteesAvailable(client, invitees) {
  const offline = [];
  for (const name of invitees) {
    if (!(await isLobbyAvailable(client, name))) offline.push(name);
  }
  if (!offline.length) return null;
  return `Not available right now: ${offline.map((n) => n.toUpperCase()).join(", ")}`;
}
