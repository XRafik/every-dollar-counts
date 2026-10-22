// Where a link opens Settings on the Category rules card (#156): TransactionCard's "Manage in
// Settings" and LearnedMarker. A query, not a #fragment, which app/(app)/loading.tsx explains, and
// ScrollToSection in the page brings the card whose id is the section into view. It does so only as
// Settings mounts, so a link on Settings itself that changes only the query does not scroll. A plain
// module, so LearnedMarker, which renders on the server, gets the string and not a client reference.
export const CATEGORY_RULES_HREF = '/settings?section=category-rules'
