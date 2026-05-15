# docs/IMAGE_PIPELINE.md

The image processing pipeline: from webcam frame to a model-ready tensor.

This doc covers everything between the user clicking the shutter button and the FER model receiving its input. The model itself is documented in `docs/FER_MODEL.md`.

---

## Pipeline stages

```
Webcam frame (JS)
    │
    ▼
Base64-encoded PNG → JS bridge → Python
    │
    ▼
[1] Decode → BGR numpy array (OpenCV native colour order)
    │
    ▼
[2] Face detection (Haar Cascade)
    │   ├─ 0 faces  → error: no_face
    │   ├─ >1 faces → error: multiple_faces
    │   └─ 1 face   → continue
    │
    ▼
[3] Extract face ROI with margin
    │
    ▼
[4] Convert BGR → RGB
    │
    ▼
[5] Resize to 300 × 300
    │
    ▼
[6] Quality check
    │   ├─ Blur (Laplacian variance < threshold) → error: low_quality_blur
    │   ├─ Dark  (mean brightness < threshold)   → error: low_quality_dark
    │   └─ Pass → continue
    │
    ▼
[7] Apply EfficientNet preprocess_input (→ float32 in [-1, 1])
    │
    ▼
Tensor (300, 300, 3), ready for FER model
```

All stages happen synchronously inside one `api.detect_emotion(image_b64)` bridge call. Total pipeline time should be < 1 second on a modern CPU.

---

## Stage 1 — Capture and decode

### JavaScript side

```javascript
// frontend/js/camera.js
async function captureFrame() {
  const video = document.querySelector("#webcam-preview");
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0);
  // PNG base64 — lossless, since we're going to downscale anyway
  return canvas.toDataURL("image/png");
}

async function onShutterClick() {
  const dataUrl = await captureFrame();
  // Strip the "data:image/png;base64," prefix; Python expects raw base64
  const b64 = dataUrl.split(",")[1];
  const result = await pywebview.api.detect_emotion(b64);
  handleResult(result);
}
```

### Python side

```python
# src/fer/image_pipeline.py
import base64
import numpy as np
import cv2

def decode_image(b64_string: str) -> np.ndarray:
    """Decode base64 PNG into BGR numpy array (OpenCV's native order)."""
    raw = base64.b64decode(b64_string)
    arr = np.frombuffer(raw, dtype=np.uint8)
    img_bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img_bgr is None:
        raise ValueError("Image decode failed")
    return img_bgr
```

**Why PNG (lossless) instead of JPEG?** JPEG compression artefacts could distort facial features at the pixel level. PNG is larger over the JS bridge (~3 MB for 1080p) but the bridge is in-process — there's no network. Speed cost is negligible.

**Why BGR?** OpenCV's `imdecode` returns BGR by default. We convert to RGB at stage 4 before feeding the model (TensorFlow expects RGB).

---

## Stage 2 — Face detection

### Implementation: Haar Cascade (default)

```python
import cv2

# Load once at module import; the XML file ships with opencv-python.
_face_cascade = cv2.CascadeClassifier(
    cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
)

def detect_faces(img_bgr: np.ndarray) -> list[tuple[int, int, int, int]]:
    """Return list of (x, y, w, h) bounding boxes."""
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    gray = cv2.equalizeHist(gray)  # improves detection under varying lighting
    faces = _face_cascade.detectMultiScale(
        gray,
        scaleFactor=1.1,
        minNeighbors=5,
        minSize=(80, 80),  # reject tiny detections (likely false positives)
    )
    return [tuple(map(int, box)) for box in faces]
```

### Parameters explained

- `scaleFactor=1.1` — how much the image is reduced at each scale (closer to 1 = more sensitive, slower). 1.1 is a good default.
- `minNeighbors=5` — how many neighbour rectangles each candidate must have to be retained. Higher = fewer false positives. 5 is conservative; 3 if too strict in practice.
- `minSize=(80, 80)` — minimum face size in pixels. At typical webcam resolution (640×480 or 1280×720) this rejects tiny background false positives.

### Multi-face handling

```python
faces = detect_faces(img_bgr)
if len(faces) == 0:
    return {"status": "error", "error": "no_face"}
if len(faces) > 1:
    return {"status": "error", "error": "multiple_faces"}
x, y, w, h = faces[0]
```

The application is single-user. If two faces are detected, we don't know which one to use, so we error out. This matches the activity diagram in the planning doc.

### Known limitations of Haar Cascade

- Frontal-face only — significantly degrades for profile / 3/4 angles. The UI mitigates by instructing the user to face the camera directly.
- Fails for heavy occlusion (mask, sunglasses). Mitigated by UI instructions to remove obstructions.
- Slower than DNN-based alternatives but adequate for ≤ 1-second pipeline budget.

### Fallback: switch to MediaPipe if Haar is insufficient

If user testing during CP2 reveals frequent detection failures despite users following UI guidance, swap to `mediapipe.solutions.face_detection`:

