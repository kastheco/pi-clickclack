import assert from "node:assert/strict";
import test from "node:test";

import { toConversationId, toMessageId, toProjectAlias, toTurnId } from "../types.js";
import { StateStore } from "./store.js";

function bindingFixture(store: StateStore) {
  return store.upsertBinding({
    conversationType: "channel",
    conversationId: toConversationId("chn_test"),
    projectAlias: toProjectAlias("main"),
    invocationMode: "mention",
  });
}

test("cursor updates are monotonic and source-message claims reject duplicates", () => {
  const store = new StateStore(":memory:");
  try {
    assert.equal(store.advanceRealtimeCursor("cur_200"), true);
    assert.equal(store.advanceRealtimeCursor("cur_100"), false);
    assert.equal(store.advanceRealtimeCursor("cur_200"), false);
    assert.equal(store.getRealtimeCursor(), "cur_200");

    const messageId = toMessageId("msg_source");
    const first = store.claimSourceMessage({ messageId, eventId: "evt_1", eventCursor: "cur_200" });
    const replay = store.claimSourceMessage({ messageId, eventId: "evt_replay", eventCursor: "cur_300" });
    assert.equal(first.claimed, true);
    assert.equal(replay.claimed, false);
    assert.equal(replay.claim.eventId, "evt_1");
    assert.equal(replay.claim.eventCursor, "cur_200");
  } finally {
    store.close();
  }
});

test("bindings upsert and keep one active Pi session", () => {
  const store = new StateStore(":memory:");
  try {
    const binding = bindingFixture(store);
    const updated = store.upsertBinding({
      conversationType: "channel",
      conversationId: toConversationId("chn_test"),
      projectAlias: toProjectAlias("secondary"),
      invocationMode: "always",
    });
    assert.equal(updated.id, binding.id);
    assert.equal(updated.projectAlias, "secondary");
    assert.equal(updated.invocationMode, "always");

    const first = store.setActivePiSession({
      bindingId: binding.id,
      sessionId: "session-1",
      sessionFile: "/sessions/one.jsonl",
    });
    const second = store.setActivePiSession({
      bindingId: binding.id,
      sessionId: "session-2",
      sessionFile: "/sessions/two.jsonl",
    });
    assert.notEqual(second.id, first.id);
    assert.equal(store.getActivePiSession(binding.id)?.sessionId, "session-2");
    const archived = store.database
      .prepare("SELECT archived_at FROM pi_session_references WHERE session_id = 'session-1'")
      .get() as { archived_at: string | null };
    assert.equal(typeof archived.archived_at, "string");
    assert.equal(store.archiveActivePiSession(binding.id), true);
    assert.equal(store.getActivePiSession(binding.id), undefined);
    assert.deepEqual(
      store.listArchivedPiSessions(binding.id).map((reference) => reference.sessionId),
      ["session-2", "session-1"],
    );
    const restored = store.restorePiSession(binding.id, second.id);
    assert.equal(restored.sessionId, "session-2");
    assert.equal(store.getActivePiSession(binding.id)?.sessionId, "session-2");
    assert.deepEqual(
      store.listArchivedPiSessions(binding.id).map((reference) => reference.sessionId),
      ["session-1"],
    );
    assert.equal(store.archiveActivePiSession(binding.id), true);
    assert.equal(store.archiveActivePiSession(binding.id), false);
  } finally {
    store.close();
  }
});

test("active turns use compare-and-set transitions", () => {
  const store = new StateStore(":memory:");
  try {
    const binding = bindingFixture(store);
    const sourceMessageId = toMessageId("msg_turn_source");
    store.claimSourceMessage({ messageId: sourceMessageId });
    const turnId = toTurnId("turn_test");
    const turn = store.startActiveTurn({ turnId, bindingId: binding.id, sourceMessageId });
    assert.equal(turn.status, "starting");
    assert.equal(store.transitionActiveTurn(turnId, "running", "stopping"), false);
    assert.equal(store.transitionActiveTurn(turnId, "starting", "running"), true);
    assert.equal(store.transitionActiveTurn(turnId, "starting", "stopping"), false);
    assert.throws(() => store.transitionActiveTurn(turnId, "stopping", "running"), /invalid active-turn transition/u);
    assert.equal(store.transitionActiveTurn(turnId, "running", "stopping"), true);
    assert.equal(store.finishActiveTurn(turnId, "stopping"), true);
    assert.equal(store.getActiveTurn(turnId), undefined);

    const interruptedMessageId = toMessageId("msg_interrupted_source");
    store.claimSourceMessage({ messageId: interruptedMessageId });
    store.setActivePiSession({
      bindingId: binding.id,
      sessionId: "interrupted-session",
      sessionFile: "/sessions/interrupted.jsonl",
    });
    const interruptedTurnId = toTurnId("turn_interrupted");
    store.startActiveTurn({ turnId: interruptedTurnId, bindingId: binding.id, sourceMessageId: interruptedMessageId });
    assert.equal(store.recoverInterruptedTurns(), 1);
    assert.equal(store.getActiveTurn(interruptedTurnId), undefined);
    assert.equal(store.getActivePiSession(binding.id), undefined);
    assert.equal(store.recoverInterruptedTurns(), 0);
  } finally {
    store.close();
  }
});

