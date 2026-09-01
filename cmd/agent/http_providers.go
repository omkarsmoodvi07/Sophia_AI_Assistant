package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"go.uber.org/fx"

	coremodule "github.com/sophiaai/sophia/cmd/internal/core"
	"github.com/sophiaai/sophia/internal/accounts"
	"github.com/sophiaai/sophia/internal/agent/application"
	"github.com/sophiaai/sophia/internal/agent/background"
	toolapproval "github.com/sophiaai/sophia/internal/agent/decision/approval"
	userinput "github.com/sophiaai/sophia/internal/agent/decision/input"
	acpagent "github.com/sophiaai/sophia/internal/agent/runtime/acp"
	sessionruntime "github.com/sophiaai/sophia/internal/agent/runtime/session"
	audiopkg "github.com/sophiaai/sophia/internal/audio"
	"github.com/sophiaai/sophia/internal/boot"
	"github.com/sophiaai/sophia/internal/bots"
	"github.com/sophiaai/sophia/internal/channel"
	"github.com/sophiaai/sophia/internal/channel/adapters/local"
	"github.com/sophiaai/sophia/internal/channel/route"
	"github.com/sophiaai/sophia/internal/chat/event"
	"github.com/sophiaai/sophia/internal/chat/message"
	sessionpkg "github.com/sophiaai/sophia/internal/chat/thread"
	"github.com/sophiaai/sophia/internal/command"
	"github.com/sophiaai/sophia/internal/config"
	dbstore "github.com/sophiaai/sophia/internal/db/store"
	emailpkg "github.com/sophiaai/sophia/internal/email"
	"github.com/sophiaai/sophia/internal/handlers"
	"github.com/sophiaai/sophia/internal/healthcheck"
	channelchecker "github.com/sophiaai/sophia/internal/healthcheck/checkers/channel"
	mcpchecker "github.com/sophiaai/sophia/internal/healthcheck/checkers/mcp"
	modelchecker "github.com/sophiaai/sophia/internal/healthcheck/checkers/model"
	"github.com/sophiaai/sophia/internal/mcp"
	"github.com/sophiaai/sophia/internal/media"
	memprovider "github.com/sophiaai/sophia/internal/memory/adapters"
	"github.com/sophiaai/sophia/internal/models"
	"github.com/sophiaai/sophia/internal/oauthclients"
	"github.com/sophiaai/sophia/internal/providers"
	"github.com/sophiaai/sophia/internal/server"
	"github.com/sophiaai/sophia/internal/settings"
	"github.com/sophiaai/sophia/internal/version"
	"github.com/sophiaai/sophia/internal/workspace"
)

func provideServerHandler(fn any) any {
	return fx.Annotate(
		fn,
		fx.As(new(server.Handler)),
		fx.ResultTags(`group:"server_handlers"`),
	)
}

func provideMemoryHandler(log *slog.Logger, botService *bots.Service, accountService *accounts.Service, _ config.Config, memoryRegistry *memprovider.Registry, settingsService *settings.Service, _ *handlers.ContainerdHandler) *handlers.MemoryHandler {
	h := handlers.NewMemoryHandler(log, botService, accountService)
	h.SetMemoryRegistry(memoryRegistry)
	h.SetSettingsService(settingsService)
	return h
}

func provideAuthHandler(log *slog.Logger, accountService *accounts.Service, rc *boot.RuntimeConfig) *handlers.AuthHandler {
	return handlers.NewAuthHandler(log, accountService, rc.JwtSecret, rc.JwtExpiresIn)
}

func provideMessageHandler(log *slog.Logger, msgService *message.DBService, sessionService *sessionpkg.Service, mediaService *media.Service, botService *bots.Service, accountService *accounts.Service, hub *event.Hub, toolApproval *toolapproval.Service, userInput *userinput.Service, bgManager *background.Manager) *handlers.MessageHandler {
	h := handlers.NewMessageHandler(log, msgService, sessionService, botService, accountService, hub)
	h.SetMediaService(mediaService)
	h.SetToolApprovalService(toolApproval)
	h.SetUserInputService(userInput)
	h.SetBackgroundManager(bgManager)
	return h
}

func provideSessionHandler(log *slog.Logger, sessionService *sessionpkg.Service, acpPool *acpagent.SessionPool, botService *bots.Service, accountService *accounts.Service, routeService *route.DBService) *handlers.SessionHandler {
	handler := handlers.NewSessionHandler(log, sessionService, acpPool, botService, accountService)
	handler.SetThreadEnricher(routeService)
	return handler
}

func provideUsersHandler(log *slog.Logger, accountService *accounts.Service, botService *bots.Service, routeService *route.DBService, channelStore *channel.Store, channelRuntime channel.Runtime, registry *channel.Registry, workspaceManager *workspace.Manager, acpPool *acpagent.SessionPool) *handlers.UsersHandler {
	handler := handlers.NewUsersHandler(log, accountService, botService, routeService, channelStore, channelRuntime, registry, workspaceManager)
	handler.SetACPRuntimeCloser(acpPool)
	return handler
}

func provideACPCodexOAuthServerHandler(handler *handlers.ACPCodexOAuthHandler) *handlers.ACPCodexOAuthHandler {
	return handler
}

func provideACPClaudeCodeOAuthServerHandler(handler *handlers.ACPClaudeCodeOAuthHandler) *handlers.ACPClaudeCodeOAuthHandler {
	return handler
}

