import argparse
import logging
import sys
import numpy as np
from pathlib import Path

from pipelines.feature_extraction.visual_embedding.config import config_from_environment
from pipelines.feature_extraction.visual_embedding.encoder import ClipEncoder
from pipelines.feature_extraction.visual_embedding.io import (
    load_keyframes_manifest,
    batch_keyframes,
    load_image,
    save_embeddings
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

def process_video(
    video_id: str, 
    parquet_path: Path, 
    output_dir: Path, 
    encoder: ClipEncoder, 
    overwrite: bool = False
):
    """Extract and save embeddings for a single video's keyframes."""
    npy_path = output_dir / f"{video_id}.npy"
    if npy_path.exists() and not overwrite:
        logger.info(f"Skipping {video_id}, {npy_path} already exists.")
        return
        
    logger.info(f"Processing video {video_id} from {parquet_path}")
    keyframes = load_keyframes_manifest(parquet_path)
    
    if not keyframes:
        logger.warning(f"No valid keyframes found in {parquet_path}")
        return
        
    all_embeddings = []
    
    for batch in batch_keyframes(keyframes, encoder.config.batch_size):
        images = []
        valid_batch = []
        for kf in batch:
            try:
                # Need to load the image from kf.storage_uri or kf.path
                # In Kaggle/R2, storage_uri usually points to the local downloaded path.
                img_path = kf.storage_uri if kf.storage_uri else kf.path
                img = load_image(img_path)
                images.append(img)
                valid_batch.append(kf)
            except Exception as e:
                logger.error(f"Failed to load image for frame {kf.original_frame_id} in {video_id}: {e}")
                
        if images:
            embs = encoder.encode_batch(images)
            all_embeddings.append(embs)
            
    if all_embeddings:
        final_embeddings = np.vstack(all_embeddings)
        out_npy, out_pq = save_embeddings(
            output_dir, video_id, final_embeddings, keyframes, encoder.config
        )
        logger.info(f"Saved {len(keyframes)} embeddings for {video_id} to {out_npy} and {out_pq}")
    else:
        logger.warning(f"No embeddings generated for {video_id}.")

def main():
    parser = argparse.ArgumentParser(description="CLIP Visual Embedding Extraction")
    parser.add_argument("--input-dir", type=str, required=True, help="Directory containing keyframe metadata parquet files")
    parser.add_argument("--output-dir", type=str, required=True, help="Directory to save .npy and .parquet embedding results")
    parser.add_argument("--overwrite", action="store_true", help="Overwrite existing output files")
    
    args = parser.parse_args()
    
    input_dir = Path(args.input_dir)
    output_dir = Path(args.output_dir)
    
    if not input_dir.exists():
        logger.error(f"Input directory does not exist: {input_dir}")
        sys.exit(1)
        
    config = config_from_environment()
    encoder = ClipEncoder(config)
    
    # Process all parquet files in the input directory
    parquet_files = list(input_dir.glob("*.parquet"))
    logger.info(f"Found {len(parquet_files)} videos (parquet files) to process.")
    
    for pq_file in parquet_files:
        # Assuming filename is <video_id>.parquet
        video_id = pq_file.stem
        process_video(video_id, pq_file, output_dir, encoder, args.overwrite)

if __name__ == "__main__":
    main()
