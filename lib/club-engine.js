/**
 * Club — judge-scored drawing-pad game (server-authoritative).
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

export function createInitialState(usernames, options = {}) {
  const names = [...new Set(usernames.map((u) => String(u).toLowerCase()))];
  if (names.length < 1) throw new Error("At least one player required.");

  const judge = (options.judge || names[0]).toLowerCase();
  if (!names.includes(judge)) {
    throw new Error("Judge must be one of the players.");
  }

  return {
    gameMode: "club",
    phase: "answer",
    round: 1,
    judge,
    players: names.map((username, seat) => ({
      username,
      score: 0,
      status: "active",
      seat,
    })),
    submissions: {},
    judgments: {},
    winners: [],
    lastEvent: { type: "game_start" },
  };
}

function assertPlayerActive(state, username) {
  const p = state.players.find((x) => x.username === username);
  if (!p || p.status !== "active") throw new Error("Player is not in this game.");
  return p;
}

function clearRound(state) {
  state.submissions = {};
  state.judgments = {};
}

export function applyAction(state, action, username, payload = {}) {
  const user = String(username).toLowerCase();
  const next = structuredClone(state);

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
    next.submissions[user] = { imageDataUrl };
    next.lastEvent = { type: "submit_answer", username: user };
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

  if (action === "pass") {
    throw new Error("Pass is not available yet.");
  }

  if (action === "set_judgment") {
    if (next.phase !== "judging") throw new Error("Not in judging phase.");
    if (next.judge !== user) throw new Error("Only the judge can score.");
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
    if (next.judge !== user) throw new Error("Only the judge can submit scores.");
    for (const p of activePlayers(next)) {
      const j = next.judgments[p.username];
      if (j !== "correct" && j !== "incorrect") {
        throw new Error("All answers must be marked correct or incorrect.");
      }
    }
    for (const p of activePlayers(next)) {
      if (next.judgments[p.username] === "correct") p.score += 1;
    }
    next.round += 1;
    clearRound(next);
    next.phase = "answer";
    next.lastEvent = { type: "round_scored" };
    return next;
  }

  if (action === "end_game") {
    if (next.judge !== user) throw new Error("Only the judge can end the game.");
    if (next.phase === "game_over") throw new Error("Game already over.");
    next.phase = "game_over";
    next.winners = computeWinners(next);
    next.lastEvent = { type: "game_over", winners: next.winners };
    return next;
  }

  if (action === "restart") {
    if (next.judge !== user) throw new Error("Only the judge can restart.");
    const active = activePlayers(next).map((p) => p.username);
    if (active.length < 2) throw new Error("Need at least 2 players to restart.");
    const judge = active.includes(next.judge) ? next.judge : active[0];
    return createInitialState(active, { judge });
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

    if (next.judge === user) {
      next.judge = remaining.sort((a, b) => a.seat - b.seat)[0].username;
      next.lastEvent = { type: "judge_changed", judge: next.judge, left: user };
    }

    if (next.phase === "answer" && allActiveSubmitted(next)) {
      next.phase = "judging";
      next.judgments = {};
      for (const pl of remaining) next.judgments[pl.username] = null;
    } else if (next.phase === "judging") {
      // Drop left player's judgment slot; keep others.
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
    judge: state.judge,
    players: state.players.map((p) => ({
      username: p.username,
      score: p.score,
      status: p.status,
      seat: p.seat,
      hasSubmitted: !!state.submissions[p.username],
    })),
    submittedUsernames: submitted,
    submissions: state.phase === "judging" || state.phase === "game_over"
      ? { ...state.submissions }
      : me && state.submissions[me]
        ? { [me]: state.submissions[me] }
        : {},
    judgments: { ...(state.judgments || {}) },
    winners: state.winners || [],
    lastEvent: state.lastEvent,
    youAreJudge: me ? me === state.judge : false,
  };
}
