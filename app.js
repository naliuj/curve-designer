import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const viewport = document.getElementById("viewport");
const statusEl = document.getElementById("status");

// ---------- Scene setup ----------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1b1d22);

const camera = new THREE.PerspectiveCamera(60, viewport.clientWidth / viewport.clientHeight, 0.1, 1000);
camera.position.set(20, 18, 20);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(viewport.clientWidth, viewport.clientHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
viewport.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);
controls.update();

scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(15, 25, 10);
scene.add(dirLight);

// ---------- Dynamically-sized ground grid ----------
// Each side tracks its own boundary so the grid only grows toward whichever
// direction a block is approaching, instead of expanding uniformly.
const GRID_EDGE_MARGIN = 5;
const GRID_GROW_STEP = 5;
const GRID_DEFAULT_HALF = 50;
let gridMinX = -GRID_DEFAULT_HALF;
let gridMaxX = GRID_DEFAULT_HALF;
let gridMinZ = -GRID_DEFAULT_HALF;
let gridMaxZ = GRID_DEFAULT_HALF;

const gridLineMaterial = new THREE.LineBasicMaterial({ color: 0x3a3f4a });

function buildGridLineGeometry(minX, maxX, minZ, maxZ) {
  const positions = [];
  for (let x = minX; x <= maxX; x++) {
    positions.push(x + 0.5, -0.5, minZ + 0.5, x + 0.5, -0.5, maxZ + 0.5);
  }
  for (let z = minZ; z <= maxZ; z++) {
    positions.push(minX + 0.5, -0.5, z + 0.5, maxX + 0.5, -0.5, z + 0.5);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  return geometry;
}

let gridLines = new THREE.LineSegments(
  buildGridLineGeometry(gridMinX, gridMaxX, gridMinZ, gridMaxZ),
  gridLineMaterial
);
scene.add(gridLines);

function rebuildGridLines() {
  scene.remove(gridLines);
  gridLines.geometry.dispose();
  const visible = gridLines.visible;
  gridLines = new THREE.LineSegments(
    buildGridLineGeometry(gridMinX, gridMaxX, gridMinZ, gridMaxZ),
    gridLineMaterial
  );
  gridLines.visible = visible;
  scene.add(gridLines);
}

const gridToggle = document.getElementById("gridToggle");
gridToggle.addEventListener("change", () => {
  gridLines.visible = gridToggle.checked;
});

const axesHelper = new THREE.AxesHelper(3);
axesHelper.position.set(0.5, -0.5, 0.5);
scene.add(axesHelper);

window.addEventListener("resize", () => {
  camera.aspect = viewport.clientWidth / viewport.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(viewport.clientWidth, viewport.clientHeight);
});

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();

// ---------- Voxel block management ----------
const cubeGeometry = new THREE.BoxGeometry(1, 1, 1);
const blocks = new Map(); // "x,y,z" -> mesh

function key(x, y, z) {
  return `${x},${y},${z}`;
}

function addBlock(x, y, z, color) {
  const k = key(x, y, z);
  if (blocks.has(k)) return;
  ensureGridCovers(x, z);
  const material = new THREE.MeshStandardMaterial({ color });
  const mesh = new THREE.Mesh(cubeGeometry, material);
  mesh.position.set(x, y, z);
  mesh.userData.gridPos = [x, y, z];
  mesh.visible = isLayerVisible(y);
  scene.add(mesh);
  blocks.set(k, mesh);
}

function removeBlock(x, y, z) {
  const k = key(x, y, z);
  const mesh = blocks.get(k);
  if (!mesh) return;
  scene.remove(mesh);
  mesh.material.dispose();
  blocks.delete(k);
  shrinkGridIfPossible();
}

function clearAllBlocks() {
  for (const mesh of blocks.values()) {
    scene.remove(mesh);
    mesh.material.dispose();
  }
  blocks.clear();
  shrinkGridIfPossible();
}

const NEIGHBOR_OFFSETS = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

// Removes any block whose all 6 neighbors are also occupied blocks, leaving
// only the blocks with at least one face exposed to empty space.
function hollowOut() {
  const toRemove = [];
  for (const [k, mesh] of blocks) {
    const [x, y, z] = mesh.userData.gridPos;
    const exposed = NEIGHBOR_OFFSETS.some(
      ([dx, dy, dz]) => !blocks.has(key(x + dx, y + dy, z + dz))
    );
    if (!exposed) toRemove.push(k);
  }
  for (const k of toRemove) {
    const mesh = blocks.get(k);
    scene.remove(mesh);
    mesh.material.dispose();
    blocks.delete(k);
  }
  if (toRemove.length > 0) shrinkGridIfPossible();
  return toRemove.length;
}

function applyHollowIfEnabled() {
  if (!document.getElementById("hollowToggle").checked) return 0;
  return hollowOut();
}

// ---------- Raycasting for manual edit ----------
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
function buildGroundPlaneMesh() {
  const margin = 200;
  const width = gridMaxX - gridMinX + margin;
  const depth = gridMaxZ - gridMinZ + margin;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, depth),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set((gridMinX + gridMaxX) / 2 + 0.5, 0, (gridMinZ + gridMaxZ) / 2 + 0.5);
  return mesh;
}

