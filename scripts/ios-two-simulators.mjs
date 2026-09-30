#!/usr/bin/env node
/* global clearTimeout, console, process, setTimeout */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { Socket } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mobileRoot = join(repoRoot, 'apps', 'mobile');
const outputDir = join(mobileRoot, '.expo', 'two-simulators');
const metroPort = process.env.EXPO_PACKAGER_PORT ?? '8081';

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: mobileRoot,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    ...options,
  });
}

function simulatorInventory() {
  const raw = run('xcrun', ['simctl', 'list', 'devices', 'available', '--json'], {
    capture: true,
  });
  const { devices } = JSON.parse(raw);

  return Object.entries(devices)
    .filter(([runtime]) => runtime.includes('.SimRuntime.iOS-'))
    .flatMap(([runtime, runtimeDevices]) =>
      runtimeDevices
        .filter((device) => device.isAvailable && device.name.startsWith('iPhone'))
        .map((device) => ({ ...device, runtime })),
    )
    .sort((left, right) => {
      const version = (runtime) => runtime.split('.SimRuntime.iOS-')[1].split('-').map(Number);
      const leftVersion = version(left.runtime);
      const rightVersion = version(right.runtime);
      const length = Math.max(leftVersion.length, rightVersion.length);

      for (let index = 0; index < length; index += 1) {
        const difference = (rightVersion[index] ?? 0) - (leftVersion[index] ?? 0);
        if (difference !== 0) return difference;
      }
      return 0;
    });
}

function runtimeLabel(runtime) {
  return runtime.split('.SimRuntime.iOS-')[1].replaceAll('-', '.');
}

function selectDevices(inventory, selectors) {
  if (selectors.length > 2) {
    throw new Error('Pass no more than two simulator names or UDIDs.');
  }

  const selected = selectors.map((selector) => {
    const candidates = inventory.filter(
      (device) => device.udid === selector || device.name === selector,
    );
    if (candidates.length === 0) {
      throw new Error(`No available iPhone simulator matches "${selector}".`);
    }
    return candidates[0];
  });

  const newestRuntime = inventory[0]?.runtime;
  const defaults = inventory.filter(
    (device) =>
      device.runtime === newestRuntime &&
      !selected.some((selectedDevice) => selectedDevice.udid === device.udid),
  );

  while (selected.length < 2 && defaults.length > 0) {
    selected.push(defaults.shift());
  }

  if (selected.length < 2) {
    throw new Error('At least two available iPhone simulators are required.');
  }
  if (selected[0].udid === selected[1].udid) {
    throw new Error('Choose two different simulators.');
  }
  return selected;
}

function isMetroRunning() {
  return new Promise((resolveStatus) => {
    const socket = new Socket();
    const finish = (status) => {
      socket.destroy();
      resolveStatus(status);
    };

    socket.setTimeout(500);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(Number(metroPort), '127.0.0.1');
  });
}

function allowMetroToStart(child) {
  return new Promise((resolveReady, reject) => {
    const timer = setTimeout(resolveReady, 2_500);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Metro exited before startup (status ${code ?? 'unknown'}).`));
    });
  });
}

const args = process.argv.slice(2);
const inventory = simulatorInventory();

if (args.includes('--help')) {
  console.log(`Usage:
  npm run ios:two
  npm run ios:two -- "iPhone 17 Pro" "iPhone 17 Pro Max"
  npm run ios:two -- <simulator-udid-1> <simulator-udid-2>
  npm run ios:two -- --list`);
  process.exit(0);
}

if (args.includes('--list')) {
  for (const device of inventory) {
    console.log(`${device.name}\t${runtimeLabel(device.runtime)}\t${device.state}\t${device.udid}`);
  }
  process.exit(0);
}

const devices = selectDevices(inventory, args);
console.log(
  `Using ${devices.map((device) => `${device.name} (iOS ${runtimeLabel(device.runtime)})`).join(' and ')}`,
);

for (const device of devices) {
  if (device.state !== 'Booted') {
    run('xcrun', ['simctl', 'boot', device.udid]);
  }
  run('xcrun', ['simctl', 'bootstatus', device.udid, '-b']);
}
run('open', ['-a', 'Simulator']);

rmSync(outputDir, { recursive: true, force: true });
run('npx', ['expo', 'run:ios', '--device', 'generic', '--no-bundler', '--output', outputDir]);

const appName = readdirSync(outputDir).find((entry) => entry.endsWith('.app'));
const appPath = appName ? join(outputDir, appName) : undefined;
if (!appPath || !existsSync(join(appPath, 'Info.plist'))) {
  throw new Error(`Expo did not produce an app bundle in ${outputDir}.`);
}

const bundleId = run(
  'plutil',
  ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(appPath, 'Info.plist')],
  { capture: true },
).trim();

for (const device of devices) {
  run('xcrun', ['simctl', 'install', device.udid, appPath]);
}

let metro;
if (await isMetroRunning()) {
  console.log(`Reusing Metro on port ${metroPort}.`);
} else {
  metro = spawn('npx', ['expo', 'start', '--dev-client', '--localhost', '--port', metroPort], {
    cwd: mobileRoot,
    env: process.env,
    // Metro runs as a child while this script installs and opens both apps.
    // Giving that child the controlling terminal can suspend it when it reads
    // stdin, so only forward its output.
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  await allowMetroToStart(metro);
}

const developmentUrl = encodeURIComponent(`http://127.0.0.1:${metroPort}`);
const deepLink = `${bundleId}://expo-development-client/?url=${developmentUrl}`;
for (const device of devices) {
  try {
    run('xcrun', ['simctl', 'terminate', device.udid, bundleId], { stdio: 'ignore' });
  } catch {
    // The app may not be running yet.
  }
  run('xcrun', ['simctl', 'openurl', device.udid, deepLink]);
}

console.log('The app is running on both simulators. Press Ctrl+C to stop Metro.');
if (metro) {
  const stopMetro = () => metro.kill('SIGINT');
  process.once('SIGINT', stopMetro);
  process.once('SIGTERM', stopMetro);
  await new Promise((resolveExit, reject) => {
    metro.once('exit', (code, signal) => {
      if (code === 0 || signal === 'SIGINT' || signal === 'SIGTERM') resolveExit();
      else reject(new Error(`Metro exited with status ${code ?? signal ?? 'unknown'}.`));
    });
  });
}
