import type { ActivityEvent, RunSnapshot, WorkspaceTarget } from "./domain/contracts";
import { actionTitle } from "./presentation/activity-view";

const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const state = element("connection");
const project = element<HTMLSelectElement>("workspace");
const start = element<HTMLButtonElement>("begin");
const stop = element<HTMLButtonElement>("stop");
let activeTab: number | undefined;
let updating = false;
let controlError = "";

async function control(method: string, fields: Record<string, unknown> = {}) {
  const response = await chrome.runtime.sendMessage({ method, tab: activeTab, ...fields }) as Record<string, unknown>;
  if (!response?.ok) throw new Error(String(response?.error || "Relay did not respond."));
  return response;
}

function showError(error: unknown): void { controlError = error instanceof Error ? error.message : String(error); element("notice").textContent = controlError; }

async function refresh(): Promise<void> {
  if (updating || activeTab === undefined) return;
  updating = true;
  try {
    const status = await control("control.status");
    const run = status.state as RunSnapshot | undefined;
    const workspaces = status.workspaces as WorkspaceTarget[];
    const selected = project.value || (status.target as WorkspaceTarget | undefined)?.id || "";
    const placeholder = new Option(workspaces.length ? "Select a workspace" : "Open a project in your editor", "");
    project.replaceChildren(placeholder, ...workspaces.map(workspace => new Option(`${workspace.editor.name} · ${workspace.name} — ${workspace.path}`, workspace.id)));
    if (workspaces.some(workspace => workspace.id === selected)) project.value = selected;
    else if (workspaces.length === 1) project.value = workspaces[0]!.id;
    project.disabled = !!run?.active || !!status.changing;
    const access = element<HTMLSelectElement>("access");
    access.disabled = !!run?.active || !!status.changing;
    if (run?.active) access.value = String(status.access || "workspace");
    element("approval").hidden = !!run?.active || access.value !== "full";
    start.hidden = !!run?.active;
    stop.hidden = !run?.active;
    start.disabled = !status.connected || !project.value || !!status.changing;
    stop.disabled = !!status.changing;
    const problem = controlError || run?.error || String(status.error || "");
    state.textContent = !status.paired ? "Pair your editor" : !status.connected ? "Bridge offline" : run?.active ? actionTitle(run.phase) : problem ? "Session failed" : "Ready";
    state.dataset.online = String(!!status.connected);
    element("notice").textContent = problem || (!status.connected ? "Start Relay from your editor, then pair once." : workspaces.length ? "This conversation stays bound to the selected project." : "Waiting for an editor workspace to register.");
    const events = (status.events || []) as ActivityEvent[];
    element("activity").replaceChildren(...events.slice(0, 5).map(event => {
      const row = document.createElement("li");
      const label = document.createElement("span"); label.textContent = actionTitle(event.title);
      const time = document.createElement("time"); time.textContent = new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      if (event.detail) row.title = event.detail;
      row.append(label, time);
      return row;
    }));
    element("pairing").hidden = !!status.paired;
  } catch (error) { showError(error); }
  finally { updating = false; }
}

project.addEventListener("change", () => { controlError = ""; start.disabled = !project.value; });
element<HTMLSelectElement>("access").addEventListener("change", event => { controlError = ""; element("approval").hidden = (event.target as HTMLSelectElement).value !== "full"; });
element("approve").addEventListener("change", () => { controlError = ""; void refresh(); });
start.addEventListener("click", async () => {
  controlError = "";
  start.disabled = true;
  try {
    const access = element<HTMLSelectElement>("access").value;
    await control("control.start", { workspace: project.value, access, approved: element<HTMLInputElement>("approve").checked });
    await refresh();
  } catch (error) { showError(error); start.disabled = false; }
});
stop.addEventListener("click", async () => { controlError = ""; try { await control("control.stop"); await refresh(); } catch (error) { showError(error); } });
element("pair").addEventListener("click", async () => {
  controlError = "";
  const input = element<HTMLInputElement>("token");
  try { await control("control.pair", { token: input.value.trim() }); input.value = ""; await refresh(); } catch (error) { showError(error); }
});
void chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => { activeTab = tabs[0]?.id; return refresh(); });
setInterval(() => { void refresh(); }, 1500);
