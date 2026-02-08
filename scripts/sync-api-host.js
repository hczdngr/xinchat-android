const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'src', 'config.ts');

const isPrivateIpv4 = (value) => {
  if (!value || typeof value !== 'string') return false;
  const parts = value.split('.').map((item) => Number(item));
  if (parts.length !== 4 || parts.some((item) => !Number.isInteger(item) || item < 0 || item > 255)) {
    return false;
  }
  if (parts[0] === 10) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  return false;
};

const rankIpv4 = (value) => {
  if (value.startsWith('192.168.')) return 100;
  if (value.startsWith('10.')) return 90;
  if (value.startsWith('172.')) return 80;
  return 0;
};

const resolveLocalIpv4 = () => {
  const nets = os.networkInterfaces();
  const all = [];
  Object.values(nets).forEach((entries) => {
    (entries || []).forEach((entry) => {
      if (!entry) return;
      const family = typeof entry.family === 'string' ? entry.family : String(entry.family || '');
      if (family !== 'IPv4') return;
      if (entry.internal) return;
      if (!isPrivateIpv4(entry.address)) return;
      all.push(entry.address);
    });
  });
  if (all.length === 0) return '';
  all.sort((a, b) => rankIpv4(b) - rankIpv4(a));
  return all[0];
};

const syncConfig = (host) => {
  const source = fs.readFileSync(CONFIG_PATH, 'utf8');
  const next = source.replace(
    /const LOCAL_MACHINE_HOST = '([^']+)';/,
    `const LOCAL_MACHINE_HOST = '${host}';`
  );
  if (next !== source) {
    fs.writeFileSync(CONFIG_PATH, next, 'utf8');
    return true;
  }
  return false;
};

const main = () => {
  const host = resolveLocalIpv4();
  if (!host) {
    console.log('[sync-api-host] no private IPv4 found, skip.');
    return;
  }
  const changed = syncConfig(host);
  if (changed) {
    console.log(`[sync-api-host] updated src/config.ts host => ${host}`);
  } else {
    console.log(`[sync-api-host] src/config.ts already uses ${host}`);
  }
};

main();
