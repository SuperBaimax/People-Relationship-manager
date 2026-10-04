const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const database = require("../database.js");

const execute = promisify(execFile);
const root = path.resolve(__dirname, "..");
const statuses = [null, "active", "needs-catchup", "inactive", "archived"];

function buildQueries(records, today) {
  const lines = [`today-day := ${database.dateDay(today)}u64`];
  const output = ["918273u64 1u64 0u64 0u64 0u64 0u64 0u64"];
  const activeIndex = records["lifecycle-policy"].findIndex((row) => row.status === "active") + 1;
  const catchupIndex = records["lifecycle-policy"].findIndex((row) => row.status === "needs-catchup") + 1;
  if (!activeIndex || !catchupIndex) throw new Error("Lifecycle policies need active and needs-catchup rows");
  if (records["lifecycle-policy"][activeIndex - 1]["max-days-since-contact"] > records["lifecycle-policy"][catchupIndex - 1]["max-days-since-contact"]) {
    throw new Error("The active threshold must not exceed the needs-catchup threshold");
  }
  if (records.person.length * (records["interaction-log"].length + records["address-log"].length) > 20000) {
    throw new Error("This prototype supports up to 20,000 person/history comparisons per refresh");
  }
  records.person.forEach((person, index) => {
    const prefix = `view-${index + 1}`;
    const personRef = `person.person-id[${index + 1}]`;
    const latest = (table, idColumn, label) => {
      let previous = { day: "0u64", id: "0u64", row: "0u64" };
      records[table].forEach((record, rowIndex) => {
        const number = rowIndex + 1;
        const name = `${prefix}-${label}-${number}`;
        const day = `${table}.date-day[${number}]`;
        const id = `${table}.${idColumn}[${number}]`;
        lines.push(`${name}-take := newer-record(${personRef}, ${table}.person-id[${number}], ${day}, ${id}, ${previous.day}, ${previous.id}, ${previous.row})`);
        lines.push(`${name}-day := choose-number(${name}-take, ${day}, ${previous.day})`);
        lines.push(`${name}-id := choose-number(${name}-take, ${id}, ${previous.id})`);
        lines.push(`${name}-row := choose-number(${name}-take, ${number}u64, ${previous.row})`);
        previous = { day: `${name}-day`, id: `${name}-id`, row: `${name}-row` };
      });
      return previous;
    };
    const contact = latest("interaction-log", "interaction-id", "contact");
    const address = latest("address-log", "address-id", "address");
    lines.push(`${prefix}-days := elapsed-days(today-day, ${contact.day})`);
    lines.push(`${prefix}-address-age := elapsed-days(today-day, ${address.day})`);
    lines.push(`${prefix}-status := contact-status(person.status[${index + 1}] == "archived", ${contact.row} > 0u64, ${prefix}-days, lifecycle-policy.max-days-since-contact[${activeIndex}], lifecycle-policy.max-days-since-contact[${catchupIndex}])`);
    output.push(`1u64 ${personRef} ${contact.row} ${address.row} ${prefix}-days ${prefix}-status ${prefix}-address-age`);
  });
  records["person-attribute"].forEach((link, index) => {
    output.push(`2u64 person-attribute-details.person-id[${index + 1}] person-attribute-details.attribute-id[${index + 1}] 0u64 0u64 0u64 0u64`);
  });
  lines.push("website-results := | tag<u64> person-id<u64> contact<u64> address<u64> days<u64> status<u64> address-age<u64> |");
  lines.push(...output.map((row) => `  | ${row} |`));
  return lines.join("\n") + "\n";
}

