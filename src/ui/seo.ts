/** Shared structured data (schema.org JSON-LD). */

export const SITE_NAME = 'The Internet Change Detector';

export function organizationJsonLd(baseUrl: string) {
  return {
    '@type': 'Organization',
    '@id': `${baseUrl}/#organization`,
    name: SITE_NAME,
    url: `${baseUrl}/`,
    logo: { '@type': 'ImageObject', url: `${baseUrl}/icon-512.png`, width: 512, height: 512 },
  };
}

/** WebSite with sitelinks search box, plus the publisher, as one graph. */
export function websiteJsonLd(baseUrl: string) {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite',
        '@id': `${baseUrl}/#website`,
        name: SITE_NAME,
        url: `${baseUrl}/`,
        publisher: { '@id': `${baseUrl}/#organization` },
        potentialAction: {
          '@type': 'SearchAction',
          target: { '@type': 'EntryPoint', urlTemplate: `${baseUrl}/search?q={search_term_string}` },
          'query-input': 'required name=search_term_string',
        },
      },
      organizationJsonLd(baseUrl),
    ],
  };
}

export function breadcrumbJsonLd(baseUrl: string, items: { name: string; path: string }[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: `${baseUrl}${item.path}`,
    })),
  };
}

/** Search engines show ~155 characters; cut at a word and end with an ellipsis. */
export function metaDescription(text: string, max = 158): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 30)).replace(/[\s,.;:–-]+$/, '')}…`;
}
