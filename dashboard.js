"use strict";
/* =====================================================================================================
   SCU Smart Waste Dashboard: STARTER PROTOTYPE (PROG6002)

   WHAT THIS FILE DOES
     1. Connects to an MQTT broker over WebSockets and subscribes to your topic(s).
     2. Every message that arrives goes through handleMessage(), which decides what kind of message it is.
     3. The message updates the in-memory STATE (devices, bins, events).
     4. renderAll() redraws the page from STATE.  Data flows one way:   MQTT -> STATE -> screen.

   HOW TO READ IT (top to bottom)
     A. CONFIG        settings you are expected to change
     B. STATE         the data the dashboard holds
     C. MQTT          connect / subscribe / receive
     D. MESSAGES      turning JSON into STATE  <- edit this if you change the message format in app.js
     E. CALCULATIONS  bin level, statistics
     F. RENDERING     STATE -> HTML (bin cards, KPIs, tables, charts)
     G. MAP           Leaflet map
     H. SIMULATOR     fake data so you can work without a tablet
     I. WIRING        buttons, start-up

   MESSAGES THIS DASHBOARD UNDERSTANDS  (see also the long comment above buildPayload() in app.js)

     1. "waste_classification": published by the tablet each time it sorts an item.
        {
          "message_type": "waste_classification",
          "device_id": "team01-tablet01",
          "sequence": 12, "timestamp": "2026-03-10T02:15:00.000Z",
          "classification": "bottle", "confidence": 0.93,
          "bin": "yellow",                          // key of BINS in bins.js: red | yellow | green | ewaste | null
          "location": { "latitude": -28.8034, "longitude": 153.2886, "accuracy_m": 10 }   // or null
        }

     2. "bin_status": NOT sent by the tablet. This is what a real smart bin (ESP32 + ultrasonic sensor, or
        a second browser tab) would publish. It gives a MEASURED fill level. Your team decides who sends it.
        {
          "message_type": "bin_status",
          "device_id": "team01-tablet01",
          "timestamp": "2026-03-10T02:15:00.000Z",
          "bins": { "yellow": { "level_pct": 63 }, "red": { "level_pct": 20 } },
          "battery_pct": 87,                        // optional
          "location": { "latitude": -28.8034, "longitude": 153.2886 }   // optional
        }

   Without bin_status messages the dashboard ESTIMATES each bin's level from how many items were sorted into
   it (items / CONFIG.binCapacity). Estimated and measured levels are labelled differently on the cards.

   SECURITY NOTE: a public broker lets anyone publish to your topic. Never put message text into innerHTML.
   This file only uses textContent (through the el() helper), so a malicious "classification" cannot inject HTML.
   ===================================================================================================== */

const $ = (id) => document.getElementById(id);

/* =====================================================================================================
   A. CONFIG: the settings most likely to need changing
   ===================================================================================================== */
const CONFIG = {
  // Must match the tablet (index.html): "Broker WebSocket URL". Browsers need wss:// (or ws:// on http pages).
  brokerUrl: "wss://broker.hivemq.com:8884/mqtt",

  // Must match (or be a wildcard of) the tablet's "Publish topic". Separate several topics with commas.
  // "prog6002/2026/team01-tablet01/#"  everything below one device's topic
  // "prog6002/2026/+/classification"   the classification topic of every device (+ = any one level)
  topicFilter: "prog6002/2026/team01-tablet01/#",

  // Only used when a bin has NOT reported a measured level: how many items fill one bin (estimate).
  // Keys must exist in BINS (bins.js). Add a key here if you add a bin there.
  binCapacity: { red: 20, yellow: 20, green: 20, ewaste: 10 },

  // Traffic-light thresholds, as % full.
  warnPct: 60,     // amber at or above this
  fullPct: 85,     // red ("needs emptying") at or above this

  // A device that has sent nothing for this long is shown as offline.
  offlineAfterMs: 5 * 60 * 1000,

  // Map start position (SCU Lismore campus). The map moves to your devices once they report a location.
  mapCentre: [-28.8034, 153.2886],
  mapZoom: 15,

  maxEvents: 2000,        // how many classifications to remember (oldest are dropped)
  timelineMinutes: 30     // width of the activity chart
};

/* =====================================================================================================
   B. STATE: everything the screen is drawn from
   ===================================================================================================== */
const BIN_KEYS = Object.keys(BINS);      // ["red","yellow","green","ewaste"], from bins.js, so both pages agree

// devices: Map of device_id -> {
//   id, lastSeen (ms), location: {lat,lng,accuracy}|null, battery (%)|null, unsorted (count),
//   bins: { red: { total, sinceEmptied, sensorLevel (%|null) }, yellow: {...}, ... }
// }
const devices = new Map();
// events: newest LAST. Each: { t (ms), device, label, bin, confidence }
let events = [];
const seenKeys = new Set();     // used to drop duplicate deliveries (MQTT QoS 1 can deliver a message twice)
let client = null;              // the MQTT client (null when disconnected)
let messageCount = 0;

function getDevice(id) {
  if (!devices.has(id)) {
    devices.set(id, {
      id, lastSeen: 0, location: null, battery: null, unsorted: 0,
      bins: Object.fromEntries(BIN_KEYS.map(k => [k, { total: 0, sinceEmptied: 0, sensorLevel: null }]))
    });
    refreshDeviceSelect();
  }
  return devices.get(id);
}

/* =====================================================================================================
   C. MQTT: connect, subscribe, receive
   ===================================================================================================== */
function setStatus(text, kind) {
  const pill = $("mqttStatus");
  pill.textContent = text;
  pill.className = "pill" + (kind ? " " + kind : "");
}

function connect() {
  if (client) { client.end(true); client = null; setStatus("Disconnected"); $("connectButton").textContent = "Connect"; return; }
  if (typeof mqtt === "undefined") { setStatus("MQTT library failed to load", "bad"); return; }
  const url = $("brokerUrl").value.trim();
  const topics = $("topicFilter").value.split(",").map(s => s.trim()).filter(Boolean);
  if (!url || topics.length === 0) { setStatus("Enter a broker URL and topic", "warn"); return; }
  saveInputs();

  setStatus("Connecting…", "warn");
  $("connectButton").textContent = "Disconnect";
  // clientId must be unique per connection, otherwise the broker disconnects the older one.
  // Add { username, password } here if your broker needs credentials (see the tablet's "Optional broker credentials").
  client = mqtt.connect(url, { 
    clientId: "dashboard-" + Math.random().toString(16).slice(2, 10), 
    clean: true, 
    reconnectPeriod: 3000, 
    connectTimeout: 10000 });

  // "connect" fires on the first connection AND after every automatic reconnect. Because clean:true wipes
  // subscriptions, we must subscribe again every time.
  client.on("connect", () => {
    setStatus("Connected", "ok");
    client.subscribe(topics, { qos: 1 }, (err, granted) => {
      if (err) setStatus("Subscribe failed: " + err.message, "bad");
      else if (granted.some(g => g.qos === 128)) setStatus("Broker rejected a subscription", "bad");
    });
  });
  client.on("reconnect", () => setStatus("Reconnecting…", "warn"));
  client.on("offline", () => setStatus("Offline", "warn"));
  client.on("error", err => setStatus("Error: " + err.message, "bad"));
  // The single entry point for incoming data. `message` is a Buffer, so convert it to text.
  client.on("message", (topic, message) => handleMessage(topic, message.toString()));
}

