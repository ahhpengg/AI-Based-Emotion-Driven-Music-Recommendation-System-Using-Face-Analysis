# docs/IMAGE_PIPELINE.md

The image processing pipeline: from webcam frame to a model-ready tensor.

This doc covers everything between the user clicking the shutter button and the FER model receiving its input. The model itself is documented in `docs/FER_MODEL.md`.

> **Design note:** the runtime pipeline reuses the **grayscale eye-alignment + square-crop algorithm** of `scripts/align_facial_images` (the offline script that preprocessed the AffectNet disgust training images), which in turn reproduces the look of RAF-DB "aligned" crops. (Only the landmark *source* differs — see the Stage 2 API note — the crop math is identical.) This guarantees the images the model sees in production match its training distribution: **grayscale, eye-aligned, square face crops at 300 × 300**. Keep the two in sync — if `align_facial_images` changes, the model must be retrained *and* this pipeline updated.

---

## Pipeline stages

```
Webcam frame (JS)
    │  base64-encoded PNG → JS bridge → Python
    ▼
[1] Decode → RGB uint8 numpy array
    │
    ▼
[2] Face detection / count gate (MediaPipe Tasks FaceLandmarker, num_faces=2)
    │   ├─ 0 faces  → error: no_face
    │   ├─ ≥2 faces → error: multiple_faces
    │   └─ 1 face   → continue (keep that face's landmarks)
    │
    ▼
[3] Align + crop (align_facial_images algorithm)
    │   ├─ grayscale
    │   ├─ rotate so the eye line is horizontal (around the eye midpoint)
    │   ├─ square crop around the face-oval landmarks (+1% margin, white-255 pad)
    │   └─ resize to 300 × 300 (LANCZOS)
    │
    ▼
[4] Quality check (on the 300 × 300 gray crop)
    │   ├─ Blur   (Laplacian variance < threshold) → error: low_quality_blur
    │   ├─ Dark   (mean brightness   < threshold)  → error: low_quality_dark
    │   ├─ Bright (mean brightness   > threshold)  → error: low_quality_bright
    │   └─ Pass → continue
    │
    ▼
[5] To model tensor → (300, 300, 1) float32 in [0, 255]   (NO preprocess_input)
    │
    ▼
Tensor ready for the FER model
```

All stages run synchronously inside one `api.detect_emotion(image_b64)` bridge call. Target: < 1 second on a modern CPU (MediaPipe FaceLandmarker dominates the cost).

**Why the count gate uses `num_faces=2`:** one detector does both jobs. `0` landmark sets → `no_face`; `≥2` → `multiple_faces`; exactly `1` → we already have the landmarks needed for alignment, so no second detection pass. (The offline `align_facial_images` script used a *fallback* for missing faces because it must never drop a training sample — the runtime does the opposite and turns a missing/extra face into a hard error.)

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
  return canvas.toDataURL("image/png");   // PNG = lossless
}

async function onShutterClick() {
  const dataUrl = await captureFrame();
  const b64 = dataUrl.split(",")[1];       // strip "data:image/png;base64,"
  const result = await pywebview.api.detect_emotion(b64);
  handleResult(result);
}
```

### Python side

Decode with PIL to an **RGB** array — this matches `align_facial_images`, which reads with PIL and derives grayscale from the same RGB image, so the grayscale conversion is byte-identical to training.

```python
# src/fer/image_pipeline.py
import base64, io
import numpy as np
from PIL import Image

def decode_image(b64_string: str) -> np.ndarray:
    """Decode a base64 PNG/JPEG into an RGB uint8 array. Raises ValueError on failure."""
    try:
        raw = base64.b64decode(b64_string)
        img = Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception as exc:
        raise ValueError("image decode failed") from exc
    return np.asarray(img)
