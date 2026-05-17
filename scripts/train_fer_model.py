"""Two-phase EfficientNet-B3 training on RAF-DB.

Training (Run on Google Colab):
    !python scripts/train_fer_model.py \
        --data-dir /content/drive/MyDrive/CP2_FER/raf-db/DATASET \
        --output-dir /content/drive/MyDrive/CP2_FER/models \
        --epochs-phase1 15 \
        --epochs-phase2 20 \
        --batch-size 32 \
        --seed 42
"""

import argparse
import json
import os
import random
import sys
from pathlib import Path

# Allow running from any working directory (Colab or local).
sys.path.insert(0, str(Path(__file__).parent.parent))

import matplotlib.pyplot as plt
import numpy as np
import seaborn as sns
from sklearn.metrics import classification_report, confusion_matrix
from sklearn.utils.class_weight import compute_class_weight


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Train EfficientNet-B3 emotion classifier on RAF-DB.")
    p.add_argument(
        "--data-dir",
        required=True,
        help="Path to the RAF-DB DATASET/ folder (must contain train/ and test/ subdirs).",
    )
    p.add_argument(
        "--output-dir",
        required=True,
        help="Directory where the model and artefacts will be saved.",
    )
    p.add_argument("--epochs-phase1", type=int, default=15, help="Max epochs for Phase 1 (default 15).")
    p.add_argument("--epochs-phase2", type=int, default=20, help="Max epochs for Phase 2 (default 20).")
    p.add_argument("--batch-size", type=int, default=32, help="Batch size for both phases (default 32).")
    p.add_argument("--seed", type=int, default=42, help="Random seed for reproducibility (default 42).")
    return p.parse_args()


# ---------------------------------------------------------------------------
# Reproducibility
# ---------------------------------------------------------------------------

def set_seeds(seed: int) -> None:
    os.environ["PYTHONHASHSEED"] = str(seed)
    random.seed(seed)
    np.random.seed(seed)
    import tensorflow as tf
    tf.random.set_seed(seed)


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def load_datasets(
    train_dir: Path,
    test_dir: Path,
    batch_size: int,
    seed: int,
):
    import tensorflow as tf

    common = dict(image_size=(300, 300), batch_size=batch_size, label_mode="int", seed=seed)

    train_ds = tf.keras.utils.image_dataset_from_directory(
        str(train_dir), validation_split=0.2, subset="training", **common
    )
    val_ds = tf.keras.utils.image_dataset_from_directory(
        str(train_dir), validation_split=0.2, subset="validation", **common
    )
    # shuffle=False so label collection during evaluation stays aligned with predictions.
    test_ds = tf.keras.utils.image_dataset_from_directory(
        str(test_dir), shuffle=False, **common
    )

    autotune = tf.data.AUTOTUNE
    return (
        train_ds.prefetch(autotune),
        val_ds.prefetch(autotune),
        test_ds.prefetch(autotune),
    )


# ---------------------------------------------------------------------------
# Class weights
# ---------------------------------------------------------------------------

def compute_class_weights_from_dir(train_dir: Path, num_classes: int) -> dict[int, float]:
    """Compute balanced class weights by counting files in each class subfolder."""
    class_dirs = sorted([d for d in train_dir.iterdir() if d.is_dir()], key=lambda d: d.name)
    labels = []
    for idx, d in enumerate(class_dirs):
        count = sum(1 for f in d.iterdir() if f.is_file())
        labels.extend([idx] * count)
    weights = compute_class_weight("balanced", classes=np.arange(num_classes), y=labels)
    return dict(enumerate(weights))


# ---------------------------------------------------------------------------
# Callbacks
# ---------------------------------------------------------------------------

def make_callbacks(output_dir: Path, phase: int) -> list:
    import tensorflow as tf

    return [
        tf.keras.callbacks.EarlyStopping(
            monitor="val_accuracy",
            patience=3,
            restore_best_weights=True,
            verbose=1,
        ),
        tf.keras.callbacks.CSVLogger(str(output_dir / f"phase{phase}_log.csv")),
    ]


# ---------------------------------------------------------------------------
# Artefacts
# ---------------------------------------------------------------------------

def save_training_curves(history1, history2, output_dir: Path) -> None:
    n1 = len(history1.history["accuracy"])
    n2 = len(history2.history["accuracy"])
    ep1 = range(1, n1 + 1)
    ep2 = range(n1 + 1, n1 + n2 + 1)

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(14, 5))

    for ax, metric in zip((ax1, ax2), ("accuracy", "loss")):
        ax.plot(ep1, history1.history[metric], "b-", label="train (phase 1)")
        ax.plot(ep1, history1.history[f"val_{metric}"], "b--", label="val (phase 1)")
        ax.plot(ep2, history2.history[metric], "r-", label="train (phase 2)")
        ax.plot(ep2, history2.history[f"val_{metric}"], "r--", label="val (phase 2)")
        ax.axvline(n1 + 0.5, color="gray", linestyle=":", label="phase boundary")
        ax.set_xlabel("Epoch")
        ax.set_ylabel(metric.capitalize())
        ax.set_title(metric.capitalize())
        ax.legend()

    fig.tight_layout()
    out = output_dir / "training_curves.png"
    fig.savefig(out, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"Saved training curves  → {out}")


