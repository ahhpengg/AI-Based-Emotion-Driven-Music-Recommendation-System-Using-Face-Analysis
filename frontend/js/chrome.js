/*
 * Shared page chrome for EchoSoul (sidebar + top app bar + bottom player).
 *
 * Why this exists: the sidebar, header and player used to be copy-pasted into
 * every page. They are now defined ONCE here and injected into each page, so a
 * change to navigation, styling or responsive behaviour is made in a single
 * place. Plain script (no module) — loaded BEFORE each page's own script so the
 * injected nodes exist by the time page code runs.
 *
 * Per-page config comes from <body data-page="...">. Asset/link paths assume
 * the page lives in frontend/pages/ (all chrome consumers do).
 *
 * Responsive model (desktop PyWebView window the user can resize):
 *   - >= lg (1024px): fixed 280px sidebar, header/player sit beside it.
 *   - <  lg: sidebar becomes an off-canvas drawer toggled by the header's
 *     hamburger, dimmed by a backdrop; content goes full width.
 *
 * PLACEHOLDER DATA: only the player's queue button and the sidebar's Recents
 * row are still static. The sidebar playlist list is LIVE: this script renders
 * the empty #sidebar-playlists container and js/sidebar.js (a module loaded
 * after this script) fills it from the Python bridge (list_user_playlists);
 * the sidebar's + button (#sidebar-new-playlist) opens js/create_playlist.js's
 * create-playlist modal. The header search box is LIVE too: this script
 * renders the input + empty dropdown and js/search.js drives them (catalogue
 * search, play, add-to-playlists). The bottom player is rendered idle here and
 * driven live by js/playback.js (Spotify Web Playback SDK). See
 * docs/FRONTEND.md.
 */