```python
import mediapipe as mp
mp_face = mp.solutions.face_detection.FaceDetection(
    model_selection=1,           # 0 = short-range (≤ 2 m), 1 = full-range (≤ 5 m)
    min_detection_confidence=0.5,
)
```

MediaPipe is more accurate (especially under poor lighting) and still CPU-friendly. The cost is an extra ~30 MB dependency. **Do not swap pre-emptively** — only if Haar empirically fails. Document the change in `docs/ARCHITECTURE.md` and the report.

---

## Stage 3 — Extract face ROI with margin

```python
def extract_face_roi(img_bgr: np.ndarray, box: tuple[int, int, int, int],
                    margin: float = 0.15) -> np.ndarray:
    """
    Crop the face with `margin` of extra context on each side
    (e.g. 0.15 = 15% extra per side).
    """
    h_img, w_img = img_bgr.shape[:2]
    x, y, w, h = box
    pad_w = int(w * margin)
    pad_h = int(h * margin)
    x0 = max(0, x - pad_w)
    y0 = max(0, y - pad_h)
    x1 = min(w_img, x + w + pad_w)
    y1 = min(h_img, y + h + pad_h)
    return img_bgr[y0:y1, x0:x1]
```

**Why margin?** Haar Cascade boxes are tight around the face. EfficientNet was pretrained on natural images that include some context around objects. A small margin (10–20%) preserves the hairline, jawline, and chin, which carry expression information (e.g. tightened jaw = anger).

---

## Stage 4 — Colour conversion

```python
def bgr_to_rgb(img_bgr: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
```

EfficientNet was trained on RGB images. Forgetting this conversion is a subtle bug — accuracy drops noticeably but the model still produces plausible-looking outputs, so it's easy to miss.

---

## Stage 5 — Resize to 300 × 300

```python
def resize_for_model(img_rgb: np.ndarray) -> np.ndarray:
    return cv2.resize(img_rgb, (300, 300), interpolation=cv2.INTER_AREA)
```

- **`INTER_AREA`** is the preferred interpolation when downsampling. For occasional upsampling cases (face crop smaller than 300×300), `INTER_AREA` still works acceptably; switching to `INTER_CUBIC` for upsampling is marginally better but adds complexity.
- Output is `uint8` numpy array, shape `(300, 300, 3)`.

---

## Stage 6 — Quality check

Performed **after** resize so thresholds are calibrated for the 300×300 image we actually feed to the model.

### Blur detection — Laplacian variance

```python
BLUR_THRESHOLD = 100.0  # tune empirically during CP2

def is_blurry(img_rgb_300: np.ndarray) -> tuple[bool, float]:
    gray = cv2.cvtColor(img_rgb_300, cv2.COLOR_RGB2GRAY)
    variance = cv2.Laplacian(gray, cv2.CV_64F).var()
    return variance < BLUR_THRESHOLD, variance
```

**Intuition:** the Laplacian operator highlights edges. Sharp images have high edge variance; blurry images have low variance. The threshold `100.0` is a starting point — common values in OpenCV tutorials range from 50 (very lenient) to 200 (strict). During CP2 testing, capture a few intentionally blurry and intentionally sharp photos to calibrate.

### Brightness check — mean intensity

```python
MIN_BRIGHTNESS = 40.0   # 0-255 scale
MAX_BRIGHTNESS = 230.0

def is_underexposed(img_rgb_300: np.ndarray) -> tuple[bool, float]:
    gray = cv2.cvtColor(img_rgb_300, cv2.COLOR_RGB2GRAY)
    mean = float(gray.mean())
    return mean < MIN_BRIGHTNESS, mean

def is_overexposed(img_rgb_300: np.ndarray) -> tuple[bool, float]:
    gray = cv2.cvtColor(img_rgb_300, cv2.COLOR_RGB2GRAY)
    mean = float(gray.mean())
    return mean > MAX_BRIGHTNESS, mean
```

**Calibration during testing:**
- A normal indoor selfie has mean brightness ~100–180.
- Below ~40: the face is too dark for reliable feature detection.
- Above ~230: heavily overexposed; facial features wash out.

### Combined check

```python
def check_quality(img_rgb_300: np.ndarray) -> dict | None:
    """Returns error dict if quality fails, else None."""
    blurry, blur_score = is_blurry(img_rgb_300)
    if blurry:
        return {"error": "low_quality_blur", "score": blur_score}

    underexposed, brightness = is_underexposed(img_rgb_300)
    if underexposed:
        return {"error": "low_quality_dark", "score": brightness}

    overexposed, brightness = is_overexposed(img_rgb_300)
    if overexposed:
        return {"error": "low_quality_bright", "score": brightness}

    return None
```

### Why this order?

Blur is the most common failure (handheld webcam shake). Check it first to fail fast.

---

## Stage 7 — Normalisation for EfficientNet

```python
from tensorflow.keras.applications.efficientnet import preprocess_input

def normalise_for_model(img_rgb_300: np.ndarray) -> np.ndarray:
    """Convert uint8 [0, 255] RGB to float32 [-1, 1] per EfficientNet's expected input."""
    img_float = img_rgb_300.astype("float32")
    return preprocess_input(img_float)
```

