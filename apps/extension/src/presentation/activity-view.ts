import type { ActionRequest, ActionResult, AssistantTurn } from "../domain/contracts";
import { readActionFrame } from "../domain/action-frame";

const labels: Record<string, string> = {
  "workspace.list": "Browse files", "workspace.tree": "Browse project", "workspace.find": "Find files",
  "workspace.read": "Read file", "workspace.readText": "Read file", "workspace.readBatch": "Read files",
  "workspace.search": "Search code", "workspace.replace": "Update file", "workspace.create": "Create file",
  "workspace.write": "Write file", "workspace.mkdir": "Create folder", "workspace.move": "Move file",
  "workspace.copy": "Copy file", "workspace.stat": "File information", "workspace.describe": "Inspect workspace",
  "project.describe": "Inspect project", "project.run": "Run project task", "project.test": "Run tests",
  "code.outline": "Code outline", "process.run": "Run command", "vcs.status": "Review changes",
  "vcs.diff": "Review diff", "vcs.log": "Commit history", "vcs.branches": "Branches",
};
export function actionTitle(name: string): string {
  const local = name.split("/").at(-1) || name;
  const text = labels[local] || local.replace(/[_.-]/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2") || "Workspace action";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function readableValue(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value !== "object") return String(value);
  if (depth > 10) return JSON.stringify(value);
  if (Array.isArray(value)) return value.length ? value.map(item => "• " + readableValue(item, depth + 1).replace(/\n/g, "\n  ")).join("\n") : "None";
  return Object.entries(value).map(([key, item]) => `${key.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2")}: ${readableValue(item, depth + 1)}`).join("\n") || "None";
}

function readableResult(text: string): string {
  if (/^\s*[\[{]/.test(text) && text.length <= 262144) { try { return readableValue(JSON.parse(text)); } catch {} }
  return text;
}

export class ActivityView {
  private readonly cards = new WeakMap<HTMLElement, HTMLElement>();
  private readonly displays = new WeakMap<HTMLElement, string>();
  historical(turns: AssistantTurn[]): void {
    for (const turn of turns) {
      const decoded = readActionFrame(turn.text);
      if (decoded.kind === "action") {
        if (!this.cards.get(turn.element)?.isConnected) this.card(turn.element, actionTitle(decoded.action.tool), "Previous action", readableValue(decoded.action.input));
      } else if (decoded.kind === "answer") this.release(turn.element);
    }
  }

  private release(item: HTMLElement): void {
    const card = this.cards.get(item);
    if (!card) return;
    card.remove();
    for (const child of item.children) {
      const element = child as HTMLElement;
      const original = this.displays.get(element);
      if (original !== undefined) { element.style.display = original; this.displays.delete(element); }
    }
    this.cards.delete(item);
  }
  pending(turn: AssistantTurn): void {
    if (/^(?:```relay\s*)?<relay-action>/.test(turn.text)) this.card(turn.element, "Preparing action", "Receiving", "Waiting for a complete action frame.");
  }

  display(turn: AssistantTurn, action: ActionRequest, result?: ActionResult): void {
    const output = result?.ok ? result.text || "Completed" : result?.error || "Action failed";
    this.card(turn.element, actionTitle(action.tool), result ? (result.ok ? "Completed" : "Failed") : "Working…", result ? (action.tool.endsWith("workspace.readText") ? output : readableResult(output)) : readableValue(action.input), result?.ok === false);
  }

  maskInternalMessages(userSelector: string): void {
    for (const item of document.querySelectorAll<HTMLElement>(userSelector)) {
      const text = (item.innerText || item.textContent || "").trim();
      if (text.startsWith("<relay-context>") && text.endsWith("</relay-context>")) this.card(item, "Workspace session", "Ready", "Relay connected this conversation to your selected project.");
      else if (text.startsWith("<relay-receipt>") && text.endsWith("</relay-receipt>")) this.card(item, "Action result", "", readableResult(text.slice(15, -16).trim()));
      else this.release(item);
    }
  }

  private card(item: HTMLElement, title: string, status: string, body: string, failed = false): void {
    let host = this.cards.get(item);
    if (!host || !host.isConnected) {
      host = document.createElement("span");
      host.dataset.relayCard = "";
      host.attachShadow({ mode: "open" });
      item.append(host);
      this.cards.set(item, host);
    }
    for (const child of item.children) if (child !== host) {
      const element = child as HTMLElement;
      if (!this.displays.has(element)) this.displays.set(element, element.style.display);
      element.style.display = "none";
    }
    const shadow = host.shadowRoot!;
    const previous = shadow.querySelector("details");
    const open = previous?.open || false;
    if (host.dataset.value === `${title}\n${status}\n${body}`) return;
    host.dataset.value = `${title}\n${status}\n${body}`;
    const style = document.createElement("style");
    style.textContent = ':host{display:block;max-width:100%;margin:8px 0;color:inherit;font:13px/1.5 system-ui}details{border:1px solid #8884;border-radius:10px;background:#8881;overflow:hidden}summary{padding:9px 12px;cursor:pointer;display:flex;gap:10px;align-items:center;list-style:none}summary:focus-visible{outline:2px solid #708bd8;outline-offset:-3px}svg{width:16px;height:16px;flex:none;color:#91a5c7}details[data-failed] svg{color:#d89a9a}b{font-weight:550;overflow-wrap:anywhere}small{margin-left:auto;opacity:.6;font:12px system-ui}.chevron{width:12px;opacity:.5}details[open] .chevron{transform:rotate(180deg)}pre{margin:0;padding:12px;border-top:1px solid #8883;max-height:320px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 ui-monospace,monospace}';
    const details = document.createElement("details");
    details.open = open;
    if (failed) details.dataset.failed = "";
    const summary = document.createElement("summary");
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24"); icon.setAttribute("fill", "none"); icon.setAttribute("stroke", "currentColor"); icon.setAttribute("stroke-width", "1.8"); icon.setAttribute("stroke-linecap", "round"); icon.setAttribute("stroke-linejoin", "round"); icon.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(icon.namespaceURI, "path");
    path.setAttribute("d", failed ? "M12 4 3 20h18L12 4Zm0 5v5m0 3h.01" : status === "Completed" ? "m5 12 4 4 10-10" : "M7 17 17 7M7 7h10v10"); icon.append(path);
    const chevron = icon.cloneNode(false) as SVGSVGElement; chevron.classList.add("chevron");
    const chevronPath = document.createElementNS(icon.namespaceURI, "path"); chevronPath.setAttribute("d", "m6 9 6 6 6-6"); chevron.append(chevronPath);
    const label = document.createElement("b"); label.textContent = title;
    const meta = document.createElement("small"); meta.textContent = status;
    summary.append(icon, label, meta, chevron);
    const content = document.createElement("pre"); content.textContent = body;
    details.append(summary, content);
    shadow.replaceChildren(style, details);
  }
}
