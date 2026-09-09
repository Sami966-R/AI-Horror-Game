'use strict';

/* ============================================================================
 * SUBLEVEL — a procedurally generated maze-horror game
 * Vanilla JavaScript + HTML5 Canvas, no game engine or external dependencies.
 *
 * Algorithms demonstrated:
 *   1. Maze generation  — randomized iterative recursive backtracker (DFS)
 *   2. Pursuit AI       — A* search (Manhattan heuristic, binary-heap open set)
 *   3. Fog of war       — breadth-first flood fill bounded by a vision radius
 *   4. Exit/spawn choice — full BFS distance map from the player's start cell
 *
 * Architecture:
 *   Maze        — grid model + generation. The single source of truth for
 *                 which walls exist, so collision only needs to ask Maze.
 *   Pathfinder  — stateless algorithms operating on a Maze (BFS + A*).
 *   GridActor   — shared "lives in one cell, renders with a smoothed pixel
 *                 position" behaviour for Player and Monster.
 *   Game        — state machine, input, canvas rendering, the render loop.
 * ============================================================================ */

// ---------------------------------------------------------------------------
// Difficulty presets
// ---------------------------------------------------------------------------
const DIFFICULTY = {
  small:  { cols: 15, rows: 11, cellSize: 38, visionRadius: 4, monsterInterval: 300, playerInterval: 150 },
  medium: { cols: 21, rows: 15, cellSize: 32, visionRadius: 4, monsterInterval: 260, playerInterval: 145 },
  large:  { cols: 27, rows: 19, cellSize: 26, visionRadius: 5, monsterInterval: 225, playerInterval: 140 },
};

// Cardinal directions, paired with each one's opposite (for carving walls
// symmetrically: removing the wall on one cell's N side must also remove
// the wall on its northern neighbor's S side).
const DIR = {
  N: { dr: -1, dc: 0, opposite: 'S' },
  S: { dr: 1, dc: 0, opposite: 'N' },
  E: { dr: 0, dc: 1, opposite: 'W' },
  W: { dr: 0, dc: -1, opposite: 'E' },
};
const DIR_KEYS = Object.keys(DIR);

const KEY_TO_DIR = {
  ArrowUp: 'N', KeyW: 'N',
  ArrowDown: 'S', KeyS: 'S',
  ArrowLeft: 'W', KeyA: 'W',
  ArrowRight: 'E', KeyD: 'E',
};

// ---------------------------------------------------------------------------
// MinHeap — small binary min-heap used as the A* open set's priority queue.
// Push/pop are both O(log n); using this instead of a linear scan for the
// lowest-f-score node is what keeps aStar() at O(E log V) instead of O(V^2).
// ---------------------------------------------------------------------------
class MinHeap {
  constructor() { this.items = []; }
  get size() { return this.items.length; }

  push(item, priority) {
    this.items.push({ item, priority });
    this._bubbleUp(this.items.length - 1);
  }

  pop() {
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0) {
      this.items[0] = last;
      this._bubbleDown(0);
    }
    return top ? top.item : undefined;
  }

  _bubbleUp(i) {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.items[parent].priority <= this.items[i].priority) break;
      [this.items[parent], this.items[i]] = [this.items[i], this.items[parent]];
      i = parent;
    }
  }

  _bubbleDown(i) {
    const n = this.items.length;
    for (;;) {
      let smallest = i;
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      if (l < n && this.items[l].priority < this.items[smallest].priority) smallest = l;
      if (r < n && this.items[r].priority < this.items[smallest].priority) smallest = r;
      if (smallest === i) break;
      [this.items[smallest], this.items[i]] = [this.items[i], this.items[smallest]];
      i = smallest;
    }
  }
}

