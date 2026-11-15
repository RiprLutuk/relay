import assert from "node:assert/strict";
import { BridgeLink, connectionTransitionAllowed } from "../src/infrastructure/bridge-link";

async function verifyTransport() {
  assert.equal(connectionTransitionAllowed("ready", "connecting"), false);
  assert.equal(connectionTransitionAllowed("ready", "degraded"), true);
  const frames: Record<string, unknown>[] = [];
  const socket = {
    readyState: 0,
    onopen: undefined as (() => void) | undefined,
    onmessage: undefined as ((event: { data: string }) => void) | undefined,
    onclose: undefined as (() => void) | undefined,
    send: (frame: string) => { frames.push(JSON.parse(frame)); },
    close: () => { socket.readyState = 3; socket.onclose?.(); },
  };
  const link = new BridgeLink(() => {}, () => socket as unknown as WebSocket);
  assert.equal(link.status().phase, "disconnected");
  await assert.rejects(link.request({ type: "capability.invoke" }), /offline/);
  assert.equal(frames.length, 0);
  link.pair("a".repeat(64));
  assert.equal(link.status().phase, "connecting");
  socket.readyState = 1; socket.onopen?.();
  assert.equal(link.status().phase, "handshaking");
  assert.equal(frames[0]?.type, "authenticate");
  socket.onmessage?.({ data: JSON.stringify({ type: "connected", bridgeId: "bridge-a", protocolVersion: 3 }) });
  assert.equal(link.status().phase, "ready");
  assert.equal(link.status().retryAttempt, 0);
  const first = link.request({ type: "session.inspect" });
  const second = link.request({ type: "workspace.list" });
  await new Promise(resolve => setImmediate(resolve));
  socket.onmessage?.({ data: JSON.stringify({ id: frames[2]?.id, ok: true, result: "second" }) });
  socket.onmessage?.({ data: JSON.stringify({ id: frames[1]?.id, ok: true, result: "first" }) });
  assert.equal((await first).result, "first");
  assert.equal((await second).result, "second");
  const interrupted = link.request({ type: "capability.invoke" });
  await new Promise(resolve => setImmediate(resolve));
  const sent = frames.length;
  link.dispose();
  await assert.rejects(interrupted, /not replay/);
  assert.equal(frames.length, sent, "Disconnect must not resend an action");
  assert.equal(link.status().phase, "closed");
  console.log("PASS bridge transport: pairing, request correlation and no automatic action replay");
}
verifyTransport().catch(error => { console.error(error); process.exitCode = 1; });