let groundPlaneMesh = buildGroundPlaneMesh();
scene.add(groundPlaneMesh);

function rebuildGroundPlaneMesh() {
  scene.remove(groundPlaneMesh);
  groundPlaneMesh.geometry.dispose();
  groundPlaneMesh.material.dispose();
  groundPlaneMesh = buildGroundPlaneMesh();
  scene.add(groundPlaneMesh);
}

// Grows the visible grid (and its raycasting plane) by GRID_GROW_STEP whenever
// a block lands within GRID_EDGE_MARGIN of the current edge — only on the
// side(s) actually being approached, not uniformly in every direction.
function ensureGridCovers(x, z) {
  let grew = false;
  while (x >= gridMaxX - GRID_EDGE_MARGIN) {
    gridMaxX += GRID_GROW_STEP;
    grew = true;
  }
  while (x <= gridMinX + GRID_EDGE_MARGIN) {
    gridMinX -= GRID_GROW_STEP;
    grew = true;
  }
  while (z >= gridMaxZ - GRID_EDGE_MARGIN) {
    gridMaxZ += GRID_GROW_STEP;
    grew = true;
  }
  while (z <= gridMinZ + GRID_EDGE_MARGIN) {
    gridMinZ -= GRID_GROW_STEP;
    grew = true;
  }
  if (grew) {
    rebuildGridLines();
    rebuildGroundPlaneMesh();
  }
}

// Shrinks each side of the grid back down by GRID_GROW_STEP whenever no
// remaining block needs that much room, but never below the default extent.
function shrinkGridIfPossible() {
  let maxXNeeded = -Infinity;
  let minXNeeded = Infinity;
  let maxZNeeded = -Infinity;
  let minZNeeded = Infinity;
  for (const mesh of blocks.values()) {
    const [x, , z] = mesh.userData.gridPos;
    if (x > maxXNeeded) maxXNeeded = x;
    if (x < minXNeeded) minXNeeded = x;
    if (z > maxZNeeded) maxZNeeded = z;
    if (z < minZNeeded) minZNeeded = z;
  }

  let shrank = false;
  while (
    gridMaxX - GRID_GROW_STEP >= GRID_DEFAULT_HALF &&
    gridMaxX - GRID_GROW_STEP - GRID_EDGE_MARGIN > maxXNeeded
  ) {
    gridMaxX -= GRID_GROW_STEP;
    shrank = true;
  }
  while (
    gridMinX + GRID_GROW_STEP <= -GRID_DEFAULT_HALF &&
    gridMinX + GRID_GROW_STEP + GRID_EDGE_MARGIN < minXNeeded
  ) {
    gridMinX += GRID_GROW_STEP;
    shrank = true;
  }
  while (
    gridMaxZ - GRID_GROW_STEP >= GRID_DEFAULT_HALF &&
    gridMaxZ - GRID_GROW_STEP - GRID_EDGE_MARGIN > maxZNeeded
  ) {
    gridMaxZ -= GRID_GROW_STEP;
    shrank = true;
  }
  while (
    gridMinZ + GRID_GROW_STEP <= -GRID_DEFAULT_HALF &&
    gridMinZ + GRID_GROW_STEP + GRID_EDGE_MARGIN < minZNeeded
  ) {
    gridMinZ += GRID_GROW_STEP;
    shrank = true;
  }

  if (shrank) {
    rebuildGridLines();
    rebuildGroundPlaneMesh();
  }
}

