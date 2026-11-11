//! Update log + snapshot storage: the actor's SQLite, or a shared Postgres group-commit writer.

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use rivetkit::{BindParam, ColumnValue, Ctx, SqliteBatchStatement, SqliteDb, WebSocket, WsMessage};
use tokio::sync::{mpsc, oneshot};
use tokio_postgres::{Client, NoTls};

use crate::{DocActor, ack};

const GROUP_ROWS: usize = 256;
const GROUP_WAIT: Duration = Duration::from_millis(10);

type Snapshot = Option<(i64, Vec<u8>)>;
type Rows = Vec<(i64, Vec<u8>)>;

pub enum Batch {
    Update { ws: WebSocket, seq: i64, update: Vec<u8>, snapshot: Snapshot },
    AckOnly { ws: WebSocket, seq: i64 },
    Flush(oneshot::Sender<()>),
    Stats(oneshot::Sender<Result<i64>>),
}

impl Batch {
    pub fn update(ws: WebSocket, seq: i64, update: Vec<u8>, snapshot: Snapshot) -> Self {
        Self::Update { ws, seq, update, snapshot }
    }
    pub fn ack_only(ws: WebSocket, seq: i64) -> Self {
        Self::AckOnly { ws, seq }
    }
    pub fn flush(reply: oneshot::Sender<()>) -> Self {
        Self::Flush(reply)
    }
    pub fn stats(reply: oneshot::Sender<Result<i64>>) -> Self {
        Self::Stats(reply)
    }
}

#[derive(Clone)]
pub enum Store {
    Sqlite(SqliteDb),
    Pg(Arc<String>),
}

struct Pg {
    writer: mpsc::UnboundedSender<PgReq>,
    reader: Client,
}

struct PgReq {
    project: Arc<String>,
    rows: Rows,
    snapshot: Snapshot,
    reply: oneshot::Sender<Result<()>>,
}

static PG: OnceLock<Pg> = OnceLock::new();

async fn pg_connect() -> Result<Client> {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://bakeoff:bakeoff@127.0.0.1:55442/bakeoff".into());
    let (client, conn) = tokio_postgres::connect(&url, NoTls).await?;
    tokio::spawn(async move {
        if let Err(e) = conn.await {
            tracing::error!(error = %e, "postgres connection lost");
        }
    });
    Ok(client)
}

/// Creates the schema and the process-wide group-commit writer.
pub async fn init_pg() -> Result<()> {
    let reader = pg_connect().await?;
    reader
        .batch_execute(
            "CREATE TABLE IF NOT EXISTS doc_updates (
                project_id text NOT NULL, seq bigint NOT NULL, \"update\" bytea NOT NULL,
                PRIMARY KEY (project_id, seq));
             CREATE TABLE IF NOT EXISTS doc_snapshots (
                project_id text PRIMARY KEY, seq bigint NOT NULL, state bytea NOT NULL);",
        )
        .await?;
    let writer_client = pg_connect().await?;
    let (writer, rx) = mpsc::unbounded_channel();
    tokio::spawn(pg_writer(writer_client, rx));
    PG.set(Pg { writer, reader }).map_err(|_| anyhow!("pg already initialized"))
}

/// Group commit: at most `GROUP_WAIT` after the first request, or `GROUP_ROWS` rows.
async fn pg_writer(mut client: Client, mut rx: mpsc::UnboundedReceiver<PgReq>) {
    while let Some(first) = rx.recv().await {
        let mut rows = first.rows.len();
        let mut batch = vec![first];
        let deadline = tokio::time::sleep(GROUP_WAIT);
        tokio::pin!(deadline);
        while rows < GROUP_ROWS {
            tokio::select! {
                r = rx.recv() => match r {
                    Some(r) => { rows += r.rows.len(); batch.push(r) }
                    None => break,
                },
                _ = &mut deadline => break,
            }
        }
        let result = pg_commit(&mut client, &batch).await;
        for req in batch {
            let _ = req.reply.send(result.as_ref().map(|_| ()).map_err(|e| anyhow!("{e:#}")));
        }
    }
}

