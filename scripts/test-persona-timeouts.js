const fs = require('fs');
const path = require('path');

function jsonOr(value, fallback) {
  if (!value) return fallback;
  let v = value.toString().trim();
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1);
  try { return JSON.parse(v); } catch (e) { return fallback; }
}

function parseDurationMs(value, fallbackMs) {
  if (!value) return fallbackMs;
  let s = value.toString().trim();
  if (!s.length) return fallbackMs;
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) s = s.slice(1, -1).trim();
  const m = s.match(/^([0-9]+(?:\.[0-9]+)?)\s*(ms|s|m|min|h)?$/i);
  if (m) {
    const num = Number(m[1]);
    if (!Number.isFinite(num) || num <= 0) return fallbackMs;
    const unit = (m[2] || "").toLowerCase();
    if (unit === "ms") return Math.floor(num);
    if (unit === "s") return Math.floor(num * 1000);
    if (unit === "m" || unit === "min") return Math.floor(num * 60 * 1000);
    if (unit === "h") return Math.floor(num * 60 * 60 * 1000);
    if (num > 1000) return Math.floor(num);
    return Math.floor(num * 1000);
  }
  const num = Number(s);
  if (!Number.isFinite(num) || num <= 0) return fallbackMs;
  if (num > 1000) return Math.floor(num);
  return Math.floor(num * 1000);
}

function parsePersonaTimeouts(raw) {
  const out = {};
  for (const [key, value] of Object.entries(raw || {})) {
    if (!key || typeof key !== 'string') continue;
    const normalizedKey = key.trim().toLowerCase();
    if (!normalizedKey.length) continue;
    let ms;
    if (typeof value === 'number') ms = value;
    else if (typeof value === 'string') {
      const parsed = parseDurationMs(value, -1);
      if (parsed > 0) ms = parsed;
    }
    if (ms === undefined || !Number.isFinite(ms) || ms <= 0) continue;
    out[normalizedKey] = Math.floor(ms);
  }
  return out;
}

const envPath = path.resolve(process.cwd(), '.env');
const env = fs.readFileSync(envPath, 'utf8');
const match = env.split(/\r?\n/).find(l => l.trim().startsWith('PERSONA_TIMEOUTS_JSON='));
console.log('raw line:', match);
const rawVal = match ? match.split('=')[1] : undefined;
const parsedJson = jsonOr(rawVal, {});
console.log('jsonOr =>', parsedJson);
const parsed = parsePersonaTimeouts(parsedJson);
console.log('parsePersonaTimeouts =>', parsed);
console.log('lead-engineer (ms) =>', parsed['lead-engineer']);

// show human-readable seconds
for (const k of Object.keys(parsed)) console.log(k, '=>', parsed[k], 'ms =>', Math.round(parsed[k]/1000)+'s');

process.exit(0);
