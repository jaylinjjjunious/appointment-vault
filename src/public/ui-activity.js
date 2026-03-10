(() => {
  const STORAGE_KEY = "av:recentActivity";
  const MAX_ITEMS = 20;
  const REMINDER_PAGE_SIZE = 40;

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

  const formatRelative = (ts) => {
    const value = new Date(ts).getTime();
    if (!Number.isFinite(value)) return "";
    const diffMs = Date.now() - value;
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (diffMs < minute) return "just now";
    if (diffMs < hour) return `${Math.max(1, Math.round(diffMs / minute))} min ago`;
    if (diffMs < day) return `${Math.max(1, Math.round(diffMs / hour))} hr ago`;
    return `${Math.max(1, Math.round(diffMs / day))} day ago`;
  };

  const escapeHtml = (value) =>
    String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");

  const buildItemHtml = (item) => {
    const detail = item.detail ? `<p>${escapeHtml(item.detail)}</p>` : "";
    const timeLabel = item.time
      ? `<p class="section-empty"><strong>When:</strong> ${escapeHtml(
        formatTime(item.time)
      )} · ${escapeHtml(formatRelative(item.time))}</p>`
      : "";
    return `
      <article class="card glass-card appointment-card">
        <div class="appointment-main">
          <h3><strong>${escapeHtml(item.title || "Activity")}</strong></h3>
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

  const ensureReminderStatusNode = (root) => {
    let node = root.querySelector("[data-reminder-status]");
    if (!node) {
      node = document.createElement("p");
      node.className = "section-empty";
      node.setAttribute("data-reminder-status", "true");
      root.appendChild(node);
    }
    return node;
  };

  const renderReminderActivity = (root, items) => {
    const list = root.querySelector(".list");
    const empty = root.querySelector(".section-empty");
    if (!items || items.length === 0) {
      if (list) list.remove();
      if (empty) {
        empty.textContent = "No reminder activity yet.";
      }
      return;
    }
    if (empty) {
      empty.textContent = "";
    }
    const listEl = list || document.createElement("div");
    listEl.className = "list";
    listEl.innerHTML = items
      .map(
        (item) => `
          <article class="card glass-card appointment-card">
            <div class="appointment-main">
              <p><strong>Channel:</strong> ${escapeHtml(item.channel || "")}</p>
              <p><strong>Status:</strong> ${escapeHtml(item.status || "")}</p>
              <p><strong>Attempt #:</strong> ${escapeHtml(item.attemptNumber || "")}</p>
              <p><strong>Scheduled:</strong> ${escapeHtml(formatTime(item.scheduledFor))}</p>
              ${item.providerSid ? `<p><strong>Provider SID:</strong> ${escapeHtml(item.providerSid)}</p>` : ""}
              ${item.errorMessage ? `<p class="error-text"><strong>Error:</strong> ${escapeHtml(item.errorMessage)}</p>` : ""}
            </div>
          </article>
        `
      )
      .join("");
    if (!list) {
      root.appendChild(listEl);
    }
  };

  const bindReminderHistory = () => {
    const panel = document.getElementById("activity");
    if (!panel) return;
    const form = panel.querySelector('form[action="/settings"]');
    if (!form) return;
    const statusNode = ensureReminderStatusNode(panel);
    const submit = async () => {
      const params = new URLSearchParams(new FormData(form));
      params.set("pageSize", String(REMINDER_PAGE_SIZE));
      statusNode.textContent = "Loading reminder activity...";
      statusNode.classList.remove("error-text");
      statusNode.hidden = false;
      try {
        const response = await fetch(`/api/reminders/activity?${params.toString()}`, {
          credentials: "same-origin"
        });
        if (!response.ok) {
          throw new Error("Request failed");
        }
        const payload = await response.json();
        renderReminderActivity(panel, Array.isArray(payload.items) ? payload.items : []);
        statusNode.textContent = "";
        statusNode.hidden = true;
      } catch (error) {
        statusNode.textContent = "Could not load reminder activity. Please try again.";
        statusNode.classList.add("error-text");
      }
    };
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      submit();
    });
    form
      .querySelectorAll("select")
      .forEach((select) => select.addEventListener("change", () => form.requestSubmit()));
  };

  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll("[data-activity]").forEach((el) => {
      const eventType = el.tagName === "FORM" ? "submit" : "click";
      el.addEventListener(eventType, () => {
        if (el.tagName === "FORM" && !el.checkValidity()) {
          return;
        }
        const title = el.getAttribute("data-activity-title") || "Activity";
        const type = el.getAttribute("data-activity") || "action";
        const detail = extractDetail(el);
        logActivity({ type, title, detail });
      });
    });

    render();
    bindReminderHistory();
  });

  window.AppointmentVaultActivity = {
    log: logActivity,
    render
  };
})();
