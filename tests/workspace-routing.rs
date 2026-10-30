#![allow(non_snake_case)]
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    path::Path,
    process::Stdio,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::time::{sleep, timeout};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message, client::IntoClientRequest},
};

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
async fn reply(socket: &mut Socket) -> Value {
    timeout(Duration::from_secs(15), async {
        loop {
            let frame = socket.next().await.unwrap().unwrap();
            if let Message::Text(text) = frame {
                return serde_json::from_str(&text).unwrap();
            }
        }
    })
    .await
    .expect("bridge response timeout")
}
async fn request(socket: &mut Socket, token: &str, mut value: Value) -> Value {
    value["token"] = json!(token);
    value["id"] = json!("test");
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .unwrap();
    reply(socket).await
}
async fn native(port: u16, token: &str) -> Socket {
    let mut req = format!("ws://127.0.0.1:{port}")
        .into_client_request()
        .unwrap();
    req.headers_mut()
        .insert("Authorization", format!("Bearer {token}").parse().unwrap());
    let (mut socket, _) = connect_async(req).await.unwrap();
    assert_eq!(reply(&mut socket).await["type"], "connected");
    socket
}
fn registration(editor: &str, window: &str, roots: &[&Path]) -> Value {
    json!({"type":"workspace.register","editor":{"id":editor,"name":editor,"version":"test"},"windowId":window,"trusted":true,"roots":roots.iter().map(|path|json!({"uri":url::Url::from_directory_path(path).unwrap().to_string(),"name":"project"})).collect::<Vec<_>>()})
}
async fn call(socket: &mut Socket, token: &str, session: &Value, name: &str, args: Value) -> Value {
    request(socket, token, json!({"type":"capability.invoke","sessionId":session["sessionId"],"workspaceId":session["workspaceId"],"name":name,"arguments":args})).await
}

