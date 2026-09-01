package handlers

import (
	acpprofileadapter "github.com/sophiaai/sophia/internal/agent/adapter/acpprofile"
	thread "github.com/sophiaai/sophia/internal/chat/thread"
	dbstore "github.com/sophiaai/sophia/internal/db/store"
)

func newThreadServiceForTest(queries dbstore.Queries) *thread.Service {
	service := thread.NewService(nil, queries, nil)
	service.SetACPSetupValidator(acpprofileadapter.NewCatalog())
	return service
}
