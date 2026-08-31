# Greenfield Multimodal Pipeline

`pipelines/main` is a new orchestration DAG for one or more videos. This package
has its own registry, nodes, checkpoints, and artifact store, and **does not
import** the legacy pipelines in `pipelines/preprocessing` or
`pipelines/feature_extraction`.

The canonical JSON Schemas still come from the repository-level
[contracts/](../../contracts/README.md) and are validated at each node
boundary.

## Default task graph

```text
ingestion -> frame_manifest -> shot_detection -> keyframes
          -> visual_embedding, asr, ocr, object_detection, captioning
          -> normalization
```

Dependency closure is added automatically when a task is selected. If an
optional model dependency is missing, the node returns a clear error and the
run may finish with status `partial`; the system does not create fake feature
rows to hide the failure.

## Profiles

| Profile | Execution |
|---|---|
| `local` | All nodes use local providers |
| `hybrid` | Timeline/keyframe core runs locally; model tasks may run on Modal |
| `modal` | Configured nodes run through the Modal dispatcher |

The default is `local`. The example configuration is in
[pipeline.example.toml](pipeline.example.toml); it includes the
pipeline/schema version, dataset identity, task list, and options for each
node.

## Installation

### Local

Python `3.11+` is required:

```powershell
python -m pip install -r pipelines/main/requirements-local.txt
```

### Modal

```powershell
python -m pip install -r pipelines/main/requirements-modal.txt
modal token new
```

Modal nodes receive the task name, source identity, configuration, and artifact
manifest. The content-addressed cache in `storage/modal_cache.py` prevents
unchanged artifacts from being staged again.

## CLI

From the repository root, create a plan before running it:

```powershell
python -m pipelines.main plan `
  --input data/video.mp4 --profile local

python -m pipelines.main run `
  --input data/video.mp4 `
  --output-dir outputs `
  --profile local
```

You can pass multiple `--input` values, or a directory with `--input-dir`.
Add `--recursive` to scan subdirectories. `--tasks` runs a subset, while still
adding all required dependencies to the DAG.

Manage runs:

```powershell
python -m pipelines.main status `
  --output-dir outputs --run-id RUN_ID

python -m pipelines.main resume `
  --output-dir outputs --run-id RUN_ID

python -m pipelines.main retry `
  --output-dir outputs --run-id RUN_ID --failed-only
```

`run` exits successfully for status `completed` or `partial`.
`status` reads the run record without rerunning the pipeline.

## Output and resume

Each run is namespaced under:

```text
outputs/runs/<run_id>/
├── run.json
├── checkpoints/<video_id>/<task>.json
├── processing_runs/<video_id>/<task>.json
└── artifacts/
```

A checkpoint contains the input/config/node fingerprint. Only checkpoints with
status `completed` and a matching fingerprint are reused; changing the input
or configuration reruns that node. A processing run records dataset, pipeline,
and schema versions, input/output artifact IDs, metrics, and errors for audit.

## Boundary with the legacy pipeline

Use this package when you need a DAG orchestrator with profiles, retry/resume,
and a unified artifact contract. Use
[pipelines/preprocessing/README.md](../preprocessing/README.md) for the existing
two-stage keyframe pipeline and its sparse/dense commands. Use the relevant
feature-extraction README when running an independent worker on Modal.

## Verification

```powershell
python -m unittest discover -s pipelines/main/tests -v
```

Changes to a node contract must update the validator, fixtures, and tests in
the same commit. Do not bypass `partial` status by writing placeholder output.