function getPointer(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
}

function currentColor() {
  return document.getElementById("blockColor").value;
}

// Returns the grid cell that a left-click placement would target, or null if nothing is hit.
function getPlacementTarget() {
  raycaster.setFromCamera(pointer, camera);
  const blockMeshes = Array.from(blocks.values());
  const hits = raycaster.intersectObjects([...blockMeshes, groundPlaneMesh], false);
  if (hits.length === 0) return null;

  const hit = hits[0];
  if (hit.object === groundPlaneMesh) {
    return [Math.round(hit.point.x), 0, Math.round(hit.point.z)];
  }
  const [bx, by, bz] = hit.object.userData.gridPos;
  const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).round();
  return [bx + normal.x, by + normal.y, bz + normal.z];
}

// ---------- Hover preview ----------
const previewMaterial = new THREE.MeshBasicMaterial({
  color: 0xffffff,
  transparent: true,
  opacity: 0.35,
  depthWrite: false,
});
const previewMesh = new THREE.Mesh(cubeGeometry, previewMaterial);
previewMesh.visible = false;
scene.add(previewMesh);

function updatePreview(event) {
  getPointer(event);
  const target = getPlacementTarget();
  if (!target || blocks.has(key(...target))) {
    previewMesh.visible = false;
    return;
  }
  previewMaterial.color.set(currentColor());
  previewMesh.position.set(target[0], target[1], target[2]);
  previewMesh.visible = true;
}

renderer.domElement.addEventListener("pointermove", updatePreview);
renderer.domElement.addEventListener("pointerleave", () => {
  previewMesh.visible = false;
});

renderer.domElement.addEventListener("contextmenu", (e) => e.preventDefault());

const DRAG_THRESHOLD_PX = 5;
let downPos = null;

renderer.domElement.addEventListener("pointerdown", (event) => {
  downPos = { x: event.clientX, y: event.clientY, button: event.button };
});

renderer.domElement.addEventListener("pointerup", (event) => {
  if (!downPos || downPos.button !== event.button) {
    downPos = null;
    return;
  }
  const dx = event.clientX - downPos.x;
  const dy = event.clientY - downPos.y;
  downPos = null;
  if (Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) return; // treat as a drag/orbit, not a click

  getPointer(event);

  if (event.button === 2) {
    raycaster.setFromCamera(pointer, camera);
    const blockMeshes = Array.from(blocks.values());
    const hits = raycaster.intersectObjects(blockMeshes, false);
    if (hits.length === 0) return;
    const [x, y, z] = hits[0].object.userData.gridPos;
    removeBlock(x, y, z);
    updatePreview(event);
    return;
  }

  if (event.button === 0) {
    const target = getPlacementTarget();
    if (!target) return;
    addBlock(target[0], target[1], target[2], currentColor());
    updatePreview(event);
  }
});

// ---------- Curve generation ----------
const tRangeRow = document.getElementById("tRangeRow");
const tabPanels = Array.from(document.querySelectorAll(".tab-panel"));
const curveTypeSelect = document.getElementById("curveType");
let activeCurveType = curveTypeSelect.value;

function setActiveCurveType(type) {
  activeCurveType = type;
  for (const panel of tabPanels) {
    panel.classList.toggle("hidden", panel.dataset.panel !== type);
  }
  tRangeRow.classList.toggle("hidden", type === "corner-round" || type === "fading-corner");

  if (type === "corner-edge") {
    document.getElementById("tStart").value = "0";
    document.getElementById("tEnd").value = (Math.PI / 2).toFixed(4);
    document.getElementById("steps").value = "16";
  }
}

curveTypeSelect.addEventListener("change", () => setActiveCurveType(curveTypeSelect.value));
setActiveCurveType(curveTypeSelect.value);

function evalExpr(expr) {
  return new Function(
    "t",
    `const {sin,cos,tan,sqrt,abs,pow,PI,floor,ceil,min,max,exp,log,random} = Math; return (${expr});`
  );
}

