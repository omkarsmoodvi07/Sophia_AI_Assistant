package qq

import (
	"log/slog"

	"github.com/sophiaai/sophia/internal/channel"
	"github.com/sophiaai/sophia/internal/channel/identities"
	"github.com/sophiaai/sophia/internal/channel/route"
	"github.com/sophiaai/sophia/internal/media"
)

func ProvideQQAdapter(log *slog.Logger, mediaService *media.Service, identityService *identities.Service, routeService *route.DBService) channel.Adapter {
	adapter := NewQQAdapter(log)
	adapter.SetAssetOpener(mediaService)
	adapter.SetChannelIdentityResolver(identityService)
	adapter.SetRouteResolver(routeService)
	return adapter
}
