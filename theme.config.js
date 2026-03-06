/** @type {const} */
const themeColors = {
  // Paleta iOS-Like Clean (dark mode)
  bg: { light: '#F8FAFC', dark: '#0F1720' },
  surface: { light: '#FFFFFF', dark: '#141C26' },
  glass: { light: 'rgba(255,255,255,0.72)', dark: 'rgba(20,28,38,0.72)' },
  border: { light: '#E2E8F0', dark: 'rgba(255,255,255,0.08)' },
  text: { light: '#0F172A', dark: '#EAF0F7' },
  text2: { light: '#64748B', dark: '#A7B3C2' },
  muted: { light: '#94A3B8', dark: '#6B7A8C' },
  
  // Cor principal (única)
  accent: { light: '#3B82F6', dark: '#3B82F6' },
  
  // Cores de estado (apenas para urgência/erro/sucesso)
  success: { light: '#22C55E', dark: '#22C55E' },
  warning: { light: '#F59E0B', dark: '#F59E0B' },
  critical: { light: '#E11D48', dark: '#E11D48' },
  
  // Compatibilidade com cores antigas (não remover)
  primary: { light: '#3B82F6', dark: '#3B82F6' }, // Mapeado para accent
  background: { light: '#F8FAFC', dark: '#0F1720' }, // Mapeado para bg
  foreground: { light: '#0F172A', dark: '#EAF0F7' }, // Mapeado para text
  error: { light: '#E11D48', dark: '#E11D48' }, // Mapeado para critical
  surface2: { light: '#F1F5F9', dark: '#141C26' }, // Compatibilidade
  info: { light: '#3B82F6', dark: '#3B82F6' }, // Mapeado para accent
  criticalDark: { light: '#9F1239', dark: '#9F1239' },
};

module.exports = { themeColors };