function buildCurveFns(type) {
  const radius = parseFloat(document.getElementById("pRadius").value) || 5;
  const heightScale = parseFloat(document.getElementById("pHeight").value) || 0.5;
  const amplitude = parseFloat(document.getElementById("pAmp").value) || 5;
  const frequency = parseFloat(document.getElementById("pFreq").value) || 0.5;

  switch (type) {
    case "helix":
      return {
        fx: (t) => radius * Math.cos(t),
        fy: (t) => t * heightScale,
        fz: (t) => radius * Math.sin(t),
      };
    case "helix-horizontal": {
      const hRadius = parseFloat(document.getElementById("hRadius").value) || 5;
      const hLength = parseFloat(document.getElementById("hLength").value) || 0.5;
      return {
        fx: (t) => t * hLength,
        fy: (t) => hRadius * Math.cos(t),
        fz: (t) => hRadius * Math.sin(t),
      };
    }
    case "sine":
      return {
        fx: (t) => t,
        fy: (t) => amplitude * Math.sin(t * frequency),
        fz: (t) => 0,
      };
    case "line":
      return {
        fx: (t) => t,
        fy: (t) => 0,
        fz: (t) => 0,
      };
    case "custom": {
      const fx = evalExpr(document.getElementById("fx").value);
      const fy = evalExpr(document.getElementById("fy").value);
      const fz = evalExpr(document.getElementById("fz").value);
      return { fx, fy, fz };
    }
    case "corner-edge": {
      const r = parseFloat(document.getElementById("edgeRadius").value) || 3;
      const plane = document.getElementById("edgePlane").value;
      const cx = parseFloat(document.getElementById("edgeCenterX").value) || 0;
      const cy = parseFloat(document.getElementById("edgeCenterY").value) || 0;
      const cz = parseFloat(document.getElementById("edgeCenterZ").value) || 0;
      // Sweeps a quarter-circle arc in the chosen plane, offset from the corner
      // point (cx,cy,cz) by radius r along the plane's two axes.
      if (plane === "xy") {
        return {
          fx: (t) => cx + r - r * Math.cos(t),
          fy: (t) => cy + r - r * Math.sin(t),
          fz: (t) => cz,
        };
      }
      if (plane === "yz") {
        return {
          fx: (t) => cx,
          fy: (t) => cy + r - r * Math.cos(t),
          fz: (t) => cz + r - r * Math.sin(t),
        };
      }
      return {
        fx: (t) => cx + r - r * Math.cos(t),
        fy: (t) => cy,
        fz: (t) => cz + r - r * Math.sin(t),
      };
    }
    default:
      throw new Error("Unknown curve type");
  }
}

function voxelLine(x0, y0, z0, x1, y1, z1) {
  const points = [];
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dz = z1 - z0;
  const steps = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
  if (steps === 0) {
    points.push([x0, y0, z0]);
    return points;
  }
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    points.push([
      Math.round(x0 + dx * t),
      Math.round(y0 + dy * t),
      Math.round(z0 + dz * t),
    ]);
  }
  return points;
}