(function () {
  "use strict";

  const PAGE_CONFIG = {
    home:    { header: "full", footer: true,  scan: true  },
    mood:    { header: "full", footer: true,  scan: true  },
    loading: { header: "full", footer: true,  scan: false },
    result:  { header: "full", footer: true,  scan: true  },
    error:   { header: "full", footer: true,  scan: false },
    photo:   { header: "back", footer: false, scan: false },
  };

  const page = document.body.dataset.page || "home";
  const cfg = PAGE_CONFIG[page] || PAGE_CONFIG.home;

  // Free (non-Premium) accounts can't use the in-app Web Playback SDK, so the
  // bottom "now playing" player is meaningless for them — suppress it. The tier
  // comes from the profile the auth gate / premium page stashed. Absent profile
  // (e.g. a page opened directly in dev) is treated as Premium: no regression.
  function isFreeUser() {
    try {
      const p = JSON.parse(sessionStorage.getItem("spotify_profile") || "null");
      return p ? p.premium === false : false;
    } catch {
      return false;
    }
  }
  const showFooter = cfg.footer && !isFreeUser();

  // ---- Sidebar -------------------------------------------------------------
  // The playlist list itself is filled by js/sidebar.js (live bridge data) and
  // the "new playlist" + button is driven by js/create_playlist.js; the
  // search/Recents control is still a placeholder.
  function sidebarHTML() {
    const scanBlock = cfg.scan
      ? `<div class="mt-auto pt-6 pb-28">
           <button data-nav="scan" class="w-full flex items-center justify-center gap-3 px-6 py-3 rounded-full bg-primary text-white font-bold shadow-lg hover:scale-105 hover:brightness-110 transition-all group">
             <span class="material-symbols-outlined" style="font-variation-settings:'FILL' 1,'wght' 700;color:rgb(168,85,247);">photo_camera</span>
             <span class="text-label-md font-bold" style="color:rgb(168,85,247);">Scan Emotion</span>
           </button>
         </div>`
      : `<div class="mt-auto pt-6 pb-28"></div>`;

    return `
    <aside id="app-sidebar" class="w-[280px] h-full fixed left-0 top-0 border-r border-white/10 backdrop-blur-xl shadow-sm bg-surface-container-low flex flex-col py-8 px-6 gap-stack-md z-40 lg:z-20 overflow-y-auto transition-transform duration-300 -translate-x-full lg:translate-x-0">
      <div class="flex items-center gap-4 mb-4">
        <a data-nav="home" class="w-10 h-10 rounded-xl flex items-center justify-center shadow-[0_0_15px_rgba(183,109,255,0.2)] cursor-pointer shrink-0">
          <img src="../assets/img/logo.png" alt="EchoSoul logo" class="w-full h-full object-contain">
        </a>
        <div class="flex-grow min-w-0">
          <h1 class="text-headline-md font-headline-md font-bold text-primary tracking-tight">EchoSoul</h1>
          <p class="text-label-sm font-label-sm text-on-surface-variant opacity-80">Music that echoes your soul</p>
        </div>
        <button data-nav="close-sidebar" aria-label="Close menu" class="lg:hidden w-9 h-9 rounded-full flex items-center justify-center text-on-surface-variant hover:bg-white/5 transition-colors shrink-0">
          <span class="material-symbols-outlined">close</span>
        </button>
      </div>

      <nav class="flex flex-col mt-4 flex-grow gap-[2px]">
        <div class="flex items-center justify-between mt-6 mb-2 pl-3 pr-1">
          <p class="text-label-sm font-label-sm text-outline-variant uppercase tracking-wider">Playlists</p>
          <button id="sidebar-new-playlist" aria-label="New playlist" title="New playlist" class="w-8 h-8 rounded-full flex items-center justify-center text-on-surface-variant hover:bg-white/5 hover:text-primary transition-colors"><span class="material-symbols-outlined text-[20px]">add</span></button>
        </div>
        <div data-placeholder class="flex items-center justify-between px-3 py-2 mb-2 text-on-surface-variant hover:text-on-surface transition-colors cursor-pointer">
          <span class="material-symbols-outlined text-[20px]">search</span>
          <div class="flex items-center gap-2"><span class="text-label-md font-label-md">Recents</span><span class="material-symbols-outlined text-[20px]">list</span></div>
        </div>
        <div id="sidebar-playlists" class="flex flex-col gap-[2px]">
          <p class="px-3 py-2 text-label-sm font-label-sm text-on-surface-variant opacity-60">Loading playlists…</p>
        </div>
      </nav>

      ${scanBlock}
    </aside>`;
  }

  // ---- Top app bar ---------------------------------------------------------
  function headerFullHTML() {
    return `
    <header id="app-header" class="fixed top-0 left-0 right-0 lg:left-[280px] backdrop-blur-md bg-background/80 flex items-center h-16 px-4 md:px-8 z-20 transition-colors duration-300 gap-3 md:gap-6">
      <button data-nav="open-sidebar" aria-label="Open menu" class="lg:hidden w-10 h-10 rounded-full flex items-center justify-center text-on-surface-variant hover:bg-white/5 transition-colors shrink-0"><span class="material-symbols-outlined">menu</span></button>
      <div class="hidden sm:flex items-center gap-4 shrink-0">
        <button data-nav="back" aria-label="Back" class="text-on-surface-variant hover:text-white transition-colors"><span class="material-symbols-outlined text-[24px]">chevron_left</span></button>
        <button data-nav="forward" aria-label="Forward" class="text-on-surface-variant hover:text-white transition-colors"><span class="material-symbols-outlined text-[24px]">chevron_right</span></button>
      </div>
      <div class="flex items-center gap-3 md:gap-4 flex-grow justify-end">
        <button data-nav="home" aria-label="Home" class="w-10 h-10 rounded-full bg-surface-container-high flex items-center justify-center text-white hover:bg-surface-container-highest transition-colors shrink-0"><span class="material-symbols-outlined filled">home</span></button>
        <div id="header-search-wrap" class="relative w-full max-w-md hidden md:block">
          <span class="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-on-surface-variant pointer-events-none">search</span>
          <input id="header-search" autocomplete="off" spellcheck="false" class="w-full bg-surface-container-high border-none rounded-full py-2.5 pl-12 pr-6 text-on-surface placeholder:text-on-surface-variant focus:ring-1 focus:ring-primary transition-all font-body-md" placeholder="What do you want to play?" type="text">
          <div id="search-dropdown" class="hidden absolute left-0 right-0 top-[52px] rounded-2xl bg-surface-container-high border border-white/10 shadow-2xl py-2 z-50 max-h-[min(28rem,60vh)] overflow-y-auto"></div>
        </div>
        <div class="flex items-center gap-2 md:gap-4 md:ml-2 shrink-0">
          <div class="relative shrink-0">
            <button id="profile-chip" aria-label="Account" class="w-8 h-8 rounded-full bg-surface-container-high overflow-hidden border border-outline-variant flex items-center justify-center text-on-surface-variant hover:border-primary transition-colors"><span class="material-symbols-outlined text-[20px]">person</span></button>
            <div id="profile-menu" class="hidden absolute right-0 top-11 w-64 rounded-xl bg-surface-container-high border border-white/10 shadow-xl py-2 z-50">
              <div class="px-4 py-2 border-b border-white/10">
                <p id="profile-menu-name" class="text-body-md font-body-md text-on-surface font-bold truncate">Spotify account</p>
                <p id="profile-menu-email" class="text-label-sm font-label-sm text-on-surface-variant truncate"></p>
                <span id="profile-menu-plan" class="hidden mt-1.5 px-2 py-0.5 rounded-full text-label-sm font-label-sm bg-primary/15 text-primary"></span>
              </div>
              <button id="profile-logout" class="w-full flex items-center gap-2 px-4 py-2.5 text-label-md font-label-md text-on-surface hover:bg-white/5 text-left transition-colors">
                <span class="material-symbols-outlined text-[20px]">logout</span>Log out
              </button>
            </div>
          </div>
        </div>
      </div>
    </header>`;
  }

  // Simplified back header used by the focused capture page.
  function headerBackHTML() {
    return `
    <header id="app-header" class="fixed top-0 left-0 right-0 lg:left-[280px] flex justify-between items-center h-16 px-4 md:px-gutter z-20 glass-panel">
      <div class="flex items-center gap-2">
        <button data-nav="open-sidebar" aria-label="Open menu" class="lg:hidden w-10 h-10 rounded-full flex items-center justify-center text-on-surface-variant hover:bg-white/5 transition-colors"><span class="material-symbols-outlined">menu</span></button>
        <a data-nav="home" class="flex items-center gap-2 text-on-surface-variant hover:text-primary transition-colors group cursor-pointer">
          <span class="material-symbols-outlined text-[20px] group-hover:-translate-x-1 transition-transform">arrow_back</span>
          <span class="font-label-md text-label-md">Dashboard</span>
        </a>
      </div>
      <div class="w-10"></div>
    </header>`;
  }

  // ---- Bottom music player (idle shell; js/playback.js drives it) ----------
  // Rendered "Nothing playing" with the transport disabled; playback.js fills
  // it from Spotify Web Playback SDK state, wires the controls, and re-enables
  // them once a playback session exists. The waveform doubles as the seek bar
  // (playback.js lights the bars up to the playback position and maps clicks
  // back to a seek). Only the queue button is still a placeholder.
  function footerHTML() {
    const heights = [4, 6, 3, 8, 5, 7, 4, 6, 3, 5, 4, 6, 2, 5, 7, 4, 6, 3, 8, 5, 7, 4, 6, 3, 5, 4, 6, 2];
    const bars = heights.map(
      (h) => `<div data-bar class="w-1 h-${h} bg-white/20 rounded-full pointer-events-none"></div>`
    ).join("");

    return `
    <footer id="app-player" class="fixed bottom-0 left-0 right-0 w-full h-24 bg-surface-container/80 backdrop-blur-xl border-t border-white/10 z-20 flex items-center px-4 md:px-8 justify-between gap-4">
      <div class="flex items-center gap-3 md:gap-4 min-w-0 md:w-1/4">
        <div class="w-12 h-12 md:w-14 md:h-14 rounded-lg overflow-hidden shadow-lg bg-surface-container-high flex items-center justify-center shrink-0">
          <img id="player-cover" alt="" class="hidden w-full h-full object-cover">
          <span id="player-cover-fallback" class="material-symbols-outlined text-on-surface-variant">music_note</span>
        </div>
        <div class="flex flex-col min-w-0">
          <span id="player-title" class="text-on-surface font-bold font-headline-md text-body-md truncate">Nothing playing</span>
          <span id="player-artist" class="text-on-surface-variant text-label-sm truncate">Play a playlist to get started</span>
        </div>
      </div>
      <div class="flex items-center gap-4 md:gap-6 shrink-0">
        <button id="player-prev" disabled aria-label="Previous" class="text-on-surface-variant hover:text-primary transition-colors disabled:opacity-40"><span class="material-symbols-outlined">skip_previous</span></button>
        <button id="player-play" disabled aria-label="Play/Pause" class="w-12 h-12 rounded-full bg-primary text-on-primary flex items-center justify-center shadow-lg hover:scale-105 transition-transform disabled:opacity-40 disabled:hover:scale-100"><span class="material-symbols-outlined filled">play_arrow</span></button>
        <button id="player-next" disabled aria-label="Next" class="text-on-surface-variant hover:text-primary transition-colors disabled:opacity-40"><span class="material-symbols-outlined">skip_next</span></button>
      </div>
      <div class="hidden lg:flex items-center gap-4 flex-grow max-w-md mx-8">
        <div id="player-progress" class="flex gap-[2px] h-8 flex-grow items-center cursor-pointer">${bars}</div>
        <span id="player-time" class="text-on-surface-variant font-label-sm whitespace-nowrap">0:00 / 0:00</span>
      </div>
      <div class="hidden md:flex items-center gap-4 w-1/4 justify-end">
        <button id="player-shuffle" disabled aria-label="Shuffle" class="text-on-surface-variant hover:text-primary transition-colors disabled:opacity-40"><span class="material-symbols-outlined">shuffle</span></button>
        <button data-placeholder aria-label="Queue" class="text-on-surface-variant hover:text-primary transition-colors"><span class="material-symbols-outlined">queue_music</span></button>
        <div class="group flex items-center gap-2">
          <input id="player-volume" type="range" min="0" max="100" value="70" aria-label="Volume" class="hidden group-hover:block w-24 accent-primary cursor-pointer">
          <button id="player-mute" aria-label="Mute" class="text-on-surface-variant hover:text-primary transition-colors"><span class="material-symbols-outlined">volume_up</span></button>
        </div>
      </div>
    </footer>`;
  }

  function backdropHTML() {
    return `<div id="app-backdrop" class="hidden fixed inset-0 bg-black/60 z-30 lg:hidden"></div>`;
  }

  // ---- Inject --------------------------------------------------------------
  // Order matters only for equal z-index overlaps: the player (z-20) must paint
  // over the desktop sidebar (lg:z-20) in the bottom-left corner, so inject the
  // sidebar first and the player after it. The backdrop (z-30) sits above both
  // and below the open drawer (z-40) on mobile.
  const headerHTML = cfg.header === "back" ? headerBackHTML() : headerFullHTML();
  let markup = sidebarHTML() + headerHTML;
  if (showFooter) markup += footerHTML();
  markup += backdropHTML();

  const holder = document.createElement("div");
  holder.innerHTML = markup;
  while (holder.firstChild) document.body.appendChild(holder.firstChild);

  // ---- Drawer toggle (mobile) ---------------------------------------------
  const sidebar = document.getElementById("app-sidebar");
  const backdrop = document.getElementById("app-backdrop");

  function openSidebar() {
    sidebar.classList.remove("-translate-x-full");
    backdrop.classList.remove("hidden");
  }
  function closeSidebar() {
    sidebar.classList.add("-translate-x-full");
    backdrop.classList.add("hidden");
  }

  // ---- Navigation (event delegation) --------------------------------------
  document.addEventListener("click", (e) => {
    if (e.target.closest("#app-backdrop")) {
      closeSidebar();
      return;
    }
    const nav = e.target.closest("[data-nav]");
    if (nav) {
      switch (nav.dataset.nav) {
        case "home":          e.preventDefault(); window.location.assign("home.html"); break;
        case "scan":          e.preventDefault(); window.location.assign("photo.html"); break;
        case "back":          e.preventDefault(); window.history.back(); break;
        case "forward":       e.preventDefault(); window.history.forward(); break;
        case "open-sidebar":  e.preventDefault(); openSidebar(); break;
        case "close-sidebar": e.preventDefault(); closeSidebar(); break;
      }
      return;
    }
    // Placeholder controls: no backend yet — swallow the click so href="#"
    // doesn't jump the page, and close the drawer if it was a sidebar item.
    const placeholder = e.target.closest("[data-placeholder]");
    if (placeholder && placeholder.tagName !== "INPUT") {
      e.preventDefault();
      if (placeholder.closest("#app-sidebar")) closeSidebar();
    }
  });

  // Close the drawer if the window grows back to desktop width.
  window.addEventListener("resize", () => {
    if (window.innerWidth >= 1024) closeSidebar();
  });

  // ---- Profile chip + account dropdown -------------------------------------
  // The auth gate (Premium) / premium page (Free mode) stashed the Spotify
  // profile in sessionStorage; show its initial in the header circle and a
  // dropdown with the account details + logout. Absent profile (page opened
  // directly in dev) keeps the generic person icon; the dropdown still works.
  (function initProfileChip() {
    const chip = document.getElementById("profile-chip");
    const menu = document.getElementById("profile-menu");
    if (!chip || !menu) return; // photo page uses the "back" header (no chip)

    let profile = null;
    try {
      profile = JSON.parse(sessionStorage.getItem("spotify_profile") || "null");
    } catch {
      /* malformed stash: treat as absent */
    }

    if (profile && profile.display_name) {
      chip.textContent = profile.display_name.trim().charAt(0).toUpperCase();
      chip.classList.add("text-label-md", "font-bold", "text-primary");
      chip.title = profile.display_name;
      document.getElementById("profile-menu-name").textContent = profile.display_name;
    }
    if (profile && profile.email) {
      document.getElementById("profile-menu-email").textContent = profile.email;
    }
    if (profile) {
      const plan = document.getElementById("profile-menu-plan");
      plan.textContent = profile.premium ? "Premium account" : "Free account";
      plan.classList.remove("hidden");
      plan.classList.add("inline-block");
    }

    chip.addEventListener("click", (e) => {
      e.stopPropagation(); // keep the document click handler from closing it
      menu.classList.toggle("hidden");
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest("#profile-menu")) menu.classList.add("hidden");
    });

    document.getElementById("profile-logout").addEventListener("click", async () => {
      // Plain script (no module imports): call the bridge API directly — the
      // bridge is long ready by the time a user can click the header.
      try {
        await window.pywebview.api.logout();
      } catch (err) {
        console.error("logout failed:", err);
      }
      // Navigate to login regardless: even if the token delete failed, the
      // login page is safe and a fresh login overwrites the cache anyway.
      sessionStorage.removeItem("spotify_profile");
      window.location.replace("login.html");
    });
  })();

  // ---- Header elevation on scroll (was ui.js) -----------------------------
  window.addEventListener("scroll", () => {
    const header = document.getElementById("app-header");
    if (!header) return;
    if (window.scrollY > 20) {
      header.classList.add("shadow-md", "bg-background/95");
      header.classList.remove("bg-background/80");
    } else {
      header.classList.remove("shadow-md", "bg-background/95");
      header.classList.add("bg-background/80");
    }
  });
})();
