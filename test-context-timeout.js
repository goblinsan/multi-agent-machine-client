import { cfg } from "./src/config.js";

console.log("Context timeout check:");
console.log("cfg.personaTimeouts:", cfg.personaTimeouts);
console.log("cfg.personaTimeouts.context:", cfg.personaTimeouts.context);
console.log("cfg.personaDefaultTimeoutMs:", cfg.personaDefaultTimeoutMs);

const personaTimeoutMs =
  cfg.personaTimeouts["context"] || cfg.personaDefaultTimeoutMs;
const maxRetries = 3;
const totalBackoffMs = (30 * 1000 * maxRetries * (maxRetries + 1)) / 2;
const totalPersonaTimeMs = (maxRetries + 1) * personaTimeoutMs;
const calculatedTimeout = totalPersonaTimeMs + totalBackoffMs + 30000;

console.log("\nCalculated step timeout:");
console.log("personaTimeoutMs:", personaTimeoutMs);
console.log("maxRetries:", maxRetries);
console.log("totalBackoffMs:", totalBackoffMs);
console.log("totalPersonaTimeMs:", totalPersonaTimeMs);
console.log(
  "calculatedTimeout:",
  calculatedTimeout,
  "(" + (calculatedTimeout / 60000).toFixed(2) + " min)",
);
