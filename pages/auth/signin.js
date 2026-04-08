import { signIn } from 'next-auth/react';

export default function SignIn() {
  return (
    <div style={{
      minHeight: '100vh', background: '#0f1117', display: 'flex',
      alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui'
    }}>
      <div style={{
        background: '#1a1d2e', borderRadius: 12, padding: 40,
        textAlign: 'center', width: 360, border: '1px solid #2a2d3e'
      }}>
        <div style={{ fontSize: 32, marginBottom: 8 }}>🗼</div>
        <h1 style={{ color: '#fff', fontSize: 24, margin: '0 0 8px' }}>Watchtower</h1>
        <p style={{ color: '#888', fontSize: 14, margin: '0 0 32px' }}>
          Commure Call Center Agents — Pipeline Intelligence
        </p>
        <button
          onClick={() => signIn('google', { callbackUrl: '/' })}
          style={{
            background: '#4285f4', color: '#fff', border: 'none',
            borderRadius: 8, padding: '12px 24px', fontSize: 15,
            cursor: 'pointer', width: '100%', display: 'flex',
            alignItems: 'center', justifyContent: 'center', gap: 10
          }}
        >
          <svg width="18" height="18" viewBox="0 0 18 18">
            <path fill="#fff" d="M16.51 8H8.98v3h4.3c-.18 1-.74 1.48-1.6 2.04v2.01h2.6a7.8 7.8 0 0 0 2.38-5.88c0-.57-.05-.66-.15-1.18z"/>
            <path fill="#fff" d="M8.98 17c2.16 0 3.97-.72 5.3-1.94l-2.6-2a4.8 4.8 0 0 1-7.18-2.54H1.83v2.07A8 8 0 0 0 8.98 17z"/>
            <path fill="#fff" d="M4.5 10.52a4.8 4.8 0 0 1 0-3.04V5.41H1.83a8 8 0 0 0 0 7.18l2.67-2.07z"/>
            <path fill="#fff" d="M8.98 4.18c1.17 0 2.23.4 3.06 1.2l2.3-2.3A8 8 0 0 0 1.83 5.4L4.5 7.49a4.77 4.77 0 0 1 4.48-3.3z"/>
          </svg>
          Sign in with Google
        </button>
        <p style={{ color: '#555', fontSize: 12, marginTop: 20 }}>
          @commure.com and @getathelas.com accounts only
        </p>
      </div>
    </div>
  );
}
