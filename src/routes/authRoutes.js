const express = require("express");
const csurf = require("csurf");
const rateLimit = require("express-rate-limit");
const { registerSchema, loginSchema } = require("../validation/authSchemas");
const { registerLocalUser, authenticateLocalUser } = require("../services/authService");

const router = express.Router();
const csrfProtection = csurf();
const TEST_PROFILE_ENABLED = ["1", "true", "yes", "on"].includes(
  String(process.env.TEMP_TEST_PROFILE || process.env.TEST_PROFILE_ENABLED || "")
    .trim()
    .toLowerCase()
);
const TEST_PROFILE_NAME =
  String(process.env.TEST_PROFILE_NAME || "").trim() || "Temporary Test Profile";
const TEST_PROFILE_EMAIL =
  String(process.env.TEST_PROFILE_EMAIL || "").trim() || "test-profile@appointment-vault.local";

function buildAuthDebugSnapshot(req, res) {
  return {
    method: req.method || "",
    path: req.path || "",
    sessionId: req.sessionID || null,
    sessionUserId: req.session?.userId || null,
    currentUserId: req.currentUser?.id || null,
    cookieHeader: String(req.headers.cookie || ""),
    secure: Boolean(req.secure),
    protocol: String(req.protocol || ""),
    xForwardedProto: String(req.get("x-forwarded-proto") || ""),
    setCookieHeader: res?.getHeader ? res.getHeader("set-cookie") || null : null
  };
}

function authRateLimitHandler(req, res, message = "Too many attempts. Please try again later.") {
  const acceptsHtml = String(req.get("accept") || "").includes("text/html");
  if (!acceptsHtml) {
    res.status(429).json({ ok: false, message });
    return;
  }
  const view = req.path.includes("register") ? "auth/register" : "auth/login";
  const title = view === "auth/register" ? "Create Account" : "Sign In";
  renderAuthPage(res.status(429), view, {
    title,
    error: message,
    values: {
      email: String(req.body?.email || ""),
      displayName: String(req.body?.displayName || "")
    },
    csrfToken: ""
  });
}

const loginIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: (req, res) =>
    authRateLimitHandler(req, res, "Too many login attempts from this network. Please wait 15 minutes.")
});

const loginEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    return `${req.ip}:${email || "unknown"}`;
  },
  handler: (req, res) =>
    authRateLimitHandler(req, res, "Too many login attempts for this account. Please wait 15 minutes.")
});

const registerLimiter = rateLimit({
  windowMs: 30 * 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) =>
    authRateLimitHandler(req, res, "Too many registration attempts. Please wait before trying again.")
});

function ensureSameOrigin(req, res, next) {
  const origin = String(req.get("origin") || "").trim();
  const referer = String(req.get("referer") || "").trim();
  const host = String(req.get("host") || "").trim().toLowerCase();
  const headerToCheck = origin || referer;
  if (!headerToCheck) {
    res.status(403).send("Forbidden");
    return;
  }
  try {
    const parsed = new URL(headerToCheck);
    if (String(parsed.host || "").toLowerCase() !== host) {
      res.status(403).send("Forbidden");
      return;
    }
  } catch (error) {
    res.status(403).send("Forbidden");
    return;
  }
  next();
}

function createSessionForUser(req, user, provider, callback) {
  req.session.regenerate((error) => {
    if (error) {
      callback(error);
      return;
    }
    req.session.userId = user.id;
    req.session.authProvider = provider;
    req.session.authenticatedAt = new Date().toISOString();
    req.session.save(callback);
  });
}

