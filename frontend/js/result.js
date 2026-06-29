/*
 * Result page.
 *
 * One template, five emotions. The chosen emotion comes from
 * sessionStorage.last_emotion (set by mood.js / loading.js); the copy, accent
 * colour, mood image and the sample tracklist below are placeholders that mirror
 * the Stitch prototypes. When the backend exists, replace EMOTIONS[...].tracks
 * with the playlist returned by generate_playlist (see docs/FRONTEND.md).
 */
const EMOTIONS = {
  happy: {
    accent: "#6ffbbe",
    img: "../assets/img/emoji-happy.png",
    cover: "../assets/img/cover-happy.png",
    heading: "You seem Happy!",
    subtitle: "We have customized a playlist to match this vibe.",
    title: "Happy Playlist",
    meta: "Curated for your joyful moments • 24 songs, 1 hr 15 min",
    tracks: [
      ["Happy", "Pharrell Williams", "Despicable Me 2", "3:53"],
      ["Walking On Sunshine", "Katrina & The Waves", "Walking on Sunshine", "3:58"],
      ["Can't Stop the Feeling!", "Justin Timberlake", "Trolls", "3:56"],
    ],
  },
  surprised: {
    accent: "#4edea3",
    img: "../assets/img/emoji-surprised.png",
    cover: "../assets/img/cover-surprised.png",
    heading: "You seem Surprised!",
    subtitle: "Unexpected drops, sudden tempo changes, and tracks that'll catch you off guard.",
    title: "Surprise Mix",
    meta: "Curated for your wide-eyed state of mind • 24 songs, 1 hr 15 min",
    tracks: [
      ["Surprised", "Pharrell Williams", "Surprise Edition", "3:53"],
      ["Midnight City", "M83", "Hurry Up, We're Dreaming", "4:03"],
      ["Genesis", "Justice", "† (Cross)", "3:54"],
    ],
  },
  sad: {
    accent: "#82b1ff",
    img: "../assets/img/emoji-sad.png",
    cover: "../assets/img/cover-sad.png",
    heading: "You seem Sad.",
    subtitle: "Embrace the melancholy. We've curated a collection of deeply emotional and reflective tracks to accompany your quiet moments.",
    title: "Sad Melodies",
    meta: "Deeply emotional and reflective tracks • 18 songs, 1 hr 02 min",
    tracks: [
      ["Someone Like You", "Adele", "21", "4:45"],
      ["Fix You", "Coldplay", "X&Y", "4:55"],
      ["Yesterday", "The Beatles", "Help!", "2:05"],
      ["The Night We Met", "Lord Huron", "Strange Trails", "3:28"],
    ],
  },
  neutral: {
    accent: "#facc15",
    img: "../assets/img/emoji-neutral.png",
    cover: "../assets/img/cover-neutral.png",
    heading: "You seem Neutral.",
    subtitle: "We have customized a playlist to match this vibe.",
    title: "Neutral Playlist",
    meta: "A balanced, calm equilibrium to maintain your steady rhythm • 24 songs, 1 hr 15 min",
    tracks: [
      ["Weightless", "Marconi Union", "Weightless", "8:00"],
      ["Gymnopédie No. 1", "Erik Satie", "3 Gymnopédies", "3:25"],
      ["An Ending (Ascent)", "Brian Eno", "Apollo", "4:26"],
    ],
  },
  angry: {
    accent: "#ff6b6b",
    img: "../assets/img/emoji-angry.png",
    cover: "../assets/img/cover-angry.png",
    heading: "You seem Angry!",
    subtitle: "We have customized a playlist to match this vibe.",
    title: "Angry Playlist",
    meta: "High-energy tracks for your intense moments • 24 songs, 1 hr 15 min",
    tracks: [
      ["Killing in the Name", "Rage Against the Machine", "Rage Against the Machine", "5:14"],
      ["Break Stuff", "Limp Bizkit", "Significant Other", "2:46"],
      ["Wait and Bleed", "Slipknot", "Slipknot", "2:27"],
    ],
  },
};

function hexToRgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function trackRow(index, [title, artist, album, time], accent) {
  const el = document.createElement("div");
  el.className =
    "grid grid-cols-[48px_minmax(0,2fr)_minmax(0,1.5fr)_minmax(0,1fr)_64px] gap-4 px-6 py-3 items-center group hover:bg-white/5 transition-colors cursor-pointer rounded-lg mx-2" +
    (index === 1 ? " mt-1" : "");
  el.innerHTML = `
    <div class="text-center text-on-surface-variant group-hover:hidden">${index}</div>
    <div class="text-center text-primary hidden group-hover:flex items-center justify-center"><span class="material-symbols-outlined filled text-[20px]">play_arrow</span></div>
    <div class="flex items-center gap-3">
      <div class="w-10 h-10 rounded flex items-center justify-center shadow-sm" style="background-color: ${hexToRgba(accent, 0.2)};"><span class="material-symbols-outlined text-[20px]" style="color: ${accent};">music_note</span></div>
      <div class="truncate"><p class="text-body-md font-body-md text-on-surface font-medium truncate"></p></div>
    </div>
    <div class="text-body-md font-body-md text-on-surface-variant truncate group-hover:text-on-surface transition-colors"></div>
    <div class="text-body-md font-body-md text-on-surface-variant truncate"></div>
    <div class="text-right text-body-md font-body-md text-on-surface-variant font-medium"></div>`;
  // Assign text via textContent (children: 0 #, 1 play, 2 title-block, 3 artist, 4 album, 5 time).
  el.querySelector("p").textContent = title;
  el.children[3].textContent = artist;
  el.children[4].textContent = album;
  el.children[5].textContent = time;
  return el;
}

window.addEventListener("load", () => {
  const key = (sessionStorage.getItem("last_emotion") || "happy").toLowerCase();
  const e = EMOTIONS[key] || EMOTIONS.happy;

  // Banner
  const banner = document.getElementById("result-banner");
  banner.style.backgroundColor = hexToRgba(e.accent, 0.12);
  document.getElementById("result-banner-overlay").style.background =
    `linear-gradient(to bottom, ${hexToRgba(e.accent, 0.1)}, transparent)`;
  const emoji = document.getElementById("result-emoji");
  emoji.src = e.img;
  emoji.alt = e.heading;
  emoji.style.filter = `drop-shadow(0 0 18px ${hexToRgba(e.accent, 0.45)})`;
  const heading = document.getElementById("result-heading");
  heading.textContent = e.heading;
  heading.style.color = e.accent;
  document.getElementById("result-subtitle").textContent = e.subtitle;

  // Cover + meta — use the fixed per-emotion cover art. The gradient stays as a
  // backdrop and only shows if the cover image is missing (see onerror below).
  const cover = document.getElementById("playlist-cover");
  cover.style.backgroundImage = `linear-gradient(135deg, ${e.accent}, #222a3d)`;
  const coverIcon = document.getElementById("cover-icon");
  coverIcon.className = "w-full h-full object-cover";
  coverIcon.onerror = () => {
    // Cover art not uploaded yet: fall back to the centred emoji over the gradient.
    coverIcon.onerror = null;
    coverIcon.className = "w-32 h-32 object-contain";
    coverIcon.src = e.img;
  };
  coverIcon.src = e.cover;
  document.getElementById("playlist-title").textContent = e.title;
  document.getElementById("playlist-meta").textContent = e.meta;

  // Tracklist
  const list = document.getElementById("tracklist");
  list.innerHTML = "";
  e.tracks.forEach((t, i) => list.appendChild(trackRow(i + 1, t, e.accent)));

  document.title = `MoodStream - ${e.title}`;
});
