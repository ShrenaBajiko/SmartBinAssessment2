"use strict";

/* =====================================================================================================
   SCU Smart Waste Terminal: student guide to this file

   WHAT HAPPENS, IN ORDER
     camera frame -> analyseFrame() (COCO / Teachable Machine model) -> result {label, confidence, bin}
       -> considerPublish() (is it stable, confident and not a repeat?) -> buildPayload() (make the JSON)
       -> publishPayload() -> publishText() -> MQTT broker -> dashboard.html (see dashboard.js)

   WHERE TO CUSTOMISE (search the file for the name in capitals or the function name)
     * MQTT message content ............ buildPayload()      (add / rename / remove JSON fields)
     * When a message is sent .......... considerPublish()    (threshold, stable frames, cooldown)
     * Topic, broker, credentials ...... the "MQTT test" panel in index.html, and connectMqtt() below
     * What arrives from other devices . showReceived() and the "message" handler in connectMqtt()
     * Which bin an item goes in ....... bins.js (or the "Bin mapping" panel in the page)
     * Sending a NEW kind of message ... see "ADDING YOUR OWN MESSAGE TYPE" above publishTest()

   The dashboard reads these messages, so if you rename a field here, change dashboard.js to match
   (handleClassification() there).
   ===================================================================================================== */

const $ = (id) => document.getElementById(id);
const fields = ["pipeline","detScore","fallback","modelSource","modelUrl","normalization","backend","region","deviceId","mqttTopic","subscribeTopic","brokerUrl","threshold","stableFrames","cooldown","mqttUsername","locationPrecision"];
const STORAGE_KEY = "prog6002-classifier", LOG_VISIBLE_KEY = "prog6002-log-visible", SETTINGS_VERSION = 2;
const PASSWORD_KEY = "prog6002-mqtt-password";   // only written when "Remember password" is ticked
let model = null, stream = null, running = false, mqttClient = null, subscribedTopic = "";
let candidate = "", candidateFrames = 0, lastPublishedClass = "", lastPublishedAt = 0;
let sequence = 0, published = 0, received = 0, errorCount = 0, animationId = null, inferenceErrors = 0;
const busy = { starting: false, camera: false, loading: false, selfTest: false };

// ---------- Event / error log ----------
function log(message, level="info") {
  const item = document.createElement("li");
  item.className = level;
  item.textContent = `${new Date().toLocaleTimeString()} · ${message}`;
  $("eventLog").prepend(item);
  while ($("eventLog").children.length > 100) $("eventLog").lastChild.remove();
  if (level === "error") { errorCount += 1; updateErrorBadge(); }
}

function updateErrorBadge() {
  $("errorBadge").textContent = errorCount;
  $("errorBadge").hidden = errorCount === 0;
}

function setLogVisible(visible) {
  $("logPanel").hidden = !visible;
  $("logToggle").setAttribute("aria-expanded", String(visible));
  $("logToggle").firstChild.textContent = visible ? "Hide log " : "Show log ";
  try { localStorage.setItem(LOG_VISIBLE_KEY, visible ? "1" : "0"); } catch {}
}

function clearLog() {
  $("eventLog").replaceChildren();
  errorCount = 0; updateErrorBadge();
}

function setText(id, value) { $(id).textContent = value; }

// ---------- Button states ----------
// A disabled button shows why (data-reason is displayed on the button by CSS), which also works on touchscreens.
function setEnabled(id, enabled, reason) {
  const el = $(id);
  el.disabled = !enabled;
  if (enabled) { delete el.dataset.reason; el.removeAttribute("title"); }
  else { el.dataset.reason = reason; el.title = reason; }
}

function updateControls() {
  const mqttOn = Boolean(mqttClient?.connected), cameraOn = Boolean(stream);
  setEnabled("startButton", !running && !busy.starting, busy.starting ? "starting…" : "running");
  setEnabled("stopButton", running || cameraOn, "nothing running");
  setEnabled("cameraTestButton", !cameraOn && !busy.camera && !busy.starting, busy.camera ? "starting…" : "camera is on");
  setEnabled("loadModelButton", !running && !busy.loading && !busy.starting, running ? "stop first" : "loading…");
  setEnabled("selfTestButton", !running && !busy.selfTest && !busy.starting, running ? "stop first" : "testing…");
  setEnabled("testButton", mqttOn, "connect MQTT first");
  setEnabled("subscribeButton", mqttOn, "connect MQTT first");
  document.body.classList.toggle("is-running", running);
}

// ---------- Tablet mode ----------
// Shows only the title, video and result; everything else is hidden. Remembered on this device.
const TABLET_MODE_KEY = "prog6002-tablet-mode";

function setTabletMode(on, {fullscreen = true} = {}) {
  document.body.classList.toggle("tablet-mode", on);
  $("tabletToggle").textContent = on ? "Exit tablet mode" : "Tablet mode";
  $("tabletToggle").setAttribute("aria-pressed", String(on));
  try { localStorage.setItem(TABLET_MODE_KEY, on ? "1" : "0"); } catch {}
  // Full screen needs a tap, so it is only requested when the user presses the button.
  if (fullscreen) {
    if (on && !document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
    if (!on && document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  }
  requestAnimationFrame(() => { updateRegionGuide(); drawDetections(); });
}
function setOverall(text, kind="warn") { const el=$("overallStatus"); el.textContent=text; el.className=`pill ${kind}`; }
function value(id) { return $(id).value.trim(); }

// ---------- Settings ----------
function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    // Settings saved before version 2 predate the COCO → bin pipeline; keep everything except the old pipeline choice.
    if (saved.settingsVersion !== SETTINGS_VERSION) { delete saved.pipeline; delete saved.fallback; }
    fields.forEach(id => { if (saved[id] !== undefined) $(id).value = saved[id]; });
    if (saved.includeLocation) { $("includeLocation").checked = true; startLocation(); }
  } catch (error) { log(`Saved configuration ignored: ${error.message}`, "error"); }
  try {
    const password = localStorage.getItem(PASSWORD_KEY);
    if (password !== null) { $("mqttPassword").value = password; $("rememberPassword").checked = true; }
  } catch {}
  let logVisible = true;
  try { logVisible = localStorage.getItem(LOG_VISIBLE_KEY) !== "0"; } catch {}
  setLogVisible(logVisible);
}

function saveSettings() {
  try {
    const data = { settingsVersion: SETTINGS_VERSION, includeLocation: $("includeLocation").checked,
                   ...Object.fromEntries(fields.map(id => [id, $(id).value])) };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    const remember = $("rememberPassword").checked;
    if (remember) localStorage.setItem(PASSWORD_KEY, $("mqttPassword").value);
    else localStorage.removeItem(PASSWORD_KEY);
    log(`Configuration saved on this tablet (${remember ? "including the MQTT password, stored unencrypted" : "password is not stored"}).`);
  } catch (error) { log(`Could not save configuration: ${error.message}`, "error"); }
}

// Opt-in only. Unticking forgets a stored password straight away, without needing to press Save.
function rememberPasswordChanged() {
  if ($("rememberPassword").checked) {
    log("The MQTT password will be stored on this device when you tap “Save on this tablet”.", "warn");
    return;
  }
  try { localStorage.removeItem(PASSWORD_KEY); } catch {}
  log("Stored MQTT password removed from this device.");
}

// ---------- Location (opt-in) ----------
// The browser's geolocation (GPS, or Wi-Fi/cell positioning on devices without GPS) is watched while the box
// is ticked. Messages carry the latest fix, rounded to the chosen precision, or "location": null.
let locationWatch = null, lastFix = null, lastLocationProblem = "";

function locationChanged() {
  if ($("includeLocation").checked) startLocation(); else { stopLocation(); log("Location switched off; messages will have \"location\": null."); }
}

