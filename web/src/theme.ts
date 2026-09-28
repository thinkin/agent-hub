export const terminalTheme = { background: '#141416', foreground: '#d4d4d8', cursor: '#b9c9d9', selectionBackground: '#394451', black: '#1e1e1e', red: '#f14c4c', green: '#23d18b', yellow: '#f5f543', blue: '#3b8eea', magenta: '#d670d6', cyan: '#29b8db', white: '#e5e5e5', brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#ffffff' } as const;
// Keep text legible when a full-screen CLI paints a background color but leaves
// the foreground at the terminal default.
export const terminalMinimumContrastRatio = 4.5;
export function applyTheme() {
  document.documentElement.dataset.theme = 'modernDark';
  document.documentElement.style.colorScheme = 'dark';
  localStorage.removeItem('multi-agent-mgr.theme');
}