def save_evaluation(model, test_ds, output_dir: Path, emotion_labels: list[str]) -> None:
    print("\nRunning evaluation on test set...")
    all_labels = np.concatenate([y.numpy() for _, y in test_ds])
    all_probs = model.predict(test_ds, verbose=1)
    all_preds = np.argmax(all_probs, axis=1)

    # Confusion matrix
    cm = confusion_matrix(all_labels, all_preds)
    fig, ax = plt.subplots(figsize=(10, 8))
    sns.heatmap(
        cm,
        annot=True,
        fmt="d",
        xticklabels=emotion_labels,
        yticklabels=emotion_labels,
        cmap="Blues",
        ax=ax,
    )
    ax.set_xlabel("Predicted")
    ax.set_ylabel("True")
    ax.set_title("Confusion Matrix — RAF-DB test set")
    fig.tight_layout()
    out = output_dir / "confusion_matrix.png"
    fig.savefig(out, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"Saved confusion matrix  → {out}")

    # Classification report
    report = classification_report(all_labels, all_preds, target_names=emotion_labels, digits=4)
    print("\n" + report)
    report_path = output_dir / "classification_report.txt"
    report_path.write_text(report)
    print(f"Saved classification report → {report_path}")

    # Per-class accuracy on in-scope classes only
    in_scope_indices = [
        i for i, lbl in enumerate(emotion_labels)
        if lbl in {"surprise", "happy", "sad", "angry", "neutral"}
    ]
    mask = np.isin(all_labels, in_scope_indices)
    in_scope_acc = np.mean(all_preds[mask] == all_labels[mask])
    print(f"\nTest accuracy — 7-class:     {np.mean(all_preds == all_labels):.4f}")
    print(f"Test accuracy — 5 in-scope:  {in_scope_acc:.4f}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    args = parse_args()
    set_seeds(args.seed)

    import tensorflow as tf
    from src.fer.model import EMOTION_LABELS, NUM_CLASSES, build_model, unfreeze_top_blocks

    data_dir = Path(args.data_dir)
    train_dir = data_dir / "train"
    test_dir = data_dir / "test"
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"TensorFlow version : {tf.__version__}")
    print(f"GPU devices        : {tf.config.list_physical_devices('GPU')}")
    print(f"Train dir          : {train_dir}")
    print(f"Test dir           : {test_dir}")
    print(f"Output dir         : {output_dir}")

    # ---- Data ---------------------------------------------------------------
    train_ds, val_ds, test_ds = load_datasets(train_dir, test_dir, args.batch_size, args.seed)
    class_weights = compute_class_weights_from_dir(train_dir, NUM_CLASSES)

    print("\nClass weights (balanced):")
    for idx, w in class_weights.items():
        print(f"  {idx}  {EMOTION_LABELS[idx]:<10}  {w:.4f}")

    # ---- Build model (Phase 1: backbone frozen) ------------------------------
    model, backbone = build_model()
    model.summary(show_trainable=True)

    # ---- Phase 1 ------------------------------------------------------------
    print("\n=== Phase 1: training head only (backbone frozen) ===")
    model.compile(
        optimizer=tf.keras.optimizers.Adam(learning_rate=1e-3),
        loss="sparse_categorical_crossentropy",
        metrics=[
            "accuracy",
            tf.keras.metrics.SparseTopKCategoricalAccuracy(k=2, name="top2_accuracy"),
        ],
    )
    history1 = model.fit(
        train_ds,
        validation_data=val_ds,
        epochs=args.epochs_phase1,
        class_weight=class_weights,
        callbacks=make_callbacks(output_dir, phase=1),
        verbose=1,
    )
    print(f"Phase 1 best val_accuracy: {max(history1.history['val_accuracy']):.4f}")

    # ---- Phase 2 ------------------------------------------------------------
    print("\n=== Phase 2: fine-tuning block6+ (BatchNorm frozen) ===")
    unfreeze_top_blocks(backbone)

    # Recompile so the optimiser registers the newly trainable variables.
    model.compile(
        optimizer=tf.keras.optimizers.Adam(learning_rate=1e-5),
        loss="sparse_categorical_crossentropy",
        metrics=[
            "accuracy",
            tf.keras.metrics.SparseTopKCategoricalAccuracy(k=2, name="top2_accuracy"),
        ],
    )
    history2 = model.fit(
        train_ds,
        validation_data=val_ds,
        epochs=args.epochs_phase2,
        class_weight=class_weights,
        callbacks=make_callbacks(output_dir, phase=2),
        verbose=1,
    )
    print(f"Phase 2 best val_accuracy: {max(history2.history['val_accuracy']):.4f}")

    # ---- Save model ---------------------------------------------------------
    model_path = output_dir / "fer_model.keras"
    model.save(str(model_path))
    print(f"\nSaved model → {model_path}")

    # ---- Save training history ----------------------------------------------
    history_combined = {
        "phase1": {k: [float(v) for v in vals] for k, vals in history1.history.items()},
        "phase2": {k: [float(v) for v in vals] for k, vals in history2.history.items()},
    }
    history_path = output_dir / "training_history.json"
    history_path.write_text(json.dumps(history_combined, indent=2))
    print(f"Saved training history → {history_path}")

    # ---- Evaluation artefacts -----------------------------------------------
    save_training_curves(history1, history2, output_dir)
    save_evaluation(model, test_ds, output_dir, EMOTION_LABELS)

    print("\nTraining complete.")


if __name__ == "__main__":
    main()
