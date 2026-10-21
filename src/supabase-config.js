// Supabase connection details.
//
// Both of these are meant to be public. The anon key is designed to ship in
// client code: protection comes from Row Level Security policies on the
// database (`auth.uid() = user_id`), not from the key being secret. So this
// file is safe in a public repo.
//
// The *service_role* key is the opposite and must never appear here, in any
// other file, or in this repository at all. It bypasses RLS entirely.
//
// Find both values in the Supabase dashboard under Project Settings -> API.
// Until they are filled in, the app runs exactly as before and the account
// page explains that sign-in is not configured yet.

export const SUPABASE_URL = '';
export const SUPABASE_ANON_KEY = '';
