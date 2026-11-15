import type { AssistantTurn, ChatSurface } from "../domain/contracts";
import type { SiteProfile } from "./site-profiles";

const delay = (milliseconds: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  signal.throwIfAborted();
  const aborted = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, milliseconds);
  signal.addEventListener("abort", aborted, { once: true });
});

function fingerprint(text: string): string {
  let first = 2166136261, second = 5381;
  for (let i = 0; i < text.length; i++) { first = Math.imul(first ^ text.charCodeAt(i), 16777619); second = Math.imul(second, 33) ^ text.charCodeAt(i); }
  return `${(first >>> 0).toString(36)}-${(second >>> 0).toString(36)}-${text.length}`;
}

function visibleElement<T extends HTMLElement = HTMLElement>(selector: string, scope: ParentNode = document): T | undefined {
  return [...scope.querySelectorAll<T>(selector)].find(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden");
}

function editorText(editor: HTMLInputElement | HTMLTextAreaElement | HTMLDivElement): string {
  return "value" in editor ? editor.value : editor.innerText || "";
}

function replaceEditorText(editor: HTMLInputElement | HTMLTextAreaElement | HTMLDivElement, text: string): void {
  editor.focus();
  if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
    const prototype = editor instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(editor, text);
  } else {
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    if (!document.execCommand("insertText", false, text)) editor.innerText = text;
  }
  editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
}

function conversationText(element: HTMLElement, exclude = ""): string {
  const ignored = '[data-relay-card],button,svg,style,script' + (exclude ? `,${exclude}` : "");
  function collect(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || "";
    if (!(node instanceof HTMLElement) || node.matches(ignored)) return "";
    const tapped = node.getAttribute("data-relay-code");
    if (tapped !== null) return tapped + "\n";
    if (node.tagName === "BR") return "\n";
    const result = [...node.childNodes].map(collect).join("");
    return /^(P|DIV|PRE|LI|SECTION)$/.test(node.tagName) || node.classList.contains("cm-line") ? result + "\n" : result;
  }
  return collect(element).trim();
}

function normalizedMessage(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
}

export function deliveryConfirmed(sent: string, remaining: string, busy: boolean, previousCount: number, userMessages: string[]): boolean {
  if (busy || !remaining.trim()) return true;
  const expected = normalizedMessage(sent);
  return userMessages.slice(previousCount).some(message => normalizedMessage(message) === expected);
}

export class WebConversationSurface implements ChatSurface {
  readonly name: string;
  constructor(readonly profile: SiteProfile, private readonly page: Location = location) { this.name = profile.name; }
  conversation(): string { return this.page.origin + this.page.pathname; }

  reply(): AssistantTurn | null {
    document.dispatchEvent(new Event("relay:refresh-code"));
    const candidates = this.assistantElements();
    const element = candidates.at(-1);
    if (!element) return null;
    return this.readTurn(element, candidates.length);
  }

  history(): AssistantTurn[] {
    document.dispatchEvent(new Event("relay:refresh-code"));
    return this.assistantElements().map((element, index) => this.readTurn(element, index + 1));
  }

  private assistantElements(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>(this.profile.assistant)].filter(element => !element.parentElement?.closest(this.profile.assistant));
  }

  private userMessages(): string[] {
    return [...document.querySelectorAll<HTMLElement>(this.profile.user)]
      .filter(element => !element.parentElement?.closest(this.profile.user))
      .map(element => conversationText(element, this.profile.exclude));
  }

  private readTurn(element: HTMLElement, ordinal: number): AssistantTurn {
    const blocks = [...element.querySelectorAll<HTMLElement>(".cm-content,pre code,pre")]
      .filter(block => !block.querySelector(".cm-content,pre code") && !(this.profile.exclude && block.closest(this.profile.exclude)))
      .map(block => conversationText(block, this.profile.exclude))
      .filter(text => text.startsWith("<relay-action>"));
    const text = blocks.length ? blocks.join("\n") : conversationText(element, this.profile.exclude);
    const identified = element.matches('[data-message-id],[data-dil-message-id]') ? element : element.querySelector<HTMLElement>('[data-message-id],[data-dil-message-id]');
    const identity = identified?.getAttribute("data-message-id") || identified?.getAttribute("data-dil-message-id")
      || element.closest('[data-testid^="conversation-turn-"]')?.getAttribute("data-testid");
    return { id: identity || `${ordinal}:${fingerprint(text)}`, text, element };
  }

  busy(): boolean { return !!visibleElement(this.profile.generating); }

  async submit(text: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const editor = visibleElement<HTMLInputElement | HTMLTextAreaElement | HTMLDivElement>(this.profile.input);
    if (!editor) throw new Error(`${this.name}: message composer unavailable. Open an editable chat.`);
    const existing = editorText(editor);
    const internal = text.startsWith("<relay-context>") || text.startsWith("<relay-receipt>") || text.startsWith("<relay-continuation>");
    if (existing.trim() && !internal) throw new Error("Your composer contains an unsent draft. Send or clear it before continuing Relay.");
    const draft = internal ? existing : "";
    replaceEditorText(editor, text);
    let button: HTMLElement | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      signal.throwIfAborted();
      const candidate = visibleElement(this.profile.send);
      if (candidate && !candidate.hasAttribute("disabled") && candidate.getAttribute("aria-disabled") !== "true") { button = candidate; break; }
      await delay(100, signal);
    }
    if (!button) throw new Error(`${this.name}: send control did not become available. Your message was not submitted.`);
    const previousMessages = this.userMessages().length;
    button.click();
    for (let attempt = 0; attempt < 150; attempt++) {
      signal.throwIfAborted();
      const current = visibleElement<HTMLInputElement | HTMLTextAreaElement | HTMLDivElement>(this.profile.input);
      const remaining = current ? editorText(current) : "";
      if (deliveryConfirmed(text, remaining, this.busy(), previousMessages, this.userMessages())) {
        if (draft && current) replaceEditorText(current, draft);
        else if (internal && current && normalizedMessage(remaining) === normalizedMessage(text)) replaceEditorText(current, "");
        return;
      }
      await delay(100, signal);
    }
    throw new Error(`${this.name}: message delivery could not be confirmed. Relay stopped to prevent duplicate submission.`);
  }
}