```

**Why PNG (lossless)?** JPEG compression artefacts could distort facial features. The bridge is in-process (no network), so the larger PNG payload is free.

---

## Stage 2 — Face detection / count gate

MediaPipe **Tasks `FaceLandmarker`**, created **once** and reused (construction is expensive). It needs the `models/face_landmarker.task` bundle (see *Model asset* below). `num_faces=2` is enough to tell "one face" from "more than one".

> **API note:** The legacy `mp.solutions.face_mesh.FaceMesh` API was **removed in mediapipe 0.10.35** (the version required for protobuf-5 / TF 2.21 compatibility). We use the Tasks API instead. It returns the **same 468-point face-mesh topology**, so the eye-corner and face-oval landmark indices — and the whole alignment step — are unchanged. `scripts/align_facial_images` (which produced the training crops on the older `solutions` API) is now out of date; if re-run, it must be migrated to `FaceLandmarker` too.

```python
import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision

# lazy singleton — see src/fer/image_pipeline.py
_landmarker = vision.FaceLandmarker.create_from_options(
    vision.FaceLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path="models/face_landmarker.task"),
        running_mode=vision.RunningMode.IMAGE,
        num_faces=2,                      # 2 distinguishes "one" from "more than one"
        min_face_detection_confidence=0.5,
    )
)

def detect_faces(rgb: np.ndarray) -> list[np.ndarray]:
    """Return a list of (N, 2) pixel-coordinate landmark arrays, one per detected face."""
    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb))
    result = _landmarker.detect(mp_image)
    if not result.face_landmarks:
        return []
    h, w = rgb.shape[:2]
    return [
        np.array([[lm.x * w, lm.y * h] for lm in face], dtype=np.float32)
        for face in result.face_landmarks
    ]
```

Count gate:

```python
faces = detect_faces(rgb)
if len(faces) == 0:
    return {"status": "error", "error": "no_face"}
if len(faces) > 1:
    return {"status": "error", "error": "multiple_faces", "count": len(faces)}
landmarks = faces[0]
```

### Model asset

`FaceLandmarker` requires a `.task` bundle. Download it once into `models/`:

```bash
curl -L -o models/face_landmarker.task \
  https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task
```

`src/fer/image_pipeline.py` raises a clear `FileNotFoundError` if it is missing.

### Why MediaPipe (not Haar Cascade)

The original plan used OpenCV Haar Cascade. We switched to **MediaPipe** because:
- `align_facial_images` produced the training crops with MediaPipe face-mesh landmarks, so runtime detection + alignment use the same landmark topology — minimal drift between train and inference.
- MediaPipe is more robust to poor lighting and off-axis angles than Haar, and gives the eye + face-oval landmarks the alignment step needs directly.

`mediapipe` is already a project dependency. This supersedes the Haar Cascade section of the original plan.

### Known limitations

- Very extreme angles / heavy occlusion (mask, sunglasses) can still fail detection → `no_face`. The photo page instructs the user to face the camera and remove obstructions.
- The landmarks are used only for alignment framing; we don't rely on their per-point precision.

---

## Stage 3 — Align and crop (the `align_facial_images` algorithm)

This is the heart of the pipeline and **must stay identical** to `scripts/align_facial_images`. Landmark id sets:

```python
# FACE_OVAL_IDS are the 36 canonical FACEMESH_FACE_OVAL vertices, hardcoded in
# src/fer/image_pipeline.py (the Tasks API no longer ships the FACEMESH_* constants;
# the hardcoded list is verified to match mediapipe's own derivation).
FACE_OVAL_IDS = [10, 21, 54, 58, 67, 93, 103, 109, 127, 132, 136, 148, 149, 150,
                 152, 162, 172, 176, 234, 251, 284, 288, 297, 323, 332, 338, 356,
                 361, 365, 377, 378, 379, 389, 397, 400, 454]
LEFT_EYE_IDS  = [33, 133]     # eye centre = mean of the two eye-corner landmarks
RIGHT_EYE_IDS = [362, 263]

