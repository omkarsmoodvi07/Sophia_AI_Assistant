package overlay

import (
	netctl "github.com/sophiaai/sophia/internal/network"
	"github.com/sophiaai/sophia/internal/network/overlay/internal/sidecar"
)

type ProviderDeps struct {
	SidecarRuntime sidecar.Runtime
	Runtime        netctl.RuntimeDescriptor
	StateRoot      string
}
