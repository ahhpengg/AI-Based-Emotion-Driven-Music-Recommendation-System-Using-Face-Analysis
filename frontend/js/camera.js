/*
 * Photo page: live webcam capture with a real-time face-presence guide
 * (docs/FRONTEND.md > photo.html, docs/IMAGE_PIPELINE.md > UI guidance).
 *
 * Flow:
 *   1. getUserMedia streams into #webcam-preview (mirrored via CSS for a
 *      natural selfie view; the captured data itself is NOT mirrored).
 *   2. Every 500 ms a downscaled JPEG frame goes to quick_face_check and the
 *      oval guide turns green (exactly one face) or red (none / several); the
 *      Capture button follows. Purely a UI aid — the authoritative gate runs
 *      inside detect_emotion on the shutter frame. One ping in flight at a
 *      time, so slow bridge calls never pile up behind the FER lock.
 *   3. Capture freezes the full-resolution frame as lossless PNG (JPEG
 *      artefacts could distort facial features — see the pipeline doc).
 *      "Use this photo" stashes it in sessionStorage.captured_image_b64 with
 *      emotion_source="camera" and advances to loading.html, which runs
 *      detect_emotion (loading.js); "Retake" returns to the live preview.
 *
 * The stream is stopped on pagehide so the camera light never stays on after
 * leaving the page.
 */
import { callPyWithTimeout } from "./bridge.js";

const PING_INTERVAL_MS = 500; // ~2 Hz, per docs/FRONTEND.md
const PING_TIMEOUT_MS = 5000; // a hung ping must not wedge the loop
const PING_MAX_DIM = 320; // the bridge downscales again; small payload = fast call

const GUIDE_NEUTRAL = ""; // clears the inline override back to the CSS default
const GUIDE_OK = "#4edea3";
const GUIDE_BAD = "#ff6b6b";

const els = {
  video: document.getElementById("webcam-preview"),
  placeholder: document.getElementById("camera-placeholder"),
  captured: document.getElementById("captured-preview"),
  guide: document.getElementById("face-guide"),
  guideInner: document.getElementById("face-guide-inner"),
  scanner: document.getElementById("scanner-line"),
  status: document.getElementById("face-status"),
  captureBtn: document.getElementById("capture-btn"),
  capturedActions: document.getElementById("captured-actions"),
  useBtn: document.getElementById("use-photo-btn"),
  retakeBtn: document.getElementById("retake-btn"),
  retryWrap: document.getElementById("camera-retry"),
  retryBtn: document.getElementById("retry-camera-btn"),
};

let stream = null;
let frozen = false; // captured state: pings pause, preview freezes
let pingTimer = null;
let pingInFlight = false;
let capturedDataUrl = null;

function setStatus(text) {
  els.status.textContent = text;
}

function setGuide(colour) {
  els.guide.style.borderColor = colour;
  els.guideInner.style.borderColor = colour;
}

