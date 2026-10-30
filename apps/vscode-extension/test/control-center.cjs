const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
async function main() {
    const entry = path.join(__dirname, '../out/workspace-companion.js');
    const originalRequire = createRequire(entry);
    const commands = new Map();
    let panel, onMessage, clipboard;
    const token = 'a'.repeat(64);
    const vscode = {
        StatusBarAlignment: { Left: 1 },
        ViewColumn: { Beside: 2 },
        workspace: { isTrusted: false, getConfiguration: () => ({ get: () => false }) },
        commands: {
            registerCommand: (id, callback) => { commands.set(id, callback); return { dispose() { } }; },
            executeCommand: async (id) => { if (!commands.has(id))
                throw new Error(`Unregistered command: ${id}`); return commands.get(id)(); },
        },
        window: {
            createStatusBarItem: () => ({ show() { }, dispose() { } }),
            createWebviewPanel: () => { panel = { reveal() {}, onDidDispose() {}, dispose() {}, webview: { postMessage() {}, onDidReceiveMessage: callback => { onMessage = callback; } } }; return panel; },
            showInformationMessage: async () => { }, showErrorMessage: async () => { },
            showQuickPick: async (items) => items[0],
        },
        env: { clipboard: { writeText: async (value) => { clipboard = value; } } },
    };
    const exports = {};
    vm.runInNewContext(fs.readFileSync(entry, 'utf8'), {
        exports, console, process, setInterval: () => 0, clearInterval: () => { }, setTimeout: () => 0,
        require: name => name === 'vscode' ? vscode : name === 'node:fs' ? {
            existsSync: () => false,
            readFileSync: file => { assert.equal(path.basename(file), 'bridge-token'); return token; },
        } : originalRequire(name),
    }, { filename: entry });
    exports.activate({ subscriptions: [] });
    assert.ok(commands.has('relay.copyPairingToken'));
    assert.equal(panel, undefined, 'Startup must not create a panel or take editor space');
    await commands.get('relay.openControlCenter')();
    assert.match(panel.webview.html, /id="copy-pairing"/, 'Copy pairing token must be visible before the first bridge poll');
    await onMessage({ type: 'copy' });
    assert.equal(clipboard, token, 'Control Center button must invoke the registered copy command');
    clipboard = undefined;
    await commands.get('relay.showActions')();
    assert.equal(clipboard, token, 'Status bar actions must allow pairing without opening the sidebar');
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
    assert.equal(manifest.contributes.viewsContainers, undefined);
    console.log('PASS native actions and optional Control Center; no startup panel or Activity Bar view');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
