-- Jace Social: animated profile pictures and banners (GIF / WebP) need room - the "avatars"
-- bucket's limit goes from 2 MB to 4 MB (lib/images.ts checks the same; Vercel takes up to 4.5 MB).
-- Run once in Supabase -> SQL Editor. Safe to re-run.
update storage.buckets set file_size_limit = 4194304,
  allowed_mime_types = array['image/png', 'image/jpeg', 'image/gif', 'image/webp']
  where id = 'avatars';

select id, file_size_limit, allowed_mime_types from storage.buckets where id = 'avatars';