function generateCornerRound() {
  const r = parseFloat(document.getElementById("cornerRadius").value) || 3;
  const cx = parseFloat(document.getElementById("cornerCenterX").value) || 0;
  const cy = parseFloat(document.getElementById("cornerCenterY").value) || 0;
  const cz = parseFloat(document.getElementById("cornerCenterZ").value) || 0;
  const sx = parseFloat(document.getElementById("cornerSignX").value);
  const sy = parseFloat(document.getElementById("cornerSignY").value);
  const sz = parseFloat(document.getElementById("cornerSignZ").value);
  const requestedSteps = Math.max(2, parseInt(document.getElementById("steps").value, 10));
  // Adjacent samples must land within ~1 voxel of each other or the diagonal
  // stitching below can't close the gap between them. Arc length per step is
  // roughly r * angleStep, so scale resolution with radius to guarantee that.
  const minStepsForRadius = Math.ceil(r * (Math.PI / 2) * 1.2);
  const steps = Math.max(requestedSteps, minStepsForRadius, 2);
  const color = currentColor();

  // Spherical octant patch: theta sweeps azimuth, phi sweeps from pole to equator.
  const pointAt = (theta, phi) => [
    Math.round(cx + sx * r * Math.cos(theta) * Math.sin(phi)),
    Math.round(cy + sy * r * Math.cos(phi)),
    Math.round(cz + sz * r * Math.sin(theta) * Math.sin(phi)),
  ];

  let placed = 0;
  const place = (x, y, z) => {
    const k = key(x, y, z);
    if (!blocks.has(k)) {
      addBlock(x, y, z, color);
      placed++;
    }
  };

  const grid = [];
  for (let i = 0; i <= steps; i++) {
    const theta = (Math.PI / 2) * (i / steps);
    grid.push([]);
    for (let j = 0; j <= steps; j++) {
      const phi = (Math.PI / 2) * (j / steps);
      grid[i].push(pointAt(theta, phi));
    }
  }

  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      const [x, y, z] = grid[i][j];
      place(x, y, z);
      if (j > 0) {
        for (const [px, py, pz] of voxelLine(...grid[i][j - 1], x, y, z)) place(px, py, pz);
      }
      if (i > 0) {
        for (const [px, py, pz] of voxelLine(...grid[i - 1][j], x, y, z)) place(px, py, pz);
      }
      if (i > 0 && j > 0) {
        // Fill both diagonals of the quad too, or a diamond-shaped gap can be
        // left uncovered in the middle when the surface curves between samples.
        for (const [px, py, pz] of voxelLine(...grid[i - 1][j - 1], x, y, z)) place(px, py, pz);
        for (const [px, py, pz] of voxelLine(...grid[i - 1][j], ...grid[i][j - 1])) place(px, py, pz);
      }
    }
  }

  const removed = applyHollowIfEnabled();
  setStatus(
    removed > 0
      ? `Generated ${placed} blocks (hollowed: removed ${removed} interior).`
      : `Generated ${placed} blocks.`
  );
}

// Stamps a solid sphere of the given radius around (cx,cy,cz). Radius 0 just
// places the single centerline voxel, preserving the old thin-curve behavior.
function stampThick(cx, cy, cz, radius, color) {
  if (radius <= 0) {
    addBlock(cx, cy, cz, color);
    return;
  }
  const rCeil = Math.ceil(radius);
  const r2 = radius * radius;
  for (let dx = -rCeil; dx <= rCeil; dx++) {
    for (let dy = -rCeil; dy <= rCeil; dy++) {
      for (let dz = -rCeil; dz <= rCeil; dz++) {
        if (dx * dx + dy * dy + dz * dz <= r2) {
          addBlock(cx + dx, cy + dy, cz + dz, color);
        }
      }
    }
  }
}

function getCurveThickness(type) {
  if (type === "helix") return parseFloat(document.getElementById("helixThickness").value) || 0;
  if (type === "helix-horizontal") return parseFloat(document.getElementById("hThickness").value) || 0;
  if (type === "line") return parseFloat(document.getElementById("lineRadius").value) || 0;
  if (type === "sine") return parseFloat(document.getElementById("sineThickness").value) || 0;
  return 0;
}

const FADE_EASINGS = {
  linear: (t) => t,
  "ease-in": (t) => t * t,
  "ease-out": (t) => t * (2 - t),
};

// A 3D corner bracket: 3 straight rods from one corner point, each fattened
// near the tip (distance 0) and tapering back to plain rod thickness once
// past the fade distance, per the chosen easing curve.
function generateFadingCorner() {
  const length = Math.max(0, parseFloat(document.getElementById("fcLength").value) || 0);
  const rodThickness = Math.max(0, parseFloat(document.getElementById("fcThickness").value) || 0);
  const tipBulge = Math.max(0, parseFloat(document.getElementById("fcBulge").value) || 0);
  const fadeDistance = Math.max(0.0001, parseFloat(document.getElementById("fcFade").value) || 0.0001);
  const ease = FADE_EASINGS[document.getElementById("fcEasing").value] || FADE_EASINGS.linear;
  const cx = parseFloat(document.getElementById("fcCenterX").value) || 0;
  const cy = parseFloat(document.getElementById("fcCenterY").value) || 0;
  const cz = parseFloat(document.getElementById("fcCenterZ").value) || 0;
  const sx = parseFloat(document.getElementById("fcSignX").value);
  const sy = parseFloat(document.getElementById("fcSignY").value);
  const sz = parseFloat(document.getElementById("fcSignZ").value);
  const steps = Math.max(2, parseInt(document.getElementById("steps").value, 10));
  const color = currentColor();

  const sizeBefore = blocks.size;
  const axes = [
    [sx, 0, 0],
    [0, sy, 0],
    [0, 0, sz],
  ];

  for (const [ax, ay, az] of axes) {
    let lastPoint = null;
    for (let i = 0; i <= steps; i++) {
      const d = (length * i) / steps;
      const x = Math.round(cx + ax * d);
      const y = Math.round(cy + ay * d);
      const z = Math.round(cz + az * d);

      const t = Math.min(1, d / fadeDistance);
      const localThickness = rodThickness + tipBulge * (1 - ease(t));

      const segment = lastPoint
        ? voxelLine(lastPoint[0], lastPoint[1], lastPoint[2], x, y, z)
        : [[x, y, z]];
      for (const [px, py, pz] of segment) {
        stampThick(px, py, pz, localThickness, color);
      }
      lastPoint = [x, y, z];
    }
  }

  const placedNet = blocks.size - sizeBefore;
  const removed = applyHollowIfEnabled();
  setStatus(
    removed > 0
      ? `Generated ${placedNet} blocks (hollowed: removed ${removed} interior).`
      : `Generated ${placedNet} blocks.`
  );
}