/* =====================================================================================================
   D. MESSAGES: turn incoming JSON into STATE
   To support a NEW message type: add a case to the switch in handleMessage() and write a handler like
   handleBinStatus(). If you change field names in app.js buildPayload(), update the handlers here to match.
   ===================================================================================================== */
function handleMessage(topic, text) {
  messageCount += 1;
  logRaw(topic, text);

  let msg;
  try { msg = JSON.parse(text); } catch { return; }              // not JSON: ignore (it still shows in the raw log)
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;

  switch (msg.message_type) {
    case "waste_classification": handleClassification(msg); break;
    case "bin_status":           handleBinStatus(msg); break;
    case "warning":              handleWarning(msg); break;   //warning
    // case "my_new_type":       handleMyNewType(msg); break;    // <- your own message types go here
    default: break;                                              // unknown type: ignore it, never crash on it
  }
  scheduleRender();
}

// Common to every message: which device sent it, and where it is.
function touchDevice(msg) {
  const id = String(msg.device_id || "unknown").slice(0, 64);
  const dev = getDevice(id);
  dev.lastSeen = Date.now();                                     // use arrival time; device clocks can be wrong
  const loc = msg.location;
  if (loc && Number.isFinite(loc.latitude) && Number.isFinite(loc.longitude)
      && Math.abs(loc.latitude) <= 90 && Math.abs(loc.longitude) <= 180) {
    dev.location = { lat: loc.latitude, lng: loc.longitude, accuracy: Number.isFinite(loc.accuracy_m) ? loc.accuracy_m : null };
  }
  return dev;
}

const isBin = (k) => typeof k === "string" && Object.hasOwn(BINS, k);   // is k a bin defined in bins.js?

function handleClassification(msg) {
  if (msg.source === "manual_test" || msg.classification === "TEST_ONLY") return;   // "Publish test message" button on the tablet

  // Drop duplicates (same device + sequence + timestamp).
  const key = `${msg.device_id}|${msg.sequence}|${msg.timestamp}`;
  if (seenKeys.has(key)) return;
  seenKeys.add(key);
  if (seenKeys.size > CONFIG.maxEvents * 2) seenKeys.delete(seenKeys.values().next().value);

  const dev = touchDevice(msg);
  const bin = isBin(msg.bin) ? msg.bin : null;
  if (bin) { dev.bins[bin].total += 1; dev.bins[bin].sinceEmptied += 1; } else dev.unsorted += 1;

  events.push({
    t: Date.now(), device: dev.id, bin,
    label: String(msg.classification ?? "unknown").slice(0, 40),
    confidence: Number.isFinite(msg.confidence) ? msg.confidence : null
  });
  if (events.length > CONFIG.maxEvents) events.shift();
}

function handleBinStatus(msg) {
  const dev = touchDevice(msg);
  if (Number.isFinite(msg.battery_pct)) dev.battery = Math.round(msg.battery_pct);
  for (const [bin, info] of Object.entries(msg.bins ?? {})) {
    if (isBin(bin) && Number.isFinite(info?.level_pct)) {
      dev.bins[bin].sensorLevel = Math.max(0, Math.min(100, info.level_pct));   // clamp: never trust incoming numbers
      recordFillReading(dev.id, bin, info.level_pct);
    }
  }
}

function handleWarning(msg) {
    touchDevice(msg);
    const event = msg.event || "unknown";
    const fillPct = Number.isFinite(msg.fill_pct) ? msg.fill_pct : 0;
    
    // Only show banner for lid_refused_full
    // (bin_full is already shown in Fleet Alerts panel)
    if (event === "lid_refused_full") {
        const item = msg.attempted_item || "item";
        const text = "LID REFUSED: Bin " + fillPct + "% full - someone tried to dispose: " + item;
        showWarningBanner(text);
    }
    console.warn("Warning:", event, msg);
}

function showWarningBanner(text, type) {
    const existing = document.getElementById("warningBanner");
    if (existing) existing.remove();
    
    const banner = document.createElement("div");
    banner.id = "warningBanner";
    banner.style.cssText = "position:fixed;top:0;left:0;right:0;padding:16px 20px;text-align:center;font-size:16px;font-weight:700;color:white;background:#b42318;z-index:9999;box-shadow:0 2px 10px rgba(0,0,0,0.3);cursor:pointer;";
    banner.textContent = "🚨 " + text + " (click to dismiss)";
    banner.onclick = function() { banner.remove(); };
    
    document.body.prepend(banner);
    setTimeout(function() {
        if (banner.parentNode) banner.remove();
    }, 15000);
}

/* =====================================================================================================
   E. CALCULATIONS: values derived from STATE (kept separate from drawing so they are easy to test)
   ===================================================================================================== */
const selectedDevices = () => {
  const id = $("deviceSelect").value;
  return id ? [devices.get(id)].filter(Boolean) : [...devices.values()];
};

// Fill level of ONE bin on ONE device. A measured value beats an estimate.
function binLevel(dev, bin) {
  const b = dev.bins[bin];
  if (b.sensorLevel !== null) return { pct: b.sensorLevel, source: "measured" };
  const cap = CONFIG.binCapacity[bin] || 20;
  return { pct: Math.min(100, (b.sinceEmptied / cap) * 100), source: "estimated" };
}

// One bin across the devices being shown: total items, and the WORST (fullest) level, because that is
// the one a collection crew needs to know about.
function summariseBin(list, bin) {
  let total = 0, worst = { pct: 0, source: "estimated" };
  for (const d of list) {
    total += d.bins[bin].total;
    const lv = binLevel(d, bin);
    if (lv.pct >= worst.pct) worst = lv;
  }
  return { total, ...worst };
}

function levelState(pct) {
  if (pct >= CONFIG.fullPct) return { text: "Needs emptying", kind: "bad", colour: "#d92d20" };
  if (pct >= CONFIG.warnPct) return { text: "Filling up", kind: "warn", colour: "#e8a200" };
  return { text: "OK", kind: "ok", colour: "#12a150" };
}

const isOnline = (dev) => Date.now() - dev.lastSeen < CONFIG.offlineAfterMs;

