# Greenfield multimodal video pipeline

This package is a new implementation under `pipelines/main`. It does not
import the legacy preprocessing or feature-extraction packages. The canonical
JSON Schemas remain in the repository-level `contracts/` directory and are
loaded at validation time.

## Local setup

```powershell
python -m pip install -r pipelines/main/requirements-local.txt
python -m pipelines.main plan --input data/video.mp4
python -m pipelines.main run --input data/video.mp4 --output-dir outputs --profile local
```

The local provider writes a run bundle under `outputs/runs/<run_id>`. Missing
optional model dependencies produce explicit node failures and a partial
bundle; they never create fake feature rows.

## Modal setup

Install and authenticate the Modal client locally:

```powershell
python -m pip install -r pipelines/main/requirements-modal.txt
modal token new
```

Configure a remote function for each Modal node in TOML:

```toml
[nodes.object_detection]
backend = "modal"

[nodes.object_detection.options]
app_name = "aic-main-pipeline"
function_name = "run_task"
```

The dispatcher sends task name, source identity, configuration and artifact
manifests. Remote workers must return a result envelope with `status`,
`metrics`, and optional error fields. Inputs are staged through the
content-addressed cache boundary in `storage/modal_cache.py`.

## Commands

```powershell
python -m pipelines.main plan --input data/video.mp4 --profile hybrid
python -m pipelines.main status --output-dir outputs --run-id RUN_ID
python -m pipelines.main resume --output-dir outputs --run-id RUN_ID
python -m pipelines.main retry --output-dir outputs --run-id RUN_ID --failed-only
```

`local` is the default profile. `hybrid` keeps timeline/keyframe work local
and routes model tasks to Modal. `modal` routes every configured task to the
remote dispatcher.

## Tests

```powershell
python -m unittest discover -s pipelines/main/tests -v
```