function startLocation() {
  if (!("geolocation" in navigator)) { setText("locationStatus", "Not available on this device"); log("Location is not available on this device.", "warn"); return; }
  if (!window.isSecureContext) { setText("locationStatus", "Needs HTTPS"); log("Location needs the page to be served over HTTPS.", "warn"); return; }
  if (locationWatch !== null) return;
  setText("locationStatus", "Waiting for location…");
  lastLocationProblem = "";
  locationWatch = navigator.geolocation.watchPosition(position => {
    if (!lastFix) log(`Location available (accuracy ±${Math.round(position.coords.accuracy)} m).`);
    lastFix = position; lastLocationProblem = "";
    const loc = locationPayload();
    setText("locationStatus", `${loc.latitude}, ${loc.longitude} (±${loc.accuracy_m} m)`);
  }, error => {
    const problem = { 1: "permission denied", 2: "position unavailable", 3: "timed out" }[error.code] ?? error.message;
    setText("locationStatus", lastFix ? `Last fix kept (${problem})` : `Unavailable (${problem})`);
    if (problem !== lastLocationProblem) log(`Location ${problem}.${lastFix ? " Using the last fix." : " Messages will have \"location\": null."}`, "warn");
    lastLocationProblem = problem;
    if (error.code === 1) { stopLocation(); $("includeLocation").checked = false; setText("locationStatus", "Permission denied"); }
  }, { enableHighAccuracy: true, maximumAge: 30000, timeout: 30000 });
}

function stopLocation() {
  if (locationWatch !== null) navigator.geolocation.clearWatch(locationWatch);
  locationWatch = null; lastFix = null;
  setText("locationStatus", "Off");
}

// Latest fix for the MQTT message, rounded to the chosen number of decimal places; null if off or no fix yet.
function locationPayload() {
  if (!$("includeLocation").checked || !lastFix) return null;
  const decimals = Number($("locationPrecision").value), c = lastFix.coords;
  const round = v => Number(v.toFixed(decimals));
  const roundingError = 111320 * 10 ** -decimals / 2;          // metres lost by rounding latitude
  return {
    latitude: round(c.latitude), longitude: round(c.longitude),
    accuracy_m: Math.round(Math.max(c.accuracy, roundingError)),
    altitude_m: c.altitude == null ? null : Math.round(c.altitude),
    timestamp: new Date(lastFix.timestamp).toISOString(),
    age_s: Math.round((Date.now() - lastFix.timestamp) / 1000)
  };
}