function eventsFor(list) {
  const ids = new Set(list.map(d => d.id));
  return events.filter(e => ids.has(e.device));
}

function computeStats(list) {
  const evs = eventsFor(list);
  const perBin = Object.fromEntries(BIN_KEYS.map(k => [k, 0]));
  const perLabel = {};
  let confSum = 0, confN = 0;
  for (const e of evs) {
    if (e.bin) perBin[e.bin] += 1;
    perLabel[e.label] = (perLabel[e.label] || 0) + 1;
    if (e.confidence !== null) { confSum += e.confidence; confN += 1; }
  }
  const total = evs.length;
  const hourAgo = Date.now() - 3600_000;
  return {
    total, perBin, perLabel, recent: evs.slice(-10).reverse(),
    lastHour: evs.filter(e => e.t >= hourAgo).length,
    // "Diversion rate" = share of items NOT going to landfill (yellow recycling + green organics). Change the
    // definition to whatever your team decides is a useful measure.
    diversion: total ? (perBin.yellow + perBin.green) / total : null,
    avgConfidence: confN ? confSum / confN : null,
    // Items per minute for the last CONFIG.timelineMinutes minutes (oldest first).
    timeline: (() => {
      const n = CONFIG.timelineMinutes, now = Date.now(), buckets = new Array(n).fill(0);
      for (const e of evs) { const age = Math.floor((now - e.t) / 60000); if (age < n) buckets[n - 1 - age] += 1; }
      return buckets;
    })()
  };
}

/* =====================================================================================================
   F. RENDERING: STATE -> HTML
   scheduleRender() batches many messages into a single redraw per animation frame.
   ===================================================================================================== */
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderAll(); });
}

// renderAll() is the table of contents of the page. Add your own render functions here.
function renderFleetAlerts() {
  const container = $("fleetAlerts");
  if (!container) return;

  const alerts = [];

  for (const device of devices.values()) {
    const stale = !isOnline(device);

    for (const key of BIN_KEYS) {
      const level = binLevel(device, key);

      if (level.pct < CONFIG.warnPct) continue;

      const full = level.pct >= CONFIG.fullPct;
      const compartment = BINS[key].name;
      const estimated = level.source === "measured"
        ? ""
        : " · Estimated";

      alerts.push({
        device,
        kind: full ? "full" : "warning",
        pct: level.pct,
        text:
          `${compartment} · ${Math.round(level.pct)}%` +
          estimated +
          (stale
            ? " · Last known reading—check device"
            : full
              ? " · Collection required"
              : " · Approaching collection threshold")
      });
    }

    if (stale) {
      alerts.push({
        device,
        kind: "stale",
        pct: 0,
        text: `No recent updates · Last seen ${timeAgo(device.lastSeen)}`
      });
    }
  }

  const priority = { full: 0, warning: 1, stale: 2 };

  alerts.sort((a, b) =>
    priority[a.kind] - priority[b.kind] ||
    b.pct - a.pct ||
    a.device.id.localeCompare(b.device.id)
  );

  // Group all compartment and stale alerts by device.
const grouped = new Map();

for (const alert of alerts) {
  if (!grouped.has(alert.device.id)) {
    grouped.set(alert.device.id, {
      device: alert.device,
      alerts: []
    });
  }

  grouped.get(alert.device.id).alerts.push(alert);
}

function groupKind(group) {
  if (group.alerts.some(a => a.kind === "full")) return "full";
  if (group.alerts.some(a => a.kind === "warning")) return "warning";
  return "stale";
}

const groups = [...grouped.values()].sort((a, b) =>
  priority[groupKind(a)] - priority[groupKind(b)] ||
  a.device.id.localeCompare(b.device.id)
);

// Remember expanded device dropdowns during updates.
const expanded = new Set(
  [...container.querySelectorAll("details[open]")]
    .map(node => node.dataset.deviceId)
);

const panel = $("fleetAlertPanel");
const summary = $("fleetAlertSummary");

const hasFull = alerts.some(a => a.kind === "full");
const hasWarning = alerts.some(a => a.kind === "warning");

panel.classList.toggle("has-full", hasFull);
panel.classList.toggle("has-warning", !hasFull && hasWarning);

summary.textContent =
  `${groups.length} ${groups.length === 1 ? "device" : "devices"} ` +
  `with alerts · ${alerts.length} total`;

const rows = groups.map(group => {
  const kind = groupKind(group);

  const deviceButton = el("button", {
    type: "button",
    class: "fleet-alert-device"
  }, "Show on map");

  deviceButton.addEventListener("click", () =>
    selectDevice(group.device.id)
  );

  const messages = group.alerts.map(alert =>
    el("div", {
      class: `fleet-alert ${alert.kind}`
    },
      el("span", {
        class: "fleet-alert-icon",
        "aria-hidden": "true"
      }, alert.kind === "stale" ? "◷" : "⚠"),
      el("span", {}, alert.text)
    )
  );

  const heading =
    `${group.device.id} · ` +
    (kind === "full"
      ? "Collection required"
      : kind === "warning"
        ? "Approaching threshold"
        : "Device stale");

  // Only create a nested dropdown when there are multiple alerts.
  if (group.alerts.length > 1) {
    const dropdown = el("details", {
      class: `device-alert-group ${kind}`,
      "data-device-id": group.device.id
    },
      el("summary", {},
        `${heading} · ${group.alerts.length} alerts`
      ),
      el("div", { class: "device-alert-content" },
        deviceButton,
        ...messages
      )
    );

    dropdown.open = expanded.has(group.device.id);
    return dropdown;
  }

  return el("div", {
    class: `device-alert-group ${kind}`
  },
    el("div", { class: "device-alert-heading" }, heading),
    el("div", { class: "device-alert-content" },
      deviceButton,
      ...messages
    )
  );
});

if (!groups.length) {
  summary.textContent = "0 Alerts";
}

container.replaceChildren(...rows);
}

function renderAll() {
  const list = selectedDevices(), stats = computeStats(list);
  renderFleetAlerts();
  renderKpis(list, stats);
  renderBinCards(list);
  renderDevices();
  renderBinCounts(stats);
  renderTopItems(stats);
  renderTimeline(stats);
  renderRecent(stats);
  renderMap();
  renderFillHistory();
}

// Small helper to build elements safely (textContent only, never innerHTML).
// el("div", {class:"x", style:{color:"red"}}, "text", childElement)
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "style") Object.assign(node.style, v);
    else node.setAttribute(k, v);
  }
  node.append(...children.filter(c => c !== null && c !== undefined));
  return node;
}

