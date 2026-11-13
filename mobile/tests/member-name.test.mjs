// Run: npm test. Grace (0027): the host's member row is not readable, so the host shows as "Host", not "Former member".
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { en } from '../src/i18n/en.ts';
import { memberName } from '../src/lib/member-name.ts';

const HOST = 'host-id';
const names = new Map([['a', 'Ann']]);

test('a known member shows their name, the host included', () => {
  assert.equal(memberName(names, 'a', HOST, en.chat), 'Ann');
  assert.equal(memberName(new Map([[HOST, 'Hana']]), HOST, HOST, en.chat), 'Hana');
});

test('grace: the host missing from the names map shows as Host', () => {
  assert.equal(memberName(names, HOST, HOST, en.chat), en.chat.host);
  assert.equal(memberName(undefined, HOST, HOST, en.chat), en.chat.host);
  assert.equal(en.chat.host, 'Host');
});

test('anyone else missing stays Former member, also with no host id', () => {
  assert.equal(memberName(names, 'b', HOST, en.chat), en.chat.formerMember);
  assert.equal(memberName(names, 'b', null, en.chat), en.chat.formerMember);
  assert.equal(memberName(names, 'b', undefined, en.chat), en.chat.formerMember);
  assert.equal(memberName(names, '', '', en.chat), en.chat.formerMember);
});
