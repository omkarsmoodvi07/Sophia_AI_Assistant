package client

import (
	"strings"

	acp "github.com/coder/acp-go-sdk"

	mcpgw "github.com/sophiaai/sophia/internal/mcp"
)

const (
	sophiaToolsMCPServerName       = "Sophia Tools"
	sophiaToolsMCPServerSlug       = "Sophia_Tools"
	sophiaHeaderBotID              = mcpgw.ToolHeaderBotID
	sophiaHeaderChatID             = mcpgw.ToolHeaderChatID
	sophiaHeaderRuntimeID          = mcpgw.ToolHeaderRuntimeID
	sophiaHeaderRuntimeToken       = mcpgw.ToolHeaderRuntimeToken
	sophiaHeaderSessionID          = mcpgw.ToolHeaderSessionID
	sophiaHeaderRunID              = mcpgw.ToolHeaderRunID
	sophiaHeaderSessionType        = mcpgw.ToolHeaderSessionType
	sophiaHeaderRouteID            = mcpgw.ToolHeaderRouteID
	sophiaHeaderChannelIdentityID  = mcpgw.ToolHeaderChannelIdentityID
	sophiaHeaderCurrentPlatform    = mcpgw.ToolHeaderCurrentPlatform
	sophiaHeaderReplyTarget        = mcpgw.ToolHeaderReplyTarget
	sophiaHeaderConversationType   = mcpgw.ToolHeaderConversationType
	sophiaHeaderIsSubagent         = mcpgw.ToolHeaderIsSubagent
	sophiaHeaderSupportsImageInput = mcpgw.ToolHeaderSupportsImageInput
)

func sophiaToolsHTTPMCPServer(rawURL string, session mcpgw.ToolSessionContext) acp.McpServer {
	rawURL = strings.TrimSpace(rawURL)
	if rawURL == "" {
		return acp.McpServer{}
	}
	return acp.McpServer{
		Http: &acp.McpServerHttpInline{
			Name:    sophiaToolsMCPServerName,
			Url:     rawURL,
			Headers: sophiaToolsHTTPHeaders(session),
		},
	}
}

func sophiaToolsHTTPHeaders(session mcpgw.ToolSessionContext) []acp.HttpHeader {
	headers := make([]acp.HttpHeader, 0, 11)
	add := func(name, value string) {
		value = strings.TrimSpace(value)
		if value == "" {
			return
		}
		headers = append(headers, acp.HttpHeader{Name: name, Value: value})
	}

	add(sophiaHeaderBotID, session.BotID)
	add(sophiaHeaderChatID, session.ChatID)
	add(sophiaHeaderRuntimeID, session.RuntimeID)
	add(sophiaHeaderRuntimeToken, session.RuntimeToken)
	add(sophiaHeaderSessionID, session.SessionID)
	add(sophiaHeaderRunID, session.RunID)
	add(sophiaHeaderSessionType, session.SessionType)
	add(sophiaHeaderRouteID, session.RouteID)
	add(sophiaHeaderChannelIdentityID, session.ChannelIdentityID)
	add(sophiaHeaderCurrentPlatform, session.CurrentPlatform)
	add(sophiaHeaderReplyTarget, session.ReplyTarget)
	add(sophiaHeaderConversationType, session.ConversationType)
	if session.IsSubagent {
		add(sophiaHeaderIsSubagent, "true")
	}
	if session.SupportsImageInput {
		add(sophiaHeaderSupportsImageInput, "true")
	}
	return headers
}

func isSophiaToolsMCPServerName(name string) bool {
	name = strings.TrimSpace(name)
	return strings.EqualFold(name, sophiaToolsMCPServerName) ||
		strings.EqualFold(name, sophiaToolsMCPServerSlug)
}
