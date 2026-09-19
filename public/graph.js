// Always animate logs/tree_demo.json in its stored states[] order.
class DiscoveryGraph {
  constructor(complete) {
    this.complete = complete;
    this.panel = document.getElementById('discovery-graph');
    this.canvas = document.getElementById('graph-canvas');
    this.progress = document.getElementById('graph-progress');
    document.getElementById('graph-fit').onclick = () => this.setScale(Math.min(1,
      (document.getElementById('graph-viewport').clientWidth - 16) / this.width));
    document.getElementById('graph-zoom-in').onclick = () => this.setScale(Math.min(1.5, this.scale * 1.4));
    document.getElementById('graph-zoom-out').onclick = () => this.setScale(Math.max(0.03, this.scale / 1.4));
    this.reset();
  }

  reset(open = false) {
    clearTimeout(this.timer);
    this.generation = (this.generation || 0) + 1;
    this.run = null;
    this.map = null;
    this.loading = false;
    this.positions = new Map();
    this.treeEdges = new Set();
    this.width = 300;
    this.height = 360;
    this.scale = 1;
    this.nodes = new Map();
    this.edges = new Set();
    this.busy = false;
    this.timer = null;
    this.canvas.replaceChildren();
    this.canvas.style.width = '';
    this.canvas.style.height = '';
    this.setScale(1);
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('aria-hidden', 'true');
    this.canvas.append(this.svg);
    this.panel.open = open;
    this.progress.textContent = open ? 'Loading demo tree…' : 'Demo tree ready to load';
    document.getElementById('graph-coverage').textContent = '';
  }

  update(run) {
    if (this.run && this.run.id !== run.id) this.reset();
    const previousStatus = this.run?.status;
    const active = ['starting', 'discovering', 'previewing'].includes(run.status);
    if (!this.run && active) this.panel.open = true;
    this.run = run;
    if (!this.map) {
      if (!this.loading) {
        this.loading = true;
        const generation = this.generation;
        fetch('/api/demo-tree').then(async response => {
          const map = await response.json();
          if (!response.ok) throw new Error(map.error || 'Could not load demo tree');
          if (generation !== this.generation) return;
          this.map = map;
          this.layout();
          this.update(this.run);
        }).catch(error => {
          if (generation === this.generation) this.progress.textContent = error.message;
        });
      }
      return;
    }
    const map = this.map;
    if (map) {
      const counts = {};
      for (const edge of map.transitions) counts[edge.status] = (counts[edge.status] || 0) + 1;
      document.getElementById('graph-coverage').textContent =
        `Demo: tree_demo.json · ${map.states.length} nodes · ${Object.entries(counts).map(([status, count]) => `${count} ${status} transitions`).join(' · ')}`;
    }
    if (!active) {
      clearTimeout(this.timer); this.timer = null;
      for (const node of map?.states || []) this.addNode(node, false);
      this.drawEdges();
      this.progress.textContent = `${map.states.length} demo nodes · ${run.status.replaceAll('_', ' ')}`;
      if (previousStatus !== run.status && (run.graphPreviewComplete || !map)) this.panel.open = false;
      return;
    }
    this.drawEdges();
    if (!this.timer && !this.busy) this.step();
  }

  step() {
    this.timer = null;
    const run = this.run;
    if (!run) return;
    const next = this.map?.states.find(node => !this.nodes.has(node.id));
    if (next) {
      this.addNode(next, true);
      this.drawEdges();
      this.progress.textContent = `${this.nodes.size} / ${this.map.states.length} demo nodes revealed`;
      this.timer = setTimeout(() => this.step(), 1100);
    } else if (run.status === 'previewing' && !this.busy) {
      // The final node remains visible for a full beat before collapsing.
      this.busy = true;
      this.progress.textContent = `${this.nodes.size} demo nodes revealed · animation complete`;
      this.timer = setTimeout(async () => {
        this.timer = null;
        this.panel.open = false;
        const generation = this.generation;
        try { await this.complete(run.id); }
        catch (error) {
          if (generation !== this.generation) return;
          this.progress.textContent = `Waiting to continue: ${error.message}`;
          this.busy = false;
          if (this.run?.status === 'previewing') this.timer = setTimeout(() => this.step(), 2000);
        }
      }, 1100);
    } else {
      this.progress.textContent = `${this.nodes.size} nodes revealed · waiting for discovery`;
    }
  }