// ---------- Model URL ----------
function normalizedModelUrl() {
  const raw = value("modelUrl");
  if (!raw) throw new Error("Enter your Teachable Machine model URL under Image classifier.");
  // https is required on a real host; http://localhost is allowed for local testing.
  if (!/^https:\/\//i.test(raw) && !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/i.test(raw)) throw new Error("Model URL must start with https://");
  return raw.endsWith("/") ? raw : raw + "/";
}

// ---------- Model loading ----------
// Every model is wrapped so the rest of the app can call
// predict(videoElement) -> [{className, probability}] and getTotalClasses().

async function loadTeachableMachineUrl() {
  const base = normalizedModelUrl();
  const tm = await tmImage.load(base + "model.json", base + "metadata.json");
  const labels = tm.getClassLabels();
  // The chosen region is copied to a canvas first, so the target box and preview work as for other models.
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 224;
  async function predict(src, {region = "square", preview = null} = {}) {
    const [w, h] = sourceSize(src), r = regionRect(w, h, region);
    canvas.getContext("2d").drawImage(src, r.x, r.y, r.w, r.h, 0, 0, canvas.width, canvas.height);
    if (preview) preview.getContext("2d").drawImage(canvas, 0, 0, preview.width, preview.height);
    return { predictions: await tm.predict(canvas, false), stats: null };
  }
  return { predict, labels, getTotalClasses: () => labels.length, dispose: () => tm.dispose?.(), source: base,
           description: `Teachable Machine model with ${labels.length} classes (${labels.join(", ")})` };
}

function readFileText(file) { return file.text(); }

async function readLabels(files) {
  const txt = files.find(f => /\.txt$/i.test(f.name));
  if (txt) return (await readFileText(txt)).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const meta = files.find(f => /metadata.*\.json$/i.test(f.name));
  if (meta) {
    const data = JSON.parse(await readFileText(meta));
    if (Array.isArray(data.labels)) return data.labels;
  }
  return [];
}

async function loadModelFiles() {
  const files = [...$("modelFiles").files];
  if (!files.length) throw new Error("Select the model files first (model.json + .bin weights).");
  const jsonFiles = files.filter(f => /\.json$/i.test(f.name) && !/metadata/i.test(f.name));
  if (jsonFiles.length !== 1) throw new Error(`Select exactly one model JSON file (found ${jsonFiles.length}).`);
  const modelJsonFile = jsonFiles[0];
  const modelJson = JSON.parse(await readFileText(modelJsonFile));
  if (!modelJson.modelTopology || !modelJson.weightsManifest) throw new Error(`${modelJsonFile.name} is not a TensorFlow.js model file.`);

  // Check every weight shard named in the manifest was selected.
  const weightFiles = files.filter(f => /\.bin$/i.test(f.name));
  const needed = modelJson.weightsManifest.flatMap(group => group.paths).map(p => p.split("/").pop());
  const missing = needed.filter(name => !weightFiles.some(f => f.name === name));
  if (missing.length) throw new Error(`Missing weight file(s): ${missing.join(", ")}`);

  const handler = tf.io.browserFiles([modelJsonFile, ...weightFiles]);
  const isGraph = modelJson.format === "graph-model";
  const net = isGraph ? await tf.loadGraphModel(handler) : await tf.loadLayersModel(handler);
  return wrapTfjsModel(net, {
    labels: await readLabels(files), normalization: $("normalization").value,
    source: `local:${modelJsonFile.name}`, name: `${isGraph ? "Graph" : "Layers"} model from ${modelJsonFile.name}`
  });
}

// Waste models shipped with the app. Each folder has model.json, weights and metadata.json.
const BUNDLED_MODELS = {
  default: { dir: "models/ecovision-mobilenetv3/", title: "EcoVision MobileNetV3" },   // tools/convert_ecovision.py
  lite:    { dir: "models/waste-mobilenetv2/",     title: "Lite TrashNet MobileNetV2" } // tools/train_waste_model.py
};

async function loadBundledModel(key) {
  const {dir, title} = BUNDLED_MODELS[key];
  if (location.protocol === "file:") throw new Error("Bundled models need the page served over http(s), not opened as a file.");
  const metaResponse = await fetch(dir + "metadata.json");
  if (!metaResponse.ok) throw new Error(`Bundled model metadata not found (${metaResponse.status}).`);
  const meta = await metaResponse.json();
  const net = meta.format === "graph-model" ? await tf.loadGraphModel(dir + "model.json")
                                            : await tf.loadLayersModel(dir + "model.json");
  return wrapTfjsModel(net, {
    labels: meta.labels ?? [], normalization: meta.normalization ?? "-1to1",
    source: `bundled:${meta.modelName ?? key}`, name: `${title} (${meta.architecture ?? "bundled"})`
  });
}

// ---------- Bins ----------
// Mapping rules live in bins.js. Edits made in the app are stored on this device as overrides.
const BIN_MAP_KEY = "prog6002-bin-map";
let binOverrides = {};
try { binOverrides = JSON.parse(localStorage.getItem(BIN_MAP_KEY) || "{}"); } catch {}

// Default rule for a label, before any in-app edits:
// "red" | "yellow" | "green" | "ewaste" | "ignore" (means "no item") | null (no rule).
function defaultRule(label) {
  const key = String(label).trim().toLowerCase();
  if (key in DEFAULT_COCO_BINS) return DEFAULT_COCO_BINS[key];
  if (LABEL_BINS[key]) return LABEL_BINS[key];
  // Match whole words, e.g. "Yellow bin" -> yellow, "food scraps" -> green, "shredded paper" -> yellow.
  const word = key.split(/[^a-z-]+/).find(w => LABEL_BINS[w]);
  return word ? LABEL_BINS[word] : null;
}

function ruleFor(label) {
  const key = String(label).trim().toLowerCase();
  return key in binOverrides ? binOverrides[key] : defaultRule(key);
}

function cocoBin(label) { return ruleFor(label) ?? "ignore"; }

// Bin shown for a label; null when the label has no bin (no rule, or "ignore").
function binFor(label) { const rule = ruleFor(label); return rule === "ignore" ? null : rule; }

// ---------- Object detection ----------
// COCO-SSD finds everyday objects (80 COCO classes). In "coco" mode the object's own label decides the bin;
// in "hybrid" mode the object is cropped and a material classifier decides.
const DETECTOR_URL = "models/coco-ssd-lite/model.json";
let detector = null;
const cropCanvas = document.createElement("canvas");

function pipeline() { return $("pipeline").value; }
function usesDetection() { return pipeline() !== "classify"; }
function needsClassifier() { return pipeline() !== "coco" || $("fallback").value === "centre"; }

async function loadDetector() {
  if (typeof cocoSsd === "undefined") throw new Error("COCO-SSD library failed to load. Check the internet connection and reload.");
  await ensureBackend();
  setText("detectedStatus", "Loading detector…");
  detector = await cocoSsd.load({ base: "lite_mobilenet_v2", modelUrl: DETECTOR_URL });
  const warmup = tf.zeros([300, 300, 3], "int32");
  await detector.detect(warmup); warmup.dispose();
  setText("detectedStatus", "—");
  log("Object detector loaded: COCO-SSD lite MobileNetV2 (80 everyday object classes).");
}

function disposeDetector() { detector?.dispose(); detector = null; }

function sourceSize(src) {
  return src instanceof HTMLVideoElement ? [src.videoWidth, src.videoHeight]
       : src instanceof HTMLImageElement ? [src.naturalWidth, src.naturalHeight] : [src.width, src.height];
}

// Square crop around a detection box with 15% padding, kept inside the frame.
function squareAround([x, y, w, h], frameW, frameH) {
  const side = Math.min(Math.max(w, h) * 1.15, frameW, frameH);
  const cx = x + w / 2, cy = y + h / 2;
  return { x: Math.min(Math.max(cx - side / 2, 0), frameW - side), y: Math.min(Math.max(cy - side / 2, 0), frameH - side), w: side, h: side };
}

// Turns classifier predictions into a result: top label, its bin, and the runners-up.
// Returns null when the top class is mapped to "no item" (for example a Teachable Machine "unknown" class).
function classifierResult(predictions) {
  const sorted = [...predictions].sort((a, b) => b.probability - a.probability);
  if (ruleFor(sorted[0].className) === "ignore") return null;
  return { label: sorted[0].className, confidence: sorted[0].probability, bin: binFor(sorted[0].className),
           alternatives: sorted.slice(1, 5).map(p => ({ label: p.className, confidence: p.probability, bin: binFor(p.className) })) };
}

// One frame through the chosen pipeline. Returns {mode, result, detection, detections, stats}.
// result = {label, confidence, bin, alternatives} or null when there is nothing to report.
// mode: "coco" | "detect" (hybrid, object found) | "classify" | "fallback" (nothing found, centre classified)
//       | "none" (nothing found) | "waiting" (camera has no picture yet).
async function analyseFrame(src) {
  const region = $("region").value, preview = $("inputPreview");
  // The video can briefly have no picture (starting up, phone rotating); skip such frames.
  const [fw, fh] = sourceSize(src);
  if (!fw || !fh || (src instanceof HTMLVideoElement && src.readyState < 2)) return { mode: "waiting", result: null, detections: [] };
  const classify = async (source, reg, mode, detection = null, detections = []) => {
    const {predictions, stats} = await model.predict(source, {region: reg, preview});
    const result = classifierResult(predictions);
    return { mode: result ? mode : "none", result, detection, detections, stats };
  };
  if (!usesDetection()) return classify(src, region, "classify");

  const detections = (await detector.detect(src, 10, Number(value("detScore")) || 0.4))
    .map(d => ({ ...d, bin: cocoBin(d.class) })).filter(d => d.bin !== "ignore");
  if (!detections.length) {
    if ($("fallback").value === "centre") return classify(src, region, "fallback");
    return { mode: "none", result: null, detection: null, detections };
  }
  // The largest object is the one being shown to the camera.
  const detection = detections.reduce((a, b) => b.bbox[2] * b.bbox[3] > a.bbox[2] * a.bbox[3] ? b : a);
  const r = squareAround(detection.bbox, fw, fh);
  cropCanvas.width = cropCanvas.height = 256;
  cropCanvas.getContext("2d").drawImage(src, r.x, r.y, r.w, r.h, 0, 0, 256, 256);

  if (pipeline() === "coco") {
    preview.getContext("2d").drawImage(cropCanvas, 0, 0, preview.width, preview.height);
    const others = detections.filter(d => d !== detection).sort((a, b) => b.score - a.score);
    return { mode: "coco", detection, detections, stats: null,
             result: { label: detection.class, confidence: detection.score, bin: detection.bin,
                       alternatives: others.map(d => ({ label: d.class, confidence: d.score, bin: d.bin })) } };
  }
  return classify(cropCanvas, "full", "detect", detection, detections);
}

// Maps a rectangle in camera-frame pixels to the displayed video (object-fit: contain).
function videoToScreen(video) {
  const vw = video.videoWidth, vh = video.videoHeight, cw = video.clientWidth, ch = video.clientHeight;
  const scale = Math.min(cw / vw, ch / vh);
  return { scale, ox: (cw - vw * scale) / 2, oy: (ch - vh * scale) / 2 };
}

// Boxes are drawn in the colour of their bin; the chosen object gets a thicker box and its bin name.
function drawDetections(detections = [], primary = null, result = null) {
  const video = $("camera"), canvas = $("detectionOverlay");
  const dpr = window.devicePixelRatio || 1;
  canvas.width = video.clientWidth * dpr; canvas.height = video.clientHeight * dpr;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!video.videoWidth || !detections.length) return;
  const {scale, ox, oy} = videoToScreen(video);
  ctx.font = "600 13px system-ui, sans-serif"; ctx.textBaseline = "top";
  for (const d of detections) {
    const [x, y, w, h] = d.bbox.map(v => v * scale), isPrimary = d === primary;
    // In hybrid mode the classifier's material decides the bin of the chosen object.
    const bin = isPrimary && result ? result.bin : d.bin, info = BINS[bin];
    ctx.lineWidth = isPrimary ? 4 : 2;
    ctx.strokeStyle = info?.colour ?? "#ffffff";
    ctx.strokeRect(ox + x, oy + y, w, h);
    let text = `${d.class} ${(d.score * 100).toFixed(0)}%`;
    if (isPrimary && result && result.label !== d.class) text += ` → ${result.label}`;
    if (isPrimary) text += ` → ${info ? info.name : "no bin rule"}`;
    const tw = ctx.measureText(text).width + 10, ty = Math.max(oy + y - 20, 0);
    ctx.fillStyle = info?.colour ?? "#071723";
    ctx.fillRect(ox + x, ty, tw, 19);
    ctx.fillStyle = info?.text ?? "#ffffff"; ctx.fillText(text, ox + x + 5, ty + 3);
  }
}

function describeDetection({mode, detection, detections}) {
  if (mode === "classify") return "Not used";
  if (mode === "waiting") return "Waiting for camera…";
  if (mode === "coco" || mode === "detect")
    return `${detection.class} ${(detection.score * 100).toFixed(0)}%` + (detections.length > 1 ? ` (+${detections.length - 1} more)` : "");
  return mode === "fallback" ? "Nothing (classified centre)" : "Nothing detected";
}

