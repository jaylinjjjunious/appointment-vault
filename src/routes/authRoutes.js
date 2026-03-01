const express = require("express");
const csurf = require("csurf");
const { registerSchema, loginSchema } = require("../validation/authSchemas");
const { registerLocalUser, authenticateLocalUser } = require("../services/authService");

const router = express.Router();
const csrfProtection = csurf();

function renderAuthPage(res, view, model = {}) {
  return res.render(view, {
    title: model.title,
    error: model.error || "",
    values: model.values || {},
    csrfToken: model.csrfToken || ""
  });
}

router.get("/login", csrfProtection, (req, res) => {
  if (req.currentUser) {
    res.redirect("/");
    return;
  }
  renderAuthPage(res, "auth/login", {
    title: "Sign In",
    csrfToken: req.csrfToken()
  });
});

router.post("/login", csrfProtection, async (req, res, next) => {
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

    req.session.userId = user.id;
    req.session.authProvider = "local";
    res.redirect("/");
  } catch (error) {
    next(error);
  }
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

router.post("/register", csrfProtection, async (req, res, next) => {
  try {
    const parsed = registerSchema.safeParse(req.body || {});
    if (!parsed.success) {
      renderAuthPage(res.status(400), "auth/register", {
        title: "Create Account",
        error: "Please enter a valid email and a password of at least 8 characters.",
        values: {
          email: String(req.body?.email || ""),
          displayName: String(req.body?.displayName || "")
        },
        csrfToken: req.csrfToken()
      });
      return;
    }

    const user = await registerLocalUser(parsed.data);
    req.session.userId = user.id;
    req.session.authProvider = "local";
    res.redirect("/");
  } catch (error) {
    renderAuthPage(res.status(error.statusCode || 400), "auth/register", {
      title: "Create Account",
      error: error.publicMessage || error.message || "Unable to create account.",
      values: {
        email: String(req.body?.email || ""),
        displayName: String(req.body?.displayName || "")
      },
      csrfToken: req.csrfToken ? req.csrfToken() : ""
    });
  }
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/auth/login");
  });
});

module.exports = router;