function generateCurve() {
  const type = activeCurveType;
  if (type === "corner-round") {
    generateCornerRound();
    return;
  }
  if (type === "fading-corner") {
    generateFadingCorner();
    return;
  }

  const tStart = parseFloat(document.getElementById("tStart").value);
  const tEnd = parseFloat(document.getElementById("tEnd").value);
  const steps = Math.max(2, parseInt(document.getElementById("steps").value, 10));
  const color = currentColor();
  const thickness = getCurveThickness(type);

  let fns;
  try {
    fns = buildCurveFns(type);
  } catch (err) {
    setStatus(`Error: ${err.message}`, true);
    return;
  }

  let lastPoint = null;
  const sizeBefore = blocks.size;
  try {
    for (let i = 0; i <= steps; i++) {
      const t = tStart + ((tEnd - tStart) * i) / steps;
      const x = Math.round(fns.fx(t));
      const y = Math.round(fns.fy(t));
      const z = Math.round(fns.fz(t));

      const segment = lastPoint
        ? voxelLine(lastPoint[0], lastPoint[1], lastPoint[2], x, y, z)
        : [[x, y, z]];

      for (const [px, py, pz] of segment) {
        stampThick(px, py, pz, thickness, color);
      }
      lastPoint = [x, y, z];
    }
  } catch (err) {
    setStatus(`Error evaluating curve: ${err.message}`, true);
    return;
  }
  const placedNet = blocks.size - sizeBefore;
  const removed = applyHollowIfEnabled();
  setStatus(
    removed > 0
      ? `Generated ${placedNet} blocks (hollowed: removed ${removed} interior).`
      : `Generated ${placedNet} blocks.`
  );
}

document.getElementById("generateBtn").addEventListener("click", generateCurve);
document.getElementById("clearBtn").addEventListener("click", () => {
  clearAllBlocks();
  setStatus("Cleared.");
});

// ---------- Status helper ----------
function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.style.color = isError ? "#e06c5c" : "#7fd97f";
}

// ---------- Save / Load (localStorage) ----------
const STORAGE_KEY = "curveDesigner.designs";
const designNameInput = document.getElementById("designName");
const loadSelect = document.getElementById("loadSelect");

function loadAllDesigns() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function saveAllDesigns(designs) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(designs));
}

function refreshLoadOptions() {
  const designs = loadAllDesigns();
  loadSelect.innerHTML = '<option value="">-- saved designs --</option>';
  for (const name of Object.keys(designs)) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    loadSelect.appendChild(opt);
  }
}

document.getElementById("saveBtn").addEventListener("click", () => {
  const name = designNameInput.value.trim();
  if (!name) {
    setStatus("Enter a design name to save.", true);
    return;
  }
  const designs = loadAllDesigns();
  designs[name] = Array.from(blocks.values()).map((mesh) => [
    ...mesh.userData.gridPos,
    `#${mesh.material.color.getHexString()}`,
  ]);
  saveAllDesigns(designs);
  refreshLoadOptions();
  loadSelect.value = name;
  setStatus(`Saved "${name}" (${designs[name].length} blocks).`);
});

