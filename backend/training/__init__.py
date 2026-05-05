"""LoRA Fine-tuning module for ticket field extraction."""

from pathlib import Path

__version__ = "1.0.0"
__author__ = "AI Assistant"

# Package directories
TRAINING_DIR = Path(__file__).parent
DATA_DIR = TRAINING_DIR / "data"
MODELS_DIR = TRAINING_DIR / "models"

# Ensure directories exist
DATA_DIR.mkdir(exist_ok=True)
MODELS_DIR.mkdir(exist_ok=True)

__all__ = [
    "TRAINING_DIR",
    "DATA_DIR", 
    "MODELS_DIR",
]
