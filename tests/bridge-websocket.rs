#![allow(non_snake_case)]
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    process::Stdio,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{process::Command, time::sleep};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message, client::IntoClientRequest},
};

fn extensionRequest(port: u16) -> tokio_tungstenite::tungstenite::http::Request<()> {
    let mut request = format!("ws://127.0.0.1:{port}")
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        "Origin",
        "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            .parse()
            .unwrap(),
    );
    request
}

fn testPort() -> u16 {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before Unix epoch")
        .subsec_nanos();
    20_000 + (nonce % 10_000) as u16
}

async fn connect(
    port: u16,
) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
    for _ in 0..40 {
        if let Ok((socket, _)) = connect_async(extensionRequest(port)).await {
            return socket;
        }
        sleep(Duration::from_millis(50)).await;
    }
    panic!("bridge did not accept a WebSocket connection");
}

async fn nextJson<S>(socket: &mut S) -> Value
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    loop {
        let message = socket
            .next()
            .await
            .expect("bridge closed")
            .expect("read bridge frame");
        if let Message::Text(text) = message {
            return serde_json::from_str(&text).expect("bridge returned JSON");
        }
    }
}

#[tokio::test]
async fn bridgeRoutesWorkspaceCapabilities() {
    let port = testPort();
    let directory = std::env::temp_dir().join(format!("relay-ws-{}-{port}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    let mut bridge = Command::new(env!("CARGO_BIN_EXE_relay-bridge"))
        .env("RELAY_BRIDGE_PORT", port.to_string())
        .env("RELAY_STATE_DIR", &directory)
        .env("RELAY_CONFIG", directory.join("config.json"))
        .env("RELAY_WORKSPACE", env!("CARGO_MANIFEST_DIR"))
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("start bridge");

    let mut socket = connect(port).await;
    assert_eq!(nextJson(&mut socket).await["type"], "pairingRequired");
    let token = std::fs::read_to_string(directory.join("bridge-token")).unwrap();
    let token = token.trim();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(directory.join("bridge-token"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    socket
        .send(Message::Text(
            json!({"type":"authenticate","token":token})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    let connected = nextJson(&mut socket).await;
    assert_eq!(connected["type"], "connected");
    assert_eq!(connected["workspaceReady"], true);

    socket
        .send(Message::Text(
            json!({"id": 1, "type": "capability.list", "token":token})
                .to_string()
                .into(),
        ))
        .await
        .expect("request tools");
    let tools = nextJson(&mut socket).await;
    assert_eq!(tools["type"], "tools");
    let listDir = tools["tools"]
        .as_array()
        .expect("tool list")
        .iter()
        .find_map(|tool| {
            tool["name"]
                .as_str()
                .filter(|name| name.ends_with("workspace.list"))
        })
        .expect("workspace.list capability")
        .to_owned();

    socket
        .send(Message::Text(
            json!({"id": 10, "type": "workspace.list", "token": token})
                .to_string()
                .into(),
        ))
        .await
        .expect("list workspaces");
    let workspaces = nextJson(&mut socket).await;
    assert_eq!(workspaces["ok"], true, "{workspaces}");
    let workspaceId = workspaces["workspaces"][0]["id"]
        .as_str()
        .expect("headless workspace ID")
        .to_owned();
    socket
        .send(Message::Text(
            json!({"id": 11, "type": "session.open", "token": token, "workspaceId": workspaceId})
                .to_string()
                .into(),
        ))
        .await
        .expect("bind workspace session");
    let bound = nextJson(&mut socket).await;
    assert_eq!(bound["ok"], true, "{bound}");
    let sessionId = bound["sessionId"].as_str().expect("session ID").to_owned();

    socket.send(Message::Text(json!({"id": 2, "type": "capability.invoke", "token": token, "sessionId": sessionId, "workspaceId": workspaceId, "name": listDir, "arguments": {"path": "."}, "timeout": 5_000}).to_string().into())).await.expect("call workspace tool");
    let result = nextJson(&mut socket).await;
    assert_eq!(result["type"], "actionResult");
    assert_eq!(result["ok"], true);
    assert!(
        result["text"]
            .as_str()
            .expect("tool text")
            .contains("Cargo.toml")
    );
    socket.send(Message::Text(json!({"id":22,"type":"capability.invoke","token":token,"sessionId":sessionId,"workspaceId":workspaceId,"name":listDir,"arguments":{"path":"."}}).to_string().into())).await.unwrap();
    assert_eq!(
        nextJson(&mut socket).await["ok"],
        true,
        "A subsequent request must be allowed to re-read the same directory"
    );

    socket
        .send(Message::Text(
            json!({"id": 3, "type": "session.authorize", "token": token, "sessionId": sessionId, "workspaceId": workspaceId, "confirm": true, "access": "full"})
                .to_string()
                .into(),
        ))
        .await
        .expect("grant full access");
    let access = nextJson(&mut socket).await;
    assert_eq!(access["type"], "accessState");
    assert_eq!(access["ok"], true, "{access}");
    assert_eq!(access["access"], "full");

    let (program, args) = if cfg!(windows) {
        ("cmd", vec!["/C", "echo relay-full-access"])
    } else {
        ("sh", vec!["-c", "printf relay-full-access"])
    };
    socket.send(Message::Text(json!({"id": 4, "type": "capability.invoke", "token": token, "sessionId": sessionId, "workspaceId": workspaceId, "name": "process.run", "arguments": {"command": program, "args": args}, "timeout": 5_000}).to_string().into())).await.expect("run granted command");
    let command = nextJson(&mut socket).await;
    assert_eq!(command["ok"], true);
    assert!(
        command["text"]
            .as_str()
            .expect("command text")
            .contains("relay-full-access")
    );

    let mut evil = extensionRequest(port);
    evil.headers_mut()
        .insert("Origin", "https://evil.example".parse().unwrap());
    assert!(connect_async(evil).await.is_err());
    assert!(
        connect_async(format!("ws://127.0.0.1:{port}"))
            .await
            .is_err()
    );
    socket
        .send(Message::Text(
            json!({"type":"session.authorize","token":token,"access":"full"})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    assert_eq!(nextJson(&mut socket).await["ok"], false);
    let mut local = format!("ws://127.0.0.1:{port}")
        .into_client_request()
        .unwrap();
    local
        .headers_mut()
        .insert("Authorization", format!("Bearer {token}").parse().unwrap());
    let (mut local, _) = connect_async(local).await.unwrap();
    assert_eq!(nextJson(&mut local).await["type"], "connected");
    local.close(None).await.unwrap();
    for attempt in 0..5 {
        socket
            .send(Message::Text(
                json!({"type":if attempt == 0 { "capability.list" } else { "capability.invoke" },"name":"workspace.list","token":if attempt == 1 { "wrong-token" } else { "" }})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        assert_eq!(nextJson(&mut socket).await["error"], "unauthorized");
    }
    assert!(matches!(
        socket.next().await,
        Some(Ok(Message::Close(_))) | None
    ));
    assert!(connect_async(extensionRequest(port)).await.is_err());
    bridge.kill().await.expect("stop bridge");
    bridge.wait().await.expect("reap bridge");
}
