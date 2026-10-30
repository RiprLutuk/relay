#![allow(non_snake_case)]
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

fn requestServer(requests: &[&str]) -> Vec<String> {
    let binary = env!("CARGO_BIN_EXE_relay-workspace");
    let mut child = Command::new(binary)
        .env("RELAY_WORKSPACE", env!("CARGO_MANIFEST_DIR"))
        .env("RELAY_ACCESS_MODE", "workspace")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("start VS Code MCP");
    let mut stdin = child.stdin.take().expect("MCP stdin");
    for request in requests {
        writeln!(stdin, "{request}").expect("write MCP request");
    }
    drop(stdin);
    let responses = BufReader::new(child.stdout.take().expect("MCP stdout"))
        .lines()
        .map(|line| line.expect("read MCP response"))
        .collect();
    child.wait().expect("reap MCP server");
    responses
}

fn fixtureCall(
    root: &std::path::Path,
    name: &str,
    arguments: serde_json::Value,
) -> serde_json::Value {
    use serde_json::json;
    let mut child = Command::new(env!("CARGO_BIN_EXE_relay-workspace"))
        .env("RELAY_WORKSPACE", root)
        .env("RELAY_ACCESS_MODE", "workspace")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    writeln!(
        child.stdin.take().unwrap(),
        "{}",
        json!({"id":1,"method":"tools/call","params":{"name":name,"arguments":arguments}})
    )
    .unwrap();
    let output = child.wait_with_output().unwrap();
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn gitLogAndPythonTestsUseExplicitWorkspace() {
    let root = std::env::temp_dir().join(format!("relay-fixture-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let git = |args: &[&str]| {
        assert!(
            Command::new("git")
                .args(args)
                .current_dir(&root)
                .output()
                .unwrap()
                .status
                .success()
        )
    };
    git(&["init"]);
    git(&[
        "-c",
        "user.name=Relay Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "fixture commit",
    ]);
    let log = fixtureCall(&root, "vcs.log", serde_json::json!({"limit":1}));
    assert!(
        log["result"]["content"][0]["text"]
            .as_str()
            .unwrap_or("")
            .contains("fixture commit"),
        "{log}"
    );
    std::fs::write(
        root.join("pyproject.toml"),
        "[tool.pytest.ini_options]\naddopts = '-q'\n",
    )
    .unwrap();
    std::fs::write(
        root.join("test_relay.py"),
        "def test_relay():\n    assert 2 + 2 == 4\n",
    )
    .unwrap();
    let python = if cfg!(windows) { "python" } else { "python3" };
    let pytestAvailable = Command::new(python)
        .args(["-m", "pytest", "--version"])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false);
    let tests = fixtureCall(&root, "project.test", serde_json::json!({}));
    if pytestAvailable {
        assert!(
            tests["result"]["content"][0]["text"]
                .as_str()
                .unwrap_or("")
                .contains("passed"),
            "pytest is installed, so the Python tests must pass: {tests}"
        );
    } else {
        assert!(
            tests["error"]["message"]
                .as_str()
                .unwrap_or("")
                .contains("No module named pytest"),
            "Missing pytest must produce an explicit dependency error: {tests}"
        );
    }
    let denied = fixtureCall(
        &root,
        "process.run",
        serde_json::json!({"command":"python3","args":["-c","print('forbidden')"]}),
    );
    assert!(
        denied["error"]["message"]
            .as_str()
            .unwrap_or("")
            .contains("limited")
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn readFileLinesReachesEndOfLargeFile() {
    let root = std::env::temp_dir().join(format!("relay-large-lines-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let mut content = String::new();
    for line in 1..=4100 {
        content.push_str(&format!("line-{line}: {}\n", "x".repeat(64)));
    }
    assert!(content.len() > 200_000);
    std::fs::write(root.join("large.js"), content).unwrap();
    let result = fixtureCall(
        &root,
        "workspace.read",
        serde_json::json!({"path":"large.js","startLine":4050,"endLine":4052}),
    );
    let text = result["result"]["content"][0]["text"]
        .as_str()
        .expect("line-range response must contain text");
    assert!(text.contains("4050: line-4050:"), "{result}");
    assert!(text.contains("4052: line-4052:"), "{result}");
    assert!(!text.contains("[truncated]"), "{result}");
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn workspaceServerAdvertisesProtocol() {
    let responses =
        requestServer(&["{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{}}"]);
    assert_eq!(responses.len(), 1);
    assert!(responses[0].contains("2024-11-05"));
}

#[test]
fn workspaceModeRejectsShellExecution() {
    let responses = requestServer(&[
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{}}",
        "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"process.run\",\"arguments\":{\"command\":\"sh\",\"args\":[\"-c\",\"echo unsafe\"]}}}",
    ]);
    assert_eq!(responses.len(), 2);
    assert!(
        responses[1].contains("Workspace mode blocks"),
        "{}",
        responses[1]
    );
    let invalid = requestServer(&[
        "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"process.run\",\"arguments\":{\"command\":\"git\",\"args\":[\"status\",null]}}}",
    ]);
    assert!(
        invalid[0].contains("Every process argument must be a string"),
        "{}",
        invalid[0]
    );
}
