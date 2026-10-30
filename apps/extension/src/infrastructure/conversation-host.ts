import { profileFor } from "../adapters/site-profiles";

export async function ensureConversation(tab: number, url: string): Promise<void> {
  const page = new URL(url);
  const profile = page.protocol === "https:" ? profileFor(page.hostname) : undefined;
  if (!profile) throw new Error("Open a supported AI conversation before starting Relay.");
  let reply: { ok?: boolean; protocol?: number } | undefined;
  try {
    reply = await chrome.tabs.sendMessage(tab, { method: "conversation.inspect" });
  } catch (error) {
    if (!/Receiving end does not exist|Could not establish connection/i.test(String(error))) throw error;
    if (profile.name === "ChatGPT") await chrome.scripting.executeScript({ target: { tabId: tab }, files: ["build/document.js"], world: "MAIN" });
    await chrome.scripting.executeScript({ target: { tabId: tab }, files: ["build/conversation.js"] });
    reply = await chrome.tabs.sendMessage(tab, { method: "conversation.inspect" });
  }
  if (!reply?.ok || reply.protocol !== 3) throw new Error("This tab is using an older Relay agent. Reload the AI tab once before starting this version.");
}
