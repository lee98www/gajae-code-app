export const appShellRoutePaths = [
  '/',
  '/session/:sessionId',
] as const;

export const herdrRoutePaths = [
  '/herdr',
  '/herdr/:sessionName',
  '/herdr/:sessionName/panes/:paneId',
] as const;

export const rootFallbackRoutePath = '*';
