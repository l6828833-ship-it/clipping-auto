/** Keep private editor media on the app's origin so byte ranges and cookies
 * reach the same endpoint, including in Safari and embedded browsers. */
export function previewMediaUrl(url: string) {
  return /^\/api\/media\/(?:video|clip)\/[^/?#]+$/.test(url) ? `${url}?preview=1` : url;
}
