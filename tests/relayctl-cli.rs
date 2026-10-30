#![allow(non_snake_case)]
use std::{fs, process::Command};

fn uniqueTempDir() -> std::path::PathBuf {
    let nonce = rand::random::<u128>();
    let path = std::env::temp_dir().join(format!("relayctl-test-{}-{nonce}", std::process::id()));
    fs::create_dir_all(&path).expect("create test directory");
    path
}

fn relayctl(directory: &std::path::Path, args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_relayctl"))
        .args(args)
        .current_dir(directory)
        .env("RELAY_CONFIG", directory.join("config.json"))
        .output()
        .expect("run relayctl")
}

#[test]
fn serverCommandsPersistAndRemoveACustomServer() {
    let directory = uniqueTempDir();

    let add = relayctl(&directory, &["server", "add", "demo", "echo", "hello"]);
    assert!(
        add.status.success(),
        "{}",
        String::from_utf8_lossy(&add.stderr)
    );

    let list = relayctl(&directory, &["server", "list"]);
    assert!(list.status.success());
    assert!(String::from_utf8_lossy(&list.stdout).contains("demo\techo"));

    let config = fs::read_to_string(directory.join("config.json")).expect("read generated config");
    assert!(config.contains("\"demo\""));
    assert!(config.contains("\"hello\""));

    let remove = relayctl(&directory, &["server", "remove", "demo"]);
    assert!(
        remove.status.success(),
        "{}",
        String::from_utf8_lossy(&remove.stderr)
    );
    let config = fs::read_to_string(directory.join("config.json")).expect("read updated config");
    assert!(!config.contains("\"demo\""));

    fs::remove_dir_all(directory).expect("remove test directory");
}

#[test]
fn managedWorkspaceServerCannotBeChanged() {
    let directory = uniqueTempDir();
    let output = relayctl(&directory, &["server", "add", "workspace", "anything"]);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("managed by Relay"));
    fs::remove_dir_all(directory).expect("remove test directory");
}

#[cfg(not(windows))]
#[test]
fn configLookupIsStableAndLocalFileTakesPrecedence() {
    let directory = uniqueTempDir();
    let configHome = directory.join("config-home");
    let run = |explicit: Option<&std::path::Path>| {
        let mut command = Command::new(env!("CARGO_BIN_EXE_relayctl"));
        command
            .current_dir(&directory)
            .env_remove("RELAY_CONFIG")
            .env("XDG_CONFIG_HOME", &configHome)
            .args(["server", "list"]);
        if let Some(path) = explicit {
            command.env("RELAY_CONFIG", path);
        }
        let result = command.output().unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    };
    run(None);
    assert!(configHome.join("relay/config.json").exists());
    std::fs::write(directory.join("config.json"), "{}").unwrap();
    run(None);
    let explicit = directory.join("elsewhere/config.json");
    run(Some(&explicit));
    assert!(explicit.exists());
    std::fs::remove_dir_all(directory).unwrap();
}
