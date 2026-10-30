import json
import os
import plistlib
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import time

from websockets.sync.client import connect


def stopEditor(profile):
    processes = subprocess.check_output(["ps", "-axo", "pid=,command="], text=True)
    markers = [str(profile), str(profile.resolve())]
    for line in processes.splitlines():
        pid, command = line.strip().split(" ", 1)
        if "--user-data-dir" in command and any(marker in command for marker in markers):
            try:
                os.kill(int(pid), signal.SIGTERM)
            except ProcessLookupError:
                pass


def verifyEditors():
    root = Path(__file__).resolve().parents[1]
    version = json.loads((root / "apps/vscode-extension/package.json").read_text())["version"]
    package = root / f"target/packages/relay-workspace-{version}-darwin-arm64.vsix"
    editors = [Path("/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"), Path("/Applications/Cursor.app/Contents/Resources/app/bin/cursor")]
    selection = os.environ.get("RELAY_TEST_EDITOR")
    if selection in ("vscode", "cursor"):
        editors = [editors[0 if selection == "vscode" else 1]]
    assert package.exists(), "Build the platform-specific VSIX first with npm run package"
    assert all(editor.exists() for editor in editors), "This live test requires installed VS Code and Cursor"
    with tempfile.TemporaryDirectory(prefix="relay-edit-", dir="/tmp") as temporary:
        temporary = Path(temporary)
        state = temporary / "state"
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        cleanEnvironment = {key: value for key, value in os.environ.items() if not key.startswith(("VSCODE_", "ELECTRON_", "CURSOR_"))}
        environment = {**cleanEnvironment, "RELAY_STATE_DIR": str(state), "RELAY_CONFIG": str(temporary / "config.json"), "RELAY_BRIDGE_PORT": str(port)}
        environment.pop("RELAY_WORKSPACE", None)
        folders = [temporary / "code/project", temporary / "cursor/project", temporary / "second-root"]
        for folder in folders:
            folder.mkdir(parents=True)
        workspace = temporary / "code-test.code-workspace"
        workspace.write_text(json.dumps({"folders": [{"path": str(folders[0])}, {"path": str(folders[2])}], "settings": {"relay.autoStart": True}}))
        profiles = [temporary / "code-profile", temporary / "cursor-profile"]
        extensions = [temporary / "code-extensions", temporary / "cursor-extensions"]
        for profile in profiles:
            (profile / "User").mkdir(parents=True)
            (profile / "User/settings.json").write_text(json.dumps({"security.workspace.trust.enabled": False, "workbench.startupEditor": "none", "chat.disableAIFeatures": True, "telemetry.telemetryLevel": "off", "update.mode": "none", "extensions.autoUpdate": False}))
        applications = []
        applicationLogs = []

        def workspaces():
            token = (state / "bridge-token").read_text().strip()
            with connect(f"ws://127.0.0.1:{port}", additional_headers={"Authorization": "Bearer " + token}, open_timeout=2) as connection:
                initial = json.loads(connection.recv())
                assert initial["protocolVersion"] == 3
                connection.send(json.dumps({"type": "workspace.list", "id": "inspect", "token": token}))
                return json.loads(connection.recv())["workspaces"]

        def waitRoots(count):
            found = []
            for attempt in range(360):
                try:
                    found = workspaces()
                    if len(found) == count:
                        return found
                except (OSError, KeyError):
                    pass
                time.sleep(0.5)
            raise AssertionError(f"Expected {count} registered roots, got {found}")

        try:
            for index, editor in enumerate(editors):
                arguments = [str(editor), "--user-data-dir", str(profiles[index]), "--extensions-dir", str(extensions[index])]
                subprocess.run([*arguments, "--install-extension", str(package), "--force"], env=environment, check=True, stdout=subprocess.DEVNULL)
                contents = editor.parents[3]
                with (contents / "Info.plist").open("rb") as metadata:
                    executable = plistlib.load(metadata)["CFBundleExecutable"]
                applicationLog = (temporary / f"application-{index}.log").open("w+")
                applicationLogs.append(applicationLog)
                applications.append(subprocess.Popen([str(contents / "MacOS" / executable), *arguments[1:], "--disable-workspace-trust", "--skip-welcome", "--new-window", str(workspace if index == 0 else folders[1])], env=environment, stdout=applicationLog, stderr=applicationLog))
                (temporary / "editor-process.json").write_text(json.dumps({"pid": applications[-1].pid, "profile": str(profiles[index])}))
                if index == 0:
                    registered = waitRoots(2)
                    assert {entry["path"] for entry in registered} == {str(folders[0].resolve()), str(folders[2].resolve())}
                    assert len({entry["windowId"] for entry in registered}) == 1
                    assert (state / "browser/manifest.json").exists(), "VSIX must prepare the browser companion without a separate download"
                    assert (state / "browser/build-id").exists(), "Prepared assets need a build identity to detect same-version updates"
            if len(editors) == 1:
                registered = waitRoots(2)
                assert {entry["editor"]["id"] for entry in registered} == {selection}
                stopEditor(profiles[0])
                waitRoots(0)
                print(f"PASS actual {selection}: bundled runtime auto-start, prepared browser companion, multi-root registration and clean window shutdown")
                return
            registered = waitRoots(3)
            assert len({entry["windowId"] for entry in registered}) == 2
            assert {entry["editor"]["id"] for entry in registered} == {"vscode", "cursor"}
            stopEditor(profiles[0])
            remaining = waitRoots(1)
            assert remaining[0]["path"] == str(folders[1].resolve()), "Closing VS Code must leave Cursor's root and the shared runtime alive"
            stopEditor(profiles[1])
            waitRoots(0)
            print("PASS actual VS Code + Cursor: one bundled VSIX, automatic runtime startup, prepared browser companion, multi-root registration, distinct window identities and independent window shutdown")
        finally:
            if not (state / "bridge-instance.json").exists():
                for application, log in zip(applications, applicationLogs):
                    log.flush()
                    log.seek(0)
                    print("APPLICATION DIAGNOSTIC", application.poll(), log.read()[-5000:])
                for filename in profiles[0].glob("logs/**/*exthost*.log"):
                    print("EDITOR DIAGNOSTIC", filename.name, filename.read_text(errors="replace")[-5000:])
                for filename in profiles[0].glob("logs/**/renderer.log"):
                    print("RENDERER DIAGNOSTIC", filename.read_text(errors="replace")[-4000:])
                for runtime in extensions[0].glob("relay-local.*/runtime/relayctl"):
                    print("RUNTIME PERMISSIONS", oct(runtime.stat().st_mode), "executable", os.access(runtime, os.X_OK))
            for profile in profiles:
                stopEditor(profile)
            for application in applications:
                if application.poll() is None:
                    application.terminate()
                    try:
                        application.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        application.kill()
                        application.wait(timeout=5)
            for log in applicationLogs:
                log.close()
            instance = state / "bridge-instance.json"
            if instance.exists():
                record = json.loads(instance.read_text())
                if str(record.get("port")) == str(port):
                    try:
                        os.kill(record["pid"], signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                    for attempt in range(50):
                        if not instance.exists():
                            break
                        time.sleep(0.1)


if __name__ == "__main__":
    verifyEditors()
