#![allow(non_snake_case)]
use anyhow::{Result, bail};
use serde_json::Value;
use std::{collections::HashMap, future::Future, sync::Arc};
use tokio::sync::{Mutex, OnceCell};

struct Receipt {
    request: Value,
    outcome: OnceCell<std::result::Result<Value, String>>,
}

#[derive(Default)]
pub(super) struct ExecutionJournal {
    receipts: Mutex<HashMap<String, Arc<Receipt>>>,
}

impl ExecutionJournal {
    pub async fn resolve<F>(&self, operation: &str, request: Value, execution: F) -> Result<Value>
    where
        F: Future<Output = Result<Value>>,
    {
        if operation.len() != 64 || !operation.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            bail!("An action requires a 64-character operation identity");
        }
        let receipt = {
            let mut receipts = self.receipts.lock().await;
            if let Some(existing) = receipts.get(operation) {
                if existing.request != request {
                    bail!("Operation identity is already attached to another action");
                }
                existing.clone()
            } else {
                if receipts.len() >= 1024 {
                    bail!("This run reached its receipt limit. Start a new workspace session.");
                }
                let receipt = Arc::new(Receipt {
                    request,
                    outcome: OnceCell::new(),
                });
                receipts.insert(operation.into(), receipt.clone());
                receipt
            }
        };
        receipt
            .outcome
            .get_or_init(|| async { execution.await.map_err(|error| error.to_string()) })
            .await
            .clone()
            .map_err(anyhow::Error::msg)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn receiptsCoalesceConcurrentRetriesAndRejectChangedPayloads() {
        let journal = ExecutionJournal::default();
        let count = AtomicUsize::new(0);
        let operation = "a".repeat(64);
        let run = || async {
            count.fetch_add(1, Ordering::SeqCst);
            tokio::task::yield_now().await;
            Ok(json!({"written":true}))
        };
        let (first, second) = tokio::join!(
            journal.resolve(&operation, json!("request"), run()),
            journal.resolve(&operation, json!("request"), run())
        );
        assert_eq!(first.unwrap(), second.unwrap());
        assert_eq!(count.load(Ordering::SeqCst), 1);
        assert!(
            journal
                .resolve(&operation, json!("changed"), run())
                .await
                .is_err()
        );
    }
}