function createSessionForUserAsync(req, user, provider) {
  return new Promise((resolve, reject) => {
    createSessionForUser(req, user, provider, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function renderAuthPage(res, view, model = {}) {
  return res.render(view, {
    title: model.title,
    error: model.error || "",
    values: model.values || {},
    csrfToken: model.csrfToken || "",
    testProfileEnabled: TEST_PROFILE_ENABLED
  });
}

router.get("/login", csrfProtection, (req, res) => {
  if (req.currentUser) {
    res.redirect("/");
    return;
  }
  const googleStatus = String(req.query.google || "").trim();
  if (googleStatus === "auth_error") {
    renderAuthPage(res, "auth/login", {
      title: "Sign In",
      error: "Google sign-in failed. Please try again.",
      csrfToken: req.csrfToken()
    });
    return;
  }
  renderAuthPage(res, "auth/login", {
    title: "Sign In",
    csrfToken: req.csrfToken()
  });
});

router.get("/register", csrfProtection, (req, res) => {
  if (req.currentUser) {
    res.redirect("/");
    return;
  }
  renderAuthPage(res, "auth/register", {
    title: "Create Account",
    csrfToken: req.csrfToken()
  });
});

router.post("/login", loginIpLimiter, loginEmailLimiter, csrfProtection, async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body || {});
    if (!parsed.success) {
      renderAuthPage(res.status(400), "auth/login", {
        title: "Sign In",
        error: "Enter a valid email and password.",
        values: { email: String(req.body?.email || "") },
        csrfToken: req.csrfToken()
      });
      return;
    }

    const user = await authenticateLocalUser(parsed.data.email, parsed.data.password);
    if (!user) {
      renderAuthPage(res.status(401), "auth/login", {
        title: "Sign In",
        error: "Invalid email or password.",
        values: { email: parsed.data.email },
        csrfToken: req.csrfToken()
      });
      return;
    }

    await createSessionForUserAsync(req, user, "local");
    console.log("[auth-local] login success snapshot:", buildAuthDebugSnapshot(req, res));
    res.redirect("/");
  } catch (error) {
    next(error);
  }
});

router.post("/register", registerLimiter, csrfProtection, async (req, res, next) => {
  try {
    const parsed = registerSchema.safeParse(req.body || {});
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message || "Enter a valid email and password.";
      renderAuthPage(res.status(400), "auth/register", {
        title: "Create Account",
        error: firstIssue,
        values: {
          email: String(req.body?.email || ""),
          displayName: String(req.body?.displayName || "")
        },
        csrfToken: req.csrfToken()
      });
      return;
    }

    const user = await registerLocalUser(parsed.data);
    await createSessionForUserAsync(req, user, "local");
    res.redirect("/");
  } catch (error) {
    if (error?.publicMessage || error?.message) {
      renderAuthPage(res.status(error?.statusCode || 400), "auth/register", {
        title: "Create Account",
        error: error.publicMessage || error.message,
        values: {
          email: String(req.body?.email || ""),
          displayName: String(req.body?.displayName || "")
        },
        csrfToken: req.csrfToken ? req.csrfToken() : ""
      });
      return;
    }
    next(error);
  }
});

router.post("/bypass", csrfProtection, (req, res, next) => {
  if (!TEST_PROFILE_ENABLED) {
    res.status(404).render("404", { title: "Not Found" });
    return;
  }

  req.session.regenerate((error) => {
    if (error) {
      next(error);
      return;
    }
    req.session.testProfile = {
      name: TEST_PROFILE_NAME,
      email: TEST_PROFILE_EMAIL,
      role: "tester"
    };
    req.session.authProvider = "test";
    req.session.authenticatedAt = new Date().toISOString();
    req.session.save((saveError) => {
      if (saveError) {
        next(saveError);
        return;
      }
      res.redirect("/dashboard");
    });
  });
});

router.post("/logout", ensureSameOrigin, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.clearCookie("av.sid");
    res.clearCookie("__Host-av.sid", { path: "/" });
    res.redirect("/auth/login");
  });
});

router.use((error, req, res, next) => {
  if (error?.code !== "EBADCSRFTOKEN") {
    next(error);
    return;
  }
  const view = req.path.includes("register") ? "auth/register" : "auth/login";
  const title = view === "auth/register" ? "Create Account" : "Sign In";
  const values = {
    email: String(req.body?.email || ""),
    displayName: String(req.body?.displayName || "")
  };
  renderAuthPage(res.status(403), view, {
    title,
    error: "Your form expired. Please try again.",
    values,
    csrfToken: req.csrfToken ? req.csrfToken() : ""
  });
});

module.exports = router;
