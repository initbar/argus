(function () {
  var VP = document.getElementById('graph-viewport');
  if (!VP) return;

  var rawData   = JSON.parse(document.getElementById('note-links').textContent);
  var rawLinks  = Array.isArray(rawData) ? rawData : (rawData.edges  || []);
  var rawChains = (Array.isArray(rawData) ? [] : (rawData.chains || [])).map(function (ch) {
    return Array.isArray(ch) ? ch : (ch.nodes || []);
  });
  var nodeEls  = Array.from(VP.querySelectorAll('.graph-node'));
  if (!nodeEls.length) return;

  // ── Constants ──────────────────────────────────────────────────────────────
  var HULL_PAD        = 48;
  var GROUP_PADDING   = 24;  // min gap: a group's inner border → its children (nodes or child groups)
  var GROUP_MARGIN    = 24;  // min gap: outer border of one sibling group → outer border of another
  var SECTION_MARGIN  = GROUP_MARGIN; // same spacing as sub-groups; balanced without forced vacuum
  var PAD             = 90;

  // ── Build data structures ─────────────────────────────────────────────────
  var nodes = nodeEls.map(function (el) {
    var rawPath  = el.dataset.path || '';
    var parts    = rawPath.split('/').filter(Boolean).map(function (p) {
      return p.replace(/-/g, ' ');
    });
    var groups   = parts.map(function (_, i) { return parts.slice(0, i + 1).join('/'); });
    return {
      id:      el.id.replace('node-', ''),
      el:      el,
      section: parts[0] || '',
      groups:  groups,
      x: 0, y: 0, vx: 0, vy: 0, fx: 0, fy: 0,
      w: 0, h: 0,
      cx: 0, cy: 0  // canvas-relative coords (set after layout)
    };
  });
  var idMap = {};
  nodes.forEach(function (n) { idMap[n.id] = n; });

  // Deduplicate: A→B and B→A collapse to one edge; prefer the entry with a label
  var edgePairMap = {};
  rawLinks.filter(function (lk) {
    return idMap[lk.from] && idMap[lk.to];
  }).forEach(function (lk) {
    var key = [lk.from, lk.to].sort().join('|');
    if (!edgePairMap[key] || (!edgePairMap[key].label && lk.label)) {
      edgePairMap[key] = lk;
    }
  });
  var edges = Object.keys(edgePairMap).map(function (k) { return edgePairMap[k]; });

  // Filter chains to known nodes; keep only chains with 2+ valid members
  var validChains = rawChains.map(function (ch) {
    return ch.filter(function (id) { return idMap[id]; });
  }).filter(function (ch) { return ch.length >= 2; });

  // Index: sourceId → [chainIndex, …] — only the first node (chain source) triggers highlight
  var chainsByNode = {};
  validChains.forEach(function (ch, ci) {
    var src = ch[0];
    if (!chainsByNode[src]) chainsByNode[src] = [];
    chainsByNode[src].push(ci);
  });

  // Index: "a|b" (sorted) → { sourceId: true } — which chain sources own each consecutive pair
  var chainEdgeSources = {};
  validChains.forEach(function (ch) {
    var src = ch[0];
    for (var i = 0; i < ch.length - 1; i++) {
      var key = [ch[i], ch[i + 1]].sort().join('|');
      if (!chainEdgeSources[key]) chainEdgeSources[key] = {};
      chainEdgeSources[key][src] = true;
    }
  });

  var groupMap = {};
  nodes.forEach(function (n) {
    n.groups.forEach(function (g) {
      if (!groupMap[g]) groupMap[g] = [];
      groupMap[g].push(n);
    });
  });
  var allGroupKeys = Object.keys(groupMap).sort(function (a, b) {
    return a.split('/').length - b.split('/').length;
  });

  var sectionMap = {};
  allGroupKeys.forEach(function (k) {
    if (k.indexOf('/') === -1) sectionMap[k] = groupMap[k];
  });
  var sections   = Object.keys(sectionMap);
  var nestedKeys = allGroupKeys.filter(function (k) { return k.indexOf('/') !== -1; });

  // ── Measure natural node sizes ────────────────────────────────────────────
  nodes.forEach(function (n) {
    n.w = Math.max(n.el.offsetWidth,  120);
    n.h = Math.max(n.el.offsetHeight,  48);
  });

  var N  = nodes.length;
  var VW = VP.offsetWidth  || window.innerWidth;
  var VH = Math.max(window.innerHeight - VP.getBoundingClientRect().top - 4, 480);

  // ── Initialise on a circle ────────────────────────────────────────────────
  var R0 = Math.max(180, Math.min(Math.min(VW, VH) * 0.32, 420));
  nodes.forEach(function (n, i) {
    var angle = (2 * Math.PI * i / N) - Math.PI / 2;
    n.x = VW / 2 + R0 * Math.cos(angle);
    n.y = VH / 2 + R0 * Math.sin(angle);
  });

  // ── Force-directed simulation ─────────────────────────────────────────────
  var REPEL    = 32000;
  var SPRING   = 0.04;
  var IDEAL    = 280;
  var GRAV     = 0.008;
  var COHESION = 0.015;
  var DAMP     = 0.74;
  var ITERS    = 800;

  for (var iter = 0; iter < ITERS; iter++) {
    var alpha = 1 - iter / ITERS;
    var i, j, ni, nj, ex, ey, ed, ef;

    nodes.forEach(function (n) { n.fx = 0; n.fy = 0; });

    for (i = 0; i < N; i++) {
      for (j = i + 1; j < N; j++) {
        ni = nodes[i]; nj = nodes[j];
        ex = nj.x - ni.x; ey = nj.y - ni.y;
        ed = Math.sqrt(Math.max(ex * ex + ey * ey, 1));
        var rf = REPEL / (ed * ed);
        ni.fx -= rf * ex / ed; ni.fy -= rf * ey / ed;
        nj.fx += rf * ex / ed; nj.fy += rf * ey / ed;
      }
    }

    edges.forEach(function (lk) {
      var a = idMap[lk.from], b = idMap[lk.to];
      if (!a || !b) return;
      ex = b.x - a.x; ey = b.y - a.y;
      ed = Math.sqrt(ex * ex + ey * ey) || 1;
      ef = SPRING * (ed - IDEAL);
      a.fx += ef * ex / ed; a.fy += ef * ey / ed;
      b.fx -= ef * ex / ed; b.fy -= ef * ey / ed;
    });

    sections.forEach(function (sec) {
      var sn = sectionMap[sec];
      if (sn.length < 2) return;
      var cx = 0, cy = 0;
      sn.forEach(function (n) { cx += n.x; cy += n.y; });
      cx /= sn.length; cy /= sn.length;
      sn.forEach(function (n) {
        n.fx -= COHESION * (n.x - cx);
        n.fy -= COHESION * (n.y - cy);
      });
    });

    allGroupKeys.forEach(function (key) {
      if (key.indexOf('/') === -1) return;
      var sn = groupMap[key];
      if (sn.length < 2) return;
      var cx = 0, cy = 0;
      sn.forEach(function (n) { cx += n.x; cy += n.y; });
      cx /= sn.length; cy /= sn.length;
      sn.forEach(function (n) {
        n.fx -= 0.04 * (n.x - cx);
        n.fy -= 0.04 * (n.y - cy);
      });
    });

    for (var gsi = 0; gsi < sections.length; gsi++) {
      for (var gsj = gsi + 1; gsj < sections.length; gsj++) {
        var gsni = sectionMap[sections[gsi]];
        var gsnj = sectionMap[sections[gsj]];
        var gcxi = 0, gcyi = 0, gcxj = 0, gcyj = 0;
        gsni.forEach(function (n) { gcxi += n.x; gcyi += n.y; });
        gsnj.forEach(function (n) { gcxj += n.x; gcyj += n.y; });
        gcxi /= gsni.length; gcyi /= gsni.length;
        gcxj /= gsnj.length; gcyj /= gsnj.length;
        var gdx = gcxj - gcxi, gdy = gcyj - gcyi;
        var gd  = Math.sqrt(gdx * gdx + gdy * gdy) || 1;
        var avgAi = gsni.reduce(function (s, n) { return s + n.w * n.h; }, 0) / gsni.length;
        var avgAj = gsnj.reduce(function (s, n) { return s + n.w * n.h; }, 0) / gsnj.length;
        var gri = HULL_PAD + Math.sqrt(gsni.length * avgAi) / 2;
        var grj = HULL_PAD + Math.sqrt(gsnj.length * avgAj) / 2;
        if (gd < (gri + grj) * 2.2) {
          var grf = 32000 / (gd * gd);
          gsni.forEach(function (n) {
            n.fx -= grf * gdx / gd / gsni.length;
            n.fy -= grf * gdy / gd / gsni.length;
          });
          gsnj.forEach(function (n) {
            n.fx += grf * gdx / gd / gsnj.length;
            n.fy += grf * gdy / gd / gsnj.length;
          });
        }
      }
    }

    nodes.forEach(function (n) {
      n.fx -= GRAV * (n.x - VW / 2);
      n.fy -= GRAV * (n.y - VH / 2);
      n.vx = n.vx * DAMP + n.fx * alpha;
      n.vy = n.vy * DAMP + n.fy * alpha;
      n.x += n.vx;
      n.y += n.vy;
    });
  }

  // ── Per-section compact layout ────────────────────────────────────────────
  var SECT_COL_GAP = 2 * GROUP_PADDING + GROUP_MARGIN;
  var SECT_CELL_X  = 16;
  var SECT_CELL_Y  = 18;

  var subgroupOf = function (n) {
    return n.groups.length > 1 ? n.groups[n.groups.length - 1] : '';
  };

  sections.forEach(function (sec) {
    var sn = sectionMap[sec];
    if (!sn.length) return;

    var centX = 0, centY = 0;
    sn.forEach(function (n) { centX += n.x; centY += n.y; });
    centX /= sn.length; centY /= sn.length;

    var colMap = {};
    sn.forEach(function (n) {
      var k = subgroupOf(n);
      if (!colMap[k]) colMap[k] = [];
      colMap[k].push(n);
    });

    var colKeys = Object.keys(colMap).sort(function (a, b) {
      var ax = colMap[a].reduce(function (s, n) { return s + n.x; }, 0) / colMap[a].length;
      var bx = colMap[b].reduce(function (s, n) { return s + n.x; }, 0) / colMap[b].length;
      return ax - bx;
    });

    var grids = colKeys.map(function (k) {
      var byX = colMap[k].slice().sort(function (a, b) { return a.x - b.x; });
      var gc  = Math.max(1, Math.ceil(Math.sqrt(byX.length)));
      var gr  = Math.ceil(byX.length / gc);
      var columns = [];
      for (var c = 0; c < gc; c++) {
        columns.push(
          byX.slice(c * gr, (c + 1) * gr).sort(function (a, b) { return a.y - b.y; })
        );
      }
      var cws = columns.map(function (cn) {
        return cn.reduce(function (m, n) { return Math.max(m, n.w); }, 0);
      });
      var rhs = [];
      for (var r = 0; r < gr; r++) {
        var mh = 0;
        columns.forEach(function (cn) { if (cn[r]) mh = Math.max(mh, cn[r].h); });
        rhs.push(mh);
      }
      var tw = cws.reduce(function (s, w) { return s + w; }, 0) + Math.max(0, gc - 1) * SECT_CELL_X;
      var th = rhs.reduce(function (s, h) { return s + h; }, 0) + Math.max(0, gr - 1) * SECT_CELL_Y;
      return { columns: columns, cws: cws, rhs: rhs, gc: gc, gr: gr, tw: tw, th: th };
    });

    // Arrange sub-groups in a balanced 2-D grid (not just a horizontal row)
    var numSgCols = Math.max(1, Math.ceil(Math.sqrt(grids.length)));
    var numSgRows = Math.ceil(grids.length / numSgCols);

    var sgColWidths = [], sgRowHeights = [];
    for (var sgc = 0; sgc < numSgCols; sgc++) sgColWidths.push(0);
    for (var sgr = 0; sgr < numSgRows; sgr++) sgRowHeights.push(0);
    grids.forEach(function (g, gi) {
      var row = Math.floor(gi / numSgCols), col = gi % numSgCols;
      sgColWidths[col]  = Math.max(sgColWidths[col],  g.tw);
      sgRowHeights[row] = Math.max(sgRowHeights[row], g.th);
    });

    var sgColStarts = [0], sgRowStarts = [0];
    for (var sgci = 1; sgci < numSgCols; sgci++) {
      sgColStarts.push(sgColStarts[sgci - 1] + sgColWidths[sgci - 1] + SECT_COL_GAP);
    }
    for (var sgri = 1; sgri < numSgRows; sgri++) {
      sgRowStarts.push(sgRowStarts[sgri - 1] + sgRowHeights[sgri - 1] + SECT_COL_GAP);
    }

    var totalSgW = sgColStarts[numSgCols - 1] + sgColWidths[numSgCols - 1];
    var totalSgH = sgRowStarts[numSgRows - 1] + sgRowHeights[numSgRows - 1];

    grids.forEach(function (g, gi) {
      var row = Math.floor(gi / numSgCols), col = gi % numSgCols;
      var cellLeft = centX - totalSgW / 2 + sgColStarts[col];
      var cellTop  = centY - totalSgH / 2 + sgRowStarts[row];
      var colX = cellLeft;
      for (var c = 0; c < g.gc; c++) {
        var rowY = cellTop;
        for (var r = 0; r < g.columns[c].length; r++) {
          var nd = g.columns[c][r];
          nd.x = colX + g.cws[c] / 2;
          nd.y = rowY + g.rhs[r] / 2;
          rowY += g.rhs[r] + SECT_CELL_Y;
        }
        colX += g.cws[c] + SECT_CELL_X;
      }
    });
  });

  // ── Node overlap resolution (first pass) ─────────────────────────────────
  for (var ri = 0; ri < 120; ri++) {
    var anyOverlap = false;
    for (i = 0; i < N; i++) {
      for (j = i + 1; j < N; j++) {
        ni = nodes[i]; nj = nodes[j];
        var ox = (ni.w + nj.w) / 2 + 12 - Math.abs(nj.x - ni.x);
        var oy = (ni.h + nj.h) / 2 + 12 - Math.abs(nj.y - ni.y);
        if (ox > 0 && oy > 0) {
          anyOverlap = true;
          if (ox < oy) {
            var pushX = ox / 2 * (nj.x >= ni.x ? 1 : -1);
            ni.x -= pushX; nj.x += pushX;
          } else {
            var pushY = oy / 2 * (nj.y >= ni.y ? 1 : -1);
            ni.y -= pushY; nj.y += pushY;
          }
        }
      }
    }
    if (!anyOverlap) break;
  }

  // ── Group separation ──────────────────────────────────────────────────────
  // Returns the drawn bbox of any group at any depth using layout coords (n.x/n.y).
  // Recurses into direct child groups so each nesting level adds GROUP_PADDING
  // around its children's already-drawn borders.
  function groupLayoutBBox(key) {
    var directChildKeys = allGroupKeys.filter(function (k) {
      return k.substring(0, k.lastIndexOf('/')) === key;
    });
    var inChild = {};
    directChildKeys.forEach(function (ck) {
      groupMap[ck].forEach(function (n) { inChild[n.id] = true; });
    });
    var bx1 = Infinity, by1 = Infinity, bx2 = -Infinity, by2 = -Infinity;
    directChildKeys.forEach(function (ck) {
      var cb = groupLayoutBBox(ck);
      bx1 = Math.min(bx1, cb[0] - GROUP_PADDING);
      by1 = Math.min(by1, cb[1] - GROUP_PADDING);
      bx2 = Math.max(bx2, cb[2] + GROUP_PADDING);
      by2 = Math.max(by2, cb[3] + GROUP_PADDING);
    });
    groupMap[key].forEach(function (n) {
      if (inChild[n.id]) return;
      bx1 = Math.min(bx1, n.x - n.w / 2 - GROUP_PADDING);
      by1 = Math.min(by1, n.y - n.h / 2 - GROUP_PADDING);
      bx2 = Math.max(bx2, n.x + n.w / 2 + GROUP_PADDING);
      by2 = Math.max(by2, n.y + n.h / 2 + GROUP_PADDING);
    });
    return [bx1, by1, bx2, by2];
  }

  for (var gi = 0; gi < 150; gi++) {
    var anyGrp = false;
    for (var gsi2 = 0; gsi2 < sections.length; gsi2++) {
      for (var gsj2 = gsi2 + 1; gsj2 < sections.length; gsj2++) {
        var bi = groupLayoutBBox(sections[gsi2]);
        var bj = groupLayoutBBox(sections[gsj2]);
        var gox = Math.min(bi[2], bj[2]) - Math.max(bi[0], bj[0]) + GROUP_MARGIN;
        var goy = Math.min(bi[3], bj[3]) - Math.max(bi[1], bj[1]) + GROUP_MARGIN;
        if (gox > 0 && goy > 0) {
          anyGrp = true;
          var gsni2 = sectionMap[sections[gsi2]];
          var gsnj2 = sectionMap[sections[gsj2]];
          if (gox < goy) {
            var gcx_i = (bi[0] + bi[2]) / 2, gcx_j = (bj[0] + bj[2]) / 2;
            var gpush = gox / 2 * (gcx_j >= gcx_i ? 1 : -1);
            gsni2.forEach(function (n) { n.x -= gpush; });
            gsnj2.forEach(function (n) { n.x += gpush; });
          } else {
            var gcy_i = (bi[1] + bi[3]) / 2, gcy_j = (bj[1] + bj[3]) / 2;
            var gpush = goy / 2 * (gcy_j >= gcy_i ? 1 : -1);
            gsni2.forEach(function (n) { n.y -= gpush; });
            gsnj2.forEach(function (n) { n.y += gpush; });
          }
        }
      }
    }
    if (!anyGrp) break;
  }

  // ── Node overlap resolution (second pass) ─────────────────────────────────
  for (var ri2 = 0; ri2 < 80; ri2++) {
    var anyOvl2 = false;
    for (i = 0; i < N; i++) {
      for (j = i + 1; j < N; j++) {
        ni = nodes[i]; nj = nodes[j];
        var ox2 = (ni.w + nj.w) / 2 + 12 - Math.abs(nj.x - ni.x);
        var oy2 = (ni.h + nj.h) / 2 + 12 - Math.abs(nj.y - ni.y);
        if (ox2 > 0 && oy2 > 0) {
          anyOvl2 = true;
          if (ox2 < oy2) {
            var pX2 = ox2 / 2 * (nj.x >= ni.x ? 1 : -1);
            ni.x -= pX2; nj.x += pX2;
          } else {
            var pY2 = oy2 / 2 * (nj.y >= ni.y ? 1 : -1);
            ni.y -= pY2; nj.y += pY2;
          }
        }
      }
    }
    if (!anyOvl2) break;
  }

  // ── Sub-group separation ──────────────────────────────────────────────────
  for (var sgRound = 0; sgRound < 6; sgRound++) {

    for (var sgIt = 0; sgIt < 60; sgIt++) {
      var anySg = false;
      for (var sgi = 0; sgi < nestedKeys.length; sgi++) {
        for (var sgj = sgi + 1; sgj < nestedKeys.length; sgj++) {
          var ki = nestedKeys[sgi], kj = nestedKeys[sgj];
          var pi = ki.substring(0, ki.lastIndexOf('/'));
          var pj = kj.substring(0, kj.lastIndexOf('/'));
          if (pi !== pj) continue;
          var bi = groupLayoutBBox(ki), bj = groupLayoutBBox(kj);
          var sox = Math.min(bi[2], bj[2]) - Math.max(bi[0], bj[0]) + GROUP_MARGIN;
          var soy = Math.min(bi[3], bj[3]) - Math.max(bi[1], bj[1]) + GROUP_MARGIN;
          if (sox > 0 && soy > 0) {
            anySg = true;
            var sni = groupMap[ki], snj = groupMap[kj];
            if (sox < soy) {
              var sgCxi = (bi[0] + bi[2]) / 2, sgCxj = (bj[0] + bj[2]) / 2;
              var sgPushX = sox / 2 * (sgCxj >= sgCxi ? 1 : -1);
              sni.forEach(function (n) { n.x -= sgPushX; });
              snj.forEach(function (n) { n.x += sgPushX; });
            } else {
              var sgCyi = (bi[1] + bi[3]) / 2, sgCyj = (bj[1] + bj[3]) / 2;
              var sgPushY = soy / 2 * (sgCyj >= sgCyi ? 1 : -1);
              sni.forEach(function (n) { n.y -= sgPushY; });
              snj.forEach(function (n) { n.y += sgPushY; });
            }
          }
        }
      }
      if (!anySg) break;
    }

    for (var nmIt = 0; nmIt < 40; nmIt++) {
      var anyNm = false;
      for (var nki = 0; nki < nestedKeys.length; nki++) {
        var nkey     = nestedKeys[nki];
        var nmembers = groupMap[nkey];
        var nmSet    = {};
        nmembers.forEach(function (n) { nmSet[n.id] = true; });
        var nb   = groupLayoutBBox(nkey);
        var nbCx = (nb[0] + nb[2]) / 2, nbCy = (nb[1] + nb[3]) / 2;
        var nmGap = GROUP_MARGIN / 2; // min clearance between a node edge and a group border
        for (var nni = 0; nni < N; nni++) {
          var nn = nodes[nni];
          if (nmSet[nn.id]) continue;
          var nox = Math.min(nb[2], nn.x + nn.w / 2) - Math.max(nb[0], nn.x - nn.w / 2) + nmGap;
          var noy = Math.min(nb[3], nn.y + nn.h / 2) - Math.max(nb[1], nn.y - nn.h / 2) + nmGap;
          if (nox > 0 && noy > 0) {
            anyNm = true;
            if (nox < noy) {
              nn.x += nox * (nn.x >= nbCx ? 1 : -1);
            } else {
              nn.y += noy * (nn.y >= nbCy ? 1 : -1);
            }
          }
        }
      }
      if (!anyNm) break;
    }

    for (var ri3 = 0; ri3 < 40; ri3++) {
      var anyOvl3 = false;
      for (i = 0; i < N; i++) {
        for (j = i + 1; j < N; j++) {
          ni = nodes[i]; nj = nodes[j];
          var ox3 = (ni.w + nj.w) / 2 + 12 - Math.abs(nj.x - ni.x);
          var oy3 = (ni.h + nj.h) / 2 + 12 - Math.abs(nj.y - ni.y);
          if (ox3 > 0 && oy3 > 0) {
            anyOvl3 = true;
            if (ox3 < oy3) {
              var pX3 = ox3 / 2 * (nj.x >= ni.x ? 1 : -1);
              ni.x -= pX3; nj.x += pX3;
            } else {
              var pY3 = oy3 / 2 * (nj.y >= ni.y ? 1 : -1);
              ni.y -= pY3; nj.y += pY3;
            }
          }
        }
      }
      if (!anyOvl3) break;
    }
  }

  // ── Re-separate groups ────────────────────────────────────────────────────
  for (var gi2 = 0; gi2 < 150; gi2++) {
    var anyGrp2 = false;
    for (var gsi3 = 0; gsi3 < sections.length; gsi3++) {
      for (var gsj3 = gsi3 + 1; gsj3 < sections.length; gsj3++) {
        var bi2 = groupLayoutBBox(sections[gsi3]);
        var bj2 = groupLayoutBBox(sections[gsj3]);
        var gox2 = Math.min(bi2[2], bj2[2]) - Math.max(bi2[0], bj2[0]) + GROUP_MARGIN;
        var goy2 = Math.min(bi2[3], bj2[3]) - Math.max(bi2[1], bj2[1]) + GROUP_MARGIN;
        if (gox2 > 0 && goy2 > 0) {
          anyGrp2 = true;
          var gsni3 = sectionMap[sections[gsi3]];
          var gsnj3 = sectionMap[sections[gsj3]];
          if (gox2 < goy2) {
            var gcxi3 = (bi2[0] + bi2[2]) / 2, gcxj3 = (bj2[0] + bj2[2]) / 2;
            var gpush2 = gox2 / 2 * (gcxj3 >= gcxi3 ? 1 : -1);
            gsni3.forEach(function (n) { n.x -= gpush2; });
            gsnj3.forEach(function (n) { n.x += gpush2; });
          } else {
            var gcyi3 = (bi2[1] + bi2[3]) / 2, gcyj3 = (bj2[1] + bj2[3]) / 2;
            var gpush2 = goy2 / 2 * (gcyj3 >= gcyi3 ? 1 : -1);
            gsni3.forEach(function (n) { n.y -= gpush2; });
            gsnj3.forEach(function (n) { n.y += gpush2; });
          }
        }
      }
    }
    if (!anyGrp2) break;
  }

  // ── Final node overlap resolution ─────────────────────────────────────────
  for (var ri4 = 0; ri4 < 80; ri4++) {
    var anyOvl4 = false;
    for (i = 0; i < N; i++) {
      for (j = i + 1; j < N; j++) {
        ni = nodes[i]; nj = nodes[j];
        var ox4 = (ni.w + nj.w) / 2 + 12 - Math.abs(nj.x - ni.x);
        var oy4 = (ni.h + nj.h) / 2 + 12 - Math.abs(nj.y - ni.y);
        if (ox4 > 0 && oy4 > 0) {
          anyOvl4 = true;
          if (ox4 < oy4) {
            var pX4 = ox4 / 2 * (nj.x >= ni.x ? 1 : -1);
            ni.x -= pX4; nj.x += pX4;
          } else {
            var pY4 = oy4 / 2 * (nj.y >= ni.y ? 1 : -1);
            ni.y -= pY4; nj.y += pY4;
          }
        }
      }
    }
    if (!anyOvl4) break;
  }

  // ── Redistribute top-level sections for balance ───────────────────────────
  // Sort sections by their current bbox x-centre, then place them left-to-right
  // with exactly SECTION_MARGIN between bbox edges.  Vertically centre the whole
  // arrangement so it sits symmetrically around y = 0.
  (function () {
    if (sections.length < 2) return;

    var items = sections.map(function (sec) {
      var bb = groupLayoutBBox(sec);
      return { key: sec, bb: bb };
    }).filter(function (item) {
      return isFinite(item.bb[0]);
    }).sort(function (a, b) {
      return ((a.bb[0] + a.bb[2]) / 2) - ((b.bb[0] + b.bb[2]) / 2);
    });

    if (items.length < 2) return;

    var totalW = items.reduce(function (s, item) {
      return s + (item.bb[2] - item.bb[0]);
    }, 0) + (items.length - 1) * SECTION_MARGIN;

    var curX = -totalW / 2;
    items.forEach(function (item) {
      var bw    = item.bb[2] - item.bb[0];
      var oldCx = (item.bb[0] + item.bb[2]) / 2;
      var dx    = curX + bw / 2 - oldCx;
      sectionMap[item.key].forEach(function (n) { n.x += dx; });
      curX += bw + SECTION_MARGIN;
    });

    var avgCy = items.reduce(function (s, item) {
      return s + (item.bb[1] + item.bb[3]) / 2;
    }, 0) / items.length;
    nodes.forEach(function (n) { n.y -= avgCy; });
  }());

  // ── Compute canvas bounding box ───────────────────────────────────────────
  var minX =  Infinity, minY =  Infinity;
  var maxX = -Infinity, maxY = -Infinity;
  nodes.forEach(function (n) {
    minX = Math.min(minX, n.x - n.w / 2); minY = Math.min(minY, n.y - n.h / 2);
    maxX = Math.max(maxX, n.x + n.w / 2); maxY = Math.max(maxY, n.y + n.h / 2);
  });
  var gW = maxX - minX, gH = maxY - minY;

  var vpW = VP.offsetWidth  || window.innerWidth;
  var vpH = VP.offsetHeight || Math.max(window.innerHeight - VP.getBoundingClientRect().top - 4, 480);

  var canvasW = gW + 2 * PAD;
  var canvasH = gH + 2 * PAD;
  var offX    = PAD;
  var offY    = PAD;

  nodes.forEach(function (n) {
    n.cx = n.x - minX + offX;
    n.cy = n.y - minY + offY;
  });

  // ── Create canvas wrapper ──────────────────────────────────────────────────
  VP.style.position = 'relative';
  var canvas = document.createElement('div');
  canvas.style.cssText =
    'position:absolute;left:0;top:0;width:' + canvasW + 'px;height:' + canvasH + 'px;' +
    'transform-origin:0 0;will-change:transform;';

  // ── SVG overlay (background — rendered behind nodes) ─────────────────────
  var ns  = 'http://www.w3.org/2000/svg';
  var svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('width',  canvasW);
  svg.setAttribute('height', canvasH);
  svg.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;overflow:visible;';
  canvas.appendChild(svg);

  nodes.forEach(function (n) {
    n.el.style.left   = (n.cx - n.w / 2) + 'px';
    n.el.style.top    = (n.cy - n.h / 2) + 'px';
    n.el.style.width  = n.w + 'px';
    n.el.style.height = n.h + 'px';
    canvas.appendChild(n.el);
  });

  // ── Label overlay SVG (rendered above nodes) ──────────────────────────────
  var svgTop = document.createElementNS(ns, 'svg');
  svgTop.setAttribute('aria-hidden', 'true');
  svgTop.setAttribute('width',  canvasW);
  svgTop.setAttribute('height', canvasH);
  svgTop.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;overflow:visible;';
  canvas.appendChild(svgTop);

  VP.appendChild(canvas);

  // ── Word-wrap helper: fills textEl with <tspan> lines, returns line count ──
  function wrapText(textEl, str, maxW) {
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
    lines.forEach(function (l, i) {
      var ts = document.createElementNS(ns, 'tspan');
      ts.setAttribute('x', '0');
      ts.setAttribute('dy', i ? '1.3em' : '0');
      ts.textContent = l;
      textEl.appendChild(ts);
    });
    return lines.length;
  }

  // ── Geometry helpers ──────────────────────────────────────────────────────
  function convexHull(pts) {
    if (pts.length <= 2) return pts.slice();
    var sorted = pts.slice().sort(function (a, b) {
      return a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1];
    });
    var lo = [], hi = [];
    sorted.forEach(function (p) {
      while (lo.length >= 2) {
        var a = lo[lo.length - 2], b = lo[lo.length - 1];
        if ((b[0]-a[0])*(p[1]-a[1]) - (b[1]-a[1])*(p[0]-a[0]) <= 0) lo.pop();
        else break;
      }
      lo.push(p);
    });
    sorted.slice().reverse().forEach(function (p) {
      while (hi.length >= 2) {
        var a = hi[hi.length - 2], b = hi[hi.length - 1];
        if ((b[0]-a[0])*(p[1]-a[1]) - (b[1]-a[1])*(p[0]-a[0]) <= 0) hi.pop();
        else break;
      }
      hi.push(p);
    });
    lo.pop(); hi.pop();
    return lo.concat(hi);
  }

  function roundedHullPath(pts, r) {
    var n = pts.length;
    if (n === 0) return '';
    if (n === 1) {
      var cx = pts[0][0], cy = pts[0][1];
      return 'M' + (cx + r) + ',' + cy +
             ' A' + r + ',' + r + ' 0 1,1 ' + (cx - r) + ',' + cy +
             ' A' + r + ',' + r + ' 0 1,1 ' + (cx + r) + ',' + cy + ' Z';
    }
    var segs = [];
    for (var i = 0; i < n; i++) {
      var p0 = pts[i], p1 = pts[(i + 1) % n];
      var dx = p1[0] - p0[0], dy = p1[1] - p0[1];
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      var nx = dy / len, ny = -dx / len;
      segs.push({
        sx: p0[0] + nx * r, sy: p0[1] + ny * r,
        tx: p1[0] + nx * r, ty: p1[1] + ny * r
      });
    }
    var last = segs[n - 1];
    var d = 'M' + last.tx.toFixed(1) + ',' + last.ty.toFixed(1);
    for (var i = 0; i < n; i++) {
      var s = segs[i];
      d += ' A' + r + ',' + r + ' 0 0,1 ' + s.sx.toFixed(1) + ',' + s.sy.toFixed(1);
      d += ' L' + s.tx.toFixed(1) + ',' + s.ty.toFixed(1);
    }
    return d + ' Z';
  }

  function port(cx, cy, dx, dy, w, h) {
    if (!dx && !dy) return [cx, cy];
    var hw = w / 2, hh = h / 2;
    var len = Math.sqrt(dx * dx + dy * dy);
    var ux = dx / len, uy = dy / len;
    var t = Math.min(
      ux ? hw / Math.abs(ux) : Infinity,
      uy ? hh / Math.abs(uy) : Infinity
    );
    return [cx + ux * t, cy + uy * t];
  }

  // ── Draw group boundaries (uses canvas coords n.cx / n.cy) ───────────────
  // Mirror of groupLayoutBBox but uses cx/cy (canvas coords set after layout).
  // Returns the drawn bbox — GROUP_PADDING around direct-child group borders
  // and direct nodes — for any group at any depth.
  function groupCanvasBBox(key) {
    var directChildKeys = allGroupKeys.filter(function (k) {
      return k.substring(0, k.lastIndexOf('/')) === key;
    });
    var inChild = {};
    directChildKeys.forEach(function (ck) {
      groupMap[ck].forEach(function (n) { inChild[n.id] = true; });
    });
    var bx1 = Infinity, by1 = Infinity, bx2 = -Infinity, by2 = -Infinity;
    directChildKeys.forEach(function (ck) {
      var cb = groupCanvasBBox(ck);
      bx1 = Math.min(bx1, cb[0] - GROUP_PADDING);
      by1 = Math.min(by1, cb[1] - GROUP_PADDING);
      bx2 = Math.max(bx2, cb[2] + GROUP_PADDING);
      by2 = Math.max(by2, cb[3] + GROUP_PADDING);
    });
    groupMap[key].forEach(function (n) {
      if (inChild[n.id]) return;
      bx1 = Math.min(bx1, n.cx - n.w / 2 - GROUP_PADDING);
      by1 = Math.min(by1, n.cy - n.h / 2 - GROUP_PADDING);
      bx2 = Math.max(bx2, n.cx + n.w / 2 + GROUP_PADDING);
      by2 = Math.max(by2, n.cy + n.h / 2 + GROUP_PADDING);
    });
    return [bx1, by1, bx2, by2];
  }

  var groupElems = {};
  allGroupKeys.forEach(function (key) {
    var depth  = key.split('/').length;
    var nested = depth > 1;
    var bb = groupCanvasBBox(key);
    var bx1 = bb[0], by1 = bb[1], bx2 = bb[2], by2 = bb[3];
    if (!isFinite(bx1)) return;

    var cr = GROUP_PADDING;
    var d = 'M' + (bx1 + cr).toFixed(1) + ',' + by1.toFixed(1) +
            ' L' + (bx2 - cr).toFixed(1) + ',' + by1.toFixed(1) +
            ' A' + cr + ',' + cr + ' 0 0,1 ' + bx2.toFixed(1) + ',' + (by1 + cr).toFixed(1) +
            ' L' + bx2.toFixed(1) + ',' + (by2 - cr).toFixed(1) +
            ' A' + cr + ',' + cr + ' 0 0,1 ' + (bx2 - cr).toFixed(1) + ',' + by2.toFixed(1) +
            ' L' + (bx1 + cr).toFixed(1) + ',' + by2.toFixed(1) +
            ' A' + cr + ',' + cr + ' 0 0,1 ' + bx1.toFixed(1) + ',' + (by2 - cr).toFixed(1) +
            ' L' + bx1.toFixed(1) + ',' + (by1 + cr).toFixed(1) +
            ' A' + cr + ',' + cr + ' 0 0,1 ' + (bx1 + cr).toFixed(1) + ',' + by1.toFixed(1) + ' Z';

    var boundary = document.createElementNS(ns, 'path');
    boundary.setAttribute('d',                d);
    boundary.setAttribute('fill',             'none');
    boundary.setAttribute('stroke-width',     '1.5');
    boundary.setAttribute('stroke-dasharray', '5 4');
    boundary.setAttribute('class', 'group-boundary ' + (nested ? 'group-nested' : 'group-outer'));
    svg.appendChild(boundary);

    var label = key.split('/').pop().toUpperCase();
    var lbl   = document.createElementNS(ns, 'text');
    lbl.setAttribute('x',              ((bx1 + bx2) / 2).toFixed(1));
    lbl.setAttribute('y',              (by1 - 6).toFixed(1));
    lbl.setAttribute('text-anchor',    'middle');
    lbl.setAttribute('font-size',      nested ? '11' : '12');
    lbl.setAttribute('letter-spacing', '1');
    lbl.setAttribute('fill',           'currentColor');
    lbl.setAttribute('class', 'group-label ' + (nested ? 'group-nested' : 'group-outer'));
    lbl.textContent = label;
    svg.appendChild(lbl);

    groupElems[key] = { boundary: boundary, label: lbl };
  });

  // ── Draw edges (uses canvas coords; stores refs for hover) ────────────────
  var edgePaths = [];
  edges.forEach(function (lk) {
    var a = idMap[lk.from], b = idMap[lk.to];
    if (!a || !b) return;

    var ax = a.cx, ay = a.cy, bx = b.cx, by = b.cy;
    var d;
    var midX, midY;
    var endX, endY, endDx, endDy; // tip position and direction for arrowhead

    var intra = a.section && b.section && a.section === b.section;

    if (intra && bx > ax + 10) {
      var sx = ax + a.w / 2, sy = ay;
      var tx = bx - b.w / 2, ty = by;
      var mx = (sx + tx) / 2;
      d = 'M'  + sx.toFixed(1) + ',' + sy.toFixed(1) +
          ' C' + mx.toFixed(1) + ',' + sy.toFixed(1) +
          ' '  + mx.toFixed(1) + ',' + ty.toFixed(1) +
          ' '  + tx.toFixed(1) + ',' + ty.toFixed(1);
      // cubic bezier midpoint at t=0.5: 0.125*P0 + 0.375*P1 + 0.375*P2 + 0.125*P3
      midX = 0.125 * sx + 0.375 * mx + 0.375 * mx + 0.125 * tx;
      midY = 0.125 * sy + 0.375 * sy + 0.375 * ty + 0.125 * ty;
      endX = tx; endY = ty; endDx = tx - mx; endDy = 0;
    } else {
      var dx = bx - ax, dy = by - ay;
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      var ux = dx / len, uy = dy / len;
      var px = -uy, py = ux;
      var oMag = len * 0.15, oSign = 1;
      var cpX, cpY;
      for (var oA = 0; oA < 8; oA++) {
        cpX = (ax + bx) / 2 + oMag * oSign * px;
        cpY = (ay + by) / 2 + oMag * oSign * py;
        var oHit = false;
        for (var oS = 1; oS <= 19 && !oHit; oS++) {
          var oT = oS / 20, oMt = 1 - oT;
          var oQx = oMt * oMt * ax + 2 * oMt * oT * cpX + oT * oT * bx;
          var oQy = oMt * oMt * ay + 2 * oMt * oT * cpY + oT * oT * by;
          for (var oK = 0; oK < N && !oHit; oK++) {
            var oN = nodes[oK];
            if (oN === a || oN === b) continue;
            if (oQx > oN.cx - oN.w / 2 && oQx < oN.cx + oN.w / 2 &&
                oQy > oN.cy - oN.h / 2 && oQy < oN.cy + oN.h / 2) {
              oHit = true;
            }
          }
        }
        if (!oHit) break;
        oSign = -oSign;
        if (oSign > 0) oMag += len * 0.15;
      }
      var sp = port(ax, ay, cpX - ax, cpY - ay, a.w, a.h);
      var tp = port(bx, by, cpX - bx, cpY - by, b.w, b.h);
      d = 'M'  + sp[0].toFixed(1) + ',' + sp[1].toFixed(1) +
          ' Q' + cpX.toFixed(1)   + ',' + cpY.toFixed(1) +
          ' '  + tp[0].toFixed(1) + ',' + tp[1].toFixed(1);
      // quadratic bezier midpoint at t=0.5: 0.25*P0 + 0.5*CP + 0.25*P2
      midX = 0.25 * sp[0] + 0.5 * cpX + 0.25 * tp[0];
      midY = 0.25 * sp[1] + 0.5 * cpY + 0.25 * tp[1];
      endX = tp[0]; endY = tp[1]; endDx = tp[0] - cpX; endDy = tp[1] - cpY;
    }

    var path = document.createElementNS(ns, 'path');
    path.setAttribute('d',     d);
    path.setAttribute('fill',  'none');
    path.setAttribute('class', 'edge-link');
    if (lk.type === 'dashed' || lk.type === 'dashed arrow') {
      path.setAttribute('stroke-dasharray', '6 4');
    }
    svg.appendChild(path);

    // Arrowhead drawn as a filled triangle; hidden by default, shown on hover
    var arrowEl = null;
    if (lk.type === 'arrow' || lk.type === 'dashed arrow') {
      var aLen = Math.sqrt(endDx * endDx + endDy * endDy) || 1;
      var aux = endDx / aLen, auy = endDy / aLen;
      var aw = 5, al = 9;
      var bpx = endX - al * aux, bpy = endY - al * auy;
      var arrowD = 'M' + endX.toFixed(1)               + ',' + endY.toFixed(1) +
                   ' L' + (bpx - aw * auy).toFixed(1)  + ',' + (bpy + aw * aux).toFixed(1) +
                   ' L' + (bpx + aw * auy).toFixed(1)  + ',' + (bpy - aw * aux).toFixed(1) + ' Z';
      arrowEl = document.createElementNS(ns, 'path');
      arrowEl.setAttribute('d',     arrowD);
      arrowEl.setAttribute('fill',  'currentColor');
      arrowEl.setAttribute('class', 'edge-arrow-head');
      svg.appendChild(arrowEl);
    }

    var labelEl = null;
    if (lk.label) {
      var labelG = document.createElementNS(ns, 'g');
      labelG.setAttribute('class',     'edge-label');
      labelG.setAttribute('transform', 'translate(' + midX.toFixed(1) + ',' + midY.toFixed(1) + ')');

      var labelText = document.createElementNS(ns, 'text');
      labelText.setAttribute('text-anchor', 'middle');
      labelG.appendChild(labelText);
      svgTop.appendChild(labelG);

      wrapText(labelText, lk.label, 180);

      // shift text so its visual centre sits at the group origin
      var tbb = labelText.getBBox();
      labelText.setAttribute('transform', 'translate(0,' + (-tbb.y - tbb.height / 2).toFixed(1) + ')');

      var bb = labelG.getBBox();
      var lpx = 10, lpy = 6;
      var labelRect = document.createElementNS(ns, 'rect');
      labelRect.setAttribute('x',      (bb.x - lpx).toFixed(1));
      labelRect.setAttribute('y',      (bb.y - lpy).toFixed(1));
      labelRect.setAttribute('width',  (bb.width  + lpx * 2).toFixed(1));
      labelRect.setAttribute('height', (bb.height + lpy * 2).toFixed(1));
      labelG.insertBefore(labelRect, labelText);

      labelEl = labelG;
    }

    edgePaths.push({ from: lk.from, to: lk.to, el: path, labelEl: labelEl, arrowEl: arrowEl });
  });

  // ── Hover highlighting ────────────────────────────────────────────────────
  nodes.forEach(function (hovN) {
    hovN.el.addEventListener('mouseenter', function () {
      VP.classList.add('has-hover');

      // Highlighted set: hovered node + targets of edges defined BY hovN
      // (ep.from === hovN.id for direct edges; chain source for chain edges)
      var highlightedNodes = {};
      highlightedNodes[hovN.id] = true;

      edgePaths.forEach(function (ep) {
        if (ep.from !== hovN.id) return;
        var edgeKey = [ep.from, ep.to].sort().join('|');
        if (!chainEdgeSources[edgeKey]) {
          highlightedNodes[ep.to] = true;
        }
      });
      (chainsByNode[hovN.id] || []).forEach(function (ci) {
        validChains[ci].forEach(function (nid) { highlightedNodes[nid] = true; });
      });

      nodes.forEach(function (n) {
        n.el.classList.toggle('is-highlighted', !!highlightedNodes[n.id]);
      });
      edgePaths.forEach(function (ep) {
        var edgeKey = [ep.from, ep.to].sort().join('|');
        var chainSrcs = chainEdgeSources[edgeKey];
        var hit;
        if (chainSrcs) {
          hit = !!chainSrcs[hovN.id];
        } else {
          hit = ep.from === hovN.id;
        }
        ep.el.classList.toggle('is-highlighted', hit);
        if (ep.labelEl)  ep.labelEl.classList.toggle('is-highlighted', hit);
        if (ep.arrowEl)  ep.arrowEl.classList.toggle('is-highlighted', hit);
      });

      var connNodeIds = highlightedNodes;

      var connGroups = {};
      allGroupKeys.forEach(function (key) {
        var members = groupMap[key];
        for (var mi = 0; mi < members.length; mi++) {
          if (connNodeIds[members[mi].id]) { connGroups[key] = true; break; }
        }
      });
      allGroupKeys.forEach(function (key) {
        if (!connGroups[key]) return;
        var parts = key.split('/');
        for (var pi = 1; pi < parts.length; pi++) {
          connGroups[parts.slice(0, pi).join('/')] = true;
        }
      });

      allGroupKeys.forEach(function (key) {
        var ge = groupElems[key];
        if (!ge) return;
        ge.boundary.classList.toggle('is-highlighted', !!connGroups[key]);
        ge.label.classList.toggle('is-highlighted', !!connGroups[key]);
      });
    });

    hovN.el.addEventListener('mouseleave', function () {
      VP.classList.remove('has-hover');
      nodes.forEach(function (n) { n.el.classList.remove('is-highlighted'); });
      edgePaths.forEach(function (ep) {
        ep.el.classList.remove('is-highlighted');
        if (ep.labelEl)  ep.labelEl.classList.remove('is-highlighted');
        if (ep.arrowEl)  ep.arrowEl.classList.remove('is-highlighted');
      });
      allGroupKeys.forEach(function (key) {
        var ge = groupElems[key];
        if (!ge) return;
        ge.boundary.classList.remove('is-highlighted');
        ge.label.classList.remove('is-highlighted');
      });
    });
  });

  // ── Pan / zoom ────────────────────────────────────────────────────────────
  VP.style.overflow = 'hidden';

  var currentZoom = Math.min(1, vpW / canvasW, vpH / canvasH);
  var panX = (vpW - canvasW * currentZoom) / 2;
  var panY = (vpH - canvasH * currentZoom) / 2;

  function applyTransform() {
    canvas.style.transform =
      'translate(' + panX.toFixed(2) + 'px,' + panY.toFixed(2) + 'px)' +
      ' scale(' + currentZoom.toFixed(4) + ')';
  }
  applyTransform();

  var isPanning = false, panSX = 0, panSY = 0;

  VP.addEventListener('mousedown', function (e) {
    if (e.target.closest && e.target.closest('.graph-node')) return;
    isPanning = true;
    panSX = e.clientX - panX;
    panSY = e.clientY - panY;
    VP.style.cursor = 'grabbing';
    e.preventDefault();
  });

  document.addEventListener('mousemove', function (e) {
    if (!isPanning) return;
    panX = e.clientX - panSX;
    panY = e.clientY - panSY;
    applyTransform();
  });

  document.addEventListener('mouseup', function () {
    if (isPanning) {
      isPanning = false;
      VP.style.cursor = '';
    }
  });

  VP.addEventListener('wheel', function (e) {
    e.preventDefault();
    var factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    var newZoom = Math.max(0.1, Math.min(5, currentZoom * factor));
    var rect = VP.getBoundingClientRect();
    var mx = e.clientX - rect.left;
    var my = e.clientY - rect.top;
    panX = mx - (mx - panX) * (newZoom / currentZoom);
    panY = my - (my - panY) * (newZoom / currentZoom);
    currentZoom = newZoom;
    applyTransform();
  }, { passive: false });

  VP.classList.add('is-ready');

  // ── Labels toggle ─────────────────────────────────────────────────────────
  var labelsBtn = document.getElementById('labels-toggle');
  if (labelsBtn) {
    labelsBtn.addEventListener('click', function () {
      var on = VP.classList.toggle('labels-enabled');
      labelsBtn.classList.toggle('is-active', on);
      labelsBtn.setAttribute('aria-pressed', String(on));
    });
  }
}());
