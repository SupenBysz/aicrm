import { theme, type ThemeConfig } from "antd";
import { themeColors } from "./tokens";

/** Component tokens and shell CSS share the same palette selection. */
export function appearanceAntdTheme(themeId: string, dark: boolean): ThemeConfig {
  const colors = themeColors(themeId, dark);
  const classic = themeId === "classic-gold";
  const graphite = themeId === "graphite-cyan";
  return {
    components: { Button: { primaryColor: colors.onPrimary } },
    algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      colorPrimary: colors.primary,
      colorLink: colors.primary,
      colorBgLayout: colors.bg,
      colorBgContainer: colors.surface,
      colorBgElevated: graphite && dark ? "#303030" : colors.surface,
      colorBorder: colors.line,
      colorSplit: graphite ? (dark ? "#333333" : "#e4e8ea") : classic ? (dark ? "rgba(255,212,125,.12)" : "rgba(210,168,95,.18)") : colors.line,
      colorText: colors.text,
      colorTextSecondary: colors.muted,
      borderRadius: 10
    }
  };
}
