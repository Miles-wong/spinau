#!/usr/bin/env python3
"""One-command setup and training orchestrator."""

import sys
import subprocess
from pathlib import Path

def run_command(cmd: str, description: str) -> bool:
    """Run shell command and return success status."""
    print(f"\n{'='*60}")
    print(f"📍 {description}")
    print(f"{'='*60}\n")
    
    result = subprocess.run(cmd, shell=True)
    
    if result.returncode != 0:
        print(f"\n❌ {description} failed!")
        return False
    
    print(f"\n✅ {description} completed!")
    return True

def main():
    training_dir = Path(__file__).parent
    
    print("""
    ╔════════════════════════════════════════════════════════════╗
    ║   LoRA Fine-tuning Setup & Training Orchestrator          ║
    ║   Gemma Model for Ticket Field Extraction                 ║
    ╚════════════════════════════════════════════════════════════╝
    """)
    
    # Step 1: Generate training data
    if not run_command(
        f"cd {training_dir} && python generate_training_data.py",
        "Step 1/3: Generating 200 training tickets"
    ):
        return 1
    
    # Step 2: Train LoRA model
    if not run_command(
        f"cd {training_dir} && python train_lora.py",
        "Step 2/3: Training LoRA adapter"
    ):
        return 1
    
    # Step 3: Test inference
    if not run_command(
        f"cd {training_dir} && python inference.py",
        "Step 3/3: Testing inference"
    ):
        return 1
    
    print("""
    ╔════════════════════════════════════════════════════════════╗
    ║   🎉 Training Complete!                                   ║
    ╠════════════════════════════════════════════════════════════╣
    ║                                                            ║
    ║   ✅ Generated:  200 training tickets                     ║
    ║   ✅ Trained:    LoRA adapter (gemma-2b)                  ║
    ║   ✅ Tested:     Inference pipeline                       ║
    ║                                                            ║
    ║   📁 Models saved to: training/models/gemma-lora/         ║
    ║   📁 Data saved to:   training/data/training_data.jsonl   ║
    ║                                                            ║
    ║   📖 Next steps:                                          ║
    ║   1. Review README.md for integration options             ║
    ║   2. Test with: python inference.py                       ║
    ║   3. Integrate to extraction.py                           ║
    ║   4. Monitor performance in production                    ║
    ║                                                            ║
    ╚════════════════════════════════════════════════════════════╝
    """)
    
    return 0

if __name__ == "__main__":
    sys.exit(main())
