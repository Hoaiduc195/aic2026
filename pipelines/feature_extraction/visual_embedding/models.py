from __future__ import annotations
from dataclasses import dataclass, field
from typing import Optional, List, Any, Dict

@dataclass
class SourceFrameRef:
    video_id: str
    original_frame_id: int
    timestamp_ms: float

@dataclass
class QualityScores:
    brightness_score: float
    blur_score: float
    contrast_score: float
    entropy_score: float
    motion_score: Optional[float] = None
    scene_change_score: Optional[float] = None
    text_change_score: Optional[float] = None

@dataclass
class RetrievalKeyframe:
    """Matches contracts/schemas/keyframe/schema.json"""
    video_id: str
    original_frame_id: int
    timestamp_ms: float
    storage_uri: str
    retrieval_roles: List[str]
    quality_scores: Dict[str, float]
    quality_route: str
    selected_for_retrieval: bool
    
    # Optional fields based on schema
    dataset_id: Optional[str] = None
    dataset_version: Optional[str] = None
    decoded_frame_index: Optional[int] = None
    segment_id: Optional[str] = None
    shot_id: Optional[Any] = None
    shot_ids: Optional[List[int]] = None
    n: Optional[int] = None
    pts: Optional[int] = None
    frame_idx: Optional[int] = None
    pts_time: Optional[float] = None
    fps: Optional[str] = None
    path: Optional[str] = None
    source_storage_uri: Optional[str] = None
    frame_id: Optional[str] = None
    quality_reason: Optional[str] = None
    eligible_for_embedding: Optional[bool] = None
    quality_ok: Optional[bool] = None
    brightness: Optional[float] = None
    std_score: Optional[float] = None
    pipeline_version: Optional[str] = None
    schema_version: Optional[str] = None
    evidence_ids: Optional[List[str]] = None
    
    @classmethod
    def from_dict(cls, data: dict) -> RetrievalKeyframe:
        # Create a copy and extract fields
        d = dict(data)
        
        # If quality_scores is a string or something weird, we just pass the dict directly.
        # But pandas dataframe might give us a dict directly.
        return cls(**d)

@dataclass
class EmbeddingResult:
    """Matches contracts/schemas/embedding_result/schema.json"""
    video_id: str
    segment_id: str
    embedding_uri: str
    embedding_dim: int
    model_name: str
    model_version: str
    
    timestamp_ms: Optional[int] = None
    embedding_id: Optional[str] = None
    dataset_id: Optional[str] = None
    dataset_version: Optional[str] = None
    original_frame_id: Optional[int] = None
    frame_id: Optional[str] = None
    dtype: Optional[str] = None
    normalized: Optional[bool] = None
    pipeline_version: Optional[str] = None
    schema_version: Optional[str] = "1.0.0"
    
    def to_dict(self) -> dict:
        d = {
            "video_id": self.video_id,
            "segment_id": self.segment_id,
            "embedding_uri": self.embedding_uri,
            "embedding_dim": self.embedding_dim,
            "model_name": self.model_name,
            "model_version": self.model_version
        }
        
        # Add optionals
        for k in ["timestamp_ms", "embedding_id", "dataset_id", "dataset_version", "original_frame_id", "frame_id", 
                  "dtype", "normalized", "pipeline_version", "schema_version"]:
            val = getattr(self, k, None)
            if val is not None:
                d[k] = val
                
        return d
