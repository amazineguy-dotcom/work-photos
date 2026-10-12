(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };

  var MAX_SIDE = 3000, QUALITY = 0.85, THUMB_SIDE = 480;
  // meta: {id, createdAt, caption, exportedAt, w, h, bytes, shapes, edited}
  var photos = [];
  var selecting = false, selected = new Set(), thumbUrls = {};

  /* ---------- helpers ---------- */
  function newId() { return "w" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function byId(id) { for (var i = 0; i < photos.length; i++) if (photos[i].id === id) return photos[i]; return null; }
  function pad(x) { return String(x).padStart(2, "0"); }
  function fmtTime(ms) { return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
  function dayLabel(ms) {
    var d = new Date(ms), n = new Date();
    if (d.toDateString() === n.toDateString()) return "Today";
    var y = new Date(n); y.setDate(n.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return "Yesterday";
    return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: d.getFullYear() === n.getFullYear() ? undefined : "numeric" });
  }
  function fmtBytes(b) {
    if (b < 1024 * 1024) return Math.max(1, Math.round(b / 1024)) + " KB";
    if (b < 1024 * 1024 * 1024) return (b / 1048576).toFixed(1) + " MB";
    return (b / 1073741824).toFixed(2) + " GB";
  }
  function toast(text, ms) {
    var t = $("toast");
    t.textContent = text; t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { t.hidden = true; }, ms || 2600);
  }
  // File name: 20261012_143052[_caption].jpg — caption cleaned for Windows/OneDrive.
  function fileName(p, used) {
    var d = new Date(p.createdAt);
    var base = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + "_" + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
    var cap = p.caption.trim().replace(/[\\/:*?"<>|#%]+/g, "").replace(/\s+/g, "-").replace(/^[.-]+|[.-]+$/g, "").slice(0, 40);
    var name = base + (cap ? "_" + cap : ""), n = 2, out = name;
    while (used[out.toLowerCase()]) out = name + "_" + (n++);
    used[out.toLowerCase()] = true;
    return out + ".jpg";
  }

  /* ---------- IndexedDB ---------- */
  var dbPromise = null;
  function db() {
    if (!dbPromise) {
      dbPromise = new Promise(function (res, rej) {
        var r = indexedDB.open("workphotos", 1);
        r.onupgradeneeded = function () {
          r.result.createObjectStore("meta", { keyPath: "id" });
          r.result.createObjectStore("blobs");
        };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { rej(r.error); };
      });
    }
    return dbPromise;
  }
  function tx(stores, mode, fn) {
    return db().then(function (d) {
      return new Promise(function (res, rej) {
        var t = d.transaction(stores, mode), out = fn(t);
        t.oncomplete = function () { res(out instanceof IDBRequest ? out.result : out); };
        t.onerror = t.onabort = function () { rej(t.error || new Error("tx")); };
      });
    });
  }
  function loadAll() { return tx(["meta"], "readonly", function (t) { return t.objectStore("meta").getAll(); }); }
  function putMeta(p) { return tx(["meta"], "readwrite", function (t) { t.objectStore("meta").put(p); }); }
  function getBlob(key) { return tx(["blobs"], "readonly", function (t) { return t.objectStore("blobs").get(key); }); }
  function savePhoto(p, blobs) {
    return tx(["meta", "blobs"], "readwrite", function (t) {
      t.objectStore("meta").put(p);
      Object.keys(blobs).forEach(function (k) {
        if (blobs[k]) t.objectStore("blobs").put(blobs[k], p.id + "/" + k);
        else t.objectStore("blobs").delete(p.id + "/" + k);
      });
    });
  }
  function deletePhotos(ids) {
    return tx(["meta", "blobs"], "readwrite", function (t) {
      ids.forEach(function (id) {
        t.objectStore("meta").delete(id);
        ["orig", "edit", "thumb"].forEach(function (k) { t.objectStore("blobs").delete(id + "/" + k); });
      });
    }).then(function () {
      ids.forEach(function (id) {
        if (thumbUrls[id]) { URL.revokeObjectURL(thumbUrls[id]); delete thumbUrls[id]; }
        selected.delete(id);
      });
      photos = photos.filter(function (p) { return ids.indexOf(p.id) === -1; });
    });
  }
  function fullBlob(p) { return p.edited ? getBlob(p.id + "/edit") : getBlob(p.id + "/orig"); }

  /* ---------- image processing ---------- */
  function loadImage(blob) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(blob), img = new Image();
      img.onload = function () { res({ img: img, url: url }); };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error("decode")); };
      img.src = url;
    });
  }
  function canvasBlob(c, q) {
    return new Promise(function (res, rej) { c.toBlob(function (b) { b ? res(b) : rej(new Error("encode")); }, "image/jpeg", q); });
  }
  function scaled(src, w, h, max, q) {
    var k = Math.min(1, max / Math.max(w, h)), c = document.createElement("canvas");
    c.width = Math.round(w * k); c.height = Math.round(h * k);
    c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
    return canvasBlob(c, q).then(function (b) { return { blob: b, w: c.width, h: c.height }; });
  }
  // Re-encoding also strips EXIF (including GPS) from the stored copy.
  function ingest(file, when) {
    return loadImage(file).then(function (o) {
      var w = o.img.naturalWidth, h = o.img.naturalHeight;
      return Promise.all([scaled(o.img, w, h, MAX_SIDE, QUALITY), scaled(o.img, w, h, THUMB_SIDE, 0.72)]).then(function (r) {
        URL.revokeObjectURL(o.url);
        var p = { id: newId(), createdAt: when, caption: "", exportedAt: null, w: r[0].w, h: r[0].h, bytes: r[0].blob.size + r[1].blob.size, shapes: null, edited: false };
        return savePhoto(p, { orig: r[0].blob, thumb: r[1].blob }).then(function () { return p; });
      });
    });
  }
  function addFiles(files, fromCamera) {
    files = Array.prototype.slice.call(files || []);
    if (!files.length) return;
    var done = 0, failed = 0, last = null;
    var chain = Promise.resolve();
    files.forEach(function (f, i) {
      chain = chain.then(function () {
        if (files.length > 1) toast("Saving " + (i + 1) + " of " + files.length + "…", 60000);
        var when = !fromCamera && f.lastModified && f.lastModified < Date.now() + 60000 ? f.lastModified : Date.now();
        return ingest(f, when).then(function (p) { photos.push(p); done++; last = p; }, function () { failed++; });
      });
    });
    chain.then(function () {
      sortPhotos(); render();
      if (failed) toast("Saved " + done + ", could not read " + failed + ".");
      else if (fromCamera && last) toast("Saved. Tap the photo to add a caption.");
      else toast("Saved " + done + " photo" + (done > 1 ? "s" : "") + ".");
    });
  }

  /* ---------- wall ---------- */
  function sortPhotos() { photos.sort(function (a, b) { return b.createdAt - a.createdAt; }); }
  function thumbUrl(p) {
    if (thumbUrls[p.id]) return Promise.resolve(thumbUrls[p.id]);
    return getBlob(p.id + "/thumb").then(function (b) {
      if (!b) return null;
      thumbUrls[p.id] = URL.createObjectURL(b);
      return thumbUrls[p.id];
    });
  }
  function dropThumb(id) { if (thumbUrls[id]) { URL.revokeObjectURL(thumbUrls[id]); delete thumbUrls[id]; } }
  function render() {
    var wall = $("wall");
    wall.textContent = "";
    $("empty").hidden = photos.length > 0;
    var groups = [], cur = null;
    photos.forEach(function (p) {
      var key = new Date(p.createdAt).toDateString();
      if (!cur || cur.key !== key) { cur = { key: key, label: dayLabel(p.createdAt), items: [] }; groups.push(cur); }
      cur.items.push(p);
    });
    groups.forEach(function (g) {
      var sec = document.createElement("section"); sec.className = "day";
      var h = document.createElement("h2"); h.textContent = g.label + " · " + g.items.length; sec.appendChild(h);
      var grid = document.createElement("div"); grid.className = "grid";
      g.items.forEach(function (p) {
        var b = document.createElement("button");
        b.type = "button"; b.className = "tile";
        b.setAttribute("aria-label", (p.caption || "Photo") + ", " + fmtTime(p.createdAt) + (p.exportedAt ? ", exported" : ""));
        if (selecting) b.setAttribute("aria-pressed", selected.has(p.id) ? "true" : "false");
        var img = document.createElement("img"); img.alt = ""; img.decoding = "async";
        thumbUrl(p).then(function (u) { if (u) img.src = u; });
        b.appendChild(img);
        if (p.exportedAt) { var dn = document.createElement("span"); dn.className = "done"; dn.textContent = "Exported"; b.appendChild(dn); }
        if (p.caption) { var c = document.createElement("span"); c.className = "cap"; c.textContent = p.caption; b.appendChild(c); }
        if (selecting) { var ck = document.createElement("span"); ck.className = "check"; b.appendChild(ck); }
        b.addEventListener("click", function () {
          if (selecting) { selected.has(p.id) ? selected.delete(p.id) : selected.add(p.id); render(); }
          else openDetail(p.id);
        });
        grid.appendChild(b);
      });
      sec.appendChild(grid); wall.appendChild(sec);
    });
    renderSummary();
  }
  function renderSummary() {
    var bytes = 0, unexp = 0, exp = 0;
    photos.forEach(function (p) { bytes += p.bytes || 0; if (p.exportedAt) exp++; else unexp++; });
    $("summary").textContent = photos.length
      ? photos.length + " photo" + (photos.length > 1 ? "s" : "") + " · " + unexp + " not exported · " + fmtBytes(bytes)
      : "";
    $("select-btn").hidden = !photos.length;
    $("export-new-btn").hidden = !unexp;
    $("export-new-btn").textContent = "Export unexported (" + unexp + ")";
    $("clean-btn").hidden = !exp;
    $("clean-btn").textContent = "Delete exported (" + exp + ")";
    $("bar-main").hidden = selecting;
    $("bar-select").hidden = !selecting;
    $("sel-count").textContent = selected.size + " selected";
    $("sel-export").disabled = $("sel-del").disabled = !selected.size;
  }
  function setSelecting(on) { selecting = on; if (!on) selected.clear(); render(); }

  /* ---------- export ---------- */
  var pending = null;   // {ids, files}
  function prepareExport(ids) {
    ids = ids.filter(byId);
    if (!ids.length) return;
    toast("Preparing " + ids.length + " photo" + (ids.length > 1 ? "s" : "") + "…", 60000);
    var used = {};
    var list = photos.filter(function (p) { return ids.indexOf(p.id) !== -1; }).slice().sort(function (a, b) { return a.createdAt - b.createdAt; });
    Promise.all(list.map(function (p) {
      return fullBlob(p).then(function (b) { return new File([b], fileName(p, used), { type: "image/jpeg", lastModified: p.createdAt }); });
    })).then(function (files) {
      $("toast").hidden = true;
      pending = { ids: list.map(function (p) { return p.id; }), files: files };
      var size = files.reduce(function (s, f) { return s + f.size; }, 0);
      $("share-msg").textContent = files.length + " photo" + (files.length > 1 ? "s" : "") + " ready (" + fmtBytes(size) + ").";
      $("share-sheet").hidden = false;
      $("share-go").focus();
    }).catch(function () { toast("Could not read the photos."); });
  }
  function markExported(ids) {
    var now = Date.now();
    return Promise.all(ids.map(function (id) { var p = byId(id); if (!p) return null; p.exportedAt = now; return putMeta(p); }));
  }
  function closeShare() { $("share-sheet").hidden = true; pending = null; }
  $("share-cancel").addEventListener("click", closeShare);
  $("share-go").addEventListener("click", function () {
    if (!pending) return;
    var job = pending;
    if (navigator.canShare && navigator.canShare({ files: job.files })) {
      // Called directly in the tap handler so iOS accepts it as a user action.
      navigator.share({ files: job.files }).then(function () {
        closeShare();
        return markExported(job.ids).then(function () {
          if (selecting) setSelecting(false); else render();
          refreshDetail();
          toast("Exported " + job.ids.length + ". Delete them here when you're sure they arrived.", 4000);
        });
      }).catch(function (e) {
        if (e && e.name === "AbortError") return;   // user closed the share sheet
        toast("Sharing failed: " + ((e && e.message) || e));
      });
      return;
    }
    // Desktop fallback: plain downloads.
    job.files.forEach(function (f, i) {
      setTimeout(function () {
        var a = document.createElement("a");
        a.href = URL.createObjectURL(f); a.download = f.name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
      }, i * 300);
    });
    closeShare();
    markExported(job.ids).then(function () { if (selecting) setSelecting(false); else render(); refreshDetail(); });
    toast("Downloading " + job.files.length + " file" + (job.files.length > 1 ? "s" : "") + ".");
  });

  /* ---------- detail ---------- */
  var detailId = null, detailUrl = null, capTimer = null;
  function openDetail(id) {
    detailId = id;
    $("detail").hidden = false;
    refreshDetail(true);
  }
  function refreshDetail(reloadImage) {
    var p = detailId && byId(detailId);
    if (!p || $("detail").hidden) return;
    $("d-title").textContent = dayLabel(p.createdAt) + " " + fmtTime(p.createdAt);
    $("d-state").textContent = p.exportedAt ? "Exported " + fmtTime(p.exportedAt) : "Not exported";
    if (document.activeElement !== $("d-caption")) $("d-caption").value = p.caption;
    $("d-unmark").hidden = !p.edited;
    $("d-markup").textContent = p.edited ? "Edit markup" : "Mark up";
    if (reloadImage) {
      fullBlob(p).then(function (b) {
        if (!b || detailId !== p.id) return;
        if (detailUrl) URL.revokeObjectURL(detailUrl);
        detailUrl = URL.createObjectURL(b);
        $("d-img").src = detailUrl;
      });
    }
  }
  function flushCaption() {
    if (!capTimer) return;
    clearTimeout(capTimer); capTimer = null;
    var p = byId(detailId); if (p) putMeta(p);
  }
  function closeDetail() {
    flushCaption();
    $("detail").hidden = true; detailId = null;
    $("d-img").removeAttribute("src");
    if (detailUrl) { URL.revokeObjectURL(detailUrl); detailUrl = null; }
    render();
  }
  $("d-close").addEventListener("click", closeDetail);
  $("d-caption").addEventListener("input", function (e) {
    var p = byId(detailId); if (!p) return;
    p.caption = e.target.value.slice(0, 120);
    clearTimeout(capTimer);
    capTimer = setTimeout(function () { capTimer = null; putMeta(p); }, 400);
  });
  $("d-caption").addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.isComposing) e.target.blur(); });
  $("d-export").addEventListener("click", function () { flushCaption(); if (detailId) prepareExport([detailId]); });
  $("d-delete").addEventListener("click", function () {
    var p = byId(detailId); if (!p) return;
    if (!confirm(p.exportedAt ? "Delete this photo?" : "This photo has not been exported. Delete it anyway?")) return;
    var id = p.id;
    closeDetail();
    deletePhotos([id]).then(render);
  });
  $("d-markup").addEventListener("click", function () { flushCaption(); if (detailId) openEditor(detailId); });
  $("d-unmark").addEventListener("click", function () {
    var p = byId(detailId); if (!p || !confirm("Remove all markup from this photo?")) return;
    getBlob(p.id + "/orig").then(loadImage).then(function (o) {
      return scaled(o.img, o.img.naturalWidth, o.img.naturalHeight, THUMB_SIDE, 0.72).then(function (t) {
        URL.revokeObjectURL(o.url);
        p.edited = false; p.shapes = null; p.exportedAt = null;
        return getBlob(p.id + "/orig").then(function (ob) {
          p.bytes = ob.size + t.blob.size;
          return savePhoto(p, { edit: null, thumb: t.blob });
        });
      });
    }).then(function () { dropThumb(p.id); refreshDetail(true); render(); toast("Markup removed"); })
      .catch(function () { toast("Could not remove markup"); });
  });

  /* ---------- markup editor ---------- */
  var ed = { id: null, img: null, url: null, shapes: [], tool: "circle", color: "#E5262E", drawing: null, scale: 1 };
  var canvas = $("e-canvas"), ctx = canvas.getContext("2d");
  function lineW() { return Math.max(4, Math.round(Math.max(ed.img.naturalWidth, ed.img.naturalHeight) / 220)); }
  function openEditor(id) {
    var p = byId(id); if (!p) return;
    getBlob(p.id + "/orig").then(loadImage).then(function (o) {
      ed.id = id; ed.img = o.img; ed.url = o.url;
      ed.shapes = p.shapes ? JSON.parse(JSON.stringify(p.shapes)) : [];
      ed.drawing = null;
      $("editor").hidden = false;
      layoutEditor();
    }).catch(function () { toast("Could not open the photo"); });
  }
  function layoutEditor() {
    if ($("editor").hidden || !ed.img) return;
    var stage = $("e-stage"), sw = stage.clientWidth, sh = stage.clientHeight;
    var w = ed.img.naturalWidth, h = ed.img.naturalHeight, k = Math.min(sw / w, sh / h);
    var dpr = window.devicePixelRatio || 1;
    canvas.style.width = Math.floor(w * k) + "px"; canvas.style.height = Math.floor(h * k) + "px";
    canvas.width = Math.floor(w * k * dpr); canvas.height = Math.floor(h * k * dpr);
    ed.scale = k * dpr;
    drawEditor();
  }
  function drawShape(c, s, scale, lw) {
    c.save();
    c.strokeStyle = c.fillStyle = s.color;
    c.lineWidth = lw * scale; c.lineCap = "round"; c.lineJoin = "round";
    if (s.type === "pen") {
      c.beginPath();
      s.pts.forEach(function (pt, i) { if (i) c.lineTo(pt[0] * scale, pt[1] * scale); else c.moveTo(pt[0] * scale, pt[1] * scale); });
      if (s.pts.length === 1) c.lineTo(s.pts[0][0] * scale + 0.1, s.pts[0][1] * scale);
      c.stroke();
    } else if (s.type === "arrow") {
      var x1 = s.a[0] * scale, y1 = s.a[1] * scale, x2 = s.b[0] * scale, y2 = s.b[1] * scale;
      var ang = Math.atan2(y2 - y1, x2 - x1), head = lw * scale * 5;
      c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
      c.beginPath();
      c.moveTo(x2, y2);
      c.lineTo(x2 - head * Math.cos(ang - 0.45), y2 - head * Math.sin(ang - 0.45));
      c.lineTo(x2 - head * Math.cos(ang + 0.45), y2 - head * Math.sin(ang + 0.45));
      c.closePath(); c.fill();
    } else if (s.type === "circle") {
      var cx = (s.a[0] + s.b[0]) / 2 * scale, cy = (s.a[1] + s.b[1]) / 2 * scale;
      var rx = Math.abs(s.b[0] - s.a[0]) / 2 * scale, ry = Math.abs(s.b[1] - s.a[1]) / 2 * scale;
      c.beginPath(); c.ellipse(cx, cy, Math.max(rx, 1), Math.max(ry, 1), 0, 0, Math.PI * 2); c.stroke();
    } else if (s.type === "text") {
      var size = lw * 7 * scale;
      c.font = "700 " + size + "px -apple-system, 'Segoe UI', 'PingFang TC', sans-serif";
      c.textBaseline = "middle";
      c.lineWidth = size / 6;
      c.strokeStyle = s.color === "#FFFFFF" || s.color === "#FFD21F" ? "rgba(0,0,0,.8)" : "rgba(255,255,255,.9)";
      c.strokeText(s.text, s.a[0] * scale, s.a[1] * scale);
      c.fillText(s.text, s.a[0] * scale, s.a[1] * scale);
    }
    c.restore();
  }
  function drawEditor() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(ed.img, 0, 0, canvas.width, canvas.height);
    var lw = lineW();
    ed.shapes.forEach(function (s) { drawShape(ctx, s, ed.scale, lw); });
    if (ed.drawing) drawShape(ctx, ed.drawing, ed.scale, lw);
    $("e-undo").disabled = !ed.shapes.length;
  }
  function imgPoint(e) {
    var r = canvas.getBoundingClientRect(), k = ed.img.naturalWidth / r.width;
    return [Math.round((e.clientX - r.left) * k), Math.round((e.clientY - r.top) * k)];
  }
  canvas.addEventListener("pointerdown", function (e) {
    if (!ed.img) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    var pt = imgPoint(e);
    if (ed.tool === "text") {
      var text = $("e-text").value.trim();
      if (!text) { toast("Type the text first, then tap the photo."); $("e-text").focus(); return; }
      ed.shapes.push({ type: "text", color: ed.color, a: pt, text: text.slice(0, 60) });
      drawEditor(); return;
    }
    ed.drawing = ed.tool === "pen" ? { type: "pen", color: ed.color, pts: [pt] } : { type: ed.tool, color: ed.color, a: pt, b: pt };
    drawEditor();
  });
  canvas.addEventListener("pointermove", function (e) {
    if (!ed.drawing) return;
    var pt = imgPoint(e);
    if (ed.drawing.type === "pen") ed.drawing.pts.push(pt); else ed.drawing.b = pt;
    drawEditor();
  });
  function endStroke() {
    var d = ed.drawing; if (!d) return;
    ed.drawing = null;
    var tiny = lineW() * 2;
    if (d.type === "pen" || Math.abs(d.b[0] - d.a[0]) > tiny || Math.abs(d.b[1] - d.a[1]) > tiny) ed.shapes.push(d);
    drawEditor();
  }
  canvas.addEventListener("pointerup", endStroke);
  canvas.addEventListener("pointercancel", endStroke);
  document.querySelectorAll("[data-tool]").forEach(function (b) {
    b.addEventListener("click", function () {
      ed.tool = b.getAttribute("data-tool");
      document.querySelectorAll("[data-tool]").forEach(function (x) { x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
      $("e-text").hidden = ed.tool !== "text";
      if (ed.tool === "text") $("e-text").focus();
      layoutEditor();
    });
  });
  document.querySelectorAll("[data-color]").forEach(function (b) {
    b.addEventListener("click", function () {
      ed.color = b.getAttribute("data-color");
      document.querySelectorAll("[data-color]").forEach(function (x) { x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
    });
  });
  $("e-undo").addEventListener("click", function () { ed.shapes.pop(); drawEditor(); });
  function closeEditor() {
    $("editor").hidden = true;
    if (ed.url) URL.revokeObjectURL(ed.url);
    ed.img = null; ed.url = null; ed.id = null; ed.drawing = null;
  }
  $("e-cancel").addEventListener("click", closeEditor);
  $("e-save").addEventListener("click", function () {
    var p = byId(ed.id); if (!p || !ed.img) return;
    if (!ed.shapes.length && !p.edited) { closeEditor(); return; }
    var w = ed.img.naturalWidth, h = ed.img.naturalHeight, c = document.createElement("canvas");
    c.width = w; c.height = h;
    var cc = c.getContext("2d"), lw = lineW();
    cc.drawImage(ed.img, 0, 0);
    ed.shapes.forEach(function (s) { drawShape(cc, s, 1, lw); });
    $("e-save").disabled = true;
    Promise.all([canvasBlob(c, 0.88), scaled(c, w, h, THUMB_SIDE, 0.72), getBlob(p.id + "/orig")]).then(function (r) {
      var edited = ed.shapes.length > 0;
      p.shapes = edited ? ed.shapes : null;
      p.edited = edited;
      p.exportedAt = null;   // the exported copy no longer matches
      p.bytes = r[2].size + r[1].blob.size + (edited ? r[0].size : 0);
      return savePhoto(p, { edit: edited ? r[0] : null, thumb: r[1].blob });
    }).then(function () {
      dropThumb(p.id); closeEditor(); refreshDetail(true); render(); toast("Markup saved");
    }).catch(function () { toast("Could not save the markup"); })
      .then(function () { $("e-save").disabled = false; });
  });
  window.addEventListener("resize", layoutEditor);

  /* ---------- buttons ---------- */
  $("shoot-btn").addEventListener("click", function () { $("shoot-input").click(); });
  $("import-btn").addEventListener("click", function () { $("import-input").click(); });
  $("shoot-input").addEventListener("change", function (e) { addFiles(e.target.files, true); e.target.value = ""; });
  $("import-input").addEventListener("change", function (e) { addFiles(e.target.files, false); e.target.value = ""; });
  $("select-btn").addEventListener("click", function () { setSelecting(true); });
  $("sel-done").addEventListener("click", function () { setSelecting(false); });
  $("sel-export").addEventListener("click", function () { prepareExport(Array.from(selected)); });
  $("sel-del").addEventListener("click", function () {
    var ids = Array.from(selected), unexp = ids.filter(function (id) { var p = byId(id); return p && !p.exportedAt; }).length;
    var msg = "Delete " + ids.length + " photo" + (ids.length > 1 ? "s" : "") + "?" + (unexp ? " " + unexp + " of them have not been exported." : "");
    if (!confirm(msg)) return;
    deletePhotos(ids).then(function () { setSelecting(false); toast("Deleted " + ids.length + "."); });
  });
  $("export-new-btn").addEventListener("click", function () {
    prepareExport(photos.filter(function (p) { return !p.exportedAt; }).map(function (p) { return p.id; }));
  });
  $("clean-btn").addEventListener("click", function () {
    var ids = photos.filter(function (p) { return p.exportedAt; }).map(function (p) { return p.id; });
    if (!ids.length) return;
    if (!confirm("Delete " + ids.length + " exported photo" + (ids.length > 1 ? "s" : "") + " from this app? Check they arrived in your work folder first.")) return;
    deletePhotos(ids).then(function () { render(); toast("Deleted " + ids.length + ". Space freed."); });
  });
  $("help-btn").addEventListener("click", function () { $("help").hidden = false; });
  $("help-close").addEventListener("click", function () { $("help").hidden = true; });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (!$("share-sheet").hidden) closeShare();
    else if (!$("help").hidden) $("help").hidden = true;
    else if (!$("editor").hidden) closeEditor();
    else if (!$("detail").hidden) closeDetail();
    else if (selecting) setSelecting(false);
  });
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") flushCaption(); });

  /* ---------- start ---------- */
  loadAll().then(function (list) {
    photos = (list || []).filter(function (p) { return p && typeof p.id === "string"; });
    sortPhotos(); render();
  }).catch(function () {
    render();
    toast("Storage is not available. Photos cannot be saved in this browser mode.", 6000);
  });
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(function () {});
})();
