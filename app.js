const STORAGE_KEY = "people-relationship-manager-mcfg-v1";
const LEGACY_STORAGE_KEY = "people-relationship-manager-state-v1";

const EMPTY_STATE = {
  people: [],
  attributeCatalog: [],
  personAttributes: [],
  relationships: [],
  interactions: [],
  lifecycleEvents: [],
};

let state = null;
let selectedId = null;
let views = { people: [], attributes: [] };
let revision = null;
let committedState = null;
let busy = false;
let needsReload = true;
let failedDraft = null;

const map = document.querySelector("#relationship-map");
const networkMap = new PeopleNetworkMap(map, selectPerson);
const panel = document.querySelector("#person-panel");
const saveMessage = document.querySelector("#save-message");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeState(parsed) {
  const normalized = {
    ...clone(EMPTY_STATE),
    ...parsed,
    lifecycleEvents: Array.isArray(parsed.lifecycleEvents) ? parsed.lifecycleEvents : [],
    lifecyclePolicy: Array.isArray(parsed.lifecyclePolicy) ? parsed.lifecyclePolicy : clone(state?.lifecyclePolicy || []),
    lifecycleTransitions: Array.isArray(parsed.lifecycleTransitions) ? parsed.lifecycleTransitions : clone(state?.lifecycleTransitions || []),
  };

  if (!Array.isArray(parsed.attributeCatalog) || !Array.isArray(parsed.personAttributes)) {
    const catalog = [];
    const links = [];
    const known = new Map(catalog.map((attribute) => [attribute.value.toLowerCase(), attribute]));

    normalized.people.forEach((person) => {
      if (!Array.isArray(person.attributes)) return;
      person.attributes.forEach((value) => {
        const key = String(value).trim().toLowerCase();
        if (!key) return;
        let attribute = known.get(key);
        if (!attribute) {
          attribute = { id: nextId(catalog), category: "imported", value: String(value).trim() };
          catalog.push(attribute);
          known.set(key, attribute);
        }
        if (!links.some((link) => link.personId === person.id && link.attributeId === attribute.id)) {
          links.push({ personId: person.id, attributeId: attribute.id });
        }
      });
      delete person.attributes;
    });

    normalized.attributeCatalog = catalog;
    normalized.personAttributes = links;
  }

  normalized.people = normalized.people.map((person) => {
    const { attributes, ...withoutAttributes } = person;
    return withoutAttributes;
  });
  return normalized;
}

function loadStoredState() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) return PeopleDatabase.toState(PeopleDatabase.parseDocument(stored));
  const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (!legacy) return null;
  const parsed = JSON.parse(legacy);
  if (!Array.isArray(parsed.people) || !Array.isArray(parsed.relationships) || !Array.isArray(parsed.interactions)) {
    throw new Error("Invalid legacy workspace");
  }
  return PeopleDatabase.toState(PeopleDatabase.fromState(normalizeState(parsed)));
}

