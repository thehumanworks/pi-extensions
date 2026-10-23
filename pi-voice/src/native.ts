import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { AudioCapture, LiveWebRtcPeer } from "@oh-my-pi/pi-natives";

export interface NativeAudio {
  AudioCapture: new (rate: number, callback: (error: Error | null, samples: Float32Array) => void) => Pick<AudioCapture, "stop">;
  LiveWebRtcPeer: new (
    onEvent: (error: Error | null, payload: string) => void,
    onLevel: (error: Error | null, level: number) => void,
    onFailure: (error: Error | null, message: string) => void,
  ) => Pick<LiveWebRtcPeer, "createOffer" | "acceptAnswer" | "waitForOpen" | "pushAudio" | "setMuted" | "close">;
}
let cached: NativeAudio | undefined;

/** Lazy: importing the extension must not load audio hardware or open a mic. */
export function loadNativeAudio(): NativeAudio {
  if (cached) return cached;
  const tag = `${process.platform}-${process.arch}`;
  const require = createRequire(import.meta.url);
  try {
    // Upstream's JS loader uses Bun-only import.meta.dir. Load its published N-API
    // leaf directly under Node, without patching dependencies or downloading code.
    // Resolve the package directory, not its JS entry point. Bun's compiled
    // runtime can fail to resolve that entry even when the package is installed.
    // Starting from the parent package also supports nested optional dependencies.
    const manifest = require.resolve.paths("@oh-my-pi/pi-natives")
      ?.map((path) => join(path, "@oh-my-pi/pi-natives/package.json"))
      .find((path) => existsSync(path));
    if (!manifest) throw new Error("Cannot find installed @oh-my-pi/pi-natives package");
    const nativeRequire = createRequire(realpathSync(manifest));
    const leaf = dirname(nativeRequire.resolve(`@oh-my-pi/pi-natives-${tag}/package.json`));
    const names = process.arch === "x64"
      ? [`pi_natives.${tag}-baseline.node`, `pi_natives.${tag}.node`]
      : [`pi_natives.${tag}.node`];
    let bindings: (NativeAudio & { __ompInstallTokioRuntime?: () => void }) | undefined;
    for (const name of names) {
      try { bindings = require(join(leaf, name)); break; } catch (error) {
        if (name === names.at(-1)) throw error;
      }
    }
    if (!bindings?.AudioCapture || !bindings.LiveWebRtcPeer) throw new Error("Audio exports unavailable");
    bindings.__ompInstallTokioRuntime?.();
    cached = bindings;
    return cached;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Native voice audio is unavailable for ${tag}: ${detail}`, { cause });
  }
}
