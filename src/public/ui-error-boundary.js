(() => {
  const existing = document.getElementById("clientErrorBanner");
  if (existing) return;

  const banner = document.createElement("div");
  banner.id = "clientErrorBanner";
  banner.className = "client-error-banner";
  banner.innerHTML = `
    <div class="client-error-banner__content">
      <strong>Something went wrong.</strong>
      <span>Try refreshing the page.</span>
    </div>
    <div class="client-error-banner__actions">
      <button type="button" class="button glass-button button-secondary" id="clientErrorReload">Reload</button>
      <button type="button" class="button glass-button button-secondary" id="clientErrorDismiss">Dismiss</button>
    </div>
  `;

  const show = () => {
    if (!banner.isConnected) {
      document.body.appendChild(banner);
    }
    banner.classList.add("show");
  };

  const logClientError = (message) => {
    if (window.AppointmentVaultActivity?.log) {
      window.AppointmentVaultActivity.log({
        type: "client_error",
        title: "Client error",
        detail: String(message || "Unknown error")
      });
    }
  };

  window.addEventListener("error", (event) => {
    show();
    logClientError(event.message);
  });

  window.addEventListener("unhandledrejection", (event) => {
    show();
    logClientError(event.reason?.message || "Unhandled promise rejection");
  });

  document.addEventListener("click", (event) => {
    if (event.target?.id === "clientErrorReload") {
      window.location.reload();
    }
    if (event.target?.id === "clientErrorDismiss") {
      banner.classList.remove("show");
    }
  });
})();