const pct = (v) => v === null ? "—" : Math.round(v * 100) + "%";
const timeAgo = (ms) => {
  if (!ms) return "never";
  const s = Math.round((Date.now() - ms) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};

function renderKpis(list, s) {
  const online = list.filter(isOnline).length;
  const tiles = [
    ["Items sorted", s.total],
    ["Last hour", s.lastHour],
    ["Diverted from landfill", pct(s.diversion)],
    ["Average confidence", pct(s.avgConfidence)],
    ["Devices online", `${online} / ${list.length}`],
    ["Messages received", messageCount]
  ];
  $("kpis").replaceChildren(...tiles.map(([label, value]) => el("div", { class: "kpi" }, el("span", {}, label), el("strong", {}, String(value)))));
}

// One card per bin type (colours and names come from bins.js).
function renderBinCards(list) {
  $("binCards").replaceChildren(...BIN_KEYS.map(k => {
    const info = BINS[k], sum = summariseBin(list, k), st = levelState(sum.pct);
    const gauge = el("div", { class: "gauge" }, el("div", { style: { width: sum.pct + "%", background: st.colour } }));
    const card = el("div", { class: "bin-card", style: { borderTopColor: info.colour } },
      el("h3", {}, info.name),
      el("div", { class: "sub" }, info.description),
      gauge,
      el("div", { class: "row" }, el("span", {}, `${Math.round(sum.pct)}% full (${sum.source})`), el("span", { class: "state " + st.kind }, st.text)),
      el("div", { class: "row" }, el("span", {}, "Items sorted"), el("strong", {}, String(sum.total)))
    );
    return card;
  }));
}

function selectDevice(id) {
  if (!devices.has(id)) return;

  $("deviceSelect").value = id;
  renderAll();

  const device = devices.get(id);
  const marker = markers.get(id);

  if (map && device.location) {
    map.setView(
      [device.location.lat, device.location.lng],
      17
    );

    if (marker) marker.openPopup();
  }
}

function renderDevices() {
  const selectedId = $("deviceSelect").value;

  const rows = [...devices.values()].map(d => {
    const fullest = Math.max(
      ...BIN_KEYS.map(k => binLevel(d, k).pct)
    );

    const on = isOnline(d);
    const items = BIN_KEYS.reduce(
      (n, k) => n + d.bins[k].total,
      d.unsorted
    );

    const row = el("tr", {
      class: "device-row" +
        (d.id === selectedId ? " selected" : ""),
      tabindex: "0",
      "aria-label": `Show ${d.id} on the map and overview`
    },
      el("td", {}, d.id),
      el("td", {},
        el("span", {
          class: "dot " + (on ? "ok" : "bad")
        }),
        on ? "Online" : "Stale"
      ),
      el("td", {}, timeAgo(d.lastSeen)),
      el("td", {}, String(items)),
      el("td", {}, Math.round(fullest) + "%"),
      el("td", {},
        d.location
          ? `${d.location.lat.toFixed(4)}, ${d.location.lng.toFixed(4)}`
          : "No GPS"
      )
    );

    row.addEventListener("click", () => selectDevice(d.id));

    row.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectDevice(d.id);
      }
    });

    return row;
  });

  $("deviceRows").replaceChildren(
    ...(rows.length
      ? rows
      : [el("tr", {},
          el("td", {
            colspan: 6,
            class: "note-empty"
          }, "No devices yet. Connect, or start the simulator.")
        )])
  );
}

// Generic horizontal bar list, reused for bins and items.
function barRows(entries, colourFor) {
  const max = Math.max(1, ...entries.map(e => e[1]));
  if (!entries.length) return [el("p", { class: "note-empty" }, "No data yet.")];
  return entries.map(([label, n]) => el("div", { class: "barrow" },
    el("span", {}, label),
    el("div", { class: "bar" }, el("div", { style: { width: (n / max) * 100 + "%", background: colourFor(label) } })),
    el("span", {}, String(n))));
}

function renderBinCounts(s) {
  $("binCounts").replaceChildren(...barRows(BIN_KEYS.map(k => [BINS[k].name, s.perBin[k]]),
    name => BINS[BIN_KEYS.find(k => BINS[k].name === name)].colour));
}

function renderTopItems(s) {
  const top = Object.entries(s.perLabel).sort((a, b) => b[1] - a[1]).slice(0, 8);
  $("topItems").replaceChildren(...barRows(top, () => "var(--brand)"));
}

// A tiny hand-drawn SVG bar chart. For richer charts, try Chart.js (https://www.chartjs.org).
function renderTimeline(s) {
  $("timelineMinutes").textContent = CONFIG.timelineMinutes;
  const W = 600, H = 120, n = s.timeline.length, max = Math.max(1, ...s.timeline), bw = W / n;
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("width", "100%");
  svg.setAttribute("role", "img"); svg.setAttribute("aria-label", "Items sorted per minute");
  s.timeline.forEach((v, i) => {
    const h = (v / max) * (H - 10), r = document.createElementNS(NS, "rect");
    r.setAttribute("x", i * bw + 1); r.setAttribute("y", H - h); r.setAttribute("width", bw - 2); r.setAttribute("height", h);
    r.setAttribute("fill", "#2b6d94");
    svg.append(r);
  });
  $("timeline").replaceChildren(svg);
}

function renderRecent(s) {
  const rows = s.recent.map(e => el("tr", {},
    el("td", {}, new Date(e.t).toLocaleTimeString()),
    el("td", {}, e.device),
    el("td", {}, e.label),
    el("td", {}, e.bin ? BINS[e.bin].name : "—"),
    el("td", {}, pct(e.confidence))));
  $("recentRows").replaceChildren(...(rows.length ? rows : [el("tr", {}, el("td", { colspan: 5, class: "note-empty" }, "Nothing yet."))]));
}

// Raw message log (newest first, capped). The first thing to check when the display looks wrong.
function logRaw(topic, text) {
  const li = el("li", {}, `${new Date().toLocaleTimeString()} ${topic} ${text.slice(0, 300)}`);
  $("rawLog").prepend(li);
  while ($("rawLog").children.length > 40) $("rawLog").lastChild.remove();
}

function refreshDeviceSelect() {
  const sel = $("deviceSelect"), current = sel.value;
  sel.replaceChildren(el("option", { value: "" }, "All devices"), ...[...devices.keys()].map(id => el("option", { value: id }, id)));
  sel.value = devices.has(current) ? current : "";
}

/* =====================================================================================================
   G. MAP (Leaflet). One coloured circle per device that has reported a location.
   Colour = worst bin on that device (green / amber / red), grey if the device is offline.
   ===================================================================================================== */
let map = null, mapFitted = false;
const markers = new Map();     // device id -> Leaflet marker

function initMap() {
  if (typeof L === "undefined") { $("mapNote").textContent = "Map library failed to load (check the internet connection)."; return; }
  map = L.map("map").setView(CONFIG.mapCentre, CONFIG.mapZoom);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);
}