async fn pg_commit(client: &mut Client, batch: &[PgReq]) -> Result<()> {
    let mut projects = Vec::new();
    let mut seqs = Vec::new();
    let mut updates: Vec<&[u8]> = Vec::new();
    for req in batch {
        for (seq, update) in &req.rows {
            projects.push(req.project.as_str());
            seqs.push(*seq);
            updates.push(update);
        }
    }
    let tx = client.transaction().await?;
    tx.execute(
        "INSERT INTO doc_updates (project_id, seq, \"update\")
         SELECT * FROM unnest($1::text[], $2::bigint[], $3::bytea[])",
        &[&projects, &seqs, &updates],
    )
    .await?;
    for req in batch {
        if let Some((seq, state)) = &req.snapshot {
            tx.execute(
                "INSERT INTO doc_snapshots (project_id, seq, state) VALUES ($1, $2, $3)
                 ON CONFLICT (project_id) DO UPDATE SET seq = excluded.seq, state = excluded.state",
                &[&*req.project, seq, state],
            )
            .await?;
            tx.execute(
                "DELETE FROM doc_updates WHERE project_id = $1 AND seq <= $2",
                &[&*req.project, seq],
            )
            .await?;
        }
    }
    tx.commit().await?;
    Ok(())
}

fn pg() -> Result<&'static Pg> {
    PG.get().context("pg not initialized")
}

impl Store {
    pub async fn open(ctx: &Ctx<DocActor>, project: &str) -> Result<Self> {
        if PG.get().is_some() {
            return Ok(Self::Pg(Arc::new(project.to_owned())));
        }
        let db = ctx.sql().clone();
        db.exec(
            "CREATE TABLE IF NOT EXISTS updates (seq INTEGER PRIMARY KEY, data BLOB NOT NULL);
             CREATE TABLE IF NOT EXISTS snapshot (
                id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL, data BLOB NOT NULL);",
        )
        .await?;
        Ok(Self::Sqlite(db))
    }

    /// Latest snapshot, then the log rows after it in seq order.
    pub async fn load(&self) -> Result<(Snapshot, Rows)> {
        match self {
            Self::Sqlite(db) => {
                let snap = db.query("SELECT seq, data FROM snapshot WHERE id = 1", None).await?;
                let snapshot = snap.rows.into_iter().next().map(sqlite_row).transpose()?;
                let after = snapshot.as_ref().map_or(0, |(s, _)| *s);
                let rows = db
                    .query(
                        "SELECT seq, data FROM updates WHERE seq > ? ORDER BY seq",
                        Some(vec![BindParam::Integer(after)]),
                    )
                    .await?
                    .rows
                    .into_iter()
                    .map(sqlite_row)
                    .collect::<Result<_>>()?;
                Ok((snapshot, rows))
            }
            Self::Pg(project) => {
                let c = &pg()?.reader;
                let snapshot = c
                    .query_opt(
                        "SELECT seq, state FROM doc_snapshots WHERE project_id = $1",
                        &[&**project],
                    )
                    .await?
                    .map(|r| (r.get::<_, i64>(0), r.get::<_, Vec<u8>>(1)));
                let after = snapshot.as_ref().map_or(0, |(s, _)| *s);
                let rows = c
                    .query(
                        "SELECT seq, \"update\" FROM doc_updates
                         WHERE project_id = $1 AND seq > $2 ORDER BY seq",
                        &[&**project, &after],
                    )
                    .await?
                    .into_iter()
                    .map(|r| (r.get(0), r.get(1)))
                    .collect();
                Ok((snapshot, rows))
            }
        }
    }

