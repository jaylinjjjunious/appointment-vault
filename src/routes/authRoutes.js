const express = require("express");

const router = express.Router();

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

router.get("/login", (req, res) => {
  res.redirect("/settings");
});

router.post("/login", (req, res) => {
  res.redirect("/settings");
});

router.get("/register", (req, res) => {
  res.redirect("/settings");
});

router.post("/register", (req, res) => {
  res.redirect("/settings");
});

router.post("/logout", ensureSameOrigin, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.clearCookie("av.sid");
    res.clearCookie("__Host-av.sid", { path: "/" });
    res.redirect("/settings");
  });
});

module.exports = router;
