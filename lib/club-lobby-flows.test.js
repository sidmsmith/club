/**
 * End-to-end lobby / invite scenario simulations against Neon.
 * Ably is mocked (CLUB_ABLY_MOCK=1) so we assert published events without a live Ably account.
 *
 * Setup: copy `.env.example` → `.env.local` and set NEON_DATABASE_URL.
 * Run from the club/ folder: npm run test:lobby
 */
import "./load-env.js";
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getPool, ensureClubTables } from "../api/db.js";
import { clearAblyMockMessages, getAblyMockMessages, LOBBY_CHANNEL } from "../api/ably.js";
import roomHandler from "../api/club-room.js";
import gameHandler from "../api/club-game.js";
import heartbeatHandler from "../api/club-heartbeat.js";

process.env.CLUB_ABLY_MOCK = "1";

const hasDb = !!process.env.NEON_DATABASE_URL;
const describeLobby = hasDb ? describe : describe.skip;

function mockRes() {
  const out = { statusCode: 200, body: null, headers: {} };
  const res = {
    setHeader(k, v) {
      out.headers[k] = v;
    },
    status(code) {
      out.statusCode = code;
      return res;
    },
    json(body) {
      out.body = body;
      return res;
    },
    end() {
      return res;
    },
  };
  res._out = out;
  return res;
}

async function call(handler, { method, body, query } = {}) {
  const req = {
    method: method || "GET",
    body: body || {},
    query: query || {},
  };
  const res = mockRes();
  await handler(req, res);
  return res._out;
}

async function heartbeat(username) {
  return call(heartbeatHandler, {
    method: "POST",
    body: { username },
  });
}

async function leaveLobby(username) {
  return call(heartbeatHandler, {
    method: "POST",
    body: { username, leave: true },
  });
}

async function presence() {
  return call(heartbeatHandler, { method: "GET" });
}

async function wipeClubTables() {
  const client = await getPool().connect();
  try {
    await ensureClubTables(client);
    await client.query(
      `TRUNCATE club_lobby, club_room_players, club_rooms, club_games RESTART IDENTITY CASCADE`
    );
  } finally {
    client.release();
  }
}

function statusByUser(players) {
  const m = {};
  for (const p of players || []) m[p.username] = p.status;
  return m;
}

