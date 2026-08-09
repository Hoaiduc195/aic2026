# Keyframe Pipeline: GitHub -> Kaggle -> Cloudflare R2 Runbook

This runbook is the operational companion to the technical design in
[`pipelines/preprocessing/README.md`](../pipelines/preprocessing/README.md).
It describes the supported production path for running keyframe preprocessing
on Kaggle while keeping raw video in Cloudflare R2.

## Deployment flow

```text
local development
  -> reviewed commit on GitHub main
  -> Kaggle notebook clones that exact commit
  -> notebook reads credential-free r2:// URIs
  -> preprocessing streams immutable R2 object ranges
  -> checkpoints and results are written under /kaggle/working/outputs
  -> committed outputs are uploaded under a dedicated R2 run prefix
```

GitHub stores source code only. R2 stores raw video and durable outputs. Kaggle
provides ephemeral compute; `/kaggle/input` is read-only and
`/kaggle/working` is lost unless the notebook version is saved or artifacts are
uploaded elsewhere.

## Required Kaggle settings

1. Sign in and open the `aic26-pipeline` notebook.
2. From a published/read-only view, choose **Copy & Edit** (or **Edit** when
   signed in as the owner) to enter the notebook editor.
3. Enable Internet so the notebook can clone GitHub, install requirements,
   download model assets, and reach R2.
4. Select a GPU accelerator for SigLIP/DINO extraction.
5. Add these Kaggle Secrets; never paste their values into a cell or commit an
   `.env` file:

   - `R2_ACCOUNT_ID`
   - `R2_ACCESS_KEY_ID`
   - `R2_SECRET_ACCESS_KEY`
   - `R2_BUCKET_NAME`

The R2 token needs object read plus bucket-list permission for the configured
raw-video prefix. Output upload additionally needs object write permission for
the run prefix. Prefer separate least-privilege read and write credentials in
production.

## First smoke run

The checked-in notebook defaults to:

```python
USE_R2 = True
SMOKE_LIMIT = 1
LIMIT_HOURS = None
R2_VIDEO_PREFIX = ""  # current team bucket stores videos at its root
R2_OUTPUT_PREFIX = "aic-runs/keyframes-smoke"
```

Change only the two prefixes to match the bucket layout. Run the notebook from
the first cell. The setup cell deletes the previous ephemeral clone, clones
`main`, and prints `git rev-parse HEAD`; compare that SHA with the expected
GitHub commit before spending GPU time.

The main invocation is equivalent to:

```bash
python -m pipelines.preprocessing.cli all \
  --source-uri-file /kaggle/working/r2_sources.txt \
  --out /kaggle/working/outputs \
  --device cuda \
  --limit 1 \
  --artifact-uri-prefix r2://BUCKET/aic-runs/keyframes-smoke
```

Success criteria for the one-video smoke run:

- `videos_manifest.parquet` has one canonical R2 source row;
- `frame_manifests/{video_id}.parquet` is non-empty;
- `retrieval_frames/{video_id}.parquet`, keyframe WebPs, and metadata exist;
- the FAISS index and `REPORT.md` are produced when embedding is enabled;
- `failed_videos.log` is absent or contains no row for the smoke video;
- outputs are uploaded only under `R2_OUTPUT_PREFIX`.

## Scale-up and resume

After the smoke run succeeds, set `SMOKE_LIMIT = None`. Optionally set
`LIMIT_HOURS` for a bounded stratified run. Use a new output prefix for a new
configuration or source revision. Reuse the same prefix only when intentionally
resuming compatible checkpoints.

The pipeline fingerprints source identity and stage configuration. It pins R2
objects by VersionId or ETag and refuses to mix byte ranges from different
object revisions. If a raw object is intentionally replaced at the same key,
refresh the manifest/checkpoints rather than treating it as the old video.

The notebook's resume and upload cells are prefix-scoped. They must never list,
download, or upload the entire bucket root because raw video and unrelated runs
may share the bucket.

## Source change checklist

Before pushing a preprocessing change:

```powershell
python -m unittest discover -s tests -q
git diff --check
git status --short
```

Confirm that no `.env`, access key, token, raw video, model weight, generated
output, or local cache is staged. Preserve new data fields through the JSON
contracts under `contracts/schemas/` and add a regression test for behavioral
changes. Keep the documentation split by responsibility:

- root `README.md`: repository map and supported capabilities;
- preprocessing `README.md`: algorithms, contracts, CLI, and output layout;
- this runbook: Kaggle/R2 deployment and recovery;
- `contracts/schemas/`: machine-readable source of truth;
- `tests/`: executable acceptance evidence.

## Automatic notebook execution

Cloning GitHub inside a notebook means Kaggle receives current code only after
the notebook starts. A GitHub push alone does not start an interactive Kaggle
session. For push-triggered batch execution, store the notebook's
`kernel-metadata.json` beside the `.ipynb` and have GitHub Actions run:

```bash
kaggle kernels push -p pipelines/preprocessing/kaggle
```

Keep the Kaggle API token in GitHub Actions Secrets. Establish this automation
only after the manual one-video smoke run is stable, because every push can
consume Kaggle GPU quota.
