# Latte & Lines · posting helper

Personal phone page: pick a video, paste the caption, and it goes to TikTok + YouTube Shorts through Buffer.

- `index.html` — the page (GitHub Pages)
- `supabase/post-video.ts` — Supabase Edge Function (upload link, publish via Buffer, auto-cleanup after 48h)

No secrets live in this repo. The Buffer API key and the passcode are Supabase Edge Function secrets.