// ---------- Bin mapping editor ----------
// Lists the COCO objects (when detection is used) and the loaded classifier's classes (when it is used).
function binMappingRow(label, allowNoRule) {
  const key = label.toLowerCase();
  const options = [...Object.entries(BINS).map(([k, b]) => [k, b.name]), ["ignore", allowNoRule ? "No item (e.g. unknown/background)" : "Ignore (not the item)"]];
  if (allowNoRule) options.push(["", "No bin rule"]);
  const tr = document.createElement("tr"), name = document.createElement("td"), cell = document.createElement("td");
  const select = document.createElement("select");
  for (const [k, text] of options) select.add(new Option(text, k));
  const show = () => { select.value = ruleFor(key) ?? ""; select.className = `bin-select bin-${select.value || "none"}`;
                       tr.classList.toggle("changed", key in binOverrides); };
  select.setAttribute("aria-label", `Bin for ${label}`);
  select.addEventListener("change", () => {
    const rule = select.value || null;
    if (rule === defaultRule(key)) delete binOverrides[key]; else binOverrides[key] = rule;
    try { localStorage.setItem(BIN_MAP_KEY, JSON.stringify(binOverrides)); } catch {}
    show();
    log(`Bin rule changed: ${label} → ${rule === "ignore" ? (allowNoRule ? "no item" : "ignored") : BINS[rule]?.name ?? "no bin rule"}.`);
  });
  name.textContent = label; cell.append(select); tr.append(name, cell); show();
  return tr;
}

function binMappingHeading(text) {
  const tr = document.createElement("tr"), th = document.createElement("th");
  th.colSpan = 2; th.textContent = text; th.className = "group"; tr.append(th);
  return tr;
}

function renderBinMapping() {
  const rows = [];
  if (needsClassifier()) {
    const labels = model?.labels ?? [];
    rows.push(binMappingHeading(`Image classifier classes${labels.length ? "" : " (load the model to list them)"}`));
    labels.forEach(label => rows.push(binMappingRow(label, true)));
  }
  if (usesDetection()) {
    rows.push(binMappingHeading("COCO objects"));
    Object.keys(DEFAULT_COCO_BINS).sort().forEach(label => rows.push(binMappingRow(label, false)));
  }
  $("binMappingRows").replaceChildren(...rows);
}

function resetBinMapping() {
  binOverrides = {};
  try { localStorage.removeItem(BIN_MAP_KEY); } catch {}
  renderBinMapping();
  log("Bin rules reset to the defaults in bins.js.");
}

// ---------- Compute backend ----------
async function ensureBackend() {
  const wanted = $("backend").value;
  if (wanted === "wasm" && tf.wasm?.setWasmPaths) tf.wasm.setWasmPaths("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@4.22.0/dist/");
  if (tf.getBackend() !== wanted) {
    const ok = await tf.setBackend(wanted).catch(() => false);
    if (!ok) { log(`Could not start the ${wanted} backend; using ${tf.getBackend()}.`, "error"); }
  }
  await tf.ready();
  const info = backendInfo();
  setText("backendStatus", info);
  return info;
}

function backendInfo() {
  const name = tf.getBackend();
  if (name !== "webgl") return name === "wasm" ? "WebAssembly (CPU)" : name;
  let gpu = "unknown GPU";
  try {
    const gl = tf.backend().gpgpu.gl, ext = gl.getExtension("WEBGL_debug_renderer_info");
    gpu = gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
  } catch {}
  const bits = tf.env().getBool("WEBGL_RENDER_FLOAT32_CAPABLE") ? "32-bit" : "16-bit";
  return `WebGL ${tf.env().getNumber("WEBGL_VERSION")} (${gpu}, ${bits} float)`;
}

async function backendChanged() {
  if (running) { log("Stop classification before changing the compute backend.", "error"); return; }
  modelSettingsChanged(); disposeDetector();
  try { log(`Compute backend: ${await ensureBackend()}.`); } catch (error) { log(error.message, "error"); }
}

