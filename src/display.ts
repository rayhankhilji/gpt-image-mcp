/**
 * On a Linux machine without a screen (servers, cloud agents) start a virtual one (Xvfb) so a
 * normal, headed Chrome can run. Falls back to headless if Xvfb isn't installed.
 */
import fs from "node:fs";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { debug, log } from "./config.js";

let xvfb: ChildProcess | null = null;

export function hasDisplay(): boolean {
  return process.platform !== "linux" || !!process.env.DISPLAY || !!process.env.WAYLAND_DISPLAY;
}

export async function ensureVirtualDisplay(): Promise<boolean> {
  if (hasDisplay()) return true;
  let bin = "";
  try {
    bin = execFileSync("which", ["Xvfb"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return false;
  }
  if (!bin) return false;
  for (let n = 99; n < 140; n++) {
    if (fs.existsSync(`/tmp/.X11-unix/X${n}`) || fs.existsSync(`/tmp/.X${n}-lock`)) continue;
    const proc = spawn(bin, [`:${n}`, "-screen", "0", "1440x900x24", "-nolisten", "tcp"], { stdio: "ignore" });
    for (let i = 0; i < 50; i++) {
      if (fs.existsSync(`/tmp/.X11-unix/X${n}`)) break;
      if (proc.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (proc.exitCode === null && fs.existsSync(`/tmp/.X11-unix/X${n}`)) {
      xvfb = proc;
      process.env.DISPLAY = `:${n}`;
      const stop = () => xvfb?.kill();
      process.once("exit", stop);
      log(`no screen found — started a virtual display (Xvfb :${n})`);
      return true;
    }
    proc.kill();
    debug(`Xvfb :${n} failed to start`);
  }
  return false;
}

export function stopVirtualDisplay(): void {
  xvfb?.kill();
  xvfb = null;
}
