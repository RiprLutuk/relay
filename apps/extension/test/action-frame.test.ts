import assert from "node:assert/strict";
import { readActionFrame } from "../src/domain/action-frame";

assert.deepEqual(readActionFrame('{"status":"ok"}'), { kind: "answer" });
assert.deepEqual(readActionFrame('Example: <relay-action>{"tool":"workspace.list"}</relay-action>'), { kind: "answer" });
assert.equal(readActionFrame('<relay-action>{"tool":"workspace.list","input":{"path":"."}}</relay-action>').kind, "action");
for (const value of [
  '<relay-action>{"tool":"workspace.list"}',
  '<relay-action>{"tool":"workspace.list","input":[]}</relay-action>',
  '<relay-action>{"tool":"workspace.list","input":null}</relay-action>',
  '<relay-action>{"tool":"workspace.list","other":true}</relay-action>',
  '<relay-action>{"tool":"workspace.list"}</relay-action><relay-action>{"tool":"workspace.list"}</relay-action>',
]) assert.equal(readActionFrame(value).kind, "invalid");
console.log("PASS explicit Relay action frames; ordinary prose/JSON never executes");
