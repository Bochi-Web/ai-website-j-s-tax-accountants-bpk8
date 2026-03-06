import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

/**
 * /api/auth
 * GET  — Validate an existing access token (Bearer header)
 * POST — Email/password sign-in
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY');
    return res.status(500).json({ success: false, message: 'Server configuration error' });
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ── GET: Validate an existing access token ──
  if (req.method === 'GET') {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Missing authorization header' });
    }

    const token = authHeader.slice(7);
    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data.user) {
      return res.status(401).json({ success: false, message: 'Invalid or expired token' });
    }

    return res.status(200).json({ success: true, user: { email: data.user.email } });
  }

  // ── POST: Email/password sign-in ──
  if (req.method === 'POST') {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required' });
    }

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error || !data.session) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials',
      });
    }

    return res.status(200).json({
      success: true,
      token: data.session.access_token,
      user: { email: data.user.email },
    });
  }

  return res.status(405).json({ success: false, message: 'Method not allowed' });
}
