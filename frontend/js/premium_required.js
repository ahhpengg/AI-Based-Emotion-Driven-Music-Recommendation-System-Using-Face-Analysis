/*
 * Premium-required page logic (docs/FRONTEND.md, docs/SPOTIFY_INTEGRATION.md).
 *
 * This is a SOFT gate: playback needs Premium, but the rest of EchoSoul (mood
 * detection, playlist building) works for Free accounts, with each song opening
 * in Spotify instead of playing in-app. So the page offers three paths — upgrade,
 * "Continue without playback" (proceed in Free mode), or switch accounts.
 *
 * The upgrade link must open in the SYSTEM browser — navigating the embedded
 * webview away from the app would strand the user — so it goes through the
 * allowlisted open_external_url bridge method. "Check again" re-runs the auth
 * gate, whose verify_premium() does a fresh /me fetch.
 */

import { callPy } from "./bridge.js";

const els = {
  upgradeBtn: document.querySelector("#upgrade-btn"),
  continueBtn: document.querySelector("#continue-btn"),
  recheckBtn: document.querySelector("#recheck-btn"),
  switchBtn: document.querySelector("#switch-btn"),
  accountLine: document.querySelector("#account-line"),
  status: document.querySelector("#premium-status"),
};

function setError(text) {
  els.status.textContent = text;
}

// Cached by the info fetch below and reused when the user continues in Free mode,
// so the downstream pages get the real display name / product without a re-fetch.
let currentProfile = null;

// Best-effort "who is logged in" line; the page works fine without it.
(async () => {
  try {
    currentProfile = await callPy("get_user_profile");
    if (currentProfile?.display_name) {
      els.accountLine.textContent =
        `Logged in as ${currentProfile.display_name} (${currentProfile.product || "free"} account)`;
    }
  } catch {
    // Ignore: purely informational.
  }
})();

els.continueBtn.addEventListener("click", () => {
  // Enter Free mode: stash the profile the way the auth gate does for Premium
  // users so the chrome/result pages can read `.premium` and hide playback.
  // Fall back to a minimal Free marker if the profile fetch above failed.
  const profile = currentProfile || { premium: false, product: "free" };
  sessionStorage.setItem("spotify_profile", JSON.stringify(profile));
  window.location.replace("home.html");
});

els.upgradeBtn.addEventListener("click", async () => {
  setError("");
  try {
    await callPy("open_external_url", "https://www.spotify.com/premium/");
  } catch (err) {
    setError(err.message || "Couldn't open the browser. Visit spotify.com/premium manually.");
  }
});

els.recheckBtn.addEventListener("click", () => {
  window.location.replace("../index.html"); // re-runs the auth gate
});

els.switchBtn.addEventListener("click", async () => {
  setError("");
  try {
    await callPy("logout");
    window.location.replace("login.html");
  } catch (err) {
    setError(err.message || "Logout failed. Please try again.");
  }
});
