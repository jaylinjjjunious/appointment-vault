(() => {
  const STORAGE_KEY = "av:savedFilters";
  const MAX_SAVED_FILTERS = 25;

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
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, MAX_SAVED_FILTERS)));
    } catch (error) {
      // ignore
    }
  };

  const getFeedbackNode = () => {
    const root = document.querySelector("[data-saved-filters]");
    if (!root) return null;
    let feedback = root.querySelector("[data-filter-feedback]");
    if (!feedback) {
      feedback = document.createElement("p");
      feedback.className = "section-empty";
      feedback.setAttribute("data-filter-feedback", "true");
      root.prepend(feedback);
    }
    return feedback;
  };

  const setFeedback = (message, isError = false) => {
    const feedback = getFeedbackNode();
    if (!feedback) return;
    feedback.textContent = message || "";
    feedback.classList.toggle("error-text", Boolean(isError && message));
    feedback.hidden = !message;
  };

  const areFiltersValid = (filters) => {
    if (!filters) return false;
    if (filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo) {
      setFeedback("From date must be before To date.", true);
      return false;
    }
    return true;
  };

  const render = () => {
    const root = document.querySelector("[data-saved-filters]");
    if (!root) return;
    const listEl = root.querySelector("[data-saved-filters-list]");
    const emptyEl = root.querySelector("[data-saved-filters-empty]");
    if (!listEl || !emptyEl) return;

    const items = load();
    if (items.length === 0) {
      listEl.innerHTML = "";
      emptyEl.hidden = false;
      return;
    }

    emptyEl.hidden = true;
    listEl.innerHTML = "";
    items.forEach((item) => {
      const row = document.createElement("div");
      row.className = "saved-filter-row";
      const name = document.createElement("span");
      name.textContent = item.name || "Saved filter";
      const applyBtn = document.createElement("button");
      applyBtn.type = "button";
      applyBtn.className = "button glass-button button-secondary";
      applyBtn.textContent = "Apply";
      applyBtn.addEventListener("click", () => applyFilter(item));

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "button glass-button button-danger";
      deleteBtn.textContent = "Delete";
      deleteBtn.addEventListener("click", () => deleteFilter(item.id));

      const actions = document.createElement("div");
      actions.className = "actions";
      actions.appendChild(applyBtn);
      actions.appendChild(deleteBtn);

      row.appendChild(name);
      row.appendChild(actions);
      listEl.appendChild(row);
    });
  };

  const applyFilter = (item) => {
    const form = document.querySelector("[data-filter-form]");
    if (!form) return;
    form.querySelector('[name="title"]').value = item.filters.title || "";
    form.querySelector('[name="dateFrom"]').value = item.filters.dateFrom || "";
    form.querySelector('[name="dateTo"]').value = item.filters.dateTo || "";
    const nextFilters = getFiltersFromForm();
    if (!areFiltersValid(nextFilters)) {
      return;
    }
    setFeedback(`Applied "${item.name || "Saved filter"}".`);
    if (window.location.pathname.startsWith("/appointments")) {
      history.replaceState(null, "", "#list");
    }
    form.requestSubmit();
  };

  const deleteFilter = (id) => {
    const items = load().filter((item) => item.id !== id);
    save(items);
    render();
  };

  const getFiltersFromForm = () => {
    const form = document.querySelector("[data-filter-form]");
    if (!form) return null;
    return {
      title: form.querySelector('[name="title"]').value.trim(),
      dateFrom: form.querySelector('[name="dateFrom"]').value.trim(),
      dateTo: form.querySelector('[name="dateTo"]').value.trim()
    };
  };

  document.addEventListener("DOMContentLoaded", () => {
    const saveBtn = document.querySelector("[data-save-filter]");
    const nameInput = document.querySelector("[data-filter-name]");
    const form = document.querySelector("[data-filter-form]");
    form?.addEventListener("submit", (event) => {
      const filters = getFiltersFromForm();
      if (!areFiltersValid(filters)) {
        event.preventDefault();
        return;
      }
      setFeedback("");
    });

    if (saveBtn) {
      saveBtn.addEventListener("click", () => {
        const filters = getFiltersFromForm();
        if (!filters) return;
        if (!areFiltersValid(filters)) return;
        const hasValues = Object.values(filters).some((value) => value);
        if (!hasValues) {
          setFeedback("Enter at least one filter value before saving.", true);
          return;
        }
        const name = (nameInput && nameInput.value.trim()) || "Appointments filter";
        const existing = load();
        const duplicate = existing.find(
          (item) =>
            item.name === name &&
            JSON.stringify(item.filters || {}) === JSON.stringify(filters)
        );
        if (duplicate) {
          setFeedback("That filter is already saved.");
          return;
        }
        const item = {
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          name,
          filters,
          createdAt: new Date().toISOString()
        };
        save([item, ...existing]);
        if (nameInput) nameInput.value = "";
        setFeedback(`Saved "${name}".`);
        render();
      });
    }

    render();
  });
})();
