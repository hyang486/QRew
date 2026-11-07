// Run: npm test (node --test, Node 24 strips the .ts types).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkAccount } from '../src/lib/account-check.ts';

const api = (code, status) => ({ api: true, code, status });
const network = () => ({ api: false, status: 0 });

/** getUser returns the queued results in order; counts refresh calls. */
function deps({ users, refresh = { error: null } }) {
  const queue = [...users];
  const calls = { getUser: 0, refresh: 0 };
  return {
    calls,
    getUser: async () => {
      calls.getUser += 1;
      return { error: queue.shift() ?? null };
    },
    refreshSession: async () => {
      calls.refresh += 1;
      return refresh;
    },
    isApiError: (e) => e.api === true,
  };
}

test('valid account -> ok, no refresh', async () => {
  const d = deps({ users: [null] });
  assert.equal(await checkAccount(d), 'ok');
  assert.equal(d.calls.refresh, 0);
});

test('user_not_found -> gone', async () => {
  const d = deps({ users: [api('user_not_found', 403)] });
  assert.equal(await checkAccount(d), 'gone');
  assert.equal(d.calls.refresh, 0);
});

test('bad_jwt, refresh OK, user OK -> ok (expired or skewed token is not a deleted account)', async () => {
  const d = deps({ users: [api('bad_jwt', 403), null] });
  assert.equal(await checkAccount(d), 'ok');
  assert.equal(d.calls.refresh, 1);
});

test('bad_jwt, refresh OK, then user_not_found -> gone', async () => {
  const d = deps({ users: [api('bad_jwt', 403), api('user_not_found', 403)] });
  assert.equal(await checkAccount(d), 'gone');
});

test('bad_jwt, refresh OK, still bad_jwt -> unknown (keep session)', async () => {
  const d = deps({ users: [api('bad_jwt', 403), api('bad_jwt', 403)] });
  assert.equal(await checkAccount(d), 'unknown');
});

test('bad_jwt, refresh fails with refresh_token_not_found -> gone', async () => {
  const d = deps({ users: [api('bad_jwt', 403)], refresh: { error: api('refresh_token_not_found', 400) } });
  assert.equal(await checkAccount(d), 'gone');
});

test('bad_jwt, refresh fails with refresh_token_already_used -> unknown', async () => {
  const d = deps({ users: [api('bad_jwt', 403)], refresh: { error: api('refresh_token_already_used', 400) } });
  assert.equal(await checkAccount(d), 'unknown');
});

test('bad_jwt, refresh network error -> unknown', async () => {
  const d = deps({ users: [api('bad_jwt', 403)], refresh: { error: network() } });
  assert.equal(await checkAccount(d), 'unknown');
});

test('network error -> unknown, no refresh', async () => {
  const d = deps({ users: [network()] });
  assert.equal(await checkAccount(d), 'unknown');
  assert.equal(d.calls.refresh, 0);
});

test('other server error (500) -> unknown', async () => {
  const d = deps({ users: [api('unexpected_failure', 500)] });
  assert.equal(await checkAccount(d), 'unknown');
  assert.equal(d.calls.refresh, 0);
});
