const assert = require("node:assert/strict");
const { EditorSession } = require("../out/editor-session.js");

const session = new EditorSession("/missing-relay-token", () => ({
  editor: { id: "test", name: "Test", version: "1" },
  windowId: "window",
  roots: [],
  trusted: true,
}));

assert.deepEqual(session.status(), {
  phase: "disconnected",
  retryAttempt: 0,
});
session.dispose();
assert.equal(session.status().phase, "closed");
console.log("PASS editor connection exposes an explicit lifecycle");
