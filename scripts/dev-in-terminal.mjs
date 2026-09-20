#!/usr/bin/env node
/**
 * Start api+web+worker in a real OS terminal so Cursor agent shells cannot kill the stack.
 */
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function runInThisShell() {
  console.log("Keep this terminal open. Dashboard: http://localhost:3000");
  const child = spawn("npm", ["run", "dev"], { cwd: root, stdio: "inherit", shell: true });
  child.on("exit", (code) => process.exit(code ?? 0));
}

if (process.platform === "darwin") {
  const quoted = root.replace(/'/g, `'\\''`);
  spawn(
    "osascript",
    ["-e", `tell application "Terminal" to activate\ndo script "cd '${quoted}' && npm run dev"`],
    { stdio: "inherit" },
  ).on("exit", (code) => {
    if (code !== 0) {
      runInThisShell();
      return;
    }
    console.log("Opened Terminal.app with npm run dev");
    console.log("Dashboard: http://localhost:3000");
    console.log("API:       http://localhost:4000/health");
  });
} else if (process.platform === "win32") {
  spawn("cmd.exe", ["/c", "start", "Recruiter Reachout", "cmd.exe", "/k", `cd /d "${root}" && npm run dev`], {
    cwd: root,
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  }).unref();
  console.log("Opened a new Command Prompt with npm run dev");
  console.log("Dashboard: http://localhost:3000");
  console.log("API:       http://localhost:4000/health");
} else {
  runInThisShell();
}