    async fn write(&self, rows: Rows, snapshot: Snapshot) -> Result<()> {
        if rows.is_empty() && snapshot.is_none() {
            return Ok(());
        }
        match self {
            Self::Sqlite(db) => {
                let mut stmts: Vec<SqliteBatchStatement> = rows
                    .into_iter()
                    .map(|(seq, data)| SqliteBatchStatement {
                        sql: "INSERT INTO updates (seq, data) VALUES (?, ?)".into(),
                        params: Some(vec![BindParam::Integer(seq), BindParam::Blob(data)]),
                    })
                    .collect();
                if let Some((seq, data)) = snapshot {
                    stmts.push(SqliteBatchStatement {
                        sql: "INSERT OR REPLACE INTO snapshot (id, seq, data) VALUES (1, ?, ?)".into(),
                        params: Some(vec![BindParam::Integer(seq), BindParam::Blob(data)]),
                    });
                    stmts.push(SqliteBatchStatement {
                        sql: "DELETE FROM updates WHERE seq <= ?".into(),
                        params: Some(vec![BindParam::Integer(seq)]),
                    });
                }
                db.execute_batch(stmts).await?;
                Ok(())
            }
            Self::Pg(project) => {
                let (reply, rx) = oneshot::channel();
                pg()?
                    .writer
                    .send(PgReq { project: project.clone(), rows, snapshot, reply })
                    .map_err(|_| anyhow!("pg writer gone"))?;
                rx.await.context("pg writer dropped reply")?
            }
        }
    }

    async fn stats(&self) -> Result<i64> {
        match self {
            Self::Sqlite(db) => {
                let r = db
                    .query(
                        "SELECT (SELECT coalesce(sum(length(data)), 0) FROM updates)
                              + (SELECT coalesce(sum(length(data)), 0) FROM snapshot)",
                        None,
                    )
                    .await?;
                match r.rows.first().and_then(|r| r.first()) {
                    Some(ColumnValue::Integer(n)) => Ok(*n),
                    _ => Ok(0),
                }
            }
            Self::Pg(project) => {
                let row = pg()?
                    .reader
                    .query_one(
                        "SELECT (SELECT coalesce(sum(octet_length(\"update\")), 0)::bigint
                                 FROM doc_updates WHERE project_id = $1)
                              + (SELECT coalesce(sum(octet_length(state)), 0)::bigint
                                 FROM doc_snapshots WHERE project_id = $1)",
                        &[&**project],
                    )
                    .await?;
                Ok(row.get(0))
            }
        }
    }

    /// Writes queued updates in groups and acks each sender after its group commits.
    pub async fn persist(self, mut rx: mpsc::UnboundedReceiver<Batch>) {
        let mut pending: Option<Batch> = None;
        loop {
            let first = match pending.take() {
                Some(b) => b,
                None => match rx.recv().await {
                    Some(b) => b,
                    None => return,
                },
            };
            match first {
                Batch::Flush(reply) => {
                    let _ = reply.send(());
                    continue;
                }
                Batch::Stats(reply) => {
                    let _ = reply.send(self.stats().await);
                    continue;
                }
                _ => {}
            }
            let mut group = vec![first];
            let mut n = 1;
            while n < GROUP_ROWS {
                match rx.try_recv() {
                    Ok(b @ (Batch::Update { .. } | Batch::AckOnly { .. })) => {
                        group.push(b);
                        n += 1;
                    }
                    Ok(other) => {
                        pending = Some(other);
                        break;
                    }
                    Err(_) => break,
                }
            }
            let mut rows = Vec::new();
            let mut snapshot = None;
            let mut acks = Vec::with_capacity(group.len());
            for b in group {
                match b {
                    Batch::Update { ws, seq, update, snapshot: s } => {
                        rows.push((seq, update));
                        if s.is_some() {
                            snapshot = s;
                        }
                        acks.push((ws, seq));
                    }
                    Batch::AckOnly { ws, seq } => acks.push((ws, seq)),
                    _ => unreachable!("only updates and acks are grouped"),
                }
            }
            match self.write(rows, snapshot).await {
                Ok(()) => {
                    for (ws, seq) in acks {
                        ws.send(WsMessage::Binary(ack(seq)));
                    }
                }
                Err(e) => {
                    tracing::error!(error = %format!("{e:#}"), "append failed; closing senders");
                    for (ws, _) in acks {
                        ws.close(Some(1011), Some("append failed".into())).await;
                    }
                }
            }
        }
    }
}

fn sqlite_row(row: Vec<ColumnValue>) -> Result<(i64, Vec<u8>)> {
    match row.as_slice() {
        [ColumnValue::Integer(seq), ColumnValue::Blob(data)] => Ok((*seq, data.clone())),
        other => Err(anyhow!("unexpected row shape: {other:?}")),
    }
}