// ---------------------------------------------------------------------------
// Maze — grid model + generation
// ---------------------------------------------------------------------------
class Maze {
  constructor(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.cells = new Array(cols * rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        this.cells[r * cols + c] = {
          row: r,
          col: c,
          walls: { N: true, S: true, E: true, W: true },
          visited: false,
        };
      }
    }
  }

  at(row, col) {
    if (row < 0 || col < 0 || row >= this.rows || col >= this.cols) return null;
    return this.cells[row * this.cols + col];
  }

  neighborInDir(cell, dirKey) {
    const d = DIR[dirKey];
    return this.at(cell.row + d.dr, cell.col + d.dc);
  }

  /** Cells reachable from `cell` through an OPEN wall — true maze
   *  connectivity, as opposed to raw grid adjacency. */
  openNeighbors(cell) {
    const out = [];
    for (const key of DIR_KEYS) {
      if (!cell.walls[key]) {
        const n = this.neighborInDir(cell, key);
        if (n) out.push(n);
      }
    }
    return out;
  }

  /**
   * Randomized iterative recursive backtracker. Produces a "perfect" maze:
   * every cell is reachable, there is exactly one path between any two
   * cells, and there are no loops (the carved passages form a spanning
   * tree over the grid graph). Iterative + an explicit stack is used
   * instead of true recursion so large grids can't blow the call stack.
   *
   * Time:  O(R*C) — every cell is pushed and popped exactly once.
   * Space: O(R*C) — the stack holds at most one entry per cell.
   */
  generate(rng) {
    const stack = [];
    const start = this.at(0, 0);
    start.visited = true;
    stack.push(start);

    while (stack.length > 0) {
      const current = stack[stack.length - 1];
      const unvisitedDirs = DIR_KEYS.filter((key) => {
        const n = this.neighborInDir(current, key);
        return n && !n.visited;
      });

      if (unvisitedDirs.length === 0) {
        stack.pop(); // dead end — backtrack
        continue;
      }

      const dirKey = unvisitedDirs[Math.floor(rng() * unvisitedDirs.length)];
      const next = this.neighborInDir(current, dirKey);

      // Knock down the wall on both sides of the shared edge.
      current.walls[dirKey] = false;
      next.walls[DIR[dirKey].opposite] = false;

      next.visited = true;
      stack.push(next);
    }

    return this;
  }
}

// ---------------------------------------------------------------------------
// Pathfinder — stateless BFS / A* over a Maze
// ---------------------------------------------------------------------------
const Pathfinder = {
  manhattan(a, b) {
    return Math.abs(a.row - b.row) + Math.abs(a.col - b.col);
  },

  /**
   * Full BFS from `start` over the whole maze, returning Map<cell, distance>.
   * Run once per maze at setup time to place the exit and the monster at
   * meaningful distances from the player's spawn.
   *
   * Time/Space: O(R*C) — every cell is enqueued and visited at most once.
   */
  bfsDistances(maze, start) {
    const dist = new Map([[start, 0]]);
    const queue = [start];
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      for (const n of maze.openNeighbors(cur)) {
        if (!dist.has(n)) {
          dist.set(n, dist.get(cur) + 1);
          queue.push(n);
        }
      }
    }
    return dist;
  },

  /**
   * Breadth-first flood fill bounded by `maxDepth`, respecting maze walls —
   * this is the horror "flashlight". A cell only counts as visible if there
   * is an unobstructed corridor path of `maxDepth` steps or fewer from the
   * player, so a wall around a corner genuinely blocks the light instead of
   * a naive circular radius seeing straight through it.
   *
   * Time/Space: O(k), k = number of cells within maxDepth steps (bounded
   * above by R*C, in practice far smaller for the vision radii used here).
   */
  bfsVisible(maze, origin, maxDepth) {
    const visible = new Set([origin]);
    let frontier = [origin];
    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const next = [];
      for (const cell of frontier) {
        for (const n of maze.openNeighbors(cell)) {
          if (!visible.has(n)) {
            visible.add(n);
            next.push(n);
          }
        }
      }
      frontier = next;
    }
    return visible;
  },

  /**
   * A* search from `start` to `goal`. Edges are open walls between adjacent
   * cells, each with uniform cost 1. Manhattan distance is an admissible AND
   * consistent heuristic here because the maze only permits axis-aligned
   * unit-cost moves, so it can never overestimate the true remaining cost —
   * that admissibility is what guarantees A* returns a truly shortest path,
   * not just a fast one.
   *
   * Time:  O(E log V) with the binary-heap open set (V = R*C, E ~= 2V).
   * Space: O(V) for the score maps, the came-from map, and the heap.
   *
   * Returns [start, ..., goal] or null if unreachable (never happens here —
   * generate() always produces a fully connected spanning tree).
   */
  aStar(maze, start, goal) {
    if (start === goal) return [start];

    const gScore = new Map([[start, 0]]);
    const cameFrom = new Map();
    const closed = new Set();
    const open = new MinHeap();
    open.push(start, this.manhattan(start, goal));

    while (open.size > 0) {
      const current = open.pop();
      if (current === goal) {
        const path = [current];
        let walk = current;
        while (cameFrom.has(walk)) {
          walk = cameFrom.get(walk);
          path.push(walk);
        }
        return path.reverse();
      }
      if (closed.has(current)) continue;
      closed.add(current);

      for (const n of maze.openNeighbors(current)) {
        const tentativeG = gScore.get(current) + 1;
        if (tentativeG < (gScore.has(n) ? gScore.get(n) : Infinity)) {
          cameFrom.set(n, current);
          gScore.set(n, tentativeG);
          open.push(n, tentativeG + this.manhattan(n, goal));
        }
      }
    }
    return null;
  },
};

