/* global localStorage */
(() => {
  const STORAGE_KEY = "av:recentActivity";
  const MAX_ITEMS = 20;

  const safeParse = (raw) => {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  };

  const load = () => {
    try {
      return safeParse(localStorage.getItem(STORAGE_KEY));
    } catch (error) {
      return [];
    }
  };

  const save = (items) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, MAX_ITEMS)));
    } catch (error) {
      // ignore storage failures
    }
  };

  const formatTime = (ts) => {
    try {
      return new Date(ts).toLocaleString();
    } catch (error) {
      return "";
    }
  };

  const buildItemHtml = (item) => {
    const detail = item.detail ? `<p>${item.detail}</p>` : "";
    const timeLabel = item.time ? `<p class="section-empty"><strong>When:</strong> ${formatTime(item.time)}</p>` : "";
    return `
      <article class="card glass-card appointment-card">
        <div class="appointment-main">
          <h3><strong>${item.title || "Activity"}</strong></h3>
          ${detail}
          ${timeLabel}
        </div>
      </article>
    `;
  };

  const render = () => {
    const root = document.querySelector("[data-activity-root]");
    if (!root) return;
    const listEl = root.querySelector("[data-activity-list]");
    const emptyEl = root.querySelector("[data-activity-empty]");
    const skeleton = root.querySelector("[data-skeleton]");
    const items = load();

    if (skeleton) skeleton.hidden = true;

    if (!listEl || !emptyEl) return;
    if (items.length === 0) {
      listEl.hidden = true;
      emptyEl.hidden = false;
      return;
    }

    listEl.innerHTML = items.map(buildItemHtml).join("");
    listEl.hidden = false;
    emptyEl.hidden = true;
  };

  const extractDetail = (el) => {
    const explicit = el.getAttribute("data-activity-detail");
    if (explicit) return explicit;
    const field = el.getAttribute("data-activity-field");
    if (!field) return "";
    const input = el.querySelector(`[name="${field}"]`);
    return input ? String(input.value || "").trim() : "";
  };

  const logActivity = (payload) => {
    const next = {
      id: payload.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      type: payload.type || "action",
      title: payload.title || "Activity",
      detail: payload.detail || "",
      time: payload.time || Date.now()
    };
    const items = [next, ...load()].slice(0, MAX_ITEMS);
    save(items);
    render();
  };

  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll("[data-activity]").forEach((el) => {
      const eventType = el.tagName === "FORM" ? "submit" : "click";
      el.addEventListener(eventType, () => {
        const title = el.getAttribute("data-activity-title") || "Activity";
        const type = el.getAttribute("data-activity") || "action";
        const detail = extractDetail(el);
        logActivity({ type, title, detail });
      });
    });

    render();
  });

  window.AppointmentVaultActivity = {
    log: logActivity,
    render
  };
})();
