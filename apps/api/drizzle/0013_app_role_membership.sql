-- TR-SEC-05, DECISIONS A25 and A32: every request runs `SET LOCAL ROLE mms_app`, which needs the
-- connecting user to hold mms_app with the SET option. A superuser always does (local Docker, CI).
-- A managed database's owner (Neon for the Cloudflare client demo, Amazon RDS in production) is not a
-- superuser: since PostgreSQL 16, creating a role gives its creator ADMIN on it but not SET, so the
-- first signed-in request would fail with "permission denied to set role". Grant it once, here.
DO $$
BEGIN
  IF NOT pg_has_role(current_user, 'mms_app', 'SET') THEN
    EXECUTE format('GRANT mms_app TO %I WITH SET TRUE', current_user);
  END IF;
END
$$;
