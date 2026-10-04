import { dlopen, FFIType, type Pointer } from "bun:ffi";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { PATHS } from "electrobun/bun";

// The Electrobun SDK never calls its `setWindowIcon` FFI symbol, and Electron-style
// window icon options do not exist, so packaged Linux windows keep the GTK default
// (gear) icon in the panel/alt-tab. Wire it up ourselves: `mainWindow.ptr` gives the
// native window pointer and libNativeWrapper.so exports setWindowIcon(window, path).
export function applyWindowIcon(windowPtr: Pointer | null): boolean {
  if (process.platform !== "linux" || !windowPtr) return false;

  const iconPath = join(PATHS.RESOURCES_FOLDER, "appIcon.png");
  if (!existsSync(iconPath)) {
    console.warn(`[icon] appIcon.png missing at ${iconPath}; window keeps the default icon`);
    return false;
  }

  const wrapperPath = join(dirname(process.execPath), "libNativeWrapper.so");
  if (!existsSync(wrapperPath)) {
    console.warn(`[icon] ${wrapperPath} missing; cannot set window icon`);
    return false;
  }

  try {
    const { symbols } = dlopen(wrapperPath, {
      setWindowIcon: {
        args: [FFIType.ptr, FFIType.cstring],
        returns: FFIType.void,
      },
    });
    // Bun's FFI takes cstring arguments as NUL-terminated buffers, not strings.
    const iconPathBuffer = Buffer.from(`${iconPath}\0`, "utf8");
    symbols.setWindowIcon(windowPtr, iconPathBuffer);
    console.log(`[icon] window icon set from ${iconPath}`);
    return true;
  } catch (error) {
    console.warn("[icon] setWindowIcon failed:", error);
    return false;
  }
}
