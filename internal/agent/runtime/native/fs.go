package native

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/sophiaai/sophia/internal/workspace/bridge"
)

// FSClient provides file operations against a bot's container filesystem.
type FSClient struct {
	provider bridge.Provider
	botID    string
	now      func() time.Time
}

// nativeProvider is satisfied by *workspace.Manager. It exists so that the
// handful of reads which must always hit the Bot's own server workspace can say
// so, instead of silently following whichever machine happens to be the Bot's
// default location right now.
//
// Declared as a local interface rather than importing the workspace package
// both to avoid an import cycle and so that a provider without the method (the
// ACP adapter, tests) still works — it just falls back to the default target.
type nativeProvider interface {
	NativeMCPClient(ctx context.Context, botID string) (*bridge.Client, error)
}

// NewFSClient creates a new container filesystem client.
func NewFSClient(provider bridge.Provider, botID string, now func() time.Time) *FSClient {
	if now == nil {
		now = time.Now
	}
	return &FSClient{provider: provider, botID: botID, now: now}
}

// ReadText reads a text file from the container, returning its content as a string.
// Returns an empty string if the file does not exist or cannot be read.
func (f *FSClient) ReadText(ctx context.Context, path string) (string, error) {
	if f.provider == nil {
		return "", nil
	}
	client, err := f.provider.MCPClient(ctx, f.botID)
	if err != nil {
		return "", fmt.Errorf("mcp client: %w", err)
	}
	resp, err := client.ReadFile(ctx, path, 0, 0)
	if err != nil {
		return "", err
	}
	return resp.GetContent(), nil
}

// ReadTextSafe reads a text file, returning empty string on any error.
func (f *FSClient) ReadTextSafe(ctx context.Context, path string) string {
	content, _ := f.ReadText(ctx, path)
	return content
}

// ReadNativeText reads a text file from the Bot's own server workspace,
// ignoring the default location for this turn.
//
// This matters because MCPClient resolves the Bot's *current* target: once a
// remote runtime is set as the default location, an ordinary read of
// "/data/AGENTS.md" is sent to that machine instead. On a Windows laptop the
// path does not exist, the read fails, ReadTextSafe swallows the error, and the
// file arrives as an empty string — so the Bot loses its own instructions and
// memory the moment it starts working on the user's computer, with nothing in
// the logs to say why.
//
// The workspace instruction files belong to the Bot, not to whichever machine
// it is currently acting on, so they are always read from the server.
func (f *FSClient) ReadNativeText(ctx context.Context, path string) (string, error) {
	if f.provider == nil {
		return "", nil
	}
	provider, ok := f.provider.(nativeProvider)
	if !ok {
		return f.ReadText(ctx, path)
	}
	client, err := provider.NativeMCPClient(ctx, f.botID)
	if err != nil {
		return "", fmt.Errorf("native mcp client: %w", err)
	}
	resp, err := client.ReadFile(ctx, path, 0, 0)
	if err != nil {
		return "", err
	}
	return resp.GetContent(), nil
}

// ReadNativeTextSafe reads from the Bot's own server workspace, returning an
// empty string on any error. See ReadNativeText.
func (f *FSClient) ReadNativeTextSafe(ctx context.Context, path string) string {
	content, _ := f.ReadNativeText(ctx, path)
	return content
}

// LoadSystemFiles loads the standard set of system files from the bot container.
func (f *FSClient) LoadSystemFiles(ctx context.Context) []SystemFile {
	home := "/data"
	filenames := []string{
		"AGENTS.md",
		"MEMORY.md",
		"PROFILES.md",
		// Sophia's companion files. Both are written by her own file tools during
		// a heartbeat run and read back here on every request, which is why the
		// diary and the promise list need no schema, no migration and no new Go
		// code — the workspace is already a durable, per-bot store that is always
		// in her context.
		//
		// DIARY.md   - her own reflections, newest entry first.
		// PROMISES.md - things the user said they would do, so she can follow up.
		//
		// Missing files read as empty and are skipped, so this is safe on a bot
		// whose workspace predates them.
		"DIARY.md",
		"PROMISES.md",
	}

	files := make([]SystemFile, len(filenames))
	for i, name := range filenames {
		// Deliberately native: home is "/data", which only exists on the server.
		// See ReadNativeText.
		content := f.ReadNativeTextSafe(ctx, home+"/"+name)
		files[i] = SystemFile{
			Filename: name,
			Content:  strings.TrimSpace(content),
		}
	}
	return files
}