// Draw the current video frame onto a canvas and return it as a data URL.
// maxDim=0 keeps full resolution. Returns null while the stream isn't ready.
function grabFrame(maxDim, type, quality) {
  const w = els.video.videoWidth;
  const h = els.video.videoHeight;
  if (!w || !h) return null;
  const scale = maxDim ? Math.min(1, maxDim / Math.max(w, h)) : 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext("2d").drawImage(els.video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL(type, quality);
}

// ---- Live face-presence ping (2 Hz) -----------------------------------------

function schedulePing() {
  clearTimeout(pingTimer);
  pingTimer = setTimeout(ping, PING_INTERVAL_MS);
}

function applyFaceCount(count) {
  if (count === 1) {
    setGuide(GUIDE_OK);
    els.captureBtn.disabled = false;
    setStatus("Face detected — you're good to go!");
  } else if (count === 0) {
    setGuide(GUIDE_BAD);
    els.captureBtn.disabled = true;
    setStatus("No face detected. Centre your face inside the oval.");
  } else {
    setGuide(GUIDE_BAD);
    els.captureBtn.disabled = true;
    setStatus("More than one face detected — one person at a time, please.");
  }
}

async function ping() {
  if (frozen || !stream) return;
  if (pingInFlight) {
    schedulePing();
    return;
  }
  // JPEG is fine for counting faces (the shutter frame stays lossless PNG).
  const dataUrl = grabFrame(PING_MAX_DIM, "image/jpeg", 0.7);
  if (!dataUrl) {
    schedulePing();
    return;
  }
  pingInFlight = true;
  try {
    const result = await callPyWithTimeout(
      PING_TIMEOUT_MS,
      "quick_face_check",
      dataUrl.split(",")[1]
    );
    if (!frozen) applyFaceCount(result.face_count);
  } catch (err) {
    // Bridge slow/unavailable (e.g. FER still warming up): keep the shutter
    // locked rather than guessing, and keep trying.
    console.error("quick_face_check failed:", err);
    if (!frozen) {
      setGuide(GUIDE_NEUTRAL);
      els.captureBtn.disabled = true;
      setStatus("Checking for your face…");
    }
  } finally {
    pingInFlight = false;
    if (!frozen) schedulePing();
  }
}

// ---- Camera lifecycle --------------------------------------------------------

async function startCamera() {
  setStatus("Starting camera…");
  els.retryWrap.classList.add("hidden");
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
      audio: false,
    });
  } catch (err) {
    console.error("getUserMedia failed:", err);
    const denied = err && (err.name === "NotAllowedError" || err.name === "SecurityError");
    setStatus(
      denied
        ? "Camera access was denied. Allow camera access for EchoSoul and try again."
        : "No camera found. Connect a webcam and try again."
    );
    els.retryWrap.classList.remove("hidden");
    return;
  }
  els.video.srcObject = stream;
  els.video.classList.remove("hidden");
  els.placeholder.classList.add("hidden");
  setGuide(GUIDE_NEUTRAL);
  setStatus("Looking for your face…");
  schedulePing();
}

function stopCamera() {
  clearTimeout(pingTimer);
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }
}

// ---- Capture / retake / use ---------------------------------------------------

els.captureBtn.addEventListener("click", () => {
  const dataUrl = grabFrame(0, "image/png"); // full res, lossless (pipeline doc)
  if (!dataUrl) return;
  capturedDataUrl = dataUrl;
  frozen = true;
  clearTimeout(pingTimer);
  els.captured.src = dataUrl;
  els.captured.classList.remove("hidden");
  els.video.classList.add("hidden");
  els.scanner.classList.add("hidden");
  els.guide.classList.add("hidden");
  els.captureBtn.classList.add("hidden");
  els.capturedActions.classList.remove("hidden");
  setStatus("Proceed with this photo?");
});

els.retakeBtn.addEventListener("click", () => {
  frozen = false;
  capturedDataUrl = null;
  els.captured.classList.add("hidden");
  els.captured.removeAttribute("src");
  els.video.classList.remove("hidden");
  els.scanner.classList.remove("hidden");
  els.guide.classList.remove("hidden");
  els.capturedActions.classList.add("hidden");
  els.captureBtn.classList.remove("hidden");
  els.captureBtn.disabled = true;
  setGuide(GUIDE_NEUTRAL);
  setStatus("Looking for your face…");
  schedulePing();
});

els.useBtn.addEventListener("click", () => {
  if (!capturedDataUrl) return;
  try {
    sessionStorage.setItem("captured_image_b64", capturedDataUrl.split(",")[1]);
  } catch (err) {
    // Storage quota — not expected at 1280×720, but never strand the user.
    console.error("Storing the capture failed:", err);
    setStatus("Couldn't hand the photo over. Please retake it.");
    return;
  }
  sessionStorage.setItem("emotion_source", "camera");
  stopCamera();
  window.location.assign("loading.html");
});

els.retryBtn.addEventListener("click", startCamera);

window.addEventListener("pagehide", stopCamera);

startCamera();
