import os
import torch
from dataclasses import dataclass

@dataclass
class VisualEmbeddingConfig:
    model_name: str = "hf-hub:UCSC-VLAA/ViT-H-14-CLIPA-336-laion2B"
    batch_size: int = 32
    device: str = "cuda" if torch.cuda.is_available() else "cpu"
    output_dtype: str = "float32"
    normalized: bool = True
    pipeline_version: str = "visual-embedding-clipa-v2-h14"

def config_from_environment() -> VisualEmbeddingConfig:
    """Load configuration from environment variables if present."""
    config = VisualEmbeddingConfig()
    config.model_name = os.environ.get("CLIP_MODEL_NAME", config.model_name).strip()
    
    batch_size_env = os.environ.get("CLIP_BATCH_SIZE")
    if batch_size_env:
        config.batch_size = int(batch_size_env)
        
    device_env = os.environ.get("CLIP_DEVICE")
    if device_env:
        config.device = device_env

    return config