// ---------- Diagnostics ----------
const SELFTEST_DIR = "models/selftest/";
let blankFrames = 0, lastBlankWarning = 0;

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load image ${url}`));
    img.src = url;
  });
}

function showInputStats(stats) {
  if (!stats) { setText("inputStats", "Preview not available for Teachable Machine URL models."); return; }
  setText("inputStats", `Brightness ${stats.brightness.toFixed(0)} / 255 · Contrast ${stats.contrast.toFixed(0)}`);
  blankFrames = stats.contrast < 8 ? blankFrames + 1 : 0;
  if (blankFrames >= 8 && Date.now() - lastBlankWarning > 10000) {
    lastBlankWarning = Date.now();
    log(`Camera frames look blank (brightness ${stats.brightness.toFixed(0)}, contrast ${stats.contrast.toFixed(1)}). ` +
        "Blank input makes the models answer cardboard/paper. Check the preview, lighting and lens.", "warn");
  }
}

// Runs the loaded models on reference images and compares with results from a known-good backend.
async function runSelfTest() {
  const key = $("modelSource").value;
  const testClassifier = needsClassifier() && Boolean(BUNDLED_MODELS[key]);
  if (needsClassifier() && !testClassifier) log("Classifier self-test skipped: it is available for the bundled models only.", "warn");
  if (!testClassifier && !usesDetection()) return;
  busy.selfTest = true; updateControls();
  try {
    await loadPipeline();
    const all = await (await fetch(SELFTEST_DIR + "expected.json")).json(), expected = testClassifier ? all[key] : {};
    let passed = 0, total = Object.keys(expected).length;
    if (detector) {
      for (const [file, ref] of Object.entries(all.detector)) {
        const found = await detector.detect(await loadImage(SELFTEST_DIR + file), 10, 0.2);
        const best = found.length ? found.reduce((a, b) => b.bbox[2] * b.bbox[3] > a.bbox[2] * a.bbox[3] ? b : a) : null;
        const ok = best?.class === ref.label && Math.abs(best.score - ref.score) < 0.1;
        passed += ok; total += 1;
        log(`Self-test detector ${file}: got ${best ? `${best.class} ${(best.score * 100).toFixed(1)}%` : "nothing"}, ` +
            `reference ${ref.label} ${(ref.score * 100).toFixed(1)}% → ${ok ? "PASS" : "FAIL"}`, ok ? "info" : "error");
      }
    }
    for (const [file, ref] of Object.entries(expected)) {
      const {predictions} = await model.predict(await loadImage(SELFTEST_DIR + file), {region: "full", preview: $("inputPreview")});
      const top = predictions.reduce((a, b) => b.probability > a.probability ? b : a);
      // Compare every class probability with the reference (robust even when two classes are close).
      const diff = Math.max(...predictions.map(p => Math.abs(p.probability - (ref.probabilities[p.className] ?? 0))));
      const ok = diff < 0.1;
      passed += ok;
      log(`Self-test ${file}: got ${top.className} ${(top.probability * 100).toFixed(1)}%, reference ${ref.label}; ` +
          `largest difference ${(diff * 100).toFixed(1)} points → ${ok ? "PASS" : "FAIL"}`, ok ? "info" : "error");
    }
    const info = backendInfo();
    if (passed === total) log(`Self-test passed ${passed}/${total} on ${info}. The model computes correctly on this device.`);
    else log(`Self-test FAILED ${total - passed}/${total} on ${info}. This backend gives wrong results on this device; ` +
             "choose WebAssembly under Compute backend and re-test.", "error");
  } catch (error) { log(`Self-test error: ${error.message}`, "error"); }
  finally { busy.selfTest = false; updateControls(); }
}

// Classifies a still photo (from the gallery or the phone's camera app) without the live video path.
async function classifyPhoto() {
  const file = $("photoInput").files[0];
  if (!file) return;
  try {
    await loadPipeline();
    const url = URL.createObjectURL(file);
    const img = await loadImage(url);
    URL.revokeObjectURL(url);
    // Downscale large phone photos before classification.
    const scale = Math.min(1, 800 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale); canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    const frame = await analyseFrame(canvas);
    setText("detectedStatus", describeDetection(frame));
    if (!frame.result) { showNoItem(); log(`Photo ${file.name}: no object detected.`, "warn"); return; }
    showResult(frame.result);
    if (frame.stats) showInputStats(frame.stats); else setText("inputStats", "Crop of the detected object.");
    const r = frame.result, found = frame.mode === "detect" ? `detected ${frame.detection.class} → ` : "";
    log(`Photo ${file.name}: ${found}${r.label} ${(r.confidence * 100).toFixed(1)}% → ${BINS[r.bin]?.name ?? "no bin rule"}`);
  } catch (error) { log(`Photo classification failed: ${error.message}`, "error"); }
  finally { $("photoInput").value = ""; }
}

// Draws the model's region on top of the video so users can frame the item.
function updateRegionGuide() {
  const video = $("camera"), guide = $("regionGuide");
  const vw = video.videoWidth, vh = video.videoHeight;
  // In detection mode the region is only used when nothing is detected and the fallback is "centre".
  const regionUsed = !usesDetection() || $("fallback").value === "centre";
  if (!vw || !vh || !regionUsed || $("region").value === "full") { guide.hidden = true; return; }
  const {scale, ox, oy} = videoToScreen(video);
  const r = regionRect(vw, vh, $("region").value);
  Object.assign(guide.style, { left: `${ox + r.x * scale}px`, top: `${oy + r.y * scale}px`,
                               width: `${r.w * scale}px`, height: `${r.h * scale}px` });
  guide.hidden = false;
}

// Region of the camera frame sent to the model: "full" frame, or a centred square with optional zoom.
function regionRect(width, height, region) {
  if (region === "full") return { x: 0, y: 0, w: width, h: height };
  const zoom = { zoom15: 1.5, zoom2: 2 }[region] ?? 1;
  const size = Math.round(Math.min(width, height) / zoom);
  return { x: Math.floor((width - size) / 2), y: Math.floor((height - size) / 2), w: size, h: size };
}

// Wraps any TF.js image classifier in the app's interface:
// predict(source, {region, preview}) -> {predictions: [{className, probability}], stats: {brightness, contrast}}
// source can be a <video>, <img> or <canvas>; preview is an optional canvas showing exactly what the model sees.
function wrapTfjsModel(net, {labels, normalization, source, name}) {
  const inputShape = net.inputs[0].shape;          // e.g. [null, 224, 224, 3]
  const height = inputShape[1] > 0 ? inputShape[1] : 224;
  const width = inputShape[2] > 0 ? inputShape[2] : 224;
  const channels = inputShape[3] > 0 ? inputShape[3] : 3;
  const outputSize = net.outputs[0].shape?.at(-1);

  if (outputSize > 0 && labels.length !== outputSize) {
    if (labels.length) log(`Label count (${labels.length}) does not match model outputs (${outputSize}); using generic names for extras.`, "warn");
    labels = Array.from({length: outputSize}, (_, i) => labels[i] ?? `Class ${i + 1}`);
  }

  // Crop the chosen region and resize to the model's input size. Result: [H, W, 3] float, 0-255.
  function cropResize(source, region) {
    return tf.tidy(() => {
      let img = tf.browser.fromPixels(source);       // [H, W, 3] int32
      const r = regionRect(img.shape[1], img.shape[0], region);
      if (r.w !== img.shape[1] || r.h !== img.shape[0]) img = img.slice([r.y, r.x, 0], [r.h, r.w, 3]);
      return tf.image.resizeBilinear(img, [height, width]).toFloat();
    });
  }

  function normalise(view) {
    return tf.tidy(() => {
      let img = channels === 1 ? view.mean(2, true) : view;
      if (normalization === "-1to1") img = img.div(127.5).sub(1);
      else if (normalization === "0to1") img = img.div(255);
      return img.expandDims(0);
    });
  }

  async function predict(src, {region = "square", preview = null} = {}) {
    const view = cropResize(src, region);
    try {
      const scores = tf.tidy(() => {
        let out = net.predict(normalise(view));
        if (Array.isArray(out)) out = out[0];
        out = out.squeeze();
        // Apply softmax if the model outputs logits rather than probabilities.
        const sum = out.sum().dataSync()[0], min = out.min().dataSync()[0];
        return (min < 0 || Math.abs(sum - 1) > 0.01) ? tf.softmax(out) : out;
      });
      const values = await scores.data();
      scores.dispose();
      // Brightness = mean pixel value; contrast = standard deviation. Near-zero contrast means a blank frame.
      const stats = tf.tidy(() => { const {mean, variance} = tf.moments(view);
        return { brightness: mean.dataSync()[0], contrast: Math.sqrt(variance.dataSync()[0]) }; });
      if (preview) {
        const pixels = tf.tidy(() => view.div(255).clipByValue(0, 1));
        await tf.browser.toPixels(pixels, preview);
        pixels.dispose();
      }
      return { stats, predictions: Array.from(values, (p, i) => ({ className: labels[i] ?? `Class ${i + 1}`, probability: p })) };
    } finally { view.dispose(); }
  }

  // Warm up once so the first real frame is not slow.
  tf.tidy(() => { net.predict(tf.zeros([1, height, width, channels])); });

  return { predict, labels, getTotalClasses: () => labels.length, dispose: () => net.dispose(), source,
           description: `${name}: input ${width}×${height}×${channels}, ${labels.length} classes ` +
                        `(${labels.join(", ")}), ${normalization} normalisation` };
}

async function loadModel() {
  if (running) throw new Error("Stop classification before loading a different model.");
  if (typeof tf === "undefined") throw new Error("TensorFlow.js failed to load. Check the internet connection and reload.");
  const source = $("modelSource").value;
  setText("modelStatus", "Loading…");
  try {
    await ensureBackend();
    const loaded = source === "files" ? await loadModelFiles()
                 : source === "url" ? await loadTeachableMachineUrl()
                 : await loadBundledModel(BUNDLED_MODELS[source] ? source : "default");
    if (model) model.dispose?.();
    model = loaded;
  } catch (error) {
    setText("modelStatus", model ? "Load failed (previous model kept)" : "Load failed");
    throw new Error(`Model load failed: ${error.message}`);
  }
  setText("modelStatus", `${model.getTotalClasses()} classes loaded`);
  log(`Model loaded: ${model.description}.`);
  renderBinMapping();
  const unmapped = (model.labels ?? []).filter(l => ruleFor(l) === null);
  if (unmapped.length) log(`No bin rule for: ${unmapped.join(", ")}. Set their bins under “Bin mapping”.`, "warn");
  $("className").textContent = "—"; $("predictions").replaceChildren();
}

// Loads whatever the chosen pipeline needs: the material classifier, plus the detector in hybrid mode.
// The classifier is only loaded when the pipeline uses it (not in the default COCO → bin mode).
async function loadPipeline() {
  if (needsClassifier() && !model) await loadModel();
  if (usesDetection() && !detector) {
    try { await loadDetector(); }
    catch (error) { setText("detectedStatus", "Detector failed"); throw new Error(`Detector load failed: ${error.message}`); }
  }
}

async function loadModelButton() {
  busy.loading = true; updateControls();
  try { await loadPipeline(); } catch (error) { log(error.message, "error"); }
  finally { busy.loading = false; updateControls(); }
}

function pipelineChanged() {
  $("detectionFields").hidden = !usesDetection();
  $("classifierFields").hidden = !needsClassifier();
  renderBinMapping();
  if (!usesDetection()) { drawDetections(); setText("detectedStatus", "Not used"); }
  else if (!detector) setText("detectedStatus", "—");
  updateRegionGuide();
}

function updateModelSourceUi() {
  const source = $("modelSource").value;
  $("defaultSourceFields").hidden = source !== "default";
  $("liteSourceFields").hidden = source !== "lite";
  $("urlSourceFields").hidden = source !== "url";
  $("fileSourceFields").hidden = source !== "files";
}

function showSelectedFiles() {
  const files = [...$("modelFiles").files];
  $("modelFileList").replaceChildren(...files.map(f => {
    const li = document.createElement("li");
    li.textContent = `${f.name} (${(f.size / 1024).toFixed(1)} KB)`;
    return li;
  }));
  if (files.length) log(`Selected ${files.length} model file(s). Tap “Load model” or start the classifier.`);
}

function modelSettingsChanged() {
  if (!model || running) return;
  model.dispose?.(); model = null;
  setText("modelStatus", "Not loaded");
  renderBinMapping();
  log("Model settings changed; the model will be reloaded on next start.");
}

// ---------- Camera ----------
function cameraErrorMessage(error) {
  switch (error.name) {
    case "NotAllowedError": return "Camera permission denied. Allow camera access in the browser site settings.";
    case "NotFoundError": return "No camera found on this device.";
    case "NotReadableError": return "Camera is in use by another app or tab.";
    case "OverconstrainedError": return "Camera does not support the requested settings.";
    default: return `Camera error: ${error.message}`;
  }
}

async function startCamera() {
  if (stream) return;
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera API unavailable. Open this page over HTTPS in a current browser.");
  setText("cameraStatus", "Starting…");
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio:false, video:{facingMode:{ideal:"environment"}, width:{ideal:640}, height:{ideal:480}}
    });
  } catch (error) {
    setText("cameraStatus", "Failed");
    throw new Error(cameraErrorMessage(error));
  }
  $("camera").srcObject = stream;
  await $("camera").play();
  $("cameraMessage").classList.add("hidden");
  updateRegionGuide();
  const settings = stream.getVideoTracks()[0]?.getSettings() || {};
  setText("cameraStatus", `Running${settings.width ? ` (${settings.width}×${settings.height})` : ""}`);
  log(`Camera started${settings.width ? ` at ${settings.width}×${settings.height}` : ""}.`);
  updateControls();
}

async function testCamera() {
  if (stream) { log("Camera is already running."); return; }
  busy.camera = true; updateControls();
  try {
    await startCamera();
    setOverall("Camera test", "ok");
  } catch (error) { log(error.message, "error"); setOverall("Camera failed", "bad"); }
  finally { busy.camera = false; updateControls(); }
}

function stopAll() {
  const wasActive = Boolean(stream) || running;
  running = false;
  if (animationId) cancelAnimationFrame(animationId);
  if (stream) stream.getTracks().forEach(track => track.stop());
  stream = null;
  $("camera").srcObject = null;
  $("regionGuide").hidden = true;
  drawDetections();
  showNoItem("—", "Stopped. Tap Start to begin.");   // never leave an old result on screen
  $("cameraMessage").textContent = "Camera stopped";
  $("cameraMessage").classList.remove("hidden");
  updateControls();
  setText("cameraStatus", "Stopped");
  setOverall("Stopped", "warn");
  if (wasActive) log("Camera stopped.");
}

// ---------- Result display ----------
function showBin(bin) {
  const badge = $("binBadge"), info = BINS[bin];
  badge.style.background = info?.colour ?? "#dce6eb";
  badge.style.color = info?.text ?? "#163247";
  badge.querySelector("strong").textContent = info ? info.name : "No bin rule";
  badge.querySelector("span").textContent = info ? info.description : "This label is not in the bin mapping.";
}

// Shows the bin, the label that decided it, and the runners-up (other objects, or other classifier classes).
function showResult(result) {
  showBin(result.bin);
  setText("className", result.label);
  setText("confidenceText", `${(result.confidence*100).toFixed(1)}%`);
  $("confidenceBar").style.width = `${result.confidence*100}%`;
  $("predictions").replaceChildren(...result.alternatives.slice(0,4).map(p => {
    const row=document.createElement("div"); row.className="prediction";
    const a=document.createElement("span"), b=document.createElement("span");
    a.textContent=`${p.label}${p.bin ? ` · ${BINS[p.bin].name}` : ""}`; b.textContent=`${(p.confidence*100).toFixed(1)}%`;
    row.append(a,b); return row;
  }));
}

// Nothing detected: show "No item" and restart the stable-frame count, so nothing is published.
function showNoItem(title = "No item", hint = "Hold one item in front of the camera.") {
  const badge = $("binBadge");
  badge.style.background = "#dce6eb"; badge.style.color = "#163247";
  badge.querySelector("strong").textContent = title;
  badge.querySelector("span").textContent = hint;
  setText("className", "—"); setText("confidenceText", "—");
  $("confidenceBar").style.width = "0"; $("predictions").replaceChildren();
  candidate = ""; candidateFrames = 0;
}

function updateStability(key) {
  if (key === candidate) candidateFrames += 1;
  else { candidate = key; candidateFrames = 1; }
}

// ---------- MQTT MESSAGE FORMAT (the "contract" with the dashboard) ----------
// MQTT only moves text. We send one JSON object per classified item, for example:
//
//   {
//     "schema_version": 2,                     version of THIS format; bump it when you make breaking changes
//     "message_type": "waste_classification",  lets a receiver tell message kinds apart (the dashboard switches on it)
//     "device_id": "team01-tablet01",          who sent it (from the "Device ID" box); use a unique id per device
//     "sequence": 17,                          counts up from 1 each page load; receivers use it to spot lost/duplicate messages
//     "timestamp": "2026-03-10T02:15:00.000Z", when it was sent, ISO 8601 in UTC
//     "source": "camera",                      "camera" for real detections, "manual_test" for the test button
//     "pipeline": "coco",                      which pipeline made the result (coco | classify | hybrid)
//     "bin": "yellow",                         key of BINS in bins.js, or null when the item has no bin
//     "bin_description": "Recycling",
//     "classification": "bottle",              the label the model produced
//     "confidence": 0.93,                      0..1, from the model
//     "detected_object": { "label": "bottle", "confidence": 0.91, "bbox": [x, y, w, h] } or null,
//                                              bbox is normalised 0..1 of the frame (COCO / hybrid only)
//     "inference_ms": 48,                      how long the model took (performance monitoring)
//     "model": "coco-ssd-lite",
//     "alternatives": [ { "label": "cup", "confidence": 0.04, "bin": "red" } ],   runner-up guesses
//     "location": { "latitude": -28.8034, "longitude": 153.2886, "accuracy_m": 10, ... } or null
//   }
//
// HOW TO CUSTOMISE
//   * Add a field: add a line to the object returned below, e.g.  "bin_id": "bin-A7",  or
//     "fill_level_pct": Number($("fillLevel").value)  if you add an <input id="fillLevel"> in index.html.
//   * Remove a field you do not need (smaller messages = less bandwidth), but check the dashboard does not use it.
//   * Rename a field: change it here AND in dashboard.js, or the dashboard will silently show nothing.
//   * Keep it valid JSON: numbers as numbers, text as strings, null (not undefined) for "no value".
//   * Never put secrets in the payload: on a public broker anyone can read it. Images are deliberately not sent.
//
// frame = result of analyseFrame (null for manual tests). The bounding box is normalised to 0-1 of the frame.
function buildPayload(result, inferenceMs, source="camera", frame=null) {
  const d = frame?.detection, [fw, fh] = d ? sourceSize($("camera")) : [1, 1];
  const round = v => Number(v.toFixed(4));
  return {
    schema_version:2, message_type:"waste_classification", device_id:value("deviceId"),
    sequence:++sequence, timestamp:new Date().toISOString(), source,
    pipeline: frame?.mode ?? null,
    bin: result.bin ?? null, bin_description: BINS[result.bin]?.description ?? null,
    classification:result.label, confidence:round(result.confidence),
    detected_object: d ? { label:d.class, confidence:round(d.score),
      bbox: [d.bbox[0]/fw, d.bbox[1]/fh, d.bbox[2]/fw, d.bbox[3]/fh].map(round) } : null,
    inference_ms:Math.round(inferenceMs),
    model: frame?.mode === "coco" ? "coco-ssd-lite" : (model?.source ?? null),
    alternatives:result.alternatives.slice(0,2).map(p=>({label:p.label, confidence:round(p.confidence), bin:p.bin ?? null})),
    location: locationPayload()
  };
}

// Sends one text message to the broker: the ONLY place that calls mqttClient.publish().
//   topic   like a folder path, "/" separated, e.g. "prog6002/2026/team01-tablet01/classification".
//           Subscribers choose which topics they receive; "+" (one level) and "#" (everything below) are wildcards
//           for SUBSCRIBING only, never use them in a publish topic. Use a distinct topic per message kind
//           (e.g. ".../classification", ".../status") so a receiver can subscribe to just what it needs.
//   qos     0 = at most once (may be lost), 1 = at least once (may arrive twice: that is why the dashboard
//           de-duplicates), 2 = exactly once (slowest, not offered by every broker).
//   retain  false = broker forgets the message after delivery. true = broker keeps the LAST message on that
//           topic and gives it to any new subscriber immediately (good for "current status", bad for events).
function publishText(text, description) {
  if (!mqttClient?.connected) { log("Cannot publish: MQTT is disconnected.", "error"); return false; }
  const topic=value("mqttTopic");
  if (!topic) { log("Cannot publish: publish topic is empty.", "error"); return false; }
  mqttClient.publish(topic, text, {qos:1, retain:false}, error => {
    if (error) return log(`Publish failed: ${error.message}`, "error");
    published += 1; setText("publishedCount", published); setText("payloadPreview", prettyPrint(text));
    log(`Published ${description} to ${topic}.`);
  });
  return true;
}

function publishPayload(payload) {
  const bin = BINS[payload.bin]?.name ?? "no bin";
  return publishText(JSON.stringify(payload), `${payload.classification} → ${bin} (${(payload.confidence*100).toFixed(1)}%)`);
}

// Decides WHEN to publish. Without this rule the app would send ~4 messages per second for the same bottle.
// A message is sent only when ALL of these hold:
//   stable    the same label+bin was seen in "Stable frames" consecutive frames (removes flicker)
//   confident the model confidence is at least "Confidence threshold"
//   new/due   it is a different item from the last one published, OR the "Publish cooldown" has passed
// All three numbers are boxes on the "Classifier configuration" panel. Change the logic here if your
// project needs something else (e.g. publish once per item and wait until the item is removed).
function considerPublish(result, inferenceMs, frame) {
  const threshold=Number(value("threshold")), required=Number(value("stableFrames")), cooldown=Number(value("cooldown"));
  const key=`${result.label}|${result.bin}`;
  updateStability(key);
  const now=Date.now(), stable=candidateFrames>=required, confident=result.confidence>=threshold;
  const changed=key!==lastPublishedClass, cooldownPassed=now-lastPublishedAt>=cooldown;
  if (stable && confident && (changed || cooldownPassed)) {
    // Without MQTT, keep classifying but do not try to publish (and do not flood the log).
    if (!mqttClient?.connected) return;
    if (publishPayload(buildPayload(result,inferenceMs,"camera",frame))) { lastPublishedClass=key; lastPublishedAt=now; candidateFrames=0; }
  }
}

async function inferenceLoop() {
  if (!running) return;
  try {
    const start=performance.now();
    const frame=await analyseFrame($("camera"));
    const elapsed=performance.now()-start;
    setText("inferenceTime", `${Math.round(elapsed)} ms`);
    setText("detectedStatus", describeDetection(frame));
    if (frame.result) {
      if (frame.stats) showInputStats(frame.stats); else setText("inputStats", "Crop of the detected object.");
      showResult(frame.result);
      drawDetections(frame.detections, frame.detection, frame.result);
      considerPublish(frame.result,elapsed,frame);
    } else if (frame.mode !== "waiting") {
      showNoItem(); drawDetections(frame.detections);
    }
    inferenceErrors = 0;
  } catch (error) {
    // Tolerate occasional errors (e.g. a frame lost during rotation); stop only if they keep happening.
    inferenceErrors += 1;
    log(`Inference error (${inferenceErrors}/5): ${error.message}`, "error");
    if (inferenceErrors >= 5) { log("Stopping after repeated inference errors.", "error"); stopAll(); return; }
  }
  // Limit load on an old tablet. Approximately 4 inferences/second maximum.
  await new Promise(resolve=>setTimeout(resolve,250));
  animationId=requestAnimationFrame(inferenceLoop);
}

async function start() {
  if (running) return;
  const ready = (!needsClassifier() || model) && (!usesDetection() || detector);
  busy.starting=true; updateControls(); setOverall(ready ? "Starting…" : "Loading models…", "warn");
  try {
    await loadPipeline();
    await startCamera(); running=true; setOverall("Running", "ok");
    if (!mqttClient?.connected) log("Running without MQTT: results will not be published until MQTT connects.", "warn");
    inferenceLoop();
  } catch (error) { log(error.message,"error"); setOverall("Start failed","bad"); }
  finally { busy.starting=false; updateControls(); }
}

// ---------- MQTT ----------
function normalizeBrokerUrl(raw) {
  let url = raw.trim();
  if (!url) throw new Error("Broker URL is empty.");
  const scheme = url.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1].toLowerCase();
  if (!scheme) {
    url = "wss://" + url.replace(/^\/+/, "");
    log(`No scheme in broker URL; using ${url}`);
  } else if (scheme === "ws" && location.protocol === "http:") {
    log("Using insecure ws:// because this page is not served over HTTPS.", "warn");
  } else if (scheme !== "wss") {
    url = "wss://" + url.slice(scheme.length + 3);
    log(`Browsers can only use WebSockets; changed ${scheme}:// to wss:// (${url}).`, "warn");
  }
  return url;
}

