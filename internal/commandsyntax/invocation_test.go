package commandsyntax

import (
	"errors"
	"reflect"
	"testing"
)

func TestParseInvocationAddressing(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name         string
		text         string
		aliases      []string
		directed     bool
		wantText     string
		wantAction   string
		wantArgs     []string
		wantRest     string
		wantDirected bool
	}{
		{name: "plain", text: "/new discuss", aliases: []string{"sophia1bot"}, wantText: "/new discuss", wantAction: "discuss", wantRest: "discuss"},
		{name: "leading mention", text: "@sophia1bot /new discuss", aliases: []string{"sophia1bot"}, wantText: "/new discuss", wantAction: "discuss", wantRest: "discuss", wantDirected: true},
		{name: "leading mention comma", text: "@sophia1bot, /new discuss", aliases: []string{"sophia1bot"}, wantText: "/new discuss", wantAction: "discuss", wantRest: "discuss", wantDirected: true},
		{name: "wrapped mention colon", text: "<@123>: /new discuss", aliases: []string{"123"}, wantText: "/new discuss", wantAction: "discuss", wantRest: "discuss", wantDirected: true},
		{name: "leading mention full width colon", text: "@sophia1bot： /new discuss", aliases: []string{"sophia1bot"}, wantText: "/new discuss", wantAction: "discuss", wantRest: "discuss", wantDirected: true},
		{name: "command suffix", text: "/new@sophia1bot discuss", aliases: []string{"sophia1bot"}, wantText: "/new discuss", wantAction: "discuss", wantRest: "discuss", wantDirected: true},
		{name: "action suffix", text: "/new discuss@sophia1bot", aliases: []string{"sophia1bot"}, wantText: "/new discuss", wantAction: "discuss", wantRest: "discuss", wantDirected: true},
		{name: "help action suffix", text: "/help model@sophia1bot", aliases: []string{"sophia1bot"}, wantText: "/help model", wantAction: "model", wantRest: "model", wantDirected: true},
		{name: "mention after command", text: "/new @sophia1bot", aliases: []string{"sophia1bot"}, wantText: "/new", wantRest: "", wantDirected: true},
		{name: "mention after action", text: "/new discuss @sophia1bot", aliases: []string{"sophia1bot"}, wantText: "/new discuss", wantAction: "discuss", wantRest: "discuss", wantDirected: true},
		{name: "repeated current mention", text: "@sophia1bot /new @sophia1bot discuss @sophia1bot", aliases: []string{"sophia1bot"}, wantText: "/new discuss", wantAction: "discuss", wantRest: "discuss", wantDirected: true},
		{name: "other mentions stay arguments", text: "/new discuss @alice @sophia1bot", aliases: []string{"sophia1bot"}, wantText: "/new discuss @alice", wantAction: "discuss", wantArgs: []string{"@alice"}, wantRest: "discuss @alice", wantDirected: true},
		{name: "quoted current mention stays data", text: `/schedule create "@sophia1bot" @sophia1bot`, aliases: []string{"sophia1bot"}, wantText: `/schedule create "@sophia1bot"`, wantAction: "create", wantArgs: []string{"@sophia1bot"}, wantRest: `create "@sophia1bot"`, wantDirected: true},
		{name: "quoted attached mention stays data", text: `/schedule create "report@sophia1bot"`, aliases: []string{"sophia1bot"}, wantText: `/schedule create "report@sophia1bot"`, wantAction: "create", wantArgs: []string{"report@sophia1bot"}, wantRest: `create "report@sophia1bot"`},
		{name: "later attached mention is addressing", text: "/schedule create report@sophia1bot", aliases: []string{"sophia1bot"}, wantText: "/schedule create report", wantAction: "create", wantArgs: []string{"report"}, wantRest: "create report", wantDirected: true},
		{name: "other at suffix stays data", text: "/schedule create report@example.com", aliases: []string{"sophia1bot"}, wantText: "/schedule create report@example.com", wantAction: "create", wantArgs: []string{"report@example.com"}, wantRest: "create report@example.com"},
		{name: "discord mention", text: "<@123> /new discuss <@!123>", aliases: []string{"123"}, wantText: "/new discuss", wantAction: "discuss", wantRest: "discuss", wantDirected: true},
		{name: "metadata directed", text: "/new discuss", aliases: []string{"sophia1bot"}, directed: true, wantText: "/new discuss", wantAction: "discuss", wantRest: "discuss", wantDirected: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got, err := ParseInvocation(InvocationInput{Text: tt.text, BotAliases: tt.aliases, Directed: tt.directed})
			if err != nil {
				t.Fatalf("ParseInvocation() error = %v", err)
			}
			if got.CommandText != tt.wantText || got.Parsed.Action != tt.wantAction || got.Rest != tt.wantRest {
				t.Fatalf("invocation = %#v, want text/action/rest %q/%q/%q", got, tt.wantText, tt.wantAction, tt.wantRest)
			}
			if !reflect.DeepEqual(got.Parsed.Args, tt.wantArgs) {
				t.Fatalf("args = %#v, want %#v", got.Parsed.Args, tt.wantArgs)
			}
			if got.Directed != tt.wantDirected {
				t.Fatalf("Directed = %v, want %v", got.Directed, tt.wantDirected)
			}
		})
	}
}

func TestParseInvocationRejectsWrongAddressing(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		text string
		err  error
	}{
		{name: "ordinary text", text: "hello /new", err: ErrNotCommand},
		{name: "other leading mention", text: "@otherbot /new", err: ErrCommandForOtherBot},
		{name: "other punctuated leading mention", text: "@otherbot, /new", err: ErrCommandForOtherBot},
		{name: "other command suffix", text: "/new@otherbot", err: ErrCommandForOtherBot},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			_, err := ParseInvocation(InvocationInput{Text: tt.text, BotAliases: []string{"sophia1bot"}})
			if !errors.Is(err, tt.err) {
				t.Fatalf("error = %v, want %v", err, tt.err)
			}
		})
	}
}
