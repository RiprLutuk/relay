const assert = require("node:assert/strict");
const { runtimeUpgradePlan } = require("../out/runtime-lifecycle.js");

assert.deepEqual(
  runtimeUpgradePlan('{"pid":1762,"port":"17613","protocolVersion":3,"version":"1.0.3"}', "1.0.4"),
  { pid: 1762, from: "1.0.3", to: "1.0.4" },
);
assert.equal(
  runtimeUpgradePlan('{"pid":2200,"port":"17613","protocolVersion":3,"version":"1.0.4"}', "1.0.4"),
  undefined,
);
assert.equal(runtimeUpgradePlan('{"pid":1,"version":"1.0.3"}', "1.0.4"), undefined);
assert.equal(runtimeUpgradePlan("not-json", "1.0.4"), undefined);
console.log("PASS installed extension replaces an older Relay runtime");
