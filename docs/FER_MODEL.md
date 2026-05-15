# docs/FER_MODEL.md

Facial Emotion Recognition model: training, fine-tuning strategy, and inference.

This doc covers the *model* layer. For the image preprocessing that produces inputs to this model, see `docs/IMAGE_PIPELINE.md`.

---

## At a glance

| Aspect | Choice |
|---|---|
| Base architecture | EfficientNet-B3 (TensorFlow / Keras) |
| Pretrained weights | ImageNet |
| Training dataset | RAF-DB (Real-world Affective Faces Database) |
| Training classes | 7 (happy, surprised, sad, angry, neutral, fear, disgust) |
| Application-layer scope | 5 (happy, surprised, sad, angry, neutral) — fear & disgust trigger out-of-scope error |
| Input size | 300 × 300 × 3 |
| Input normalisation | `tf.keras.applications.efficientnet.preprocess_input` (scales to [-1, 1]) |
| Classification head | Global Average Pooling → Dropout → Dense (7, softmax) |
| Training strategy | Two-phase transfer learning (head only, then partial unfreeze) |
| Target validation accuracy | ≥ 80% on RAF-DB test split (achievable per Setiaputri et al. 2025 reporting 84.47%) |
| Persisted artefact | `models/emotion_model.keras` (single-file Keras v3 format) |

---

## Why EfficientNet-B3 (not VGG, ResNet, or B0)

Already justified in the CP1 planning doc §2.1.2.2 and §3.8. Summary:

- **Vs. VGG16:** EfficientNet-B3 has fewer parameters, faster inference, higher accuracy on FER benchmarks.
- **Vs. ResNet50:** EfficientNet-B3 outperforms ResNet50 on FER2013 in published comparisons (84.47% vs ~70%).
- **Vs. EfficientNet-B0:** B3 has higher accuracy; B0 is lighter and faster but the accuracy gap matters for a capstone that's judged on results. Inference at CPU still completes in < 1 s for B3 — acceptable.
- **Vs. larger (B4–B7):** Diminishing returns. Larger models need much more training data and longer training time; RAF-DB has ~30k images, which fits B3's capacity well.

If during CP2 the B3 model is genuinely too slow on the target machine, swap to B0 as a fallback. This must be documented in the report.

---

## Dataset preparation (RAF-DB)

### What RAF-DB ships with

- **Total images:** ~30,000 facial images.
- **Annotation:** 7 basic emotion labels (1–7 indexing in their original file format).
- **Split:** Train (~12,271 images) / Test (~3,068 images) per the official split.
- **Format:** Cropped and aligned faces, varying resolutions but standardised to ~100 × 100 by the dataset providers (the "aligned" subfolder).

### Label mapping (RAF-DB → our codebase)

The original RAF-DB labels are integers 1–7. Map them to string labels internally for clarity:

| RAF-DB index | Our label | In scope for music rec? |
|---|---|---|
| 1 | surprise | ✅ |
| 2 | fear | ❌ out-of-scope |
| 3 | disgust | ❌ out-of-scope |
| 4 | happy | ✅ |
| 5 | sad | ✅ |
| 6 | angry | ✅ |
| 7 | neutral | ✅ |

The model outputs a 7-element softmax in this order:
```python
EMOTION_LABELS = ["surprise", "fear", "disgust", "happy", "sad", "angry", "neutral"]
IN_SCOPE = {"surprise", "happy", "sad", "angry", "neutral"}
```

The order is fixed to RAF-DB's index order so the persisted model is portable.

### Preprocessing during training

