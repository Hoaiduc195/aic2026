import torch
import numpy as np
from PIL import Image
from typing import List, Union
import logging

try:
    import open_clip
except ImportError:
    open_clip = None

from transformers import CLIPProcessor, CLIPVisionModelWithProjection
from pipelines.feature_extraction.visual_embedding.config import VisualEmbeddingConfig

logger = logging.getLogger(__name__)

class ClipEncoder:
    """Encoder for extracting visual embeddings using CLIPA-v2 (ViT-H/14) or standard CLIP."""

    def __init__(self, config: VisualEmbeddingConfig):
        self.config = config
        self.device = config.device
        self.model_name = config.model_name
        self.use_open_clip = False

        logger.info(f"Loading CLIP model {self.model_name} on {self.device}...")

        is_open_clip_spec = (
            self.model_name.startswith("hf-hub:")
            or "CLIPA" in self.model_name
            or "open_clip" in self.model_name
            or "/" not in self.model_name
        )

        if is_open_clip_spec and open_clip is not None:
            self.model, _, self.preprocess = open_clip.create_model_and_transforms(
                self.model_name,
                device=self.device
            )
            self.use_open_clip = True
        else:
            try:
                self.processor = CLIPProcessor.from_pretrained(self.model_name)
                self.model = CLIPVisionModelWithProjection.from_pretrained(self.model_name).to(self.device)
            except Exception:
                if open_clip is not None:
                    self.model, _, self.preprocess = open_clip.create_model_and_transforms(
                        self.model_name,
                        device=self.device
                    )
                    self.use_open_clip = True
                else:
                    raise

        self.model.eval()

    @torch.no_grad()
    def encode_batch(self, images: List[Image.Image]) -> np.ndarray:
        """
        Encode a batch of PIL Images.
        Returns:
            np.ndarray: Batch of embeddings, shape (N, dim), correctly typed and normalized as per config.
        """
        if not images:
            return np.array([])

        if self.use_open_clip:
            tensors = torch.stack([self.preprocess(img) for img in images]).to(self.device)
            image_features = self.model.encode_image(tensors)
        else:
            inputs = self.processor(images=images, return_tensors="pt")
            inputs = {k: v.to(self.device) for k, v in inputs.items()}
            outputs = self.model(**inputs)
            image_features = outputs.image_embeds

        if self.config.normalized:
            image_features = image_features / image_features.norm(p=2, dim=-1, keepdim=True)

        embeddings = image_features.cpu().numpy()

        if self.config.output_dtype == "float16":
            embeddings = embeddings.astype(np.float16)
        elif self.config.output_dtype == "float32":
            embeddings = embeddings.astype(np.float32)

        return embeddings
