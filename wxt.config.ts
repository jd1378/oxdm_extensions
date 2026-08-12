import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: ({ browser }) => ({
    // The Chrome Web Store takes the listing's item name and summary
    // straight from here; neither is editable in the dashboard. Keep
    // `name` within 45 chars and `description` within 132, and say the
    // desktop app is required, since the summary is often all a user
    // reads before installing.
    name: 'oxdm Download Manager Integration',
    description:
      'Sends browser downloads to the oxdm download manager running on your computer. Requires the oxdm desktop app.',
    // No `version` here on purpose. WXT takes it from package.json, and
    // setting it here silently overrides that, so a bumped package.json
    // would still ship a stale manifest and stale zip filenames.
    permissions: [
      'downloads',
      'storage',
      'tabs',
      'contextMenus',
      'cookies',
      // No `activeTab`: `<all_urls>` below already grants everything it
      // would, so it is one more permission to justify at store review
      // for no capability.
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
        ? (['icon-32.png'] as any)
        : ([
            {
              resources: ['icon-32.png'],
              matches: ['<all_urls>'],
            },
          ] as any),
    // Single unified icon — readable on both light and dark toolbars,
    // so no theme variant or runtime swap is needed. Chrome's
    // `theme_icons` only fires for theme-extension installs, not the
    // default dark UI, which made two-variant artwork misleading.
    // No `default_title` here: WXT derives it from the popup's
    // <title>, so anything set here is silently discarded. The live
    // tooltip is written by `setTitle` in background.ts.
    action: {
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
              // Mandatory for AMO submissions since 3 Nov 2025.
              // Mozilla scopes it to data handled "outside the add-on
              // or the local browser": we transmit only to oxdm on
              // this machine, over loopback or native messaging, and
              // send nothing to any server of ours. Hence "none".
              data_collection_permissions: {
                required: ['none'],
              },
            },
          },
        }
      : {}),
  }),
});