function renderMap() {
  if (!map) return;
  const located = [...devices.values()].filter(d => d.location);
  $("mapNote").textContent = located.length
    ? ""
    : "No device has sent a location yet. On the tablet tick “Include GPS location in messages” (needs HTTPS), or use the simulator.";

  for (const d of located) {
    const fullest = Math.max(...BIN_KEYS.map(k => binLevel(d, k).pct));
    const colour = isOnline(d) ? levelState(fullest).colour : "#98a2b3";
    let m = markers.get(d.id);
    if (!m) { m = L.circleMarker([d.location.lat, d.location.lng], 
      { radius: 11, weight: 2, color: "#123047", fillOpacity: 0.85 }).addTo(map); 
      markers.set(d.id, m);
      m.on("click", () => {
      $("deviceSelect").value = d.id;
      renderAll();
});
    }
    m.setLatLng([d.location.lat, d.location.lng]).setStyle({ fillColor: colour });
    // Popup content is a DOM element (not an HTML string) so device names cannot inject markup.

const sortedBins = BIN_KEYS
  .map(key => ({
    key,
    pct: binLevel(d, key).pct
  }))
  .sort((a, b) => b.pct - a.pct);

const popup = el("div", { class: "bin-popup" },
  el("div", { class: "bin-popup-header" },
    el("strong", {}, d.id),
    el("span", {}, "· Last seen " + timeAgo(d.lastSeen))
  ),
  ...sortedBins.map(({ key, pct }) => {
  const status = levelState(pct);

  return el("div", {
    style: { marginBottom: "12px" }
  },
    el("div", {
      style: {
        fontSize: "11px",
        color: "#667085",
        marginBottom: "4px"
      }
    }, BINS[key].name),

    el("div", {
      style: {
        display: "flex",
        alignItems: "center",
        gap: "10px"
      }
    },
      el("div", {
        style: {
          flex: "1",
          height: "14px",
          backgroundColor: "#eef2f6",
          borderRadius: "4px",
          overflow: "hidden"
        }
      },
        el("div", {
          style: {
            width: `${pct}%`,
            height: "100%",
            backgroundColor: status.colour,
            borderRadius: "4px"
          }
        })
      ),
      el("strong", {
        title: status.text,
        style: {
          width: "38px",
          textAlign: "right",
          fontSize: "12px"
        }
      }, `${Math.round(pct)}%`)
    )
  );
})
);

m.bindPopup(popup);
  }
  // Zoom to fit the devices the first time (not every update, or the map would fight the user's panning).
  if (located.length && !mapFitted) {
    map.fitBounds(L.latLngBounds(located.map(d => [d.location.lat, d.location.lng])).pad(0.3), { maxZoom: 17 });
    mapFitted = true;
  }
}

/* =====================================================================================================
   H. SIMULATOR: pushes made-up messages through handleMessage(), exactly as if they came from MQTT.
   Handy for building the dashboard before anyone has a working tablet or bin.
   To test with real MQTT instead, publish these same JSON shapes from the tablet's "Publish test message" box.
   ===================================================================================================== */
let simTimer = null;
const SIM_DEVICES = [
  { id: "sim-bin-01", lat: -28.8034, lng: 153.2886, count: 0 },
  { id: "sim-bin-02", lat: -28.8042, lng: 153.2899, count: 0 },
  { id: "sim-bin-03", lat: -28.8027, lng: 153.2871, count: 0 }
];
// Items a simulated bin can "see", taken from bins.js (skipping labels mapped to "ignore").
const SIM_LABELS = Object.entries(DEFAULT_COCO_BINS).filter(([, bin]) => bin !== "ignore");

function simulateTick() {
  const sim = SIM_DEVICES[Math.floor(Math.random() * SIM_DEVICES.length)];
  const [label, bin] = SIM_LABELS[Math.floor(Math.random() * SIM_LABELS.length)];
  sim.count += 1;
  const location = { latitude: sim.lat, longitude: sim.lng, accuracy_m: 10 };
  handleMessage("sim/classification", JSON.stringify({
    schema_version: 2, message_type: "waste_classification", device_id: sim.id, sequence: sim.count,
    timestamp: new Date().toISOString(), source: "simulator", bin, classification: label,
    confidence: Number((0.6 + Math.random() * 0.4).toFixed(2)), location
  }));
  if (sim.count % 6 === 0) {       // now and then a "smart bin" reports a measured level too
    handleMessage("sim/binstatus", JSON.stringify({
      schema_version: 1, message_type: "bin_status", device_id: sim.id, timestamp: new Date().toISOString(),
      bins: Object.fromEntries(BIN_KEYS.map(k => [k, { level_pct: Math.min(100, Math.round(Math.random() * 60 + sim.count)) }])),
      battery_pct: Math.max(5, 100 - sim.count), location
    }));
  }
}

function toggleSimulator() {
  if (simTimer) { clearInterval(simTimer); simTimer = null; $("simButton").textContent = "Start simulator"; return; }
  simTimer = setInterval(simulateTick, 1200);
  $("simButton").textContent = "Stop simulator";
}

function resetData() {
  devices.clear(); events = []; seenKeys.clear(); messageCount = 0;
  SIM_DEVICES.forEach(s => { s.count = 0; });
  markers.forEach(m => m.remove()); markers.clear(); mapFitted = false;
  $("rawLog").replaceChildren();
  refreshDeviceSelect(); renderAll();
}

/* =====================================================================================================
   I. WIRING + START-UP
   ===================================================================================================== */
const INPUT_KEY = "prog6002-dashboard";
function saveInputs() {
  try { localStorage.setItem(INPUT_KEY, JSON.stringify({ brokerUrl: $("brokerUrl").value, topicFilter: $("topicFilter").value })); } catch {}
}

const FILL_HISTORY_KEY = "fleet-fill-history-v1";
const HISTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_HISTORY_POINTS = 3000;

let fillHistory = {};
let fillHistoryChart = null;

try {
  const saved = JSON.parse(localStorage.getItem(FILL_HISTORY_KEY));
  if (saved && typeof saved === "object" && !Array.isArray(saved)) {
    fillHistory = saved;
  }
} catch (error) {
  console.warn("Could not load fill history:", error);
}

function historyKey(deviceId, compartment) {
  return JSON.stringify([deviceId, compartment]);
}

