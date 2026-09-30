/* global document, navigator, localStorage, URL, Blob, fetch, requestAnimationFrame, cancelAnimationFrame, setTimeout, clearTimeout, performance, confirm */

import {
  CAMERA_MIN_ZOOM,
  TOOLS,
  allObjects,
  blankLevel,
  cloneLevel,
  createPlaytestPlayer,
  createObject,
  exportJson,
  exportTypescript,
  importTypescriptLevel,
  findObject,
  fitCameraToBounds,
  mirrorObjectAcrossStage,
  nextTrackpadCamera,
  pushableSupportY,
  removeObject,
  resolvePushableX,
  resizeRectangle,
  snapJumpOrigin,
  stepPlaytestPlayer,
  traceJumpReach,
  updateObject,
  validateLevel,
} from './model.mjs';

const $ = (selector) => document.querySelector(selector);
const svg = $('#canvas');
const camera = $('#camera');
const world = $('#world');
const SAVED_WORKSPACE_KEY = 'ember-tide-level-forge-workspace-v1';
let levels = [];
let level;
let liveLevels = [];
let tool = 'select';
let selection = [];
let elementClipboard = [];
let pasteCount = 0;
let zoom = 1;
let pan = { x: 24, y: 40 };
let drag = null;
let history = [];
let issueFilter = 'all';
let simulationMode = 'edit';
let playtestPlayer = null;
let playtestMechanics = null;
let reachTraces = [];
let reachOrigin = null;
let reachArmed = false;
let simulationFrame = null;
let simulationLastTime = 0;
let simulationAccumulator = 0;
let jumpQueued = false;
let autosaveTimer = null;
let catalogSyncTimer = null;
const pressedKeys = new Set();
const colors = { ember: '#f0643c', tide: '#1f9fc4', neutral: '#7f8987', none: '#25132b' };