  layout() {
    // Choose a spanning forest before revealing nodes. Shared states and cycles
    // remain reference edges; neither can change a node's parent or depth.
    const children = new Map(this.map.states.map(node => [node.id, []]));
    const outgoing = new Map(this.map.states.map(node => [node.id, []]));
    for (const edge of this.map.transitions) {
      if (children.has(edge.from) && children.has(edge.to)) outgoing.get(edge.from).push(edge);
    }
    const visited = new Set(), roots = [];
    for (const id of [this.map.rootId, ...this.map.states.map(node => node.id)]) {
      if (visited.has(id) || !children.has(id)) continue;
      roots.push(id); visited.add(id);
      const queue = [id];
      for (let i = 0; i < queue.length; i++) {
        for (const edge of outgoing.get(queue[i])) {
          if (visited.has(edge.to)) continue;
          visited.add(edge.to);
          children.get(edge.from).push(edge.to);
          this.treeEdges.add(edge.id);
          queue.push(edge.to);
        }
      }
    }
    let leaf = 0;
    const place = (id, depth) => {
      const branches = children.get(id);
      const xs = branches.map(child => place(child, depth + 1));
      const x = xs.length ? (xs[0] + xs[xs.length - 1]) / 2 : 24 + leaf++ * 260;
      this.positions.set(id, { x, y: 24 + depth * 150, depth });
      return x;
    };
    for (const root of roots) place(root, 0);
    this.width = Math.max(300, ...[...this.positions.values()].map(p => p.x + 244));
    this.height = Math.max(360, ...[...this.positions.values()].map(p => p.y + 104));
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.setScale(1);
  }

  setScale(scale) {
    this.scale = scale;
    this.canvas.style.transform = `scale(${scale})`;
    const stage = document.getElementById('graph-stage');
    stage.style.width = `${this.width * scale}px`;
    stage.style.height = `${this.height * scale}px`;
    document.getElementById('graph-zoom').textContent = `${Math.round(scale * 100)}%`;
  }

  addNode(node, animate) {
    if (this.nodes.has(node.id)) return;
    const index = this.nodes.size;
    const { x, y, depth } = this.positions.get(node.id);
    const card = document.createElement('div');
    card.className = `graph-node${animate ? ' graph-node-enter' : ''}`;
    card.style.left = `${x}px`; card.style.top = `${y}px`;
    const label = document.createElement('small'); label.textContent = `${String(index + 1).padStart(2, '0')} / ${node.id}`;
    const task = document.createElement('strong'); task.textContent = node.task || node.snapshot.title || 'Website state';
    card.title = `${task.textContent}\n${node.snapshot.url}`;
    card.append(label, task); this.canvas.append(card);
    this.nodes.set(node.id, { x, y, depth });
    if (animate && this.panel.open && document.getElementById('view-browsers').classList.contains('active')) {
      const viewport = document.getElementById('graph-viewport');
      viewport.scrollTop = Math.max(0, (y + 40) * this.scale - viewport.clientHeight / 2);
      viewport.scrollLeft = Math.max(0, (x + 110) * this.scale - viewport.clientWidth / 2);
    }
  }

  drawEdges() {
    for (const edge of this.map?.transitions || []) {
      const from = this.nodes.get(edge.from), to = this.nodes.get(edge.to);
      if (!from || !to || this.edges.has(edge.id)) continue;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const branch = this.treeEdges.has(edge.id);
      if (branch) {
        const sx = from.x + 110, sy = from.y + 80, tx = to.x + 110, ty = to.y;
        const middle = (sy + ty) / 2;
        path.setAttribute('d', `M ${sx} ${sy} C ${sx} ${middle}, ${tx} ${middle}, ${tx} ${ty}`);
      } else {
        const sx = from.x + 220, sy = from.y + 40, tx = to.x + 220, ty = to.y + 40;
        const side = Math.max(sx, tx) + 20;
        path.setAttribute('d', `M ${sx} ${sy} C ${side} ${sy - 25}, ${side} ${ty + 25}, ${tx} ${ty}`);
      }
      path.setAttribute('class', `graph-edge ${edge.status}${branch ? '' : ' graph-reference'}`);
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = `${edge.id}: ${edge.from} → ${edge.to} (${edge.status}) ${edge.reason}`;
      path.append(title); this.svg.append(path); this.edges.add(edge.id);
    }
  }
}
