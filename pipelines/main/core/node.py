"""Node protocol and shared base class."""

from __future__ import annotations

import hashlib
import json
from abc import ABC, abstractmethod

from .models import NodeContext, NodeResult


class PipelineNode(ABC):
    task_name: str
    provider: str
    dependencies: tuple[str, ...] = ()
    allow_failed_dependencies: bool = False

    def fingerprint(self, context: NodeContext) -> str:
        payload = {
            "task": self.task_name,
            "provider": self.provider,
            "run_id": context.run_id,
            "video_id": context.video_id,
            "config": context.config.stable_json(),
            "inputs": {
                str(key): [
                    {
                        "artifact_id": str(getattr(artifact, "artifact_id", "")),
                        "sha256": str(getattr(artifact, "sha256", "")),
                    }
                    for artifact in getattr(result, "artifacts", ())
                ]
                for key, result in sorted(context.artifacts.items())
            },
        }
        encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(encoded.encode("utf-8")).hexdigest()

    @abstractmethod
    async def run(self, context: NodeContext) -> NodeResult:
        raise NotImplementedError
