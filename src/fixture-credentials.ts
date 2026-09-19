// Deliberately fake credentials for disposable, unauthenticated test fixtures.
// The password token is safe to persist in flow maps and logs; only the browser
// execution boundary resolves it to the fixture value.
import type { Action, Snapshot } from './types.js';

export const FIXTURE_LOGIN_USERNAME = 'JohnSmith@example.com';
export const FIXTURE_PASSWORD_TOKEN = '[fixture-login-password]';
export const FIXTURE_LOGIN_PASSWORD = '123456';

export const isAccountCreation = (label: string) => /creat\w*\s+(?:(?:an?|your)\s+)?account|sign\s*up|register/i.test(label)
  && !/sign\s*in|log\s*in/i.test(label);

/** Resolve each step from the current DOM: switching tabs can change selectors. */
export function fixtureLoginActions(snapshot: Snapshot): Action[] | undefined {
  const password = snapshot.elements.find(element => element.tag === 'input' && element.type === 'password');
  if (!password) return;
  const controls = snapshot.elements.filter(element => element.tag === 'button' || element.tag === 'a' || element.type === 'submit');
  const signIn = controls.filter(element => /^(sign\s*in|log\s*in|login)$/i.test(element.label.trim()));
  const submit = signIn.find(element => element.type === 'submit');
  if (!submit) {
    const tab = signIn.find(element => element.tag === 'button') || signIn[0];
    return tab ? [{ kind: 'click', selector: tab.selector, value: '' }] : undefined;
  }
  const username = snapshot.elements.find(element => element.tag === 'input' && (element.type === 'email' || /email|user/i.test(element.label)));
  if (!username) return;
  return [{ kind: 'fill', selector: username.selector, value: FIXTURE_LOGIN_USERNAME },
    { kind: 'fill', selector: password.selector, value: FIXTURE_PASSWORD_TOKEN },
    { kind: 'click', selector: submit.selector, value: '' }];
}
