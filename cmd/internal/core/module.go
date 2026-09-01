package core

import (
	"go.uber.org/fx"

	"github.com/sophiaai/sophia/internal/acl"
	"github.com/sophiaai/sophia/internal/agent/context/compaction"
	userinput "github.com/sophiaai/sophia/internal/agent/decision/input"
	audiopkg "github.com/sophiaai/sophia/internal/audio"
	"github.com/sophiaai/sophia/internal/boot"
	"github.com/sophiaai/sophia/internal/bots"
	"github.com/sophiaai/sophia/internal/channelaccess"
	"github.com/sophiaai/sophia/internal/chat/event"
	"github.com/sophiaai/sophia/internal/connectors"
	"github.com/sophiaai/sophia/internal/fetchproviders"
	"github.com/sophiaai/sophia/internal/heartbeat"
	"github.com/sophiaai/sophia/internal/mcp"
	memprovider "github.com/sophiaai/sophia/internal/memory/adapters"
	"github.com/sophiaai/sophia/internal/models"
	"github.com/sophiaai/sophia/internal/oauthclients"
	pluginspkg "github.com/sophiaai/sophia/internal/plugins"
	"github.com/sophiaai/sophia/internal/policy"
	"github.com/sophiaai/sophia/internal/providertemplates"
	"github.com/sophiaai/sophia/internal/schedule"
	"github.com/sophiaai/sophia/internal/searchproviders"
	"github.com/sophiaai/sophia/internal/settings"
	"github.com/sophiaai/sophia/internal/userruntime"
	videopkg "github.com/sophiaai/sophia/internal/video"
	"github.com/sophiaai/sophia/internal/workspace"
)

// FoundationModule assembles process-neutral domain infrastructure shared by
// Server and Channel. It intentionally excludes Agent, workspace runtimes,
// schedulers, and provider bootstrap loops.
func FoundationModule() fx.Option {
	return fx.Options(
		fx.Provide(
			provideLogger,
			provideDBConn,
			providePostgresStore,
			provideDBQueries,
			provideAccountStore,
			bots.NewService,
			provideAccountService,
			acl.NewService,
			channelaccess.NewService,
			userinput.NewService,
			policy.NewService,
			oauthclients.NewRegistry,
			event.NewHub,
			provideSessionService,
			provideMessageService,
		),
	)
}

// ServerModule assembles the Server-owned Agent and workspace runtime. It
// expects FoundationModule and the Channel catalog/runtime interfaces to be
// provided by the composing command.
func ServerModule() fx.Option {
	return fx.Options(
		fx.Provide(
			boot.ProvideRuntimeConfig,
			provideContainerService,
			provideOverlayProviderRegistry,
			provideNetworkService,
			provideNetworkController,
			settings.NewService,
			provideToolApprovalService,
			providePGVectorStore,
			provideUserRuntimeStore,
			provideBotRemoteRuntimeBindingStore,
			provideUserRuntimeHub,
			userruntime.NewService,
			workspace.NewRemoteWorkspaceService,
			provideUserRuntimePipe,
			provideWikiStore,
			provideWorkspaceManager,
			provideBridgeProvider,
			providePluginBridgeProvider,
			provideMemoryLLM,
			memprovider.NewService,
			provideMemoryProviderRegistry,
			models.NewService,
			provideACPRunner,
			provideACPSessionPool,
			provideACPCodexOAuthHandler,
			provideACPClaudeCodeOAuthHandler,
			provideHooksService,
			provideProvidersService,
			providertemplates.NewService,
			fetchproviders.NewService,
			searchproviders.NewService,
			mcp.NewConnectionService,
			connectors.NewService,
			connectors.NewSource,
			pluginspkg.NewService,
			mcp.NewToolSessionContextStore,
			provideAudioRegistry,
			audiopkg.NewService,
			provideVideoRegistry,
			videopkg.NewService,
			provideAudioTempStore,
			provideMediaService,
			provideSessionRunLedger,
			provideRuntimeFenceActivator,
			provideSessionRuntimeManager,
			provideAgent,
			provideAgentService,
			provideTurnService,
			provideScheduleTriggerer,
			provideHeartbeatSessionCreator,
			provideScheduleSessionCreator,
			schedule.NewService,
			provideHeartbeatTriggerer,
			heartbeat.NewService,
			compaction.NewService,
			provideContainerdHandler,
			provideBotBackupService,
			provideFederationGateway,
			provideACPToolSource,
			provideToolGatewayService,
			provideBackgroundManager,
			provideToolProviders,
			provideOAuthService,
		),
		fx.Invoke(
			injectToolProviders,
			injectACPToolProviders,
			injectBotConnectorLifecycle,
			configureMemoryProviderRegistry,
			startProviderTemplateSync,
			startScheduleService,
			startHeartbeatService,
			startContainerReconciliation,
			startBackgroundTaskCleanup,
			startAudioTempStoreCleanup,
		),
	)
}

// Module preserves the all-in-one composition API for tests and transitional
// callers. Production commands compose the two modules explicitly.
func Module() fx.Option {
	return fx.Options(FoundationModule(), ServerModule())
}
