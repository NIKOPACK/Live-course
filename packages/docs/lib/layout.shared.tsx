import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { appName, gitConfig } from './shared';
import { i18n } from './i18n';

export function baseOptions(lang?: string): BaseLayoutProps {
  // Respect hideLocale: the default locale (en) has no path prefix, so its
  // nav title links to the docs root, not /en.
  const localePrefix =
    lang && lang !== i18n.defaultLanguage ? `/${lang}` : '';

  return {
    nav: {
      // JSX supported
      title: appName,
      url: `${localePrefix}/`,
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
    // enable the locale switcher in the navbar
    i18n: true,
  };
}