function recordFillReading(deviceId, compartment, value) {
  if (!Number.isFinite(value) || value < 0 || value > 100) return;

  const key = historyKey(deviceId, compartment);
  const now = Date.now();

  // Arrival time avoids trusting an unsynchronised device clock.
  const previous = Array.isArray(fillHistory[key])
    ? fillHistory[key]
    : [];

  const points = previous.filter(point =>
    Number.isFinite(point.t) &&
    Number.isFinite(point.pct) &&
    point.t >= now - HISTORY_RETENTION_MS &&
    point.t <= now &&
    point.pct >= 0 &&
    point.pct <= 100
  );

  const last = points[points.length - 1];

  // Limit identical readings to one per minute.
  if (last && last.pct === value && now - last.t < 60000) return;

  points.push({ t: now, pct: value });
  fillHistory[key] = points.slice(-MAX_HISTORY_POINTS);

  // Remove old readings from other compartments too.
  for (const storedKey of Object.keys(fillHistory)) {
    const stored = fillHistory[storedKey];
    if (!Array.isArray(stored)) {
      delete fillHistory[storedKey];
      continue;
    }

    fillHistory[storedKey] = stored.filter(point =>
      Number.isFinite(point.t) &&
      point.t >= now - HISTORY_RETENTION_MS
    ).slice(-MAX_HISTORY_POINTS);

    if (!fillHistory[storedKey].length) delete fillHistory[storedKey];
  }

  try {
    localStorage.setItem(FILL_HISTORY_KEY, JSON.stringify(fillHistory));
  } catch (error) {
    console.warn("History remains in memory; browser storage failed:", error);
  }
}

function predictFill(points) {
  // Forecast using at most the last 24 hours.
  const recent = points.filter(point =>
    point.t >= Date.now() - 24 * 60 * 60 * 1000
  );

  // A drop of 20 percentage points suggests an emptying event.
  let cycleStart = 0;

  for (let i = 1; i < recent.length; i++) {
    if (recent[i - 1].pct - recent[i].pct >= 20) {
      cycleStart = i;
    }
  }

  const cycle = recent.slice(cycleStart);

  if (
    cycle.length < 3 ||
    cycle[cycle.length - 1].t - cycle[0].t < 10 * 60 * 1000
  ) {
    return null;
  }

  // Linear regression: percentage points gained per hour.
  const origin = cycle[0].t;
  const xs = cycle.map(point => (point.t - origin) / 3600000);
  const ys = cycle.map(point => point.pct);

  const meanX = xs.reduce((sum, x) => sum + x, 0) / xs.length;
  const meanY = ys.reduce((sum, y) => sum + y, 0) / ys.length;

  let numerator = 0;
  let denominator = 0;

  xs.forEach((x, i) => {
    numerator += (x - meanX) * (ys[i] - meanY);
    denominator += (x - meanX) ** 2;
  });

  if (!denominator) return null;

  return {
    rate: numerator / denominator,
    last: cycle[cycle.length - 1]
  };
}

function syncHistoryDeviceSelect() {
  const selector = $("historyDevice");
  if (!selector) return;

  selector.replaceChildren(
    el("option", { value: "" }, "Select a device"),
    ...[...devices.keys()].sort().map(id =>
      el("option", { value: id }, id)
    )
  );

  selector.value = $("deviceSelect").value;
}

function renderFillHistory() {
  syncHistoryDeviceSelect();
  const canvas = $("fillHistoryChart");
  const summary = $("predictionSummary");
  if (!canvas || !summary) return;

  if (typeof Chart === "undefined") {
    summary.textContent = "Chart.js failed to load. Check your connection.";
    return;
  }

  const deviceId = $("deviceSelect").value;
  const compartment = $("historyCompartment").value;
  const hours = Number($("historyRange").value) || 24;
  const now = Date.now();
  const start = now - hours * 3600000;

  const stored = fillHistory[historyKey(deviceId, compartment)];
  const points = (Array.isArray(stored) ? stored : []).filter(point =>
    Number.isFinite(point.t) &&
    Number.isFinite(point.pct) &&
    point.t >= now - HISTORY_RETENTION_MS &&
    point.t <= now
  ).sort((a, b) => a.t - b.t);

  const visible = points.filter(point => point.t >= start);
  const threshold = CONFIG.fullPct;
  const forecast = [];
  let end = now;

  summary.textContent = deviceId
    ? "Waiting for measured fill readings."
    : "Select an individual device to view its history.";

  if (deviceId && points.length) {
    const last = points[points.length - 1];
    const stale = now - last.t > CONFIG.offlineAfterMs;
    const prediction = predictFill(points);

    if (stale) {
      summary.textContent =
        "Fill reading is stale. Prediction paused until a new reading arrives.";
    } else if (last.pct >= threshold) {
      summary.textContent =
        `${deviceId} · ${BINS[compartment].name} · ` +
        `${Math.round(last.pct)}% · Collection required`;
    } else if (!prediction) {
      summary.textContent =
        "Insufficient data: at least 3 readings spanning 10 minutes are needed.";
    } else if (prediction.rate <= 0.1) {
      summary.textContent = "No meaningful rising trend detected.";
    } else {
      const hoursToThreshold =
        (threshold - last.pct) / prediction.rate;

      const horizon = Math.min(hoursToThreshold, 24);
      end = last.t + horizon * 3600000;

      forecast.push(
        { x: last.t, y: last.pct },
        {
          x: end,
          y: Math.min(100, last.pct + prediction.rate * horizon)
        }
      );

      summary.textContent =
        `${deviceId} · ${BINS[compartment].name} · ` +
        `Rising approximately ${prediction.rate.toFixed(1)} percentage points/hour. ` +
        (hoursToThreshold <= 24
          ? `Estimated ${threshold}% in ${hoursToThreshold.toFixed(1)} hours.`
          : `Not expected to reach ${threshold}% within 24 hours.`);
    }
  }

  const datasets = [
    {
      label: "Measured fill",
      data: visible.map(point => ({ x: point.t, y: point.pct })),
      borderColor: BINS[compartment]?.colour || "#2563eb",
      backgroundColor: BINS[compartment]?.colour || "#2563eb",
      pointRadius: 2,
      borderWidth: 2,
      tension: 0
    },
    {
      label: "Predicted fill",
      data: forecast,
      borderColor: "#667085",
      borderDash: [6, 5],
      pointRadius: 0,
      borderWidth: 2
    },
    {
      label: `${threshold}% collection threshold`,
      data: [
        { x: start, y: threshold },
        { x: Math.max(now, end), y: threshold }
      ],
      borderColor: "#d92d20",
      borderDash: [3, 3],
      pointRadius: 0,
      borderWidth: 1
    }
  ];

  if (!fillHistoryChart) {
    fillHistoryChart = new Chart(canvas, {
      type: "line",
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        parsing: false,
        scales: {
          x: {
            type: "linear",
            min: start,
            max: Math.max(now, end),
            title: { display: true, text: "Time" },
            ticks: {
              maxTicksLimit: 6,
              callback: value => new Date(Number(value))
                .toLocaleString([], {
                  day: "numeric",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit"
                })
            }
          },
          y: {
            min: 0,
            max: 100,
            title: { display: true, text: "Fill level (%)" }
          }
        },
        plugins: {
          tooltip: {
            callbacks: {
              title: items => items.length
                ? new Date(items[0].parsed.x).toLocaleString()
                : "",
              label: item =>
                `${item.dataset.label}: ${item.parsed.y.toFixed(1)}%`
            }
          }
        }
      }
    });
  } else {
    fillHistoryChart.data.datasets = datasets;
    fillHistoryChart.options.scales.x.min = start;
    fillHistoryChart.options.scales.x.max = Math.max(now, end);
    fillHistoryChart.update("none");
  }
}

