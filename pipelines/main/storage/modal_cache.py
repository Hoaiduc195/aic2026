"""Content-addressed staging boundary for Modal inputs."""

from __future__ import annotations

import hashlib
import os
import shutil
from pathlib import Path


class ContentAddressedCache:
    """Stage immutable local files once per content hash.

    The resulting path is suitable for a Modal Volume uploader or another
    remote transport.  This class intentionally has no Modal import so local
    runs stay dependency-free.
    """

    def __init__(self, root: Path) -> None:
        self.root = Path(root).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def stage(self, source: Path) -> tuple[str, Path]:
        source = Path(source).expanduser().resolve()
        digest = self.sha256(source)
        target = self.root / digest[:2] / digest / source.name
        if not target.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_name(f".{target.name}.tmp")
            shutil.copyfile(source, temporary)
            os.replace(temporary, target)
        return digest, target

    @staticmethod
    def sha256(path: Path) -> str:
        digest = hashlib.sha256()
        with Path(path).open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()