#[tokio::test]
async fn routesSessionsByWindowAndRootAndFailsClosedOnTargetLoss() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("relay-routing-{}-{nonce}", std::process::id()));
    let a = dir.join("editor-a/project");
    let b = dir.join("editor-b/project");
    let extra = dir.join("other-root");
    for root in [&a, &b, &extra] {
        std::fs::create_dir_all(root).unwrap();
    }
    std::fs::write(a.join("marker.txt"), "A").unwrap();
    std::fs::write(b.join("marker.txt"), "B").unwrap();
    let mut bridge = tokio::process::Command::new(env!("CARGO_BIN_EXE_relay-bridge"))
        .env("RELAY_BRIDGE_PORT", port.to_string())
        .env("RELAY_STATE_DIR", &dir)
        .env("RELAY_CONFIG", dir.join("config.json"))
        .env_remove("RELAY_WORKSPACE")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    for _ in 0..100 {
        if tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_ok()
        {
            break;
        }
        sleep(Duration::from_millis(40)).await;
    }
    let token = std::fs::read_to_string(dir.join("bridge-token")).unwrap();
    let token = token.trim();
    let mut ownerA = native(port, token).await;
    let mut ownerB = native(port, token).await;
    let mut browser = native(port, token).await;
    let ra = request(
        &mut ownerA,
        token,
        registration("vscode", "window-a", &[&a, &extra]),
    )
    .await;
    assert_eq!(ra["ok"], true, "native registration must succeed: {ra}");
    assert_eq!(
        ra["workspaces"].as_array().unwrap().len(),
        2,
        "all multi-root folders must register"
    );
    let rb = request(
        &mut ownerB,
        token,
        registration("cursor", "window-b", &[&b]),
    )
    .await;
    assert_eq!(rb["ok"], true, "{rb}");
    let wa = ra["workspaces"][0]["id"].clone();
    let wb = rb["workspaces"][0]["id"].clone();
    let sa = request(
        &mut browser,
        token,
        json!({"type":"session.open","workspaceId":wa}),
    )
    .await;
    let sb = request(
        &mut browser,
        token,
        json!({"type":"session.open","workspaceId":wb}),
    )
    .await;
    assert_eq!(sa["ok"], true, "{sa}");
    assert_eq!(sb["ok"], true, "{sb}");
    for (session, expected) in [(&sa, "A"), (&sb, "B")] {
        let result = call(
            &mut browser,
            token,
            session,
            "workspace.readText",
            json!({"path":"marker.txt"}),
        )
        .await;
        assert_eq!(result["text"], expected, "{result}");
    }
    let wrong=request(&mut browser,token,json!({"type":"capability.invoke","sessionId":sa["sessionId"],"workspaceId":wb,"name":"workspace.write","arguments":{"path":"marker.txt","content":"WRONG"}})).await;
    assert_eq!(
        wrong["ok"], false,
        "a chat must never switch target through request parameters"
    );
    assert_eq!(std::fs::read_to_string(b.join("marker.txt")).unwrap(), "B");
    let unbound = request(
        &mut browser,
        token,
        json!({"type":"capability.invoke","name":"workspace.list","arguments":{}}),
    )
    .await;
    assert_eq!(
        unbound["ok"], false,
        "unbound requests must not fall back to the last active window"
    );
    let grant=request(&mut browser,token,json!({"type":"session.authorize","sessionId":sb["sessionId"],"workspaceId":wb,"access":"full","confirm":true})).await;
    assert_eq!(grant["ok"], true, "{grant}");
    let executable = env!("CARGO_BIN_EXE_relayctl");
    let unrestricted = call(
        &mut browser,
        token,
        &sb,
        "process.run",
        json!({"command":executable,"args":["version"]}),
    )
    .await;
    assert_eq!(
        unrestricted["ok"], true,
        "Full access must accept executables outside the Workspace allowlist: {unrestricted}"
    );
    assert!(
        unrestricted["text"]
            .as_str()
            .unwrap()
            .contains(env!("CARGO_PKG_VERSION"))
    );
    let restricted = call(
        &mut browser,
        token,
        &sa,
        "process.run",
        json!({"command":executable,"args":["version"]}),
    )
    .await;
    assert_eq!(
        restricted["ok"], false,
        "Full access in B must not change A's command permissions"
    );
    #[cfg(unix)]
    {
        let cleanup = b.join("command-cleanup.txt");
        std::fs::write(&cleanup, "temporary command test").unwrap();
        let removed = call(
            &mut browser,
            token,
            &sb,
            "process.run",
            json!({"command":"rm","args":[cleanup]}),
        )
        .await;
        assert_eq!(removed["ok"], true, "{removed}");
        assert!(
            !cleanup.exists(),
            "Full access rm must remove the test file"
        );
    }
    let escaped = call(
        &mut browser,
        token,
        &sa,
        "workspace.readText",
        json!({"path":b.join("marker.txt")}),
    )
    .await;
    assert_eq!(escaped["ok"], false, "full access in B must not elevate A");
    let written = call(
        &mut browser,
        token,
        &sa,
        "workspace.create",
        json!({"path":"new.txt","content":"only A"}),
    )
    .await;
    assert_eq!(written["ok"], true, "{written}");
    assert!(!b.join("new.txt").exists());
    let operation = "c".repeat(64);
    let action = json!({"type":"capability.invoke","sessionId":sa["sessionId"],"workspaceId":wa,"name":"workspace.create","arguments":{"path":"receipt.txt","content":"created once"},"operationId":operation});
    assert_eq!(
        request(&mut browser, token, action.clone()).await["ok"],
        true
    );
    assert_eq!(
        request(&mut browser, token, action).await["ok"],
        true,
        "Retry must reuse the receipt, not attempt another create"
    );

    request(
        &mut ownerA,
        token,
        registration("vscode", "window-a", &[&a]),
    )
    .await;
    let stale = call(
        &mut browser,
        token,
        &sa,
        "workspace.write",
        json!({"path":"marker.txt","content":"STALE"}),
    )
    .await;
    assert_eq!(stale["ok"], false, "{stale}");
    assert_eq!(std::fs::read_to_string(a.join("marker.txt")).unwrap(), "A");
    assert_eq!(
        call(
            &mut browser,
            token,
            &sb,
            "workspace.readText",
            json!({"path":"marker.txt"})
        )
        .await["text"],
        "B"
    );
    let lateFile = b.join("orphan.txt");
    let source = format!(
        "const {{spawn}}=require('node:child_process');spawn(process.execPath,['-e',{}],{{stdio:'inherit'}});setTimeout(()=>{{}},10000)",
        serde_json::to_string(&format!(
            "setTimeout(()=>require('node:fs').writeFileSync({},'orphan'),1800)",
            serde_json::to_string(&lateFile).unwrap()
        ))
        .unwrap()
    );
    browser.send(Message::Text(json!({"id":"slow","type":"capability.invoke","token":token,"sessionId":sb["sessionId"],"workspaceId":wb,"name":"process.run","arguments":{"command":"node","args":["-e",source]},"operationId":"d".repeat(64)}).to_string().into())).await.unwrap();
    sleep(Duration::from_millis(150)).await;
    browser
        .send(Message::Text(
            json!({"id":"heartbeat","type":"ping","token":token})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    let heartbeat = tokio::time::timeout(Duration::from_secs(1), reply(&mut browser))
        .await
        .expect("Heartbeat must remain responsive while a process runs");
    assert_eq!(heartbeat["type"], "pong", "{heartbeat}");
    ownerB.close(None).await.unwrap();
    let cancelled = tokio::time::timeout(Duration::from_secs(2), reply(&mut browser))
        .await
        .unwrap();
    assert_eq!(
        cancelled["ok"], false,
        "Closing the owner must cancel its running action"
    );
    assert_eq!(cancelled["kind"], "workspaceUnavailable");
    sleep(Duration::from_millis(2100)).await;
    assert!(
        !lateFile.exists(),
        "Cancelling a workspace must stop descendant processes too"
    );
    sleep(Duration::from_millis(100)).await;
    assert_eq!(
        call(&mut browser, token, &sb, "workspace.list", json!({})).await["ok"],
        false,
        "closed windows must invalidate sessions"
    );
    bridge.kill().await.unwrap();
    let _ = bridge.wait().await;
    let _ = std::fs::remove_dir_all(dir);
}