1. Load image as RGB.
2. Resize to 300 × 300 (RAF-DB aligned faces are ~100 × 100; upscaling for B3's native input size is fine — the model was pretrained at this resolution).
3. Apply `tf.keras.applications.efficientnet.preprocess_input` — this scales pixel values into [-1, 1] per channel.
4. Data augmentation (training only):
   - Random horizontal flip
   - Random rotation ±10°
   - Random brightness ±10%
   - Random zoom ±10%
   - No vertical flip (faces are not symmetric vertically)
5. Validation/test set: no augmentation, just resize + normalise.

Implementation: use `tf.keras.utils.image_dataset_from_directory` to load, then chain a `tf.keras.Sequential` augmentation block as the first part of the model. This makes augmentation run on GPU and serialise correctly with the model.

### Class imbalance

RAF-DB is **heavily imbalanced** — *happy* dominates (~38% of training samples), *disgust* and *fear* are smallest (~3–4% each). Handle this:

**Option A (preferred):** Compute class weights with `sklearn.utils.class_weight.compute_class_weight('balanced', ...)` and pass to `model.fit(class_weight=...)`.

**Option B:** Oversample minority classes via `tf.data.Dataset.sample_from_datasets` with explicit weights.

**Do not** use simple oversampling that duplicates minority images without augmentation — that overfits the rare classes.

The class weighting approach is simpler and works well. Document the per-class weights in the report.

### Train / validation / test splits

- RAF-DB ships with an official train/test split. Honour it.
- Carve a validation set from the official **train** set: 80% train / 20% validation, stratified by class.
- Final test accuracy is reported on the **official test** set, untouched.

---

## Model architecture (Keras code outline)

```python
import tensorflow as tf
from tensorflow.keras import layers, Model

NUM_CLASSES = 7
INPUT_SHAPE = (300, 300, 3)

def build_model(dropout: float = 0.3) -> Model:
    # Input + augmentation block (executed only in training mode)
    inputs = layers.Input(shape=INPUT_SHAPE, name="image")
    x = layers.RandomFlip("horizontal")(inputs)
    x = layers.RandomRotation(0.04)(x)               # ±10° ≈ 10/360 = 0.028 of a full turn — but Keras uses fraction of 2π; 10° = 10/360 ≈ 0.028. Use 0.04 to be generous.
    x = layers.RandomZoom(0.1)(x)
    x = layers.RandomBrightness(0.1)(x)

    # EfficientNet-B3 backbone with ImageNet weights, no top
    backbone = tf.keras.applications.EfficientNetB3(
        include_top=False,
        weights="imagenet",
        input_tensor=x,
        pooling=None,
    )
    backbone.trainable = False  # frozen for phase 1

    # Custom classification head
    x = layers.GlobalAveragePooling2D(name="gap")(backbone.output)
    x = layers.Dropout(dropout, name="head_dropout")(x)
    outputs = layers.Dense(NUM_CLASSES, activation="softmax", name="emotion_softmax")(x)

    return Model(inputs=inputs, outputs=outputs, name="emotion_efficientnetb3")
```

Notes:
- `RandomBrightness` requires TF ≥ 2.11. Confirm the project's TF version supports it; if not, use `tf.image.random_brightness` inside a `Lambda` layer.
- Augmentation layers do nothing during inference (`training=False`), so we get free augmentation during `fit()` and clean inference.

---

## Two-phase fine-tuning strategy

This is the standard transfer-learning recipe for EfficientNet on a domain-shifted dataset (RAF-DB faces vs. ImageNet objects).

### Phase 1 — head only

- **Goal:** Let the new classification head learn emotion-discriminative features without disrupting pretrained ImageNet weights.
- **Frozen:** entire `backbone` (set `backbone.trainable = False`).
- **Trainable:** only the GAP + Dropout + Dense head.
- **Optimiser:** Adam, `learning_rate = 1e-3`.
- **Loss:** `categorical_crossentropy` (one-hot labels) or `sparse_categorical_crossentropy` (integer labels) — pick one consistently.
- **Metrics:** `accuracy`, `top_2_accuracy` (the latter is useful diagnostic info — many FER confusions are sad↔neutral).
- **Epochs:** 10–15, with `EarlyStopping(patience=3, restore_best_weights=True, monitor="val_accuracy")`.
- **Batch size:** 32. If GPU memory permits, try 64.
- **Class weights:** Yes (from `compute_class_weight`).
- **Expected val accuracy after phase 1:** 60–70%.

### Phase 2 — partial unfreeze

- **Goal:** Adapt mid- and high-level features to faces while keeping low-level (edge/texture) features intact.
- **Frozen:** the first ~70% of EfficientNet-B3's blocks (block1–block5 roughly). Unfreeze block6 and block7 + the head.
  - In code: iterate `backbone.layers`, set `trainable = True` only for layers after a certain index. EfficientNet-B3's MBConv blocks are named clearly (`block6a_...`, `block7a_...`). Unfreeze everything from `block6a_expand_conv` onward.
- **Crucial:** Set `BatchNormalization` layers to `trainable = False` even within unfrozen blocks. Updating BN stats on a small dataset destroys pretrained statistics. Loop:
  ```python
  for layer in backbone.layers:
      if isinstance(layer, layers.BatchNormalization):
          layer.trainable = False
  ```
- **Optimiser:** Adam, `learning_rate = 1e-5` (lower by 100× from phase 1 — critical to not destroy pretrained weights).
- **Epochs:** 15–25, same early-stopping.
- **Expected val accuracy after phase 2:** 78–85%.

### Why two phases (not one-shot end-to-end)

If you unfreeze everything from the start with a high learning rate, the random-initialised head produces large gradients that propagate back and corrupt the pretrained backbone. Two-phase training avoids this. This is standard practice — Tan & Le 2019 (the EfficientNet paper) and the Keras transfer-learning tutorial both recommend it.

---

## Training script outline

Single script: `scripts/train_emotion_model.py`. Should:

1. Parse args: `--data-dir`, `--output-dir`, `--epochs-phase1`, `--epochs-phase2`, `--batch-size`, `--seed`.
2. Load RAF-DB train/val/test as `tf.data.Dataset` objects.
3. Build model (Phase 1 config: backbone frozen).
4. Train Phase 1. Save checkpoint after best epoch.
5. Reload best Phase 1 weights, unfreeze block6+, train Phase 2.
6. Evaluate on test set; print per-class precision/recall + confusion matrix.
7. Save final model as `models/emotion_model.keras` (Keras v3 format — single file, includes optimiser state).
8. Save training history to `models/training_history.json` for plotting.

**Set random seeds:** `np.random.seed(seed)`, `tf.random.set_seed(seed)`, `random.seed(seed)`, and `os.environ["PYTHONHASHSEED"] = str(seed)`. Even with this, GPU non-determinism may cause small variance.

**Logging:** Use `tf.keras.callbacks.CSVLogger` to dump per-epoch metrics. Pair with `TensorBoard` callback for live curves during training.

---

## Inference

### Loading the model (at app startup, once)

```python
# src/fer/emotion_model.py
import tensorflow as tf
from pathlib import Path

MODEL_PATH = Path("models/emotion_model.keras")
EMOTION_LABELS = ["surprise", "fear", "disgust", "happy", "sad", "angry", "neutral"]
IN_SCOPE = {"surprise", "happy", "sad", "angry", "neutral"}

_model = None

def get_model() -> tf.keras.Model:
    global _model
    if _model is None:
        _model = tf.keras.models.load_model(MODEL_PATH, compile=False)
    return _model

def predict(image_array_300x300x3_normalised) -> tuple[str, float, dict]:
    """
    image_array: numpy array shape (300, 300, 3), already preprocessed
                 (i.e. passed through efficientnet.preprocess_input).
    Returns (predicted_label, confidence, all_class_probs_dict).
    """
    model = get_model()
    batch = image_array_300x300x3_normalised[None, ...]  # add batch dim
    probs = model.predict(batch, verbose=0)[0]            # shape (7,)
    idx = int(probs.argmax())
    label = EMOTION_LABELS[idx]
    confidence = float(probs[idx])
    all_probs = {EMOTION_LABELS[i]: float(probs[i]) for i in range(len(EMOTION_LABELS))}
    return label, confidence, all_probs
```

### Out-of-scope handling

This is **application-layer** logic, kept outside the model itself for cleanliness:

```python
def predict_in_scope(image_array) -> dict:
    label, confidence, all_probs = predict(image_array)
    if label not in IN_SCOPE:
        return {
            "status": "out_of_scope",
            "detected": label,
            "confidence": confidence,
            "all_probs": all_probs,
        }
    return {
        "status": "ok",
        "emotion": label,
        "confidence": confidence,
        "all_probs": all_probs,
    }
```

### Confidence threshold (optional, decide during testing)

Initially: **no threshold**. Always return the argmax.

If user testing reveals frequent low-confidence false positives, introduce a threshold (e.g. confidence < 0.4 → return error_low_confidence). Defer this decision until we have real test data. Default off.

### Inference performance

- **Per-image inference on CPU (single core):** ~300–500 ms for EfficientNet-B3 at 300×300.
- **First inference is slower** (~2–3 s) due to lazy graph compilation. **Warm up at startup**: run one dummy inference on a zero tensor after `get_model()` to amortise this cost.

---

## Evaluation

For the report, produce these artefacts after training:

1. **Confusion matrix** (7×7) on the RAF-DB test set. Use `sklearn.metrics.confusion_matrix` + `seaborn.heatmap`. Save as `models/confusion_matrix.png`.
2. **Per-class precision, recall, F1.** `sklearn.metrics.classification_report`. Save as `models/classification_report.txt`.
3. **Training curves.** Loss + accuracy per epoch for both phases. Save as `models/training_curves.png`.
4. **Per-class accuracy on the 5 in-scope classes only.** Reported separately from the full 7-class evaluation, because in-scope accuracy is what matters for end-user experience.
5. **Top-2 accuracy.** A useful framing — even when the top prediction is wrong, knowing that the correct label is in the top 2 says the model is "close."

**Expected results based on prior work:**
- Setiaputri et al. (2025, cited in CP1 §2.1.2.2): EfficientNet-B3 reached 84.47% on FER2013. RAF-DB is generally a cleaner dataset, so similar or better is realistic.
- Aim: ≥ 80% test accuracy across 7 classes. ≥ 85% on the 5 in-scope classes.

If after Phase 2 the model is below 75% test accuracy, **stop and investigate** before continuing the build:
- Check class imbalance handling — re-verify class weights.
- Check augmentation is enabled.
- Check `BatchNormalization` layers are actually frozen during Phase 2.
- Consider longer Phase 2 training (the LR is low, convergence is slow).

---

## Common pitfalls (read before training)

1. **Forgetting `preprocess_input`.** EfficientNet's pretrained weights expect inputs scaled with their specific `preprocess_input` function (centred and scaled to [-1, 1]). If you skip this or use `/255.0` normalisation, accuracy collapses to ~random. *Both training and inference must use the same preprocessing.*

2. **Unfreezing BatchNormalization in Phase 2.** Already covered above. Easy to miss; catastrophic when missed.

3. **Mixing label encodings.** Stay consistent on one of:
   - Integer labels (`y = [3, 1, 6, ...]`) → use `sparse_categorical_crossentropy`.
   - One-hot labels (`y = [[0,0,0,1,0,0,0], ...]`) → use `categorical_crossentropy`.
   - Recommendation: integer labels, simpler.

4. **Training on test data by accident.** RAF-DB ships train and test as separate folders; we further split train into train/val. Never let test images touch `fit()`. Use distinct `tf.data.Dataset` objects.

5. **Saving the model in the wrong format.** Save as `.keras` (Keras v3 single-file format), **not** legacy `.h5`. Keras 3 / TF 2.16+ deprecates HDF5 saving and `.keras` is the recommended format.

6. **Model file size.** Expect ~50 MB. Add `models/*.keras` to `.gitignore` if it exceeds GitHub's 100 MB hard limit; otherwise commit it so other machines can run inference without re-training.

7. **Determinism for tests.** Set seeds, but accept that GPU operations have residual non-determinism. The CPU inference path in production tests is deterministic.

---

## When and how to retrain

You will not retrain casually. Retraining triggers:

- Architecture change (e.g. swap to B0 because B3 is too slow on the target machine).
- Adding/removing emotion classes.
- Switching datasets (e.g. adding AffectNet — out of scope for capstone).
- Discovering a data quality bug in RAF-DB preparation.

Each retraining run should be:
- Versioned: `models/emotion_model_v{N}.keras`, with `models/emotion_model.keras` symlinked (or copied) to the current production version.
- Documented: a markdown note in `models/README.md` describing what changed and the new test metrics.
- Committed: training script changes, hyperparameter changes, and a results summary.

---

## Related docs

- `docs/IMAGE_PIPELINE.md` — produces the input tensors this model consumes.
- `docs/ARCHITECTURE.md` — where this fits in the system flow.
- `docs/TESTING.md` — how to test the model end-to-end with a fixture image.
- `docs/BUILD_PLAN.md` — when in CP2 to train the model (Phase 3, weeks 3–8).