const compartmentSelect = $("historyCompartment");

if (compartmentSelect) {
  compartmentSelect.replaceChildren(
    ...BIN_KEYS.map(key =>
      el("option", { value: key }, BINS[key].name)
    )
  );

  compartmentSelect.addEventListener("change", renderFillHistory);
}

$("historyRange")?.addEventListener("change", renderFillHistory);

function loadInputs() {
  $("brokerUrl").value = CONFIG.brokerUrl; $("topicFilter").value = CONFIG.topicFilter;
  try {
    const saved = JSON.parse(localStorage.getItem(INPUT_KEY) || "{}");
    if (saved.brokerUrl) $("brokerUrl").value = saved.brokerUrl;
    if (saved.topicFilter) $("topicFilter").value = saved.topicFilter;
  } catch {}
}

$("connectButton").addEventListener("click", connect);
$("simButton").addEventListener("click", toggleSimulator);
$("resetButton").addEventListener("click", resetData);
$("deviceSelect").addEventListener("change", renderAll);
$("historyDevice")?.addEventListener("change", event => {
  const id = event.target.value;

  if (id) {
    selectDevice(id);
  } else {
    $("deviceSelect").value = "";
    renderAll();
  }});

// Example depot near our demo bins.
// Replace these coordinates with your actual collection depot.
let ROUTE_DEPOT = null;

// Prototype assumptions—adjust to match your collection operation.
const ROUTE_AVERAGE_SPEED_KMH = 30;
const ROUTE_MINUTES_PER_STOP = 3;

let collectionRouteLayer = null;
let collectionRouteBounds = null;

function closeBinPopups() {
  if (!map) return;

  markers.forEach(marker => marker.closePopup());
  map.closePopup();
}

function renderCollectionRoute() {
  if (!ROUTE_DEPOT) return;

  const summary = $("routeSummary");
  const stops = $("routeStops");

  if (!summary || !stops) return;

  stops.replaceChildren();
  collectionRouteBounds = null;

  if (collectionRouteLayer) {
    collectionRouteLayer.remove();
    collectionRouteLayer = null;
  }

  if (!map || typeof L === "undefined") {
    summary.textContent = "Map unavailable.";
    return;
  }

  // Close bin-condition popups.
  markers.forEach(marker => marker.closePopup());
  map.closePopup();

  // Find devices with a compartment above the collection threshold.
  const eligible = [...devices.values()]
    .map(device => ({
      device,
      compartments: BIN_KEYS
        .map(key => ({ key, ...binLevel(device, key) }))
        .filter(bin => bin.pct > CONFIG.fullPct)
    }))
    .filter(stop => stop.compartments.length);

  const missingGPS = eligible.filter(
    stop => !stop.device.location
  );

  const remaining = eligible
    .filter(stop => stop.device.location)
    .sort((a, b) => a.device.id.localeCompare(b.device.id));

  if (!remaining.length) {
    summary.textContent = eligible.length
      ? "Collection needed, but eligible devices have no GPS location."
      : `No devices have a compartment above ${CONFIG.fullPct}%.`;
    return;
  }

  const depot = L.latLng(ROUTE_DEPOT.lat, ROUTE_DEPOT.lng);
  const routePoints = [depot];
  const ordered = [];

  let current = depot;
  let totalMetres = 0;

  // Visit the nearest remaining device next.
  while (remaining.length) {
    let nearestIndex = 0;
    let nearestMetres = Infinity;

    remaining.forEach((stop, index) => {
      const location = L.latLng(
        stop.device.location.lat,
        stop.device.location.lng
      );

      const distance = current.distanceTo(location);

      if (distance < nearestMetres) {
        nearestMetres = distance;
        nearestIndex = index;
      }
    });

    const stop = remaining.splice(nearestIndex, 1)[0];

    stop.legMetres = nearestMetres;
    ordered.push(stop);

    current = L.latLng(
      stop.device.location.lat,
      stop.device.location.lng
    );

    routePoints.push(current);
    totalMetres += nearestMetres;
  }

  // Include the return to the driver's starting location.
  totalMetres += current.distanceTo(depot);
  routePoints.push(depot);

  // Rough time estimate: 30 km/h and 3 minutes per pickup stop.
  const distanceKm = totalMetres / 1000;
  const drivingMinutes = Math.ceil(distanceKm / 30 * 60);
  const collectionMinutes = ordered.length * 3;
  const totalMinutes = drivingMinutes + collectionMinutes;

  summary.textContent =
    `${ordered.length} pickup stops · ` +
    `${distanceKm.toFixed(2)} km straight-line round trip · ` +
    `Approx. ${drivingMinutes} min travel + ` +
    `${collectionMinutes} min collection = ${totalMinutes} min total` +
    (missingGPS.length
      ? ` · Missing GPS: ${missingGPS.map(s => s.device.id).join(", ")}`
      : "");

  // Display the numbered pickup cards.
  ordered.forEach(stop => {
    const deviceButton = el("button", {
      type: "button",
      class: "route-stop-button"
    }, stop.device.id);

    deviceButton.addEventListener("click", () =>
      selectDevice(stop.device.id)
    );

    const compartmentText = stop.compartments.map(bin =>
      `${BINS[bin.key].name}: ${Math.round(bin.pct)}%` +
      (bin.source === "measured" ? "" : " (estimated)")
    ).join(" · ");

    const staleText = isOnline(stop.device)
      ? ""
      : " · Stale reading—verify before pickup";

    stops.appendChild(
      el("li", {},
        deviceButton,
        el("div", { class: "route-stop-detail" },
          compartmentText + staleText
        ),
        el("div", { class: "route-stop-detail" },
          `${(stop.legMetres / 1000).toFixed(2)} km from previous stop`
        )
      )
    );
  });

  // Draw the route and starting marker.
  collectionRouteLayer = L.layerGroup().addTo(map);

  L.polyline(routePoints, {
    color: "#2563eb",
    weight: 4,
    dashArray: "8 6"
  }).addTo(collectionRouteLayer);

  L.circleMarker(depot, {
    radius: 8,
    color: "#123047",
    fillColor: "white",
    fillOpacity: 1
  })
    .bindTooltip("Driver starting location")
    .addTo(collectionRouteLayer);

  // Number the pickup stops on the map.
  ordered.forEach((stop, index) => {
    const label = document.createElement("span");
    label.textContent = `${index + 1}. ${stop.device.id}`;

    L.circleMarker(
      [stop.device.location.lat, stop.device.location.lng],
      {
        radius: 15,
        color: "#2563eb",
        fillOpacity: 0
      }
    )
      .bindTooltip(label, {
        permanent: true,
        direction: "top"
      })
      .on("click", () => selectDevice(stop.device.id))
      .addTo(collectionRouteLayer);
  });

  collectionRouteBounds = L.latLngBounds(routePoints);
}

