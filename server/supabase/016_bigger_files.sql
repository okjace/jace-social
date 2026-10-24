-- Jace Social: files in messages can be up to 50 MB (was 10 MB) - lib/uploads.ts checks the same.
-- 50 MB is also Supabase's largest file on the free plan (Storage settings -> "Upload file size limit").
-- Run once in Supabase -> SQL Editor. Safe to re-run.
update storage.buckets set file_size_limit = 52428800 where id = 'attachments';

select id, file_size_limit from storage.buckets where id = 'attachments';
