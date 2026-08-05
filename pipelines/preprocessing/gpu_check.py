"""Fail fast, with an actionable message, when the installed PyTorch build
cannot actually run kernels on the attached GPU (e.g. Kaggle's P100 = sm_60,
which recent PyTorch wheels no longer ship kernels for). `.to("cuda")` alone
does not trigger this -- it only shows up on the first real kernel launch --
so we force one tiny matmul here before any heavy model is loaded."""


def assert_cuda_usable(device: str) -> None:
    if device != "cuda":
        return
    try:
        import torch
    except ModuleNotFoundError:
        # torch not installed at all (e.g. local CPU-only dev env) -- shots.py
        # and extract.py already fall back gracefully in that case.
        return

    if not torch.cuda.is_available():
        print("[gpu] --device cuda requested but torch.cuda.is_available() is False.")
        raise SystemExit(1)

    try:
        a = torch.ones(4, 4, device="cuda")
        (a @ a).cpu()
    except RuntimeError as e:
        name = torch.cuda.get_device_name(0)
        cap = torch.cuda.get_device_capability(0)
        print(
            f"[gpu] CUDA device '{name}' (compute capability sm_{cap[0]}{cap[1]}) is not supported by "
            f"the installed PyTorch build ({torch.__version__}).\n"
            f"[gpu] This is the known Kaggle P100 (sm_60, Pascal) vs. newer PyTorch (sm_70+ only) mismatch.\n"
            f"[gpu] Fix: Notebook Settings -> Accelerator -> switch 'GPU P100' to 'GPU T4 x2', "
            f"then Restart & Run All. (T4 is sm_75 and fully supported; it is also generally as fast or "
            f"faster than P100 for CLIP/TransNetV2 fp16 inference.)\n"
            f"[gpu] Original error: {e}"
        )
        raise SystemExit(1) from e
