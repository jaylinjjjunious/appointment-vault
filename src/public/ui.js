(() => {
  const createStatusMessage = (form) => {
    let el = form.querySelector("[data-form-status]");
    if (!el) {
      el = document.createElement("p");
      el.className = "section-empty";
      el.setAttribute("data-form-status", "true");
      form.appendChild(el);
    }
    return el;
  };

  const setFormStatus = (form, message, isError = false) => {
    const status = createStatusMessage(form);
    status.textContent = message || "";
    status.classList.toggle("error-text", Boolean(isError && message));
    status.hidden = !message;
  };

  const clearFieldError = (field) => {
    field?.setAttribute("aria-invalid", "false");
    const wrap = field?.closest(".form-field");
    const error = wrap?.querySelector("[data-field-error]");
    if (error) {
      error.remove();
    }
  };

  const showFieldError = (field, message) => {
    if (!field) return;
    field.setAttribute("aria-invalid", "true");
    const wrap = field.closest(".form-field");
    if (!wrap) return;
    let error = wrap.querySelector("[data-field-error]");
    if (!error) {
      error = document.createElement("p");
      error.className = "field-error";
      error.setAttribute("data-field-error", "true");
      wrap.appendChild(error);
    }
    error.textContent = message;
  };

  const parseServerError = async (response) => {
    try {
      const text = await response.text();
      if (!text) return "";
      const parser = new DOMParser();
      const doc = parser.parseFromString(text, "text/html");
      const firstFieldError = doc.querySelector(".field-error");
      if (firstFieldError?.textContent) {
        return firstFieldError.textContent.trim();
      }
      const heading = doc.querySelector("h1");
      if (heading?.textContent) {
        return heading.textContent.trim();
      }
      return "";
    } catch (error) {
      return "";
    }
  };

  const setSubmitLoading = (form, active, pendingText = "Saving...") => {
    const submit = form.querySelector('button[type="submit"]');
    if (!submit) return;
    if (!submit.dataset.originalText) {
      submit.dataset.originalText = submit.textContent || "Submit";
    }
    submit.disabled = active;
    submit.textContent = active ? pendingText : submit.dataset.originalText;
    form.dataset.submitting = active ? "1" : "0";
  };

  const bindAppointmentForm = () => {
    const form = document.querySelector('form[action^="/appointments"]');
    if (!form || String(form.method || "").toUpperCase() !== "POST") return;

    const titleField = form.querySelector('[name="title"]');
    const dateField = form.querySelector('[name="date"]');
    const timeField = form.querySelector('[name="time"]');
    const recurringField = form.querySelector('[name="isRecurring"]');
    const rruleField = form.querySelector('[name="rrule"]');

    [titleField, dateField, timeField, rruleField].forEach((field) => {
      field?.addEventListener("input", () => clearFieldError(field));
    });
    recurringField?.addEventListener("change", () => clearFieldError(rruleField));

    const validate = () => {
      let ok = true;
      const title = String(titleField?.value || "").trim();
      const date = String(dateField?.value || "").trim();
      const time = String(timeField?.value || "").trim();
      const isRecurring = Boolean(recurringField?.checked);
      const rrule = String(rruleField?.value || "").trim();
      clearFieldError(titleField);
      clearFieldError(dateField);
      clearFieldError(timeField);
      clearFieldError(rruleField);

      if (!title) {
        showFieldError(titleField, "Title is required.");
        ok = false;
      }
      if (!date) {
        showFieldError(dateField, "Date is required.");
        ok = false;
      }
      if (!time) {
        showFieldError(timeField, "Time is required.");
        ok = false;
      }
      if (isRecurring && !rrule) {
        showFieldError(rruleField, "Recurring appointments require an RRULE.");
        ok = false;
      }
      return ok;
    };

    form.addEventListener("submit", async (event) => {
      if (form.dataset.submitting === "1") {
        event.preventDefault();
        return;
      }
      if (!validate()) {
        event.preventDefault();
        setFormStatus(form, "Please fix the highlighted fields.", true);
        return;
      }

      event.preventDefault();
      setFormStatus(form, "");
      setSubmitLoading(form, true, "Saving...");
      try {
        const response = await fetch(form.action, {
          method: "POST",
          body: new FormData(form),
          credentials: "same-origin"
        });
        if (response.redirected && response.url) {
          window.location.assign(response.url);
          return;
        }
        if (!response.ok) {
          const serverMessage = await parseServerError(response);
          setFormStatus(
            form,
            serverMessage || "Unable to save right now. Please review your fields and try again.",
            true
          );
          return;
        }
        window.location.assign("/dashboard");
      } catch (error) {
        setFormStatus(form, "Network error while saving. Please try again.", true);
      } finally {
        setSubmitLoading(form, false);
      }
    });
  };

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
    bindAppointmentForm();
  });
})();
