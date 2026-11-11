//! One Rivet actor per project holding a `yrs` doc, speaking y-websocket over a raw actor
//! WebSocket. `COLLAB_STORE=sqlite` logs updates in the actor's SQLite (`actor`);
//! `COLLAB_STORE=pg` logs them in Postgres with a group commit (`actor-pg`).

mod store;

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{Context, Result};
use async_trait::async_trait;
use rivetkit::prelude::*;
use rivetkit::{ActorConfig, Request, Response, WebSocket, WsMessage};
use tokio::sync::{Mutex, mpsc, oneshot};
use yrs::encoding::read::{Cursor, Read};
use yrs::encoding::write::Write;
use yrs::sync::{Message, SyncMessage};
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::{Encode, Encoder, EncoderV1};
use yrs::{Doc, ReadTxn, StateVector, Transact, Update};

use store::{Batch, Store};

const MSG_SYNC: u32 = 0;
const MSG_AWARENESS: u32 = 1;
const MSG_ACK: u32 = 10;
/// y-websocket's encoding of an update with no structs and an empty delete set.
const EMPTY_UPDATE: &[u8] = &[0, 0];

static NEXT_SOCKET: AtomicU64 = AtomicU64::new(1);

enum Cmd {
    Open(u64, WebSocket),
    Msg(u64, Vec<u8>),
    Close(u64),
    Flush(oneshot::Sender<()>),
    Stats(oneshot::Sender<Result<i64>>),
}

pub struct DocActor {
    tx: mpsc::UnboundedSender<Cmd>,
    rx: Mutex<Option<mpsc::UnboundedReceiver<Cmd>>>,
}

#[async_trait]
impl Actor for DocActor {
    type Input = ();
    type Actions = ();
    type Events = ();
    type ConnParams = ();
    type Action = ();

    async fn create(_ctx: &Ctx<Self>) -> Result<Self> {
        let (tx, rx) = mpsc::unbounded_channel();
        Ok(Self { tx, rx: Mutex::new(Some(rx)) })
    }

    async fn run(self: Arc<Self>, ctx: Ctx<Self>) -> Result<()> {
        let rx = self.rx.lock().await.take().context("doc loop already running")?;
        let project = project_id(&ctx);
        let store = Store::open(&ctx, &project).await?;
        doc_loop(store, rx).await
    }

    async fn on_websocket(
        self: Arc<Self>,
        _ctx: Ctx<Self>,
        ws: WebSocket,
        _req: Request,
    ) -> Result<()> {
        let id = NEXT_SOCKET.fetch_add(1, Ordering::Relaxed);
        let tx = self.tx.clone();
        ws.configure_message_event_callback(Some(Arc::new(move |msg, _| {
            if let WsMessage::Binary(data) = msg {
                let _ = tx.send(Cmd::Msg(id, data));
            }
            Ok(())
        })));
        let tx = self.tx.clone();
        ws.configure_close_event_callback(Some(Arc::new(move |_, _, _| {
            let _ = tx.send(Cmd::Close(id));
            Box::pin(async { Ok(()) })
        })));
        let _ = self.tx.send(Cmd::Open(id, ws));
        Ok(())
    }

    async fn on_fetch(self: Arc<Self>, _ctx: Ctx<Self>, req: Request) -> Result<Response> {
        let (_, path, _, _) = req.to_parts();
        if !path.trim_end_matches('/').ends_with("stats") {
            return Response::from_parts(404, HashMap::new(), Vec::new());
        }
        let (reply, rx) = oneshot::channel();
        let _ = self.tx.send(Cmd::Stats(reply));
        let bytes = rx.await.context("doc loop gone")??;
        let body = serde_json::json!({ "bytes": bytes }).to_string().into_bytes();
        let headers = HashMap::from([("content-type".to_owned(), "application/json".to_owned())]);
        Response::from_parts(200, headers, body)
    }

    async fn on_sleep(self: Arc<Self>, _ctx: Ctx<Self>) -> Result<()> {
        let (reply, rx) = oneshot::channel();
        if self.tx.send(Cmd::Flush(reply)).is_ok() {
            let _ = rx.await;
        }
        Ok(())
    }
}

