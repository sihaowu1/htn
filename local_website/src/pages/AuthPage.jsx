import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';

export function AuthPage({ params }) {
  const { currentUser, login, logout } = useAuth();
  const returnTo = params.get('returnTo') || 'index.html';

  const [mode, setMode] = useState(() => (currentUser ? 'sign-in' : 'create'));
  const [name, setName] = useState('');
  const [email, setEmail] = useState(() => currentUser?.email || '');
  const [password, setPassword] = useState('');

  const safeReturnTo = () => (returnTo.startsWith('http') ? 'index.html' : returnTo);

  const handleSubmit = (e) => {
    e.preventDefault();
    const resolvedName = mode === 'create' ? name.trim() : (currentUser?.name || email.split('@')[0]);
    if (!resolvedName) return;
    login({ name: resolvedName, email: email.trim().toLowerCase() });
    window.location.href = safeReturnTo();
  };

  const handleSignOut = () => {
    logout();
    window.location.href = 'index.html';
  };

  const isCreate = mode === 'create';

  return (
    <main>
      <div className="auth-shell">
        <div className="auth-card">
          <div className="auth-tabs" role="tablist" aria-label="Account actions">
            <button
              className={`auth-tab ${!isCreate ? 'active' : ''}`}
              id="sign-in-tab"
              type="button"
              role="tab"
              aria-selected={!isCreate}
              onClick={() => setMode('sign-in')}
            >
              Sign in
            </button>
            <button
              className={`auth-tab ${isCreate ? 'active' : ''}`}
              id="create-account-tab"
              type="button"
              role="tab"
              aria-selected={isCreate}
              onClick={() => setMode('create')}
            >
              Create an account
            </button>
          </div>
          <div id="auth-content">
            <h1>{isCreate ? 'Create your account' : 'Sign in'}</h1>
            <p className="auth-note">Use a demo identity to keep your cart and checkout flow together.</p>
            <form id="auth-form" onSubmit={handleSubmit}>
              {isCreate && (
                <div className="form-row">
                  <label htmlFor="name">Name</label>
                  <input
                    id="name"
                    name="name"
                    type="text"
                    autoComplete="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                  />
                </div>
              )}
              <div className="form-row">
                <label htmlFor="email">Email</label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="form-row">
                <label htmlFor="password">Password</label>
                <input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete={isCreate ? 'new-password' : 'current-password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              <button className="btn yellow" type="submit">
                {isCreate ? 'Create account' : 'Sign in'}
              </button>
            </form>
            <div className="auth-status" id="auth-status" role="status" aria-live="polite"></div>
            {currentUser && (
              <button className="text-button" id="sign-out-button" type="button" onClick={handleSignOut}>
                Sign out of {currentUser.name}
              </button>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