function setMqttButtons() { updateControls(); }

function updateSubscribeUi() {
  $("subscribeButton").textContent = subscribedTopic ? "Unsubscribe" : "Subscribe";
  setText("subscribedStatus", subscribedTopic || "—");
}

function setMqttStatus(status, level="info") {
  if ($("mqttStatus").textContent === status) return;
  setText("mqttStatus", status);
  log(`MQTT ${status.toLowerCase()}.`, level);
}

function disconnectMqtt() {
  if (!mqttClient) return;
  mqttClient.removeAllListeners();
  mqttClient.end(true);
  mqttClient = null; subscribedTopic = "";
  setText("mqttStatus", "Disconnected"); $("mqttButton").textContent = "Connect MQTT";
  setMqttButtons(false); updateSubscribeUi();
  log("MQTT disconnected by user.");
}

// Connects to the broker with the mqtt.js library (loaded by a <script> tag in index.html; it provides `mqtt`).
// Browsers cannot open raw TCP sockets, so the broker must offer MQTT over WebSockets (wss://host:port/path).
// Options below: clientId must be unique per connection (a duplicate kicks the other client off);
// clean:true = start with no saved subscriptions; reconnectPeriod = retry every 3 s if the link drops;
// keepalive = ping every 30 s so the broker knows we are alive.
// The events registered at the bottom are how mqtt.js reports things: "connect", "message", "error", ...
function connectMqtt() {
  if (mqttClient) { disconnectMqtt(); return; }
  if (typeof mqtt === "undefined") { log("MQTT library failed to load. Check the internet connection and reload.", "error"); return; }
  let url;
  try { url = normalizeBrokerUrl($("brokerUrl").value); } catch (error) { log(error.message, "error"); return; }
  $("brokerUrl").value = url;
  const options={clientId:`${value("deviceId") || "device"}-web-${Math.random().toString(16).slice(2,10)}`,clean:true,
                 connectTimeout:10000,reconnectPeriod:3000,keepalive:30};
  if (value("mqttUsername")) options.username=value("mqttUsername");
  if ($("mqttPassword").value) options.password=$("mqttPassword").value;
  setText("mqttStatus","Connecting…"); log(`MQTT connecting to ${url}…`);
  $("mqttButton").textContent = "Disconnect MQTT";
  try { mqttClient=mqtt.connect(url,options); }
  catch (error) { log(`MQTT connect failed: ${error.message}`, "error"); mqttClient=null; $("mqttButton").textContent="Connect MQTT"; return; }
  mqttClient.on("connect",()=>{setMqttStatus("Connected"); setMqttButtons(true);});
  mqttClient.on("reconnect",()=>setMqttStatus("Reconnecting…", "warn"));
  mqttClient.on("offline",()=>{setMqttStatus("Offline", "warn"); setMqttButtons(false);});
  mqttClient.on("close",()=>{setMqttStatus("Disconnected", "warn"); setMqttButtons(false);});
  mqttClient.on("error",error=>log(`MQTT error: ${error.message}`,"error"));
  mqttClient.on("message",showReceived);
}

