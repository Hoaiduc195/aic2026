"""Greenfield multimodal video feature pipeline.

This package is intentionally independent from the legacy preprocessing and
feature-extraction packages.  It uses the repository-level ``contracts``
package as its canonical schema boundary.
"""

from .config import PipelineConfig
from .service import PipelineService

__all__ = ["PipelineConfig", "PipelineService"]
