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
      'scripting',
      'notifications',
    ],
    host_permissions: ['<all_urls>'],
    action: {
      default_title: 'oxdm — click to toggle',
      default_icon: {
        '16': 'icon-16-on.png',
        '32': 'icon-32-on.png',
        '48': 'icon-48-on.png',
        '128': 'icon-128-on.png',
      },
    },
    icons: {
      '16': 'icon-16-on.png',
      '32': 'icon-32-on.png',
      '48': 'icon-48-on.png',
      '128': 'icon-128-on.png',
    },
    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: {
              id: 'oxdm@oxdm.io',
              strict_min_version: '115.0',
            },
          },
        }
      : {}),
  }),
});
