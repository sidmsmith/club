/**
 * Club — host-scored drawing-pad game (server-authoritative).
 */

function activePlayers(state) {
  return state.players.filter((p) => p.status === "active");
}

function allActiveSubmitted(state) {
  const active = activePlayers(state);
  return active.length > 0 && active.every((p) => !!state.submissions[p.username]);
}

function computeWinners(state) {
  const active = activePlayers(state);
  if (!active.length) return [];
  const max = Math.max(...active.map((p) => p.score));
  return active.filter((p) => p.score === max).map((p) => p.username);
}

function nowMs(payload) {
  const n = Number(payload?.now);
  return Number.isFinite(n) ? n : Date.now();
}

function archiveRoundTimes(state) {
  const times = {};
  for (const [u, sub] of Object.entries(state.submissions || {})) {
    if (sub && sub.elapsedMs != null) times[u] = sub.elapsedMs;
  }
  if (!Object.keys(times).length) return;
  if (!Array.isArray(state.roundHistory)) state.roundHistory = [];
  state.roundHistory.push({
    round: state.round,
    timerStartedAt: state.timerStartedAt || null,
    timerStartedBy: state.timerStartedBy || null,
    times,
  });
}

function clearRound(state) {
  state.submissions = {};
  state.judgments = {};
  state.timerStartedAt = null;
  state.timerStartedBy = null;
}

export function createInitialState(usernames, options = {}) {
  const names = [...new Set(usernames.map((u) => String(u).toLowerCase()))];
  if (names.length < 1) throw new Error("At least one player required.");

  const host = (options.host || names[0]).toLowerCase();
  if (!names.includes(host)) {
    throw new Error("Host must be one of the players.");
  }

  return {
    gameMode: "club",
    phase: "answer",
    round: 1,
    host,
    players: names.map((username, seat) => ({
      username,
      score: 0,
      status: "active",
      seat,
    })),
    submissions: {},
    judgments: {},
    timerStartedAt: null,
    timerStartedBy: null,
    roundHistory: [],
    winners: [],
    lastEvent: { type: "game_start" },
  };
}

function assertPlayerActive(state, username) {
  const p = state.players.find((x) => x.username === username);
  if (!p || p.status !== "active") throw new Error("Player is not in this game.");
  return p;
}