function snapshot() {
  history.push(JSON.stringify(level));
  if (history.length > 60) history.shift();
}
function undo() {
  if (!history.length) return;
  level = JSON.parse(history.pop());
  clearSelection();
  render();
}
function snap(value) {
  const grid = Number($('#grid-size').value) || 0.5;
  return Number((Math.round(value / grid) * grid).toFixed(6));
}
function viewHeight() {
  return 19;
}
function applyCamera() {
  const scale = (svg.clientHeight / viewHeight()) * zoom;
  camera.setAttribute(
    'transform',
    `translate(${pan.x} ${svg.clientHeight + pan.y}) scale(${scale} ${-scale})`,
  );
  $('#zoom-label').textContent = `${Math.round(zoom * 100)}%`;
}
function point(event) {
  const rect = svg.getBoundingClientRect();
  const scale = (svg.clientHeight / viewHeight()) * zoom;
  return {
    x: (event.clientX - rect.left - pan.x) / scale,
    y: (svg.clientHeight + pan.y - (event.clientY - rect.top)) / scale,
  };
}
function safe(text) {
  return String(text).replace(
    /[&<>"']/g,
    (value) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[value],
  );
}
function objectRef(object) {
  return { kind: object.kind, id: object.id, role: object.role };
}
function refKey(ref) {
  return ref ? `${ref.kind}:${ref.id}` : '';
}
function isSelected(ref) {
  const key = refKey(ref);
  return selection.some((item) => refKey(item) === key);
}
function setSelection(refs) {
  selection = refs.filter(Boolean);
}
function selectOnly(ref) {
  setSelection(ref ? [ref] : []);
}
function clearSelection() {
  setSelection([]);
}
function toggleSelection(ref) {
  if (isSelected(ref)) setSelection(selection.filter((item) => refKey(item) !== refKey(ref)));
  else setSelection([...selection, ref]);
}
function selectedEntries() {
  return selection
    .map((ref) => ({ ref, object: findObject(level, ref) }))
    .filter((entry) => entry.object);
}
function objectSize(ref, object) {
  if (ref.kind === 'crystal') return { width: 1, height: 1.1 };
  if (ref.kind === 'spawn') return { width: level.playerWidth, height: level.playerWidth };
  if (ref.kind === 'gate') return { width: object.width, height: 4.5 };
  if (ref.kind === 'platform') return { width: object.width, height: 0.36 };
  if (ref.kind === 'ramp') return { width: object.width, height: object.height };
  if (ref.kind === 'hazard') return { width: object.width, height: 0.65 };
  if (ref.kind === 'lever') return { width: object.width, height: 3.6 };
  if (ref.kind === 'pressurePlate') return { width: object.width, height: 0.45 };
  if (ref.kind === 'activatedPlatform') return { width: object.width, height: 0.36 };
  return { width: object.width ?? 0, height: object.height ?? 0 };
}
function resizeBounds(ref, object) {
  const size = objectSize(ref, object);
  let x = object.x;
  let y = object.y ?? 0;
  if (ref.kind === 'crystal') {
    x -= size.width / 2;
    y -= size.height / 2;
  } else if (['platform', 'activatedPlatform'].includes(ref.kind)) y -= size.height / 2;
  else if (ref.kind === 'hazard') y = -size.height;
  return { x, y, width: size.width, height: size.height };
}
function resizeCapabilities(ref) {
  return {
    horizontal: [
      'solid',
      'platform',
      'ramp',
      'hazard',
      'gate',
      'lever',
      'pressurePlate',
      'pushable',
      'activatedPlatform',
      'environmentZone',
      'entrance',
    ].includes(ref.kind),
    vertical: ['solid', 'ramp', 'pushable', 'environmentZone', 'entrance'].includes(ref.kind),
  };
}
function selectionOutlines() {
  return selectedEntries()
    .map(({ ref, object }) => {
      const bounds = resizeBounds(ref, object);
      const padding = 0.1;
      return `<rect class="selection-outline" x="${bounds.x - padding}" y="${bounds.y - padding}" width="${bounds.width + padding * 2}" height="${bounds.height + padding * 2}" rx=".1"/>`;
    })
    .join('');
}
function resizeOverlay() {
  if (tool !== 'resize' || selection.length !== 1) return '';
  const [{ ref, object } = {}] = selectedEntries();
  if (!object) return '';
  const capabilities = resizeCapabilities(ref);
  if (!capabilities.horizontal && !capabilities.vertical) return '';
  const bounds = resizeBounds(ref, object);
  const left = bounds.x;
  const right = bounds.x + bounds.width;
  const bottom = bounds.y;
  const top = bounds.y + bounds.height;
  const middleX = (left + right) / 2;
  const middleY = (bottom + top) / 2;
  const handles = [];
  if (capabilities.horizontal) handles.push(['w', left, middleY], ['e', right, middleY]);
  if (capabilities.vertical) handles.push(['s', middleX, bottom], ['n', middleX, top]);
  if (capabilities.horizontal && capabilities.vertical)
    handles.push(
      ['sw', left, bottom],
      ['se', right, bottom],
      ['nw', left, top],
      ['ne', right, top],
    );
  return `<g class="resize-overlay"><rect class="resize-outline" x="${left}" y="${bottom}" width="${bounds.width}" height="${bounds.height}"/>${handles
    .map(
      ([handle, x, y]) =>
        `<rect class="resize-handle handle-${handle}" data-resize-handle="${handle}" x="${x - 0.22}" y="${y - 0.22}" width=".44" height=".44" rx=".08"/>`,
    )
    .join('')}</g>`;
}
function centerPosition(ref, object) {
  const size = objectSize(ref, object);
  const worldCenterX = ref.kind === 'crystal' ? object.x : object.x + size.width / 2;
  let centerY = object.y ?? 0;
  if (
    [
      'solid',
      'ramp',
      'gate',
      'spawn',
      'lever',
      'pressurePlate',
      'pushable',
      'environmentZone',
      'entrance',
    ].includes(ref.kind)
  )
    centerY += size.height / 2;
  if (ref.kind === 'hazard') centerY = -size.height / 2;
  return { x: worldCenterX - level.width / 2, y: centerY };
}
function centeredPositionPatch(ref, object, key, value) {
  const size = objectSize(ref, object);
  if (key === 'x') {
    const worldCenter = value + level.width / 2;
    return {
      x: ref.kind === 'crystal' ? worldCenter : worldCenter - size.width / 2,
    };
  }
  if (key === 'y') {
    if (ref.kind === 'hazard') return {};
    return {
      y: [
        'solid',
        'ramp',
        'gate',
        'spawn',
        'lever',
        'pressurePlate',
        'pushable',
        'environmentZone',
        'entrance',
      ].includes(ref.kind)
        ? value - size.height / 2
        : value,
    };
  }
  return { [key]: value };
}
function playRole() {
  return $('#play-role').value === 'tide' ? 'tide' : 'ember';
}

function renderSimulation() {
  const reach = $('#reach-layer');
  const simulation = $('#simulation-layer');
  const role = playRole();
  reach.innerHTML = reachTraces
    .map((trace) => {
      const points = trace.points.map((item) => `${item.x},${item.y + 0.08}`).join(' ');
      return `<polyline class="jump-trace ${role}${trace.died ? ' lethal' : ''}" points="${points}"/><circle class="landing-dot ${role}" cx="${trace.landing.x}" cy="${trace.landing.y + 0.08}" r=".18"/>`;
    })
    .join('');
  if (reachOrigin)
    reach.insertAdjacentHTML(
      'afterbegin',
      `<circle class="reach-origin${reachOrigin.snappedEdge ? ' snapped' : ''}" cx="${reachOrigin.snappedEdge ? reachOrigin.edgeX : reachOrigin.x + level.playerWidth / 2}" cy="${reachOrigin.y}" r=".3"/>`,
    );
  reach.querySelector('.reach-origin')?.addEventListener('pointerdown', startReachDrag);

  if (simulationMode !== 'playtest' || !playtestPlayer) {
    simulation.innerHTML = '';
    return;
  }
  const color = role === 'ember' ? colors.ember : colors.tide;
  const mechanics = level.mechanics;
  const activatedPlatformActive =
    mechanics &&
    playtestMechanics &&
    (mechanics.lever.target === 'activatedPlatform' ||
      mechanics.pressurePlate.target === 'activatedPlatform') &&
    (mechanics.lever.target !== 'activatedPlatform' || playtestMechanics.leverActivated) &&
    (mechanics.pressurePlate.target !== 'activatedPlatform' ||
      playtestMechanics.pressurePlatePressed);
  const mechanismMarkup =
    mechanics && playtestMechanics
      ? `<rect class="pushable" x="${playtestMechanics.pushableX}" y="${pushableSupportY(level, playtestMechanics.pushableX)}" width="${mechanics.pushable.width}" height="${mechanics.pushable.height}" rx=".12"/>${activatedPlatformActive ? `<rect class="platform ${mechanics.activatedPlatform.element} active-platform-preview" x="${mechanics.activatedPlatform.x}" y="${mechanics.activatedPlatform.y - 0.18}" width="${mechanics.activatedPlatform.width}" height=".36" rx=".18"/>` : ''}`
      : '';
  simulation.innerHTML = `${mechanismMarkup}<g class="demo-player"><rect x="${playtestPlayer.x}" y="${playtestPlayer.y}" width="${level.playerWidth}" height="${level.playerWidth}" rx=".48" fill="${color}"/><circle cx="${playtestPlayer.x + level.playerWidth * 0.34}" cy="${playtestPlayer.y + level.playerWidth * 0.62}" r=".1"/><circle cx="${playtestPlayer.x + level.playerWidth * 0.66}" cy="${playtestPlayer.y + level.playerWidth * 0.62}" r=".1"/></g>`;
}

function setSimulationHint(message) {
  const hint = $('#simulation-hint');
  hint.hidden = !message;
  hint.textContent = message;
}

function playtestHint() {
  return `PLAYTEST · A/D or ←/→ move · W, ↑, or Space jumps${level.mechanics ? ' · E toggles lever · hold Shift to simulate partner ramp-push' : ''} · click to reposition`;
}

function resetPlaytest() {
  playtestPlayer = createPlaytestPlayer(level, playRole());
  playtestMechanics = level.mechanics
    ? {
        leverActivated: false,
        pressurePlatePressed: false,
        pushableX: level.mechanics.pushable.x,
      }
    : null;
  jumpQueued = false;
  reachOrigin = null;
  reachTraces = [];
  renderSimulation();
}

function stopPlaytest() {
  simulationMode = 'edit';
  pressedKeys.clear();
  jumpQueued = false;
  if (simulationFrame !== null) cancelAnimationFrame(simulationFrame);
  simulationFrame = null;
  $('#playtest').textContent = 'Playtest';
  $('#playtest').classList.remove('active');
  $('#reset-playtest').hidden = true;
  $('#jump-reach').hidden = false;
  setSimulationHint('');
  renderWorld();
  renderSimulation();
}

function playtestFrame(now) {
  if (simulationMode !== 'playtest' || !playtestPlayer) return;
  if (simulationLastTime === 0) simulationLastTime = now;
  simulationAccumulator += Math.min((now - simulationLastTime) / 1000, 0.05);
  simulationLastTime = now;
  while (simulationAccumulator >= 1 / 60) {
    const moveX =
      pressedKeys.has('arrowleft') || pressedKeys.has('a')
        ? -1
        : pressedKeys.has('arrowright') || pressedKeys.has('d')
          ? 1
          : 0;
    if (level.mechanics && playtestMechanics && playtestPlayer.grounded && moveX !== 0) {
      const pushable = level.mechanics.pushable;
      const activatedPlatformActive =
        (level.mechanics.lever.target === 'activatedPlatform' ||
          level.mechanics.pressurePlate.target === 'activatedPlatform') &&
        (level.mechanics.lever.target !== 'activatedPlatform' ||
          playtestMechanics.leverActivated) &&
        (level.mechanics.pressurePlate.target !== 'activatedPlatform' ||
          playtestMechanics.pressurePlatePressed);
      const pushableY = pushableSupportY(level, playtestMechanics.pushableX);
      const overlapsVertically =
        playtestPlayer.y < pushableY + pushable.height &&
        playtestPlayer.y + level.playerWidth > pushableY;
      const touchingLeft =
        moveX === 1 &&
        playtestPlayer.x + level.playerWidth >= playtestMechanics.pushableX - 0.3 &&
        playtestPlayer.x < playtestMechanics.pushableX;
      const touchingRight =
        moveX === -1 &&
        playtestPlayer.x <= playtestMechanics.pushableX + pushable.width + 0.3 &&
        playtestPlayer.x > playtestMechanics.pushableX;
      if (overlapsVertically && (touchingLeft || touchingRight))
        playtestMechanics.pushableX = resolvePushableX(
          level,
          playtestMechanics.pushableX,
          playtestMechanics.pushableX + moveX * pushable.pushSpeed * (1 / 60),
          pressedKeys.has('shift'),
          activatedPlatformActive,
        );
    }
    const result = stepPlaytestPlayer(
      level,
      playtestPlayer,
      { moveX, jump: jumpQueued },
      playRole(),
      1 / 60,
      playtestMechanics,
    );
    if (level.mechanics && playtestMechanics) {
      const plate = level.mechanics.pressurePlate;
      const center = playtestPlayer.x + level.playerWidth / 2;
      const playerPressed =
        Math.abs(playtestPlayer.y - plate.y) <= 0.25 &&
        center >= plate.x &&
        center <= plate.x + plate.width;
      const pushable = level.mechanics.pushable;
      const pushableY = pushableSupportY(level, playtestMechanics.pushableX);
      const blockPressed =
        Math.abs(pushableY - plate.y) <= 0.25 &&
        playtestMechanics.pushableX + pushable.width > plate.x &&
        playtestMechanics.pushableX < plate.x + plate.width;
      playtestMechanics.pressurePlatePressed = playerPressed || blockPressed;
    }
    jumpQueued = false;
    simulationAccumulator -= 1 / 60;
    if (result.died) toast(`Respawned · ${result.hazardId}`);
  }
  renderSimulation();
  simulationFrame = requestAnimationFrame(playtestFrame);
}

function startPlaytest() {
  simulationMode = 'playtest';
  reachArmed = false;
  clearSelection();
  tool = 'select';
  resetPlaytest();
  $('#playtest').textContent = 'Stop';
  $('#playtest').classList.add('active');
  $('#reset-playtest').hidden = false;
  $('#jump-reach').hidden = true;
  setSimulationHint(playtestHint());
  simulationLastTime = performance.now();
  simulationAccumulator = 0;
  simulationFrame = requestAnimationFrame(playtestFrame);
  renderWorld();
  renderTools();
}

function updateReachOrigin(position, bypassSnap = false) {
  const origin = snapJumpOrigin(level, position, playRole(), bypassSnap ? -1 : 1.25);
  reachOrigin = {
    ...origin,
    x: origin.snappedEdge ? origin.x : snap(origin.x),
    y: origin.snappedEdge ? origin.y : snap(origin.y),
  };
  reachTraces = traceJumpReach(level, reachOrigin, playRole());
  renderSimulation();
}

function placeReachOrigin(event) {
  reachArmed = false;
  updateReachOrigin(point(event), event.shiftKey);
  $('#jump-reach').classList.remove('active');
  setSimulationHint(
    simulationMode === 'playtest'
      ? playtestHint()
      : reachOrigin.snappedEdge
        ? 'JUMP REACH · snapped to platform edge · drag marker to retest'
        : reachOrigin.snappedSurface
          ? 'JUMP REACH · projected to nearest surface below · drag marker to retest'
          : 'JUMP REACH · free-space origin · drag marker to retest',
  );
}

function startReachDrag(event) {
  event.preventDefault();
  event.stopPropagation();
  drag = { type: 'reach' };
  svg.setPointerCapture(event.pointerId);
}

function renderWorld() {
  const objects = allObjects(level).sort(
    (first, second) =>
      Number(second.kind === 'environmentZone') - Number(first.kind === 'environmentZone'),
  );
  const body = [];
  body.push(
    `<rect class="ground" x="0" y="-1" width="${level.width}" height="1"/><rect class="world-boundary" x="0" y="0" width="${level.width}" height="17.2"/><line class="center-axis" x1="${level.width / 2}" y1="-1" x2="${level.width / 2}" y2="17.2"/>`,
  );
  for (const object of objects) {
    const active = isSelected(objectRef(object)) ? ' selected' : '';
    const role = object.element ?? object.safeRole ?? object.role ?? 'neutral';
    if (object.kind === 'solid')
      body.push(
        `<g class="object${active}" data-kind="solid" data-id="${object.id}"><rect class="solid" x="${object.x}" y="${object.y}" width="${object.width}" height="${object.height}" rx=".14"/></g>`,
      );
    if (object.kind === 'platform')
      body.push(
        `<g class="object${active}" data-kind="platform" data-id="${object.id}"><rect class="platform ${role}" x="${object.x}" y="${object.y - 0.18}" width="${object.width}" height=".36" rx=".18"/></g>`,
      );
    if (object.kind === 'ramp') {
      const points =
        object.direction === 'up-right'
          ? `${object.x},${object.y} ${object.x + object.width},${object.y} ${object.x + object.width},${object.y + object.height}`
          : `${object.x},${object.y} ${object.x + object.width},${object.y} ${object.x},${object.y + object.height}`;
      body.push(
        `<g class="object${active}" data-kind="ramp" data-id="${object.id}"><polygon class="ramp ${role}" points="${points}"/><polyline class="ramp-edge" points="${points}"/></g>`,
      );
    }
    if (object.kind === 'hazard')
      body.push(
        `<g class="object${active}" data-kind="hazard" data-id="${object.id}"><path class="hazard ${role}" d="M${object.x},0 Q${object.x + object.width * 0.25},-.42 ${object.x + object.width * 0.5},0 Q${object.x + object.width * 0.75},-.42 ${object.x + object.width},0 L${object.x + object.width},-.65 L${object.x},-.65Z"/></g>`,
      );
    if (object.kind === 'crystal')
      body.push(
        `<g class="object${active}" data-kind="crystal" data-id="${object.id}"><path class="crystal ${role}" d="M${object.x},${object.y + 0.55} l.5,-.55 l-.5,-.55 l-.5,.55Z"/></g>`,
      );
    if (object.kind === 'gate')
      body.push(
        `<g class="object${active}" data-kind="gate" data-id="${object.id}" data-role="${role}"><path class="gate-frame ${role}" d="M${object.x},${object.y} v3.3 q0 1.2 1.2 1.2 h${object.width - 2.4} q1.2 0 1.2 -1.2 v-3.3"/></g>`,
      );
    if (object.kind === 'spawn')
      body.push(
        `<g class="object${active}" data-kind="spawn" data-id="${object.id}" data-role="${role}"><circle class="spawn ${role}" cx="${object.x + level.playerWidth / 2}" cy="${object.y + level.playerWidth / 2}" r="${level.playerWidth / 2}"/></g>`,
      );
    if (object.kind === 'activatedPlatform' && simulationMode !== 'playtest')
      body.push(
        `<g class="object${active}" data-kind="activatedPlatform" data-id="${object.id}"><rect class="platform ${role} activated-platform" x="${object.x}" y="${object.y - 0.18}" width="${object.width}" height=".36" rx=".18"/></g>`,
      );
    if (object.kind === 'pushable' && simulationMode !== 'playtest')
      body.push(
        `<g class="object${active}" data-kind="pushable" data-id="${object.id}"><rect class="pushable" x="${object.x}" y="${object.y}" width="${object.width}" height="${object.height}" rx=".12"/><path class="pushable-mark" d="M${object.x + 0.35},${object.y + 0.35} L${object.x + object.width - 0.35},${object.y + object.height - 0.35} M${object.x + object.width - 0.35},${object.y + 0.35} L${object.x + 0.35},${object.y + object.height - 0.35}"/></g>`,
      );
    if (object.kind === 'pressurePlate')
      body.push(
        `<g class="object${active}" data-kind="pressurePlate" data-id="${object.id}"><rect class="pressure-plate" x="${object.x}" y="${object.y}" width="${object.width}" height=".45" rx=".16"/><circle class="mechanic-light" cx="${object.x + object.width / 2}" cy="${object.y + 0.24}" r=".09"/></g>`,
      );
    if (object.kind === 'lever')
      body.push(
        `<g class="object${active}" data-kind="lever" data-id="${object.id}"><rect class="lever-base" x="${object.x}" y="${object.y}" width="${object.width}" height="1" rx=".2"/><line class="lever-arm" x1="${object.x + object.width / 2}" y1="${object.y + 0.72}" x2="${object.x + object.width * 0.72}" y2="${object.y + 2.8}"/><circle class="lever-knob" cx="${object.x + object.width * 0.72}" cy="${object.y + 2.8}" r=".28"/></g>`,
      );
    if (object.kind === 'environmentZone')
      body.push(
        `<g class="object environment-zone-object${active}" data-kind="environmentZone" data-id="${object.id}"><rect class="environment-zone ${object.environment}" x="${object.x}" y="${object.y}" width="${object.width}" height="${object.height}" rx=".18"/></g>`,
      );
    if (object.kind === 'entrance')
      body.push(
        `<g class="object${active}" data-kind="entrance" data-id="${object.id}"><path class="environment-entrance ${object.from}-${object.to}" d="M${object.x},${object.y} v${object.height - 1.1} q0 1.1 1.1 1.1 h${Math.max(0, object.width - 2.2)} q1.1 0 1.1 -1.1 v-${object.height - 1.1}"/><path class="entrance-arrow" d="M${object.x + object.width / 2 - 0.55},${object.y + object.height / 2 + 0.35} l.55,-.7 l.55,.7"/></g>`,
      );
  }
  body.push(selectionOutlines(), resizeOverlay());
  world.innerHTML = body.join('');
  for (const node of world.querySelectorAll('.object'))
    node.addEventListener('pointerdown', startObjectDrag);
  for (const handle of world.querySelectorAll('[data-resize-handle]'))
    handle.addEventListener('pointerdown', startResize);
}

function renderTools() {
  const icons = {
    select: '↖',
    platform: '━',
    ramp: '◢',
    solid: '▰',
    hazard: '≈',
    crystal: '◆',
    gate: '∩',
    spawn: '●',
    lever: '⌁',
    pressurePlate: '▂',
    pushable: '□',
    activatedPlatform: '┄',
    environmentZone: '▧',
    entrance: '⌂',
    resize: '↔',
  };
  $('#tools').innerHTML = TOOLS.map(
    (name, index) =>
      `<button class="tool ${tool === name ? 'active' : ''}" data-tool="${name}"><b>${icons[name]}</b>${index < 9 ? `${index + 1}. ` : ''}${name.replace(/([A-Z])/g, ' $1').replace(/^./, (letter) => letter.toUpperCase())}</button>`,
  ).join('');
  for (const button of document.querySelectorAll('.tool'))
    button.onclick = () => {
      tool = button.dataset.tool;
      render();
    };
}
function renderLayers() {
  $('#layers').innerHTML = allObjects(level)
    .map(
      (object) =>
        `<button class="layer ${isSelected(objectRef(object)) ? 'active' : ''}" data-kind="${object.kind}" data-id="${object.id}" data-role="${object.role ?? ''}"><i style="background:${colors[object.element ?? object.safeRole ?? object.role ?? 'neutral']}"></i><span>${safe(object.id)}</span></button>`,
    )
    .join('');
  for (const button of document.querySelectorAll('.layer'))
    button.onclick = (event) => {
      const ref = {
        kind: button.dataset.kind,
        id: button.dataset.id,
        role: button.dataset.role || undefined,
      };
      if (event.shiftKey || event.metaKey || event.ctrlKey) toggleSelection(ref);
      else selectOnly(ref);
      render();
    };
}
function commonValue(values) {
  return values.every((value) => value === values[0]) ? values[0] : null;
}
function numericField(label, key, value, step = 0.1) {
  const displayValue = typeof value === 'number' ? Number(value.toFixed(6)) : '';
  return `<label>${label}<input data-key="${key}" type="number" step="${step}" value="${displayValue}" placeholder="Mixed"></label>`;
}
function renderInspector() {
  const entries = selectedEntries();
  $('#selection-kind').textContent = entries.length
    ? entries.length === 1
      ? entries[0].ref.kind
      : `${entries.length} objects`
    : 'Level';
  if (!entries.length) {
    $('#inspector').innerHTML =
      '<p class="empty">Select an object, or Shift-click to select several. Coordinates use each object’s center; X 0 is the middle of the stage.</p>';
    return;
  }
  const [{ object }] = entries;
  const positions = entries.map((entry) => centerPosition(entry.ref, entry.object));
  const fields = [];
  if (entries.length === 1 && object.id)
    fields.push(`<label class="span-2">ID<input data-key="id" value="${safe(object.id)}"></label>`);
  fields.push(numericField('Center X', 'centerX', commonValue(positions.map((item) => item.x))));
  if (!entries.every((entry) => entry.ref.kind === 'hazard'))
    fields.push(numericField('Center Y', 'centerY', commonValue(positions.map((item) => item.y))));
  if (entries.every((entry) => entry.object.width !== undefined))
    fields.push(
      numericField('Width', 'width', commonValue(entries.map((entry) => entry.object.width))),
    );
  if (entries.every((entry) => entry.object.height !== undefined))
    fields.push(
      numericField('Height', 'height', commonValue(entries.map((entry) => entry.object.height))),
    );
  if (entries.every((entry) => entry.object.element !== undefined))
    fields.push(
      `<label class="span-2">Element<select data-key="element"><option value="" disabled>Mixed</option><option value="neutral">Neutral</option><option value="ember">Ember</option><option value="tide">Tide</option></select></label>`,
    );
  if (entries.length === 1 && entries[0].ref.kind === 'ramp')
    fields.push(
      `<label class="span-2">Rises toward<select data-key="direction"><option value="up-right">Right</option><option value="up-left">Left</option></select></label>`,
    );
  if (entries.length === 1 && ['lever', 'pressurePlate'].includes(entries[0].ref.kind))
    fields.push(
      `<label class="span-2">Controls<select data-key="target"><option value="activatedPlatform">Activated platform</option><option value="gates">Level gates</option></select></label>`,
    );
  if (entries.length === 1 && entries[0].ref.kind === 'environmentZone')
    fields.push(
      `<label class="span-2">Environment<select data-key="environment"><option value="outside">Outside</option><option value="underground">Underground</option></select></label>`,
    );
  if (entries.length === 1 && entries[0].ref.kind === 'entrance')
    fields.push(
      `<label>From<select data-key="from"><option value="outside">Outside</option><option value="underground">Underground</option></select></label><label>To<select data-key="to"><option value="underground">Underground</option><option value="outside">Outside</option></select></label>`,
    );
  for (const [label, key] of [
    ['Interaction reach', 'reach'],
    ['Push speed', 'pushSpeed'],
  ])
    if (entries.length === 1 && entries[0].object[key] !== undefined)
      fields.push(numericField(label, key, entries[0].object[key]));
  if (entries.every((entry) => entry.object.safeRole !== undefined))
    fields.push(
      `<label class="span-2">Safe role<select data-key="safeRole"><option value="" disabled>Mixed</option><option value="none">Kills both</option><option value="ember">Ember</option><option value="tide">Tide</option></select></label>`,
    );
  if (entries.every((entry) => entry.ref.kind === 'crystal'))
    fields.push(
      `<label class="span-2">Role<select data-key="role"><option value="" disabled>Mixed</option><option value="ember">Ember</option><option value="tide">Tide</option></select></label>`,
    );
  $('#inspector').innerHTML =
    `<p class="coordinate-note">Center coordinates · stage midpoint is X 0</p><div class="field-grid">${fields.join('')}</div>`;
  for (const input of $('#inspector').querySelectorAll('input,select')) {
    if (input.tagName === 'SELECT')
      input.value = commonValue(entries.map((entry) => entry.object[input.dataset.key])) ?? '';
    input.onchange = () => {
      snapshot();
      const value = input.type === 'number' ? Number(input.value) : input.value;
      if (!Number.isFinite(value) && input.type === 'number') return;
      for (const entry of entries) {
        const center = centerPosition(entry.ref, entry.object);
        let patch;
        if (input.dataset.key === 'centerX')
          patch = centeredPositionPatch(entry.ref, entry.object, 'x', value);
        else if (input.dataset.key === 'centerY')
          patch = centeredPositionPatch(entry.ref, entry.object, 'y', value);
        else if (input.dataset.key === 'width') {
          patch = { width: value };
          Object.assign(
            patch,
            centeredPositionPatch(entry.ref, { ...entry.object, width: value }, 'x', center.x),
          );
        } else if (input.dataset.key === 'height') {
          patch = { height: value };
          Object.assign(
            patch,
            centeredPositionPatch(entry.ref, { ...entry.object, height: value }, 'y', center.y),
          );
        } else patch = { [input.dataset.key]: value };
        updateObject(level, entry.ref, patch);
        if (input.dataset.key === 'id') entry.ref.id = value;
      }
      render();
    };
  }
}
function renderValidation() {
  const issues = validateLevel(level);
  const duplicateNumber = levels.filter((item) => item.number === level.number).length > 1;
  if (duplicateNumber)
    issues.unshift({
      severity: 'warning',
      code: 'duplicate-level-number',
      message: `More than one workspace level uses number ${level.number}.`,
      ids: [],
    });
  const errors = issues.filter((x) => x.severity === 'error').length,
    warnings = issues.filter((x) => x.severity === 'warning').length;
  $('#validation-summary').textContent = errors
    ? `${errors} blocking issue${errors === 1 ? '' : 's'}`
    : warnings
      ? `${warnings} warning${warnings === 1 ? '' : 's'}`
      : 'Geometry ready';
  $('#score-ring').textContent = errors ? 'FIX' : warnings ? 'CHECK' : 'PASS';
  $('#issues').innerHTML = issues
    .filter((x) => issueFilter === 'all' || x.severity === issueFilter)
    .map(
      (x) =>
        `<button class="issue ${x.severity}" data-ids="${(x.ids ?? []).join(',')}"><i></i><span><b>${safe(x.code.replaceAll('-', ' '))}</b>${safe(x.message)}</span></button>`,
    )
    .join('');
  for (const node of document.querySelectorAll('.issue'))
    node.onclick = () => {
      const id = node.dataset.ids.split(',')[0];
      const object = allObjects(level).find((x) => x.id === id);
      if (object) {
        selectOnly(objectRef(object));
        render();
      }
    };
}
function renderMeta() {
  $('#canvas-title').textContent = `Level ${level.number} · ${level.name}`;
  $('#level-name').value = level.name;
  $('#level-id').value = level.id;
  $('#level-number').value = level.number;
  $('#level-width').value = level.width;
}
function render() {
  renderMeta();
  renderTools();
  renderWorld();
  renderLayers();
  renderInspector();
  renderValidation();
  applyCamera();
  if (reachOrigin) reachTraces = traceJumpReach(level, reachOrigin, playRole());
  renderSimulation();
  scheduleAutosave();
}

function startResize(event) {
  event.preventDefault();
  event.stopPropagation();
  const [{ ref, object } = {}] = selectedEntries();
  if (!object) return;
  const bounds = resizeBounds(ref, object);
  snapshot();
  drag = {
    type: 'resize',
    ref: { ...ref },
    handle: event.currentTarget.dataset.resizeHandle,
    start: point(event),
    bounds: { ...bounds },
  };
  svg.setPointerCapture(event.pointerId);
}

function startObjectDrag(event) {
  if (reachArmed) {
    event.stopPropagation();
    placeReachOrigin(event);
    return;
  }
  if (simulationMode === 'playtest') {
    event.stopPropagation();
    const p = point(event);
    playtestPlayer.x = snap(Math.max(0, Math.min(level.width - level.playerWidth, p.x)));
    playtestPlayer.y = snap(Math.max(0, p.y));
    playtestPlayer.velocityX = 0;
    playtestPlayer.velocityY = 0;
    playtestPlayer.grounded = true;
    renderSimulation();
    return;
  }
  event.stopPropagation();
  const node = event.currentTarget;
  const ref = {
    kind: node.dataset.kind,
    id: node.dataset.id,
    role: node.dataset.role || undefined,
  };
  const additive = event.shiftKey || event.metaKey || event.ctrlKey;
  if (tool === 'resize') {
    selectOnly(ref);
    render();
    return;
  }
  if (additive) {
    toggleSelection(ref);
    if (!isSelected(ref)) {
      render();
      return;
    }
  } else if (!isSelected(ref)) selectOnly(ref);
  snapshot();
  drag = {
    type: 'objects',
    start: point(event),
    origins: selectedEntries().map((entry) => ({
      ref: { ...entry.ref },
      x: entry.object.x,
      y: entry.object.y,
    })),
  };
  svg.setPointerCapture(event.pointerId);
  render();
}
svg.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 && event.button !== 1) return;
  if (reachArmed) {
    placeReachOrigin(event);
    return;
  }
  if (simulationMode === 'playtest') {
    const p = point(event);
    playtestPlayer.x = snap(Math.max(0, Math.min(level.width - level.playerWidth, p.x)));
    playtestPlayer.y = snap(Math.max(0, p.y));
    playtestPlayer.velocityX = 0;
    playtestPlayer.velocityY = 0;
    playtestPlayer.grounded = true;
    renderSimulation();
    return;
  }
  const p = point(event);
  if (
    tool !== 'select' &&
    [
      'platform',
      'ramp',
      'solid',
      'hazard',
      'crystal',
      'lever',
      'pressurePlate',
      'pushable',
      'activatedPlatform',
      'environmentZone',
      'entrance',
    ].includes(tool)
  ) {
    snapshot();
    const ref = createObject(
      level,
      tool,
      snap(p.x),
      snap(Math.max(0, p.y)),
      tool === 'crystal' ? 'ember' : 'neutral',
    );
    const object = findObject(level, ref);
    if (!['crystal'].includes(tool))
      updateObject(level, ref, { x: snap(p.x - objectSize(ref, object).width / 2) });
    if (
      [
        'solid',
        'ramp',
        'lever',
        'pressurePlate',
        'pushable',
        'environmentZone',
        'entrance',
      ].includes(tool)
    )
      updateObject(level, ref, { y: snap(Math.max(0, p.y - objectSize(ref, object).height / 2)) });
    selectOnly(ref);
    tool = 'select';
    render();
    return;
  }
  if (tool === 'gate' || tool === 'spawn') {
    snapshot();
    const role = event.shiftKey ? 'tide' : 'ember';
    const ref = { kind: tool, id: `${role}-${tool}`, role };
    const object = findObject(level, ref);
    const size = objectSize(ref, object);
    updateObject(level, ref, {
      x: snap(p.x - size.width / 2),
      y: snap(Math.max(0, p.y - size.height / 2)),
    });
    selectOnly(ref);
    tool = 'select';
    render();
    return;
  }
  drag = { type: 'pan', client: { x: event.clientX, y: event.clientY }, origin: { ...pan } };
  svg.setPointerCapture(event.pointerId);
});
svg.addEventListener('pointermove', (event) => {
  const p = point(event);
  $('#coordinates').textContent = `x ${(p.x - level.width / 2).toFixed(1)} · y ${p.y.toFixed(1)}`;
  if (!drag) return;
  if (drag.type === 'pan') {
    pan = {
      x: drag.origin.x + event.clientX - drag.client.x,
      y: drag.origin.y + event.clientY - drag.client.y,
    };
    applyCamera();
  } else if (drag.type === 'objects') {
    const start = drag.start;
    for (const origin of drag.origins) {
      const patch = { x: snap(origin.x + p.x - start.x) };
      if (origin.y !== undefined) patch.y = snap(Math.max(0, origin.y + p.y - start.y));
      updateObject(level, origin.ref, patch);
    }
    renderWorld();
    renderInspector();
    renderValidation();
  } else if (drag.type === 'resize') {
    const dx = p.x - drag.start.x;
    const dy = p.y - drag.start.y;
    const bounds = resizeRectangle(
      drag.bounds,
      drag.handle,
      { x: dx, y: dy },
      Number($('#grid-size').value) || 0.5,
    );
    const patch = { x: bounds.x, width: bounds.width };
    if (['solid', 'ramp', 'pushable', 'environmentZone', 'entrance'].includes(drag.ref.kind))
      Object.assign(patch, { y: bounds.y, height: bounds.height });
    updateObject(level, drag.ref, patch);
    renderWorld();
    renderInspector();
    renderValidation();
  } else if (drag.type === 'reach') {
    updateReachOrigin(p, event.shiftKey);
    setSimulationHint(
      reachOrigin.snappedEdge
        ? 'JUMP REACH · snapped to platform edge · drag marker to retest'
        : reachOrigin.snappedSurface
          ? 'JUMP REACH · projected to nearest surface below · drag marker to retest'
          : 'JUMP REACH · free-space origin · hold Shift while dragging for no snapping',
    );
  }
});
svg.addEventListener('pointerup', () => {
  drag = null;
  scheduleAutosave();
  if (reachOrigin) {
    reachTraces = traceJumpReach(level, reachOrigin, playRole());
    renderSimulation();
  }
});
svg.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    const rect = svg.getBoundingClientRect();
    const next = nextTrackpadCamera(
      { zoom, pan },
      {
        pinching: event.ctrlKey,
        shiftKey: event.shiftKey,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        pointerX: event.clientX - rect.left,
        pointerY: event.clientY - rect.top,
      },
      { height: svg.clientHeight },
      viewHeight(),
    );
    zoom = next.zoom;
    pan = next.pan;
    applyCamera();
  },
  { passive: false },
);
function fit() {
  const objectTops = allObjects(level).map((object) => {
    if (['solid', 'ramp', 'pushable', 'environmentZone', 'entrance'].includes(object.kind))
      return object.y + object.height;
    if (object.kind === 'lever') return object.y + 3.6;
    if (object.kind === 'gate') return object.y + 4.5;
    if (object.kind === 'spawn') return object.y + level.playerWidth;
    if (object.kind === 'crystal') return object.y + 0.55;
    return object.y ?? 0;
  });
  const fitted = fitCameraToBounds(
    {
      minX: 0,
      maxX: level.width,
      minY: -1,
      maxY: Math.max(17.2, ...objectTops),
    },
    { width: svg.clientWidth, height: svg.clientHeight },
    viewHeight(),
  );
  zoom = fitted.zoom;
  pan = fitted.pan;
  applyCamera();
}
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1600);
}
function saveProgress(showToast = true) {
  try {
    localStorage.setItem(
      SAVED_WORKSPACE_KEY,
      JSON.stringify({
        levels,
        currentIndex: Math.max(0, levels.indexOf(level)),
        savedAt: new Date().toISOString(),
      }),
    );
    if (showToast) toast('Workspace saved in this browser');
    return true;
  } catch {
    if (showToast) toast('Workspace could not be saved');
    return false;
  }
}
function scheduleAutosave() {
  if (!level || !levels.length) return;
  if (autosaveTimer !== null) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    saveProgress(false);
  }, 350);
}
function savedWorkspace() {
  try {
    const saved = JSON.parse(localStorage.getItem(SAVED_WORKSPACE_KEY));
    return Array.isArray(saved?.levels) && saved.levels.length ? saved : null;
  } catch {
    return null;
  }
}
function openSavedProgress() {
  try {
    const saved = savedWorkspace();
    if (!saved) {
      toast('No saved workspace yet');
      return;
    }
    if (simulationMode === 'playtest') stopPlaytest();
    levels = saved.levels.map(cloneLevel);
    level = levels[Math.min(Math.max(0, saved.currentIndex ?? 0), levels.length - 1)];
    clearSelection();
    history = [];
    refreshPicker();
    fit();
    render();
    toast('Saved workspace opened');
  } catch {
    toast('Saved workspace could not be opened');
  }
}
function loadImportedLevel(imported, message) {
  if (simulationMode === 'playtest') stopPlaytest();
  const normalized = cloneLevel(imported);
  levels.push(normalized);
  level = normalized;
  clearSelection();
  history = [];
  refreshPicker();
  fit();
  render();
  saveProgress(false);
  toast(message);
}
function deleteSelected() {
  const removable = selection.filter((ref) => !['gate', 'spawn'].includes(ref.kind));
  if (!removable.length) {
    if (selection.length) toast('Gates and spawns cannot be deleted');
    return;
  }
  snapshot();
  for (const ref of removable) removeObject(level, ref);
  clearSelection();
  render();
}
async function copyElements() {
  elementClipboard = selectedEntries()
    .filter((entry) => !['gate', 'spawn'].includes(entry.ref.kind))
    .map((entry) => ({ ref: { ...entry.ref }, object: JSON.parse(JSON.stringify(entry.object)) }));
  pasteCount = 0;
  if (!elementClipboard.length) {
    toast('Select platforms, solids, pools, or shards to copy');
    return;
  }
  try {
    await navigator.clipboard.writeText(
      JSON.stringify({ type: 'ember-tide-elements', elements: elementClipboard }),
    );
  } catch {
    // The in-editor clipboard still works when browser clipboard permission is unavailable.
  }
  toast(`${elementClipboard.length} object${elementClipboard.length === 1 ? '' : 's'} copied`);
}
function pasteElements(mirrored = false) {
  if (!elementClipboard.length) {
    toast('Copy some objects first');
    return;
  }
  snapshot();
  if (!mirrored) pasteCount += 1;
  const offset = mirrored ? 0 : snap(pasteCount);
  const pasted = [];
  const stamp = Date.now().toString(36);
  elementClipboard.forEach((entry, index) => {
    const object = mirrored
      ? mirrorObjectAcrossStage(level.width, entry.ref.kind, entry.object)
      : JSON.parse(JSON.stringify(entry.object));
    object.id = `${entry.object.id}-copy-${stamp}-${index + 1}`;
    if (!mirrored) {
      object.x += offset;
      if (entry.ref.kind !== 'hazard' && object.y !== undefined) object.y += offset;
    }
    if (['lever', 'pressurePlate', 'pushable', 'activatedPlatform'].includes(entry.ref.kind)) {
      level.mechanics ??= {};
      level.mechanics[entry.ref.kind] = object;
    } else {
      const collection =
        entry.ref.kind === 'solid'
          ? level.solids
          : entry.ref.kind === 'environmentZone'
            ? (level.environmentZones ??= [])
            : level[`${entry.ref.kind}s`];
      collection.push(object);
    }
    pasted.push({ kind: entry.ref.kind, id: object.id, role: object.role });
  });
  setSelection(pasted);
  render();
  toast(
    `${pasted.length} object${pasted.length === 1 ? '' : 's'} pasted${mirrored ? ' across X 0' : ''}`,
  );
}
$('#delete').onclick = deleteSelected;
$('#copy-elements').onclick = copyElements;
$('#paste-elements').onclick = () => pasteElements();
$('#paste-mirrored').onclick = () => pasteElements(true);
$('#save-progress').onclick = () => saveProgress();
$('#open-progress').onclick = openSavedProgress;
$('#zoom-in').onclick = () => {
  zoom = Math.min(3, zoom * 1.2);
  applyCamera();
};
$('#zoom-out').onclick = () => {
  zoom = Math.max(CAMERA_MIN_ZOOM, zoom / 1.2);
  applyCamera();
};
$('#fit').onclick = fit;
$('#jump-reach').onclick = () => {
  reachArmed = !reachArmed;
  if (reachArmed) {
    reachOrigin = null;
    reachTraces = [];
    renderSimulation();
  }
  $('#jump-reach').classList.toggle('active', reachArmed);
  setSimulationHint(
    reachArmed
      ? 'JUMP REACH · click the character’s starting position on a surface'
      : simulationMode === 'playtest'
        ? playtestHint()
        : '',
  );
};
$('#playtest').onclick = () => {
  if (simulationMode === 'playtest') stopPlaytest();
  else startPlaytest();
};
$('#reset-playtest').onclick = resetPlaytest;
$('#play-role').onchange = () => {
  reachTraces = [];
  reachOrigin = null;
  if (simulationMode === 'playtest') resetPlaytest();
  else renderSimulation();
};
for (const [id, key] of [
  ['level-name', 'name'],
  ['level-id', 'id'],
  ['level-number', 'number'],
  ['level-width', 'width'],
])
  $('#' + id).onchange = (event) => {
    snapshot();
    const previousValue = level[key];
    const nextValue =
      event.target.type === 'number' ? Number(event.target.value) : event.target.value;
    if (key === 'number') {
      const displaced = levels.find((item) => item !== level && item.number === nextValue);
      if (displaced) {
        displaced.number = previousValue;
        displaced.chapter = `Level ${displaced.number}`;
      }
    }
    level[key] = nextValue;
    if (key === 'number') level.chapter = `Level ${level.number}`;
    if (['name', 'number'].includes(key)) refreshPicker();
    if (key === 'number') scheduleLiveCatalogSync();
    render();
  };
