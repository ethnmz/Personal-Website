// ethnmz.com: pages live in src/, shared pieces in src/_includes, build output in _site/
export default function (eleventyConfig) {
  // only these get copied into the site, so local-only folders (unblurred screenshots, raw media) never ship
  eleventyConfig.addPassthroughCopy({
    assets: 'assets',
    media: 'media',
    CNAME: 'CNAME',
    'playlist.json': 'playlist.json',
    'src/colorstack/index.html': 'colorstack/index.html',
    'src/open-source/index.html': 'open-source/index.html'
  });

  // marks the sidebar link for the page you're on (a section link also covers its subpages)
  eleventyConfig.addFilter('navCurrent', function (href, url) {
    var current = href === url || (href !== '/' && url.indexOf(href) === 0);
    return current ? ' aria-current="page"' : '';
  });

  return {
    dir: { input: 'src', output: '_site' },
    templateFormats: ['njk'],
    htmlTemplateEngine: 'njk'
  };
}