**Critical:** This must match the preprocessing used during training. EfficientNet's `preprocess_input` scales to roughly [-1, 1] using channel-specific means and standard deviations baked into the function. **Never substitute `/255.0` or another normalisation.**

---

## End-to-end pipeline function

```python
# src/fer/image_pipeline.py

def process(b64_image: str) -> dict:
    """
    Run the full pipeline on a base64-encoded image.
    Returns either {"status": "ok", "tensor": np.ndarray} or
    {"status": "error", "error": "<error_code>", ...details}.
    """
    try:
        img_bgr = decode_image(b64_image)
    except ValueError:
        return {"status": "error", "error": "decode_failed"}

    faces = detect_faces(img_bgr)
    if len(faces) == 0:
        return {"status": "error", "error": "no_face"}
    if len(faces) > 1:
        return {"status": "error", "error": "multiple_faces", "count": len(faces)}

    roi_bgr = extract_face_roi(img_bgr, faces[0])
    roi_rgb = bgr_to_rgb(roi_bgr)
    roi_300 = resize_for_model(roi_rgb)

    quality_error = check_quality(roi_300)
    if quality_error is not None:
        return {"status": "error", **quality_error}

    tensor = normalise_for_model(roi_300)
    return {"status": "ok", "tensor": tensor}
```

This function is **pure given a fixed image** — no I/O, no randomness, no global state changes. That makes it trivially testable.

---

## Error codes and UI mapping

The frontend handles errors by routing to the error page with a contextual message. Error codes returned by this pipeline:

| Error code | User-facing message | Suggested user action |
|---|---|---|
| `decode_failed` | "Could not read the image." | Retake photo |
| `no_face` | "No face detected." | Centre your face in the frame |
| `multiple_faces` | "More than one face detected." | Only one person at a time |
| `low_quality_blur` | "Image is too blurry." | Hold the camera steady |
| `low_quality_dark` | "Image is too dark." | Move to a brighter room |
| `low_quality_bright` | "Image is too bright." | Reduce glare or move away from the light |

Additional codes returned by downstream layers (FER model, recommender) are documented in their respective docs.

---

## UI guidance (recommended on the photo-taking page)

To minimise pipeline failures, the photo page should show — *before* the shutter is enabled:

- Live webcam preview with a centred oval outline guide.
- Text instructions:
  - "Face the camera directly."
  - "Remove glasses, masks, and hair covering your face."
  - "Make sure the lighting is even on your face."
- A subtle visual indicator when face detection (running on the preview at 2 Hz) finds exactly one face — turn the outline green. This is feedback to the user *before* they take the shot, dramatically reducing failure rate.

The on-preview detection can run a simpler/faster Haar pass on a downsampled frame to keep frame rate up. It's purely a UI aid; the authoritative detection still runs in the pipeline on the final shutter frame.

See `docs/FRONTEND.md` for layout details.

---

## Testing

### Unit tests (`tests/fer/test_image_pipeline.py`)

Cover each stage independently:
- `test_decode_invalid_base64()` → expects `decode_failed`-class error.
- `test_decode_valid_png()` → expects valid BGR array.
- `test_detect_zero_faces()` → fixture: a landscape photo with no people.
- `test_detect_one_face()` → fixture: known good selfie.
- `test_detect_multiple_faces()` → fixture: group photo.
- `test_quality_blurry_rejected()` → fixture: intentionally blurred face.
- `test_quality_dark_rejected()` → fixture: underexposed face.
- `test_normalise_preserves_shape()` → output is shape `(300, 300, 3)` float32.

Test fixtures live in `tests/fixtures/images/`. Create real images, not synthetic ones — Haar Cascade behaves differently on synthesised faces.

### Integration test

`test_full_pipeline_happy_path()`:
- Input: a known-good base64 photo of a happy face from RAF-DB.
- Run `process()` end-to-end.
- Assert `status == "ok"` and tensor shape is correct.

---

## Performance notes

- **Total pipeline budget:** < 1 second on a typical laptop CPU.
- **Dominant cost:** Haar Cascade detection (~100–300 ms depending on input resolution).
- **Optimisation:** Downsample the input before running detection if input is >1280px wide. Detection accuracy is preserved down to about 640px.

```python
def maybe_downsample(img_bgr: np.ndarray, max_dim: int = 1280) -> np.ndarray:
    h, w = img_bgr.shape[:2]
    if max(h, w) <= max_dim:
        return img_bgr
    scale = max_dim / max(h, w)
    return cv2.resize(img_bgr, (int(w * scale), int(h * scale)),
                      interpolation=cv2.INTER_AREA)
```

Apply this between Stage 1 and Stage 2 if the bridge sends a high-res frame.

---

## Related docs

- `docs/FER_MODEL.md` — model that consumes this pipeline's output.
- `docs/FRONTEND.md` — webcam UI and the bridge call.
- `docs/ARCHITECTURE.md` — where this pipeline sits in the full flow.
