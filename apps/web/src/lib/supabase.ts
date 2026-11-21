import { createClient } from '@supabase/supabase-js';
import { isViewOnly, VIEW_AS_STORAGE_KEY } from './viewAsFlag';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('Missing Supabase env: set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env');
}

// TASK-H21: a view-as tab keeps its (intern) session in this tab's own sessionStorage under its own key, so it never
// reads or writes the admin's localStorage session, and never detects a session from the URL.
export const supabase = isViewOnly
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        storage: window.sessionStorage,
        storageKey: VIEW_AS_STORAGE_KEY,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    })
  : createClient(supabaseUrl, supabaseAnonKey);