// ---------------------------------------------------------------------------
// GridActor — shared behaviour for anything that occupies one maze cell and
// renders with a smoothed pixel position, so discrete grid movement doesn't
// look like teleporting on screen.
// ---------------------------------------------------------------------------
class GridActor {
  constructor(cell, cellSize) {
    this.cell = cell;
    this.cellSize = cellSize;
    this.renderX = this._targetX();
    this.renderY = this._targetY();
  }
  _targetX() { return this.cell.col * this.cellSize + this.cellSize / 2; }
  _targetY() { return this.cell.row * this.cellSize + this.cellSize / 2; }
  setCell(cell) { this.cell = cell; }

  updateRenderPosition(dt) {
    const lerpSpeed = Math.min(1, dt * 0.018);
    this.renderX += (this._targetX() - this.renderX) * lerpSpeed;
    this.renderY += (this._targetY() - this.renderY) * lerpSpeed;
  }
}

class Player extends GridActor {
  constructor(cell, cellSize) {
    super(cell, cellSize);
    this.moveTimer = 0;
  }

  /**
   * Attempts one grid step per `interval` ms while a direction is held.
   * Maze is the only thing consulted for whether a move is legal, keeping
   * wall data in one place instead of duplicating it on the actor.
   */
  update(dt, heldDir, maze, interval) {
    this.moveTimer += dt;
    if (heldDir && this.moveTimer >= interval) {
      if (!this.cell.walls[heldDir]) {
        const target = maze.neighborInDir(this.cell, heldDir);
        if (target) {
          this.setCell(target);
        }
      }
      this.moveTimer = 0;
    }
    this.updateRenderPosition(dt);
  }
}

class Monster extends GridActor {
  constructor(cell, cellSize) {
    super(cell, cellSize);
    this.moveTimer = 0;
  }

  /**
   * Every `interval` ms, re-run A* from the monster's cell to the player's
   * current cell and advance one step along the fresh path. Recomputing on
   * every tick (rather than caching a path across ticks) keeps pursuit
   * correct the instant the player changes direction — these mazes are at
   * most a few hundred cells, so a fresh A* call is cheap enough to afford.
   */
  update(dt, maze, playerCell, interval) {
    this.moveTimer += dt;
    if (this.moveTimer >= interval) {
      this.moveTimer = 0;
      const path = Pathfinder.aStar(maze, this.cell, playerCell);
      if (path && path.length > 1) {
        this.setCell(path[1]);
      }
    }
    this.updateRenderPosition(dt);
  }
}