OUT_SIZE   = 300
PAD_WHITE  = 255              # white padding for rotation borders + out-of-bounds crop
FACE_MARGIN = 0.01            # extra margin around the face-oval box
```

Steps (all on the **grayscale** image derived from the decoded RGB):

1. **Grayscale:** `gray = np.asarray(Image.fromarray(rgb).convert("L"))`.
2. **Align:** compute left/right eye centres from the eye-corner landmarks, swap if mirrored, get the roll angle `atan2(dy, dx)`, and rotate the whole gray image about the eye midpoint so the eyes are horizontal — `cv2.warpAffine(..., flags=cv2.INTER_CUBIC, borderValue=PAD_WHITE)`.
3. **Square crop:** transform the face-oval landmarks by the same rotation matrix, take their bounding box, expand to a square of side `max(width, height) * (1 + FACE_MARGIN)` centred on the box centre, and crop — padding any out-of-bounds region with white 255.
4. **Resize:** `Image.resize((300, 300), Image.LANCZOS)`.

Output: a `(300, 300)` uint8 **grayscale** array whose face fills the frame, eyes level — a RAF-DB-style aligned crop.

**Why no background removal?** An earlier `bg_removal` variant flooded the background with gray-128. It was dropped: only disgust used it in training, so at inference it would push in-scope faces off-distribution (and risk a "gray background ⇒ disgust" shortcut). Keeping the natural background matches the RAF-DB in-scope training images.

---

## Stage 4 — Quality check

Performed **after** the crop, so thresholds are calibrated on the exact 300 × 300 image the model receives. The crop is already single-channel, so no colour conversion is needed.

```python
BLUR_THRESHOLD = 20.0    # Laplacian variance; calibrated below (retune in CP2)
MIN_BRIGHTNESS = 40.0    # mean intensity, 0–255
MAX_BRIGHTNESS = 230.0

def check_quality(gray_300: np.ndarray) -> dict | None:
    """Return an error dict if quality fails, else None."""
    if cv2.Laplacian(gray_300, cv2.CV_64F).var() < BLUR_THRESHOLD:
        return {"error": "low_quality_blur"}
    mean = float(gray_300.mean())
    if mean < MIN_BRIGHTNESS:
        return {"error": "low_quality_dark"}
    if mean > MAX_BRIGHTNESS:
        return {"error": "low_quality_bright"}
    return None
```

- **Blur** — the Laplacian highlights edges; sharp images have high edge variance, blurry ones low. Calibrated to `20.0`: a real (soft) webcam selfie scored **~41**, while heavy/out-of-focus blur typically scores **< 10**. `100.0` (the original placeholder) wrongly rejected normal webcam captures. Checked first because handheld shake is the most common failure — fail fast. Retune in CP2 with intentionally blurry vs. sharp sets.
- **Brightness** — a normal indoor selfie sits ~100–180. Below ~40 is too dark; above ~230 washes out facial features.
- Calibrate all three during CP2 with intentionally blurry / dark / bright captures.

---

## Stage 5 — To model tensor

The FER model expects **grayscale `(300, 300, 1)` float32 in `[0, 255]`** (see `docs/FER_MODEL.md`). No normalisation here — EfficientNet-B3 normalises internally.

```python
def to_model_tensor(gray_300: np.ndarray) -> np.ndarray:
    """uint8 (300, 300) → float32 (300, 300, 1), values left in [0, 255]."""
    return gray_300.astype("float32")[..., np.newaxis]
```

**Critical:** do **not** apply `efficientnet.preprocess_input`, `/255.0`, or any other scaling. Training fed raw `[0, 255]`; inference must too. (This inverts the original plan's Stage 7, which normalised to `[-1, 1]` for an RGB setup we no longer use.)

---

## End-to-end pipeline function

```python
# src/fer/image_pipeline.py

def process(b64_image: str) -> dict:
    """Run the full pipeline. Returns {"status": "ok", "tensor": np.ndarray}
    or {"status": "error", "error": "<code>", ...}."""
    try:
        rgb = decode_image(b64_image)
    except ValueError:
        return {"status": "error", "error": "decode_failed"}

    faces = detect_faces(rgb)
    if len(faces) == 0:
        return {"status": "error", "error": "no_face"}
    if len(faces) > 1:
        return {"status": "error", "error": "multiple_faces", "count": len(faces)}

    gray_300 = align_and_crop(rgb, faces[0])

    quality_error = check_quality(gray_300)
    if quality_error is not None:
        return {"status": "error", **quality_error}

    return {"status": "ok", "tensor": to_model_tensor(gray_300)}