// Subscribing tells the broker "send me every message published to topics matching this filter".
// The messages then arrive in the mqttClient.on("message", ...) handler in connectMqtt() -> showReceived().
// This tablet only DISPLAYS what it receives; to make it react (e.g. show an "empty the bin" alert),
// parse the message in showReceived() and act on it. Note that subscriptions are lost on a clean reconnect.
function toggleSubscribe() {
  if (!mqttClient?.connected) { log("Cannot subscribe: MQTT is disconnected.", "error"); return; }
  if (subscribedTopic) {
    const topic = subscribedTopic;
    mqttClient.unsubscribe(topic, error => {
      if (error) return log(`Unsubscribe failed: ${error.message}`, "error");
      subscribedTopic = ""; updateSubscribeUi(); log(`Unsubscribed from ${topic}.`);
    });
    return;
  }
  const topic = value("subscribeTopic");
  if (!topic) { log("Subscribe topic is empty.", "error"); return; }
  mqttClient.subscribe(topic, {qos:1}, (error, granted) => {
    if (error) return log(`Subscribe failed: ${error.message}`, "error");
    if (granted?.[0]?.qos === 128) return log(`Broker rejected subscription to ${topic}.`, "error");
    subscribedTopic = topic; updateSubscribeUi(); log(`Subscribed to ${topic}.`);
  });
}

