(function (root) {
  "use strict";

  const TABLES = [
    ["person", "people", "person-id:id:u64 name:name:string status:status:string birthdate:birthday:string background:background:string"],
    ["attribute", "attributeCatalog", "attribute-id:id:u64 category:category:string value:value:string"],
    ["person-attribute", "personAttributes", "person-id:personId:u64 attribute-id:attributeId:u64 source:source:string confidence:confidence:f64"],
    ["address-log", "addressLog", "address-id:id:u64 person-id:personId:u64 timestamp:timestamp:string date-day:dateDay:u64 address:address:string source:source:string"],
    ["interaction-log", "interactions", "interaction-id:id:u64 person-id:personId:u64 timestamp:date:string date-day:dateDay:u64 kind:kind:string summary:summary:string follow-up-date:followUpDate:string"],
    ["relationship", "relationships", "relationship-id:id:u64 from-person-id:from:u64 to-person-id:to:u64 kind:kind:string strength:strength:string note:note:string"],
    ["lifecycle-policy", "lifecyclePolicy", "status:status:string max-days-since-contact:max-days-since-contact:u64 reminder-kind:reminder-kind:string note:note:string"],
    ["lifecycle-transition", "lifecycleTransitions", "from-status:from-status:string event-kind:event-kind:string to-status:to-status:string"],
    ["lifecycle-event", "lifecycleEvents", "event-id:id:u64 person-id:personId:u64 timestamp:date:string date-day:dateDay:u64 event-kind:kind:string note:note:string"],
  ].map(([name, stateKey, fields]) => ({
    name, stateKey, fields: fields.split(" ").map((field) => {
      const [name, key, type] = field.split(":");
      return { name, key, type };
    }),
  }));

  const DEFAULT_CONFIG = {
    runtime: { name: "people-relationship-manager", limits: { "max-turn-duration-ms": 2000 } },
    run: { paths: [".generated/people-runtime.mec"], grants: [] },
  };

  function parseDocument(source) {
    let position = 0;
    const fail = (message) => {
      const line = source.slice(0, position).split("\n").length;
      throw new Error(`${message} (line ${line})`);
    };
    function skip() {
      while (position < source.length) {
        if (/\s/.test(source[position])) position += 1;
        else if (source.startsWith("--", position)) {
          const end = source.indexOf("\n", position);
          position = end < 0 ? source.length : end + 1;
        } else break;
      }
    }
    function consume(token) {
      skip();
      if (!source.startsWith(token, position)) fail(`Expected ${token}`);
      position += token.length;
    }
    function identifier() {
      skip();
      const match = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(source.slice(position));
      if (!match) fail("Expected a field or binding name");
      position += match[0].length;
      return match[0];
    }
    function value(depth = 0) {
      if (depth > 32) fail("Data nesting is too deep");
      skip();
      const start = source[position];
      if (start === "{") {
        position += 1;
        skip();
        const record = Object.create(null);
        if (source[position] === ":") { position += 1; consume("}"); return record; }
        while (source[position] !== "}") {
          const key = identifier();
          if (Object.hasOwn(record, key)) fail(`Duplicate field ${key}`);
          consume(":");
          record[key] = value(depth + 1);
          skip();
          if (source[position] === ",") { position += 1; skip(); }
        }
        position += 1;
        return record;
      }
      if (start === "[") {
        position += 1;
        skip();
        const items = [];
        while (source[position] !== "]") {
          if (position >= source.length) fail("Unclosed list");
          items.push(value(depth + 1));
          skip();
          if (source[position] === ",") { position += 1; skip(); }
        }
        position += 1;
        return items;
      }
      if (start === '"') {
        const match = /^"(?:\\.|[^"\\])*"/.exec(source.slice(position));
        if (!match) fail("Unclosed string");
        position += match[0].length;
        try { return JSON.parse(match[0]); } catch { fail("Invalid string escape"); }
      }
      const literal = /^(true|false|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?:u64|f64)?)(?=$|[\s,\]}])/.exec(source.slice(position));
      if (!literal) fail("Expected a record, list, string, boolean, or nonnegative number");
      position += literal[0].length;
      if (literal[0] === "true" || literal[0] === "false") return literal[0] === "true";
      const number = Number(literal[0].replace(/(?:u64|f64)$/, ""));
      if (!Number.isFinite(number) || (Number.isInteger(number) && !Number.isSafeInteger(number))) fail("Number exceeds browser precision");
      return number;
    }
    const bindings = Object.create(null);
    skip();
    while (position < source.length) {
      const name = identifier();
      if (Object.hasOwn(bindings, name)) fail(`Duplicate binding ${name}`);
      consume(":=");
      bindings[name] = value();
      skip();
    }
    if (!bindings.config || Array.isArray(bindings.config) || typeof bindings.config !== "object") fail("Missing config record");
    validate(bindings.database);
    if (Object.keys(bindings).some((name) => name !== "database" && name !== "config")) fail("Only database and config bindings are supported by this app");
    return bindings;
  }

  function validate(database) {
    if (!database || database.version !== 1) throw new Error("Expected database version 1");
    const tableNames = new Set(["version", ...TABLES.map((table) => table.name)]);
    for (const key of Object.keys(database)) {
      if (!tableNames.has(key)) throw new Error(`Unknown database field ${key}`);
    }
    for (const table of TABLES) {
      const rows = database[table.name];
      if (!Array.isArray(rows)) throw new Error(`Missing list ${table.name}`);
      const fieldNames = new Set(table.fields.map((field) => field.name));
      const keys = new Set();
      rows.forEach((row, index) => {
        if (!row || Array.isArray(row) || typeof row !== "object") throw new Error(`Invalid ${table.name} row ${index + 1}`);
        for (const key of Object.keys(row)) {
          if (!fieldNames.has(key)) throw new Error(`Unknown ${table.name}.${key}`);
        }
        for (const field of table.fields) {
          const item = row[field.name];
          const valid = field.type === "string" ? typeof item === "string"
            : field.type === "u64" ? Number.isSafeInteger(item) && item >= 0
              : typeof item === "number" && Number.isFinite(item) && item >= 0 && item <= 1;
          if (!valid) throw new Error(`Invalid ${table.name}.${field.name} in row ${index + 1}`);
        }
        const key = table.name === "person-attribute" ? `${row["person-id"]}:${row["attribute-id"]}`
          : table.name === "lifecycle-transition" ? JSON.stringify([row["from-status"], row["event-kind"]])
            : row[table.fields[0].name];
        if (keys.has(key)) throw new Error(`Duplicate key in ${table.name}: ${key}`);
        keys.add(key);
      });
    }
    const people = new Set(database.person.map((row) => row["person-id"]));
    const validDate = (value) => value === "" || (/^\d{4}-\d{2}-\d{2}$/.test(value)
      && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
      && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value);
    for (const person of database.person) {
      if (!validDate(person.birthdate)) throw new Error("Invalid birthday; use YYYY-MM-DD");
      if (!["active", "needs-catchup", "inactive", "archived"].includes(person.status)) throw new Error("Invalid person status");
    }
    for (const name of ["address-log", "interaction-log", "lifecycle-event"]) {
      for (const row of database[name]) {
        if (!validDate(row.timestamp) || (name !== "address-log" && !row.timestamp)
          || row["date-day"] !== dateDay(row.timestamp)) throw new Error(`Invalid or inconsistent date in ${name}`);
        if (name === "interaction-log" && !validDate(row["follow-up-date"])) throw new Error("Invalid follow-up date");
      }
    }
    const attributes = new Set(database.attribute.map((row) => row["attribute-id"]));
    const attributeKeys = new Set();
    for (const attribute of database.attribute) {
      const key = JSON.stringify([attribute.category.trim().toLowerCase(), attribute.value.trim().toLowerCase()]);
      if (!attribute.category.trim() || !attribute.value.trim() || attributeKeys.has(key)) throw new Error("Empty or duplicate attribute category/value");
      attributeKeys.add(key);
    }
    for (const name of ["person-attribute", "address-log", "interaction-log", "lifecycle-event"]) {
      for (const row of database[name]) {
        if (!people.has(row["person-id"])) throw new Error(`Unknown person ID in ${name}`);
        if (name === "person-attribute" && !attributes.has(row["attribute-id"])) throw new Error("Unknown attribute ID in person-attribute");
      }
    }
    const pairs = new Set();
    for (const relationship of database.relationship) {
      const from = relationship["from-person-id"];
      const to = relationship["to-person-id"];
      const key = [from, to].sort((left, right) => left - right).join(":");
      if (!people.has(from) || !people.has(to) || from === to || pairs.has(key)) throw new Error("Invalid or duplicate relationship");
      pairs.add(key);
    }
    return database;
  }

  function formatValue(value, depth = 0) {
    const indent = "  ".repeat(depth);
    if (Array.isArray(value)) return value.length ? `[\n${value.map((item) => `${indent}  ${formatValue(item, depth + 1)}`).join("\n")}\n${indent}]` : "[]";
    if (value && typeof value === "object") {
      const entries = Object.entries(value);
      return entries.length ? `{\n${entries.map(([key, item]) => `${indent}  ${key}: ${formatValue(item, depth + 1)}`).join("\n")}\n${indent}}` : "{:}";
    }
    return JSON.stringify(value);
  }

  function stringifyDocument(document) {
    validate(document.database);
    return `database := ${formatValue(document.database)}\n\nconfig := ${formatValue(document.config || DEFAULT_CONFIG)}\n`;
  }

  function dateDay(date) {
    const milliseconds = Date.parse(`${date}T00:00:00Z`);
    return Number.isFinite(milliseconds) ? Math.max(0, Math.floor(milliseconds / 86400000) + 719163) : 0;
  }

  function toState(document) {
    validate(document.database);
    const state = { mcfgConfig: document.config };
    for (const table of TABLES) {
      state[table.stateKey] = document.database[table.name].map((row) => Object.fromEntries(table.fields.map((field) => [field.key, row[field.name]])));
    }
    for (const person of state.people) {
      const latest = state.addressLog.filter((row) => row.personId === person.id)
        .sort((left, right) => right.dateDay - left.dateDay || right.id - left.id)[0];
      person.address = latest?.address || "";
      person.addressDate = latest?.timestamp || "";
      if (person.status === "archived") person.manualStatus = "archived";
    }
    return state;
  }

  function fromState(state, captureAddressChanges = true) {
    const database = { version: 1 };
    const addressLog = [...(state.addressLog || [])];
    for (const person of captureAddressChanges ? state.people : []) {
      const latest = addressLog.filter((row) => row.personId === person.id)
        .sort((left, right) => right.dateDay - left.dateDay || right.id - left.id)[0];
      if ((person.address || latest) && (person.address !== latest?.address || person.addressDate !== latest?.timestamp)) {
        addressLog.push({ id: Math.max(0, ...addressLog.map((row) => row.id)) + 1, personId: person.id,
          timestamp: person.addressDate || "", dateDay: dateDay(person.addressDate), address: person.address || "", source: "manual" });
      }
    }
    for (const table of TABLES) {
      const rows = table.name === "address-log" ? addressLog : state[table.stateKey] || [];
      database[table.name] = rows.map((row) => Object.fromEntries(table.fields.map((field) => {
        let value = row[field.key];
        if (table.name === "person" && field.name === "status") value = row.manualStatus || (row.status === "archived" ? "active" : row.status) || "active";
        if (field.name === "date-day" && value === undefined) value = dateDay(row.date || row.timestamp);
        if (value === undefined) value = field.name === "source" ? "manual" : field.name === "confidence" ? 1 : field.type === "string" ? "" : undefined;
        return [field.name, value];
      })));
    }
    validate(database);
    return { database, config: state.mcfgConfig || DEFAULT_CONFIG };
  }

  function toMechTables(database) {
    validate(database);
    return TABLES.map((table) => {
      const header = table.fields.map((field) => `${field.name}<${field.type}>`).join(" ");
      const rows = database[table.name];
      if (!rows.length) {
        const template = `${table.name}-empty-template`;
        const cells = table.fields.map((field) => field.type === "string" ? '""' : `0${field.type}`).join(" ");
        return `${template} := | ${header} |\n  | ${cells} |\n  | ${cells} |\n${table.name} := ${template}[[false; false]]`;
      }
      return `${table.name} := | ${header} |\n${rows.map((row) => `  | ${table.fields.map((field) => field.type === "string" ? JSON.stringify(row[field.name]) : `${row[field.name]}${field.type}`).join(" ")} |`).join("\n")}`;
    }).join("\n\n") + "\n";
  }

  const api = { parseDocument, stringifyDocument, validate, toState, fromState, toMechTables, dateDay, TABLES };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PeopleDatabase = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
