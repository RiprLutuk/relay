import assert from "node:assert/strict";
import { deliveryConfirmed } from "../src/adapters/conversation-surface";

const receipt = "<relay-receipt>\nAction: workspace.readText\nOutcome: completed\n</relay-receipt>";

assert.equal(deliveryConfirmed(receipt, receipt, false, 2, ["hello", "older", receipt]), true);
assert.equal(deliveryConfirmed(receipt, receipt, false, 3, ["hello", "older", receipt]), false);
assert.equal(deliveryConfirmed(receipt, "", false, 3, []), true);
assert.equal(deliveryConfirmed(receipt, receipt, true, 3, []), true);
console.log("PASS delivery confirmation accepts a newly rendered user message");
