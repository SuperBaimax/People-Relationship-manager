const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const database = require("./database.js");
const { calculate } = require("./tools/mech-engine.cjs");
const { initializeDatabase } = require("./tools/initialize-database.cjs");

const root = __dirname;
const databasePath = path.resolve(process.env.PRM_DATABASE || path.join(root, "people.mcfg"));
if (!process.env.PRM_DATABASE) initializeDatabase(databasePath);
const port = Number(process.env.PORT || 8080);
const limit = 1024 * 1024;
const staticFiles = new Map([
  ["/", ["index.html", "text/html"]], ["/index.html", ["index.html", "text/html"]],
  ["/app.js", ["app.js", "text/javascript"]], ["/database.js", ["database.js", "text/javascript"]],
  ["/styles.css", ["styles.css", "text/css"]],
  ["/network-map.js", ["network-map.js", "text/javascript"]],
]);
let queue = Promise.resolve();

function failure(status, message) {
  return Object.assign(new Error(message), { status });
}

function revision(source) {
  return crypto.createHash("sha256").update(source).digest("hex");
}

async function readDatabase() {
  const source = await fs.readFile(databasePath, "utf8");
  return { source, document: database.parseDocument(source), revision: revision(source) };
}

async function snapshot(current) {
  let views;
  try { views = await calculate(current.document); }
  catch (error) { throw failure(503, error.message); }
  const state = database.toState(current.document);
  for (const person of state.people) {
    const view = views.people.find((item) => item.id === person.id);
    person.address = view.address;
    person.addressDate = view.addressDate;
  }
  return { state, views, revision: current.revision };
}

async function requestBody(request) {
  if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json") throw failure(415, "Expected application/json");
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw failure(413, "Import is too large (maximum 1 MB)");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw failure(400, "Invalid request body"); }
}

async function saveDatabase(body, expectedRevision) {
  if (typeof expectedRevision !== "string") throw failure(428, "Reload the database before saving");
  if (typeof body?.source !== "string" || Buffer.byteLength(body.source) > limit) throw failure(400, "Expected an MCFG document under 1 MB");
  let document;
  try { document = database.parseDocument(body.source); }
  catch (error) { throw failure(400, error.message); }
  const lockPath = `${databasePath}.lock`;
  let lock;
  try { lock = await fs.open(lockPath, "wx"); }
  catch (error) {
    if (error.code === "EEXIST") throw failure(409, "The database is locked by another save. Try reloading. If a server crashed, see the README recovery steps.");
    throw error;
  }
  const temporary = `${databasePath}.${crypto.randomUUID()}.tmp`;
  try {
    const current = await readDatabase();
    if (expectedRevision !== `"${current.revision}"`) throw failure(409, "The database changed elsewhere. Your edit was not saved. Reload database, then retry.");
    const source = database.stringifyDocument(document);
    const result = await snapshot({ document, revision: revision(source) });
    if (revision(await fs.readFile(databasePath, "utf8")) !== current.revision) throw failure(409, "The file changed during calculation. Reload database before retrying.");
    const backupDirectory = path.join(path.dirname(databasePath), ".backups", path.basename(databasePath));
    await fs.mkdir(backupDirectory, { recursive: true });
    await fs.writeFile(path.join(backupDirectory, `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID()}.mcfg`), current.source, { flag: "wx" });
    const handle = await fs.open(temporary, "wx");
    try { await handle.writeFile(source, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    if (revision(await fs.readFile(databasePath, "utf8")) !== current.revision) throw failure(409, "The file changed before replacement. Reload database before retrying.");
    await fs.rename(temporary, databasePath);
    return result;
  } finally {
    try { await fs.rm(temporary, { force: true }); }
    finally {
      try { await lock.close(); }
      finally { await fs.rm(lockPath, { force: true }); }
    }
  }
}

function serialize(operation) {
  const result = queue.then(operation);
  queue = result.catch(() => {});
  return result;
}

function send(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

const server = http.createServer(async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    const host = request.headers.host;
    const boundPort = server.address().port;
    if (![ `127.0.0.1:${boundPort}`, `localhost:${boundPort}` ].includes(host)) throw failure(403, "Only local requests are allowed");
    if ((request.headers.origin && request.headers.origin !== `http://${host}`)
      || request.headers["sec-fetch-site"] === "cross-site") throw failure(403, "Cross-site requests are not allowed");
    const pathname = new URL(request.url, `http://${host}`).pathname;
    if (pathname === "/api/health" && request.method === "GET") {
      send(response, 200, { application: "people-relationship-manager" });
    } else if (pathname === "/api/database") {
      let result;
      if (request.method === "GET") result = await serialize(async () => snapshot(await readDatabase()));
      else if (request.method === "PUT") {
        const body = await requestBody(request);
        result = await serialize(() => saveDatabase(body, request.headers["if-match"]));
      } else throw failure(405, "Use GET or PUT");
      response.setHeader("ETag", `"${result.revision}"`);
      send(response, 200, result);
    } else {
      const file = staticFiles.get(pathname);
      if (!file || request.method !== "GET") throw failure(404, "Not found");
      const contents = await fs.readFile(path.join(root, file[0]));
      response.writeHead(200, { "Content-Type": `${file[1]}; charset=utf-8` });
      response.end(contents);
    }
  } catch (error) {
    console.error(error.message);
    send(response, error.status || 500, { error: error.status ? error.message : "Could not read or save the database. Check the server window; no successful save was acknowledged." });
  }
});

server.requestTimeout = 45000;
server.on("error", (error) => { console.error(`Server failed: ${error.message}`); process.exitCode = 1; });
server.listen(port, "127.0.0.1", () => {
  console.log(`People Relationship Manager: http://127.0.0.1:${server.address().port}`);
  console.log(`Database: ${databasePath}`);
  console.log("Keep this window open. Press Ctrl+C to stop. Mech recalculates on each load and save.");
});
