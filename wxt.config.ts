import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: ({ browser }) => ({
    name: 'oxdm',
    description:
      'Capture browser downloads and direct them to the oxdm desktop app.',
    version: '0.1.0',
    permissions: [
      'downloads',
      'storage',
      'tabs',
      'contextMenus',
      'cookies',
      'activeTab',
      'notifications',
      'nativeMessaging',
    ],
    host_permissions: ['<all_urls>'],
    // The injected pin/selection pill render an <img> pointing at the
    // extension's own icon. Without `web_accessible_resources` the
    // host page can't load chrome-extension:// URLs even though we
    // know the chrome-extension origin ourselves.
    web_accessible_resources:
      browser === 'firefox'
        ? (['icon-16.png', 'icon-32.png', 'icon-48.png', 'icon-96.png', 'icon-128.png'] as any)
        : ([
            {
              resources: [
                'icon-16.png',
                'icon-32.png',
                'icon-48.png',
                'icon-96.png',
                'icon-128.png',
              ],
              matches: ['<all_urls>'],
            },
          ] as any),
    // Single unified icon — readable on both light and dark toolbars,
    // so no theme variant or runtime swap is needed. Chrome's
    // `theme_icons` only fires for theme-extension installs, not the
    // default dark UI, which made two-variant artwork misleading.
    action: {
      default_title: 'oxdm — click to toggle',
      default_icon: {
        '16': 'icon-16.png',
        '32': 'icon-32.png',
        '48': 'icon-48.png',
        '128': 'icon-128.png',
      },
    },
    icons: {
      '16': 'icon-16.png',
      '32': 'icon-32.png',
      '48': 'icon-48.png',
      '128': 'icon-128.png',
    },
    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: {
              id: 'oxdm@jd1378.github.io',
              strict_min_version: '115.0',
            },
          },
        }
      : {}),
  }),
});
