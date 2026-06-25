/**
 * Built in collaboration with Claude AI (Anthropic).
 *
 * Interactive note-graph: force-directed layout, hierarchical grouping,
 * curved edges with labels/arrows, hover highlighting, and pan/zoom.
 *
 * Architecture (single IIFE — nothing leaks to the global scope):
 *   GraphNode          – one DOM node plus its layout/physics state.
 *   GraphModel         – parses the source data into nodes, edges, chains
 *                        and the group/section hierarchy; owns bbox queries.
 *   LayoutEngine       – positions nodes (force simulation → compaction →
 *                        overlap/group separation) and derives canvas coords.
 *   GraphRenderer      – builds the canvas, SVG layers, group boxes and edges.
 *   HoverController    – highlights a node, its edges, chains and groups.
 *   PanZoomController  – drag-to-pan and wheel-to-zoom.
 *   LabelsToggle       – the "Labels" button.
 *   GraphApp           – wires the above together.
 */
(function () {
  'use strict';

  // Configuration
  var GROUP_PADDING = 20; // gap: a group's inner border → its children
  var GROUP_MARGIN  = 35; // gap: outer border of one sibling group → another

  /** @type {Readonly<Record<string, number>>} */
  var CONFIG = Object.freeze({
    // Node sizing
    nodeMinWidth: 120,
    nodeMinHeight: 48,
    nodeGap: 20, // min clearance between two nodes during overlap resolution

    // Group spacing
    hullPad: 48,
    groupPadding: GROUP_PADDING,
    groupMargin: GROUP_MARGIN,
    sectionMargin: GROUP_MARGIN, // balanced spacing without a forced vacuum
    canvasPad: 90,

    // Per-section compact layout
    sectColGap: 2 * GROUP_PADDING + GROUP_MARGIN,
    sectCellX: 22,
    sectCellY: 22,

    // Force-directed simulation
    repel: 32000,
    groupRepel: 32000,
    groupRepelRange: 2.2,
    spring: 0.04,
    ideal: 280,
    gravity: 0.008,
    cohesion: 0.015,       // pull toward a section's centroid
    nestedCohesion: 0.04,  // pull toward a nested sub-group's centroid
    damping: 0.74,
    iterations: 800,

    // Iteration budgets for the post-simulation separation passes
    overlapPass1: 120,
    overlapPass2: 80,
    overlapFinal: 80,
    sectionSepIters: 150,
    subgroupRounds: 6,
    subgroupSepIters: 60,
    nodePushIters: 40,
    subgroupOverlapIters: 40,

    // Edge / arrow / label geometry
    edgeWrapWidth: 180,
    arrowWidth: 5,
    arrowLen: 9,
    labelPadX: 14,
    labelPadY: 6,
    labelRadius: 30,

    // Interaction
    hoverClearMs: 80, // dwell over empty space before the highlight clears
    zoomMin: 0.1,
    zoomMax: 5,
    zoomStep: 1.1
  });

  var SVG_NS = 'http://www.w3.org/2000/svg';

  // Coordinate accessors shared by layout (x/y) and rendering (cx/cy) passes.
  var layoutX = function (n) { return n.x; };
  var layoutY = function (n) { return n.y; };
  var canvasX = function (n) { return n.cx; };
  var canvasY = function (n) { return n.cy; };

  // Small pure helpers

  /**
   * Create an SVG element and apply a flat map of attributes.
   * @param {string} tag
   * @param {Record<string, string|number>=} attrs
   * @returns {SVGElement}
   */
  function svgEl(tag, attrs) {
    var el = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      for (var key in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, key)) {
          el.setAttribute(key, String(attrs[key]));
        }
      }
    }
    return el;
  }

  /**
   * Average centre of a set of nodes (using layout coords).
   * @param {GraphNode[]} members
   * @returns {{x: number, y: number}}
   */
  function centroid(members) {
    var x = 0, y = 0;
    for (var i = 0; i < members.length; i++) { x += members[i].x; y += members[i].y; }
    return { x: x / members.length, y: y / members.length };
  }

  /**
   * Edge intersection of a ray (dx,dy) from a box centre with that box's border.
   * @returns {[number, number]}
   */
  function port(cx, cy, dx, dy, w, h) {
    if (!dx && !dy) return [cx, cy];
    var len = Math.sqrt(dx * dx + dy * dy);
    var ux = dx / len, uy = dy / len;
    var t = Math.min(
      ux ? (w / 2) / Math.abs(ux) : Infinity,
      uy ? (h / 2) / Math.abs(uy) : Infinity
    );
    return [cx + ux * t, cy + uy * t];
  }

  // GraphNode

  /**
   * A single graph node: its DOM element plus layout (x/y), physics
   * (vx/vy/fx/fy), measured size (w/h) and final canvas coords (cx/cy).
   */
  class GraphNode {
    /** @param {Element} el */
    constructor(el) {
      if (!(el instanceof Element)) {
        throw new TypeError('GraphNode expects a DOM Element');
      }
      this.el = el;
      this.id = el.id.replace('node-', '');

      var parts = (el.getAttribute('data-path') || '')
        .split('/')
        .filter(Boolean)
        .map(function (p) { return p.replace(/-/g, ' '); });

      this.section = parts[0] || '';
      // Ancestry keys, e.g. ['a', 'a/b', 'a/b/c'] for path "a/b/c".
      this.groups = parts.map(function (_, i) { return parts.slice(0, i + 1).join('/'); });

      this.x = 0; this.y = 0;   // layout coords
      this.vx = 0; this.vy = 0; // velocity
      this.fx = 0; this.fy = 0; // accumulated force
      this.w = 0; this.h = 0;   // measured size
      this.cx = 0; this.cy = 0; // canvas coords (set after layout)
    }

    /** Innermost sub-group key, or '' for top-level-only nodes. */
    get subgroup() {
      return this.groups.length > 1 ? this.groups[this.groups.length - 1] : '';
    }

    /** Record the node's natural rendered size, clamped to sensible minimums. */
    measure(minW, minH) {
      this.w = Math.max(this.el.offsetWidth, minW);
      this.h = Math.max(this.el.offsetHeight, minH);
    }
  }

  // GraphModel

  /**
   * Parsed, validated graph data and its group hierarchy. Pure data + topology
   * queries — it holds no DOM beyond the node elements and never mutates layout.
   */
  class GraphModel {
    /**
     * @param {Element[]} nodeEls
     * @param {object|Array} rawData  Parsed JSON: either an edges array or
     *                                `{ edges, chains }`.
     * @param {typeof CONFIG} config
     */
    constructor(nodeEls, rawData, config) {
      if (!Array.isArray(nodeEls)) throw new TypeError('nodeEls must be an array');
      this.config = config;

      this.nodes = nodeEls.map(function (el) { return new GraphNode(el); });
      this.nodes.forEach(function (n) { n.measure(config.nodeMinWidth, config.nodeMinHeight); });

      /** @type {Record<string, GraphNode>} */
      this.idMap = {};
      this.nodes.forEach(function (n) { this.idMap[n.id] = n; }, this);

      this._buildEdgesAndChains(rawData);
      this._buildGroups();
    }

    /** @param {object|Array} rawData */
    _buildEdgesAndChains(rawData) {
      var idMap = this.idMap;
      var rawLinks = Array.isArray(rawData) ? rawData : (rawData.edges || []);
      var rawChains = (Array.isArray(rawData) ? [] : (rawData.chains || [])).map(function (ch) {
        return Array.isArray(ch) ? ch : (ch.nodes || []);
      });

      // Keep only edges whose endpoints both exist.
      this.edges = rawLinks.filter(function (lk) {
        return idMap[lk.from] && idMap[lk.to];
      });

      // Keep chains restricted to known nodes, with 2+ valid members.
      this.validChains = rawChains
        .map(function (ch) { return ch.filter(function (id) { return idMap[id]; }); })
        .filter(function (ch) { return ch.length >= 2; });

      // Index: chain-source id → [chainIndex, …]. Only the source triggers highlight.
      /** @type {Record<string, number[]>} */
      this.chainsByNode = {};
      this.validChains.forEach(function (ch, ci) {
        var src = ch[0];
        (this.chainsByNode[src] || (this.chainsByNode[src] = [])).push(ci);
      }, this);
    }

    _buildGroups() {
      // group key → member nodes (a node belongs to every ancestor group).
      /** @type {Record<string, GraphNode[]>} */
      this.groupMap = {};
      this.nodes.forEach(function (n) {
        n.groups.forEach(function (g) {
          (this.groupMap[g] || (this.groupMap[g] = [])).push(n);
        }, this);
      }, this);

      // Shallowest groups first so parents are processed before children.
      this.allGroupKeys = Object.keys(this.groupMap).sort(function (a, b) {
        return a.split('/').length - b.split('/').length;
      });

      this.sectionMap = {};
      this.allGroupKeys.forEach(function (k) {
        if (k.indexOf('/') === -1) this.sectionMap[k] = this.groupMap[k];
      }, this);
      this.sections = Object.keys(this.sectionMap);
      this.nestedKeys = this.allGroupKeys.filter(function (k) { return k.indexOf('/') !== -1; });

      // Precompute direct children of every group (parent '' = the top level).
      /** @type {Record<string, string[]>} */
      this.childKeysByParent = {};
      this.allGroupKeys.forEach(function (k) {
        var parent = k.indexOf('/') === -1 ? '' : k.substring(0, k.lastIndexOf('/'));
        (this.childKeysByParent[parent] || (this.childKeysByParent[parent] = [])).push(k);
      }, this);
    }

    /** @returns {string[]} direct child group keys of `key`. */
    directChildren(key) {
      return this.childKeysByParent[key] || [];
    }

    /** @returns {string} the parent group key of `key` ('' if top-level). */
    parentOf(key) {
      return key.indexOf('/') === -1 ? '' : key.substring(0, key.lastIndexOf('/'));
    }

    /**
     * Drawn bounding box of a group at any depth, in the chosen coordinate space.
     * Recurses into direct child groups so every nesting level adds groupPadding
     * around its children's already-drawn borders.
     * @param {string} key
     * @param {(n: GraphNode) => number} getX
     * @param {(n: GraphNode) => number} getY
     * @returns {[number, number, number, number]} [minX, minY, maxX, maxY]
     */
    groupBBox(key, getX, getY) {
      var pad = this.config.groupPadding;
      var children = this.directChildren(key);

      var inChild = {};
      children.forEach(function (ck) {
        this.groupMap[ck].forEach(function (n) { inChild[n.id] = true; });
      }, this);

      var x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;

      children.forEach(function (ck) {
        var cb = this.groupBBox(ck, getX, getY);
        x1 = Math.min(x1, cb[0] - pad);
        y1 = Math.min(y1, cb[1] - pad);
        x2 = Math.max(x2, cb[2] + pad);
        y2 = Math.max(y2, cb[3] + pad);
      }, this);

      this.groupMap[key].forEach(function (n) {
        if (inChild[n.id]) return;
        var nx = getX(n), ny = getY(n);
        x1 = Math.min(x1, nx - n.w / 2 - pad);
        y1 = Math.min(y1, ny - n.h / 2 - pad);
        x2 = Math.max(x2, nx + n.w / 2 + pad);
        y2 = Math.max(y2, ny + n.h / 2 + pad);
      });

      return [x1, y1, x2, y2];
    }
  }

  // LayoutEngine

  /**
   * Computes node positions. The pipeline is:
   *   circle seed → force simulation → per-section compaction →
   *   overlap & group/sub-group separation → section redistribution →
   *   canvas-coordinate derivation.
   */
  class LayoutEngine {
    /**
     * @param {GraphModel} model
     * @param {typeof CONFIG} config
     * @param {HTMLElement} viewport
     */
    constructor(model, config, viewport) {
      this.model = model;
      this.config = config;
      this.VW = viewport.offsetWidth || window.innerWidth;
      this.VH = Math.max(window.innerHeight - viewport.getBoundingClientRect().top - 4, 480);
    }

    /** Run every layout pass and return the resulting canvas dimensions. */
    run() {
      this._seedOnCircle();
      this._runForceSimulation();
      this._compactSections();
      this._resolveNodeOverlaps(this.config.overlapPass1);
      this._separateSections(this.config.sectionSepIters);
      this._resolveNodeOverlaps(this.config.overlapPass2);
      this._separateSubgroups();
      this._separateSections(this.config.sectionSepIters);
      this._resolveNodeOverlaps(this.config.overlapFinal);
      this._redistributeSections();
      return this._deriveCanvasCoords();
    }

    // Seeding & simulation

    _seedOnCircle() {
      var nodes = this.model.nodes;
      var n = nodes.length;
      var r0 = Math.max(180, Math.min(Math.min(this.VW, this.VH) * 0.32, 420));
      nodes.forEach(function (node, i) {
        var angle = (2 * Math.PI * i / n) - Math.PI / 2;
        node.x = this.VW / 2 + r0 * Math.cos(angle);
        node.y = this.VH / 2 + r0 * Math.sin(angle);
      }, this);
    }

    _runForceSimulation() {
      var iters = this.config.iterations;
      for (var iter = 0; iter < iters; iter++) {
        var alpha = 1 - iter / iters;
        this.model.nodes.forEach(function (n) { n.fx = 0; n.fy = 0; });
        this._applyRepulsion();
        this._applySprings();
        this._applyCohesion();
        this._applyGroupRepulsion();
        this._integrate(alpha);
      }
    }

    /** Pairwise inverse-square repulsion between all nodes. */
    _applyRepulsion() {
      var nodes = this.model.nodes, N = nodes.length, repel = this.config.repel;
      for (var i = 0; i < N; i++) {
        for (var j = i + 1; j < N; j++) {
          var a = nodes[i], b = nodes[j];
          var ex = b.x - a.x, ey = b.y - a.y;
          var ed = Math.sqrt(Math.max(ex * ex + ey * ey, 1));
          var f = repel / (ed * ed);
          var fxu = f * ex / ed, fyu = f * ey / ed;
          a.fx -= fxu; a.fy -= fyu;
          b.fx += fxu; b.fy += fyu;
        }
      }
    }

    /** Spring force along every edge toward the ideal length. */
    _applySprings() {
      var idMap = this.model.idMap, spring = this.config.spring, ideal = this.config.ideal;
      this.model.edges.forEach(function (lk) {
        var a = idMap[lk.from], b = idMap[lk.to];
        if (!a || !b) return;
        var ex = b.x - a.x, ey = b.y - a.y;
        var ed = Math.sqrt(ex * ex + ey * ey) || 1;
        var f = spring * (ed - ideal);
        var fxu = f * ex / ed, fyu = f * ey / ed;
        a.fx += fxu; a.fy += fyu;
        b.fx -= fxu; b.fy -= fyu;
      });
    }

    /** Pull section members and nested-group members toward their centroids. */
    _applyCohesion() {
      var model = this.model;
      var sectionStrength = this.config.cohesion;
      var nestedStrength = this.config.nestedCohesion;

      model.sections.forEach(function (sec) {
        var members = model.sectionMap[sec];
        if (members.length < 2) return;
        var c = centroid(members);
        members.forEach(function (n) {
          n.fx -= sectionStrength * (n.x - c.x);
          n.fy -= sectionStrength * (n.y - c.y);
        });
      });

      model.nestedKeys.forEach(function (key) {
        var members = model.groupMap[key];
        if (members.length < 2) return;
        var c = centroid(members);
        members.forEach(function (n) {
          n.fx -= nestedStrength * (n.x - c.x);
          n.fy -= nestedStrength * (n.y - c.y);
        });
      });
    }

    /** Push whole sections apart when their estimated radii overlap. */
    _applyGroupRepulsion() {
      var model = this.model;
      var hullPad = this.config.hullPad;
      var repel = this.config.groupRepel;
      var range = this.config.groupRepelRange;
      var sections = model.sections;

      var radiusOf = function (members) {
        var avgArea = members.reduce(function (s, n) { return s + n.w * n.h; }, 0) / members.length;
        return hullPad + Math.sqrt(members.length * avgArea) / 2;
      };

      for (var i = 0; i < sections.length; i++) {
        for (var j = i + 1; j < sections.length; j++) {
          var A = model.sectionMap[sections[i]];
          var B = model.sectionMap[sections[j]];
          var ca = centroid(A), cb = centroid(B);
          var dx = cb.x - ca.x, dy = cb.y - ca.y;
          var dist = Math.sqrt(dx * dx + dy * dy) || 1;

          if (dist < (radiusOf(A) + radiusOf(B)) * range) {
            var f = repel / (dist * dist);
            A.forEach(function (n) { n.fx -= f * dx / dist / A.length; n.fy -= f * dy / dist / A.length; });
            B.forEach(function (n) { n.fx += f * dx / dist / B.length; n.fy += f * dy / dist / B.length; });
          }
        }
      }
    }

    /** Apply gravity toward the viewport centre, then damp and integrate. */
    _integrate(alpha) {
      var gravity = this.config.gravity, damp = this.config.damping;
      var cx = this.VW / 2, cy = this.VH / 2;
      this.model.nodes.forEach(function (n) {
        n.fx -= gravity * (n.x - cx);
        n.fy -= gravity * (n.y - cy);
        n.vx = n.vx * damp + n.fx * alpha;
        n.vy = n.vy * damp + n.fy * alpha;
        n.x += n.vx;
        n.y += n.vy;
      });
    }

    // Compaction

    /** Re-lay each section as a tidy grid of sub-group grids around its centroid. */
    _compactSections() {
      var model = this.model;
      model.sections.forEach(function (sec) {
        var members = model.sectionMap[sec];
        if (!members.length) return;

        var center = centroid(members);

        // Bucket members by sub-group, ordered left-to-right by mean x.
        var colMap = {};
        members.forEach(function (n) {
          var k = n.subgroup;
          (colMap[k] || (colMap[k] = [])).push(n);
        });
        var meanX = function (ns) {
          return ns.reduce(function (s, n) { return s + n.x; }, 0) / ns.length;
        };
        var colKeys = Object.keys(colMap).sort(function (a, b) {
          return meanX(colMap[a]) - meanX(colMap[b]);
        });

        var grids = colKeys.map(function (k) { return this._buildGrid(colMap[k]); }, this);
        this._placeGrids(grids, center);
      }, this);
    }

    /**
     * Arrange a sub-group's members into a near-square grid and measure it.
     * @param {GraphNode[]} members
     */
    _buildGrid(members) {
      var cellX = this.config.sectCellX, cellY = this.config.sectCellY;
      var byX = members.slice().sort(function (a, b) { return a.x - b.x; });
      var gc = Math.max(1, Math.ceil(Math.sqrt(byX.length)));
      var gr = Math.ceil(byX.length / gc);

      var columns = [];
      for (var c = 0; c < gc; c++) {
        columns.push(byX.slice(c * gr, (c + 1) * gr).sort(function (a, b) { return a.y - b.y; }));
      }

      var cws = columns.map(function (col) {
        return col.reduce(function (m, n) { return Math.max(m, n.w); }, 0);
      });
      var rhs = [];
      for (var r = 0; r < gr; r++) {
        var mh = 0;
        columns.forEach(function (col) { if (col[r]) mh = Math.max(mh, col[r].h); });
        rhs.push(mh);
      }

      var tw = cws.reduce(function (s, w) { return s + w; }, 0) + Math.max(0, gc - 1) * cellX;
      var th = rhs.reduce(function (s, h) { return s + h; }, 0) + Math.max(0, gr - 1) * cellY;
      return { columns: columns, cws: cws, rhs: rhs, gc: gc, gr: gr, tw: tw, th: th };
    }

    /** Place sub-group grids in a balanced 2-D arrangement centred on `center`. */
    _placeGrids(grids, center) {
      var colGap = this.config.sectColGap;
      var cellX = this.config.sectCellX, cellY = this.config.sectCellY;

      var numCols = Math.max(1, Math.ceil(Math.sqrt(grids.length)));
      var numRows = Math.ceil(grids.length / numCols);

      var colWidths = new Array(numCols).fill(0);
      var rowHeights = new Array(numRows).fill(0);
      grids.forEach(function (g, gi) {
        var row = Math.floor(gi / numCols), col = gi % numCols;
        colWidths[col] = Math.max(colWidths[col], g.tw);
        rowHeights[row] = Math.max(rowHeights[row], g.th);
      });

      var colStarts = [0], rowStarts = [0];
      for (var i = 1; i < numCols; i++) colStarts.push(colStarts[i - 1] + colWidths[i - 1] + colGap);
      for (var k = 1; k < numRows; k++) rowStarts.push(rowStarts[k - 1] + rowHeights[k - 1] + colGap);

      var totalW = colStarts[numCols - 1] + colWidths[numCols - 1];
      var totalH = rowStarts[numRows - 1] + rowHeights[numRows - 1];

      grids.forEach(function (g, gi) {
        var row = Math.floor(gi / numCols), col = gi % numCols;
        var cellLeft = center.x - totalW / 2 + colStarts[col];
        var cellTop = center.y - totalH / 2 + rowStarts[row];
        var colX = cellLeft;
        for (var c = 0; c < g.gc; c++) {
          var rowY = cellTop;
          for (var r = 0; r < g.columns[c].length; r++) {
            var nd = g.columns[c][r];
            nd.x = colX + g.cws[c] / 2;
            nd.y = rowY + g.rhs[r] / 2;
            rowY += g.rhs[r] + cellY;
          }
          colX += g.cws[c] + cellX;
        }
      });
    }

    // Separation passes

    /** Iteratively shove overlapping nodes apart along the shallower axis. */
    _resolveNodeOverlaps(iterations) {
      var nodes = this.model.nodes, N = nodes.length, gap = this.config.nodeGap;
      for (var it = 0; it < iterations; it++) {
        var any = false;
        for (var i = 0; i < N; i++) {
          for (var j = i + 1; j < N; j++) {
            var a = nodes[i], b = nodes[j];
            var ox = (a.w + b.w) / 2 + gap - Math.abs(b.x - a.x);
            var oy = (a.h + b.h) / 2 + gap - Math.abs(b.y - a.y);
            if (ox > 0 && oy > 0) {
              any = true;
              if (ox < oy) {
                var px = ox / 2 * (b.x >= a.x ? 1 : -1);
                a.x -= px; b.x += px;
              } else {
                var py = oy / 2 * (b.y >= a.y ? 1 : -1);
                a.y -= py; b.y += py;
              }
            }
          }
        }
        if (!any) break;
      }
    }

    /**
     * Separate the bounding boxes of two key groups, splitting the push evenly.
     * @param {string[]} keys      group keys to compare pairwise
     * @param {(ki: string, kj: string) => boolean} pairable  filter for pairs
     * @param {number} iterations
     */
    _separateGroupPairs(keys, pairable, iterations) {
      var model = this.model, margin = this.config.groupMargin;
      for (var it = 0; it < iterations; it++) {
        var any = false;
        for (var i = 0; i < keys.length; i++) {
          for (var j = i + 1; j < keys.length; j++) {
            var ki = keys[i], kj = keys[j];
            if (!pairable(ki, kj)) continue;

            var bi = model.groupBBox(ki, layoutX, layoutY);
            var bj = model.groupBBox(kj, layoutX, layoutY);
            var ox = Math.min(bi[2], bj[2]) - Math.max(bi[0], bj[0]) + margin;
            var oy = Math.min(bi[3], bj[3]) - Math.max(bi[1], bj[1]) + margin;
            if (ox > 0 && oy > 0) {
              any = true;
              var A = model.groupMap[ki], B = model.groupMap[kj];
              if (ox < oy) {
                var cxi = (bi[0] + bi[2]) / 2, cxj = (bj[0] + bj[2]) / 2;
                var px = ox / 2 * (cxj >= cxi ? 1 : -1);
                A.forEach(function (n) { n.x -= px; });
                B.forEach(function (n) { n.x += px; });
              } else {
                var cyi = (bi[1] + bi[3]) / 2, cyj = (bj[1] + bj[3]) / 2;
                var py = oy / 2 * (cyj >= cyi ? 1 : -1);
                A.forEach(function (n) { n.y -= py; });
                B.forEach(function (n) { n.y += py; });
              }
            }
          }
        }
        if (!any) break;
      }
    }

    /** Keep top-level sections from overlapping. */
    _separateSections(iterations) {
      this._separateGroupPairs(this.model.sections, function () { return true; }, iterations);
    }

    /**
     * Tidy nested sub-groups: separate sibling sub-groups, push stray nodes out
     * of foreign sub-group boxes, then resolve any node overlaps that introduces.
     */
    _separateSubgroups() {
      var model = this.model, config = this.config;
      var siblings = function (ki, kj) {
        return model.parentOf(ki) === model.parentOf(kj);
      };
      for (var round = 0; round < config.subgroupRounds; round++) {
        this._separateGroupPairs(model.nestedKeys, siblings, config.subgroupSepIters);
        this._pushNodesOutOfGroups(config.nodePushIters);
        this._resolveNodeOverlaps(config.subgroupOverlapIters);
      }
    }

    /** Push non-member nodes outside each nested group's bounding box. */
    _pushNodesOutOfGroups(iterations) {
      var model = this.model, nodes = model.nodes, N = nodes.length;
      var gap = this.config.groupMargin;

      for (var it = 0; it < iterations; it++) {
        var any = false;
        for (var ki = 0; ki < model.nestedKeys.length; ki++) {
          var key = model.nestedKeys[ki];
          var memberSet = {};
          model.groupMap[key].forEach(function (n) { memberSet[n.id] = true; });

          var bb = model.groupBBox(key, layoutX, layoutY);
          var bCx = (bb[0] + bb[2]) / 2, bCy = (bb[1] + bb[3]) / 2;

          for (var ni = 0; ni < N; ni++) {
            var n = nodes[ni];
            if (memberSet[n.id]) continue;
            var ox = Math.min(bb[2], n.x + n.w / 2) - Math.max(bb[0], n.x - n.w / 2) + gap;
            var oy = Math.min(bb[3], n.y + n.h / 2) - Math.max(bb[1], n.y - n.h / 2) + gap;
            if (ox > 0 && oy > 0) {
              any = true;
              if (ox < oy) n.x += ox * (n.x >= bCx ? 1 : -1);
              else n.y += oy * (n.y >= bCy ? 1 : -1);
            }
          }
        }
        if (!any) break;
      }
    }

    /**
     * Lay the top-level sections left-to-right by current x-centre with exactly
     * sectionMargin between bbox edges, then vertically centre the whole graph.
     */
    _redistributeSections() {
      var model = this.model, margin = this.config.sectionMargin;
      if (model.sections.length < 2) return;

      var items = model.sections
        .map(function (sec) { return { key: sec, bb: model.groupBBox(sec, layoutX, layoutY) }; })
        .filter(function (item) { return isFinite(item.bb[0]); })
        .sort(function (a, b) {
          return ((a.bb[0] + a.bb[2]) / 2) - ((b.bb[0] + b.bb[2]) / 2);
        });
      if (items.length < 2) return;

      var totalW = items.reduce(function (s, item) {
        return s + (item.bb[2] - item.bb[0]);
      }, 0) + (items.length - 1) * margin;

      var curX = -totalW / 2;
      items.forEach(function (item) {
        var bw = item.bb[2] - item.bb[0];
        var oldCx = (item.bb[0] + item.bb[2]) / 2;
        var dx = curX + bw / 2 - oldCx;
        model.sectionMap[item.key].forEach(function (n) { n.x += dx; });
        curX += bw + margin;
      });

      var avgCy = items.reduce(function (s, item) {
        return s + (item.bb[1] + item.bb[3]) / 2;
      }, 0) / items.length;
      model.nodes.forEach(function (n) { n.y -= avgCy; });
    }

    // Canvas coordinates

    /** Translate layout coords into padded canvas coords; return canvas size. */
    _deriveCanvasCoords() {
      var pad = this.config.canvasPad;
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      this.model.nodes.forEach(function (n) {
        minX = Math.min(minX, n.x - n.w / 2);
        minY = Math.min(minY, n.y - n.h / 2);
        maxX = Math.max(maxX, n.x + n.w / 2);
        maxY = Math.max(maxY, n.y + n.h / 2);
      });

      var canvasW = (maxX - minX) + 2 * pad;
      var canvasH = (maxY - minY) + 2 * pad;
      this.model.nodes.forEach(function (n) {
        n.cx = n.x - minX + pad;
        n.cy = n.y - minY + pad;
      });
      return { canvasW: canvasW, canvasH: canvasH };
    }
  }

  // GraphRenderer

  /**
   * Builds the DOM: a positioned canvas holding a background SVG (group boxes +
   * edges), the node elements, and a foreground SVG (arrows + edge labels).
   */
  class GraphRenderer {
    /**
     * @param {GraphModel} model
     * @param {typeof CONFIG} config
     * @param {HTMLElement} viewport
     * @param {number} canvasW
     * @param {number} canvasH
     */
    constructor(model, config, viewport, canvasW, canvasH) {
      this.model = model;
      this.config = config;
      this.VP = viewport;
      this.canvasW = canvasW;
      this.canvasH = canvasH;

      /** @type {Record<string, {boundary: SVGElement, label: SVGElement}>} */
      this.groupElems = {};
      /** @type {EdgeRef[]} */
      this.edgePaths = [];
    }

    /** @returns {{canvas: HTMLElement, groupElems: object, edgePaths: EdgeRef[]}} */
    render() {
      this.VP.style.position = 'relative';

      this.canvas = document.createElement('div');
      this.canvas.style.cssText =
        'position:absolute;left:0;top:0;width:' + this.canvasW + 'px;height:' +
        this.canvasH + 'px;transform-origin:0 0;';

      this.svg = this._makeLayer();      // background: group boxes + edges
      this.canvas.appendChild(this.svg);

      this.model.nodes.forEach(function (n) {
        n.el.style.left = (n.cx - n.w / 2) + 'px';
        n.el.style.top = (n.cy - n.h / 2) + 'px';
        n.el.style.width = n.w + 'px';
        n.el.style.height = n.h + 'px';
        this.canvas.appendChild(n.el);
      }, this);

      this.svgTop = this._makeLayer();   // foreground: arrows + edge labels
      this.canvas.appendChild(this.svgTop);

      this.VP.appendChild(this.canvas);

      this._drawGroups();
      this._drawEdges();

      return { canvas: this.canvas, groupElems: this.groupElems, edgePaths: this.edgePaths };
    }

    /** A full-canvas, non-interactive, overflow-visible SVG layer. */
    _makeLayer() {
      var svg = svgEl('svg', {
        'aria-hidden': 'true',
        width: this.canvasW,
        height: this.canvasH
      });
      svg.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;overflow:visible;';
      return svg;
    }

    _drawGroups() {
      var model = this.model, cr = this.config.groupPadding;
      model.allGroupKeys.forEach(function (key) {
        var nested = key.indexOf('/') !== -1;
        var bb = model.groupBBox(key, canvasX, canvasY);
        var x1 = bb[0], y1 = bb[1], x2 = bb[2], y2 = bb[3];
        if (!isFinite(x1)) return;

        var boundary = svgEl('path', {
          d: this._roundedRectPath(x1, y1, x2, y2, cr),
          fill: 'none',
          'stroke-width': '1.5',
          'stroke-dasharray': '5 4',
          'class': 'group-boundary ' + (nested ? 'group-nested' : 'group-outer')
        });
        this.svg.appendChild(boundary);

        var label = svgEl('text', {
          x: ((x1 + x2) / 2).toFixed(1),
          y: (y1 - 6).toFixed(1),
          'text-anchor': 'middle',
          'font-size': nested ? '11' : '12',
          'letter-spacing': '1',
          fill: 'currentColor',
          'class': 'group-label ' + (nested ? 'group-nested' : 'group-outer')
        });
        label.textContent = key.split('/').pop().toUpperCase();
        this.svg.appendChild(label);

        this.groupElems[key] = { boundary: boundary, label: label };
      }, this);
    }

    /** SVG path for a rounded rectangle with corner radius `cr`. */
    _roundedRectPath(x1, y1, x2, y2, cr) {
      return 'M' + (x1 + cr).toFixed(1) + ',' + y1.toFixed(1) +
        ' L' + (x2 - cr).toFixed(1) + ',' + y1.toFixed(1) +
        ' A' + cr + ',' + cr + ' 0 0,1 ' + x2.toFixed(1) + ',' + (y1 + cr).toFixed(1) +
        ' L' + x2.toFixed(1) + ',' + (y2 - cr).toFixed(1) +
        ' A' + cr + ',' + cr + ' 0 0,1 ' + (x2 - cr).toFixed(1) + ',' + y2.toFixed(1) +
        ' L' + (x1 + cr).toFixed(1) + ',' + y2.toFixed(1) +
        ' A' + cr + ',' + cr + ' 0 0,1 ' + x1.toFixed(1) + ',' + (y2 - cr).toFixed(1) +
        ' L' + x1.toFixed(1) + ',' + (y1 + cr).toFixed(1) +
        ' A' + cr + ',' + cr + ' 0 0,1 ' + (x1 + cr).toFixed(1) + ',' + y1.toFixed(1) + ' Z';
    }

    _drawEdges() {
      this.model.edges.forEach(function (lk) {
        var a = this.model.idMap[lk.from], b = this.model.idMap[lk.to];
        if (!a || !b) return;

        var geom = this._edgeGeometry(a, b);

        var path = svgEl('path', { d: geom.d, fill: 'none', 'class': 'edge-link' });
        if (lk.type === 'dashed' || lk.type === 'dashed arrow') {
          path.setAttribute('stroke-dasharray', '6 4');
        }
        this.svg.appendChild(path);

        var arrowEl = null;
        if (lk.type === 'arrow' || lk.type === 'dashed arrow') {
          arrowEl = this._drawArrow(geom);
        }
        var labelEl = lk.label ? this._drawEdgeLabel(lk.label, geom.midX, geom.midY) : null;

        this.edgePaths.push({
          from: lk.from,
          to: lk.to,
          chainSource: lk.chainSource || null,
          el: path,
          labelEl: labelEl,
          arrowEl: arrowEl
        });
      }, this);
    }

    /**
     * Compute the SVG path, midpoint and arrow tip/direction for an edge.
     * Intra-section, left-to-right edges use a flat S-curve; everything else
     * uses a quadratic curve that bows around any nodes in the way.
     */
    _edgeGeometry(a, b) {
      var ax = a.cx, ay = a.cy, bx = b.cx, by = b.cy;
      var intra = a.section && b.section && a.section === b.section;
      var sx0 = ax + a.w / 2, tx0 = bx - b.w / 2;

      if (intra && tx0 > sx0 + 5) {
        var sx = sx0, sy = ay, tx = tx0, ty = by;
        var mx = (sx + tx) / 2;
        var d = 'M' + sx.toFixed(1) + ',' + sy.toFixed(1) +
          ' C' + mx.toFixed(1) + ',' + sy.toFixed(1) +
          ' ' + mx.toFixed(1) + ',' + ty.toFixed(1) +
          ' ' + tx.toFixed(1) + ',' + ty.toFixed(1);
        return {
          d: d,
          // cubic midpoint at t=0.5: 0.125·P0 + 0.375·P1 + 0.375·P2 + 0.125·P3
          midX: 0.125 * sx + 0.375 * mx + 0.375 * mx + 0.125 * tx,
          midY: 0.125 * sy + 0.375 * sy + 0.375 * ty + 0.125 * ty,
          endX: tx, endY: ty, endDx: tx - mx, endDy: 0
        };
      }

      var cp = this._curveControlPoint(a, b);
      var sp = port(ax, ay, cp.x - ax, cp.y - ay, a.w, a.h);
      var tp = port(bx, by, cp.x - bx, cp.y - by, b.w, b.h);
      var dq = 'M' + sp[0].toFixed(1) + ',' + sp[1].toFixed(1) +
        ' Q' + cp.x.toFixed(1) + ',' + cp.y.toFixed(1) +
        ' ' + tp[0].toFixed(1) + ',' + tp[1].toFixed(1);
      return {
        d: dq,
        // quadratic midpoint at t=0.5: 0.25·P0 + 0.5·CP + 0.25·P2
        midX: 0.25 * sp[0] + 0.5 * cp.x + 0.25 * tp[0],
        midY: 0.25 * sp[1] + 0.5 * cp.y + 0.25 * tp[1],
        endX: tp[0], endY: tp[1], endDx: tp[0] - cp.x, endDy: tp[1] - cp.y
      };
    }

    /**
     * Find a quadratic control point that keeps the curve clear of other nodes,
     * widening the bow (and alternating sides) until a clear path is found.
     */
    _curveControlPoint(a, b) {
      var nodes = this.model.nodes, N = nodes.length;
      var ax = a.cx, ay = a.cy, bx = b.cx, by = b.cy;
      var dx = bx - ax, dy = by - ay;
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      var px = -(dy / len), py = dx / len; // unit normal
      var mag = len * 0.15, sign = 1;
      var cpX = 0, cpY = 0;

      for (var attempt = 0; attempt < 8; attempt++) {
        cpX = (ax + bx) / 2 + mag * sign * px;
        cpY = (ay + by) / 2 + mag * sign * py;

        var hit = false;
        for (var s = 1; s <= 19 && !hit; s++) {
          var t = s / 20, mt = 1 - t;
          var qx = mt * mt * ax + 2 * mt * t * cpX + t * t * bx;
          var qy = mt * mt * ay + 2 * mt * t * cpY + t * t * by;
          for (var k = 0; k < N && !hit; k++) {
            var n = nodes[k];
            if (n === a || n === b) continue;
            if (qx > n.cx - n.w / 2 && qx < n.cx + n.w / 2 &&
                qy > n.cy - n.h / 2 && qy < n.cy + n.h / 2) {
              hit = true;
            }
          }
        }
        if (!hit) break;
        sign = -sign;
        if (sign > 0) mag += len * 0.15;
      }
      return { x: cpX, y: cpY };
    }

    /** Draw a filled arrowhead at the edge tip (hidden until hover via CSS). */
    _drawArrow(geom) {
      var aw = this.config.arrowWidth, al = this.config.arrowLen;
      var len = Math.sqrt(geom.endDx * geom.endDx + geom.endDy * geom.endDy) || 1;
      var ux = geom.endDx / len, uy = geom.endDy / len;
      var bx = geom.endX - al * ux, by = geom.endY - al * uy;
      var d = 'M' + geom.endX.toFixed(1) + ',' + geom.endY.toFixed(1) +
        ' L' + (bx - aw * uy).toFixed(1) + ',' + (by + aw * ux).toFixed(1) +
        ' L' + (bx + aw * uy).toFixed(1) + ',' + (by - aw * ux).toFixed(1) + ' Z';

      var arrow = svgEl('path', { d: d, fill: 'currentColor', 'class': 'edge-arrow-head' });
      this.svgTop.appendChild(arrow);
      return arrow;
    }

    /** Draw a pill-backed, word-wrapped edge label centred at (midX, midY). */
    _drawEdgeLabel(text, midX, midY) {
      var group = svgEl('g', {
        'class': 'edge-label',
        transform: 'translate(' + midX.toFixed(1) + ',' + midY.toFixed(1) + ')'
      });
      var textEl = svgEl('text', { 'text-anchor': 'middle' });
      group.appendChild(textEl);
      this.svgTop.appendChild(group);

      this._wrapText(textEl, text, this.config.edgeWrapWidth);

      // Shift the text so its visual centre sits at the group origin.
      var tbb = textEl.getBBox();
      textEl.setAttribute('transform', 'translate(0,' + (-tbb.y - tbb.height / 2).toFixed(1) + ')');

      var bb = group.getBBox();
      var lpx = this.config.labelPadX, lpy = this.config.labelPadY;
      var rect = svgEl('rect', {
        x: (bb.x - lpx).toFixed(1),
        y: (bb.y - lpy).toFixed(1),
        width: (bb.width + lpx * 2).toFixed(1),
        height: (bb.height + lpy * 2).toFixed(1),
        rx: this.config.labelRadius
      });
      group.insertBefore(rect, textEl);
      return group;
    }

    /** Fill `textEl` with wrapped <tspan> lines; returns the line count. */
    _wrapText(textEl, str, maxW) {
      var words = str.split(/\s+/);
      var lines = [], cur = '';
      words.forEach(function (w) {
        var trial = cur ? cur + ' ' + w : w;
        textEl.textContent = trial;
        if (cur && textEl.getBBox().width > maxW) { lines.push(cur); cur = w; }
        else cur = trial;
      });
      if (cur) lines.push(cur);

      textEl.textContent = '';
      lines.forEach(function (line, i) {
        var ts = svgEl('tspan', { x: '0', dy: i ? '1.3em' : '0' });
        ts.textContent = line;
        textEl.appendChild(ts);
      });
      return lines.length;
    }
  }

  // HoverController

  /**
   * On node hover, highlights the node, its outgoing edges, any chains it
   * sources, and the groups that contain the highlighted nodes.
   */
  class HoverController {
    /**
     * @param {HTMLElement} viewport
     * @param {GraphModel} model
     * @param {Record<string, {boundary: SVGElement, label: SVGElement}>} groupElems
     * @param {EdgeRef[]} edgePaths
     * @param {number} clearMs
     */
    constructor(viewport, model, groupElems, edgePaths, clearMs) {
      this.VP = viewport;
      this.model = model;
      this.groupElems = groupElems;
      this.edgePaths = edgePaths;
      this.clearMs = clearMs;
      this.hoveredId = null;
      this.clearTimer = null;
    }

    bind() {
      var self = this;

      // Hover is driven by pointer *position*, not enter/leave bookkeeping.
      // Every pointermove re-reads the real element under the cursor, so a late
      // or janky frame can never leave a node falsely "cleared" — the next move
      // corrects it. (Enter/leave + a blind timer raced under load on large,
      // dense graphs, producing the dim→bright→dim flicker.) A clear only fires
      // after the pointer genuinely dwells over empty space for `clearMs`.
      this.VP.addEventListener('pointermove', function (e) {
        var nodeEl = e.target && e.target.closest ? e.target.closest('.graph-node') : null;
        var node = nodeEl ? self.model.idMap[nodeEl.id.replace('node-', '')] : null;
        if (node) self._applyNodeHover(node); // cancels any pending clear
        else self._scheduleClear();
      });

      // Leaving the viewport entirely clears immediately.
      this.VP.addEventListener('pointerleave', function () {
        if (self.clearTimer !== null) { clearTimeout(self.clearTimer); self.clearTimer = null; }
        if (self.hoveredId !== null) self._clear();
      });
    }

    /** Clear after a short dwell over empty space; node hovers cancel it. */
    _scheduleClear() {
      if (this.hoveredId === null || this.clearTimer !== null) return;
      var self = this;
      this.clearTimer = setTimeout(function () {
        self.clearTimer = null;
        self._clear();
      }, this.clearMs);
    }

    /** @param {GraphNode} node */
    _applyNodeHover(node) {
      if (this.clearTimer !== null) { clearTimeout(this.clearTimer); this.clearTimer = null; }
      if (this.hoveredId === node.id) return;
      this.hoveredId = node.id;
      this.VP.classList.add('has-hover');

      var model = this.model;

      // Highlight set: the node, the targets of its direct edges, and every
      // member of chains it sources.
      var highlighted = {};
      highlighted[node.id] = true;
      this.edgePaths.forEach(function (ep) {
        if (ep.chainSource || ep.from !== node.id) return;
        highlighted[ep.to] = true;
      });
      (model.chainsByNode[node.id] || []).forEach(function (ci) {
        model.validChains[ci].forEach(function (nid) { highlighted[nid] = true; });
      });

      model.nodes.forEach(function (n) {
        n.el.classList.toggle('is-highlighted', !!highlighted[n.id]);
      });
      this.edgePaths.forEach(function (ep) {
        var hit = ep.chainSource ? ep.chainSource === node.id : ep.from === node.id;
        ep.el.classList.toggle('is-highlighted', hit);
        if (ep.labelEl) ep.labelEl.classList.toggle('is-highlighted', hit);
        if (ep.arrowEl) ep.arrowEl.classList.toggle('is-highlighted', hit);
      });

      // A group is connected if it (or, transitively, an ancestor) holds a
      // highlighted node.
      var connected = {};
      model.allGroupKeys.forEach(function (key) {
        var members = model.groupMap[key];
        for (var i = 0; i < members.length; i++) {
          if (highlighted[members[i].id]) { connected[key] = true; break; }
        }
      });
      model.allGroupKeys.forEach(function (key) {
        if (!connected[key]) return;
        var parts = key.split('/');
        for (var i = 1; i < parts.length; i++) {
          connected[parts.slice(0, i).join('/')] = true;
        }
      });

      var groupElems = this.groupElems;
      model.allGroupKeys.forEach(function (key) {
        var ge = groupElems[key];
        if (!ge) return;
        ge.boundary.classList.toggle('is-highlighted', !!connected[key]);
        ge.label.classList.toggle('is-highlighted', !!connected[key]);
      });
    }

    _clear() {
      this.hoveredId = null;
      this.VP.classList.remove('has-hover');
      this.model.nodes.forEach(function (n) { n.el.classList.remove('is-highlighted'); });
      this.edgePaths.forEach(function (ep) {
        ep.el.classList.remove('is-highlighted');
        if (ep.labelEl) ep.labelEl.classList.remove('is-highlighted');
        if (ep.arrowEl) ep.arrowEl.classList.remove('is-highlighted');
      });
      var groupElems = this.groupElems;
      this.model.allGroupKeys.forEach(function (key) {
        var ge = groupElems[key];
        if (!ge) return;
        ge.boundary.classList.remove('is-highlighted');
        ge.label.classList.remove('is-highlighted');
      });
    }
  }

  // PanZoomController

  /** Drag-to-pan and wheel-to-zoom over the canvas, fitted on first paint. */
  class PanZoomController {
    /**
     * @param {HTMLElement} viewport
     * @param {HTMLElement} canvas
     * @param {typeof CONFIG} config
     * @param {number} vpW
     * @param {number} vpH
     * @param {number} canvasW
     * @param {number} canvasH
     */
    constructor(viewport, canvas, config, vpW, vpH, canvasW, canvasH) {
      this.VP = viewport;
      this.canvas = canvas;
      this.config = config;
      this.zoom = Math.min(1, vpW / canvasW, vpH / canvasH);
      this.panX = (vpW - canvasW * this.zoom) / 2;
      this.panY = (vpH - canvasH * this.zoom) / 2;
      this.isPanning = false;
      this.startX = 0;
      this.startY = 0;
    }

    bind() {
      var self = this;
      this.VP.style.overflow = 'hidden';
      this._applyTransform();

      this.VP.addEventListener('mousedown', function (e) {
        if (e.target.closest && e.target.closest('.graph-node')) return;
        self.isPanning = true;
        self.startX = e.clientX - self.panX;
        self.startY = e.clientY - self.panY;
        self.VP.style.cursor = 'grabbing';
        e.preventDefault();
      });

      document.addEventListener('mousemove', function (e) {
        if (!self.isPanning) return;
        self.panX = e.clientX - self.startX;
        self.panY = e.clientY - self.startY;
        self._applyTransform();
      });

      document.addEventListener('mouseup', function () {
        if (self.isPanning) {
          self.isPanning = false;
          self.VP.style.cursor = '';
        }
      });

      this.VP.addEventListener('wheel', function (e) {
        e.preventDefault();
        var factor = e.deltaY < 0 ? self.config.zoomStep : 1 / self.config.zoomStep;
        var newZoom = Math.max(self.config.zoomMin, Math.min(self.config.zoomMax, self.zoom * factor));
        var rect = self.VP.getBoundingClientRect();
        var mx = e.clientX - rect.left, my = e.clientY - rect.top;
        self.panX = mx - (mx - self.panX) * (newZoom / self.zoom);
        self.panY = my - (my - self.panY) * (newZoom / self.zoom);
        self.zoom = newZoom;
        self._applyTransform();
      }, { passive: false });
    }

    _applyTransform() {
      this.canvas.style.transform =
        'translate(' + Math.round(this.panX) + 'px,' + Math.round(this.panY) + 'px)' +
        ' scale(' + this.zoom.toFixed(4) + ')';
    }
  }

  // LabelsToggle

  /** The "Labels" button: toggles edge-label visibility on the viewport. */
  class LabelsToggle {
    /**
     * @param {HTMLElement} viewport
     * @param {HTMLElement|null} button
     */
    constructor(viewport, button) {
      if (!button) return;
      button.addEventListener('click', function () {
        var on = viewport.classList.toggle('labels-enabled');
        button.classList.toggle('is-active', on);
        button.setAttribute('aria-pressed', String(on));
      });
    }
  }

  // GraphApp

  /** Top-level orchestrator: parse → model → layout → render → wire interaction. */
  class GraphApp {
    /** @param {HTMLElement} viewport */
    constructor(viewport) {
      this.VP = viewport;
    }

    init() {
      var rawData = this._readData();
      if (rawData === null) return;

      var nodeEls = Array.from(this.VP.querySelectorAll('.graph-node'));
      if (!nodeEls.length) return;

      var model = new GraphModel(nodeEls, rawData, CONFIG);

      var size = new LayoutEngine(model, CONFIG, this.VP).run();

      var vpW = this.VP.offsetWidth || window.innerWidth;
      var vpH = this.VP.offsetHeight ||
        Math.max(window.innerHeight - this.VP.getBoundingClientRect().top - 4, 480);

      var rendered = new GraphRenderer(model, CONFIG, this.VP, size.canvasW, size.canvasH).render();

      new HoverController(this.VP, model, rendered.groupElems, rendered.edgePaths, CONFIG.hoverClearMs).bind();
      new PanZoomController(this.VP, rendered.canvas, CONFIG, vpW, vpH, size.canvasW, size.canvasH).bind();

      this.VP.classList.add('is-ready');
      new LabelsToggle(this.VP, document.getElementById('labels-toggle'));
    }

    /** @returns {object|Array|null} parsed graph data, or null if unavailable. */
    _readData() {
      var dataEl = document.getElementById('note-links');
      if (!dataEl) return null;
      try {
        return JSON.parse(dataEl.textContent || 'null');
      } catch (e) {
        return null;
      }
    }
  }

  // Bootstrap

  /**
   * @typedef {object} EdgeRef
   * @property {string} from
   * @property {string} to
   * @property {string|null} chainSource
   * @property {SVGElement} el
   * @property {SVGElement|null} labelEl
   * @property {SVGElement|null} arrowEl
   */

  var viewport = document.getElementById('graph-viewport');
  if (viewport) new GraphApp(viewport).init();
}());
