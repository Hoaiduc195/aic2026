"""FAISS index build + text-to-keyframe search.

IndexFlatIP over L2-normalized vectors = exact cosine search. At the expected
scale (tens of thousands of keyframes) this is fast enough that approximate
indexes (HNSW/IVF) are premature."""

import json
import time

import numpy as np
import pandas as pd


def build_index(cfg, store) -> None:
    import faiss
    maps, feats = [], []
    for f in sorted((store.root / "features").glob("*.npy")):
        vid = f.stem
        map_path = store.map_path(vid)
        if not map_path.exists():
            print(f"[index] SKIP {vid}: no map csv")
            continue
        m = pd.read_csv(map_path)
        x = np.load(f).astype(np.float32)
        if len(m) != len(x):
            print(f"[index] SKIP {vid}: {len(m)} csv rows != {len(x)} feature rows")
            continue
        maps.append(m)
        feats.append(x)
    if not maps:
        print("[index] nothing to index (no features found — was extract run with embedding on?)")
        return
    table = pd.concat(maps, ignore_index=True)
    x_all = np.ascontiguousarray(np.concatenate(feats))
    faiss.normalize_L2(x_all)  # fp16 round-trip may denormalize slightly
    index = faiss.IndexFlatIP(x_all.shape[1])
    index.add(x_all)
    faiss.write_index(index, str(store.faiss_path))
    table.to_parquet(store.index_table_path, index=False)
    store.index_meta_path.write_text(json.dumps({
        "n_vectors": int(index.ntotal),
        "dim": int(x_all.shape[1]),
        "n_videos": int(table["video_id"].nunique()),
        "embed_model": cfg.embed_model,
        "embed_pretrained": cfg.embed_pretrained,
    }, indent=2), encoding="utf-8")
    size_mb = store.faiss_path.stat().st_size / 2**20
    print(f"[index] {index.ntotal} vectors, dim {x_all.shape[1]}, {size_mb:.1f} MB")


# Diverse query set for latency benchmarking: scenes, actions, people, objects,
# colors, text-on-screen, weather, indoor/outdoor. Content does not need to
# match the dataset — latency is what is being measured.
BENCHMARK_QUERIES = [
    "a news anchor in a television studio",
    "a man riding a motorbike on a crowded street",
    "children playing football on a field",
    "a red car driving on a highway",
    "people cooking food in a kitchen",
    "a woman speaking into a microphone",
    "a dog running on the grass",
    "traffic lights at a busy intersection",
    "a boat sailing on a river",
    "people walking under umbrellas in the rain",
    "a street market with fruit stalls",
    "a building on fire with smoke",
    "an airplane taking off from a runway",
    "a crowd of people waving flags",
    "a doctor in a white coat at a hospital",
    "a mountain landscape at sunset",
    "two people shaking hands in an office",
    "a police car with flashing lights",
    "students sitting in a classroom",
    "a chef cutting vegetables with a knife",
    "a bridge over a river at night",
    "a person typing on a laptop",
    "colorful fireworks in the night sky",
    "a farmer working in a rice field",
]


def benchmark(cfg, store, k: int = 10, rounds: int = 5) -> dict:
    """Measure retrieval latency over a diverse query set: pure vector search
    and end-to-end (text encode + search). Writes index/benchmark.json which
    the report picks up."""
    import faiss
    from .embed import ClipEmbedder
    index = faiss.read_index(str(store.faiss_path))
    embedder = ClipEmbedder(cfg)

    search_ms, e2e_ms = [], []
    # warmup: first CUDA/text-tower call pays one-time init cost
    _ = embedder.encode_text([BENCHMARK_QUERIES[0]])
    index.search(np.ascontiguousarray(_.astype(np.float32)), k)

    for _round in range(rounds):
        for q in BENCHMARK_QUERIES:
            t0 = time.perf_counter()
            vec = np.ascontiguousarray(embedder.encode_text([q]).astype(np.float32))
            t1 = time.perf_counter()
            index.search(vec, k)
            t2 = time.perf_counter()
            search_ms.append((t2 - t1) * 1000)
            e2e_ms.append((t2 - t0) * 1000)

    def _stats(xs):
        xs = np.asarray(xs)
        return {"mean_ms": round(float(xs.mean()), 2),
                "p50_ms": round(float(np.percentile(xs, 50)), 2),
                "p95_ms": round(float(np.percentile(xs, 95)), 2)}

    result = {
        "n_queries": len(BENCHMARK_QUERIES),
        "rounds": rounds,
        "k": k,
        "n_vectors": int(index.ntotal),
        "vector_search": _stats(search_ms),
        "end_to_end": _stats(e2e_ms),
    }
    (store.root / "index" / "benchmark.json").write_text(
        json.dumps(result, indent=2), encoding="utf-8")
    print(f"[benchmark] {len(BENCHMARK_QUERIES)} queries x {rounds} rounds on "
          f"{index.ntotal:,} vectors (top-{k}):")
    print(f"[benchmark]   vector search  mean {result['vector_search']['mean_ms']} ms | "
          f"p50 {result['vector_search']['p50_ms']} | p95 {result['vector_search']['p95_ms']}")
    print(f"[benchmark]   end-to-end     mean {result['end_to_end']['mean_ms']} ms | "
          f"p50 {result['end_to_end']['p50_ms']} | p95 {result['end_to_end']['p95_ms']}")
    return result


def search(cfg, store, query: str, k: int = 10, embedder=None) -> pd.DataFrame:
    import faiss
    index = faiss.read_index(str(store.faiss_path))
    table = pd.read_parquet(store.index_table_path)
    if embedder is None:
        from .embed import ClipEmbedder
        embedder = ClipEmbedder(cfg)
    q = np.ascontiguousarray(embedder.encode_text([query]).astype(np.float32))
    t0 = time.perf_counter()
    scores, ids = index.search(q, k)
    latency_ms = (time.perf_counter() - t0) * 1000
    hits = table.iloc[[i for i in ids[0] if i >= 0]].copy().reset_index(drop=True)
    hits.insert(0, "score", scores[0][: len(hits)])
    print(f"[search] '{query}' -> top {len(hits)} in {latency_ms:.1f} ms (vector search only)")
    return hits
