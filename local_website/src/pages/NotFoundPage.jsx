import React, { useEffect } from 'react';

export function NotFoundPage({
  title = "404 - Page Not Found",
  message = "We couldn't find the page or product you were looking for.",
}) {
  useEffect(() => {
    document.title = "404 Not Found - BestBuy Mock";
    if (typeof window !== 'undefined' && !window.location.pathname.endsWith('404.html')) {
      try {
        window.history.replaceState(null, '', '404.html');
      } catch {
        // ignore
      }
    }
  }, []);

  return (
    <main id="main-content">
      <div
        className="empty-state 404-container"
        data-testid="404-page"
        style={{ padding: '4rem 1rem', textAlign: 'center' }}
      >
        <h1
          style={{
            fontSize: '5rem',
            fontWeight: 800,
            color: '#dc2626',
            margin: '0 0 0.5rem 0',
            lineHeight: 1,
          }}
        >
          404
        </h1>
        <h2
          style={{
            fontSize: '1.75rem',
            fontWeight: 700,
            margin: '0 0 1rem 0',
            color: '#111827',
          }}
        >
          {title}
        </h2>
        <p
          style={{
            color: '#4b5563',
            fontSize: '1.1rem',
            maxWidth: '480px',
            margin: '0 auto 1.5rem auto',
            lineHeight: 1.5,
          }}
        >
          {message}
        </p>
        <a href="index.html" className="btn yellow" style={{ display: 'inline-block' }}>
          Back to store
        </a>
      </div>
    </main>
  );
}
