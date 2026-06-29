/*
 * Shared UI behaviour for MoodStream pages.
 *
 * Currently: toggle the top app bar's elevation/opacity once the canvas is
 * scrolled, matching the Stitch prototype. Plain script (no module) so it can be
 * dropped into any page that has a <header>.
 */
window.addEventListener("scroll", () => {
  const header = document.querySelector("header");
  if (!header) return;
  if (window.scrollY > 20) {
    header.classList.add("shadow-md", "bg-background/95");
    header.classList.remove("bg-background/80");
  } else {
    header.classList.remove("shadow-md", "bg-background/95");
    header.classList.add("bg-background/80");
  }
});
