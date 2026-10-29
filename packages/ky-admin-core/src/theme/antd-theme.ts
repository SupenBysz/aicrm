import { theme, type ThemeConfig } from "antd";
import { themeColors } from "./tokens";

/** Component tokens and shell CSS share the same palette selection. */
export function appearanceAntdTheme(themeId: string, dark: boolean): ThemeConfig {
  const colors = themeColors(themeId, dark);
  const classic = themeId === "classic-gold";
  return {
    algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      colorPrimary: colors.primary,
      colorLink: colors.primary,
      colorBgLayout: colors.bg,
      colorBgContainer: colors.surface,
      colorBgElevated: colors.surface,
      colorBorder: classic ? (dark ? "rgba(255,212,125,.16)" : "rgba(221,182,113,.24)") : (dark ? "#3d4b5c" : "#cbd2da"),
      colorSplit: classic ? (dark ? "rgba(255,212,125,.12)" : "rgba(210,168,95,.18)") : (dark ? "#29394a" : "#e0e4e9"),
      colorText: colors.text,
      colorTextSecondary: colors.muted,
      borderRadius: 10
    }
  };
}
