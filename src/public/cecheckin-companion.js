(function () {
  if (window.__avCeCheckInCompanionLoaded) {
    return;
  }
  window.__avCeCheckInCompanionLoaded = true;

  const READINESS_TIMEOUT_MS = 120000;
  const PHOTO_POLL_MS = 1200;

  const readLaunchParams = () => {
    const sources = [window.location.hash.replace(/^#/, ""), window.location.search.replace(/^\?/, "")];
    for (const source of sources) {
      const params = new URLSearchParams(source);
      const token = String(params.get("avHandoffToken") || "").trim();
      const appOrigin = String(params.get("avAppOrigin") || "").trim().replace(/\/+$/, "");
      if (token && appOrigin) {
        return { token, appOrigin };
      }
    }
    return null;
  };

  const launch = readLaunchParams();
  if (!launch) {
    return;
  }

  const normalize = (value) =>
    String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

  const createOverlay = () => {
    const existing = document.getElementById("av-ce-helper");
    if (existing) {
      return existing;
    }
    const wrap = document.createElement("div");
    wrap.id = "av-ce-helper";
    wrap.style.cssText = [
      "position:fixed",
      "right:12px",
      "bottom:12px",
      "z-index:999999",
      "max-width:min(88vw,320px)",
      "padding:12px 14px",
      "border-radius:16px",
      "background:rgba(15,17,23,0.94)",
      "color:#fff",
      "font:13px/1.45 system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      "box-shadow:0 18px 40px rgba(0,0,0,0.28)"
    ].join(";");
    wrap.innerHTML = '<strong style="display:block;margin-bottom:6px;">Appointment Vault Helper</strong><div data-av-helper-status>Starting…</div>';
    document.body.appendChild(wrap);
    return wrap;
  };

  const overlay = createOverlay();
  const statusEl = overlay.querySelector("[data-av-helper-status]");
  const setStatus = (message, isError) => {
    if (!statusEl) {
      return;
    }
    statusEl.textContent = String(message || "");
    statusEl.style.color = isError ? "#ff9ca3" : "#fff";
  };

  const fetchCheckpoint = async () => {
    const response = await fetch(
      `${launch.appOrigin}/automation/photo-handoff/state?token=${encodeURIComponent(launch.token)}`,
      {
        method: "GET",
        credentials: "omit",
        headers: {
          Accept: "application/json"
        }
      }
    );
    if (!response.ok) {
      throw new Error(`Checkpoint request failed (${response.status})`);
    }
    const payload = await response.json();
    if (!payload?.ok || !payload.handoff) {
      throw new Error("Photo handoff payload was empty.");
    }
    return payload.handoff;
  };

  const waitFor = async (fn, label) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < READINESS_TIMEOUT_MS) {
      const value = fn();
      if (value) {
        return value;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 400));
    }
    throw new Error(`Timed out waiting for ${label}.`);
  };

  const fillContact = async (contact) => {
    if (!contact || !contact.line1) {
      return;
    }
    const addressRow = Array.from(document.querySelectorAll(".contact-information .row")).find((row) =>
      normalize(row.textContent).includes("mailing address")
    );
    if (addressRow) {
      addressRow.click();
      await waitFor(() => document.querySelector("#line1"), "mailing address modal");
    }
    const line1 = document.querySelector("#line1");
    if (!line1) {
      return;
    }
    const line2 = document.querySelector("#line2");
    const city = document.querySelector("#city");
    const state = document.querySelector("#ddlstate");
    const zip = document.querySelector("#zip");
    line1.value = contact.line1 || "";
    line1.dispatchEvent(new Event("input", { bubbles: true }));
    if (line2) {
      line2.value = contact.line2 || "";
      line2.dispatchEvent(new Event("input", { bubbles: true }));
    }
    if (city) {
      city.value = contact.city || "";
      city.dispatchEvent(new Event("input", { bubbles: true }));
    }
    if (state && contact.state) {
      state.value = contact.state;
      state.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (zip) {
      zip.value = contact.zip || "";
      zip.dispatchEvent(new Event("input", { bubbles: true }));
      zip.dispatchEvent(new Event("keyup", { bubbles: true }));
    }
    const doneButton = Array.from(document.querySelectorAll(".modal .btn.btn-primary")).find((button) =>
      normalize(button.textContent) === "done"
    );
    doneButton?.click();
    await new Promise((resolve) => window.setTimeout(resolve, 400));
  };

  const fillQuestionnaire = async (answers) => {
    const items = Array.from(document.querySelectorAll("li"));
    const questionItems = items
      .map((item) => ({
        item,
        textNode: item.querySelector(".question-text")
      }))
      .filter((entry) => entry.textNode);

    for (const entry of questionItems) {
      const questionText = normalize(entry.textNode.textContent);
      const answer = normalize(answers[questionText]);
      if (!answer) {
        continue;
      }
      const answerLabel = answer === "yes" ? "yes" : "no";
      const button = Array.from(entry.item.querySelectorAll("button")).find(
        (candidate) => normalize(candidate.textContent) === answerLabel
      );
      button?.click();
      await new Promise((resolve) => window.setTimeout(resolve, 80));
    }
  };

  const clickTakePhoto = () => {
    const button = Array.from(document.querySelectorAll("button")).find((candidate) =>
      normalize(candidate.textContent).includes("take a photo")
    );
    button?.click();
    return Boolean(button);
  };

  const hasCapturedPhoto = () => {
    const preview = document.querySelector("#importPhoto");
    const src = String(preview?.getAttribute("src") || preview?.src || "");
    return Boolean(src) && !src.includes("silhouette.png");
  };

  const clickCheckIn = () => {
    const button = document.querySelector(".btn.btn-primary.btn-checkin");
    button?.click();
    return Boolean(button);
  };

  const acknowledgeCompletion = async () => {
    try {
      await fetch(
        `${launch.appOrigin}/automation/photo-handoff/complete?token=${encodeURIComponent(launch.token)}`,
        { method: "GET", credentials: "omit", headers: { Accept: "application/json" } }
      );
    } catch (error) {
      // best-effort sync back to Appointment Vault
    }
  };

  const watchForPhotoCompletion = () => {
    const finishIfReady = async () => {
      if (!hasCapturedPhoto()) {
        return false;
      }
      setStatus("Photo captured. Completing check-in…");
      if (clickCheckIn()) {
        await acknowledgeCompletion();
        setStatus("Check-in submitted. You can return to Appointment Vault.");
        return true;
      }
      return false;
    };

    const timer = window.setInterval(async () => {
      const done = await finishIfReady();
      if (done) {
        window.clearInterval(timer);
      }
    }, PHOTO_POLL_MS);
  };

  const run = async () => {
    setStatus("Loading handoff from Appointment Vault…");
    const handoff = await fetchCheckpoint();
    const state = handoff.state || {};
    const payload = state.payload || {};
    const currentUrl = new URL(window.location.href);
    const resumeUrl = String(handoff.resumeUrl || state.resumeUrl || "");
    if (resumeUrl && currentUrl.pathname !== new URL(resumeUrl).pathname) {
      setStatus("Opening the exact photo step…");
      window.location.href = `${resumeUrl}${window.location.hash || ""}`;
      return;
    }

    setStatus("Waiting for CE Check-In report…");
    await waitFor(() => document.querySelector("#client-report .question-text"), "CE Check-In questionnaire");

    if (payload.updateMailingAddress) {
      setStatus("Replaying mailing address…");
      await fillContact(payload.contact || {});
    }

    setStatus("Replaying saved answers…");
    const answers = Object.entries(payload.questionnaireAnswers || {}).reduce((acc, [key, value]) => {
      acc[normalize(key)] = value;
      return acc;
    }, {});
    await fillQuestionnaire(answers);

    setStatus("Ready for your photo. Opening the camera step…");
    clickTakePhoto();
    watchForPhotoCompletion();
  };

  run().catch((error) => {
    console.error("[av-ce-helper]", error);
    setStatus(error?.message || "Unable to continue the assisted photo handoff.", true);
  });
})();
