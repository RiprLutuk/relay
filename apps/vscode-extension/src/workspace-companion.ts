import { execFile, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { EditorSession } from "./editor-session";
import * as vscode from "vscode";
import { controlCenterHtml } from "./control-center";
const exec = promisify(execFile);
let editorSession: EditorSession | undefined;
let extensionDirectory = "";
const binary = process.platform === "win32" ? "relayctl.exe" : "relayctl";
const stateDirectory = () => process.env.RELAY_STATE_DIR || join(homedir(), ".relay");
type Event = {
    kind: string;
    label: string;
    detail?: string;
    at?: number;
};
type State = {
    online: boolean;
    alive: boolean;
    tools: number;
    servers: unknown[];
    access: string;
    activity: Event[];
    error?: string;
};
function controlPath(): string {
    const configured = vscode.workspace.getConfiguration("relay").get<string>("controlPath")?.trim();
    if (configured)
        return configured;
    const packaged = join(extensionDirectory, "runtime", binary);
    if (extensionDirectory && existsSync(packaged)) return packaged;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const local = root && join(root, "target", "release", binary);
    return local && existsSync(local) ? local : binary;
}
async function health(): Promise<boolean> {
    if (!vscode.workspace.isTrusted)
        return false;
    try {
        await exec(controlPath(), ["check"], { timeout: 5000, windowsHide: true });
        return true;
    }
    catch {
        return false;
    }
}
async function snapshot(): Promise<State> {
    try {
        if (!editorSession) throw new Error("Open a trusted local project folder");
        const value = await editorSession.inspect();
        return { online: true, alive: !!value.workspaceReady, tools: Array.isArray(value.tools) ? value.tools.length : 0, servers: value.servers as unknown[] || [], access: "workspace", activity: ((value.activity || []) as (Event & { workspaceId?: string })[]).filter(event => !event.workspaceId || editorSession!.workspaces.some(workspace => workspace.id === event.workspaceId)) };
    } catch (error) {
        return { online: false, alive: false, tools: 0, servers: [], access: "workspace", activity: [], error: error instanceof Error ? error.message : String(error) };
    }
}
class ControlCenter implements vscode.Disposable {
    private panel?: vscode.WebviewPanel;
    constructor(private readonly start: () => Promise<void>, private readonly choose: () => Promise<void>) { }
    private attach(panel: vscode.WebviewPanel): void {
        panel.webview.html = controlCenterHtml();
        panel.webview.onDidReceiveMessage(async (m) => { if (m.type === "start")
            await this.start(); if (m.type === "choose")
            await this.choose(); if (m.type === "copy")
            await vscode.commands.executeCommand("relay.copyPairingToken"); if (m.type === "browser")
            await vscode.commands.executeCommand("relay.openBrowserExtension"); });
    }
    update(state: State): void { this.panel?.webview.postMessage({ type: "state", state }); }
    show(): void {
        if (!this.panel) {
            this.panel = vscode.window.createWebviewPanel("relay.controlCenter", "Relay", vscode.ViewColumn.Beside, { enableScripts: true });
            this.attach(this.panel);
            this.panel.onDidDispose(() => { this.panel = undefined; });
        }
        this.panel.reveal();
    }
    dispose(): void { this.panel?.dispose(); }
}
export function activate(context: vscode.ExtensionContext): void {
    extensionDirectory = context.extensionPath || "";
    const browserSource = join(extensionDirectory, "runtime", "browser");
    const browserHome = join(stateDirectory(), "browser");
    if (extensionDirectory && existsSync(join(browserSource, "manifest.json"))) {
        try {
            const bundled = readFileSync(join(browserSource, "build-id"), "utf8");
            const installed = existsSync(join(browserHome, "build-id")) ? readFileSync(join(browserHome, "build-id"), "utf8") : "";
            if (bundled !== installed) { mkdirSync(browserHome, { recursive: true }); cpSync(browserSource, browserHome, { recursive: true }); }
        } catch (error) { void vscode.window.showErrorMessage(`Relay could not prepare its browser companion: ${String(error)}`); }
    }
    const attachEditor = () => {
        if (!vscode.workspace.isTrusted || editorSession) return;
        const windowId = randomUUID();
        editorSession = new EditorSession(join(stateDirectory(), "bridge-token"), () => ({
            windowId: windowId,
            editor: { id: vscode.env.uriScheme || "vscode", name: vscode.env.appName || "VS Code", version: vscode.version },
            roots: (vscode.workspace.workspaceFolders || []).map(folder => ({ uri: folder.uri.toString(), name: folder.name })),
            trusted: vscode.workspace.isTrusted,
        }));
        editorSession.connect();
        context.subscriptions.push(editorSession, vscode.workspace.onDidChangeWorkspaceFolders(() => { void editorSession?.register(); }));
    };
    attachEditor();
    if (vscode.workspace.onDidGrantWorkspaceTrust) context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => { attachEditor(); void start(); }));
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    item.command = "relay.showActions";
    item.show();
    let starting = false;
    let refresh: () => Promise<void>;
    const start = async () => {
        if (starting || !vscode.workspace.isTrusted)
            return;
        if (editorSession?.reachable()) {
            await refresh();
            return;
        }
        starting = true;
        try {
            if (await health()) {
                const environment = { ...process.env };
                delete environment.RELAY_WORKSPACE;
                const daemon = spawn(controlPath(), ["start"], { detached: true, windowsHide: true, stdio: "ignore", env: environment, cwd: homedir() });
                daemon.on("error", error => { starting = false; void vscode.window.showErrorMessage(`Relay: ${error.message}. Select the Relay binary or install the packaged extension.`); });
                daemon.unref();
            } else { void vscode.window.showErrorMessage("Relay runtime is missing. Install the Relay package for your platform or select a built Relay binary."); }
            editorSession?.connect();
        } catch (error) { void vscode.window.showErrorMessage(String(error)); }
        setTimeout(() => { starting = false; void refresh(); }, 1000);
    };
    const choose = async () => { const selected = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: "Use Relay binary", filters: process.platform === "win32" ? { Relay: ["exe"] } : undefined }); if (selected?.[0]) {
        await vscode.workspace.getConfiguration("relay").update("controlPath", selected[0].fsPath, vscode.ConfigurationTarget.Global);
        await refresh();
    } };
    const center = new ControlCenter(start, choose);
    context.subscriptions.push(center);
    context.subscriptions.push(vscode.commands.registerCommand("relay.showActions", async () => {
        const picked = await vscode.window.showQuickPick([
            { label: "$(key) Copy pairing token", command: "relay.copyPairingToken" },
            { label: "$(browser) Set up browser companion", command: "relay.openBrowserExtension" },
            { label: "$(pulse) Open activity", command: "relay.openControlCenter" },
            { label: "$(refresh) Refresh status", command: "relay.check" },
            { label: "$(play) Start bridge", command: "relay.start" },
            { label: "$(gear) Select Relay binary", command: "relay.selectControlPath" },
        ], { title: "Relay", placeHolder: "Local workspace actions" });
        if (picked)
            await vscode.commands.executeCommand(picked.command);
    }));
    context.subscriptions.push(vscode.commands.registerCommand("relay.copyPairingToken", async () => {
        try {
            await vscode.env.clipboard.writeText(readFileSync(join(stateDirectory(), "bridge-token"), "utf8").trim());
            void vscode.window.showInformationMessage("Pairing token copied. Paste it only in the Relay browser popup.");
        }
        catch {
            void vscode.window.showErrorMessage("Start Relay before copying its pairing token.");
        }
    }));
    refresh = async () => { const state = await snapshot(); item.text = state.online ? "$(radio-tower) Relay" : "$(warning) Relay"; item.tooltip = state.online ? `Relay connected · ${state.tools} tools` : "Relay offline"; center.update(state); };
    const auto = vscode.workspace.getConfiguration("relay").get<boolean>("autoStart");
    context.subscriptions.push(item, vscode.commands.registerCommand("relay.check", refresh), vscode.commands.registerCommand("relay.start", start), vscode.commands.registerCommand("relay.openControlCenter", () => center.show()), vscode.commands.registerCommand("relay.selectControlPath", choose), vscode.commands.registerCommand("relay.openBrowserExtension", () => vscode.env.openExternal(existsSync(join(browserHome, "manifest.json")) ? vscode.Uri.file(browserHome) : vscode.Uri.parse("https://github.com/RiprLutuk/relay/releases/latest"))), { dispose: () => clearInterval(timer) });
    const timer = setInterval(() => void refresh(), 2000);
    void (async () => { await refresh(); if (auto && !(await snapshot()).online)
        await start(); })();
}
