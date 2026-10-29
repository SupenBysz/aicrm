import { theme, type ThemeConfig } from "antd";
import { themeColors } from "./tokens";

/** Component tokens and shell CSS share the same palette selection. */
export function appearanceAntdTheme(themeId: string, dark: boolean): ThemeConfig {
  const colors = themeColors(themeId, dark);
  const classic = themeId === "classic-gold";
  const graphite = themeId === "graphite-cyan";
  return {
    components: graphite ? { Button: { primaryColor: dark ? "#102629" : "#ffffff" } } : undefined,
    algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      colorPrimary: colors.primary,
      colorLink: colors.primary,
      colorBgLayout: colors.bg,
      colorBgContainer: colors.surface,
      colorBgElevated: graphite && dark ? "#303030" : colors.surface,
      colorBorder: graphite ? (dark ? "#3a3a3a" : "#dce2e5") : classic ? (dark ? "rgba(255,212,125,.16)" : "rgba(221,182,113,.24)") : (dark ? "#3d4b5c" : "#cbd2da"),
      colorSplit: graphite ? (dark ? "#333333" : "#e4e8ea") : classic ? (dark ? "rgba(255,212,125,.12)" : "rgba(210,168,95,.18)") : (dark ? "#29394a" : "#e0e4e9"),
      colorText: colors.text,
      colorTextSecondary: colors.muted,
      borderRadius: 10
    }
  };
}
