import assert from "node:assert/strict";
import test from "node:test";
import { isExtensionContextInvalid } from "../src/domain/extension-lifetime";

test("recognizes a browser content script invalidated by an extension reload", () => {
  assert.equal(isExtensionContextInvalid(new Error("Extension context invalidated.")), true);
  assert.equal(isExtensionContextInvalid(new Error("Could not establish connection.")), false);
});
