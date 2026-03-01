/* global localStorage */
(() => {
  const STORAGE_KEY = "av:savedFilters";

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
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch (error) {
      // ignore
    }
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
    form.submit();
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
    if (saveBtn) {
      saveBtn.addEventListener("click", () => {
        const filters = getFiltersFromForm();
        if (!filters) return;
        const hasValues = Object.values(filters).some((value) => value);
        if (!hasValues) return;
        const name = (nameInput && nameInput.value.trim()) || "Appointments filter";
        const item = {
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          name,
          filters,
          createdAt: new Date().toISOString()
        };
        save([item, ...load()]);
        if (nameInput) nameInput.value = "";
        render();
      });
    }

    render();
  });
})();
