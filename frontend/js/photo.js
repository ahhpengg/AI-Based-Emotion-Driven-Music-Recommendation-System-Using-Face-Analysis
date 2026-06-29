/*
 * Camera scan page.
 *
 * Static import: the Capture button simply advances to the loading screen.
 * The real webcam preview (getUserMedia into #webcam-preview), the per-frame
 * face-presence check, and the detect_emotion bridge call are added later
 * (see docs/FRONTEND.md > photo.html / camera.js).
 */
document.getElementById("capture-btn")?.addEventListener("click", () => {
  sessionStorage.setItem("emotion_source", "camera");
  window.location.assign("loading.html");
});
