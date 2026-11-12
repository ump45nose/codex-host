import { type RendererAgent } from "./agent-selection-state.js";
import { installCodexProjectDefaultDirectory } from "./codex-project-default-directory.js";
import {
  installRendererBindingProbe,
  type RendererBindingProbeApi,
} from "./renderer-binding-probe.js";
import { installCurrentRendererAdapter } from "./versioned-renderer-adapter.js";

export function installRendererBinding(
  enabledAgents?: readonly RendererAgent[],
): RendererBindingProbeApi {
  window.__codexhostRendererBindingProbeV1?.dispose();
  const binding = installRendererBindingProbe({ ...(enabledAgents ? { enabledAgents } : {}) });
  const projectDefaultDirectory = installCodexProjectDefaultDirectory(window);
  try {
    const adapter = installCurrentRendererAdapter();
    binding.setAdapter(
      adapter.status,
      () => {
        projectDefaultDirectory.dispose();
        adapter.dispose();
      },
      adapter.applyAgent,
      adapter.modelControl,
    );
  } catch (error) {
    console.error(
      "codexhost Renderer Adapter installation failed",
      error instanceof Error ? error.name : "UnknownError",
    );
    binding.setAdapter(
      {
        state: "unsupported",
        reason: "installation-failed",
        modelUpdates: 0,
        hook: null,
      },
      () => {
        projectDefaultDirectory.dispose();
      },
    );
  }
  return binding;
}
