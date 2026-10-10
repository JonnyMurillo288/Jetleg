-- Deleting an account must always work.
--
-- It did not, in one ordinary situation: Ana publishes a map, Ben branches
-- it, Ana likes Ben's branch -- and then Ana's account is deleted. Auth
-- answered "Database error deleting user" and the account stayed.
--
-- Everything Ana owns cascades from her user row in a single statement. Her
-- map goes, and its versions with it; Ben's branch points at one of those
-- versions and is due to have that pointer set null. But her like on Ben's
-- branch goes in the same statement, and its trigger recounts the branch's
-- likes -- an UPDATE of Ben's row, arriving before the set-null has run.
-- Postgres re-checks a row's foreign keys when it is updated twice in one
-- transaction, finds parent_version_id naming a version that no longer
-- exists, and aborts the lot.
--
-- Nothing is actually inconsistent: by the end of the statement the pointer
-- is null. So these three references are checked at commit instead of
-- mid-statement. `on delete set null` still fires as before; only the
-- moment of the check moves.
--
-- Found by re-running seed-community.ts over its own data, which removes
-- the dummy accounts first.

alter table community_maps
  alter constraint community_maps_parent_map_id_fkey deferrable initially deferred,
  alter constraint community_maps_parent_version_fkey deferrable initially deferred,
  alter constraint community_maps_head_version_fkey deferrable initially deferred;