for (const button of document.querySelectorAll('.filter-row button'))
  button.onclick = () => {
    issueFilter = button.dataset.filter;
    for (const b of document.querySelectorAll('.filter-row button'))
      b.classList.toggle('active', b === button);
    renderValidation();
  };
$('#copy').onclick = async () => {
  await navigator.clipboard.writeText(exportTypescript(level));
  toast('TypeScript copied');
};
async function loadLiveLevels() {
  const response = await fetch('/api/levels');
  if (!response.ok) throw new Error('Live levels could not be loaded');
  liveLevels = (await response.json()).map(cloneLevel);
  return liveLevels;
}
async function syncLiveCatalogNumbering() {
  if (!liveLevels.length) return;
  const liveIds = new Set(liveLevels.map((item) => item.id));
  const liveWorkspaceLevels = levels.filter((item) => liveIds.has(item.id));
  if (liveWorkspaceLevels.length !== liveLevels.length) return;
  const numbers = liveWorkspaceLevels.map((item) => item.number);
  if (
    numbers.some((number) => !Number.isInteger(number) || number < 1) ||
    new Set(numbers).size !== numbers.length
  )
    return;
  const orderedIds = [...liveWorkspaceLevels]
    .sort((first, second) => first.number - second.number)
    .map((item) => item.id);
  if (orderedIds.every((id, index) => liveLevels[index]?.id === id)) return;
  const response = await fetch('/api/reorder-levels', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orderedIds }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'Live level order could not be updated');
  liveLevels = result.levels.map(cloneLevel);
  for (const liveLevel of liveLevels) {
    const workspaceLevel = levels.find((item) => item.id === liveLevel.id);
    if (workspaceLevel) {
      workspaceLevel.number = liveLevel.number;
      workspaceLevel.chapter = liveLevel.chapter;
    }
  }
  refreshPicker();
  render();
  saveProgress(false);
  toast('Live game order updated');
}
function scheduleLiveCatalogSync() {
  if (catalogSyncTimer !== null) clearTimeout(catalogSyncTimer);
  catalogSyncTimer = setTimeout(() => {
    catalogSyncTimer = null;
    void syncLiveCatalogNumbering().catch((error) =>
      toast(error instanceof Error ? error.message : 'Live order update failed'),
    );
  }, 500);
}
$('#push-level').onclick = async () => {
  try {
    await loadLiveLevels();
  } catch (error) {
    toast(error instanceof Error ? error.message : 'Live levels could not be loaded');
    return;
  }
  const target = $('#push-target');
  target.innerHTML = liveLevels
    .map(
      (liveLevel) =>
        `<option value="${liveLevel.number}">Level ${liveLevel.number} — ${safe(liveLevel.name)}</option>`,
    )
    .join('');
  if (liveLevels.some((item) => item.number === level.number)) target.value = String(level.number);
  $('#push-summary').textContent = `“${level.name}” will replace the selected live level.`;
  $('#push-dialog').showModal();
};
$('#confirm-push').onclick = async () => {
  const targetNumber = Number($('#push-target').value);
  saveProgress(false);
  const button = $('#confirm-push');
  button.disabled = true;
  button.textContent = 'Archiving and pushing…';
  try {
    const response = await fetch('/api/push-level', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetNumber, level }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    const index = levels.indexOf(level);
    level = cloneLevel(result.installedLevel);
    levels[index] = level;
    liveLevels = liveLevels.map((item) =>
      item.number === targetNumber ? cloneLevel(level) : item,
    );
    $('#push-dialog').close();
    refreshPicker();
    render();
    saveProgress(false);
    toast(`Level ${targetNumber} replaced · previous version archived`);
  } catch (error) {
    toast(error instanceof Error ? error.message : 'Level update failed');
  } finally {
    button.disabled = false;
    button.textContent = 'Archive and overwrite';
  }
};
$('#archive-active-level').onclick = async () => {
  if (!confirm(`Archive “${level.name}” and remove it from this workspace?`)) return;
  const button = $('#archive-active-level');
  button.disabled = true;
  button.textContent = 'Archiving…';
  try {
    const response = await fetch('/api/archived-levels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ level }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    const ordered = orderedWorkspaceEntries();
    const orderedIndex = ordered.findIndex((entry) => entry.item === level);
    const workspaceIndex = levels.indexOf(level);
    levels.splice(workspaceIndex, 1);
    if (!levels.length) {
      levels.push(blankLevel(1));
      level = levels[0];
    } else {
      const nextEntry = ordered[orderedIndex + 1] ?? ordered[orderedIndex - 1];
      level = nextEntry.item;
    }
    clearSelection();
    history = [];
    refreshPicker();
    fit();
    render();
    saveProgress(false);
    toast('Level archived · reopen it from Archived');
  } catch (error) {
    toast(error instanceof Error ? error.message : 'Level could not be archived');
  } finally {
    button.disabled = false;
    button.textContent = 'Archive active level';
  }
};
$('#archived-levels').onclick = async () => {
  const list = $('#archive-list');
  list.innerHTML = '<p>Loading archives…</p>';
  $('#archive-dialog').showModal();
  try {
    const response = await fetch('/api/archived-levels');
    if (!response.ok) throw new Error('Archived levels could not be loaded');
    const archives = await response.json();
    if (!archives.length) {
      list.innerHTML = '<p>No levels have been archived yet.</p>';
      return;
    }
    list.innerHTML = archives
      .map(
        (archive, index) =>
          `<div class="archive-entry"><div><strong>Level ${archive.targetNumber} · ${safe(archive.level.name)}</strong><span>${archive.reason === 'manual' ? 'Manually archived' : 'Replaced during publish'} · ${safe(new Date(archive.archivedAt).toLocaleString())} · ${safe(archive.level.id)}</span></div><button type="button" data-archive-index="${index}">Open copy</button></div>`,
      )
      .join('');
    for (const openButton of list.querySelectorAll('[data-archive-index]'))
      openButton.onclick = () => {
        const archive = archives[Number(openButton.dataset.archiveIndex)];
        $('#archive-dialog').close();
        loadImportedLevel(
          cloneLevel(archive.level),
          `Archived Level ${archive.targetNumber} opened`,
        );
      };
  } catch (error) {
    list.innerHTML = `<p>${safe(error instanceof Error ? error.message : 'Archives unavailable')}</p>`;
  }
};
$('#download').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([exportJson(level)], { type: 'application/json' }));
  a.download = `${level.id}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('JSON downloaded');
};
$('#import').onclick = () => $('#file').click();
$('#file').onchange = async (event) => {
  try {
    const imported = JSON.parse(await event.target.files[0].text());
    loadImportedLevel(imported, 'JSON level imported');
  } catch {
    toast('That JSON could not be read');
  } finally {
    event.target.value = '';
  }
};
$('#import-typescript').onclick = () => $('#typescript-file').click();
$('#typescript-file').onchange = async (event) => {
  try {
    const imported = importTypescriptLevel(await event.target.files[0].text());
    loadImportedLevel(imported, 'TypeScript level imported');
  } catch {
    toast('That TypeScript level could not be read');
  } finally {
    event.target.value = '';
  }
};
$('#paste-typescript').onclick = () => {
  $('#typescript-source').value = '';
  $('#typescript-dialog').showModal();
  $('#typescript-source').focus();
};
$('#load-typescript').onclick = () => {
  try {
    const imported = importTypescriptLevel($('#typescript-source').value);
    loadImportedLevel(imported, 'Pasted TypeScript level loaded');
    $('#typescript-dialog').close();
  } catch {
    toast('That TypeScript level could not be read');
  }
};
$('#new-level').onclick = () => {
  if (simulationMode === 'playtest') stopPlaytest();
  const nextNumber = Math.max(0, ...levels.map((item) => Number(item.number) || 0)) + 1;
  levels.push(blankLevel(nextNumber));
  level = levels.at(-1);
  refreshPicker();
  fit();
  render();
};
function orderedWorkspaceEntries() {
  return levels
    .map((item, index) => ({ item, index }))
    .sort(
      (first, second) =>
        first.item.number - second.item.number || first.item.name.localeCompare(second.item.name),
    );
}
function moveActiveLevel(direction) {
  const ordered = orderedWorkspaceEntries();
  const current = ordered.findIndex((entry) => entry.item === level);
  const target = current + direction;
  if (current < 0 || target < 0 || target >= ordered.length) return;
  const other = ordered[target].item;
  const currentNumber = level.number;
  level.number = other.number;
  level.chapter = `Level ${level.number}`;
  other.number = currentNumber;
  other.chapter = `Level ${other.number}`;
  refreshPicker();
  render();
  scheduleLiveCatalogSync();
}
$('#move-level-up').onclick = () => moveActiveLevel(-1);
$('#move-level-down').onclick = () => moveActiveLevel(1);
function refreshPicker() {
  const picker = $('#level-picker');
  picker.innerHTML = orderedWorkspaceEntries()
    .map(
      ({ item, index }) =>
        `<option value="${index}">Level ${item.number} — ${safe(item.name)}</option>`,
    )
    .join('');
  picker.value = String(levels.indexOf(level));
  picker.onchange = () => {
    if (simulationMode === 'playtest') stopPlaytest();
    level = levels[Number(picker.value)];
    clearSelection();
    history = [];
    fit();
    render();
  };
}
document.addEventListener('keydown', (event) => {
  const activeElement = document.activeElement;
  if (
    ['INPUT', 'SELECT', 'TEXTAREA'].includes(activeElement.tagName) ||
    activeElement.isContentEditable
  )
    return;
  const key = event.key.toLowerCase();
  if (simulationMode === 'playtest') {
    if (key === 'shift') {
      pressedKeys.add(key);
      return;
    }
    if (['arrowleft', 'arrowright', 'arrowup', 'a', 'd', 'w', ' '].includes(key)) {
      event.preventDefault();
      pressedKeys.add(key);
      if (['arrowup', 'w', ' '].includes(key) && !event.repeat) jumpQueued = true;
      return;
    }
    if (key === 'e' && !event.repeat && level.mechanics && playtestMechanics) {
      event.preventDefault();
      const lever = level.mechanics.lever;
      const playerCenter = playtestPlayer.x + level.playerWidth / 2;
      if (
        Math.abs(playtestPlayer.y - lever.y) <= 0.25 &&
        Math.abs(playerCenter - (lever.x + lever.width / 2)) <= lever.reach
      ) {
        playtestMechanics.leverActivated = !playtestMechanics.leverActivated;
        renderSimulation();
      } else toast('Move within reach of the lever');
      return;
    }
    if (key === 'r') {
      event.preventDefault();
      resetPlaytest();
      return;
    }
    if (key === 'escape') {
      stopPlaytest();
      return;
    }
  }
  if ((event.metaKey || event.ctrlKey) && key === 'c') {
    event.preventDefault();
    copyElements();
  } else if ((event.metaKey || event.ctrlKey) && event.shiftKey && key === 'v') {
    event.preventDefault();
    pasteElements(true);
  } else if ((event.metaKey || event.ctrlKey) && key === 'v') {
    event.preventDefault();
    pasteElements();
  } else if ((event.metaKey || event.ctrlKey) && key === 'a') {
    event.preventDefault();
    setSelection(allObjects(level).map(objectRef));
    render();
  } else if ((event.metaKey || event.ctrlKey) && key === 'z') {
    event.preventDefault();
    undo();
  } else if (event.key === 'Delete' || event.key === 'Backspace') deleteSelected();
  else if (/^[1-9]$/.test(event.key)) {
    tool = TOOLS[Number(event.key) - 1];
    render();
  } else if (event.key === 'Escape') {
    clearSelection();
    tool = 'select';
    render();
  }
});
document.addEventListener('keyup', (event) => pressedKeys.delete(event.key.toLowerCase()));
globalThis.addEventListener('blur', () => pressedKeys.clear());
document.addEventListener(
  'click',
  (event) => {
    if (event.target.closest('a[href]')) saveProgress(false);
  },
  { capture: true },
);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveProgress(false);
});
globalThis.addEventListener('pagehide', () => saveProgress(false));
globalThis.addEventListener('beforeunload', () => saveProgress(false));

try {
  await loadLiveLevels();
  const saved = savedWorkspace();
  if (saved) {
    levels = saved.levels.map(cloneLevel);
    level = levels[Math.min(Math.max(0, saved.currentIndex ?? 0), levels.length - 1)];
  } else {
    levels = liveLevels.map(cloneLevel);
    level = levels[0];
  }
} catch {
  levels = [blankLevel()];
  level = levels[0];
}
refreshPicker();
render();
requestAnimationFrame(fit);