describeLobby("club lobby invite scenarios", () => {
  before(async () => {
    await wipeClubTables();
  });

  after(async () => {
    await wipeClubTables();
    await getPool().end();
  });

  beforeEach(async () => {
    await wipeClubTables();
    clearAblyMockMessages();
  });

  it("Sidney invites Parker; Parker accepts; presence shows Host/Ready/Available for Caroline", async () => {
    await heartbeat("sidney");
    await heartbeat("parker");
    await heartbeat("caroline");

    const created = await call(roomHandler, {
      method: "POST",
      body: { username: "sidney", invitees: ["parker"] },
    });
    assert.equal(created.statusCode, 200);
    assert.ok(created.body.room_id);
    const roomId = created.body.room_id;

    const invites = getAblyMockMessages().filter(
      (m) => m.name === "invite" && m.data.invitee === "parker"
    );
    assert.equal(invites.length, 1);

    const accepted = await call(roomHandler, {
      method: "PATCH",
      body: { action: "accept", room_id: roomId, username: "parker" },
    });
    assert.equal(accepted.statusCode, 200);

    const room = await call(roomHandler, {
      method: "GET",
      query: { room_id: roomId },
    });
    const by = statusByUser(room.body.players);
    assert.equal(by.sidney, "accepted");
    assert.equal(by.parker, "accepted");

    const list = await presence();
    const map = Object.fromEntries(
      (list.body.players || []).map((p) => [p.username, p.status])
    );
    assert.equal(map.sidney, "host");
    assert.equal(map.parker, "ready");
    assert.equal(map.caroline, "available");
  });

  it("decline returns host to empty lobby room that can re-invite after abandon path", async () => {
    await heartbeat("sidney");
    await heartbeat("parker");

    const created = await call(roomHandler, {
      method: "POST",
      body: { username: "sidney", invitees: ["parker"] },
    });
    const roomId = created.body.room_id;

    const declined = await call(roomHandler, {
      method: "PATCH",
      body: { action: "decline", room_id: roomId, username: "parker" },
    });
    assert.equal(declined.statusCode, 200);

    const room = await call(roomHandler, {
      method: "GET",
      query: { room_id: roomId },
    });
    const by = statusByUser(room.body.players);
    assert.equal(by.parker, "declined");

    // No pending invites / accepted guests → UI would abandon; simulate abandon.
    const abandoned = await call(roomHandler, {
      method: "PATCH",
      body: { action: "abandon", room_id: roomId, username: "sidney" },
    });
    assert.equal(abandoned.statusCode, 200);
    assert.ok(
      getAblyMockMessages().some(
        (m) => m.channel === LOBBY_CHANNEL && m.name === "room-abandoned"
      )
    );

    // Parker is available again and can be invited into a new room.
    await heartbeat("parker");
    const again = await call(roomHandler, {
      method: "POST",
      body: { username: "sidney", invitees: ["parker"] },
    });
    assert.equal(again.statusCode, 200);
    assert.notEqual(again.body.room_id, roomId);
  });

  it("re-invite declined player into same open lobby via invite action", async () => {
    await heartbeat("sidney");
    await heartbeat("parker");
    await heartbeat("caroline");

    const created = await call(roomHandler, {
      method: "POST",
      body: { username: "sidney", invitees: ["parker"] },
    });
    const roomId = created.body.room_id;
    await call(roomHandler, {
      method: "PATCH",
      body: { action: "accept", room_id: roomId, username: "parker" },
    });

    await call(roomHandler, {
      method: "PATCH",
      body: { action: "invite", room_id: roomId, username: "sidney", invitees: ["caroline"] },
    });
    await call(roomHandler, {
      method: "PATCH",
      body: { action: "decline", room_id: roomId, username: "caroline" },
    });

    clearAblyMockMessages();
    const reinv = await call(roomHandler, {
      method: "PATCH",
      body: { action: "invite", room_id: roomId, username: "sidney", invitees: ["caroline"] },
    });
    assert.equal(reinv.statusCode, 200);
    const by = statusByUser(reinv.body.players);
    assert.equal(by.caroline, "invited");
    assert.ok(
      getAblyMockMessages().some(
        (m) => m.name === "invite" && m.data.invitee === "caroline"
      )
    );
  });

  it("starting the game withdraws pending invites and publishes invite-cancelled", async () => {
    await heartbeat("sidney");
    await heartbeat("parker");
    await heartbeat("caroline");

    const created = await call(roomHandler, {
      method: "POST",
      body: { username: "sidney", invitees: ["parker"] },
    });
    const roomId = created.body.room_id;
    await call(roomHandler, {
      method: "PATCH",
      body: { action: "accept", room_id: roomId, username: "parker" },
    });
    await call(roomHandler, {
      method: "PATCH",
      body: { action: "invite", room_id: roomId, username: "sidney", invitees: ["caroline"] },
    });

    clearAblyMockMessages();
    const started = await call(gameHandler, {
      method: "PATCH",
      body: { action: "start", room_id: roomId, username: "sidney" },
    });
    assert.equal(started.statusCode, 200);
    assert.deepEqual(started.body.cancelled_invites, ["caroline"]);
    assert.ok(started.body.state);
    assert.ok(
      getAblyMockMessages().some(
        (m) =>
          m.channel === LOBBY_CHANNEL &&
          m.name === "invite-cancelled" &&
          m.data.reason === "game_started"
      )
    );

    const room = await call(roomHandler, {
      method: "GET",
      query: { room_id: roomId },
    });
    assert.equal(room.body.room.status, "active");
    const by = statusByUser(room.body.players);
    assert.equal(by.sidney, "playing");
    assert.equal(by.parker, "playing");
    assert.equal(by.caroline, "left");

    // Accept after start must fail.
    const lateAccept = await call(roomHandler, {
      method: "PATCH",
      body: { action: "accept", room_id: roomId, username: "caroline" },
    });
    assert.equal(lateAccept.statusCode, 400);

    // Active-game players are hidden from lobby presence.
    await leaveLobby("sidney");
    await leaveLobby("parker");
    await heartbeat("caroline");
    const list = await presence();
    const names = (list.body.players || []).map((p) => p.username);
    assert.ok(!names.includes("sidney"));
    assert.ok(!names.includes("parker"));
    assert.ok(names.includes("caroline"));
  });

  it("cannot invite someone who is already in another lobby room", async () => {
    await heartbeat("sidney");
    await heartbeat("parker");
    await heartbeat("caroline");

    const a = await call(roomHandler, {
      method: "POST",
      body: { username: "sidney", invitees: ["parker"] },
    });
    assert.equal(a.statusCode, 200);
    await call(roomHandler, {
      method: "PATCH",
      body: { action: "accept", room_id: a.body.room_id, username: "parker" },
    });

    const b = await call(roomHandler, {
      method: "POST",
      body: { username: "caroline", invitees: ["parker"] },
    });
    assert.equal(b.statusCode, 400);
    assert.match(b.body.error || "", /not available/i);
  });

  it("pending invites list only while room is still lobby + invited", async () => {
    await heartbeat("sidney");
    await heartbeat("parker");

    const created = await call(roomHandler, {
      method: "POST",
      body: { username: "sidney", invitees: ["parker"] },
    });
    const roomId = created.body.room_id;

    const pending = await call(roomHandler, {
      method: "GET",
      query: { username: "parker" },
    });
    assert.equal(pending.body.room_id, null);
    assert.equal(pending.body.pending_invites.length, 1);
    assert.equal(pending.body.pending_invites[0].room_id, roomId);

    await call(roomHandler, {
      method: "PATCH",
      body: { action: "accept", room_id: roomId, username: "parker" },
    });
    await call(gameHandler, {
      method: "PATCH",
      body: { action: "start", room_id: roomId, username: "sidney" },
    });

    const after = await call(roomHandler, {
      method: "GET",
      query: { username: "parker" },
    });
    assert.equal(after.body.pending_invites.length, 0);
    assert.equal(after.body.room?.status, "active");
  });
});
