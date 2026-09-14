export const themes = {
  modernDark: { label: '深色现代', terminal: { background: '#141416', foreground: '#d4d4d8', cursor: '#b9c9d9', selectionBackground: '#394451', black: '#1e1e1e', red: '#f14c4c', green: '#23d18b', yellow: '#f5f543', blue: '#3b8eea', magenta: '#d670d6', cyan: '#29b8db', white: '#e5e5e5', brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#ffffff' } },
  modernLight: { label: '浅色现代', terminal: { background: '#f7f7f8', foreground: '#242428', cursor: '#345d7e', selectionBackground: '#bfd7ea', black: '#000000', red: '#cd3131', green: '#00bc00', yellow: '#949800', blue: '#0451a5', magenta: '#bc05bc', cyan: '#0598bc', white: '#555555', brightBlack: '#666666', brightRed: '#cd3131', brightGreen: '#14ce14', brightYellow: '#b5ba00', brightBlue: '#0451a5', brightMagenta: '#bc05bc', brightCyan: '#0598bc', brightWhite: '#a5a5a5' } },
} as const;

export type ThemeName = keyof typeof themes;
export const defaultTheme: ThemeName = 'modernDark';
export function storedTheme(): ThemeName {
  const value = localStorage.getItem('multi-agent-mgr.theme');
  return value && value in themes ? value as ThemeName : defaultTheme;
}
export function applyTheme(theme: ThemeName) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme === 'modernLight' ? 'light' : 'dark';
  localStorage.setItem('multi-agent-mgr.theme', theme);
}
