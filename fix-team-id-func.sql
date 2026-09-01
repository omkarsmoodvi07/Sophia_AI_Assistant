CREATE OR REPLACE FUNCTION public.sophia_current_team_id()
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  raw text;
BEGIN
  raw := pg_catalog.current_setting('sophia.team_id', true);
  IF raw IS NULL OR pg_catalog.btrim(raw) = '' THEN
    RAISE EXCEPTION 'sophia.team_id is not set'
      USING ERRCODE = '42501';
  END IF;
  BEGIN
    RETURN raw::uuid;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'sophia.team_id is invalid'
        USING ERRCODE = '22P02';
  END;
END;
$function$;