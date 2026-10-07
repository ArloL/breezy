import * as R from "./rules.js";
import { Model } from "./model.js";
import { View } from "./view.js";
import { sampleBoard, stressBoard } from "./sample.js";

const params = new URLSearchParams(location.search);
const state = { selection: new Set(), turned: null, editing: null, renaming: null, held: new Set(), lifted: new Set(), marquee: null, found: null };
const model = new Model(params.has("stress") ? stressBoard() : sampleBoard());
const view = new View(document.getElementById("board"), model, state);
R.gravity(model.board, view.heightOf);
view.setCamera({ x: 16, y: document.getElementById("top").getBoundingClientRect().bottom + 16, zoom: 0.75 });
if (params.get("demo") === "turn") state.turned = "c-offsite";
if (params.get("demo") === "select") state.selection = new Set(["c-offsite"]);
view.render();
