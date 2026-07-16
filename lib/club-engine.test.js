import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createInitialState, applyAction, publicState } from "./club-engine.js";

describe("club-engine", () => {
  it("creates answer phase with host", () => {
    const s = createInitialState(["alice", "bob"], { host: "alice" });
    assert.equal(s.phase, "answer");
    assert.equal(s.host, "alice");
    assert.equal(s.round, 1);
  });

  it("allows resubmit and advances when all submitted", () => {
    let s = createInitialState(["alice", "bob"], { host: "alice" });
    s = applyAction(s, "submit_answer", "alice", { imageDataUrl: "data:img,a1" });
    assert.equal(s.phase, "answer");
    s = applyAction(s, "submit_answer", "alice", { imageDataUrl: "data:img,a2" });
    assert.equal(s.submissions.alice.imageDataUrl, "data:img,a2");
    assert.equal(s.phase, "answer");
    s = applyAction(s, "submit_answer", "bob", { imageDataUrl: "data:img,b1" });
    assert.equal(s.phase, "judging");
  });

  it("scores correct answers and starts next round", () => {
    let s = createInitialState(["alice", "bob"], { host: "alice" });
    s = applyAction(s, "submit_answer", "alice", { imageDataUrl: "data:a" });
    s = applyAction(s, "submit_answer", "bob", { imageDataUrl: "data:b" });
    s = applyAction(s, "set_judgment", "alice", {
      targetUsername: "alice",
      value: "correct",
    });
    s = applyAction(s, "set_judgment", "alice", {
      targetUsername: "bob",
      value: "incorrect",
    });
    s = applyAction(s, "submit_judgments", "alice");
    assert.equal(s.phase, "answer");
    assert.equal(s.round, 2);
    assert.equal(s.players.find((p) => p.username === "alice").score, 1);
    assert.equal(s.players.find((p) => p.username === "bob").score, 0);
  });

  it("leave continues for others and may advance phase", () => {
    let s = createInitialState(["alice", "bob", "carol"], { host: "alice" });
    s = applyAction(s, "submit_answer", "alice", { imageDataUrl: "data:a" });
    s = applyAction(s, "submit_answer", "bob", { imageDataUrl: "data:b" });
    s = applyAction(s, "leave", "carol");
    assert.equal(s.phase, "judging");
    assert.equal(s.players.find((p) => p.username === "carol").status, "left");
  });

  it("end_game and restart", () => {
    let s = createInitialState(["alice", "bob"], { host: "alice" });
    s.players[0].score = 3;
    s = applyAction(s, "end_game", "alice");
    assert.equal(s.phase, "game_over");
    assert.deepEqual(s.winners, ["alice"]);
    s = applyAction(s, "restart", "alice");
    assert.equal(s.phase, "answer");
    assert.equal(s.round, 1);
    assert.equal(s.players[0].score, 0);
  });

  it("publicState hides others pads during answer", () => {
    let s = createInitialState(["alice", "bob"], { host: "alice" });
    s = applyAction(s, "submit_answer", "alice", { imageDataUrl: "data:a" });
    const view = publicState(s, "bob");
    assert.equal(Object.keys(view.submissions).length, 0);
    assert.equal(view.players.find((p) => p.username === "alice").hasSubmitted, true);
    assert.equal(view.youAreHost, false);
    assert.equal(publicState(s, "alice").youAreHost, true);
  });

  it("host can set scores", () => {
    let s = createInitialState(["alice", "bob"], { host: "alice" });
    s = applyAction(s, "set_scores", "alice", { scores: { alice: 5, bob: 2 } });
    assert.equal(s.players.find((p) => p.username === "alice").score, 5);
    assert.equal(s.players.find((p) => p.username === "bob").score, 2);
    assert.throws(() =>
      applyAction(s, "set_scores", "bob", { scores: { alice: 0, bob: 0 } })
    );
  });
});
