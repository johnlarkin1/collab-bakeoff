// Shape bench in yrs 0.28 (the server's library). One fixture file per process.
// Usage: shape-yrs --file F --mode time|mem [--reps N]
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use yrs::types::ToJson;
use yrs::updates::decoder::Decode;
use yrs::{Any, Doc, Map, MapRef, Out, ReadTxn, StateVector, Transact, Update};

const ROOT: &str = "markup.icons";

fn arg(name: &str) -> Option<String> {
    let a: Vec<String> = std::env::args().collect();
    a.iter().position(|x| x == name).and_then(|i| a.get(i + 1).cloned())
}

fn max_rss_bytes() -> i64 {
    unsafe {
        let mut u: libc::rusage = std::mem::zeroed();
        libc::getrusage(libc::RUSAGE_SELF, &mut u);
        // macOS reports bytes, Linux kilobytes.
        if cfg!(target_os = "macos") { u.ru_maxrss } else { u.ru_maxrss * 1024 }
    }
}

fn load(bytes: &[u8]) -> Doc {
    let doc = Doc::new();
    {
        let mut txn = doc.transact_mut();
        txn.apply_update(Update::decode_v1(bytes).expect("decode")).expect("apply");
    }
    doc
}

fn edit(doc: &Doc, key: &str, field: &str, value: Any) -> Vec<u8> {
    let root: MapRef = doc.get_or_insert_map(ROOT);
    let sv: StateVector = doc.transact().state_vector();
    {
        let mut txn = doc.transact_mut();
        match root.get(&txn, key) {
            Some(Out::YMap(m)) => {
                m.insert(&mut txn, field, value);
            }
            Some(Out::Any(Any::Map(cur))) => {
                let mut next: HashMap<String, Any> = (*cur).clone();
                next.insert(field.to_string(), value);
                root.insert(&mut txn, key, Any::Map(Arc::new(next)));
            }
            other => panic!("unexpected value for {key}: {other:?}"),
        }
    }
    doc.transact().encode_state_as_update_v1(&sv)
}

fn main() {
    let file = arg("--file").expect("--file");
    let mode = arg("--mode").unwrap_or_else(|| "time".into());
    let bytes = std::fs::read(&file).expect("read");

    if mode == "mem" {
        let before = max_rss_bytes();
        let doc = load(&bytes);
        let after = max_rss_bytes();
        let n = doc.get_or_insert_map(ROOT).len(&doc.transact());
        println!(
            "{}",
            serde_json::json!({"peak_rss_delta_mb": (after - before) as f64 / 1e6, "items": n})
        );
        return;
    }

    let reps: usize = arg("--reps").and_then(|r| r.parse().ok()).unwrap_or(5);
    let mut load_ms = Vec::with_capacity(reps);
    let mut doc = None;
    for _ in 0..reps {
        drop(doc.take());
        let t = Instant::now();
        doc = Some(load(&bytes));
        load_ms.push(t.elapsed().as_secs_f64() * 1e3);
    }
    let doc = doc.unwrap();
    let root = doc.get_or_insert_map(ROOT);

    let t = Instant::now();
    let mut n = 0usize;
    {
        let txn = doc.transact();
        for (_, v) in root.iter(&txn) {
            let _json = v.to_json(&txn);
            n += 1;
        }
    }
    let to_json_ms = t.elapsed().as_secs_f64() * 1e3;

    let t = Instant::now();
    let _encoded = doc.transact().encode_state_as_update_v1(&StateVector::default());
    let encode_ms = t.elapsed().as_secs_f64() * 1e3;

    let key = {
        let txn = doc.transact();
        root.keys(&txn).next().map(|k| k.to_string()).expect("non-empty")
    };
    let one_edit = edit(&doc, &key, "x", Any::from(1234.5f64));

    let mut sorted = load_ms.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!(
        "{}",
        serde_json::json!({
            "icons": n,
            "load_ms": sorted[sorted.len() / 2],
            "load_ms_all": load_ms.iter().map(|x| (x * 10.0).round() / 10.0).collect::<Vec<_>>(),
            "to_json_ms": to_json_ms,
            "encode_ms": encode_ms,
            "edit_update_bytes": one_edit.len(),
        })
    );
}
