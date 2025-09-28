import { cfg } from "./config.js";
import { fetch } from "undici";

export async function fetchContext(workflowId: string) {
  try {
    const r = await fetch(`${cfg.dashboardBaseUrl}/api/context?workflow_id=${encodeURIComponent(workflowId)}`, {
      headers: { "Authorization": `Bearer ${cfg.dashboardApiKey}` }
    });
    if (!r.ok) throw new Error(`dashboard ${r.status}`);
    const data = await r.json();
    return data;
  } catch {
    return { projectTree: "", fileHotspots: "", limits: "", personaHints: "" };
  }
}

export async function recordEvent(ev: any) {
  try {
    await fetch(`${cfg.dashboardBaseUrl}/api/events`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${cfg.dashboardApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(ev)
    });
  } catch (e) {
    console.warn("[dashboard] recordEvent failed:", (e as Error).message);
  }
}
