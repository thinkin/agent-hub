export const themes = {
  modernDark: { label: '深色现代', terminal: { background: '#141416', foreground: '#d4d4d8', cursor: '#b9c9d9', selectionBackground: '#394451', black: '#1e1e1e', red: '#f14c4c', green: '#23d18b', yellow: '#f5f543', blue: '#3b8eea', magenta: '#d670d6', cyan: '#29b8db', white: '#e5e5e5', brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#ffffff' } },
  modernLight: { label: '浅色现代', terminal: { background: '#f7f7f8', foreground: '#242428', cursor: '#345d7e', selectionBackground: '#bfd7ea', black: '#000000', red: '#cd3131', green: '#00bc00', yellow: '#949800', blue: '#0451a5', magenta: '#bc05bc', cyan: '#0598bc', white: '#555555', brightBlack: '#666666', brightRed: '#cd3131', brightGreen: '#14ce14', brightYellow: '#b5ba00', brightBlue: '#0451a5', brightMagenta: '#bc05bc', brightCyan: '#0598bc', brightWhite: '#a5a5a5' } },
  solarizedDark: { label: 'Solarized Dark', terminal: { background: '#002b36', foreground: '#93a1a1', cursor: '#b58900', selectionBackground: '#174652', black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5', brightBlack: '#002b36', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3' } },
  monokai: { label: 'Monokai', terminal: { background: '#272822', foreground: '#f8f8f2', cursor: '#f8f8f0', selectionBackground: '#49483e', black: '#272822', red: '#f92672', green: '#a6e22e', yellow: '#f4bf75', blue: '#66d9ef', magenta: '#ae81ff', cyan: '#a1efe4', white: '#f8f8f2', brightBlack: '#75715e', brightRed: '#f92672', brightGreen: '#a6e22e', brightYellow: '#f4bf75', brightBlue: '#66d9ef', brightMagenta: '#ae81ff', brightCyan: '#a1efe4', brightWhite: '#f9f8f5' } },
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
