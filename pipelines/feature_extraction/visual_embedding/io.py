import os
import uuid
import numpy as np
import pandas as pd
from pathlib import Path
from typing import List, Tuple, Dict, Any, Generator, Union
from PIL import Image
import logging

from pipelines.feature_extraction.visual_embedding.models import RetrievalKeyframe, EmbeddingResult
from pipelines.feature_extraction.visual_embedding.config import VisualEmbeddingConfig

logger = logging.getLogger(__name__)

def load_keyframes_manifest(parquet_path: Union[str, Path]) -> List[RetrievalKeyframe]:
    """Load keyframe metadata from a parquet file."""
    df = pd.read_parquet(parquet_path)
    
    keyframes = []
    # Convert records to RetrievalKeyframe objects
    for record in df.to_dict(orient="records"):
        # Fill in missing but required fields for the schema if needed, 
        # though the preprocessor should have output them perfectly.
        try:
            kf = RetrievalKeyframe.from_dict(record)
            keyframes.append(kf)
        except Exception as e:
            logger.warning(f"Skipping a record due to schema mismatch: {e}")
            
    return keyframes

def batch_keyframes(keyframes: List[RetrievalKeyframe], batch_size: int) -> Generator[List[RetrievalKeyframe], None, None]:
    """Yield batches of keyframes."""
    for i in range(0, len(keyframes), batch_size):
        yield keyframes[i:i + batch_size]

def load_image(uri: str) -> Image.Image:
    """
    Load an image from a URI or local path.
    Currently assumes local file paths since R2 files are usually downloaded 
    to a working directory during Kaggle execution.
    """
    # Simple file protocol stripping
    if uri.startswith("file://"):
        uri = uri[7:]
        # Fix windows paths if needed e.g. file:///C:/... -> /C:/... -> C:/...
        if os.name == 'nt' and uri.startswith('/'):
            uri = uri[1:]
            
    img = Image.open(uri)
    # Ensure it's in RGB mode (e.g. convert from RGBA/grayscale if needed)
    return img.convert("RGB")

def save_embeddings(
    output_dir: Union[str, Path], 
    video_id: str, 
    embeddings: np.ndarray, 
    keyframes: List[RetrievalKeyframe],
    config: VisualEmbeddingConfig
) -> Tuple[str, str]:
    """
    Save the embedding numpy array and the corresponding parquet metadata.
    Returns the paths to the generated .npy and .parquet files.
    """
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    
    npy_path = output_dir / f"{video_id}.npy"
    parquet_path = output_dir / f"{video_id}.parquet"
    
    # Save the dense vector matrix
    np.save(npy_path, embeddings)
    
    # Construct the EmbeddingResult records
    results = []
    
    # We assign an embedding ID for the entire chunk/video or individually per vector?
    # Usually in this architecture, the URI points to the .npy and row index matches.
    # We can use a combination of video_id and original_frame_id as the embedding_id.
    
    # The actual embedding_uri should be a relative or R2 link. We'll store it as a file:// URI
    # pointing to the .npy file, and downstream processes can replace it.
    embedding_uri = f"file://{npy_path.absolute()}"
    
    embedding_dim = embeddings.shape[1] if len(embeddings.shape) > 1 else 0
    
    for kf in keyframes:
        # We need a segment_id. If missing in keyframe, fallback to video_id
        seg_id = kf.segment_id if kf.segment_id else kf.video_id
        
        res = EmbeddingResult(
            video_id=kf.video_id,
            segment_id=seg_id,
            embedding_uri=embedding_uri, # All point to the same npy file
            embedding_dim=embedding_dim,
            model_name=config.model_name,
            model_version=config.pipeline_version,
            
            dataset_id=kf.dataset_id,
            dataset_version=kf.dataset_version,
            original_frame_id=kf.original_frame_id,
            frame_id=kf.frame_id,
            dtype=config.output_dtype,
            normalized=config.normalized,
            pipeline_version=config.pipeline_version
        )
        results.append(res.to_dict())
        
    # Save metadata as parquet
    df = pd.DataFrame(results)
    df.to_parquet(parquet_path, index=False)
    
    return str(npy_path), str(parquet_path)
