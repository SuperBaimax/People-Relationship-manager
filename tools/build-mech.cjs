const fs = require("node:fs");
const path = require("node:path");
const database = require("../database.js");
const { initializeDatabase } = require("./initialize-database.cjs");

const root = path.resolve(__dirname, "..");
const source = path.resolve(process.argv[2] || path.join(root, "people.mcfg"));
const output = path.join(root, ".generated", "people-runtime.mec");

try {
  if (!process.argv[2]) initializeDatabase(source);
  const document = database.parseDocument(fs.readFileSync(source, "utf8"));
  const schema = fs.readFileSync(path.join(root, "person.mec"), "utf8");
  const program = database.toMechTables(document.database) + "\n" + schema;
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, program, "utf8");
  console.log(`Built ${output} from ${source}`);
  console.log("Run the generated tables and join: mech .generated/people-runtime.mec");
  console.log("For a CLI with --config support: mech --config people.mcfg run");
} catch (error) {
  console.error(`Build failed: ${error.message}`);
  process.exitCode = 1;
}
