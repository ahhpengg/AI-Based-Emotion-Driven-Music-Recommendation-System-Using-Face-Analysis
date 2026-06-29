/*
 * Loading / "Analyzing Emotion" screen.
 *
 * Static import: after a short delay we advance to the result screen. Once the
 * backend exists this is where detect_emotion (camera path) and
 * generate_playlist run, routing to result.html or error.html based on the
 * outcome (see docs/FRONTEND.md > loading.html).
 */
window.addEventListener("load", () => {
  // Default to a happy result if no emotion was chosen (e.g. camera path demo).
  if (!sessionStorage.getItem("last_emotion")) {
    sessionStorage.setItem("last_emotion", "happy");
  }
  setTimeout(() => window.location.assign("result.html"), 2600);
});
