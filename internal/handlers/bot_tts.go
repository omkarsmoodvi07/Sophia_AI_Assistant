package handlers

import (
	"log/slog"
	"net/http"
	"strings"

	"github.com/labstack/echo/v4"

	audiopkg "github.com/sophiaai/sophia/internal/audio"
	"github.com/sophiaai/sophia/internal/settings"
)

// BotAudioHandler handles per-bot speech synthesis requests from the agent tool
// and from the Sophia avatar in the web UI.
type BotAudioHandler struct {
	audioService    *audiopkg.Service
	settingsService *settings.Service
	tempStore       *audiopkg.TempStore
	logger          *slog.Logger
}

func NewBotAudioHandler(log *slog.Logger, audioService *audiopkg.Service, settingsService *settings.Service, tempStore *audiopkg.TempStore) *BotAudioHandler {
	return &BotAudioHandler{
		audioService:    audioService,
		settingsService: settingsService,
		tempStore:       tempStore,
		logger:          log.With(slog.String("handler", "bot_audio")),
	}
}

func (h *BotAudioHandler) Register(e *echo.Echo) {
	e.POST("/bots/:bot_id/tts/synthesize", h.Synthesize)
	// Sophia avatar voice: synthesize and return the audio bytes inline so the
	// browser can play them directly. The /synthesize route above parks the
	// audio in a temp file for the agent tool, which is not reachable from a
	// <audio> element, so the avatar needs its own single-round-trip route.
	e.POST("/bots/:bot_id/tts/speak", h.Speak)
}

type synthesizeRequest struct {
	Text string `json:"text"`
}

type synthesizeResponse struct {
	TempID      string `json:"temp_id"`
	ContentType string `json:"content_type"`
	Size        int64  `json:"size"`
}

// Synthesize godoc
// @Summary Synthesize speech for a bot
// @Description Stream-synthesize text using the bot's configured TTS model, write to temp file
// @Tags bots
// @Accept json
// @Produce json
// @Param bot_id path string true "Bot ID"
// @Param request body synthesizeRequest true "Text to synthesize"
// @Success 200 {object} synthesizeResponse
// @Failure 400 {object} ErrorResponse
// @Failure 500 {object} ErrorResponse
// @Router /bots/{bot_id}/tts/synthesize [post].
func (h *BotAudioHandler) Synthesize(c echo.Context) error {
	botID := strings.TrimSpace(c.Param("bot_id"))
	if botID == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "bot_id is required")
	}

	var req synthesizeRequest
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, err.Error())
	}
	text := strings.TrimSpace(req.Text)
	if text == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "text is required")
	}
	const maxTextLen = 500
	if len([]rune(text)) > maxTextLen {
		return echo.NewHTTPError(http.StatusBadRequest, "text too long, max 500 characters")
	}

	botSettings, err := h.settingsService.GetBot(c.Request().Context(), botID)
	if err != nil {
		h.logger.Error("failed to load bot settings", slog.String("bot_id", botID), slog.Any("error", err))
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to load bot settings")
	}
	if botSettings.TtsModelID == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "bot has no TTS model configured")
	}

	tempID, f, err := h.tempStore.Create()
	if err != nil {
		h.logger.Error("failed to create temp file", slog.Any("error", err))
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to create temp file")
	}

	contentType, streamErr := h.audioService.StreamToFile(c.Request().Context(), botSettings.TtsModelID, text, f)
	closeErr := f.Close()
	if streamErr != nil {
		h.logger.Error("speech synthesis failed", slog.String("bot_id", botID), slog.String("model_id", botSettings.TtsModelID), slog.Any("error", streamErr))
		h.tempStore.Delete(tempID)
		return echo.NewHTTPError(http.StatusInternalServerError, streamErr.Error())
	}
	if closeErr != nil {
		h.logger.Error("failed to finalize audio file", slog.String("bot_id", botID), slog.Any("error", closeErr))
		h.tempStore.Delete(tempID)
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to finalize audio file")
	}

	size, _ := h.tempStore.FileSize(tempID)

	return c.JSON(http.StatusOK, synthesizeResponse{
		TempID:      tempID,
		ContentType: contentType,
		Size:        size,
	})
}

// maxSpeakTextLen caps a single avatar utterance. The web client already splits
// a reply into sentence-sized chunks well under this, so hitting the cap means
// something upstream sent an unsplit wall of text; truncate instead of failing
// so Sophia still says the beginning rather than going silent.
const maxSpeakTextLen = 1000

type speakRequest struct {
	Text  string   `json:"text"`
	Voice string   `json:"voice"`
	Speed *float64 `json:"speed"`
	Pitch *float64 `json:"pitch"`
}

// Speak godoc
// @Summary Synthesize speech and return the audio inline
// @Description Synthesize text with the bot's configured TTS model and return the raw audio bytes, so a browser can play them directly. Optional voice/speed/pitch override the model defaults for this request only.
// @Tags bots
// @Accept json
// @Produce audio/mpeg
// @Param bot_id path string true "Bot ID"
// @Param request body speakRequest true "Text to speak"
// @Success 200 {string} binary "Audio bytes"
// @Failure 400 {object} ErrorResponse
// @Failure 500 {object} ErrorResponse
// @Router /bots/{bot_id}/tts/speak [post].
func (h *BotAudioHandler) Speak(c echo.Context) error {
	botID := strings.TrimSpace(c.Param("bot_id"))
	if botID == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "bot_id is required")
	}

	var req speakRequest
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, err.Error())
	}
	text := strings.TrimSpace(req.Text)
	if text == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "text is required")
	}
	if runes := []rune(text); len(runes) > maxSpeakTextLen {
		text = strings.TrimSpace(string(runes[:maxSpeakTextLen]))
	}

	botSettings, err := h.settingsService.GetBot(c.Request().Context(), botID)
	if err != nil {
		h.logger.Error("failed to load bot settings", slog.String("bot_id", botID), slog.Any("error", err))
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to load bot settings")
	}
	if botSettings.TtsModelID == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "bot has no TTS model configured")
	}

	// Per-request overrides land on top of provider config then model config,
	// so the avatar can pick a warmer voice or slow her down slightly without
	// anyone having to re-save the model in settings.
	override := map[string]any{}
	if v := strings.TrimSpace(req.Voice); v != "" {
		override["voice"] = v
	}
	if req.Speed != nil {
		override["speed"] = *req.Speed
	}
	if req.Pitch != nil {
		override["pitch"] = *req.Pitch
	}

	data, contentType, err := h.audioService.Synthesize(c.Request().Context(), botSettings.TtsModelID, text, override)
	if err != nil {
		h.logger.Error("avatar speech synthesis failed",
			slog.String("bot_id", botID),
			slog.String("model_id", botSettings.TtsModelID),
			slog.Any("error", err))
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	if len(data) == 0 {
		h.logger.Error("avatar speech synthesis returned no audio",
			slog.String("bot_id", botID),
			slog.String("model_id", botSettings.TtsModelID))
		return echo.NewHTTPError(http.StatusInternalServerError, "speech synthesis returned no audio")
	}
	if contentType == "" {
		contentType = "audio/mpeg"
	}

	c.Response().Header().Set("Cache-Control", "no-store")
	return c.Blob(http.StatusOK, contentType, data)
}