function decodeOutput(stdout, records, today) {
  const clean = stdout.replace(/\x1b\[[0-9;]*m/g, "");
  const expected = 1 + records.person.length + records["person-attribute"].length;
  const header = `|tag<u64> person-id<u64> contact<u64> address<u64> days<u64> status<u64> address-age<u64>|:${expected}`;
  if (!clean.includes(header)) throw new Error("Mech returned an unsupported result format");
  const resultText = clean.slice(clean.lastIndexOf(header));
  const rows = resultText.split(/\r?\n/).filter((line) => /^│\s*\d/.test(line)).map((line) => {
    const cells = line.split("│").slice(1, -1).map((cell) => cell.trim());
    if (cells.length !== 7 || cells.some((cell) => !/^\d+$/.test(cell) || !Number.isSafeInteger(Number(cell)))) {
      throw new Error("Mech returned an invalid numeric result");
    }
    return cells.map(Number);
  });
  if (rows.length !== expected || rows[0]?.join(",") !== "918273,1,0,0,0,0,0") throw new Error("Mech returned incomplete results");
  const people = [];
  const attributes = [];
  const personIds = new Set();
  const linkKeys = new Set();
  for (const [tag, personId, contactRow, addressRow, days, status, addressAge] of rows.slice(1)) {
    if (!records.person.some((person) => person["person-id"] === personId)) throw new Error("Mech returned an unknown person");
    if (tag === 1) {
      const contact = records["interaction-log"][contactRow - 1];
      const address = records["address-log"][addressRow - 1];
      if (personIds.has(personId) || !statuses[status]
        || (contactRow && contact?.["person-id"] !== personId)
        || (addressRow && address?.["person-id"] !== personId)) throw new Error("Mech returned an invalid person view");
      personIds.add(personId);
      people.push({ id: personId, status: statuses[status], lastContact: contact?.timestamp || "No contact recorded",
        daysSinceContact: contact ? days : null, address: address?.address || "", addressDate: address?.timestamp || "",
        addressAgeDays: address?.timestamp ? addressAge : null });
    } else if (tag === 2) {
      const attribute = records.attribute.find((item) => item["attribute-id"] === contactRow);
      const key = `${personId}:${contactRow}`;
      if (!attribute || linkKeys.has(key) || !records["person-attribute"].some((link) => link["person-id"] === personId && link["attribute-id"] === contactRow)) {
        throw new Error("Mech returned an invalid attribute join");
      }
      linkKeys.add(key);
      attributes.push({ personId, id: contactRow, category: attribute.category, value: attribute.value });
    } else throw new Error("Mech returned an unknown result type");
  }
  if (people.length !== records.person.length || attributes.length !== records["person-attribute"].length) throw new Error("Mech omitted view rows");
  return { people, attributes, engine: "Mech", calculatedOn: today };
}

async function calculate(document, options = {}) {
  database.validate(document.database);
  const today = options.today || new Date().toISOString().slice(0, 10);
  const schema = await fs.readFile(path.join(root, "person.mec"), "utf8");
  const program = database.toMechTables(document.database) + "\n" + schema + "\n" + buildQueries(document.database, today);
  const generated = path.join(root, ".generated");
  await fs.mkdir(generated, { recursive: true });
  const directory = await fs.mkdtemp(path.join(generated, "view-"));
  const sourcePath = path.join(directory, "website.mec");
  const configPath = path.join(directory, "runtime.mcfg");
  try {
    await fs.writeFile(sourcePath, program, "utf8");
    await fs.writeFile(configPath, 'config := { runtime: { limits: { max-turn-duration-ms: 25000 } } }\n', "utf8");
    const { stdout } = await execute(options.mech || process.env.MECH_BIN || "mech", ["--config", configPath, "run", sourcePath], {
      cwd: root, encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024,
    });
    return decodeOutput(stdout, document.database, today);
  } catch (error) {
    const detail = error.code === "ENOENT" ? "Mech was not found. Set MECH_BIN to your mech.exe path."
      : error.killed ? "Mech exceeded the 30-second calculation limit."
        : (error.stderr || error.message).slice(0, 1600);
    throw new Error(`Mech calculation failed: ${detail}`);
  } finally {
    if (path.resolve(directory).startsWith(path.resolve(generated) + path.sep)) {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
}

module.exports = { calculate, buildQueries, decodeOutput };
