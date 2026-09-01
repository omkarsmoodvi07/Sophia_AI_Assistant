package db

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
)

func bindTeamQueryFixture(t *testing.T, ctx context.Context, tx pgx.Tx) {
	t.Helper()
	if _, err := tx.Exec(ctx, `
CREATE OR REPLACE FUNCTION public.sophia_current_team_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$ SELECT pg_catalog.current_setting('sophia.team_id')::uuid $$;
SELECT set_config('sophia.team_id', '00000000-0000-0000-0000-000000000001', true);
`); err != nil {
		t.Fatalf("bind team query fixture: %v", err)
	}
}
