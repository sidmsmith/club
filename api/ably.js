export async function ablyPublish(channel, eventName, data) {
  const key = process.env.ABLY_API_KEY;
  if (!key) return;
  try {
    await fetch(`https://rest.ably.io/channels/${encodeURIComponent(channel)}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(key).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: eventName, data: JSON.stringify(data) }),
    });
  } catch (_) {}
}

export const LOBBY_CHANNEL = "club-lobby";

export function roomChannel(roomId) {
  return `club-room-${roomId}`;
}
