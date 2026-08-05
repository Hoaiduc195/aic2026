"""Visual embedding (spec §5.1) — SigLIP/CLIP via open_clip.
One encode serves two purposes: tier-2 dedup AND the retrieval index."""

import numpy as np


class ClipEmbedder:
    def __init__(self, cfg):
        import open_clip
        import torch
        self._torch = torch
        self.device = cfg.device if torch.cuda.is_available() else "cpu"
        model, _, preprocess = open_clip.create_model_and_transforms(
            cfg.embed_model, pretrained=cfg.embed_pretrained)
        self.model = model.eval().to(self.device)
        self.preprocess = preprocess
        self.tokenizer = open_clip.get_tokenizer(cfg.embed_model)
        self.batch_size = cfg.embed_batch_size
        print(f"[embed] {cfg.embed_model}/{cfg.embed_pretrained} on {self.device}")

    def encode_images(self, rgbs: list[np.ndarray]) -> np.ndarray:
        """RGB uint8 arrays -> L2-normalized float32 embeddings (N, D)."""
        from PIL import Image
        torch = self._torch
        feats = []
        with torch.no_grad():
            for i in range(0, len(rgbs), self.batch_size):
                batch = torch.stack([
                    self.preprocess(Image.fromarray(a)) for a in rgbs[i:i + self.batch_size]
                ]).to(self.device)
                if self.device == "cuda":
                    with torch.autocast(device_type="cuda", dtype=torch.float16):
                        f = self.model.encode_image(batch)
                else:
                    f = self.model.encode_image(batch)
                f = f / f.norm(dim=-1, keepdim=True)
                feats.append(f.float().cpu().numpy())
        if not feats:
            return np.zeros((0, 1), dtype=np.float32)
        return np.concatenate(feats)

    def encode_text(self, texts: list[str]) -> np.ndarray:
        torch = self._torch
        tokens = self.tokenizer(texts).to(self.device)
        with torch.no_grad():
            f = self.model.encode_text(tokens)
            f = f / f.norm(dim=-1, keepdim=True)
        return f.float().cpu().numpy()
