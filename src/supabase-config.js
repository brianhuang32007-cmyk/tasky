// Supabase connection details.
//
// Both of these are meant to be public. The publishable key is designed to
// ship in client code: protection comes from Row Level Security policies on
// the database (`auth.uid() = user_id`), not from the key being secret. So
// this file is safe in a public repo.
//
// The *secret* key — `sb_secret_…`, previously called service_role — is the
// opposite, and must never appear here, in any other file, or anywhere in
// this repository. It bypasses RLS entirely.
//
// Both values live in the Supabase dashboard under Project Settings -> API.
// While the URL is blank the app runs exactly as before, and the account page
// says sign-in is not configured yet.

export const SUPABASE_URL = 'https://xofuwlovbulwpknmypve.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_51y2Qxc1LvsFQB5W59Qq5A_UvPEXkrx';
