// The Search page's view state lives in the URL hash query
// (#/search?pl=4&q=leon&...) so refreshing - or opening a copied link -
// restores the exact playlist + filters. App.tsx drops the query when you
// leave the Search tab (clean URLs elsewhere), so we remember the last one
// here and the Search page falls back to it when it mounts without a query.
let last = '';

export function rememberSearchQuery(q: string): void {
  last = q;
}

export function lastSearchQuery(): string {
  return last;
}
