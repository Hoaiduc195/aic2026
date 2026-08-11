"""Install the headless subset of the local Sherpa distribution."""

from __future__ import annotations

import hashlib
import json
import shutil
from dataclasses import asdict, dataclass
from pathlib import Path

CORE_SOURCE_FILES = (
    "asr_engine.py",
    "audio_decode.py",
    "audio_preprocessing.py",
    "config.py",
    "gec_model.py",
    "gec_utils.py",
    "hardware_accel.py",
    "hotword_context.py",
    "punctuation_restorer_improved.py",
    "vad_utils.py",
    "vocabulary.py",
)

_MINIMAL_INIT = '\"\"\"Headless Sherpa core namespace.\"\"\"\n'


@dataclass(frozen=True)
class InstallManifest:
    source_dir: str
    target_dir: str
    files: tuple[str, ...]
    source_version: str

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


def install_sherpa_core(source_dir: Path, target_dir: Path | None = None) -> InstallManifest:
    """Copy only the pure-Python ASR closure and generate an audit manifest."""

    source = Path(source_dir).expanduser().resolve()
    if not source.is_dir():
        raise FileNotFoundError(source)

    source_core = source / "core"
    missing = [name for name in CORE_SOURCE_FILES if not (source_core / name).is_file()]
    if missing:
        raise FileNotFoundError(
            "Sherpa source is missing core file(s): " + ", ".join(missing)
        )

    target = (
        Path(target_dir).expanduser().resolve()
        if target_dir is not None
        else Path(__file__).with_name("vendor") / "core"
    )
    target.mkdir(parents=True, exist_ok=True)

    copied: list[str] = []
    for filename in CORE_SOURCE_FILES:
        source_path = source_core / filename
        target_path = target / filename
        text = source_path.read_text(encoding="utf-8")
        if filename == "punctuation_restorer_improved.py":
            text = _make_punctuation_headless(text)
        target_path.write_text(text, encoding="utf-8", newline="\n")
        copied.append(filename)

    init_path = target / "__init__.py"
    init_path.write_text(_MINIMAL_INIT, encoding="utf-8", newline="\n")
    copied.append("__init__.py")

    headless_analyzer = Path(__file__).with_name("headless_audio_analyzer.py")
    analyzer_target = target / "audio_analyzer.py"
    shutil.copy2(headless_analyzer, analyzer_target)
    copied.append("audio_analyzer.py")

    manifest = InstallManifest(
        source_dir=str(source),
        target_dir=str(target),
        files=tuple(sorted(copied)),
        source_version=_read_source_version(source),
    )
    manifest_path = target / "install-manifest.json"
    manifest_path.write_text(
        json.dumps(
            {
                **manifest.to_dict(),
                "sha256": {
                    name: _sha256(target / name)
                    for name in manifest.files
                    if (target / name).is_file()
                },
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
        newline="\n",
    )
    return manifest


def _make_punctuation_headless(text: str) -> str:
    old = "base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))"
    replacement = "from core.config import BASE_DIR as base_dir"
    if old not in text:
        raise ValueError("punctuation_restorer_improved.py has unexpected base path")
    return text.replace(old, replacement, 1)


def _read_source_version(source: Path) -> str:
    version_file = source / "core" / "version.py"
    if not version_file.is_file():
        return "unknown"
    for line in version_file.read_text(encoding="utf-8").splitlines():
        if "__version__" in line and "=" in line:
            return line.split("=", 1)[1].strip().strip("'\"")
    return "unknown"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for block in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()
