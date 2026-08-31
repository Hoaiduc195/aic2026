# TRAKE (Temporal Retrieval and Alignment of Key Events)

This guide explains how the TRAKE feature is implemented in this codebase. If you're contributing to the retrieval system, scoring mechanisms, or the temporal alignment algorithm, this document will help you understand the end-to-end flow.

## Overview

Unlike standard retrieval tasks (like `textual_kis` or `vqa`) that search for individual keyframes matching a query, **TRAKE** queries consist of an ordered sequence of events. The goal of a TRAKE task is to return an ordered sequence of frames within a single video that semantically match the respective events in the query, strictly maintaining chronological order.

TRAKE is executed only when the request explicitly provides 1-20 events separately and numbers them sequentially from `1.` through `N.`. A prose description containing words such as “then” or “after” is not sufficient; the agent must not invent or split events.

For example, a query like:
1. `mở cửa` (opens door)
2. `bước vào phòng` (steps into the room)
3. `ngồi xuống` (sits down)

Requires finding a sequence of 3 strictly increasing frame IDs in the same video, where frame 1 matches "opens door", frame 2 matches "steps into the room", etc.

## How It Works Under The Hood

The TRAKE execution path touches three major components in the `apps/backend` package:

### 1. The Query Planner
The query planner detects `trake` queries and automatically splits the temporal events into independent `query_variants`. For example, a 3-event query generates 3 distinct query variants.

### 2. Retrieval Service & Fusion (`retrieval.service.ts` & `fusion.ts`)
Instead of completely squashing variant data, the `RetrievalService` maintains a `variant_scores` object on each retrieved candidate. 
- When `runBranchVariants` executes, it tracks which candidate scored how highly on which variant index.
- During fusion in `fuseBranchResults`, the system calculates a Reciprocal Rank Fusion (RRF) contribution *per variant*. This ensures that a single candidate `FusedCandidate` carries a map of scores corresponding to each query event it might match.

### 3. Viterbi Aligner (`trake.executor.ts`)
The `TrakeExecutor` is responsible for taking these candidates and finding the optimal chronological sequence.
- **Grouping**: Candidates are grouped by `video_id`.
- **Dynamic Programming (Viterbi)**: For each video, the candidates are sorted by their `original_frame_id`. A DP algorithm scans through the sorted candidates to find the highest-scoring sequence of frames that matches the events (0 to N-1). It enforces the constraint that the `original_frame_id`s must strictly increase.
- **Boosting**: The candidates that form the winning sequence are boosted in score and emitted as the top results.

The MCP layer applies the same safety constraints when checking exact evidence locally: it
groups evidence by video, finds the best chronological path for the N event descriptions,
requires strictly increasing `originalFrameId` values, and never treats frames from
different videos as one TRAKE sequence. The number of events is not hard-coded to four;
the current bounded MCP tools accept 1-20 events.

## Relevant Files

- **`apps/backend/src/tasks/trake/trake.executor.ts`**: The core DP/Viterbi temporal sequence aligner.
- **`apps/backend/src/retrieval/retrieval.service.ts`**: Handles the execution of variant queries and aggregates per-variant scores.
- **`apps/backend/src/retrieval/fusion.ts`**: Handles RRF calculation per query variant.
- **`contracts/schemas/trake_alignment/schema.json`**: The canonical JSON schema validating TRAKE output configurations.

## Testing

When making changes to the TRAKE aligner or variant scoring, you can run the test suite to ensure temporal ordering and schema validation are maintained:

```bash
cd apps/backend
npm run test
```

Pay special attention to `tests/task-executors.test.ts` and `tests/retrieval.service.test.ts` where TRAKE-specific unit behaviors are asserted.
