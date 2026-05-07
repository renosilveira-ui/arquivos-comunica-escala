import React from "react";
import { theme } from "@/lib/theme";

/**
 * AppButton — versão web. Espelha a spec §6.1 (5 variants × 3 sizes).
 *
 * Variants:
 *   - primary   → bg primary, text branco. Ação principal por tela.
 *   - secondary → bg surface, border, text textPrimary. Ações alternativas.
 *   - danger    → bg danger, text branco. Destrutivas.
 *   - ghost     → bg transparente, text textPrimary. Secundárias compactas.
 *   - link      → bg transparente, text primary, sem border. Navegação textual.
 *
 * Sizes (height / padding-x / fontSize / fontWeight):
 *   - sm → 32 / space.3 / text.body / weight.medium
 *   - md → 40 / space.4 / text.body / weight.semibold (DEFAULT)
 *   - lg → 48 / space.5 / text.bodyLg / weight.semibold
 */

type Variant = "primary" | "secondary" | "danger" | "ghost" | "link";
type Size = "sm" | "md" | "lg";

type Props = {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: Variant;
  size?: Size;
  fullWidth?: boolean;
  style?: React.CSSProperties;
};

const SIZE_MAP: Record<Size, { height: number; paddingX: number; fontSize: number; fontWeight: number }> = {
  sm: {
    height: 32,
    paddingX: theme.space[3],
    fontSize: theme.text.body.fontSize,
    fontWeight: 500,
  },
  md: {
    height: 40,
    paddingX: theme.space[4],
    fontSize: theme.text.body.fontSize,
    fontWeight: 600,
  },
  lg: {
    height: 48,
    paddingX: theme.space[5],
    fontSize: theme.text.bodyLg.fontSize,
    fontWeight: 600,
  },
};

function variantStyle(variant: Variant): React.CSSProperties {
  switch (variant) {
    case "primary":
      return {
        background: theme.colors.primary,
        color: theme.colors.surface,
        border: "none",
      };
    case "secondary":
      return {
        background: theme.colors.surface,
        color: theme.colors.textPrimary,
        border: `1px solid ${theme.colors.border}`,
      };
    case "danger":
      return {
        background: theme.colors.danger,
        color: theme.colors.surface,
        border: "none",
      };
    case "ghost":
      return {
        background: "transparent",
        color: theme.colors.textPrimary,
        border: "none",
      };
    case "link":
      return {
        background: "transparent",
        color: theme.colors.primary,
        border: "none",
        padding: 0,
        height: "auto",
      };
  }
}

export function AppButton({
  title,
  onPress,
  disabled = false,
  variant = "primary",
  size = "md",
  fullWidth = true,
  style,
}: Props) {
  const sz = SIZE_MAP[size];
  const base: React.CSSProperties = {
    height: sz.height,
    width: fullWidth ? "100%" : "auto",
    borderRadius: theme.radius.md,
    fontWeight: sz.fontWeight,
    fontSize: sz.fontSize,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.4 : 1,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    userSelect: "none",
    padding: `0 ${sz.paddingX}px`,
    transition: "background-color 120ms ease, opacity 120ms ease",
  };

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!disabled) onPress();
      }}
      style={{ ...base, ...variantStyle(variant), ...style }}
    >
      {title}
    </button>
  );
}
