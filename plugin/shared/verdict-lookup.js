// Look up OUR authoritative graded verdict for a skill by content hash, from the
// bundled verdict index. Returns "d" | "w" | "g", or null when we haven't graded
// this exact content (unknown or locally modified) so the caller falls back to
// the fast regex triage. No network, no execution — just a hash and a lookup.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

let INDEX;
function index() {
  if (INDEX === undefined) {
    try {
      INDEX = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../product-surface/data/verdict-index.json"), "utf8"));
    } catch (_error) {
      INDEX = {};
    }
  }
  return INDEX;
}

// Must match scripts/build-verdict-index.mjs exactly, or nothing will resolve.
function normalizeForHash(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\s+$/, "");
}

// The graded risk code for this skill text, or null if we haven't graded it.
function gradedRisk(text) {
  try {
    const h = crypto.createHash("sha256").update(normalizeForHash(text), "utf8").digest("hex").slice(0, 16);
    const code = index()[h];
    return code === "d" || code === "w" || code === "g" ? code : null;
  } catch (_error) {
    return null;
  }
}

module.exports = { gradedRisk, normalizeForHash };
