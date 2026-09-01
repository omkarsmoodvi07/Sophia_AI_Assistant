package plugins

import (
	"log/slog"

	"github.com/sophiaai/sophia/internal/config"
	"github.com/sophiaai/sophia/internal/oauthclients"
)

type (
	OAuthClient         = oauthclients.Client
	OAuthClientRegistry = oauthclients.Registry
)

func NewOAuthClientRegistry(log *slog.Logger, cfg config.Config) *OAuthClientRegistry {
	return oauthclients.NewRegistry(log, cfg)
}