document.getElementById("loadBtn").addEventListener("click", () => {
  const name = loadSelect.value;
  if (!name) {
    setStatus("Select a saved design first.", true);
    return;
  }
  const designs = loadAllDesigns();
  const data = designs[name];
  if (!data) return;
  clearAllBlocks();
  for (const [x, y, z, color] of data) {
    addBlock(x, y, z, color);
  }
  designNameInput.value = name;
  setStatus(`Loaded "${name}" (${data.length} blocks).`);
});

document.getElementById("deleteBtn").addEventListener("click", () => {
  const name = loadSelect.value;
  if (!name) {
    setStatus("Select a saved design to delete.", true);
    return;
  }
  const designs = loadAllDesigns();
  delete designs[name];
  saveAllDesigns(designs);
  refreshLoadOptions();
  setStatus(`Deleted "${name}".`);
});

refreshLoadOptions();

// ---------- Minecraft NBT export ----------
const NBT_TAG = {
  END: 0,
  BYTE: 1,
  SHORT: 2,
  INT: 3,
  LONG: 4,
  FLOAT: 5,
  DOUBLE: 6,
  BYTE_ARRAY: 7,
  STRING: 8,
  LIST: 9,
  COMPOUND: 10,
  INT_ARRAY: 11,
  LONG_ARRAY: 12,
};

