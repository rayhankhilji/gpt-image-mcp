import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/** Installed Chrome/Chromium-family browsers on this machine, best first. */
export function systemBrowsers(): string[] {
  const env = process.env;
  const out: string[] = [];
  if (process.platform === "darwin") {
    out.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      `${env.HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    );
  } else if (process.platform === "win32") {
    out.push(
      `${env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
      `${env["PROGRAMFILES(X86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
      `${env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
      `${env["PROGRAMFILES(X86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${env.PROGRAMFILES}\\Microsoft\\Edge\\Application\\msedge.exe`,
    );
  } else {
    for (const bin of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"]) {
      try {
        const p = execFileSync("which", [bin], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        if (p) out.push(p);
      } catch {
        /* not installed */
      }
    }
  }
  return out.filter((p) => p && fs.existsSync(p));
}

/** Chromium builds pre-installed for Playwright (e.g. in cloud agent images), newest first. */
export function preinstalledChromium(): string[] {
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, "/opt/pw-browsers", path.join(process.env.HOME ?? "", ".cache", "ms-playwright")];
  const out: string[] = [];
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    const dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
    for (const d of dirs) {
      for (const rel of ["chrome-linux64/chrome", "chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium", "chrome-win/chrome.exe"]) {
        const p = path.join(root, d, rel);
        if (fs.existsSync(p)) out.push(p);
      }
    }
  }
  return out;
}
