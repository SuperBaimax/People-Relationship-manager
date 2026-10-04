const path = require("node:path");
const http = require("node:http");
const { spawn, execFile } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const port = Number(process.env.PORT || 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("PORT must be a number between 1 and 65535.");
  process.exit(1);
}
const address = `http://127.0.0.1:${port}`;

function checkServer() {
  return new Promise((resolve) => {
    const request = http.get(`${address}/api/health`, (response) => {
      let body = "";
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 4096) response.destroy();
      });
      response.on("error", () => resolve("other"));
      response.on("end", () => {
        try { resolve(response.statusCode === 200 && JSON.parse(body).application === "people-relationship-manager" ? "ready" : "other"); }
        catch { resolve("other"); }
      });
    });
    request.setTimeout(1500, () => request.destroy());
    request.on("error", () => resolve("unavailable"));
  });
}

function openWebsite() {
  console.log(`Open ${address}`);
  if (process.argv.includes("--no-browser") || process.platform !== "win32") return;
  execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Start-Process -FilePath '${address}' -WindowStyle Hidden`], { windowsHide: true }, (error) => {
    if (error) console.error(`Could not open the browser automatically. Open ${address} yourself.`);
  });
}

async function start() {
  const existing = await checkServer();
  if (existing === "ready") {
    console.log("The app is already running. Keep its original server window open.");
    openWebsite();
    return;
  }
  if (existing === "other") throw new Error(`Port ${port} is used by another server or an older app instance. Stop that server, or choose a different PORT, then try again.`);
  const child = spawn(process.execPath, [path.join(root, "server.cjs")], { cwd: root, env: process.env, stdio: "inherit", windowsHide: true });
  let exited = false;
  let startupError;
  child.on("error", (error) => { startupError = error; exited = true; });
  child.on("exit", (code) => { exited = true; process.exitCode = code || 0; });
  process.on("SIGINT", () => child.kill());
  process.on("SIGTERM", () => child.kill());
  for (let attempt = 0; attempt < 60 && !exited; attempt += 1) {
    if (await checkServer() === "ready") {
      console.log("Keep this window open while using the app. Press Ctrl+C to stop.");
      openWebsite();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!exited) child.kill();
  throw startupError || new Error("The backend could not start. Check the error above, then try again.");
}

start().catch((error) => { console.error(error.message); process.exitCode = 1; });
