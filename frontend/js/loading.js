/*
 * Loading page: the detection / recommendation bridge work happens here
 * (docs/FRONTEND.md > loading.html).
 *
 * Camera path (emotion_source === "camera"): the captured frame from
 * sessionStorage.captured_image_b64 goes through detect_emotion. Pipeline
 * failures and out-of-scope detections leave error_code (+ detected_emotion)
 * in sessionStorage and route to error.html. Manual path: the emotion is
 * already in sessionStorage.last_emotion (mood card / home chip).
 *
 * Either way a usable emotion ends in generate_playlist; the tracks land in
 * sessionStorage.current_playlist (+ playlist_emotion) for result.html.
 *
 * All exits use location.replace: this page is transient and its inputs are
 * consumed on the way through, so the Back button must never land here and
 * re-run the flow. The captured frame is removed as soon as it is read —
 * multi-MB of PNG must not outlive the one call that needs it.
 */
import { callPy } from "./bridge.js";

// Keep the analyzing animation up long enough to register; finishing in a
// sub-second flash looks like a glitch. Measured from page load to navigation.
const MIN_DISPLAY_MS = 1500;

// Progress-bar stage caps (%). A bridge call is one opaque await — there is no
// real per-call percentage — so the bar glides toward the running stage's cap
// (slower than any healthy call takes) and the finishing fill to 100% is timed
// to land just before navigation. Forward motion, never a lie of precision.
const DETECT_CAP = 55; // while detect_emotion runs (the slow, model stage)
const DETECT_CREEP_MS = 6000;
const PLAYLIST_CAP = 90; // while generate_playlist runs (fast DB query)
const PLAYLIST_CREEP_MS = 4000;

const startedAt = Date.now();

const els = {
  status: document.getElementById("loading-status"),
  substatus: document.getElementById("loading-substatus"),
  bar: document.getElementById("loading-progress"),
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setStatus(text, subtext) {
  if (els.status) els.status.textContent = text;
  if (els.substatus) els.substatus.textContent = subtext;
}

// Glide the fill toward pct over ms (linear). Interruptible: a new target
// takes over from the currently rendered width, so stage handoffs are smooth.
function progressTo(pct, ms) {
  if (!els.bar) return;
  els.bar.style.transitionDuration = `${ms}ms`;
  els.bar.style.width = `${pct}%`;
}

// Success exit: fill the bar the rest of the way, timed to complete just
// before we navigate (inside the minimum-display window, so the user actually
// sees it reach the end).
async function finishAndLeave(page) {
  const remaining = Math.max(MIN_DISPLAY_MS - (Date.now() - startedAt), 500);
  progressTo(100, remaining - 200);
  await sleep(remaining);
  window.location.replace(page);
}

async function leaveFor(page) {
  const remaining = MIN_DISPLAY_MS - (Date.now() - startedAt);
  if (remaining > 0) await sleep(remaining);
  window.location.replace(page);
}

function fail(code, detected) {
  sessionStorage.setItem("error_code", code);
  if (detected) sessionStorage.setItem("detected_emotion", detected);
  else sessionStorage.removeItem("detected_emotion");
  return leaveFor("error.html");
}

(async function run() {
  const source = sessionStorage.getItem("emotion_source");
  // Flush layout so the bar's initial 0% width is rendered; otherwise the
  // first glide has no starting keyframe and the width just snaps.
  void els.bar?.offsetWidth;
  try {
    let emotion = null;

    if (source === "camera") {
      const b64 = sessionStorage.getItem("captured_image_b64");
      sessionStorage.removeItem("captured_image_b64"); // consumed either way
      if (!b64) {
        // Stale re-entry (history / deep link): nothing left to analyse.
        window.location.replace("home.html");
        return;
      }
      progressTo(DETECT_CAP, DETECT_CREEP_MS);
      const result = await callPy("detect_emotion", b64);
      if (result.status === "out_of_scope") {
        await fail("out_of_scope", result.detected);
        return;
      }
      if (result.status !== "ok") {
        await fail(result.error || "unexpected");
        return;
      }
      emotion = result.emotion;
      sessionStorage.setItem("last_emotion", emotion);
    } else if (source === "manual") {
      emotion = sessionStorage.getItem("last_emotion");
    }

    if (!emotion) {
      // Landed here without a flow behind it: head home rather than error.
      window.location.replace("home.html");
      return;
    }

    setStatus("Building your playlist...", "Matching songs to your mood");
    progressTo(PLAYLIST_CAP, PLAYLIST_CREEP_MS);
    const playlist = await callPy("generate_playlist", emotion);
    if (!Array.isArray(playlist) || !playlist.length) {
      await fail("playlist_failed");
      return;
    }
    sessionStorage.setItem("current_playlist", JSON.stringify(playlist));
    sessionStorage.setItem("playlist_emotion", emotion);
    await finishAndLeave("result.html");
  } catch (err) {
    // Unexpected bridge failure (backend raised, timed out, DB down, ...).
    console.error("Loading flow failed:", err);
    await fail("unexpected");
  }
})();
