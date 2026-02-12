import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { app } from '../index.js';
import { resetAdminAuthForTests } from '../routes/adminAuth.js';

const withServer = async (runner) => {
  const server = http.createServer(app);
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await runner(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

const withEnv = async (nextEnv, runner) => {
  const keys = Object.keys(nextEnv || {});
  const backup = {};
  keys.forEach((key) => {
    backup[key] = process.env[key];
    if (typeof nextEnv[key] === 'undefined') {
      delete process.env[key];
    } else {
      process.env[key] = String(nextEnv[key]);
    }
  });
  try {
    return await runner();
  } finally {
    keys.forEach((key) => {
      if (typeof backup[key] === 'undefined') {
        delete process.env[key];
      } else {
        process.env[key] = backup[key];
      }
    });
  }
};

const jsonFetch = async (url, { method = 'GET', body, token, adminToken } = {}) => {
  const headers = {};
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (adminToken) {
    headers['X-Admin-Token'] = adminToken;
  }
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
};

const registerAndLogin = async (baseUrl, label) => {
  const seed = `${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;
  const username = `admin_auth_${String(label || 'u').slice(0, 8)}_${seed}`.toLowerCase();
  const password = 'Passw0rd!normalUser';

  const registerResult = await jsonFetch(`${baseUrl}/api/register`, {
    method: 'POST',
    body: { username, password },
  });
  assert.equal(registerResult.response.status, 200);
  assert.equal(registerResult.payload.success, true);

  const loginResult = await jsonFetch(`${baseUrl}/api/login`, {
    method: 'POST',
    body: { username, password },
  });
  assert.equal(loginResult.response.status, 200);
  assert.equal(loginResult.payload.success, true);

  return {
    uid: Number(loginResult.payload.uid),
    token: String(loginResult.payload.token || ''),
    username,
  };
};

test('Admin login uses dedicated admin database and isolates user auth', async () => {
  const seed = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const adminUsername = `ops_admin_${seed}`;
  const adminPassword = 'Passw0rd!AdminOnly';

  await withEnv(
    {
      ADMIN_ENABLE_INSECURE: 'false',
      ADMIN_API_TOKEN: undefined,
      ADMIN_BOOTSTRAP_USERNAME: adminUsername,
      ADMIN_BOOTSTRAP_PASSWORD: adminPassword,
      ADMIN_BOOTSTRAP_DISPLAY_NAME: 'Ops Admin',
      ADMIN_BOOTSTRAP_FORCE_RESET_PASSWORD: 'true',
    },
    async () => {
      resetAdminAuthForTests();
      await withServer(async (baseUrl) => {
        const normalUser = await registerAndLogin(baseUrl, 'regular');

        const normalTokenResult = await jsonFetch(`${baseUrl}/api/admin/users/summary`, {
          token: normalUser.token,
        });
        assert.equal(normalTokenResult.response.status, 401);
        assert.equal(normalTokenResult.payload.success, false);

        const userLoginByAdminCred = await jsonFetch(`${baseUrl}/api/login`, {
          method: 'POST',
          body: {
            username: adminUsername,
            password: adminPassword,
          },
        });
        assert.equal(userLoginByAdminCred.response.status, 401);
        assert.equal(userLoginByAdminCred.payload.success, false);

        const adminLogin = await jsonFetch(`${baseUrl}/api/admin/auth/login`, {
          method: 'POST',
          body: {
            username: adminUsername,
            password: adminPassword,
          },
        });
        assert.equal(adminLogin.response.status, 200);
        assert.equal(adminLogin.payload.success, true);
        const adminToken = String(adminLogin.payload?.data?.token || '');
        assert.equal(adminToken.length >= 32, true);

        const meResult = await jsonFetch(`${baseUrl}/api/admin/auth/me`, {
          adminToken,
        });
        assert.equal(meResult.response.status, 200);
        assert.equal(meResult.payload.success, true);
        assert.equal(meResult.payload.data?.username, adminUsername);

        const summaryResult = await jsonFetch(`${baseUrl}/api/admin/users/summary`, {
          adminToken,
        });
        assert.equal(summaryResult.response.status, 200);
        assert.equal(summaryResult.payload.success, true);
        assert.equal(Number(summaryResult.payload.data?.total) >= 1, true);

        const logoutResult = await jsonFetch(`${baseUrl}/api/admin/auth/logout`, {
          method: 'POST',
          adminToken,
        });
        assert.equal(logoutResult.response.status, 200);
        assert.equal(logoutResult.payload.success, true);

        const postLogoutSummary = await jsonFetch(`${baseUrl}/api/admin/users/summary`, {
          adminToken,
        });
        assert.equal(postLogoutSummary.response.status, 401);
        assert.equal(postLogoutSummary.payload.success, false);
      });
    }
  );
});

test('Default admin bootstrap account can login when bootstrap env is missing', async () => {
  await withEnv(
    {
      ADMIN_ENABLE_INSECURE: 'false',
      ADMIN_API_TOKEN: undefined,
      ADMIN_BOOTSTRAP_USERNAME: undefined,
      ADMIN_BOOTSTRAP_PASSWORD: undefined,
      ADMIN_BOOTSTRAP_DISPLAY_NAME: undefined,
      ADMIN_DEFAULT_BOOTSTRAP_ENABLED: 'true',
      ADMIN_DEFAULT_BOOTSTRAP_USERNAME: 'admin',
      ADMIN_DEFAULT_BOOTSTRAP_PASSWORD: 'Ss112211',
      ADMIN_BOOTSTRAP_FORCE_RESET_PASSWORD: 'true',
    },
    async () => {
      resetAdminAuthForTests();
      await withServer(async (baseUrl) => {
        const adminLogin = await jsonFetch(`${baseUrl}/api/admin/auth/login`, {
          method: 'POST',
          body: {
            username: 'admin',
            password: 'Ss112211',
          },
        });
        assert.equal(adminLogin.response.status, 200);
        assert.equal(adminLogin.payload.success, true);
        assert.equal(adminLogin.payload?.data?.admin?.username, 'admin');
        const adminToken = String(adminLogin.payload?.data?.token || '');
        assert.equal(adminToken.length >= 32, true);

        const summary = await jsonFetch(`${baseUrl}/api/admin/users/summary`, {
          adminToken,
        });
        assert.equal(summary.response.status, 200);
        assert.equal(summary.payload.success, true);
      });
    }
  );
});
