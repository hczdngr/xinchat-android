const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DEVICE = process.env.ADB_DEVICE || '192.168.0.2:5555';
const APK_PATH = path.join(
  ROOT,
  'android',
  'app',
  'build',
  'outputs',
  'apk',
  'debug',
  'app-debug.apk'
);
const WATCH_TARGETS = ['App.tsx', 'src', 'android\\app\\src'];
const DEBOUNCE_MS = 800;

let timer = null;
let running = false;
let pending = false;

const log = (message) => {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[auto-install ${stamp}] ${message}`);
};

const run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    log(`run: ${command} ${args.join(' ')}`);
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: false,
      ...options,
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
  });

const buildAndInstall = async () => {
  if (running) {
    pending = true;
    return;
  }
  running = true;
  try {
    await run('adb', ['connect', DEVICE]);
    await run('cmd', ['/c', 'gradlew.bat', 'assembleDebug'], {
      cwd: path.join(ROOT, 'android'),
    });
    if (!fs.existsSync(APK_PATH)) {
      throw new Error(`APK not found: ${APK_PATH}`);
    }
    await run('adb', ['-s', DEVICE, 'install', '-r', APK_PATH]);
    log('install complete.');
  } catch (err) {
    log(`error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    running = false;
    if (pending) {
      pending = false;
      scheduleBuild();
    }
  }
};

const scheduleBuild = () => {
  if (timer) {
    clearTimeout(timer);
  }
  timer = setTimeout(() => {
    timer = null;
    void buildAndInstall();
  }, DEBOUNCE_MS);
};

const watchTarget = (target) => {
  const abs = path.resolve(ROOT, target);
  if (!fs.existsSync(abs)) {
    log(`skip missing path: ${abs}`);
    return;
  }
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) {
    fs.watch(abs, { recursive: true }, () => scheduleBuild());
  } else {
    fs.watch(path.dirname(abs), { recursive: false }, (event, filename) => {
      if (!filename) return;
      if (path.resolve(path.dirname(abs), filename) === abs) {
        scheduleBuild();
      }
    });
  }
  log(`watching: ${abs}`);
};

WATCH_TARGETS.forEach(watchTarget);
log('ready. waiting for changes...');
