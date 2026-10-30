import assert from "node:assert/strict";
import { BridgeLink } from "../src/infrastructure/bridge-link";

async function verifyTransport() {
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
  await assert.rejects(link.request({ type: "capability.invoke" }), /offline/);
  assert.equal(frames.length, 0);
  link.pair("a".repeat(64));
  socket.readyState = 1; socket.onopen?.();
  assert.equal(frames[0]?.type, "authenticate");
  socket.onmessage?.({ data: JSON.stringify({ type: "connected", bridgeId: "bridge-a", protocolVersion: 3 }) });
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
  console.log("PASS bridge transport: pairing, request correlation and no automatic action replay");
}
verifyTransport().catch(error => { console.error(error); process.exitCode = 1; });
