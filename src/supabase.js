import { createClient } from '@supabase/supabase-js';

const rawUrl = (process.env.SUPABASE_URL || '').trim();
// Automatically sanitize URL if user copied with /rest/v1
const supabaseUrl = rawUrl.replace(/\/rest\/v1\/?$/i, '').replace(/\/+$/, '');
const supabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '').trim();

if (!supabaseUrl || !supabaseKey) {
  console.warn('[Supabase] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing from .env');
}

export const supabase = createClient(
  supabaseUrl,
  supabaseKey,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  }
);

export default supabase;
