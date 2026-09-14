-- 0026: Serbian Securities Commission (SSC) approval evidence for whitepapers.
-- The ssc_approved whitepaper status must be backed by a decision reference
-- (e.g. the SSC decision number) and, optionally, the decision document itself
-- (stored in the public `documents` bucket alongside the whitepaper, with its
-- SHA-256 recorded for integrity). The public "Approved by the Serbian
-- Securities Commission" badge renders only when whitepaper_status =
-- 'ssc_approved' AND ssc_decision_ref is present.

alter table public.asset_profiles
  add column if not exists ssc_decision_ref text,
  add column if not exists ssc_decision_doc_path text,
  add column if not exists ssc_decision_doc_sha256 text;
