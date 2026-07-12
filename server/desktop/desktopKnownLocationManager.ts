import { platform } from "node:os";
import { launchWindowsExplorer } from "./explorerLauncher";
import type {
  DesktopKnownLocation,
  DesktopOpenKnownLocationData
} from "./desktopTypes";

const KNOWN_LOCATION_ARGUMENTS: Record<DesktopKnownLocation, string[]> = {
  this_pc: ["shell:MyComputerFolder"]
};

function createKnownLocationError(
  code: "INVALID_REQUEST" | "UNSUPPORTED_PLATFORM" | "REVEAL_FAILED",
  message: string
) {
  return Object.assign(new Error(message), { desktopCode: code });
}

export class DesktopKnownLocationManager {
  async open(location: DesktopKnownLocation): Promise<DesktopOpenKnownLocationData> {
    if (platform() !== "win32") {
      throw createKnownLocationError(
        "UNSUPPORTED_PLATFORM",
        `desktop.openKnownLocation 当前仅支持 Windows，当前平台：${platform()}`
      );
    }

    const explorerArguments = KNOWN_LOCATION_ARGUMENTS[location];
    if (!explorerArguments) {
      throw createKnownLocationError("INVALID_REQUEST", `不支持的系统位置：${location}`);
    }

    try {
      await launchWindowsExplorer(explorerArguments);
    } catch (error) {
      throw createKnownLocationError(
        "REVEAL_FAILED",
        error instanceof Error ? error.message : "无法打开 Windows 系统位置"
      );
    }

    return {
      location,
      openedAt: Date.now()
    };
  }
}

export const desktopKnownLocationManager = new DesktopKnownLocationManager();
