import fs from "fs/promises";




export function sanitizeSegment(seg: string) {
  
  
  return seg.replace(/[^A-Za-z0-9._-]/g, "-").toLowerCase();
}


export async function directoryExists(p: string) {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}