async function databaseRequest(options = {}) {
  const startupHelp = "Double-click start.cmd in the project folder and keep its window open. Use the browser page it opens, not index.html or a static/Live Server preview.";
  if (location.protocol === "file:") throw new Error(startupHelp);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    let response;
    try { response = await fetch("/api/database", { cache: "no-store", ...options, signal: controller.signal }); }
    catch (error) {
      if (controller.signal.aborted) throw error;
      throw new Error(`Cannot reach the local backend. ${startupHelp}`);
    }
    if (!response.headers.get("content-type")?.includes("application/json")) throw new Error(`This page is not connected to the app backend. ${startupHelp}`);
    let result;
    try { result = await response.json(); }
    catch { throw new Error(`The backend returned an unreadable response. ${startupHelp}`); }
    if (!response.ok) throw new Error(result.error || `Database request failed: ${response.status}`);
    if (!result.state || !result.views || !result.revision) throw new Error("Invalid database response");
    return result;
  } catch (error) {
    if (controller.signal.aborted) throw new Error("The backend did not reply within 45 seconds. Reload to check the saved file.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function acceptSnapshot(result) {
  state = result.state;
  views = result.views;
  revision = result.revision;
  committedState = clone(state);
  needsReload = false;
  document.querySelector(".header-status").classList.remove("is-offline");
  document.querySelector("#engine-status").textContent = `Mech results · ${views.calculatedOn} (UTC)`;
}

function setBusy(value) {
  busy = value;
  document.querySelector(".workspace").inert = value || needsReload;
  document.querySelectorAll(".toolbar button, .toolbar input").forEach((control) => {
    control.disabled = value || (needsReload && !["reset-data", "download-draft"].includes(control.id));
  });
  document.querySelector(".app-shell").setAttribute("aria-busy", String(value));
  document.querySelector(".header-status").classList.toggle("is-offline", needsReload && !value);
}

async function saveState(message = "Changes saved") {
  let source;
  setBusy(true);
  saveMessage.textContent = "Calculating with Mech and saving to people.mcfg…";
  saveMessage.className = "save-message";
  try {
    source = PeopleDatabase.stringifyDocument(PeopleDatabase.fromState(state, false));
    acceptSnapshot(await databaseRequest({ method: "PUT", headers: { "Content-Type": "application/json", "If-Match": `"${revision}"` }, body: JSON.stringify({ source }) }));
    failedDraft = null;
    document.querySelector("#download-draft").hidden = true;
    saveMessage.textContent = `${message} · saved to people.mcfg`;
    saveMessage.className = "save-message saved";
  } catch (error) {
    failedDraft = source || failedDraft;
    document.querySelector("#download-draft").hidden = !failedDraft;
    state = clone(committedState);
    needsReload = true;
    document.querySelector("#engine-status").textContent = "Save not confirmed — reload before editing";
    saveMessage.textContent = `Save not confirmed: ${error.message} Download the unsaved draft if needed, then reload database.`;
    saveMessage.className = "save-message error";
  } finally {
    setBusy(false);
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function personById(id) {
  return state.people.find((person) => person.id === id);
}

function attributesFor(personId) {
  return views.attributes
    .filter((attribute) => attribute.personId === personId)
    .sort((left, right) => left.category.localeCompare(right.category) || left.value.localeCompare(right.value));
}

function availableAttributesFor(personId) {
  return state.attributeCatalog
    .filter((attribute) => !state.personAttributes.some((link) => link.personId === personId && link.attributeId === attribute.id))
    .sort((left, right) => left.category.localeCompare(right.category) || left.value.localeCompare(right.value));
}

function attributeKey(category, value) {
  return JSON.stringify([String(category).trim().toLowerCase(), String(value).trim().toLowerCase()]);
}

function relationshipExists(fromId, toId) {
  return state.relationships.some((relationship) => (
    (relationship.from === fromId && relationship.to === toId)
    || (relationship.from === toId && relationship.to === fromId)
  ));
}

function nextId(items) {
  const id = items.reduce((largest, item) => Math.max(largest, Number(item.id) || 0), 0) + 1;
  if (!Number.isSafeInteger(id)) throw new Error("No more IDs are available within browser precision");
  return id;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function interactionsFor(personId) {
  return state.interactions
    .filter((interaction) => interaction.personId === personId)
    .sort((left, right) => right.date.localeCompare(left.date));
}

function derivedPerson(person) {
  return { ...person, ...views.people.find((view) => view.id === person.id) };
}

function renderMap() {
  networkMap.setData(state.people.map(derivedPerson), state.relationships, selectedId);
}

function renderPanel(person) {
  if (!person) {
    panel.innerHTML = '<div class="empty-state">Select or add a person to begin.</div>';
    return;
  }

  const current = derivedPerson(person);
  const personAttributes = attributesFor(person.id);
  const availableAttributes = availableAttributesFor(person.id);
  const availablePeople = state.people
    .filter((candidate) => candidate.id !== person.id && !relationshipExists(person.id, candidate.id))
    .sort((left, right) => left.name.localeCompare(right.name));
  const attributeCategories = [...new Set(availableAttributes.map((attribute) => attribute.category))].sort();
  const attributeValues = [...new Set(availableAttributes.map((attribute) => attribute.value))].sort();
  const categoryOptions = attributeCategories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join("");
  const valueOptions = attributeValues.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("");
  const attributeOptions = availableAttributes.map((attribute) => `<option value="${attribute.id}">${escapeHtml(attribute.category)} · ${escapeHtml(attribute.value)}</option>`).join("");
  const catalogCategories = [...new Set(state.attributeCatalog.map((attribute) => attribute.category))].sort();
  const catalogValues = [...new Set(state.attributeCatalog.map((attribute) => attribute.value))].sort();
  const categorySuggestions = catalogCategories.map((category) => `<option value="${escapeHtml(category)}"></option>`).join("");
  const valueSuggestions = catalogValues.map((value) => `<option value="${escapeHtml(value)}"></option>`).join("");
  const connectionOptions = availablePeople.map((candidate) => `<option value="${candidate.id}">${escapeHtml(candidate.name || "Unnamed person")}</option>`).join("");
  const related = state.relationships
    .filter((relationship) => relationship.from === person.id || relationship.to === person.id)
    .map((relationship) => {
      const otherId = relationship.from === person.id ? relationship.to : relationship.from;
      const other = personById(otherId);
      if (!other) return "";
      return `<div class="relationship-item"><div><div class="relationship-name">${escapeHtml(other.name)}</div><div class="relationship-kind">${escapeHtml(relationship.kind)} · ${escapeHtml(relationship.note)}</div></div><span class="relationship-strength">${escapeHtml(relationship.strength)}</span></div>`;
    }).join("");
  const history = interactionsFor(person.id).map((interaction) => `
    <div class="interaction-item">
      <div class="interaction-meta"><span>${escapeHtml(interaction.date)}</span><span>${escapeHtml(interaction.kind)}</span></div>
      <div>${escapeHtml(interaction.summary)}</div>
    </div>
  `).join("");

  panel.innerHTML = `
    <div class="person-summary">
      <div>
        <p class="eyebrow">Editable profile</p>
        <h3 id="person-name">${escapeHtml(person.name || "Unnamed person")}</h3>
        <p class="subtitle">Each submitted edit saves to people.mcfg. Mech calculates contact health.</p>
      </div>
      <span class="status-badge ${escapeHtml(current.status)}">${escapeHtml(current.status)}</span>
    </div>
    <div class="health-row"><span class="detail-label">Contact health</span><span class="health-value">${current.daysSinceContact === null ? "No contact" : `${current.daysSinceContact} days ago`}</span></div>
    <form id="profile-form" class="editor-form">
      <label>Name<input name="name" value="${escapeHtml(person.name)}" required /></label>
      <label>Background<textarea name="background" rows="2">${escapeHtml(person.background)}</textarea></label>
      <div class="form-grid">
        <label>Birthday<input name="birthday" type="date" value="${escapeHtml(person.birthday)}" /></label>
        <label>Address date<input name="addressDate" type="date" value="${escapeHtml(person.addressDate)}" /></label>
      </div>
      <label>Current address<input name="address" value="${escapeHtml(person.address)}" /></label>
      <button class="button primary" type="submit">Save profile</button>
    </form>
    <section class="panel-section"><h4>Attributes</h4>
      <div class="attribute-search-grid">
        <label>Search<input id="attribute-search" type="search" placeholder="Search category or value" /></label>
        <label>Category<select id="attribute-category"><option value="">All categories</option>${categoryOptions}</select></label>
        <label>Value<select id="attribute-value"><option value="">All values</option>${valueOptions}</select></label>
      </div>
      <div class="attribute-assignment"><select id="attribute-select" aria-label="Existing attribute"><option value="">Choose existing attribute</option>${attributeOptions || '<option value="" disabled>All attributes already assigned</option>'}</select><button id="add-existing-attribute" class="button secondary" type="button"${availableAttributes.length ? "" : " disabled"}>Assign</button></div>
      <p class="field-hint attribute-help">Search or filter first, then select an existing attribute to avoid duplicates.</p>
      <button id="create-attribute-toggle" class="button quiet" type="button">Create new attribute</button>
      <form id="new-attribute-form" class="editor-form" hidden>
        <div class="form-grid"><label>Category<input id="new-attribute-category" name="category" list="attribute-category-suggestions" placeholder="Search or type a category" autocomplete="off" required /><datalist id="attribute-category-suggestions">${categorySuggestions}</datalist></label><label>Value<input id="new-attribute-value" name="value" list="attribute-value-suggestions" placeholder="Search or type a value" autocomplete="off" required /><datalist id="attribute-value-suggestions">${valueSuggestions}</datalist></label></div>
        <p class="field-hint attribute-help">These fields suggest existing entries. You may also type a new category or value.</p>
        <button class="button secondary" type="submit">Create and assign</button>
      </form>
      <div class="tag-list assigned-attributes">${personAttributes.map((attribute) => `<span class="tag"><span>${escapeHtml(attribute.category)} · ${escapeHtml(attribute.value)}</span><button class="remove-tag" type="button" data-remove-attribute="${attribute.id}" aria-label="Remove ${escapeHtml(attribute.value)}">×</button></span>`).join("") || '<span class="empty-state compact-empty">No attributes assigned yet.</span>'}</div>
    </section>
    <section class="panel-section"><h4>Record interaction</h4>
      <form id="interaction-form" class="editor-form">
        <div class="form-grid"><label>Date<input name="date" type="date" value="${today()}" required /></label><label>Type<select name="kind"><option>meeting</option><option>message</option><option>call</option><option>email</option><option>note</option></select></div>
        <label>Summary<textarea name="summary" rows="2" placeholder="What happened?" required></textarea></label>
        <button class="button secondary" type="submit">Record interaction</button>
      </form>
    </section>
    <section class="panel-section"><h4>Lifecycle</h4><div class="action-row"><button class="button secondary" type="button" data-action="reconnect">Record reconnection</button>${current.status === "archived" ? '<button class="button secondary" type="button" data-action="restore">Restore active</button>' : '<button class="button danger" type="button" data-action="archive">Archive</button>'}</div></section>
    <section class="panel-section"><h4>Recent interactions</h4><div class="interaction-list">${history || '<span class="empty-state compact-empty">No interactions yet.</span>'}</div></section>
    <section class="panel-section"><h4>Connections</h4><div class="relationship-list">${related || '<span class="empty-state compact-empty">No connections yet.</span>'}</div>
      <form id="connect-form" class="editor-form connection-form">
        <label>Connect to<select name="personId" required><option value="">Choose a person</option>${connectionOptions || '<option value="" disabled>No unconnected people</option>'}</select></label>
        <div class="form-grid"><label>Type<select name="kind"><option>friend</option><option>research collaborator</option><option>professional</option><option>professor</option><option>family</option><option>other</option></select></label><label>Strength<select name="strength"><option>normal</option><option>strong</option><option>weak</option></select></label></div>
        <label>Note<input name="note" placeholder="How are they connected?" /></label>
        <button class="button secondary" type="submit"${availablePeople.length ? "" : " disabled"}>Connect person</button>
      </form>
    </section>
    <div class="detail-list compact-details"><div class="detail-row"><span class="detail-label">Last contact</span><span class="detail-value">${escapeHtml(current.lastContact)}</span></div><div class="detail-row"><span class="detail-label">Address age</span><span class="detail-value">${current.addressAgeDays === null ? "Unknown" : `${current.addressAgeDays} days`}</span></div></div>
  `;

  panel.querySelector("#profile-form").addEventListener("submit", saveProfile);
  panel.querySelector("#attribute-search").addEventListener("input", updateAttributeOptions);
  panel.querySelector("#attribute-category").addEventListener("change", updateAttributeOptions);
  panel.querySelector("#attribute-value").addEventListener("change", updateAttributeOptions);
  panel.querySelector("#add-existing-attribute").addEventListener("click", assignExistingAttribute);
  panel.querySelector("#create-attribute-toggle").addEventListener("click", () => {
    const form = panel.querySelector("#new-attribute-form");
    form.hidden = !form.hidden;
  });
  panel.querySelector("#new-attribute-form").addEventListener("submit", createAttribute);
  panel.querySelector("#new-attribute-category").addEventListener("input", updateNewAttributeValueSuggestions);
  panel.querySelector("#interaction-form").addEventListener("submit", recordInteraction);
  panel.querySelector("#connect-form").addEventListener("submit", addConnection);
  panel.querySelectorAll("[data-remove-attribute]").forEach((button) => button.addEventListener("click", () => removeAttribute(Number(button.dataset.removeAttribute))));
  panel.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", () => lifecycleAction(button.dataset.action)));
}

function updateAttributeOptions() {
  const person = personById(selectedId);
  if (!person) return;
  const search = panel.querySelector("#attribute-search").value.trim().toLowerCase();
  const category = panel.querySelector("#attribute-category").value;
  const value = panel.querySelector("#attribute-value").value;
  const select = panel.querySelector("#attribute-select");
  const assignButton = panel.querySelector("#add-existing-attribute");
  const matching = availableAttributesFor(person.id).filter((attribute) => {
    const matchesSearch = !search || `${attribute.category} ${attribute.value}`.toLowerCase().includes(search);
    const matchesCategory = !category || attribute.category === category;
    const matchesValue = !value || attribute.value === value;
    return matchesSearch && matchesCategory && matchesValue;
  });
  select.innerHTML = `<option value="">Choose existing attribute</option>${matching.map((attribute) => `<option value="${attribute.id}">${escapeHtml(attribute.category)} · ${escapeHtml(attribute.value)}</option>`).join("") || '<option value="" disabled>No matching attributes</option>'}`;
  assignButton.disabled = matching.length === 0;
}

function updateNewAttributeValueSuggestions() {
  const category = panel.querySelector("#new-attribute-category").value.trim().toLowerCase();
  const values = [...new Set(state.attributeCatalog
    .filter((attribute) => !category || attribute.category.toLowerCase() === category)
    .map((attribute) => attribute.value))].sort();
  panel.querySelector("#attribute-value-suggestions").innerHTML = values.map((value) => `<option value="${escapeHtml(value)}"></option>`).join("");
}

function selectPerson(id) {
  if (busy || !personById(id)) return;
  selectedId = id;
  render();
}

function render() {
  if (selectedId !== null && !personById(selectedId)) selectedId = state.people[0]?.id ?? null;
  renderMap();
  renderPanel(personById(selectedId));
}

function addLifecycleEvent(personId, kind, note, date = today()) {
  state.lifecycleEvents.push({ id: nextId(state.lifecycleEvents), personId, date, kind, note });
}

async function saveProfile(event) {
  event.preventDefault();
  if (busy || needsReload) return;
  const person = personById(selectedId);
  if (!person) return;
  const form = new FormData(event.currentTarget);
  person.name = String(form.get("name") || "Unnamed person").trim();
  person.background = String(form.get("background") || "").trim();
  person.birthday = String(form.get("birthday") || "");
  const address = String(form.get("address") || "").trim();
  let addressDate = String(form.get("addressDate") || "");
  if (address !== person.address || addressDate !== person.addressDate) {
    addressDate ||= today();
    state.addressLog ||= [];
    state.addressLog.push({ id: nextId(state.addressLog), personId: person.id, timestamp: addressDate,
      dateDay: PeopleDatabase.dateDay(addressDate), address, source: "manual" });
  }
  await saveState("Profile updated");
  render();
}

async function assignExistingAttribute() {
  if (busy || needsReload) return;
  const person = personById(selectedId);
  const attributeId = Number(panel.querySelector("#attribute-select").value);
  if (!person || !attributeId || !state.attributeCatalog.some((attribute) => attribute.id === attributeId)) return;
  if (state.personAttributes.some((link) => link.personId === person.id && link.attributeId === attributeId)) return;
  state.personAttributes.push({ personId: person.id, attributeId });
  await saveState("Existing attribute assigned");
  render();
}

async function createAttribute(event) {
  event.preventDefault();
  if (busy || needsReload) return;
  const person = personById(selectedId);
  if (!person) return;
  const form = new FormData(event.currentTarget);
  const category = String(form.get("category") || "").trim();
  const value = String(form.get("value") || "").trim();
  if (!category || !value) return;
  const key = attributeKey(category, value);
  let attribute = state.attributeCatalog.find((candidate) => attributeKey(candidate.category, candidate.value) === key);
  const reused = Boolean(attribute);
  const alreadyAssigned = attribute && state.personAttributes.some((link) => link.personId === person.id && link.attributeId === attribute.id);
  if (!attribute) {
    attribute = { id: nextId(state.attributeCatalog), category, value };
    state.attributeCatalog.push(attribute);
  }
  if (!alreadyAssigned) state.personAttributes.push({ personId: person.id, attributeId: attribute.id });
  await saveState(alreadyAssigned ? "Attribute already assigned" : reused ? "Existing attribute assigned" : "New attribute created and assigned");
  render();
}

async function removeAttribute(attributeId) {
  if (busy || needsReload) return;
  const person = personById(selectedId);
  if (!person) return;
  state.personAttributes = state.personAttributes.filter((link) => !(link.personId === person.id && link.attributeId === attributeId));
  await saveState("Attribute removed from person");
  render();
}

async function addConnection(event) {
  event.preventDefault();
  if (busy || needsReload) return;
  const person = personById(selectedId);
  if (!person) return;
  const form = new FormData(event.currentTarget);
  const otherId = Number(form.get("personId"));
  if (!otherId || !personById(otherId) || otherId === person.id || relationshipExists(person.id, otherId)) return;
  state.relationships.push({
    id: nextId(state.relationships),
    from: person.id,
    to: otherId,
    kind: String(form.get("kind") || "other"),
    strength: String(form.get("strength") || "normal"),
    note: String(form.get("note") || "").trim(),
  });
  await saveState("Connection added");
  render();
}

async function recordInteraction(event) {
  event.preventDefault();
  if (busy || needsReload) return;
  const person = personById(selectedId);
  if (!person) return;
  const form = new FormData(event.currentTarget);
  const date = String(form.get("date") || today());
  const kind = String(form.get("kind") || "note");
  const summary = String(form.get("summary") || "").trim();
  if (!summary) return;
  state.interactions.push({ id: nextId(state.interactions), personId: person.id, date, kind, summary });
  person.manualStatus = undefined;
  addLifecycleEvent(person.id, kind === "reconnected" ? "reconnected" : "contacted", summary, date);
  await saveState("Interaction recorded");
  render();
}

async function lifecycleAction(action) {
  if (busy || needsReload) return;
  const person = personById(selectedId);
  if (!person) return;
  if (action === "archive") {
    person.manualStatus = "archived";
    addLifecycleEvent(person.id, "archived", "Archived from the browser workspace");
    await saveState("Person archived");
  }
  if (action === "reconnect") {
    const summary = "Recorded reconnection from the lifecycle panel";
    state.interactions.push({ id: nextId(state.interactions), personId: person.id, date: today(), kind: "reconnected", summary });
    person.manualStatus = undefined;
    addLifecycleEvent(person.id, "reconnected", summary);
    await saveState("Reconnection recorded");
  }
  if (action === "restore") {
    person.manualStatus = undefined;
    addLifecycleEvent(person.id, "restored", "Restored to the active lifecycle");
    await saveState("Person restored");
  }
  render();
}

async function addPerson() {
  if (busy || needsReload) return;
  const person = {
    id: nextId(state.people),
    name: "New person",
    background: "",
    birthday: "",
    address: "",
    addressDate: "",
  };
  state.people.push(person);
  selectedId = person.id;
  await saveState("New person added");
  render();
}

function exportData() {
  let source;
  try {
    source = PeopleDatabase.stringifyDocument(PeopleDatabase.fromState(state, false));
  } catch (error) {
    saveMessage.textContent = `Export failed: ${error.message}`;
    saveMessage.className = "save-message error";
    return;
  }
  downloadSource(source, `people-relationship-manager-${today()}.mcfg`);
  saveMessage.textContent = "MCFG export downloaded";
  saveMessage.className = "save-message saved";
}

function downloadSource(source, filename) {
  const blob = new Blob([source], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function importData(event) {
  if (busy || needsReload) return;
  const file = event.target.files[0];
  if (!file) return;
  setBusy(true);
  try {
    if (file.size > 1024 * 1024) throw new Error("The maximum import size is 1 MB");
    const source = await file.text();
    const imported = source.trimStart().startsWith("{")
      ? PeopleDatabase.fromState(normalizeState(JSON.parse(source)))
      : PeopleDatabase.parseDocument(source);
    if (!window.confirm("Replace the actual database with this import? The server will back up the current file first.")) return;
    state = PeopleDatabase.toState(imported);
    selectedId = state.people[0]?.id ?? null;
    await saveState("Database imported");
    render();
  } catch (error) {
    saveMessage.textContent = `Import failed: ${error.message}`;
    saveMessage.className = "save-message error";
  } finally {
    event.target.value = "";
    setBusy(false);
  }
}

async function resetData() {
  if (busy) return;
  await initialize();
}

async function recoverBrowserData() {
  if (busy || needsReload) return;
  try {
    const previous = loadStoredState();
    if (!previous) throw new Error("No old browser save exists at this address");
    if (!window.confirm("Replace people.mcfg with the old browser save? A file backup will be made first.")) return;
    state = previous;
    await saveState("Old browser save imported");
    render();
  } catch (error) {
    saveMessage.textContent = error.message;
    saveMessage.className = "save-message error";
  }
}

document.querySelector("#add-person").addEventListener("click", addPerson);
document.querySelector("#export-data").addEventListener("click", exportData);
document.querySelector("#import-data").addEventListener("change", importData);
document.querySelector("#reset-data").addEventListener("click", resetData);
document.querySelector("#recover-browser").addEventListener("click", recoverBrowserData);
document.querySelector("#download-draft").addEventListener("click", () => {
  if (failedDraft) downloadSource(failedDraft, `unsaved-draft-${today()}.mcfg`);
});

async function initialize() {
  setBusy(true);
  saveMessage.textContent = "Reading people.mcfg and calculating with Mech…";
  saveMessage.className = "save-message";
  try {
    acceptSnapshot(await databaseRequest());
    selectedId = personById(selectedId) ? selectedId : state.people[0]?.id ?? null;
    saveMessage.textContent = "Database loaded · Mech results ready";
    saveMessage.className = "save-message saved";
  } catch (error) {
    state ||= clone(EMPTY_STATE);
    needsReload = true;
    saveMessage.textContent = `Could not load database: ${error.message}`;
    saveMessage.className = "save-message error";
    document.querySelector("#engine-status").textContent = "Backend unavailable — editing paused";
  } finally {
    setBusy(false);
  }
  render();
}

try {
  document.querySelector("#recover-browser").hidden = !(localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY));
} catch {}
window.addEventListener("beforeunload", (event) => {
  if (busy || failedDraft) { event.preventDefault(); event.returnValue = ""; }
});
initialize();
