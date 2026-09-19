// Deliberately fake credentials for disposable, unauthenticated test fixtures.
// The password token is safe to persist in flow maps and logs; only the browser
// execution boundary resolves it to the fixture value.
export const FIXTURE_LOGIN_USERNAME = 'JohnSmith@mail.com';
export const FIXTURE_PASSWORD_TOKEN = '[fixture-login-password]';
export const FIXTURE_LOGIN_PASSWORD = '123456';