const locationDialog = $("routeLocationDialog");

$("calculateRoute").addEventListener("click", () => {
  $("driverLocationNote").textContent =
    "Enter coordinates or use this device's location.";

  locationDialog.showModal();
});

$("cancelRoute").addEventListener("click", () => {
  locationDialog.close();
});

$("useDriverGPS").addEventListener("click", () => {
  const note = $("driverLocationNote");
  const button = $("useDriverGPS");

  if (!navigator.geolocation) {
    note.textContent =
      "Location is unavailable. Enter coordinates manually.";
    return;
  }

  note.textContent = "Getting your location…";

  navigator.geolocation.getCurrentPosition(
    position => {
      $("driverLatitude").value =
        position.coords.latitude.toFixed(6);

      $("driverLongitude").value =
        position.coords.longitude.toFixed(6);

      note.textContent =
        `Location received. Accuracy: approximately ` +
        `${Math.round(position.coords.accuracy)} metres.`;
    },
    error => {
      note.textContent =
        `Could not get location: ${error.message}. ` +
        "Enter coordinates manually.";
    },
    {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 0
    }
  );
});

$("routeLocationForm").addEventListener("submit", event => {
  event.preventDefault();

  const lat = Number($("driverLatitude").value);
  const lng = Number($("driverLongitude").value);

  if (
    !Number.isFinite(lat) || Math.abs(lat) > 90 ||
    !Number.isFinite(lng) || Math.abs(lng) > 180
  ) {
    $("driverLocationNote").textContent =
      "Please enter valid latitude and longitude.";
    return;
  }

  ROUTE_DEPOT = { lat, lng };

  $("collectionRoutePanel").hidden = false;

  renderCollectionRoute();
  locationDialog.close();

  if (map && collectionRouteBounds) {
    map.fitBounds(collectionRouteBounds.pad(0.2), {
      maxZoom: 16
    });
  }
});

loadInputs();
initMap();
renderAll();
// Redraw every 10 s so "last seen", online/offline and the activity chart stay correct when no messages arrive.
setInterval(renderAll, 10000);

function seedDemoHistory() {
  const now = Date.now();

  const demoDevices = [
    {
      id: "bin01",
      lat: -28.1670,
      lng: 153.5360,
      levels: {
        green:  { start: 50, end: 80 },
        yellow: { start: 35, end: 59 },
        red:    { start: 40, end: 55 }
      }
    },
    {
      id: "bin02",
      lat: -28.1700,
      lng: 153.5400,
      levels: {
        green:  { start: 65, end: 91 },
        yellow: { start: 42, end: 66 },
        red:    { start: 20, end: 35 }
      }
    },
    {
      id: "bin03",
      lat: -28.1630,
      lng: 153.5320,
      levels: {
        green:  { start: 35, end: 35 },
        yellow: { start: 50, end: 82 },
        red:    { start: 20, end: 45 }
      }
    }
  ];

  for (const demo of demoDevices) {
    // Create/update the device, its current readings and map location.
    handleBinStatus({
      message_type: "bin_status",
      device_id: demo.id,
      timestamp: new Date(now).toISOString(),
      location: {
        latitude: demo.lat,
        longitude: demo.lng,
        accuracy_m: 18
      },
      bins: Object.fromEntries(
        Object.entries(demo.levels).map(([key, values]) => [
          key,
          { level_pct: values.end }
        ])
      )
    });

    // Seed 13 readings, ten minutes apart, covering two hours.
    for (const [compartment, values] of Object.entries(demo.levels)) {
      fillHistory[historyKey(demo.id, compartment)] =
        Array.from({ length: 13 }, (_, index) => ({
          t: now - (12 - index) * 10 * 60 * 1000,
          pct: Number((
            values.start +
            (values.end - values.start) * index / 12
          ).toFixed(1))
        }));
    }
  }

  try {
    localStorage.setItem(
      FILL_HISTORY_KEY,
      JSON.stringify(fillHistory)
    );
  } catch (error) {
    console.warn("Demo history could not be saved:", error);
  }
  console.log("Synthetic demo data loaded for bin01, bin02 and bin03.");
}

function seedRouteDemo() {
  // Load the original history test first.
  seedDemoHistory();

  const now = Date.now();

  const changes = [
    { id: "bin01", compartment: "green", start: 60, end: 93 },
    { id: "bin03", compartment: "yellow", start: 50, end: 96 }
  ];

  for (const change of changes) {
    handleBinStatus({
      message_type: "bin_status",
      device_id: change.id,
      bins: {
        [change.compartment]: { level_pct: change.end }
      }
    });

    fillHistory[historyKey(change.id, change.compartment)] =
      Array.from({ length: 13 }, (_, index) => ({
        t: now - (12 - index) * 10 * 60 * 1000,
        pct: Number((
          change.start +
          (change.end - change.start) * index / 12
        ).toFixed(1))
      }));
  }

  try {
    localStorage.setItem(
      FILL_HISTORY_KEY,
      JSON.stringify(fillHistory)
    );
  } catch (error) {
    console.warn("Could not save demo history:", error);
  }

  renderAll();
  console.log("Route demo loaded: bin01, bin02 and bin03 require collection.");
}

/* =====================================================================================================
   IDEAS FOR YOUR OWN DASHBOARD (pick some, invent more)
     - Save events to localStorage or IndexedDB so a page reload keeps the history.
     - Alerts: play a sound / show a banner when a bin passes CONFIG.fullPct.
     - A "Mark emptied" button that sets dev.bins[k].sinceEmptied = 0 and sensorLevel = 0.
     - Fill-level history chart per bin (store {t, level} in a list each time a bin_status arrives).
     - Collection route: order the full bins by distance from the depot and draw a Leaflet polyline.
     - Contamination view: highlight low-confidence items or bins with many "unsorted" items.
     - Publish commands BACK to a device (e.g. topic ".../command") using client.publish().
     - Replace the hand-made SVG chart with Chart.js, or the raw JSON log with a searchable table.
   ===================================================================================================== */