// ---------------------------------------------------------------------------
// Game — state machine, input, rendering, main loop
// ---------------------------------------------------------------------------
class Game {
  constructor() {
    this.screens = {
      start: document.getElementById('screen-start'),
      game: document.getElementById('screen-game'),
      gameover: document.getElementById('screen-gameover'),
      win: document.getElementById('screen-win'),
    };
    this.canvas = document.getElementById('game-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.difficultySelect = document.getElementById('difficulty-select');

    this.hud = {
      timer: document.getElementById('hud-timer'),
      status: document.getElementById('hud-status'),
      level: document.getElementById('hud-level'),
    };

    this.state = 'start';
    this.level = 1;
    this.difficultyKey = 'medium';
    this.rafHandle = null;
    this.lastTs = 0;
    this.elapsedMs = 0;
    this.heldDirs = []; // stack of currently-held direction keys, most-recent last

    this._bindInput();
    this._bindButtons();
  }

  // -- input -----------------------------------------------------------
  _bindInput() {
    window.addEventListener('keydown', (e) => {
      const dir = KEY_TO_DIR[e.code];
      if (dir) {
        e.preventDefault();
        if (!this.heldDirs.includes(dir)) this.heldDirs.push(dir);
      } else if (e.code === 'Escape' && this.state === 'playing') {
        this._abandonRun();
      }
    });
    window.addEventListener('keyup', (e) => {
      const dir = KEY_TO_DIR[e.code];
      if (dir) {
        this.heldDirs = this.heldDirs.filter((d) => d !== dir);
      }
    });
  }

  _bindButtons() {
    document.getElementById('btn-start').addEventListener('click', () => {
      this.level = 1;
      this.difficultyKey = this.difficultySelect.value;
      this._startRun();
    });
    document.getElementById('btn-retry').addEventListener('click', () => this._startRun());
    document.getElementById('btn-next').addEventListener('click', () => this._startRun());
  }

  _showScreen(name) {
    for (const key of Object.keys(this.screens)) {
      this.screens[key].classList.toggle('screen--active', key === name);
    }
  }

  _abandonRun() {
    this._stopLoop();
    this.state = 'start';
    this._showScreen('start');
  }

  // -- run setup ---------------------------------------------------------
  _startRun() {
    const preset = DIFFICULTY[this.difficultyKey];
    // Mild difficulty ramp on repeated descents: the monster reacts a
    // little faster each level, floored so it never becomes unfair.
    const monsterInterval = Math.max(140, preset.monsterInterval - (this.level - 1) * 12);

    this.preset = preset;
    this.monsterInterval = monsterInterval;

    this.maze = new Maze(preset.cols, preset.rows).generate(Math.random);

    const startCell = this.maze.at(0, 0);
    const distances = Pathfinder.bfsDistances(this.maze, startCell);
    const byDistDesc = [...distances.entries()].sort((a, b) => b[1] - a[1]);

    this.exitCell = byDistDesc[0][0];
    const maxDist = byDistDesc[0][1];

    // Spawn the monster somewhere with real breathing room from the player
    // (never adjacent-ish) but not necessarily camped on the exit.
    const targetDist = maxDist * 0.55;
    const candidates = byDistDesc.filter(
      ([cell, d]) => cell !== this.exitCell && d >= Math.min(6, maxDist * 0.3)
    );
    const pool = candidates.length > 0 ? candidates : byDistDesc;
    pool.sort((a, b) => Math.abs(a[1] - targetDist) - Math.abs(b[1] - targetDist));
    const monsterCell = pool[0][0];

    this._setupCanvas(preset);

    this.player = new Player(startCell, preset.cellSize);
    this.monster = new Monster(monsterCell, preset.cellSize);

    this.exploredCells = new Set();
    this.visibleCells = new Set();
    this._recomputeVisibility();

    this.elapsedMs = 0;
    this.lastTs = performance.now();
    this.heldDirs = [];

    this.hud.level.textContent = String(this.level).padStart(2, '0');
    this.hud.timer.textContent = '00:00';
    this._setStatus(false);

    this.state = 'playing';
    this._showScreen('game');
    this._startLoop();
  }

  _setupCanvas(preset) {
    const dpr = window.devicePixelRatio || 1;
    const pixelW = preset.cols * preset.cellSize;
    const pixelH = preset.rows * preset.cellSize;
    this.canvas.style.width = `${pixelW}px`;
    this.canvas.style.height = `${pixelH}px`;
    this.canvas.width = pixelW * dpr;
    this.canvas.height = pixelH * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  _recomputeVisibility() {
    this.visibleCells = Pathfinder.bfsVisible(this.maze, this.player.cell, this.preset.visionRadius);
    for (const c of this.visibleCells) this.exploredCells.add(c);
  }

  _setStatus(danger) {
    this.hud.status.textContent = danger ? 'PROXIMITY WARNING' : 'SIGNAL STABLE';
    this.hud.status.classList.toggle('hud__status--danger', danger);
  }

  // -- loop ----------------------------------------------------------------
  _startLoop() {
    this._stopLoop();
    const step = (ts) => {
      const dt = Math.min(50, ts - this.lastTs); // clamp to avoid huge jumps on tab refocus
      this.lastTs = ts;
      this._update(dt);
      this._render();
      this.rafHandle = requestAnimationFrame(step);
    };
    this.rafHandle = requestAnimationFrame(step);
  }

  _stopLoop() {
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
  }

  _update(dt) {
    if (this.state !== 'playing') return;

    this.elapsedMs += dt;
    this.hud.timer.textContent = formatTime(this.elapsedMs);

    const heldDir = this.heldDirs[this.heldDirs.length - 1] || null;
    const prevCell = this.player.cell;
    this.player.update(dt, heldDir, this.maze, this.preset.playerInterval);
    if (this.player.cell !== prevCell) {
      this._recomputeVisibility();
    }

    this.monster.update(dt, this.maze, this.player.cell, this.monsterInterval);

    const proximity = Pathfinder.manhattan(this.player.cell, this.monster.cell);
    this._setStatus(proximity <= 3);

    if (this.player.cell === this.monster.cell) {
      this._triggerGameOver();
      return;
    }
    if (this.player.cell === this.exitCell) {
      this._triggerWin();
    }
  }

  _triggerGameOver() {
    this.state = 'gameover';
    this._stopLoop();
    document.getElementById('over-level').textContent = String(this.level).padStart(2, '0');
    document.getElementById('over-time').textContent = formatTime(this.elapsedMs);
    this._showScreen('gameover');
  }

  _triggerWin() {
    this.state = 'win';
    this._stopLoop();
    document.getElementById('win-level').textContent = String(this.level).padStart(2, '0');
    document.getElementById('win-time').textContent = formatTime(this.elapsedMs);
    this.level += 1;
    this._showScreen('win');
  }

  // -- rendering -------------------------------------------------------
  _render() {
    const { ctx, maze, preset } = this;
    const size = preset.cellSize;

    ctx.fillStyle = '#0b0e0c';
    ctx.fillRect(0, 0, maze.cols * size, maze.rows * size);

    for (const cell of maze.cells) {
      const lit = this.visibleCells.has(cell);
      const dim = !lit && this.exploredCells.has(cell);
      if (!lit && !dim) continue;
      this._drawCell(cell, lit);
    }

    if (this.visibleCells.has(this.exitCell) || this.exploredCells.has(this.exitCell)) {
      this._drawExit(this.visibleCells.has(this.exitCell));
    }

    this._drawPlayer();

    if (this.visibleCells.has(this.monster.cell)) {
      this._drawMonster();
    }
  }

  _drawCell(cell, lit) {
    const { ctx } = this;
    const size = this.preset.cellSize;
    const x = cell.col * size;
    const y = cell.row * size;

    ctx.fillStyle = lit ? '#141a17' : '#0e120f';
    ctx.fillRect(x, y, size, size);

    ctx.strokeStyle = lit ? '#3c4a42' : '#22281f';
    ctx.lineWidth = Math.max(2, size * 0.09);
    ctx.lineCap = 'square';

    ctx.beginPath();
    if (cell.walls.N) { ctx.moveTo(x, y); ctx.lineTo(x + size, y); }
    if (cell.walls.S) { ctx.moveTo(x, y + size); ctx.lineTo(x + size, y + size); }
    if (cell.walls.W) { ctx.moveTo(x, y); ctx.lineTo(x, y + size); }
    if (cell.walls.E) { ctx.moveTo(x + size, y); ctx.lineTo(x + size, y + size); }
    ctx.stroke();
  }

  _drawExit(lit) {
    const { ctx, exitCell } = this;
    const size = this.preset.cellSize;
    const cx = exitCell.col * size + size / 2;
    const cy = exitCell.row * size + size / 2;
    const r = size * 0.28;

    if (lit) {
      const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 1.4);
      glow.addColorStop(0, 'rgba(94,156,116,0.55)');
      glow.addColorStop(1, 'rgba(94,156,116,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(cx - size * 1.4, cy - size * 1.4, size * 2.8, size * 2.8);
    }

    ctx.fillStyle = lit ? '#5e9c74' : '#2c4534';
    ctx.beginPath();
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx + r, cy);
    ctx.lineTo(cx, cy + r);
    ctx.lineTo(cx - r, cy);
    ctx.closePath();
    ctx.fill();
  }

  _drawPlayer() {
    const { ctx, player } = this;
    const size = this.preset.cellSize;
    const r = size * 0.26;

    const glow = ctx.createRadialGradient(player.renderX, player.renderY, 0, player.renderX, player.renderY, size * 2.2);
    glow.addColorStop(0, 'rgba(217,164,65,0.30)');
    glow.addColorStop(1, 'rgba(217,164,65,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(player.renderX - size * 2.2, player.renderY - size * 2.2, size * 4.4, size * 4.4);

    ctx.fillStyle = '#d9a441';
    ctx.beginPath();
    ctx.arc(player.renderX, player.renderY, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#3a2e14';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  _drawMonster() {
    const { ctx, monster } = this;
    const size = this.preset.cellSize;
    const r = size * 0.3;

    ctx.fillStyle = '#1a0d0d';
    ctx.beginPath();
    ctx.arc(monster.renderX, monster.renderY, r, 0, Math.PI * 2);
    ctx.fill();

    // Two glowing eyes so it reads as "something" even at small sizes.
    const eyeOffset = r * 0.42;
    const eyeR = Math.max(1.5, size * 0.05);
    ctx.fillStyle = '#c94a3a';
    ctx.shadowColor = '#c94a3a';
    ctx.shadowBlur = size * 0.25;
    ctx.beginPath();
    ctx.arc(monster.renderX - eyeOffset, monster.renderY - eyeOffset * 0.3, eyeR, 0, Math.PI * 2);
    ctx.arc(monster.renderX + eyeOffset, monster.renderY - eyeOffset * 0.3, eyeR, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }
}

function formatTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const mm = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const ss = String(totalSeconds % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  new Game();
});
