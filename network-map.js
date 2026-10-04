class PeopleNetworkMap {
  constructor(element, onSelect) {
    this.element = element;
    this.onSelect = onSelect;
    this.positions = new Map();
    this.people = [];
    this.relationships = [];
    this.camera = { x: 0, y: 0, scale: 1 };
    this.pointers = new Map();
    this.nodes = new Map();
    this.fitted = false;
    this.element.innerHTML = '<div class="map-world"><svg class="map-lines" aria-hidden="true"></svg></div><div class="empty-state" hidden>No people yet. Add your first person.</div>';
    this.world = element.querySelector(".map-world");
    this.lines = element.querySelector(".map-lines");
    this.search = document.querySelector("#map-search");
    this.results = document.querySelector("#map-results");
    this.searchStatus = document.querySelector("#map-search-status");
    this.search.addEventListener("input", () => this.searchPeople());
    this.search.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        this.search.value = "";
        this.searchPeople();
      } else if (event.key === "Enter" || event.key === "ArrowDown") {
        const first = this.results.querySelector("button");
        if (first) {
          event.preventDefault();
          if (event.key === "Enter") first.click();
          else first.focus();
        }
      }
    });
    this.results.addEventListener("keydown", (event) => {
      const buttons = [...this.results.querySelectorAll("button")];
      const index = buttons.indexOf(document.activeElement);
      if (["ArrowDown", "ArrowUp", "Escape"].includes(event.key)) {
        event.preventDefault();
        if (event.key === "Escape" || (event.key === "ArrowUp" && index === 0)) this.search.focus();
        else buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }
    });
    document.querySelector("#map-zoom-in").addEventListener("click", () => this.zoom(1.25));
    document.querySelector("#map-zoom-out").addEventListener("click", () => this.zoom(0.8));
    document.querySelector("#map-fit").addEventListener("click", () => this.fit());
    document.querySelector("#map-center").addEventListener("click", () => this.focusPerson(this.selectedId));
    document.querySelector("#map-arrange").addEventListener("click", () => {
      this.arrange();
      this.drawPositions();
      this.fit();
    });
    document.querySelector("#map-expand").addEventListener("click", (event) => {
      const expanded = document.querySelector(".workspace").classList.toggle("is-map-expanded");
      event.currentTarget.textContent = expanded ? "Collapse map" : "Expand map";
      event.currentTarget.setAttribute("aria-expanded", String(expanded));
    });
    element.addEventListener("wheel", (event) => {
      event.preventDefault();
      const point = this.point(event);
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1);
      this.zoom(Math.exp(-Math.max(-300, Math.min(300, delta)) * 0.002), point);
    }, { passive: false });
    element.addEventListener("pointerdown", (event) => this.pointerDown(event));
    element.addEventListener("pointermove", (event) => this.pointerMove(event));
    for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) {
      element.addEventListener(name, (event) => this.pointerEnd(event));
    }
    element.addEventListener("click", (event) => {
      const node = event.target.closest(".person-node");
      if (node && (!this.suppressClick || event.detail === 0)) this.onSelect(Number(node.dataset.personId));
      this.suppressClick = false;
    });
    element.addEventListener("keydown", (event) => {
      if (event.target !== element) return;
      const shifts = { ArrowLeft: [60, 0], ArrowRight: [-60, 0], ArrowUp: [0, 60], ArrowDown: [0, -60] };
      if (shifts[event.key]) {
        event.preventDefault();
        this.camera.x += shifts[event.key][0];
        this.camera.y += shifts[event.key][1];
        this.applyCamera();
      } else if (["+", "=", "-", "f", "F"].includes(event.key)) {
        event.preventDefault();
        if (event.key.toLowerCase() === "f") this.fit();
        else this.zoom(event.key === "-" ? 0.8 : 1.25);
      }
    });
    this.size = { width: element.clientWidth, height: element.clientHeight };
    new ResizeObserver(() => {
      const next = { width: element.clientWidth, height: element.clientHeight };
      this.camera.x += (next.width - this.size.width) / 2;
      this.camera.y += (next.height - this.size.height) / 2;
      this.size = next;
      this.applyCamera();
    }).observe(element);
  }

  arrange() {
    const neighbors = new Map(this.people.map((person) => [person.id, []]));
    for (const edge of this.relationships) {
      neighbors.get(edge.from)?.push(edge.to);
      neighbors.get(edge.to)?.push(edge.from);
    }
    const order = [];
    const visited = new Set();
    for (const person of this.people) {
      const queue = [person.id];
      for (let index = 0; index < queue.length; index += 1) {
        const id = queue[index];
        if (visited.has(id) || !neighbors.has(id)) continue;
        visited.add(id);
        order.push(id);
        queue.push(...neighbors.get(id).filter((neighbor) => !visited.has(neighbor)));
      }
    }
    const columns = Math.max(1, Math.ceil(Math.sqrt(order.length)));
    this.positions.clear();
    order.forEach((id, index) => {
      const row = Math.floor(index / columns);
      const column = row % 2 ? columns - 1 - index % columns : index % columns;
      this.positions.set(id, { x: column * 260, y: row * 150 });
    });
  }

  setData(people, relationships, selectedId) {
    const initial = !this.positions.size;
    this.people = people;
    this.relationships = relationships;
    this.selectedId = selectedId;
    const ids = new Set(people.map((person) => person.id));
    for (const id of this.positions.keys()) if (!ids.has(id)) this.positions.delete(id);
    if (initial) this.arrange();
    else {
      for (const person of people) {
        if (this.positions.has(person.id)) continue;
        const right = Math.max(0, ...[...this.positions.values()].map((position) => position.x));
        this.positions.set(person.id, { x: right + 260, y: 0 });
      }
    }
    for (const [id, node] of this.nodes) {
      if (!ids.has(id)) { node.remove(); this.nodes.delete(id); }
    }
    for (const person of people) {
      let node = this.nodes.get(person.id);
      if (!node) {
        node = document.createElement("button");
        node.type = "button";
        node.dataset.personId = person.id;
        node.innerHTML = '<span class="node-name"></span><span class="node-status"></span>';
        node.addEventListener("focus", () => {
          if (!this.pointers.size) this.ensureVisible(person.id);
        });
        this.world.append(node);
        this.nodes.set(person.id, node);
      }
      node.className = `person-node${person.id === selectedId ? " is-selected" : ""}`;
      node.setAttribute("aria-label", `Edit ${person.name || "Unnamed person"}, person ${person.id}`);
      node.setAttribute("aria-pressed", String(person.id === selectedId));
      node.title = person.name;
      node.querySelector(".node-name").textContent = person.name || "Unnamed person";
      node.querySelector(".node-status").textContent = person.status;
    }
    this.lines.replaceChildren();
    this.edges = relationships.filter((edge) => ids.has(edge.from) && ids.has(edge.to)).map((edge) => {
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("class", `map-line${edge.from === selectedId || edge.to === selectedId ? " is-selected" : ""}`);
      this.lines.append(line);
      return { ...edge, line };
    });
    this.element.querySelector(".empty-state").hidden = people.length > 0;
    for (const id of ["map-fit", "map-arrange", "map-center"]) document.getElementById(id).disabled = !people.length;
    this.drawPositions();
    if (people.length && (!this.fitted || initial)) { this.fit(); this.fitted = true; }
    if (!people.length) this.fitted = false;
    this.searchPeople();
  }

  drawPositions() {
    for (const [id, node] of this.nodes) {
      const position = this.positions.get(id);
      node.style.left = `${position.x}px`;
      node.style.top = `${position.y}px`;
    }
    for (const edge of this.edges || []) {
      const from = this.positions.get(edge.from);
      const to = this.positions.get(edge.to);
      for (const [key, value] of Object.entries({ x1: from.x, y1: from.y, x2: to.x, y2: to.y })) edge.line.setAttribute(key, value);
    }
  }

  applyCamera() {
    const { x, y, scale } = this.camera;
    this.world.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    document.querySelector("#map-zoom").textContent = `${Math.round(scale * 100)}%`;
  }

  zoom(factor, point = { x: this.element.clientWidth / 2, y: this.element.clientHeight / 2 }) {
    const previous = this.camera.scale;
    this.camera.scale = Math.max(0.02, Math.min(3, previous * factor));
    this.camera.x = point.x - (point.x - this.camera.x) * this.camera.scale / previous;
    this.camera.y = point.y - (point.y - this.camera.y) * this.camera.scale / previous;
    this.applyCamera();
  }

  fit() {
    if (!this.positions.size) return;
    const points = [...this.positions.values()];
    const left = Math.min(...points.map((point) => point.x)) - 105;
    const right = Math.max(...points.map((point) => point.x)) + 105;
    const top = Math.min(...points.map((point) => point.y)) - 50;
    const bottom = Math.max(...points.map((point) => point.y)) + 50;
    const scale = Math.max(0.02, Math.min(1, (this.element.clientWidth - 48) / (right - left), (this.element.clientHeight - 48) / (bottom - top)));
    this.camera = { scale, x: this.element.clientWidth / 2 - (left + right) * scale / 2, y: this.element.clientHeight / 2 - (top + bottom) * scale / 2 };
    this.applyCamera();
  }

  focusPerson(id, focusButton = false) {
    const position = this.positions.get(id);
    if (!position) return;
    const scale = Math.min(1.2, Math.max(0.3, (this.element.clientWidth - 32) / 200));
    this.camera = { scale, x: this.element.clientWidth / 2 - position.x * scale, y: this.element.clientHeight / 2 - position.y * scale };
    this.applyCamera();
    if (focusButton) this.nodes.get(id)?.focus({ preventScroll: true });
  }

  ensureVisible(id) {
    const position = this.positions.get(id);
    const { x, y, scale } = this.camera;
    const screenX = x + position.x * scale;
    const screenY = y + position.y * scale;
    if (screenX < 105 * scale || screenX > this.element.clientWidth - 105 * scale || screenY < 50 * scale || screenY > this.element.clientHeight - 50 * scale) this.focusPerson(id);
  }

  searchPeople() {
    const query = this.search.value.trim().toLocaleLowerCase();
    this.results.replaceChildren();
    this.results.hidden = !query;
    if (!query) { this.searchStatus.textContent = ""; return; }
    const matches = this.people.filter((person) => person.name.toLocaleLowerCase().includes(query));
    this.searchStatus.textContent = matches.length ? `${matches.length} ${matches.length === 1 ? "match" : "matches"}. Choose a person to jump to them.` : "No matching people.";
    for (const person of matches) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `${person.name} · #${person.id} · ${person.status}`;
      button.addEventListener("click", () => {
        this.search.value = "";
        this.onSelect(person.id);
        this.focusPerson(person.id, true);
        this.searchStatus.textContent = `Showing ${person.name}.`;
      });
      item.append(button);
      this.results.append(item);
    }
  }

  point(event) {
    const bounds = this.element.getBoundingClientRect();
    return { x: event.clientX - bounds.left - this.element.clientLeft, y: event.clientY - bounds.top - this.element.clientTop };
  }

  pointerDown(event) {
    if (event.button !== 0) return;
    this.suppressClick = false;
    const point = this.point(event);
    this.pointers.set(event.pointerId, point);
    const node = event.target.closest(".person-node");
    this.drag = { point, id: node ? Number(node.dataset.personId) : null, moved: false };
    if (this.pointers.size > 1) { this.drag = null; this.suppressClick = true; }
    this.pinch = this.pinchState();
    this.element.setPointerCapture(event.pointerId);
    this.element.classList.add("is-dragging");
  }

  pinchState() {
    if (this.pointers.size < 2) return null;
    const [first, second] = this.pointers.values();
    return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2, distance: Math.max(1, Math.hypot(first.x - second.x, first.y - second.y)) };
  }

  pointerMove(event) {
    if (!this.pointers.has(event.pointerId)) return;
    const point = this.point(event);
    this.pointers.set(event.pointerId, point);
    const pinch = this.pinchState();
    if (pinch && this.pinch) {
      this.zoom(pinch.distance / this.pinch.distance, this.pinch);
      this.camera.x += pinch.x - this.pinch.x;
      this.camera.y += pinch.y - this.pinch.y;
      this.applyCamera();
      this.pinch = pinch;
      this.suppressClick = true;
      return;
    }
    if (!this.drag) return;
    const deltaX = point.x - this.drag.point.x;
    const deltaY = point.y - this.drag.point.y;
    if (!this.drag.moved && Math.hypot(deltaX, deltaY) < 4) return;
    this.drag.moved = true;
    this.suppressClick = true;
    if (this.drag.id !== null) {
      const position = this.positions.get(this.drag.id);
      position.x += deltaX / this.camera.scale;
      position.y += deltaY / this.camera.scale;
      this.drawPositions();
    } else {
      this.camera.x += deltaX;
      this.camera.y += deltaY;
      this.applyCamera();
    }
    this.drag.point = point;
  }

  pointerEnd(event) {
    if (!this.pointers.has(event.pointerId)) return;
    const clickedId = this.drag && !this.drag.moved && !this.suppressClick ? this.drag.id : null;
    this.pointers.delete(event.pointerId);
    this.drag = null;
    this.pinch = this.pinchState();
    if (!this.pointers.size) this.element.classList.remove("is-dragging");
    if (event.type === "pointerup" && clickedId !== null) {
      this.suppressClick = true;
      this.onSelect(clickedId);
    }
  }
}