class NbtWriter {
  constructor() {
    this.chunks = [];
  }
  writeByte(value) {
    this.chunks.push(new Uint8Array([value & 0xff]));
  }
  writeShort(value) {
    const buf = new Uint8Array(2);
    new DataView(buf.buffer).setInt16(0, value, false);
    this.chunks.push(buf);
  }
  writeInt(value) {
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setInt32(0, value, false);
    this.chunks.push(buf);
  }
  writeString(str) {
    const utf8 = new TextEncoder().encode(str);
    this.writeShort(utf8.length);
    this.chunks.push(utf8);
  }
  writeTagHeader(type, name) {
    this.writeByte(type);
    this.writeString(name);
  }
  toUint8Array() {
    const total = this.chunks.reduce((sum, c) => sum + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

// The 16 standard Minecraft wool colors, used as the closest match for any block color.
const MINECRAFT_WOOL_COLORS = [
  ["white", "#f9fffe"],
  ["orange", "#f9801d"],
  ["magenta", "#c74ebd"],
  ["light_blue", "#3ab3da"],
  ["yellow", "#fed83d"],
  ["lime", "#80c71f"],
  ["pink", "#f38baa"],
  ["gray", "#474f52"],
  ["light_gray", "#9d9d97"],
  ["cyan", "#169c9c"],
  ["purple", "#8932b8"],
  ["blue", "#3c44aa"],
  ["brown", "#835432"],
  ["green", "#5e7c16"],
  ["red", "#b02e26"],
  ["black", "#1d1d21"],
];

function hexToRgb(hex) {
  const clean = hex.replace("#", "");
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

function nearestWoolBlockName(hex) {
  const [r, g, b] = hexToRgb(hex);
  let bestName = "white";
  let bestDist = Infinity;
  for (const [name, woolHex] of MINECRAFT_WOOL_COLORS) {
    const [wr, wg, wb] = hexToRgb(woolHex);
    const dist = (r - wr) ** 2 + (g - wg) ** 2 + (b - wb) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      bestName = name;
    }
  }
  return `minecraft:${bestName}_wool`;
}

function buildStructureNbt() {
  const entries = Array.from(blocks.values()).map((mesh) => ({
    pos: mesh.userData.gridPos,
    blockName: nearestWoolBlockName(`#${mesh.material.color.getHexString()}`),
  }));

  const minX = Math.min(...entries.map((e) => e.pos[0]));
  const minY = Math.min(...entries.map((e) => e.pos[1]));
  const minZ = Math.min(...entries.map((e) => e.pos[2]));
  const maxX = Math.max(...entries.map((e) => e.pos[0]));
  const maxY = Math.max(...entries.map((e) => e.pos[1]));
  const maxZ = Math.max(...entries.map((e) => e.pos[2]));

  const paletteIndex = new Map();
  const paletteNames = [];
  for (const entry of entries) {
    if (!paletteIndex.has(entry.blockName)) {
      paletteIndex.set(entry.blockName, paletteNames.length);
      paletteNames.push(entry.blockName);
    }
  }

  const w = new NbtWriter();
  w.writeTagHeader(NBT_TAG.COMPOUND, "");

  w.writeTagHeader(NBT_TAG.INT, "DataVersion");
  w.writeInt(3465); // Minecraft 1.20.1

  w.writeTagHeader(NBT_TAG.LIST, "size");
  w.writeByte(NBT_TAG.INT);
  w.writeInt(3);
  w.writeInt(maxX - minX + 1);
  w.writeInt(maxY - minY + 1);
  w.writeInt(maxZ - minZ + 1);

  w.writeTagHeader(NBT_TAG.LIST, "entities");
  w.writeByte(NBT_TAG.END);
  w.writeInt(0);

  w.writeTagHeader(NBT_TAG.LIST, "blocks");
  w.writeByte(NBT_TAG.COMPOUND);
  w.writeInt(entries.length);
  for (const entry of entries) {
    w.writeTagHeader(NBT_TAG.INT, "state");
    w.writeInt(paletteIndex.get(entry.blockName));

    w.writeTagHeader(NBT_TAG.LIST, "pos");
    w.writeByte(NBT_TAG.INT);
    w.writeInt(3);
    w.writeInt(entry.pos[0] - minX);
    w.writeInt(entry.pos[1] - minY);
    w.writeInt(entry.pos[2] - minZ);

    w.writeByte(NBT_TAG.END); // close this block compound
  }

  w.writeTagHeader(NBT_TAG.LIST, "palette");
  w.writeByte(NBT_TAG.COMPOUND);
  w.writeInt(paletteNames.length);
  for (const name of paletteNames) {
    w.writeTagHeader(NBT_TAG.STRING, "Name");
    w.writeString(name);
    w.writeByte(NBT_TAG.END); // close this palette compound
  }

  w.writeByte(NBT_TAG.END); // close root compound

  return w.toUint8Array();
}

async function gzipBytes(bytes) {
  if (!("CompressionStream" in window)) {
    throw new Error("This browser doesn't support gzip compression (try Chrome, Edge, Firefox, or Safari).");
  }
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const buffer = await new Response(cs.readable).arrayBuffer();
  return new Uint8Array(buffer);
}

document.getElementById("exportNbtBtn").addEventListener("click", async () => {
  if (blocks.size === 0) {
    setStatus("No blocks to export.", true);
    return;
  }
  try {
    const raw = buildStructureNbt();
    const gzipped = await gzipBytes(raw);
    const blob = new Blob([gzipped], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const name = designNameInput.value.trim() || "design";
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name}.nbt`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus(`Exported ${blocks.size} blocks as ${name}.nbt.`);
  } catch (err) {
    setStatus(`Export failed: ${err.message}`, true);
  }
});

// ---------- Layer preview ----------
const layerYInput = document.getElementById("layerY");
const layerModeSelect = document.getElementById("layerMode");

function isLayerVisible(y) {
  const mode = layerModeSelect.value;
  if (mode === "full") return true;
  const layerY = parseInt(layerYInput.value, 10) || 0;
  if (mode === "above") return y >= layerY;
  if (mode === "below") return y <= layerY;
  return true;
}

function applyLayerPreview() {
  for (const mesh of blocks.values()) {
    mesh.visible = isLayerVisible(mesh.userData.gridPos[1]);
  }
}

layerYInput.addEventListener("input", applyLayerPreview);
layerModeSelect.addEventListener("change", applyLayerPreview);

// ---------- Help modal ----------
const helpModal = document.getElementById("helpModal");

function openHelp() {
  helpModal.classList.remove("hidden");
}

function closeHelp() {
  helpModal.classList.add("hidden");
}

document.getElementById("helpBtn").addEventListener("click", openHelp);
document.getElementById("helpCloseBtn").addEventListener("click", closeHelp);
document.getElementById("helpModalBackdrop").addEventListener("click", closeHelp);
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeHelp();
});

const helpTabButtons = Array.from(document.querySelectorAll("#helpCurveTabs .help-tab-btn"));
const helpPanels = Array.from(document.querySelectorAll(".help-panel"));
for (const btn of helpTabButtons) {
  btn.addEventListener("click", () => {
    for (const b of helpTabButtons) b.classList.toggle("active", b === btn);
    for (const panel of helpPanels) {
      panel.classList.toggle("hidden", panel.dataset.helpPanel !== btn.dataset.help);
    }
  });
}