```

This function is **pure given a fixed image** — no disk I/O, no randomness, no global state mutation (the FaceLandmarker singleton is read-only after construction). That makes it deterministic and testable.

---

## Error codes and UI mapping

| Error code | User-facing message | Suggested user action |
|---|---|---|
| `decode_failed` | "Could not read the image." | Retake photo |
| `no_face` | "No face detected." | Centre your face in the frame |
| `multiple_faces` | "More than one face detected." | Only one person at a time |
| `low_quality_blur` | "Image is too blurry." | Hold the camera steady |
| `low_quality_dark` | "Image is too dark." | Move to a brighter room |
| `low_quality_bright` | "Image is too bright." | Reduce glare or move away from the light |

Downstream layers (FER model out-of-scope, recommender) add their own codes — see their docs.

---

## UI guidance (recommended on the photo-taking page)

To minimise failures, the photo page should show — *before* the shutter is enabled:

- Live webcam preview with a centred oval outline guide.
- Instructions: "Face the camera directly.", "Remove glasses, masks, and hair covering your face.", "Make sure the lighting is even on your face."
- A live indicator that turns the oval green when exactly one face is visible (run a lightweight FaceLandmarker pass on the preview at ~2 Hz). Purely a UI aid; the authoritative detection still runs in the pipeline on the shutter frame.

See `docs/FRONTEND.md` for layout details.

---

## Testing

### Unit tests (`tests/fer/test_image_pipeline.py`)

The pure helpers are tested directly without heavy dependencies:
- `decode_image` — valid base64 PNG → RGB array; invalid base64 → `ValueError` → `decode_failed`.
- `crop_square` — output size + white padding for out-of-bounds crops.
- `check_quality` — synthetic arrays for blur (low-variance uniform), dark (all-10), bright (all-250), and a sharp/mid-brightness pass.
- `to_model_tensor` — shape `(300, 300, 1)`, dtype float32, values preserved in `[0, 255]`.

The face-dependent branches are tested by **monkeypatching `detect_faces`** so no real face image (or MediaPipe install) is required:
- 0 faces → `no_face`; 2 faces → `multiple_faces`; 1 fabricated face → `status == "ok"` with a correctly shaped tensor.

An optional end-to-end test runs against a real happy-face fixture (`tests/fixtures/images/happy_face.png.b64`) if present, and is skipped otherwise. Real face images behave differently from synthetic ones, so fixtures should be real captures / RAF-DB crops.

---

## Performance notes

- **Total pipeline budget:** < 1 second on a typical laptop CPU.
- **Dominant cost:** MediaPipe FaceLandmarker (`RunningMode.IMAGE`). Reuse the singleton — reconstructing it per call is the main avoidable cost.
- MediaPipe resizes internally, so very large frames are handled, but capping the capture resolution on the JS side (e.g. 1280 px) keeps latency down.

---

## MediaPipe usage telemetry (privacy disclosure)

MediaPipe — the face-detection dependency used in Stage 2 — ships with **Google's
"Clearcut" client-telemetry uploader compiled into its binaries**. EchoSoul adds no
analytics of its own (see CLAUDE.md §5 "Privacy-sensitive data"), but this third-party
component runs inside the app process and periodically attempts to contact Google.
Owner decision (2026-07-14): **accept and disclose in the capstone report** rather than
patch around it. This section is the factual basis for that disclosure.

### What happens, and why it happens

- When the first `FaceLandmarker` runs (the FER warm-up at app start, or the photo
  page's live face check), MediaPipe's embedded Clearcut client starts. From then on it
  attempts to upload batched usage events to **`https://play.googleapis.com/log`**
  (Google's Clearcut / Play log-collection endpoint) roughly **once every 60 seconds**
  for the life of the process, honouring a server-directed backoff window.
- It happens because Google compiles this usage-analytics client into the released
  `mediapipe` PyPI wheels. The application does not enable it, cannot see it through the
  Python API, and the wheel exposes **no documented switch to disable it**.
- Observed live in the F9 session log (2026-07-14), repeating every ~60 s:

  ```
  portable_clearcut_uploader.cc:90] Failed to send to clearcut:
  FAILED_PRECONDITION: Not valid for uploading until: 2026-07-14T03:42:23+00:00
  ```

  `FAILED_PRECONDITION` here is the client's own rate-limit window ("don't upload again
  until \<time\>"), **not** a permanent block — once the window passes, an upload can
  succeed. Assume the telemetry does reach Google on machines with internet access.

### What is uploaded

Binary inspection of the installed wheel (`mediapipe==0.10.35`; embedded strings in
`tasks/c/libmediapipe.dll`) shows the payload is Google's generic client-analytics
event format plus a MediaPipe-specific extension:

- `wireless/android/play/playlog/proto/clientanalytics.proto` — `LogRequest` /
  `LogEvent` / `LogEventKeyValues`: compact usage events expressed as **enums and
  key-value pairs**, carrying client/platform information (there is e.g. a
  `WindowsClientInfo` message) and timestamps, sent over HTTPS with a `Bearer` token.
- `third_party/mediapipe/util/analytics/mediapipe_log_extension.proto` +
  `mediapipe_logging_enums.proto`, including `logs.proto.mediapipe.SolutionName` — the
  MediaPipe-specific events record **which MediaPipe solution/task is used** (an enum
  value) plus library-usage metadata.

The exact field values Google populates are not publicly documented; the schema types
embedded in the binary bound what the payload *can* contain: library-usage metadata of
the form "a Windows client used the FaceLandmarker solution at time T".

### What is NOT uploaded

- **No camera frames, no face crops, no landmarks, no emotion predictions.** The event
  schema is an enum/key-value usage format with **no image payload field**; image data
  flows through the MediaPipe graph in memory and never enters the logging path.
- EchoSoul's own guarantees are unchanged and enforced by application code: captured
  images are processed in-memory only, never written to disk (outside explicit debug
  mode), never transmitted by application code, and discarded immediately after
  prediction.

The project's hard privacy rule — **facial images never leave the machine** — therefore
holds. What leaves the machine is third-party *library-usage* telemetry, not user data.

### Why disclose instead of block

| Option | Verdict |
|---|---|
| Disclose in the report | **Chosen** — zero engineering risk; honest limitation |
| Block `play.googleapis.com` via hosts file / firewall | Machine-wide side effects on other Google software; unreasonable to require of user-study participants |
| Rebuild MediaPipe from source with analytics compiled out | Out of all proportion for a solo capstone; unmaintainable |

### Suggested report wording (adapt as needed)

> The face-detection library used by the system (Google MediaPipe) embeds a usage-
> telemetry client that periodically attempts to report library-usage events — which
> MediaPipe component is in use, platform information, and timestamps — to a Google
> logging endpoint over HTTPS. This telemetry is compiled into the distributed library
> and cannot be disabled through its public API. Inspection of the library's embedded
> event schema and of its runtime behaviour confirmed that these events are a compact
> enum/key-value usage format and cannot carry image data; captured facial images are
> processed in memory by the application and never enter the telemetry path. The system
> itself performs no analytics or tracking. This third-party telemetry is disclosed as a
> limitation of the chosen dependency rather than a behaviour of the system.

---

## Related docs

- `docs/FER_MODEL.md` — the model that consumes this pipeline's `(300, 300, 1)` `[0, 255]` output.
- `scripts/align_facial_images` — the offline script this pipeline mirrors.
- `docs/FRONTEND.md` — webcam UI and the bridge call.
- `docs/ARCHITECTURE.md` — where this pipeline sits in the full flow.