fn project_id(ctx: &Ctx<DocActor>) -> String {
    ctx.key()
        .iter()
        .map(|s| match s {
            rivetkit::ActorKeySegment::String(s) => s.clone(),
            rivetkit::ActorKeySegment::Number(n) => n.to_string(),
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// Owns the doc. Applies and broadcasts in arrival order; the persister acks after commit.
async fn doc_loop(store: Store, mut rx: mpsc::UnboundedReceiver<Cmd>) -> Result<()> {
    let snapshot_every: i64 = std::env::var("SNAPSHOT_EVERY")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(500);
    let doc = Doc::new();
    let (snapshot, rows) = store.load().await?;
    let mut seq = 0i64;
    let mut since_snapshot = 0i64;
    {
        let mut txn = doc.transact_mut();
        if let Some((s, state)) = snapshot {
            txn.apply_update(Update::decode_v1(&state)?)?;
            seq = s;
        }
        for (s, update) in rows {
            txn.apply_update(Update::decode_v1(&update)?)?;
            seq = s;
            since_snapshot += 1;
        }
    }
    tracing::info!(seq, replayed = since_snapshot, "doc loaded");

    let (persist_tx, persist_rx) = mpsc::unbounded_channel::<Batch>();
    let persister = tokio::spawn(store.clone().persist(persist_rx));
    let mut sockets: HashMap<u64, WebSocket> = HashMap::new();

    while let Some(cmd) = rx.recv().await {
        match cmd {
            Cmd::Open(id, ws) => {
                let txn = doc.transact();
                let sv = txn.state_vector();
                let full = txn.encode_state_as_update_v1(&StateVector::default());
                drop(txn);
                ws.send(WsMessage::Binary(Message::Sync(SyncMessage::SyncStep1(sv)).encode_v1()));
                ws.send(WsMessage::Binary(Message::Sync(SyncMessage::SyncStep2(full)).encode_v1()));
                sockets.insert(id, ws);
            }
            Cmd::Close(id) => {
                sockets.remove(&id);
            }
            Cmd::Flush(reply) => {
                let _ = persist_tx.send(Batch::flush(reply));
            }
            Cmd::Stats(reply) => {
                let _ = persist_tx.send(Batch::stats(reply));
            }
            Cmd::Msg(id, data) => {
                let Some(ws) = sockets.get(&id).cloned() else { continue };
                let Ok(tag) = Cursor::new(&data).read_var::<u32>() else { continue };
                match tag {
                    MSG_AWARENESS => {
                        for (other, s) in &sockets {
                            if *other != id {
                                s.send(WsMessage::Binary(data.clone()));
                            }
                        }
                    }
                    MSG_SYNC => {
                        let msg = match Message::decode_v1(&data) {
                            Ok(Message::Sync(m)) => m,
                            _ => {
                                tracing::warn!(id, "undecodable sync message");
                                continue;
                            }
                        };
                        let update = match msg {
                            SyncMessage::SyncStep1(sv) => {
                                let diff = doc.transact().encode_state_as_update_v1(&sv);
                                let reply = Message::Sync(SyncMessage::SyncStep2(diff));
                                ws.send(WsMessage::Binary(reply.encode_v1()));
                                continue;
                            }
                            SyncMessage::SyncStep2(u) | SyncMessage::Update(u) => u,
                        };
                        if update.as_slice() == EMPTY_UPDATE {
                            let _ = persist_tx.send(Batch::ack_only(ws, seq));
                            continue;
                        }
                        let decoded = match Update::decode_v1(&update) {
                            Ok(u) => u,
                            Err(e) => {
                                tracing::warn!(id, error = %e, "bad update");
                                continue;
                            }
                        };
                        if let Err(e) = doc.transact_mut().apply_update(decoded) {
                            tracing::warn!(id, error = %e, "apply failed");
                            continue;
                        }
                        seq += 1;
                        since_snapshot += 1;
                        let bcast = Message::Sync(SyncMessage::Update(update.clone())).encode_v1();
                        for (other, s) in &sockets {
                            if *other != id {
                                s.send(WsMessage::Binary(bcast.clone()));
                            }
                        }
                        let snapshot = (since_snapshot >= snapshot_every).then(|| {
                            since_snapshot = 0;
                            let state =
                                doc.transact().encode_state_as_update_v1(&StateVector::default());
                            (seq, state)
                        });
                        let _ = persist_tx.send(Batch::update(ws, seq, update, snapshot));
                    }
                    _ => {}
                }
            }
        }
    }
    drop(persist_tx);
    let _ = persister.await;
    Ok(())
}

fn ack(seq: i64) -> Vec<u8> {
    let mut e = EncoderV1::new();
    e.write_var(MSG_ACK);
    e.write_var(seq as u64);
    e.to_vec()
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();
    let mode = std::env::var("COLLAB_STORE").unwrap_or_else(|_| "sqlite".into());
    let name = match mode.as_str() {
        "sqlite" => "doc_sqlite",
        "pg" => {
            store::init_pg().await?;
            "doc_pg"
        }
        other => anyhow::bail!("unknown COLLAB_STORE {other}"),
    };
    let config = ActorConfig {
        max_incoming_message_size: 256 * 1024 * 1024,
        max_outgoing_message_size: 256 * 1024 * 1024,
        ..ActorConfig::default()
    };
    let mut registry = Registry::new();
    registry.register_actor_with::<DocActor>(name, config);
    tracing::info!(name, mode, "serving");
    registry.start().await
}
