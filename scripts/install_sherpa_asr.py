"""CLI installer for the headless local Sherpa ASR core."""

from __future__ import annotations

import argparse
from pathlib import Path

from pipelines.feature_extraction.asr.installer import install_sherpa_core


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Install the GUI-free Sherpa ASR core into the ASR module."
    )
    parser.add_argument(
        "--source",
        type=Path,
        required=True,
        help="Sherpa distribution directory, for example E:\\aic2026\\sherpa-vietnamese-asr-2.6.3",
    )
    parser.add_argument(
        "--target",
        type=Path,
        default=None,
        help="Optional vendor/core target; defaults to the ASR module vendor directory",
    )
    args = parser.parse_args(argv)
    manifest = install_sherpa_core(args.source, args.target)
    print(f"Installed {len(manifest.files)} headless Sherpa files into {manifest.target_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
