const fs = require("node:fs");
const path = require("node:path");
const database = require("../database.js");

function initializeDatabase(destination) {
  if (fs.existsSync(destination)) return;
  const example = path.resolve(__dirname, "../examples/people.example.mcfg");
  const source = fs.readFileSync(example, "utf8");
  database.parseDocument(source);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try { fs.writeFileSync(destination, source, { encoding: "utf8", flag: "wx" }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
}

module.exports = { initializeDatabase };
