/*
 * Home page interactions.
 *
 * Static navigation only for this design import — no Python bridge calls yet
 * (see docs/FRONTEND.md for where the real detect_emotion / generate_playlist
 * calls will hook in later).
 */
const hero = document.getElementById("camera-hero-section");
const cameraImg = document.getElementById("local-camera-img");
const caption = document.getElementById("hero-caption");

if (hero && cameraImg) {
  hero.addEventListener("click", () => {
    // Zoom the camera toward the viewer, then advance to the capture screen.
    if (caption) caption.style.opacity = "0";
    cameraImg.style.transform = "translateY(-10%) scale(6)";
    cameraImg.style.opacity = "0";
    setTimeout(() => window.location.assign("photo.html"), 650);
  });
}

document.getElementById("scan-cta")?.addEventListener("click", () => {
  window.location.assign("photo.html");
});

document.getElementById("manual-mood-btn")?.addEventListener("click", () => {
  window.location.assign("mood.html");
});

document.querySelectorAll(".mood-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    if (chip.dataset.emotion) {
      sessionStorage.setItem("preselected_mood", chip.dataset.emotion);
    }
    window.location.assign("mood.html");
  });
});
