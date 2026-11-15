const draftPath = /^\/(?:new|app|chat)?\/?$/;
const chatGptOptimisticPath = /^\/c\/local-chatgpt(?::|%3a)/i;

export function isProvisionalConversation(value: string): boolean {
  const url = new URL(value);
  return draftPath.test(url.pathname) || (url.hostname === "chatgpt.com" && chatGptOptimisticPath.test(url.pathname));
}

export function conversationAddress(value: string, tab: number): string {
  const url = new URL(value);
  return `${url.origin}${url.pathname}#relay-tab-${tab}`;
}

