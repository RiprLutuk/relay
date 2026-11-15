import assert from "node:assert/strict";
import { actionReceipt, automaticContinuation, readActionFrame, requestsManualRelayContinuation, sessionContext } from "../src/domain/action-frame";

assert.deepEqual(readActionFrame('{"status":"ok"}'), { kind: "answer" });
assert.deepEqual(readActionFrame('Example: <relay-action>{"tool":"workspace.list"}</relay-action>'), { kind: "answer" });
assert.equal(readActionFrame('<relay-action>{"tool":"workspace.list","input":{"path":"."}}</relay-action>').kind, "action");
assert.deepEqual(
  readActionFrame('Saya akan memeriksa workspace terlebih dahulu.\n```relay\n<relay-action>{"tool":"workspace.tree","input":{"path":".","maxDepth":3}}</relay-action>\n```'),
  { kind: "action", action: { tool: "workspace.tree", input: { path: ".", maxDepth: 3 } } },
);
assert.deepEqual(
  readActionFrame('Saya akan cek isi index.html terlebih dahulu.\n\n<relay-action>{"tool":"workspace.readText","input":{"path":"index.html"}}</relay-action>'),
  { kind: "action", action: { tool: "workspace.readText", input: { path: "index.html" } } },
);
for (const value of [
  '<relay-action>{"tool":"workspace.list"}',
  '<relay-action>{"tool":"workspace.list","input":[]}</relay-action>',
  '<relay-action>{"tool":"workspace.list","input":null}</relay-action>',
  '<relay-action>{"tool":"workspace.list","other":true}</relay-action>',
  '<relay-action>{"tool":"workspace.list"}</relay-action><relay-action>{"tool":"workspace.list"}</relay-action>',
]) assert.equal(readActionFrame(value).kind, "invalid");
const receipt = actionReceipt("workspace.readText", { ok: true, text: "done", actionId: "action-1", durationMs: 42, status: "completed" });
assert.match(receipt, /Action ID: action-1/);
assert.match(receipt, /Duration: 42 ms/);
assert.match(receipt, /Status: completed/);
assert.match(receipt, /delivered this receipt automatically/);
const context = sessionContext([], "project", "autonomous");
assert.match(context, /automatically submits every action receipt/);
assert.match(context, /Never ask the user to send another message through Relay/);
assert.equal(requestsManualRelayContinuation('Aktifkan kembali Relay dari VS Code dan kirim "lanjut deploy".'), true);
assert.equal(requestsManualRelayContinuation("Reconnect Relay, then send the next message to continue."), true);
assert.equal(requestsManualRelayContinuation("Relay completed the deployment successfully."), false);
assert.match(automaticContinuation(), /Continue the existing task now/);
console.log("PASS explicit Relay action frames; ordinary prose/JSON never executes");