func provideProviderOAuthHandler(providersService *providers.Service, acpCodexOAuthHandler *handlers.ACPCodexOAuthHandler) *handlers.ProviderOAuthHandler {
	handler := handlers.NewProviderOAuthHandler(providersService)
	handler.SetACPCodexOAuthHandler(acpCodexOAuthHandler)
	return handler
}

func provideWebHandler(channelManager *channel.Manager, channelStore *channel.Store, hub *local.RouteHub, botService *bots.Service, accountService *accounts.Service, sessionService *sessionpkg.Service, resolver *application.Service, sessionRuntime *sessionruntime.Manager, mediaService *media.Service, audioService *audiopkg.Service, settingsService *settings.Service, rc *boot.RuntimeConfig, commandHandler *command.Handler, containerdHandler *handlers.ContainerdHandler) *handlers.LocalChannelHandler {
	h := handlers.NewLocalChannelHandler(local.WebType, channelManager, channelStore, hub, botService, accountService, sessionService)
	h.SetAgentService(resolver)
	h.SetSessionRuntime(sessionRuntime)
	h.SetCommandHandler(commandHandler)
	h.SetRuntimeSkillResolver(containerdHandler)
	h.SetAuthTokenConfig(rc.JwtSecret, rc.JwtExpiresIn)
	h.SetMediaService(mediaService)
	h.SetSpeechService(audioService, &webSpeechModelResolver{settings: settingsService})
	return h
}

func provideEmailOAuthHandler(log *slog.Logger, service *emailpkg.Service, tokenStore *emailpkg.DBOAuthTokenStore, oauthClients *oauthclients.Registry, cfg config.Config) *handlers.EmailOAuthHandler {
	addr := strings.TrimSpace(cfg.Server.Addr)
	if addr == "" {
		addr = ":8080"
	}
	host := addr
	if strings.HasPrefix(host, ":") {
		host = "localhost" + host
	}
	callbackURL := "http://" + host + "/api/email/oauth/callback"
	return handlers.NewEmailOAuthHandler(log, service, tokenStore, oauthClients, callbackURL)
}

type serverParams struct {
	fx.In

	Logger            *slog.Logger
	RuntimeConfig     *boot.RuntimeConfig
	Config            config.Config
	AccountService    *accounts.Service
	ServerHandlers    []server.Handler `group:"server_handlers"`
	ContainerdHandler *handlers.ContainerdHandler
}

func provideServer(params serverParams) *server.Server {
	allHandlers := make([]server.Handler, 0, len(params.ServerHandlers)+1)
	allHandlers = append(allHandlers, params.ServerHandlers...)
	allHandlers = append(allHandlers, params.ContainerdHandler)
	return server.NewServerWithSessionValidator(
		params.Logger,
		params.RuntimeConfig.ServerAddr,
		params.Config.Auth.JWTSecret,
		params.AccountService.ValidateSession,
		allHandlers...,
	)
}

func startServer(lc fx.Lifecycle, logger *slog.Logger, srv *server.Server, shutdowner fx.Shutdowner, cfg config.Config, queries dbstore.Queries, accountStore dbstore.AccountStore, emailService *emailpkg.Service, botService *bots.Service, _ *handlers.ContainerdHandler, manager *workspace.Manager, mcpConnService *mcp.ConnectionService, toolGateway *mcp.ToolGatewayService, channelRuntime channel.Runtime, modelsService *models.Service) {
	fmt.Printf("Starting Sophia Agent %s\n", version.GetInfo())

	lc.Append(fx.Hook{
		OnStart: func(ctx context.Context) error {
			if err := coremodule.EnsureAdminUser(ctx, logger, accountStore, emailService, cfg); err != nil {
				return err
			}
			botService.SetContainerLifecycle(manager)
			botService.SetContainerReachability(func(ctx context.Context, botID string) error {
				_, err := manager.MCPClient(ctx, botID)
				return err
			})
			botService.AddRuntimeChecker(healthcheck.NewRuntimeCheckerAdapter(
				mcpchecker.NewChecker(logger, mcpConnService, toolGateway),
			))
			botService.AddRuntimeChecker(healthcheck.NewRuntimeCheckerAdapter(
				channelchecker.NewChecker(logger, channelRuntime),
			))
			botService.AddRuntimeChecker(healthcheck.NewRuntimeCheckerAdapter(
				modelchecker.NewChecker(logger, modelchecker.NewQueriesLookup(queries), modelsService),
			))

			go func() {
				if err := srv.Start(); err != nil && !errors.Is(err, http.ErrServerClosed) {
					logger.Error("server failed", slog.Any("error", err))
					_ = shutdowner.Shutdown()
				}
			}()
			return nil
		},
		OnStop: func(ctx context.Context) error {
			if err := srv.Stop(ctx); err != nil && !errors.Is(err, http.ErrServerClosed) {
				return fmt.Errorf("server stop: %w", err)
			}
			return nil
		},
	})
}

// webSpeechModelResolver adapts bot settings to the web chat speech model
// lookup (same shape as the shared Channel module's inbound resolver glue).
type webSpeechModelResolver struct {
	settings *settings.Service
}

func (r *webSpeechModelResolver) ResolveSpeechModelID(ctx context.Context, botID string) (string, error) {
	s, err := r.settings.GetBot(ctx, botID)
	if err != nil {
		return "", err
	}
	return s.TtsModelID, nil
}
