import assert from "node:assert/strict";
import { ConversationRun } from "../src/domain/run-coordinator";
import type { AssistantTurn, RunSnapshot } from "../src/domain/contracts";

async function verify() {
  let turn = { id: "historic", text: '<relay-action>{"tool":"workspace.list"}</relay-action>', element: {} } as AssistantTurn;
  let clock = 0;
  let generating = false;
  let calls = 0;
  const sent: string[] = [];
  const states: RunSnapshot[] = [];
  const run = new ConversationRun({ name: "Fixture", conversation: () => "chat/a", reply: () => turn, busy: () => generating, submit: async text => { sent.push(text); } }, {
    catalog: async () => [{ name: "workspace.list", server: "vscode", description: "List files", inputSchema: {} }],
    execute: async () => { calls++; return { ok: true, text: "src" }; },
    publish: state => states.push(state), present: () => {}, target: () => "project-a", now: () => clock,
    access: () => "full",
  }, 20);
  await run.begin();
  assert.ok(sent[0]?.includes("Access: Full access (approved for this session)."), "The model must receive the session's approved access mode");
  await run.observe(); clock += 100; await run.observe();
  assert.equal(calls, 0, "Opening a chat must not replay historical actions");
  turn = { ...turn, id: "new" }; generating = true;
  await run.observe(); clock += 100; await run.observe();
  assert.equal(calls, 0, "Streaming actions must never run");
  generating = false;
  await run.observe(); clock += 100;
  await Promise.all([run.observe(), run.observe(), run.observe()]);
  assert.equal(calls, 1, "Concurrent observations must execute one action");
  assert.ok(sent[1]?.includes("Outcome: completed"));
  await run.observe(); assert.equal(calls, 1);
  turn = { ...turn, id: "ordinary", text: '{"status":"ok"}' };
  await run.observe(); clock += 100; await run.observe();
  assert.equal(sent.length, 2, "Ordinary JSON answers must not generate error feedback");
  turn = { ...turn, id: "hidden", text: '<relay-action>{"tool":"workspace.list"}</relay-action>' };
  await run.observe(false); assert.equal(run.snapshot().phase, "paused");
  run.stop(); await run.observe(); assert.equal(calls, 1);
  assert.equal(run.snapshot().active, false);
  assert.ok(states.some(state => state.phase === "executing"));
  console.log("PASS run lifecycle: no history replay, streaming barrier, single-flight execution, receipts, ordinary answers and stop");

  let finishAction: ((value: { ok: boolean; text: string }) => void) | undefined;
  const messages: string[] = [];
  const restarted = new ConversationRun({ name: "Fixture", conversation: () => "chat/a", reply: () => turn, busy: () => false, submit: async text => { messages.push(text); } }, {
    catalog: async () => [{ name: "workspace.list", server: "workspace", description: "List", inputSchema: {} }],
    execute: () => new Promise(resolve => { finishAction = resolve; }),
    publish: () => {}, present: () => {}, target: () => "project", now: () => clock,
  }, 0);
  turn = { ...turn, id: "baseline" };
  await restarted.begin();
  turn = { ...turn, id: "running" };
  await restarted.observe();
  const pending = restarted.observe();
  assert.equal(restarted.snapshot().phase, "executing");
  restarted.stop();
  await restarted.begin();
  finishAction!({ ok: true, text: "old result" });
  await pending;
  assert.equal(messages.filter(message => message.startsWith("<relay-receipt>")).length, 0, "Stopped runs must never inject results into a replacement run");
  assert.equal(restarted.snapshot().phase, "waiting");
  console.log("PASS run replacement rejects late results from the stopped generation");
}
verify().catch(error => { console.error(error); process.exitCode = 1; });
