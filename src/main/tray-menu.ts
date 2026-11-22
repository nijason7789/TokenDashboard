import type { Settings } from "../shared/settings";

interface TrayCommands {
  toggleVisibility(): void;
  refresh(): void;
  togglePin(): void;
  toggleCompact(): void;
  openSettings(): void;
  quit(): void;
}

export function trayMenu(
  visible: boolean,
  settings: Settings,
  commands: TrayCommands,
) {
  return [
    {
      label: visible ? "Hide window" : "Show window",
      click: commands.toggleVisibility,
    },
    { label: "Refresh quota", click: commands.refresh },
    {
      label: "Always on top",
      type: "checkbox" as const,
      checked: settings.alwaysOnTop,
      click: commands.togglePin,
    },
    {
      label: "Compact mode",
      type: "checkbox" as const,
      checked: settings.compact,
      click: commands.toggleCompact,
    },
    { label: "Settings", click: commands.openSettings },
    { type: "separator" as const },
    { label: "Quit", click: commands.quit },
  ];
}
