const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MIN_REQUEST_INTERVAL_MS = 1100;

const cache = new Map();
let lastRequestAt = 0;

const buildUserAgent = () => {
  const appUrl = process.env.APP_PUBLIC_URL || "https://appointment-vault.onrender.com";
  return `AppointmentVault/1.0 (${appUrl})`;
};

async function sleep(ms) {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function searchOpenStreetMapLocation(query) {
  const trimmed = String(query || "").trim();
  if (!trimmed) {
    return null;
  }

  const key = trimmed.toLowerCase();
  const cached = cache.get(key);
  if (cached && Date.now() - cached.timestamp < DEFAULT_CACHE_TTL_MS) {
    return cached.value;
  }

  const waitFor = MIN_REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt);
  await sleep(waitFor);

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("q", trimmed);
  url.searchParams.set("limit", "1");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("accept-language", "en");

  lastRequestAt = Date.now();

  const response = await fetch(url.toString(), {
    headers: {
      "User-Agent": buildUserAgent(),
      "Accept-Language": "en"
    }
  });

  if (!response.ok) {
    return null;
  }

  const payload = await response.json();
  const first = Array.isArray(payload) ? payload[0] : null;
  if (!first) {
    return null;
  }

  const result = {
    displayName: String(first.display_name || ""),
    lat: String(first.lat || ""),
    lon: String(first.lon || ""),
    type: String(first.type || ""),
    category: String(first.category || first.class || "")
  };

  cache.set(key, { value: result, timestamp: Date.now() });
  return result;
}

module.exports = {
  searchOpenStreetMapLocation
};
