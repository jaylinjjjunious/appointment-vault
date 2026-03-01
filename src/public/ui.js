/* global localStorage */
(() => {
  const root = document.documentElement;
  const savedTheme = localStorage.getItem("vault-theme");
  const prefersLight =
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: light)").matches;
  const initialTheme = savedTheme || (prefersLight ? "light" : "vaultDark");

  root.setAttribute("data-theme", initialTheme);

  const toggle = document.querySelector("[data-theme-toggle]");
  if (toggle) {
    const setIcon = (theme) => {
      toggle.setAttribute("aria-pressed", theme !== "vaultDark");
      toggle.dataset.theme = theme;
    };

    setIcon(initialTheme);

    toggle.addEventListener("click", () => {
      const next = root.getAttribute("data-theme") === "vaultDark" ? "light" : "vaultDark";
      root.setAttribute("data-theme", next);
      localStorage.setItem("vault-theme", next);
      setIcon(next);
    });
  }

  const path = String(window.location.pathname || "/").toLowerCase();
  let active = "dashboard";
  if (path === "/calendar" || path.startsWith("/calendar/")) {
    active = "calendar";
  } else if (path === "/checkin" || path.startsWith("/checkin/")) {
    active = "checkin";
  } else if (path.startsWith("/settings/history")) {
    active = "history";
  } else if (path === "/settings" || path.startsWith("/settings/")) {
    active = "settings";
  } else if (path === "/appointments" || path.startsWith("/appointments/")) {
    active = "new";
  } else if (path === "/" || path.startsWith("/dashboard")) {
    active = "dashboard";
  }

  document.querySelectorAll("[data-nav-key]").forEach((link) => {
    const key = String(link.getAttribute("data-nav-key") || "");
    const isActive = key === active;
    link.classList.toggle("nav-pill-active", isActive);
    if (isActive) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  });

  document.body.addEventListener("htmx:afterSwap", (event) => {
    const target = event.target;
    if (target && target.classList) {
      target.classList.add("fade-in");
      setTimeout(() => target.classList.remove("fade-in"), 600);
    }
  });

  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll("[data-skeleton]").forEach((el) => {
      el.hidden = true;
    });
  });
})();
