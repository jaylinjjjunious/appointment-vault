function requireAuth(req, res, next) {
  if (req.currentUser) {
    return next();
  }

  const acceptsHtml = String(req.get("accept") || "").includes("text/html");
  if (acceptsHtml) {
    return res.redirect("/auth/login");
  }

  return res.status(401).json({
    ok: false,
    message: "Authentication required."
  });
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.currentUser) {
      return res.status(401).json({ ok: false, message: "Authentication required." });
    }

    if (String(req.currentUser.role || "user") !== String(role)) {
      return res.status(403).json({ ok: false, message: "Forbidden." });
    }

    return next();
  };
}

module.exports = {
  requireAuth,
  requireRole
};