test("pending interactions fail closed until correlated", () => {
  const store = new StateStore(":memory:");
  try {
    const binding = bindingFixture(store);
    const sourceMessageId = toMessageId("msg_interactive_source");
    store.claimSourceMessage({ messageId: sourceMessageId });
    const turnId = toTurnId("turn_interactive");
    store.startActiveTurn({ turnId, bindingId: binding.id, sourceMessageId });
    store.transitionActiveTurn(turnId, "starting", "running");

    const request = store.createInteractiveRequest({
      requestId: "request-1",
      turnId,
      kind: "selection",
      promptMessageId: toMessageId("msg_prompt"),
    });
    assert.equal(request.status, "pending");
    assert.throws(() => store.finishActiveTurn(turnId, "running"), /pending interactive request/u);
    assert.throws(
      () => store.completeInteractiveRequest({ requestId: "request-1", status: "resolved" }),
      /require a response message ID/u,
    );
    assert.equal(
      store.completeInteractiveRequest({
        requestId: "request-1",
        status: "resolved",
        responseMessageId: toMessageId("msg_response"),
      }),
      true,
    );
    assert.equal(store.completeInteractiveRequest({ requestId: "request-1", status: "timed_out" }), false);
    assert.equal(store.finishActiveTurn(turnId, "running"), true);
  } finally {
    store.close();
  }
});

test("outbound nonces track uncertain creates through reconciliation", () => {
  const store = new StateStore(":memory:");
  try {
    const reserved = store.reserveOutbound({
      nonce: "nonce-1",
      targetType: "channel",
      targetId: "chn_test",
      messageKind: "message",
      body: "a durable final answer",
      turnId: toTurnId("turn_outbound"),
    });
    assert.equal(reserved.status, "pending");
    assert.equal(reserved.bodySha256.length, 64);
    assert.equal(store.transitionOutbound({ nonce: "nonce-1", expected: "pending", next: "uncertain" }), true);
    assert.equal(
      store.transitionOutbound({
        nonce: "nonce-1",
        expected: "uncertain",
        next: "reconciled",
        messageId: toMessageId("msg_created"),
      }),
      true,
    );
    const reconciled = store.getOutbound("nonce-1");
    assert.equal(reconciled?.status, "reconciled");
    assert.equal(reconciled?.messageId, "msg_created");
    assert.equal(reconciled?.attempts, 2);
    assert.deepEqual(store.listOutboundByStatus("reconciled").map((row) => row.nonce), ["nonce-1"]);
  } finally {
    store.close();
  }
});


test("steering receipt and source claim commit atomically; duplicate claims cannot change identity", () => {
  const store = new StateStore(":memory:");
  try {
    const binding = bindingFixture(store);
    const messageId = toMessageId("steering-source");
    const steering = {
      bindingId: binding.id, sessionId: "session-a", turnId: toTurnId("turn-a"), projectAlias: "main",
      authorId: "owner", workspaceId: "workspace", botId: "bot",
    };
    assert.throws(() => store.claimSourceMessage({ messageId, steering: { ...steering, bindingId: 999 } }), /FOREIGN KEY/);
    assert.equal(store.getSourceMessageClaim(messageId), undefined, "failed receipt rolls claim back");
    assert.equal(store.claimSourceMessage({ messageId, steering }).claimed, true);
    assert.equal(store.claimSourceMessage({ messageId, steering: { ...steering, sessionId: "wrong-session" } }).claimed, false);
    store.markSteeringUncertain();
    assert.equal(store.listUncertainSteering()[0]?.sessionId, "session-a");
    store.consumeSteering(messageId);
    assert.equal(store.hasUnconsumedSteering(toTurnId("turn-a"), "session-a"), false);
    store.markSteeringUncertain();
    assert.deepEqual(store.listUncertainSteering(), [], "recovery cannot downgrade consumed receipts");
  } finally { store.close(); }
});
