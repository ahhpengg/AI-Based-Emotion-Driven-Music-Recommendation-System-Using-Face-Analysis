/*
 * Manual mood selection.
 *
 * Records the chosen emotion (manual source) and advances to the loading
 * screen. Real inference is skipped for a manual pick; the bridge wiring lives
 * in loading.js later (see docs/FRONTEND.md).
 */
document.querySelectorAll(".mood-card").forEach((card) => {
  card.addEventListener("click", () => {
    const emotion = card.dataset.emotion;
    sessionStorage.setItem("last_emotion", emotion);
    sessionStorage.setItem("emotion_source", "manual");
    window.location.assign("loading.html");
  });
});
