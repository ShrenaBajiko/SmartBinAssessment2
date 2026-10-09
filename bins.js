"use strict";
// Which bin each item goes in, using Australian kerbside lid colours.
// Councils differ (for example, whether food scraps go in the green bin), so check your council's
// rules. The mapping can also be edited in the app under "Bin mapping"; edits are saved on the device.

const BINS = {
  red:    { name: "Red bin",         description: "General waste (landfill)",           colour: "#d92d20", text: "#ffffff" },
  yellow: { name: "Yellow bin",      description: "Recycling",                          colour: "#f5b700", text: "#1d1d1d" },
  green:  { name: "Green bin",       description: "Food & garden organics (FOGO)",      colour: "#12a150", text: "#ffffff" },
  ewaste: { name: "No kerbside bin", description: "E-waste: take to a drop-off point",  colour: "#667085", text: "#ffffff" }
};

// All 80 COCO-SSD object classes. "ignore" = never the item being shown
// (people/hands, animals, vehicles, furniture and large appliances in the background).
const DEFAULT_COCO_BINS = {
  // Recycling
  "bottle": "yellow", "book": "yellow",
  // Food & garden organics
  "banana": "green", "apple": "green", "orange": "green", "broccoli": "green", "carrot": "green",
  "sandwich": "green", "hot dog": "green", "pizza": "green", "donut": "green", "cake": "green",
  // General waste. Drinking glasses, ceramics, coffee cups (plastic-lined) and cutlery are not kerbside-recyclable.
  "cup": "red", "wine glass": "red", "bowl": "red", "fork": "red", "knife": "red", "spoon": "red",
  "vase": "red", "scissors": "red", "toothbrush": "red", "teddy bear": "red",
  "backpack": "red", "umbrella": "red", "handbag": "red", "tie": "red", "suitcase": "red",
  "frisbee": "red", "skis": "red", "snowboard": "red", "sports ball": "red", "kite": "red",
  "baseball bat": "red", "baseball glove": "red", "skateboard": "red", "surfboard": "red", "tennis racket": "red",
  // Electronics: not allowed in any kerbside bin
  "laptop": "ewaste", "cell phone": "ewaste", "keyboard": "ewaste", "mouse": "ewaste", "remote": "ewaste",
  "microwave": "ewaste", "toaster": "ewaste", "hair drier": "ewaste", "clock": "ewaste",
  // Never the item being shown
  "person": "ignore", "bicycle": "ignore", "car": "ignore", "motorcycle": "ignore", "airplane": "ignore",
  "bus": "ignore", "train": "ignore", "truck": "ignore", "boat": "ignore", "traffic light": "ignore",
  "fire hydrant": "ignore", "stop sign": "ignore", "parking meter": "ignore", "bench": "ignore",
  "bird": "ignore", "cat": "ignore", "dog": "ignore", "horse": "ignore", "sheep": "ignore", "cow": "ignore",
  "elephant": "ignore", "bear": "ignore", "zebra": "ignore", "giraffe": "ignore",
  "chair": "ignore", "couch": "ignore", "potted plant": "ignore", "bed": "ignore", "dining table": "ignore",
  "toilet": "ignore", "tv": "ignore", "oven": "ignore", "sink": "ignore", "refrigerator": "ignore"
};

// Labels from material classifiers (bundled models) and common Teachable Machine class names.
const LABEL_BINS = {
  plastic: "yellow", glass: "yellow", metal: "yellow", paper: "yellow", cardboard: "yellow",
  biological: "green", trash: "red", clothes: "red", shoes: "red", battery: "ewaste",
  recycling: "yellow", recycle: "yellow", recycled: "yellow", recyclable: "yellow", yellow: "yellow",
  landfill: "red", general: "red", rubbish: "red", red: "red",
  organic: "green", organics: "green", food: "green", garden: "green", compost: "green", fogo: "green", green: "green",
  "e-waste": "ewaste", ewaste: "ewaste", electronics: "ewaste",
  // Classes meaning "nothing to sort" (e.g. a Teachable Machine background class) -> show "No item"
  unknown: "ignore", background: "ignore", nothing: "ignore", empty: "ignore", none: "ignore", "no item": "ignore"
};
