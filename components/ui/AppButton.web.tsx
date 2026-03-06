import React from "react";

type Props = {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: "primary" | "danger" | "neutral";
  fullWidth?: boolean;
  style?: React.CSSProperties;
};

export function AppButton({
  title,
  onPress,
  disabled = false,
  variant = "primary",
  fullWidth = true,
  style,
}: Props) {
  const base: React.CSSProperties = {
    height: 52,
    width: fullWidth ? "100%" : "auto",
    borderRadius: 14,
    fontWeight: 700,
    fontSize: 16,
    border: "1px solid rgba(255,255,255,0.12)",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.6 : 1,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    userSelect: "none",
    padding: "0 16px",
    background: "transparent",
  };

  const variants: Record<string, React.CSSProperties> = {
    primary: { background: "rgba(59,130,246,0.9)", color: "white" },
    danger: { background: "rgba(239,68,68,0.9)", color: "white" },
    neutral: { background: "rgba(255,255,255,0.08)", color: "white" },
  };

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        console.log("[AppButton.web] onClick fired", { title, disabled });
        if (!disabled) onPress();
      }}
      style={{ ...base, ...variants[variant], ...style }}
    >
      {title}
    </button>
  );
}
