/*
 * Error page messaging (docs/FRONTEND.md > error.html).
 *
 * loading.js routes here after a detection / playlist failure, leaving the
 * cause in sessionStorage:
 *   error_code       — image-pipeline code (no_face, multiple_faces,
 *                      low_quality_*, decode_failed), "out_of_scope",
 *                      "playlist_failed" or "unexpected"
 *   detected_emotion — the out-of-scope model label (fear / disgust)
 *
 * The keys are read, not consumed, so refreshing the page keeps the message.
 * Opened directly with no code at all (design preview), the static prototype
 * copy stays.
 */
const ERROR_MESSAGES = {
  no_face: "We couldn't see a face. Please centre your face in the frame and try again.",
  multiple_faces: "We detected more than one face. Please make sure only one person is in the photo.",
  low_quality_blur: "The image is too blurry. Please hold the camera steady.",
  low_quality_dark: "The image is too dark. Move to a brighter spot.",
  low_quality_bright: "The image is too bright. Reduce glare or move away from direct light.",
  decode_failed: "Something went wrong reading the photo. Please try again.",
  playlist_failed: "We couldn't build a playlist just now. Please try again in a moment.",
  // out_of_scope is handled specially below so the detected emotion is bolded.
};

const code = sessionStorage.getItem("error_code");
if (code) {
  const el = document.getElementById("error-message");
  if (code === "out_of_scope") {
    // Bold the detected out-of-scope emotion (e.g. fear / disgust). Built from
    // DOM nodes rather than innerHTML so the model label can never inject markup.
    const detected = sessionStorage.getItem("detected_emotion") || "an emotion";
    const strong = document.createElement("strong");
    strong.textContent = detected;
    strong.className = "font-bold text-on-surface";
    el.replaceChildren(
      "We detected ",
      strong,
      ", which isn't supported for music recommendations. Try choosing your mood manually."
    );
  } else {
    const entry = ERROR_MESSAGES[code];
    el.textContent = entry || "An unexpected error occurred. Please try again.";
  }
}
