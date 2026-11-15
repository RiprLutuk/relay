import assert from "node:assert/strict";
import test from "node:test";
import { conversationAddress, isProvisionalConversation } from "../src/domain/conversation-address";

test("keeps identical conversation URLs isolated by browser tab", () => {
  assert.equal(
    conversationAddress("https://chatgpt.com/c/shared", 41),
    "https://chatgpt.com/c/shared#relay-tab-41",
  );
  assert.equal(
    conversationAddress("https://chatgpt.com/c/shared", 42),
    "https://chatgpt.com/c/shared#relay-tab-42",
  );
});

test("treats ChatGPT optimistic routes as provisional conversations", () => {
  assert.equal(isProvisionalConversation("https://chatgpt.com/"), true);
  assert.equal(isProvisionalConversation("https://chatgpt.com/c/local-chatgpt%3Atemporary"), true);
  assert.equal(isProvisionalConversation("https://chatgpt.com/c/permanent-id"), false);
  assert.equal(isProvisionalConversation("https://gemini.google.com/u/2/app/permanent-id"), false);
});

