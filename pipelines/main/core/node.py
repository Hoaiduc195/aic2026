"""Node protocol and shared base class."""

from __future__ import annotations

import hashlib
import json
from abc import ABC, abstractmethod
from typing import Any

from .models import NodeContext, NodeResult


class PipelineNode(ABC):
    task_name: str
    provider: str
    dependencies: tuple[str, ...] = ()

    def fingerprint(self, context: NodeContext) -> str:
        payload = {
            "task": self.task_name,
            "provider": self.provider,
            "run_id": context.run_id,
            "video_id": context.video_id,
            "config": context.config.stable_json(),
            "inputs": sorted(str(key) for key in context.artifacts),
        }
        encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(encoded.encode("utf-8")).hexdigest()

    @abstractmethod
    async def run(self, context: NodeContext) -> NodeResult:
        raise NotImplementedError