export function applyAction(state, action, username, payload = {}) {
  const user = String(username).toLowerCase();
  const next = structuredClone(state);
  const now = nowMs(payload);

  if (action === "start_timer") {
    if (next.phase !== "answer") throw new Error("Timer only starts during answering.");
    assertPlayerActive(next, user);
    if (next.timerStartedAt) throw new Error("Timer already started.");
    next.timerStartedAt = now;
    next.timerStartedBy = user;
    next.lastEvent = { type: "timer_started", username: user, timerStartedAt: now };
    return next;
  }

  if (action === "submit_answer") {
    if (next.phase !== "answer") throw new Error("Not accepting answers.");
    assertPlayerActive(next, user);
    const imageDataUrl = payload.imageDataUrl;
    if (!imageDataUrl || typeof imageDataUrl !== "string") {
      throw new Error("imageDataUrl required.");
    }
    if (imageDataUrl.length > 1_500_000) {
      throw new Error("Image too large.");
    }
    let elapsedMs = null;
    if (next.timerStartedAt) {
      elapsedMs = Math.max(0, Math.floor(now - next.timerStartedAt));
    }
    next.submissions[user] = { imageDataUrl, elapsedMs };
    next.lastEvent = { type: "submit_answer", username: user, elapsedMs };
    if (allActiveSubmitted(next)) {
      next.phase = "judging";
      next.judgments = {};
      for (const p of activePlayers(next)) {
        next.judgments[p.username] = null;
      }
      next.lastEvent = { type: "judging_start" };
    }
    return next;
  }

  if (action === "clear_answer") {
    if (next.phase !== "answer") throw new Error("Can only clear during answering.");
    assertPlayerActive(next, user);
    delete next.submissions[user];
    next.lastEvent = { type: "clear_answer", username: user };
    return next;
  }

  if (action === "pass") {
    throw new Error("Pass is not available yet.");
  }

  if (action === "set_judgment") {
    if (next.phase !== "judging") throw new Error("Not in judging phase.");
    if (next.host !== user) throw new Error("Only the host can score.");
    const target = String(payload.targetUsername || "").toLowerCase();
    assertPlayerActive(next, target);
    const value = payload.value;
    if (value !== "correct" && value !== "incorrect" && value !== null) {
      throw new Error("value must be correct, incorrect, or null.");
    }
    next.judgments[target] = value;
    next.lastEvent = { type: "set_judgment", target, value };
    return next;
  }

  if (action === "submit_judgments") {
    if (next.phase !== "judging") throw new Error("Not in judging phase.");
    if (next.host !== user) throw new Error("Only the host can submit scores.");
    for (const p of activePlayers(next)) {
      const j = next.judgments[p.username];
      if (j !== "correct" && j !== "incorrect") {
        throw new Error("All answers must be marked correct or incorrect.");
      }
    }
    for (const p of activePlayers(next)) {
      if (next.judgments[p.username] === "correct") p.score += 1;
    }
    archiveRoundTimes(next);
    next.round += 1;
    clearRound(next);
    next.phase = "answer";
    next.lastEvent = { type: "round_scored" };
    return next;
  }

  if (action === "end_game") {
    if (next.host !== user) throw new Error("Only the host can end the game.");
    if (next.phase === "game_over") throw new Error("Game already over.");
    if (next.phase === "judging" || Object.keys(next.submissions || {}).length) {
      archiveRoundTimes(next);
    }
    next.phase = "game_over";
    next.winners = computeWinners(next);
    next.lastEvent = { type: "game_over", winners: next.winners };
    return next;
  }

  if (action === "set_scores") {
    if (next.host !== user) throw new Error("Only the host can update scores.");
    const scores = payload.scores;
    if (!scores || typeof scores !== "object") {
      throw new Error("scores object required.");
    }
    for (const p of activePlayers(next)) {
      if (!(p.username in scores)) continue;
      const n = Number(scores[p.username]);
      if (!Number.isFinite(n) || n < 0 || n > 9999) {
        throw new Error(`Invalid score for ${p.username}.`);
      }
      p.score = Math.floor(n);
    }
    next.lastEvent = { type: "set_scores" };
    return next;
  }

  if (action === "restart") {
    if (next.host !== user) throw new Error("Only the host can restart.");
    const active = activePlayers(next).map((p) => p.username);
    if (active.length < 2) throw new Error("Need at least 2 players to restart.");
    const host = active.includes(next.host) ? next.host : active[0];
    return createInitialState(active, { host });
  }

  if (action === "leave") {
    const p = next.players.find((x) => x.username === user);
    if (!p || p.status !== "active") throw new Error("Player is not in this game.");
    p.status = "left";
    delete next.submissions[user];
    delete next.judgments[user];
    next.lastEvent = { type: "leave", username: user };

    const remaining = activePlayers(next);
    if (remaining.length < 2) {
      next.phase = "game_over";
      next.winners = computeWinners(next);
      next.lastEvent = { type: "game_over", winners: next.winners, reason: "not_enough_players" };
      return next;
    }

    if (next.host === user) {
      next.host = remaining.sort((a, b) => a.seat - b.seat)[0].username;
      next.lastEvent = { type: "host_changed", host: next.host, left: user };
    }

    if (next.phase === "answer" && allActiveSubmitted(next)) {
      next.phase = "judging";
      next.judgments = {};
      for (const pl of remaining) next.judgments[pl.username] = null;
    } else if (next.phase === "judging") {
      for (const pl of remaining) {
        if (!(pl.username in next.judgments)) next.judgments[pl.username] = null;
      }
    }

    return next;
  }

  throw new Error(`Unknown action: ${action}`);
}

/** Public view — full pads visible to everyone during judging. */
export function publicState(state, forUsername = null) {
  if (!state) return null;
  const me = forUsername ? String(forUsername).toLowerCase() : null;
  const submitted = Object.keys(state.submissions || {});

  return {
    gameMode: "club",
    phase: state.phase,
    round: state.round,
    host: state.host,
    timerStartedAt: state.timerStartedAt || null,
    timerStartedBy: state.timerStartedBy || null,
    serverNow: Date.now(),
    players: state.players.map((p) => ({
      username: p.username,
      score: p.score,
      status: p.status,
      seat: p.seat,
      hasSubmitted: !!state.submissions[p.username],
      elapsedMs: state.submissions[p.username]?.elapsedMs ?? null,
    })),
    submittedUsernames: submitted,
    submissions: state.phase === "judging" || state.phase === "game_over"
      ? { ...state.submissions }
      : me && state.submissions[me]
        ? { [me]: state.submissions[me] }
        : {},
    judgments: { ...(state.judgments || {}) },
    roundHistory: state.roundHistory || [],
    winners: state.winners || [],
    lastEvent: state.lastEvent,
    youAreHost: me ? me === state.host : false,
  };
}