function prettyPrint(text) {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

// Called for every incoming message. `message` is a Buffer (bytes), so .toString() turns it into text.
// To use the data rather than just show it:
//     let data; try { data = JSON.parse(message.toString()); } catch { return; }   // may not be JSON!
//     if (data.message_type === "command") { ... }
// Always treat incoming data as untrusted and write it to the page with textContent, never innerHTML.
function showReceived(topic, message) {
  received += 1; setText("receivedCount", received);
  const item = document.createElement("li");
  const head = document.createElement("div"), body = document.createElement("pre");
  head.className = "received-head";
  head.textContent = `${new Date().toLocaleTimeString()} · ${topic}`;
  body.textContent = prettyPrint(message.toString());
  item.append(head, body);
  $("receivedLog").prepend(item);
  while ($("receivedLog").children.length > 30) $("receivedLog").lastChild.remove();
}

function clearReceived() {
  $("receivedLog").replaceChildren(); received = 0; setText("receivedCount", 0);
}

// ---------- ADDING YOUR OWN MESSAGE TYPE ----------
// Example: publish a "bin_status" message (a measured fill level) to a second topic. dashboard.js already
// understands this shape (see handleBinStatus() there):
//
//   function publishBinStatus(levelPct) {
//     const topic = value("mqttTopic").replace(/classification$/, "binstatus");   // ".../binstatus"
//     const msg = { schema_version:1, message_type:"bin_status", device_id:value("deviceId"),
//                   timestamp:new Date().toISOString(), bins:{ yellow:{ level_pct:levelPct } },
//                   location: locationPayload() };
//     mqttClient.publish(topic, JSON.stringify(msg), {qos:1});
//   }
//
// Steps: (1) pick a new "message_type" and a topic, (2) build the object, (3) JSON.stringify and publish,
// (4) add a matching case in dashboard.js handleMessage(). You can try it without any code by pasting the JSON
// into the "Publish test message" box below, which sends exactly what you type to the publish topic.
function publishTest() {
  const text = $("testMessage").value.trim();
  if (!text) {
    publishPayload(buildPayload({label:"TEST_ONLY", confidence:1, bin:null, alternatives:[]}, 0, "manual_test"));
    return;
  }
  publishText(text, "custom test message");
}

// ---------- Wiring ----------
$("startButton").addEventListener("click",start);
$("loadModelButton").addEventListener("click",loadModelButton);
$("modelSource").addEventListener("change",()=>{updateModelSourceUi(); modelSettingsChanged();});
$("modelFiles").addEventListener("change",()=>{showSelectedFiles(); modelSettingsChanged();});
$("modelUrl").addEventListener("change",modelSettingsChanged);
$("backend").addEventListener("change",backendChanged);
$("pipeline").addEventListener("change",pipelineChanged);
$("fallback").addEventListener("change",pipelineChanged);
$("resetBinsButton").addEventListener("click",resetBinMapping);
$("region").addEventListener("change",updateRegionGuide);
$("camera").addEventListener("loadedmetadata",updateRegionGuide);
$("camera").addEventListener("resize",updateRegionGuide);   // fires when the phone rotates
window.addEventListener("resize",updateRegionGuide);
$("selfTestButton").addEventListener("click",runSelfTest);
$("photoInput").addEventListener("change",classifyPhoto);
$("normalization").addEventListener("change",modelSettingsChanged);
$("cameraTestButton").addEventListener("click",testCamera);
$("stopButton").addEventListener("click",stopAll);
$("mqttButton").addEventListener("click",connectMqtt);
$("saveButton").addEventListener("click",saveSettings);
$("tabletToggle").addEventListener("click",()=>setTabletMode(!document.body.classList.contains("tablet-mode")));
$("rememberPassword").addEventListener("change",rememberPasswordChanged);
$("includeLocation").addEventListener("change",locationChanged);
$("locationPrecision").addEventListener("change",()=>{ if (lastFix) { const l = locationPayload(); setText("locationStatus", `${l.latitude}, ${l.longitude} (±${l.accuracy_m} m)`); } });
$("testButton").addEventListener("click",publishTest);
$("subscribeButton").addEventListener("click",toggleSubscribe);
$("clearReceivedButton").addEventListener("click",clearReceived);
$("logToggle").addEventListener("click",()=>setLogVisible($("logPanel").hidden));
$("clearLogButton").addEventListener("click",clearLog);
$("errorsOnly").addEventListener("change",e=>$("eventLog").classList.toggle("errors-only", e.target.checked));
window.addEventListener("error",e=>log(`Script error: ${e.message}`,"error"));
window.addEventListener("unhandledrejection",e=>log(`Unhandled error: ${e.reason?.message || e.reason}`,"error"));
window.addEventListener("pagehide",()=>{stopAll(); if(mqttClient)mqttClient.end(true);});
loadSettings();
updateModelSourceUi();
pipelineChanged();
updateControls();
try { if (localStorage.getItem(TABLET_MODE_KEY) === "1") setTabletMode(true, {fullscreen: false}); } catch {}
renderBinMapping();
log("App ready. Test the camera and MQTT independently, or configure a model URL and start classifying.");
