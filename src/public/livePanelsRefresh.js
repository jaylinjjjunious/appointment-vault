(() => {
  const normalizedPath = window.location.pathname.replace(/\/+$/, "") || "/";
  const enabledPaths = new Set(["/", "/settings"]);

  if (!enabledPaths.has(normalizedPath)) {
    return;
  }

  let lastKey = getMinuteKey(new Date());

  function getMinuteKey(date) {
    return [
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      date.getHours(),
      date.getMinutes()
    ].join("-");
  }

  function maybeRefresh() {
    if (document.visibilityState !== "visible") {
      return;
    }

    const currentKey = getMinuteKey(new Date());
    if (currentKey !== lastKey) {
      window.location.reload();
    }
  }

  setInterval(maybeRefresh, 15000);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      maybeRefresh();
    }
  });
})();
