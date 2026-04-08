import { useRouter } from 'next/router';
import { signIn } from 'next-auth/react';

export default function AuthError() {
  const router = useRouter();
  const error = router.query.error;
  return (
    <div style={{ minHeight:'100vh', background:'#0f1117', display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'system-ui' }}>
      <div style={{ background:'#1a1d2e', borderRadius:12, padding:40, textAlign:'center', width:360, border:'1px solid #2a2d3e' }}>
        <div style={{ fontSize:32, marginBottom:8 }}>🚫</div>
        <h2 style={{ color:'#fff' }}>Access Denied</h2>
        <p style={{ color:'#888', fontSize:14 }}>
          {error === 'AccessDenied' ? 'Only @commure.com accounts are allowed.' : 'An error occurred during sign in.'}
        </p>
        <button onClick={() => signIn('google', { callbackUrl: '/' })} style={{ background:'#4285f4', color:'#fff', border:'none', borderRadius:8, padding:'10px 20px', cursor:'pointer', marginTop:16 }}>
          Try again
        </button>
      </div>
    </div>
  );
}
