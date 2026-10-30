export interface SiteProfile {
  name: string;
  hosts: string[];
  assistant: string;
  user: string;
  input: string;
  send: string;
  generating: string;
  exclude?: string;
}

const submit = 'button[data-testid="send-button"],button[aria-label="Send"],button[aria-label="Send message"],button[aria-label="Send Message"],button[type="submit"]';
const cancel = 'button[data-testid="stop-button"],button[aria-label="Stop"],button[aria-label="Stop generating"],button[aria-label="Stop response"]';

const siteProfiles: SiteProfile[] = [
  { name: "ChatGPT", hosts: ["chatgpt.com", "chat.openai.com"], assistant: '[data-message-author-role="assistant"],[class*="DilResponseRoot"]', user: '[data-message-author-role="user"],[data-user-message-bubble]', input: '#prompt-textarea,[data-mobile-composer-prompt],textarea[aria-label="Chat with ChatGPT"],[role="textbox"][aria-label="Ask ChatGPT"]', send: submit, generating: cancel, exclude: '[data-testid*="thinking"],[class*="reasoning"]' },
  { name: "Claude", hosts: ["claude.ai"], assistant: '[data-testid="assistant-message"]', user: '[data-testid="user-message"]', input: '.ProseMirror[contenteditable="true"],[contenteditable][data-placeholder]', send: submit + ',button[aria-label="Send Message"]', generating: cancel, exclude: '[data-testid*="thinking"]' },
  { name: "Gemini", hosts: ["gemini.google.com"], assistant: "model-response", user: "user-query", input: '.ql-editor[contenteditable="true"]', send: submit + ',button.send-button', generating: cancel + ',button[aria-label="Stop response"]', exclude: 'model-thoughts' },
  { name: "DeepSeek", hosts: ["chat.deepseek.com", "deepseek.com"], assistant: '.ds-message:has(.ds-markdown)', user: '.ds-message:not(:has(.ds-markdown))', input: 'textarea', send: submit + ',.ds-button--primary:has(svg)', generating: cancel + ',.ds-loading', exclude: '.ds-think-content' },
  { name: "Kimi", hosts: ["www.kimi.ai", "kimi.ai"], assistant: '.segment-assistant', user: '.segment-user', input: '.chat-input-editor', send: submit + ',.send-button-container', generating: cancel + ',.stop-button-container', exclude: '.thinking-container' },
  { name: "GLM", hosts: ["chat.z.ai"], assistant: '.chat-assistant', user: '.user-message', input: '#chat-input', send: '#send-message-button,' + submit, generating: cancel, exclude: '.thinking-chain-container' },
  { name: "Qwen", hosts: ["chat.qwen.ai"], assistant: '.qwen-chat-message-assistant', user: '.qwen-chat-message-user', input: 'textarea.message-input-textarea', send: 'button.send-button,' + submit, generating: 'button.stop-button,' + cancel },
  { name: "Arena", hosts: ["arena.ai"], assistant: '[data-message-author-role="assistant"],ol.flex-col-reverse .prose', user: '[data-message-author-role="user"]', input: 'textarea,[contenteditable="true"][role="textbox"]', send: submit, generating: cancel },
  { name: "Meta AI", hosts: ["www.meta.ai", "meta.ai"], assistant: '[data-message-author-role="assistant"],[data-testid="assistant-message"]', user: '[data-message-author-role="user"],[data-testid="user-message"]', input: '[contenteditable="true"][role="textbox"],textarea', send: submit + ',[role="button"][aria-label="Send"]', generating: cancel },
  { name: "Ptero", hosts: ["ptero.pro"], assistant: '[data-testid="assistant-message"],[data-message-author-role="assistant"]', user: '[data-testid="user-message"],[data-message-author-role="user"]', input: 'textarea,[contenteditable="true"][role="textbox"]', send: submit, generating: cancel },
  { name: "Grok", hosts: ["grok.com"], assistant: '[data-testid="assistant-message"],[data-message-author-role="assistant"]', user: '[data-testid="user-message"],[data-message-author-role="user"]', input: 'textarea,.ProseMirror[contenteditable="true"]', send: submit + ',button[aria-label="Submit"]', generating: cancel },
];

export function profileFor(host: string): SiteProfile | undefined { return siteProfiles.find(profile => profile.hosts.includes(host)); }
