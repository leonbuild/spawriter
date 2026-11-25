import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { TransportV2, TransportState, WIRE_VERSION } from "./transport.js";

describe("TransportV2", () => {
  /** @type {TransportV2} */
  let transport;
  /** @type {string[]} */
  let sent;

  beforeEach(() => {
    transport = new TransportV2({
      initialCredit: 8,
      replenishThreshold: 3,
      maxQueueFrames: 4,
      maxQueueBytes: 10_000,
      keepaliveMs: 60_000, // Large to avoid timer interference.
      keepaliveTimeoutMs: 5000,
    });
    sent = [];
    transport.onSend = (data) => sent.push(data);
  });

  describe("lifecycle", () => {
    it("starts disconnected", () => {
      assert.equal(transport.state, TransportState.DISCONNECTED);
    });

    it("transitions through handshake to ready", () => {
      transport.connectionOpened();
      assert.equal(transport.state, TransportState.HANDSHAKE);
      assert.equal(transport.generation, 1);

      // Should have sent hello.
      assert.equal(sent.length, 1);
      const hello = JSON.parse(sent[0]);
      assert.equal(hello.p.type, "hello");
      assert.equal(hello.p.version, WIRE_VERSION);

      transport.handshakeCompleted({ version: WIRE_VERSION });
      assert.equal(transport.state, TransportState.READY);
    });

    it("rejects version mismatch in handshake", () => {
      let disconnectReason = null;
      transport.onDisconnect = (r) => { disconnectReason = r; };
      transport.connectionOpened();
      transport.handshakeCompleted({ version: 999 });
      assert.equal(disconnectReason, "version_mismatch");
    });

    it("increments generation on reconnect", () => {
      transport.connectionOpened();
      transport.handshakeCompleted({ version: WIRE_VERSION });
      transport.connectionClosed();
      transport.connectionOpened();
      assert.equal(transport.generation, 2);
    });

    it("close is permanent", () => {
      transport.close();
      assert.equal(transport.state, TransportState.CLOSED);
      transport.connectionOpened();
      assert.equal(transport.state, TransportState.CLOSED);
    });
  });

  describe("sending (T18/T42)", () => {
    beforeEach(() => {
      transport.connectionOpened();
      transport.handshakeCompleted({ version: WIRE_VERSION });
      sent = [];
    });

    it("sends with sequential seq numbers", () => {
      transport.send("event", { method: "Console.messageAdded" });
      transport.send("event", { method: "Page.loadEventFired" });
      const e1 = JSON.parse(sent[0]);
      const e2 = JSON.parse(sent[1]);
      assert.equal(e1.seq, 1);
      assert.equal(e2.seq, 2);
      assert.equal(e1.gen, transport.generation);
    });

    it("queues when credit exhausted", () => {
      for (let i = 0; i < 8; i++) transport.send("event", { i });
      assert.equal(sent.length, 8);
      const queued = transport.send("event", { overflow: true });
      assert(queued); // Queued, not dropped.
      assert.equal(sent.length, 8); // Not sent yet.
    });

    it("drops when queue is full", () => {
      for (let i = 0; i < 8; i++) transport.send("event", { i }); // exhaust credit
      for (let i = 0; i < 4; i++) transport.send("event", { q: i }); // fill queue
      assert(!transport.send("event", { drop: true })); // dropped
      assert(transport.metrics().droppedFrames >= 1);
    });

    it("drops oversized frames (non-critical)", () => {
      const big = "x".repeat(200_000);
      assert(!transport.send("event", big));
    });

    it("does not send in DRAINING for non-critical", () => {
      transport.startDrain();
      assert(!transport.send("event", {}));
    });
  });

  describe("receiving (T18/T65)", () => {
    let received;

    beforeEach(() => {
      transport.connectionOpened();
      transport.handshakeCompleted({ version: WIRE_VERSION });
      sent = [];
      received = [];
      transport.onMessage = (env) => received.push(env);
    });

    it("delivers valid envelopes to consumer", () => {
      const env = JSON.stringify({
        v: WIRE_VERSION, k: "event", seq: 1, gen: transport.generation, p: { data: 1 },
      });
      transport.receive(env);
      assert.equal(received.length, 1);
      assert.equal(received[0].p.data, 1);
    });

    it("rejects stale generation", () => {
      const env = JSON.stringify({
        v: WIRE_VERSION, k: "event", seq: 1, gen: 0, p: {},
      });
      transport.receive(env);
      assert.equal(received.length, 0);
    });

    it("rejects wrong version", () => {
      transport.receive(JSON.stringify({ v: 1, k: "event", seq: 1, gen: 1, p: {} }));
      assert.equal(received.length, 0);
    });

    it("rejects invalid JSON", () => {
      transport.receive("not json");
      assert.equal(received.length, 0);
    });

    it("replenishes credit when threshold reached", () => {
      const gen = transport.generation;
      for (let i = 1; i <= 6; i++) {
        transport.receive(JSON.stringify({ v: WIRE_VERSION, k: "event", seq: i, gen, p: {} }));
      }
      // Should have sent credit replenish.
      const creditMsgs = sent.filter((s) => {
        const p = JSON.parse(s);
        return p.k === "control" && p.p?.type === "credit";
      });
      assert(creditMsgs.length >= 1);
    });
  });

  describe("flow control credit processing", () => {
    beforeEach(() => {
      transport.connectionOpened();
      transport.handshakeCompleted({ version: WIRE_VERSION });
      sent = [];
    });

    it("drains queue when credit arrives", () => {
      for (let i = 0; i < 8; i++) transport.send("event", { i }); // exhaust credit
      transport.send("event", { queued: true }); // queued
      assert.equal(sent.length, 8);

      // Simulate credit from relay.
      transport.receive(JSON.stringify({
        v: WIRE_VERSION, k: "control", seq: 0, gen: transport.generation,
        credit: 4, p: { type: "credit", amount: 4 },
      }));

      assert.equal(sent.length, 9); // queued item now sent
    });
  });

  describe("control messages (T19)", () => {
    beforeEach(() => {
      transport.connectionOpened();
      transport.handshakeCompleted({ version: WIRE_VERSION });
      sent = [];
    });

    it("responds to ping with pong", () => {
      transport.receive(JSON.stringify({
        v: WIRE_VERSION, k: "control", seq: 0, gen: transport.generation,
        p: { type: "ping", id: 42, sentAt: 1000 },
      }));
      const pong = sent.find((s) => JSON.parse(s).p?.type === "pong");
      assert(pong);
      assert.equal(JSON.parse(pong).p.id, 42);
    });

    it("fence advances generation", () => {
      const newGen = transport.generation + 5;
      transport.receive(JSON.stringify({
        v: WIRE_VERSION, k: "control", seq: 0, gen: transport.generation,
        p: { type: "fence", generation: newGen },
      }));
      assert.equal(transport.generation, newGen);
    });
  });

  describe("reconnect (T45/T54)", () => {
    it("exponential backoff", () => {
      const d1 = transport.getReconnectDelay();
      const d2 = transport.getReconnectDelay();
      const d3 = transport.getReconnectDelay();
      assert(d2 > d1);
      assert(d3 > d2);
      assert(d3 <= 30000);
    });

    it("reset counter clears backoff", () => {
      transport.getReconnectDelay();
      transport.getReconnectDelay();
      transport.resetReconnectCounter();
      const d = transport.getReconnectDelay();
      assert.equal(d, 500); // base delay
    });

    it("returns -1 when closed", () => {
      transport.close();
      assert.equal(transport.getReconnectDelay(), -1);
    });
  });

  describe("drain", () => {
    it("sends fence on drain", () => {
      transport.connectionOpened();
      transport.handshakeCompleted({ version: WIRE_VERSION });
      sent = [];
      transport.startDrain();
      assert.equal(transport.state, TransportState.DRAINING);
      const fence = sent.find((s) => JSON.parse(s).p?.type === "fence");
      assert(fence);
    });
  });

  describe("metrics", () => {
    it("reports comprehensive metrics", () => {
      transport.connectionOpened();
      transport.handshakeCompleted({ version: WIRE_VERSION });
      transport.send("event", {});
      const m = transport.metrics();
      assert.equal(m.state, TransportState.READY);
      assert.equal(m.sentSeq, 1);
      assert.equal(m.generation, 1);
    });
  });
});
