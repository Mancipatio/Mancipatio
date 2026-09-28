-- 0077: size cap and MIME allowlist on the private KYC bucket (podaci-infra-16).
--
-- client-documents (0025) was created without either, so only the upload
-- route enforced them: 15 MiB (app/api/clients/_helpers.ts MAX_UPLOAD_BYTES)
-- and PDF, PNG, JPEG or DOCX (app/api/clients/upload/route.ts). Pin both on
-- the bucket too, as 0031 did for documents / documents-confidential and 0048
-- for document-uploads, so the two layers cannot drift apart silently. Only
-- the service role writes here, through that route.
--
-- Expand-only and compatible with the deployed front: the route already
-- refuses everything the bucket now refuses. Existing objects are untouched
-- (Storage checks the limits on upload). Apply order: any time after 0076
-- (0076_offering_exemption.sql; the two are independent), with db.sh like
-- 0071-0076; no code depends on it. Idempotent.

begin;

update storage.buckets
   set file_size_limit = 15728640, -- 15 MiB = MAX_UPLOAD_BYTES
       allowed_mime_types = array[
         'application/pdf',
         'image/png',
         'image/jpeg',
         'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
       ]
 where id = 'client-documents';

commit;
